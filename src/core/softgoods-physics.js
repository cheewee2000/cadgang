// What a design tells the cloth preview beyond its patterns and seams: elastic, tacks and pins, stuffing, creased folds,
// shrinkage, frozen and strengthened pieces. All of it is optional and none of it changes a cutting pattern.
// Validation is called from validateSoftgoodsDocument, the check from checkDesign, and the resolved input is what
// GET /api/softgoods/simulation-input adds for web/softgoods-worker.js.

import { GraphError } from './errors.js';
import { segmentLength } from './softgoods-export.js';

const finite = (v) => v != null && v !== '' && typeof v !== 'boolean' && Number.isFinite(Number(v));
const ID = /^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/;
const uv = (at) => Array.isArray(at) && at.length === 2 && at.every(finite);

function elastic(e, what) {
  if (!e || typeof e !== 'object' || !finite(e.ratio) || !(Number(e.ratio) > 0 && Number(e.ratio) <= 1)) throw new GraphError(`${what} needs a ratio above 0 and at most 1: its relaxed length as a share of the cloth it is sewn to`);
  if (e.stiffness != null && !(finite(e.stiffness) && Number(e.stiffness) > 0)) throw new GraphError(`${what} stiffness must be positive: newtons at twice its relaxed length`);
}

/** Throws on a malformed simulation field. `patterns` is the validator's map of id → { points: Map, segments: Map }. */
export function validatePhysics(d, patterns) {
  for (const [id, p] of patterns) {
    if (p.shrink != null && !(typeof p.shrink === 'object' && ['warp', 'weft'].every((k) => p.shrink[k] == null || (finite(p.shrink[k]) && Math.abs(Number(p.shrink[k])) < 100)))) throw new GraphError(`Pattern '${id}' shrink must be { warp, weft } in percent, each under 100`);
    if (p.freeze != null && typeof p.freeze !== 'boolean') throw new GraphError(`Pattern '${id}' freeze must be true or false`);
    if (p.strengthen != null && !(finite(p.strengthen) && Number(p.strengthen) > 0)) throw new GraphError(`Pattern '${id}' strengthen must be a positive multiplier`);
  }
  for (const s of d.seams) if (s.elastic != null) elastic(s.elastic, `Seam '${s.id}' elastic`);
  for (const key of ['elastics', 'stuffing']) if (d[key] != null && !Array.isArray(d[key])) throw new GraphError(`${key} must be an array`);
  const ids = new Set();
  for (const e of d.elastics || []) {
    if (!ID.test(String(e?.id || ''))) throw new GraphError(`elastic id '${e?.id}' must match ${ID}`);
    if (ids.has(e.id)) throw new GraphError(`Two elastics are named '${e.id}'`); ids.add(e.id);
    const p = patterns.get(e.pattern); if (!p) throw new GraphError(`Elastic '${e.id}' refers to missing pattern '${e.pattern}'`);
    if ((e.segment != null) === (e.line != null)) throw new GraphError(`Elastic '${e.id}' runs along one outline segment or one line between two points: give segment or line`);
    if (e.segment != null && !p.segments.has(e.segment)) throw new GraphError(`Elastic '${e.id}' refers to missing segment '${e.pattern}.${e.segment}'`);
    if (e.line != null && !(Array.isArray(e.line) && e.line.length === 2 && e.line[0] !== e.line[1] && e.line.every((q) => p.points.has(q)))) throw new GraphError(`Elastic '${e.id}' line must be two different points of pattern '${e.pattern}'`);
    elastic(e, `Elastic '${e.id}'`);
  }
  for (const a of d.attachments) {
    if (a.strength != null && !(finite(a.strength) && Number(a.strength) > 0)) throw new GraphError(`Attachment '${a.id}' strength must be positive (N/mm)`);
    if (a.exact != null && typeof a.exact !== 'boolean') throw new GraphError(`Attachment '${a.id}' exact must be true or false`);
  }
  const groups = new Set();
  for (const s of d.stuffing || []) {
    if (!ID.test(String(s?.id || ''))) throw new GraphError(`stuffing id '${s?.id}' must match ${ID}`);
    if (groups.has(s.id)) throw new GraphError(`Two stuffings are named '${s.id}'`); groups.add(s.id);
    if (!Array.isArray(s.patterns) || !s.patterns.length || s.patterns.some((p) => !patterns.has(p))) throw new GraphError(`Stuffing '${s.id}' needs the ids of the patterns that enclose it`);
    if (s.pressure == null && s.volume == null) throw new GraphError(`Stuffing '${s.id}' needs a pressure (Pa) or a volume (litres)`);
    if (s.pressure != null && !(finite(s.pressure) && Number(s.pressure) >= 0)) throw new GraphError(`Stuffing '${s.id}' pressure must be zero or more pascals`);
    if (s.volume != null && !(finite(s.volume) && Number(s.volume) > 0)) throw new GraphError(`Stuffing '${s.id}' volume must be positive litres`);
  }
  for (const a of d.annotations) if (a.angle != null) {
    if (a.type === 'dart') throw new GraphError(`Annotation '${a.id}' is a dart: only a fold_line or a pleat takes an angle`);
    if (!finite(a.angle) || Math.abs(Number(a.angle)) > 180) throw new GraphError(`Annotation '${a.id}' angle must be between -180 and 180 degrees`);
  }
  for (const a of d.arrangement) if (a.layer != null && !finite(a.layer)) throw new GraphError(`Arrangement '${a.pattern}' layer must be a number`);
}

