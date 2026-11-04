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

test('an assembly is meshed, boxed and measured part by part, so an edit re-meshes one part', async () => {
  await initBrep(); clearCellCache();
  const doc = new CellDocument();
  doc.addCell({ id: 'a', prompt: 'a', code: 'export default ({ brep }) => brep.box(10, 10, 10)' });
  doc.addCell({ id: 'b', prompt: 'b', code: 'export default ({ brep }) => brep.translate(brep.cylinder(4, 12), [30, 0, 0])' });
  doc.addCell({ id: 'asm', refs: ['a', 'b'], prompt: 'asm', code: 'export default ({ brep, inputs }) => brep.compound(inputs.a, inputs.b)' });
  let run = evaluateCells(doc, 'asm');
  resetBrepOperationStats();
  const whole = tessellate(run.value, { tolerance: 0.1 });
  assert.equal(brepOperationStats().tessellation.count, 2, 'one mesh per part');
  const { tightBounds } = await import('../src/core/brep.js');
  const box = tightBounds(run.value);
  assert.deepEqual(box.min.map((v) => Math.round(v) + 0), [-5, -5, 0]); assert.deepEqual(box.max.map((v) => Math.round(v) + 0), [34, 5, 12]);
  const { measuresOf } = await import('../src/core/cellapi.js');
  const m = measuresOf(run.value);
  assert.equal(Math.round(m.volume), Math.round(1000 + Math.PI * 16 * 12)); assert.equal(m.bodies, 2);
  assert.equal(whole.faces.length, 6 + 3, 'every face of both parts, in part order');
  assert.equal(whole.indices.length, [...whole.faces].reduce((n, f) => n + f.count, 0) * 3);
  assert.ok(whole.indices.every((i) => i < whole.positions.length / 3), 'indices were offset into the merged vertices');

  doc.updateCell('a', { code: 'export default ({ brep }) => brep.box(10, 10, 11)' });
  run = evaluateCells(doc, 'asm');
  resetBrepOperationStats();
  tessellate(run.value, { tolerance: 0.1 });
  assert.equal(brepOperationStats().tessellation.count, 1, 'only the edited part is meshed again');
});
