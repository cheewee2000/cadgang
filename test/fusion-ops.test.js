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

// ------------------------------------------------------------ second batch

test('chamfer takes two distances measured from a named face', () => inScope(() => {
  const cube = ops.box(10, 10, 10);
  const top = q.faces(cube).planar().facing('+z');
  const edges = q.edges(cube).linear().along('x').atExtreme('+z');
  const c = ops.chamfer(cube, edges, { distances: [4, 1], face: top });
  // two chamfers, each a 4×1 right triangle prism 10 long
  near(ops.volume(c), 1000 - 2 * (0.5 * 4 * 1 * 10));
}));

test('mirror keep, pushPull, and simplify', () => inScope(() => {
  const half = ops.box(10, 10, 10);
  const whole = ops.mirror(ops.translate(half, [5, 0, 0]), 'YZ', [0, 0, 0], { keep: true });
  near(ops.volume(whole), 2000);
  const pushed = ops.pushPull(half, q.faces(half).planar().facing('+z'), 5);
  near(ops.volume(pushed), 1500);
  const pulled = ops.pushPull(half, q.faces(half).planar().facing('+x'), -3);
  near(ops.volume(pulled), 700);
  const row = ops.linearPattern(ops.box(10, 10, 10), [10, 0, 0], 3);
  const tidy = ops.simplify(row);
  near(ops.volume(tidy), 3000);
  assert.ok(q.faces(tidy).count() <= q.faces(row).count() && q.faces(tidy).count() === 6, 'simplify merges the coplanar faces');
}));

test('pathPattern spaces copies along a path and turns them', () => inScope(() => {
  const peg = ops.box(2, 2, 2, { center: 'xyz' });
  const line = ops.pathPattern(peg, ops.polyline([[0, 0, 0], [30, 0, 0]]), 4);
  near(ops.volume(line), 32);
  near(ops.bbox(line).max[0], 31);
  const bent = ops.pathPattern(ops.box(4, 1, 1, { center: 'xyz' }), ops.polyline([[0, 0, 0], [20, 0, 0], [20, 20, 0]]), 3);
  const b = ops.bbox(bent);
  near(b.max[1], 22, 0.05); // the last copy turned to follow +y
}));

test('rib, emboss and coil', () => inScope(() => {
  const plate = ops.box(40, 40, 4);
  const ribbed = ops.rib(plate, [[-15, 0, 4], [15, 0, 4]], 2, 6);
  near(ops.volume(ribbed), 6400 + 30 * 2 * 6);
  const boss = ops.emboss(plate, circle(5, 'XY', 4), 3);
  near(ops.volume(boss), 6400 + Math.PI * 25 * 3);
  const pocket = ops.emboss(plate, circle(5, 'XY', 4), 2, { cut: true });
  near(ops.volume(pocket), 6400 - Math.PI * 25 * 2);
  const spring = ops.coil(10, 6, 30, 1);
  near(ops.volume(spring), Math.PI * 1 * 5 * Math.hypot(2 * Math.PI * 10, 6), 0.05);
  const square = ops.coil(10, 6, 30, 1, { section: 'square' });
  near(ops.volume(square), 4 * 5 * Math.hypot(2 * Math.PI * 10, 6), 0.05);
}));

test('thread cuts a helical groove on a boss and in a hole', () => inScope(() => {
  const bolt = ops.cylinder(5, 20);
  const threaded = ops.thread(bolt, q.faces(bolt).cylindrical(), 1.5);
  const v = ops.volume(threaded);
  assert.ok(v < Math.PI * 25 * 20 && v > Math.PI * 25 * 20 * 0.7, `external thread removed a groove: ${v}`);
  near(ops.bbox(threaded).size[2], 20);
  const left = ops.thread(bolt, q.faces(bolt).cylindrical(), 1.5, { lefthand: true });
  near(ops.volume(left), v);
  // a boss on a base keeps its base
  const stud = ops.union(ops.box(30, 30, 5), ops.translate(ops.cylinder(5, 20), [0, 0, 5]));
  const studded = ops.thread(stud, q.faces(stud).cylindrical(), 1.5);
  near(ops.volume(studded), 4500 + v);
  const nut = ops.hole(ops.box(20, 20, 10), [0, 0, 10], 8);
  const tapped = ops.thread(nut, q.faces(nut).cylindrical(), 1.25);
  const nv = ops.volume(tapped);
  assert.ok(nv < ops.volume(nut) && nv > ops.volume(nut) * 0.9, `internal thread cut into the wall: ${nv}`);
}));

