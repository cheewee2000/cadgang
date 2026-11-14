/**
 * Linear static stress analysis (FEA) of a solid: no mesher, no dependency.
 *
 * The solid's surface triangles become a grid of equal cubes, each an 8-node trilinear hexahedron. Every
 * element is the same, so ONE 24x24 stiffness matrix serves them all and K is never assembled: conjugate
 * gradients multiply element by element. Units are mm, N and MPa throughout.
 *
 * What it is good for: where a part is stressed, by about how much, and which of two designs is better.
 * What it is not: a certified number. The surface is stair-stepped, so the peak surface stress is noisy
 * (read p99 beside it); contact is not modelled (a load is spread over the nodes of a region, pulling as
 * well as pushing); and a wall wants 3 or more voxels through it (full-integration hexes are too stiff
 * in bending when thinner).
 *
 * ponytail: Jacobi-preconditioned CG, a few hundred to a few thousand iterations; multigrid if grids
 * past a few hundred thousand elements are ever needed.
 */

const CORNERS = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Strain from nodal displacement (6x24, rows xx yy zz xy yz zx) for a cube of side h at a natural point. */
function strainMatrix(h, xi, eta, zeta) {
  const B = new Float64Array(144);
  for (let a = 0; a < 8; a++) {
    const sx = CORNERS[a][0] * 2 - 1, sy = CORNERS[a][1] * 2 - 1, sz = CORNERS[a][2] * 2 - 1;
    const dx = sx * (1 + sy * eta) * (1 + sz * zeta) / (4 * h);
    const dy = sy * (1 + sx * xi) * (1 + sz * zeta) / (4 * h);
    const dz = sz * (1 + sx * xi) * (1 + sy * eta) / (4 * h);
    const c = 3 * a;
    B[c] = dx; B[24 + c + 1] = dy; B[48 + c + 2] = dz;
    B[72 + c] = dy; B[72 + c + 1] = dx;
    B[96 + c + 1] = dz; B[96 + c + 2] = dy;
    B[120 + c] = dz; B[120 + c + 2] = dx;
  }
  return B;
}

/** Isotropic elasticity, 6x6. */
function elasticity(E, nu) {
  const l = E * nu / ((1 + nu) * (1 - 2 * nu)), g = E / (2 * (1 + nu)), D = new Float64Array(36);
  for (let i = 0; i < 3; i++) { for (let j = 0; j < 3; j++) D[i * 6 + j] = l; D[i * 7] = l + 2 * g; D[(i + 3) * 7] = g; }
  return D;
}

const times = (A, rows, inner, B, cols) => {   // A (rows x inner) * B (inner x cols)
  const C = new Float64Array(rows * cols);
  for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) { let s = 0; for (let k = 0; k < inner; k++) s += A[i * inner + k] * B[k * cols + j]; C[i * cols + j] = s; }
  return C;
};

/** The one element stiffness matrix, 2x2x2 Gauss. */
function stiffness(h, D) {
  const K = new Float64Array(576), g = 1 / Math.sqrt(3), w = (h / 2) ** 3;
  for (const xi of [-g, g]) for (const eta of [-g, g]) for (const zeta of [-g, g]) {
    const B = strainMatrix(h, xi, eta, zeta), DB = times(D, 6, 6, B, 24);
    for (let a = 0; a < 24; a++) for (let b = 0; b < 24; b++) { let s = 0; for (let i = 0; i < 6; i++) s += B[i * 24 + a] * DB[i * 24 + b]; K[a * 24 + b] += s * w; }
  }
  return K;
}

/**
 * Which cubes of side h are inside a closed triangle mesh: a ray up each column, filled between pairs of
 * crossings. Only the largest face-connected piece is kept (a sliver thinner than a voxel can break off,
 * and a piece nothing holds has no solution). -> { n: [nx, ny, nz], origin, filled, dropped }
 */
