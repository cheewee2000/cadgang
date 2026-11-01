"""Stage 2 data: touching-part pairs from the stage 1 dumps (<id>.json + <id>.f32). Numpy only.

Dump format (compute/automate/explode.automate.mjs --dump): <id>.json has
  parts: [{occ, part, first, count, bbox: [minx, miny, minz, maxx, maxy, maxz]}]   world mm; first/count in vertices
  mates: [{type, occs: [occA, occB], axis, origin, dot, together}]                axis = world z of the first mate frame
  solve: [{occ, dir | null, len, parent, stage}]                                  the rule solver's answer per part
and <id>.f32 holds every part's vertices (float32 xyz, world mm) back to back in parts order.

build_index() reads only the JSON files (and the .f32 sizes) and writes one row per touching pair. PairDataset
reads the two parts' vertex ranges from a memory map of <id>.f32 per item, so the corpus never sits in RAM."""
from __future__ import annotations

import json
import multiprocessing as mp
import time
from collections import Counter
from pathlib import Path

import numpy as np

from cadnn.util import atomic_write_json, random_rotation, rng_for, sample_indices, split_of

try:
    from scipy.spatial import cKDTree
except ImportError:   # optional: the numpy fallback gives the same mask, slower
    cKDTree = None

LABELS = ('FASTENED', 'REVOLUTE', 'SLIDER', 'CYLINDRICAL', 'PLANAR', 'BALL', 'NONE')
LABEL_ID = {n: i for i, n in enumerate(LABELS)}
NONE_ID = LABEL_ID['NONE']
FOLD = {'PIN_SLOT': 'SLIDER', 'PARALLEL': 'PLANAR'}
AXIAL = ('REVOLUTE', 'SLIDER', 'CYLINDRICAL')        # the axis loss and the axis report cover these only
AXIAL_IDS = tuple(LABEL_ID[n] for n in AXIAL)
# a pair with several mates takes the first type in this order: the ones that say how the part moves come first
PRIORITY = ('REVOLUTE', 'CYLINDRICAL', 'SLIDER', 'BALL', 'PLANAR', 'FASTENED')
N_CH = 5      # per point: x, y, z, contact (within contact_mm of a vertex of the other part), inside the other's bbox + contact_mm
N_EXTRA = 4   # per pair: log10(pair diagonal mm), diag A / pair diag, diag B / pair diag, bbox gap / pair diag
SPLIT_NAMES = ('train', 'val', 'test')

INT_COLS = dict(occ_a=np.int32, occ_b=np.int32, first_a=np.int64, count_a=np.int64, first_b=np.int64,
                count_b=np.int64, label=np.int8, n_mates=np.int16)
VEC_COLS = dict(bbox_a=6, bbox_b=6, axis=3, solver_dir=3)


def fold_type(t):
    """The stage 2 label for an AutoMate mate type, or None for a type outside the label set."""
    t = FOLD.get(str(t).upper(), str(t).upper())
    return t if t in LABEL_ID and t != 'NONE' else None


def bbox_gap(a, b):
    """Euclidean distance between two boxes [min xyz, max xyz]; 0 when they touch or overlap."""
    a, b = np.asarray(a, dtype=np.float64), np.asarray(b, dtype=np.float64)
    d = np.maximum(0.0, np.maximum(a[:3] - b[3:], b[:3] - a[3:]))
    return float(np.linalg.norm(d))


def bbox_diag(b):
    b = np.asarray(b, dtype=np.float64)
    return float(np.linalg.norm(b[3:] - b[:3]))


def _unit(v):
    if v is None:
        return None
    v = np.asarray(v, dtype=np.float64).reshape(-1)
    if v.shape != (3,) or not np.all(np.isfinite(v)):
        return None
    n = np.linalg.norm(v)
    return v / n if n > 1e-9 else None


