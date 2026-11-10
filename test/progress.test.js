import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CellDocument, evaluateCells } from '../src/core/cells.js';
import { initBrep, progress } from '../src/core/brep.js';

test('a cell program under way reports each shape it makes, under its cell\'s name', async () => {
  await initBrep();
  const doc = new CellDocument();
  doc.addCell({ id: 'block', prompt: 'a block with a hole', code: 'export default ({ brep }) => brep.subtract(brep.box(20, 20, 10), brep.cylinder(3, 10))' });
  const seen = [];
  progress.fn = (op, shape) => seen.push([op, progress.cell, typeof shape.mesh]);
  try { evaluateCells(doc); } finally { progress.fn = null; }
  assert.ok(seen.length >= 2, `ops seen: ${seen.length}`);
  assert.ok(seen.every(([, cell, mesh]) => cell === 'block' && mesh === 'function'));
  assert.equal(progress.cell, null);
});

test('each cell that actually builds announces itself first; a cached one stays quiet', async () => {
  await initBrep();
  const doc = new CellDocument();
  doc.addCell({ id: 'slab', code: 'export default ({ brep }) => brep.box(20, 20, 2)' });
  doc.addCell({ id: 'drilled', code: 'export const params = { r: 3 }; export default ({ p, brep, input }) => brep.subtract(input, brep.cylinder(p.r, 10))' });
  const began = [];
  progress.fn = (op) => { if (op === 'cell') began.push(progress.cell); };
  try {
    evaluateCells(doc);
    doc.updateCell('drilled', { params: { r: 4 } });
    evaluateCells(doc);
  } finally { progress.fn = null; }
  assert.deepEqual(began, ['slab', 'drilled', 'drilled']);
});
