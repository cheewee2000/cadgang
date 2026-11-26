// Manufacturing exports from the authoritative 2D softgoods document.
// Simulation never changes these coordinates: the pattern is the deliverable.

import fs from 'node:fs';
import path from 'node:path';
import { GraphError } from './errors.js';
import { checkDesign, gradePattern } from './softgoods-operations.js';
import { billOfMaterials, bomHTML } from './softgoods-bom.js';

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
const flag = (seam) => (!seam ? '' : seam.ok ? 'OK' : `MISMATCH ${(seam.mismatch * 100).toFixed(1)}%`);
function bounds(pattern) { const x = pattern.points.map((p) => p.x), y = pattern.points.map((p) => p.y); return { min: [Math.min(...x), Math.min(...y)], max: [Math.max(...x), Math.max(...y)] }; }
const line = (a, b, layer) => `0\nLINE\n8\n${layer}\n10\n${a[0]}\n20\n${a[1]}\n30\n0\n11\n${b[0]}\n21\n${b[1]}\n31\n0`;
const text = (at, value, height = 5, rotation = 0) => `0\nTEXT\n8\nTEXT\n10\n${at[0]}\n20\n${at[1]}\n30\n0\n40\n${height}\n50\n${rotation}\n1\n${value}`;
const cross2 = (a, b) => a[0] * b[1] - a[1] * b[0];
const sub2 = (a, b) => [a[0] - b[0], a[1] - b[1]];
const add2 = (a, b) => [a[0] + b[0], a[1] + b[1]];
const mul2 = (a, k) => [a[0] * k, a[1] * k];
const close2 = (a, b, eps = 1e-7) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= eps;

function loopPolyline(pattern, loop, curveStep = 2) {
  const edges = [];
  for (const id of loop) {
    const segment = pattern.segments.find((s) => s.id === id);
    if (!segment) throw new GraphError(`Pattern '${pattern.id}' contour refers to missing segment '${id}'`);
    const rough = sampleSegment(pattern, segment, 64), length = rough.slice(1).reduce((n, q, i) => n + Math.hypot(q[0] - rough[i][0], q[1] - rough[i][1]), 0);
    const q = sampleSegment(pattern, segment, Math.max(1, Math.ceil(length / curveStep)));
    for (let i = 1; i < q.length; i++) if (!close2(q[i - 1], q[i])) edges.push({ a: q[i - 1], b: q[i], segment: id, allowance: Number(pattern.allowances?.[id] ?? 0) });
  }
  if (edges.length < 3 || !close2(edges[0].a, edges.at(-1).b)) throw new GraphError(`Pattern '${pattern.id}' contour is not closed`);
  return edges;
}
function signedArea(edges) { return edges.reduce((n, e) => n + cross2(e.a, e.b), 0) / 2; }
function pointInEdges(edges, p) {
  let inside = false;
  for (const e of edges) if ((e.a[1] > p[1]) !== (e.b[1] > p[1]) && p[0] < (e.b[0] - e.a[0]) * (p[1] - e.a[1]) / (e.b[1] - e.a[1]) + e.a[0]) inside = !inside;
  return inside;
}
function intersection(p, r, q, s) { const d = cross2(r, s); if (Math.abs(d) < 1e-10) return null; return add2(p, mul2(r, cross2(sub2(q, p), s) / d)); }
function orient(a, b, c) { return cross2(sub2(b, a), sub2(c, a)); }
function properCross(a, b, c, d) {
  if (Math.max(a[0], b[0]) < Math.min(c[0], d[0]) - 1e-7 || Math.max(c[0], d[0]) < Math.min(a[0], b[0]) - 1e-7 || Math.max(a[1], b[1]) < Math.min(c[1], d[1]) - 1e-7 || Math.max(c[1], d[1]) < Math.min(a[1], b[1]) - 1e-7) return false;
  const x = orient(a, b, c), y = orient(a, b, d), z = orient(c, d, a), w = orient(c, d, b);
  return x * y < -1e-12 && z * w < -1e-12;
}
function assertSimple(points, patternId) {
  for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++) {
    if (j === i || j === (i + 1) % points.length || i === (j + 1) % points.length) continue;
    if (properCross(points[i], points[(i + 1) % points.length], points[j], points[(j + 1) % points.length])) throw new GraphError(`Pattern '${patternId}' seam allowance self-intersects; reduce an allowance or simplify the corner`);
  }
}

