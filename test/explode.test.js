/** A magnet in a pocket explodes along the pocket's open axis and rides on the pocketed body. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { explodeOffsets } from '../web/explode.js';

const box = (w, h, d, x, y, z) => { const g = new THREE.BoxGeometry(w, h, d); g.translate(x, y, z); return new THREE.Mesh(g); };

test('pocketed part leaves along +Z, carried by its pocket; a free part goes radially', () => {
  // A 20×20×10 block on the +X side with a 6×6×4 pocket open to +Z, a 4×4×3 magnet in it, a loose block far on -X.
  const walls = [box(7, 20, 10, 23.5, 0, 0), box(7, 20, 10, 36.5, 0, 0), box(6, 7, 10, 30, 6.5, 0), box(6, 7, 10, 30, -6.5, 0), box(6, 6, 6, 30, 0, -2)];
  const block = new THREE.Mesh(mergeBoxes(walls));
  const magnet = box(4, 4, 3, 30, 0, 3);
  const loose = box(10, 10, 10, -30, 0, 0);
  const bodies = [block, magnet, loose];
  explodeOffsets(bodies, new THREE.Vector3(0, 0, 0));
  assert.equal(magnet.userData.parent, block);
  assert.deepEqual(magnet.userData.offset.clone().normalize().toArray().map(Math.round), [0, 0, 1]);
  assert.equal(loose.userData.parent, null);
  assert.deepEqual(loose.userData.offset.clone().normalize().toArray().map(Math.round), [-1, 0, 0]);
  assert.equal(block.userData.parent, null);
});

function mergeBoxes(meshes) {
  const pos = [], idx = []; let base = 0;
  for (const m of meshes) {
    const g = m.geometry.toNonIndexed();
    pos.push(...g.getAttribute('position').array);
    const n = g.getAttribute('position').count;
    for (let i = 0; i < n; i++) idx.push(base + i);
    base += n;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}