/** An attachment whose \`to\` is { pattern, at } is a tack between two cloth points. Returns false for anything else, which must then be a world point. */
export function validateTack(a, patterns) {
  if (!a.to || Array.isArray(a.to) || typeof a.to !== 'object') return false;
  if (!patterns.has(a.to.pattern)) throw new GraphError(`Attachment '${a.id}' tacks to missing pattern '${a.to.pattern}'`);
  if (!uv(a.to.at)) throw new GraphError(`Attachment '${a.id}' tacks to a point that must be two finite pattern coordinates`);
  return true;
}

// The straight lines the mesh of a pattern must follow, in a fixed order: creased folds, then elastics drawn between two points.
function linesOf(d, p) {
  const at = (id) => { const q = p.points.find((x) => x.id === id); return [q.x, q.y]; }, out = [];
  for (const a of d.annotations || []) if (a.pattern === p.id && a.angle != null && Number(a.angle) !== 0) a.lines.forEach((pair, k) => out.push({ id: a.id, a: at(pair[0]), b: at(pair[1]), angle: Number(a.angle) * (a.type === 'pleat' && k % 2 ? -1 : 1) }));
  for (const e of d.elastics || []) if (e.pattern === p.id && e.line) out.push({ id: e.id, a: at(e.line[0]), b: at(e.line[1]), ratio: Number(e.ratio), stiffness: e.stiffness });
  return out;
}
/** meshPattern's \`lines\` for one pattern. */
export const conformLines = (d, p) => linesOf(d, p).map((l) => [l.a, l.b]);

/** The simulation-only part of the solver's input, resolved onto the meshes. A design that uses none of it adds nothing. */
export function physicsInput(d, meshes) {
  const byId = new Map(meshes.map((m) => [m.id, m])), elastics = [], folds = [];
  const length = (m, chain) => chain.reduce((n, v, i) => i ? n + Math.hypot(m.uv[v * 2] - m.uv[chain[i - 1] * 2], m.uv[v * 2 + 1] - m.uv[chain[i - 1] * 2 + 1]) : 0, 0);
  for (const p of d.patterns) linesOf(d, p).forEach((l, k) => { const chain = byId.get(p.id)?.lineVertices?.[k]; if (!chain) return; if (l.angle != null) folds.push({ id: l.id, pattern: p.id, chain, angle: l.angle }); else elastics.push({ id: l.id, pattern: p.id, chain, ratio: l.ratio, stiffness: l.stiffness }); });
  for (const e of d.elastics || []) if (e.segment) elastics.push({ id: e.id, pattern: e.pattern, chain: byId.get(e.pattern).segmentVertices[e.segment], ratio: Number(e.ratio), stiffness: e.stiffness });
  // An elastic seam relaxes to ratio × its shorter side. Both sides gather to that; the spring is on one of them, the seam carries it to the other.
  for (const s of d.seams || []) if (s.elastic) {
    const sides = [s.a, s.b].map((ref) => { const m = byId.get(ref.pattern), chain = m.segmentVertices[ref.segment]; return { pattern: ref.pattern, chain, length: length(m, chain) }; }), short = Math.min(sides[0].length, sides[1].length), spring = sides[0].length <= sides[1].length ? 0 : 1;
    sides.forEach((side, k) => elastics.push({ id: s.id, pattern: side.pattern, chain: side.chain, ratio: Number(s.elastic.ratio) * short / side.length, stiffness: k === spring ? s.elastic.stiffness : 0 }));
  }
  return { ...(elastics.length ? { elastics } : {}), ...(folds.length ? { folds } : {}), ...(d.stuffing?.length ? { stuffing: d.stuffing } : {}) };
}

