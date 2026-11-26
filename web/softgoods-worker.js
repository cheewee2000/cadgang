// Incremental XPBD cloth preview. Pattern meshes and manufacturing data remain
// authoritative outside this worker. Current scope: gravity, anisotropic in-plane
// stretch, bending for a fabric with a measured rigidity, seam and fixed attachment constraints, layers that keep to their side of each other, with per-vertex strain diagnostics. Body pressure requires a collision body and is reported unavailable until one is supplied.
// Also, each only when the design asks for it: elastic that gathers the cloth along a line, tacks and pins, stuffing pressure,
// creased folds, shrinkage, frozen and strengthened pieces, and layers that keep their order. A design with none of them runs as before.
// Units: mm, g, s. A force is g·mm/s² (1e-6 N), so a pressure is g/(mm·s²), which is the pascal.

import { meshField } from './softgoods-sdf.js';

let state = null, timer = null;
const V = (a, i) => [a[i * 3], a[i * 3 + 1], a[i * 3 + 2]];
const set = (a, i, p) => { a[i * 3] = p[0]; a[i * 3 + 1] = p[1]; a[i * 3 + 2] = p[2]; };
// An arrangement turns a flat piece about x, then y, then z (degrees) and moves it: [90,0,0] stands it up facing -y.
// src/core/softgoods-arrange.js centres pieces with the same convention.
// wrap {radius, centre} first bends the flat piece into a tube about a line parallel to its v axis, `radius` behind its face at u = centre: a sleeve round an arm.
const transform = (u, v, a = {}) => { const [rx, ry, rz] = (a.rotation || [0, 0, 0]).map((x) => x * Math.PI / 180), p = a.position || [0, 0, 0]; let x = u, y = v * Math.cos(rx), z = v * Math.sin(rx); if (a.wrap) { const t = (u - a.wrap.centre) / a.wrap.radius, w = a.wrap.radius * (Math.cos(t) - 1); x = a.wrap.centre + a.wrap.radius * Math.sin(t); y -= w * Math.sin(rx); z += w * Math.cos(rx); } [x, z] = [x * Math.cos(ry) + z * Math.sin(ry), -x * Math.sin(ry) + z * Math.cos(ry)]; [x, y] = [x * Math.cos(rz) - y * Math.sin(rz), x * Math.sin(rz) + y * Math.cos(rz)]; return [p[0] + x, p[1] + y, p[2] + z]; };

const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]], dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
// Elastic. The cloth beside an elastic gathers in folds finer than the mesh, so within GATHER_DEPTH of the line it may shorten
// along the line without resisting: to the elastic's ratio at the line, less with distance. Elastics side by side (shirring, a
// casing) add up, to no more than the tightest of them. This is the least length factor of the flat edge a-b.
// An elastic with no stiffness given pulls with ELASTIC newtons at twice its relaxed length.
// ponytail: the depth is one number for every fabric; make it a field of the elastic if a design needs deeper or shallower gathers.
const GATHER_DEPTH = 50, ELASTIC = 5;
function gatherOf(uv, lines, a, b) {
  const du = uv[b * 2] - uv[a * 2], dv = uv[b * 2 + 1] - uv[a * 2 + 1], l = Math.hypot(du, dv) || 1, mx = (uv[a * 2] + uv[b * 2]) / 2, my = (uv[a * 2 + 1] + uv[b * 2 + 1]) / 2; let drop = 0, most = 0, nearest = Infinity, cos = 0;
  for (const e of lines) {
    let d = GATHER_DEPTH, c = 0;
    for (let k = 1; k < e.chain.length; k++) { const px = uv[e.chain[k - 1] * 2], py = uv[e.chain[k - 1] * 2 + 1], tx = uv[e.chain[k] * 2] - px, ty = uv[e.chain[k] * 2 + 1] - py, tt = tx * tx + ty * ty || 1, s = Math.max(0, Math.min(1, ((mx - px) * tx + (my - py) * ty) / tt)), q = Math.hypot(px + tx * s - mx, py + ty * s - my); if (q < d) { d = q; c = Math.min(1, Math.abs(du * tx + dv * ty) / (l * Math.sqrt(tt))); } }
    if (d >= GATHER_DEPTH) continue;
    drop += (1 - e.ratio) * (1 - d / GATHER_DEPTH); most = Math.max(most, 1 - e.ratio); if (d < nearest) { nearest = d; cos = c; }
  }
  return Math.hypot((1 - Math.min(drop, most)) * cos, Math.sqrt(1 - cos * cos));
}
// The triangle of piece p that holds the flat point (u, v), and the point's weights on its corners: a tack holds that point, not a vertex.
// ponytail: a point outside the piece takes the triangle it is least outside of, clamped to it, which is not always the nearest.
function locate(p, [u, v]) {
  let best = null, score = -Infinity;
  for (let i = 0; i < p.triangles.length && score < 0; i += 3) {
    const [a, b, c] = [0, 1, 2].map((k) => p.triangles[i + k]), ax = p.uv[a * 2], ay = p.uv[a * 2 + 1], bx = p.uv[b * 2] - ax, by = p.uv[b * 2 + 1] - ay, cx = p.uv[c * 2] - ax, cy = p.uv[c * 2 + 1] - ay, d = bx * cy - by * cx; if (!d) continue;
    const wb = ((u - ax) * cy - (v - ay) * cx) / d, wc = (bx * (v - ay) - by * (u - ax)) / d, w = [1 - wb - wc, wb, wc], inside = Math.min(...w);
    if (inside > score) { score = inside; best = { ids: [a, b, c].map((k) => p.off + k), weights: w }; }
  }
  const w = best.weights.map((q) => Math.max(0, q)), n = w[0] + w[1] + w[2]; return { ids: best.ids, weights: w.map((q) => q / n) };
}

