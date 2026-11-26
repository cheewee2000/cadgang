// The marker: every cut piece on the roll, none overlapping, none over the edge, grain along the roll, and the yield it claims.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SoftgoodsDocument, validateSoftgoodsDocument } from '../src/core/softgoods-document.js';
import { cutContours } from '../src/core/softgoods-export.js';
import { makeMarkers, markerDXF, markerSVG, markerSummary, dxfEntities } from '../src/core/softgoods-marker.js';
import { tee } from './fixtures/softgoods-tee.js';

const area = (q) => Math.abs(q.reduce((sum, p, i) => sum + p[0] * q[(i + 1) % q.length][1] - q[(i + 1) % q.length][0] * p[1], 0) / 2);
const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
const inside = (q, p) => { let c = false; for (let i = 0, j = q.length - 1; i < q.length; j = i++) if ((q[i][1] > p[1]) !== (q[j][1] > p[1]) && p[0] < (q[j][0] - q[i][0]) * (p[1] - q[i][1]) / (q[j][1] - q[i][1]) + q[i][0]) c = !c; return c; };
const pointToSegment = (p, a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1))); return Math.hypot(a[0] + dx * t - p[0], a[1] + dy * t - p[1]); };
/** How far apart two polygons are: 0 when an edge of one crosses an edge of the other or one lies inside the other. A real polygon test, edge against edge. */
function clearance(P, Q) {
  let least = Infinity;
  for (let i = 0; i < P.length; i++) for (let j = 0; j < Q.length; j++) {
    const a = P[i], b = P[(i + 1) % P.length], c = Q[j], d = Q[(j + 1) % Q.length];
    if (cross(a, b, c) * cross(a, b, d) < -1e-9 && cross(c, d, a) * cross(c, d, b) < -1e-9) return 0;
    least = Math.min(least, pointToSegment(a, c, d), pointToSegment(b, c, d), pointToSegment(c, a, b), pointToSegment(d, a, b));
  }
  return inside(Q, P[0]) || inside(P, Q[0]) ? 0 : least;
}
function assertLaid(marker) {
  const { placements: pieces, width, length, gap } = marker;
  for (const p of pieces) for (const [x, y] of p.outline) assert.ok(x > -1e-6 && x < length + 1e-6 && y > -1e-6 && y < width + 1e-6, `${p.name} ${p.copy} is on the roll: ${x}, ${y}`);
  for (let i = 0; i < pieces.length; i++) for (let j = i + 1; j < pieces.length; j++) {
    const a = pieces[i], b = pieces[j]; if (a.bounds.max[0] < b.bounds.min[0] - gap || b.bounds.max[0] < a.bounds.min[0] - gap || a.bounds.max[1] < b.bounds.min[1] - gap || b.bounds.max[1] < a.bounds.min[1] - gap) continue;
    const apart = clearance(a.outline, b.outline);
    assert.ok(apart > gap - 1e-6, `${a.name} ${a.size} ${a.copy} and ${b.name} ${b.size} ${b.copy} are ${apart.toFixed(4)} mm apart, the gap is ${gap}`);
  }
}
const rects = (list, materials = {}) => { const d = new SoftgoodsDocument(null); for (const r of list) d.addRectangle({ allowance: 0, ...r }); const json = d.toJSON(); json.materials = materials; for (const r of list) Object.assign(json.patterns.find((p) => p.id === r.id), r.extra || {}); return json; };

test('two squares that fit across the roll lie side by side: the length and yield are exact', () => {
  const made = makeMarkers(rects([{ id: 'a', width: 100, height: 100 }, { id: 'b', width: 100, height: 100 }]), { width: 300, gap: 0 }), m = made.markers[0];
  assert.equal(made.markers.length, 1); assert.equal(m.material, 'canvas'); assert.equal(m.pieces, 2);
  assert.ok(Math.abs(m.length - 100) < 1e-9); assert.equal(m.pieceArea, 20000);
  assert.ok(Math.abs(m.efficiency - 20000 / (300 * 100)) < 1e-12); assert.equal(m.lengthPerUnit, m.length);
  assertLaid(m);
});

