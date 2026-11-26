// Deterministic correspondence between authoritative pattern segments and their
// boundary-conforming simulation mesh chains. A longer side may be eased or
// gathered into the shorter side without changing either cutting pattern.

import { GraphError } from './errors.js';

const point = (mesh, i) => [mesh.uv[i * 2], mesh.uv[i * 2 + 1]];
function chainLengths(mesh, chain) {
  const cumulative = [0];
  for (let i = 1; i < chain.length; i++) { const a = point(mesh, chain[i - 1]), b = point(mesh, chain[i]); cumulative.push(cumulative.at(-1) + Math.hypot(b[0] - a[0], b[1] - a[1])); }
  return { cumulative, total: cumulative.at(-1) };
}
/** A seam side read as a span of the outline: its segments in order, from a fraction of the first one's length to a fraction of the last one's.
 *  {pattern, segment} is one whole segment; {pattern, segment, from, to} part of it; {pattern, segments: [...], from?, to?} several that follow one another. */
export const seamSide = (ref) => ({ pattern: ref?.pattern, segments: Array.isArray(ref?.segments) ? ref.segments : ref?.segment != null ? [ref.segment] : [], from: Number(ref?.from ?? 0), to: Number(ref?.to ?? 1) });
export const seamSideLabel = (ref) => { const s = seamSide(ref); return `${s.pattern}.${s.segments.join('+')}${s.from > 0 || s.to < 1 ? ` ${+s.from.toFixed(3)}-${+s.to.toFixed(3)}` : ''}`; };
/** The length of a span, given the length of each of its segments. */
export const spanLength = (side, lengths) => lengths.reduce((n, v) => n + v, 0) - side.from * lengths[0] - (1 - side.to) * lengths.at(-1);
/** The mesh boundary under one seam side: its segments' chains end to end, and where along them the sewn span starts and stops. */
export function sideChain(mesh, ref) {
  const side = seamSide(ref), chain = [], cumulative = [], each = []; let run = 0;
  for (const id of side.segments) { const c = mesh?.segmentVertices?.[id]; if (!c) return null; const l = chainLengths(mesh, c); c.forEach((v, i) => { chain.push(v); cumulative.push(run + l.cumulative[i]); }); each.push(l.total); run += l.total; }
  if (!chain.length) return null;
  const start = side.from * each[0], total = spanLength(side, each);
  return { chain, cumulative, start, total };
}
function atFraction(mesh, chain, lengths, t) {
  const want = (lengths.start || 0) + Math.max(0, Math.min(1, t)) * lengths.total;
  let i = 1; while (i < lengths.cumulative.length - 1 && lengths.cumulative[i] < want) i++;
  const a = lengths.cumulative[i - 1], b = lengths.cumulative[i], f = b > a ? (want - a) / (b - a) : 0;
  return { vertices: [chain[i - 1], chain[i]], weights: [1 - f, f], t: Math.max(0, Math.min(1, t)) };
}
function mapFraction(t, correspondence) {
  if (!correspondence?.length) return t;
  const stops = [{ a: 0, b: 0 }, ...correspondence.map((q) => ({ a: Number(q.a), b: Number(q.b) })), { a: 1, b: 1 }];
  for (let i = 1; i < stops.length; i++) if (t <= stops[i].a) { const p = stops[i - 1], q = stops[i], f = q.a > p.a ? (t - p.a) / (q.a - p.a) : 0; return p.b + f * (q.b - p.b); }
  return 1;
}
/** Where a fraction of one side's length lands on the other side: through the correspondence stops, then the flip. fromB maps side b back to side a. */
export function seamFraction(seam, t, fromB = false) {
  if (fromB) return mapFraction(seam.flip ? 1 - t : t, (seam.correspondence || []).map((q) => ({ a: q.b, b: q.a })));
  const mapped = mapFraction(t, seam.correspondence); return seam.flip ? 1 - mapped : mapped;
}
function validateStops(seam) {
  let a = 0, b = 0;
  for (const q of seam.correspondence || []) {
    if (!Number.isFinite(Number(q.a)) || !Number.isFinite(Number(q.b)) || q.a <= a || q.b <= b || q.a >= 1 || q.b >= 1) throw new GraphError(`Seam '${seam.id}' correspondence must increase strictly inside 0..1`);
    a = Number(q.a); b = Number(q.b);
  }
}

/** Resolve every seam into paired, interpolated mesh attachments. */
export function resolveSeamCorrespondence(seams, meshes, { spacing = 10 } = {}) {
  if (!(spacing > 0)) throw new GraphError('Seam correspondence spacing must be positive');
  const byId = new Map(meshes.map((m) => [m.id, m])), resolved = [];
  for (const seam of seams) {
    validateStops(seam);
    const ma = byId.get(seam.a?.pattern), mb = byId.get(seam.b?.pattern), la = sideChain(ma, seam.a), lb = sideChain(mb, seam.b);
    if (!la || !lb) throw new GraphError(`Seam '${seam.id}' has no simulation boundary chain`);
    const ca = la.chain, cb = lb.chain;
    if (!(la.total > 0 && lb.total > 0)) throw new GraphError(`Seam '${seam.id}' has a collapsed boundary chain`);
    // Judged on the pattern's own lengths where the mesh carries them: a curve meshed in a few chords reads short, which is not a sewing mismatch.
    const sewn = (mesh, ref, chords) => { const side = seamSide(ref), each = side.segments.map((id) => mesh.segmentLengths?.[id]); return each.every((v) => v > 0) ? spanLength(side, each) : chords; };
    const trueA = sewn(ma, seam.a, la.total), trueB = sewn(mb, seam.b, lb.total);
    const mismatch = Math.abs(trueA - trueB) / Math.max(trueA, trueB), allowed = Number(seam.ease || 0);
    const gather = seam.kind === 'gather' || seam.kind === 'elastic';
    if (!gather && mismatch > allowed + 1e-9) throw new GraphError(`Seam '${seam.id}' length mismatch ${(mismatch * 100).toFixed(2)}% exceeds ease ${(allowed * 100).toFixed(2)}%`);
    const count = Math.max(2, Math.ceil(Math.max(la.total, lb.total) / spacing) + 1), pairs = [];
    for (let i = 0; i < count; i++) {
      const ta = i / (count - 1), tb = seamFraction(seam, ta);
      pairs.push({ a: atFraction(ma, ca, la, ta), b: atFraction(mb, cb, lb, tb) });
    }
    resolved.push({ id: seam.id, a: seam.a, b: seam.b, flip: !!seam.flip, kind: seam.kind || 'plain', lengthA: la.total, lengthB: lb.total, mismatch, gatherRatio: la.total / lb.total, pairs });
  }
  return resolved;
}