export function voxelise(P, I, h) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let t = 0; t < I.length; t++) for (let k = 0; k < 3; k++) { const v = P[3 * I[t] + k]; if (v < min[k]) min[k] = v; if (v > max[k]) max[k] = v; }
  const n = [0, 1, 2].map((k) => Math.max(1, Math.ceil((max[k] - min[k]) / h - 1e-9)));
  const origin = [0, 1, 2].map((k) => (min[k] + max[k]) / 2 - n[k] * h / 2);   // the grid's overhang is shared by both sides
  const [nx, ny, nz] = n;
  const hits = Array.from({ length: nx * ny }, () => []);
  const ox = origin[0] + h * 7.31e-4, oy = origin[1] + h * 3.917e-4;   // off the grid lines: a ray never runs along a triangle's edge
  for (let t = 0; t < I.length; t += 3) {
    const a = 3 * I[t], b = 3 * I[t + 1], c = 3 * I[t + 2];
    const ax = P[a], ay = P[a + 1], az = P[a + 2], bx = P[b], by = P[b + 1], bz = P[b + 2], cx = P[c], cy = P[c + 1], cz = P[c + 2];
    const det = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
    if (Math.abs(det) < 1e-12) continue;   // edge-on to the rays
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx, cx) - ox) / h - 0.5)), i1 = Math.min(nx - 1, Math.ceil((Math.max(ax, bx, cx) - ox) / h - 0.5));
    const j0 = Math.max(0, Math.floor((Math.min(ay, by, cy) - oy) / h - 0.5)), j1 = Math.min(ny - 1, Math.ceil((Math.max(ay, by, cy) - oy) / h - 0.5));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const x = ox + (i + 0.5) * h - ax, y = oy + (j + 0.5) * h - ay;
      const u = (x * (cy - ay) - (cx - ax) * y) / det, v = ((bx - ax) * y - x * (by - ay)) / det;
      if (u < 0 || v < 0 || u + v > 1) continue;
      hits[j * nx + i].push(az + u * (bz - az) + v * (cz - az));
    }
  }
  const filled = new Uint8Array(nx * ny * nz);
  for (let c = 0; c < hits.length; c++) {
    const z = hits[c].sort((p, q) => p - q);
    for (let p = 0; p + 1 < z.length; p += 2) {
      const k0 = Math.max(0, Math.ceil((z[p] - origin[2]) / h - 0.5)), k1 = Math.min(nz - 1, Math.floor((z[p + 1] - origin[2]) / h - 0.5));
      for (let k = k0; k <= k1; k++) filled[k * nx * ny + c] = 1;
    }
  }
  // keep the largest face-connected piece
  const label = new Int32Array(filled.length), sizes = [0], stack = [];
  for (let s = 0; s < filled.length; s++) {
    if (!filled[s] || label[s]) continue;
    const id = sizes.length; let count = 0; label[s] = id; stack.push(s);
    while (stack.length) {
      const c = stack.pop(); count++;
      const i = c % nx, j = Math.floor(c / nx) % ny, k = Math.floor(c / (nx * ny));
      const visit = (d) => { if (filled[d] && !label[d]) { label[d] = id; stack.push(d); } };
      if (i > 0) visit(c - 1); if (i < nx - 1) visit(c + 1);
      if (j > 0) visit(c - nx); if (j < ny - 1) visit(c + nx);
      if (k > 0) visit(c - nx * ny); if (k < nz - 1) visit(c + nx * ny);
    }
    sizes.push(count);
  }
  const keep = sizes.indexOf(Math.max(...sizes.slice(1)));
  let dropped = 0;
  for (let s = 0; s < filled.length; s++) if (filled[s] && label[s] !== keep) { filled[s] = 0; dropped++; }
  return { n, origin, filled, dropped };
}

/** Is p in a region ({box: [min, max]} or {cylinder: {from, to, radius}}), grown by pad? */
function inRegion(region, p, pad) {
  if (region.box) { const [a, b] = region.box; return [0, 1, 2].every((k) => p[k] >= Math.min(a[k], b[k]) - pad && p[k] <= Math.max(a[k], b[k]) + pad); }
  if (region.cylinder) {
    const { from, to, radius } = region.cylinder, axis = sub(to, from), len = Math.hypot(...axis), d = sub(p, from);
    const t = dot(d, axis) / len;
    return t >= -pad && t <= len + pad && Math.sqrt(Math.max(0, dot(d, d) - t * t)) <= radius + pad;
  }
  throw new Error('A region is {box: [[x,y,z],[x,y,z]]} or {cylinder: {from: [x,y,z], to: [x,y,z], radius}}');
}

/** Solve the 3x3 system J w = m (Cramer). */
function solve3(J, m) {
  const det = (M) => M[0] * (M[4] * M[8] - M[5] * M[7]) - M[1] * (M[3] * M[8] - M[5] * M[6]) + M[2] * (M[3] * M[7] - M[4] * M[6]);
  const d = det(J);
  if (Math.abs(d) < 1e-9) throw new Error('A load with a moment needs nodes that are not all on one line');
  return [0, 1, 2].map((c) => { const M = J.slice(); for (let r = 0; r < 3; r++) M[3 * r + c] = m[r]; return det(M) / d; });
}

