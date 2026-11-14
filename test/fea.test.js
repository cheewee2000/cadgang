import test from 'node:test';
import assert from 'node:assert/strict';
import { fea, voxelise, refine, heat, colouredPLY, bandedGLB } from '../src/core/fea.js';

/** A closed box mesh, corner at the origin. */
function box(sx, sy, sz) {
  const positions = [];
  for (const z of [0, sz]) for (const y of [0, sy]) for (const x of [0, sx]) positions.push(x, y, z);
  const quads = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]];
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(quads.flatMap(([a, b, c, d]) => [a, b, c, a, c, d])) };
}

test('voxelise fills a box exactly', () => {
  const { n, filled, dropped } = voxelise(...Object.values(box(10, 20, 30)), 2.5);
  assert.deepEqual(n, [4, 8, 12]);
  assert.equal(filled.reduce((s, v) => s + v, 0), 4 * 8 * 12);
  assert.equal(dropped, 0);
});

test('a cantilever bends as beam theory says', () => {
  // 10 x 10 x 60 mm aluminium bar, held at z = 0, 100 N sideways on the far end
  const E = 70000, L = 60, F = 100, I = 10 ** 4 / 12;
  const out = fea(box(10, 10, L), {
    size: 1.25, E, nu: 0.33,
    fixed: [{ box: [[-1, -1, -1], [11, 11, 0.01]] }],
    loads: [{ box: [[-1, -1, L - 0.01], [11, 11, L + 1]], force: [F, 0, 0] }],
  });
  assert.ok(out.converged, `converged (residual ${out.residual} after ${out.iterations})`);
  const bend = F * L ** 3 / (3 * E * I), shear = F * L / ((5 / 6) * (E / 2.66) * 100);
  assert.ok(Math.abs(out.maxDisp / (bend + shear) - 1) < 0.1, `tip deflection ${out.maxDisp.toFixed(4)} mm vs ${(bend + shear).toFixed(4)} mm`);
  // bending stress at the centre of the outermost voxels of the first free layer (z = 1.875, 4.375 mm off the axis)
  const root = F * (L - 1.875) * 4.375 / I;
  assert.ok(Math.abs(out.peak.stress / root - 1) < 0.15, `root stress ${out.peak.stress.toFixed(1)} MPa vs ${root.toFixed(1)} MPa`);
  assert.ok(out.peak.at[2] < 5, 'the peak is at the held end');
});

test('a load carried in from a point adds its moment', () => {
  // the same 100 N, acting 40 mm beyond the bar's end: the end sees the force and a 4000 N·mm couple
  const out = fea(box(10, 10, 60), {
    size: 2.5, E: 70000,
    fixed: [{ box: [[-1, -1, -1], [11, 11, 0.01]] }],
    loads: [{ box: [[-1, -1, 59.99], [11, 11, 61]], force: [100, 0, 0], at: [5, 5, 100] }],
  });
  assert.ok(Math.abs(Math.abs(out.applied[0].moment[1]) - 4000) < 1, `moment ${out.applied[0].moment}`);
});

test('a part nothing holds is refused', () => {
  assert.throws(() => fea(box(10, 10, 10), { size: 2.5, E: 70000, loads: [{ box: [[0, 0, 9], [10, 10, 11]], force: [0, 0, 1] }] }), /Nothing holds/);
});

test('the display helpers', () => {
  const b = box(10, 10, 10), soup = refine(b.positions, b.indices, 3);
  assert.ok(soup.length / 9 > 12);
  for (let t = 0; t < soup.length; t += 9) assert.ok(Math.hypot(soup[t] - soup[t + 3], soup[t + 1] - soup[t + 4], soup[t + 2] - soup[t + 5]) <= 3 + 1e-6);
  assert.deepEqual(heat(0), [0, 0, 1]); assert.deepEqual(heat(1), [1, 0, 0]);
  const ply = colouredPLY(soup, new Float32Array(soup.length).fill(1));
  assert.ok(ply.subarray(0, 3).toString() === 'ply');
  // two bands used out of four: a valid GLB whose lengths add up, one named mesh per band in use
  const glb = bandedGLB(soup, Float32Array.from({ length: soup.length / 3 }, (_, v) => (v < 9 ? 10 : 90)), 100, 'MPa', 4);
  assert.equal(glb.readUInt32LE(0), 0x46546c67); assert.equal(glb.readUInt32LE(8), glb.length);
  const doc = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString());
  assert.deepEqual(doc.meshes.map((m) => m.name), ['0-25 MPa', '75-100 MPa and over']);
  assert.equal(doc.accessors.reduce((n, a) => n + a.count, 0), soup.length / 3);
});
