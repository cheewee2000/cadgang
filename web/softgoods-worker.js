// Incremental XPBD cloth preview. Pattern meshes and manufacturing data remain
// authoritative outside this worker. Current scope: gravity, anisotropic in-plane
// stretch, bending for a fabric with a measured rigidity, seam and fixed attachment constraints, layers that keep to their side of each other, with per-vertex strain diagnostics. Body pressure requires a collision body and is reported unavailable until one is supplied.
// Units: mm, g, s. A force is g·mm/s² (1e-6 N), so a pressure is g/(mm·s²), which is the pascal.

let state = null, timer = null;
const V = (a, i) => [a[i * 3], a[i * 3 + 1], a[i * 3 + 2]];
const set = (a, i, p) => { a[i * 3] = p[0]; a[i * 3 + 1] = p[1]; a[i * 3 + 2] = p[2]; };
// An arrangement turns a flat piece about x, then y, then z (degrees) and moves it: [90,0,0] stands it up facing -y.
// src/core/softgoods-arrange.js centres pieces with the same convention.
const transform = (u, v, a = {}) => { const [rx, ry, rz] = (a.rotation || [0, 0, 0]).map((x) => x * Math.PI / 180), p = a.position || [0, 0, 0]; let x = u, y = v * Math.cos(rx), z = v * Math.sin(rx); [x, z] = [x * Math.cos(ry) + z * Math.sin(ry), -x * Math.sin(ry) + z * Math.cos(ry)]; [x, y] = [x * Math.cos(rz) - y * Math.sin(rz), x * Math.sin(rz) + y * Math.cos(rz)]; return [p[0] + x, p[1] + y, p[2] + z]; };

