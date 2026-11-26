// Trims and hardware as parts of the softgoods design: zippers, buttons and buttonholes, snaps, rivets and eyelets,
// buckles and D-rings, hook-and-loop, webbing, binding and piping, topstitching, elastic and drawcords, labels.
// A trim is placed on the 2D pattern by ids, never by array positions, and everything here is derived from that
// placement: its real length, where every mark lands, what the cutter's file shows, what the bill buys.
//
// Ways to place one:
//   at       one spot: { pattern, u, v } in pattern mm, { pattern, point }, or { pattern, segment, t, inset }
//   along    a run of edges, measured as one length. Each entry is a seam side (softgoods-seams.js seamSide): { pattern, segment, from?, to? }
//            or { pattern, segments: [...], from?, to? }; or { pattern, contour } for a whole outline
//   path     a line on a piece: { pattern, points: [point id | [x, y], ...], closed? }, or { pattern, line } for one of its internal lines by id
//   elastic  (an elastic only) the id of the design's own elastic: an entry of elastics[] or a seam with elastic. The cloth preview
//            gathers by that entry's ratio, so the trim does not carry a second one: it adds what is bought (width, cut length, price)
// A point trim (button, snap, rivet...) takes `at`, or `along` with a count or a pitch for a row of them. A length
// trim (zipper, binding, webbing, topstitch...) takes `along` or `path`. `mate` is the other half on another edge or
// spot: the buttonholes of a button row, the socket of a snap, the second side of a zipper.
//
// NOTHING IN THE TABLES BELOW IS MEASURED. Seam allowances, zipper tape widths and stiffness are typical shop figures,
// good enough to start a tech pack and to warn about an allowance that is plainly too small. A trim's own spec wins.

import { GraphError } from './errors.js';
import { sampleSegment } from './softgoods-export.js';
import { seamSide, seamSideLabel, resolveSeamCorrespondence } from './softgoods-seams.js';
import { patternSVG } from './softgoods-print.js';
import { FABRICS } from './softgoods-fabrics.js';

const ID = /^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/;
const SOURCE = 'typical, not measured';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const round = (v, digits = 2) => +v.toFixed(digits);
const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
const lengthOf = (q) => q.slice(1).reduce((n, p, i) => n + dist(q[i], p), 0);
const isClosed = (q) => q.length > 3 && dist(q[0], q.at(-1)) < 1e-6;

/**
 * The seam vocabulary. A seam's kind stays a free string; a kind listed here also has a number of stitch rows (the
 * thread estimate is seam length × rows × the thread multiplier), a usual allowance, and the least allowance the
 * construction can be sewn with, which checkDesign warns below.
 */
export const SEAM_KINDS = Object.freeze({
  plain: { rows: 1, allowance: 10, min: 6, note: 'right sides together, one row' },
  overlock: { rows: 1, allowance: 6, min: 4, note: 'trimmed and wrapped in one pass; give threadMultiplier about 14 for a four-thread overlock' },
  gather: { rows: 1, allowance: 10, min: 6, note: 'the longer side drawn up to the shorter' },
  elastic: { rows: 1, allowance: 10, min: 6, note: 'sewn stretched; the sides differ on purpose' },
  'flat-felled': { rows: 2, allowance: 15, min: 10, note: 'one allowance wrapped over the other and stitched down: jeans, shirts' },
  french: { rows: 2, allowance: 12, min: 10, note: 'sewn wrong sides together, trimmed, turned and sewn again' },
  lapped: { rows: 2, allowance: 10, min: 6, note: 'one edge laid over the other and stitched through both' },
  bound: { rows: 1, allowance: 6, min: 4, note: 'both allowances wrapped in a binding' },
  topstitched: { rows: 2, allowance: 10, min: 8, note: 'a plain seam with one row stitched beside it through the allowances' },
  'double-topstitched': { rows: 3, allowance: 10, min: 8, note: 'a plain seam with a row either side' },
});

/** Whole tape width mm of a closed zipper by chain size. Typical, not measured: spec.tapeWidth wins. */
export const ZIPPER_TAPE = Object.freeze({ 3: 25, 5: 32, 8: 38, 10: 40 });

/** What each kind of trim is: a mark at a spot or a length along something, and what its mate is called. */
export const TRIM_KINDS = Object.freeze({
  button: { place: 'point', mate: 'buttonhole' }, snap: { place: 'point', mate: 'socket' },
  rivet: { place: 'point' }, eyelet: { place: 'point' }, grommet: { place: 'point' }, label: { place: 'point' }, 'd-ring': { place: 'point' }, buckle: { place: 'point' },
  zipper: { place: 'length', mate: 'second side' }, 'hook-and-loop': { place: 'length', mate: 'loop side' },
  binding: { place: 'length' }, piping: { place: 'length' }, elastic: { place: 'length' }, drawcord: { place: 'length' }, topstitch: { place: 'length' }, webbing: { place: 'length' },
});
// The kinds that hold two things together. One with a mate is closed in the cloth preview unless it says closed: false (a jacket
// worn open); any other trim with a mate is closed only when it says closed: true.
const CLOSURES = ['zipper', 'hook-and-loop', 'button', 'snap'];
const shut = (trim) => trim.mate != null && (trim.closed ?? CLOSURES.includes(trim.kind));
// A kind that is not listed is a piece of hardware at a spot (a cord lock, a toggle, a hook), with an optional mate.
const HARDWARE = { place: 'point', mate: 'mate' };
const FIELDS = ['id', 'kind', 'name', 'spec', 'qty', 'supplier', 'partNumber', 'unitPrice', 'pricePerMeter', 'at', 'along', 'path', 'elastic', 'mate', 'flip', 'closed', 'count', 'pitch', 'margin', 'inset', 'mateInset', 'length', 'hardware', 'notes'];
const POSITIVE = ['diameter', 'width', 'height', 'tapeWidth', 'finishedWidth', 'flange', 'stitchLength', 'spacing', 'buttonholeLength'];
const NON_NEGATIVE = ['thickness', 'overlap', 'cornerAllowance', 'bartackInset', 'allowance', 'mass', 'massPerMeter', 'rigidity'];

// ---- geometry -------------------------------------------------------------------------------------------------

