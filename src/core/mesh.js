/** Mesh helpers the STEP importer needs: weld coincident vertices, measure bounds. */

/**
 * Merge vertices closer than `tol` (grid quantization). Triangle order is
 * preserved, so external triangle-range references (B-rep faces) stay valid.
 */
export function weldVertices(positions, indices, tol = 1e-4) {
  const inv = 1 / tol;
  const map = new Map();
  const remap = new Uint32Array(positions.length / 3);
  const outPos = [];
  let next = 0;
  for (let v = 0; v < positions.length / 3; v++) {
    const x = positions[v * 3], y = positions[v * 3 + 1], z = positions[v * 3 + 2];
    const key = `${Math.round(x * inv)},${Math.round(y * inv)},${Math.round(z * inv)}`;
    let idx = map.get(key);
    if (idx === undefined) {
      idx = next++;
      map.set(key, idx);
      outPos.push(x, y, z);
    }
    remap[v] = idx;
  }
  const outIdx = new Uint32Array(indices.length);
  for (let i = 0; i < indices.length; i++) outIdx[i] = remap[indices[i]];
  return { positions: Float32Array.from(outPos), indices: outIdx };
}

/** Axis-aligned bounds of a position array: {min:[..], max:[..]} (null if empty). */
export function positionsBBox(positions) {
  if (!positions.length) return null;
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let j = 0; j < 3; j++) {
      const v = positions[i + j];
      if (v < min[j]) min[j] = v;
      if (v > max[j]) max[j] = v;
    }
  }
  return { min, max };
}