function initialize(input) {
  const arrangements = new Map(input.arrangement.map((a) => [a.pattern, a])), patterns = new Map(input.patterns.map((p) => [p.id, p]));
  let total = 0; const pieces = [];
  for (const m of input.meshes) { const off = total; total += m.uv.length / 2; pieces.push({ ...m, off }); }
  const x = new Float64Array(total * 3), prev = new Float64Array(total * 3), inv = new Float64Array(total).fill(1), radius = new Float64Array(total), area = new Float64Array(total), density = new Float64Array(total), friction = new Float64Array(total), constraints = [], springs = [], gathered = [], creases = [], folded = [], frozen = [], excluded = new Set(), uvAll = new Float64Array(total * 2), pieceAt = new Int32Array(total), tris = [], bendRows = [], pieceOf = new Map(), materialAt = new Array(total);
  for (const p of pieces) {
    const ar = arrangements.get(p.id) || {}, spec = patterns.get(p.id) || {}, grain = Number(spec.grain?.angle ?? 90) * Math.PI / 180, gx = Math.cos(grain), gy = Math.sin(grain), mat = input.materials?.[spec.material] || {};
    // Finishing, per pattern: shrink (percent along warp and weft) shortens every rest length, strengthen multiplies the fabric's
    // stiffness, freeze holds the piece where it was arranged. The elastics and creased folds drawn on this piece come with it.
    const shrink = spec.shrink ? [1 - Number(spec.shrink.warp || 0) / 100, 1 - Number(spec.shrink.weft || 0) / 100] : null, stiff = Number(spec.strengthen) > 0 ? Number(spec.strengthen) : 1, lines = (input.elastics || []).filter((e) => e.pattern === p.id), creased = new Map();
    const span = (a, b) => { const du = p.uv[b * 2] - p.uv[a * 2], dv = p.uv[b * 2 + 1] - p.uv[a * 2 + 1], l = Math.hypot(du, dv), along = Math.min(1, Math.abs((du * gx + dv * gy) / (l || 1))); return shrink ? l * Math.hypot(along * shrink[0], Math.sqrt(1 - along * along) * shrink[1]) : l; };
    for (const f of input.folds || []) if (f.pattern === p.id) for (let k = 1; k < f.chain.length; k++) { const a = f.chain[k - 1], b = f.chain[k]; creased.set(a < b ? a * total + b : b * total + a, Math.max(-175, Math.min(175, Number(f.angle))) * Math.PI / 180); }
    // A vertex carries a third of every triangle on it: its mass is the fabric's areal density (g/m²) over that area.
    for (let i = 0; i < p.triangles.length; i += 3) { const [a, b, c] = [0, 1, 2].map((k) => p.triangles[i + k]), third = Math.abs((p.uv[b * 2] - p.uv[a * 2]) * (p.uv[c * 2 + 1] - p.uv[a * 2 + 1]) - (p.uv[b * 2 + 1] - p.uv[a * 2 + 1]) * (p.uv[c * 2] - p.uv[a * 2])) / 6; area[p.off + a] += third; area[p.off + b] += third; area[p.off + c] += third; }
    for (let i = 0; i < p.uv.length / 2; i++) { materialAt[p.off+i]=mat; radius[p.off+i]=Number(mat.thickness||mat.thicknessMm||0.6)/2; density[p.off+i]=Number(mat.arealDensity??mat.weight??mat.weightGsm??250); friction[p.off+i]=Math.max(0,Math.min(1,Number(mat.friction??0.5))); inv[p.off+i]=1/Math.max(1e-9,density[p.off+i]*Math.max(area[p.off+i],1)*1e-6); const q = transform(p.uv[i * 2], p.uv[i * 2 + 1], ar); set(x, p.off + i, q); pieceOf.set(p.off + i, p.id); if (spec.freeze) { inv[p.off + i] = 0; frozen.push(p.off + i); } }
    for (let i = 0; i < p.edges.length; i += 2) { const a = p.edges[i], b = p.edges[i + 1], du = p.uv[b * 2] - p.uv[a * 2], dv = p.uv[b * 2 + 1] - p.uv[a * 2 + 1], l = Math.hypot(du, dv), along = Math.abs((du * gx + dv * gy) / (l || 1)); const measuredWarp=Number(mat.tensile?.warp),measuredWeft=Number(mat.tensile?.weft),measuredShear=Number(mat.shearRigidity); const warp = Number(mat.warpCompliance ?? (measuredWarp>0?1/(measuredWarp*1e6):2e-7)), weft = Number(mat.weftCompliance ?? (measuredWeft>0?1/(measuredWeft*1e6):5e-7)), bias = Number(mat.biasCompliance ?? (measuredShear>0?1/(measuredShear*1e6):2e-6)), alpha = (along ** 4 * warp + (1 - along) ** 4 * weft + 2 * along * (1 - along) * bias) / stiff, rest = shrink ? span(a, b) : l, least = lines.length ? gatherOf(p.uv, lines, a, b) : 1; if (least < 1) gathered.push({ a: p.off + a, b: p.off + b, rest, min: rest * least, alpha }); else constraints.push({ a: p.off + a, b: p.off + b, rest, alpha, lambda: 0, kind: 'fabric' }); }
    // The elastic itself is a spring along its line, relaxed at ratio × the cloth it is sewn to. stiffness 0 marks the far side of an elastic seam: gathered, with the spring on the other side.
    for (const e of lines) { const k = Number(e.stiffness ?? ELASTIC); if (k > 0) for (let i = 1; i < e.chain.length; i++) { const rest = span(e.chain[i - 1], e.chain[i]) * e.ratio; springs.push({ a: p.off + e.chain[i - 1], b: p.off + e.chain[i], rest, alpha: rest / (k * 1e6) }); } }
    for (let i = 0; i < p.uv.length / 2; i++) { uvAll[(p.off + i) * 2] = p.uv[i * 2]; uvAll[(p.off + i) * 2 + 1] = p.uv[i * 2 + 1]; pieceAt[p.off + i] = pieces.indexOf(p); }
    for (const t of p.triangles) tris.push(p.off + t);
    // Bending, for a fabric with a measured rigidity (N·mm, one number or {warp, weft}); without one the cloth only hangs.
    // Each pair of triangles sharing an edge is a hinge. Flat cloth that does not stretch has a bending energy quadratic in
    // position, ½ · 3D/(A0+A1) · |Σ Kᵢxᵢ|² with cotangent weights K (Bergou et al. 2006): a constant matrix, gathered here.
    const rigid = mat.rigidity, dWarp = Number(rigid?.warp ?? rigid) * stiff, dWeft = Number(rigid?.weft ?? rigid) * stiff, bends = dWarp > 0 && dWeft > 0;
    if (bends || creased.size) {
      const U = (i) => [p.uv[i * 2], p.uv[i * 2 + 1]], hinge = new Map();
      for (let i = 0; i < p.triangles.length; i += 3) for (let k = 0; k < 3; k++) { const a = p.triangles[i + k], b = p.triangles[i + (k + 1) % 3], key = a < b ? a * total + b : b * total + a; (hinge.get(key) || hinge.set(key, { a, b, opposite: [] }).get(key)).opposite.push(p.triangles[i + (k + 2) % 3]); }
      for (const [key, h] of hinge) {
        if (h.opposite.length !== 2) continue;
        // A creased fold: the hinge rests at the fold's angle. The wing on the left of a→b goes first, so a positive angle always
        // folds toward the face of the pattern. A fabric with a rigidity also bends about that angle, below.
        const fold = creased.get(key); let wings = null;
        if (fold !== undefined) { const [a, b, o] = [h.a, h.b, h.opposite[0]].map(U), left = (b[0] - a[0]) * (o[1] - a[1]) - (b[1] - a[1]) * (o[0] - a[0]) > 0; wings = [h.opposite[left ? 0 : 1], h.opposite[left ? 1 : 0], h.a, h.b].map((i) => p.off + i); creases.push({ i: wings, rest: fold, alpha: 1 / (CREASE * Math.hypot(b[0] - a[0], b[1] - a[1]) * 1e6) }); }
        if (!bends) continue;
        const [x0, x1, x2, x3] = [h.a, h.b, ...h.opposite].map(U), cot = (o, m, n) => { const u = [m[0] - o[0], m[1] - o[1]], v = [n[0] - o[0], n[1] - o[1]]; return (u[0] * v[0] + u[1] * v[1]) / Math.abs(u[0] * v[1] - u[1] * v[0]); };
        const c01 = cot(x0, x1, x2), c02 = cot(x0, x1, x3), c03 = cot(x1, x0, x2), c04 = cot(x1, x0, x3), areas = (Math.abs((x1[0] - x0[0]) * (x2[1] - x0[1]) - (x1[1] - x0[1]) * (x2[0] - x0[0])) + Math.abs((x1[0] - x0[0]) * (x3[1] - x0[1]) - (x1[1] - x0[1]) * (x3[0] - x0[0]))) / 2;
        // A fold along the warp bends the weft yarns, and the other way round.
        const e = [x1[0] - x0[0], x1[1] - x0[1]], along = ((e[0] * gx + e[1] * gy) / (Math.hypot(...e) || 1)) ** 2, D = along * dWeft + (1 - along) * dWarp;
        const ids = [h.a, h.b, ...h.opposite].map((i) => p.off + i), K = [c03 + c04, c01 + c02, -c01 - c03, -c02 - c04], k = BEND_SCALE * 3 * D * 1e6 / areas;
        for (let m = 0; m < 4; m++) for (let n = 0; n < 4; n++) { const row = bendRows[ids[m]] || (bendRows[ids[m]] = new Map()); row.set(ids[n], (row.get(ids[n]) || 0) + k * K[m] * K[n]); }
        // Σ Kᵢxᵢ of a hinge folded by θ is its edge length × 2 sin(θ/2), along the hinge's normal and away from the face: a fold's rest value.
        if (wings) folded.push({ ids, K, k, i: wings, rest: -2 * Math.hypot(...e) * Math.sin(fold / 2) });
      }
    }
  }
  prev.set(x);
  // Attachments are fixed world points, located by nearest UV vertex for this first worker slice.
  // strength (N/mm) makes one a spring. exact: true holds the very point, weighted on its triangle. A `to` that names a pattern
  // and a point on it is a tack: the two cloth points are held together, and their triangles do not collide with each other.
  for (const a of input.attachments || []) { const p = pieces.find((q) => q.id === a.pattern); if (!p) continue; const alpha = Number(a.strength) > 0 ? 1 / (Number(a.strength) * 1e6) : 0;
    if (!Array.isArray(a.to)) { const q = pieces.find((r) => r.id === a.to?.pattern); if (!q) continue; const A = locate(p, a.at), B = locate(q, a.to.at); constraints.push({ ids: [...A.ids, ...B.ids], weights: [...A.weights, ...B.weights.map((w) => -w)], alpha: alpha || 1e-9, lambda: 0, kind: 'tack' }); for (const i of A.ids) for (const j of B.ids) { excluded.add(i * total + j); excluded.add(j * total + i); } continue; }
    if (patterns.get(p.id)?.freeze) continue;
    if (a.exact) { const A = locate(p, a.at); constraints.push({ ids: A.ids, weights: A.weights, target: a.to, alpha, lambda: 0, kind: 'pin' }); continue; }
    let best = 0, d = Infinity; for (let i = 0; i < p.uv.length / 2; i++) { const q = Math.hypot(p.uv[i * 2] - a.at[0], p.uv[i * 2 + 1] - a.at[1]); if (q < d) { d = q; best = i; } } constraints.push({ a: p.off + best, target: a.to, alpha, lambda: 0, kind: 'attachment' }); }
  // Server-resolved seam pairs are bilinear boundary attachments; expand each into
  // a four-point XPBD coincidence constraint so ease/gather correspondence is exact.
  for (const s of input.seams) { const A = pieces.find((p) => p.id === s.a.pattern), B = pieces.find((p) => p.id === s.b.pattern); if (!A || !B) continue; for (const pair of s.pairs || []) { const av = pair.a.vertices.map((i) => A.off + i), bv = pair.b.vertices.map((i) => B.off + i); constraints.push({ ids: [...av, ...bv], weights: [...pair.a.weights, ...pair.b.weights.map((w) => -w)], alpha: Number(s.seamCompliance ?? 1e-9), lambda: 0, kind: 'seam-pair' }); for (const i of av) for (const j of bv) { excluded.add(i * total + j); excluded.add(j * total + i); } } }
  // The bending matrix as rows of (column, value); a vertex held by an attachment does not move in the bending solve.
  let bend = null;
  if (bendRows.length) { const start = new Int32Array(total + 1), col = [], val = []; for (let i = 0; i < total; i++) { for (const [j, v] of bendRows[i] || []) { col.push(j); val.push(v); } start[i + 1] = col.length; } const mass = Float64Array.from(inv, (w) => w ? 1 / w : 1e12); for (const c of constraints) if (c.kind === 'attachment' && !c.alpha) mass[c.a] = 1e12; bend = { start, col: Int32Array.from(col), val: Float64Array.from(val), mass, folded, force: folded.length ? new Float64Array(total * 3) : null }; }
  let edgeSum = 0, edgeCount = 0; for (const c of constraints) if (c.kind === 'fabric') { edgeSum += c.rest; edgeCount++; } for (const c of gathered) { edgeSum += c.rest; edgeCount++; }
  // Stuffing: the pieces of a group enclose a volume. Every triangle is wound counter-clockwise in its flat pattern, and a piece
  // whose face then looks at the middle of the group is turned over, so every normal points out of the volume.
  const stuffed = (input.stuffing || []).map((s) => {
    const members = pieces.filter((p) => (s.patterns || []).includes(p.id)), centre = [0, 0, 0], out = []; let n = 0;
    for (const p of members) for (let i = 0; i < p.uv.length / 2; i++, n++) for (let k = 0; k < 3; k++) centre[k] += x[(p.off + i) * 3 + k];
    for (const p of members) {
      const local = []; let outward = 0;
      for (let i = 0; i < p.triangles.length; i += 3) { let [a, b, c] = [0, 1, 2].map((k) => p.triangles[i + k]); if ((p.uv[b * 2] - p.uv[a * 2]) * (p.uv[c * 2 + 1] - p.uv[a * 2 + 1]) - (p.uv[b * 2 + 1] - p.uv[a * 2 + 1]) * (p.uv[c * 2] - p.uv[a * 2]) < 0) [b, c] = [c, b]; local.push(p.off + a, p.off + b, p.off + c); const A = V(x, p.off + a), B = V(x, p.off + b), C = V(x, p.off + c); outward += dot3(cross3(sub3(B, A), sub3(C, A)), [0, 1, 2].map((k) => (A[k] + B[k] + C[k]) / 3 - centre[k] / n)); }
      if (outward < 0) for (let i = 0; i < local.length; i += 3) [local[i + 1], local[i + 2]] = [local[i + 2], local[i + 1]];
      out.push(...local);
    }
    return { id: s.id, tris: Int32Array.from(out), pressure: Number(s.pressure ?? STUFFING), target: Number(s.volume || 0) * 1e6, volume: 0, now: 0 };
  }).filter((g) => g.tris.length);
  // What the elastics, gathered cloth and creases move: a vertex held rigidly by an attachment, or frozen, has no give.
  const give = springs.length || gathered.length || creases.length ? Float64Array.from(inv) : inv; if (give !== inv) for (const c of constraints) if (c.kind === 'attachment' && !c.alpha) give[c.a] = 0;
  // Layers: a piece on a higher layer stays on the face side of every piece on a lower one. face is each triangle's winding in its flat pattern.
  const layerOf = pieces.map((p) => Number(arrangements.get(p.id)?.layer || 0)), layered = layerOf.some((l) => l !== layerOf[0]), face = layered ? Int8Array.from({ length: tris.length / 3 }, (_, t) => { const [a, b, c] = [0, 1, 2].map((k) => tris[t * 3 + k]); return (uvAll[b * 2] - uvAll[a * 2]) * (uvAll[c * 2 + 1] - uvAll[a * 2 + 1]) - (uvAll[b * 2 + 1] - uvAll[a * 2 + 1]) * (uvAll[c * 2] - uvAll[a * 2]) < 0 ? -1 : 1; }) : null;
  state = { input, pieces, x, prev, inv, radius, area, density, friction, bend, total, uvAll, pieceAt, tris: Int32Array.from(tris), cell: edgeCount ? edgeSum / edgeCount : 25, push: new Float64Array(total), contact: new Float64Array(total), substeps: substepsFor(stuffed), reach: radius.reduce((m, r) => Math.max(m, r), 0) + 1, materialAt, constraints, springs, gathered, creases, give, pulled: new Float64Array(springs.length ? total * 3 : 0), pulls: [...new Set(springs.flatMap((c) => [c.a, c.b]))], frozen, stuffed, layerOf, face, excluded, velocities: new Float64Array(total * 3), pressure: new Float32Array(total), running: false, step: 0, collision: input.collisionBody ? 'avatar+self' : 'self', pressureAvailable: !!input.collisionBody };
}

