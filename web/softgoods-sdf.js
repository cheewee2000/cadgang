// A triangle mesh as something cloth collides with (web/softgoods-worker.js, body shape {type: 'mesh'}): its signed
// distance, sampled once on a regular grid and read back by trilinear interpolation, so a query costs eight reads whatever
// the triangle count: about 60 ns. A BVH nearest-triangle query (src/core/mesh.js buildMeshDistance) on the same 20,000
// triangles took 1,300 ns, and the solver asks twelve times a step for every cloth vertex: 5,000 vertices would spend 80 ms
// a step in the BVH against 4 in the grid. The grid takes 0.3 s to build, once per body.
//
// Built in four passes. (1) The exact distance to the nearest triangle at every node within `band` of the surface.
// (2) Every grid edge a triangle crosses is marked cut. (3) Outside is what a flood from a corner of the grid reaches
// without crossing a cut edge, so the sign needs no consistent winding, and a closed hollow part (an enclosure with a 2 mm
// wall) is solid: cloth is kept out of its cavity however thin the wall. (4) Deep inside, the depth grows from the band.
//
// The limits: a free-standing sheet or fin thinner than a cell has no node inside it and the cloth does not see it, and one
// thinner than two cells is seen roughly (the cell is the cube root of the padded box over `budget` nodes: 1.5 mm on a part
// 100 mm across, 3 mm on one 300 mm across; `field.cell` says),
// corners are rounded by about a fifth of a cell, and a mesh that encloses nothing (an open surface) is not a body at all:
// `field.inside` is then 0.

/** The squared distance from p to triangle a, b, c (Ericson, Real-Time Collision Detection 5.1.5). */
function triangleDistance2(px, py, pz, ax, ay, az, bx, by, bz, cx, cy, cz) {
  const abx = bx - ax, aby = by - ay, abz = bz - az, acx = cx - ax, acy = cy - ay, acz = cz - az, apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  let qx, qy, qz;
  if (d1 <= 0 && d2 <= 0) { qx = ax; qy = ay; qz = az; } else {
    const bpx = px - bx, bpy = py - by, bpz = pz - bz, d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
    if (d3 >= 0 && d4 <= d3) { qx = bx; qy = by; qz = bz; } else {
      const vc = d1 * d4 - d3 * d2;
      if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); qx = ax + abx * v; qy = ay + aby * v; qz = az + abz * v; } else {
        const cpx = px - cx, cpy = py - cy, cpz = pz - cz, d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
        if (d6 >= 0 && d5 <= d6) { qx = cx; qy = cy; qz = cz; } else {
          const vb = d5 * d2 - d1 * d6;
          if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); qx = ax + acx * w; qy = ay + acy * w; qz = az + acz * w; } else {
            const va = d3 * d6 - d5 * d4;
            if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const w = (d4 - d3) / (d4 - d3 + d5 - d6); qx = bx + (cx - bx) * w; qy = by + (cy - by) * w; qz = bz + (cz - bz) * w; } else {
              const den = 1 / (va + vb + vc), v = vb * den, w = vc * den; qx = ax + abx * v + acx * w; qy = ay + aby * v + acy * w; qz = az + abz * v + acz * w;
            }
          }
        }
      }
    }
  }
  return (px - qx) ** 2 + (py - qy) ** 2 + (pz - qz) ** 2;
}

/**
 * The field of a mesh: positions [x, y, z, ...] in mm and indices, three to a triangle. reach is the furthest from the
 * surface a contact is ever asked about (the cloth's half thickness and the body's clearance), budget the node count.
 * Returns { at(x, y, z, normal): the signed distance (positive outside, at most `far`), writing the way out into normal;
 * cell, far, inside (nodes inside the body), nodes, min, max }.
 */
