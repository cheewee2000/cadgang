import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSoftgoodsDocument } from '../src/core/softgoods-document.js';
import { evaluateMeasurementConstraints, gradePattern, gradePatterns } from '../src/core/softgoods-operations.js';
import { patternDXF, techPack, techPackHTML } from '../src/core/softgoods-export.js';

const pattern = () => ({ id: 'front', name: 'Front', material: 'shell', cut: 1, points: [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 100, y: 0 }, { id: 'c', x: 100, y: 150 }, { id: 'd', x: 0, y: 150 }, { id: 'dart_tip', x: 50, y: 80 }], segments: [{ id: 'bottom', type: 'line', a: 'a', b: 'b' }, { id: 'right', type: 'line', a: 'b', b: 'c' }, { id: 'top', type: 'line', a: 'c', b: 'd' }, { id: 'left', type: 'line', a: 'd', b: 'a' }], contours: [['bottom', 'right', 'top', 'left']], allowances: { bottom: 10, right: 10, top: 10, left: 10 }, notches: [], grain: { angle: 90 } });
const document = () => ({ version: 1, revision: 0, materials: {}, patterns: [pattern()], seams: [], attachments: [], arrangement: [], constraints: [{ id: 'width', name: 'Chest width', type: 'distance', a: { pattern: 'front', point: 'a' }, b: { pattern: 'front', point: 'b' }, target: 100, tolerance: .1 }, { id: 'perimeter', type: 'length', pattern: 'front', contour: 0, target: 500, tolerance: .1 }], annotations: [{ id: 'waist_dart', type: 'dart', pattern: 'front', label: 'CLOSE DART', lines: [['a', 'dart_tip'], ['b', 'dart_tip']] }, { id: 'centre_fold', type: 'fold_line', pattern: 'front', lines: [['d', 'dart_tip']] }], simulation: { status: 'not_run' } });

test('measurement constraints evaluate without changing authoritative geometry', () => {
  const d = validateSoftgoodsDocument(document()), before = structuredClone(d.patterns);
  const rows = evaluateMeasurementConstraints(d);
  assert.equal(rows.length, 2); assert.equal(rows[0].measured, 100); assert.equal(rows[0].withinTolerance, true);
  assert.equal(rows[1].measured, 500); assert.deepEqual(d.patterns, before);
});

test('grading moves explicit stable points and preserves manufacturing topology', () => {
  const base = pattern(), [large] = gradePatterns(base, [{ name: 'Large', rules: [{ point: 'b', dx: 10, dy: 0 }, { point: 'c', dx: 10, dy: 15 }] }]);
  assert.equal(large.id, 'front_large'); assert.equal(large.points.find(p => p.id === 'c').x, 110);
  assert.deepEqual(large.segments, base.segments); assert.deepEqual(large.allowances, base.allowances); assert.deepEqual(large.contours, base.contours);
  assert.throws(() => gradePattern(base, { size: 'L', rules: [{ point: 'missing', dx: 1, dy: 1 }] }), /missing point/);
});

test('darts pleats and folds validate and enter DXF and tech packs', () => {
  const d = validateSoftgoodsDocument(document()), dxf = patternDXF(d.patterns[0], d.annotations), pack = techPack(d, 'garment'), html = techPackHTML(pack);
  assert.match(dxf, /\nDART\n/); assert.match(dxf, /\nFOLD\n/); assert.equal(pack.annotations.length, 2);
  assert.match(html, /MEASUREMENT CONSTRAINTS/); assert.match(html, /CLOSE DART/);
  const bad = document(); bad.annotations[0].lines = [['a', 'gone']]; assert.throws(() => validateSoftgoodsDocument(bad), /missing point/);
});
