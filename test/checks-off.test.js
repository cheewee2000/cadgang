import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CellDocument, evaluateCells, clearCellCache } from '../src/core/cells.js';
import { initBrep, resetBrepOperationStats, brepOperationStats } from '../src/core/brep.js';

test('with checks off an assertion cell is skipped, passes its input on, and the document does not pass', async () => {
  await initBrep(); clearCellCache();
  const doc = new CellDocument();
  doc.addCell({ id: 'a', prompt: 'a', code: 'export default ({ brep }) => brep.box(10, 10, 10)' });
  doc.addCell({ id: 'b', prompt: 'b', code: 'export default ({ brep }) => brep.translate(brep.box(10, 10, 10), [5, 0, 0])' });
  doc.addCell({ id: 'check', kind: 'assert', refs: ['a', 'b'], prompt: 'c', code: 'export default ({ brep, inputs, assert }) => { assert.ok(brep.interference(inputs.a, inputs.b) < 1, \'clear\'); return inputs.a; }' });
  doc.setChecks(false);
  resetBrepOperationStats();
  let run = evaluateCells(doc, 'check');
  assert.equal(run.report.find((e) => e.id === 'check').status, 'skipped');
  assert.equal(brepOperationStats().interference?.count ?? 0, 0);
  assert.equal(run.assertionsPass, false, 'a check not run is a claim unmet');
  assert.ok(run.value, 'the input still comes through');

  run = evaluateCells(doc, 'check', { checks: true });   // an export asks for them whatever the switch says
  assert.equal(run.report.find((e) => e.id === 'check').status, 'failed');
  assert.equal(brepOperationStats().interference?.count, 1);

  doc.setChecks(true);
  run = evaluateCells(doc, 'check');
  assert.equal(run.report.find((e) => e.id === 'check').status, 'failed');
});
