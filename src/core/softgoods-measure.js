// Measurements on a draped garment (src/core/softgoods-drape.js), and the fit report made from them.
// Everything is in the solver's units and frame: mm, z up, the body standing on z = 0 about the z axis.

import { GraphError } from './errors.js';
import { segmentLength } from './softgoods-export.js';
import { resolveSeamCorrespondence, seamSide } from './softgoods-seams.js';
import { resolveMaterials } from './softgoods-fabrics.js';

const round = (v, d = 2) => (Number.isFinite(v) ? +v.toFixed(d) : null);
const pieceOf = (drape, id) => { const p = drape.pieces.find((q) => q.id === id); if (!p) throw new GraphError(`The drape has no piece '${id}'`); return p; };
const at = (p, i) => [p.positions[i * 3], p.positions[i * 3 + 1], p.positions[i * 3 + 2]];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** A pattern point given as {pattern, point: id} or {pattern, at: [x, y]}: its pattern coordinate. */
function patternPoint(document, ref) {
  const pattern = document.patterns.find((p) => p.id === ref?.pattern); if (!pattern) throw new GraphError(`No pattern '${ref?.pattern}'`);
  if (Array.isArray(ref.at) && ref.at.length === 2 && ref.at.every(Number.isFinite)) return ref.at;
  const q = pattern.points.find((p) => p.id === ref.point); if (!q) throw new GraphError(`No point '${ref.pattern}.${ref.point}'`);
  return [q.x, q.y];
}

/** The triangle of a piece that holds pattern coordinate uv (the nearest one, if uv is off the piece) and the weights of its corners. */
function locate(piece, uv) {
  let best = null;
  for (let t = 0; t < piece.triangles.length; t += 3) {
    const [a, b, c] = [0, 1, 2].map((k) => piece.triangles[t + k]), ax = piece.uv[a * 2], ay = piece.uv[a * 2 + 1], ux = piece.uv[b * 2] - ax, uy = piece.uv[b * 2 + 1] - ay, vx = piece.uv[c * 2] - ax, vy = piece.uv[c * 2 + 1] - ay, den = ux * vy - uy * vx; if (!den) continue;
    const s = ((uv[0] - ax) * vy - (uv[1] - ay) * vx) / den, r = (ux * (uv[1] - ay) - uy * (uv[0] - ax)) / den, inside = Math.min(1 - s - r, s, r);
    if (!best || inside > best.inside) best = { t, inside, w: [1 - s - r, s, r] };
    if (inside >= 0) break;
  }
  const w = best.w.map((x) => Math.max(0, x)), sum = w[0] + w[1] + w[2];
  return { t: best.t, ids: [0, 1, 2].map((k) => piece.triangles[best.t + k]), w: w.map((x) => x / sum) };
}

