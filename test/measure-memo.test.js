import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CellDocument, evaluateCells, clearCellCache } from '../src/core/cells.js';
import { initBrep, resetBrepOperationStats, brepOperationStats } from '../src/core/brep.js';

const count = (op) => brepOperationStats()[op]?.count ?? 0;

test('a clash check between two unchanged parts is a lookup, not a kernel call', async () => {
  await initBrep(); clearCellCache();
  const doc = new CellDocument();
  doc.addCell({ id: 'a', prompt: 'a', code: 'export default ({ brep }) => brep.box(10, 10, 10)' });
  doc.addCell({ id: 'b', prompt: 'b', code: 'export default ({ brep }) => brep.translate(brep.box(10, 10, 10), [5, 0, 0])' });
  doc.addCell({ id: 'c', prompt: 'c', code: 'export default ({ brep }) => brep.translate(brep.box(10, 10, 10), [40, 0, 0])' });
  doc.addCell({ id: 'check', kind: 'assert', refs: ['a', 'b', 'c'], prompt: 'clashes', code: `export default ({ brep, inputs, assert }) => {
    const v = brep.interference(inputs.a, inputs.b) + brep.interference(inputs.b, inputs.c) + brep.interference(inputs.a, inputs.c);
    const box = brep.bbox(brep.compound(inputs.a, inputs.b, inputs.c));
    assert.ok(v > 0, 'measured ' + Math.round(v) + ' ' + box.size.map(Math.round));
    return inputs.a;
  }` });
  resetBrepOperationStats();
  let run = evaluateCells(doc, 'check', { stopOnError: false });
  assert.equal(run.report.find((e) => e.id === 'check').status, 'ok', run.report.find((e) => e.id === 'check').error);
  assert.equal(count('interference'), 3);
  const boxes = count('bbox');   // one per part: the compound's box is the union of theirs

  run = evaluateCells(doc, 'check', { stopOnError: false });   // nothing changed: the assertion re-runs, the kernel rests
  assert.equal(run.report.find((e) => e.id === 'check').status, 'ok');
  assert.equal(count('interference'), 3);
  assert.equal(count('bbox'), boxes);

  doc.updateCell('c', { code: 'export default ({ brep }) => brep.translate(brep.box(10, 10, 10), [41, 0, 0])' });   // one part moved
  run = evaluateCells(doc, 'check', { stopOnError: false });
  assert.equal(run.report.find((e) => e.id === 'check').status, 'ok');
  assert.equal(count('interference'), 5, 'only the two pairs with c re-measure');
  assert.equal(count('bbox'), boxes + 1, 'only c\'s box re-measures');
  assert.equal(run.report.find((e) => e.id === 'check').checks[0].label, 'measured 500 51,10,10', 'the box followed the move');
});
