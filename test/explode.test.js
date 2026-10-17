/** Explode vectors: a pin in a bore, a pocketed magnet, a lid on a box, a slide in a channel, a loose part, a path through another body. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { explodeOffsets } from '../web/explode.js';

const box = (w, h, d, x, y, z) => { const g = new THREE.BoxGeometry(w, h, d); g.translate(x, y, z); return new THREE.Mesh(g); };
const dir = (m) => m.userData.offset.clone().normalize().toArray().map((v) => Math.round(v * 100) / 100);

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
  assert.equal(lid.userData.parent, null);
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

test('a radial path through another body is replaced by a clear one', () => {
  // a U-shaped frame whose far wall crosses the cube's radial; the frame moves out less than the cube would
  const frame = merged([box(4, 80, 40, 0, 0, 0), box(4, 80, 40, 22, 0, 0)]);
  const cube = box(2, 2, 2, 15, 0, 0);
  explodeOffsets([frame, cube], new THREE.Vector3());
  assert.deepEqual(dir(cube), [0, 1, 0]);
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
