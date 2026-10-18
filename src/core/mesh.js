/**
 * Triangle-mesh distance queries for imported geometry (STEP etc).
 *
 * buildMeshDistance() compiles a triangle soup (optionally a sub-range of
 * triangles = one B-rep face patch) into a signed distance closure using a
 * flat BVH for the nearest-triangle search and angle-weighted pseudonormals
 * for the sign (Bærentzen & Aanæs). For a closed, consistently wound mesh the
 * result is a true SDF; for an open patch the sign is the side of the surface
 * along its orientation.
 */

// ---------------------------------------------------------------- welding

/**
 * Merge vertices closer than `tol` (grid quantization). Triangle order is
 * preserved, so external triangle-range references (B-rep faces) stay valid.
 * Degenerate triangles produced by welding are kept (they never win a
 * closest-point query against non-degenerate neighbors at these tolerances).
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

// ---------------------------------------------------------------- BVH

const LEAF_SIZE = 4;

function buildBVH(positions, tris, triStart, triCount) {
  // Centroids + per-triangle bounds for the selected range.
  const cx = new Float64Array(triCount), cy = new Float64Array(triCount), cz = new Float64Array(triCount);
  const tmin = new Float64Array(triCount * 3), tmax = new Float64Array(triCount * 3);
  const order = new Uint32Array(triCount);
  for (let t = 0; t < triCount; t++) {
    order[t] = triStart + t;
    let mnx = Infinity, mny = Infinity, mnz = Infinity, mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
    for (let k = 0; k < 3; k++) {
      const vi = tris[(triStart + t) * 3 + k] * 3;
      const x = positions[vi], y = positions[vi + 1], z = positions[vi + 2];
      if (x < mnx) mnx = x; if (x > mxx) mxx = x;
      if (y < mny) mny = y; if (y > mxy) mxy = y;
      if (z < mnz) mnz = z; if (z > mxz) mxz = z;
    }
    tmin[t * 3] = mnx; tmin[t * 3 + 1] = mny; tmin[t * 3 + 2] = mnz;
    tmax[t * 3] = mxx; tmax[t * 3 + 1] = mxy; tmax[t * 3 + 2] = mxz;
    cx[t] = (mnx + mxx) / 2; cy[t] = (mny + mxy) / 2; cz[t] = (mnz + mxz) / 2;
  }
  const cent = [cx, cy, cz];

  // Flat node storage, grown as we split.
  const nodes = []; // {min:[3], max:[3], left, right, start, count} — leaf when left<0

  function nodeBounds(start, count) {
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = start; i < start + count; i++) {
      const t = order[i] - triStart;
      for (let j = 0; j < 3; j++) {
        if (tmin[t * 3 + j] < min[j]) min[j] = tmin[t * 3 + j];
        if (tmax[t * 3 + j] > max[j]) max[j] = tmax[t * 3 + j];
      }
    }
    return { min, max };
  }

  function split(start, count) {
    const { min, max } = nodeBounds(start, count);
    const idx = nodes.length;
    nodes.push({ min, max, left: -1, right: -1, start, count });
    if (count <= LEAF_SIZE) return idx;
    let axis = 0;
    let ext = max[0] - min[0];
    for (let j = 1; j < 3; j++) if (max[j] - min[j] > ext) { ext = max[j] - min[j]; axis = j; }
    if (ext <= 0) return idx;
    const c = cent[axis];
    const sub = Array.from(order.subarray(start, start + count));
    sub.sort((a, b) => c[a - triStart] - c[b - triStart]);
    order.set(sub, start);
    const mid = start + (count >> 1);
    const node = nodes[idx];
    node.left = split(start, mid - start);
    node.right = split(mid, start + count - mid);
    node.count = 0;
    return idx;
  }

  split(0, triCount);
  return { nodes, order };
}

function aabbDistSq(min, max, x, y, z) {
  let d = 0;
  let v = x < min[0] ? min[0] - x : x > max[0] ? x - max[0] : 0; d += v * v;
  v = y < min[1] ? min[1] - y : y > max[1] ? y - max[1] : 0; d += v * v;
  v = z < min[2] ? min[2] - z : z > max[2] ? z - max[2] : 0; d += v * v;
  return d;
}

// ------------------------------------------------- closest point on triangle

// Region codes for the pseudonormal lookup.
const REG_FACE = 0, REG_A = 1, REG_B = 2, REG_C = 3, REG_AB = 4, REG_AC = 5, REG_BC = 6;

/**
 * Ericson's closestPtPointTriangle, returning [qx,qy,qz,region] via `out`.
 */
