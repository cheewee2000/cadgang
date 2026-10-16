/**
 * Version history of a cell document: what changed between two snapshots,
 * said in words, plus the on-disk store of versions.
 *
 * A version is a folder entry: <dir>/<n>.json (snapshot, note, auto note,
 * measures, timestamp) and <dir>/<n>.png (a rendered look). The annotation is
 * written by the diff below so every version reads like a commit message
 * nobody had to type — "added 'lid'; changed params on 'body' (h 20 → 24);
 * volume +12%". Claude or the user can append to it.
 */

import fs from 'node:fs';
import path from 'node:path';

const r2 = (v) => Math.round(v * 100) / 100;
const q = (s) => `'${s}'`;

/** Structured + spoken diff between two document snapshots ({cells, output}). */
export function diffSnapshots(prev, next, { measures = null, prevMeasures = null } = {}) {
  const a = new Map((prev?.cells || []).map((c) => [c.id, c]));
  const b = new Map((next?.cells || []).map((c) => [c.id, c]));
  const added = [...b.keys()].filter((id) => !a.has(id));
  const removed = [...a.keys()].filter((id) => !b.has(id));
  const changed = [];
  for (const [id, c] of b) {
    const p = a.get(id);
    if (!p) continue;
    const fields = [];
    if (p.prompt !== c.prompt) fields.push('prompt');
    if (p.code !== c.code) fields.push('code');
    if (JSON.stringify(p.sketch) !== JSON.stringify(c.sketch)) fields.push('sketch');
    if (JSON.stringify(p.selections) !== JSON.stringify(c.selections)) fields.push('selections');
    if (JSON.stringify(p.refs) !== JSON.stringify(c.refs)) fields.push('refs');
    const params = [];
    for (const k of new Set([...Object.keys(p.params || {}), ...Object.keys(c.params || {})])) {
      const from = p.params?.[k], to = c.params?.[k];
      if (JSON.stringify(from) !== JSON.stringify(to)) params.push({ name: k, from, to });
    }
    if (params.length) fields.push('params');
    if (fields.length) changed.push({ id, fields, params });
  }
  const orderA = (prev?.cells || []).filter((c) => b.has(c.id)).map((c) => c.id).join('\u0000');
  const orderB = (next?.cells || []).filter((c) => a.has(c.id)).map((c) => c.id).join('\u0000');
  const reordered = orderA !== orderB;
  const output = (prev?.output ?? null) !== (next?.output ?? null) ? { from: prev?.output ?? null, to: next?.output ?? null } : null;

  const parts = [];
  if (added.length) parts.push(`added ${added.map((id) => q(id) + promptOf(b.get(id))).join(', ')}`);
  if (removed.length) parts.push(`removed ${removed.map(q).join(', ')}`);
  for (const ch of changed) {
    const bits = ch.fields.filter((f) => f !== 'params').map((f) => f);
    if (ch.params.length) bits.push(`params (${ch.params.map((p) => `${p.name} ${fmt(p.from)} → ${fmt(p.to)}`).join(', ')})`);
    parts.push(`changed ${bits.join(', ')} on ${q(ch.id)}`);
  }
  if (reordered) parts.push('reordered the stack');
  if (output) parts.push(`output → ${output.to ? q(output.to) : 'last cell'}`);

  const delta = measureDelta(prevMeasures, measures);
  if (delta.text) parts.push(delta.text);

  return {
    added, removed, changed, reordered, output, delta: delta.values,
    text: parts.length ? parts.join('; ') : 'no change in the stack',
  };
}

function promptOf(cell) {
  const p = String(cell?.prompt || '').trim().replace(/\s+/g, ' ');
  return p ? ` ("${p.length > 60 ? p.slice(0, 57) + '…' : p}")` : '';
}

function fmt(v) {
  if (v === undefined) return '∅';
  if (typeof v === 'number') return String(r2(v));
  return JSON.stringify(v);
}

/** How the measured part moved: volume %, bbox size, body count. */
export function measureDelta(prev, next) {
  if (!prev || !next) return { values: null, text: next ? `volume ${r2(next.volume)} mm³` : '' };
  const values = {
    volumePct: prev.volume ? r2(((next.volume - prev.volume) / prev.volume) * 100) : null,
    size: next.bbox.size.map((s, i) => r2(s - prev.bbox.size[i])),
    bodies: next.bodies - prev.bodies,
  };
  const bits = [];
  if (values.volumePct !== null && Math.abs(values.volumePct) >= 0.05) bits.push(`volume ${values.volumePct > 0 ? '+' : ''}${values.volumePct}%`);
  const grew = values.size.map((d, i) => (Math.abs(d) >= 0.005 ? `${'xyz'[i]} ${d > 0 ? '+' : ''}${d}` : null)).filter(Boolean);
  if (grew.length) bits.push(`size ${grew.join(' ')}`);
  if (values.bodies) bits.push(`${next.bodies} bod${next.bodies === 1 ? 'y' : 'ies'} (was ${prev.bodies})`);
  return { values, text: bits.join(', ') };
}

/** Versions on disk. Numbering is monotonic per directory. */
export class HistoryStore {
  constructor(dir) { this.dir = dir; }

  _ids() {
    if (!fs.existsSync(this.dir)) return [];
    return fs.readdirSync(this.dir).map((f) => /^(\d+)\.json$/.exec(f)?.[1]).filter(Boolean).map(Number).sort((x, y) => x - y);
  }

  list() {
    return this._ids().map((n) => {
      const { snapshot, ...meta } = this.get(n);
      return { ...meta, cells: snapshot.cells.length };
    });
  }

  get(n) {
    const p = path.join(this.dir, `${n}.json`);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  }

  last() {
    const ids = this._ids();
    return ids.length ? this.get(ids[ids.length - 1]) : null;
  }

  pngPath(n) { return path.join(this.dir, `${n}.png`); }

  add({ snapshot, auto, note = '', measures = null, png = null, kind = 'auto' }) {
    fs.mkdirSync(this.dir, { recursive: true });
    const ids = this._ids();
    const n = (ids.length ? ids[ids.length - 1] : 0) + 1;
    const entry = { n, at: new Date().toISOString(), kind, auto, note, measures, snapshot };
    fs.writeFileSync(path.join(this.dir, `${n}.json`), JSON.stringify(entry));
    if (png) fs.writeFileSync(this.pngPath(n), png);
    return entry;
  }

  setNote(n, note) {
    const e = this.get(n);
    if (!e) return null;
    e.note = note;
    fs.writeFileSync(path.join(this.dir, `${n}.json`), JSON.stringify(e));
    return e;
  }
}
