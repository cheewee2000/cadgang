// Boundary-conforming simulation meshes generated from authoritative patterns.
// Curves and straight segments are sampled into stable boundary chains. Earcut
// triangulates one outer contour plus holes; every boundary sample it skipped (it
// drops collinear points) and a triangular lattice of interior points are then
// inserted, and edge flips make the result Delaunay without ever crossing a
// boundary. The cloth solver gets near-equilateral triangles at the target size.
// Lines drawn inside a pattern that the cloth must bend or gather along (a creased
// fold, an elastic) are given as `lines`: the mesh then has an unbroken run of edges on each.

import earcut from 'earcut';
import { GraphError } from './errors.js';
import { sampleSegment } from './softgoods-export.js';

function contourOf(pattern, contour, curveStep) {
  const vertices = [], segmentVertices = {}, ranges = [];
  for (const id of contour) {
    const s = pattern.segments.find((q) => q.id === id); if (!s) throw new GraphError(`Pattern '${pattern.id}' is missing segment '${id}'`);
    const rough = sampleSegment(pattern, s, 32), length = rough.reduce((n, p, i) => i ? n + Math.hypot(p[0] - rough[i - 1][0], p[1] - rough[i - 1][1]) : 0, 0), steps = Math.max(1, Math.ceil(length / curveStep));
    let q = sampleSegment(pattern, s, steps), start = vertices.length;
    if (s.type === 'line') q = Array.from({ length: steps + 1 }, (_, i) => [q[0][0] + (q[1][0] - q[0][0]) * i / steps, q[0][1] + (q[1][1] - q[0][1]) * i / steps]);
    for (let i = 0; i < q.length - 1; i++) { const last = vertices.at(-1); if (!last || Math.hypot(last[0] - q[i][0], last[1] - q[i][1]) > 1e-8) vertices.push(q[i]); }
    ranges.push({ id, start, count: vertices.length - start });
  }
  for (const r of ranges) segmentVertices[r.id] = [...Array(r.count).keys()].map((i) => r.start + i).concat((r.start + r.count) % vertices.length);
  let area = 0; for (let i = 0; i < vertices.length; i++) { const a = vertices[i], b = vertices[(i + 1) % vertices.length]; area += a[0] * b[1] - b[0] * a[1]; }
  if (Math.abs(area) < 1e-7) throw new GraphError(`Pattern '${pattern.id}' has a collapsed contour`);
  return { vertices, segmentVertices, area: area / 2 };
}

function boundariesOf(pattern, curveStep) {
  if (!pattern.contours.length) throw new GraphError(`Pattern '${pattern.id}' has no contour`);
  const loops = pattern.contours.map((c) => contourOf(pattern, c, curveStep));
  // The material outer boundary is the largest absolute area; every other contour is a hole.
  loops.sort((a, b) => Math.abs(b.area) - Math.abs(a.area));
  const vertices = [], segmentVertices = {}, holes = [];
  for (let n = 0; n < loops.length; n++) {
    const loop = loops[n], offset = vertices.length;
    if (n) holes.push(offset);
    vertices.push(...loop.vertices);
    for (const [id, chain] of Object.entries(loop.segmentVertices)) segmentVertices[id] = chain.map((i) => i + offset);
  }
  return { vertices, segmentVertices, holes, loops: loops.map((l) => l.vertices) };
}

export const insideLoop = (loop, p) => { let c = false; for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) { const a = loop[i], b = loop[j]; if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) c = !c; } return c; };
export const segmentDistance = (p, a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1))); return Math.hypot(a[0] + dx * t - p[0], a[1] + dy * t - p[1]); };

/** Interior points on a triangular lattice of pitch h, inside the material and clear of every boundary. */
function lattice(loops, h, lines = []) {
  const xs = loops[0].map((p) => p[0]), ys = loops[0].map((p) => p[1]), minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys), out = [];
  // Centred on the bounding box, so a symmetric pattern gets a symmetric mesh.
  const rows = Math.max(1, Math.round((maxY - minY) / (h * 0.866))), dy = (maxY - minY) / rows, cols = Math.max(1, Math.round((maxX - minX) / h)), dx = (maxX - minX) / cols;
  for (let j = 1; j < rows; j++) for (let i = 0; i <= cols; i++) {
    const p = [minX + (i + (j % 2 ? 0.5 : 0)) * dx, minY + j * dy];
    if (!insideLoop(loops[0], p) || loops.slice(1).some((l) => insideLoop(l, p))) continue;
    if (loops.some((l) => l.some((a, k) => segmentDistance(p, a, l[(k + 1) % l.length]) < 0.5 * Math.min(dx, dy)))) continue;
    if (lines.some(([a, b]) => segmentDistance(p, a, b) < 0.5 * Math.min(dx, dy))) continue;
    out.push(p);
  }
  return out;
}

