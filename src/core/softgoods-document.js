// The persistent source of truth for softgoods design.
// 2D patterns are authoritative; arrangement and future simulation consume them.
// IDs, rather than array positions, keep seams and annotations attached through edits.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { GraphError } from './errors.js';
import { resolveMaterial } from './softgoods-fabrics.js';
import { sampleSegment } from './softgoods-export.js';
import { insideLoop, segmentDistance } from './softgoods-mesh.js';
import { seamSide } from './softgoods-seams.js';
import { validatePhysics, validateTack } from './softgoods-physics.js';
import { validateTrims, elasticEntry } from './softgoods-trims.js';
import { validateBodies } from './softgoods-bodies.js';

const ID = /^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/;
const TYPES = new Set(['line', 'arc', 'bezier']);
const finite = (v) => Number.isFinite(Number(v));
const clone = (v) => structuredClone(v);
const uid = (prefix) => `${prefix}_${crypto.randomBytes(5).toString('hex')}`;

function identifier(id, what) {
  if (!ID.test(String(id || ''))) throw new GraphError(`${what} id '${id}' must match ${ID}`);
  return String(id);
}
function point(p, what) {
  if (!p || !finite(p.x) || !finite(p.y)) throw new GraphError(`${what} needs finite x and y coordinates`);
  return { id: identifier(p.id, what), x: Number(p.x), y: Number(p.y) };
}
function vec3(v, what) {
  if (!Array.isArray(v) || v.length !== 3 || !v.every(finite)) throw new GraphError(`${what} must be three finite numbers`);
  return v.map(Number);
}

/** A pattern's contours as sampled closed polygons, largest first: the first is the outer edge of the material, the rest are holes in it. */
export function patternLoops(pattern, steps = 48) {
  const area = (q) => Math.abs(q.reduce((n, a, i) => { const b = q[(i + 1) % q.length]; return n + a[0] * b[1] - b[0] * a[1]; }, 0));
  return (pattern.contours || []).map((loop) => loop.flatMap((id) => { const s = pattern.segments.find((q) => q.id === id); return sampleSegment(pattern, s, s.type === 'line' ? 1 : steps).slice(0, -1); })).sort((a, b) => area(b) - area(a));
}
/** Is a point in the material: inside the outer edge and outside every hole, or within tolerance (mm) of an edge. */
export function inMaterial(loops, p, tolerance = 0.5) {
  if (tolerance > 0 && loops.some((l) => l.some((a, i) => segmentDistance(p, a, l[(i + 1) % l.length]) <= tolerance))) return true;
  return loops.length > 0 && insideLoop(loops[0], p) && !loops.slice(1).some((l) => insideLoop(l, p));
}
/** An internal line is a point pair [a, b] or a segment-shaped {id, type, a, b, ...}; either way, read it as a segment. */
export const internalSegment = (l) => (Array.isArray(l) ? { type: 'line', a: l[0], b: l[1] } : l);
const defaults = () => ({ version: 1, revision: 0, materials: {}, patterns: [], seams: [], attachments: [], arrangement: [], constraints: [], annotations: [], grades: [], trims: [], simulation: { status: 'not_run' } });