test('planes, axes and measures', () => inScope(() => {
  const p = ops.plane([0, 0, 5], [0, 0, 2]);
  assert.deepEqual(p.normal, [0, 0, 1]);
  const pt = ops.planeThrough([0, 0, 0], [10, 0, 0], [0, 10, 0]);
  assert.deepEqual(pt.normal, [0, 0, 1]);
  const tilted = ops.pivotPlane(pt, 90);
  near(tilted.normal[1], -1);
  const cube = ops.box(10, 10, 10);
  const mid = ops.midplane(cube, q.faces(cube).planar().facing('+x'), q.faces(cube).planar().facing('-x'));
  near(mid.origin[0], 0);
  const peg = ops.translate(ops.cylinder(3, 8), [12, 0, 0]);
  const ax = ops.axisOf(peg, q.faces(peg).cylindrical());
  near(ax.radius, 3);
  near(ax.origin[0], 12);
  near(Math.abs(ax.direction[2]), 1);
  // a solid on a tilted plane extrudes along its normal
  const tiltedBox = ops.extrude(square(4).on(ops.pivotPlane(ops.plane([0, 0, 0], [0, 0, 1]), 90)), 10);
  near(ops.bbox(tiltedBox).size[0], 10); // the normal was turned from +z to +x
  near(ops.mass(cube, 2.7), 2.7);
  near(ops.length(cube, q.edges(cube).linear()), 120);
  near(ops.interference(cube, ops.translate(cube, [5, 0, 0])), 500);
  near(ops.interference(cube, ops.translate(cube, [50, 0, 0])), 0);
  const { above, below } = ops.split(cube, ops.translate(cube, [5, 0, 0]));
  near(ops.volume(above), 500);
  near(ops.volume(below), 500);
}));

test('sketch polygon and slot are closed profiles', () => inScope(() => {
  const s = new Sketch();
  s.polygon(0, 0, 6, 10);
  near(ops.volume(ops.extrude(s, 2)), (3 * Math.sqrt(3) / 2) * 100 * 2);
  const t = new Sketch();
  t.slot(-10, 0, 10, 0, 3);
  near(ops.volume(ops.extrude(t, 1)), 20 * 6 + Math.PI * 9);
}));

test('an island inside a hole is kept, not cut', () => inScope(() => {
  const s = new Sketch();
  s.rectangle(-20, -20, 20, 20);
  s.circle(s.point(0, 0), 10);
  s.circle(s.point(0, 0), 4);
  near(ops.volume(ops.extrude(s, 1)), 1600 - Math.PI * 100 + Math.PI * 16);
  const t = new Sketch();
  t.rectangle(-20, -20, 20, 20);
  t.circle(t.point(-8, 0), 5);
  t.circle(t.point(8, 0), 5);
  near(ops.volume(ops.extrude(t, 1)), 1600 - 2 * Math.PI * 25);
}));

test('bbox of a shelled revolve is the geometry, not the offset surface box', () => inScope(() => {
  const s = new Sketch().on('XZ');
  const a = s.anchor(0, 0); const b = s.point(28, 0); const c = s.point(28, 60);
  const d = s.point(10, 90); const e = s.point(10, 97); const f = s.point(0, 97);
  const shoulder = s.point(19, 75);
  s.line(a, b); s.line(b, c); s.arc(shoulder, c, d); s.line(d, e); s.line(e, f); s.line(f, a);
  const bottle = ops.revolve(s, [0, 0, 1]);
  const hollow = ops.shell(bottle, q.faces(bottle).planar().facing('+z'), 1.2);
  const before = ops.bbox(bottle);
  const after = ops.bbox(hollow);
  for (const k of [0, 1, 2]) {
    near(after.min[k], before.min[k], 0.001);
    near(after.max[k], before.max[k], 0.001);
  }
  near(after.max[2], 97, 0.001);
}));