function closestOnTriangle(px, py, pz, ax, ay, az, bx, by, bz, cx, cy, cz, out) {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) { out[0] = ax; out[1] = ay; out[2] = az; out[3] = REG_A; return; }
  const bpx = px - bx, bpy = py - by, bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) { out[0] = bx; out[1] = by; out[2] = bz; out[3] = REG_B; return; }
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const t = d1 / (d1 - d3);
    out[0] = ax + t * abx; out[1] = ay + t * aby; out[2] = az + t * abz; out[3] = REG_AB; return;
  }
  const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) { out[0] = cx; out[1] = cy; out[2] = cz; out[3] = REG_C; return; }
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const t = d2 / (d2 - d6);
    out[0] = ax + t * acx; out[1] = ay + t * acy; out[2] = az + t * acz; out[3] = REG_AC; return;
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const t = (d4 - d3) / (d4 - d3 + (d5 - d6));
    out[0] = bx + t * (cx - bx); out[1] = by + t * (cy - by); out[2] = bz + t * (cz - bz); out[3] = REG_BC; return;
  }
  const denom = 1 / (va + vb + vc);
  const v = vb * denom, w = vc * denom;
  out[0] = ax + abx * v + acx * w;
  out[1] = ay + aby * v + acy * w;
  out[2] = az + abz * v + acz * w;
  out[3] = REG_FACE;
}

// ---------------------------------------------------------------- distance

/**
 * Compile one face patch into a true extrusion builder: the solid swept by
 * the patch along its average normal, bounded laterally by the patch's
 * boundary loop (no wrap-around past the face outline).
 *
 * Geometry per query point p (n̂ = average patch normal, o = signed offset of
 * p from the patch surface along n̂):
 *   cap = distance outside the [0, d] offset layer (ray-cast along n̂ picks
 *         the nearest surface layer; closest-point fallback off the footprint)
 *   lat = signed lateral distance to the boundary loop, projected ⊥ n̂
 *         (negative inside the footprint = the ray hit the patch)
 * combined with the standard box-corner rule.
 *
 * Returns { normal, bbox(d), compile(d) -> (x,y,z)=>sd }.
 */
/**
 * Compile a triangle soup into a first-hit ray caster over the same BVH.
 *
 * Wall-thickness and clearance checks are ray questions, not nearest-surface
 * questions: "starting here and heading that way, how far until I leave the
 * material?" Answering them by marching the signed distance field converges
 * slowly wherever another surface is close by — exactly at the rims and
 * corners a thickness check cares most about — and a march that runs out of
 * steps reports a distance SHORTER than the truth, which reads as a wall
 * failure that is not there. An exact cast has no such failure mode.
 */
export function buildMeshRaycaster(positions, indices, triStart = 0, triCount = indices.length / 3) {
  if (triCount <= 0) throw new Error('buildMeshRaycaster: empty triangle range');
  const { nodes, order } = buildBVH(positions, indices, triStart, triCount);

  /** Distance along (dx,dy,dz) to the first triangle hit, or Infinity. */
  function cast(ox, oy, oz, dx, dy, dz, tMin = 1e-9, tMax = Infinity) {
    const inv = [1 / dx, 1 / dy, 1 / dz];
    const o = [ox, oy, oz];
    let best = tMax;
    const stack = [0];
    while (stack.length) {
      const node = nodes[stack.pop()];
      if (!slabHit(node.min, node.max, o, inv, tMin, best)) continue;
      if (node.left < 0) {
        for (let i = node.start; i < node.start + node.count; i++) {
          const tri = order[i];
          const t = mollerTrumbore(
            positions, indices, tri, ox, oy, oz, dx, dy, dz, tMin, best
          );
          if (t < best) best = t;
        }
      } else {
        stack.push(node.left, node.right);
      }
    }
    return best;
  }

  return { cast };
}

