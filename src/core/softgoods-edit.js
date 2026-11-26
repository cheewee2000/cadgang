// Pattern-making operations on the softgoods document: what a pattern maker does to a piece with a ruler and scissors.
// Every operation takes a document and its arguments and returns a new, validated document; the input is never changed.
// Existing ids keep their meaning. New ids are spelled from the ones they came from (front_top_2, waist_dart_apex),
// so the next prompt can name them. All lengths are mm; a place along an edge is a fraction of that edge's length.

import { GraphError } from './errors.js';
import { validateSoftgoodsDocument, patternLoops, inMaterial, internalSegment } from './softgoods-document.js';
import { sampleSegment, segmentLength } from './softgoods-export.js';
import { insideLoop } from './softgoods-mesh.js';
import { seamFraction } from './softgoods-seams.js';

const EPS = 1e-6, KEYS = ['a', 'b', 'c', 'c1', 'c2'];
const clone = (v) => structuredClone(v);
const need = (ok, message) => { if (!ok) throw new GraphError(message); };
const positive = (v) => Number.isFinite(v) && v > 0;
const pat = (d, id) => { const p = d.patterns.find((q) => q.id === id); need(p, `No pattern '${id}'`); return p; };
const seg = (p, id) => { const s = p.segments.find((q) => q.id === id); need(s, `Pattern '${p.id}' has no segment '${id}'`); return s; };
const pt = (p, id) => { const q = p.points.find((r) => r.id === id); need(q, `Pattern '${p.id}' has no point '${id}'`); return q; };
/** The wanted id, or the first of wanted_2, wanted_3 ... that is free. The set learns the id it gave out. */
const fresh = (taken, wanted) => { let id = wanted; for (let n = 2; taken.has(id); n++) id = `${wanted}_${n}`; taken.add(id); return id; };
const idsOf = (...lists) => new Set(lists.flat().map((q) => q.id));
const unit = (v) => { const l = Math.hypot(v[0], v[1]); need(l > EPS, 'Two points that set a direction coincide'); return [v[0] / l, v[1] / l]; };
const signedArea = (q) => q.reduce((n, a, i) => { const b = q[(i + 1) % q.length]; return n + a[0] * b[1] - b[0] * a[1]; }, 0) / 2;
const polyline = (p, ids) => ids.flatMap((id, k) => { const s = seg(p, id); return sampleSegment(p, s, s.type === 'line' ? 1 : 32).slice(k ? 1 : 0); });
const inside = (p, q) => inMaterial(patternLoops(p), q, 0);
const refsOf = (list) => new Set(list.flatMap((s) => KEYS.map((k) => s[k])).filter((id) => id != null));
const usualAllowance = (p) => { const n = new Map(); for (const mm of Object.values(p.allowances || {})) n.set(mm, (n.get(mm) || 0) + 1); return [...n].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0; };

// Seams measure along an edge by length; a Bezier's own parameter does not run evenly along it. Lines and arcs agree.
function lengthTable(p, s) { const q = sampleSegment(p, s, 256), c = [0]; for (let i = 1; i < q.length; i++) c.push(c[i - 1] + Math.hypot(q[i][0] - q[i - 1][0], q[i][1] - q[i - 1][1])); return c; }
function paramAt(p, s, f) { if (s.type !== 'bezier') return f; const c = lengthTable(p, s), want = f * c.at(-1); let i = 1; while (i < c.length - 1 && c[i] < want) i++; return (i - 1 + (c[i] > c[i - 1] ? (want - c[i - 1]) / (c[i] - c[i - 1]) : 0)) / (c.length - 1); }
function fractionAt(p, s, t) { if (s.type !== 'bezier') return t; const c = lengthTable(p, s), u = t * (c.length - 1), i = Math.min(c.length - 2, Math.floor(u)); return (c[i] + (c[i + 1] - c[i]) * (u - i)) / c.at(-1); }
function evalSegment(p, s, t) {
  const a = pt(p, s.a), b = pt(p, s.b);
  if (s.type === 'line') return [a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t];
  if (s.type === 'arc') { const c = pt(p, s.c), r = Math.hypot(a.x - c.x, a.y - c.y), a0 = Math.atan2(a.y - c.y, a.x - c.x); let sweep = Math.atan2(b.y - c.y, b.x - c.x) - a0; if (sweep <= 0) sweep += 2 * Math.PI; return [c.x + r * Math.cos(a0 + sweep * t), c.y + r * Math.sin(a0 + sweep * t)]; }
  const c1 = pt(p, s.c1), c2 = pt(p, s.c2), u = 1 - t, k = [u ** 3, 3 * u * u * t, 3 * u * t * t, t ** 3];
  return [k[0] * a.x + k[1] * c1.x + k[2] * c2.x + k[3] * b.x, k[0] * a.y + k[1] * c1.y + k[2] * c2.y + k[3] * b.y];
}
/** The point at a fraction of an edge's length, and the unit normal there that points into the material. */
function inward(p, s, f) {
  const li = p.contours.findIndex((loop) => loop.includes(s.id)); need(li >= 0, `Segment '${s.id}' is not on the outline of '${p.id}'`);
  const t = paramAt(p, s, f), at = evalSegment(p, s, t), a = evalSegment(p, s, Math.max(0, t - 1e-4)), b = evalSegment(p, s, Math.min(1, t + 1e-4)), [tx, ty] = unit([b[0] - a[0], b[1] - a[1]]);
  // Material is on the left of a counter-clockwise outer edge, and on the right of a counter-clockwise hole.
  const areas = p.contours.map((loop) => signedArea(polyline(p, loop))), outer = areas.every((v, k) => k === li || Math.abs(v) < Math.abs(areas[li])), left = (areas[li] > 0) === outer;
  return { at, normal: left ? [-ty, tx] : [ty, -tx] };
}

