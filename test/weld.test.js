import { test } from 'node:test';
import assert from 'node:assert/strict';
import { weldVertices } from '../src/core/mesh.js';

test('welding keeps one vertex per surface at a crease and returns the normals (v0.11.1 shading fix)', () => {
  // Two triangles sharing the edge (0,0,0)-(1,0,0): a floor (normal +z) and a wall (normal +y).
  const positions = Float32Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0, /* wall */ 0, 0, 0, 1, 0, 0, 0, 0, 1);
  const normals = Float32Array.of(0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1, 0, 0, 1, 0);
  const indices = Uint32Array.of(0, 1, 2, 3, 4, 5);
  const plain = weldVertices(positions, indices, 1e-4);
  assert.equal(plain.positions.length / 3, 4, 'without normals the shared edge welds');
  const w = weldVertices(positions, indices, 1e-4, normals);
  assert.equal(w.positions.length / 3, 6, 'with normals the crease keeps its own vertices');
  assert.equal(w.normals.length, w.positions.length);
  assert.deepEqual([...w.normals.slice(9, 12)], [0, 1, 0]);
});
