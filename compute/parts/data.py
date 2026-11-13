"""Stage 3 data: compute/results/parts-labelled.jsonl (one body per line, exported by the Mac session) parsed
tolerantly, validated, split by group, and cached as a memory-mapped array. Numpy only.

A line needs a label and a point cloud; a bbox, a group and an id are optional:
  label   'label' | 'class' | 'category'                      case and plurals are folded ('Screws' -> screw)
  points  'points' | 'pts' | 'cloud' | 'point_cloud' | 'pointcloud' | 'xyz' | 'pc'
          flat [x, y, z, x, y, z, ...], nested [[x, y, z], ...], channels-first [[x...], [y...], [z...]]
          or {x: [...], y: [...], z: [...]}
  bbox    'bbox' | 'box' | 'aabb' | 'bounds'
          [minx, miny, minz, maxx, maxy, maxz], [[min], [max]], {min, max} (lists or {x, y, z}),
          {center, size}, or [sx, sy, sz] (extents only)
  group   'group' | 'assembly' | 'assembly_id' | 'file' | 'file_id' | 'path' | 'document' | 'doc' | 'source'
  id      'id' | 'body_id' | 'uid' | 'name'

The bbox is taken as the body's real size in mm (the points may be normalised); without it the size comes from
the points. Labels outside the classes are reported and skipped unless asked otherwise; nothing is guessed."""
from __future__ import annotations

import gzip
import hashlib
import json
import time
from collections import Counter
from pathlib import Path

import numpy as np

from cadnn.util import (SPLITS, atomic_write_json, file_sha256, normalize_cloud, random_rotation, rng_for,
                        rotation_about_z, sample_indices, split_of)

CLASSES = ('screw', 'nut', 'washer', 'standoff', 'bearing', 'magnet', 'spring', 'oring', 'pcb', 'component', 'battery', 'other')
CLASS_ID = {c: i for i, c in enumerate(CLASSES)}
PLURALS = {c + 's': c for c in CLASSES}
LABEL_KEYS = ('label', 'class', 'category')
POINT_KEYS = ('points', 'pts', 'cloud', 'point_cloud', 'pointcloud', 'xyz', 'pc')
BBOX_KEYS = ('bbox', 'box', 'aabb', 'bounds', 'size')
GROUP_KEYS = ('group', 'assembly', 'assembly_id', 'file', 'file_id', 'path', 'document', 'doc', 'source')
ID_KEYS = ('id', 'body_id', 'uid', 'name')
MIN_POINTS = 8


class RecordError(ValueError):
    pass


def norm_label(raw):
    s = ' '.join(str(raw).strip().lower().replace('_', ' ').replace('-', ' ').split())
    return PLURALS.get(s, s)


def _vec3(v, what):
    if isinstance(v, dict):
        try:
            v = [v['x'], v['y'], v['z']]
        except KeyError:
            raise RecordError(f'{what}: dict without x/y/z') from None
    try:
        a = np.asarray(v, dtype=np.float64).reshape(-1)
    except (TypeError, ValueError):
        raise RecordError(f'{what}: not numbers') from None
    if a.shape != (3,):
        raise RecordError(f'{what}: expected 3 numbers, got {a.size}')
    return a


def parse_points(v):
    """-> ((P, 3) float64, format name)."""
    if isinstance(v, dict):
        if all(k in v for k in 'xyz'):
            try:
                cols = [np.asarray(v[k], dtype=np.float64).reshape(-1) for k in 'xyz']
            except (TypeError, ValueError):
                raise RecordError('points: x/y/z are not numbers') from None
            if len({len(c) for c in cols}) != 1:
                raise RecordError('points: x, y and z have different lengths')
            a, fmt = np.stack(cols, 1), 'xyz-dict'
        else:
            raise RecordError('points: dict without x/y/z')
    else:
        try:
            a = np.asarray(v, dtype=np.float64)
        except (TypeError, ValueError):
            raise RecordError('points: not a numeric array (ragged or non-numbers)') from None
        if a.ndim == 1:
            if a.size == 0 or a.size % 3:
                raise RecordError(f'points: flat length {a.size} is not a positive multiple of 3')
            a, fmt = a.reshape(-1, 3), 'flat'
        elif a.ndim == 2 and a.shape[1] == 3:
            fmt = 'nested'
        elif a.ndim == 2 and a.shape[0] == 3:
            a, fmt = a.T, 'channels-first'
        else:
            raise RecordError(f'points: shape {a.shape} is not (N, 3), (3N,) or (3, N)')
    if not np.all(np.isfinite(a)):
        raise RecordError('points: NaN or infinite values')
    if len(a) < MIN_POINTS:
        raise RecordError(f'points: only {len(a)} points (need {MIN_POINTS})')
    return a, fmt


