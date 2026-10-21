/** The wireframe's silhouette: a curved surface's outline where it turns away from the eye. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { silhouetteEdges, silhouetteFor } from '../web/silhouette.js';

test('a cylinder seen from the side shows its two side lines, and they follow the eye', () => {
  const geo = new THREE.CylinderGeometry(5, 5, 20, 48, 1, true);   // axis along y, open ends: only the side
  const edges = silhouetteEdges(geo);
  const out = new Float32Array(edges.pos.length);
  const sides = (eye, dir = null) => {
    const n = silhouetteFor(edges, eye, dir, out);
    const xs = [];
    for (let i = 0; i < n; i += 6) xs.push(Math.round(out[i] * 10) / 10 + 0, Math.round(out[i + 2] * 10) / 10 + 0);
    return { segs: n / 6, xs };
  };
  // from far along +z the outline is at x = ±5 (the vertical lines left and right)
  const front = sides(new THREE.Vector3(0, 0, 1000));
  assert.equal(front.segs, 2);
  for (let i = 0; i < front.xs.length; i += 2) assert.ok(Math.abs(Math.abs(front.xs[i]) - 5) < 0.1 && Math.abs(front.xs[i + 1]) < 0.4, `${front.xs}`);
  // from +x it moves to z = ±5; an orthographic look along -z gives the front view's again
  const side = sides(new THREE.Vector3(1000, 0, 0));
  assert.equal(side.segs, 2);
  for (let i = 0; i < side.xs.length; i += 2) assert.ok(Math.abs(side.xs[i]) < 0.4 && Math.abs(Math.abs(side.xs[i + 1]) - 5) < 0.1, `${side.xs}`);
  assert.equal(sides(null, new THREE.Vector3(0, 0, -1)).segs, 2);
});

test("what is already drawn is no candidate: a mesh's creases, a B-rep's face borders", () => {
  const box = new THREE.BoxGeometry(1, 1, 1);   // 6 sides × 2 triangles: its corners are creases on a mesh, face borders on a B-rep
  assert.equal(silhouetteEdges(box, { creases: true }), null);
  assert.equal(silhouetteEdges(box, { faces: Array.from({ length: 6 }, (_, i) => ({ first: 2 * i, count: 2 })) }), null);
  const coarse = new THREE.CylinderGeometry(5, 5, 20, 6, 1, true);   // 60° per facet: every bend a crease
  assert.equal(silhouetteEdges(coarse, { creases: true }), null);
  assert.ok(silhouetteEdges(coarse), 'a B-rep body keeps them: its overlay is face borders only');
});