/**
 * Solve one load case.
 *
 * mesh: { positions, indices } — a closed triangle mesh, mm.
 * opts.size    voxel edge, mm
 * opts.E, nu   Young's modulus (MPa) and Poisson's ratio
 * opts.fixed   [region]: every node in one is held (a region reaches half a voxel past its surface)
 * opts.loads   [{ ...region, force: [fx, fy, fz] N, at?: [x, y, z], moment?: [mx, my, mz] N·mm }]: the force is
 *              spread over the region's nodes so that their sum is the force and their moment about the
 *              nodes' centroid is `moment`, plus the force's own moment when it acts at `at` (a pole's tip
 *              load carried into its socket, for one).
 *
 * -> { elements, nodes, dropped, iterations, residual, converged, maxDisp, peak: {stress, at}, p99,
 *      stressAt(x, y, z), ... } — stress is von Mises, MPa. `peak` and `p99` leave out the elements that
 *      touch a held node, where a rigid hold makes the stress meaningless.
 */
export function fea({ positions: P, indices: I }, { size: h, E, nu = 0.33, fixed = [], loads = [], tol = 1e-5, maxIter = 8000 } = {}) {
  if (!(h > 0) || !(E > 0)) throw new Error('fea needs size (mm) and E (MPa)');
  const { n: [nx, ny, nz], origin, filled, dropped } = voxelise(P, I, h);
  const gx = nx + 1, gy = ny + 1;
  const nodeOf = new Int32Array(gx * gy * (nz + 1)).fill(-1), grid = [];
  const conn = [], cellOf = [];
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    if (!filled[(k * ny + j) * nx + i]) continue;
    for (const [a, b, c] of CORNERS) {
      const g = ((k + c) * gy + (j + b)) * gx + (i + a);
      if (nodeOf[g] < 0) { nodeOf[g] = grid.length; grid.push(g); }
      conn.push(nodeOf[g]);
    }
    cellOf.push((k * ny + j) * nx + i);
  }
  const ne = cellOf.length, nn = grid.length;
  if (!ne) throw new Error(`Nothing to analyse: no ${h} mm voxel fits inside the body`);
  const xyz = (v) => { const g = grid[v]; return [origin[0] + (g % gx) * h, origin[1] + (Math.floor(g / gx) % gy) * h, origin[2] + Math.floor(g / (gx * gy)) * h]; };

  const pad = h / 2, held = new Uint8Array(nn);
  let nHeld = 0;
  for (let v = 0; v < nn; v++) { const p = xyz(v); if (fixed.some((r) => inRegion(r, p, pad))) { held[v] = 1; nHeld++; } }
  if (nHeld < 3) throw new Error(`Nothing holds the part: the fixed regions catch ${nHeld} node${nHeld === 1 ? '' : 's'} (3 or more are needed)`);

  const f = new Float64Array(3 * nn), applied = [];
  for (const load of loads) {
    const picked = [];
    for (let v = 0; v < nn; v++) if (!held[v] && inRegion(load, xyz(v), pad)) picked.push(v);
    if (!picked.length) throw new Error('A load region catches no free node of the body');
    const pts = picked.map(xyz), c = [0, 1, 2].map((k) => pts.reduce((s, p) => s + p[k], 0) / pts.length);
    const F = load.force || [0, 0, 0], M = (load.moment || [0, 0, 0]).slice();
    if (load.at) { const m = cross(sub(load.at, c), F); for (let k = 0; k < 3; k++) M[k] += m[k]; }
    let w = [0, 0, 0];
    if (Math.hypot(...M) > 0) {
      const J = new Float64Array(9);
      for (const p of pts) { const r = sub(p, c), rr = dot(r, r); for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) J[3 * a + b] += (a === b ? rr : 0) - r[a] * r[b]; }
      w = solve3(J, M);
    }
    picked.forEach((v, q) => { const t = cross(w, sub(pts[q], c)); for (let k = 0; k < 3; k++) f[3 * v + k] += F[k] / picked.length + t[k]; });
    applied.push({ nodes: picked.length, force: F, moment: M.map((m) => +m.toFixed(1)), about: c.map((m) => +m.toFixed(2)) });
  }

  const D = elasticity(E, nu), K = stiffness(h, D);
  const ndof = 3 * nn, ue = new Float64Array(24), diag = new Float64Array(ndof);
  for (let e = 0; e < ne; e++) for (let a = 0; a < 8; a++) { const v = 3 * conn[8 * e + a]; for (let k = 0; k < 3; k++) diag[v + k] += K[(3 * a + k) * 25]; }
  const hold = (v) => { for (let q = 0; q < nn; q++) if (held[q]) v[3 * q] = v[3 * q + 1] = v[3 * q + 2] = 0; };
  const multiply = (v, out) => {
    out.fill(0);
    for (let e = 0; e < ne; e++) {
      const c = 8 * e;
      for (let a = 0; a < 8; a++) { const q = 3 * conn[c + a]; ue[3 * a] = v[q]; ue[3 * a + 1] = v[q + 1]; ue[3 * a + 2] = v[q + 2]; }
      for (let a = 0; a < 8; a++) {
        const q = 3 * conn[c + a];
        for (let k = 0; k < 3; k++) { const row = (3 * a + k) * 24; let s = 0; for (let b = 0; b < 24; b++) s += K[row + b] * ue[b]; out[q + k] += s; }
      }
    }
    hold(out);
  };
  // conjugate gradients, Jacobi preconditioned
  const u = new Float64Array(ndof), r = Float64Array.from(f), z = new Float64Array(ndof), p = new Float64Array(ndof), Ap = new Float64Array(ndof);
  hold(r);
  const fNorm = Math.sqrt(r.reduce((s, v) => s + v * v, 0));
  let iterations = 0, residual = fNorm ? 1 : 0;
  if (fNorm) {
    for (let d = 0; d < ndof; d++) p[d] = z[d] = r[d] / diag[d];
    let rz = 0; for (let d = 0; d < ndof; d++) rz += r[d] * z[d];
    while (iterations < maxIter && residual > tol) {
      multiply(p, Ap);
      let pAp = 0; for (let d = 0; d < ndof; d++) pAp += p[d] * Ap[d];
      const alpha = rz / pAp;
      let rr = 0, next = 0;
      for (let d = 0; d < ndof; d++) { u[d] += alpha * p[d]; r[d] -= alpha * Ap[d]; rr += r[d] * r[d]; z[d] = r[d] / diag[d]; next += r[d] * z[d]; }
      const beta = next / rz; rz = next;
      for (let d = 0; d < ndof; d++) p[d] = z[d] + beta * p[d];
      residual = Math.sqrt(rr) / fNorm; iterations++;
    }
  }

  // von Mises at each element's centre, then averaged onto the nodes
  const S = times(D, 6, 6, strainMatrix(h, 0, 0, 0), 24), stress = new Float32Array(ne), nodeStress = new Float32Array(nn), share = new Uint8Array(nn);
  const free = [];
  let peak = { stress: 0, at: null };
  for (let e = 0; e < ne; e++) {
    let touchesHeld = false;
    for (let a = 0; a < 8; a++) { const v = conn[8 * e + a]; if (held[v]) touchesHeld = true; ue[3 * a] = u[3 * v]; ue[3 * a + 1] = u[3 * v + 1]; ue[3 * a + 2] = u[3 * v + 2]; }
    const s = [0, 0, 0, 0, 0, 0];
    for (let i = 0; i < 6; i++) for (let b = 0; b < 24; b++) s[i] += S[i * 24 + b] * ue[b];
    const vm = Math.sqrt(0.5 * ((s[0] - s[1]) ** 2 + (s[1] - s[2]) ** 2 + (s[2] - s[0]) ** 2) + 3 * (s[3] ** 2 + s[4] ** 2 + s[5] ** 2));
    stress[e] = vm;
    for (let a = 0; a < 8; a++) { const v = conn[8 * e + a]; nodeStress[v] += vm; share[v]++; }
    if (touchesHeld) continue;
    free.push(vm);
    if (vm > peak.stress) { const c = cellOf[e]; peak = { stress: vm, at: [origin[0] + (c % nx + 0.5) * h, origin[1] + (Math.floor(c / nx) % ny + 0.5) * h, origin[2] + (Math.floor(c / (nx * ny)) + 0.5) * h] }; }
  }
  for (let v = 0; v < nn; v++) nodeStress[v] /= share[v];
  free.sort((a, b) => a - b);
  let maxDisp = 0;
  for (let v = 0; v < nn; v++) maxDisp = Math.max(maxDisp, Math.hypot(u[3 * v], u[3 * v + 1], u[3 * v + 2]));

  /** Von Mises stress at a point on or in the body: the nodes of the voxel it is in (or of the ones around it), nearest weighing most. */
  const stressAt = (x, y, z0) => {
    const ci = Math.min(nx - 1, Math.max(0, Math.floor((x - origin[0]) / h))), cj = Math.min(ny - 1, Math.max(0, Math.floor((y - origin[1]) / h))), ck = Math.min(nz - 1, Math.max(0, Math.floor((z0 - origin[2]) / h)));
    for (const reach of [0, 1, 2]) {
      let sum = 0, weight = 0;
      for (let k = Math.max(0, ck - reach); k <= Math.min(nz, ck + 1 + reach); k++) for (let j = Math.max(0, cj - reach); j <= Math.min(ny, cj + 1 + reach); j++) for (let i = Math.max(0, ci - reach); i <= Math.min(nx, ci + 1 + reach); i++) {
        const v = nodeOf[(k * gy + j) * gx + i]; if (v < 0) continue;
        const d2 = (origin[0] + i * h - x) ** 2 + (origin[1] + j * h - y) ** 2 + (origin[2] + k * h - z0) ** 2, wgt = 1 / (d2 + (0.1 * h) ** 2);
        sum += wgt * nodeStress[v]; weight += wgt;
      }
      if (weight) return sum / weight;
    }
    return 0;
  };

  return {
    size: h, grid: [nx, ny, nz], elements: ne, nodes: nn, dropped, held: nHeld, applied,
    iterations, residual, converged: residual <= tol,
    maxDisp, peak, p99: free.length ? free[Math.floor(0.99 * (free.length - 1))] : 0,
    stressAt,
  };
}

