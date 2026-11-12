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

test('welding groups vertices exactly as a string-keyed map of the rounded coordinates would', () => {
  // Points on a coarse lattice (many duplicates, negatives, zero from both sides), normals from a few directions.
  let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32;
  const n = 5000, positions = new Float32Array(n * 3), normals = new Float32Array(n * 3);
  for (let i = 0; i < n * 3; i++) { positions[i] = Math.round(rnd() * 12 - 6) * 0.5 + (rnd() - 0.5) * 2e-5; normals[i] = Math.round(rnd() * 2 - 1); }
  const indices = Uint32Array.from({ length: n }, (_, i) => i);
  for (const nr of [null, normals]) {
    const seen = new Map(), want = [];
    for (let v = 0; v < n; v++) {
      const r = (a, s, k) => Math.round(a[v * 3 + k] * s) + 0;   // + 0: minus zero is zero
      const key = [0, 1, 2].map((k) => r(positions, 1e4, k)).concat(nr ? [0, 1, 2].map((k) => r(nr, 64, k)) : []).join();
      if (!seen.has(key)) seen.set(key, seen.size);
      want.push(seen.get(key));
    }
    const w = weldVertices(positions, indices, 1e-4, nr);
    assert.deepEqual([...w.indices], want);
    assert.equal(w.positions.length / 3, seen.size);
    assert.ok(seen.size < n, 'the lattice has duplicates to weld');
  }
});
