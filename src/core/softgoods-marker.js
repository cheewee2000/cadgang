// Marker making: every cut piece of one material laid on a roll of a given usable width, as short as the heuristic gets it.
// The roll runs along +x (its length is what is being minimised) and its width along +y. A piece's grain is laid along
// the roll; turns of 180 degrees are allowed unless the cloth has a nap, and 90 degree or free turns only when asked.
//
// The heuristic is a scanline bottom-left fill on the true cut outlines, not their bounding boxes: the roll is sliced into
// bands across its width, each piece is the exact x-extent of its outline inside every band it touches, and a piece is
// slid along the roll to the first place where none of its bands meets an occupied one. Positions across the width are
// whole bands (`resolution` mm), positions along the roll are exact. Largest first, in a few orders, shortest marker kept.
// ponytail: no no-fit polygons and no compaction pass; expect roughly 60-80% on garment-like pieces where a commercial
// nester reaches 80-90%. Swap `nest` for an NFP placer if yield starts to cost real money.

import { GraphError } from './errors.js';
import { cutContours, capDarts, patternDXF, dxfFile, dxfLine, dxfText } from './softgoods-export.js';
import { trimMarks } from './softgoods-trims.js';
import { gradeDocument } from './softgoods-operations.js';
import { resolveMaterial } from './softgoods-fabrics.js';

export const DEFAULT_ROLL_WIDTH = 1500;
const EPS = 1e-7;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const n = (v) => +v.toFixed(3);
const snap = (v) => (Math.abs(v - Math.round(v)) < 1e-12 ? Math.round(v) : v);
const area = (q) => q.reduce((sum, p, i) => sum + p[0] * q[(i + 1) % q.length][1] - q[(i + 1) % q.length][0] * p[1], 0) / 2;
const apply = (m, p) => [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];

/** The LINE and TEXT entities and the layer table of an R12 DXF written by this exporter. */
export function dxfEntities(dxf) {
  const rows = dxf.split('\n'), layers = {}, lines = [], texts = [];
  let section = '', rec = null;
  const flush = () => {
    if (!rec) return;
    if (rec[0] === 'SECTION') section = rec[2];
    else if (section === 'TABLES' && rec[0] === 'LAYER') layers[rec[2]] = Number(rec[62]);
    else if (section === 'ENTITIES' && rec[0] === 'LINE') lines.push({ layer: rec[8], a: [Number(rec[10]), Number(rec[20])], b: [Number(rec[11]), Number(rec[21])] });
    else if (section === 'ENTITIES' && rec[0] === 'TEXT') texts.push({ layer: rec[8], at: [Number(rec[10]), Number(rec[20])], height: Number(rec[40]), rotation: Number(rec[50] || 0), value: rec[1] });
  };
  for (let i = 0; i + 1 < rows.length; i += 2) {
    const code = rows[i].trim();
    if (code === '0') { flush(); rec = { 0: rows[i + 1].trim() }; } else if (rec && !(code in rec)) rec[code] = rows[i + 1];
  }
  flush();
  return { layers, lines, texts };
}

/** Every size asked for, as [{ size, units, document }]. 'base' is the pattern as drawn; the others are the document's grades. sizes: ['base', 'L'] or { base: 1, L: 2 }. */
export function sizeSet(document, sizes) {
  const wanted = sizes == null ? { base: 1 } : Array.isArray(sizes) ? Object.fromEntries(sizes.map((s) => [s, 1])) : sizes, out = [];
  for (const [size, units] of Object.entries(wanted)) {
    if (!(Number.isInteger(Number(units)) && Number(units) > 0)) throw new GraphError(`Size '${size}' needs a whole number of units, at least 1`);
    const grade = size === 'base' ? null : (document.grades || []).find((g) => g.size === size);
    if (size !== 'base' && !grade) throw new GraphError(`No graded size '${size}'. Known: ${['base', ...(document.grades || []).map((g) => g.size)].join(', ')}`);
    out.push({ size, units: Number(units), document: grade ? gradeDocument(document, grade) : document });
  }
  if (!out.length) throw new GraphError('No sizes were asked for');
  return out;
}

/** Pattern → roll, without the move: the grain is laid along the roll, a mirrored copy is flipped across it, then the piece is turned. [a, b, c, d] of x' = ax + cy, y' = bx + dy. */
function linear(grain, turn, mirrored) {
  const g = -grain * Math.PI / 180, t = turn * Math.PI / 180, m = mirrored ? -1 : 1, a = Math.cos(g), b = Math.sin(g), c = Math.cos(t), s = Math.sin(t);
  return [c * a - s * m * b, s * a + c * m * b, -c * b - s * m * a, -s * b + c * m * a].map(snap);
}