/** Closed manufacturing cutting contours. Contour 0 offsets away from material; contained contours offset into holes. */
export function cutContours(pattern, { curveStep = 2, miterLimit = 4 } = {}) {
  const loops = pattern.contours.map((loop) => loopPolyline(pattern, loop, curveStep));
  return loops.map((edges, loopIndex) => {
    const probe = edges[0].a, depth = loops.filter((other, i) => i !== loopIndex && Math.abs(signedArea(other)) > Math.abs(signedArea(edges)) && pointInEdges(other, probe)).length;
    const materialSide = depth % 2 ? -1 : 1, winding = signedArea(edges) >= 0 ? 1 : -1, side = materialSide * winding;
    const shifted = edges.map((e) => { const d = sub2(e.b, e.a), l = Math.hypot(...d), n = [side * d[1] / l, -side * d[0] / l], o = mul2(n, e.allowance); return { ...e, p: add2(e.a, o), q: add2(e.b, o), d }; });
    const points = [];
    for (let i = 0; i < shifted.length; i++) {
      const prev = shifted[(i + shifted.length - 1) % shifted.length], cur = shifted[i], hit = intersection(prev.p, prev.d, cur.p, cur.d), corner = edges[i].a, limit = miterLimit * Math.max(1, prev.allowance, cur.allowance);
      if (hit && Math.hypot(hit[0] - corner[0], hit[1] - corner[1]) <= limit) points.push(hit);
      else { if (!points.length || !close2(points.at(-1), prev.q)) points.push(prev.q); if (!close2(points.at(-1), cur.p)) points.push(cur.p); }
    }
    const clean = points.filter((q, i) => !i || !close2(q, points[i - 1])); if (clean.length > 1 && close2(clean[0], clean.at(-1))) clean.pop();
    if (clean.length < 3 || Math.abs(clean.reduce((n, q, i) => n + cross2(q, clean[(i + 1) % clean.length]), 0)) < 1e-6) throw new GraphError(`Pattern '${pattern.id}' seam allowance collapsed`);
    assertSimple(clean, pattern.id); return clean;
  });
}

function stitchAt(pattern, segment, at) { const q = sampleSegment(pattern, segment, 128), f = Math.max(0, Math.min(1, Number(at ?? .5))) * (q.length - 1), i = Math.min(q.length - 2, Math.floor(f)), t = f - i; return { p: [q[i][0] + (q[i + 1][0] - q[i][0]) * t, q[i][1] + (q[i + 1][1] - q[i][1]) * t], d: sub2(q[i + 1], q[i]) }; }

