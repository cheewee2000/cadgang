// Drafting patterns by hand on the softgoods page: every piece on one board, and the edits a pattern maker makes there (move
// a point, draw a piece, add a point on an edge, bend an edge, delete, sew two edges). Each edit is a function from a document
// to a new one; the page PUTs the result to /api/softgoods/document, which validates it like any other change. The board
// (createDraftBoard) is the page's; the edits run in node too (test/softgoods-draft.test.js).
import { seamSide, seamCss } from './softgoods-view.js';

const clone = (v) => JSON.parse(JSON.stringify(v));
const r2 = (v) => Math.round(v * 100) / 100 + 0;
const pieceOf = (d, pid) => { const p = d.patterns.find((q) => q.id === pid); if (!p) throw new Error(`No piece '${pid}'`); return p; };
const fresh = (taken, base) => { let i = 1; while (taken.has(`${base}_${i}`)) i++; return `${base}_${i}`; };
const idsOf = (p) => new Set([...p.points.map((q) => q.id), ...p.segments.map((s) => s.id)]);

/** Points along a segment, uniform in its own parameter (a line is its two ends). */
export function sample(p, s, n = 24) {
  const m = new Map(p.points.map((q) => [q.id, q])), a = m.get(s.a), b = m.get(s.b);
  if (s.type === 'line') return [a, b];
  if (s.type === 'arc') {
    const c = m.get(s.c), r = Math.hypot(a.x - c.x, a.y - c.y), q = Math.atan2(a.y - c.y, a.x - c.x); let w = Math.atan2(b.y - c.y, b.x - c.x) - q; if (w <= 0) w += 2 * Math.PI;
    return Array.from({ length: n + 1 }, (_, i) => ({ x: c.x + r * Math.cos(q + w * i / n), y: c.y + r * Math.sin(q + w * i / n) }));
  }
  const c1 = m.get(s.c1), c2 = m.get(s.c2);
  return Array.from({ length: n + 1 }, (_, i) => { const t = i / n, u = 1 - t; return { x: u ** 3 * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t ** 3 * b.x, y: u ** 3 * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t ** 3 * b.y }; });
}
export const segLength = (p, s) => { const q = sample(p, s, 64); let l = 0; for (let i = 1; i < q.length; i++) l += Math.hypot(q[i].x - q[i - 1].x, q[i].y - q[i - 1].y); return l; };

/** Where each piece sits on the board: side by side in document order, 40 mm apart. Drawing only; nothing is stored. */
export function boardLayout(d, gap = 40) {
  const out = new Map(); let x = 0;
  for (const p of d.patterns) {
    const pts = p.segments.flatMap((s) => { try { return sample(p, s, 12); } catch { return []; } }).filter(Boolean);
    const lo = [Math.min(...pts.map((q) => q.x)), Math.min(...pts.map((q) => q.y))], hi = [Math.max(...pts.map((q) => q.x)), Math.max(...pts.map((q) => q.y))];
    if (!pts.length) { lo[0] = lo[1] = hi[0] = hi[1] = 0; }
    out.set(p.id, { dx: x - lo[0], dy: -lo[1], lo, hi }); x += hi[0] - lo[0] + gap;
  }
  return out;
}

/** Ids this document still uses for `id` of piece `pid` outside the piece's own outline and the seams: what an edit may not drop. */
function usedElsewhere(d, pid, id) {
  const p = pieceOf(d, pid), rest = { ...d, seams: [], patterns: d.patterns.map((q) => (q.id === pid ? { ...q, points: [], segments: [], contours: [], allowances: {}, notches: [] } : q)) };
  return JSON.stringify(rest).includes(JSON.stringify(id)) || (p.notches || []).some((n) => n.point === id);
}

export function movePoint(d, pid, qid, x, y) {
  d = clone(d); const q = pieceOf(d, pid).points.find((v) => v.id === qid); if (!q) throw new Error(`No point '${qid}'`);
  q.x = r2(x); q.y = r2(y); return d;
}

/** A new piece from an outline clicked round (three or more points, either way round): straight edges, 10 mm allowance. */
export function addPiece(d, pts, { name = null } = {}) {
  if (pts.length < 3) throw new Error('A piece needs three or more points');
  d = clone(d); const taken = new Set(d.patterns.map((p) => p.id)), id = fresh(taken, 'piece');
  let area = 0; pts.forEach((u, i) => { const v = pts[(i + 1) % pts.length]; area += u.x * v.y - v.x * u.y; });
  const loop = area < 0 ? [...pts].reverse() : pts;   // counter-clockwise, as the rest of the pattern code expects
  const points = loop.map((q, i) => ({ id: `${id}_p${i + 1}`, x: r2(q.x), y: r2(q.y) })), segments = points.map((q, i) => ({ id: `${id}_e${i + 1}`, type: 'line', a: q.id, b: points[(i + 1) % points.length].id }));
  const material = Object.keys(d.materials || {})[0] || 'canvas';
  d.patterns.push({ id, name: name || id, material, cut: 1, points, segments, contours: [segments.map((s) => s.id)], allowances: Object.fromEntries(segments.map((s) => [s.id, 10])), notches: [], grain: { angle: 90 }, internalLines: [] });
  d.arrangement.push({ pattern: id, position: [d.arrangement.length * 240, 0, 0], rotation: [0, 0, 0], layer: 0 });
  return d;
}

