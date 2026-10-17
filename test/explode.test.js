/** Explode directions: a pocketed magnet, a lid on a box, a slide in a channel, a loose part. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { explodeOffsets } from '../web/explode.js';

const box = (w, h, d, x, y, z) => { const g = new THREE.BoxGeometry(w, h, d); g.translate(x, y, z); return new THREE.Mesh(g); };
const dir = (m) => m.userData.offset.clone().normalize().toArray().map((v) => Math.round(v * 100) / 100);

test('magnet in a pocket leaves by the open axis, riding on the block; a loose part goes radially', () => {
  // 20×20×10 block on +X with a 6×6×4 pocket open to +Z, a 4×4×3 magnet floating in it, a loose block far on -X.
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
  const lid = box(20, 20, 2, 0, 0, 6);          // sits on the top face (z = 5)
  explodeOffsets([body, lid], new THREE.Vector3(8, 8, -3));   // an off-centre assembly centre: radial would be diagonal
  assert.deepEqual(dir(lid), [0, 0, 1]);
  assert.equal(lid.userData.parent, null);
  assert.equal(body.userData.parent, null);
});

test('a slide between two walls moves along the channel and rides on the rail', () => {
  const rail = merged([box(2, 20, 4, -3, 0, 0), box(2, 20, 4, 3, 0, 0), box(8, 20, 1, 0, 0, -2.5)]);   // channel along Y, open to +Z
  const slide = box(3.9, 6, 4, 0, 0, 0);
  explodeOffsets([rail, slide], new THREE.Vector3());
  assert.deepEqual(dir(slide), [0, 1, 0]);
  assert.equal(slide.userData.parent, rail);
});

function merged(meshes) {
  const pos = [];
  for (const m of meshes) pos.push(...m.geometry.toNonIndexed().getAttribute('position').array);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return new THREE.Mesh(g);
}