/** R12 DXF with exact STITCH geometry and a closed manufacturing CUT contour. */
export function patternDXF(pattern, annotations = []) {
  const entities = [];
  for (const loop of pattern.contours) for (const id of loop) { const q = sampleSegment(pattern, pattern.segments.find((s) => s.id === id)); for (let i = 1; i < q.length; i++) entities.push(line(q[i - 1], q[i], 'STITCH')); }
  for (const q of cutContours(pattern)) for (let i = 0; i < q.length; i++) entities.push(line(q[i], q[(i + 1) % q.length], 'CUT'));
  for (const s of pattern.segments) {
    const { p: a, d } = stitchAt(pattern, s, .5), l = Math.hypot(...d) || 1, mm = Number(pattern.allowances?.[s.id] ?? 0), loop = pattern.contours.find((x) => x.includes(s.id)), outer = signedArea(loopPolyline(pattern, loop)) >= 0 ? [d[1] / l, -d[0] / l] : [-d[1] / l, d[0] / l];
    if (mm) entities.push(line(a, add2(a, mul2(outer, mm)), 'ALLOWANCE'));
  }
  for (const n of pattern.notches || []) {
    const s = pattern.segments.find((x) => x.id === n.segment); if (!s) continue;
    const { p, d } = stitchAt(pattern, s, n.at), l = Math.hypot(...d) || 1, loop = pattern.contours.find((x) => x.includes(s.id)), outward = signedArea(loopPolyline(pattern, loop)) >= 0 ? [d[1] / l, -d[0] / l] : [-d[1] / l, d[0] / l], allowance = Number(pattern.allowances?.[s.id] ?? 0), cut = add2(p, mul2(outward, allowance));
    entities.push(line(cut, add2(cut, mul2(outward, -Number(n.depth ?? 4))), 'NOTCH'));
  }
  for (const annotation of annotations) {
    const points = pointMap(pattern), layer = ({ dart: 'DART', pleat: 'PLEAT', fold_line: 'FOLD' })[annotation.type];
    for (const [aId, bId] of annotation.lines || []) {
      const a = points.get(aId), b = points.get(bId);
      entities.push(line([a.x, a.y], [b.x, b.y], layer));
      if (annotation.label) entities.push(text([(a.x + b.x) / 2, (a.y + b.y) / 2], annotation.label, 3));
    }
  }
  const b = bounds(pattern), c = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2], ang = Number(pattern.grain?.angle ?? 90) * Math.PI / 180, span = Math.max(20, Math.min(b.max[0] - b.min[0], b.max[1] - b.min[1]) * 0.35), d = [Math.cos(ang) * span, Math.sin(ang) * span];
  entities.push(line([c[0] - d[0], c[1] - d[1]], [c[0] + d[0], c[1] + d[1]], 'GRAIN'));
  entities.push(text([c[0], c[1]], `${pattern.name || pattern.id}  CUT ${pattern.cut || 1}  ${pattern.material || ''}`, Math.max(3, span / 12)));
  const layerNames = ['STITCH', 'CUT', 'ALLOWANCE', 'NOTCH', 'GRAIN', 'TEXT', 'DART', 'PLEAT', 'FOLD'];
  const layers = layerNames.map((n, i) => `0\nLAYER\n2\n${n}\n70\n0\n62\n${[3,7,2,6,4,7,1,5,6][i]}\n6\nCONTINUOUS`).join('\n');
  return `0\nSECTION\n2\nHEADER\n9\n$INSUNITS\n70\n4\n0\nENDSEC\n0\nSECTION\n2\nTABLES\n0\nTABLE\n2\nLAYER\n70\n${layerNames.length}\n${layers}\n0\nENDTAB\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n${entities.join('\n')}\n0\nENDSEC\n0\nEOF\n`;
}

export function techPack(document, name = 'softgoods', { fit = null } = {}) {
  const patterns = document.patterns.map((p) => ({ id: p.id, name: p.name || p.id, material: p.material || '', cut: p.cut || 1, grain: p.grain || null, allowances: p.allowances || {}, notches: p.notches || [], annotations: (document.annotations || []).filter((a) => a.pattern === p.id), segments: p.segments.map((s) => ({ id: s.id, type: s.type, lengthMm: +segmentLength(p, s).toFixed(2) })) }));
  const seams = document.seams.map((s) => { const pa = document.patterns.find((p) => p.id === s.a.pattern), pb = document.patterns.find((p) => p.id === s.b.pattern), a = pa?.segments.find((q) => q.id === s.a.segment), b = pb?.segments.find((q) => q.id === s.b.segment); return { ...s, lengthAmm: a ? +segmentLength(pa, a).toFixed(2) : null, lengthBmm: b ? +segmentLength(pb, b).toFixed(2) : null }; });
  return { schema: 'cadgang.softgoods-tech-pack.v1', name, generatedAt: new Date().toISOString(), revision: document.revision, materials: document.materials || {}, patterns, seams, constraints: document.constraints || [], annotations: document.annotations || [], sizes: (document.grades || []).map((g) => g.size), check: checkDesign(document), bom: billOfMaterials(document), notes: ['All dimensions mm.', 'DXF STITCH geometry is authoritative.', 'DXF CUT geometry is the closed seam-allowance cutting boundary; ALLOWANCE records the per-edge schedule.'], ...(fit ? { fit } : {}) };
}