// Distance along the cloth. A path may bend where it crosses a mesh edge and nowhere else, so the search runs over
// points on the edges: PER_EDGE of them on every edge to find which edges the shortest path crosses, and then each
// crossing slides along its edge to where the path is straight across the two triangles unfolded flat. A seam is
// crossed at matched points of its two sides, SEAM_STEPS of them to a mesh edge, which do not slide.
// ponytail: the path stays in the run of edges the search chose, which on flat cloth reads up to 0.15% long. Flip the
// run at clamped crossings if a measurement ever needs better.
const PER_EDGE = 5, SEAM_STEPS = 10;
export function geodesic(document, drape, a, b) {
  const nodes = [], groups = [], member = [], links = new Map(), edgeNodes = new Map(), triGroup = new Map();
  const node = (piece, i, j, t, fixed) => { nodes.push({ piece, i, j, t, fixed }); member.push([]); return nodes.length - 1; };
  const where = (n) => (n.w ? n.ids.reduce((q, id, k) => { const p = at(n.piece, id); return [q[0] + p[0] * n.w[k], q[1] + p[1] * n.w[k], q[2] + p[2] * n.w[k]]; }, [0, 0, 0]) : mix(at(n.piece, n.i), at(n.piece, n.j), n.t));
  const join = (g, n) => { groups[g].push(n); member[n].push(g); };
  const edgeKey = (piece, i, j) => `${piece.id}:${Math.min(i, j)}/${Math.max(i, j)}`;
  for (const piece of drape.pieces) for (let t = 0; t < piece.triangles.length; t += 3) {
    const g = groups.push([]) - 1; triGroup.set(`${piece.id}:${t}`, g);
    for (let k = 0; k < 3; k++) {
      const i = piece.triangles[t + k], j = piece.triangles[t + (k + 1) % 3], key = edgeKey(piece, i, j);
      if (!edgeNodes.has(key)) edgeNodes.set(key, { on: Array.from({ length: PER_EDGE }, (_, s) => node(piece, Math.min(i, j), Math.max(i, j), (s + 0.5) / PER_EDGE, false)), groups: [] });
      const e = edgeNodes.get(key); e.groups.push(g); for (const n of e.on) join(g, n);
    }
  }
  for (const seam of resolveSeamCorrespondence(document.seams || [], drape.pieces, { spacing: drape.options.target / SEAM_STEPS })) {
    const A = pieceOf(drape, seam.a.pattern), B = pieceOf(drape, seam.b.pattern);
    for (const pair of seam.pairs || []) {
      const [na, nb] = [[A, pair.a], [B, pair.b]].map(([piece, side]) => { const [i, j] = side.vertices, e = edgeNodes.get(edgeKey(piece, i, j)); if (!e) return null; const n = node(piece, i, j, side.weights[1], true); for (const g of e.groups) join(g, n); return n; });
      if (na == null || nb == null) continue;
      links.set(na, [...(links.get(na) || []), nb]); links.set(nb, [...(links.get(nb) || []), na]);
    }
  }
  const ends = [a, b].map((ref) => { const piece = pieceOf(drape, ref.pattern), uv = patternPoint(document, ref), hit = locate(piece, uv), n = node(piece, 0, 0, 0, true); Object.assign(nodes[n], { ids: hit.ids, w: hit.w }); join(triGroup.get(`${piece.id}:${hit.t}`), n); return { n, piece, uv }; });
  const P = nodes.map(where), best = new Float64Array(nodes.length).fill(Infinity), from = new Int32Array(nodes.length).fill(-1), heap = [[0, ends[0].n]];
  const push = (item) => { let i = heap.push(item) - 1; while (i) { const up = (i - 1) >> 1; if (heap[up][0] <= heap[i][0]) break; [heap[up], heap[i]] = [heap[i], heap[up]]; i = up; } };
  const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; for (let i = 0; ;) { const l = i * 2 + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
  best[ends[0].n] = 0;
  while (heap.length) {
    const [d, n] = pop(); if (d > best[n]) continue; if (n === ends[1].n) break;
    const relax = (m) => { const next = d + dist(P[n], P[m]); if (next < best[m]) { best[m] = next; from[m] = n; push([next, m]); } };
    for (const g of member[n]) for (const m of groups[g]) if (m !== n) relax(m);
    for (const m of links.get(n) || []) relax(m);
  }
  if (!Number.isFinite(best[ends[1].n])) throw new GraphError('No path along the cloth joins those two points: the pieces they are on are not sewn together');
  const route = []; for (let n = ends[1].n; n !== -1; n = from[n]) route.unshift(n);
  const path = route.map((n) => P[n]);
  for (let sweep = 0, moved = 1; sweep < 400 && moved > 1e-7; sweep++) {
    moved = 0;
    for (let k = 1; k < route.length - 1; k++) {
      const n = nodes[route[k]]; if (n.fixed) continue;
      const A = at(n.piece, n.i), B = at(n.piece, n.j), L = dist(A, B) || 1, u = [0, 1, 2].map((q) => (B[q] - A[q]) / L);
      const [[sp, dp], [sn, dn]] = [path[k - 1], path[k + 1]].map((p) => { const s = (p[0] - A[0]) * u[0] + (p[1] - A[1]) * u[1] + (p[2] - A[2]) * u[2]; return [s, dist(p, mix(A, B, s / L))]; });
      const t = Math.max(0, Math.min(1, (dp + dn > 1e-12 ? (sp * dn + sn * dp) / (dp + dn) : sp) / L)), next = mix(A, B, t);
      moved = Math.max(moved, dist(next, path[k])); path[k] = next;
    }
  }
  // The flat pattern distance is the same path only when it stays on one piece and crosses no seam.
  const length = path.reduce((sum, p, k) => (k ? sum + dist(p, path[k - 1]) : 0), 0), seamsCrossed = route.filter((n, k) => k && links.get(n)?.includes(route[k - 1])).length, flat = !seamsCrossed && ends[0].piece === ends[1].piece ? Math.hypot(ends[0].uv[0] - ends[1].uv[0], ends[0].uv[1] - ends[1].uv[1]) : null;
  return { type: 'distance', distance: round(length), straight: round(dist(path[0], path.at(-1))), pattern: round(flat), stretch: flat > 0 ? round(length / flat - 1, 5) : null, seamsCrossed };
}

/** Where the plane z = height cuts the cloth: every loop of it, the closed ones marked, and whether each goes round `centre` (the body's axis). */
export function circumference(drape, height, { centre = [0, 0], join = 15 } = {}) {
  if (!Number.isFinite(Number(height))) throw new GraphError('A circumference needs a height (mm above the floor)');
  const z = Number(height), ends = new Map(), segments = [];
  for (const piece of drape.pieces) for (let t = 0; t < piece.triangles.length; t += 3) {
    const ids = [0, 1, 2].map((k) => piece.triangles[t + k]), above = ids.map((i) => piece.positions[i * 3 + 2] >= z), cuts = [];
    for (let k = 0; k < 3; k++) { const i = ids[k], j = ids[(k + 1) % 3]; if (above[k] === above[(k + 1) % 3]) continue; const p = at(piece, i), q = at(piece, j), f = (z - p[2]) / (q[2] - p[2]); cuts.push({ key: `${piece.id}:${Math.min(i, j)}/${Math.max(i, j)}`, p: [p[0] + (q[0] - p[0]) * f, p[1] + (q[1] - p[1]) * f] }); }
    if (cuts.length !== 2) continue;
    const s = segments.push({ cuts, piece: piece.id, used: false }) - 1; for (const c of cuts) ends.set(c.key, [...(ends.get(c.key) || []), s]);
  }
  // Within a piece the cut runs from mesh edge to mesh edge; follow it both ways from any unused segment.
  const chains = [];
  for (const start of segments) {
    if (start.used) continue; start.used = true;
    const chain = { points: [start.cuts[0].p, start.cuts[1].p], pieces: new Set([start.piece]), closed: false };
    for (const forward of [true, false]) for (let key = start.cuts[forward ? 1 : 0].key; ;) {
      const next = (ends.get(key) || []).map((s) => segments[s]).find((s) => !s.used);
      if (!next) { if (forward && key === start.cuts[0].key && segments.length > 2) chain.closed = true; break; }
      next.used = true; const far = next.cuts[next.cuts[0].key === key ? 1 : 0]; key = far.key; chain.pieces.add(next.piece);
      if (forward) chain.points.push(far.p); else chain.points.unshift(far.p);
    }
    if (chain.closed) chain.points.pop();
    chains.push(chain);
  }
  // A seam is a small gap between two pieces' cuts: close the nearest open ends, nearest first, while they are within `join` mm.
  const gap = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
  for (;;) {
    const open = chains.filter((c) => !c.closed); let pick = null;
    for (const c of open) for (const d of open) for (const [ce, de] of c === d ? [[1, 0]] : [[0, 0], [0, 1], [1, 0], [1, 1]]) { const g = gap(ce ? c.points.at(-1) : c.points[0], de ? d.points.at(-1) : d.points[0]); if (g <= join && (!pick || g < pick.g) && (c !== d || c.points.length > 2)) pick = { g, c, d, ce, de }; }
    if (!pick) break;
    if (pick.c === pick.d) { pick.c.closed = true; continue; }
    const head = pick.ce ? pick.c.points : [...pick.c.points].reverse(), tail = pick.de ? [...pick.d.points].reverse() : pick.d.points;
    pick.c.points = [...head, ...tail]; for (const id of pick.d.pieces) pick.c.pieces.add(id); chains.splice(chains.indexOf(pick.d), 1);
  }
  const loops = chains.map((c) => {
    let length = 0, turn = 0; const n = c.points.length;
    for (let i = 0; i < (c.closed ? n : n - 1); i++) { const p = c.points[i], q = c.points[(i + 1) % n]; length += gap(p, q); const a = Math.atan2(q[1] - centre[1], q[0] - centre[0]) - Math.atan2(p[1] - centre[1], p[0] - centre[0]); turn += a > Math.PI ? a - 2 * Math.PI : a < -Math.PI ? a + 2 * Math.PI : a; }
    return { length: round(length), closed: c.closed, encloses: c.closed && Math.abs(turn) > Math.PI, pieces: [...c.pieces] };
  }).sort((p, q) => q.length - p.length);
  const closed = loops.filter((l) => l.closed);
  return { type: 'circumference', height: z, circumference: (closed.find((l) => l.encloses) || closed[0])?.length ?? null, total: round(loops.reduce((n, l) => n + l.length, 0)), loops };
}

/** A pattern segment as it lies in the drape: its length there against its length in the flat pattern. */
export function edgeLength(document, drape, patternId, segmentId) {
  const piece = pieceOf(drape, patternId), pattern = document.patterns.find((p) => p.id === patternId), segment = pattern?.segments.find((s) => s.id === segmentId), chain = piece.segmentVertices?.[segmentId];
  if (!segment || !chain) throw new GraphError(`No segment '${patternId}.${segmentId}' on a contour`);
  const draped = chain.reduce((n, v, k) => (k ? n + dist(at(piece, v), at(piece, chain[k - 1])) : 0), 0), flat = segmentLength(pattern, segment);
  return { type: 'edge', pattern: patternId, segment: segmentId, draped: round(draped), flat: round(flat), stretch: round(draped / flat - 1, 5) };
}

/** One side of a seam in the drape. A whole segment is measured as an edge; a span (part of a segment, or several in a row) is measured
 *  along its boundary chain, in the flat pattern and in the drape, between where it starts and where it stops. */
function sideLength(document, drape, ref) {
  const side = seamSide(ref); if (side.segments.length === 1 && side.from === 0 && side.to === 1) return edgeLength(document, drape, side.pattern, side.segments[0]);
  const piece = pieceOf(drape, side.pattern), flatAt = [0], drapedAt = [0], each = [];
  for (const id of side.segments) {
    const chain = piece.segmentVertices?.[id], base = flatAt.at(-1); if (!chain) throw new GraphError(`No segment '${side.pattern}.${id}' on a contour`);
    for (let k = 1; k < chain.length; k++) { const i = chain[k - 1], j = chain[k]; flatAt.push(flatAt.at(-1) + Math.hypot(piece.uv[j * 2] - piece.uv[i * 2], piece.uv[j * 2 + 1] - piece.uv[i * 2 + 1])); drapedAt.push(drapedAt.at(-1) + dist(at(piece, j), at(piece, i))); }
    each.push(flatAt.at(-1) - base);
  }
  const start = side.from * each[0], end = flatAt.at(-1) - (1 - side.to) * each.at(-1), flat = end - start;
  const along = (want) => { let k = 1; while (k < flatAt.length - 1 && flatAt[k] < want) k++; return drapedAt[k - 1] + (flatAt[k] > flatAt[k - 1] ? (want - flatAt[k - 1]) / (flatAt[k] - flatAt[k - 1]) : 0) * (drapedAt[k] - drapedAt[k - 1]); };
  const draped = along(end) - along(start);
  return { type: 'edge', pattern: side.pattern, segments: side.segments, from: side.from, to: side.to, draped: round(draped), flat: round(flat), stretch: round(draped / flat - 1, 5) };
}

/** Both sides of a seam in the drape, and how far apart the sewn points still are. */
export function seamLength(document, drape, seamId) {
  const seam = (drape.seams || []).find((s) => s.id === seamId); if (!seam) throw new GraphError(`No seam '${seamId}'`);
  const A = pieceOf(drape, seam.a.pattern), B = pieceOf(drape, seam.b.pattern), point = (piece, side) => mix(at(piece, side.vertices[0]), at(piece, side.vertices[1]), side.weights[1]);
  return { type: 'seam', seam: seamId, a: sideLength(document, drape, seam.a), b: sideLength(document, drape, seam.b), gap: round(Math.max(0, ...seam.pairs.map((pair) => dist(point(A, pair.a), point(B, pair.b))))) };
}

/** The box round the draped cloth. size is [across x, front to back y, top to bottom z]. */
export function boundsOf(drape) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const p of drape.pieces) for (let i = 0; i < p.positions.length; i++) { min[i % 3] = Math.min(min[i % 3], p.positions[i]); max[i % 3] = Math.max(max[i % 3], p.positions[i]); }
  return { type: 'bounds', min: min.map((v) => round(v)), max: max.map((v) => round(v)), size: min.map((v, k) => round(max[k] - v)) };
}