/** The points of a pattern that something refers to: its segments (but for one, if given), internal lines, marks and measurements. */
function usedPoints(d, p, but) {
  const used = refsOf([...p.segments.filter((s) => s !== but), ...(p.internalLines || []).map(internalSegment)]);
  for (const a of d.annotations) if (a.pattern === p.id) for (const id of a.lines.flat()) used.add(id);
  for (const c of d.constraints) for (const side of [c.a, c.b]) if (side?.pattern === p.id) used.add(side.point);
  return used;
}
/** Forget points that nothing uses any more (the handles of a curve that left the outline). */
function dropUnused(d, p, ids) {
  const used = usedPoints(d, p), gone = new Set(ids.filter((id) => !used.has(id)));
  p.points = p.points.filter((q) => !gone.has(q.id));
  for (const g of d.grades) g.rules = g.rules.filter((r) => r.pattern !== p.id || !gone.has(r.point));
}

/** A graded size moves a new point as far as its place between two others says. */
function gradeBetween(d, pid, id, a, b, f) {
  for (const g of d.grades) { const rule = (q) => g.rules.find((r) => r.pattern === pid && r.point === q) || { dx: 0, dy: 0 }, u = rule(a), v = rule(b), dx = u.dx + (v.dx - u.dx) * f, dy = u.dy + (v.dy - u.dy) * f; if (dx || dy) g.rules.push({ pattern: pid, point: id, dx, dy }); }
}

/** Cut one segment in two at a fraction of its length. The first half keeps the id (the second, with keepSecond) and the other takes
 *  newSid; allowances, notches, length constraints and graded sizes follow. Seams are the caller's business: see reseam. */
function splitGeom(d, p, sid, f, pointId, newSid, keepSecond = false) {
  const i = p.segments.findIndex((q) => q.id === sid), s = p.segments[i], t = paramAt(p, s, f), [x, y] = evalSegment(p, s, t), [first, second] = keepSecond ? [newSid, sid] : [sid, newSid];
  const halves = [{ ...s, id: first, b: pointId }, { ...s, id: second, a: pointId }];
  if (s.type === 'bezier') {
    // de Casteljau: each half is its own cubic, with its own handles. The half that keeps the segment's id keeps its two handles
    // as well, moved to where that half needs them, unless something else uses those points too.
    const P = [s.a, s.c1, s.c2, s.b].map((id) => pt(p, id)), mix = (u, v) => ({ x: u.x + (v.x - u.x) * t, y: u.y + (v.y - u.y) * t });
    const ab = mix(P[0], P[1]), bc = mix(P[1], P[2]), cd = mix(P[2], P[3]), taken = idsOf(p.points), used = usedPoints(d, p, s), mine = s.c1 !== s.c2 && !used.has(s.c1) && !used.has(s.c2);
    const ids = [`${first}_c1`, `${first}_c2`, `${second}_c1`, `${second}_c2`].map((id, k) => (mine && (k > 1) === keepSecond ? [s.c1, s.c2][k % 2] : fresh(taken, id)));
    [ab, mix(ab, bc), mix(bc, cd), cd].forEach((q, k) => { const old = p.points.find((r) => r.id === ids[k]); if (old) Object.assign(old, q); else p.points.push({ id: ids[k], ...q }); });
    Object.assign(halves[0], { c1: ids[0], c2: ids[1] }); Object.assign(halves[1], { c1: ids[2], c2: ids[3] });
  }
  p.points.push({ id: pointId, x, y }); p.segments.splice(i, 1, ...halves);
  const both = (list) => list.flatMap((id) => (id === sid ? [first, second] : [id]));
  p.contours = p.contours.map(both);
  if (p.allowances?.[sid] != null) p.allowances[first] = p.allowances[second] = p.allowances[sid];
  // A notch sits at a fraction of the segment's own parameter, which is what was just cut at t.
  for (const n of p.notches || []) if (n.segment === sid) { const at = n.at ?? 0.5; Object.assign(n, at <= t ? { segment: first, at: +(at / t).toFixed(9) } : { segment: second, at: +((at - t) / (1 - t)).toFixed(9) }); }
  for (const c of d.constraints) if (c.pattern === p.id && c.segments) c.segments = both(c.segments);
  gradeBetween(d, p.id, pointId, s.a, s.b, f);
}

/** One edit's memory. log: every split it made, so a later reference to the same segment still means the place the caller saw.
 *  stack and handled: the walk from a split edge through the seams on it to the edges those sew to. */
const context = () => ({ log: [], stack: [], handled: new Set() });

/** A segment was cut at f into first and second: cut every edge sewn to it at the matching place, and turn each seam into two. */
function reseam(d, pid, sid, f, first, second, ctx) {
  const ids = idsOf(d.seams);
  for (const seam of [...d.seams]) {
    const onA = seam.a.pattern === pid && seam.a.segment === sid, onB = seam.b.pattern === pid && seam.b.segment === sid;
    if (ctx.handled.has(seam.id) || (!onA && !onB)) continue;
    need(!(onA && onB), `Seam '${seam.id}' sews '${sid}' to itself and cannot be split`);
    // fa: the cut as a fraction of side a. m: of side b before the flip, which is how the correspondence stops are written.
    const fa = onA ? f : seamFraction(seam, f, true), fb = onA ? seamFraction(seam, f) : f, m = seam.flip ? 1 - fb : fb, other = onA ? seam.b : seam.a;
    ctx.handled.add(seam.id);
    const o = splitAt(d, other.pattern, other.segment, onA ? fb : fa, ctx);
    need(o.second, `Seam '${seam.id}' cannot be split that close to its end`);
    const a = onA ? [first, second] : [o.first, o.second], b = onA ? [o.first, o.second] : [first, second]; if (seam.flip) b.reverse();
    const stops = seam.correspondence || [], id2 = fresh(ids, `${seam.id}_2`); ctx.handled.add(id2);
    const rest = { ...clone(seam), id: id2, a: { ...seam.a, segment: a[1] }, b: { ...seam.b, segment: b[1] }, correspondence: stops.filter((q) => q.a > fa + EPS && q.b > m + EPS).map((q) => ({ a: (q.a - fa) / (1 - fa), b: (q.b - m) / (1 - m) })) };
    seam.a.segment = a[0]; seam.b.segment = b[0]; seam.correspondence = stops.filter((q) => q.a < fa - EPS && q.b < m - EPS).map((q) => ({ a: q.a / fa, b: q.b / m }));
    d.seams.splice(d.seams.indexOf(seam) + 1, 0, rest);
  }
}