/** A point on edge `sid` at its parameter t (0..1): the edge becomes two, and its seams, allowance and notches follow. */
export function insertPoint(d, pid, sid, t) {
  d = clone(d); const p = pieceOf(d, pid), s = p.segments.find((v) => v.id === sid); if (!s) throw new Error(`No edge '${sid}'`);
  if (usedElsewhere(d, pid, sid)) throw new Error(`Edge '${sid}' carries a trim, elastic or measurement: change it by prompt`);
  t = Math.min(0.98, Math.max(0.02, t));
  const m = new Map(p.points.map((q) => [q.id, q])), taken = idsOf(p), qid = fresh(taken, `${sid}_p`), s2 = { id: fresh(new Set([...taken, qid]), `${sid}_b`) };
  const a = m.get(s.a), b = m.get(s.b), lerp = (u, v, f) => ({ x: u.x + (v.x - u.x) * f, y: u.y + (v.y - u.y) * f });
  let at;
  if (s.type === 'line') { at = lerp(a, b, t); Object.assign(s2, { type: 'line', a: qid, b: s.b }); }
  else if (s.type === 'arc') { at = sample(p, s, 1000)[Math.round(t * 1000)]; Object.assign(s2, { type: 'arc', a: qid, b: s.b, c: s.c }); }
  else {   // de Casteljau: both halves are the same curve
    const c1 = m.get(s.c1), c2 = m.get(s.c2), p01 = lerp(a, c1, t), p12 = lerp(c1, c2, t), p23 = lerp(c2, b, t), p012 = lerp(p01, p12, t), p123 = lerp(p12, p23, t); at = lerp(p012, p123, t);
    const k1 = fresh(new Set([...taken, qid, s2.id]), `${sid}_c`), k2 = fresh(new Set([...taken, qid, s2.id, k1]), `${sid}_c`);
    Object.assign(c1, { x: r2(p01.x), y: r2(p01.y) }); Object.assign(c2, { x: r2(p012.x), y: r2(p012.y) });
    p.points.push({ id: k1, x: r2(p123.x), y: r2(p123.y) }, { id: k2, x: r2(p23.x), y: r2(p23.y) });
    Object.assign(s2, { type: 'bezier', a: qid, b: s.b, c1: k1, c2: k2 });
  }
  p.points.push({ id: qid, x: r2(at.x), y: r2(at.y) }); s.b = qid;
  p.segments.splice(p.segments.indexOf(s) + 1, 0, s2);
  for (const loop of p.contours || []) { const i = loop.indexOf(sid); if (i >= 0) loop.splice(i + 1, 0, s2.id); }
  if (p.allowances?.[sid] != null) p.allowances[s2.id] = p.allowances[sid];
  for (const n of p.notches || []) if (n.segment === sid && n.at != null) { if (n.at > t) { n.segment = s2.id; n.at = r2((n.at - t) / (1 - t) * 1e4) / 1e4; } else n.at = r2(n.at / t * 1e4) / 1e4; }
  for (const seam of d.seams) for (const k of ['a', 'b']) {   // a seam side on the edge now runs over both halves
    const ref = seam[k]; if (ref?.pattern !== pid) continue; const side = seamSide(ref), i = side.segments.indexOf(sid); if (i < 0) continue;
    side.segments.splice(i + 1, 0, s2.id); seam[k] = { pattern: pid, segments: side.segments, ...(side.from > 0 ? { from: side.from } : {}), ...(side.to < 1 ? { to: side.to } : {}) };
  }
  return d;
}

/** A straight edge bent into a Bezier, its two handles on it at a third and two thirds: drag them to shape the curve. */
export function toCurve(d, pid, sid) {
  d = clone(d); const p = pieceOf(d, pid), s = p.segments.find((v) => v.id === sid); if (!s) throw new Error(`No edge '${sid}'`);
  if (s.type !== 'line') return d;
  const m = new Map(p.points.map((q) => [q.id, q])), a = m.get(s.a), b = m.get(s.b), taken = idsOf(p), k1 = fresh(taken, `${sid}_c`), k2 = fresh(new Set([...taken, k1]), `${sid}_c`);
  p.points.push({ id: k1, x: r2(a.x + (b.x - a.x) / 3), y: r2(a.y + (b.y - a.y) / 3) }, { id: k2, x: r2(a.x + 2 * (b.x - a.x) / 3), y: r2(a.y + 2 * (b.y - a.y) / 3) });
  Object.assign(s, { type: 'bezier', c1: k1, c2: k2 }); return d;
}

/** A curved edge made straight again; handles nothing else uses go with it. */
export function toLine(d, pid, sid) {
  d = clone(d); const p = pieceOf(d, pid), s = p.segments.find((v) => v.id === sid); if (!s) throw new Error(`No edge '${sid}'`);
  const handles = s.type === 'bezier' ? [s.c1, s.c2] : s.type === 'arc' ? [s.c] : [];
  for (const k of ['c', 'c1', 'c2']) delete s[k]; s.type = 'line';
  const still = (id) => p.segments.some((v) => [v.a, v.b, v.c, v.c1, v.c2].includes(id)) || usedElsewhere(d, pid, id);
  p.points = p.points.filter((q) => !handles.includes(q.id) || still(q.id)); return d;
}

/**
 * Delete a point. A Bezier handle straightens its edge; a corner joins its two edges into one straight edge (the piece keeps
 * three or more). Refused where a seam, a trim or a line still uses what would go.
 */
