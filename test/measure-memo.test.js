import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CellDocument, evaluateCells, clearCellCache } from '../src/core/cells.js';
import { initBrep, resetBrepOperationStats, brepOperationStats } from '../src/core/brep.js';

const count = (op) => brepOperationStats()[op]?.count ?? 0;

test('a clash check between two unchanged parts is a lookup, not a kernel call', async () => {
  await initBrep(); clearCellCache();
  const doc = new CellDocument();
  doc.addCell({ id: 'a', prompt: 'a', code: 'export default ({ brep }) => brep.box(10, 10, 10, { center: \'xy\' })' });   // an options object from the sandbox's realm keys too
  doc.addCell({ id: 'b', prompt: 'b', code: 'export default ({ brep }) => brep.translate(brep.box(10, 10, 10), [5, 0, 0])' });
  doc.addCell({ id: 'c', prompt: 'c', code: 'export default ({ brep }) => brep.translate(brep.box(10, 10, 10), [40, 0, 0])' });
  // names a part on its way into an assembly: a label, not a change, so the part's measures still hit once this cell is cached
  doc.addCell({ id: 'asm', refs: ['a', 'b', 'c'], prompt: 'asm', code: 'export default ({ brep, inputs }) => brep.compound(brep.name(inputs.a, \'A\'), inputs.b, inputs.c)' });
  doc.addCell({ id: 'check', kind: 'assert', refs: ['a', 'b', 'c', 'asm'], prompt: 'clashes', code: `export default ({ brep, inputs, assert }) => {
    const v = brep.interference(inputs.a, inputs.b) + brep.interference(inputs.b, inputs.c) + brep.interference(inputs.a, inputs.c);
    const box = brep.bbox(brep.compound(inputs.a, inputs.b, inputs.c));
    assert.ok(v > 0, 'measured ' + Math.round(v) + ' ' + box.size.map(Math.round));
    return inputs.a;
  }` });
  resetBrepOperationStats();
  let run = evaluateCells(doc, 'check', { stopOnError: false });
  assert.equal(run.report.find((e) => e.id === 'check').status, 'ok', run.report.find((e) => e.id === 'check').error);
  assert.equal(count('interference'), 1, 'b–c and a–c are boxes apart: no boolean');
  const boxes = count('bbox');   // one per part: the compound's box is the union of theirs

  run = evaluateCells(doc, 'check', { stopOnError: false });   // nothing changed: the assertion re-runs, the kernel rests
  assert.equal(run.report.find((e) => e.id === 'check').status, 'ok');
  assert.equal(count('interference'), 1);
  assert.equal(count('bbox'), boxes);

  doc.updateCell('c', { code: 'export default ({ brep }) => brep.translate(brep.box(10, 10, 10), [41, 0, 0])' });   // one part moved
  run = evaluateCells(doc, 'check', { stopOnError: false });
  assert.equal(run.report.find((e) => e.id === 'check').status, 'ok');
  assert.equal(count('interference'), 1, 'c is still apart from a and b');
  assert.equal(count('bbox'), boxes + 1, 'only c\'s box re-measures');
  assert.equal(run.report.find((e) => e.id === 'check').checks[0].label, 'measured 500 51,10,10', 'the box followed the move');
});

test('a clash check against an assembly is a check against each part, so an edit re-measures its pairs only', async () => {
  await initBrep(); clearCellCache();
  const doc = new CellDocument();
  doc.addCell({ id: 'a', prompt: 'a', code: 'export default ({ brep }) => brep.box(10, 10, 10)' });
  doc.addCell({ id: 'b', prompt: 'b', code: 'export default ({ brep }) => brep.translate(brep.box(10, 10, 10), [20, 0, 0])' });
  doc.addCell({ id: 'c', prompt: 'c', code: 'export default ({ brep }) => brep.translate(brep.box(10, 10, 10), [40, 0, 0])' });
  doc.addCell({ id: 'asm', refs: ['a', 'b', 'c'], prompt: 'asm', code: 'export default ({ brep, inputs }) => brep.compound(inputs.a, inputs.b, inputs.c)' });
  // a bar through a and b, clear of c; the assembly is checked moved, so its parts are moved too
  doc.addCell({ id: 'bar', prompt: 'bar', code: 'export default ({ brep }) => brep.translate(brep.box(30, 4, 4), [10, 3, 3])' });
  doc.addCell({ id: 'check', kind: 'assert', refs: ['asm', 'bar'], prompt: 'clash', code: `export default ({ brep, inputs, assert }) => {
    const v = brep.interference(brep.translate(inputs.asm, [0, 0, 1]), inputs.bar);
    assert.ok(v > 0, 'shared ' + Math.round(v));
    return inputs.asm;
  }` });
  resetBrepOperationStats();
  let run = evaluateCells(doc, 'check', { stopOnError: false });
  const check = () => run.report.find((e) => e.id === 'check');
  assert.equal(check().status, 'ok', check().error);
  assert.equal(check().checks[0].label, 'shared 320', 'two 10×4×4 overlaps, moved up by one');
  assert.equal(count('interference'), 2, 'a and b against the bar; c is boxes apart');

  doc.updateCell('a', { code: 'export default ({ brep }) => brep.box(10, 10, 11)' });   // one part edited
  run = evaluateCells(doc, 'check', { stopOnError: false });
  assert.equal(check().status, 'ok', check().error);
  assert.equal(count('interference'), 3, 'only a re-measures against the bar');

  doc.updateCell('check', { code: doc.get('check').code.replace('brep.interference(brep.translate(inputs.asm, [0, 0, 1]), inputs.bar)', 'brep.interference(inputs.bar, brep.translate(inputs.asm, [0, 0, 1]))') });
  run = evaluateCells(doc, 'check', { stopOnError: false });
  assert.equal(check().checks[0].label, 'shared 320');
  assert.equal(count('interference'), 3, 'the pairs the other way round are the same pairs');
});

test('a check cell\'s clips and poses are kept: the second evaluate makes no boolean', async () => {
  await initBrep(); clearCellCache();
  const doc = new CellDocument();
  doc.addCell({ id: 'a', prompt: 'a', code: 'export default ({ brep }) => brep.box(10, 10, 10)' });
  doc.addCell({ id: 'check', kind: 'assert', refs: ['a'], prompt: 'c', code: `export default ({ brep, inputs, assert }) => {
    const piece = brep.intersect(inputs.a, brep.translate(brep.box(4, 4, 20), [3, 0, 0]));
    assert.ok(brep.volume(piece) > 1, 'piece ' + brep.volume(piece).toFixed(0));
    return inputs.a;
  }` });
  resetBrepOperationStats();
  let run = evaluateCells(doc, 'check');
  assert.equal(run.report.find((e) => e.id === 'check').status, 'ok');
  assert.equal(brepOperationStats().intersect?.count, 1);
  run = evaluateCells(doc, 'check');
  assert.equal(run.report.find((e) => e.id === 'check').status, 'ok');
  assert.equal(run.report.find((e) => e.id === 'check').checks[0].label, 'piece 160');
  assert.equal(brepOperationStats().intersect?.count, 1, 'the clip came from the memo');
});
