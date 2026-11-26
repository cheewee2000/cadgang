// 3D-to-2D flattening: faces of a CAD solid (or any triangle mesh) become sewing pattern pieces, with the seams
// that sew them back into the shape they were taken from. A bag, cover or sleeve is patterned straight off the
// hard part it wraps.
//
//   flattenPatch   one connected patch → planar coordinates that keep lengths (conformal start, then as-rigid-as-
//                  possible iterations), with the stretch of every triangle
//   flattenMesh    a body's faces → patches (grown across smooth borders while they lie flat, cut open where they
//                  are closed) → patterns, seams, notches and where each piece sits on the part
//   describeFaces  the bodies and faces a caller can name
//
// Faces are addressed as the viewer addresses them: a body is a triangle range with a name, a face is the n-th
// B-rep face range inside it (mesh.bodies, mesh.faces: what importCadFile and tessellateBodies return). mm.

import { GraphError } from './errors.js';
import { segmentLength } from './softgoods-export.js';

const DEG = 180 / Math.PI;
const r4 = (v) => Math.round(v * 1e4) / 1e4 + 0;   // + 0: never -0
const r3 = (v) => Math.round(v * 1e3) / 1e3 + 0;

// ------------------------------------------------------------------ solver

/** Conjugate gradients with a diagonal preconditioner, on a symmetric positive semi-definite operator given as a
 *  function. An entry whose diagonal is 0 is held at the value it came in with (a pinned vertex). */
function pcg(mul, b, x, diag, tol, maxIter) {
  const n = b.length, r = new Float64Array(n), z = new Float64Array(n), p = new Float64Array(n), q = new Float64Array(n);
  mul(x, q);
  let rz = 0, bb = 0, rr = 0;
  for (let i = 0; i < n; i++) { r[i] = diag[i] > 0 ? b[i] - q[i] : 0; z[i] = diag[i] > 0 ? r[i] / diag[i] : 0; p[i] = z[i]; rz += r[i] * z[i]; rr += r[i] * r[i]; bb += b[i] * b[i]; }
  const stop = tol * tol * Math.max(bb, rr);
  for (let it = 0; it < maxIter && rr > stop && rz > 0; it++) {
    mul(p, q);
    let pq = 0; for (let i = 0; i < n; i++) { if (!(diag[i] > 0)) q[i] = 0; pq += p[i] * q[i]; }
    if (!(pq > 0)) break;
    const alpha = rz / pq; let next = 0; rr = 0;
    for (let i = 0; i < n; i++) { x[i] += alpha * p[i]; r[i] -= alpha * q[i]; z[i] = diag[i] > 0 ? r[i] / diag[i] : 0; next += r[i] * z[i]; rr += r[i] * r[i]; }
    const beta = next / rz; rz = next;
    for (let i = 0; i < n; i++) p[i] = z[i] + beta * p[i];
  }
  return x;
}

// ----------------------------------------------------------------- flatten

/**
 * Flatten one connected patch that has a boundary. positions: xyz per vertex, triangles: three vertex indices each,
 * wound so the outside faces the viewer. Returns uv (two per vertex, anticlockwise seen from outside), stretch (the
 * two principal stretches of every triangle, 1 = unchanged) and the summary distortion. A developable patch (plane,
 * cylinder, cone, any fold of them) comes out exact; anything else is the nearest to length-preserving it found.
 */
