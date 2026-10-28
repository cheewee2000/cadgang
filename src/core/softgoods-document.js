// The persistent source of truth for softgoods design.
// 2D patterns are authoritative; arrangement and future simulation consume them.
// IDs, rather than array positions, keep seams and annotations attached through edits.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { GraphError } from './errors.js';

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
const defaults = () => ({ version: 1, revision: 0, materials: {}, patterns: [], seams: [], arrangement: [], simulation: { status: 'not_run' } });

export function validateSoftgoodsDocument(value) {
  const d = { ...defaults(), ...clone(value || {}) };
  if (d.version !== 1) throw new GraphError(`Softgoods document version ${d.version} is not supported`);
  if (!Array.isArray(d.patterns) || !Array.isArray(d.seams) || !Array.isArray(d.arrangement)) throw new GraphError('patterns, seams and arrangement must be arrays');
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
    patterns.set(id, { ...raw, points, segments });
  }
  const seamIds = new Set();
  for (const s of d.seams) {
    const id = identifier(s.id, 'seam');
    if (seamIds.has(id)) throw new GraphError(`Two seams are named '${id}'`); seamIds.add(id);
    for (const side of ['a', 'b']) {
      const ref = s[side], p = patterns.get(ref?.pattern);
      if (!p || !p.segments.has(ref.segment)) throw new GraphError(`Seam '${id}' ${side} refers to missing segment '${ref?.pattern}.${ref?.segment}'`);
    }
    if (s.ease != null && (!finite(s.ease) || Number(s.ease) < 0)) throw new GraphError(`Seam '${id}' ease must be non-negative`);
  }
  const arranged = new Set();
  for (const a of d.arrangement) {
    const pid = identifier(a.pattern, 'arrangement pattern');
    if (!patterns.has(pid)) throw new GraphError(`Arrangement refers to missing pattern '${pid}'`);
    if (arranged.has(pid)) throw new GraphError(`Pattern '${pid}' is arranged twice`); arranged.add(pid);
    vec3(a.position || [0, 0, 0], `Arrangement '${pid}' position`);
    vec3(a.rotation || [0, 0, 0], `Arrangement '${pid}' rotation`);
  }
  return d;
}

export class SoftgoodsDocument {
  constructor(filePath = null) { this.filePath = filePath; this._listeners = new Set(); this.load(); }
  load() {
    if (!this.filePath) { this.data = defaults(); return; }
    try { this.data = validateSoftgoodsDocument(JSON.parse(fs.readFileSync(this.filePath, 'utf8'))); }
    catch (e) { if (e.code !== 'ENOENT' && !(e instanceof SyntaxError)) throw e; this.data = defaults(); }
  }
  onChange(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }
  toJSON() { return clone(this.data); }
  replace(value) { this.data = validateSoftgoodsDocument(value); this.touch(); return this.toJSON(); }
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
  updateArrangement(patternId, { position, rotation, layer } = {}) {
    const a = this.data.arrangement.find((x) => x.pattern === patternId); if (!a) throw new GraphError(`Pattern '${patternId}' has no arrangement`);
    if (position) a.position = vec3(position, 'position'); if (rotation) a.rotation = vec3(rotation, 'rotation'); if (layer != null) a.layer = Number(layer);
    this.touch(); return clone(a);
  }
}
