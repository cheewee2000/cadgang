// The outline of a mesh (web/edges.js) is the one THREE.EdgesGeometry draws: the same segments, found faster.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { creaseEdges } from '../web/edges.js';

const segs = (a) => { const s = []; for (let i = 0; i < a.length; i += 6) { const p = [...a.slice(i, i + 3)].map((x) => x.toFixed(3)).join(','), q = [...a.slice(i + 3, i + 6)].map((x) => x.toFixed(3)).join(','); s.push(p < q ? `${p} ${q}` : `${q} ${p}`); } return s.sort(); };
const same = (geo, label) => {
  const mine = creaseEdges(geo.getAttribute('position').array, geo.index?.array ?? null, 25), theirs = new THREE.EdgesGeometry(geo, 25).getAttribute('position').array;
  assert.deepEqual(segs(mine), segs(theirs), label);
  return mine.length / 6;
};

test('the outline is the one three draws, on closed, open, indexed and soup meshes', () => {
  assert.equal(same(new THREE.BoxGeometry(2, 3, 4), 'a box'), 12);
  assert.equal(same(new THREE.BoxGeometry(2, 3, 4).toNonIndexed(), 'a box as loose triangles (an STL)'), 12);
  same(new THREE.CylinderGeometry(5, 5, 10, 48), 'a cylinder: rims, and no lines down the smooth wall');
  same(new THREE.CylinderGeometry(5, 5, 10, 8), 'an octagonal prism: every wall edge is a crease');
  same(new THREE.TorusKnotGeometry(10, 3, 120, 16), 'a knot');
  assert.equal(same(new THREE.PlaneGeometry(4, 4, 3, 3), 'an open sheet: its rim'), 12);
  const g = new THREE.BufferGeometry();   // a sliver with no area, a doubled triangle, and three triangles on one edge
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 0, 0, 0, 0, -1, 2, 0, 0]), 3));
  g.setIndex([0, 1, 2, 0, 3, 1, 0, 1, 5, 0, 1, 2, 0, 1, 1, 1, 6, 6, 0, 2, 3]);
  same(g, 'a mesh that is not a manifold');
});
