import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSeamCorrespondence } from '../src/core/softgoods-seams.js';

const mesh = (id, length) => ({ id, uv: [0, 0, length / 2, 0, length, 0], segmentVertices: { edge: [0, 1, 2] } });
const seam = (extra = {}) => ({ id: 'side', a: { pattern: 'a', segment: 'edge' }, b: { pattern: 'b', segment: 'edge' }, ease: 0.1, ...extra });

test('seam correspondence creates ordered bilinear boundary attachments', () => {
  const [s] = resolveSeamCorrespondence([seam({ flip: true })], [mesh('a', 100), mesh('b', 95)], { spacing: 20 });
  assert.equal(s.pairs.length, 6); assert.deepEqual(s.pairs[0].a.vertices, [0, 1]);
  assert.equal(s.pairs[0].b.t, 1); assert.equal(s.pairs.at(-1).b.t, 0);
  assert.ok(Math.abs(s.mismatch - 0.05) < 1e-9);
});

test('notch correspondence redistributes ease and gathering permits deliberate mismatch', () => {
  const [shaped] = resolveSeamCorrespondence([seam({ correspondence: [{ a: 0.5, b: 0.25 }] })], [mesh('a', 100), mesh('b', 100)], { spacing: 25 });
  assert.equal(shaped.pairs[2].b.t, 0.25);
  const [gathered] = resolveSeamCorrespondence([seam({ kind: 'gather', ease: 0 })], [mesh('a', 150), mesh('b', 100)]);
  assert.equal(gathered.gatherRatio, 1.5);
});

test('plain seams reject excess mismatch and invalid correspondence', () => {
  assert.throws(() => resolveSeamCorrespondence([seam({ ease: 0.02 })], [mesh('a', 110), mesh('b', 100)]), /length mismatch/);
  assert.throws(() => resolveSeamCorrespondence([seam({ correspondence: [{ a: 0.7, b: 0.4 }, { a: 0.6, b: 0.8 }] })], [mesh('a', 100), mesh('b', 100)]), /increase strictly/);
});