/** The point s mm along a polyline, the unit direction there, and the index of the vertex that ends its stretch. */
function walk(q, s) {
  let i = 1, done = 0;
  while (i < q.length - 1 && done + dist(q[i - 1], q[i]) < s) { done += dist(q[i - 1], q[i]); i++; }
  const l = dist(q[i - 1], q[i]) || 1, d = [(q[i][0] - q[i - 1][0]) / l, (q[i][1] - q[i - 1][1]) / l], t = Math.max(0, Math.min(l, s - done));
  return { p: [q[i - 1][0] + d[0] * t, q[i - 1][1] + d[1] * t], d, i };
}
function span(q, from, to) {
  if (from <= 0 && to >= 1) return q;
  const L = lengthOf(q), a = walk(q, from * L), b = walk(q, to * L);
  return [a.p, ...q.slice(a.i, b.i), b.p].filter((p, i, all) => !i || dist(all[i - 1], p) > 1e-9);
}
/** A polyline moved d mm to its left, mitred at the corners (closed when its ends meet). */
function offsetChain(q, d) {
  if (!d) return q;
  const closed = isClosed(q), pts = closed ? q.slice(0, -1) : q, n = pts.length, normal = (a, b) => { const l = dist(a, b) || 1; return [-(b[1] - a[1]) / l, (b[0] - a[0]) / l]; };
  const out = pts.map((p, i) => {
    const prev = closed ? pts[(i - 1 + n) % n] : pts[i - 1], next = closed ? pts[(i + 1) % n] : pts[i + 1], a = prev ? normal(prev, p) : normal(p, next), b = next ? normal(p, next) : a;
    const k = d / Math.max(0.25, 1 + a[0] * b[0] + a[1] * b[1]);      // the mitre, limited where an edge doubles back
    return [round(p[0] + (a[0] + b[0]) * k, 4), round(p[1] + (a[1] + b[1]) * k, 4)];
  });
  if (closed) out.push(out[0]);
  return out;
}
/** Turns sharper than 30° along a polyline: the corners a binding has to be mitred or eased around. */
function cornersOf(q) {
  const closed = isClosed(q), pts = closed ? q.slice(0, -1) : q, n = pts.length; let count = 0;
  for (let i = closed ? 0 : 1; i < (closed ? n : n - 1); i++) {
    const a = pts[(i - 1 + n) % n], b = pts[i], c = pts[(i + 1) % n], u = [b[0] - a[0], b[1] - a[1]], v = [c[0] - b[0], c[1] - b[1]];
    if (Math.abs(Math.atan2(u[0] * v[1] - u[1] * v[0], u[0] * v[0] + u[1] * v[1])) > Math.PI / 6) count++;
  }
  return count;
}
function patternOf(document, id, what) { const p = document.patterns.find((q) => q.id === id); if (!p) throw new GraphError(`${what} refers to missing pattern '${id}'`); return p; }
/** +1 when the material lies to the left of a segment as it is drawn, -1 when to the right. */
function inward(pattern, segmentId) {
  const i = (pattern.contours || []).findIndex((loop) => loop.includes(segmentId)); if (i < 0) return 1;
  const q = pattern.contours[i].flatMap((id) => sampleSegment(pattern, pattern.segments.find((s) => s.id === id), 16)), area = q.reduce((n, p, k) => n + p[0] * q[(k + 1) % q.length][1] - q[(k + 1) % q.length][0] * p[1], 0);
  return (area >= 0 ? 1 : -1) * (i ? -1 : 1);      // ponytail: contour 0 is taken as the outline and the rest as holes; test containment (as cutContours does) if nested islands appear
}
const segmentsOf = (document, refs) => refs.flatMap((r) => (r.contour != null ? document.patterns.find((p) => p.id === r.pattern)?.contours?.[r.contour] || [] : seamSide(r).segments).map((segment) => ({ pattern: r.pattern, segment })));

/** A run of edges as polylines in pattern mm. Edges that meet end to end on one piece are one chain. */
function runOf(document, refs, what) {
  if (!Array.isArray(refs) || !refs.length) throw new GraphError(`${what} needs a list of edges: [{ pattern, segment, from?, to? }], [{ pattern, segments: [...] }] or [{ pattern, contour }]`);
  const chains = [];
  for (const ref of refs) {
    const p = patternOf(document, ref?.pattern, what), whole = ref.contour != null, side = seamSide(ref), ids = whole ? p.contours?.[ref.contour] : side.segments;
    if (!ids) throw new GraphError(`${what} refers to missing contour ${ref.contour} of '${p.id}'`);
    if (whole && (ref.segment != null || ref.segments != null || ref.from != null || ref.to != null)) throw new GraphError(`${what} names a whole contour of '${p.id}': leave segment, segments, from and to out`);
    if (!ids.length) throw new GraphError(`${what} needs a segment, segments or a contour of '${p.id}'`);
    if (ref.segment != null && ref.segments != null) throw new GraphError(`${what} names segment or segments on '${p.id}', not both`);
    // As for a seam side: from is a fraction of the first segment's length, to of the last one's.
    if (!(side.from >= 0 && side.from < 1 && side.to > 0 && side.to <= 1) || (ids.length === 1 && side.from >= side.to)) throw new GraphError(`${what} from and to on '${p.id}.${ids[0]}' must be fractions 0..1 of its first and last segment, from before to`);
    ids.forEach((sid, k) => {
      const s = p.segments.find((q) => q.id === sid); if (!s) throw new GraphError(`${what} refers to missing segment '${p.id}.${sid}'`);
      if (!whole && k && p.segments.find((q) => q.id === ids[k - 1]).b !== s.a) throw new GraphError(`${what} segments '${ids[k - 1]}' and '${sid}' do not follow one another along the outline`);
      const points = span(sampleSegment(p, s, 64), whole || k ? 0 : side.from, whole || k < ids.length - 1 ? 1 : side.to), sign = inward(p, sid), last = chains.at(-1);
      if (last && last.pattern === p.id && last.sign === sign && dist(last.points.at(-1), points[0]) < 1e-6) last.points.push(...points.slice(1)); else chains.push({ pattern: p.id, sign, points: [...points] });
    });
  }
  return { chains, length: chains.reduce((n, c) => n + lengthOf(c.points), 0) };
}
function pathRun(document, path, what) {
  const p = patternOf(document, path?.pattern, what);
  if ((path.line != null) === (path.points != null)) throw new GraphError(`${what} path is { pattern, points: [...] } or { pattern, line: '<internal line id>' }`);
  if (path.line != null) {
    const l = (p.internalLines || []).find((q) => !Array.isArray(q) && q.id === path.line); if (!l) throw new GraphError(`${what} path refers to missing internal line '${p.id}.${path.line}' (only an internal line with an id can be named)`);
    const points = sampleSegment(p, l, 64); return { chains: [{ pattern: p.id, sign: 1, points }], length: lengthOf(points) };
  }
  if (!Array.isArray(path.points) || path.points.length < 2) throw new GraphError(`${what} path needs at least two points`);
  const points = path.points.map((q) => {
    if (typeof q === 'string') { const hit = p.points.find((x) => x.id === q); if (!hit) throw new GraphError(`${what} path refers to missing point '${p.id}.${q}'`); return [hit.x, hit.y]; }
    if (!Array.isArray(q) || q.length !== 2 || !q.every(finite)) throw new GraphError(`${what} path points are point ids or [x, y] in pattern mm`);
    return q;
  });
  if (path.closed) points.push(points[0]);
  return { chains: [{ pattern: p.id, sign: 1, points }], length: lengthOf(points) };
}
/** The spot s mm along a run, moved `inset` mm into the material. angle is the edge's direction there, degrees. */
function onRun(run, s, inset = 0) {
  for (const c of run.chains) {
    const l = lengthOf(c.points);
    if (s <= l + 1e-9 || c === run.chains.at(-1)) { const { p, d } = walk(c.points, s), k = c.sign * inset; return { pattern: c.pattern, x: round(p[0] - d[1] * k, 3), y: round(p[1] + d[0] * k, 3), angle: round(Math.atan2(d[1], d[0]) * 180 / Math.PI, 2) }; }
    s -= l;
  }
}
function spot(document, at, what) {
  const p = patternOf(document, at?.pattern, what);
  if (at.point != null) { const q = p.points.find((x) => x.id === at.point); if (!q) throw new GraphError(`${what} refers to missing point '${p.id}.${at.point}'`); return { pattern: p.id, x: q.x, y: q.y, angle: 0 }; }
  if (at.segment != null) {
    const run = runOf(document, [{ pattern: p.id, segment: at.segment }], what), t = at.t ?? 0.5;
    if (!(finite(t) && t >= 0 && t <= 1) || (at.inset != null && !finite(at.inset))) throw new GraphError(`${what} on '${p.id}.${at.segment}' needs t between 0 and 1 and a finite inset`);
    return { ...onRun(run, t * run.length, at.inset ?? 0), t };
  }
  if (!finite(at.u) || !finite(at.v)) throw new GraphError(`${what} needs a spot: { pattern, u, v } in pattern mm, { pattern, point } or { pattern, segment, t, inset }`);
  return { pattern: p.id, x: at.u, y: at.v, angle: 0 };
}

