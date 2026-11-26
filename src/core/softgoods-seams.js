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
function atFraction(mesh, chain, lengths, t) {
  const want = Math.max(0, Math.min(1, t)) * lengths.total;
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
    const ma = byId.get(seam.a?.pattern), mb = byId.get(seam.b?.pattern), ca = ma?.segmentVertices?.[seam.a?.segment], cb = mb?.segmentVertices?.[seam.b?.segment];
    if (!ma || !ca || !mb || !cb) throw new GraphError(`Seam '${seam.id}' has no simulation boundary chain`);
    const la = chainLengths(ma, ca), lb = chainLengths(mb, cb);
    if (!(la.total > 0 && lb.total > 0)) throw new GraphError(`Seam '${seam.id}' has a collapsed boundary chain`);
    const mismatch = Math.abs(la.total - lb.total) / Math.max(la.total, lb.total), allowed = Number(seam.ease || 0);
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
