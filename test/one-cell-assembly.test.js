// One cell that builds a whole assembly (sketched parts, posed, named): an edit rebuilds only what it touched,
// the viewer gets every body by name, and a moved part's mesh is its source's mesh moved.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CellDocument, evaluateCells, clearCellCache } from '../src/core/cells.js';
import { initBrep, beginBrepScope, tessellateBodies, brepOperationStats, resetBrepOperationStats } from '../src/core/brep.js';

const code = `export const params = { turn: 0, lid: 4 };
export default ({ p, brep, sk }) => {
  const plate = (w, d, h) => { const s = sk.sketch(); const ids = [[0, 0], [w, 0], [w, d], [0, d]].map(([x, y]) => s.point(x, y, { fixed: true })); ids.forEach((a, i) => s.line(a, ids[(i + 1) % 4])); return brep.extrude(s, h); };
  const base = plate(60, 40, 5), arm = brep.translate(brep.rotate(plate(30, 6, 3), p.turn, [0, 0, 1], [3, 3, 0]), [10, 10, 5]);
  const lid = brep.translate(plate(60, 40, p.lid), [0, 0, 20]);
  return brep.compound(brep.name(base, 'base, steel'), brep.name(arm, 'arm'), brep.name(lid, 'lid, plastic #e4572e'));
};`;
const count = (op) => brepOperationStats()[op]?.count ?? 0;
const run = (doc, body) => { const scope = beginBrepScope(); try { return body(evaluateCells(doc).value); } finally { scope.dispose(); } };
const box = (pos, first, n) => { const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]; for (let i = first; i < first + n; i++) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], pos[3 * i + k]); hi[k] = Math.max(hi[k], pos[3 * i + k]); } return [...lo, ...hi].map((v) => Math.round(v * 100) / 100); };

test('a one-cell assembly: an edit rebuilds one part, bodies come out named, a turned part is not re-meshed', async () => {
  await initBrep();
  clearCellCache();
  const doc = new CellDocument();
  doc.addCell({ id: 'rig', code });
  const first = run(doc, (shape) => tessellateBodies(shape, { tolerance: 0.1 }, 'rig'));
  assert.deepEqual(first.bodies.map((b) => b.name), ['base, steel', 'arm', 'lid, plastic'], 'a #rrggbb in a name is its colour, not part of the name');
  assert.deepEqual(first.bodies.map((b) => b.color?.map((c) => Math.round(c * 255)) ?? null), [null, null, [0xe4, 0x57, 0x2e]]);
  assert.equal(first.bodies.reduce((n, b) => n + b.count, 0), first.indices.length / 3, 'the bodies cover every triangle');

  resetBrepOperationStats();
  doc.updateCell('rig', { params: { turn: 0, lid: 6 } });
  run(doc, (shape) => tessellateBodies(shape, { tolerance: 0.1 }, 'rig'));
  assert.equal(count('extrude'), 1, 'only the lid is extruded again');
  assert.equal(count('tessellation'), 1, 'and only the lid is meshed again');

  resetBrepOperationStats();
  doc.updateCell('rig', { params: { turn: 90, lid: 6 } });
  const turned = run(doc, (shape) => tessellateBodies(shape, { tolerance: 0.1 }, 'rig'));
  assert.equal(count('extrude'), 0);
  assert.equal(count('tessellation'), 0, 'the turned arm is the same mesh, turned');
  // the arm, 30 x 6 x 3 turned 90° about (3, 3) then moved by (10, 10, 5): x 10..16, y 10..40, z 5..8
  const arm = turned.bodies[1], verts = new Set(turned.indices.subarray(arm.first * 3, (arm.first + arm.count) * 3));
  assert.deepEqual(box(turned.positions, Math.min(...verts), verts.size), [10, 10, 5, 16, 40, 8]);
});

test('a sketch whose dimension reads a parameter is a new drawing when that parameter changes, and only then', async () => {
  await initBrep();
  clearCellCache();
  const doc = new CellDocument();
  doc.addCell({ id: 'bar', code: `export const params = { w: 20, other: 1 };
export default ({ p, brep, sk }) => { const s = sk.sketch(); const [a, b, c, d] = s.rectangle(0, 0, 10, 5); s.distance(a, b, 'w'); return brep.translate(brep.extrude(s, 2), [p.other, 0, 0]); };` });
  const width = () => run(doc, (shape) => { const t = tessellateBodies(shape, { tolerance: 0.1 }, 'bar'); return box(t.positions, 0, t.positions.length / 3); });
  const w20 = width();
  resetBrepOperationStats();
  doc.updateCell('bar', { params: { w: 20, other: 3 } }); width();
  assert.equal(count('extrude'), 0, 'a parameter the sketch does not read leaves it alone');
  doc.updateCell('bar', { params: { w: 35, other: 3 } });
  const w35 = width();
  assert.equal(count('extrude'), 1);
  assert.notDeepEqual(w35.map((v, i) => v - w20[i]).slice(3), [2, 0, 0], 'the bar changed size, not just place');
});

test('a part placed by a later cell: moving it there re-meshes nothing', async () => {
  await initBrep();
  clearCellCache();
  const doc = new CellDocument();
  doc.addCell({ id: 'peg', code: 'export default ({ brep }) => brep.cylinder(4, 20);' });
  doc.addCell({ id: 'placed', refs: ['peg'], code: `export const params = { z: 5 };
export default ({ p, brep, inputs }) => brep.compound(brep.box(30, 30, 2), brep.name(brep.translate(brep.rotate(inputs.peg, 90, [0, 1, 0]), [0, 0, p.z]), 'peg'));` });
  run(doc, (shape) => tessellateBodies(shape, { tolerance: 0.1 }, 'placed'));
  resetBrepOperationStats();
  doc.updateCell('placed', { params: { z: 9 } });
  const moved = run(doc, (shape) => tessellateBodies(shape, { tolerance: 0.1 }, 'placed'));
  assert.equal(count('tessellation'), 0, 'the peg comes from another cell: its mesh is moved, not made again');
  const peg = moved.bodies.find((b) => b.name === 'peg'), zs = []; for (let i = peg.first * 3; i < (peg.first + peg.count) * 3; i++) zs.push(moved.positions[moved.indices[i] * 3 + 2]);
  assert.ok(Math.abs(Math.min(...zs) - 5) < 0.2 && Math.abs(Math.max(...zs) - 13) < 0.2, `the peg sits at its new height (${Math.min(...zs)}..${Math.max(...zs)})`);
});