/** Cut a segment at a fraction of its length, seams and all. At either end there is nothing to cut: the point is already there. */
function splitAt(d, pid, sid, f, ctx, ids = {}) {
  const p = pat(d, pid), s = seg(p, sid), length = segmentLength(p, s);
  if (f * length < 1e-4) return { point: s.a }; if ((1 - f) * length < 1e-4) return { point: s.b };
  // ponytail: seams that lead back to the edge being cut (a to b, b to c, c to a) are refused; cut them by hand if that ever comes up.
  const key = `${pid}/${sid}`; need(!ctx.stack.includes(key), `The seams on '${pid}.${sid}' lead back to it; it cannot be split`);
  const point = fresh(idsOf(p.points), ids.point || `${sid}_split`), second = fresh(idsOf(p.segments), `${sid}_2`);
  splitGeom(d, p, sid, f, point, second); ctx.log.push({ pattern: pid, segment: sid, f, second });
  ctx.stack.push(key); reseam(d, pid, sid, f, sid, second, ctx); ctx.stack.pop();
  return { point, first: sid, second };
}

/** The outline vertex the caller pointed at: an existing point id, or { segment, at } which cuts that segment there. */
function vertexAt(d, p, ref, ctx, ids) {
  if (typeof ref === 'string') { pt(p, ref); return ref; }
  need(ref && typeof ref.segment === 'string', 'A place on the outline is a point id or { segment, at }');
  let sid = ref.segment, f = Number(ref.at ?? 0.5); seg(p, sid); need(f >= 0 && f <= 1, `'at' on '${sid}' must be between 0 and 1`);
  for (const e of ctx.log) if (e.pattern === p.id && e.segment === sid) { if (f <= e.f) f /= e.f; else { sid = e.second; f = (f - e.f) / (1 - e.f); } }
  ctx.handled = new Set();
  return splitAt(d, p.id, sid, f, ctx, ids).point;
}

/** The contour through two of its vertices: the run of segments from x round to y, and the run from y back to x. */
function chains(p, x, y) {
  need(x !== y, `A cut needs two different points, not '${x}' twice`);
  for (let li = 0; li < p.contours.length; li++) {
    const loop = p.contours[li], i = loop.findIndex((id) => seg(p, id).a === x), j = loop.findIndex((id) => seg(p, id).a === y); if (i < 0 || j < 0) continue;
    const run = (m, n) => { const out = []; for (let k = m; k !== n; k = (k + 1) % loop.length) out.push(loop[k]); return out; };
    return { li, forward: run(i, j), back: run(j, i) };
  }
  throw new GraphError(`Points '${x}' and '${y}' are not both on one outline of pattern '${p.id}'`);
}
/** A straight cut between two outline vertices has to run through the material of the outer contour. */
function needInside(p, li, x, y, what) {
  const area = (loop) => Math.abs(signedArea(polyline(p, loop)));
  need(p.contours.every((loop, k) => k === li || area(loop) < area(p.contours[li])), `${what} must join two points on the outer edge of '${p.id}', not on a hole`);
  const a = pt(p, x), b = pt(p, y);
  for (let k = 1; k < 16; k++) need(inside(p, [a.x + (b.x - a.x) * k / 16, a.y + (b.y - a.y) * k / 16]), `${what} from '${x}' to '${y}' leaves the material of '${p.id}'`);
}

/** Open the outline between two of its vertices, the way a pattern is slashed and spread. The run of the outline from x round to y,
 *  and whatever lies inside it, moves; x and y stay with the rest and get twins on the moved side. The caller closes the gaps. */
function spread(d, p, x, y, move, twinIds) {
  const { li, forward, back } = chains(p, x, y); needInside(p, li, x, y, 'The slash');
  // ponytail: an arc centre or curve handle shared by both sides stays put; give each side its own if a curve comes out bent.
  // ponytail: a graded size moves the spread side by the rules it had, not turned with it; turn the rules if graded flares drift.
  const poly = polyline(p, forward), still = refsOf(back.map((id) => seg(p, id))), moving = refsOf(forward.map((id) => seg(p, id))), taken = idsOf(p.points), twin = {}, before = [...p.points];
  for (const id of [x, y]) {
    const q = pt(p, id), [mx, my] = move(q.x, q.y); if (Math.hypot(mx - q.x, my - q.y) < EPS) continue;
    twin[id] = fresh(taken, twinIds[id === x ? 0 : 1]); p.points.push({ id: twin[id], x: mx, y: my });
    for (const g of d.grades) for (const r of g.rules.filter((q2) => q2.pattern === p.id && q2.point === id)) g.rules.push({ ...r, point: twin[id] });
  }
  for (const q of before) if (q.id !== x && q.id !== y && !still.has(q.id) && (moving.has(q.id) || insideLoop(poly, [q.x, q.y]))) [q.x, q.y] = move(q.x, q.y);
  for (const id of forward) { const s = seg(p, id); for (const k of KEYS) if (twin[s[k]]) s[k] = twin[s[k]]; }
  return { li, forward, back, x2: twin[x] || x, y2: twin[y] || y };
}

/** Where a ray from a point on the edge first meets the outline again: the segment, and the fraction of its length. */
function across(p, o, dir) {
  let best = null;
  for (const sid of p.contours.flat()) {
    const s = seg(p, sid), n = s.type === 'line' ? 1 : 256, q = sampleSegment(p, s, n);
    for (let i = 0; i < n; i++) {
      const e = [q[i + 1][0] - q[i][0], q[i + 1][1] - q[i][1]], w = [q[i][0] - o[0], q[i][1] - o[1]], den = dir[0] * e[1] - dir[1] * e[0]; if (Math.abs(den) < 1e-12) continue;
      const along = (w[0] * e[1] - w[1] * e[0]) / den, u = (w[0] * dir[1] - w[1] * dir[0]) / den;
      if (along > 1e-3 && u > -1e-9 && u < 1 + 1e-9 && (!best || along < best.along)) best = { along, segment: sid, at: fractionAt(p, s, Math.min(1, Math.max(0, (i + u) / n))) };
    }
  }
  need(best, `Nothing lies across pattern '${p.id}' from there`); return best;
}

/** A pattern's geometry reflected in the line through o along the unit vector u. Reflection turns the outline over, so every segment is
 *  reversed and every contour read backwards: the copy winds the way the original does, and its arcs are still counter-clockwise. */