/** Put vertex p into the triangulation: split the triangle it is in, or the edge it is on together with that edge's other triangle. */
function insertVertex(vertices, triangles, p) {
  const P = vertices[p];
  for (let t = 0; t < triangles.length; t += 3) {
    const v = [triangles[t], triangles[t + 1], triangles[t + 2]], V = v.map((i) => vertices[i]);
    const turn = Math.sign((V[1][0] - V[0][0]) * (V[2][1] - V[0][1]) - (V[1][1] - V[0][1]) * (V[2][0] - V[0][0]));
    if (!turn) continue;
    // How far P is inside each edge, in mm.
    const d = [0, 1, 2].map((k) => { const A = V[k], B = V[(k + 1) % 3]; return turn * ((B[0] - A[0]) * (P[1] - A[1]) - (B[1] - A[1]) * (P[0] - A[0])) / Math.hypot(B[0] - A[0], B[1] - A[1]); });
    if (Math.min(...d) < -1e-7) continue;
    const k = d.findIndex((x) => x < 1e-7);
    if (k < 0) { triangles.splice(t, 3, v[0], v[1], p, v[1], v[2], p, v[2], v[0], p); return; }
    const a = v[k], b = v[(k + 1) % 3], c = v[(k + 2) % 3];
    triangles.splice(t, 3, a, p, c, p, b, c);
    for (let u = 0; u < triangles.length; u += 3) for (let j = 0; j < 3; j++) if (triangles[u + j] === b && triangles[u + (j + 1) % 3] === a) { const e = triangles[u + (j + 2) % 3]; triangles.splice(u, 3, b, p, e, p, a, e); return; }
    return;
  }
  throw new GraphError('A simulation mesh point fell outside its pattern');
}

/** Lawson flips: swap the diagonal of every pair of triangles that fails the empty-circle test. Boundary edges have one triangle and stay. */
function flipToDelaunay(vertices, triangles, maxPasses = 2000) {
  for (let pass = 0; pass < maxPasses; pass++) {
    const directed = new Map();
    for (let t = 0; t < triangles.length; t += 3) for (let k = 0; k < 3; k++) directed.set(`${triangles[t + k]}/${triangles[t + (k + 1) % 3]}`, [t, triangles[t + (k + 2) % 3]]);
    const done = new Set(); let flips = 0;
    for (const [key, [t, c]] of directed) {
      const [a, b] = key.split('/').map(Number); if (a > b) continue;
      const twin = directed.get(`${b}/${a}`); if (!twin || done.has(t) || done.has(twin[0])) continue;
      const d = twin[1], A = vertices[a], B = vertices[b], C = vertices[c], D = vertices[d];
      const ax = A[0] - D[0], ay = A[1] - D[1], bx = B[0] - D[0], by = B[1] - D[1], cx = C[0] - D[0], cy = C[1] - D[1];
      const turn = (B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0]), inCircle = (ax * ax + ay * ay) * (bx * cy - cx * by) - (bx * bx + by * by) * (ax * cy - cx * ay) + (cx * cx + cy * cy) * (ax * by - bx * ay);
      // The new diagonal c-d must cross a-b, or the flip would fold the quad over.
      const side = (P, Q, R) => (Q[0] - P[0]) * (R[1] - P[1]) - (Q[1] - P[1]) * (R[0] - P[0]);
      if (!(inCircle * Math.sign(turn) > 1e-9 * turn * turn) || !(side(C, D, A) * side(C, D, B) < 0)) continue;
      triangles[t] = a; triangles[t + 1] = d; triangles[t + 2] = c; triangles[twin[0]] = d; triangles[twin[0] + 1] = b; triangles[twin[0] + 2] = c;
      done.add(t); done.add(twin[0]); flips++;
    }
    if (!flips) break;
  }
  return triangles;
}

/** Halve the longest over-length edge, and both triangles on it, until no edge exceeds target.
 *  Splitting the longest edge first keeps the triangles near target size and near equilateral;
 *  splitting every triangle in four turned earcut's long fans into slivers twenty times too dense. */