/** Slab test: does the ray meet this box within (tMin, tMax)? */
function slabHit(min, max, o, inv, tMin, tMax) {
  let lo = tMin;
  let hi = tMax;
  for (let j = 0; j < 3; j++) {
    let t1 = (min[j] - o[j]) * inv[j];
    let t2 = (max[j] - o[j]) * inv[j];
    if (t1 > t2) { const s = t1; t1 = t2; t2 = s; }
    // A ray parallel to an axis gives ±Infinity here, which compares correctly
    // unless the origin is exactly on the slab and produces NaN — hence the
    // explicit guards rather than plain min/max.
    if (t1 === t1 && t1 > lo) lo = t1;
    if (t2 === t2 && t2 < hi) hi = t2;
    if (lo > hi) return false;
  }
  return true;
}

/** Möller–Trumbore, both faces, returning t or Infinity. */
function mollerTrumbore(positions, indices, tri, ox, oy, oz, dx, dy, dz, tMin, tMax) {
  const i0 = indices[tri * 3] * 3, i1 = indices[tri * 3 + 1] * 3, i2 = indices[tri * 3 + 2] * 3;
  const e1x = positions[i1] - positions[i0];
  const e1y = positions[i1 + 1] - positions[i0 + 1];
  const e1z = positions[i1 + 2] - positions[i0 + 2];
  const e2x = positions[i2] - positions[i0];
  const e2y = positions[i2 + 1] - positions[i0 + 1];
  const e2z = positions[i2 + 2] - positions[i0 + 2];
  const px = dy * e2z - dz * e2y;
  const py = dz * e2x - dx * e2z;
  const pz = dx * e2y - dy * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-14) return Infinity; // ray parallel to the triangle
  const invDet = 1 / det;
  const tx = ox - positions[i0], ty = oy - positions[i0 + 1], tz = oz - positions[i0 + 2];
  const u = (tx * px + ty * py + tz * pz) * invDet;
  if (u < -1e-9 || u > 1 + 1e-9) return Infinity;
  const qx = ty * e1z - tz * e1y;
  const qy = tz * e1x - tx * e1z;
  const qz = tx * e1y - ty * e1x;
  const v = (dx * qx + dy * qy + dz * qz) * invDet;
  if (v < -1e-9 || u + v > 1 + 1e-9) return Infinity;
  const t = (e2x * qx + e2y * qy + e2z * qz) * invDet;
  return t > tMin && t < tMax ? t : Infinity;
}

