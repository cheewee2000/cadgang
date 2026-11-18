"""Numpy-only helpers shared by compute/joints (stage 2) and compute/parts (stage 3).

Nothing here imports torch, so data indexing and label validation run on a machine without it. Every random
choice goes through rng_for(key...): a generator seeded from the key alone, so a sample is the same in any
process, in any order, and after a resume."""
from __future__ import annotations

import hashlib
import json
import math
import os
from pathlib import Path

import numpy as np

SPLITS = ('train', 'val', 'test')


def _h64(key: str) -> int:
    return int.from_bytes(hashlib.sha256(key.encode('utf-8')).digest()[:8], 'little')


def rng_for(*key) -> np.random.Generator:
    """A numpy generator seeded from the key (any printable values)."""
    return np.random.default_rng(_h64('\x1f'.join(map(str, key))))


def split_of(group, seed=0, val=0.1, test=0.1) -> int:
    """0 train, 1 val, 2 test, from a hash of the group (an assembly id, a source file). A group never straddles
    splits, and adding groups later does not move the old ones."""
    u = _h64(f'split\x1f{seed}\x1f{group}') / 2.0 ** 64
    return 2 if u < test else 1 if u < test + val else 0


def sample_indices(n, k, rng):
    """k indices into n points: without replacement when there are enough, else every point once plus repeats."""
    if n <= 0:
        raise ValueError('no points to sample from')
    if n >= k:
        return rng.choice(n, size=k, replace=False)
    return np.concatenate([rng.permutation(n), rng.integers(0, n, size=k - n)])


def random_rotation(rng):
    """A uniformly random proper rotation matrix (3x3)."""
    q, r = np.linalg.qr(rng.normal(size=(3, 3)))
    q = q * np.sign(np.diag(r))
    if np.linalg.det(q) < 0:
        q[:, 0] = -q[:, 0]
    return q


def rotation_about_z(rng):
    a = rng.uniform(0, 2 * math.pi)
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, -s, 0.0], [s, c, 0.0], [0.0, 0.0, 1.0]])


def normalize_cloud(p, lo=None, hi=None):
    """Centre on the box (lo, hi) (default: the points' own bbox) and scale its diagonal to 1.
    Returns (points, centre, diagonal)."""
    p = np.asarray(p, dtype=np.float64)
    lo = p.min(0) if lo is None else np.asarray(lo, dtype=np.float64)
    hi = p.max(0) if hi is None else np.asarray(hi, dtype=np.float64)
    c = (lo + hi) / 2
    d = float(np.linalg.norm(hi - lo))
    if not d > 1e-12:
        d = 1.0
    return (p - c) / d, c, d


def angle_deg(u, v):
    """Sign-invariant angle in degrees between rows of u and v (an axis and its reverse are the same axis)."""
    u = np.asarray(u, dtype=np.float64).reshape(-1, 3)
    v = np.asarray(v, dtype=np.float64).reshape(-1, 3)
    if not len(u):
        return np.zeros(0)
    c = np.abs((u * v).sum(1)) / np.maximum(np.linalg.norm(u, axis=1) * np.linalg.norm(v, axis=1), 1e-12)
    return np.degrees(np.arccos(np.clip(c, 0.0, 1.0)))


def angle_stats(e):
    e = np.asarray(e, dtype=np.float64)
    if not len(e):
        return dict(n=0)
    return dict(n=int(len(e)), mean=float(e.mean()), median=float(np.median(e)), p90=float(np.percentile(e, 90)),
                within_5=float((e <= 5).mean()), within_15=float((e <= 15).mean()))


def class_metrics(y, p, names):
    """Confusion matrix plus per-class support / recall / precision / F1 and their macro means over the classes
    that occur in y. Recall is the per-class accuracy."""
    k = len(names)
    y = np.asarray(y, dtype=np.int64)
    p = np.asarray(p, dtype=np.int64)
    cm = np.zeros((k, k), dtype=np.int64)
    np.add.at(cm, (y, p), 1)
    per = {}
    for i, name in enumerate(names):
        sup, pred, tp = int(cm[i].sum()), int(cm[:, i].sum()), int(cm[i, i])
        rec = tp / sup if sup else None
        prec = tp / pred if pred else None
        f1 = (2 * prec * rec / (prec + rec) if prec and rec else 0.0) if sup else None
        per[name] = dict(support=sup, predicted=pred, correct=tp, recall=rec, precision=prec, f1=f1)
    present = [v for v in per.values() if v['support']]
    return dict(n=int(len(y)), accuracy=float(np.trace(cm) / len(y)) if len(y) else None,
                macro_recall=float(np.mean([v['recall'] for v in present])) if present else None,
                macro_f1=float(np.mean([v['f1'] for v in present])) if present else None,
                per_class=per, confusion=cm.tolist(), names=list(names))


def class_weights(labels, n_classes, mode='sqrt-inv', clip=50.0):
    """Loss weights from training label counts: 'none', 'inv' (1/count) or 'sqrt-inv' (1/sqrt(count)), scaled so
    the average weight over the training samples is 1. Classes with no samples get 0. Returns None for 'none'."""
    if mode == 'none':
        return None
    if mode not in ('inv', 'sqrt-inv'):
        raise ValueError(f'class weight mode {mode!r}')
    labels = np.asarray(labels, dtype=np.int64)
    counts = np.bincount(labels, minlength=n_classes).astype(np.float64)
    w = np.zeros(n_classes)
    have = counts > 0
    w[have] = (counts.sum() / counts[have]) ** (1.0 if mode == 'inv' else 0.5)
    if len(labels):
        w /= w[labels].mean()
    return np.minimum(w, clip)


def clean(o):
    """JSON-safe copy: numpy scalars and arrays to python, NaN and inf to None."""
    if isinstance(o, dict):
        return {str(k): clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [clean(v) for v in o]
    if isinstance(o, np.ndarray):
        return clean(o.tolist())
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, (np.floating, float)):
        f = float(o)
        return f if math.isfinite(f) else None
    if isinstance(o, (np.bool_,)):
        return bool(o)
    if isinstance(o, Path):
        return str(o)
    return o


def atomic_write_text(path, text):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + '.tmp')
    tmp.write_text(text, encoding='utf-8')
    os.replace(tmp, path)


def atomic_write_json(path, obj):
    atomic_write_text(path, json.dumps(clean(obj), indent=2, allow_nan=False) + '\n')


def file_sha256(path, chunk=1 << 20):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for b in iter(lambda: f.read(chunk), b''):
            h.update(b)
    return h.hexdigest()


def fmt(x, nd=1, pct=False):
    """A number for a markdown table; None as a dash."""
    if x is None:
        return '–'
    if pct:
        return f'{100 * x:.{nd}f}%'
    return f'{x:.{nd}f}' if isinstance(x, float) else str(x)


def md_table(header, rows):
    out = ['| ' + ' | '.join(header) + ' |', '|' + '---|' * len(header)]
    out += ['| ' + ' | '.join(str(c) for c in r) + ' |' for r in rows]
    return '\n'.join(out)


def parse_ints(s):
    return tuple(int(x) for x in str(s).split(',') if x.strip())