export function flattenPatch(positions, triangles, { boundary = null, iterations = 100 } = {}) {
  const P = positions, T = triangles, n = P.length / 3, m = T.length / 3;
  if (!m) throw new GraphError('Nothing to flatten: the patch has no triangles');
  // Every triangle laid flat on its own: corner 0 at the origin, 1 at (l, 0), 2 at (x2, y2).
  const X = new Float64Array(m * 4); let area3 = 0, big = 0;
  for (let t = 0; t < m; t++) {
    const a = 3 * T[3 * t], b = 3 * T[3 * t + 1], c = 3 * T[3 * t + 2];
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const l = Math.hypot(ux, uy, uz) || 1e-300, y2 = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / l;
    X[4 * t] = l; X[4 * t + 1] = (ux * vx + uy * vy + uz * vz) / l; X[4 * t + 2] = y2; X[4 * t + 3] = l * y2 / 2;
    area3 += X[4 * t + 3]; big = Math.max(big, X[4 * t + 3]);
  }
  const live = (t) => X[4 * t + 3] > 1e-9 * big, edge = Math.sqrt(area3 / m);
  const mate = new Map();   // directed edge a → b: the half-edge on it
  for (let t = 0; t < m; t++) for (let k = 0; k < 3; k++) mate.set(T[3 * t + k] * n + T[3 * t + (k + 1) % 3], 3 * t + k);
  if (!boundary) { boundary = []; for (const e of mate.keys()) if (!mate.has((e % n) * n + Math.floor(e / n))) boundary.push(Math.floor(e / n)); }
  if (!boundary.length) throw new GraphError('A closed surface has to be cut open before it can be flattened');
  const u = new Float64Array(n), v = new Float64Array(n);

  // What a map does to every triangle: the two principal stretches, and their summary.
  const stretch = new Float32Array(m * 2);
  const measure = () => {
    let maxStrain = 0, sum = 0, maxShear = 0, flips = 0, flat = 0;
    for (let t = 0; t < m; t++) {
      const a = T[3 * t], b = T[3 * t + 1], c = T[3 * t + 2], l = X[4 * t], x2 = X[4 * t + 1], y2 = X[4 * t + 2] || 1e-300;
      const ax = (u[b] - u[a]) / l, ay = (v[b] - v[a]) / l, bx = (u[c] - u[a] - x2 * ax) / y2, by = (v[c] - v[a] - x2 * ay) / y2;
      const E = ax * ax + ay * ay, F = ax * bx + ay * by, G = bx * bx + by * by, mid = (E + G) / 2, dev = Math.hypot((E - G) / 2, F);
      const s1 = Math.sqrt(mid + dev), s2 = Math.sqrt(Math.max(mid - dev, 0)), det = ax * by - ay * bx;
      stretch[2 * t] = s1; stretch[2 * t + 1] = s2;
      if (!live(t)) continue;
      flat += det * X[4 * t + 3];
      const strain = Math.max(Math.abs(s1 - 1), Math.abs(s2 - 1));
      maxStrain = Math.max(maxStrain, strain); sum += strain * X[4 * t + 3];
      maxShear = Math.max(maxShear, Math.asin(Math.min(1, (s1 * s1 - s2 * s2) / (s1 * s1 + s2 * s2 || 1))) * DEG);
      if (!(det > 0)) flips++;
    }
    return { maxStrain, meanStrain: sum / area3, maxShear, areaError: flat / area3 - 1, flips, area: area3 };
  };

  // 1. Unfold: lay the triangles down one after another across their shared edges. On a developable patch every
  //    triangle lands unstretched and this is the answer, with nothing to solve.
  const placed = new Uint8Array(n), done = new Uint8Array(m), queue = [0];
  u[T[1]] = X[0]; u[T[2]] = X[1]; v[T[2]] = X[2]; placed[T[0]] = placed[T[1]] = placed[T[2]] = done[0] = 1;
  for (let head = 0; head < queue.length; head++) {
    const t = queue[head];
    for (let k = 0; k < 3; k++) {
      const h = mate.get(T[3 * t + (k + 1) % 3] * n + T[3 * t + k]); if (h === undefined) continue;
      const s = (h / 3) | 0; if (done[s]) continue;
      done[s] = 1; queue.push(s);
      const p = T[h], q = T[3 * s + (h % 3 + 1) % 3], r = T[3 * s + (h % 3 + 2) % 3]; if (placed[r]) continue;
      const ex = P[3 * q] - P[3 * p], ey = P[3 * q + 1] - P[3 * p + 1], ez = P[3 * q + 2] - P[3 * p + 2], fx = P[3 * r] - P[3 * p], fy = P[3 * r + 1] - P[3 * p + 1], fz = P[3 * r + 2] - P[3 * p + 2];
      const ee = ex * ex + ey * ey + ez * ez || 1e-300, along = (ex * fx + ey * fy + ez * fz) / ee, off = Math.hypot(ey * fz - ez * fy, ez * fx - ex * fz, ex * fy - ey * fx) / ee;
      u[r] = u[p] + along * (u[q] - u[p]) - off * (v[q] - v[p]); v[r] = v[p] + along * (v[q] - v[p]) + off * (u[q] - u[p]); placed[r] = 1;
    }
  }
  let distortion = measure(), rounds = 0;
  // (Below a hundredth of a percent the unfolding is kept: an iterative solve is no closer than that.)
  if (distortion.maxStrain > 1e-4 || distortion.flips) {
    if (distortion.maxStrain > 0.1 || distortion.flips) {
      // 2. Too curved to unfold: a least-squares conformal map instead. Per triangle, Σ W_k U_k = 0 in complex
      //    numbers (U = u + iv); two pinned vertices fix position, rotation and scale. Normal equations, never assembled.
      // ponytail: conjugate gradients on this system slows with size and with slivers (a second or two for 10k
      // triangles of doubly curved surface, cut off at 5000 steps); a multigrid or a sparse Cholesky is the upgrade
      // if big domes are flattened in one piece
      const wr = new Float64Array(m * 3), wi = new Float64Array(m * 3), dc = new Float64Array(n * 2);
      for (let t = 0; t < m; t++) {
        if (!live(t)) continue;
        const l = X[4 * t], x2 = X[4 * t + 1], y2 = X[4 * t + 2], s = 1 / Math.sqrt(l * y2);
        wr[3 * t] = (x2 - l) * s; wi[3 * t] = y2 * s; wr[3 * t + 1] = -x2 * s; wi[3 * t + 1] = -y2 * s; wr[3 * t + 2] = l * s;
        for (let k = 0; k < 3; k++) { const d = wr[3 * t + k] ** 2 + wi[3 * t + k] ** 2, i = T[3 * t + k]; dc[2 * i] += d; dc[2 * i + 1] += d; }
      }
      const mulC = (x, out) => {
        out.fill(0);
        for (let t = 0; t < m; t++) {
          let re = 0, im = 0;
          for (let k = 0; k < 3; k++) { const i = 2 * T[3 * t + k], a = wr[3 * t + k], b = wi[3 * t + k]; re += a * x[i] - b * x[i + 1]; im += a * x[i + 1] + b * x[i]; }
          for (let k = 0; k < 3; k++) { const i = 2 * T[3 * t + k], a = wr[3 * t + k], b = wi[3 * t + k]; out[i] += a * re + b * im; out[i + 1] += a * im - b * re; }
        }
      };
      const d3 = (a, b) => Math.hypot(P[3 * a] - P[3 * b], P[3 * a + 1] - P[3 * b + 1], P[3 * a + 2] - P[3 * b + 2]);
      const far = (from) => boundary.reduce((best, i) => (d3(i, from) > d3(best, from) ? i : best), boundary[0]);
      const p = far(boundary[0]), q = far(p), x = new Float64Array(n * 2);
      x[2 * q] = d3(p, q) || 1;
      for (const i of [p, q]) dc[2 * i] = dc[2 * i + 1] = 0;
      pcg(mulC, new Float64Array(n * 2), x, dc, 1e-6, Math.min(10 * n + 500, 5000));   // a start for the next step, not the answer
      let area2 = 0;
      for (let t = 0; t < m; t++) { const a = 2 * T[3 * t], b = 2 * T[3 * t + 1], c = 2 * T[3 * t + 2]; area2 += ((x[b] - x[a]) * (x[c + 1] - x[a + 1]) - (x[b + 1] - x[a + 1]) * (x[c] - x[a])) / 2; }
      const scale = Math.sqrt(area3 / (Math.abs(area2) || 1));
      for (let i = 0; i < n; i++) { u[i] = x[2 * i] * scale; v[i] = x[2 * i + 1] * scale * (area2 < 0 ? -1 : 1); }
    }
    // 3. As rigid as possible (Liu et al. 2008): turn every flat triangle to best match the map, then solve for the
    //    map that best matches the turned triangles. Cotangent weights, floored so a sliver cannot unpin a vertex.
    const w = new Float64Array(m * 3), dl = new Float64Array(n), lx = [0, 0, 0], ly = [0, 0, 0];
    const local = (t) => { lx[1] = X[4 * t]; lx[2] = X[4 * t + 1]; ly[2] = X[4 * t + 2]; };
    for (let t = 0; t < m; t++) {
      local(t);
      for (let k = 0; k < 3; k++) {
        const i = (k + 1) % 3, j = (k + 2) % 3, cot = ((lx[i] - lx[k]) * (lx[j] - lx[k]) + (ly[i] - ly[k]) * (ly[j] - ly[k])) / (2 * X[4 * t + 3]);
        w[3 * t + k] = live(t) ? Math.max(cot, 0.02) : 1e-6;
        dl[T[3 * t + i]] += w[3 * t + k]; dl[T[3 * t + j]] += w[3 * t + k];
      }
    }
    const mulL = (f, out) => {
      out.fill(0);
      for (let t = 0; t < m; t++) for (let k = 0; k < 3; k++) { const i = T[3 * t + (k + 1) % 3], j = T[3 * t + (k + 2) % 3], g = w[3 * t + k] * (f[i] - f[j]); out[i] += g; out[j] -= g; }
    };
    const bu = new Float64Array(n), bv = new Float64Array(n), was = new Float64Array(n * 2);
    // Each solve is a few warm-started steps, not run to the end: the rounds converge the same and cost a tenth.
    // Done when nothing moves, or when five more rounds no longer bring the mean strain down by a hundredth.
    for (let moved = Infinity, last = Infinity; rounds < iterations && moved > 1e-4 * edge; rounds++) {
      if (rounds && rounds % 5 === 0) { const now = measure().meanStrain; if (now > 0.99 * last) break; last = now; }
      bu.fill(0); bv.fill(0);
      for (let t = 0; t < m; t++) {
        local(t);
        let s00 = 0, s01 = 0, s10 = 0, s11 = 0;
        for (let k = 0; k < 3; k++) { const a = (k + 1) % 3, b = (k + 2) % 3, i = T[3 * t + a], j = T[3 * t + b], dx = lx[a] - lx[b], dy = ly[a] - ly[b], g = w[3 * t + k]; s00 += g * (u[i] - u[j]) * dx; s01 += g * (u[i] - u[j]) * dy; s10 += g * (v[i] - v[j]) * dx; s11 += g * (v[i] - v[j]) * dy; }
        const turn = Math.atan2(s10 - s01, s00 + s11), c = Math.cos(turn), s = Math.sin(turn);
        for (let k = 0; k < 3; k++) { const a = (k + 1) % 3, b = (k + 2) % 3, i = T[3 * t + a], j = T[3 * t + b], dx = lx[a] - lx[b], dy = ly[a] - ly[b], g = w[3 * t + k], gx = g * (c * dx - s * dy), gy = g * (s * dx + c * dy); bu[i] += gx; bu[j] -= gx; bv[i] += gy; bv[j] -= gy; }
      }
      was.set(u); was.set(v, n);
      pcg(mulL, bu, u, dl, 1e-7, 30); pcg(mulL, bv, v, dl, 1e-7, 30);
      moved = 0; for (let i = 0; i < n; i++) moved = Math.max(moved, Math.abs(u[i] - was[i]), Math.abs(v[i] - was[n + i]));
    }
    distortion = measure();
  }
  const uv = new Float64Array(n * 2); for (let i = 0; i < n; i++) { uv[2 * i] = u[i]; uv[2 * i + 1] = v[i]; }
  return { uv, stretch, iterations: rounds, distortion };
}

// -------------------------------------------------------------------- mesh

function bodiesOf(mesh) { return mesh.bodies?.length ? mesh.bodies : [{ first: 0, count: mesh.indices.length / 3, name: mesh.name || 'body' }]; }
const nameOf = (b) => String(b?.name ?? 'body');

/** One body of the mesh, its vertices welded by position so faces that meet share vertices. */
function prepare(mesh, body) {
  if (!mesh?.positions?.length || !mesh?.indices?.length) throw new GraphError('The source has no triangles');
  const bodies = bodiesOf(mesh);
  let bi = 0;
  if (body == null) { if (bodies.length > 1) throw new GraphError(`This model has ${bodies.length} bodies. Name one: ${bodies.map((b, i) => `${i} '${nameOf(b)}'`).join(', ')}`); }
  else if (typeof body === 'number') bi = body;
  else {
    const hits = bodies.map((b, i) => i).filter((i) => nameOf(bodies[i]) === body), loose = hits.length ? hits : bodies.map((b, i) => i).filter((i) => nameOf(bodies[i]).toLowerCase() === String(body).toLowerCase());
    if (loose.length > 1) throw new GraphError(`${loose.length} bodies are named '${body}': pass the index instead (${loose.join(', ')})`);
    bi = loose.length ? loose[0] : -1;
  }
  const B = bodies[bi];
  if (!B) throw new GraphError(`No body '${body}'. The bodies are: ${bodies.map((b, i) => `${i} '${nameOf(b)}'`).join(', ')}`);
  const ranges = (mesh.faces?.length ? mesh.faces : [B]).filter((f) => f.first >= B.first && f.first < B.first + B.count && f.count > 0);
  const pos = mesh.positions, idx = mesh.indices, lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = B.first * 3; i < (B.first + B.count) * 3; i++) for (let k = 0; k < 3; k++) { const c = pos[3 * idx[i] + k]; if (c < lo[k]) lo[k] = c; if (c > hi[k]) hi[k] = c; }
  // Two vertices closer than h/2 are one: the cells a point's ±h/2 box touches are searched, so none is missed at a cell border.
  const h = Math.max(Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) * 2e-6, 2e-5), cells = new Map(), P = [], byIndex = new Map();
  const weld = (o) => {
    let id = byIndex.get(o); if (id !== undefined) return id;
    const x = pos[3 * o], y = pos[3 * o + 1], z = pos[3 * o + 2];
    for (let c = 0; c < 8 && id === undefined; c++) {
      const list = cells.get(`${Math.floor(x / h + (c & 1) - 0.5)},${Math.floor(y / h + ((c >> 1) & 1) - 0.5)},${Math.floor(z / h + ((c >> 2) & 1) - 0.5)}`);
      if (list) for (const j of list) if (Math.hypot(P[3 * j] - x, P[3 * j + 1] - y, P[3 * j + 2] - z) <= h / 2) { id = j; break; }
    }
    if (id === undefined) { id = P.length / 3; P.push(x, y, z); const k = `${Math.floor(x / h)},${Math.floor(y / h)},${Math.floor(z / h)}`; if (!cells.has(k)) cells.set(k, []); cells.get(k).push(id); }
    byIndex.set(o, id); return id;
  };
  const tri = [], orig = [], faceOf = [];
  ranges.forEach((f, face) => {
    for (let t = f.first; t < f.first + f.count; t++) {
      const o = [idx[3 * t], idx[3 * t + 1], idx[3 * t + 2]], a = weld(o[0]), b = weld(o[1]), c = weld(o[2]);
      if (a === b || b === c || c === a) continue;   // collapsed by the weld: no area, and its edge is one edge now
      tri.push(a, b, c); orig.push(...o); faceOf.push(face);
    }
  });
  return { P: Float64Array.from(P), tri: Int32Array.from(tri), orig, faceOf: Int32Array.from(faceOf), nv: P.length / 3, nt: faceOf.length, nf: ranges.length, normals: mesh.normals?.length === pos.length ? mesh.normals : null, body: nameOf(B), bodyIndex: bi, lo, hi };
}

