// A pattern DXF read back into pieces (web/softgoods-dxf.js): cadgang's own ASTM-style export, and a plain drawing in inches.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { NURBSCurve } from 'three/addons/curves/NURBSCurve.js';
import { SoftgoodsDocument, validateSoftgoodsDocument } from '../src/core/softgoods-document.js';
import { astmStyleDXF } from '../src/core/softgoods-astm.js';
import { outlinesFromDxf, importPiece } from '../web/softgoods-dxf.js';
import { addPiece, origin, addNotch, setPiece } from '../web/softgoods-draft.js';

const area = (q) => Math.abs(q.reduce((n, u, i) => { const v = q[(i + 1) % q.length]; return n + u.x * v.y - v.x * u.y; }, 0)) / 2;

test('dxf import: an ASTM-style export comes back as its pieces, on the stitch line, a corner per corner', () => {
  const d = new SoftgoodsDocument(null); d.addRectangle({ id: 'front', width: 200, height: 100 }); d.addRectangle({ id: 'back', width: 300, height: 120 });
  const { outlines, layer } = outlinesFromDxf(astmStyleDXF(d.toJSON(), { name: 't', size: 'base' }), { THREE, NURBSCurve });
  assert.equal(layer, '14'); assert.deepEqual(outlines.map((q) => [q.length, Math.round(area(q))]).sort((a, b) => a[1] - b[1]), [[4, 20000], [4, 36000]]);
  const back = validateSoftgoodsDocument(outlines.reduce((doc, q) => addPiece(doc, origin(q)), d.toJSON()));
  assert.equal(back.patterns.length, 4);
});

test('dxf import: closed polylines in inches, a hole inside one dropped', () => {
  const poly = (pts) => ['0', 'LWPOLYLINE', '8', '0', '90', String(pts.length), '70', '1', ...pts.flatMap(([x, y]) => ['10', String(x), '20', String(y)])];
  const dxf = ['0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', '1', '0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES', ...poly([[0, 0], [10, 0], [10, 5], [5, 5], [0, 5]]), ...poly([[1, 1], [2, 1], [2, 2]]), '0', 'ENDSEC', '0', 'EOF'].join('\n');
  const { outlines } = outlinesFromDxf(dxf, { THREE, NURBSCurve });
  assert.equal(outlines.length, 1); assert.equal(outlines[0].length, 4, 'the point on the straight top edge is merged'); assert.ok(Math.abs(area(outlines[0]) - 50 * 25.4 ** 2) < 1);
});

test('dxf import: a piece keeps its grain and its notches through an ASTM-style export', () => {
  const d = new SoftgoodsDocument(null); d.addRectangle({ id: 'front', width: 200, height: 100 });
  const marked = setPiece(addNotch(d.toJSON(), 'front', 'front_top', 0.25), 'front', { grain: 45 });
  const { pieces } = outlinesFromDxf(astmStyleDXF(marked, { name: 't', size: 'base' }), { THREE, NURBSCurve });
  assert.equal(pieces.length, 1); assert.equal(pieces[0].grain, 45); assert.equal(pieces[0].notches.length, 1);
  const p = validateSoftgoodsDocument(importPiece({ ...marked, patterns: [], arrangement: [], seams: [] }, pieces[0])).patterns[0], n = p.notches[0], s = p.segments.find((v) => v.id === n.segment);
  const [a, b] = [s.a, s.b].map((id) => p.points.find((q) => q.id === id)), at = { x: a.x + (b.x - a.x) * n.at, y: a.y + (b.y - a.y) * n.at };
  assert.equal(p.grain.angle, 45); assert.ok(Math.abs(at.x - 150) < 0.5 && Math.abs(at.y - 100) < 0.5, JSON.stringify(at));
});