test('a realistic marker: nothing overlaps, everything is on the roll and a gap apart', () => {
  const d = validateSoftgoodsDocument(tee()), m = makeMarkers(d, { sizes: { base: 1, L: 1 }, gap: 4 }).markers[0];
  assert.equal(m.width, 1600); assert.equal(m.widthSource, 'material'); assert.equal(m.units, 2);
  assertLaid(m);
  assert.ok(Math.abs(m.pieceArea - m.placements.reduce((sum, p) => sum + area(p.outline), 0)) < 1e-6, 'the piece area is the area of the laid outlines');
  assert.ok(Math.abs(m.efficiency - m.pieceArea / (m.width * m.length)) < 1e-12, 'efficiency is area over width × length');
  assert.ok(Math.abs(m.length - Math.max(...m.placements.map((p) => p.bounds.max[0]))) < 1e-9, 'the marker ends where its last piece does');
  assert.ok(Math.abs(m.lengthPerUnit - m.length / 2) < 1e-12);
  assert.ok(m.efficiency > 0.7, `a tee in two sizes should yield over 70%, got ${(m.efficiency * 100).toFixed(1)}%`);
});

test('quantities, mirrored pairs and grain are what the patterns say', () => {
  const d = validateSoftgoodsDocument(tee()), m = makeMarkers(d, { sizes: { base: 2, XL: 1 } }).markers[0], count = (f) => m.placements.filter(f).length;
  assert.equal(m.pieces, 18); assert.equal(count((p) => p.pattern === 'front' && p.size === 'base'), 2); assert.equal(count((p) => p.pattern === 'front' && p.size === 'XL'), 1);
  assert.equal(count((p) => p.pattern === 'sleeve'), 6, 'cut 2 per unit, three units');
  const sleeves = m.placements.filter((p) => p.pattern === 'sleeve'), det = (p) => p.matrix[0] * p.matrix[3] - p.matrix[1] * p.matrix[2];
  assert.equal(sleeves.filter((p) => p.mirrored).length, 3, 'every second sleeve is the other hand');
  for (const p of m.placements) assert.ok(Math.abs(det(p) - (p.mirrored ? -1 : 1)) < 1e-9, 'a mirrored copy is flipped, the rest only turned and moved');
  // The grain direction of the pattern, carried by the placement, lies along the roll: +x or -x, never across.
  for (const p of m.placements) { const g = d.patterns.find((q) => q.id === p.pattern).grain.angle * Math.PI / 180, x = p.matrix[0] * Math.cos(g) + p.matrix[2] * Math.sin(g), y = p.matrix[1] * Math.cos(g) + p.matrix[3] * Math.sin(g); assert.ok(Math.abs(Math.abs(x) - 1) < 1e-9 && Math.abs(y) < 1e-9, `${p.name} grain lies along the roll`); assert.ok([0, 180].includes(p.turn)); }
  // The graded front really is the wider one.
  const wide = (size) => { const p = m.placements.find((q) => q.pattern === 'front' && q.size === size); return p.bounds.max[1] - p.bounds.min[1]; };
  assert.ok(Math.abs(wide('XL') - wide('base') - 40) < 1e-6);
  for (const p of makeMarkers(d, { turns: 0 }).markers[0].placements) assert.equal(p.turn, 0, 'napped cloth is laid one way only');
});

test('the same design always gives the same marker', () => {
  const d = validateSoftgoodsDocument(tee()), a = makeMarkers(d, { sizes: ['base', 'L', 'XL'] }), b = makeMarkers(d, { sizes: ['base', 'L', 'XL'] });
  assert.deepEqual(a, b);
});

test('a piece wider than the roll fails loudly, and turning it is an option, not a default', () => {
  const d = rects([{ id: 'strap', name: 'Long strap', width: 400, height: 100, extra: { grain: { angle: 90 } } }]);
  assert.throws(() => makeMarkers(d, { width: 150 }), /Long strap.*400\.0 mm across the roll.*150 mm wide/);
  const turned = makeMarkers(d, { width: 150, turns: 90 }).markers[0];
  assert.ok([90, 270].includes(turned.placements[0].turn)); assert.ok(Math.abs(turned.length - 400) < 1e-9); assertLaid(turned);
  assert.throws(() => makeMarkers(d, { turns: 45 }), /turns must be/); assert.throws(() => makeMarkers(d, { sizes: ['XXL'] }), /No graded size 'XXL'/);
});