def pairs_of(asm, gap_mm=1.0):
    """Rows for every two parts whose bboxes are within gap_mm, smaller part (bbox diagonal) first as the stage 1
    harness scores 'the smaller part'. Returns (rows, stats Counter)."""
    st = Counter()
    parts = asm.get('parts') or []
    by_occ = {p['occ']: p for p in parts}
    solve = {s.get('occ'): s for s in asm.get('solve') or []}
    mates = {}
    for m in asm.get('mates') or []:
        occs = m.get('occs') or []
        if len(occs) != 2 or occs[0] == occs[1] or any(o not in by_occ for o in occs):
            st['mate_bad_occs'] += 1
            continue
        t = fold_type(m.get('type'))
        if t is None:
            st[f'mate_type_skipped:{m.get("type")}'] += 1
            continue
        if str(m.get('type')).upper() in FOLD:
            st[f'mate_folded:{str(m.get("type")).upper()}->{t}'] += 1
        mates.setdefault(tuple(sorted(occs)), []).append((t, m.get('axis'), occs[0]))
    rows = []
    for i in range(len(parts)):
        for j in range(i + 1, len(parts)):
            pa, pb = parts[i], parts[j]
            key = tuple(sorted((pa['occ'], pb['occ'])))
            ms = mates.get(key)
            gap = bbox_gap(pa['bbox'], pb['bbox'])
            if gap > gap_mm:
                if ms:
                    st['mate_not_touching'] += len(ms)
                continue
            if pa['count'] <= 0 or pb['count'] <= 0:
                st['pair_empty_part'] += 1
                continue
            da, db = bbox_diag(pa['bbox']), bbox_diag(pb['bbox'])
            best = min(ms, key=lambda m: PRIORITY.index(m[0])) if ms else None
            # on a tie the harness (diag(a) <= diag(b)) takes the mate's first occurrence as the smaller part
            tie_first = best[2] if best else min(pa['occ'], pb['occ'])
            if db < da or (db == da and pb['occ'] == tie_first):
                pa, pb = pb, pa
            label, axis = 'NONE', None
            if ms:
                label, raw_axis, _ = best
                if len({m[0] for m in ms}) > 1:
                    st['pair_several_mate_types'] += 1
                if label in AXIAL:
                    axis = _unit(raw_axis)
                    if axis is None:
                        st['axial_mate_without_axis'] += 1
            sdir = _unit((solve.get(pa['occ']) or {}).get('dir'))
            rows.append(dict(occ_a=pa['occ'], occ_b=pb['occ'], first_a=pa['first'], count_a=pa['count'],
                             first_b=pb['first'], count_b=pb['count'], bbox_a=pa['bbox'], bbox_b=pb['bbox'],
                             label=LABEL_ID[label], n_mates=len(ms or ()),
                             axis=axis if axis is not None else [np.nan] * 3,
                             solver_dir=sdir if sdir is not None else [np.nan] * 3, gap=gap))
            st[f'pairs:{label}'] += 1
    return rows, st


def _rows_to_arrays(rows):
    out = {k: np.array([r[k] for r in rows], dtype=t) for k, t in INT_COLS.items()}
    out.update({k: np.array([r[k] for r in rows], dtype=np.float32).reshape(-1, n) for k, n in VEC_COLS.items()})
    out['gap'] = np.array([r['gap'] for r in rows], dtype=np.float32)
    return out


