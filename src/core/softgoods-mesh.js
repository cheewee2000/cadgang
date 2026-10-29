// Boundary-conforming simulation meshes generated from authoritative patterns.
// This first mesher supports one outer contour (holes are rejected explicitly),
// samples curves, ear-clips the boundary, then uniformly refines long triangles.

import { GraphError } from './errors.js';
import { sampleSegment } from './softgoods-export.js';

const area2 = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
const insideTri = (p, a, b, c) => { const x = area2(a, b, p), y = area2(b, c, p), z = area2(c, a, p); return x >= -1e-9 && y >= -1e-9 && z >= -1e-9; };

function boundaryOf(pattern, curveStep) {
  if (pattern.contours.length !== 1) throw new GraphError(`Pattern '${pattern.id}' simulation currently supports one outer contour and no holes`);
  const vertices = [], segmentVertices = {}, ranges = [];
  for (const id of pattern.contours[0]) {
    const s = pattern.segments.find((q) => q.id === id); if (!s) throw new GraphError(`Pattern '${pattern.id}' is missing segment '${id}'`);
    const lengthGuess = sampleSegment(pattern, s, 32).reduce((n, p, i, q) => i ? n + Math.hypot(p[0] - q[i - 1][0], p[1] - q[i - 1][1]) : 0, 0);
    const n = Math.max(1, Math.ceil(lengthGuess / curveStep)); let q = sampleSegment(pattern, s, n); const start = vertices.length;
    // sampleSegment leaves a line as its two ends; the mesh wants it at curveStep like the curves so seams pin the whole edge.
    if (s.type === 'line') q = Array.from({ length: n + 1 }, (_, i) => [q[0][0] + (q[1][0] - q[0][0]) * i / n, q[0][1] + (q[1][1] - q[0][1]) * i / n]);
    for (let i = 0; i < q.length - 1; i++) { const last = vertices.at(-1); if (!last || Math.hypot(last[0] - q[i][0], last[1] - q[i][1]) > 1e-8) vertices.push(q[i]); }
    ranges.push({ id, start, count: vertices.length - start });
  }
  for (const r of ranges) segmentVertices[r.id] = [...Array(r.count).keys()].map((i) => r.start + i).concat((r.start + r.count) % vertices.length);
  let sum = 0; for (let i = 0; i < vertices.length; i++) { const a = vertices[i], b = vertices[(i + 1) % vertices.length]; sum += a[0] * b[1] - b[0] * a[1]; }
  if (sum < 0) { vertices.reverse(); for (const k of Object.keys(segmentVertices)) segmentVertices[k] = segmentVertices[k].map((i) => vertices.length - 1 - i).reverse(); }
  return { vertices, segmentVertices };
}

function earClip(vertices) {
  const ring = vertices.map((_, i) => i), triangles = [];
  for (let guard = 0; ring.length > 3 && guard < vertices.length ** 2; guard++) {
    let cut = false;
    for (let k = 0; k < ring.length; k++) {
      const a = ring[(k + ring.length - 1) % ring.length], b = ring[k], c = ring[(k + 1) % ring.length];
      if (area2(vertices[a], vertices[b], vertices[c]) <= 1e-9) continue;
      if (ring.some((i) => i !== a && i !== b && i !== c && insideTri(vertices[i], vertices[a], vertices[b], vertices[c]))) continue;
      triangles.push(a, b, c); ring.splice(k, 1); cut = true; break;
    }
    if (!cut) throw new GraphError('Pattern contour could not be triangulated (it may cross itself or contain duplicate edges)');
  }
  if (ring.length === 3) triangles.push(...ring);
  return triangles;
}

/** Refine every triangle into four until no edge exceeds target, retaining a conforming midpoint map. */
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

/** Where p sits along the polyline (piece index + fraction), or null when it is not on it. */
function paramOn(poly, p) {
  for (let k = 1; k < poly.length; k++) {
    const a = poly[k - 1], b = poly[k], dx = b[0] - a[0], dy = b[1] - a[1], t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1);
    if (t >= -1e-9 && t <= 1 + 1e-9 && Math.hypot(a[0] + dx * t - p[0], a[1] + dy * t - p[1]) < 1e-6) return k - 1 + t;
  }
  return null;
}
/** Refinement splits boundary edges too: rebuild each segment's chain from every vertex that now lies on it, in order. */
function chainsOf(vertices, segmentVertices) {
  const out = {};
  for (const [id, chain] of Object.entries(segmentVertices)) {
    const poly = chain.map((i) => vertices[i]), hits = [];
    for (let v = 0; v < vertices.length; v++) { const t = paramOn(poly, vertices[v]); if (t != null) hits.push([t, v]); }
    out[id] = hits.sort((a, b) => a[0] - b[0]).map((h) => h[1]);
  }
  return out;
}

export function meshPattern(pattern, { target = 25, curveStep = target } = {}) {
  if (!(target > 0 && curveStep > 0)) throw new GraphError('Simulation mesh spacing must be positive');
  const { vertices, segmentVertices: coarse } = boundaryOf(pattern, curveStep);
  if (vertices.length < 3) throw new GraphError(`Pattern '${pattern.id}' has no usable boundary`);
  const triangles = refine(vertices, earClip(vertices), target), segmentVertices = chainsOf(vertices, coarse), boundaryCount = new Set(Object.values(segmentVertices).flat()).size;
  const edges = new Map();
  for (let i = 0; i < triangles.length; i += 3) for (const [a, b] of [[triangles[i], triangles[i + 1]], [triangles[i + 1], triangles[i + 2]], [triangles[i + 2], triangles[i]]]) { const k = a < b ? `${a}/${b}` : `${b}/${a}`; edges.set(k, [a, b]); }
  return { id: pattern.id, uv: vertices.flat(), triangles, edges: [...edges.values()].flat(), boundaryCount, segmentVertices };
}
