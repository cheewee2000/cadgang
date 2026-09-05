/**
 * The Fusion-shaped vocabulary: every operation a cell can call that goes
 * beyond box / extrude / boolean, checked by the number it must produce.
 * Volumes are the honest witness — a sweep that took the wrong frame or a
 * pattern that fused nothing reads as the wrong number, not as "it ran".
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { initBrep, beginBrepScope } from '../src/core/brep.js';
import * as ops from '../src/core/ops.js';
import { Sketch } from '../src/core/sketch.js';
import { q } from '../src/core/query.js';
import { cellApi } from '../src/core/cellapi.js';

await initBrep();

const inScope = (fn) => { const s = beginBrepScope(); try { return fn(); } finally { s.dispose(); } };
const near = (a, b, rel = 0.02) =>
  assert.ok(Math.abs(a - b) <= Math.abs(b) * rel + 1e-6, `expected ${a} to be within ${rel * 100}% of ${b}`);

/** A square of side `w` centred on the origin, on `plane` at `offset`. */
function square(w, plane = 'XY', offset = 0) {
  const s = new Sketch().on(plane, offset);
  s.rectangle(-w / 2, -w / 2, w / 2, w / 2);
  return s;
}
function circle(r, plane = 'XY', offset = 0) {
  const s = new Sketch().on(plane, offset);
  s.circle(s.anchor(0, 0), r);
  return s;
}

test('torus and cone have the volumes geometry says', () => inScope(() => {
  near(ops.volume(ops.torus(20, 3)), 2 * Math.PI ** 2 * 20 * 9);
  near(ops.volume(ops.cone(10, 0, 30)), (Math.PI * 100 * 30) / 3);
  near(ops.volume(ops.cone(10, 5, 30)), (Math.PI * 30 * (100 + 50 + 25)) / 3);
}));

test('revolve takes a partial angle and extrude a twist and end scale', () => inScope(() => {
  const s = new Sketch().on('XZ');
  s.rectangle(10, 0, 20, 5); // a 10×5 block from r = 10 to r = 20
  near(ops.volume(ops.revolve(s, [0, 0, 1], { angle: 90 })), (Math.PI * (400 - 100) * 5) / 4);
  const twisted = ops.extrude(square(10), 20, { twist: 45 });
  near(ops.volume(twisted), 2000, 0.05);
  const tapered = ops.extrude(square(10), 20, { endScale: 0.5 });
  // frustum of a square pyramid: h/3 (A1 + A2 + sqrt(A1 A2))
  near(ops.volume(tapered), (20 / 3) * (100 + 25 + 50), 0.05);
}));

test('loft between two offset sections and sweep along a path', () => inScope(() => {
  const lofted = ops.loft([square(10), square(10, 'XY', 20)], { ruled: true });
  near(ops.volume(lofted), 2000);
  const swept = ops.sweep(circle(2), ops.polyline([[0, 0, 0], [0, 0, 30]]));
  near(ops.volume(swept), Math.PI * 4 * 30);
  const bent = ops.sweep(circle(2), ops.spline([[0, 0, 0], [0, 10, 20], [0, 0, 40]]));
  assert.ok(ops.volume(bent) > Math.PI * 4 * 40);
}));

test('helix pipe makes a coil, and wall hollows it', () => inScope(() => {
  const coil = ops.pipe(ops.helix(10, 8, 24), 1.5);
  const turns = 3;
  const length = turns * Math.hypot(2 * Math.PI * 10, 8);
  near(ops.volume(coil), Math.PI * 1.5 ** 2 * length, 0.05);
  const tube = ops.pipe(ops.polyline([[0, 0, 0], [50, 0, 0]]), 5, { wall: 1 });
  near(ops.volume(tube), Math.PI * (25 - 16) * 50);
}));