function triangleNormals(M) {
  const N = new Float64Array(M.nt * 3), A = new Float64Array(M.nt), P = M.P;
  for (let t = 0; t < M.nt; t++) {
    const a = 3 * M.tri[3 * t], b = 3 * M.tri[3 * t + 1], c = 3 * M.tri[3 * t + 2];
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx, l = Math.hypot(x, y, z);
    A[t] = l / 2; if (l > 0) { N[3 * t] = x / l; N[3 * t + 1] = y / l; N[3 * t + 2] = z / l; }
  }
  M.N = N; M.A = A;
}

const edgeKey = (M, a, b) => (a < b ? a * M.nv + b : b * M.nv + a);

/** The edges of the chosen triangles: key → the half-edges on it (3·triangle + corner, running corner → next corner). */
function edgesOf(M, tris) {
  const edges = new Map();
  for (const t of tris) for (let k = 0; k < 3; k++) { const e = edgeKey(M, M.tri[3 * t + k], M.tri[3 * t + (k + 1) % 3]); if (!edges.has(e)) edges.set(e, []); edges.get(e).push(3 * t + k); }
  return edges;
}

/** Grow the chosen surface outward by d: every vertex moves so that each plane it lies on moves out by d (a mitre
 *  at an edge or corner, the normal on a smooth face), so pieces still meet along their seams. */
function offsetSurface(M, tris, d) {
  const fans = new Map();
  for (const t of tris) for (let k = 0; k < 3; k++) { const v = M.tri[3 * t + k]; if (!fans.has(v)) fans.set(v, []); fans.get(v).push(t); }
  const moved = Float64Array.from(M.P);
  for (const [v, fan] of fans) {
    const m = [0, 0, 0];
    for (let sweep = 0; sweep < 30; sweep++) for (const t of fan) { const nx = M.N[3 * t], ny = M.N[3 * t + 1], nz = M.N[3 * t + 2], miss = d - (m[0] * nx + m[1] * ny + m[2] * nz); m[0] += miss * nx; m[1] += miss * ny; m[2] += miss * nz; }
    const l = Math.hypot(...m), k = l > 4 * Math.abs(d) ? 4 * Math.abs(d) / l : 1;   // a knife edge would send its mitre to infinity
    for (let c = 0; c < 3; c++) moved[3 * v + c] += m[c] * k;
  }
  M.P = moved; triangleNormals(M);
}

// ----------------------------------------------------------------- patches

const ufMake = (n) => { const p = new Int32Array(n); for (let i = 0; i < n; i++) p[i] = i; return p; };
const ufFind = (p, i) => { while (p[i] !== i) { p[i] = p[p[i]]; i = p[i]; } return i; };
const ufJoin = (p, a, b) => { p[ufFind(p, a)] = ufFind(p, b); };

/**
 * The connected patches of a set of triangles, glued along every edge two of them share that is not cut. A vertex
 * on a cut is one vertex on each side of it, so a slit opens. Each patch: tri (local indices), gv (welded vertex of
 * each local vertex), gt (source triangles), P (local positions), loops (boundary half-edges in order, {a, b, key}),
 * chi (Euler characteristic: 1 for a disk).
 */
function buildPatches(M, tris, cut) {
  const n = tris.length, at = new Map(); tris.forEach((t, i) => at.set(t, i));
  const corners = ufMake(n * 3), comp = ufMake(n), open = [];
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) {
    const h = 3 * tris[i] + k, b = M.tri[3 * tris[i] + (k + 1) % 3], e = edgeKey(M, M.tri[h], b);
    let mate = -1, users = 0;
    if (!cut.has(e)) for (const g of M.edges.get(e)) { if (!at.has((g / 3) | 0)) continue; users++; if (g !== h) mate = g; }
    // Glued only when exactly two triangles meet here and run opposite ways (a consistently wound surface).
    if (users !== 2 || M.tri[mate] !== b) { open.push(i * 3 + k); continue; }
    const j = at.get((mate / 3) | 0), kk = mate % 3;
    ufJoin(corners, i * 3 + k, j * 3 + (kk + 1) % 3); ufJoin(corners, i * 3 + (k + 1) % 3, j * 3 + kk); ufJoin(comp, i, j);
  }
  const members = new Map(), opens = new Map();
  for (let i = 0; i < n; i++) { const r = ufFind(comp, i); if (!members.has(r)) { members.set(r, []); opens.set(r, []); } members.get(r).push(i); }
  for (const o of open) opens.get(ufFind(comp, (o / 3) | 0)).push(o);
  const patches = [];
  for (const [root, list] of members) {
    const id = new Map(), gv = [], tri = new Int32Array(list.length * 3);
    list.forEach((i, m) => { for (let k = 0; k < 3; k++) { const c = ufFind(corners, i * 3 + k); let v = id.get(c); if (v === undefined) { v = gv.length; id.set(c, v); gv.push(M.tri[3 * tris[i] + k]); } tri[3 * m + k] = v; } });
    const next = new Map();
    for (const o of opens.get(root)) { const i = (o / 3) | 0, k = o % 3, a = id.get(ufFind(corners, o)), b = id.get(ufFind(corners, i * 3 + (k + 1) % 3)); next.set(a, { a, b, key: edgeKey(M, gv[a], gv[b]) }); }
    const loops = [], seen = new Set();
    for (const start of next.keys()) { if (seen.has(start)) continue; const loop = []; for (let e = next.get(start); e && !seen.has(e.a); e = next.get(e.b)) { seen.add(e.a); loop.push(e); } loops.push(loop); }
    const P = new Float64Array(gv.length * 3); gv.forEach((g, v) => { P[3 * v] = M.P[3 * g]; P[3 * v + 1] = M.P[3 * g + 1]; P[3 * v + 2] = M.P[3 * g + 2]; });
    const len = (loop) => loop.reduce((s, e) => s + Math.hypot(P[3 * e.a] - P[3 * e.b], P[3 * e.a + 1] - P[3 * e.b + 1], P[3 * e.a + 2] - P[3 * e.b + 2]), 0);
    loops.sort((p, q) => len(q) - len(p));   // the outer boundary first
    patches.push({ tri, gv, gt: list.map((i) => tris[i]), P, loops, chi: gv.length - (list.length * 3 + next.size) / 2 + list.length });
  }
  return patches;
}
const handles = (p) => (2 - p.loops.length - p.chi) / 2;

/** Shortest way along mesh edges from any source to the first target (or, with no target, to the farthest vertex). */
function shortest(adj, sources, isTarget) {
  const n = adj.length, dist = new Float64Array(n).fill(Infinity), prev = new Int32Array(n).fill(-1), heap = [];
  const push = (d, v) => { heap.push([d, v]); for (let i = heap.length - 1; i > 0;) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
  const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; for (let i = 0; ;) { const l = 2 * i + 1, r = l + 1; let s = i; if (l < heap.length && heap[l][0] < heap[s][0]) s = l; if (r < heap.length && heap[r][0] < heap[s][0]) s = r; if (s === i) break; [heap[s], heap[i]] = [heap[i], heap[s]]; i = s; } } return top; };
  for (const s of sources) { dist[s] = 0; push(0, s); }
  let end = -1;
  while (heap.length) {
    const [d, v] = pop(); if (d > dist[v]) continue;
    end = v; if (isTarget?.(v)) break;
    for (const [to, w] of adj[v] || []) if (d + w < dist[to]) { dist[to] = d + w; prev[to] = v; push(d + w, to); }
  }
  if (isTarget && (end < 0 || !isTarget(end))) return null;
  const path = []; for (let v = end; v >= 0; v = prev[v]) path.push(v);
  return { path: path.reverse(), length: dist[end] };
}
/** Edge lengths between vertices, for [a, b, weldedA, weldedB] edges; an edge on a B-rep face border counts a touch shorter, so a cut prefers to follow one. */
function adjacency(M, n, edges) {
  const adj = Array.from({ length: n }, () => []);
  for (const [a, b, ga, gb] of edges) {
    const users = M.edges.get(edgeKey(M, ga, gb)) || [], border = users.length === 2 && M.faceOf[(users[0] / 3) | 0] !== M.faceOf[(users[1] / 3) | 0];
    // Among cuts of nearly the same length the one at the back (+y: the front of a design faces -y) wins.
    const back = ((M.P[3 * ga + 1] + M.P[3 * gb + 1]) / 2 - M.lo[1]) / (M.hi[1] - M.lo[1] || 1);
    const w = Math.hypot(M.P[3 * ga] - M.P[3 * gb], M.P[3 * ga + 1] - M.P[3 * gb + 1], M.P[3 * ga + 2] - M.P[3 * gb + 2]) * (border ? 0.98 : 1) * (1 - 0.01 * back);
    adj[a].push([b, w]); adj[b].push([a, w]);
  }
  return adj;
}
const patchAdjacency = (M, p) => { const e = []; for (let t = 0; t < p.tri.length; t += 3) for (let k = 0; k < 3; k++) { const a = p.tri[t + k], b = p.tri[t + (k + 1) % 3]; e.push([a, b, p.gv[a], p.gv[b]]); } return adjacency(M, p.gv.length, e); };
const xyz = (M, g) => [r3(M.P[3 * g]), r3(M.P[3 * g + 1]), r3(M.P[3 * g + 2])];

