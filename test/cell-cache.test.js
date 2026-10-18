import test from 'node:test';
import assert from 'node:assert/strict';
import { CellDocument, evaluateCells, clearCellCache } from '../src/core/cells.js';
import { initBrep, beginBrepScope } from '../src/core/brep.js';
import * as ops from '../src/core/ops.js';

const run = (doc) => {
  const scope = beginBrepScope();
  try {
    const r = evaluateCells(doc);
    return { cached: r.report.map((c) => !!c.cached), size: ops.bbox(r.value).size.map(Math.round) };
  } finally { scope.dispose(); }
};

test('cells reuse built shapes across runs; an edit re-runs only itself and below', async () => {
  await initBrep();
  clearCellCache();
  const doc = new CellDocument();
  doc.addCell({ id: 'body', code: 'export const params = { w: 60 }; export default ({ p, brep }) => brep.box(p.w, 40, 24);' });
  doc.addCell({ id: 'check', kind: 'assert', code: 'export default ({ input }) => input;' });
  doc.addCell({ id: 'round', code: `export const params = { r: 3 };
    export default ({ p, brep, q, input }) => brep.fillet(input, q.edges(input).linear().along('z').expect(4), p.r);` });

  assert.deepEqual(run(doc).cached, [false, false, false]);
  assert.deepEqual(run(doc).cached, [true, false, true], 'assertions always re-run');

  doc.updateCell('round', { params: { r: 5 } });
  assert.deepEqual(run(doc).cached, [true, false, false]);

  doc.updateCell('body', { params: { w: 80 } });
  const edited = run(doc);
  assert.deepEqual(edited.cached, [false, false, false], 'an upstream edit misses everything below');
  assert.equal(edited.size[0], 80);

  doc.updateCell('body', { params: { w: 60 } });
  const back = run(doc);
  assert.deepEqual(back.cached, [true, false, true], 'reverting finds the old body, and round at r=5 on it');
  assert.equal(back.size[0], 60);
});