test('each material gets its own marker at its own width, and free turns still do not overlap', () => {
  const d = rects([{ id: 'shell', width: 300, height: 200, material: 'shell' }, { id: 'lining', width: 300, height: 200, material: 'lining' }, { id: 'tab', width: 60, height: 200, material: 'lining', extra: { cut: 3 } }], { shell: { rollWidth: 1000 }, lining: { preset: 'ripstop-nylon-70d' } });
  const made = makeMarkers(d, { width: { lining: 400 } }), shell = made.markers.find((m) => m.material === 'shell'), lining = made.markers.find((m) => m.material === 'lining');
  assert.equal(shell.width, 1000); assert.equal(shell.widthSource, 'material'); assert.equal(lining.width, 400); assert.equal(lining.widthSource, 'option'); assert.equal(lining.pieces, 4);
  assert.equal(makeMarkers(d, { material: 'shell', width: {} }).markers.length, 1);
  assert.equal(makeMarkers(rects([{ id: 'a', width: 100, height: 100 }])).markers[0].widthSource, 'default');
  const free = makeMarkers(validateSoftgoodsDocument(tee()), { turns: 'free', freeStep: 30 }).markers[0]; assertLaid(free);
});

test('a hole is not cloth: the piece area leaves it out', () => {
  const d = rects([{ id: 'panel', width: 100, height: 80 }]), p = d.patterns[0], ids = ['h0', 'h1', 'h2', 'h3'], seg = ['hb', 'hr', 'ht', 'hl'];
  p.points.push({ id: 'h0', x: 30, y: 25 }, { id: 'h1', x: 70, y: 25 }, { id: 'h2', x: 70, y: 55 }, { id: 'h3', x: 30, y: 55 });
  p.segments.push(...seg.map((id, i) => ({ id, type: 'line', a: ids[i], b: ids[(i + 1) % 4] }))); p.contours.push(seg);
  assert.equal(cutContours(p).length, 2); assert.equal(makeMarkers(d).markers[0].pieceArea, 100 * 80 - 40 * 30);
});

test('the marker is written as DXF and as 1:1 SVG', () => {
  const m = makeMarkers(validateSoftgoodsDocument(tee())).markers[0], dxf = dxfEntities(markerDXF(m)), svg = markerSVG(m);
  for (const layer of ['ROLL', 'CUT', 'NOTCH', 'GRAIN', 'TEXT']) assert.ok(layer in dxf.layers, layer);
  assert.equal(dxf.lines.filter((l) => l.layer === 'ROLL').length, 4); assert.equal(dxf.lines.filter((l) => l.layer === 'GRAIN').length, m.pieces); assert.equal(dxf.lines.filter((l) => l.layer === 'NOTCH').length, 1);
  assert.equal(dxf.lines.filter((l) => l.layer === 'CUT').length, m.placements.reduce((sum, p) => sum + p.outline.length, 0), 'every cut contour is closed');
  assert.ok(!dxf.lines.some((l) => l.layer === 'STITCH'), 'stitch lines are for the pattern, not the cutter');
  for (const l of dxf.lines.filter((q) => q.layer === 'CUT')) assert.ok(l.a[0] > -1e-6 && l.a[0] < m.length + 1e-6 && l.a[1] > -1e-6 && l.a[1] < m.width + 1e-6);
  assert.equal(dxf.texts.length, m.pieces + 1); assert.ok(dxf.texts.some((t) => t.value === 'Sleeve 2/2 MIRRORED'));
  assert.match(svg, new RegExp(`width="${+m.length.toFixed(3)}mm" height="1600mm" viewBox="0 0 ${+m.length.toFixed(3)} 1600"`));
  assert.equal(svg.match(/<text /g).length, m.pieces);
  const s = markerSummary(m); assert.equal(s.lengthMm, +m.length.toFixed(1)); assert.ok(!('placements' in s));
});