def parse_bbox(v):
    """-> (lo, hi, format name)."""
    if isinstance(v, dict):
        lo = next((v[k] for k in ('min', 'lo', 'lower') if k in v), None)
        hi = next((v[k] for k in ('max', 'hi', 'upper') if k in v), None)
        size = next((v[k] for k in ('size', 'dims', 'extent', 'extents') if k in v), None)
        if lo is not None and hi is not None:
            lo, hi, fmt = _vec3(lo, 'bbox min'), _vec3(hi, 'bbox max'), 'min-max-dict'
        elif size is not None:
            s = _vec3(size, 'bbox size')
            c = _vec3(v.get('center', v.get('centre', [0, 0, 0])), 'bbox center')
            lo, hi, fmt = c - s / 2, c + s / 2, 'center-size'
        else:
            raise RecordError('bbox: dict without min/max or size')
    else:
        try:
            a = np.asarray(v, dtype=np.float64)
        except (TypeError, ValueError):
            raise RecordError('bbox: not numbers') from None
        if a.shape == (6,):
            lo, hi, fmt = a[:3], a[3:], 'flat6'
        elif a.shape == (2, 3):
            lo, hi, fmt = a[0], a[1], 'nested'
        elif a.shape == (3,):
            lo, hi, fmt = -a / 2, a / 2, 'extents'
        else:
            raise RecordError(f'bbox: shape {a.shape} is not 6 numbers, [[min], [max]] or 3 extents')
    if not (np.all(np.isfinite(lo)) and np.all(np.isfinite(hi))):
        raise RecordError('bbox: NaN or infinite values')
    if np.any(hi < lo):
        raise RecordError('bbox: max below min (expected [minx, miny, minz, maxx, maxy, maxz])')
    return lo, hi, fmt


def _first(obj, keys):
    for k in keys:
        if k in obj and obj[k] is not None:
            return k, obj[k]
    return None, None


def parse_record(obj, lineno):
    if not isinstance(obj, dict):
        raise RecordError('line is not a JSON object')
    lk, raw = _first(obj, LABEL_KEYS)
    if lk is None:
        raise RecordError(f'no label ({"/".join(LABEL_KEYS)})')
    pk, pv = _first(obj, POINT_KEYS)
    if pk is None:
        raise RecordError(f'no points ({"/".join(POINT_KEYS)})')
    pts, pfmt = parse_points(pv)
    bk, bv = _first(obj, BBOX_KEYS)
    lo, hi, bfmt = parse_bbox(bv) if bk else (None, None, None)
    gk, gv = _first(obj, GROUP_KEYS)
    ik, iv = _first(obj, ID_KEYS)
    label = norm_label(raw)
    return dict(line=lineno, raw_label=str(raw), label=label, cls=CLASS_ID.get(label, -1), points=pts, points_fmt=pfmt,
                lo=lo, hi=hi, bbox_fmt=bfmt, group=None if gk is None else str(gv), group_key=gk,
                id=str(iv) if ik else f'line{lineno}', synthetic=bool(obj.get('synthetic')))


def iter_records(path):
    """Yields records from plain JSONL or a gzip-compressed .jsonl.gz file."""
    opener = gzip.open if str(path).lower().endswith('.gz') else open
    with opener(path, 'rt', encoding='utf-8') as f:
        for lineno, line in enumerate(f, 1):
            s = line.strip()
            if not s or s.startswith('#'):
                continue
            try:
                obj = json.loads(s)
            except json.JSONDecodeError as e:
                yield lineno, None, f'bad JSON: {e.msg}'
                continue
            try:
                yield lineno, parse_record(obj, lineno), None
            except RecordError as e:
                yield lineno, None, str(e)


def extents(rec, bbox_scale=1.0):
    if rec['lo'] is not None:
        return (rec['hi'] - rec['lo']) * bbox_scale
    p = rec['points']
    return p.max(0) - p.min(0)


def size_feature(ext):
    """log10 of the bbox extents in mm, largest first, floored at 1 micron. What tells an M3 from an M8."""
    return np.log10(np.maximum(np.sort(np.asarray(ext, dtype=np.float64))[::-1], 1e-3)).astype(np.float32)