export function removePoint(d, pid, qid) {
  const p0 = pieceOf(d, pid), curve = p0.segments.find((s) => s.c1 === qid || s.c2 === qid || s.c === qid);
  if (curve) return toLine(d, pid, curve.id);
  d = clone(d); const p = pieceOf(d, pid), into = p.segments.find((s) => s.b === qid), out = p.segments.find((s) => s.a === qid);
  if (!into || !out) throw new Error(`Point '${qid}' is not a corner of the outline`);
  const loop = (p.contours || []).find((l) => l.includes(out.id)); if (loop && loop.length <= 3) throw new Error('A piece keeps three edges or more');
  if (d.seams.some((s) => [s.a, s.b].some((r) => r?.pattern === pid && seamSide(r).segments.includes(out.id)))) throw new Error(`Edge '${out.id}' is sewn: remove its seam first`);
  if (usedElsewhere(d, pid, out.id) || usedElsewhere(d, pid, qid)) throw new Error(`'${qid}' is used by a trim, a line or a measurement: change it by prompt`);
  into.b = out.b; for (const k of ['c', 'c1', 'c2']) delete into[k]; into.type = 'line';
  p.segments = p.segments.filter((s) => s !== out); for (const l of p.contours || []) { const i = l.indexOf(out.id); if (i >= 0) l.splice(i, 1); }
  if (p.allowances) delete p.allowances[out.id]; p.notches = (p.notches || []).filter((n) => n.segment !== out.id);
  const used = new Set(p.segments.flatMap((s) => [s.a, s.b, s.c, s.c1, s.c2])); p.points = p.points.filter((q) => used.has(q.id) || usedElsewhere(d, pid, q.id));
  return d;
}

/** Delete a piece with its seams. Refused where a trim, a tack or anything else still names it. */
export function removePiece(d, pid) {
  d = clone(d); pieceOf(d, pid);
  const rest = { ...d, patterns: d.patterns.filter((p) => p.id !== pid), arrangement: d.arrangement.filter((a) => a.pattern !== pid), seams: d.seams.filter((s) => s.a?.pattern !== pid && s.b?.pattern !== pid) };
  if (JSON.stringify(rest).includes(JSON.stringify(pid))) throw new Error(`Something else still names '${pid}' (a trim, a tack, a grade): change it by prompt`);
  return rest;
}

/** Sew edge a to edge b ({ pattern, segment } each). Two edges that run the same way round their pieces are sewn flipped, as two pieces face to face are. */
export function sewEdges(d, a, b) {
  if (a.pattern === b.pattern && a.segment === b.segment) throw new Error('An edge is not sewn to itself');
  d = clone(d); const id = fresh(new Set(d.seams.map((s) => s.id)), 'seam');
  d.seams.push({ id, a: { pattern: a.pattern, segment: a.segment }, b: { pattern: b.pattern, segment: b.segment }, flip: true, ease: 0, kind: 'plain', correspondence: [] });
  return d;
}

/** A match notch on edge `sid` at its parameter t. */
export function addNotch(d, pid, sid, t) {
  d = clone(d); const p = pieceOf(d, pid); if (!p.segments.some((s) => s.id === sid)) throw new Error(`No edge '${sid}'`);
  (p.notches ||= []).push({ segment: sid, at: Math.round(Math.min(1, Math.max(0, t)) * 1e4) / 1e4, kind: 'match' }); return d;
}
/** The seam allowance (mm) of edge `sid`. */
export function setAllowance(d, pid, sid, mm) {
  if (!(Number(mm) >= 0)) throw new Error('An allowance is 0 mm or more');
  d = clone(d); const p = pieceOf(d, pid); if (!p.segments.some((s) => s.id === sid)) throw new Error(`No edge '${sid}'`);
  (p.allowances ||= {})[sid] = Number(mm); return d;
}

/** A piece's name, material, cut count (1 or more) and grain angle (degrees), any of them. */
/** Where a piece starts for the drape: an avatar region, or 'body:side' on one of the design's bodies. */
export const REGIONS = ['front', 'back', 'left', 'right', 'left-arm', 'right-arm', 'left-leg', 'right-leg'], SIDES = ['front', 'back', 'left', 'right', 'top', 'bottom'];
export function setPiece(d, pid, { name, material, cut, grain, place, layer } = {}) {
  d = clone(d); const p = pieceOf(d, pid);
  if (name != null) { if (!String(name).trim()) throw new Error('A piece needs a name'); p.name = String(name).trim(); }
  if (material != null) p.material = String(material);
  if (cut != null) { if (!(Number.isInteger(Number(cut)) && Number(cut) >= 1)) throw new Error('Cut is a whole number, 1 or more'); p.cut = Number(cut); }
  if (grain != null) { if (!Number.isFinite(Number(grain))) throw new Error('Grain is an angle in degrees'); p.grain = { ...(p.grain || {}), angle: Number(grain) }; }
  // A new place keeps the piece's layer, offset and anchor; '' takes the piece off the body (laid flat beside the others).
  if (place != null) {
    const { layer: l, offset, anchor } = p.placement || {}, kept = Object.fromEntries(Object.entries({ layer: l, offset, anchor }).filter(([, v]) => v != null)), [body, side] = String(place).split(':');
    if (!place) delete p.placement; else if (side != null) p.placement = { body, side, ...kept }; else p.placement = { region: place, ...kept };
  }
  if (layer != null && layer !== '') { if (!p.placement) throw new Error('Place the piece first'); if (!Number.isFinite(Number(layer))) throw new Error('Layer is a number'); p.placement = { ...p.placement, layer: Number(layer) }; }
  return d;
}

