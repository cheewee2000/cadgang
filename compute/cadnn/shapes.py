"""Surface point samplers for the synthetic fixtures (numpy only). Shapes are centred on the origin with z as
their axis; every function returns (n, 3) float64."""
from __future__ import annotations

import math

import numpy as np


def box(dims, n, rng):
    d = np.asarray(dims, dtype=np.float64) / 2
    areas = np.array([d[1] * d[2], d[0] * d[2], d[0] * d[1]])
    ax = rng.choice(3, size=n, p=areas / areas.sum())
    p = rng.uniform(-d, d, size=(n, 3))
    p[np.arange(n), ax] = rng.choice([-1.0, 1.0], size=n) * d[ax]
    return p


def cylinder(r, h, n, rng, r_in=0.0, caps=True):
    """A cylinder (or a tube when r_in > 0) of height h about z."""
    a_out, a_in = 2 * math.pi * r * h, 2 * math.pi * r_in * h
    a_cap = 2 * math.pi * (r * r - r_in * r_in) if caps else 0.0
    w = np.array([a_out, a_in, a_cap])
    which = rng.choice(3, size=n, p=w / w.sum())
    th = rng.uniform(0, 2 * math.pi, n)
    rad = np.where(which == 0, r, r_in)
    z = rng.uniform(-h / 2, h / 2, n)
    cap = which == 2
    rad[cap] = np.sqrt(rng.uniform(r_in * r_in, r * r, int(cap.sum())))
    z[cap] = rng.choice([-h / 2, h / 2], size=int(cap.sum()))
    return np.stack([rad * np.cos(th), rad * np.sin(th), z], 1)


def sphere(r, n, rng):
    v = rng.normal(size=(n, 3))
    return r * v / np.linalg.norm(v, axis=1, keepdims=True)


def hex_prism(s, h, n, rng, hole_r=0.0):
    """A hexagonal prism of circumradius s and height h about z, optionally with a through hole."""
    a_side = 6 * s * h
    a_hole = 2 * math.pi * hole_r * h
    a_cap = 2 * (1.5 * math.sqrt(3) * s * s - math.pi * hole_r * hole_r)
    w = np.array([a_side, a_hole, a_cap])
    which = rng.choice(3, size=n, p=w / w.sum())
    out = np.zeros((n, 3))
    k = np.flatnonzero(which == 0)
    if len(k):
        e = rng.integers(0, 6, len(k))
        t = rng.uniform(0, 1, len(k))
        a0, a1 = e * math.pi / 3, (e + 1) * math.pi / 3
        out[k, 0] = s * ((1 - t) * np.cos(a0) + t * np.cos(a1))
        out[k, 1] = s * ((1 - t) * np.sin(a0) + t * np.sin(a1))
        out[k, 2] = rng.uniform(-h / 2, h / 2, len(k))
    k = np.flatnonzero(which == 1)
    if len(k):
        th = rng.uniform(0, 2 * math.pi, len(k))
        out[k] = np.stack([hole_r * np.cos(th), hole_r * np.sin(th), rng.uniform(-h / 2, h / 2, len(k))], 1)
    k = np.flatnonzero(which == 2)
    got = 0
    normals = np.array([[math.cos(a), math.sin(a)] for a in (math.pi / 6, math.pi / 2, 5 * math.pi / 6)])
    while got < len(k):
        q = rng.uniform(-s, s, size=(2 * (len(k) - got) + 8, 2))
        ok = np.all(np.abs(q @ normals.T) <= s * math.sqrt(3) / 2, axis=1) & (np.linalg.norm(q, axis=1) >= hole_r)
        q = q[ok][:len(k) - got]
        out[k[got:got + len(q)], :2] = q
        out[k[got:got + len(q)], 2] = rng.choice([-h / 2, h / 2], size=len(q))
        got += len(q)
    return out


def place(p, R=None, t=None):
    p = np.asarray(p, dtype=np.float64)
    if R is not None:
        p = p @ np.asarray(R).T
    if t is not None:
        p = p + np.asarray(t)
    return p
