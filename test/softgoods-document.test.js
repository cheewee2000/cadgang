import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SoftgoodsDocument, validateSoftgoodsDocument } from '../src/core/softgoods-document.js';

test('softgoods document persists stable pattern and segment ids', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadgang-soft-')), file = path.join(dir, 'softgoods.json');
  const doc = new SoftgoodsDocument(file);
  const front = doc.addRectangle({ id: 'front', width: 300, height: 400, allowance: 12 });
  const back = doc.addRectangle({ id: 'back', width: 300, height: 400, allowance: 12 });
  assert.deepEqual(front.segments.map((s) => s.id), ['front_bottom', 'front_right', 'front_top', 'front_left']);
  doc.addSeam({ id: 'side', a: { pattern: 'front', segment: 'front_right' }, b: { pattern: 'back', segment: 'back_left' } });
  doc.updatePoint('front', 'front_tr', 320, 410);
  assert.equal(doc.toJSON().seams[0].a.segment, 'front_right', 'point edits do not retarget a seam');
  const loaded = new SoftgoodsDocument(file);
  assert.equal(loaded.toJSON().patterns.length, 2);
  assert.equal(loaded.toJSON().seams[0].id, 'side');
  assert.ok(loaded.toJSON().revision >= 4);
  fs.rmSync(dir, { recursive: true });
});

test('softgoods validation catches open contours and stale seam references', () => {
  const d = new SoftgoodsDocument(null);
  d.addRectangle({ id: 'panel' });
  const open = d.toJSON(); open.patterns[0].segments[1].a = 'panel_bl';
  assert.throws(() => validateSoftgoodsDocument(open), /contour is open/);
  const stale = d.toJSON(); stale.seams.push({ id: 'bad', a: { pattern: 'panel', segment: 'gone' }, b: { pattern: 'panel', segment: 'panel_left' } });
  assert.throws(() => validateSoftgoodsDocument(stale), /missing segment/);
});

test('curved segments and per-edge allowances are first-class document data', () => {
  const d = { version: 1, revision: 0, materials: {}, seams: [], arrangement: [], simulation: {}, patterns: [{
    id: 'curve', name: 'curve', points: [
      { id: 'a', x: 0, y: 0 }, { id: 'b', x: 100, y: 0 }, { id: 'c', x: 100, y: 100 }, { id: 'd', x: 0, y: 100 }, { id: 'bc', x: 100, y: 50 },
    ], segments: [
      { id: 'bottom', type: 'line', a: 'a', b: 'b' }, { id: 'round', type: 'arc', a: 'b', b: 'c', c: 'bc' },
      { id: 'top', type: 'line', a: 'c', b: 'd' }, { id: 'left', type: 'line', a: 'd', b: 'a' },
    ], contours: [['bottom', 'round', 'top', 'left']], allowances: { bottom: 5, round: 8, top: 10, left: 5 }, notches: [], grain: { angle: 90 }, internalLines: [],
  }] };
  assert.equal(validateSoftgoodsDocument(d).patterns[0].allowances.round, 8);
});
