import test from 'node:test';
import assert from 'node:assert/strict';
import {
  initBrep, beginBrepScope, brepOperationStats, resetBrepOperationStats,
} from '../src/core/brep.js';
import { box, union } from '../src/core/ops.js';

await initBrep();

test('exact-kernel calls expose bounded aggregate timings and failures', () => {
  resetBrepOperationStats();
  const scope = beginBrepScope();
  try {
    const a = box(10, 10, 10), b = box(10, 10, 10, { center: 'xyz' });
    union(a, b);
    assert.throws(() => box(0, 1, 1));
    const stats = brepOperationStats();
    assert.equal(stats.box.count, 2); // invalid dimensions are rejected before entering OCCT
    assert.equal(stats.box.failures, 0);
    assert.equal(stats.union.count, 1);
    assert.ok(stats.union.totalMs >= 0);
    assert.ok(stats.union.maxMs >= stats.union.meanMs);
  } finally { scope.dispose(); }
});