test('hole drills through, with counterbore and countersink', () => inScope(() => {
  const plate = ops.box(40, 40, 10);
  near(ops.volume(ops.hole(plate, [0, 0, 10], 4)), 16000 - Math.PI * 4 * 10);
  near(ops.volume(ops.hole(plate, [0, 0, 10], 4, { depth: 5 })), 16000 - Math.PI * 4 * 5);
  const cb = ops.hole(plate, [0, 0, 10], 4, { counterbore: { diameter: 8, depth: 3 } });
  near(ops.volume(cb), 16000 - Math.PI * 4 * 10 - Math.PI * (16 - 4) * 3);
  const cs = ops.hole(plate, [0, 0, 10], 4, { countersink: { diameter: 8, angle: 90 } });
  const csDepth = 2; // (8-4)/2 / tan(45°)
  const frustum = (Math.PI * csDepth * (16 + 4 + 8)) / 3 - Math.PI * 4 * csDepth;
  near(ops.volume(cs), 16000 - Math.PI * 4 * 10 - frustum);
  // sideways, into the +x face
  near(ops.volume(ops.hole(plate, [20, 0, 5], 4, { direction: [-1, 0, 0], depth: 10 })), 16000 - Math.PI * 4 * 10);
}));

test('patterns fuse their copies', () => inScope(() => {
  const peg = ops.cylinder(2, 5);
  near(ops.volume(ops.linearPattern(peg, [10, 0, 0], 4)), 4 * Math.PI * 4 * 5);
  const ring = ops.circularPattern(ops.translate(peg, [15, 0, 0]), 6);
  near(ops.volume(ring), 6 * Math.PI * 4 * 5);
  assert.equal(q.faces(ring).cylindrical().count(), 6);
  const arc = ops.circularPattern(ops.translate(peg, [15, 0, 0]), 3, { angle: 90 });
  const b = ops.bbox(arc);
  near(b.max[1], 17); // the last copy sits at 90°, on +y
}));

test('offset grows a body and draft tapers it', () => inScope(() => {
  const cube = ops.box(10, 10, 10, { center: 'xyz' });
  const grown = ops.offset(cube, 1);
  assert.ok(ops.volume(grown) > 1000 && ops.volume(grown) < 12 ** 3);
  near(ops.bbox(grown).size[0], 12);
  const drafted = ops.draft(ops.box(20, 20, 10), q.faces(ops.box(20, 20, 10)).planar().facing('+x'), 10);
  const top = ops.bbox(drafted);
  assert.ok(top.size[0] > 20 - 1e-6, 'the neutral plane is the bottom; the bottom stays 20 wide');
  assert.ok(ops.volume(drafted) < 4000, 'draft removed material along the pull');
}));

test('split returns both halves and planeOf reads a face', () => inScope(() => {
  const cube = ops.box(10, 10, 10);
  const { above, below } = ops.split(cube, [0, 0, 4], [0, 0, 1]);
  near(ops.volume(above), 600);
  near(ops.volume(below), 400);
  const plane = ops.planeOf(cube, q.faces(cube).planar().facing('+z'));
  assert.deepEqual(plane.normal.map((c) => Math.round(c) + 0), [0, 0, 1]);
  near(plane.origin[2], 10);
  // a sketch on that face extrudes up from it
  const boss = ops.extrude(circle(3).on(plane), 5);
  near(ops.bbox(boss).min[2], 10);
  near(ops.bbox(boss).max[2], 15);
}));

test('measures: centroid and distance', () => inScope(() => {
  const cube = ops.box(10, 10, 10);
  const c = ops.centroid(cube);
  [0, 0, 5].forEach((v, i) => assert.ok(Math.abs(c[i] - v) < 1e-6, `centroid[${i}] = ${c[i]}`));
  near(ops.distance(cube, ops.translate(cube, [25, 0, 0])), 15);
}));

test('every operation is reachable from a cell program', () => inScope(() => {
  const api = cellApi({});
  for (const name of ['torus', 'cone', 'loft', 'sweep', 'pipe', 'polyline', 'spline', 'helix', 'hole',
    'linearPattern', 'circularPattern', 'offset', 'draft', 'split', 'planeOf', 'centroid', 'distance']) {
    assert.equal(typeof api.brep[name], 'function', name);
  }
  const s = api.sk.sketch().on('XY', 5);
  assert.equal(s.offset, 5);
}));
