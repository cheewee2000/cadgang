/** Explode vectors: a pin in a bore, a pocketed magnet, a lid on a box, a slide in a channel, a loose part, a path through another body. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { explodeOffsets } from '../web/explode.js';

const box = (w, h, d, x, y, z) => { const g = new THREE.BoxGeometry(w, h, d); g.translate(x, y, z); return new THREE.Mesh(g); };
const dir = (m) => m.userData.offset.clone().normalize().toArray().map((v) => Math.round(v * 100) / 100 + 0);

test('magnet in a pocket leaves by the open axis, riding on the block; a loose part goes radially', () => {
  const block = merged([box(7, 20, 10, 23.5, 0, 0), box(7, 20, 10, 36.5, 0, 0), box(6, 7, 10, 30, 6.5, 0), box(6, 7, 10, 30, -6.5, 0), box(6, 6, 6, 30, 0, -2)]);
  const magnet = box(4, 4, 3, 30, 0, 3);
  const loose = box(10, 10, 10, -30, 0, 0);
  explodeOffsets([block, magnet, loose], new THREE.Vector3());
  assert.equal(magnet.userData.parent, block);
  assert.deepEqual(dir(magnet), [0, 0, 1]);
  assert.equal(loose.userData.parent, null);
  assert.deepEqual(dir(loose), [-1, 0, 0]);
});

test('a lid resting on a box lifts perpendicular to the mating plane, not radially', () => {
  const body = box(20, 20, 10, 0, 0, 0);
  const lid = box(20, 20, 2, 0, 0, 6);
  explodeOffsets([body, lid], new THREE.Vector3(8, 8, -3));
  assert.deepEqual(dir(lid), [0, 0, 1]);
  assert.equal(lid.userData.parent, body);   // and goes where the box goes
});

test('a slide between two walls moves along the channel and rides on the rail', () => {
  const rail = merged([box(2, 20, 4, -3, 0, 0), box(2, 20, 4, 3, 0, 0), box(8, 20, 1, 0, 0, -2.5)]);
  const slide = box(3.9, 6, 4, 0, 0, 0);
  explodeOffsets([rail, slide], new THREE.Vector3());
  assert.deepEqual(dir(slide), [0, 1, 0]);
  assert.equal(slide.userData.parent, rail);
});

test('a pin in a bore slides along the shared axis, out of the freer end, riding on the housing', () => {
  // housing: a Y-axis tube r 3..10, 20 long, with a wall closing the -Y end; pin r 2.9, 24 long, in the bore
  const tube = (r, h) => new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 48, 1, true));
  const ring = (ri, ro, y) => { const g = new THREE.RingGeometry(ri, ro, 48); g.rotateX(-Math.PI / 2); g.translate(0, y, 0); return new THREE.Mesh(g); };
  const housing = merged([tube(3, 20), tube(10, 20), ring(3, 10, 10), ring(0, 10, -10)]);
  const pin = merged([tube(2.9, 24), ring(0, 2.9, 12), ring(0, 2.9, -12)]);
  pin.geometry.translate(0, 2, 0);
  explodeOffsets([housing, pin], new THREE.Vector3(6, -40, 6));   // radial from here would be a diagonal
  assert.deepEqual(dir(pin), [0, 1, 0]);
  assert.equal(pin.userData.parent, housing);
});

test('a thread in its tap drill (pin wider than the through hole) still pairs with the bore and leaves by the open side, not toward a far wall', () => {
  const tube = (r, h) => new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 48, 1, true));
  const ring = (ri, ro, y) => { const g = new THREE.RingGeometry(ri, ro, 48); g.rotateX(-Math.PI / 2); g.translate(0, y, 0); return new THREE.Mesh(g); };
  const housing = merged([tube(3, 20), tube(10, 20), ring(3, 10, 10), ring(3, 10, -10), box(40, 2, 40, 0, 30, 0)]);   // through hole r 3, a wall beyond the +Y end
  const pin = merged([tube(3.3, 24), ring(0.5, 3.3, 12), ring(0.5, 3.3, -12)]);   // r 3.3: its teeth sit in the wall and meet the hole's lip (caps ringed: a fan from the centre is half degenerate triangles, which the stride sampler lands on)
  pin.geometry.translate(0, 2, 0);
  explodeOffsets([housing, pin], new THREE.Vector3(6, -40, 6));
  assert.deepEqual(dir(pin), [0, -1, 0]);
  assert.equal(pin.userData.parent, housing);
});
test('a radial path through another body is replaced by a clear one', () => {
  // a U-shaped frame whose far wall crosses the cube's radial
  const frame = merged([box(4, 80, 40, 0, 0, 0), box(4, 80, 40, 22, 0, 0)]);
  const cube = box(2, 2, 2, 15, 0, 0);
  explodeOffsets([frame, cube], new THREE.Vector3(11, 0, 0));   // the frame is centred: it stays; the cube's radial runs into its far wall
  assert.deepEqual(dir(cube), [0, 1, 0]);
});

test('facing pockets: a magnet rides the part whose pocket holds it, and leaves toward the other part', () => {
  // two blocks stacked along Y, each with a Y-axis pocket at the interface, a magnet in each; the pockets share one axis line
  // faces wind outward like a real solid: a bore's wall faces in, a pocket floor faces the opening
  const tube = (r, h, y, bore = false) => { const g = new THREE.CylinderGeometry(r, r, h, 48, 1, true); if (bore) g.scale(-1, 1, 1); g.translate(0, y, 0); return new THREE.Mesh(g); };
  const disc = (r, y, facing) => { const g = new THREE.CircleGeometry(r, 48); g.rotateX(facing > 0 ? -Math.PI / 2 : Math.PI / 2); g.translate(0, y, 0); return new THREE.Mesh(g); };
  const slab = (y0, y1) => { const g = new THREE.BoxGeometry(30, y1 - y0, 30); g.translate(0, (y0 + y1) / 2, 0); return new THREE.Mesh(g); };
  const lower = merged([slab(-20, 0), tube(3, 4, -2, true), disc(3, -4, +1)]);   // pocket y -4..0, open at y = 0
  const upper = merged([slab(0, 20), tube(3, 4, 2, true), disc(3, 4, -1)]);      // pocket y 0..4, open at y = 0
  const magLow = merged([tube(2.9, 3, -2.5), disc(2.9, -4, -1), disc(2.9, -1, +1)]);
  const magUp = merged([tube(2.9, 3, 2.5), disc(2.9, 1, -1), disc(2.9, 4, +1)]);
  explodeOffsets([lower, upper, magLow, magUp], new THREE.Vector3(10, 0, 10));
  assert.equal(magLow.userData.parent, lower);
  assert.equal(magUp.userData.parent, upper);
  assert.deepEqual(dir(magLow), [0, 1, 0]);
  assert.deepEqual(dir(magUp), [0, -1, 0]);
});

test('a screw whose shank fills its standoff leaves by the head end; a standoff between board and lid separates along the stack', () => {
  // board, tube standoff r 0.8..2 on it, lid with a 2.4 mm clearance hole resting on the standoff, pan-head screw on the lid:
  // shank r 1 (wider than the bore, as threads are modelled) down the standoff, head r 2.1. One ray from the screw's
  // centre threaded the bore and called "down" free; the probe from its head says otherwise.
  const tube = (r, h, z, bore = false) => { const g = new THREE.CylinderGeometry(r, r, h, 48, 1, true); if (bore) g.scale(-1, 1, 1); g.rotateX(Math.PI / 2); g.translate(0, 0, z); return new THREE.Mesh(g); };
  const disc = (ri, ro, z, up) => { const g = new THREE.RingGeometry(ri, ro, 48); if (!up) g.rotateX(Math.PI); g.translate(0, 0, z); return new THREE.Mesh(g); };
  const board = box(30, 30, 1, 0, 0, 0.5);
  const standoff = merged([tube(2, 6, 4), tube(0.8, 6, 4, true), disc(0.8, 2, 7, true), disc(0.8, 2, 1, false)]);
  const lid = merged([box(13.8, 30, 1.5, -8.1, 0, 7.75), box(13.8, 30, 1.5, 8.1, 0, 7.75), box(2.4, 13.8, 1.5, 0, -8.1, 7.75), box(2.4, 13.8, 1.5, 0, 8.1, 7.75)]);
  const screw = merged([tube(1, 7.5, 4.75), disc(0, 1, 1, false), tube(2.1, 1, 9), disc(1, 2.1, 8.5, false), disc(0, 2.1, 9.5, true)]);
  explodeOffsets([lid, board, standoff, screw], new THREE.Vector3(12, 0, 6));
  assert.deepEqual(dir(screw), [0, 0, 1]);
  assert.equal(screw.userData.parent, lid);   // rides the lid its head bears on, not the standoff (which leaves the other way)
  assert.equal(Math.abs(dir(standoff)[2]), 1);   // along the stack, not sideways
});

/** One mesh from several, remembering each input as a B-rep face. */
function merged(meshes) {
  const pos = [], faces = []; let first = 0;
  for (const m of meshes) {
    const a = m.geometry.toNonIndexed().getAttribute('position').array;
    pos.push(...a); faces.push({ first, count: a.length / 9 }); first += a.length / 9;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  const mesh = new THREE.Mesh(g); mesh.userData.faces = faces;
  return mesh;
}

// ---- joints as hints, and the order of removal

const hint = (type, axis, parent = null) => ({ type, axis: new THREE.Vector3(...axis), parent });

test('a slider joint explodes along its own axis, and rides on its parent', () => {
  const plate = box(40, 40, 4, 0, 0, 0);
  const slide = box(6, 6, 6, -30, 0, 0);   // radially it would leave along -x
  explodeOffsets([plate, slide], new THREE.Vector3(), new Map([[slide, hint('slider', [0, 0, 1], plate)]]));
  const d = dir(slide);
  assert.equal(d[0] + 0, 0); assert.equal(d[1] + 0, 0); assert.equal(Math.abs(d[2]), 1);
  assert.equal(slide.userData.parent, plate);
});

test('a screw leaves by the end of its axis with more room', () => {
  const lid = box(40, 40, 2, 0, 0, 0);
  const screw = box(4, 4, 10, 0, 0, 7);   // a head side that is clear, above a lid it threads into
  explodeOffsets([lid, screw], new THREE.Vector3(), new Map([[screw, hint('screw', [0, 0, 1], lid)]]));
  assert.deepEqual(dir(screw), [0, 0, 1]);
  explodeOffsets([lid, screw], new THREE.Vector3(), new Map([[screw, hint('screw', [0, 0, -1], lid)]]));   // the axis the other way round: same end
  assert.deepEqual(dir(screw), [0, 0, 1]);
});

test('a fixed joint has no travel of its own: the part goes where its parent goes', () => {
  const orb = box(20, 20, 20, 30, 0, 0);
  const dot = box(2, 2, 2, 30, 10, 0);
  const far = box(10, 10, 10, -30, 0, 0);
  explodeOffsets([orb, dot, far], new THREE.Vector3(), new Map([[dot, { type: 'fixed', axis: new THREE.Vector3(0, 0, 1), parent: orb }]]));
  assert.equal(dot.userData.parent, orb);
  assert.equal(dot.userData.offset.length(), 0);
});

test('a joint parent loop is cut: no part ends up riding itself', () => {
  const a = box(10, 10, 10, 20, 0, 0), b = box(10, 10, 10, -20, 0, 0);
  explodeOffsets([a, b], new THREE.Vector3(), new Map([[a, hint('revolute', [0, 0, 1], b)], [b, hint('revolute', [0, 0, 1], a)]]));
  assert.ok(!(a.userData.parent === b && b.userData.parent === a));
});

test('a part waits for what stands in its way: the stages put it after the part that moves off first', () => {
  // three blocks in a row with gaps; the middle one is forced along +x (a slider), into the right one, which leaves that way itself
  const a = box(10, 10, 10, 0, 0, 0), b = box(10, 10, 10, 14, 0, 0), c = box(10, 10, 10, 28, 0, 0);
  explodeOffsets([a, b, c], new THREE.Vector3(14, 0, 0), new Map([[b, hint('slider', [1, 0, 0])]]));
  assert.equal(c.userData.stage, 0);
  assert.equal(a.userData.stage, 0);
  assert.equal(b.userData.stage, 1);
});

test('parts with a clear way out all come off together (one stage)', () => {
  const a = box(10, 10, 10, -30, 0, 0), b = box(10, 10, 10, 30, 0, 0);
  explodeOffsets([a, b], new THREE.Vector3());
  assert.deepEqual([a.userData.stage, b.userData.stage], [0, 0]);
});

test('a ball joint leaves by the open side of its socket', () => {
  // a cup open to +z: a floor and four walls; a ball (a box here) sits in it
  const cup = merged([box(24, 24, 2, 0, 0, -7), box(2, 24, 14, -11, 0, 0), box(2, 24, 14, 11, 0, 0), box(20, 2, 14, 0, -11, 0), box(20, 2, 14, 0, 11, 0)]);
  const ball = box(8, 8, 8, 0, 0, 0);
  explodeOffsets([cup, ball], new THREE.Vector3(0, 0, -20), new Map([[ball, { type: 'ball', axis: new THREE.Vector3(0, 0, 1), origin: new THREE.Vector3(0, 0, 0), parent: null }]]));
  const d = ball.userData.offset.clone().normalize();
  assert.ok(d.z > 0.95, `out of the open top, got ${d.toArray()}`);
});
