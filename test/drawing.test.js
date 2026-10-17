/** The sheet picks the largest standard scale that fits front + top + right views. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitScale, scaleText } from '../web/drawing.js';

test('fitScale: the largest standard scale whose whole layout fits A3 landscape', () => {
  assert.equal(fitScale(100, 50, 30, 420, 297), 1);
  assert.equal(fitScale(142, 202, 19, 420, 297), 1 / 2);   // the bench leg: 1:1 would run the front view into the title block
  assert.equal(fitScale(600, 300, 200, 420, 297), 1 / 5);
  assert.equal(scaleText(1 / 5), '1:5');
  assert.equal(scaleText(2), '2:1');
});