/** The tape-measure length round the body at a height: the hull of where the plane cuts its shapes (all of them, or only those named). */
export function bodyCircumference(body, height, only = null) {
  const points = [];
  for (const s of body?.shapes || []) {
    if (only && !only.includes(s.name)) continue;
    if (s.type === 'mesh') { const P = s.positions; for (let t = 0; t < s.indices.length; t += 3) for (let k = 0; k < 3; k++) { const a = s.indices[t + k] * 3, b = s.indices[t + (k + 1) % 3] * 3; if ((P[a + 2] >= height) !== (P[b + 2] >= height)) { const f = (height - P[a + 2]) / (P[b + 2] - P[a + 2]); points.push([P[a] + (P[b] - P[a]) * f, P[a + 1] + (P[b + 1] - P[a + 1]) * f]); } } continue; }
    if (s.type === 'ellipsoid') { const q = (height - s.c[2]) / s.r[2]; if (Math.abs(q) < 1) { const k = Math.sqrt(1 - q * q); for (let i = 0; i < 96; i++) points.push([s.c[0] + s.r[0] * k * Math.cos(i * Math.PI / 48), s.c[1] + s.r[1] * k * Math.sin(i * Math.PI / 48)]); } }
    else for (let j = 0; j <= 24; j++) { const c = mix(s.a, s.b, j / 24), d = height - c[2]; if (Math.abs(d) < s.r) { const k = Math.sqrt(s.r * s.r - d * d); for (let i = 0; i < 32; i++) points.push([c[0] + k * Math.cos(i * Math.PI / 16), c[1] + k * Math.sin(i * Math.PI / 16)]); } }
  }
  if (points.length < 3) return null;
  points.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const turn = (o, p, q) => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]), half = (list) => { const h = []; for (const p of list) { while (h.length > 1 && turn(h.at(-2), h.at(-1), p) <= 0) h.pop(); h.push(p); } return h.slice(0, -1); };
  const hull = [...half(points), ...half([...points].reverse())];
  return hull.reduce((n, p, i) => n + Math.hypot(p[0] - hull[(i + 1) % hull.length][0], p[1] - hull[(i + 1) % hull.length][1]), 0);
}