def geometry_hash(points):
    """Same for bodies whose normalised clouds are identical up to point order (exact duplicates)."""
    q, _, _ = normalize_cloud(points)
    q = np.round(q, 3) + 0.0   # + 0.0 turns -0.0 into 0.0
    q = q[np.lexsort(q.T[::-1])]
    return hashlib.sha1(q.astype(np.float32).tobytes()).hexdigest()[:16]


def prepare_points(points, n_points, rng):
    p = np.asarray(points, dtype=np.float64)[sample_indices(len(points), n_points, rng)]
    return normalize_cloud(p)[0].astype(np.float32)


def merge_groups(groups, hashes):
    """Leak-resistant split keys: groups that share an exact-duplicate body are merged, and each merged component is
    named by its smallest group. Returns one key per record."""
    parent = {}

    def find(x):
        parent.setdefault(x, x)
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for g, h in zip(groups, hashes):
        a, b = find(('g', g)), find(('h', h))
        if a != b:
            parent[max(a, b)] = min(a, b)
    name = {}
    for g in groups:
        r = find(('g', g))
        name[r] = min(name.get(r, g), g)
    return [name[find(('g', g))] for g in groups]


def _scan(path, unknown='skip', bbox_scale=1.0):
    """One pass: the light per-record facts (no points kept)."""
    rows, errors, stats = [], [], Counter()
    for lineno, rec, err in iter_records(path):
        stats['lines'] += 1
        if err:
            errors.append((lineno, err))
            continue
        stats[f'points:{rec["points_fmt"]}'] += 1
        stats[f'bbox:{rec["bbox_fmt"] or "missing"}'] += 1
        cls = rec['cls']
        if cls < 0:
            stats['unknown_label'] += 1
            if unknown == 'skip':
                continue
            if unknown == 'error':
                raise SystemExit(f'{path}:{lineno}: label {rec["raw_label"]!r} is not one of {", ".join(CLASSES)}')
            cls = CLASS_ID['other']
            stats['unknown_mapped_to_other'] += 1
        p = rec['points']
        ext = extents(rec, bbox_scale)
        pdiag, bdiag = float(np.linalg.norm(p.max(0) - p.min(0))), float(np.linalg.norm(ext))
        rows.append(dict(line=lineno, cls=cls, raw_label=rec['raw_label'], id=rec['id'],
                         group=rec['group'] if rec['group'] is not None else f'#line{lineno}', has_group=rec['group'] is not None,
                         group_key=rec['group_key'], hash=geometry_hash(p), size=size_feature(ext), n=len(p),
                         ratio=pdiag / bdiag if bdiag > 0 and rec['lo'] is not None else None, synthetic=rec['synthetic']))
    return rows, errors, stats


