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
  const made = brepOperationStats().tessellation.count;   // 2: a fine mesh is judged against the coarse one, which is a mesh of its own
  const b = tessellate(run.value, { tolerance: 0.05 }), e2 = tessellateEdges(run.value, { tolerance: 0.05 });
  assert.equal(brepOperationStats().tessellation.count, made);
  assert.equal(a, b); assert.equal(e1, e2);
  tessellate(run.value, { tolerance: 0.5 });
  assert.equal(brepOperationStats().tessellation.count, made + 1, 'another tolerance is another mesh');
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

test('a part mesh kept on disk is read back by a fresh kernel instead of being meshed again', async () => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path'), crypto = await import('node:crypto');
  const { persistMeshes } = await import('../src/core/brep.js');
  await initBrep(); clearCellCache();
  const doc = new CellDocument();
  doc.addCell({ id: 'rod', prompt: 'r', code: 'export default ({ brep }) => brep.cylinder(7, 31)' });
  const run = evaluateCells(doc, 'rod'), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadgang-meshes-'));
  const file = (tol) => path.join(dir, '1', crypto.createHash('sha1').update(`${run.value.__key}|${tol}|0.3`).digest('hex'));
  try {
    persistMeshes(dir); resetBrepOperationStats();
    const made = tessellate(run.value, { tolerance: 0.07 }), meshed = brepOperationStats().tessellation.count;
    assert.ok(fs.existsSync(file(0.07)), 'written');
    fs.copyFileSync(file(0.07), file(0.08));   // stands in for a mesh an earlier kernel left
    const read = tessellate(run.value, { tolerance: 0.08 });
    assert.equal(brepOperationStats().tessellation.count, meshed, 'the second was read, not meshed');
    assert.deepEqual(read, made);
    fs.writeFileSync(file(0.09), 'cut short');
    assert.equal(tessellate(run.value, { tolerance: 0.09 }).indices.length, made.indices.length, 'a damaged file is meshed over');
  } finally { persistMeshes(null); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a pick by named query steps is remembered with its shape; one by a function is not', async () => {
  await initBrep(); clearCellCache();
  const { cellApi } = await import('../src/core/cellapi.js'), { beginBrepScope } = await import('../src/core/brep.js');
  const scope = beginBrepScope();
  try {
    const { brep, q } = cellApi({}), count = () => brepOperationStats().chamfer?.count ?? 0;
    const block = brep.subtract(brep.box(20, 20, 10), brep.cylinder(3, 30));
    resetBrepOperationStats();
    const a = brep.chamfer(block, q.edges(block).linear().along('z'), 1), b = brep.chamfer(block, q.edges(block).linear().along('z'), 1);
    assert.equal(count(), 1, 'the same named pick of the same shape is one chamfer');
    assert.ok(a.__key && a.__key === b.__key);
    const c = brep.chamfer(block, q.edges(block).linear().along('z', 5), 1);
    assert.equal(count(), 2, 'a tolerance the label does not show is still another pick');
    assert.notEqual(c.__key, a.__key);
    const d = brep.chamfer(block, q.edges(block).where((e) => e.kind === 'LINE').along('z'), 1);
    assert.equal(count(), 3);
    assert.equal(d.__key, undefined, 'a function cannot be compared, so nothing built on it is remembered');
    assert.ok(brep.chamfer(block, q.edges(block).linear().exclude((x) => x.along('x').along('y')), 1).__key, 'a sub-query of named steps is named too');
  } finally { scope.dispose(); }
});

test('a part over the triangle budget is meshed once for every finer tolerance', async () => {
  await initBrep(); clearCellCache();
  const doc = new CellDocument();
  doc.addCell({ id: 'ring', prompt: 'r', code: 'export default ({ brep }) => brep.torus(40, 8)' });
  const run = evaluateCells(doc, 'ring');
  resetBrepOperationStats();
  const fine = tessellate(run.value, { tolerance: 0.05, angularTolerance: 0.02 }), n = brepOperationStats().tessellation.count;
  assert.ok(fine.indices.length / 3 * 2 > 40000, `the test part is over the budget (${fine.indices.length / 3} triangles)`);
  assert.equal(n, 1, 'only the coarse mesh was made');
  assert.equal(tessellate(run.value, { tolerance: 0.02, angularTolerance: 0.02 }), fine);
  assert.equal(tessellate(run.value, { tolerance: 0.1, angularTolerance: 0.02 }), fine);
  assert.equal(brepOperationStats().tessellation.count, 1);
});

test('a mesh to print (fit) is the finest the triangle budget allows, where the screen gets the coarse one', async () => {
  await initBrep(); clearCellCache();
  const doc = new CellDocument();
  doc.addCell({ id: 'knob', prompt: 'k', code: 'export default ({ brep }) => brep.cylinder(20, 30)' });
  const knob = evaluateCells(doc, 'knob').value, tris = (m) => m.indices.length / 3;
  const coarse = tessellate(knob, { tolerance: 0.1 }), tiny = 1e-4;   // far finer than the budget allows for any part
  assert.equal(tessellate(knob, { tolerance: tiny }), coarse, 'over the budget, the screen keeps the coarse mesh');
  const print = tessellate(knob, { tolerance: tiny, fit: true });
  assert.ok(tris(print) > 4 * tris(coarse), `the print mesh is much finer: ${tris(print)} triangles against ${tris(coarse)}`);
  assert.ok(tris(print) <= 2 * 40000, `and stays near the budget: ${tris(print)}`);
  assert.equal(tessellate(knob, { tolerance: tiny }), coarse, 'and asking for it does not change what the screen gets');
});