// The optional fit section: a report from src/core/softgoods-measure.js fitReport, which costs a drape, so it is there only when asked for.
function fitHTML(fit) {
  const n = (v) => (v == null ? '' : v), row = (label, material, q) => `<tr><td>${esc(label)}</td><td>${esc(material)}</td><td>${n(q.strain.p50)} / ${n(q.strain.p99)} / ${n(q.strain.max)}</td><td>${n(q.strain.limit)}</td><td>${q.strain.ok ? 'OK' : `${(q.strain.overLimit * 100).toFixed(1)}% OF CLOTH OVER`}</td><td>${q.pressure.unit ? `${q.pressure.p50} / ${q.pressure.p99} / ${q.pressure.max}` : ''}</td><td>${q.contact == null ? '' : `${(q.contact * 100).toFixed(1)}%`}</td></tr>`;
  const ease = fit.ease.map((e) => `<tr><td>${esc(e.level)}</td><td>${n(e.height)}</td><td>${n(e.garment)}</td><td>${n(e.body)}</td><td>${e.ease == null ? 'NOT CLOSED HERE' : e.ease}</td></tr>`).join('');
  return `<h2>FIT · DRAPED PREVIEW</h2><small>${fit.drape.settled ? 'Settled' : 'NOT SETTLED'} after ${fit.drape.steps} steps · ${fit.drape.target} mm mesh · an XPBD preview, not a fit guarantee</small><table><tr><th>Piece</th><th>Material</th><th>Strain % p50 / p99 / max</th><th>Limit %</th><th>Stretch</th><th>Pressure kPa p50 / p99 / max</th><th>In contact</th></tr>${fit.pieces.map((p) => row(p.name, p.material, p)).join('')}${row('ALL', '', fit.overall)}</table>${ease ? `<table><tr><th>Level</th><th>Height mm</th><th>Garment mm</th><th>Body mm</th><th>Ease mm</th></tr>${ease}</table>` : ''}`;
}

export function techPackHTML(pack) {
  const rows = pack.patterns.map((p) => `<tr><td>${esc(p.name)}</td><td>${esc(p.material)}</td><td>${p.cut}</td><td>${esc(Object.entries(p.allowances).map(([k, v]) => `${k}: ${v} mm`).join('; '))}</td><td>${esc(p.notches.length)}</td><td>${esc(p.annotations.map((a) => `${a.type}: ${a.label || a.id}`).join('; '))}</td></tr>`).join('');
  const seams = pack.seams.map((s) => `<tr><td>${esc(s.id)}</td><td>${esc(`${s.a.pattern}.${s.a.segment}`)}</td><td>${esc(`${s.b.pattern}.${s.b.segment}`)}</td><td>${s.lengthAmm ?? ''}</td><td>${s.lengthBmm ?? ''}</td><td>${esc(s.kind || 'plain')}</td><td>${flag(pack.check?.seams.find((q) => q.id === s.id))}</td></tr>`).join('');
  const measured = (list) => list.map((c) => `<li>${esc(c.name || c.id)} · ${esc(c.type)} · target ${c.target} mm · measured ${c.measured} mm · ${c.withinTolerance ? 'OK' : `OUT BY ${c.delta} mm`}</li>`).join('');
  const sizes = (pack.check?.sizes || []).map((z) => `<tr><td>${esc(z.size)}</td><td>${z.ok ? 'OK' : 'CHECK'}</td><td>${esc(z.seams.filter((q) => !q.ok).map((q) => `${q.id}: ${q.lengthA} / ${q.lengthB} mm`).join('; '))}</td><td>${esc(z.constraints.filter((c) => !c.withinTolerance).map((c) => `${c.name || c.id}: ${c.measured} mm`).join('; '))}</td></tr>`).join('');
  return `<!doctype html><meta charset="utf-8"><title>${esc(pack.name)} tech pack</title><style>body{font:13px monospace;margin:32px;color:#111}h1{font-size:22px}h2{margin-top:32px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #bbb;padding:6px;text-align:left}small{color:#666}@media print{body{margin:12mm}}</style><h1>${esc(pack.name)} · TECH PACK</h1><small>Revision ${pack.revision} · ${esc(pack.generatedAt)}</small><h2>PATTERN SCHEDULE</h2><table><tr><th>Pattern</th><th>Material</th><th>Cut</th><th>Allowances</th><th>Notches</th><th>Annotations</th></tr>${rows}</table><h2>SEAM SCHEDULE</h2><table><tr><th>Seam</th><th>A</th><th>B</th><th>A mm</th><th>B mm</th><th>Type</th><th>Lengths</th></tr>${seams}</table><h2>MEASUREMENT CONSTRAINTS</h2><ul>${measured(pack.check?.constraints || [])}</ul>${sizes ? `<h2>GRADED SIZES</h2><table><tr><th>Size</th><th>Check</th><th>Seams that no longer match</th><th>Measurements out of tolerance</th></tr>${sizes}</table>` : ''}${pack.bom ? bomHTML(pack.bom) : ''}${pack.fit ? fitHTML(pack.fit) : ''}<h2>NOTES</h2><ol>${pack.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ol>`;
}