/** Triangle soup (9 numbers a triangle) with no edge longer than maxEdge, so a per-vertex value has somewhere to change. */
export function refine(P, I, maxEdge, cap = 600000) {
  const out = [], stack = [];
  for (let t = 0; t < I.length; t += 3) stack.push([0, 1, 2].map((q) => [P[3 * I[t + q]], P[3 * I[t + q] + 1], P[3 * I[t + q] + 2]]));
  const len = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  while (stack.length) {
    const [a, b, c] = stack.pop(), ab = len(a, b), bc = len(b, c), ca = len(c, a), longest = Math.max(ab, bc, ca);
    if (longest <= maxEdge || out.length / 9 + stack.length >= cap) { out.push(...a, ...b, ...c); continue; }
    const mid = (p, q) => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2];
    if (longest === ab) { const m = mid(a, b); stack.push([a, m, c], [m, b, c]); }
    else if (longest === bc) { const m = mid(b, c); stack.push([a, b, m], [a, m, c]); }
    else { const m = mid(c, a); stack.push([a, b, m], [m, b, c]); }
  }
  return Float32Array.from(out);
}

/** 0..1 -> [r, g, b] 0..1: blue, cyan, green, yellow, red. */
export function heat(t) {
  const x = Math.min(1, Math.max(0, t)) * 4, s = Math.min(3, Math.floor(x)), k = x - s;
  return [[0, k, 1], [0, 1, 1 - k], [k, 1, 0], [1, 1 - k, 0]][s];
}