def validate(path, n_points=1024, seed=0, val=0.1, test=0.1, max_invalid=0.01, max_examples=10):
    """Everything worth knowing before a training run, as a dict with 'fatal' and 'warnings' lists."""
    unk = Counter()
    raw = Counter()
    for _, rec, _ in iter_records(path):
        if rec is not None:
            raw[rec['raw_label']] += 1
            if rec['cls'] < 0:
                unk[rec['raw_label']] += 1
    rows, errors, stats = _scan(path, unknown='skip')
    fatal, warn = [], []
    lines = stats['lines']
    n_bad = len(errors)
    keys = merge_groups([r['group'] for r in rows], [r['hash'] for r in rows]) if rows else []
    split = [split_of(k, seed, val, test) for k in keys]
    by_split = {s: Counter() for s in SPLITS}
    for r, s in zip(rows, split):
        by_split[SPLITS[s]][CLASSES[r['cls']]] += 1
    cls_count = Counter(CLASSES[r['cls']] for r in rows)
    groups = Counter(r['group'] for r in rows if r['has_group'])
    hashes = Counter(r['hash'] for r in rows)
    dup_rows = sum(c for c in hashes.values() if c > 1)
    hash_groups = {}
    for r in rows:
        hash_groups.setdefault(r['hash'], set()).add(r['group'])
    cross_group_dups = sum(1 for g in hash_groups.values() if len(g) > 1)
    npts = np.array([r['n'] for r in rows]) if rows else np.zeros(0)
    ratios = np.array([r['ratio'] for r in rows if r['ratio'] is not None])
    error_kinds = Counter(e.split(':')[0] for _, e in errors)

    if not rows:
        fatal.append('no usable records')
    if lines and n_bad / lines > max_invalid:
        fatal.append(f'{n_bad} of {lines} lines invalid ({100 * n_bad / lines:.1f}% > {100 * max_invalid:.1f}%)')
    if len(cls_count) < 2 and rows:
        fatal.append(f'only one class present ({", ".join(cls_count)})')
    if unk:
        warn.append(f'{sum(unk.values())} records with labels outside the classes will be skipped: '
                    + ', '.join(f'{k!r} x{v}' for k, v in unk.most_common(10)))
    missing = [c for c in CLASSES if not cls_count.get(c)]
    if missing:
        warn.append(f'classes with no examples: {", ".join(missing)}')
    few = [f'{c} ({n})' for c, n in cls_count.items() if n < 20]
    if few:
        warn.append(f'classes with under 20 examples: {", ".join(few)}')
    for s in ('val', 'test'):
        gone = [c for c in cls_count if not by_split[s].get(c)]
        if gone and (val if s == 'val' else test) > 0:
            warn.append(f'{s} split has no {", ".join(gone)}: those classes will not be measured there')
    no_group = sum(1 for r in rows if not r['has_group'])
    if no_group:
        warn.append(f'{no_group} records have no group key ({"/".join(GROUP_KEYS)}): each is its own group, so bodies '
                    'from one file can land in different splits')
    if groups and rows:
        top, top_n = groups.most_common(1)[0]
        if len(groups) < 10 or top_n / len(rows) > 0.2:
            warn.append(f'{len(groups)} groups, largest {top!r} holds {100 * top_n / len(rows):.0f}% of records: '
                        'a coarse group key (e.g. a constant "source") makes the split lumpy')
    if len(npts) and np.any(npts != n_points):
        warn.append(f'{int((npts != n_points).sum())} records do not have {n_points} points; they will be resampled')
    if cross_group_dups:
        warn.append(f'{cross_group_dups} identical bodies appear in more than one group; those groups are merged for the split')
    if len(ratios) and np.median(ratios) < 0.2:
        warn.append(f'points look normalised (median points/bbox size ratio {np.median(ratios):.3f}); size comes from bbox')
    no_bbox = sum(v for k, v in stats.items() if k == 'bbox:missing')
    if no_bbox:
        warn.append(f'{no_bbox} records have no bbox: their size feature comes from the points, which is wrong if '
                    'those points are normalised')
    return dict(path=str(path), lines=lines, valid=len(rows) + sum(unk.values()), usable=len(rows), invalid=n_bad,
                error_kinds=dict(error_kinds), error_examples=[dict(line=l, error=e) for l, e in errors[:max_examples]],
                labels_raw=dict(raw.most_common()), classes=dict(cls_count), unknown_labels=dict(unk),
                formats={k: v for k, v in stats.items() if k.startswith(('points:', 'bbox:'))},
                points=dict(min=int(npts.min()), median=float(np.median(npts)), max=int(npts.max())) if len(npts) else None,
                points_to_bbox_ratio_median=float(np.median(ratios)) if len(ratios) else None,
                groups=len(groups), records_without_group=no_group,
                group_keys=dict(Counter(r['group_key'] for r in rows if r['group_key'])),
                duplicate_rows=dup_rows, cross_group_duplicates=cross_group_dups,
                split_seed=seed, split_fractions=dict(val=val, test=test),
                split_preview={s: dict(c) for s, c in by_split.items()},
                synthetic_rows=sum(1 for r in rows if r['synthetic']),
                warnings=warn, fatal=fatal)


def format_validation(rep):
    L = [f'{rep["path"]}: {rep["lines"]} lines, {rep["usable"]} usable, {rep["invalid"]} invalid, '
         f'{sum(rep["unknown_labels"].values())} unknown labels']
    L.append('classes: ' + ', '.join(f'{c} {rep["classes"].get(c, 0)}' for c in CLASSES))
    for s, c in rep['split_preview'].items():
        L.append(f'  {s:5}: ' + ', '.join(f'{k} {c.get(k, 0)}' for k in CLASSES))
    L.append(f'groups {rep["groups"]} (keys {rep["group_keys"]}), points {rep["points"]}, formats {rep["formats"]}')
    if rep['synthetic_rows']:
        L.append(f'SYNTHETIC: {rep["synthetic_rows"]} rows are marked synthetic')
    for e in rep['error_examples']:
        L.append(f'  line {e["line"]}: {e["error"]}')
    L += [f'warning: {w}' for w in rep['warnings']]
    L += [f'FATAL: {f}' for f in rep['fatal']]
    L.append('ok to train' if not rep['fatal'] else 'not ok to train')
    return '\n'.join(L)