function initialize(input) {
  const arrangements = new Map(input.arrangement.map((a) => [a.pattern, a])), patterns = new Map(input.patterns.map((p) => [p.id, p]));
  let total = 0; const pieces = [];
  for (const m of input.meshes) { const off = total; total += m.uv.length / 2; pieces.push({ ...m, off }); }
  const x = new Float64Array(total * 3), prev = new Float64Array(total * 3), inv = new Float64Array(total).fill(1), radius = new Float64Array(total), area = new Float64Array(total), density = new Float64Array(total), friction = new Float64Array(total), constraints = [], excluded = new Set(), uvAll = new Float64Array(total * 2), pieceAt = new Int32Array(total), tris = [], bendRows = [], pieceOf = new Map(), materialAt = new Array(total);
  for (const p of pieces) {
    const ar = arrangements.get(p.id) || {}, spec = patterns.get(p.id) || {}, grain = Number(spec.grain?.angle ?? 90) * Math.PI / 180, gx = Math.cos(grain), gy = Math.sin(grain), mat = input.materials?.[spec.material] || {};
    // A vertex carries a third of every triangle on it: its mass is the fabric's areal density (g/m²) over that area.
    for (let i = 0; i < p.triangles.length; i += 3) { const [a, b, c] = [0, 1, 2].map((k) => p.triangles[i + k]), third = Math.abs((p.uv[b * 2] - p.uv[a * 2]) * (p.uv[c * 2 + 1] - p.uv[a * 2 + 1]) - (p.uv[b * 2 + 1] - p.uv[a * 2 + 1]) * (p.uv[c * 2] - p.uv[a * 2])) / 6; area[p.off + a] += third; area[p.off + b] += third; area[p.off + c] += third; }
    for (let i = 0; i < p.uv.length / 2; i++) { materialAt[p.off+i]=mat; radius[p.off+i]=Number(mat.thickness||mat.thicknessMm||0.6)/2; density[p.off+i]=Number(mat.arealDensity??mat.weight??mat.weightGsm??250); friction[p.off+i]=Math.max(0,Math.min(1,Number(mat.friction??0.5))); inv[p.off+i]=1/Math.max(1e-9,density[p.off+i]*Math.max(area[p.off+i],1)*1e-6); const q = transform(p.uv[i * 2], p.uv[i * 2 + 1], ar); set(x, p.off + i, q); pieceOf.set(p.off + i, p.id); }
    for (let i = 0; i < p.edges.length; i += 2) { const a = p.edges[i], b = p.edges[i + 1], du = p.uv[b * 2] - p.uv[a * 2], dv = p.uv[b * 2 + 1] - p.uv[a * 2 + 1], l = Math.hypot(du, dv), along = Math.abs((du * gx + dv * gy) / (l || 1)); const measuredWarp=Number(mat.tensile?.warp),measuredWeft=Number(mat.tensile?.weft),measuredShear=Number(mat.shearRigidity); const warp = Number(mat.warpCompliance ?? (measuredWarp>0?1/(measuredWarp*1e6):2e-7)), weft = Number(mat.weftCompliance ?? (measuredWeft>0?1/(measuredWeft*1e6):5e-7)), bias = Number(mat.biasCompliance ?? (measuredShear>0?1/(measuredShear*1e6):2e-6)), alpha = along ** 4 * warp + (1 - along) ** 4 * weft + 2 * along * (1 - along) * bias; constraints.push({ a: p.off + a, b: p.off + b, rest: l, alpha, lambda: 0, kind: 'fabric' }); }
    for (let i = 0; i < p.uv.length / 2; i++) { uvAll[(p.off + i) * 2] = p.uv[i * 2]; uvAll[(p.off + i) * 2 + 1] = p.uv[i * 2 + 1]; pieceAt[p.off + i] = pieces.indexOf(p); }
    for (const t of p.triangles) tris.push(p.off + t);
    // Bending, for a fabric with a measured rigidity (N·mm, one number or {warp, weft}); without one the cloth only hangs.
    // Each pair of triangles sharing an edge is a hinge. Flat cloth that does not stretch has a bending energy quadratic in
    // position, ½ · 3D/(A0+A1) · |Σ Kᵢxᵢ|² with cotangent weights K (Bergou et al. 2006): a constant matrix, gathered here.
    const rigid = mat.rigidity, dWarp = Number(rigid?.warp ?? rigid), dWeft = Number(rigid?.weft ?? rigid);
    if (dWarp > 0 && dWeft > 0) {
      const U = (i) => [p.uv[i * 2], p.uv[i * 2 + 1]], hinge = new Map();
      for (let i = 0; i < p.triangles.length; i += 3) for (let k = 0; k < 3; k++) { const a = p.triangles[i + k], b = p.triangles[i + (k + 1) % 3], key = a < b ? a * total + b : b * total + a; (hinge.get(key) || hinge.set(key, { a, b, opposite: [] }).get(key)).opposite.push(p.triangles[i + (k + 2) % 3]); }
      for (const h of hinge.values()) {
        if (h.opposite.length !== 2) continue;
        const [x0, x1, x2, x3] = [h.a, h.b, ...h.opposite].map(U), cot = (o, m, n) => { const u = [m[0] - o[0], m[1] - o[1]], v = [n[0] - o[0], n[1] - o[1]]; return (u[0] * v[0] + u[1] * v[1]) / Math.abs(u[0] * v[1] - u[1] * v[0]); };
        const c01 = cot(x0, x1, x2), c02 = cot(x0, x1, x3), c03 = cot(x1, x0, x2), c04 = cot(x1, x0, x3), areas = (Math.abs((x1[0] - x0[0]) * (x2[1] - x0[1]) - (x1[1] - x0[1]) * (x2[0] - x0[0])) + Math.abs((x1[0] - x0[0]) * (x3[1] - x0[1]) - (x1[1] - x0[1]) * (x3[0] - x0[0]))) / 2;
        // A fold along the warp bends the weft yarns, and the other way round.
        const e = [x1[0] - x0[0], x1[1] - x0[1]], along = ((e[0] * gx + e[1] * gy) / (Math.hypot(...e) || 1)) ** 2, D = along * dWeft + (1 - along) * dWarp;
        const ids = [h.a, h.b, ...h.opposite].map((i) => p.off + i), K = [c03 + c04, c01 + c02, -c01 - c03, -c02 - c04], k = BEND_SCALE * 3 * D * 1e6 / areas;
        for (let m = 0; m < 4; m++) for (let n = 0; n < 4; n++) { const row = bendRows[ids[m]] || (bendRows[ids[m]] = new Map()); row.set(ids[n], (row.get(ids[n]) || 0) + k * K[m] * K[n]); }
      }
    }
  }
  prev.set(x);
  // Attachments are fixed world points, located by nearest UV vertex for this first worker slice.
  for (const a of input.attachments || []) { const p = pieces.find((q) => q.id === a.pattern); if (!p) continue; let best = 0, d = Infinity; for (let i = 0; i < p.uv.length / 2; i++) { const q = Math.hypot(p.uv[i * 2] - a.at[0], p.uv[i * 2 + 1] - a.at[1]); if (q < d) { d = q; best = i; } } constraints.push({ a: p.off + best, target: a.to, alpha: 0, lambda: 0, kind: 'attachment' }); }
  // Server-resolved seam pairs are bilinear boundary attachments; expand each into
  // a four-point XPBD coincidence constraint so ease/gather correspondence is exact.
  for (const s of input.seams) { const A = pieces.find((p) => p.id === s.a.pattern), B = pieces.find((p) => p.id === s.b.pattern); if (!A || !B) continue; for (const pair of s.pairs || []) { const av = pair.a.vertices.map((i) => A.off + i), bv = pair.b.vertices.map((i) => B.off + i); constraints.push({ ids: [...av, ...bv], weights: [...pair.a.weights, ...pair.b.weights.map((w) => -w)], alpha: Number(s.seamCompliance ?? 1e-9), lambda: 0, kind: 'seam-pair' }); for (const i of av) for (const j of bv) { excluded.add(i * total + j); excluded.add(j * total + i); } } }
  // The bending matrix as rows of (column, value); a vertex held by an attachment does not move in the bending solve.
  let bend = null;
  if (bendRows.length) { const start = new Int32Array(total + 1), col = [], val = []; for (let i = 0; i < total; i++) { for (const [j, v] of bendRows[i] || []) { col.push(j); val.push(v); } start[i + 1] = col.length; } const mass = Float64Array.from(inv, (w) => 1 / w); for (const c of constraints) if (c.kind === 'attachment') mass[c.a] = 1e12; bend = { start, col: Int32Array.from(col), val: Float64Array.from(val), mass }; }
  let edgeSum = 0, edgeCount = 0; for (const c of constraints) if (c.kind === 'fabric') { edgeSum += c.rest; edgeCount++; }
  state = { input, pieces, x, prev, inv, radius, area, density, friction, bend, total, uvAll, pieceAt, tris: Int32Array.from(tris), cell: edgeCount ? edgeSum / edgeCount : 25, push: new Float64Array(total), contact: new Float64Array(total), materialAt, constraints, excluded, velocities: new Float64Array(total * 3), pressure: new Float32Array(total), running: false, step: 0, collision: input.collisionBody ? 'avatar+self' : 'self', pressureAvailable: !!input.collisionBody };
}