/** Does the flattened patch lap over itself? (It could not be cut from one layer.) Two boundary edges that cross,
 *  or the middle of one triangle lying inside another: two flaps folded onto the same place share their outline
 *  exactly and cross nowhere. */
function overlaps(patch, uv) {
  const seg = patch.loops.flat().map((e) => [uv[2 * e.a], uv[2 * e.a + 1], uv[2 * e.b], uv[2 * e.b + 1], e.a, e.b]);
  let lo = Infinity, hi = -Infinity; for (const s of seg) { lo = Math.min(lo, s[0], s[1]); hi = Math.max(hi, s[0], s[1]); }
  const eps = 1e-7 * (hi - lo) ** 2, side = (ax, ay, bx, by, cx, cy) => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  seg.sort((p, q) => Math.min(p[0], p[2]) - Math.min(q[0], q[2]));
  for (let i = 0; i < seg.length; i++) {
    const p = seg[i], right = Math.max(p[0], p[2]);
    for (let j = i + 1; j < seg.length && Math.min(seg[j][0], seg[j][2]) <= right; j++) {
      const q = seg[j];
      if (Math.max(p[1], p[3]) < Math.min(q[1], q[3]) || Math.max(q[1], q[3]) < Math.min(p[1], p[3])) continue;
      const a = side(p[0], p[1], p[2], p[3], q[0], q[1]), b = side(p[0], p[1], p[2], p[3], q[2], q[3]), c = side(q[0], q[1], q[2], q[3], p[0], p[1]), d = side(q[0], q[1], q[2], q[3], p[2], p[3]);
      if (((a > eps && b < -eps) || (a < -eps && b > eps)) && ((c > eps && d < -eps) || (c < -eps && d > eps))) return true;
    }
  }
  // ponytail: a sweep over x with every triangle that spans the sweep line held open; long slivers across a big face make it slow (quadratic at worst), a grid would not care
  const T = patch.tri, tris = [];
  for (let t = 0; t < T.length; t += 3) { const x = [uv[2 * T[t]], uv[2 * T[t + 1]], uv[2 * T[t + 2]]], y = [uv[2 * T[t] + 1], uv[2 * T[t + 1] + 1], uv[2 * T[t + 2] + 1]]; if (Math.abs(side(x[0], y[0], x[1], y[1], x[2], y[2])) > eps) tris.push({ x, y, x0: Math.min(...x), x1: Math.max(...x), y0: Math.min(...y), y1: Math.max(...y), cx: (x[0] + x[1] + x[2]) / 3, cy: (y[0] + y[1] + y[2]) / 3 }); }
  const byStart = [...tris].sort((p, q) => p.x0 - q.x0), byMiddle = [...tris].sort((p, q) => p.cx - q.cx); let open = [], next = 0;
  for (const m of byMiddle) {
    while (next < byStart.length && byStart[next].x0 <= m.cx) open.push(byStart[next++]);
    if (open.length > 64 && open.length > 2 * byStart.length / 3) open = open.filter((t) => t.x1 >= m.cx);
    for (const t of open) {
      if (t === m || t.x1 < m.cx || t.y0 > m.cy || t.y1 < m.cy) continue;
      const a = side(t.x[0], t.y[0], t.x[1], t.y[1], m.cx, m.cy), b = side(t.x[1], t.y[1], t.x[2], t.y[2], m.cx, m.cy), c = side(t.x[2], t.y[2], t.x[0], t.y[0], m.cx, m.cy);
      if ((a > eps && b > eps && c > eps) || (a < -eps && b < -eps && c < -eps)) return true;
    }
  }
  return false;
}

/** A patch with several boundaries lies flat as it is only when each boundary turns a full circle (a plate with
 *  holes); the rims of a tube barely turn at all. The turning of a loop is the sum of π minus the surface angle at its vertices. */
function plateLike(patch) {
  const angle = new Float64Array(patch.gv.length), P = patch.P;
  for (let t = 0; t < patch.tri.length; t += 3) for (let k = 0; k < 3; k++) {
    const a = 3 * patch.tri[t + k], b = 3 * patch.tri[t + (k + 1) % 3], c = 3 * patch.tri[t + (k + 2) % 3], ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    angle[patch.tri[t + k]] += Math.atan2(Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx), ux * vx + uy * vy + uz * vz);
  }
  return patch.loops.every((loop) => Math.abs(Math.abs(loop.reduce((sum, e) => sum + Math.PI - angle[e.a], 0)) - 2 * Math.PI) < 1);
}

const flattenOne = (patch) => flattenPatch(patch.P, patch.tri, { boundary: patch.loops[0].map((e) => e.a) });
const liesFlat = (patch, flat, opt) => flat.distortion.maxStrain <= opt.strainLimit && !flat.distortion.flips && !overlaps(patch, flat.uv);

/**
 * Make a set of triangles flattenable and flatten it: [{patch, flat}]. A closed surface is slit between its two
 * farthest points; a tube (two or more boundaries that do not lie flat as they are) is cut from one boundary to
 * the next by the shortest way. A plate with holes lies flat as it is and keeps its holes. Cuts made are added to
 * `cut` and reported in `cuts`.
 */
function openAndFlatten(M, tris, cut, opt, cuts) {
  for (let guard = 0; guard < 64; guard++) {
    const out = []; let again = false;
    for (const patch of buildPatches(M, tris, cut)) {
      const report = (why, r) => { const g = r.path.map((v) => patch.gv[v]); let length = 0; for (let i = 1; i < g.length; i++) { cut.add(edgeKey(M, g[i - 1], g[i])); length += Math.hypot(M.P[3 * g[i]] - M.P[3 * g[i - 1]], M.P[3 * g[i] + 1] - M.P[3 * g[i - 1] + 1], M.P[3 * g[i] + 2] - M.P[3 * g[i - 1] + 2]); } cuts.push({ kind: 'auto', why, faces: [...new Set(patch.gt.map((t) => M.faceOf[t]))].sort((a, b) => a - b), from: xyz(M, g[0]), to: xyz(M, g.at(-1)), length: r3(length) }); again = true; };
      if (!patch.loops.length) {
        const adj = patchAdjacency(M, patch), a = shortest(adj, [0], null).path.at(-1);
        report('a closed surface was slit between its two farthest points', shortest(adj, [a], null)); continue;
      }
      // ponytail: a surface with a handle (a whole torus) needs a loop cut this does not look for; the caller's cuts open it
      if (handles(patch) > 0) throw new GraphError(`Faces ${[...new Set(patch.gt.map((t) => M.faceOf[t]))].join(', ')} form a surface with a handle through it (a ring or torus): pass cuts ({path:[...]} around the tube) to open it`);
      const flat = patch.loops.length === 1 || plateLike(patch) ? flattenOne(patch) : null;
      if (flat && (patch.loops.length === 1 || liesFlat(patch, flat, opt))) { out.push({ patch, flat }); continue; }
      const adj = patchAdjacency(M, patch), loopOf = new Map(); patch.loops.forEach((loop, i) => loop.forEach((e) => loopOf.set(e.a, i)));
      const joined = new Set([0]), sources = patch.loops[0].map((e) => e.a);
      while (joined.size < patch.loops.length) {
        const r = shortest(adj, sources, (v) => loopOf.has(v) && !joined.has(loopOf.get(v)));
        if (!r) { if (joined.size === 1) out.push({ patch, flat: flat || flattenOne(patch) }); break; }
        const hit = loopOf.get(r.path.at(-1)); joined.add(hit); sources.push(...r.path, ...patch.loops[hit].map((e) => e.a));
        report('a tube was cut along its length so it unrolls', r);
      }
    }
    if (!again) return out;
  }
  throw new GraphError('The surface could not be cut open');
}

