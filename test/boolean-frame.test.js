import test from 'node:test';
import assert from 'node:assert/strict';
import { initBrep, beginBrepScope, brepIsValid } from '../src/core/brep.js';
import * as ops from '../src/core/ops.js';

await initBrep();
const scoped = (fn) => { const s = beginBrepScope(); try { return fn(); } finally { s.dispose(); } };
const near = (a, b, tol = 1e-5) => assert.ok(Math.abs(a - b) <= tol, `${a} != ${b}`);

test('a boolean far from the origin keeps finite exact bounds', () => scoped(() => {
  const o = 1e12, overlap = 1e-4;
  const a = ops.translate(ops.box(10, 10, 10), [o, o, o]);
  const b = ops.translate(ops.box(10, 10, 10), [o + 10 - overlap, o, o]);
  const joined = ops.union(a, b);
  assert.ok(brepIsValid(joined));
  assert.equal(ops.bodies(joined), 1);
  near(ops.volume(joined), 2000 - overlap * 100, 0.02);
  const box = ops.bbox(joined);
  assert.ok([...box.min, ...box.max, ...box.size].every(Number.isFinite));
  near(box.size[0], 20 - overlap, 2e-4);
  near(box.size[1], 10);
  near(box.size[2], 10);
}));

test('local-frame rescue recovers an OCCT direction failure at huge coordinates', () => scoped(() => {
  const o = 1e14;
  const a = ops.translate(ops.box(10, 10, 10), [o, o, o]);
  const b = ops.translate(ops.box(10, 10, 10), [o + 9, o, o]);
  const joined = ops.union(a, b);
  assert.ok(brepIsValid(joined));
  assert.equal(ops.bodies(joined), 1);
  near(ops.volume(joined), 1900, 0.02);
  assert.deepEqual(ops.bbox(joined).size, [19, 10, 10]);
}));

test('local-frame rescue changes no ordinary boolean result', () => scoped(() => {
  const a = ops.box(10, 10, 10), b = ops.translate(ops.box(10, 10, 10), [5, 0, 0]);
  const joined = ops.union(a, b), cut = ops.subtract(a, b);
  near(ops.volume(joined), 1500);
  near(ops.volume(cut), 500);
  assert.equal(ops.bodies(joined), 1);
  assert.equal(ops.bodies(cut), 1);
}));
