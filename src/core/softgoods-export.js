// Manufacturing exports from the authoritative 2D softgoods document.
// Simulation never changes these coordinates: the pattern is the deliverable.

import fs from 'node:fs';
import path from 'node:path';
import { GraphError } from './errors.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const pointMap = (p) => new Map(p.points.map((q) => [q.id, q]));

export function sampleSegment(pattern, segment, steps = 24) {
  const p = pointMap(pattern), a = p.get(segment.a), b = p.get(segment.b);
  if (segment.type === 'line') return [[a.x, a.y], [b.x, b.y]];
  if (segment.type === 'arc') {
    const c = p.get(segment.c), r = Math.hypot(a.x - c.x, a.y - c.y), a0 = Math.atan2(a.y - c.y, a.x - c.x);
    let sweep = Math.atan2(b.y - c.y, b.x - c.x) - a0; if (sweep <= 0) sweep += 2 * Math.PI;
    return Array.from({ length: steps + 1 }, (_, i) => [c.x + r * Math.cos(a0 + sweep * i / steps), c.y + r * Math.sin(a0 + sweep * i / steps)]);
  }
  const c1 = p.get(segment.c1), c2 = p.get(segment.c2);
  return Array.from({ length: steps + 1 }, (_, i) => { const t = i / steps, u = 1 - t; return [u ** 3 * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t ** 3 * b.x, u ** 3 * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t ** 3 * b.y]; });
}

export function segmentLength(pattern, segment) {
  const q = sampleSegment(pattern, segment, 64); return q.slice(1).reduce((n, p, i) => n + Math.hypot(p[0] - q[i][0], p[1] - q[i][1]), 0);
}
function bounds(pattern) { const x = pattern.points.map((p) => p.x), y = pattern.points.map((p) => p.y); return { min: [Math.min(...x), Math.min(...y)], max: [Math.max(...x), Math.max(...y)] }; }
const line = (a, b, layer) => `0\nLINE\n8\n${layer}\n10\n${a[0]}\n20\n${a[1]}\n30\n0\n11\n${b[0]}\n21\n${b[1]}\n31\n0`;
const text = (at, value, height = 5, rotation = 0) => `0\nTEXT\n8\nTEXT\n10\n${at[0]}\n20\n${at[1]}\n30\n0\n40\n${height}\n50\n${rotation}\n1\n${value}`;

/** R12 DXF: STITCH is exact; CUT is currently the manufacturing boundary metadata plus a visible allowance tick schedule. */
export function patternDXF(pattern) {
  const entities = [];
  for (const loop of pattern.contours) for (const id of loop) { const q = sampleSegment(pattern, pattern.segments.find((s) => s.id === id)); for (let i = 1; i < q.length; i++) entities.push(line(q[i - 1], q[i], 'STITCH')); }
  // Per-edge allowances are represented as dimension ticks until robust curved offset joins land.
  // Never pretend these ticks are a closed cutting contour: the tech pack calls the limitation out.
  for (const s of pattern.segments) {
    const q = sampleSegment(pattern, s), a = q[Math.floor(q.length / 2)], z = q[Math.min(q.length - 1, Math.floor(q.length / 2) + 1)], dx = z[0] - a[0], dy = z[1] - a[1], n = Math.hypot(dx, dy) || 1, mm = Number(pattern.allowances?.[s.id] ?? 0);
    if (mm) entities.push(line(a, [a[0] + dy / n * mm, a[1] - dx / n * mm], 'ALLOWANCE'));
  }
  for (const n of pattern.notches || []) { const s = pattern.segments.find((x) => x.id === n.segment); if (!s) continue; const q = sampleSegment(pattern, s), i = Math.max(0, Math.min(q.length - 1, Math.round((n.at ?? 0.5) * (q.length - 1)))); entities.push(line(q[i], [q[i][0], q[i][1] + Number(n.depth ?? 4)], 'NOTCH')); }
  const b = bounds(pattern), c = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2], ang = Number(pattern.grain?.angle ?? 90) * Math.PI / 180, span = Math.max(20, Math.min(b.max[0] - b.min[0], b.max[1] - b.min[1]) * 0.35), d = [Math.cos(ang) * span, Math.sin(ang) * span];
  entities.push(line([c[0] - d[0], c[1] - d[1]], [c[0] + d[0], c[1] + d[1]], 'GRAIN'));
  entities.push(text([c[0], c[1]], `${pattern.name || pattern.id}  CUT ${pattern.cut || 1}  ${pattern.material || ''}`, Math.max(3, span / 12)));
  const layers = ['STITCH', 'CUT', 'ALLOWANCE', 'NOTCH', 'GRAIN', 'TEXT'].map((n, i) => `0\nLAYER\n2\n${n}\n70\n0\n62\n${[3,7,2,6,4,7][i]}\n6\nCONTINUOUS`).join('\n');
  return `0\nSECTION\n2\nHEADER\n9\n$INSUNITS\n70\n4\n0\nENDSEC\n0\nSECTION\n2\nTABLES\n0\nTABLE\n2\nLAYER\n70\n6\n${layers}\n0\nENDTAB\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n${entities.join('\n')}\n0\nENDSEC\n0\nEOF\n`;
}

