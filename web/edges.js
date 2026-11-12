/**
 * The outline of a mesh that came with none (STL, OBJ, 3MF, glTF…): every edge where the two triangles
 * beside it turn by more than `deg`, and every edge with a triangle on one side only.
 *
 * The same edges as THREE.EdgesGeometry, which this replaces (test/edges.test.js holds them equal). That one
 * keys every corner and every edge by a string and was nine tenths of the time an STL took to open: 1.4 s of
 * 1.5 s on 840,000 triangles. Here the corners and the edges are in typed hash tables.
 *
 * position: xyz per vertex. index: three per triangle, or null for a triangle soup.
 * Returns xyz pairs, one line segment each (a Float32Array).
 */
export function creaseEdges(position, index, deg = 25) {
  const nIdx = index ? index.length : position.length / 3, nTri = Math.floor(nIdx / 3), nVert = position.length / 3;
  const pow2 = (n) => { let c = 16; while (c < n) c *= 2; return c; };

  // corners that are the same point (to 1e-4, as EdgesGeometry rounds) share a number
  const id = new Uint32Array(nVert), first = new Uint32Array(nVert);
  {
    const cap = pow2(nVert * 2), mask = cap - 1, table = new Int32Array(cap).fill(-1);
    let next = 0;
    for (let v = 0; v < nVert; v++) {
      const x = Math.round(position[v * 3] * 1e4), y = Math.round(position[v * 3 + 1] * 1e4), z = Math.round(position[v * 3 + 2] * 1e4);
      let h = Math.imul(x | 0, 73856093) ^ Math.imul(y | 0, 19349663) ^ Math.imul(z | 0, 83492791);
      h ^= h >>> 16; h = Math.imul(h, 0x45d9f3b); h ^= h >>> 16;
      let k;
      for (let s = h & mask; ; s = (s + 1) & mask) {
        k = table[s];
        if (k < 0) { k = table[s] = next++; first[k] = v; break; }
        const u = first[k] * 3;
        if (Math.round(position[u] * 1e4) === x && Math.round(position[u + 1] * 1e4) === y && Math.round(position[u + 2] * 1e4) === z) break;
      }
      id[v] = k;
    }
  }

  // an edge, by the numbers of its two ends in the order its triangle goes round: who left it, and from where to where
  const cap = pow2(nTri * 6), mask = cap - 1;
  const from = new Int32Array(cap).fill(-1), to = new Int32Array(cap), tri = new Int32Array(cap), v0 = new Uint32Array(cap), v1 = new Uint32Array(cap);   // tri -1: met its other side
  const slot = (a, b) => {
    let h = Math.imul(a, 73856093) ^ Math.imul(b, 19349663);
    h ^= h >>> 16; h = Math.imul(h, 0x45d9f3b); h ^= h >>> 16;
    let s = h & mask;
    while (from[s] >= 0 && (from[s] !== a || to[s] !== b)) s = (s + 1) & mask;
    return s;
  };

  const normal = new Float32Array(nTri * 3), cos = Math.cos(deg * Math.PI / 180), out = [], c = [0, 0, 0];
  for (let t = 0; t < nTri; t++) {
    for (let j = 0; j < 3; j++) c[j] = index ? index[t * 3 + j] : t * 3 + j;
    const a = id[c[0]], b = id[c[1]], d = id[c[2]];
    if (a === b || b === d || d === a) continue;   // no area: no edges
    const A = c[0] * 3, B = c[1] * 3, C = c[2] * 3;
    const ux = position[C] - position[B], uy = position[C + 1] - position[B + 1], uz = position[C + 2] - position[B + 2];
    const wx = position[A] - position[B], wy = position[A + 1] - position[B + 1], wz = position[A + 2] - position[B + 2];
    let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    const len = Math.hypot(nx, ny, nz) || Infinity;   // a sliver with no normal: 0, as three leaves it
    normal[t * 3] = nx /= len; normal[t * 3 + 1] = ny /= len; normal[t * 3 + 2] = nz /= len;
    for (let j = 0; j < 3; j++) {
      const p = id[c[j]], q = id[c[(j + 1) % 3]], back = slot(q, p);
      if (from[back] >= 0 && tri[back] >= 0) {   // the triangle on the other side went the other way along it
        const o = tri[back] * 3;
        if (nx * normal[o] + ny * normal[o + 1] + nz * normal[o + 2] <= cos) out.push(c[j], c[(j + 1) % 3]);
        tri[back] = -1;
      } else {
        const s = slot(p, q);
        if (from[s] < 0) { from[s] = p; to[s] = q; tri[s] = t; v0[s] = c[j]; v1[s] = c[(j + 1) % 3]; }
      }
    }
  }
  for (let s = 0; s < cap; s++) if (from[s] >= 0 && tri[s] >= 0) out.push(v0[s], v1[s]);   // one side only: the rim of an open mesh

  const lines = new Float32Array(out.length * 3);
  for (let i = 0; i < out.length; i++) { const v = out[i] * 3; lines[i * 3] = position[v]; lines[i * 3 + 1] = position[v + 1]; lines[i * 3 + 2] = position[v + 2]; }
  return lines;
}