/** The x-extents of a polygon inside the band y0..y1, merged: the clipped edges and the two cross-sections bound every part of it. */
function bandSpans(poly, y0, y1) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length], lo = Math.min(a[1], b[1]), hi = Math.max(a[1], b[1]);
    if (hi < y0 || lo > y1) continue;
    const at = (y) => (hi === lo ? a[0] : a[0] + (b[0] - a[0]) * (Math.max(lo, Math.min(hi, y)) - a[1]) / (b[1] - a[1])), p = hi === lo ? a[0] : at(y0), q = hi === lo ? b[0] : at(y1);
    out.push([Math.min(p, q), Math.max(p, q)]);
  }
  for (const y of [y0, y1]) {
    const xs = [];
    for (let i = 0; i < poly.length; i++) { const a = poly[i], b = poly[(i + 1) % poly.length]; if ((a[1] > y) !== (b[1] > y)) xs.push(a[0] + (y - a[1]) / (b[1] - a[1]) * (b[0] - a[0])); }
    xs.sort((p, q) => p - q);
    for (let i = 0; i + 1 < xs.length; i += 2) out.push([xs[i], xs[i + 1]]);
  }
  out.sort((p, q) => p[0] - q[0]);
  const merged = [];
  for (const s of out) { const last = merged.at(-1); if (last && s[0] <= last[1] + EPS) last[1] = Math.max(last[1], s[1]); else merged.push([...s]); }
  return merged;
}

/** One way of laying a shape: its outline turned, and its bands. Each piece is grown by gap/2 all round, so two that touch are a gap apart. */
function variant(outline, m, turn, gap, cell) {
  const q = outline.map((p) => apply([...m, 0, 0], p)), xs = q.map((p) => p[0]), ys = q.map((p) => p[1]), minX = Math.min(...xs), minY = Math.min(...ys), w = Math.max(...xs) - minX, h = Math.max(...ys) - minY;
  const local = q.map((p) => [p[0] - minX, p[1] - minY]);
  const rows = Array.from({ length: Math.max(1, Math.ceil((h + gap) / cell - 1e-9)) }, (_, k) => bandSpans(local, k * cell - gap, (k + 1) * cell).map(([a, b]) => [a, b + gap]));
  return { m, turn, minX, minY, w, h, rows };
}

/** The first x at which the variant, its bottom on band iy, meets nothing already laid. Gives up (Infinity) past `stop`. */
function slot(occupied, v, iy, stop) {
  let x = 0, moved = true;
  while (moved) {
    moved = false;
    for (let k = 0; k < v.rows.length; k++) for (const [s0, s1] of v.rows[k]) for (const [a, b] of occupied[iy + k]) {
      if (a - s1 >= x - EPS) break;
      if (b - s0 > x + EPS) { x = b - s0; moved = true; if (x > stop) return Infinity; }
    }
  }
  return x;
}

function nest(pieces, order, bands) {
  const occupied = Array.from({ length: bands }, () => []), placed = []; let length = 0;
  for (const i of order) {
    let best = null;
    for (const v of pieces[i].variants) for (let iy = 0; iy + v.rows.length <= bands; iy++) {
      const x = slot(occupied, v, iy, best ? best.end - v.w + EPS : Infinity); if (x === Infinity) continue;
      const end = Math.max(length, x + v.w);
      if (!best || end < best.end - EPS || (end < best.end + EPS && x < best.x - EPS)) best = { v, iy, x, end };
    }
    for (let k = 0; k < best.v.rows.length; k++) { const row = occupied[best.iy + k]; for (const [s0, s1] of best.v.rows[k]) row.push([best.x + s0, best.x + s1]); row.sort((p, q) => p[0] - q[0]); }
    length = best.end; placed[i] = best;
  }
  return { length, placed };
}

const TURNS = { 0: [0], 180: [0, 180], 90: [0, 180, 90, 270] };

/**
 * One marker per material. Options:
 *   width       usable roll width, mm: one number for every material or { material: mm }. Otherwise the material's rollWidth, otherwise 1500.
 *   gap         clear distance between pieces, mm (default 3).
 *   turns       180 (default: grain along the roll, either way up), 0 (napped cloth: one way only), 90 (quarter turns too) or 'free' (every freeStep degrees, for cloth with no direction).
 *   sizes       ['base', 'L'] or { base: 1, L: 2 }: which graded sizes share the marker and how many units of each.
 *   resolution  band height across the roll, mm (default: width / 300, at least 1).
 *   tries       how many shuffled piece orders to lay besides the three sorted ones (default 12); the shortest marker wins.
 * A pattern is laid `cut` times per unit; with `mirror: true` every second copy is flipped (a left and a right).
 */