/** What is worth a second look before simulating or cutting. One row per elastic, stuffing, tack and shrunk pattern; ok false fails the design's check. */
export function checkPhysics(d) {
  const patterns = new Map(d.patterns.map((p) => [p.id, p])), out = [], seg = (pid, sid) => { const p = patterns.get(pid); return segmentLength(p, p.segments.find((s) => s.id === sid)); };
  const rate = (id, length, ratio) => out.push({ id, kind: 'elastic', length: +length.toFixed(2), relaxed: +(length * ratio).toFixed(2), ok: ratio >= 0.3, note: ratio >= 0.3 ? `cut the elastic ${(length * ratio).toFixed(0)} mm for ${length.toFixed(0)} mm of cloth` : `ratio ${ratio} gathers the cloth to under a third of its length: an elastic is usually 0.5 to 0.9` });
  for (const e of d.elastics || []) { const p = patterns.get(e.pattern), q = (id) => p.points.find((x) => x.id === id); rate(e.id, e.segment ? seg(e.pattern, e.segment) : Math.hypot(q(e.line[0]).x - q(e.line[1]).x, q(e.line[0]).y - q(e.line[1]).y), Number(e.ratio)); }
  for (const s of d.seams || []) if (s.elastic) rate(s.id, Math.min(seg(s.a.pattern, s.a.segment), seg(s.b.pattern, s.b.segment)), Number(s.elastic.ratio));
  for (const s of d.stuffing || []) {
    // A piece of the group that no seam joins to the group (or, alone, to itself) leaves the volume open.
    const open = s.patterns.filter((id) => !(d.seams || []).some((m) => s.patterns.includes(m.a.pattern) && s.patterns.includes(m.b.pattern) && (m.a.pattern === id || m.b.pattern === id) && (s.patterns.length === 1 || m.a.pattern !== m.b.pattern)));
    out.push({ id: s.id, kind: 'stuffing', ok: !open.length, note: open.length ? `'${open.join("', '")}' is not sewn to the rest of the stuffing: the volume is open` : s.volume != null ? `fills toward ${s.volume} L` : `${s.pressure} Pa` });
  }
  const inside = (pid, at) => { const pts = patterns.get(pid).points, xs = pts.map((q) => q.x), ys = pts.map((q) => q.y); return at[0] >= Math.min(...xs) - 1e-6 && at[0] <= Math.max(...xs) + 1e-6 && at[1] >= Math.min(...ys) - 1e-6 && at[1] <= Math.max(...ys) + 1e-6; };
  for (const a of d.attachments || []) {
    const tack = a.to && !Array.isArray(a.to); if (!tack && !a.exact && a.strength == null) continue;
    const off = [[a.pattern, a.at], ...(tack ? [[a.to.pattern, a.to.at]] : [])].filter(([pid, at]) => !inside(pid, at)).map(([pid]) => pid);
    out.push({ id: a.id, kind: tack ? 'tack' : 'pin', ok: !off.length, note: off.length ? `its point is off pattern '${off.join("', '")}'` : tack ? `holds '${a.pattern}' to '${a.to.pattern}'` : `holds '${a.pattern}' to a fixed point` });
  }
  for (const p of d.patterns) if (p.shrink) { const most = Math.max(Math.abs(Number(p.shrink.warp || 0)), Math.abs(Number(p.shrink.weft || 0))); out.push({ id: p.id, kind: 'shrink', ok: most <= 20, note: most <= 20 ? `simulated ${Number(p.shrink.warp || 0)}% shorter along the warp and ${Number(p.shrink.weft || 0)}% along the weft; the cutting pattern is unchanged` : `${most}% is more than cloth shrinks: shrink is in percent` }); }
  return out;
}