export function buildFaceExtrusion(positions, indices, triStart = 0, triCount = indices.length / 3) {
  if (triCount <= 0) throw new Error('buildFaceExtrusion: empty triangle range');
  const tris = indices;

  // Area-weighted average normal.
  let ax = 0, ay = 0, az = 0;
  for (let t = 0; t < triCount; t++) {
    const i0 = tris[(triStart + t) * 3] * 3, i1 = tris[(triStart + t) * 3 + 1] * 3, i2 = tris[(triStart + t) * 3 + 2] * 3;
    const ux = positions[i1] - positions[i0], uy = positions[i1 + 1] - positions[i0 + 1], uz = positions[i1 + 2] - positions[i0 + 2];
    const vx = positions[i2] - positions[i0], vy = positions[i2 + 1] - positions[i0 + 1], vz = positions[i2 + 2] - positions[i0 + 2];
    ax += uy * vz - uz * vy; ay += uz * vx - ux * vz; az += ux * vy - uy * vx;
  }
  const al = Math.hypot(ax, ay, az) || 1;
  const nx = ax / al, ny = ay / al, nz = az / al;

  // Orthonormal basis (u,v) perpendicular to the normal for lateral distances.
  const ref = Math.abs(nx) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  let ux_ = ny * ref[2] - nz * ref[1], uy_ = nz * ref[0] - nx * ref[2], uz_ = nx * ref[1] - ny * ref[0];
  const ul = Math.hypot(ux_, uy_, uz_) || 1;
  ux_ /= ul; uy_ /= ul; uz_ /= ul;
  const vx_ = ny * uz_ - nz * uy_, vy_ = nz * ux_ - nx * uz_, vz_ = nx * uy_ - ny * ux_;

  // Boundary loop: edges used by exactly one triangle of the patch,
  // projected into (u,v).
  const nv = positions.length / 3;
  const edgeCount = new Map();
  for (let t = 0; t < triCount; t++) {
    const ia = tris[(triStart + t) * 3], ib = tris[(triStart + t) * 3 + 1], ic = tris[(triStart + t) * 3 + 2];
    for (const [a, b] of [[ia, ib], [ib, ic], [ic, ia]]) {
      const key = a < b ? a * nv + b : b * nv + a;
      edgeCount.set(key, (edgeCount.get(key) || 0) + 1);
    }
  }
  const segs = [];
  for (const [key, count] of edgeCount) {
    if (count !== 1) continue;
    const a = Math.floor(key / nv), b = key % nv;
    segs.push(
      positions[a * 3] * ux_ + positions[a * 3 + 1] * uy_ + positions[a * 3 + 2] * uz_,
      positions[a * 3] * vx_ + positions[a * 3 + 1] * vy_ + positions[a * 3 + 2] * vz_,
      positions[b * 3] * ux_ + positions[b * 3 + 1] * uy_ + positions[b * 3 + 2] * uz_,
      positions[b * 3] * vx_ + positions[b * 3 + 1] * vy_ + positions[b * 3 + 2] * vz_
    );
  }

  // Patch bounds.
  const bmin = [Infinity, Infinity, Infinity], bmax = [-Infinity, -Infinity, -Infinity];
  for (let t = 0; t < triCount; t++) {
    for (let k = 0; k < 3; k++) {
      const vi = tris[(triStart + t) * 3 + k] * 3;
      for (let j = 0; j < 3; j++) {
        const c = positions[vi + j];
        if (c < bmin[j]) bmin[j] = c;
        if (c > bmax[j]) bmax[j] = c;
      }
    }
  }

  const q = new Float64Array(4);

  function compile(d) {
    const lo = Math.min(0, d), hi = Math.max(0, d);
    return (x, y, z) => {
      // Cap term: ray-cast p + τ·n̂ against the patch (Möller–Trumbore); each
      // hit is one surface layer, offset o = −τ; keep the nearest layer.
      let cap = Infinity, hit = false;
      for (let t = 0; t < triCount; t++) {
        const i0 = tris[(triStart + t) * 3] * 3, i1 = tris[(triStart + t) * 3 + 1] * 3, i2 = tris[(triStart + t) * 3 + 2] * 3;
        const e1x = positions[i1] - positions[i0], e1y = positions[i1 + 1] - positions[i0 + 1], e1z = positions[i1 + 2] - positions[i0 + 2];
        const e2x = positions[i2] - positions[i0], e2y = positions[i2 + 1] - positions[i0 + 1], e2z = positions[i2 + 2] - positions[i0 + 2];
        const px = ny * e2z - nz * e2y, py = nz * e2x - nx * e2z, pz = nx * e2y - ny * e2x;
        const det = e1x * px + e1y * py + e1z * pz;
        if (Math.abs(det) < 1e-12) continue;
        const inv = 1 / det;
        const tx = x - positions[i0], ty = y - positions[i0 + 1], tz = z - positions[i0 + 2];
        const uu = (tx * px + ty * py + tz * pz) * inv;
        if (uu < -1e-9 || uu > 1 + 1e-9) continue;
        const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
        const vv = (nx * qx + ny * qy + nz * qz) * inv;
        if (vv < -1e-9 || uu + vv > 1 + 1e-9) continue;
        const tau = (e2x * qx + e2y * qy + e2z * qz) * inv;
        const o = -tau;
        const c = Math.max(lo - o, o - hi);
        if (c < cap) cap = c;
        hit = true;
      }
      if (!hit) {
        // Off the footprint (or silhouette): offset from the closest patch point.
        let bestSq = Infinity, bx = 0, by = 0, bz = 0;
        for (let t = 0; t < triCount; t++) {
          const i0 = tris[(triStart + t) * 3] * 3, i1 = tris[(triStart + t) * 3 + 1] * 3, i2 = tris[(triStart + t) * 3 + 2] * 3;
          closestOnTriangle(
            x, y, z,
            positions[i0], positions[i0 + 1], positions[i0 + 2],
            positions[i1], positions[i1 + 1], positions[i1 + 2],
            positions[i2], positions[i2 + 1], positions[i2 + 2],
            q
          );
          const dx = x - q[0], dy = y - q[1], dz = z - q[2];
          const dsq = dx * dx + dy * dy + dz * dz;
          if (dsq < bestSq) { bestSq = dsq; bx = q[0]; by = q[1]; bz = q[2]; }
        }
        const o = (x - bx) * nx + (y - by) * ny + (z - bz) * nz;
        cap = Math.max(lo - o, o - hi);
      }
      if (!segs.length) return cap; // closed patch (no outline): pure layer
      // Lateral term: 2D distance to the boundary loop in the (u,v) plane.
      const pu = x * ux_ + y * uy_ + z * uz_, pv = x * vx_ + y * vy_ + z * vz_;
      let latSq = Infinity;
      for (let s = 0; s < segs.length; s += 4) {
        const aX = segs[s], aY = segs[s + 1], bX = segs[s + 2], bY = segs[s + 3];
        const ex = bX - aX, ey = bY - aY;
        const wx = pu - aX, wy = pv - aY;
        const tt = Math.max(0, Math.min(1, (wx * ex + wy * ey) / (ex * ex + ey * ey || 1)));
        const dx = wx - tt * ex, dy = wy - tt * ey;
        const dsq = dx * dx + dy * dy;
        if (dsq < latSq) latSq = dsq;
      }
      const lat = (hit ? -1 : 1) * Math.sqrt(latSq);
      const mx = Math.max(cap, lat);
      if (mx < 0) return mx;
      const co = Math.max(cap, 0), lo2 = Math.max(lat, 0);
      return Math.hypot(co, lo2);
    };
  }

  function bbox(d) {
    const off = [d * nx, d * ny, d * nz];
    return {
      min: bmin.map((v, i) => v + Math.min(0, off[i]) - 0.5),
      max: bmax.map((v, i) => v + Math.max(0, off[i]) + 0.5),
    };
  }

  return { normal: [nx, ny, nz], compile, bbox };
}