function reflected(p, o, u, rp, rs) {
  const turn = (s) => ({ ...s, ...(s.id != null ? { id: rs(s.id) } : {}), a: rp(s.b), b: rp(s.a), ...(s.type === 'arc' ? { c: rp(s.c) } : s.type === 'bezier' ? { c1: rp(s.c2), c2: rp(s.c1) } : {}) });
  return {
    points: p.points.map((q) => { const k = 2 * ((q.x - o[0]) * u[0] + (q.y - o[1]) * u[1]); return { ...q, id: rp(q.id), x: 2 * o[0] + k * u[0] - q.x, y: 2 * o[1] + k * u[1] - q.y }; }),
    segments: p.segments.map(turn), contours: p.contours.map((loop) => loop.map(rs).reverse()),
    allowances: Object.fromEntries(Object.entries(p.allowances || {}).map(([sid, mm]) => [rs(sid), mm])),
    notches: (p.notches || []).map((n) => ({ ...n, segment: rs(n.segment), at: 1 - (n.at ?? 0.5) })),
    internalLines: (p.internalLines || []).map((l) => (Array.isArray(l) ? l.map(rp) : turn(l))),
  };
}
const reflectedDelta = (r, u) => { const k = 2 * (r.dx * u[0] + r.dy * u[1]); return { dx: k * u[0] - r.dx + 0, dy: k * u[1] - r.dy + 0 }; };
/** A seam between two reversed edges pairs the same places, read from the other end. */
const mirroredSeam = (s, id, a, b) => ({ ...clone(s), id, a, b, correspondence: (s.correspondence || []).map((q) => ({ a: 1 - q.a, b: 1 - q.b })).reverse() });