function refine(vertices, triangles, target, maxPasses = 200) {
  const len = (a, b) => Math.hypot(vertices[a][0] - vertices[b][0], vertices[a][1] - vertices[b][1]);
  for (let pass = 0; pass < maxPasses; pass++) {
    const edges = new Map();
    for (let t = 0; t < triangles.length; t += 3) for (let k = 0; k < 3; k++) {
      const a = triangles[t + k], b = triangles[t + (k + 1) % 3], key = a < b ? `${a}/${b}` : `${b}/${a}`;
      if (!edges.has(key)) edges.set(key, { a, b, l: len(a, b), tris: [] });
      edges.get(key).tris.push(t);
    }
    const long = [...edges.values()].filter((e) => e.l > target).sort((p, q) => q.l - p.l || p.a - q.a || p.b - q.b);
    if (!long.length) break;
    const done = new Set(), out = [];
    for (const e of long) {
      if (e.tris.some((t) => done.has(t))) continue;
      const m = vertices.push([(vertices[e.a][0] + vertices[e.b][0]) / 2, (vertices[e.a][1] + vertices[e.b][1]) / 2]) - 1;
      for (const t of e.tris) { done.add(t); const tri = [triangles[t], triangles[t + 1], triangles[t + 2]]; out.push(...tri.map((v) => (v === e.b ? m : v)), ...tri.map((v) => (v === e.a ? m : v))); }
    }
    for (let t = 0; t < triangles.length; t += 3) if (!done.has(t)) out.push(triangles[t], triangles[t + 1], triangles[t + 2]);
    triangles = out;
  }
  return triangles;
}
function paramOn(poly, p) {
  for (let k = 1; k < poly.length; k++) { const a = poly[k - 1], b = poly[k], dx = b[0] - a[0], dy = b[1] - a[1], t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1); if (t >= -1e-9 && t <= 1 + 1e-9 && Math.hypot(a[0] + dx * t - p[0], a[1] + dy * t - p[1]) < 1e-6) return k - 1 + t; }
  return null;
}
function chainsOf(vertices, segmentVertices) {
  const out = {};
  for (const [id, chain] of Object.entries(segmentVertices)) { const poly = chain.map((i) => vertices[i]), hits = []; for (let v = 0; v < vertices.length; v++) { const t = paramOn(poly, vertices[v]); if (t != null) hits.push([t, v]); } out[id] = hits.sort((a, b) => a[0] - b[0]).map((h) => h[1]); }
  return out;
}

/** Until every line is an unbroken run of edges, halve the stretches of it that are not and restore Delaunay (a conforming Delaunay mesh). */
function conform(vertices, triangles, ends) {
  if (!ends.length) return { triangles, chains: [] };
  for (let pass = 0; pass < 16; pass++) {
    const edges = new Set(), chains = Object.values(chainsOf(vertices, ends)), missing = [];
    for (let t = 0; t < triangles.length; t += 3) for (let k = 0; k < 3; k++) edges.add(`${triangles[t + k]}/${triangles[t + (k + 1) % 3]}`);
    for (const c of chains) for (let k = 1; k < c.length; k++) if (!edges.has(`${c[k - 1]}/${c[k]}`) && !edges.has(`${c[k]}/${c[k - 1]}`)) missing.push([(vertices[c[k - 1]][0] + vertices[c[k]][0]) / 2, (vertices[c[k - 1]][1] + vertices[c[k]][1]) / 2]);
    if (!missing.length) return { triangles, chains };
    for (const m of missing) insertVertex(vertices, triangles, vertices.push(m) - 1);
    triangles = flipToDelaunay(vertices, triangles);
  }
  throw new GraphError('A simulation mesh could not follow a fold or elastic line');
}

export function meshPattern(pattern, { target = 25, curveStep = target, lines = [] } = {}) {
  if (!(target > 0 && curveStep > 0)) throw new GraphError('Simulation mesh spacing must be positive');
  const { vertices, segmentVertices: coarse, holes, loops } = boundariesOf(pattern, curveStep);
  const boundary = vertices.length, initial = earcut(vertices.flat(), holes, 2);
  if (!initial.length) throw new GraphError(`Pattern '${pattern.id}' contour could not be triangulated (it may cross itself or contain a hole outside its outer contour)`);
  const used = new Set(initial);
  for (let i = 0; i < boundary; i++) if (!used.has(i)) insertVertex(vertices, initial, i);
  // Each line is sampled at the target size; a sample that falls on a vertex already there (a corner, a boundary sample) is that vertex.
  const ends = lines.map(([a, b]) => { const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / target)), ids = []; for (let i = 0; i <= n; i++) { const q = [a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n]; let v = vertices.findIndex((w) => Math.hypot(w[0] - q[0], w[1] - q[1]) < 1e-6); if (v < 0) { v = vertices.push(q) - 1; try { insertVertex(vertices, initial, v); } catch { throw new GraphError(`Pattern '${pattern.id}' has a fold or elastic line that leaves its outline`); } } ids.push(v); } return [ids[0], ids.at(-1)]; });
  for (const p of lattice(loops, target * 0.9, lines)) insertVertex(vertices, initial, vertices.push(p) - 1);
  const conformed = conform(vertices, flipToDelaunay(vertices, refine(vertices, flipToDelaunay(vertices, initial), target)), ends), triangles = conformed.triangles, segmentVertices = chainsOf(vertices, coarse), boundaryCount = new Set(Object.values(segmentVertices).flat()).size;
  const edges = new Map();
  for (let i = 0; i < triangles.length; i += 3) for (const [a, b] of [[triangles[i], triangles[i + 1]], [triangles[i + 1], triangles[i + 2]], [triangles[i + 2], triangles[i]]]) { const k = a < b ? `${a}/${b}` : `${b}/${a}`; edges.set(k, [a, b]); }
  return { id: pattern.id, uv: vertices.flat(), triangles, edges: [...edges.values()].flat(), boundaryCount, segmentVertices, holes: holes.length, ...(lines.length ? { lineVertices: conformed.chains } : {}) };
}