test('planeOf puts the origin at the face centre', () => inScope(() => {
  const cube = ops.translate(ops.box(10, 10, 10), [5, 5, 0]);
  const plane = ops.planeOf(cube, q.faces(cube).planar().facing('+x'));
  [10, 5, 5].forEach((v, i) => near(plane.origin[i], v, 0.001));
  const boss = ops.extrude(circle(2).on(plane), 3);
  const c = ops.centroid(boss);
  near(c[1], 5, 0.01); near(c[2], 5, 0.01);
}));

test('crossing loops and collapsed points are named, not left to the kernel', () => inScope(() => {
  const s = new Sketch();
  s.rectangle(0, 0, 20, 20);
  s.circle(s.point(20, 10), 5); // pokes through the right edge
  assert.throws(() => ops.extrude(s, 1), /loops cross each other near \(20\.00/);
  const t = new Sketch();
  const a = t.anchor(0, 0); const b = t.point(10, 0); const c = t.point(10, 10); const d = t.point(0, 10);
  const l1 = t.line(a, b); t.line(b, c); t.line(c, d); t.line(d, a);
  t.distance(l1, 0.0000001); // collapses b onto a
  assert.throws(() => ops.extrude(t, 1), /converged to the same place/);
}));

test('a loft with corners still shells, by offset when OCCT refuses', () => inScope(() => {
  const sq = new Sketch(); sq.rectangle(-20, -20, 20, 20);
  const ci = new Sketch().on('XY', 40); ci.circle(ci.anchor(0, 0), 15);
  const adapter = ops.loft([sq, ci]);
  const duct = ops.shell(adapter, q.faces(adapter).planar(), 1.5);
  const v = ops.volume(duct);
  assert.ok(v > 5000 && v < 10000, `a 1.5 mm wall duct: ${v}`);
  assert.equal(q.faces(duct).planar().count(), 2, 'both ends open: two rims');
  const cup = ops.shell(adapter, q.faces(adapter).planar().facing('+z'), 1.5);
  assert.ok(ops.volume(cup) > v, 'one end closed keeps its floor');
}));

test('errors name the cause: collapsed offset, curved draft, a split that misses, a coordinate for a point', () => inScope(() => {
  const box = ops.box(30, 30, 30);
  const hollow = ops.shell(box, q.faces(box).planar().facing('+z'), 2);
  assert.throws(() => ops.offset(hollow, -1), /thinner than 2 mm/);
  const cyl = ops.cylinder(10, 20);
  assert.throws(() => ops.draft(cyl, q.faces(cyl).cylindrical(), 5), /only planar faces can be drafted/);
  assert.throws(() => ops.split(box, ops.translate(cyl, [100, 0, 0])), /does not cut the body/);
  assert.throws(() => ops.split(box, [0, 0, 100], [0, 0, 1]), /does not cut the body/);
  const s = new Sketch();
  assert.throws(() => s.circle([0, 0], 5), /pass the index that s\.point/);
}));

test('a sweep guide rail steers the profile', () => inScope(() => {
  const rect = new Sketch(); rect.rectangle(-2, -3, 2, 3);
  const path = ops.polyline([[0, 0, 0], [50, 0, 0]]);
  const plain = ops.bbox(ops.sweep(rect, path));
  const guided = ops.bbox(ops.sweep(rect, path, { guide: ops.spline([[0, 0, 3], [25, 0, 13], [50, 0, 3]]) }));
  near(plain.size[2], 4);
  assert.ok(guided.size[2] > 6, `the rail lifted the profile: ${guided.size[2]}`);
}));

test('primitives refuse non-positive sizes', () => inScope(() => {
  assert.throws(() => ops.box(-10, 10, 10), /box: sx must be a positive number/);
  assert.throws(() => ops.cylinder(5, 0), /cylinder: height must be a positive number/);
  assert.throws(() => ops.sphere('big'), /sphere: radius must be a positive number/);
}));