const OPS = {
  /** A mirrored copy of a pattern: the other hand of a left or right piece. Across one of its segments, or across an axis. */
  mirror(d, { pattern: pid, segment, axis = 'y', id, name, seam = false }) {
    const p = pat(d, pid), newId = id || fresh(idsOf(d.patterns), `${pid}_mirror`); need(!d.patterns.some((q) => q.id === newId), `Pattern '${newId}' already exists`);
    const xs = p.points.map((q) => q.x), ys = p.points.map((q) => q.y); let o, u;
    if (segment != null) { const s = seg(p, segment), a = pt(p, s.a), b = pt(p, s.b); o = [a.x, a.y]; u = unit([b.x - a.x, b.y - a.y]); }
    else if (axis === 'x' || axis === 'y') { o = [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2]; u = axis === 'y' ? [0, 1] : [1, 0]; }
    else { need([axis?.a, axis?.b].every((q) => Array.isArray(q) && q.length === 2 && q.every(Number.isFinite)), "axis is 'x', 'y' or { a: [x, y], b: [x, y] }"); o = axis.a; u = unit([axis.b[0] - axis.a[0], axis.b[1] - axis.a[1]]); }
    // front_top becomes front_mirror_top; ids that do not carry the pattern's name stay as they are (they are only unique within a pattern).
    const swap = (x) => (x.startsWith(`${pid}_`) ? `${newId}_${x.slice(pid.length + 1)}` : x), renamer = (ids) => (new Set(ids.map(swap)).size === ids.length ? swap : (x) => x);
    const rp = renamer(p.points.map((q) => q.id)), rs = renamer(p.segments.map((q) => q.id));
    const copy = { ...clone(p), ...reflected(p, o, u, rp, rs), id: newId, name: name || `${p.name || pid} mirrored` };
    if (p.grain) copy.grain = { ...p.grain, angle: +((((2 * Math.atan2(u[1], u[0]) * 180 / Math.PI - Number(p.grain.angle)) % 180) + 180) % 180).toFixed(9) };
    if (copy.placement) {
      const region = { left: 'right', right: 'left' }[copy.placement.region] || copy.placement.region, offset = copy.placement.offset;
      copy.placement = { ...copy.placement, region, ...(offset && region !== p.placement.region ? { offset: [-offset[0], offset[1], offset[2]] } : {}) };
      // Two pieces cannot stand in the same place on the body: a copy whose place is taken is laid beside the original instead.
      if (d.patterns.some((q) => q.placement?.region === region && Number(q.placement.layer || 0) === Number(copy.placement.layer || 0))) delete copy.placement;
    }
    d.patterns.splice(d.patterns.indexOf(p) + 1, 0, copy);
    const row = d.arrangement.find((a) => a.pattern === pid);
    if (row) { const { source, ...rest } = clone(row); d.arrangement.push({ ...rest, pattern: newId, position: [row.position[0] + Math.max(...xs) - Math.min(...xs) + 40, row.position[1], row.position[2]] }); }
    const annotationIds = idsOf(d.annotations), seamIds = idsOf(d.seams), named = (x) => (x.startsWith(`${pid}_`) ? swap(x) : `${newId}_${x}`);
    for (const a of d.annotations.filter((q) => q.pattern === pid)) d.annotations.push({ ...clone(a), id: fresh(annotationIds, named(a.id)), pattern: newId, lines: a.lines.map((pair) => pair.map(rp)) });
    for (const g of d.grades) for (const r of g.rules.filter((q) => q.pattern === pid)) g.rules.push({ pattern: newId, point: rp(r.point), ...reflectedDelta(r, u) });
    // Seams within the piece (its darts and pleats) belong to it and are copied; seams to other pieces are not, the copy sews to different edges.
    for (const s of d.seams.filter((q) => q.a.pattern === pid && q.b.pattern === pid)) d.seams.push(mirroredSeam(s, fresh(seamIds, named(s.id)), { pattern: newId, segment: rs(s.a.segment) }, { pattern: newId, segment: rs(s.b.segment) }));
    if (seam) { need(segment != null, 'seam: true sews the copy to the original along the mirror segment, so give segment'); d.seams.push({ id: fresh(seamIds, typeof seam === 'string' ? seam : `${segment}_seam`), a: { pattern: pid, segment }, b: { pattern: newId, segment: rs(segment) }, flip: true, ease: 0, kind: 'plain', correspondence: [] }); }
  },

  /** A half pattern drawn to be cut on the fold becomes the whole symmetric piece: the fold segment goes, and the outline carries on as its own mirror image. */
  unfold(d, { pattern: pid, segment: sid }) {
    const p = pat(d, pid), fold = seg(p, sid), li = p.contours.findIndex((loop) => loop.includes(sid)), sewn = d.seams.find((s) => [s.a, s.b].some((r) => r.pattern === pid && r.segment === sid));
    need(fold.type === 'line' && li >= 0, `A fold is a straight segment of the outline; '${sid}' is not`); need(!sewn, `Segment '${sid}' is sewn by seam '${sewn?.id}', so it is not a fold`);
    const a = pt(p, fold.a), b = pt(p, fold.b), o = [a.x, a.y], u = unit([b.x - a.x, b.y - a.y]), onAxis = (q) => Math.abs((q.x - o[0]) * u[1] - (q.y - o[1]) * u[0]) < 1e-6;
    // A measurement of the fold itself is still the distance between its two ends.
    for (const c of d.constraints) if (c.pattern === pid && c.segments?.includes(sid)) { need(c.segments.length === 1, `Constraint '${c.id}' measures the fold together with other edges; redefine it first`); Object.assign(c, { type: 'distance', a: { pattern: pid, point: fold.a }, b: { pattern: pid, point: fold.b } }); delete c.pattern; delete c.segments; }
    const loop = p.contours[li], k = loop.indexOf(sid);
    p.contours[li] = [...loop.slice(k + 1), ...loop.slice(0, k)]; p.segments = p.segments.filter((q) => q.id !== sid); delete p.allowances?.[sid]; p.notches = (p.notches || []).filter((n) => n.segment !== sid);
    const P = new Map(p.points.map((q) => [q.id, q])), taken = idsOf(p.points), segmentIds = idsOf(p.segments);
    const pointName = new Map(p.points.map((q) => [q.id, onAxis(q) ? q.id : fresh(taken, `${q.id}_m`)])), segmentName = new Map(p.segments.map((q) => [q.id, fresh(segmentIds, `${q.id}_m`)]));
    const rp = (id) => pointName.get(id), rs = (id) => segmentName.get(id) ?? `${id}_m`, m = reflected(p, o, u, rp, rs);
    const offAxis = (l) => [...refsOf([internalSegment(l)])].some((id) => !onAxis(P.get(id)));
    p.internalLines = [...(p.internalLines || []), ...m.internalLines.filter((_, n) => offAxis(p.internalLines[n]))];
    p.points.push(...m.points.filter((q) => !P.has(q.id))); p.segments.push(...m.segments); p.allowances = { ...p.allowances, ...m.allowances }; p.notches.push(...m.notches);
    p.contours = p.contours.flatMap((own, n) => (n === li ? [[...own, ...m.contours[n]]] : [own, m.contours[n]]));
    const annotationIds = idsOf(d.annotations), seamIds = idsOf(d.seams);
    for (const an of d.annotations.filter((q) => q.pattern === pid)) { const lines = an.lines.map((pair) => pair.map(rp)); if (JSON.stringify(lines) !== JSON.stringify(an.lines)) d.annotations.push({ ...clone(an), id: fresh(annotationIds, `${an.id}_m`), lines }); }
    for (const g of d.grades) for (const r of g.rules.filter((q) => q.pattern === pid && rp(q.point) !== q.point)) g.rules.push({ pattern: pid, point: rp(r.point), ...reflectedDelta(r, u) });
    // The new half is sewn as the old one is, wherever the other edge has a mirrored twin too: its own darts at once, and a seam to
    // another piece as soon as that piece has been unfolded as well (its twin of side_seam is side_seam_m).
    const twin = (ref) => { const id = ref.pattern === pid ? segmentName.get(ref.segment) : `${ref.segment}_m`; return d.patterns.find((q) => q.id === ref.pattern)?.segments.some((q) => q.id === id) ? { pattern: ref.pattern, segment: id } : null; };
    const same = (x, y) => x.pattern === y.pattern && x.segment === y.segment, sewn2 = (ref) => ref.pattern !== pid && d.seams.some((q) => same(q.a, ref) || same(q.b, ref));
    for (const s of [...d.seams]) { if (s.a.pattern !== pid && s.b.pattern !== pid) continue; const ta = twin(s.a), tb = twin(s.b); if (ta && tb && !sewn2(ta) && !sewn2(tb)) d.seams.push(mirroredSeam(s, fresh(seamIds, `${s.id}_m`), ta, tb)); }
  },

  /** Cut a pattern in two along a straight line between two places on its outer edge. The two cut edges are sewn to each other, and
   *  every seam, measurement, graded size and mark follows the piece its edge ended up in. Points and segments keep their ids. */
  split(d, { pattern: pid, from, to, ids, names, allowance }) {
    const p = pat(d, pid), ctx = context(), x = vertexAt(d, p, from, ctx, { point: `${pid}_cut_a` }), y = vertexAt(d, p, to, ctx, { point: `${pid}_cut_b` });
    const { li, forward, back } = chains(p, x, y); needInside(p, li, x, y, 'The cut');
    const [idA, idB] = ids || [`${pid}_a`, `${pid}_b`]; need(idA !== idB && [idA, idB].every((id) => id === pid || !d.patterns.some((q) => q.id === id)), `The two pieces need two ids that are not in use: '${idA}', '${idB}'`);
    const polyA = polyline(p, forward), inA = (q) => insideLoop(polyA, q), P = new Map(p.points.map((q) => [q.id, q])), xy = (id) => [P.get(id).x, P.get(id).y];
    need(Math.abs(signedArea(polyA)) > 1e-3 && Math.abs(signedArea(polyline(p, back))) > 1e-3, `The cut from '${x}' to '${y}' runs along the edge and cuts nothing off`);
    const cut = fresh(idsOf(p.segments), `${pid}_cut`), mm = allowance ?? usualAllowance(p), loopsOf = [[forward], [back]];
    p.contours.forEach((loop, k) => { if (k !== li) loopsOf[inA(xy(seg(p, loop[0]).a)) ? 0 : 1].push(loop); });
    const middle = (l) => { const s = internalSegment(l), q = sampleSegment(p, s, 2); return s.type === 'line' ? [(q[0][0] + q[1][0]) / 2, (q[0][1] + q[1][1]) / 2] : q[1]; };
    const pieces = [idA, idB].map((id, k) => {
      const contours = loopsOf[k].map((loop, n) => (n ? loop : [...loop, cut])), own = new Set(contours.flat()), { placement, ...rest } = p;
      // Each half stays where the whole piece stood; it no longer has the piece's place on the body to itself.
      return { ...rest, id, name: names?.[k] || `${p.name || pid} ${'AB'[k]}`, contours, segments: [...p.segments.filter((s) => own.has(s.id)), { id: cut, type: 'line', a: k ? x : y, b: k ? y : x }],
        allowances: { ...Object.fromEntries(Object.entries(p.allowances || {}).filter(([sid]) => own.has(sid))), [cut]: mm }, notches: (p.notches || []).filter((n) => own.has(n.segment)), internalLines: (p.internalLines || []).filter((l) => inA(middle(l)) === !k) };
    });
    for (const a of d.annotations.filter((q) => q.pattern === pid)) { const [u, v] = a.lines[0].map(xy); a.pattern = pieces[inA([(u[0] + v[0]) / 2, (u[1] + v[1]) / 2]) ? 0 : 1].id; }
    const refs = pieces.map((piece) => new Set([...refsOf([...piece.segments, ...piece.internalLines.map(internalSegment)]), ...d.annotations.filter((a) => a.pattern === piece.id).flatMap((a) => a.lines.flat())]));
    pieces.forEach((piece, k) => { piece.points = p.points.filter((q) => refs[k].has(q.id) || (!refs[1 - k].has(q.id) && inA([q.x, q.y]) === !k)); });
    const has = (k, kind, id) => pieces[k][kind].some((q) => q.id === id), home = (kind, id) => pieces[has(0, kind, id) ? 0 : 1].id;
    for (const s of d.seams) for (const side of [s.a, s.b]) if (side.pattern === pid) side.pattern = home('segments', side.segment);
    for (const c of d.constraints) {
      if (c.type === 'distance') { for (const side of [c.a, c.b]) if (side.pattern === pid) side.pattern = home('points', side.point); continue; }
      if (c.pattern !== pid) continue;
      const list = c.segments || p.contours[c.contour] || [], k = [0, 1].find((n) => list.every((sid) => has(n, 'segments', sid)));
      need(k != null, `Constraint '${c.id}' measures edges on both sides of the cut; redefine it first`);
      c.pattern = pieces[k].id; c.segments = [...list]; delete c.contour;
    }
    for (const g of d.grades) g.rules = g.rules.flatMap((r) => (r.pattern !== pid ? [r] : pieces.filter((piece) => piece.points.some((q) => q.id === r.point)).map((piece) => ({ ...r, pattern: piece.id }))));
    for (const a of d.attachments) if (a.pattern === pid) a.pattern = pieces[inA(a.at) ? 0 : 1].id;
    d.arrangement = d.arrangement.flatMap((a) => { if (a.pattern !== pid) return [a]; const { source, ...row } = a; return pieces.map((piece) => ({ ...clone(row), pattern: piece.id })); });
    d.patterns.splice(d.patterns.indexOf(p), 1, ...pieces);
    // In one piece the cut runs from y to x and in the other from x to y, so the same places meet when the seam is flipped.
    d.seams.push({ id: fresh(idsOf(d.seams), cut), a: { pattern: idA, segment: cut }, b: { pattern: idB, segment: cut }, flip: true, ease: 0, kind: 'plain', correspondence: [] });
  },

  /** A sewn dart: a wedge of the given width at the edge and length into the piece is taken out of the outline, and its two legs are sewn
   *  to each other. What the edge is sewn to is sewn on either side of the dart. The dart annotation stays for the drawing. */
  dart(d, { pattern: pid, segment: sid, at = 0.5, width, length, apex, id }) {
    const p = pat(d, pid), s = seg(p, sid), edge = segmentLength(p, s), f1 = at - width / 2 / edge, f2 = at + width / 2 / edge;
    need(positive(width) && (apex != null || positive(length)), 'A dart needs a width, and a length or an apex [x, y]');
    need(f1 * edge > 1e-3 && (1 - f2) * edge > 1e-3, `A ${width} mm dart at ${at} does not fit on '${sid}', which is ${edge.toFixed(1)} mm long`);
    const name = fresh(idsOf(d.annotations, d.seams), id || `${sid}_dart`), mm = p.allowances?.[sid], { normal } = inward(p, s, at), ctx = context();
    const taken = idsOf(p.points), segmentIds = idsOf(p.segments), [pa, pb, tip] = ['a', 'b', 'apex'].map((k) => fresh(taken, `${name}_${k}`)), after = fresh(segmentIds, `${sid}_2`), mouth = fresh(segmentIds, `${name}_mouth`), legs = ['a', 'b'].map((k) => fresh(segmentIds, `${name}_leg_${k}`));
    splitGeom(d, p, sid, f2, pb, after); splitGeom(d, p, sid, f1 / f2, pa, mouth);
    const A = pt(p, pa), B = pt(p, pb); let n = unit([-(B.y - A.y), B.x - A.x]); if (n[0] * normal[0] + n[1] * normal[1] < 0) n = [-n[0], -n[1]];
    const at2 = apex != null ? apex.map(Number) : [(A.x + B.x) / 2 + n[0] * length, (A.y + B.y) / 2 + n[1] * length];
    need(at2.length === 2 && at2.every(Number.isFinite) && inside(p, at2), `The apex of dart '${name}' falls outside the material of '${pid}'`);
    // The two legs are sewn to each other, so they must be the same length: an apex off the centre line is taken up as ease, within reason.
    const la = Math.hypot(A.x - at2[0], A.y - at2[1]), lb = Math.hypot(B.x - at2[0], B.y - at2[1]), mismatch = Math.abs(la - lb) / Math.max(la, lb);
    need(mismatch <= 0.05, `The legs of dart '${name}' would be ${la.toFixed(1)} and ${lb.toFixed(1)} mm; move the apex nearer its centre line`);
    const curve = seg(p, mouth), handles = [curve.c1, curve.c2].filter(Boolean);
    p.points.push({ id: tip, x: at2[0], y: at2[1] }); gradeBetween(d, pid, tip, pa, pb, 0.5);
    p.segments = p.segments.filter((q) => q.id !== mouth); p.segments.push({ id: legs[0], type: 'line', a: pa, b: tip }, { id: legs[1], type: 'line', a: tip, b: pb });
    p.contours = p.contours.map((loop) => loop.flatMap((q) => (q === mouth ? legs : [q])));
    p.notches = (p.notches || []).filter((q) => q.segment !== mouth); if (p.allowances) delete p.allowances[mouth];
    // A leg's allowance is the allowance across the dart's mouth: the cut runs straight over a sewn dart (see patternDXF).
    if (mm != null) for (const leg of legs) p.allowances[leg] = mm;
    for (const c of d.constraints) if (c.pattern === pid && c.segments) c.segments = c.segments.filter((q) => q !== mouth);
    dropUnused(d, p, handles);
    d.seams.push({ id: name, a: { pattern: pid, segment: legs[0] }, b: { pattern: pid, segment: legs[1] }, flip: true, ease: mismatch > 1e-9 ? Math.ceil(mismatch * 1e4) / 1e4 : 0, kind: 'dart', correspondence: [] });
    d.annotations.push({ id: name, type: 'dart', pattern: pid, lines: [[pa, tip], [tip, pb]] });
    // Once the dart is sewn its mouth is one place on the edge: whatever the edge was sewn to is cut there too, and sewn on either side.
    ctx.stack.push(`${pid}/${sid}`); reseam(d, pid, sid, at, sid, after, ctx);
  },

  /** A knife or box pleat: the piece is slashed straight across from a place on an edge and spread by the intake, the extra cloth is
   *  marked with its fold lines, and its halves are sewn to each other at the edge so the edge is as long as it was. */
  pleat(d, { pattern: pid, segment: sid, at = 0.5, intake, kind = 'knife', to, id, bothEnds = false }) {
    need(positive(intake), 'A pleat needs an intake in mm'); need(kind === 'knife' || kind === 'box', "A pleat's kind is 'knife' or 'box'");
    const p = pat(d, pid), s = seg(p, sid), ctx = context(), name = fresh(idsOf(d.annotations, d.seams), id || `${sid}_pleat`), mm = p.allowances?.[sid], { at: origin, normal } = inward(p, s, at);
    const x = vertexAt(d, p, { segment: sid, at }, ctx, { point: `${name}_a` });
    const y = to != null ? vertexAt(d, p, to, ctx, { point: `${name}_far_a` }) : (() => { const hit = across(p, origin, normal); ctx.handled = new Set(); return splitAt(d, pid, hit.segment, hit.at, ctx, { point: `${name}_far_a` }).point; })();
    const X = { ...pt(p, x) }, Y = { ...pt(p, y) }, { forward } = chains(p, x, y), side = Math.sign(signedArea(polyline(p, forward))) || 1, across2 = unit([Y.x - X.x, Y.y - X.y]);
    // The moved side lies to the right of the slash when the outline runs counter-clockwise: it moves that way, square to the slash.
    const shift = [side * across2[1] * intake, -side * across2[0] * intake];
    const cutEdge = spread(d, p, x, y, (px, py) => [px + shift[0], py + shift[1]], [`${name}_b`, `${name}_far_b`]);
    const n = kind === 'box' ? 4 : 2, taken = idsOf(p.points), segmentIds = idsOf(p.segments), seamIds = idsOf(d.seams); p.allowances ||= {};
    // The extra cloth at one edge, as n equal segments from one side of the slash to the other, with a point at every fold.
    const strip = (from, end, base, allowance) => {
      const A = pt(p, from), B = pt(p, end), points = [from], segments = [];
      for (let k = 1; k <= n; k++) {
        const b = k === n ? end : fresh(taken, `${base}_fold_${k}`), sidK = fresh(segmentIds, `${base}_${k}`);
        if (k < n) { p.points.push({ id: b, x: A.x + (B.x - A.x) * k / n, y: A.y + (B.y - A.y) * k / n }); gradeBetween(d, pid, b, from, end, k / n); }
        p.segments.push({ id: sidK, type: 'line', a: points.at(-1), b }); if (allowance != null) p.allowances[sidK] = allowance; points.push(b); segments.push(sidK);
      }
      return { points, segments };
    };
    const near = strip(x, cutEdge.x2, name, mm), far = strip(cutEdge.y2, y, `${name}_far`, p.allowances[cutEdge.forward.at(-1)]);
    p.contours[cutEdge.li] = [...cutEdge.forward, ...far.segments, ...cutEdge.back, ...near.segments];
    // Each fold is sewn shut at the edge: a knife pleat folds the intake in half, a box pleat folds each half in half towards the middle.
    const sew = (segments, base) => { for (let k = 0; k < n; k += 2) d.seams.push({ id: fresh(seamIds, n > 2 ? `${base}_${k / 2 + 1}` : base), a: { pattern: pid, segment: segments[k] }, b: { pattern: pid, segment: segments[k + 1] }, flip: true, ease: 0, kind: 'pleat', correspondence: [] }); };
    sew(near.segments, name); if (bothEnds) sew(far.segments, `${name}_far`);
    d.annotations.push({ id: name, type: 'pleat', pattern: pid, lines: near.points.map((q, k) => [q, far.points[n - k]]) });
  },

  /** Add fullness: slash from a place on the outline to a pivot on the far edge and open the slash by an angle (degrees) or by a distance
   *  at its open end. The pivot edge keeps its length; the opened edge gains an arc about the pivot. */
  slashSpread(d, { pattern: pid, from, pivot, angle, distance, id }) {
    const p = pat(d, pid), ctx = context(), gap = fresh(idsOf(p.segments), id || `${pid}_spread`);
    need((angle != null) !== (distance != null), 'Open the slash by an angle in degrees or by a distance in mm, one of the two');
    const x = vertexAt(d, p, from, ctx, { point: `${gap}_a` }), y = vertexAt(d, p, pivot, ctx, { point: `${gap}_pivot` }), X = { ...pt(p, x) }, Y = { ...pt(p, y) }, r = Math.hypot(X.x - Y.x, X.y - Y.y);
    const theta = angle != null ? angle * Math.PI / 180 : 2 * Math.asin(distance / (2 * r)); need(theta > 0 && theta < Math.PI, 'The slash opens by more than nothing and less than a half turn');
    // Counter-clockwise about the pivot opens the slash when the outline runs counter-clockwise.
    const { forward, back } = chains(p, x, y), turn = (Math.sign(signedArea(polyline(p, forward))) || 1) * theta, cos = Math.cos(turn), sin = Math.sin(turn), mm = p.allowances?.[back.at(-1)];
    const cutEdge = spread(d, p, x, y, (px, py) => [Y.x + (px - Y.x) * cos - (py - Y.y) * sin, Y.y + (px - Y.x) * sin + (py - Y.y) * cos], [`${gap}_b`, `${gap}_pivot_b`]);
    // An arc runs counter-clockwise from a to b; where the slash opens the other way the gap is closed with a straight line.
    p.segments.push(turn > 0 ? { id: gap, type: 'arc', a: x, b: cutEdge.x2, c: y } : { id: gap, type: 'line', a: x, b: cutEdge.x2 });
    if (mm != null) p.allowances[gap] = mm;
    p.contours[cutEdge.li] = [...forward, ...back, gap];
  },

  /** Draw a line on a piece: a stitch line, a pocket placement, a fold. Ends and handles are point ids, or [x, y] for a new point. */
  internalLine(d, { pattern: pid, id, a, b, c, c1, c2, remove = false }) {
    const p = pat(d, pid); p.internalLines ||= [];
    if (remove) { need(p.internalLines.some((l) => l.id === id), `Pattern '${pid}' has no internal line '${id}'`); p.internalLines = p.internalLines.filter((l) => l.id !== id); return; }
    need(id == null || !p.internalLines.some((l) => l.id === id), `Pattern '${pid}' already has an internal line '${id}'`);
    const name = fresh(idsOf(p.internalLines.filter((l) => l.id != null)), id || `${pid}_line`), taken = idsOf(p.points);
    const ref = (v, key) => { if (typeof v === 'string') return pt(p, v).id; need(Array.isArray(v) && v.length === 2 && v.every(Number.isFinite), `Internal line ${key} is a point id or [x, y]`); const q = fresh(taken, `${name}_${key}`); p.points.push({ id: q, x: v[0], y: v[1] }); return q; };
    need(c == null || (c1 == null && c2 == null), 'An internal line is an arc (c) or a bezier (c1 and c2), not both'); need((c1 == null) === (c2 == null), 'A bezier needs both c1 and c2');
    p.internalLines.push({ id: name, type: c != null ? 'arc' : c1 != null ? 'bezier' : 'line', a: ref(a, 'a'), b: ref(b, 'b'), ...(c != null ? { c: ref(c, 'c') } : c1 != null ? { c1: ref(c1, 'c1'), c2: ref(c2, 'c2') } : {}) });
  },

  /** Matched notches on both sides of every seam: at its ends, and at the given fractions or every so many mm along side a. The other side's
   *  notch is where the seam's correspondence puts that place, so the two still meet when one side is eased or gathered. Asking twice adds nothing. */
  autoNotch(d, { seams, fractions = [0.5], every, ends = true, depth = 4 }) {
    for (const id of seams || []) need(d.seams.some((s) => s.id === id), `No seam '${id}'`);
    need(every == null || positive(every), 'every is a spacing in mm'); need(fractions.every((f) => f >= 0 && f <= 1), 'fractions are between 0 and 1');
    const notch = (p, s, f) => { const at = +paramAt(p, s, f).toFixed(6); p.notches ||= []; if (!p.notches.some((n) => n.segment === s.id && Math.abs((n.at ?? 0.5) - at) < 1e-4)) p.notches.push({ segment: s.id, at, depth, kind: 'seam' }); };
    for (const s of d.seams) {
      // ponytail: a dart is not notched unless asked for by name; its notches belong on the mouth, which the outline no longer has.
      if (seams ? !seams.includes(s.id) : s.kind === 'dart') continue;
      const A = pat(d, s.a.pattern), B = pat(d, s.b.pattern), sa = seg(A, s.a.segment), sb = seg(B, s.b.segment), length = segmentLength(A, sa);
      const along = every ? Array.from({ length: Math.max(0, Math.ceil(length / every - 1e-9) - 1) }, (_, k) => (k + 1) * every / length) : fractions;
      for (const f of [...(ends ? [0, 1] : []), ...along]) { notch(A, sa, f); notch(B, sb, seamFraction(s, f)); }
    }
  },
};