def build_cache(jsonl, out_dir, n_points=1024, seed=0, val=0.1, test=0.1, unknown='skip', bbox_scale=1.0, log=print):
    """Two streaming passes over the JSONL: facts and split first, then the resampled, normalised points into
    out_dir/points.npy (memory-mapped, (M, n_points, 3) float32) with labels etc. in out_dir/meta.npz."""
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    rows, errors, stats = _scan(jsonl, unknown, bbox_scale)
    if not rows:
        raise SystemExit(f'{jsonl}: no usable records ({len(errors)} invalid)')
    keys = merge_groups([r['group'] for r in rows], [r['hash'] for r in rows])
    split = np.array([split_of(k, seed, val, test) for k in keys], dtype=np.int8)
    row_of = {r['line']: i for i, r in enumerate(rows)}
    tmp = out / 'points.tmp.npy'
    pts = np.lib.format.open_memmap(tmp, mode='w+', dtype=np.float32, shape=(len(rows), n_points, 3))
    done = 0
    for lineno, rec, err in iter_records(jsonl):
        i = row_of.get(lineno)
        if i is None or rec is None:
            continue
        pts[i] = prepare_points(rec['points'], n_points, rng_for(seed, 'resample', lineno))
        done += 1
    pts.flush()
    del pts
    if done != len(rows):
        raise SystemExit(f'{jsonl} changed while caching ({done} of {len(rows)} records found on the second pass)')
    tmp.replace(out / 'points.npy')
    arrays = dict(label=np.array([r['cls'] for r in rows], dtype=np.int8), size=np.stack([r['size'] for r in rows]),
                  split=split, group=np.array(keys, dtype=str), id=np.array([r['id'] for r in rows], dtype=str),
                  raw_label=np.array([r['raw_label'] for r in rows], dtype=str),
                  line=np.array([r['line'] for r in rows], dtype=np.int64))
    with open(out / 'meta.tmp.npz', 'wb') as f:
        np.savez(f, **arrays)
    (out / 'meta.tmp.npz').replace(out / 'meta.npz')
    counts = {SPLITS[s]: {c: int(((split == s) & (arrays['label'] == i)).sum()) for i, c in enumerate(CLASSES)} for s in range(3)}
    meta = dict(source=str(Path(jsonl).resolve()), sha256=file_sha256(jsonl), n_points=n_points, seed=seed, val=val,
                test=test, unknown=unknown, bbox_scale=bbox_scale, records=len(rows), invalid=len(errors),
                counts=counts, stats=dict(stats), synthetic_rows=sum(1 for r in rows if r['synthetic']),
                classes=list(CLASSES), created=time.strftime('%Y-%m-%d %H:%M:%S'))
    atomic_write_json(out / 'cache.json', meta)
    log(f'{len(rows)} bodies -> {out} ({len(errors)} invalid lines skipped, {time.time() - t0:.0f} s)')
    return meta


def load_cache_meta(cache_dir):
    return json.loads((Path(cache_dir) / 'cache.json').read_text(encoding='utf-8'))


class PartDataset:
    """Map-style dataset over the cache; item = row or (row, epoch). Opens the memory map lazily in each process."""

    def __init__(self, cache_dir, train=False, augment='so3', seed=0):
        if augment not in ('none', 'so3', 'z'):
            raise ValueError(f'augment {augment!r}')
        self.dir, self.train, self.augment, self.seed = Path(cache_dir), train, augment, seed
        with np.load(self.dir / 'meta.npz', allow_pickle=False) as z:
            self.label, self.size, self.split = z['label'].astype(np.int64), z['size'], z['split']
            self.ids, self.groups = z['id'], z['group']
        self._pts = None

    def __len__(self):
        return len(self.label)

    def __getstate__(self):
        s = dict(self.__dict__)
        s['_pts'] = None
        return s

    def points(self, row):
        if self._pts is None:
            self._pts = np.load(self.dir / 'points.npy', mmap_mode='r')
        return np.array(self._pts[row], dtype=np.float32)

    def __getitem__(self, item):
        row, epoch = (item if isinstance(item, (tuple, list)) else (item, -1))
        row = int(row)
        p = self.points(row)
        if self.train and self.augment != 'none':
            r = rng_for(self.seed, 'rot', row, epoch)
            R = random_rotation(r) if self.augment == 'so3' else rotation_about_z(r)
            p = normalize_cloud(p @ R.T)[0].astype(np.float32)   # unit bbox diagonal again, as at eval time
        return dict(pts=p, size=self.size[row].astype(np.float32), label=np.int64(self.label[row]), row=np.int64(row))
