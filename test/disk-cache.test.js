import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CellDocument, evaluateCells, clearCellCache } from '../src/core/cells.js';
import { persistMeasureMemo, saveMeasureMemo, clearMeasureMemo } from '../src/core/cellapi.js';
import { initBrep, resetBrepOperationStats, brepOperationStats } from '../src/core/brep.js';

test('a fresh kernel finds the parts it built before on disk instead of rebuilding them', async () => {
  await initBrep(); clearCellCache();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadgang-disk-')), file = path.join(dir, 'cadgang', 'cells.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ cells: [
    { id: 'plate', prompt: 'p', code: 'export default ({ brep }) => brep.name(brep.box(40, 20, 3), \'plate\')' },
    { id: 'studs', refs: ['plate'], prompt: 's', code: 'export default ({ brep, inputs }) => { console.log(\'two studs\'); return brep.union(inputs.plate, brep.cylinder(2, 10), brep.translate(brep.cylinder(2, 10), [10, 0, 0])); }' },
  ] }));
  let doc = new CellDocument(file);
  resetBrepOperationStats();
  let run = evaluateCells(doc, 'studs');
  assert.equal(brepOperationStats().union?.count, 1);

  clearCellCache();   // what a kernel restart does to the in-memory cache
  doc = new CellDocument(file);
  resetBrepOperationStats();
  run = evaluateCells(doc, 'studs');
  assert.equal(brepOperationStats().union?.count ?? 0, 0, 'nothing rebuilt');
  assert.equal(brepOperationStats().box?.count ?? 0, 0);
  assert.ok(run.report.every((e) => e.cached), run.report.map((e) => e.id + ':' + e.cached).join(' '));
  assert.equal(run.report.find((e) => e.id === 'studs').logs[0].text, 'two studs', 'the logs came back with the shape');
  assert.equal(Math.round(run.value.wrapped ? 1 : 0), 1);

  doc.updateCell('plate', { code: 'export default ({ brep }) => brep.name(brep.box(40, 20, 4), \'plate\')' });   // an edit still rebuilds
  resetBrepOperationStats();
  run = evaluateCells(doc, 'studs');
  assert.equal(brepOperationStats().union?.count, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a fresh kernel finds its measures on disk too', async () => {
  await initBrep(); clearCellCache();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadgang-memo-')), file = path.join(dir, 'measures.json');
  persistMeasureMemo(file);
  const doc = new CellDocument();
  doc.addCell({ id: 'a', prompt: 'a', code: 'export default ({ brep }) => brep.box(10, 10, 10)' });
  doc.addCell({ id: 'b', prompt: 'b', code: 'export default ({ brep }) => brep.translate(brep.box(10, 10, 10), [5, 0, 0])' });
  doc.addCell({ id: 'check', kind: 'assert', refs: ['a', 'b'], prompt: 'c', code: 'export default ({ brep, inputs, assert }) => { assert.ok(brep.interference(inputs.a, inputs.b) > 0, \'overlap\'); return inputs.a; }' });
  resetBrepOperationStats();
  evaluateCells(doc, 'check');
  assert.equal(brepOperationStats().interference?.count, 1);
  saveMeasureMemo();
  clearMeasureMemo();   // a kernel restart
  persistMeasureMemo(file);
  resetBrepOperationStats();
  const run = evaluateCells(doc, 'check');
  assert.equal(run.report.find((e) => e.id === 'check').status, 'ok');
  assert.equal(brepOperationStats().interference?.count ?? 0, 0, 'the clash volume came from the file');
  persistMeasureMemo(path.join(dir, 'unused.json'));   // stop writing to the folder about to go
  fs.rmSync(dir, { recursive: true, force: true });
});