export const SOFTGOODS_EDITS = Object.keys(OPS);

/** Apply one pattern-making operation, named by op, to a document. Returns the new document; the one passed in is left as it was. */
export function editSoftgoods(document, { op, ...args } = {}) {
  need(Object.hasOwn(OPS, op), `Unknown softgoods edit '${op}': use one of ${SOFTGOODS_EDITS.join(', ')}`);
  const d = validateSoftgoodsDocument(document); OPS[op](d, args); return validateSoftgoodsDocument(d);
}
export const { mirror, unfold, split, dart, pleat, slashSpread, internalLine, autoNotch } = Object.fromEntries(SOFTGOODS_EDITS.map((op) => [op, (document, args) => editSoftgoods(document, { ...args, op })]));

/** What an edit made and took away, by id, so the next prompt can name the new parts without reading the whole design back. */
export function editChanges(before, after) {
  const ids = (list) => (list || []).map((q) => q.id), extra = (a, b) => { const had = new Set(ids(a)); return ids(b).filter((id) => !had.has(id)); }, out = { added: {}, removed: {} };
  const note = (where, key, list, pattern) => { if (list.length) { if (pattern) (out[where][key] ||= {})[pattern] = list; else out[where][key] = list; } };
  for (const key of ['patterns', 'seams', 'annotations']) { note('added', key, extra(before[key], after[key])); note('removed', key, extra(after[key], before[key])); }
  for (const p of after.patterns) { const was = before.patterns.find((q) => q.id === p.id) || {}; for (const key of ['segments', 'points']) { note('added', key, extra(was[key], p[key]), p.id); if (was.id) note('removed', key, extra(p[key], was[key]), p.id); } }
  return out;
}