function project(c, dt) {
  const { x, inv } = state;
  // |Σ wᵢxᵢ| → 0: a seam pair is a point on one edge minus a point on the other.
  if (c.ids) {
    let sx = 0, sy = 0, sz = 0, w = 0; for (let k = 0; k < c.ids.length; k++) { const i = c.ids[k] * 3, wk = c.weights[k]; sx += x[i] * wk; sy += x[i + 1] * wk; sz += x[i + 2] * wk; w += wk * wk * inv[c.ids[k]]; }
    if (c.target) { sx -= c.target[0]; sy -= c.target[1]; sz -= c.target[2]; }
    const len = Math.hypot(sx, sy, sz); if (len < 1e-12) return; const alpha = c.alpha / (dt * dt), dl = (-len - alpha * c.lambda) / (w + alpha), q = dl / len; c.lambda += dl;
    for (let k = 0; k < c.ids.length; k++) { const i = c.ids[k] * 3, f = q * c.weights[k] * inv[c.ids[k]]; x[i] += sx * f; x[i + 1] += sy * f; x[i + 2] += sz * f; } return;
  }
  const pa = V(x, c.a);
  if (c.target) { const dx = pa[0] - c.target[0], dy = pa[1] - c.target[1], dz = pa[2] - c.target[2], len = Math.hypot(dx, dy, dz); if (len < 1e-12) return; const alpha = c.alpha / (dt * dt), dl = (-len - alpha * c.lambda) / (inv[c.a] + alpha); c.lambda += dl; set(x, c.a, [pa[0] + dx / len * dl * inv[c.a], pa[1] + dy / len * dl * inv[c.a], pa[2] + dz / len * dl * inv[c.a]]); return; }
  const pb = V(x, c.b), dx = pa[0] - pb[0], dy = pa[1] - pb[1], dz = pa[2] - pb[2], len = Math.hypot(dx, dy, dz); if (len < 1e-12) return; const alpha = c.alpha / (dt * dt), dl = (-(len - c.rest) - alpha * c.lambda) / (inv[c.a] + inv[c.b] + alpha); c.lambda += dl; const q = dl / len; set(x, c.a, [pa[0] + dx * q * inv[c.a], pa[1] + dy * q * inv[c.a], pa[2] + dz * q * inv[c.a]]); set(x, c.b, [pb[0] - dx * q * inv[c.b], pb[1] - dy * q * inv[c.b], pb[2] - dz * q * inv[c.b]]);
}
// The elastics pull. Every spring is measured before any vertex moves and the pulls are added up, so the even tension along
// a stretched elastic cancels at each vertex and only what is left over moves the cloth; one after another, each spring would
// drag its neighbours about and the cloth would never settle. An elastic shorter than its relaxed length is slack.
// ponytail: a vertex where more than two springs meet (elastics crossing) could overshoot; halve the pull there if it shows.
function pull(dt) {
  const { x, give, pulled } = state;
  for (const c of state.springs) {
    const a = c.a * 3, b = c.b * 3, dx = x[a] - x[b], dy = x[a + 1] - x[b + 1], dz = x[a + 2] - x[b + 2], len = Math.hypot(dx, dy, dz), w = give[c.a] + give[c.b]; if (len <= c.rest || !w) continue;
    const q = -(len - c.rest) / (w + c.alpha / (dt * dt)) / len, qa = q * give[c.a], qb = q * give[c.b];
    pulled[a] += dx * qa; pulled[a + 1] += dy * qa; pulled[a + 2] += dz * qa; pulled[b] -= dx * qb; pulled[b + 1] -= dy * qb; pulled[b + 2] -= dz * qb;
  }
  for (const i of state.pulls) for (let k = 0; k < 3; k++) { x[i * 3 + k] += pulled[i * 3 + k]; pulled[i * 3 + k] = 0; }
}
// Gathered cloth: free between the length the elastic gathers it to and its own, held at either end of that range.
function band(c, dt) {
  const { x, give: inv } = state, a = c.a * 3, b = c.b * 3, dx = x[a] - x[b], dy = x[a + 1] - x[b + 1], dz = x[a + 2] - x[b + 2], len = Math.hypot(dx, dy, dz), rest = len > c.rest ? c.rest : len < c.min ? c.min : len; if (rest === len || len < 1e-12) return;
  const w = inv[c.a] + inv[c.b]; if (!w) return; const q = -(len - rest) / (w + c.alpha / (dt * dt)) / len;
  x[a] += dx * q * inv[c.a]; x[a + 1] += dy * q * inv[c.a]; x[a + 2] += dz * q * inv[c.a]; x[b] -= dx * q * inv[c.b]; x[b + 1] -= dy * q * inv[c.b]; x[b + 2] -= dz * q * inv[c.b];
}
// A creased fold holds the angle between its two triangles: 0 flat, positive toward the face of the pattern. The angle's gradient
// is Bridson's (Simulation of Clothing with Folds and Wrinkles, 2003); it is well behaved at flat, where a fold starts.
// CREASE is the fold's stiffness, N·mm per radian per mm of fold. A fold closes over its first FOLDING steps, and never corrects
// more than TURN radians in a substep, so it turns the cloth and does not snap it.
// ponytail: one stiffness for every crease; make it a field of the annotation when a soft roll and a pressed crease must differ.
const CREASE = 1, TURN = 0.5;
export const FOLDING = 60;
function crease(c, dt) {
  const { x, give: inv } = state, [x1, x2, x3, x4] = c.i.map((i) => V(x, i)), N1 = cross3(sub3(x1, x3), sub3(x1, x4)), N2 = cross3(sub3(x2, x4), sub3(x2, x3)), E = sub3(x4, x3), e = Math.hypot(...E), a = dot3(N1, N1), b = dot3(N2, N2); if (e < 1e-9 || a < 1e-12 || b < 1e-12) return;
  const angle = Math.atan2(-dot3(cross3(N1, N2), E) / e, dot3(N1, N2)), p = dot3(sub3(x1, x4), E) / e / a, q = dot3(sub3(x2, x4), E) / e / b, r = -dot3(sub3(x1, x3), E) / e / a, s = -dot3(sub3(x2, x3), E) / e / b;
  const u = [N1.map((v) => v * e / a), N2.map((v) => v * e / b), N1.map((v, j) => v * p + N2[j] * q), N1.map((v, j) => v * r + N2[j] * s)]; let w = 0; for (let k = 0; k < 4; k++) w += inv[c.i[k]] * dot3(u[k], u[k]); if (!w) return;
  // How far off the fold is, the short way round: a fold near 180° that overshoots reads as nearly -180°, and must not be turned all the way back.
  const off = angle - c.rest * Math.min(1, (state.step + 1) / FOLDING), dl = -Math.max(-TURN, Math.min(TURN, off - 2 * Math.PI * Math.round(off / (2 * Math.PI)))) / (w + c.alpha / (dt * dt));
  for (let k = 0; k < 4; k++) for (let j = 0; j < 3; j++) x[c.i[k] * 3 + j] += inv[c.i[k]] * dl * u[k][j];
}
// Stuffing pushes every triangle of a group outward with its pressure (Pa) times its area. With a target volume the pressure
// falls as the group fills and is nothing once it holds that volume, as loose fill stops pushing when it has room.
const STUFFING = 200;
function inflate(dt) {
  const { x, inv, velocities: v } = state;
  for (const g of state.stuffed) {
    const t = g.tris, o = t[0] * 3; let volume = 0;
    for (let k = 0; k < t.length; k += 3) { const a = t[k] * 3, b = t[k + 1] * 3, c = t[k + 2] * 3, ax = x[a] - x[o], ay = x[a + 1] - x[o + 1], az = x[a + 2] - x[o + 2], bx = x[b] - x[o], by = x[b + 1] - x[o + 1], bz = x[b + 2] - x[o + 2], cx = x[c] - x[o], cy = x[c + 1] - x[o + 1], cz = x[c + 2] - x[o + 2]; volume += (ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx)) / 6; }
    g.volume = volume; g.now = g.target ? g.pressure * Math.max(0, Math.min(1, 1 - volume / g.target)) : g.pressure; const f = g.now / 6 * dt; if (!f) continue;
    for (let k = 0; k < t.length; k += 3) { const a = t[k] * 3, b = t[k + 1] * 3, c = t[k + 2] * 3, ux = x[b] - x[a], uy = x[b + 1] - x[a + 1], uz = x[b + 2] - x[a + 2], wx = x[c] - x[a], wy = x[c + 1] - x[a + 1], wz = x[c + 2] - x[a + 2], nx = (uy * wz - uz * wy) * f, ny = (uz * wx - ux * wz) * f, nz = (ux * wy - uy * wx) * f;
      for (const i of [t[k], t[k + 1], t[k + 2]]) { v[i * 3] += nx * inv[i]; v[i * 3 + 1] += ny * inv[i]; v[i * 3 + 2] += nz * inv[i]; } }
  }
}
// A frozen piece is put back where it was, whatever gravity, the body or another layer did to it this substep.
function hold() { const { x, prev, velocities: v } = state; for (const i of state.frozen) for (let k = 0; k < 3; k++) { x[i * 3 + k] = prev[i * 3 + k]; v[i * 3 + k] = 0; } }
// Layers. A vertex nearer to a triangle of the cloth than their thicknesses allow is put back on the side it was on a
// moment ago, and the triangle is pushed the other way. Not tested: a vertex against its own triangles, against cloth
// that is close to it in the flat pattern (its neighbours), or against the edge it is sewn to.
// ponytail: the side comes from the previous substep only, so cloth that starts interpenetrating, or crosses more than
// BAND in one substep, stays crossed; remember the side per pair if that shows.
const BAND = 6;
function collideSelf() {
  const { x, prev, inv, radius, tris, uvAll, pieceAt, excluded, total, cell, layerOf, face } = state, bins = new Map(), near = (2.5 * cell) ** 2;
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
      // Between layers the side is the design's, not the last substep's: the higher layer on the face side. So cloth that starts crossed, or crosses, is put right.
      const order = face ? Math.sign(layerOf[pieceAt[i]] - layerOf[pieceAt[a]]) * face[t / 3] : 0;
      if (!order && (!plane(prev, i * 3, a * 3, b * 3, c * 3, was) || Math.abs(was.d) < 1e-6)) continue;
      const side = order || Math.sign(was.d), gap = radius[i] + radius[a], lack = gap - side * now.d; if (lack <= 0) continue;
      const bw = [1 - now.s - now.t, now.s, now.t], w = inv[i] + bw[0] ** 2 * inv[a] + bw[1] ** 2 * inv[b] + bw[2] ** 2 * inv[c], f = side * lack / w; if (!w) continue;
      for (let j = 0; j < 3; j++) { x[i * 3 + j] += now.n[j] * f * inv[i]; x[a * 3 + j] -= now.n[j] * f * bw[0] * inv[a]; x[b * 3 + j] -= now.n[j] * f * bw[1] * inv[b]; x[c * 3 + j] -= now.n[j] * f * bw[2] * inv[c]; }
    }
  }
}
// The body is a few ellipsoids and capsules (src/core/softgoods-arrange.js avatarBody) standing on a floor at z = 0.
// A shape {type: 'mesh', positions, indices, clearance, friction} is a CAD part or a lofted torso (src/core/softgoods-bodies.js):
// the cloth keeps its clearance off the mesh's signed distance field (web/softgoods-sdf.js), built once per shape. A body that
// gives a friction uses it in place of the fabric's. floor moves the floor (mm), and floor: false takes it away.
const fields = new WeakMap(), fieldOf = (s, reach) => { let f = fields.get(s); if (!f || f.reach < reach) { f = meshField(s.positions, s.indices, { reach }); f.reach = reach; fields.set(s, f); } return f; };
// A vertex inside one is put back on its surface; how far it was pushed is the contact force, and cloth in contact drags.
// drag false: only put the cloth back outside, after the layers moved it (friction has had this substep's slide already).
function collideAvatar(drag = true) {
  const b = state.input.collisionBody; if (!b) return; const { x, prev, radius, push, friction } = state, floor = b.floor === false ? -Infinity : Number(b.floor ?? 0), out = [0, 0, 0], shapes = b.shapes || [], field = shapes.map((s) => (s.type === 'mesh' ? fieldOf(s, state.reach + Number(s.clearance ?? 0)) : null));
  for (let i = 0; i < state.inv.length; i++) {
    const p = [x[i * 3], x[i * 3 + 1], x[i * 3 + 2]]; let n = null, depth = 0, by = null, byDepth = 0;
    for (let k = 0; k < shapes.length; k++) {
      const s = shapes[k];
      if (field[k]) { const dist = radius[i] + Number(s.clearance ?? 0) - field[k].at(p[0], p[1], p[2], out); if (dist > depth) { depth = dist; n = [out[0], out[1], out[2]]; by = s; byDepth = dist; } continue; }
      if (s.type === 'ellipsoid') {
        const r = s.r.map((v) => v + radius[i]), d = [0, 1, 2].map((k) => (p[k] - s.c[k]) / r[k]), q = Math.hypot(...d); if (q >= 1 || q < 1e-9) continue;
        // Out along the surface normal at the point the centre ray meets: the gradient of the ellipsoid's own equation.
        const g = [0, 1, 2].map((k) => d[k] / r[k]), gl = Math.hypot(...g), dist = (1 - q) / gl * q; if (dist > depth) { depth = dist; n = g.map((v) => v / gl); }
      } else {
        const ab = [0, 1, 2].map((k) => s.b[k] - s.a[k]), t = Math.max(0, Math.min(1, [0, 1, 2].reduce((m, k) => m + (p[k] - s.a[k]) * ab[k], 0) / (ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2 || 1))), d = [0, 1, 2].map((k) => p[k] - s.a[k] - ab[k] * t), q = Math.hypot(...d), dist = s.r + radius[i] - q;
        if (dist > depth && q > 1e-9) { depth = dist; n = d.map((v) => v / q); }
      }
    }
    if (p[2] < floor + radius[i]) { x[i * 3 + 2] = floor + radius[i]; p[2] = floor + radius[i]; }
    if (!n) continue;
    for (let k = 0; k < 3; k++) x[i * 3 + k] = p[k] + n[k] * depth;
    push[i] += depth; if (!drag) continue;
    // Friction: of this step's slide along the surface, the contact holds back up to friction × the push.
    const d = [0, 1, 2].map((k) => x[i * 3 + k] - prev[i * 3 + k]), dn = d[0] * n[0] + d[1] * n[1] + d[2] * n[2], slide = d.map((v, k) => v - dn * n[k]), sl = Math.hypot(...slide);
    if (sl > 1e-9) { const hold = Math.min(1, (by && depth === byDepth && by.friction != null ? by.friction : friction[i]) * depth / sl); for (let k = 0; k < 3; k++) x[i * 3 + k] -= slide[k] * hold; }
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
  // A creased hinge bends about its fold angle, not about flat: the energy is ½k|Σ Kᵢxᵢ − rest · n|² with n the hinge's own normal as
  // it is now, which adds a force k Kᵢ rest n and leaves the matrix alone. So a stiff fabric carries its fold out along the whole piece.
  const g = B.force; if (g) { g.fill(0); const ease = Math.min(1, (state.step + 1) / FOLDING);
    for (const f of B.folded) { const [x1, x2, x3, x4] = f.i.map((i) => V(x, i)), N1 = cross3(sub3(x1, x3), sub3(x1, x4)), N2 = cross3(sub3(x2, x4), sub3(x2, x3)), a = Math.hypot(...N1) || 1, b = Math.hypot(...N2) || 1, m = [0, 1, 2].map((j) => N1[j] / a + N2[j] / b), s = f.k * f.rest * ease / (Math.hypot(...m) || 1); for (let q = 0; q < 4; q++) for (let j = 0; j < 3; j++) g[f.ids[q] * 3 + j] += s * f.K[q] * m[j]; } }
  const y = new Float64Array(n), r = new Float64Array(n), z = new Float64Array(n), p = new Float64Array(n), Ap = new Float64Array(n), dv = new Float64Array(n);
  for (let axis = 0; axis < 3; axis++) {
    for (let i = 0; i < n; i++) y[i] = x[i * 3 + axis] + dt * v[i * 3 + axis];
    Q(y, r); if (g) for (let i = 0; i < n; i++) r[i] -= g[i * 3 + axis]; let rz = 0, r0 = 0; for (let i = 0; i < n; i++) { r[i] *= -dt; dv[i] = 0; z[i] = r[i] / diag[i]; p[i] = z[i]; rz += r[i] * z[i]; r0 += r[i] * r[i]; }
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
// Stuffing pushes a few hundred times harder than gravity, and one pass a substep then leaves the cloth stretched: a stuffed
// design takes more, shorter substeps (the stretch left over goes as pressure × dt²): at least twice as many, which is what
// keeps its seams shut against the pressure, and up to MAX_SUBSTEPS.
// ponytail: above about 400 Pa the cap is reached and the cloth reads stretched; a harder inflatable needs a solver that iterates.
const SUBSTEPS = 8, MAX_SUBSTEPS = 32, substepsFor = (stuffed) => stuffed.length ? Math.min(MAX_SUBSTEPS, Math.max(2 * SUBSTEPS, Math.ceil(SUBSTEPS * Math.sqrt(Math.max(0, ...stuffed.map((g) => g.pressure)) / 25)))) : SUBSTEPS;
function tick() {
  if (!state?.running) return; const began = performance.now(), n = state.substeps, dt = 1 / 120 / n, { x, prev, velocities: v, push, contact } = state; contact.fill(0); bendKick(1 / 120);
  for (let sub = 0; sub < n; sub++) {
    prev.set(x); push.fill(0); if (state.stuffed.length) inflate(dt);
    for (let i = 0; i < state.inv.length; i++) { const damp=1-Math.max(0,Math.min(1,Number(state.materialAt?.[i]?.damping??.005)))/n;v[i * 3] *= damp; v[i * 3 + 1] *= damp; v[i * 3 + 2] = (v[i * 3 + 2] - 9810 * dt) * damp; const speed = Math.hypot(v[i * 3], v[i * 3 + 1], v[i * 3 + 2]), cap = speed > MAX_SPEED ? MAX_SPEED / speed : 1; v[i * 3] *= cap; v[i * 3 + 1] *= cap; v[i * 3 + 2] *= cap; x[i * 3] += v[i * 3] * dt; x[i * 3 + 1] += v[i * 3 + 1] * dt; x[i * 3 + 2] += v[i * 3 + 2] * dt; }
    if (state.frozen.length) hold();
    // Soft before stiff: the elastics pull, then the gathered cloth and the creases answer, and the list below ends with the pins and seams, which have the last word.
    if (state.springs.length) pull(dt); for (const c of state.gathered) band(c, dt); for (const c of state.creases) crease(c, dt);
    for (const c of state.constraints) { c.lambda = 0; project(c, dt); }
    collideAvatar(); if (sub % 2) { collideSelf(); collideAvatar(false); } if (state.frozen.length) hold();
    // Contact force per area in Pa: what pushed the vertex out (mass × push / dt²) over the vertex's own area.
    for (let i = 0; i < state.inv.length; i++) { v[i * 3] = (x[i * 3] - prev[i * 3]) / dt; v[i * 3 + 1] = (x[i * 3 + 1] - prev[i * 3 + 1]) / dt; v[i * 3 + 2] = (x[i * 3 + 2] - prev[i * 3 + 2]) / dt; contact[i] += state.density[i] * 1e-6 * push[i] / (dt * dt) / n; }
  }
  for (let i = 0; i < state.inv.length; i++) state.pressure[i] += 0.1 * (contact[i] - state.pressure[i]);
  state.step++; state.ms = (state.ms ?? 0) + 0.1 * (performance.now() - began - (state.ms ?? 0)); if (state.step % 2 === 0 && typeof postMessage === 'function') send();
}
/** The solver without a page: initialise, advance, return the frame. Tests and scripts call this. */
export function simulate(input, steps = 0) { initialize(input); state.running = true; for (let i = 0; i < steps; i++) tick(); state.running = false; return snapshot(); }
/** Carry on from where simulate (or an earlier advance) left the cloth: src/core/softgoods-drape.js steps until it settles. */
export function advance(steps = 1) { state.running = true; for (let i = 0; i < steps; i++) tick(); state.running = false; return snapshot(); }
function send() { const m = snapshot(); postMessage(m, [m.positions.buffer, m.strain.buffer, m.pressure.buffer]); }
function snapshot() {
  const positions = Float32Array.from(state.x), strain = new Float32Array(state.inv.length), pressure = Float32Array.from(state.pressure), count = new Uint16Array(state.inv.length);
  for (const c of state.constraints) {
    if (c.kind !== 'fabric' || c.target || !(c.rest > 0)) continue;
    const a = V(state.x, c.a), b = V(state.x, c.b), e = (Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) - c.rest) / c.rest;
    strain[c.a] += e; strain[c.b] += e; count[c.a]++; count[c.b]++;
  }
  // Gathered cloth reads as strained only once it is pulled past its own length.
  for (const c of state.gathered) { const a = V(state.x, c.a), b = V(state.x, c.b), e = Math.max(0, (Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) - c.rest) / c.rest); strain[c.a] += e; strain[c.b] += e; count[c.a]++; count[c.b]++; }
  let minStrain = Infinity, maxStrain = -Infinity, maxPressure = 0;
  for (let i = 0; i < strain.length; i++) { strain[i] = count[i] ? strain[i] / count[i] : 0; minStrain = Math.min(minStrain, strain[i]); maxStrain = Math.max(maxStrain, strain[i]); maxPressure=Math.max(maxPressure,pressure[i]); }
  return { type: 'frame', step: state.step, ms: state.ms ?? 0, body: (state.input.collisionBody?.shapes || []).map((s) => (s.type === 'mesh' ? { type: s.type, name: s.name, id: s.id } : s)), collision: state.collision, diagnostics: { strain: { unit: 'ratio', min: minStrain, max: maxStrain }, pressure: { available: state.pressureAvailable, unit: 'Pa', min: 0, max: maxPressure, reason: state.pressureAvailable ? null : 'No collision body is present in this preview' } }, ...(state.stuffed.length ? { stuffing: state.stuffed.map((g) => ({ id: g.id, volume: g.volume / 1e6, pressure: g.now })) } : {}), positions, strain, pressure, pieces: state.pieces.map((p) => ({ id: p.id, off: p.off, count: p.uv.length / 2, triangles: p.triangles })) };
}
globalThis.onmessage = (e) => { const m = e.data; if (m.type === 'init') { initialize(m.input); send(); } else if (m.type === 'run') { state.running = true; clearInterval(timer); timer = setInterval(tick, 1000 / 60); } else if (m.type === 'pause') state.running = false; else if (m.type === 'reset') { initialize(state.input); send(); } };