/** Answer a list of measurement requests on one drape. A request that cannot be answered carries its error; the others still answer. */
export function measureDrape(document, drape, measures = []) {
  if (!Array.isArray(measures)) throw new GraphError('measures must be an array');
  return measures.map((m) => {
    try {
      if (m?.type === 'distance') return geodesic(document, drape, m.a, m.b);
      if (m?.type === 'circumference') { const z = m.level != null ? drape.body?.levels?.[m.level] : m.height; if (m.level != null && z == null) throw new GraphError(`The avatar has no level '${m.level}'`); return { ...circumference(drape, z, m), ...(m.level != null ? { level: m.level } : {}) }; }
      if (m?.type === 'edge') return edgeLength(document, drape, m.pattern, m.segment);
      if (m?.type === 'seam') return seamLength(document, drape, m.seam);
      if (m?.type === 'bounds') return boundsOf(drape);
      throw new GraphError(`Unknown measurement type '${m?.type}': use distance, circumference, edge, seam or bounds`);
    } catch (e) { if (!(e instanceof GraphError)) throw e; return { type: m?.type, error: e.message }; }
  });
}

// A fabric says how far it may be stretched with strainLimit (a ratio); one that does not is held to this.
const STRAIN_LIMIT = 0.05;
// The stretch is in order while no more than this share of the cloth is over its limit: a seam corner's one vertex is solver noise.
const OVER_SHARE = 0.01;
// Cloth counts as touching the body where the solver's smoothed contact pressure is above this (Pa).
const CONTACT = 0.1;
const percentile = (sorted, q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : null);