export function validateSoftgoodsDocument(value) {
  const d = { ...defaults(), ...clone(value || {}) };
  if (d.version !== 1) throw new GraphError(`Softgoods document version ${d.version} is not supported`);
  if (!Array.isArray(d.patterns) || !Array.isArray(d.seams) || !Array.isArray(d.attachments) || !Array.isArray(d.arrangement) || !Array.isArray(d.constraints) || !Array.isArray(d.annotations) || !Array.isArray(d.grades)) throw new GraphError('patterns, seams, attachments, arrangement, constraints, annotations and grades must be arrays');
  // A material may stand on a fabric-library preset ({ preset: 'nylon-500d', ...overrides }); the preset has to exist.
  for (const [id, m] of Object.entries(d.materials || {})) resolveMaterial(m, id);
  const patterns = new Map();
  for (const raw of d.patterns) {
    const id = identifier(raw.id, 'pattern');
    if (patterns.has(id)) throw new GraphError(`Two patterns are named '${id}'`);
    const points = new Map((raw.points || []).map((p) => { const q = point(p, `pattern '${id}' point`); return [q.id, q]; }));
    if (points.size !== (raw.points || []).length) throw new GraphError(`Pattern '${id}' has duplicate point ids`);
    const segments = new Map();
    for (const s of raw.segments || []) {
      const sid = identifier(s.id, `pattern '${id}' segment`);
      if (segments.has(sid)) throw new GraphError(`Pattern '${id}' has two segments named '${sid}'`);
      if (!TYPES.has(s.type)) throw new GraphError(`Segment '${sid}' has unknown type '${s.type}'`);
      for (const key of ['a', 'b']) if (!points.has(s[key])) throw new GraphError(`Segment '${sid}' refers to missing point '${s[key]}'`);
      if (s.type === 'arc' && !points.has(s.c)) throw new GraphError(`Arc '${sid}' refers to missing centre '${s.c}'`);
      if (s.type === 'bezier') for (const key of ['c1', 'c2']) if (!points.has(s[key])) throw new GraphError(`Bezier '${sid}' refers to missing control point '${s[key]}'`);
      segments.set(sid, s);
    }
    for (const loop of raw.contours || []) {
      if (!Array.isArray(loop) || loop.length < 3) throw new GraphError(`Pattern '${id}' contours need at least three segments`);
      for (const sid of loop) if (!segments.has(sid)) throw new GraphError(`Pattern '${id}' contour refers to missing segment '${sid}'`);
      for (let i = 0; i < loop.length; i++) {
        const a = segments.get(loop[i]), b = segments.get(loop[(i + 1) % loop.length]);
        if (a.b !== b.a) throw new GraphError(`Pattern '${id}' contour is open between '${a.id}' and '${b.id}'`);
      }
    }
    const allowances = raw.allowances || {};
    for (const [sid, mm] of Object.entries(allowances)) if (!segments.has(sid) || !finite(mm) || Number(mm) < 0) throw new GraphError(`Pattern '${id}' has an invalid allowance on '${sid}'`);
    // Internal lines (stitch lines, pocket placements, folds drawn on the piece) use the pattern's own points and stay on the material.
    if (raw.internalLines != null && !Array.isArray(raw.internalLines)) throw new GraphError(`Pattern '${id}' internalLines must be an array`);
    const loops = raw.internalLines?.length ? patternLoops(raw) : [], lineIds = new Set();
    for (const item of raw.internalLines || []) {
      const l = internalSegment(item), what = `Pattern '${id}' internal line '${l?.id ?? [l?.a, l?.b].join('-')}'`;
      if (!l || !TYPES.has(l.type) || (Array.isArray(item) && item.length !== 2)) throw new GraphError(`${what} must be a point pair or a line, arc or bezier`);
      if (l.id != null) { identifier(l.id, what); if (lineIds.has(l.id)) throw new GraphError(`Pattern '${id}' has two internal lines named '${l.id}'`); lineIds.add(l.id); }
      for (const key of ['a', 'b', ...(l.type === 'arc' ? ['c'] : l.type === 'bezier' ? ['c1', 'c2'] : [])]) if (!points.has(l[key])) throw new GraphError(`${what} refers to missing point '${l[key]}'`);
      const ends = sampleSegment(raw, l, 24), along = l.type === 'line' ? Array.from({ length: 9 }, (_, i) => [ends[0][0] + (ends[1][0] - ends[0][0]) * i / 8, ends[0][1] + (ends[1][1] - ends[0][1]) * i / 8]) : ends;
      if (along.some((q) => !inMaterial(loops, q))) throw new GraphError(`${what} leaves the outline`);
    }
    patterns.set(id, { ...raw, points, segments });
  }
  const seamIds = new Set();
  for (const s of d.seams) {
    const id = identifier(s.id, 'seam');
    if (seamIds.has(id)) throw new GraphError(`Two seams are named '${id}'`); seamIds.add(id);
    for (const side of ['a', 'b']) {
      // A side is one segment, part of one (from, to as fractions of its length), or several that follow one another along the outline.
      const ref = s[side], p = patterns.get(ref?.pattern), span = seamSide(ref), gone = span.segments.find((sid) => !p?.segments.has(sid));
      if (!p || !span.segments.length || gone != null) throw new GraphError(`Seam '${id}' ${side} refers to missing segment '${ref?.pattern}.${gone ?? ref?.segment}'`);
      if (ref.segment != null && ref.segments != null) throw new GraphError(`Seam '${id}' ${side} names segment or segments, not both`);
      for (let i = 1; i < span.segments.length; i++) if (p.segments.get(span.segments[i - 1]).b !== p.segments.get(span.segments[i]).a) throw new GraphError(`Seam '${id}' ${side} segments '${span.segments[i - 1]}' and '${span.segments[i]}' do not follow one another along the outline`);
      if (!(span.from >= 0 && span.from < 1 && span.to > 0 && span.to <= 1) || (span.segments.length === 1 && span.from >= span.to)) throw new GraphError(`Seam '${id}' ${side} from and to must be fractions 0..1 of its first and last segment, from before to`);
    }
    if (s.ease != null && (!finite(s.ease) || Number(s.ease) < 0)) throw new GraphError(`Seam '${id}' ease must be non-negative`);
  }
  const attachmentIds = new Set();
  for (const a of d.attachments) {
    const id = identifier(a.id, 'attachment'); if (attachmentIds.has(id)) throw new GraphError(`Two attachments are named '${id}'`); attachmentIds.add(id);
    if (!patterns.has(a.pattern)) throw new GraphError(`Attachment '${id}' refers to missing pattern '${a.pattern}'`);
    if (!Array.isArray(a.at) || a.at.length !== 2 || !a.at.every(finite)) throw new GraphError(`Attachment '${id}' at must be two finite pattern coordinates`);
    if (!validateTack(a, patterns)) vec3(a.to, `Attachment '${id}' target`);
  }
  const arranged = new Set();
  for (const a of d.arrangement) {
    const pid = identifier(a.pattern, 'arrangement pattern');
    if (!patterns.has(pid)) throw new GraphError(`Arrangement refers to missing pattern '${pid}'`);
    if (arranged.has(pid)) throw new GraphError(`Pattern '${pid}' is arranged twice`); arranged.add(pid);
    vec3(a.position || [0, 0, 0], `Arrangement '${pid}' position`);
    vec3(a.rotation || [0, 0, 0], `Arrangement '${pid}' rotation`);
  }
  const constraintIds = new Set();
  for (const c of d.constraints) {
    const id = identifier(c.id, 'constraint');
    if (constraintIds.has(id)) throw new GraphError(`Two constraints are named '${id}'`); constraintIds.add(id);
    if (!['distance', 'length'].includes(c.type)) throw new GraphError(`Constraint '${id}' has unknown type '${c.type}'`);
    if (!finite(c.target) || Number(c.target) < 0 || (c.tolerance != null && (!finite(c.tolerance) || Number(c.tolerance) < 0))) throw new GraphError(`Constraint '${id}' target and tolerance must be non-negative finite numbers`);
    if (c.type === 'distance') {
      for (const side of ['a', 'b']) { const ref = c[side], p = patterns.get(ref?.pattern); if (!p?.points.has(ref?.point)) throw new GraphError(`Constraint '${id}' ${side} refers to missing point '${ref?.pattern}.${ref?.point}'`); }
    } else {
      const p = patterns.get(c.pattern);
      if (!p) throw new GraphError(`Constraint '${id}' refers to missing pattern '${c.pattern}'`);
      const ids = c.segments ?? p.contours[c.contour];
      if (!Array.isArray(ids) || !ids.length || ids.some((sid) => !p.segments.has(sid))) throw new GraphError(`Constraint '${id}' needs existing segment ids or a valid contour index`);
      if (c.segments && c.contour != null) throw new GraphError(`Constraint '${id}' must use segments or contour, not both`);
    }
  }
  const annotationIds = new Set();
  for (const a of d.annotations) {
    const id = identifier(a.id, 'annotation');
    if (annotationIds.has(id)) throw new GraphError(`Two annotations are named '${id}'`); annotationIds.add(id);
    if (!['dart', 'pleat', 'fold_line'].includes(a.type)) throw new GraphError(`Annotation '${id}' has unknown type '${a.type}'`);
    const p = patterns.get(a.pattern);
    if (!p) throw new GraphError(`Annotation '${id}' refers to missing pattern '${a.pattern}'`);
    if (!Array.isArray(a.lines) || !a.lines.length) throw new GraphError(`Annotation '${id}' needs at least one point-pair line`);
    for (const pair of a.lines) if (!Array.isArray(pair) || pair.length !== 2 || pair.some((pid) => !p.points.has(pid))) throw new GraphError(`Annotation '${id}' has a line referring to a missing point`);
  }
  const sizes = new Set();
  for (const g of d.grades) {
    if (!g || typeof g.size !== 'string' || !g.size.trim()) throw new GraphError('A grade needs a size name');
    if (sizes.has(g.size)) throw new GraphError(`Two grades are named '${g.size}'`); sizes.add(g.size);
    if (!Array.isArray(g.rules)) throw new GraphError(`Grade '${g.size}' rules must be an array`);
    const moved = new Set();
    for (const rule of g.rules) {
      if (!patterns.get(rule.pattern)?.points.has(rule.point)) throw new GraphError(`Grade '${g.size}' refers to missing point '${rule.pattern}.${rule.point}'`);
      if (!finite(rule.dx) || !finite(rule.dy)) throw new GraphError(`Grade '${g.size}' rule for '${rule.pattern}.${rule.point}' needs finite dx and dy`);
      if (moved.has(`${rule.pattern}.${rule.point}`)) throw new GraphError(`Grade '${g.size}' moves '${rule.pattern}.${rule.point}' twice`); moved.add(`${rule.pattern}.${rule.point}`);
    }
  }
  validatePhysics(d, patterns);
  // Trims and hardware are placed on the patterns above; softgoods-trims.js owns their schema and derives their geometry.
  if (!Array.isArray(d.trims)) throw new GraphError('trims must be an array');
  validateTrims(d);
  // Bodies (CAD solids the cloth drapes on), where each placed piece goes (an avatar region or a body), and the floor.
  validateBodies(d);
  return d;
}

