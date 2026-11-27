"""Surface inputs for the joint model. The stage 1 dump holds mesh vertices only, and a flat face has none in its
middle: 61% of SLIDER pairs and 39% of PLANAR pairs had no vertex within 1 mm of the other part. With the triangles
(explode.automate.mjs --tris) build_cache() stores, per pair, K points spread by area over each part with the surface
normal and the exact distance to the other part's surface. PairDataset(surface=...) reads it; no mesh work per step.
Building needs open3d (pip install open3d); reading needs numpy only."""
from __future__ import annotations

import json
import multiprocessing as mp
import time
from pathlib import Path

import numpy as np

from cadnn.util import atomic_write_json, rng_for

K = 512
FILES = dict(xyz=('<f4', (2, K, 3)), nrm=('i1', (2, K, 3)), dist=('<f2', (2, K)), ok=('u1', ()))


def surface_sample(v, tri, n, rng):
    """n points spread by area over the mesh (v: (V,3), tri: (T,3)) and the unit normal at each."""
    a = v[tri[:, 0]].astype(np.float64)
    e1, e2 = v[tri[:, 1]] - a, v[tri[:, 2]] - a
    cr = np.cross(e1, e2)
    area = np.linalg.norm(cr, axis=1)
    f = rng.choice(len(tri), size=n, p=area / area.sum())
    u, w = rng.random(n), rng.random(n)
    flip = u + w > 1
    u[flip], w[flip] = 1 - u[flip], 1 - w[flip]
    return a[f] + u[:, None] * e1[f] + w[:, None] * e2[f], cr[f] / area[f, None]


class SurfaceCache:
    """Memory maps over a build_cache() directory: xyz (N,2,K,3) world mm, nrm (N,2,K,3) int8 x127, dist (N,2,K) mm to
    the other part's surface, ok (N,) 1 where the pair has them. Index 0 is part A (the smaller), 1 is part B."""
    def __init__(self, path):
        self.path = Path(path)
        self.meta = json.loads((self.path / 'surface.json').read_text(encoding='utf-8'))
        self._m = {}

    def __getstate__(self):   # memory maps are reopened in each worker
        return dict(path=self.path, meta=self.meta, _m={})

    def __getattr__(self, name):
        if name not in FILES:
            raise AttributeError(name)
        if name not in self._m:
            dt, shape = FILES[name]
            self._m[name] = np.memmap(self.path / f'{name}.bin', dtype=dt, mode='r', shape=(self.meta['pairs'], *shape))
        return self._m[name]


_G = {}


def _one_assembly(job):
    """Every pair of one assembly: (rows, xyz, nrm, dist), or (rows, None, ...) when its triangles are missing."""
    import open3d as o3d
    aid, rows, occ_a, first_a, count_a, occ_b, first_b, count_b = job
    dump, tris, seed = _G['dump'], _G['tris'], _G['seed']
    try:
        parts = {int(o): (int(f), int(c)) for o, f, c in json.loads((tris / f'{aid}.tri.json').read_text())['parts']}
        u32 = np.fromfile(tris / f'{aid}.u32', dtype='<u4')
        f32 = np.fromfile(dump / f'{aid}.f32', dtype='<f4').reshape(-1, 3)
    except (OSError, ValueError, KeyError):
        return rows, None, None, None
    mesh = {}

    def part(occ, first, count):
        if occ not in mesh:
            v, t = f32[first:first + count], None
            if occ in parts:
                t = u32[parts[occ][0]:parts[occ][0] + parts[occ][1]].reshape(-1, 3)
                if len(t) and t.max() < count:   # triangles with no area cannot be sampled
                    t = t[np.linalg.norm(np.cross(v[t[:, 1]] - v[t[:, 0]], v[t[:, 2]] - v[t[:, 0]]), axis=1) > 0]
                else:
                    t = None
            scene = None
            if t is not None and len(t):
                scene = o3d.t.geometry.RaycastingScene(nthreads=1)
                scene.add_triangles(o3d.core.Tensor(np.ascontiguousarray(v)), o3d.core.Tensor(np.ascontiguousarray(t)))
            mesh[occ] = (v, t, scene)
        return mesh[occ]

    xyz = np.zeros((len(rows), 2, K, 3), np.float32)
    nrm = np.zeros((len(rows), 2, K, 3), np.int8)
    dist = np.zeros((len(rows), 2, K), np.float16)
    ok = np.zeros(len(rows), np.uint8)
    for j in range(len(rows)):
        A, B = part(int(occ_a[j]), int(first_a[j]), int(count_a[j])), part(int(occ_b[j]), int(first_b[j]), int(count_b[j]))
        if A[2] is None or B[2] is None:
            continue
        for s, (P, Q) in enumerate(((A, B), (B, A))):
            p, n = surface_sample(P[0], P[1], K, rng_for(seed, 'surf', aid, int(occ_a[j]), int(occ_b[j]), s))
            xyz[j, s] = p
            nrm[j, s] = np.round(n * 127)
            d = Q[2].compute_distance(o3d.core.Tensor(xyz[j, s]), nthreads=1).numpy()
            dist[j, s] = np.clip(d, 0, 6e4)
        ok[j] = 1
    dist[ok == 0] = np.inf   # how the parent tells a pair without surfaces
    return rows, xyz, nrm, dist


def build_cache(index_dir, dump, tris, out, workers=1, seed=0, log=print):
    from joints.data import load_index
    index, meta = load_index(index_dir)
    n, out = len(index['label']), Path(out)
    out.mkdir(parents=True, exist_ok=True)
    maps = {k: np.memmap(out / f'{k}.bin', dtype=dt, mode='w+', shape=(n, *shape)) for k, (dt, shape) in FILES.items()}
    order = np.argsort(index['asm'], kind='stable')
    cuts = np.flatnonzero(np.diff(index['asm'][order])) + 1
    ids = [str(a) for a in index['asm_ids']]
    jobs = [(ids[int(index['asm'][r[0]])], r, *(index[c][r] for c in ('occ_a', 'first_a', 'count_a', 'occ_b', 'first_b', 'count_b')))
            for r in np.split(order, cuts)]
    _G.update(dump=Path(dump or meta['dump_dir']), tris=Path(tris), seed=seed)
    t0, done, good = time.time(), 0, 0
    pool = mp.get_context('fork').Pool(workers) if workers > 1 else None
    for rows, xyz, nrm, dist in (pool.imap_unordered(_one_assembly, jobs, chunksize=8) if pool else map(_one_assembly, jobs)):
        if xyz is not None:
            has = np.isfinite(dist[:, 0, 0])
            maps['xyz'][rows], maps['nrm'][rows], maps['dist'][rows], maps['ok'][rows] = xyz, nrm, dist, has
            good += int(has.sum())
        done += 1
        if done % 2000 == 0:
            log(f'{done}/{len(jobs)} assemblies, {good} pairs with surfaces, {(time.time() - t0) / 60:.1f} min')
    if pool:
        pool.close()
    for m in maps.values():
        m.flush()
    info = dict(pairs=n, k=K, with_surface=good, index=str(index_dir), tris=str(tris), seed=seed)
    atomic_write_json(out / 'surface.json', info)
    log(f'{good} of {n} pairs have surfaces -> {out} ({(time.time() - t0) / 60:.1f} min)')
    return info