function stats(rows, limit, pressureAvailable) {
  // rows: [strain, pressure Pa, area mm², limit] for every vertex.
  const strain = rows.map((r) => r[0]).sort((a, b) => a - b), touching = rows.filter((r) => r[1] > CONTACT), pressure = touching.map((r) => r[1] / 1000).sort((a, b) => a - b), area = rows.reduce((n, r) => n + r[2], 0) || 1;
  const over = rows.reduce((n, r) => n + (r[0] > r[3] ? r[2] : 0), 0) / area, pct = (v) => round(v * 100, 3), kPa = (v) => round(v, 5);
  return { areaMm2: round(area, 0),
    strain: { unit: '%', min: pct(strain[0]), p50: pct(percentile(strain, 0.5)), p90: pct(percentile(strain, 0.9)), p99: pct(percentile(strain, 0.99)), max: pct(strain.at(-1)), ...(limit ? { limit: pct(limit.value), limitSource: limit.source } : {}), overLimit: round(over, 4), ok: over <= OVER_SHARE },
    pressure: pressureAvailable ? { unit: 'kPa', p50: kPa(percentile(pressure, 0.5) ?? 0), p90: kPa(percentile(pressure, 0.9) ?? 0), p99: kPa(percentile(pressure, 0.99) ?? 0), max: kPa(pressure.at(-1) ?? 0), mean: kPa(rows.reduce((n, r) => n + r[1] * r[2], 0) / area / 1000) } : { available: false, reason: 'The design has no avatar for the cloth to press on' },
    contact: pressureAvailable ? round(touching.reduce((n, r) => n + r[2], 0) / area, 4) : null };
}