/** A binary PLY of a triangle soup with a colour (0..1) at each vertex: what the viewer opens. */
export function colouredPLY(soup, colours) {
  const nv = soup.length / 3, nt = nv / 3;
  const head = Buffer.from(`ply\nformat binary_little_endian 1.0\nelement vertex ${nv}\nproperty float x\nproperty float y\nproperty float z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nelement face ${nt}\nproperty list uchar int vertex_indices\nend_header\n`);
  const body = Buffer.alloc(nv * 15 + nt * 13);
  let o = 0;
  for (let v = 0; v < nv; v++) {
    for (let k = 0; k < 3; k++) { body.writeFloatLE(soup[3 * v + k], o); o += 4; }
    for (let k = 0; k < 3; k++) body[o++] = Math.round(colours[3 * v + k] * 255);
  }
  for (let t = 0; t < nt; t++) { body[o++] = 3; for (let k = 0; k < 3; k++) { body.writeInt32LE(3 * t + k, o); o += 4; } }
  return Buffer.concat([head, body]);
}

/**
 * A binary glTF of a triangle soup cut into colour bands by a value at each vertex (0..top): one named, coloured mesh
 * per band. A viewer that shows a file's own material colours shows the map, and its part list is the legend.
 */
export function bandedGLB(soup, values, top, unit = 'MPa', bands = 12) {
  const tris = Array.from({ length: bands }, () => []);
  for (let t = 0; t < soup.length / 9; t++) tris[Math.max(0, Math.min(bands - 1, Math.floor(bands * (values[3 * t] + values[3 * t + 1] + values[3 * t + 2]) / 3 / top)))].push(t);
  const linear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);   // glTF colours are linear, heat() is what the eye sees
  const gltf = { asset: { version: '2.0', generator: 'cadgang fea' }, scene: 0, scenes: [{ nodes: [] }], nodes: [], meshes: [], materials: [], accessors: [], bufferViews: [], buffers: [] };
  const chunks = [];
  let offset = 0;
  tris.forEach((list, b) => {
    if (!list.length) return;
    const pos = new Float32Array(list.length * 9), min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    list.forEach((t, i) => { for (let k = 0; k < 9; k++) { const x = soup[9 * t + k]; pos[9 * i + k] = x; min[k % 3] = Math.min(min[k % 3], x); max[k % 3] = Math.max(max[k % 3], x); } });
    const i = gltf.meshes.length, name = `${Math.round(top * b / bands)}-${Math.round(top * (b + 1) / bands)} ${unit}${b === bands - 1 ? ' and over' : ''}`;
    gltf.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: pos.byteLength });
    gltf.accessors.push({ bufferView: i, componentType: 5126, count: pos.length / 3, type: 'VEC3', min, max });
    gltf.materials.push({ name, pbrMetallicRoughness: { baseColorFactor: [...heat((b + 0.5) / bands).map(linear), 1], metallicFactor: 0, roughnessFactor: 0.8 } });
    gltf.meshes.push({ name, primitives: [{ attributes: { POSITION: i }, material: i }] });
    gltf.nodes.push({ name, mesh: i });
    gltf.scenes[0].nodes.push(i);
    chunks.push(Buffer.from(pos.buffer));
    offset += pos.byteLength;
  });
  const bin = Buffer.concat(chunks);
  gltf.buffers.push({ byteLength: bin.length });
  let json = Buffer.from(JSON.stringify(gltf));
  json = Buffer.concat([json, Buffer.alloc((4 - json.length % 4) % 4, 0x20)]);
  const chunk = (data, type) => { const h = Buffer.alloc(8); h.writeUInt32LE(data.length, 0); h.writeUInt32LE(type, 4); return Buffer.concat([h, data]); };
  const head = Buffer.alloc(12);
  head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 16 + json.length + bin.length, 8);
  return Buffer.concat([head, chunk(json, 0x4e4f534a), chunk(bin, 0x004e4942)]);
}