export function meshField(positions, indices, { reach = 4, budget = 1000000 } = {}) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i++) { const v = positions[i], k = i % 3; if (v < lo[k]) lo[k] = v; if (v > hi[k]) hi[k] = v; }
  if (!(indices.length >= 3) || !lo.every(Number.isFinite) || !hi.every(Number.isFinite)) throw new Error('A mesh body needs finite positions and at least one triangle');
  let h = 1; for (let it = 0; it < 4; it++) h = Math.max(0.2, Math.cbrt([0, 1, 2].reduce((v, k) => v * (hi[k] - lo[k] + 2 * (3 * h + reach)), 1) / budget));
  const band = reach + 2 * h, pad = band + h, o = lo.map((v) => v - pad), n = [0, 1, 2].map((k) => Math.ceil((hi[k] - lo[k] + 2 * pad) / h) + 1), [nx, ny] = n, stride = [1, nx, nx * ny], N = nx * ny * n[2];
  const phi = new Float32Array(N).fill(Infinity), nearest = new Int32Array(N).fill(-1), cut = new Uint8Array(N), band2 = band * band, P = positions, e = [o[0] + 3.7e-5 * h, o[1] + 7.1e-5 * h, o[2] + 5.3e-5 * h];
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3, A = [P[a], P[a + 1], P[a + 2]], B = [P[b], P[b + 1], P[b + 2]], C = [P[c], P[c + 1], P[c + 2]];
    const nrm = [(B[1] - A[1]) * (C[2] - A[2]) - (B[2] - A[2]) * (C[1] - A[1]), (B[2] - A[2]) * (C[0] - A[0]) - (B[0] - A[0]) * (C[2] - A[2]), (B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0])], nl = Math.hypot(...nrm);
    if (!(nl > 1e-12)) continue;
    const from = [0, 1, 2].map((k) => Math.max(0, Math.ceil((Math.min(A[k], B[k], C[k]) - band - o[k]) / h))), to = [0, 1, 2].map((k) => Math.min(n[k] - 1, Math.floor((Math.max(A[k], B[k], C[k]) + band - o[k]) / h)));
    // (1) Along the axis the triangle faces most, only the nodes within the band of its plane.
    const u = Math.abs(nrm[0]) >= Math.abs(nrm[1]) && Math.abs(nrm[0]) >= Math.abs(nrm[2]) ? 0 : Math.abs(nrm[1]) >= Math.abs(nrm[2]) ? 1 : 2, v = (u + 1) % 3, w = (u + 2) % 3, half = band * nl / Math.abs(nrm[u]), q = [0, 0, 0];
    for (let j = from[v]; j <= to[v]; j++) for (let k = from[w]; k <= to[w]; k++) {
      q[v] = o[v] + j * h; q[w] = o[w] + k * h;
      const on = A[u] - (nrm[v] * (q[v] - A[v]) + nrm[w] * (q[w] - A[w])) / nrm[u], i0 = Math.max(from[u], Math.ceil((on - half - o[u]) / h)), i1 = Math.min(to[u], Math.floor((on + half - o[u]) / h));
      for (let i = i0; i <= i1; i++) { q[u] = o[u] + i * h; const d = triangleDistance2(q[0], q[1], q[2], A[0], A[1], A[2], B[0], B[1], B[2], C[0], C[1], C[2]), at = i * stride[u] + j * stride[v] + k * stride[w]; if (d < band2 && d < phi[at] * phi[at]) { phi[at] = Math.sqrt(d); nearest[at] = t; } }
    }
    // (2) The grid lines along each axis that pass through the triangle: the grid edge each one crosses in is cut. The lines are those of the
    // grid moved a hair (`e`, the same on every axis, so the cut edges still close round the body): none then runs along a mesh edge of a square part.
    for (let axis = 0; axis < 3; axis++) {
      const s = (axis + 1) % 3, r = (axis + 2) % 3, den = (B[s] - A[s]) * (C[r] - A[r]) - (B[r] - A[r]) * (C[s] - A[s]); if (Math.abs(den) < 1e-12) continue;
      for (let j = Math.max(0, Math.ceil((Math.min(A[s], B[s], C[s]) - e[s]) / h - 1)); j < n[s] && e[s] + j * h <= Math.max(A[s], B[s], C[s]); j++) for (let k = Math.max(0, Math.ceil((Math.min(A[r], B[r], C[r]) - e[r]) / h - 1)); k < n[r] && e[r] + k * h <= Math.max(A[r], B[r], C[r]); k++) {
        const ps = e[s] + j * h - A[s], pr = e[r] + k * h - A[r], wb = (ps * (C[r] - A[r]) - pr * (C[s] - A[s])) / den, wc = ((B[s] - A[s]) * pr - (B[r] - A[r]) * ps) / den;
        if (wb < 0 || wc < 0 || wb + wc > 1) continue;
        const i = Math.floor((A[axis] + wb * (B[axis] - A[axis]) + wc * (C[axis] - A[axis]) - e[axis]) / h); if (i >= 0 && i < n[axis] - 1) cut[i * stride[axis] + j * stride[s] + k * stride[r]] |= 1 << axis;
      }
    }
  }
  // (3) Flood the outside from a corner of the grid, which the padding keeps clear of the mesh.
  const outside = new Uint8Array(N), stack = new Int32Array(N); let top = 0, inside = N; stack[top++] = 0; outside[0] = 1;
  while (top) {
    const at = stack[--top], i = at % nx, j = ((at - i) / nx) % ny, k = (at - i - j * nx) / stride[2], ijk = [i, j, k]; inside--;
    for (let axis = 0; axis < 3; axis++) {
      if (ijk[axis] < n[axis] - 1 && !(cut[at] & (1 << axis)) && !outside[at + stride[axis]]) { outside[at + stride[axis]] = 1; stack[top++] = at + stride[axis]; }
      if (ijk[axis] > 0 && !(cut[at - stride[axis]] & (1 << axis)) && !outside[at - stride[axis]]) { outside[at - stride[axis]] = 1; stack[top++] = at - stride[axis]; }
    }
  }
  // (4) Outside and beyond the band is simply far. Inside, the depth is below the body's skin: the triangles an outside node is nearest to. So the
  // inner wall of a hollow part does not count, and a vertex that gets into a thin wall is sent back out, not on into the cavity. An inside node
  // nearest to some other triangle starts from the outside node across a cut edge from it (a cell less that node's distance), and the depth grows
  // from there, node to neighbour, down the grid and back up until every node has one.
  const skin = new Uint8Array(indices.length); for (let at = 0; at < N; at++) if (outside[at] && nearest[at] >= 0) skin[nearest[at]] = 1;
  for (let at = 0; at < N; at++) {
    if (outside[at]) { phi[at] = Math.min(phi[at], band); continue; }
    let depth = nearest[at] >= 0 && skin[nearest[at]] ? -phi[at] : -Infinity;
    if (depth === -Infinity) { const i = at % nx, j = ((at - i) / nx) % ny, k = (at - i - j * nx) / stride[2], ijk = [i, j, k]; for (let axis = 0; axis < 3; axis++) for (const step of [-1, 1]) { const to = at + step * stride[axis]; if (ijk[axis] + step >= 0 && ijk[axis] + step < n[axis] && outside[to]) depth = Math.max(depth, -Math.max(0.05 * h, h - Math.min(phi[to], band))); } }
    phi[at] = depth;
  }
  for (let round = 0, left = inside; left && round < 8; round++) for (const dir of [1, -1]) { left = 0; for (let s = 0; s < N; s++) {
    const at = dir > 0 ? s : N - 1 - s; if (outside[at]) continue;
    const i = at % nx, j = ((at - i) / nx) % ny, k = (at - i - j * nx) / stride[2]; let best = phi[at];
    for (let dk = -1; dk <= 1; dk++) for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      if ((!di && !dj && !dk) || i + di < 0 || i + di >= nx || j + dj < 0 || j + dj >= ny || k + dk < 0 || k + dk >= n[2]) continue;
      const near = at + di + dj * nx + dk * stride[2]; if (outside[near]) continue;
      const d = phi[near] - h * Math.sqrt(di * di + dj * dj + dk * dk); if (d > best) best = d;
    }
    phi[at] = best; if (best === -Infinity) left++;
  } }
  for (let at = 0; at < N; at++) if (phi[at] === -Infinity) phi[at] = -band;
  const sx = nx, sxy = stride[2], mx = nx - 2, my = ny - 2, mz = n[2] - 2, top3 = o.map((v, k) => v + (n[k] - 1) * h);
  function at(x, y, z, normal) {
    if (x <= o[0] || y <= o[1] || z <= o[2] || x >= top3[0] || y >= top3[1] || z >= top3[2]) return band;
    const fx = (x - o[0]) / h, fy = (y - o[1]) / h, fz = (z - o[2]) / h, i = Math.min(mx, fx | 0), j = Math.min(my, fy | 0), k = Math.min(mz, fz | 0), tx = fx - i, ty = fy - j, tz = fz - k, p = i + j * sx + k * sxy;
    const c000 = phi[p], c100 = phi[p + 1], c010 = phi[p + sx], c110 = phi[p + sx + 1], c001 = phi[p + sxy], c101 = phi[p + sxy + 1], c011 = phi[p + sxy + sx], c111 = phi[p + sxy + sx + 1];
    const ux = 1 - tx, uy = 1 - ty, uz = 1 - tz, d = uz * (uy * (ux * c000 + tx * c100) + ty * (ux * c010 + tx * c110)) + tz * (uy * (ux * c001 + tx * c101) + ty * (ux * c011 + tx * c111));
    if (normal && d < band) {
      const gx = uz * (uy * (c100 - c000) + ty * (c110 - c010)) + tz * (uy * (c101 - c001) + ty * (c111 - c011)), gy = uz * (ux * (c010 - c000) + tx * (c110 - c100)) + tz * (ux * (c011 - c001) + tx * (c111 - c101)), gz = uy * (ux * (c001 - c000) + tx * (c101 - c100)) + ty * (ux * (c011 - c010) + tx * (c111 - c110)), gl = Math.hypot(gx, gy, gz) || 1;
      normal[0] = gx / gl; normal[1] = gy / gl; normal[2] = gz / gl;
    }
    return d;
  }
  return { at, cell: h, far: band, inside, nodes: N, min: lo, max: hi };
}
