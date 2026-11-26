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

test('avatar placement persists measurements for collision and pressure maps', async () => {
  const fs = await import('node:fs');
  const server = fs.readFileSync(new URL('../src/server/softgoods.js', import.meta.url), 'utf8');
  const worker = fs.readFileSync(new URL('../web/softgoods-worker.js', import.meta.url), 'utf8');
  assert.match(server, /simulation.*avatar: result\.avatar/);
  assert.match(server, /collisionBody: d\.simulation\?\.avatar/);
  assert.match(worker, /seam-pair/); assert.match(worker, /collideAvatar/); assert.match(worker, /pressure: new Float32Array/);
});