/** One piece per group of faces that lies flat together: grown across smooth borders, longest border first. */
function grow(M, faceTris, faces, cut, opt, cuts) {
  const groupOf = new Map(faces.map((f) => { const parts = openAndFlatten(M, faceTris[f], cut, opt, cuts); return [f, { faces: [f], tris: faceTris[f], parts, flat: parts.length === 1 && liesFlat(parts[0].patch, parts[0].flat, opt) }]; }));
  const groups = new Set(groupOf.values()), find = (f) => groupOf.get(f);
  // ponytail: every trial flattens the union, so a body with hundreds of faces would take minutes; past this size each face is its own piece (pass faces groups to join them)
  if (!opt.merge || faces.length > 400 || M.edges.size > 300000) return [...groups];
  const cosOf = (h, g) => {   // how far the surface turns across this edge: true normals at the shared vertices when the mesh has them
    const t = (h / 3) | 0, s = (g / 3) | 0;
    if (!M.normals) return M.N[3 * t] * M.N[3 * s] + M.N[3 * t + 1] * M.N[3 * s + 1] + M.N[3 * t + 2] * M.N[3 * s + 2];
    let worst = 1;
    for (const [i, j] of [[h, 3 * s + (g % 3 + 1) % 3], [3 * t + (h % 3 + 1) % 3, g]]) { const a = 3 * M.orig[i], b = 3 * M.orig[j], n = M.normals, d = (n[a] * n[b] + n[a + 1] * n[b + 1] + n[a + 2] * n[b + 2]) / (Math.hypot(n[a], n[a + 1], n[a + 2]) * Math.hypot(n[b], n[b + 1], n[b + 2]) || 1); worst = Math.min(worst, d); }
    return worst;
  };
  const borders = new Map();
  for (const [e, users] of M.edges) {
    if (users.length !== 2 || cut.has(e)) continue;
    const fa = M.faceOf[(users[0] / 3) | 0], fb = M.faceOf[(users[1] / 3) | 0]; if (fa === fb) continue;
    const k = fa < fb ? `${fa}/${fb}` : `${fb}/${fa}`, a = Math.floor(e / M.nv), b = e % M.nv;
    if (!borders.has(k)) borders.set(k, { a: fa, b: fb, length: 0, cos: 1 });
    const row = borders.get(k); row.length += Math.hypot(M.P[3 * a] - M.P[3 * b], M.P[3 * a + 1] - M.P[3 * b + 1], M.P[3 * a + 2] - M.P[3 * b + 2]); row.cos = Math.min(row.cos, cosOf(users[0], users[1]));
  }
  const smooth = Math.cos(opt.smoothAngle / DEG) - 1e-9, tried = new Set();
  const attempt = (tris, cutSet) => { const patches = buildPatches(M, tris, cutSet); if (patches.length !== 1 || !patches[0].loops.length || handles(patches[0]) !== 0 || (patches[0].loops.length > 1 && !plateLike(patches[0]))) return null; const flat = flattenOne(patches[0]); return liesFlat(patches[0], flat, opt) ? [{ patch: patches[0], flat }] : null; };
  for (const border of [...borders.entries()].map(([, b]) => b).filter((b) => b.cos >= smooth).sort((p, q) => q.length - p.length)) {
    const A = find(border.a), B = find(border.b); if (A === B || !A.flat || !B.flat) continue;   // a group that does not lie flat alone will not lie flat grown
    const memo = `${A.faces[0]}:${A.tris.length}/${B.faces[0]}:${B.tris.length}`; if (tried.has(memo)) continue; tried.add(memo);
    const tris = A.tris.concat(B.tris);
    let parts = attempt(tris, cut);
    if (!parts) {
      // Glued along every shared border they close into a ring or a tube. Glue along the longest border only: the
      // others stay open as the seams that close it (two half cylinders become one rectangle with one seam).
      const inA = new Set(A.tris), inB = new Set(B.tris), runs = new Map(), root = new Map(), top = (v) => { while (root.get(v) !== v) v = root.get(v); return v; };
      const between = [...M.edges].filter(([e, users]) => users.length === 2 && !cut.has(e) && ((inA.has((users[0] / 3) | 0) && inB.has((users[1] / 3) | 0)) || (inB.has((users[0] / 3) | 0) && inA.has((users[1] / 3) | 0)))).map(([e]) => e);
      for (const e of between) for (const v of [Math.floor(e / M.nv), e % M.nv]) if (!root.has(v)) root.set(v, v);
      for (const e of between) root.set(top(Math.floor(e / M.nv)), top(e % M.nv));
      for (const e of between) { const r = top(e % M.nv), a = Math.floor(e / M.nv), b = e % M.nv; if (!runs.has(r)) runs.set(r, { edges: [], length: 0 }); const run = runs.get(r); run.edges.push(e); run.length += Math.hypot(M.P[3 * a] - M.P[3 * b], M.P[3 * a + 1] - M.P[3 * b + 1], M.P[3 * a + 2] - M.P[3 * b + 2]); }
      if (runs.size > 1) {
        const keep = [...runs.values()].sort((p, q) => q.length - p.length)[0], trial = new Set(cut);
        for (const run of runs.values()) if (run !== keep) for (const e of run.edges) trial.add(e);
        parts = attempt(tris, trial);
        if (parts) for (const e of trial) cut.add(e);
      }
    }
    if (!parts) continue;
    for (const f of B.faces) groupOf.set(f, A);
    A.faces.push(...B.faces); A.tris = tris; A.parts = parts; groups.delete(B);
  }
  return [...groups];
}

// ---------------------------------------------------------------- patterns

/** A cubic through the ends of a run of points, least squares on the two inner control points; the worst miss. */
function fitCubic(pts, t) {
  const a = pts[0], b = pts.at(-1); let a11 = 0, a12 = 0, a22 = 0, x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const s = t[i], u = 1 - s, b1 = 3 * u * u * s, b2 = 3 * u * s * s, rx = pts[i][0] - u ** 3 * a[0] - s ** 3 * b[0], ry = pts[i][1] - u ** 3 * a[1] - s ** 3 * b[1];
    a11 += b1 * b1; a12 += b1 * b2; a22 += b2 * b2; x1 += b1 * rx; x2 += b2 * rx; y1 += b1 * ry; y2 += b2 * ry;
  }
  const det = a11 * a22 - a12 * a12; if (!(det > 1e-12)) return null;
  return { c1: [(x1 * a22 - x2 * a12) / det, (y1 * a22 - y2 * a12) / det], c2: [(a11 * x2 - a12 * x1) / det, (a11 * y2 - a12 * y1) / det] };
}
const cubicAt = (a, c1, c2, b, s) => { const u = 1 - s; return [u ** 3 * a[0] + 3 * u * u * s * c1[0] + 3 * u * s * s * c2[0] + s ** 3 * b[0], u ** 3 * a[1] + 3 * u * u * s * c1[1] + 3 * u * s * s * c2[1] + s ** 3 * b[1]]; };

/**
 * One run of boundary points as a single segment: a line when they are straight within tol, else one cubic Bezier
 * within tol. {type:'line'} | {type:'bezier', c1, c2} | {split: i}: the point to break the run at when neither fits.
 */