export class SoftgoodsDocument {
  constructor(filePath = null) { this.filePath = filePath; this._listeners = new Set(); this.load(); }
  load() {
    if (!this.filePath) { this.data = defaults(); return; }
    try { this.data = validateSoftgoodsDocument(JSON.parse(fs.readFileSync(this.filePath, 'utf8'))); }
    catch (e) {
      if (e.code !== 'ENOENT' && !(e instanceof SyntaxError) && !(e instanceof GraphError)) throw e;
      // A hand-edited file that no longer validates must not stop the server or a project switch: start empty and say so.
      if (e.code !== 'ENOENT') console.error(`softgoods: ignoring ${this.filePath}: ${e.message}`);
      this.data = defaults();
    }
  }
  onChange(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }
  toJSON() { return clone(this.data); }
  // The revision is the server's, not the caller's: a replacement keeps counting so pages notice every change.
  replace(value) { this.data = validateSoftgoodsDocument({ ...value, revision: this.data.revision }); this.touch(); return this.toJSON(); }
  touch() {
    this.data.revision = (this.data.revision || 0) + 1;
    if (this.filePath) { fs.mkdirSync(path.dirname(this.filePath), { recursive: true }); const tmp = `${this.filePath}.tmp`; fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2)); fs.renameSync(tmp, this.filePath); }
    for (const fn of this._listeners) fn(this);
  }
  addRectangle({ id, name = null, width = 200, height = 150, allowance = 10, material = 'canvas' } = {}) {
    id = identifier(id || uid('pattern'), 'pattern');
    if (this.data.patterns.some((p) => p.id === id)) throw new GraphError(`Pattern '${id}' already exists`);
    if (!(finite(width) && Number(width) > 0 && finite(height) && Number(height) > 0)) throw new GraphError('width and height must be positive');
    const p = ['bl', 'br', 'tr', 'tl'].map((n) => `${id}_${n}`), s = ['bottom', 'right', 'top', 'left'].map((n) => `${id}_${n}`);
    const pattern = { id, name: name || id, material, cut: 1, points: [
      { id: p[0], x: 0, y: 0 }, { id: p[1], x: Number(width), y: 0 }, { id: p[2], x: Number(width), y: Number(height) }, { id: p[3], x: 0, y: Number(height) },
    ], segments: s.map((sid, i) => ({ id: sid, type: 'line', a: p[i], b: p[(i + 1) % 4] })), contours: [s], allowances: Object.fromEntries(s.map((sid) => [sid, Number(allowance)])), notches: [], grain: { angle: 90 }, internalLines: [] };
    this.data.patterns.push(pattern); this.data.arrangement.push({ pattern: id, position: [this.data.arrangement.length * 240, 0, 0], rotation: [0, 0, 0], layer: 0 }); this.touch(); return clone(pattern);
  }
  updatePoint(patternId, pointId, x, y) {
    const p = this.data.patterns.find((x) => x.id === patternId), q = p?.points.find((x) => x.id === pointId);
    if (!q) throw new GraphError(`No point '${patternId}.${pointId}'`); if (!finite(x) || !finite(y)) throw new GraphError('Point coordinates must be finite');
    q.x = Number(x); q.y = Number(y); validateSoftgoodsDocument(this.data); this.touch(); return clone(q);
  }
  addSeam({ id, a, b, flip = true, ease = 0, kind = 'plain' }) {
    id = identifier(id || uid('seam'), 'seam');
    const seam = { id, a: clone(a), b: clone(b), flip: !!flip, ease: Number(ease), kind, correspondence: [] };
    const next = clone(this.data); next.seams.push(seam); validateSoftgoodsDocument(next); this.data = next; this.touch(); return clone(seam);
  }
  // Trims go through the same door as everything else: the whole document is validated with the change before it is kept.
  _commit(next, result) { this.data = validateSoftgoodsDocument(next); this.touch(); return clone(result); }
  addTrim(trim) {
    let t = { ...clone(trim || {}), id: identifier(trim?.id || uid(String(trim?.kind || 'trim').replace(/[^a-zA-Z0-9_-]/g, '_')), 'trim') }; const next = clone(this.data), e = elasticEntry(t);
    if (next.trims.some((x) => x.id === t.id)) throw new GraphError(`Trim '${t.id}' already exists`);
    // An elastic on one whole edge or between two points is the cloth preview's to gather: its ratio is kept once, in elastics[], and the trim points at it.
    if (e) {
      if ((next.elastics ||= []).some((x) => x.id === e.id)) throw new GraphError(`Elastic '${e.id}' already exists: point the trim at it with elastic: '${e.id}'`);
      const { along, path, spec: { ratio, ...spec }, ...rest } = t; next.elastics.push(e); t = { ...rest, spec, elastic: e.id };
    }
    next.trims.push(t); return this._commit(next, t);
  }
  /** Fields given replace the trim's own; spec is merged key by key; null removes a field or a spec key. */
  updateTrim(id, patch = {}) {
    const next = clone(this.data), t = next.trims.find((x) => x.id === id); if (!t) throw new GraphError(`No trim '${id}'`);
    if (patch.id != null && patch.id !== id) throw new GraphError('A trim keeps its id: remove it and add another to rename it');
    const strip = (o) => { for (const k of Object.keys(o)) if (o[k] === null) delete o[k]; return o; };
    // The ratio of an elastic the trim points at lives on that elastic: a new one is written there.
    if (t.elastic != null && patch.spec?.ratio != null) { const e = (next.elastics || []).find((x) => x.id === t.elastic) || next.seams.find((x) => x.id === t.elastic)?.elastic; if (e) e.ratio = patch.spec.ratio; patch = { ...patch, spec: { ...patch.spec, ratio: null } }; }
    Object.assign(t, clone(patch), patch.spec === undefined ? {} : { spec: patch.spec === null ? null : strip({ ...(t.spec || {}), ...clone(patch.spec) }) }); strip(t);
    return this._commit(next, t);
  }
  removeTrim(id) {
    const next = clone(this.data), i = next.trims.findIndex((x) => x.id === id); if (i < 0) throw new GraphError(`No trim '${id}'`);
    const [gone] = next.trims.splice(i, 1);
    // The elastic an elastic trim brought with it (same id) goes with it; one the design already had stays.
    if (gone.elastic != null && gone.elastic === gone.id && next.elastics) next.elastics = next.elastics.filter((e) => e.id !== gone.id);
    return this._commit(next, gone);
  }
  updateArrangement(patternId, { position, rotation, layer } = {}) {
    const a = this.data.arrangement.find((x) => x.pattern === patternId); if (!a) throw new GraphError(`Pattern '${patternId}' has no arrangement`);
    if (position) a.position = vec3(position, 'position'); if (rotation) a.rotation = vec3(rotation, 'rotation'); if (layer != null) a.layer = Number(layer);
    this.touch(); return clone(a);
  }
}
