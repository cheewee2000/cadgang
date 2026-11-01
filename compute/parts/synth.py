"""A small synthetic parts-labelled.jsonl for tests and the self-test: simple shapes per class (a screw is a shank
and a head, a nut a holed hex prism...) written in every format data.py accepts, with groups, a duplicate body in a
second group, and optionally broken lines. Every record says synthetic: true so reports built on it say so."""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from cadnn import shapes
from cadnn.util import random_rotation, rng_for
from parts.data import CLASSES


def make_points(cls, rng, n):
    u = rng.uniform
    if cls == 'screw':
        r, L = u(1.2, 3), u(6, 30)
        k = int(n * 0.75)
        return np.concatenate([shapes.cylinder(r, L, k, rng) + [0, 0, L / 2],
                               shapes.cylinder(1.8 * r, 1.2 * r, n - k, rng) + [0, 0, L + 0.6 * r]])
    if cls == 'nut':
        s = u(3, 8)
        return shapes.hex_prism(s, 0.8 * s, n, rng, hole_r=0.5 * s)
    if cls == 'washer':
        ro = u(3, 10)
        return shapes.cylinder(ro, 0.1 * ro, n, rng, r_in=0.55 * ro)
    if cls == 'standoff':
        s = u(2.5, 4)
        return shapes.hex_prism(s, u(8, 30), n, rng, hole_r=0.45 * s)
    if cls == 'pcb':
        w, d = u(20, 100), u(15, 80)
        k = int(n * 0.8)
        chips = [shapes.box((u(2, 10), u(2, 10), u(1, 3)), (n - k) // 4 + (1 if i < (n - k) % 4 else 0), rng)
                 + [u(-w / 3, w / 3), u(-d / 3, d / 3), 1.6] for i in range(4)]
        return np.concatenate([shapes.box((w, d, 1.6), k, rng), *chips])
    if cls == 'bearing':
        ro = u(5, 20)
        return shapes.cylinder(ro, 0.35 * ro, n, rng, r_in=0.5 * ro)
    kind = rng.integers(0, 3)
    if kind == 0:
        return shapes.box(u(5, 60, 3), n, rng)
    if kind == 1:
        return shapes.sphere(u(3, 30), n, rng)
    a, b = u(10, 40), u(10, 40)   # an L bracket
    k = n // 2
    return np.concatenate([shapes.box((a, 10, 2), k, rng) + [a / 2, 0, 0], shapes.box((2, 10, b), n - k, rng) + [0, 0, b / 2]])


def make_record(cls, i, rng, n_points=1024, j=0, n_groups=10):
    """Record i of a class (i picks the formats), j-th in the file (j picks the group)."""
    n = n_points if i % 5 else (n_points // 2 if i % 2 else n_points + 200)   # some clouds need resampling
    p = make_points(cls, rng, n) @ random_rotation(rng).T + rng.uniform(-50, 50, 3)
    lo, hi = p.min(0), p.max(0)
    p = np.round(p, 4)
    labels = (cls, cls.upper(), cls.capitalize() + 's')
    rec = {('label', 'class', 'category')[i % 3]: labels[i % 3], 'synthetic': True,
           ('group', 'file')[i % 2]: f'file-{j % n_groups}', 'id': f'{cls}-{i}'}
    pts = p.reshape(-1).tolist() if i % 2 else p.tolist()
    rec['points' if i % 3 else 'pts'] = pts
    b = [*np.round(lo, 4).tolist(), *np.round(hi, 4).tolist()]
    rec['bbox'] = (b, {'min': b[:3], 'max': b[3:]}, [b[:3], b[3:]])[i % 3]
    return rec


BAD_LINES = ['not json at all',
             '{"label": "screw"}',
             '{"label": "nut", "points": [1, 2]}',
             '{"label": "nut", "points": [NaN, 0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4, 5, 5, 5, 6, 6, 6, 7, 7, 7]}',
             '{"label": "washer", "points": [[0, 0, 0], [1, 1]]}',
             '{"label": "washer", "points": ' + json.dumps([[i, i % 3, i % 5] for i in range(16)]) + ', "bbox": [1, 1, 1, 0, 0, 0]}']
UNKNOWN_LINE = {'label': 'widget', 'points': [[i, i % 3, i % 5] for i in range(16)], 'group': 'file-0', 'synthetic': True}


def write_jsonl(path, per_class=8, seed=0, n_points=1024, bad=False):
    """Writes the file and returns the number of valid records with a known class."""
    rng = rng_for(seed, 'synth-parts')
    lines, n = [], 0
    for cls in CLASSES:
        for i in range(per_class):
            lines.append(json.dumps(make_record(cls, i, rng, n_points, j=n)))
            n += 1
    dup = json.loads(lines[0])               # the same body again, in a different file: groups must merge
    dup['group' if 'group' in dup else 'file'] = 'file-dup'
    dup['id'] = 'dup-of-' + dup['id']
    lines.append(json.dumps(dup))
    n += 1
    if bad:
        lines += BAD_LINES + [json.dumps(UNKNOWN_LINE)]
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text('\n'.join(lines) + '\n', encoding='utf-8')
    return n