// 3x5 glyphs, rows top to bottom, for the scale's numbers
const GLYPHS = {
  0: '111101101101111', 1: '010110010010111', 2: '111001111100111', 3: '111001111001111', 4: '101101111001001',
  5: '111100111001111', 6: '111100111101111', 7: '111001001001001', 8: '111101111101111', 9: '111101111001111',
  '.': '000000000000010', M: '101111111101101', P: '111101111100100', a: '000110011101111', ' ': '000000000000000',
};

/** Draw the colour scale down the left of an RGB pixel buffer: red is `max`, blue is 0. */
export function drawScale(px, width, height, max, unit = 'MPa') {
  const x0 = 20, bar = 16, y0 = 40, y1 = height - 40, k = 3;
  const set = (x, y, c) => { if (x >= 0 && y >= 0 && x < width && y < height) { const o = (y * width + x) * 3; px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2]; } };
  for (let y = y0; y <= y1; y++) { const c = heat(1 - (y - y0) / (y1 - y0)).map((v) => Math.round(v * 255)); for (let x = x0; x < x0 + bar; x++) set(x, y, c); }
  const text = (s, x, y) => [...s].forEach((ch, i) => {
    const g = GLYPHS[ch] || GLYPHS[' '];
    for (let q = 0; q < 15; q++) if (g[q] === '1') for (let a = 0; a < k; a++) for (let b = 0; b < k; b++) set(x + i * 4 * k + (q % 3) * k + a, y + Math.floor(q / 3) * k + b, [0, 0, 0]);
  });
  const label = (v) => (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2));
  for (const t of [0, 0.25, 0.5, 0.75, 1]) text(`${t ? label(max * t) : '0'}${t === 1 ? ` ${unit}` : ''}`, x0 + bar + 8, Math.round(y1 - t * (y1 - y0)) - 7);
}