export function fitRun(pts, tol) {
  const a = pts[0], b = pts.at(-1), dx = b[0] - a[0], dy = b[1] - a[1], chord = Math.hypot(dx, dy);
  if (pts.length < 3) return { type: 'line' };
  let worst = 0, at = 1;
  for (let i = 1; i < pts.length - 1; i++) { const d = chord > 1e-9 ? Math.abs(dx * (pts[i][1] - a[1]) - dy * (pts[i][0] - a[0])) / chord : Math.hypot(pts[i][0] - a[0], pts[i][1] - a[1]); if (d > worst) { worst = d; at = i; } }
  if (worst <= tol && chord > 1e-9) return { type: 'line' };
  if (pts.length < 4) return { split: Math.max(1, Math.min(pts.length - 2, at)) };
  const t = [0]; for (let i = 1; i < pts.length; i++) t.push(t[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const total = t.at(-1); for (let i = 0; i < t.length; i++) t[i] /= total;
  let best = null;
  // Refit a few times with each point's parameter moved to its nearest place on the curve: a fit merely inside the
  // tolerance still bulges, and a bulge is extra length on one side of a seam.
  for (let pass = 0; pass < 5; pass++) {
    const c = fitCubic(pts, t); if (!c) break;
    let miss = 0, where = 1;
    for (let i = 1; i < pts.length - 1; i++) { const q = cubicAt(a, c.c1, c.c2, b, t[i]), d = Math.hypot(q[0] - pts[i][0], q[1] - pts[i][1]); if (d > miss) { miss = d; where = i; } }
    // The curve between its points must not wander: a control polygon much longer than the run is a loop, not a fit.
    const polygon = Math.hypot(c.c1[0] - a[0], c.c1[1] - a[1]) + Math.hypot(c.c2[0] - c.c1[0], c.c2[1] - c.c1[1]) + Math.hypot(b[0] - c.c2[0], b[1] - c.c2[1]);
    if (polygon > 1.5 * total) miss = Infinity;
    if (!best || miss < best.miss) best = { ...c, miss, where };
    if (miss <= tol / 100) break;
    for (let i = 1; i < pts.length - 1; i++) {   // one Newton step of each point's parameter toward its nearest point on the curve
      const s = t[i], u = 1 - s, q = cubicAt(a, c.c1, c.c2, b, s), ex = q[0] - pts[i][0], ey = q[1] - pts[i][1];
      const d1 = [0, 1].map((k) => 3 * u * u * (c.c1[k] - a[k]) + 6 * u * s * (c.c2[k] - c.c1[k]) + 3 * s * s * (b[k] - c.c2[k])), d2 = [0, 1].map((k) => 6 * u * (c.c2[k] - 2 * c.c1[k] + a[k]) + 6 * s * (b[k] - 2 * c.c2[k] + c.c1[k]));
      const den = d1[0] * d1[0] + d1[1] * d1[1] + ex * d2[0] + ey * d2[1]; if (Math.abs(den) > 1e-12) t[i] = Math.max(t[i - 1] + 1e-6, Math.min(1 - 1e-6, s - (ex * d1[0] + ey * d1[1]) / den));
    }
  }
  if (best && best.miss <= tol) return { type: 'bezier', c1: best.c1, c2: best.c2 };
  // Break where the miss is worst, but not near an end: a smooth arc misses most there and would be whittled away in slivers.
  const lo = t.findIndex((x) => x >= 0.3), hi = t.findLastIndex((x) => x <= 0.7), where = best && Number.isFinite(best.miss) ? best.where : (pts.length - 1) >> 1;
  return { split: Math.max(1, Math.min(pts.length - 2, Math.max(lo, Math.min(hi, where)))) };
}

const slug = (s, max = 28) => { const t = String(s).trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, max); return /^[a-z_]/.test(t) ? t : `p_${t}`.slice(0, max); };

/** Turn the flat piece so the part's up (z, or y on a level face) is the pattern's +y, set its corner at the origin, and say where it sits in 3D. */
function settle(piece) {
  const { patch, flat } = piece, uv = flat.uv, P = patch.P, n = patch.gv.length;
  const up = [0, 0, 0, 0, 0, 0];   // the gradient of x, y and z over the pattern, area weighted
  for (let t = 0; t < patch.tri.length; t += 3) {
    const a = patch.tri[t], b = patch.tri[t + 1], c = patch.tri[t + 2], e1 = [uv[2 * b] - uv[2 * a], uv[2 * b + 1] - uv[2 * a + 1]], e2 = [uv[2 * c] - uv[2 * a], uv[2 * c + 1] - uv[2 * a + 1]], det = e1[0] * e2[1] - e1[1] * e2[0];
    if (!(Math.abs(det) > 1e-12)) continue;
    for (let k = 0; k < 3; k++) { const f1 = P[3 * b + k] - P[3 * a + k], f2 = P[3 * c + k] - P[3 * a + k]; up[2 * k] += (f1 * e2[1] - f2 * e1[1]) / 2 * Math.sign(det); up[2 * k + 1] += (e1[0] * f2 - e2[0] * f1) / 2 * Math.sign(det); }
  }
  const area = flat.distortion.area, axis = [2, 1, 0].find((k) => Math.hypot(up[2 * k], up[2 * k + 1]) > 0.3 * area) ?? 2;
  const turn = Math.PI / 2 - Math.atan2(up[2 * axis + 1], up[2 * axis]), c = Math.cos(turn), s = Math.sin(turn);
  let lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
  for (let i = 0; i < n; i++) { const x = uv[2 * i] * c - uv[2 * i + 1] * s, y = uv[2 * i] * s + uv[2 * i + 1] * c; uv[2 * i] = x; uv[2 * i + 1] = y; lo = [Math.min(lo[0], x), Math.min(lo[1], y)]; hi = [Math.max(hi[0], x), Math.max(hi[1], y)]; }
  for (let i = 0; i < n; i++) { uv[2 * i] -= lo[0]; uv[2 * i + 1] -= lo[1]; }
  piece.size = [hi[0] - lo[0], hi[1] - lo[1]];
  // The rigid placement that best lays the flat piece on its patch: the least-squares linear map, made orthonormal.
  const mean = [0, 0, 0, 0, 0]; for (let i = 0; i < n; i++) { mean[0] += uv[2 * i] / n; mean[1] += uv[2 * i + 1] / n; for (let k = 0; k < 3; k++) mean[2 + k] += P[3 * i + k] / n; }
  let quu = 0, quv = 0, qvv = 0; const C = [0, 0, 0, 0, 0, 0];
  for (let i = 0; i < n; i++) { const a = uv[2 * i] - mean[0], b = uv[2 * i + 1] - mean[1]; quu += a * a; quv += a * b; qvv += b * b; for (let k = 0; k < 3; k++) { C[2 * k] += (P[3 * i + k] - mean[2 + k]) * a; C[2 * k + 1] += (P[3 * i + k] - mean[2 + k]) * b; } }
  const det = quu * qvv - quv * quv || 1, unit = (v) => { const l = Math.hypot(...v) || 1; return v.map((x) => x / l); };
  const e1 = unit([0, 1, 2].map((k) => (C[2 * k] * qvv - C[2 * k + 1] * quv) / det)), raw = [0, 1, 2].map((k) => (C[2 * k + 1] * quu - C[2 * k] * quv) / det), dot = raw[0] * e1[0] + raw[1] * e1[1] + raw[2] * e1[2];
  const e2 = unit(raw.map((x, k) => x - dot * e1[k])), e3 = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
  // R = Rz·Ry·Rx (degrees about x, then y, then z: what the arrangement and the cloth preview use), columns e1 e2 e3.
  const level = Math.hypot(e1[0], e1[1]) > 1e-9;
  const rotation = level ? [Math.atan2(e2[2], e3[2]), Math.asin(Math.max(-1, Math.min(1, -e1[2]))), Math.atan2(e1[1], e1[0])] : [Math.atan2(-e3[1], e2[1]), Math.asin(Math.max(-1, Math.min(1, -e1[2]))), 0];
  let mid = 0, near = Infinity; for (let i = 0; i < n; i++) { const d = Math.hypot(uv[2 * i] - mean[0], uv[2 * i + 1] - mean[1]); if (d < near) { near = d; mid = i; } }
  piece.position = [0, 1, 2].map((k) => r4(P[3 * mid + k] - e1[k] * uv[2 * mid] - e2[k] * uv[2 * mid + 1]));
  piece.rotation = rotation.map((a) => r4(a * DEG));
  piece.normal = e3;
}

/**
 * Flatten faces of one body into pattern pieces.
 *
 * mesh: { positions, indices, faces:[{first,count}], bodies:[{first,count,name}], normals? }.
 * options:
 *   body         name or index of the body (needed when the mesh has several)
 *   faces        face indices within the body (default all). A flat list is grouped automatically; a list of lists
 *                is the caller's grouping, one piece per list
 *   cuts         seams the caller wants: [faceA, faceB] keeps the border between two faces open; {path:[[x,y,z],…]}
 *                cuts along the mesh edges through those points (a dart, a split, or where a tube opens)
 *   strainLimit  the most strain a piece may take and still count as lying flat (default 0.02)
 *   smoothAngle  faces meeting within this many degrees are grown into one piece (default 20)
 *   merge        false: one piece per face
 *   tolerance    how far a fitted line or Bezier may stray from the flattened boundary, mm (default 0.2; never
 *                more than 1/500 of the piece's diagonal)
 *   offset       grow the surface outward by this many mm first (fabric or foam thickness, ease)
 *   allowance    seam allowance on every edge, mm (default 10)
 *   minWidth     pieces narrower than this (twice their area over their perimeter, mm; default 3) are left out and
 *                listed in report.skipped: chamfers, the walls of small holes, slivers
 *   material, name, avoid (ids already taken), source (carried into every pattern's source)
 * Returns { body, patterns, seams, arrangement, report: { pieces, seams, cuts, skipped }, meshes (uv + xyz of every piece, not for the document) }.
 */
export function flattenMesh(mesh, options = {}) {
  const opt = { strainLimit: 0.02, smoothAngle: 20, merge: true, tolerance: 0.2, offset: 0, allowance: 10, minWidth: 3, ...Object.fromEntries(Object.entries(options).filter(([, v]) => v != null)) };
  for (const k of ['strainLimit', 'smoothAngle', 'tolerance', 'allowance', 'minWidth']) if (!(Number.isFinite(Number(opt[k])) && Number(opt[k]) >= 0)) throw new GraphError(`${k} must be a non-negative number`);
  if (!(opt.tolerance > 0)) throw new GraphError('tolerance must be greater than zero');
  if (!Number.isFinite(Number(opt.offset))) throw new GraphError('offset must be a number');
  const M = prepare(mesh, opt.body);
  const grouped = Array.isArray(opt.faces) && opt.faces.some(Array.isArray), lists = opt.faces == null ? null : grouped ? opt.faces.map((g) => [].concat(g)) : [opt.faces];
  const faces = lists ? lists.flat() : [...Array(M.nf).keys()];
  for (const f of faces) if (!Number.isInteger(f) || f < 0 || f >= M.nf) throw new GraphError(`No face ${f}: body '${M.body}' has faces 0 to ${M.nf - 1}`);
  if (new Set(faces).size !== faces.length) throw new GraphError('A face is listed twice');
  if (!faces.length) throw new GraphError('No faces to flatten');
  const faceTris = Array.from({ length: M.nf }, () => []); for (let t = 0; t < M.nt; t++) faceTris[M.faceOf[t]].push(t);
  const chosen = faces.flatMap((f) => faceTris[f]);
  if (!chosen.length) throw new GraphError('The chosen faces have no triangles');
  M.edges = edgesOf(M, chosen); triangleNormals(M);
  if (Number(opt.offset)) offsetSurface(M, chosen, Number(opt.offset));

  const cut = new Set(), cuts = [];
  let graph = null;
  for (const c of opt.cuts || []) {
    if (Array.isArray(c) && c.length === 2 && c.every(Number.isInteger)) {
      let length = 0;
      for (const [e, users] of M.edges) { const fs = users.map((h) => M.faceOf[(h / 3) | 0]); if (fs.includes(c[0]) && fs.includes(c[1])) { cut.add(e); const a = Math.floor(e / M.nv), b = e % M.nv; length += Math.hypot(M.P[3 * a] - M.P[3 * b], M.P[3 * a + 1] - M.P[3 * b + 1], M.P[3 * a + 2] - M.P[3 * b + 2]); } }
      if (!length) throw new GraphError(`Faces ${c[0]} and ${c[1]} do not share a border among the chosen faces`);
      cuts.push({ kind: 'given', why: `the border between faces ${c[0]} and ${c[1]}`, faces: [...c], length: r3(length) });
    } else if (Array.isArray(c?.path) && c.path.length >= 2 && c.path.every((p) => Array.isArray(p) && p.length === 3 && p.every(Number.isFinite))) {
      graph ||= adjacency(M, M.nv, [...M.edges.keys()].map((e) => [Math.floor(e / M.nv), e % M.nv, Math.floor(e / M.nv), e % M.nv]));
      const used = [...new Set(chosen.flatMap((t) => [M.tri[3 * t], M.tri[3 * t + 1], M.tri[3 * t + 2]]))];
      const snap = (p) => used.reduce((best, v) => (Math.hypot(M.P[3 * v] - p[0], M.P[3 * v + 1] - p[1], M.P[3 * v + 2] - p[2]) < Math.hypot(M.P[3 * best] - p[0], M.P[3 * best + 1] - p[1], M.P[3 * best + 2] - p[2]) ? v : best), used[0]);
      const stops = c.path.map(snap); let length = 0;
      for (let i = 1; i < stops.length; i++) {
        if (stops[i] === stops[i - 1]) continue;
        const r = shortest(graph, [stops[i - 1]], (v) => v === stops[i]); if (!r) throw new GraphError('A cut path crosses a gap between the chosen faces');
        for (let k = 1; k < r.path.length; k++) cut.add(edgeKey(M, r.path[k - 1], r.path[k]));
        length += r.length;
      }
      if (!length) throw new GraphError('A cut path needs two points that are apart on the mesh');
      cuts.push({ kind: 'given', why: 'a cut path', from: xyz(M, stops[0]), to: xyz(M, stops.at(-1)), length: r3(length) });
    } else throw new GraphError('A cut is [faceA, faceB] or {path: [[x,y,z], [x,y,z], ...]}');
  }

  const groups = grouped ? lists.map((list) => ({ faces: list, parts: openAndFlatten(M, list.flatMap((f) => faceTris[f]), cut, opt, cuts) })) : grow(M, faceTris, faces, cut, opt, cuts);
  // A slit one edge long has no width when flat: it is not a contour.
  const every = groups.flatMap((g) => g.parts.map((part) => ({ ...part, loops: part.patch.loops.filter((l) => l.length >= 3), faces: [...new Set(part.patch.gt.map((t) => M.faceOf[t]))].sort((a, b) => a - b) })));
  every.forEach(settle);
  // A piece too narrow to sew (a chamfer, the wall of a hole in a plate) is left out: its neighbours keep a free edge there.
  const skipped = [], pieces = every.filter((piece) => {
    const { uv } = piece.flat, around = piece.patch.loops.flat().reduce((sum, e) => sum + Math.hypot(uv[2 * e.b] - uv[2 * e.a], uv[2 * e.b + 1] - uv[2 * e.a + 1]), 0), width = 2 * piece.flat.distortion.area / (around || 1);
    if (width >= opt.minWidth) return true;
    skipped.push({ faces: piece.faces, size: piece.size.map(r3), width: r3(width), why: `narrower than minWidth ${opt.minWidth} mm` }); return false;
  });
  if (!pieces.length) throw new GraphError(`Every piece is narrower than minWidth (${opt.minWidth} mm): nothing to sew. Pass a smaller minWidth to keep them`);
  // A small piece is fitted closer than the tolerance asks: 0.2 mm is nothing on a bag panel and a visible flat on a 20 mm tab.
  for (const piece of pieces) piece.tolerance = Math.min(Number(opt.tolerance), Math.hypot(...piece.size) / 500);

  // Where the boundary of every piece breaks into segments. A break is a welded mesh vertex, so the two sides of a
  // seam always break at the same place and pair one segment to one segment: where three or more boundaries meet or
  // one ends, where either side turns a corner, and wherever a fitted run would stray past the tolerance.
  const meet = new Map(), breaks = new Set();
  for (const piece of pieces) for (const loop of piece.loops) for (const e of loop) for (const v of [e.a, e.b]) { const g = piece.patch.gv[v]; if (!meet.has(g)) meet.set(g, new Set()); meet.get(g).add(e.key); }
  for (const [g, keys] of meet) if (keys.size !== 2) breaks.add(g);
  const at = (piece, v) => [piece.flat.uv[2 * v], piece.flat.uv[2 * v + 1]];
  for (const piece of pieces) {
    piece.turn = new Map();
    for (const loop of piece.loops) {
      const turns = loop.map((e, i) => { const prev = loop[(i + loop.length - 1) % loop.length], p = at(piece, prev.a), q = at(piece, e.a), r = at(piece, e.b); return Math.abs(Math.atan2((q[0] - p[0]) * (r[1] - q[1]) - (q[1] - p[1]) * (r[0] - q[0]), (q[0] - p[0]) * (r[0] - q[0]) + (q[1] - p[1]) * (r[1] - q[1]))) * DEG; });
      const lengths = loop.map((e) => { const p = at(piece, e.a), q = at(piece, e.b); return Math.hypot(q[0] - p[0], q[1] - p[1]); });
      loop.forEach((e, i) => {
        const before = (i + loop.length - 1) % loop.length, after = (i + 1) % loop.length, t = turns[i], beside = Math.max(turns[before], turns[after]);
        piece.turn.set(e.a, t);
        // A corner turns sharply where its neighbours do not; a coarse arc turns the same at every vertex.
        if (t >= 60 || (t >= 15 && t > 2.5 * beside)) breaks.add(piece.patch.gv[e.a]);
        // Where a straight edge runs into an arc the facets change length at once: the tangent point, a break with no corner.
        else if (Math.max(lengths[before], lengths[i]) > 4 * Math.min(lengths[before], lengths[i]) && t + beside > 1) breaks.add(piece.patch.gv[e.a]);
      });
      if (!loop.some((e) => breaks.has(piece.patch.gv[e.a]))) breaks.add(piece.patch.gv[loop[0].a]);
    }
  }
  // A run is fitted within the piece's tolerance and within a hundredth of its own length: a short edge fitted
  // loosely is a seam whose two sides differ by several percent.
  const fit = (piece, pts) => { let length = 0; for (let i = 1; i < pts.length; i++) length += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); return fitRun(pts, Math.min(piece.tolerance, length / 100)); };
  const runsOf = (piece, loop) => {
    const starts = loop.map((e, i) => i).filter((i) => breaks.has(piece.patch.gv[loop[i].a]));
    return starts.map((s, k) => { const end = starts[(k + 1) % starts.length], count = ((end - s + loop.length - 1) % loop.length) + 1, edges = Array.from({ length: count }, (_, i) => loop[(s + i) % loop.length]); return { edges, pts: [at(piece, edges[0].a), ...edges.map((e) => at(piece, e.b))] }; });
  };
  for (let guard = 0, added = true; added && guard < 10000; guard++) {
    added = false;
    for (const piece of pieces) for (const loop of piece.loops) {
      const runs = runsOf(piece, loop);
      for (const run of runs) { run.fit = fit(piece, run.pts); if (run.fit.split != null) { breaks.add(piece.patch.gv[run.edges[run.fit.split - 1].b]); added = true; } }
      if (!added && runs.length < 3) {   // a contour is at least three segments: halve the longest run
        const longest = runs.filter((r) => r.edges.length > 1).sort((p, q) => q.edges.length - p.edges.length)[0];
        if (longest) { breaks.add(piece.patch.gv[longest.edges[(longest.edges.length - 1) >> 1].b]); added = true; }
      }
    }
  }

  // Patterns: corner points, one line or Bezier per run, the outer contour first.
  const taken = new Set(opt.avoid || []), unique = (id) => { let out = id; for (let k = 2; taken.has(out); k++) out = `${id}_${k}`; taken.add(out); return out; };
  const base = slug(opt.name || M.body), sides = [['right', 'left'], ['back', 'front'], ['top', 'bottom']];
  const patterns = [], report = [], runOf = new Map();   // edge key → the runs on it
  for (const piece of pieces) {
    const { patch, flat } = piece, n = [0, 0, 0]; let total = 0;
    for (const t of patch.gt) { for (let k = 0; k < 3; k++) n[k] += M.N[3 * t + k] * M.A[t]; total += M.A[t]; }
    const axis = [0, 1, 2].sort((a, b) => Math.abs(n[b]) - Math.abs(n[a]))[0], facing = Math.hypot(...n) > 0.85 * total;
    const label = facing ? sides[axis][n[axis] > 0 ? 0 : 1] : Math.hypot(...n) < 0.5 * total ? 'wrap' : 'panel';
    const id = unique(`${base}_${label}`), points = [], segments = [], contours = [], notches = [];
    piece.id = id; piece.runs = [];
    for (const loop of piece.loops) {
      const contour = [], first = points.length, runs = runsOf(piece, loop);
      runs.forEach((run, i) => {
        const sid = `${id}_e${segments.length}`, a = `${id}_p${first + i}`, b = `${id}_p${first + (i + 1) % runs.length}`, shape = fit(piece, run.pts), start = run.edges[0].a;
        points.push({ id: a, x: r4(run.pts[0][0]), y: r4(run.pts[0][1]) });
        Object.assign(run, { piece, id: sid, type: shape.type || 'line', fit: shape, start });
        contour.push(sid); piece.runs.push(run);
        for (const e of run.edges) { if (!runOf.has(e.key)) runOf.set(e.key, []); runOf.get(e.key).push(run); }
        segments.push(shape.type === 'bezier' ? { id: sid, type: 'bezier', a, b, c1: `${sid}_c1`, c2: `${sid}_c2` } : { id: sid, type: 'line', a, b });
      });
      runs.forEach((run, i) => { run.before = runs[(i + runs.length - 1) % runs.length]; });
      contours.push(contour);
    }
    for (const run of piece.runs) if (run.type === 'bezier') points.push({ id: `${run.id}_c1`, x: r4(run.fit.c1[0]), y: r4(run.fit.c1[1]) }, { id: `${run.id}_c2`, x: r4(run.fit.c2[0]), y: r4(run.fit.c2[1]) });
    const d = flat.distortion, lies = d.maxStrain <= opt.strainLimit && !d.flips, lapped = overlaps(patch, flat.uv);
    const distortion = { maxStrain: +d.maxStrain.toFixed(5), meanStrain: +d.meanStrain.toFixed(5), maxShear: +d.maxShear.toFixed(3), areaError: +d.areaError.toFixed(5), flips: d.flips, flat: lies && !lapped, ...(lapped && { overlaps: true }) };
    const pattern = {
      id, name: `${opt.name || M.body} ${label} (face${piece.faces.length === 1 ? '' : 's'} ${piece.faces.slice(0, 8).join(', ')}${piece.faces.length > 8 ? ', …' : ''})`, ...(opt.material && { material: String(opt.material) }), cut: 1,
      points, segments, contours, allowances: Object.fromEntries(segments.map((s) => [s.id, Number(opt.allowance)])), notches, grain: { angle: 90 }, internalLines: [],
      source: { kind: 'flatten', ...(opt.source || {}), body: M.body, faces: piece.faces, ...(Number(opt.offset) && { offset: Number(opt.offset) }), area: r3(d.area), normal: piece.normal.map(r4), distortion },
    };
    patterns.push(pattern);
    report.push({ id, name: pattern.name, faces: piece.faces, size: piece.size.map(r3), area: r3(d.area), points: points.length, segments: segments.length, beziers: segments.filter((s) => s.type === 'bezier').length, holes: contours.length - 1, distortion,
      ...(!distortion.flat && { advice: lapped ? 'This piece laps over itself when laid flat: split it with cuts or smaller faces groups.' : `Its strain of ${(d.maxStrain * 100).toFixed(1)}% is over the ${(opt.strainLimit * 100).toFixed(1)}% limit, so it will not lie flat: add darts or split it with cuts ({path:[[x,y,z],…]} from its edge inward or across), or sew it in a fabric that stretches.` }) });
  }

  // Seams: two runs on the same mesh edges are the two sides of one seam.
  const seams = [], seamReport = [], byId = new Map(patterns.map((p) => [p.id, p])), length = (run) => segmentLength(byId.get(run.piece.id), byId.get(run.piece.id).segments.find((s) => s.id === run.id));
  const along = (run) => { const g = [run.piece.patch.gv[run.edges[0].a]], f = [0]; for (let i = 0; i < run.edges.length; i++) { g.push(run.piece.patch.gv[run.edges[i].b]); f.push(f[i] + Math.hypot(run.pts[i + 1][0] - run.pts[i][0], run.pts[i + 1][1] - run.pts[i][1])); } return { g, f: f.map((x) => x / (f.at(-1) || 1)) }; };
  const sewn = new Set();
  for (const piece of pieces) for (const run of piece.runs) {
    const others = runOf.get(run.edges[0].key).filter((r) => r !== run);
    if (others.length !== 1 || sewn.has(run)) continue;   // a free edge, or more than two sheets on one edge
    const mate = others[0]; sewn.add(run); sewn.add(mate);
    const a = along(run), b = along(mate), flip = b.g[0] !== a.g[0] || (a.g[0] === a.g.at(-1) && b.g[1] !== a.g[1]);
    const where = new Map(b.g.map((g, i) => [g, flip ? 1 - b.f[i] : b.f[i]]));
    // Where the two sides stretch differently, points between the ends keep the 3D order: {a, b} fractions along each side.
    let stops = []; for (let i = 1; i < a.g.length - 1; i++) { const fb = where.get(a.g[i]); if (fb != null && Math.abs(fb - a.f[i]) > 0.002) stops.push({ a: r4(a.f[i]), b: r4(fb) }); }
    if (stops.length > 7) stops = Array.from({ length: 7 }, (_, i) => stops[Math.round((i + 0.5) * stops.length / 7 - 0.5)]);
    const correspondence = []; for (const s of stops) { const last = correspondence.at(-1) || { a: 0, b: 0 }; if (s.a > last.a + 1e-3 && s.b > last.b + 1e-3 && s.a < 0.999 && s.b < 0.999) correspondence.push(s); }
    const la = length(run), lb = length(mate), mismatch = Math.abs(la - lb) / Math.max(la, lb, 1e-9), ease = Math.ceil((mismatch + 0.001) * 1e4) / 1e4;
    const id = unique(`sew_${slug(run.piece.id, 22)}_${slug(mate.piece.id, 22)}`);
    seams.push({ id, a: { pattern: run.piece.id, segment: run.id }, b: { pattern: mate.piece.id, segment: mate.id }, flip, ease, kind: 'plain', correspondence });
    seamReport.push({ id, a: `${run.piece.id}.${run.id}`, b: `${mate.piece.id}.${mate.id}`, lengthA: r3(la), lengthB: r3(lb), mismatch: +mismatch.toFixed(5), ease, ...(run.piece === mate.piece && { closes: 'the piece onto itself' }) });
    run.sewn = mate.sewn = true;
  }
  // Notches: where a seam segment starts in the middle of a smooth edge (the other side has a corner there, or the
  // run was broken to fit), a match mark on both sides shows where the two meet.
  for (const piece of pieces) for (const run of piece.runs) if ((run.sewn || run.before.sewn) && piece.turn.get(run.start) < 10) byId.get(piece.id).notches.push({ segment: run.id, at: 0, kind: 'match' });
  const arrangement = pieces.map((p) => ({ pattern: p.id, position: p.position, rotation: p.rotation, layer: 0, source: 'flatten' }));
  const meshes = pieces.map((p) => ({ id: p.id, uv: p.flat.uv, xyz: p.patch.P, triangles: p.patch.tri, stretch: p.flat.stretch }));
  return { body: M.body, patterns, seams, arrangement, report: { pieces: report, seams: seamReport, cuts, skipped }, meshes };
}

