// Boundary-conforming simulation meshes generated from authoritative patterns.
// Curves and straight segments are sampled into stable boundary chains, Earcut
// triangulates one outer contour plus holes, then long triangles are refined.

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
  return { vertices, segmentVertices, holes };
}

/** Refine every triangle into four until no edge exceeds target. */
function refine(vertices, triangles, target, maxPasses = 6) {
  for (let pass = 0; pass < maxPasses; pass++) {
    let long = false; const mids = new Map(), out = [];
    const mid = (a, b) => { const key = a < b ? `${a}/${b}` : `${b}/${a}`; if (mids.has(key)) return mids.get(key); const p = [(vertices[a][0] + vertices[b][0]) / 2, (vertices[a][1] + vertices[b][1]) / 2], i = vertices.push(p) - 1; mids.set(key, i); return i; };
    for (let i = 0; i < triangles.length; i += 3) {
      const a = triangles[i], b = triangles[i + 1], c = triangles[i + 2], d = (i, j) => Math.hypot(vertices[i][0] - vertices[j][0], vertices[i][1] - vertices[j][1]);
      if (Math.max(d(a, b), d(b, c), d(c, a)) <= target) { out.push(a, b, c); continue; }
      long = true; const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a); out.push(a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca);
    }
    triangles = out; if (!long) break;
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

export function meshPattern(pattern, { target = 25, curveStep = target } = {}) {
  if (!(target > 0 && curveStep > 0)) throw new GraphError('Simulation mesh spacing must be positive');
  const { vertices, segmentVertices: coarse, holes } = boundariesOf(pattern, curveStep);
  const flat = vertices.flat(), initial = earcut(flat, holes, 2);
  if (!initial.length) throw new GraphError(`Pattern '${pattern.id}' contour could not be triangulated (it may cross itself or contain a hole outside its outer contour)`);
  const triangles = refine(vertices, initial, target), segmentVertices = chainsOf(vertices, coarse), boundaryCount = new Set(Object.values(segmentVertices).flat()).size;
  const edges = new Map();
  for (let i = 0; i < triangles.length; i += 3) for (const [a, b] of [[triangles[i], triangles[i + 1]], [triangles[i + 1], triangles[i + 2]], [triangles[i + 2], triangles[i]]]) { const k = a < b ? `${a}/${b}` : `${b}/${a}`; edges.set(k, [a, b]); }
  return { id: pattern.id, uv: vertices.flat(), triangles, edges: [...edges.values()].flat(), boundaryCount, segmentVertices, holes: holes.length };
}