export function techPack(document, name = 'softgoods') {
  const patterns = document.patterns.map((p) => ({ id: p.id, name: p.name || p.id, material: p.material || '', cut: p.cut || 1, grain: p.grain || null, allowances: p.allowances || {}, notches: p.notches || [], segments: p.segments.map((s) => ({ id: s.id, type: s.type, lengthMm: +segmentLength(p, s).toFixed(2) })) }));
  const seams = document.seams.map((s) => { const pa = document.patterns.find((p) => p.id === s.a.pattern), pb = document.patterns.find((p) => p.id === s.b.pattern), a = pa?.segments.find((q) => q.id === s.a.segment), b = pb?.segments.find((q) => q.id === s.b.segment); return { ...s, lengthAmm: a ? +segmentLength(pa, a).toFixed(2) : null, lengthBmm: b ? +segmentLength(pb, b).toFixed(2) : null }; });
  return { schema: 'cadgang.softgoods-tech-pack.v1', name, generatedAt: new Date().toISOString(), revision: document.revision, materials: document.materials || {}, patterns, seams, notes: ['All dimensions mm.', 'DXF STITCH geometry is authoritative.', 'CUT contour offset joins are not generated yet; ALLOWANCE layer ticks and this schedule specify per-edge allowances.'] };
}

export function techPackHTML(pack) {
  const rows = pack.patterns.map((p) => `<tr><td>${esc(p.name)}</td><td>${esc(p.material)}</td><td>${p.cut}</td><td>${esc(Object.entries(p.allowances).map(([k, v]) => `${k}: ${v} mm`).join('; '))}</td><td>${esc(p.notches.length)}</td></tr>`).join('');
  const seams = pack.seams.map((s) => `<tr><td>${esc(s.id)}</td><td>${esc(`${s.a.pattern}.${s.a.segment}`)}</td><td>${esc(`${s.b.pattern}.${s.b.segment}`)}</td><td>${s.lengthAmm ?? ''}</td><td>${s.lengthBmm ?? ''}</td><td>${esc(s.kind || 'plain')}</td></tr>`).join('');
  return `<!doctype html><meta charset="utf-8"><title>${esc(pack.name)} tech pack</title><style>body{font:13px monospace;margin:32px;color:#111}h1{font-size:22px}h2{margin-top:32px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #bbb;padding:6px;text-align:left}small{color:#666}@media print{body{margin:12mm}}</style><h1>${esc(pack.name)} · TECH PACK</h1><small>Revision ${pack.revision} · ${esc(pack.generatedAt)}</small><h2>PATTERN SCHEDULE</h2><table><tr><th>Pattern</th><th>Material</th><th>Cut</th><th>Allowances</th><th>Notches</th></tr>${rows}</table><h2>SEAM SCHEDULE</h2><table><tr><th>Seam</th><th>A</th><th>B</th><th>A mm</th><th>B mm</th><th>Type</th></tr>${seams}</table><h2>NOTES</h2><ol>${pack.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ol>`;
}

export function exportSoftgoods(document, dir, name) {
  if (!/^[\w.-]+$/.test(name)) throw new GraphError('Export name may contain letters, digits, dot, dash and underscore only');
  if (!document.patterns.length) throw new GraphError('No softgoods patterns to export');
  fs.mkdirSync(dir, { recursive: true }); const files = [];
  for (const p of document.patterns) { const file = path.join(dir, `${name}_${p.id}.dxf`); fs.writeFileSync(file, patternDXF(p)); files.push(file); }
  const pack = techPack(document, name), json = path.join(dir, `${name}_tech-pack.json`), html = path.join(dir, `${name}_tech-pack.html`); fs.writeFileSync(json, JSON.stringify(pack, null, 2)); fs.writeFileSync(html, techPackHTML(pack)); files.push(json, html);
  return { name, files, patterns: document.patterns.length, seams: document.seams.length };
}
