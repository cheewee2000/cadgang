import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CellDocument, evaluateCells, clearCellCache } from '../src/core/cells.js';
import { initBrep, resetBrepOperationStats, brepOperationStats, tessellate, tessellateEdges } from '../src/core/brep.js';

test('a keyed shape is tessellated once per tolerance, however many times it is shown', async () => {
  await initBrep(); clearCellCache();
  const doc = new CellDocument();
  doc.addCell({ id: 'plate', prompt: 'p', code: 'export default ({ brep }) => brep.box(40, 20, 3)' });
  const run = evaluateCells(doc, 'plate');
  resetBrepOperationStats();
  const a = tessellate(run.value, { tolerance: 0.05 }), e1 = tessellateEdges(run.value, { tolerance: 0.05 });
  const b = tessellate(run.value, { tolerance: 0.05 }), e2 = tessellateEdges(run.value, { tolerance: 0.05 });
  assert.equal(brepOperationStats().tessellation.count, 1);
  assert.equal(a, b); assert.equal(e1, e2);
  tessellate(run.value, { tolerance: 0.5 });
  assert.equal(brepOperationStats().tessellation.count, 2, 'another tolerance is another mesh');
});