/** The bodies of a mesh and the faces of one of them: what a caller names in flattenMesh. */
export function describeFaces(mesh, { body } = {}) {
  const bodies = bodiesOf(mesh).map((b, index) => ({ index, name: nameOf(b), triangles: b.count }));
  if (body == null && bodies.length > 1) return { bodies };
  const M = prepare(mesh, body); triangleNormals(M);
  const rows = Array.from({ length: M.nf }, (_, index) => ({ index, triangles: 0, area: 0, c: [0, 0, 0], n: [0, 0, 0] }));
  for (let t = 0; t < M.nt; t++) { const row = rows[M.faceOf[t]]; row.triangles++; row.area += M.A[t]; for (let k = 0; k < 3; k++) { row.n[k] += M.N[3 * t + k] * M.A[t]; row.c[k] += (M.P[3 * M.tri[3 * t] + k] + M.P[3 * M.tri[3 * t + 1] + k] + M.P[3 * M.tri[3 * t + 2] + k]) / 3 * M.A[t]; } }
  return { bodies, body: M.body, faces: rows.map(({ index, triangles, area, c, n }) => { const l = Math.hypot(...n); return { index, triangles, area: r3(area), centre: c.map((x) => r3(x / (area || 1))), normal: l ? n.map((x) => r4(x / l)) : null, kind: l > 0.9999 * area ? 'flat' : 'curved' }; }) };
}

/** The document with the flattened pieces added (mode 'append') or in place of its patterns ('replace'; materials and the avatar stay). */
export function mergeFlattened(document, flat, mode = 'append') {
  const d = structuredClone(document);
  if (mode === 'replace') Object.assign(d, { patterns: [], seams: [], arrangement: [], attachments: [], constraints: [], annotations: [], grades: [] });
  d.patterns = [...(d.patterns || []), ...flat.patterns]; d.seams = [...(d.seams || []), ...flat.seams]; d.arrangement = [...(d.arrangement || []), ...flat.arrangement];
  return d;
}