/**
 * Compile triangles [triStart, triStart+triCount) of an indexed mesh into a
 * signed distance closure.
 *
 * Returns { distance(x,y,z), bbox, normal } where `normal` is the
 * area-weighted average facet normal of the range (the natural extrusion
 * direction for a face patch).
 */
export function buildMeshDistance(positions, indices, triStart = 0, triCount = indices.length / 3) {
  if (triCount <= 0) throw new Error('buildMeshDistance: empty triangle range');
  const tris = indices;
  const { nodes, order } = buildBVH(positions, tris, triStart, triCount);

  // Facet normals (normalized) + area-weighted average.
  const faceN = new Float64Array(triCount * 3);
  let avg = [0, 0, 0];
  for (let t = 0; t < triCount; t++) {
    const i0 = tris[(triStart + t) * 3] * 3, i1 = tris[(triStart + t) * 3 + 1] * 3, i2 = tris[(triStart + t) * 3 + 2] * 3;
    const ux = positions[i1] - positions[i0], uy = positions[i1 + 1] - positions[i0 + 1], uz = positions[i1 + 2] - positions[i0 + 2];
    const vx = positions[i2] - positions[i0], vy = positions[i2 + 1] - positions[i0 + 1], vz = positions[i2 + 2] - positions[i0 + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    avg[0] += nx; avg[1] += ny; avg[2] += nz; // cross product length = 2*area
    const len = Math.hypot(nx, ny, nz) || 1;
    faceN[t * 3] = nx / len; faceN[t * 3 + 1] = ny / len; faceN[t * 3 + 2] = nz / len;
  }
  const avgLen = Math.hypot(...avg) || 1;
  const normal = [avg[0] / avgLen, avg[1] / avgLen, avg[2] / avgLen];

  // Angle-weighted vertex pseudonormals + edge pseudonormals over the range.
  const nv = positions.length / 3;
  const vertN = new Map(); // vertexIndex -> [x,y,z]
  const edgeN = new Map(); // a*nv+b (a<b) -> [x,y,z]
  const accum = (map, key, nx, ny, nz, w) => {
    let e = map.get(key);
    if (!e) { e = [0, 0, 0]; map.set(key, e); }
    e[0] += nx * w; e[1] += ny * w; e[2] += nz * w;
  };
  for (let t = 0; t < triCount; t++) {
    const ia = tris[(triStart + t) * 3], ib = tris[(triStart + t) * 3 + 1], ic = tris[(triStart + t) * 3 + 2];
    const nx = faceN[t * 3], ny = faceN[t * 3 + 1], nz = faceN[t * 3 + 2];
    const corner = [ia, ib, ic];
    for (let k = 0; k < 3; k++) {
      const i0 = corner[k] * 3, i1 = corner[(k + 1) % 3] * 3, i2 = corner[(k + 2) % 3] * 3;
      const e1x = positions[i1] - positions[i0], e1y = positions[i1 + 1] - positions[i0 + 1], e1z = positions[i1 + 2] - positions[i0 + 2];
      const e2x = positions[i2] - positions[i0], e2y = positions[i2 + 1] - positions[i0 + 1], e2z = positions[i2 + 2] - positions[i0 + 2];
      const l1 = Math.hypot(e1x, e1y, e1z), l2 = Math.hypot(e2x, e2y, e2z);
      let angle = 0;
      if (l1 > 0 && l2 > 0) {
        const cos = (e1x * e2x + e1y * e2y + e1z * e2z) / (l1 * l2);
        angle = Math.acos(Math.max(-1, Math.min(1, cos)));
      }
      accum(vertN, corner[k], nx, ny, nz, angle);
    }
    const edges = [[ia, ib], [ia, ic], [ib, ic]];
    for (const [a, b] of edges) {
      const key = a < b ? a * nv + b : b * nv + a;
      accum(edgeN, key, nx, ny, nz, 1);
    }
  }

  const q = new Float64Array(4);
  const stack = new Int32Array(64);

  function distance(x, y, z) {
    let bestSq = Infinity;
    let bx = 0, by = 0, bz = 0, bReg = 0, bTri = 0;
    let sp = 0;
    stack[sp++] = 0;
    while (sp > 0) {
      const node = nodes[stack[--sp]];
      if (aabbDistSq(node.min, node.max, x, y, z) >= bestSq) continue;
      if (node.left < 0) {
        for (let i = node.start; i < node.start + node.count; i++) {
          const tri = order[i];
          const i0 = tris[tri * 3] * 3, i1 = tris[tri * 3 + 1] * 3, i2 = tris[tri * 3 + 2] * 3;
          closestOnTriangle(
            x, y, z,
            positions[i0], positions[i0 + 1], positions[i0 + 2],
            positions[i1], positions[i1 + 1], positions[i1 + 2],
            positions[i2], positions[i2 + 1], positions[i2 + 2],
            q
          );
          const dx = x - q[0], dy = y - q[1], dz = z - q[2];
          const dsq = dx * dx + dy * dy + dz * dz;
          if (dsq < bestSq) {
            bestSq = dsq;
            bx = q[0]; by = q[1]; bz = q[2]; bReg = q[3]; bTri = tri;
          }
        }
      } else {
        // Visit nearer child first for tighter pruning.
        const dl = aabbDistSq(nodes[node.left].min, nodes[node.left].max, x, y, z);
        const dr = aabbDistSq(nodes[node.right].min, nodes[node.right].max, x, y, z);
        if (dl < dr) { stack[sp++] = node.right; stack[sp++] = node.left; }
        else { stack[sp++] = node.left; stack[sp++] = node.right; }
      }
    }
    const t = bTri - triStart;
    const ia = tris[bTri * 3], ib = tris[bTri * 3 + 1], ic = tris[bTri * 3 + 2];
    let n;
    switch (bReg) {
      case REG_FACE: n = [faceN[t * 3], faceN[t * 3 + 1], faceN[t * 3 + 2]]; break;
      case REG_A: n = vertN.get(ia); break;
      case REG_B: n = vertN.get(ib); break;
      case REG_C: n = vertN.get(ic); break;
      case REG_AB: n = edgeN.get(ia < ib ? ia * nv + ib : ib * nv + ia); break;
      case REG_AC: n = edgeN.get(ia < ic ? ia * nv + ic : ic * nv + ia); break;
      default: n = edgeN.get(ib < ic ? ib * nv + ic : ic * nv + ib); break;
    }
    const dx = x - bx, dy = y - by, dz = z - bz;
    const side = dx * n[0] + dy * n[1] + dz * n[2];
    const dist = Math.sqrt(bestSq);
    return side >= 0 ? dist : -dist;
  }

  // Bounds of the triangle range (not the whole vertex array).
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let t = 0; t < triCount; t++) {
    for (let k = 0; k < 3; k++) {
      const vi = tris[(triStart + t) * 3 + k] * 3;
      for (let j = 0; j < 3; j++) {
        const v = positions[vi + j];
        if (v < min[j]) min[j] = v;
        if (v > max[j]) max[j] = v;
      }
    }
  }

  return { distance, bbox: { min, max }, normal };
}