/** The trim kinds TRIM places, as src/core/softgoods-trims.js TRIM_KINDS has them: a spot, or a length along an edge. */
export const TRIM_KINDS = { point: ['snap', 'button', 'rivet', 'eyelet', 'grommet', 'label', 'd-ring', 'buckle'], length: ['zipper', 'hook-and-loop', 'binding', 'piping', 'elastic', 'drawcord', 'topstitch', 'webbing'] };
/** A trim of `kind` at a spot (`at`: { pattern, u, v } or { pattern, segment, t, inset }) or along edges (`along`), named kind_n. */
export function addTrim(d, kind, place) {
  d = clone(d); const ids = new Set((d.trims || []).map((t) => t.id)); let n = 1; while (ids.has(`${kind}_${n}`)) n++;
  (d.trims ||= []).push({ id: `${kind}_${n}`, kind, ...place }); return d;
}
export const removeTrim = (d, id) => ({ ...clone(d), trims: (d.trims || []).filter((t) => t.id !== id) });
// A material's fields as the fabric panel edits them: [key, label]. tensile.warp and tensile.weft are the nested tensile.
export const FABRIC_FIELDS = [['arealDensity', 'WEIGHT g/m²'], ['thickness', 'THICK mm'], ['rigidity', 'BEND N·mm'], ['tensile.warp', 'WARP N/mm'], ['tensile.weft', 'WEFT N/mm'], ['shearRigidity', 'SHEAR N/mm'], ['friction', 'FRICTION 0-1'], ['pricePerMeter', 'PRICE /m'], ['rollWidth', 'ROLL mm']];