/**
 * Where a row of marks sits on a span of `length` mm, as distances from its start.
 * count alone spreads them evenly with half a pitch at each end; pitch alone fits as many as the span holds, centred.
 * margin (one number, or [start, end]) fixes the first mark that far from the start: count then spreads the rest to
 * the far margin, pitch steps from it.
 */
export function rowSpacing(length, { count, pitch, margin } = {}) {
  if (count == null && pitch == null) throw new GraphError('A row of marks needs a count or a pitch');
  if (count != null && !(Number.isInteger(count) && count > 0)) throw new GraphError('count must be a whole number, at least 1');
  if (pitch != null && !(finite(pitch) && pitch > 0)) throw new GraphError('pitch must be a positive length in mm');
  const m = margin == null ? null : Array.isArray(margin) ? margin : [margin, margin];
  if (m && !(m.length === 2 && m.every((v) => finite(v) && v >= 0))) throw new GraphError('margin must be one length or [start, end], zero or more');
  const usable = length - (m ? m[0] + m[1] : 0);
  if (!(usable >= 0)) throw new GraphError(`The margins (${m.join(' + ')} mm) are longer than the ${round(length)} mm edge`);
  const n = count ?? (m ? Math.floor(usable / pitch + 1e-9) + 1 : Math.max(1, Math.floor(length / pitch + 1e-9)));
  const p = pitch ?? (!m ? length / n : n > 1 ? usable / (n - 1) : 0);
  const start = m && (pitch != null || n > 1) ? m[0] : (m ? m[0] : 0) + (usable - (n - 1) * p) / 2;
  if (start < -1e-9 || start + (n - 1) * p > length - (m ? m[1] : 0) + 1e-9) throw new GraphError(`${n} marks at ${round(p)} mm pitch need ${round((n - 1) * p + (m ? m[0] + m[1] : 0))} mm; the edge has ${round(length)} mm`);
  return { count: n, pitch: p, at: Array.from({ length: n }, (_, i) => start + i * p) };
}

/** The design's own elastic a trim points at: where it runs and the ratio the cloth preview gathers it by. */
function elasticRun(document, trim, what) {
  const e = (document.elastics || []).find((q) => q.id === trim.elastic), seam = e ? null : (document.seams || []).find((q) => q.id === trim.elastic && q.elastic);
  if (!e && !seam) throw new GraphError(`${what} refers to missing elastic '${trim.elastic}': the id of an elastics[] entry or of a seam with elastic`);
  if (e) return { run: e.line ? pathRun(document, { pattern: e.pattern, ...(Array.isArray(e.line) ? { points: e.line } : { line: e.line }) }, what) : runOf(document, [{ pattern: e.pattern, segment: e.segment }], what), ratio: Number(e.ratio), centred: !!e.line };
  // An elastic seam relaxes to its ratio of the shorter side.
  const [a, b] = [seam.a, seam.b].map((side) => runOf(document, [side], what));
  return { run: a.length <= b.length ? a : b, ratio: Number(seam.elastic.ratio) };
}
/**
 * An elastic trim drawn on one whole edge, or between two points, with its own spec.ratio is something the cloth preview can gather:
 * the elastics[] entry for it, so the document can keep the ratio there, once. null for any other trim.
 */
export function elasticEntry(trim) {
  if (trim?.kind !== 'elastic' || trim.spec?.ratio == null || trim.elastic != null) return null;
  const edge = trim.along?.length === 1 ? trim.along[0] : null, line = trim.path?.points?.length === 2 && trim.path.points.every((q) => typeof q === 'string') && !trim.path.closed ? trim.path.points : null;
  if (edge && edge.segment != null && edge.from == null && edge.to == null) return { id: trim.id, pattern: edge.pattern, segment: edge.segment, ratio: trim.spec.ratio };
  return line ? { id: trim.id, pattern: trim.path.pattern, line, ratio: trim.spec.ratio } : null;
}

