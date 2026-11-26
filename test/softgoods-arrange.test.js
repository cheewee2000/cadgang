import test from 'node:test';
import assert from 'node:assert/strict';
import { arrangePatternsAroundAvatar } from '../src/core/softgoods-arrange.js';

test('patterns arrange deterministically around measured avatar regions', () => {
  const patterns = [{ id: 'front', placement: { region: 'front', offset: [5, 0, 10] } }, { id: 'back', placement: { region: 'back', layer: 1 } }, { id: 'unplaced' }];
  const a = arrangePatternsAroundAvatar(patterns, { height: 1800, chest: 1000, depth: 300, ease: 25 });
  assert.equal(a.arrangement.length, 2); assert.deepEqual(a.arrangement[0].rotation, [90, 0, 0]);
  assert.deepEqual(a.arrangement[0].position, [5, -175, 1126]);
  assert.deepEqual(a.arrangement[1].rotation, [90, 0, 180]);
  assert.equal(a.arrangement[1].source, 'avatar');
});

test('avatar arrangement rejects ambiguous slots and unknown regions', () => {
  assert.throws(() => arrangePatternsAroundAvatar([{ id: 'a', placement: { region: 'front' } }, { id: 'b', placement: { region: 'front' } }]), /occupy avatar placement/);
  assert.throws(() => arrangePatternsAroundAvatar([{ id: 'a', placement: { region: 'sleeve' } }]), /front, back, left or right/);
});
