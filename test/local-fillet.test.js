/**
 * The local fillet: a seam filleted inside a tube cut out around it, for seams whose ends the whole-body
 * fillet cannot resolve. Checked by the volume it removes slice by slice: full radius in the middle, fading
 * to nothing at both ends. And the boolean behind it: a union still merges coplanar faces.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { initBrep, beginBrepScope } from '../src/core/brep.js';
import * as ops from '../src/core/ops.js';
import { q } from '../src/core/query.js';

await initBrep();

const inScope = (fn) => { const s = beginBrepScope(); try { return fn(); } finally { s.dispose(); } };
const slab = (s, z0, z1) => ops.volume(ops.intersect(s, ops.translate(ops.box(100, 100, z1 - z0), [0, 0, z0])));
const FULL = 4 * 4 * (1 - Math.PI / 4);   // area an R4 fillet removes from a square corner

test('local fillet: full radius mid-seam, fading out at both ends', () => inScope(() => {
  const box = ops.box(20, 20, 60);
  const out = ops.fillet(box, q.edges(box).linear().along('z').near([10, 10, 30], 1).expect(1), 4, { local: true });
  const removed = (a, b) => (slab(box, a, b) - slab(out, a, b)) / (b - a);
  assert.ok(Math.abs(removed(29, 31) - FULL) < 0.02, `mid-seam removes ${removed(29, 31)} mm2, want ${FULL}`);
  for (const [a, b] of [[0, 2], [58, 60]]) assert.ok(removed(a, b) < 0.1, `end ${a}-${b} removes ${removed(a, b)} mm2, want ~0`);
  assert.ok(Math.abs(removed(5, 7) - removed(53, 55)) < 0.02, 'the two run-outs match');
  assert.equal(ops.bodies(out), 1);
}));

test('local fillet: a chain of tangent seams is one fillet, a closed one has no run-out', () => inScope(() => {
  const puck = ops.cylinder(15, 10);
  const rim = q.edges(puck).circular().near([0, 0, 10], 16).where((d) => d.center[2] > 9).expect(1);
  const whole = ops.fillet(puck, rim, 2, { local: false }), local = ops.fillet(puck, rim, 2, { local: true });
  assert.ok(Math.abs(ops.volume(whole) - ops.volume(local)) < 0.5, `whole ${ops.volume(whole)} vs local ${ops.volume(local)}`);
}));

test('local fillet: one radius only', () => inScope(() => {
  const box = ops.box(20, 20, 60);
  assert.throws(() => ops.fillet(box, q.edges(box).linear().along('z').expect(4), () => 2, { local: true }), /one radius/);
}));

test('union still merges coplanar faces', () => inScope(() => {
  const both = ops.union(ops.box(10, 10, 10), ops.translate(ops.box(10, 10, 10), [10, 0, 0]));
  assert.equal(q.faces(both).count(), 6);
  assert.ok(Math.abs(ops.volume(both) - 2000) < 1e-6);
}));
