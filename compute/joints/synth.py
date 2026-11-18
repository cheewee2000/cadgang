"""A tiny stage 1 dump for tests and the self-test: assemblies of a base plate with parts sitting on it, one per
mate type, in the exact <id>.json + <id>.f32 format compute/automate/explode.automate.mjs --dump writes.

Every assembly is rotated and moved at random, so axes are not always world z. Occurrence numbers start at 10 so
nothing can assume occ == position. Some parts have fewer vertices than a sample (exercises repeats), PIN_SLOT and
PARALLEL appear (exercise folding), and odd assemblies carry a mate between parts that do not touch. The solver
answers are a mix of right axes, noisy axes, random directions and unmoved parts. Each JSON says synthetic: true,
so reports built on it say so."""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from cadnn import shapes
from cadnn.util import random_rotation, rng_for

Z = np.array([0.0, 0.0, 1.0])


def _part(kind, rng):
    """(local vertices sitting on z = 0, local mate axis) for a part of the given mate type."""
    if kind == 'REVOLUTE':      # a disc
        return shapes.cylinder(5, 3, int(rng.integers(300, 900)), rng) + [0, 0, 1.5], Z
    if kind == 'CYLINDRICAL':   # a rod
        return shapes.cylinder(2, 20, int(rng.integers(300, 900)), rng) + [0, 0, 10], Z
    if kind in ('SLIDER', 'PIN_SLOT'):   # a block, long along its axis
        along_x = rng.random() < 0.5
        dims = (8, 4, 4) if along_x else (4, 8, 4)
        return shapes.box(dims, int(rng.integers(150, 700)), rng) + [0, 0, 2], (np.array([1.0, 0, 0]) if along_x else np.array([0, 1.0, 0]))
    if kind in ('PLANAR', 'PARALLEL'):   # a pad
        return shapes.box((8, 8, 2), int(rng.integers(150, 700)), rng) + [0, 0, 1], Z
    if kind == 'FASTENED':      # a screw: shank and head
        shank = shapes.cylinder(1.5, 10, 400, rng) + [0, 0, 5]
        head = shapes.cylinder(2.6, 2, 200, rng) + [0, 0, 11]
        return np.concatenate([shank, head]), Z
    if kind == 'BALL':
        return shapes.sphere(4, int(rng.integers(300, 900)), rng) + [0, 0, 4], Z
    if kind == 'NONE':          # touches the plate, no mate
        return shapes.box((6, 6, 6), int(rng.integers(150, 700)), rng) + [0, 0, 3], Z
    raise ValueError(kind)


KINDS = ('REVOLUTE', 'CYLINDRICAL', 'SLIDER', 'PLANAR', 'FASTENED', 'BALL', 'NONE', 'PIN_SLOT', 'PARALLEL')
SLOTS = [(x, y) for x in (-24, -12, 0, 12, 24) for y in (-12, 0, 12)]


def make_assembly(i, seed=0):
    rng = rng_for(seed, 'synth-joints', i)
    R, t = random_rotation(rng), rng.uniform(-200, 200, 3)
    kinds = [KINDS[(i + k) % len(KINDS)] for k in range(7)]
    slots = [SLOTS[j] for j in rng.permutation(len(SLOTS))[:len(kinds)]]
    local = [(shapes.box((60, 40, 5), 1500, rng) + [0, 0, -2.5], None, 'PLATE')]
    for kind, (x, y) in zip(kinds, slots):
        v, ax = _part(kind, rng)
        local.append((v + [x, y, 0], ax, kind))
    if i % 2:   # mated but 100 mm away from the plate: must not become a pair
        local.append((shapes.box((6, 6, 6), 300, rng) + [100, 0, 50], Z, 'FASTENED'))
    verts, parts, mates, solve, first = [], [], [], [], 0
    for k, (v, ax, kind) in enumerate(local):
        w = shapes.place(v, R, t).astype(np.float32)
        occ = 10 + k
        lo, hi = w.min(0), w.max(0)
        parts.append(dict(occ=occ, part=f'synth-{kind.lower()}-{i}-{k}', first=first, count=len(w),
                          bbox=[round(float(c), 3) for c in (*lo, *hi)]))
        verts.append(w)
        first += len(w)
        wax = R @ ax if ax is not None else None
        if kind not in ('PLATE', 'NONE'):
            mates.append(dict(type=kind, occs=[10, occ], axis=[round(float(c), 4) for c in wax],
                              origin=[round(float(c), 3) for c in w.mean(0)], dot=0.0, together=False))
        u = rng.random()
        if kind == 'PLATE' or u < 0.2:
            d = None
        elif u < 0.6 and wax is not None:
            d = wax
        elif u < 0.8 and wax is not None:
            d = wax + rng.normal(scale=0.15, size=3)
        else:
            d = rng.normal(size=3)
        if d is not None:
            d = d / np.linalg.norm(d) * (1 if rng.random() < 0.5 else -1)
        solve.append(dict(occ=occ, dir=None if d is None else [round(float(c), 4) for c in d],
                          len=0.0 if d is None else 10.0, parent=None if kind == 'PLATE' else 10, stage=0))
    return dict(id=f'synth-{i:03d}', synthetic=True, parts=parts, mates=mates, solve=solve), np.concatenate(verts)


def write_dump(out_dir, n_assemblies=12, seed=0):
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    ids = []
    for i in range(n_assemblies):
        asm, v = make_assembly(i, seed)
        (out / f'{asm["id"]}.json').write_text(json.dumps(asm), encoding='utf-8')
        v.astype('<f4').tofile(out / f'{asm["id"]}.f32')
        ids.append(asm['id'])
    return ids