// The body's chest line sits at the armpit, where a shirt's armhole is still open, so the garment's chest is taken where
// a tape goes on a shirt: the first level below the line that closes round the body, 10 mm at a time and at most 100 mm down.
function closedAround(level, cutAt, height) {
  for (let below = 0; below <= (level === 'chest' ? 100 : 0); below += 10) { const loop = cutAt(height - below).loops.find((l) => l.closed && l.encloses); if (loop) return [loop, below]; }
  return [null, 0];
}

/** How the garment fits: stretch against each fabric's limit, pressure on the body, how much of the cloth touches it, and ease at the avatar's levels. */
export function fitReport(document, drape) {
  const all = [], fabrics = resolveMaterials(document.materials), pieces = drape.pieces.map((p) => {
    const fabric = fabrics[p.material] || {}, limit = Number(fabric.strainLimit) > 0 ? { value: Number(fabric.strainLimit), source: 'material' } : { value: STRAIN_LIMIT, source: 'default' };
    const rows = Array.from({ length: p.count }, (_, i) => [p.strain[i], p.pressure[i], p.area[i], limit.value]); all.push(...rows);
    return { id: p.id, name: p.name, material: p.material, ...stats(rows, limit, drape.pressureAvailable) };
  });
  // The full avatar says where a tape goes (src/core/softgoods-avatar.js girths): round the torso at chest, waist and hip, and square across each upper arm and thigh.
  // Each is measured in a frame turned so that its plane is level: the body's own shapes there, and the cloth that goes round the same point.
  const girths = drape.body?.girths, ease = girths ? girths.map((g) => {
    const n = g.normal, e1 = Math.abs(n[2]) > 0.999 ? [1, 0, 0] : (() => { const l = Math.hypot(n[1], n[0]); return [-n[1] / l, n[0] / l, 0]; })(), e2 = [n[1] * e1[2] - n[2] * e1[1], n[2] * e1[0] - n[0] * e1[2], n[0] * e1[1] - n[1] * e1[0]];
    const turn = (a) => { const out = new Float32Array(a.length); for (let i = 0; i < a.length; i += 3) { out[i] = a[i] * e1[0] + a[i + 1] * e1[1] + a[i + 2] * e1[2]; out[i + 1] = a[i] * e2[0] + a[i + 1] * e2[1] + a[i + 2] * e2[2]; out[i + 2] = a[i] * n[0] + a[i + 1] * n[1] + a[i + 2] * n[2]; } return out; }, [cx, cy, height] = turn(g.at);
    const turned = { shapes: drape.body.shapes.filter((s) => g.shapes.includes(s.name)).map((s) => (s.type === 'mesh' ? { ...s, positions: turn(s.positions) } : s.type === 'capsule' ? { ...s, a: [...turn(s.a)], b: [...turn(s.b)] } : s)) };
    const cloth = { pieces: drape.pieces.map((p) => ({ ...p, positions: turn(p.positions) })) }, [loop, below] = closedAround(g.level, (h) => circumference(cloth, h, { centre: [cx, cy] }), height), body = bodyCircumference(turned, height), garment = loop?.length ?? null;
    return { level: g.level, height: round(g.at[2]), garment, body: round(body), stated: g.stated, ease: garment != null && body != null ? round(garment - body) : null, gap: garment != null && body != null ? round((garment - body) / (2 * Math.PI)) : null, closed: !!loop, ...(below ? { below } : {}) };
  }) : Object.entries(drape.body?.levels || {}).filter(([level]) => level !== 'shoulder').map(([level, height]) => {
    const cut = circumference(drape, height), loop = cut.loops.find((l) => l.closed && l.encloses), body = bodyCircumference(drape.body, height), garment = loop?.length ?? null;
    return { level, height: round(height), garment, body: round(body), ease: garment != null && body != null ? round(garment - body) : null, gap: garment != null && body != null ? round((garment - body) / (2 * Math.PI)) : null, closed: !!loop, ...(level === 'chest' && drape.body?.chest ? { stated: drape.body.chest } : {}) };
  });
  const overall = stats(all, null, drape.pressureAvailable);
  return { schema: 'cadgang.softgoods-fit.v1', revision: drape.revision, drape: { settled: drape.settled, steps: drape.steps, residual: round(drape.residual, 4), target: drape.options.target }, ok: drape.settled && overall.strain.ok, overall, pieces, ease, bounds: boundsOf(drape),
    notes: ['Lengths mm, strain %, pressure kPa.', `overLimit is the share of the cloth's area stretched past its fabric's strainLimit (${STRAIN_LIMIT * 100}% for a fabric that gives none); the stretch is ok while that is at most ${OVER_SHARE * 100}%.`, 'ease is the garment\'s circumference less the body\'s at that height; gap is that ease as a mean distance from the body. A level the garment does not close around has no ease.', girths ? 'body is measured round the avatar the cloth collides with, whose torso, upper arms and thighs are built to the stated girths; an arm or a thigh is measured square across the limb, a third of the way down it. The chest line is at the armpit, so where the armholes are open there the garment is measured at the first level up to 100 mm below that closes, and below says how far down.' : 'body is measured round the avatar the cloth collides with, which is narrower than the stated chest.', 'An XPBD preview: it points at tight places and is not a fit guarantee.'] };
}