export function exportSoftgoods(document, dir, name, { fit = null } = {}) {
  if (!/^[\w.-]+$/.test(name)) throw new GraphError('Export name may contain letters, digits, dot, dash and underscore only');
  if (!document.patterns.length) throw new GraphError('No softgoods patterns to export');
  fs.mkdirSync(dir, { recursive: true }); const files = [];
  for (const p of document.patterns) { const file = path.join(dir, `${name}_${p.id}.dxf`); fs.writeFileSync(file, patternDXF(p, (document.annotations || []).filter((a) => a.pattern === p.id))); files.push(file); }
  // A graded size is the same pattern with its points moved: same segments, allowances, notches and annotations.
  for (const g of document.grades || []) for (const p of document.patterns) { const graded = gradePattern(p, { size: g.size, rules: g.rules.filter((r) => r.pattern === p.id).map(({ point, dx, dy }) => ({ point, dx, dy })) }), file = path.join(dir, `${name}_${graded.id}.dxf`); fs.writeFileSync(file, patternDXF({ ...graded, name: `${p.name || p.id} ${g.size}` }, (document.annotations || []).filter((a) => a.pattern === p.id))); files.push(file); }
  const pack = techPack(document, name, { fit }), json = path.join(dir, `${name}_tech-pack.json`), html = path.join(dir, `${name}_tech-pack.html`); fs.writeFileSync(json, JSON.stringify(pack, null, 2)); fs.writeFileSync(html, techPackHTML(pack)); files.push(json, html);
  return { name, files, patterns: document.patterns.length, seams: document.seams.length, sizes: pack.sizes, check: { ok: pack.check.ok, seams: pack.check.seams.filter((q) => !q.ok), constraints: pack.check.constraints.filter((c) => !c.withinTolerance), sizes: pack.check.sizes.filter((z) => !z.ok).map((z) => z.size) } };
}

// The same R12 writer, for exports that are not one pattern (the marker lays many pieces in one file). layers: [[name, AutoCAD colour index], ...]; blocks: whole BLOCK ... ENDBLK records.
export const dxfLine = line, dxfText = text;
export function dxfFile(entities, layers, blocks = []) {
  const table = layers.map(([n, colour]) => `0\nLAYER\n2\n${n}\n70\n0\n62\n${colour}\n6\nCONTINUOUS`).join('\n');
  return `0\nSECTION\n2\nHEADER\n9\n$INSUNITS\n70\n4\n0\nENDSEC\n0\nSECTION\n2\nTABLES\n0\nTABLE\n2\nLAYER\n70\n${layers.length}\n${table}\n0\nENDTAB\n0\nENDSEC\n${blocks.length ? `0\nSECTION\n2\nBLOCKS\n${blocks.join('\n')}\n0\nENDSEC\n` : ''}0\nSECTION\n2\nENTITIES\n${entities.join('\n')}\n0\nENDSEC\n0\nEOF\n`;
}
