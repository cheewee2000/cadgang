/** The sheet picks the largest standard scale that fits front + top + right views. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitScale, scaleText, noteLines, wrap } from '../web/drawing.js';

test('fitScale: the largest standard scale whose whole layout fits A3 landscape', () => {
  assert.equal(fitScale(100, 50, 30, 420, 297), 1);
  assert.equal(fitScale(142, 202, 19, 420, 297), 1 / 2);   // the bench leg: 1:1 would run the front view into the title block
  assert.equal(fitScale(600, 300, 200, 420, 297), 1 / 5);
  assert.equal(scaleText(1 / 5), '1:5');
  assert.equal(scaleText(2), '2:1');
});

test('notes: material, finish and tolerances first, upper case, wrapped at 60 with indented continuations, DO NOT SCALE last', () => {
  const lines = noteLines({ material: '6063-T832 aluminium tube', notes: ['Ends square to the axis within 0.2; deburr inside and out, break edges 0.2 max, no chamfer beyond that.'] });
  assert.equal(lines[0], 'NOTES:');
  assert.equal(lines[1], '1. MATERIAL: 6063-T832 ALUMINIUM TUBE');
  assert.match(lines[2], /^2\. ENDS SQUARE/);
  assert.match(lines[3], /^   /);
  assert.ok(lines.every((l) => l.length <= 63));
  assert.equal(lines.at(-1), '3. DO NOT SCALE DRAWING. DIMENSIONS IN MM.');
  assert.deepEqual(wrap('a bb ccc dddd', 6), ['a bb', 'ccc', 'dddd']);
});
