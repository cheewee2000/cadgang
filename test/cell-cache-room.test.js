import test from 'node:test';
import assert from 'node:assert/strict';

// With no room at all, every rebuild counts as "the heap is big".
process.env.CADGANG_BREP_ROOM = '0';
const { CellDocument, evaluateCells, clearCellCache } = await import('../src/core/cells.js');
const { initBrep, beginBrepScope } = await import('../src/core/brep.js');

const run = (doc) => {
  const scope = beginBrepScope();
  try { return evaluateCells(doc).report.map((c) => !!c.cached); } finally { scope.dispose(); }
};

test('a big model drops a cell\'s older versions before it rebuilds, and still reuses the current ones', async () => {
  await initBrep();
  clearCellCache();
  const doc = new CellDocument();
  doc.addCell({ id: 'body', code: 'export const params = { w: 60 }; export default ({ p, brep }) => brep.box(p.w, 40, 24);' });
  doc.addCell({ id: 'round', code: `export const params = { r: 3 };
    export default ({ p, brep, q, input }) => brep.fillet(input, q.edges(input).linear().along('z').expect(4), p.r);` });

  assert.deepEqual(run(doc), [false, false]);
  assert.deepEqual(run(doc), [true, true], 'an unchanged stack is all hits');

  doc.updateCell('body', { params: { w: 80 } });
  assert.deepEqual(run(doc), [false, false]);
  doc.updateCell('body', { params: { w: 60 } });
  assert.deepEqual(run(doc), [false, false], 'the older versions were dropped, so the revert rebuilds');
});