export function makeMarkers(document, { width, gap = 3, turns = 180, freeStep = 15, sizes, resolution, tries = 12, material: only } = {}) {
  gap = Number(gap);
  if (!(gap >= 0)) throw new GraphError('Marker gap must be zero or more');
  const angles = turns === 'free' ? Array.from({ length: Math.max(1, Math.round(360 / freeStep)) }, (_, i) => i * freeStep) : TURNS[turns];
  if (!angles || !(freeStep > 0)) throw new GraphError("Marker turns must be 180, 0, 90 or 'free'");
  const set = sizeSet(document, sizes), units = set.reduce((sum, s) => sum + s.units, 0), byMaterial = new Map();
  for (const { size, units: count, document: d } of set) for (const p of d.patterns) {
    const material = p.material || '';
    if (only != null && material !== only) continue;
    // The cloth of a sewn dart is laid and cut with the piece: the contour runs across its mouth, as in the pattern's own DXF.
    const marks = (document.annotations || []).filter((a) => a.pattern === p.id), contours = cutContours(capDarts(p, marks)), outer = contours.reduce((best, q) => (Math.abs(area(q)) > Math.abs(area(best)) ? q : best)), net = 2 * Math.abs(area(outer)) - contours.reduce((sum, q) => sum + Math.abs(area(q)), 0);
    // What rides along on the marker: notches, grain and any marks. Stitch lines and allowance ticks are for the pattern, not the cutter; the cut contours are drawn closed from `contours`.
    const lines = dxfEntities(patternDXF(p, marks, trimMarks(d, p.id))).lines.filter((l) => !['CUT', 'STITCH', 'ALLOWANCE'].includes(l.layer));
    const copies = (p.cut || 1) * count, shape = { pattern: p.id, name: p.name || p.id, size, grain: Number(p.grain?.angle ?? 90), contours, outer, area: net, lines };
    if (!byMaterial.has(material)) byMaterial.set(material, []);
    for (let copy = 0; copy < copies; copy++) byMaterial.get(material).push({ shape, copy: copy + 1, of: copies, mirrored: !!p.mirror && copy % 2 === 1 });
  }
  const markers = [];
  for (const [material, pieces] of byMaterial) {
    const own = Number(resolveMaterial(document.materials?.[material], material)?.rollWidth), given = typeof width === 'object' && width ? Number(width[material]) : Number(width);
    const W = given > 0 ? given : own > 0 ? own : DEFAULT_ROLL_WIDTH, widthSource = given > 0 ? 'option' : own > 0 ? 'material' : 'default';
    const bands = Math.max(1, Math.ceil((W + gap) / (resolution > 0 ? resolution : Math.max(1, W / 300)))), cell = (W + gap) / bands, cache = new Map();
    for (const piece of pieces) {
      const key = `${piece.shape.size}/${piece.shape.pattern}/${piece.mirrored}`;
      if (!cache.has(key)) {
        const all = angles.map((turn) => variant(piece.shape.outer, linear(piece.shape.grain, turn, piece.mirrored), turn, gap, cell)), fit = all.filter((v) => v.h <= W + 1e-6);
        if (!fit.length) throw new GraphError(`Piece '${piece.shape.name}'${piece.shape.size === 'base' ? '' : ` (size ${piece.shape.size})`} is ${Math.min(...all.map((v) => v.h)).toFixed(1)} mm across the roll with its grain along it, and the ${material || 'unnamed'} roll is ${W} mm wide. Use a wider roll, split the piece, or allow more turns.`);
        cache.set(key, fit);
      }
      piece.variants = cache.get(key); piece.span = Math.min(...piece.variants.map((v) => v.h)); piece.long = Math.max(...piece.variants.map((v) => v.w));
    }
    // Largest first by area, by width across the roll and by length along it, then the area order with neighbours swapped at random (a fixed seed: the same design always gives the same marker).
    const index = pieces.map((_, i) => i), orders = [(p) => p.shape.area, (p) => p.span, (p) => p.long].map((key) => [...index].sort((a, b) => key(pieces[b]) - key(pieces[a]) || a - b));
    let seed = 0x9e3779b9; const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    for (let t = 0; t < tries && pieces.length > 2; t++) { const o = [...orders[0]]; for (let k = 0; k < o.length; k++) { const i = Math.floor(random() * (o.length - 1)); [o[i], o[i + 1]] = [o[i + 1], o[i]]; } orders.push(o); }
    let best = null; const seen = new Set();
    for (const order of orders) { if (seen.has(order.join())) continue; seen.add(order.join()); const r = nest(pieces, order, bands); if (!best || r.length < best.length - EPS) best = r; }
    const placements = pieces.map((piece, i) => {
      const { v, iy, x } = best.placed[i], matrix = [...v.m, snap(x - v.minX), snap(iy * cell - v.minY)], to = (p) => apply(matrix, p), outline = piece.shape.outer.map(to);
      return { pattern: piece.shape.pattern, name: piece.shape.name, size: piece.shape.size, copy: piece.copy, of: piece.of, mirrored: piece.mirrored, turn: v.turn, matrix, bounds: { min: [x, iy * cell], max: [x + v.w, iy * cell + v.h] }, outline, contours: piece.shape.contours.map((q) => q.map(to)), lines: piece.shape.lines.map((l) => ({ layer: l.layer, a: to(l.a), b: to(l.b) })) };
    });
    const pieceArea = pieces.reduce((sum, p) => sum + p.shape.area, 0);
    markers.push({ material, width: W, widthSource, gap, turns, length: best.length, pieces: pieces.length, pieceArea, efficiency: pieceArea / (W * best.length), units, lengthPerUnit: best.length / units, placements });
  }
  return { units, sizes: set.map((s) => ({ size: s.size, units: s.units })), markers };
}