/** Set a material's fields: preset (a library id, '' for none), color (#rrggbb) or a FABRIC_FIELDS number ('' leaves it to the preset). */
export function setMaterial(d, id, fields) {
  if (!String(id ?? '').trim()) throw new Error('A material needs a name');
  d = clone(d); const m = ((d.materials ||= {})[id] ||= {});
  for (const [k, raw] of Object.entries(fields)) {
    const v = String(raw ?? '').trim(), [top, sub] = k.split('.');
    if (k === 'preset' || k === 'color') { if (k === 'color' && v && !/^#[0-9a-f]{6}$/i.test(v)) throw new Error('A colour is #rrggbb'); if (v) m[k] = v; else delete m[k]; continue; }
    if (!FABRIC_FIELDS.some(([f]) => f === k)) throw new Error(`No material field '${k}'`);
    const n = Number(v); if (v && !(n >= 0 && (k !== 'friction' || n <= 1))) throw new Error(`${k} is ${k === 'friction' ? 'between 0 and 1' : '0 or more'}`);
    if (sub) { const t = (m[top] = typeof m[top] === 'object' && m[top] ? m[top] : {}); if (v) t[sub] = n; else delete t[sub]; if (!Object.keys(t).length) delete m[top]; }
    else if (v) m[k] = n; else delete m[k];
  }
  return d;
}

/** A new graded size, no point moved yet. */
export function addSize(d, size) {
  const name = String(size ?? '').trim(); if (!name) throw new Error('A size needs a name');
  d = clone(d); if ((d.grades ||= []).some((g) => g.size === name)) throw new Error(`There is already a size '${name}'`);
  d.grades.push({ size: name, rules: [] }); return d;
}
export const removeSize = (d, size) => ({ ...clone(d), grades: (d.grades || []).filter((g) => g.size !== size) });

/** Where a point sits in a size: dx, dy mm from the base pattern; 0, 0 drops its rule. */
export function gradePoint(d, size, pid, qid, dx, dy) {
  d = clone(d); const g = (d.grades || []).find((v) => v.size === size); if (!g) throw new Error(`No size '${size}'`);
  if (!pieceOf(d, pid).points.some((q) => q.id === qid)) throw new Error(`No point '${qid}'`);
  g.rules = g.rules.filter((r) => r.pattern !== pid || r.point !== qid); dx = r2(dx); dy = r2(dy);
  if (dx || dy) g.rules.push({ pattern: pid, point: qid, dx, dy }); return d;
}

/** A piece as it is in a graded size (the base piece when there is none). */
export function graded(p, g) {
  const m = new Map((g?.rules || []).filter((r) => r.pattern === p.id).map((r) => [r.point, r]));
  return { ...p, points: p.points.map((q) => { const r = m.get(q.id); return r ? { ...q, x: q.x + r.dx, y: q.y + r.dy } : q; }) };
}

// ---- the board

// A piece drawn on the board keeps its shape but starts at its own origin: its lowest, leftmost corner at 0, 0.
const origin = (pts) => { const x0 = Math.min(...pts.map((q) => q.x)), y0 = Math.min(...pts.map((q) => q.y)); return pts.map((q) => ({ x: q.x - x0, y: q.y - y0 })); };

const TOOLS = ['move', 'pen', 'point', 'curve', 'seam', 'delete', 'dart', 'pleat', 'cut', 'line', 'notch', 'allowance', 'mirror', 'grade', 'trim'];
// The numbers a tool takes from the board's two fields: [label, default] each.
export const AMOUNTS = { dart: [['width mm', 20], ['length mm', 80]], pleat: [['intake mm', 30]], allowance: [['allowance mm', 10]] };
const HELP = { trim: 'a spot trim: click inside a piece or on an edge (10 mm in) · a length trim: click the edge it runs along', move: 'drag a point or a handle · drag the board to pan', pen: 'click the corners of a new piece · click the first one or press Enter to close · Esc cancels', point: 'click an edge to put a point on it', curve: 'click a straight edge to bend it (then drag its handles), a curved one to straighten it', seam: 'click an edge, then the edge it is sewn to', delete: 'click a point, a seam or inside a piece to delete it', dart: 'click an edge where the dart goes: width and length from the fields', pleat: 'click an edge where the pleat goes: intake from the field', cut: 'click two places on a piece\'s edge: it is cut in two along the line and the cut is sewn', line: 'click two places inside a piece for a stitch or placement line', notch: 'click an edge to notch it there', allowance: 'click an edge to give it the allowance in the field', mirror: 'click an edge: the piece is mirrored across it, the other hand', grade: 'drag a point to where it is in the size chosen; every size is drawn over the base' };

/**
 * The drafting board on `canvas`. getDoc() is the page's document; commit(next) PUTs it and resolves to the saved document
 * (or throws with the server's reason); say(text, bad) writes the page's status line.
 */
export function createDraftBoard({ canvas, getDoc, commit, operate, amounts = () => [], say, onSelect = () => {}, marks = () => null }) {
  let tool = 'move', size = null, trimKind = 'snap', view = { k: 1, x: 0, y: 0 }, drag = null, pen = [], pick = null, hover = null, local = null, undo = [], busy = false;
  const doc = () => local || getDoc();
  const frame = () => {
    // Laid out and fitted from the saved document, drawn from the edit in hand: a dragged point never rescales the board under the pointer.
    const d = doc(), lay = boardLayout(getDoc()), r = canvas.getBoundingClientRect(), all = [...lay.values()];
    const lo = [Math.min(0, ...all.map((v) => v.lo[0] + v.dx)), Math.min(0, ...all.map((v) => v.lo[1] + v.dy))], hi = [Math.max(100, ...all.map((v) => v.hi[0] + v.dx)), Math.max(100, ...all.map((v) => v.hi[1] + v.dy))];
    const k = 0.85 * Math.min(r.width / (hi[0] - lo[0]), r.height / (hi[1] - lo[1])) * view.k, c = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2];
    const toScreen = (pid, q) => { const o = lay.get(pid) || { dx: 0, dy: 0 }; return [r.width / 2 + view.x + (q.x + o.dx - c[0]) * k, r.height / 2 + view.y - (q.y + o.dy - c[1]) * k]; };
    const toBoard = (X, Y) => ({ x: (X - r.width / 2 - view.x) / k + c[0], y: -(Y - r.height / 2 - view.y) / k + c[1] });
    return { d, lay, k, w: r.width, h: r.height, toScreen, toBoard };
  };
  // What is under the pointer: a point (8 px), else an edge (6 px, with its parameter there), else the piece it is inside.
  function hit(X, Y, f = frame()) {
    let best = null;
    for (const p of shownPieces(f.d)) for (const q of p.points) { const [x, y] = f.toScreen(p.id, q), e = Math.hypot(x - X, y - Y); if (e < 8 && (!best || e < best.e)) best = { kind: 'point', pattern: p.id, id: q.id, e }; }
    if (best) return best;
    for (const p of f.d.patterns) for (const s of p.segments) {
      const q = s.type === 'line' ? Array.from({ length: 33 }, (_, i) => { const [a, b] = sample(p, s); return { x: a.x + (b.x - a.x) * i / 32, y: a.y + (b.y - a.y) * i / 32 }; }) : sample(p, s, 32);
      q.forEach((v, i) => { const [x, y] = f.toScreen(p.id, v), e = Math.hypot(x - X, y - Y); if (e < 6 && (!best || e < best.e)) best = { kind: 'edge', pattern: p.id, id: s.id, t: i / 32, e }; });
    }
    if (best) return best;
    for (const p of f.d.patterns) { const at = f.toBoard(X, Y), o = f.lay.get(p.id) || { dx: 0, dy: 0 }, u = { x: at.x - o.dx, y: at.y - o.dy }, ring = p.segments.flatMap((s) => sample(p, s, 12)); let inside = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const a = ring[i], b = ring[j]; if ((a.y > u.y) !== (b.y > u.y) && u.x < (b.x - a.x) * (u.y - a.y) / (b.y - a.y) + a.x) inside = !inside; } if (inside) return { kind: 'piece', pattern: p.id, id: p.id }; }
    return null;
  }
  const activeGrade = (d) => (tool === 'grade' ? (d.grades || []).find((g) => g.size === size) : null);
  const shownPieces = (d) => { const g = activeGrade(d); return g ? d.patterns.map((p) => graded(p, g)) : d.patterns; };
  async function apply(next, done) {
    if (busy) return; busy = true; const before = getDoc();
    try { local = next; draw(); await commit(next); undo.push(before); if (undo.length > 50) undo.shift(); say(done || ''); }
    catch (e) { say(e.message, true); } finally { local = null; busy = false; draw(); }
  }
  const edit = (fn, done) => { try { apply(fn(getDoc()), done); } catch (e) { say(e.message, true); } };
  // The server's own pattern-making operations (POST /edit: dart, pleat, split, internal line, mirror), undone like the rest.
  async function op(args, done) {
    if (busy) return; busy = true; const before = getDoc();
    try { await operate(args); undo.push(before); if (undo.length > 50) undo.shift(); say(done); } catch (e) { say(e.message, true); } finally { busy = false; draw(); }
  }
  const num = (i) => { const v = Number(amounts()[i]); return Number.isFinite(v) && v > 0 ? v : AMOUNTS[tool][i][1]; };
  const length = (pid, sid) => { const p = getDoc().patterns.find((q) => q.id === pid), s = p?.segments.find((v) => v.id === sid); return s ? segLength(p, s) : 0; };

  function draw() {
    const f = frame(), ratio = devicePixelRatio || 1; canvas.width = Math.round(f.w * ratio); canvas.height = Math.round(f.h * ratio);
    const x = canvas.getContext('2d'); x.setTransform(ratio, 0, 0, ratio, 0, 0); x.clearRect(0, 0, f.w, f.h); x.font = '11px "Space Mono", monospace';
    const line = (pid, pts, { width = 1, color = '#000', dash = [] } = {}) => { x.setLineDash(dash); x.lineWidth = width; x.strokeStyle = color; x.beginPath(); pts.forEach((q, i) => { const [X, Y] = f.toScreen(pid, q); i ? x.lineTo(X, Y) : x.moveTo(X, Y); }); x.stroke(); x.setLineDash([]); };
    const is = (h, kind, pid, id) => h && h.kind === kind && h.pattern === pid && h.id === id;
    f.d.seams.forEach((seam, i) => { for (const ref of [seam.a, seam.b]) { const p = f.d.patterns.find((q) => q.id === ref?.pattern); if (!p) continue; for (const sid of seamSide(ref).segments) { const s = p.segments.find((v) => v.id === sid); if (s) line(p.id, sample(p, s, 32), { width: is(hover, 'seam', seam.id, seam.id) ? 7 : 5, color: seamCss(i) }); } } });
    if (tool === 'grade') for (const g of f.d.grades || []) for (const p0 of f.d.patterns) {
      const p = graded(p0, g), on = g.size === size; for (const s of p.segments) line(p.id, sample(p, s, 32), { color: on ? '#e35a1e' : '#bbb', dash: on ? [] : [4, 3] });
      if (on) for (const r of g.rules.filter((v) => v.pattern === p.id)) { const q = p.points.find((v) => v.id === r.point); if (q) { const [X, Y] = f.toScreen(p.id, q); x.fillStyle = '#e35a1e'; x.fillRect(X - 3, Y - 3, 6, 6); } }
    }
    for (const p of f.d.patterns) {
      for (const s of p.segments) { const hot = is(hover, 'edge', p.id, s.id) || is(pick, 'edge', p.id, s.id); line(p.id, sample(p, s, 32), { width: hot ? 3 : 1.5, color: hot ? '#e35a1e' : '#000' }); }
      const m = new Map(p.points.map((q) => [q.id, q]));
      // Internal lines dashed; a notch a short tick into the piece from the stitch line (inward is left of a counter-clockwise edge).
      for (const l of p.internalLines || []) { const s = Array.isArray(l) ? { type: 'line', a: l[0], b: l[1] } : l; if (m.has(s.a) && m.has(s.b)) try { line(p.id, sample(p, s, 24), { dash: [3, 3] }); } catch { /* a line this board cannot read */ } }
      for (const n of p.notches || []) { const s = p.segments.find((v) => v.id === n.segment); if (!s) continue; const q = sample(p, s, 64), last = q.length - 1, g = (n.at ?? 0.5) * last, i = Math.min(last - 1, Math.floor(g)), u = q[i], v = q[i + 1], L = Math.hypot(v.x - u.x, v.y - u.y) || 1, at = { x: u.x + (v.x - u.x) * (g - i), y: u.y + (v.y - u.y) * (g - i) }, tick = 6 / f.k; line(p.id, [at, { x: at.x - (v.y - u.y) / L * tick, y: at.y + (v.x - u.x) / L * tick }], { width: 2 }); }
      for (const s of p.segments) if (s.type === 'bezier') { line(p.id, [m.get(s.a), m.get(s.c1)], { color: '#999' }); line(p.id, [m.get(s.b), m.get(s.c2)], { color: '#999' }); }
      const handles = new Set(p.segments.flatMap((s) => [s.c, s.c1, s.c2]).filter(Boolean));
      for (const q of p.points) { const [X, Y] = f.toScreen(p.id, q), hot = is(hover, 'point', p.id, q.id); x.fillStyle = hot ? '#e35a1e' : handles.has(q.id) ? '#fff' : '#000'; x.strokeStyle = hot ? '#e35a1e' : '#000'; x.lineWidth = 1; if (handles.has(q.id)) { x.beginPath(); x.arc(X, Y, 3.5, 0, 2 * Math.PI); x.fill(); x.stroke(); } else x.fillRect(X - 3, Y - 3, 6, 6); }
      const o = f.lay.get(p.id) || { lo: [0, 0], hi: [0, 0] }, [LX, LY] = f.toScreen(p.id, { x: o.lo[0], y: o.hi[1] }); x.fillStyle = is(hover, 'piece', p.id, p.id) ? '#e35a1e' : '#000'; x.fillText(p.name || p.id, LX, LY - 8, Math.max(20, (o.hi[0] - o.lo[0] + 30) * f.k));
    }
    // Trims as the tech pack marks them (the page's GET /trim-marks), violet.
    for (const [pid, list] of Object.entries(marks() || {})) for (const t of list) { for (const l of t.lines) line(pid, [{ x: l.a[0], y: l.a[1] }, { x: l.b[0], y: l.b[1] }], { color: '#6b2bd9', width: 2 }); for (const q of t.drills || []) { const [X, Y] = f.toScreen(pid, { x: q.at[0], y: q.at[1] }); x.fillStyle = '#6b2bd9'; x.fillRect(X - 3, Y - 3, 6, 6); } }
    if (pick?.kind === 'spot') { const [X, Y] = f.toScreen(pick.pattern, { x: pick.q[0], y: pick.q[1] }); x.fillStyle = '#e35a1e'; x.fillRect(X - 3, Y - 3, 6, 6); }
    if (pen.length) { x.strokeStyle = '#e35a1e'; x.lineWidth = 1.5; x.beginPath(); pen.forEach((q, i) => { const [X, Y] = f.toScreen(null, q); i ? x.lineTo(X, Y) : x.moveTo(X, Y); }); if (drag?.at) x.lineTo(drag.at[0], drag.at[1]); x.stroke(); for (const q of pen) { const [X, Y] = f.toScreen(null, q); x.fillStyle = '#e35a1e'; x.fillRect(X - 3, Y - 3, 6, 6); } }
    // Scale bar: the longest of 1, 2 or 5 × a power of ten under 90 px.
    const pow = 10 ** Math.floor(Math.log10(90 / f.k)), L = [5, 2, 1].map((v) => v * pow).find((v) => v * f.k <= 90), y = f.h - 10;
    x.fillStyle = '#000'; x.strokeStyle = '#000'; x.lineWidth = 1; x.beginPath(); x.moveTo(10, y - 4); x.lineTo(10, y); x.lineTo(10 + L * f.k, y); x.lineTo(10 + L * f.k, y - 4); x.stroke(); x.fillText(`${L} mm`, 16 + L * f.k, y);
    x.fillText(`${tool.toUpperCase()} · ${HELP[tool]}`, 10, 16);
  }
  // A seam is hit where one of its sides is: the edge it sews.
  const seamAt = (h, d) => (h?.kind === 'edge' ? d.seams.find((s) => [s.a, s.b].some((r) => r?.pattern === h.pattern && seamSide(r).segments.includes(h.id))) : null);

  canvas.onpointerdown = (e) => {
    canvas.setPointerCapture(e.pointerId); const r = canvas.getBoundingClientRect(), X = e.clientX - r.left, Y = e.clientY - r.top, f = frame(), h = hit(X, Y, f), d = getDoc();
    if (h?.pattern && h.kind !== 'seam') onSelect(h.pattern);   // the schedule and its properties follow the piece clicked
    if (tool === 'move') { drag = h?.kind === 'point' ? { point: h, moved: false } : { pan: [e.clientX, e.clientY] }; return; }
    if (tool === 'grade') { if (!activeGrade(d)) { say('add a size first: name it in the field and press Enter', true); return; } drag = h?.kind === 'point' ? { point: h, moved: false } : { pan: [e.clientX, e.clientY] }; return; }
    if (tool === 'pen') {
      const at = f.toBoard(X, Y), first = pen[0] && f.toScreen(null, pen[0]);
      if (pen.length >= 3 && Math.hypot(first[0] - X, first[1] - Y) < 8) { const pts = pen; pen = []; edit((doc0) => addPiece(doc0, origin(pts)), 'piece added'); return; }
      pen.push({ x: r2(at.x), y: r2(at.y) }); say(`${pen.length} point${pen.length === 1 ? '' : 's'}${pen.length >= 3 ? ' · Enter or the first point closes' : ''}`); draw(); return;
    }
    if (tool === 'line') {
      const at = f.toBoard(X, Y), inside = h?.kind === 'piece' ? h.pattern : null; if (!inside) { say('click inside a piece', true); return; }
      const o = f.lay.get(inside), q = [r2(at.x - o.dx), r2(at.y - o.dy)];
      if (!pick || pick.pattern !== inside) { pick = { kind: 'spot', pattern: inside, q }; say('now the other end'); draw(); return; }
      const a = pick.q; pick = null; op({ op: 'internalLine', pattern: inside, a, b: q }, 'line drawn'); return;
    }
    if (tool === 'trim') {
      const spot = TRIM_KINDS.point.includes(trimKind), at = f.toBoard(X, Y);
      if (h?.kind === 'piece' && spot) { const o = f.lay.get(h.pattern); edit((doc0) => addTrim(doc0, trimKind, { at: { pattern: h.pattern, u: r2(at.x - o.dx), v: r2(at.y - o.dy) } }), `${trimKind} placed`); }
      else if (h?.kind === 'edge') edit((doc0) => addTrim(doc0, trimKind, spot ? { at: { pattern: h.pattern, segment: h.id, t: Math.round(h.t * 1e4) / 1e4, inset: 10 } } : { along: [{ pattern: h.pattern, segment: h.id }] }), `${trimKind} placed`);
      else say(spot ? 'click inside a piece or on an edge' : 'click the edge it runs along', true);
      return;
    }
    if (!h) return;
    if (h.kind === 'edge') {
      if (tool === 'dart') op({ op: 'dart', pattern: h.pattern, segment: h.id, at: h.t, width: num(0), length: num(1) }, 'dart taken out and sewn');
      if (tool === 'pleat') op({ op: 'pleat', pattern: h.pattern, segment: h.id, at: h.t, intake: num(0) }, 'pleat spread and sewn at the edge');
      if (tool === 'mirror') op({ op: 'mirror', pattern: h.pattern, segment: h.id }, 'mirrored: the other hand is a new piece');
      if (tool === 'notch') edit((doc0) => addNotch(doc0, h.pattern, h.id, h.t), 'notched');
      if (tool === 'allowance') edit((doc0) => setAllowance(doc0, h.pattern, h.id, num(0)), `allowance ${num(0)} mm`);
      if (tool === 'cut') {
        if (!pick || pick.pattern !== h.pattern) { pick = h; say('now the other end of the cut, on the same piece'); draw(); return; }
        const a = pick; pick = null; op({ op: 'split', pattern: h.pattern, from: { segment: a.id, at: a.t }, to: { segment: h.id, at: h.t } }, 'cut in two; the cut is sewn');
      }
    }
    if (tool === 'point' && h.kind === 'edge') edit((doc0) => insertPoint(doc0, h.pattern, h.id, h.t), 'point added');
    if (tool === 'curve' && h.kind === 'edge') { const s = d.patterns.find((p) => p.id === h.pattern).segments.find((v) => v.id === h.id); edit((doc0) => (s.type === 'line' ? toCurve : toLine)(doc0, h.pattern, h.id), s.type === 'line' ? 'edge bent: drag its handles with MOVE' : 'edge straightened'); }
    if (tool === 'seam' && h.kind === 'edge') {
      if (!pick) { pick = h; say(`${h.pattern}.${h.id} · ${length(h.pattern, h.id).toFixed(1)} mm · now the edge it is sewn to`); draw(); return; }
      const a = pick; pick = null; const la = length(a.pattern, a.id), lb = length(h.pattern, h.id);
      edit((doc0) => sewEdges(doc0, { pattern: a.pattern, segment: a.id }, { pattern: h.pattern, segment: h.id }), `sewn: ${la.toFixed(1)} mm to ${lb.toFixed(1)} mm${Math.abs(la - lb) > 1 ? ` · ${Math.abs(la - lb).toFixed(1)} mm of ease` : ''}`);
    }
    if (tool === 'delete') {
      const seam = seamAt(h, d);
      if (h.kind === 'point') edit((doc0) => removePoint(doc0, h.pattern, h.id), 'point deleted');
      else if (seam) edit((doc0) => ({ ...clone(doc0), seams: doc0.seams.filter((s) => s.id !== seam.id) }), `seam ${seam.id} deleted`);
      else if (h.kind === 'piece') edit((doc0) => removePiece(doc0, h.pattern), `${h.pattern} deleted`);
    }
  };
  canvas.onpointermove = (e) => {
    const r = canvas.getBoundingClientRect(), X = e.clientX - r.left, Y = e.clientY - r.top;
    if (drag?.pan) { view.x += e.clientX - drag.pan[0]; view.y += e.clientY - drag.pan[1]; drag.pan = [e.clientX, e.clientY]; draw(); return; }
    if (drag?.point) {
      const f = frame(), at = f.toBoard(X, Y), o = f.lay.get(drag.point.pattern);
      if (tool === 'grade') {
        const base = getDoc().patterns.find((q) => q.id === drag.point.pattern).points.find((v) => v.id === drag.point.id), dx = Math.round(2 * (at.x - o.dx - base.x)) / 2, dy = Math.round(2 * (at.y - o.dy - base.y)) / 2;
        local = gradePoint(getDoc(), size, drag.point.pattern, drag.point.id, dx, dy); drag.moved = true; say(`${drag.point.id} in ${size} · dx ${dx} dy ${dy} mm`); draw(); return;
      }
      local = movePoint(getDoc(), drag.point.pattern, drag.point.id, at.x - o.dx, at.y - o.dy); drag.moved = true;
      const p = local.patterns.find((q) => q.id === drag.point.pattern), q = p.points.find((v) => v.id === drag.point.id); say(`${q.id} · x ${q.x.toFixed(1)} y ${q.y.toFixed(1)} mm`); draw(); return;
    }
    if (tool === 'pen' && pen.length) { drag = { at: [X, Y] }; draw(); return; }
    const h = hit(X, Y), seam = tool === 'delete' ? seamAt(h, getDoc()) : null, next = seam ? { kind: 'seam', pattern: seam.id, id: seam.id } : h;
    if (JSON.stringify(next) !== JSON.stringify(hover)) { hover = next; if (h?.kind === 'edge' && tool !== 'seam') say(`${h.pattern}.${h.id} · ${length(h.pattern, h.id).toFixed(1)} mm`); draw(); }
  };
  canvas.onpointerup = canvas.onpointercancel = () => {
    const was = drag; drag = null;
    if (was?.point && was.moved) { const next = local; local = null; apply(next, tool === 'grade' ? `graded in ${size}` : 'point moved'); }
    else if (was?.point) local = null;
  };
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault(); const r = canvas.getBoundingClientRect(), px = e.clientX - r.left - r.width / 2, py = e.clientY - r.top - r.height / 2;
    if (e.ctrlKey || e.deltaMode) { const f = Math.max(0.1, Math.min(80, view.k * Math.exp(-Math.sign(e.deltaY) * Math.min(0.5, Math.abs(e.deltaY) * 0.01)))) / view.k; view = { k: view.k * f, x: px - (px - view.x) * f, y: py - (py - view.y) * f }; }
    else { view.x -= e.deltaX; view.y -= e.deltaY; }
    draw();
  }, { passive: false });
  canvas.ondblclick = () => { if (tool === 'move') { view = { k: 1, x: 0, y: 0 }; draw(); } };
  function key(e) {
    if (canvas.hidden || e.target.matches?.('input,select,textarea')) return false;
    if (e.key === 'Escape') { pen = []; pick = null; drag = null; say(''); draw(); return true; }
    if (e.key === 'Enter' && tool === 'pen' && pen.length >= 3) { const pts = pen; pen = []; edit((d) => addPiece(d, origin(pts)), 'piece added'); return true; }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && undo.length) { const back = undo.pop(); commit(back).then(() => say('undone')).catch((err) => say(err.message, true)).finally(draw); return true; }
    return false;
  }
  return {
    draw, key, edit,
    setTool(t) { if (!TOOLS.includes(t)) return; tool = t; pen = []; pick = null; hover = null; say(''); draw(); },
    get tool() { return tool; },
    setSize(v) { size = v || null; draw(); },
    setTrimKind(v) { trimKind = v; },
    get amounts() { return AMOUNTS[tool] || []; },
  };
}
export { TOOLS };