const chainSize = (spec) => (spec.chain == null ? null : Number(String(spec.chain).replace(/^#/, '')));
/** The tape of one side of a zipper beyond its teeth, mm: what lies under the seam allowance. null when nothing says how wide the tape is. */
function tapeSide(spec) { const chain = chainSize(spec), tape = spec.tapeWidth ?? ZIPPER_TAPE[chain]; return tape == null ? null : (tape - (chain || 0)) / 2; }
/** The strip a length trim covers, as two offsets from its line (+ into the material from an edge; centred on a line drawn on the piece). */
function bandOf(trim, centred) {
  const s = trim.spec || {}, offset = s.offset ?? 0, w = s.width ?? 10;
  if (trim.kind === 'zipper') return [-(tapeSide(s) ?? 12), 0];      // the tape lies under the allowance, outside the stitch line
  if (trim.kind === 'piping') return [-(s.flange ?? 10), 0];
  if (trim.kind === 'binding') return [0, s.finishedWidth ?? 10];
  return centred ? [offset - w / 2, offset + w / 2] : [offset, offset + w];
}

/**
 * Everything derived from one trim's placement, in pattern mm.
 * A point trim: positions (and mate, index for index, at matching fractions of their edges), pitchMm, count.
 * A length trim: lengthMm as measured, cutLengthMm as bought or cut, mateLengthMm for a second side, and the chains.
 */
export function trimGeometry(document, trim) {
  const what = `Trim '${trim.id}'`, def = TRIM_KINDS[trim.kind] || HARDWARE, spec = trim.spec || {}, cut = (id) => patternOf(document, id, what).cut || 1, g = { id: trim.id, kind: trim.kind, place: def.place };
  if (def.place === 'point') {
    if (trim.along) {
      const run = runOf(document, trim.along, what); let row;
      try { row = rowSpacing(run.length, trim); } catch (e) { throw new GraphError(`${what}: ${e.message}`); }
      const inset = trim.inset ?? 0;
      g.positions = row.at.map((s) => ({ ...onRun(run, s, inset), t: round(s / run.length, 5) })); g.pitchMm = round(row.pitch);
      if (trim.mate) {
        const other = runOf(document, trim.mate, `${what} mate`);
        g.mate = row.at.map((s) => { const t = trim.flip ? 1 - s / run.length : s / run.length; return { ...onRun(other, t * other.length, trim.mateInset ?? inset), t: round(t, 5) }; });
      }
    } else { g.positions = [spot(document, trim.at, what)]; if (trim.mate) g.mate = [spot(document, trim.mate, `${what} mate`)]; }
    // A buttonhole is the button's diameter plus its thickness (3 mm when the spec does not give one).
    if (trim.kind === 'button' && g.mate) g.buttonholeLengthMm = round(spec.buttonholeLength ?? spec.diameter + (spec.thickness ?? 3));
    g.count = trim.qty ?? g.positions.length * cut(g.positions[0].pattern);
    return g;
  }
  const own = trim.elastic != null ? elasticRun(document, trim, what) : null, run = own ? own.run : trim.path ? pathRun(document, trim.path, what) : runOf(document, trim.along, what), L = run.length;
  if (!(L > 0)) throw new GraphError(`${what} has no length`);
  Object.assign(g, { pattern: run.chains[0].pattern, lengthMm: round(L), chains: run.chains, centred: !!(trim.path || own?.centred) });
  if (trim.mate) { const other = runOf(document, trim.mate, `${what} mate`); g.mateLengthMm = round(other.length); g.mateChains = other.chains; }
  let cutLength = L;
  if (trim.kind === 'zipper' && spec.lengths) cutLength = [...spec.lengths].sort((a, b) => a - b).reduce((best, v) => (Math.abs(v - L) < Math.abs(best - L) - 1e-9 ? v : best));      // the nearest stocked length; the shorter of two equally near
  if (trim.kind === 'binding') { g.corners = run.chains.reduce((n, c) => n + cornersOf(c.points), 0); cutLength += g.corners * (spec.cornerAllowance ?? 0) + (spec.overlap ?? 0); }
  if (trim.kind === 'elastic') { g.relaxedRatio = own ? own.ratio : spec.ratio ?? 1; cutLength = L * g.relaxedRatio + (spec.overlap ?? 0); }
  if (spec.tailLengths) cutLength += spec.tailLengths[0] + spec.tailLengths[1];
  if (trim.kind === 'topstitch') { g.rows = spec.rows ?? 1; g.stitchedMm = round(L * g.rows); }
  if (trim.kind === 'webbing' && spec.bartacks !== false) {
    const [o1, o2] = bandOf(trim, g.centred), mid = (o1 + o2) / 2;
    g.bartacks = run.chains.filter((c) => !isClosed(c.points)).flatMap((c) => { const l = lengthOf(c.points), s = Math.min(spec.bartackInset ?? 5, l / 2); return [s, l - s].map((v) => onRun({ chains: [c] }, v, mid)); });
  }
  g.cutLengthMm = round(trim.length ?? cutLength);
  if (trim.kind === 'zipper') g.gapMm = round(L - g.cutLengthMm);
  g.count = trim.qty ?? cut(g.pattern);
  return g;
}

// ---- validation -----------------------------------------------------------------------------------------------

/** Called by validateSoftgoodsDocument once the patterns are known to be sound. A trim that cannot be placed is an error here, not at export. */
export function validateTrims(document) {
  const ids = new Set();
  for (const t of document.trims) {
    if (!t || typeof t !== 'object' || Array.isArray(t)) throw new GraphError('A trim must be an object with an id and a kind');
    if (!ID.test(String(t.id || ''))) throw new GraphError(`trim id '${t.id}' must match ${ID}`);
    const what = `Trim '${t.id}'`, def = TRIM_KINDS[t.kind], spec = t.spec ?? {};
    if (ids.has(t.id)) throw new GraphError(`Two trims are named '${t.id}'`); ids.add(t.id);
    if (typeof t.kind !== 'string' || !t.kind.trim()) throw new GraphError(`${what} needs a kind. Known: ${Object.keys(TRIM_KINDS).join(', ')}`);
    for (const k of Object.keys(t)) if (!FIELDS.includes(k)) throw new GraphError(`${what} has unknown field '${k}'${[...POSITIVE, ...NON_NEGATIVE, 'rows', 'offset', 'chain', 'ratio'].includes(k) ? `: sizes belong in spec, as spec.${k}` : `. Known: ${FIELDS.join(', ')}`}`);
    if (typeof spec !== 'object' || Array.isArray(spec)) throw new GraphError(`${what} spec must be an object`);
    const placed = ['at', 'along', 'path', 'elastic'].filter((k) => t[k] != null), row = t.count != null || t.pitch != null;
    if (placed.length !== 1) throw new GraphError(`${what} needs exactly one placement: at (a spot), along (a run of edges) or path (a line on a piece)${t.kind === 'elastic' ? ', or elastic (the id of the design\'s own elastic)' : ''}`);
    if (t.elastic != null && (t.kind !== 'elastic' || typeof t.elastic !== 'string')) throw new GraphError(`${what} elastic is the id of the design's own elastic, for a trim of kind elastic`);
    if (t.elastic != null && spec.ratio != null) throw new GraphError(`${what} points at elastic '${t.elastic}', which has the ratio: leave spec.ratio out`);
    if (!def && !(t.at || (t.along && row))) throw new GraphError(`${what} kind '${t.kind}' is not a known length trim (${Object.keys(TRIM_KINDS).filter((k) => TRIM_KINDS[k].place === 'length').join(', ')}); an unlisted kind is a piece of hardware and needs at, or along with a count or a pitch`);
    if ((def || HARDWARE).place === 'point') {
      if (t.path) throw new GraphError(`${what} is a ${t.kind}: place it with at, or along an edge with a count or a pitch`);
      if (t.along && !row) throw new GraphError(`${what} runs along an edge: give a count or a pitch`);
      if (t.at && (row || t.margin != null)) throw new GraphError(`${what} is placed at one spot: count, pitch and margin belong to a row along an edge`);
      if (t.mate != null && (t.along ? !Array.isArray(t.mate) : Array.isArray(t.mate) || typeof t.mate !== 'object')) throw new GraphError(`${what} mate must be ${t.along ? 'a run of edges, like along' : 'a spot, like at'}`);
    } else {
      if (t.at) throw new GraphError(`${what} is a ${t.kind}: place it along edges or on a path, not at a spot`);
      if (row || t.margin != null || t.inset != null) throw new GraphError(`${what} is a ${t.kind}: count, pitch, margin and inset belong to a row of point trims`);
      if (t.mate != null && (!def.mate || !Array.isArray(t.mate))) throw new GraphError(def.mate ? `${what} mate must be a run of edges, like along` : `${what} is a ${t.kind}, which has one side: leave mate out`);
    }
    if (spec.strength != null && !(finite(spec.strength) && spec.strength > 0)) throw new GraphError(`${what} spec.strength must be positive (N/mm, how hard its tack holds in the cloth preview)`);
    if (t.kind === 'button' && !(spec.diameter > 0)) throw new GraphError(`${what} is a button: give spec.diameter in mm`);
    for (const k of POSITIVE) if (spec[k] != null && !(finite(spec[k]) && spec[k] > 0)) throw new GraphError(`${what} spec.${k} must be a positive number of mm`);
    for (const k of NON_NEGATIVE) if (spec[k] != null && !(finite(spec[k]) && spec[k] >= 0)) throw new GraphError(`${what} spec.${k} must be zero or more`);
    for (const k of ['rows', 'sliders']) if (spec[k] != null && !(Number.isInteger(spec[k]) && spec[k] > 0)) throw new GraphError(`${what} spec.${k} must be a whole number, at least 1`);
    if (spec.offset != null && !finite(spec.offset)) throw new GraphError(`${what} spec.offset must be a finite number of mm`);
    if (spec.ratio != null && !(finite(spec.ratio) && spec.ratio > 0 && spec.ratio <= 1)) throw new GraphError(`${what} spec.ratio is the relaxed length over the edge it is sewn to: above 0, at most 1`);
    if (spec.chain != null && !(chainSize(spec) > 0)) throw new GraphError(`${what} spec.chain is a zipper size such as '#5' or 5`);
    if (spec.lengths != null && !(Array.isArray(spec.lengths) && spec.lengths.length && spec.lengths.every((v) => finite(v) && v > 0))) throw new GraphError(`${what} spec.lengths must list the lengths it can be bought in, mm`);
    if (spec.tailLengths != null && !(Array.isArray(spec.tailLengths) && spec.tailLengths.length === 2 && spec.tailLengths.every((v) => finite(v) && v >= 0))) throw new GraphError(`${what} spec.tailLengths must be [start, end], the free length beyond each end in mm`);
    if (spec.buttonhole != null && !['parallel', 'perpendicular'].includes(spec.buttonhole)) throw new GraphError(`${what} spec.buttonhole must be parallel or perpendicular (to the edge)`);
    if (t.closed != null && typeof t.closed !== 'boolean') throw new GraphError(`${what} closed must be true or false`);
    if (t.closed && t.mate == null) throw new GraphError(`${what} can only be closed onto a mate`);
    if (t.qty != null && !(Number.isInteger(t.qty) && t.qty > 0)) throw new GraphError(`${what} qty must be a whole number, at least 1`);
    for (const k of ['unitPrice', 'pricePerMeter']) if (t[k] != null && !(finite(t[k]) && t[k] >= 0)) throw new GraphError(`${what} ${k} must be zero or more`);
    for (const k of ['inset', 'mateInset']) if (t[k] != null && !finite(t[k])) throw new GraphError(`${what} ${k} must be a finite number of mm`);
    if (t.length != null && !(finite(t.length) && t.length > 0)) throw new GraphError(`${what} length must be a positive number of mm`);
    if (t.hardware != null && !(Array.isArray(t.hardware) && t.hardware.every((h) => h && typeof h.kind === 'string' && h.kind.trim() && (h.qty == null || (Number.isInteger(h.qty) && h.qty > 0)) && (h.unitPrice == null || (finite(h.unitPrice) && h.unitPrice >= 0))))) throw new GraphError(`${what} hardware must be a list of { kind, qty?, unitPrice?, name?, partNumber?, at? }`);
    trimGeometry(document, t);
  }
}

// ---- checks ---------------------------------------------------------------------------------------------------

/**
 * What a trim asks of the pattern. trims: one row per trim, ok false when it cannot be sewn as drawn (the two sides
 * of a zipper differ). warnings: things to look at that do not fail the design: an allowance too small for its seam
 * type or for a zipper tape, a stocked zipper length that leaves a gap, a mark typed outside its piece.
 */
export function checkTrims(document) {
  const warnings = [], patterns = new Map(document.patterns.map((p) => [p.id, p])), allowance = (ref) => Number(patterns.get(ref.pattern)?.allowances?.[ref.segment] ?? 0);
  for (const s of document.seams || []) {
    const kind = s.kind || 'plain', k = SEAM_KINDS[kind]; if (!k) continue;
    for (const ref of segmentsOf(document, [s.a, s.b])) if (allowance(ref) < k.min) warnings.push(`Seam '${s.id}' is ${kind}: ${ref.pattern}.${ref.segment} has a ${allowance(ref)} mm allowance and needs at least ${k.min} mm`);
  }
  const trims = (document.trims || []).map((trim) => {
    // At a graded size a row at a fixed pitch may no longer fit: that is a finding about that size, not a crash.
    let g; try { g = trimGeometry(document, trim); } catch (e) { return { id: trim.id, kind: trim.kind, ok: false, issues: [e.message] }; }
    const spec = trim.spec || {}, issues = [];
    if (g.mateLengthMm != null && Math.abs(g.lengthMm - g.mateLengthMm) > Math.max(1, 0.01 * g.lengthMm)) issues.push(`its two sides are ${g.lengthMm} mm and ${g.mateLengthMm} mm long`);
    if (trim.kind === 'zipper') {
      if (Math.abs(g.gapMm) > 2) warnings.push(`Zipper '${trim.id}' is ${g.cutLengthMm} mm on a ${g.lengthMm} mm opening: ${Math.abs(g.gapMm)} mm too ${g.gapMm > 0 ? 'short' : 'long'}`);
      // Three quarters of one side's tape under the allowance is a rule of thumb (10 mm for a #5), not a standard: spec.allowance says otherwise.
      const side = tapeSide(spec), need = spec.allowance ?? (side == null ? null : Math.round(side * 0.75));
      if (need != null && trim.along) for (const ref of segmentsOf(document, [...trim.along, ...(trim.mate || [])])) if (allowance(ref) < need) warnings.push(`Zipper '${trim.id}': ${ref.pattern}.${ref.segment} has a ${allowance(ref)} mm allowance and its tape needs at least ${need} mm`);
    }
    // Only a spot typed as coordinates can miss its piece; one placed on an edge or a point is on it by construction.
    for (const [at, p] of [[trim.at, g.positions?.[0]], [Array.isArray(trim.mate) ? null : trim.mate, g.mate?.[0]]]) if (at?.u != null && !insideOutline(patterns.get(p.pattern), p)) warnings.push(`Trim '${trim.id}' is at (${p.x}, ${p.y}), outside the outline of '${p.pattern}'`);
    return { id: trim.id, kind: trim.kind, ok: !issues.length, count: g.count, ...(g.lengthMm != null ? { lengthMm: g.lengthMm, cutLengthMm: g.cutLengthMm } : {}), ...(g.mateLengthMm != null ? { mateLengthMm: g.mateLengthMm } : {}), issues };
  });
  return { trims, warnings };
}
function insideOutline(pattern, p) {
  const q = (pattern.contours?.[0] || []).flatMap((id) => sampleSegment(pattern, pattern.segments.find((s) => s.id === id), 16)); let inside = false;
  for (let i = 0; i < q.length; i++) { const a = q[i], b = q[(i + 1) % q.length]; if ((a[1] > p.y) !== (b[1] > p.y) && p.x < (b[0] - a[0]) * (p.y - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside; }
  return inside || !q.length;
}

// ---- what the cutter's file shows ---------------------------------------------------------------------------------

/**
 * The marks every trim leaves on one pattern, for patternDXF: null when there are none, so a design without trims
 * exports exactly what it always did. lines carry their layer (DRILL: a cross at every drilled spot; TRIM: extents,
 * outlines and centre lines; TOPSTITCH: stitch rows and bartacks), drills are the spots themselves, texts name each trim.
 */
export function trimMarks(document, patternId) {
  if (!document.trims?.length) return null;
  const m = { lines: [], drills: [], texts: [] }, r4 = (p) => [round(p[0], 4), round(p[1], 4)];
  const stroke = (a, b, layer) => m.lines.push({ a: r4(a), b: r4(b), layer }), poly = (q, layer) => { for (let i = 1; i < q.length; i++) stroke(q[i - 1], q[i], layer); };
  const turned = (p, deg, along, across = 0) => { const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a); return [p.x + c * along - s * across, p.y + s * along + c * across]; };
  for (const trim of document.trims) {
    const g = trimGeometry(document, trim), spec = trim.spec || {}, name = String(trim.name || trim.id).replace(/\s+/g, ' ');
    const label = (at, suffix = '') => m.texts.push({ at: r4([at[0] + 2, at[1] + 2]), value: `${name}${suffix}`, height: 2.5 });
    if (g.place === 'point') {
      const drill = (p) => { const r = Math.max(2, (spec.diameter ?? 4) / 2); stroke([p.x - r, p.y], [p.x + r, p.y], 'DRILL'); stroke([p.x, p.y - r], [p.x, p.y + r], 'DRILL'); m.drills.push({ at: r4([p.x, p.y]), diameter: spec.diameter ?? null }); };
      const mine = g.positions.filter((p) => p.pattern === patternId), theirs = (g.mate || []).filter((p) => p.pattern === patternId);
      for (const p of mine) {
        if (trim.kind !== 'label') { drill(p); continue; }
        const w = (spec.width ?? 20) / 2, h = (spec.height ?? 10) / 2; poly([[-w, -h], [w, -h], [w, h], [-w, h], [-w, -h]].map(([x, y]) => turned(p, p.angle, x, y)), 'TRIM');
      }
      for (const p of theirs) {
        if (trim.kind !== 'button') { drill(p); continue; }
        const half = g.buttonholeLengthMm / 2, deg = p.angle + (spec.buttonhole === 'perpendicular' ? 90 : 0); stroke(turned(p, deg, -half), turned(p, deg, half), 'TRIM');
      }
      if (mine.length) label([mine[0].x, mine[0].y], mine.length > 1 ? ` x${mine.length}` : '');
      if (theirs.length) label([theirs[0].x, theirs[0].y], ` ${(TRIM_KINDS[trim.kind] || HARDWARE).mate}${theirs.length > 1 ? ` x${theirs.length}` : ''}`);
      continue;
    }
    const sides = [...g.chains, ...(g.mateChains || [])].filter((c) => c.pattern === patternId); if (!sides.length) continue;
    for (const c of sides) {
      if (trim.kind === 'topstitch') { for (let i = 0; i < g.rows; i++) poly(offsetChain(c.points, c.sign * ((spec.offset ?? (g.centred ? 0 : 6)) + i * (spec.spacing ?? 6))), 'TOPSTITCH'); continue; }
      const [o1, o2] = bandOf(trim, g.centred), a = offsetChain(c.points, c.sign * o1), b = offsetChain(c.points, c.sign * o2);
      // A side of the band that lies on the stitch line itself is already drawn there.
      if (o1 || g.centred) poly(a, 'TRIM'); if (o2 || g.centred) poly(b, 'TRIM');
      if (!isClosed(c.points)) { stroke(a[0], b[0], 'TRIM'); stroke(a.at(-1), b.at(-1), 'TRIM'); }
      if (trim.kind === 'webbing') poly(offsetChain(c.points, c.sign * (o1 + o2) / 2), 'TRIM');
    }
    for (const p of (g.bartacks || []).filter((q) => q.pattern === patternId)) { const half = (spec.width ?? 10) / 2; stroke(turned(p, p.angle + 90, -half), turned(p, p.angle + 90, half), 'TOPSTITCH'); }
    label(walk(sides[0].points, lengthOf(sides[0].points) / 2).p);
  }
  return m.lines.length || m.drills.length ? m : null;
}

// ---- schedule, bill and tech pack -----------------------------------------------------------------------------------

const specText = (spec) => Object.entries(spec || {}).map(([k, v]) => `${k} ${Array.isArray(v) ? v.join('/') : v}`).join(', ');
const refText = (r) => (r.contour != null ? `${r.pattern} contour ${r.contour}` : seamSideLabel(r));
const spotText = (a) => (a.point != null ? `${a.pattern}.${a.point}` : a.segment != null ? `${a.pattern}.${a.segment} at ${a.t ?? 0.5}${a.inset ? `, ${a.inset} mm in` : ''}` : `${a.pattern} (${a.u}, ${a.v})`);
const placeText = (v) => (Array.isArray(v) ? v.map(refText).join(' + ') : spotText(v));
const whereText = (t) => `${t.elastic != null ? `elastic ${t.elastic}` : t.path ? (t.path.line != null ? `${t.path.pattern}, internal line ${t.path.line}` : `${t.path.pattern}, a line of ${t.path.points.length} points`) : placeText(t.at || t.along)}${t.mate ? ` to ${placeText(t.mate)}` : ''}`;

/**
 * One row per thing to buy or sew for one unit: every trim, then the hardware threaded on it.
 * count is per unit: the marks × the cut quantity of the piece it sits on, unless the trim gives qty. lengthMm is the cut length of one.
 */
export function trimSchedule(document) {
  return (document.trims || []).flatMap((trim) => {
    const g = trimGeometry(document, trim), row = (o) => ({ supplier: null, partNumber: null, unitPrice: null, pricePerMeter: null, ...o });
    return [
      row({ id: trim.id, kind: trim.kind, name: trim.name || trim.id, spec: specText(trim.spec), where: whereText(trim), count: g.count, lengthMm: g.cutLengthMm ?? null, supplier: trim.supplier ?? null, partNumber: trim.partNumber ?? null, unitPrice: trim.unitPrice ?? null, pricePerMeter: trim.pricePerMeter ?? null }),
      ...(trim.hardware || []).map((h) => row({ id: `${trim.id}.${h.id || h.kind}`, kind: h.kind, name: h.name || h.kind, spec: specText(h.spec), where: `on ${trim.name || trim.id}${h.at != null ? ` at ${h.at}` : ''}`, count: (h.qty ?? 1) * g.count, lengthMm: null, supplier: h.supplier ?? null, partNumber: h.partNumber ?? null, unitPrice: h.unitPrice ?? null })),
    ];
  });
}

/**
 * The trims of the bill over a size set (sizeSet's rows): counts and lengths added up over every unit, and a cost from
 * unitPrice × count, else pricePerMeter × total length. Topstitching is thread, not a purchase: it is in the thread estimate.
 */
export function trimsBill(set) {
  const rows = new Map();
  for (const s of set) for (const r of trimSchedule(s.document)) {
    if (r.kind === 'topstitch') continue;
    const row = rows.get(r.id) || { ...r, count: 0, totalLengthMm: r.lengthMm == null ? null : 0 };
    if (row.lengthMm !== r.lengthMm) row.lengthVaries = true;
    row.count += s.units * r.count; if (r.lengthMm != null) row.totalLengthMm = round(row.totalLengthMm + s.units * r.count * r.lengthMm);
    rows.set(r.id, row);
  }
  return [...rows.values()].map((r) => ({ ...r, cost: r.unitPrice != null ? round(r.unitPrice * r.count) : r.pricePerMeter != null && r.totalLengthMm != null ? round(r.pricePerMeter * r.totalLengthMm / 1000) : null }));
}
/** mm of topstitch rows over a size set: length × rows × how many of the piece are cut × units. */
export function topstitchLength(set) {
  return round(set.reduce((sum, s) => sum + s.units * (s.document.trims || []).filter((t) => t.kind === 'topstitch').reduce((n, t) => { const g = trimGeometry(s.document, t); return n + g.stitchedMm * g.count; }, 0), 0));
}

/** The tech pack's trims: the schedule, the check, and a placement drawing of every piece that carries a mark. */
export function trimsReport(document) {
  const drawings = document.patterns.flatMap((p) => { const marks = trimMarks(document, p.id); return marks ? [{ pattern: p.id, name: p.name || p.id, svg: patternSVG(p, (document.annotations || []).filter((a) => a.pattern === p.id), marks) }] : []; });
  return { schedule: trimSchedule(document), ...checkTrims(document), drawings };
}
const TRIMS_STYLE = '@font-face{font-family:"Space Mono";font-weight:400;font-style:normal;src:local("Space Mono"),local("SpaceMono-Regular")}.trims,.trims *{font-family:"Space Mono",monospace;font-weight:400;font-style:normal;color:#000000;border-radius:0}.trims th,.trims td{border-color:#000000}.trims figure{margin:24px 0}.trims svg{display:block;width:auto;height:auto;max-width:100%;max-height:160mm}.trims svg g{stroke:#000000}.trims svg #TEXT{stroke:none;fill:#000000}.trims svg #DRILL,.trims svg #TRIM,.trims svg #TOPSTITCH{stroke-width:.7}.trims svg #TOPSTITCH{stroke-dasharray:2 1.5}.trims svg #STITCH{stroke-dasharray:4 2}.trims svg #ALLOWANCE,.trims svg #GRAIN{display:none}';
/** The trims section of the tech pack: the schedule as a table and a placement drawing per piece. */
export function trimsHTML(report) {
  const rows = report.schedule.map((r) => `<tr><td>${esc(r.name)}</td><td>${esc(r.kind)}</td><td>${esc(r.spec)}</td><td>${r.count}</td><td>${r.lengthMm ?? ''}</td><td>${esc(r.where)}</td><td>${esc([r.supplier, r.partNumber].filter(Boolean).join(' '))}</td></tr>`).join('');
  const notes = [...report.trims.flatMap((t) => t.issues.map((i) => `${t.id}: ${i}`)), ...report.warnings].map((w) => `<li>${esc(w)}</li>`).join('');
  return `<section class="trims"><style>${TRIMS_STYLE}</style><h2>TRIMS SCHEDULE</h2><table><tr><th>Trim</th><th>Kind</th><th>Spec</th><th>Per unit</th><th>Cut length mm</th><th>Where</th><th>Supplier, part</th></tr>${rows}</table>${notes ? `<ul>${notes}</ul>` : ''}<h2>TRIM PLACEMENT</h2><p>Crosses: drill and placement marks. Heavy solid: trim extents, outlines and buttonholes. Short dashes: topstitch rows and bartacks. Long dashes: stitch line.</p>${report.drawings.map((d) => `<figure><figcaption>${esc(d.name.toUpperCase())}</figcaption>${d.svg}</figure>`).join('')}</section>`;
}

// ---- prompts and the cloth preview ------------------------------------------------------------------------------------

/** Every trim with its derived geometry (the chains left out: they are for drawing) and what the check says. */
export function listTrims(document) {
  return { revision: document.revision, trims: (document.trims || []).map((t) => { const { chains, mateChains, centred, ...geometry } = trimGeometry(document, t); return { ...t, geometry }; }), check: checkTrims(document) };
}

/**
 * What the trims mean physically. Coordinates are pattern mm. The solver reads none of this itself: what it acts on is closures().
 *   seam     two edges held together (a zipper, hook-and-loop): pairs at matching fractions, every `spacing` mm, and, when each
 *            side is one seam side, `seam` in the shape of the design's seams[]
 *   tack     two spots held together (a button in its buttonhole, a snap): `attachments` in the shape of the design's cloth-to-cloth tacks
 *   strip    a stiff band on a piece (webbing, binding, piping, a one-sided zipper): paths and widthMm
 *   elastic  a band that wants to be relaxedRatio of the edge it is sewn to; `elastic` names the design's own elastic when the trim
 *            points at one (the solver already gathers that)
 *   point    a mass at a spot (a rivet, an eyelet, a buckle)
 * closed: true marks a closure the design wears shut: closures() below sews those into the solver's own seams and attachments.
 * rigidity (bending, N·mm) and the masses come from the trim's spec. A zipper or webbing without one takes the webbing
 * figure of the fabric library and says so in rigiditySource; a mass nobody gave is null.
 */
export function simulationTrims(document, { spacing = 12.5 } = {}) {
  const uv = ({ pattern, x, y }) => ({ pattern, x, y }), paths = (chains) => chains.map((c) => ({ pattern: c.pattern, points: c.points }));
  return (document.trims || []).flatMap((trim) => {
    const g = trimGeometry(document, trim), spec = trim.spec || {}, base = { id: trim.id, kind: trim.kind, ...(shut(trim) ? { closed: true } : {}) };
    // A pair of spots held together is written as the design's own cloth-to-cloth tack, attachments[]: { id, pattern, at, to: { pattern, at } }.
    if (g.place === 'point') return [g.mate ? { ...base, type: 'tack', attachments: g.positions.map((p, i) => ({ id: `${trim.id}_${i + 1}`, pattern: p.pattern, at: [p.x, p.y], to: { pattern: g.mate[i].pattern, at: [g.mate[i].x, g.mate[i].y] }, kind: trim.kind, ...(spec.strength != null ? { strength: spec.strength } : {}) })), massG: spec.mass ?? null } : { ...base, type: 'point', points: g.positions.map(uv), massG: spec.mass ?? null }];
    if (trim.kind === 'topstitch') return [];
    const stiff = ['zipper', 'webbing'].includes(trim.kind), [o1, o2] = bandOf(trim, g.centred);
    const physical = { lengthMm: g.lengthMm, widthMm: round(Math.abs(o2 - o1)), massPerMeterG: spec.massPerMeter ?? null, rigidity: spec.rigidity ?? (stiff ? FABRICS['nylon-webbing-25mm'].rigidity : null), rigiditySource: spec.rigidity != null ? 'spec' : stiff ? SOURCE : null };
    if (g.mateChains) {
      const a = { chains: g.chains }, b = { chains: g.mateChains }, n = Math.max(2, Math.ceil(Math.max(g.lengthMm, g.mateLengthMm) / spacing) + 1);
      // Two single sides are a seam the solver's own seam resolver takes as it is.
      const single = (refs) => refs.length === 1 && refs[0].contour == null, seam = trim.along && single(trim.along) && single(trim.mate) ? { seam: { id: trim.id, a: trim.along[0], b: trim.mate[0], flip: !!trim.flip, kind: trim.kind } } : {};
      return [{ ...base, type: 'seam', flip: !!trim.flip, ...seam, ...physical, mateLengthMm: g.mateLengthMm, pairs: Array.from({ length: n }, (_, i) => { const t = i / (n - 1); return { a: uv(onRun(a, t * g.lengthMm)), b: uv(onRun(b, (trim.flip ? 1 - t : t) * g.mateLengthMm)) }; }) }];
    }
    if (trim.kind === 'elastic') return [{ ...base, type: 'elastic', ...(trim.elastic != null ? { elastic: trim.elastic } : {}), ...physical, relaxedRatio: g.relaxedRatio, relaxedLengthMm: round(g.lengthMm * g.relaxedRatio), paths: paths(g.chains) }];
    return [{ ...base, type: 'strip', ...physical, ...(spec.tailLengths ? { tailLengths: spec.tailLengths } : {}), paths: paths(g.chains) }];
  });
}
/**
 * The closed closures as the solver's own input: a zipper or hook-and-loop as a resolved seam between its two edges, a button or
 * snap pair as a cloth-to-cloth tack. Both input builders (GET /simulation-input and simulationInput in softgoods-drape.js) add
 * these to the design's seams and attachments. Only a closure that is closed and passes its check is sewn: a zipper whose two sides
 * differ is left open, and the check says why. A design with no trims, or with every closure open, adds nothing.
 */
export function closures(document, meshes, { spacing = 12.5 } = {}) {
  const seams = [], attachments = [];
  if (!(document.trims || []).some(shut)) return { seams, attachments };
  const ok = new Map(checkTrims(document).trims.map((t) => [t.id, t.ok]));
  for (const fact of simulationTrims(document, { spacing })) {
    if (!fact.closed || !ok.get(fact.id)) continue;
    if (fact.type === 'tack') attachments.push(...fact.attachments);
    if (fact.type !== 'seam') continue;
    // The check allows the two sides a millimetre or a hundredth apart; the seam is given that as ease. Should the resolver still
    // refuse it (the mesh measures a curve a little differently), the closure is left open rather than the whole input lost.
    const ease = Math.abs(fact.lengthMm - fact.mateLengthMm) / Math.max(fact.lengthMm, fact.mateLengthMm) + 0.005;
    if (fact.seam) try { seams.push(...resolveSeamCorrespondence([{ ...fact.seam, ease, correspondence: [] }], meshes, { spacing })); } catch { /* left open */ }
    // A side made of several entries (an edge cut by a pleat) is not one seam side: it is held point for point instead.
    else attachments.push(...fact.pairs.map((p, i) => ({ id: `${fact.id}_${i + 1}`, pattern: p.a.pattern, at: [p.a.x, p.a.y], to: { pattern: p.b.pattern, at: [p.b.x, p.b.y] }, kind: fact.kind })));
  }
  return { seams, attachments };
}
/** The simulation input's share of it: { trims } for a design that has trims, nothing for one that has none, so its input is what it always was. */
export const trimsInput = (document, options) => (document.trims?.length ? { trims: simulationTrims(document, options) } : {});