function project(c, dt) {
  const { x, inv } = state;
  // |Σ wᵢxᵢ| → 0: a seam pair is a point on one edge minus a point on the other.
  if (c.ids) {
    let sx = 0, sy = 0, sz = 0, w = 0; for (let k = 0; k < c.ids.length; k++) { const i = c.ids[k] * 3, wk = c.weights[k]; sx += x[i] * wk; sy += x[i + 1] * wk; sz += x[i + 2] * wk; w += wk * wk * inv[c.ids[k]]; }
    const len = Math.hypot(sx, sy, sz); if (len < 1e-12) return; const alpha = c.alpha / (dt * dt), dl = (-len - alpha * c.lambda) / (w + alpha), q = dl / len; c.lambda += dl;
    for (let k = 0; k < c.ids.length; k++) { const i = c.ids[k] * 3, f = q * c.weights[k] * inv[c.ids[k]]; x[i] += sx * f; x[i + 1] += sy * f; x[i + 2] += sz * f; } return;
  }
  const pa = V(x, c.a);
  if (c.target) { const dx = pa[0] - c.target[0], dy = pa[1] - c.target[1], dz = pa[2] - c.target[2], len = Math.hypot(dx, dy, dz); if (len < 1e-12) return; const alpha = c.alpha / (dt * dt), dl = (-len - alpha * c.lambda) / (inv[c.a] + alpha); c.lambda += dl; set(x, c.a, [pa[0] + dx / len * dl * inv[c.a], pa[1] + dy / len * dl * inv[c.a], pa[2] + dz / len * dl * inv[c.a]]); return; }
  const pb = V(x, c.b), dx = pa[0] - pb[0], dy = pa[1] - pb[1], dz = pa[2] - pb[2], len = Math.hypot(dx, dy, dz); if (len < 1e-12) return; const alpha = c.alpha / (dt * dt), dl = (-(len - c.rest) - alpha * c.lambda) / (inv[c.a] + inv[c.b] + alpha); c.lambda += dl; const q = dl / len; set(x, c.a, [pa[0] + dx * q * inv[c.a], pa[1] + dy * q * inv[c.a], pa[2] + dz * q * inv[c.a]]); set(x, c.b, [pb[0] - dx * q * inv[c.b], pb[1] - dy * q * inv[c.b], pb[2] - dz * q * inv[c.b]]);
}
// Layers. A vertex nearer to a triangle of the cloth than their thicknesses allow is put back on the side it was on a
// moment ago, and the triangle is pushed the other way. Not tested: a vertex against its own triangles, against cloth
// that is close to it in the flat pattern (its neighbours), or against the edge it is sewn to.
// ponytail: the side comes from the previous substep only, so cloth that starts interpenetrating, or crosses more than
// BAND in one substep, stays crossed; remember the side per pair if that shows.
const BAND = 6;
function collideSelf() {
  const { x, prev, inv, radius, tris, uvAll, pieceAt, excluded, total, cell } = state, bins = new Map(), near = (2.5 * cell) ** 2;
  const key = (a, b, c) => ((a * 73856093) ^ (b * 19349663) ^ (c * 83492791)) | 0;
  for (let t = 0; t < tris.length; t += 3) {
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let k = 0; k < 3; k++) for (let j = 0; j < 3; j++) { const v = x[tris[t + k] * 3 + j]; if (v < lo[j]) lo[j] = v; if (v > hi[j]) hi[j] = v; }
    for (let a = Math.floor((lo[0] - BAND) / cell); a <= Math.floor((hi[0] + BAND) / cell); a++) for (let b = Math.floor((lo[1] - BAND) / cell); b <= Math.floor((hi[1] + BAND) / cell); b++) for (let c = Math.floor((lo[2] - BAND) / cell); c <= Math.floor((hi[2] + BAND) / cell); c++) { const k = key(a, b, c), list = bins.get(k); if (list) list.push(t); else bins.set(k, [t]); }
  }
  // The signed distance of point p from triangle a,b,c in array q, and where its foot falls in the triangle.
  const plane = (q, p, a, b, c, out) => {
    const ux = q[b] - q[a], uy = q[b + 1] - q[a + 1], uz = q[b + 2] - q[a + 2], vx = q[c] - q[a], vy = q[c + 1] - q[a + 1], vz = q[c + 2] - q[a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; const nl = Math.hypot(nx, ny, nz); if (nl < 1e-12) return false; nx /= nl; ny /= nl; nz /= nl;
    const wx = q[p] - q[a], wy = q[p + 1] - q[a + 1], wz = q[p + 2] - q[a + 2], uu = ux * ux + uy * uy + uz * uz, uv = ux * vx + uy * vy + uz * vz, vv = vx * vx + vy * vy + vz * vz, wu = wx * ux + wy * uy + wz * uz, wv = wx * vx + wy * vy + wz * vz, den = uu * vv - uv * uv;
    out.d = wx * nx + wy * ny + wz * nz; out.n = [nx, ny, nz]; out.s = (vv * wu - uv * wv) / den; out.t = (uu * wv - uv * wu) / den; return true;
  };
  const now = {}, was = {};
  for (let i = 0; i < inv.length; i++) {
    const list = bins.get(key(Math.floor(x[i * 3] / cell), Math.floor(x[i * 3 + 1] / cell), Math.floor(x[i * 3 + 2] / cell))); if (!list) continue;
    for (const t of list) {
      const a = tris[t], b = tris[t + 1], c = tris[t + 2]; if (a === i || b === i || c === i) continue;
      if (pieceAt[a] === pieceAt[i]) { const du = (uvAll[a * 2] + uvAll[b * 2] + uvAll[c * 2]) / 3 - uvAll[i * 2], dv = (uvAll[a * 2 + 1] + uvAll[b * 2 + 1] + uvAll[c * 2 + 1]) / 3 - uvAll[i * 2 + 1]; if (du * du + dv * dv < near) continue; }
      else if (excluded.has(i * total + a) || excluded.has(i * total + b) || excluded.has(i * total + c)) continue;
      if (!plane(x, i * 3, a * 3, b * 3, c * 3, now) || Math.abs(now.d) > BAND || now.s < -0.02 || now.t < -0.02 || now.s + now.t > 1.02) continue;
      if (!plane(prev, i * 3, a * 3, b * 3, c * 3, was) || Math.abs(was.d) < 1e-6) continue;
      const side = Math.sign(was.d), gap = radius[i] + radius[a], lack = gap - side * now.d; if (lack <= 0) continue;
      const bw = [1 - now.s - now.t, now.s, now.t], w = inv[i] + bw[0] ** 2 * inv[a] + bw[1] ** 2 * inv[b] + bw[2] ** 2 * inv[c], f = side * lack / w;
      for (let j = 0; j < 3; j++) { x[i * 3 + j] += now.n[j] * f * inv[i]; x[a * 3 + j] -= now.n[j] * f * bw[0] * inv[a]; x[b * 3 + j] -= now.n[j] * f * bw[1] * inv[b]; x[c * 3 + j] -= now.n[j] * f * bw[2] * inv[c]; }
    }
  }
}
// The body is a few ellipsoids and capsules (src/core/softgoods-arrange.js avatarBody) standing on a floor at z = 0.
// A vertex inside one is put back on its surface; how far it was pushed is the contact force, and cloth in contact drags.
// drag false: only put the cloth back outside, after the layers moved it (friction has had this substep's slide already).
function collideAvatar(drag = true) {
  const b = state.input.collisionBody; if (!b) return; const { x, prev, radius, push, friction } = state;
  for (let i = 0; i < state.inv.length; i++) {
    const p = [x[i * 3], x[i * 3 + 1], x[i * 3 + 2]]; let n = null, depth = 0;
    for (const s of b.shapes || []) {
      if (s.type === 'ellipsoid') {
        const r = s.r.map((v) => v + radius[i]), d = [0, 1, 2].map((k) => (p[k] - s.c[k]) / r[k]), q = Math.hypot(...d); if (q >= 1 || q < 1e-9) continue;
        // Out along the surface normal at the point the centre ray meets: the gradient of the ellipsoid's own equation.
        const g = [0, 1, 2].map((k) => d[k] / r[k]), gl = Math.hypot(...g), dist = (1 - q) / gl * q; if (dist > depth) { depth = dist; n = g.map((v) => v / gl); }
      } else {
        const ab = [0, 1, 2].map((k) => s.b[k] - s.a[k]), t = Math.max(0, Math.min(1, [0, 1, 2].reduce((m, k) => m + (p[k] - s.a[k]) * ab[k], 0) / (ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2 || 1))), d = [0, 1, 2].map((k) => p[k] - s.a[k] - ab[k] * t), q = Math.hypot(...d), dist = s.r + radius[i] - q;
        if (dist > depth && q > 1e-9) { depth = dist; n = d.map((v) => v / q); }
      }
    }
    if (p[2] < radius[i]) { x[i * 3 + 2] = radius[i]; p[2] = radius[i]; }
    if (!n) continue;
    for (let k = 0; k < 3; k++) x[i * 3 + k] = p[k] + n[k] * depth;
    push[i] += depth; if (!drag) continue;
    // Friction: of this step's slide along the surface, the contact holds back up to friction × the push.
    const d = [0, 1, 2].map((k) => x[i * 3 + k] - prev[i * 3 + k]), dn = d[0] * n[0] + d[1] * n[1] + d[2] * n[2], slide = d.map((v, k) => v - dn * n[k]), sl = Math.hypot(...slide);
    if (sl > 1e-9) { const hold = Math.min(1, friction[i] * depth / sl); for (let k = 0; k < 3; k++) x[i * 3 + k] -= slide[k] * hold; }
  }
}
// Seams close from wherever the pieces were arranged: without a speed limit the first steps would fling the cloth.
const MAX_SPEED = 2500;
// The hinge energy as written is stiffer than a plate of rigidity D by a constant: 3/8 brings a cantilever of this mesh
// to the beam formula's droop (test/softgoods-review.test.js holds it there, at two mesh sizes).
const BEND_SCALE = 3 / 8;
// Bending is stiff and reaches across the whole piece, which hinge-by-hinge passes cannot carry (a foam panel would
// hang like cloth). So once a step the bending force changes the velocities implicitly: (M + dt²Q) Δv = -dt Q (x + dt v),
// solved per axis by conjugate gradients. A cantilever then droops what a beam of that rigidity does.
function bendKick(dt) {
  const B = state.bend; if (!B) return; const n = state.inv.length, { x, velocities: v } = state, { start, col, val, mass } = B;
  const Q = (p, out) => { for (let i = 0; i < n; i++) { let sum = 0; for (let k = start[i]; k < start[i + 1]; k++) sum += val[k] * p[col[k]]; out[i] = sum; } };
  const diag = B.diag || (B.diag = Float64Array.from(mass, (m, i) => { let d = 0; for (let k = start[i]; k < start[i + 1]; k++) if (col[k] === i) d = val[k]; return m + dt * dt * d; }));
  const y = new Float64Array(n), r = new Float64Array(n), z = new Float64Array(n), p = new Float64Array(n), Ap = new Float64Array(n), dv = new Float64Array(n);
  for (let axis = 0; axis < 3; axis++) {
    for (let i = 0; i < n; i++) y[i] = x[i * 3 + axis] + dt * v[i * 3 + axis];
    Q(y, r); let rz = 0, r0 = 0; for (let i = 0; i < n; i++) { r[i] *= -dt; dv[i] = 0; z[i] = r[i] / diag[i]; p[i] = z[i]; rz += r[i] * z[i]; r0 += r[i] * r[i]; }
    for (let it = 0; it < 400 && rz > 1e-10 * r0 / n + 1e-30; it++) {
      Q(p, Ap); let pAp = 0; for (let i = 0; i < n; i++) { Ap[i] = mass[i] * p[i] + dt * dt * Ap[i]; pAp += p[i] * Ap[i]; }
      const a = rz / pAp; let next = 0; for (let i = 0; i < n; i++) { dv[i] += a * p[i]; r[i] -= a * Ap[i]; z[i] = r[i] / diag[i]; next += r[i] * z[i]; }
      const b = next / rz; rz = next; for (let i = 0; i < n; i++) p[i] = z[i] + b * p[i];
    }
    for (let i = 0; i < n; i++) v[i * 3 + axis] += dv[i];
  }
}
// One step is SUBSTEPS small steps of one constraint pass each: at the same cost as eight passes over one long step,
// hanging cloth stops stretching under its own weight, so the strain map shows fit and not solver error.
const SUBSTEPS = 8;
function tick() {
  if (!state?.running) return; const began = performance.now(), dt = 1 / 120 / SUBSTEPS, { x, prev, velocities: v, push, contact } = state; contact.fill(0); bendKick(1 / 120);
  for (let sub = 0; sub < SUBSTEPS; sub++) {
    prev.set(x); push.fill(0);
    for (let i = 0; i < state.inv.length; i++) { const damp=1-Math.max(0,Math.min(1,Number(state.materialAt?.[i]?.damping??.005)))/SUBSTEPS;v[i * 3] *= damp; v[i * 3 + 1] *= damp; v[i * 3 + 2] = (v[i * 3 + 2] - 9810 * dt) * damp; const speed = Math.hypot(v[i * 3], v[i * 3 + 1], v[i * 3 + 2]), cap = speed > MAX_SPEED ? MAX_SPEED / speed : 1; v[i * 3] *= cap; v[i * 3 + 1] *= cap; v[i * 3 + 2] *= cap; x[i * 3] += v[i * 3] * dt; x[i * 3 + 1] += v[i * 3 + 1] * dt; x[i * 3 + 2] += v[i * 3 + 2] * dt; }
    for (const c of state.constraints) { c.lambda = 0; project(c, dt); }
    collideAvatar(); if (sub % 2) { collideSelf(); collideAvatar(false); }
    // Contact force per area in Pa: what pushed the vertex out (mass × push / dt²) over the vertex's own area.
    for (let i = 0; i < state.inv.length; i++) { v[i * 3] = (x[i * 3] - prev[i * 3]) / dt; v[i * 3 + 1] = (x[i * 3 + 1] - prev[i * 3 + 1]) / dt; v[i * 3 + 2] = (x[i * 3 + 2] - prev[i * 3 + 2]) / dt; contact[i] += state.density[i] * 1e-6 * push[i] / (dt * dt) / SUBSTEPS; }
  }
  for (let i = 0; i < state.inv.length; i++) state.pressure[i] += 0.1 * (contact[i] - state.pressure[i]);
  state.step++; state.ms = (state.ms ?? 0) + 0.1 * (performance.now() - began - (state.ms ?? 0)); if (state.step % 2 === 0 && typeof postMessage === 'function') send();
}
/** The solver without a page: initialise, advance, return the frame. Tests and scripts call this. */
export function simulate(input, steps = 0) { initialize(input); state.running = true; for (let i = 0; i < steps; i++) tick(); state.running = false; return snapshot(); }
function send() { const m = snapshot(); postMessage(m, [m.positions.buffer, m.strain.buffer, m.pressure.buffer]); }
function snapshot() {
  const positions = Float32Array.from(state.x), strain = new Float32Array(state.inv.length), pressure = Float32Array.from(state.pressure), count = new Uint16Array(state.inv.length);
  for (const c of state.constraints) {
    if (c.kind !== 'fabric' || c.target || !(c.rest > 0)) continue;
    const a = V(state.x, c.a), b = V(state.x, c.b), e = (Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) - c.rest) / c.rest;
    strain[c.a] += e; strain[c.b] += e; count[c.a]++; count[c.b]++;
  }
  let minStrain = Infinity, maxStrain = -Infinity, maxPressure = 0;
  for (let i = 0; i < strain.length; i++) { strain[i] = count[i] ? strain[i] / count[i] : 0; minStrain = Math.min(minStrain, strain[i]); maxStrain = Math.max(maxStrain, strain[i]); maxPressure=Math.max(maxPressure,pressure[i]); }
  return { type: 'frame', step: state.step, ms: state.ms ?? 0, body: state.input.collisionBody?.shapes || [], collision: state.collision, diagnostics: { strain: { unit: 'ratio', min: minStrain, max: maxStrain }, pressure: { available: state.pressureAvailable, unit: 'Pa', min: 0, max: maxPressure, reason: state.pressureAvailable ? null : 'No collision body is present in this preview' } }, positions, strain, pressure, pieces: state.pieces.map((p) => ({ id: p.id, off: p.off, count: p.uv.length / 2, triangles: p.triangles })) };
}
globalThis.onmessage = (e) => { const m = e.data; if (m.type === 'init') { initialize(m.input); send(); } else if (m.type === 'run') { state.running = true; clearInterval(timer); timer = setInterval(tick, 1000 / 60); } else if (m.type === 'pause') state.running = false; else if (m.type === 'reset') { initialize(state.input); send(); } };