def _scan(job):
    path, gap_mm = job
    path = Path(path)
    st = Counter()
    try:
        asm = json.loads(path.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        st['asm_bad_json'] += 1
        return path.stem, None, st, False
    f32 = path.with_suffix('.f32')
    total = sum(int(p.get('count', 0)) for p in asm.get('parts') or [])
    if not f32.exists():
        st['asm_missing_f32'] += 1
        return path.stem, None, st, False
    if f32.stat().st_size != total * 12:
        st['asm_f32_size_mismatch'] += 1
        return path.stem, None, st, False
    rows, s2 = pairs_of(asm, gap_mm)
    st.update(s2)
    st['asm_ok'] += 1
    if not rows:
        st['asm_no_touching_pairs'] += 1
    return path.stem, (_rows_to_arrays(rows) if rows else None), st, bool(asm.get('synthetic'))


def build_index(dump_dir, out_dir, gap_mm=1.0, seed=0, val=0.1, test=0.1, ids=None, workers=1, log=print):
    """Scan <dump_dir>/*.json (or the given ids) and write out_dir/pairs.npz and out_dir/index.json.
    The split is a hash of the assembly id: every pair of an assembly lands in the same split."""
    dump = Path(dump_dir)
    files = sorted(dump.glob('*.json')) if ids is None else [dump / f'{i}.json' for i in ids]
    jobs = [(str(f), gap_mm) for f in files]
    st, asm_ids, chunks, splits, synth = Counter(), [], [], [], 0
    t0 = time.time()

    def take(results):
        nonlocal synth
        for k, (stem, arr, s, is_synth) in enumerate(results, 1):
            st.update(s)
            if arr is not None:
                ai = len(asm_ids)
                asm_ids.append(stem)
                synth += is_synth
                sp = split_of(stem, seed, val, test)
                n = len(arr['label'])
                arr['asm'] = np.full(n, ai, dtype=np.int32)
                arr['split'] = np.full(n, sp, dtype=np.int8)
                chunks.append(arr)
            if k % 5000 == 0:
                log(f'{k}/{len(jobs)} assemblies scanned, {sum(len(c["label"]) for c in chunks)} pairs, {time.time() - t0:.0f} s')

    if workers > 1:
        with mp.Pool(workers) as pool:
            take(pool.imap(_scan, jobs, chunksize=32))
    else:
        take(map(_scan, jobs))
    if not chunks:
        raise SystemExit(f'no usable pairs under {dump} ({dict(st)})')
    cols = {k: np.concatenate([c[k] for c in chunks]) for k in chunks[0]}
    cols['asm_ids'] = np.array(asm_ids, dtype=str)
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    tmp = out / 'pairs.npz.tmp'
    with open(tmp, 'wb') as f:
        np.savez(f, **cols)
    tmp.replace(out / 'pairs.npz')
    counts = {SPLIT_NAMES[s]: {LABELS[l]: int(((cols['split'] == s) & (cols['label'] == l)).sum()) for l in range(len(LABELS))}
              for s in range(3)}
    asm_split = Counter(SPLIT_NAMES[split_of(a, seed, val, test)] for a in asm_ids)
    meta = dict(dump_dir=str(dump.resolve()), gap_mm=gap_mm, seed=seed, val=val, test=test, assemblies=len(asm_ids),
                assemblies_per_split=dict(asm_split), pairs=int(len(cols['label'])), pairs_per_split_and_label=counts,
                synthetic_assemblies=synth, stats=dict(sorted(st.items())), labels=list(LABELS), created=time.strftime('%Y-%m-%d %H:%M:%S'))
    atomic_write_json(out / 'index.json', meta)
    log(f'{meta["pairs"]} pairs from {len(asm_ids)} assemblies -> {out}/pairs.npz ({time.time() - t0:.0f} s)')
    return meta


def load_index(index_dir):
    d = Path(index_dir)
    with np.load(d / 'pairs.npz', allow_pickle=False) as z:
        idx = {k: z[k] for k in z.files}
    meta = json.loads((d / 'index.json').read_text(encoding='utf-8'))
    return idx, meta


def rows_in(index, split):
    s = SPLIT_NAMES.index(split) if isinstance(split, str) else int(split)
    return np.flatnonzero(index['split'] == s)


def train_rows_for_epoch(index, epoch, seed=0, none_ratio=2.0, limit=None):
    """Training rows of one epoch: every mated pair plus none_ratio x as many NONE pairs, drawn afresh each epoch
    (deterministic in seed and epoch). none_ratio < 0 keeps every NONE pair. limit caps the total (smoke runs)."""
    rows = rows_in(index, 'train')
    if limit:
        rows = rows[np.sort(rng_for(seed, 'limit').permutation(len(rows))[:limit])]
    if none_ratio is not None and none_ratio >= 0:
        lab = index['label'][rows]
        none, pos = rows[lab == NONE_ID], rows[lab != NONE_ID]
        k = int(round(none_ratio * len(pos))) if len(pos) else len(none)
        if k < len(none):
            none = none[np.sort(rng_for(seed, 'none', epoch).choice(len(none), k, replace=False))]
        rows = np.sort(np.concatenate([pos, none]))
    return rows


def near(p, v, tol, use_kdtree=True):
    """Boolean mask: which points p lie within tol of some point of v."""
    out = np.zeros(len(p), dtype=bool)
    if not len(v) or not len(p):
        return out
    lo, hi = p.min(0) - tol, p.max(0) + tol
    v = v[np.all((v >= lo) & (v <= hi), axis=1)]           # only the vertices that can be near any point
    if not len(v):
        return out
    vlo, vhi = v.min(0) - tol, v.max(0) + tol
    cand = np.flatnonzero(np.all((p >= vlo) & (p <= vhi), axis=1))
    if not len(cand):
        return out
    q = p[cand]
    if use_kdtree and cKDTree is not None:
        d, _ = cKDTree(v).query(q, k=1)
        out[cand] = d <= tol
        return out
    hit = np.zeros(len(q), dtype=bool)
    step = max(1, 1_000_000 // len(q))
    for s in range(0, len(v), step):
        w = v[s:s + step]
        hit |= (((q[:, None, :] - w[None, :, :]) ** 2).sum(-1) <= tol * tol).any(1)
    out[cand] = hit
    return out


def in_box(p, box, tol):
    box = np.asarray(box, dtype=np.float64)
    return np.all((p >= box[:3] - tol) & (p <= box[3:] + tol), axis=1)


def make_pair(va, vb, bbox_a, bbox_b, n_points, contact_mm, rng_a, rng_b, gap=0.0):
    """Model input for one pair from the parts' world vertices (mm): (xa, xb, extra).
    xa, xb: (n_points, N_CH) float32 = xyz centred on the pair's joint bbox and divided by its diagonal, then
    contact (within contact_mm of a vertex of the other part) and inside-other-bbox (+ contact_mm) flags."""
    pa = np.asarray(va[sample_indices(len(va), n_points, rng_a)], dtype=np.float64)
    pb = np.asarray(vb[sample_indices(len(vb), n_points, rng_b)], dtype=np.float64)
    ba, bb = np.asarray(bbox_a, dtype=np.float64), np.asarray(bbox_b, dtype=np.float64)
    lo, hi = np.minimum(ba[:3], bb[:3]), np.maximum(ba[3:], bb[3:])
    c, d = (lo + hi) / 2, float(np.linalg.norm(hi - lo))
    if not d > 1e-9:
        d = 1.0
    va64, vb64 = np.asarray(va, dtype=np.float64), np.asarray(vb, dtype=np.float64)
    xa = np.concatenate([(pa - c) / d, near(pa, vb64, contact_mm)[:, None], in_box(pa, bb, contact_mm)[:, None]], 1)
    xb = np.concatenate([(pb - c) / d, near(pb, va64, contact_mm)[:, None], in_box(pb, ba, contact_mm)[:, None]], 1)
    extra = np.array([np.log10(max(d, 1e-3)), bbox_diag(ba) / d, bbox_diag(bb) / d, gap / d], dtype=np.float32)
    return xa.astype(np.float32), xb.astype(np.float32), extra


class PairDataset:
    """Map-style dataset over index rows; item = row or (row, epoch). Works as a torch DataLoader dataset without
    importing torch. train=True resamples points every epoch and applies the augmentation; train=False samples
    every pair the same way every time."""

    def __init__(self, index, dump_dir, n_points=1024, contact_mm=1.0, seed=0, train=False, augment='none',
                 resample=True, cache_files=16):
        if augment not in ('none', 'so3', 'z'):
            raise ValueError(f'augment {augment!r}')
        self.index, self.dump = index, Path(dump_dir)
        self.asm_ids = [str(a) for a in index['asm_ids']]
        self.n_points, self.contact_mm, self.seed = n_points, contact_mm, seed
        self.train, self.augment, self.resample = train, augment, resample
        self._maps, self._cache_files = {}, cache_files

    def __len__(self):
        return len(self.index['label'])

    def __getstate__(self):   # memory maps are reopened in each worker
        s = dict(self.__dict__)
        s['_maps'] = {}
        return s

    def _f32(self, ai):
        m = self._maps.get(ai)
        if m is None:
            if len(self._maps) >= self._cache_files:
                self._maps.pop(next(iter(self._maps)))
            m = self._maps[ai] = np.memmap(self.dump / f'{self.asm_ids[ai]}.f32', dtype='<f4', mode='r')
        return m

    def vertices(self, ai, first, count):
        first, count = int(first), int(count)
        return np.asarray(self._f32(ai)[first * 3:(first + count) * 3]).reshape(-1, 3)

    def __getitem__(self, item):
        row, epoch = (item if isinstance(item, (tuple, list)) else (item, -1))
        row, I = int(row), self.index
        ai = int(I['asm'][row])
        aid = self.asm_ids[ai]
        ep = int(epoch) if (self.train and self.resample) else 'eval'
        va = self.vertices(ai, I['first_a'][row], I['count_a'][row])
        vb = self.vertices(ai, I['first_b'][row], I['count_b'][row])
        xa, xb, extra = make_pair(va, vb, I['bbox_a'][row], I['bbox_b'][row], self.n_points, self.contact_mm,
                                  rng_for(self.seed, 'pts', aid, int(I['occ_a'][row]), ep),
                                  rng_for(self.seed, 'pts', aid, int(I['occ_b'][row]), ep), gap=float(I['gap'][row]))
        label = int(I['label'][row])
        axis, sdir = I['axis'][row].astype(np.float64), I['solver_dir'][row].astype(np.float64)
        amask, smask = label in AXIAL_IDS and bool(np.all(np.isfinite(axis))), bool(np.all(np.isfinite(sdir)))
        axis, sdir = (axis if amask else np.zeros(3)), (sdir if smask else np.zeros(3))
        if self.train and self.augment != 'none':
            r = rng_for(self.seed, 'rot', row, epoch)
            R = random_rotation(r) if self.augment == 'so3' else _z_rotation(r)
            xa[:, :3] = xa[:, :3] @ R.T.astype(np.float32)
            xb[:, :3] = xb[:, :3] @ R.T.astype(np.float32)
            axis, sdir = R @ axis, R @ sdir
        return dict(pa=xa, pb=xb, extra=extra, label=np.int64(label), axis=axis.astype(np.float32),
                    axis_mask=np.float32(amask), solver_dir=sdir.astype(np.float32), solver_mask=np.float32(smask),
                    row=np.int64(row))


def _z_rotation(rng):
    from cadnn.util import rotation_about_z
    return rotation_about_z(rng)