/** What to say about a marker without its geometry. */
export const markerSummary = (m) => ({ material: m.material, widthMm: m.width, widthSource: m.widthSource, gapMm: m.gap, turns: m.turns, lengthMm: +m.length.toFixed(1), pieces: m.pieces, pieceAreaMm2: +m.pieceArea.toFixed(1), efficiency: +m.efficiency.toFixed(4), units: m.units, lengthPerUnitMm: +m.lengthPerUnit.toFixed(1) });

const label = (p) => `${p.name}${p.size === 'base' ? '' : ` ${p.size}`}${p.of > 1 ? ` ${p.copy}/${p.of}` : ''}${p.mirrored ? ' MIRRORED' : ''}`;
const labelAt = (p) => { const w = p.bounds.max[0] - p.bounds.min[0], h = p.bounds.max[1] - p.bounds.min[1], height = Math.max(3, Math.min(10, Math.min(w, h) / 8)); return { height, at: [(p.bounds.min[0] + p.bounds.max[0]) / 2, (p.bounds.min[1] + p.bounds.max[1]) / 2] }; };

/** The marker as R12 DXF: the roll on ROLL, every piece's closed cut contours on CUT, and its notches, grain and marks on their pattern layers. */
export function markerDXF(marker) {
  const L = marker.length, W = marker.width, corners = [[0, 0], [L, 0], [L, W], [0, W]], entities = corners.map((c, i) => dxfLine(c, corners[(i + 1) % 4], 'ROLL')), colours = new Map([['CUT', 7], ['NOTCH', 6], ['GRAIN', 4], ['TEXT', 7], ['ROLL', 8]]);
  for (const p of marker.placements) {
    for (const q of p.contours) for (let i = 0; i < q.length; i++) entities.push(dxfLine(q[i], q[(i + 1) % q.length], 'CUT'));
    for (const l of p.lines) { if (!colours.has(l.layer)) colours.set(l.layer, 1); entities.push(dxfLine(l.a, l.b, l.layer)); }
    const { at, height } = labelAt(p); entities.push(dxfText([at[0] - label(p).length * height * 0.3, at[1]], label(p), height));
  }
  entities.push(dxfText([0, -12], `${marker.material || 'unnamed'}  ${W} x ${L.toFixed(0)} mm  ${(marker.efficiency * 100).toFixed(1)}%  ${marker.pieces} pieces  ${marker.units} unit${marker.units > 1 ? 's' : ''}`, 8));
  return dxfFile(entities, [...colours]);
}

/** The marker at 1:1 as SVG (mm): the roll runs left to right, its width is the height of the drawing. */
export function markerSVG(marker) {
  const L = marker.length, W = marker.width, y = (v) => n(W - v), d = (q) => `M${q.map((p) => `${n(p[0])} ${y(p[1])}`).join('L')}Z`;
  const pieces = marker.placements.map((p) => { const { at, height } = labelAt(p); return `<g><path d="${p.contours.map(d).join('')}" stroke-width="0.4"/><path d="${p.lines.map((l) => `M${n(l.a[0])} ${y(l.a[1])}L${n(l.b[0])} ${y(l.b[1])}`).join('')}" stroke-width="0.25"/><text x="${n(at[0])}" y="${y(at[1])}" font-size="${n(height)}" text-anchor="middle" fill="#000000" stroke="none">${esc(label(p))}</text></g>`; }).join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${n(L)}mm" height="${n(W)}mm" viewBox="0 0 ${n(L)} ${n(W)}" fill="none" stroke="#000000" font-family='"Space Mono",monospace' font-weight="400">\n<title>${esc(`${marker.material || 'unnamed'} marker ${W} x ${L.toFixed(0)} mm, ${(marker.efficiency * 100).toFixed(1)}%`)}</title>\n<rect width="${n(L)}" height="${n(W)}" stroke-width="0.25" stroke-dasharray="4 2"/>\n${pieces}\n</svg>\n`;
}
