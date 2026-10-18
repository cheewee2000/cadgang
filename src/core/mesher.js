/**
 * Naive Surface Nets mesher for signed distance fields.
 *
 * Samples the SDF on a regular grid over a bounding box, places one vertex
 * per sign-crossing cell (at the average of its edge intersections), and
 * stitches quads across every grid edge that crosses the surface.
 * Produces watertight, manifold-friendly triangle meshes ideal for SDFs.
 */

// Progress is split across the passes weighted roughly by cost. Grid sampling
// (O(res^3) SDF evals) dominates; the rest is bookkeeping plus per-vertex
// normals. Cumulative ceilings per phase, all summing to 1.0:
const P_SAMPLE = 0.70; // grid field sampling  -> [0.00 .. 0.70]
const P_CELLS = 0.10;  // cell vertex extraction -> [0.70 .. 0.80]
const P_QUADS = 0.05;  // quad stitching        -> [0.80 .. 0.85]
const P_NORMALS = 0.15; // vertex normals        -> [0.85 .. 1.00]

/**
 * The mesher as a generator: identical arithmetic to the classic surface-nets
 * pass, but it `yield`s a 0..1 progress fraction at slice/chunk boundaries and
 * returns the finished mesh. Driven synchronously by meshSDF and asynchronously
 * (yielding to the event loop between chunks) by meshSDFAsync — so both paths
 * produce byte-identical output. Progress is monotonically nondecreasing.
 */
function* meshGenerator(fn, bounds, resolution = 80) {
  const res = Math.max(8, Math.min(220, Math.round(resolution)));
  const { min, max } = bounds;
  const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const longest = Math.max(...size);
  // Cells per axis proportional to extent, capped so the grid stays sane.
  const dims = size.map((s) => Math.max(4, Math.round((s / longest) * res)));
  const [nx, ny, nz] = dims;
  const step = [size[0] / nx, size[1] / ny, size[2] / nz];

  const gx = nx + 1, gy = ny + 1, gz = nz + 1;
  const field = new Float32Array(gx * gy * gz);
  const gidx = (i, j, k) => i + gx * (j + gy * k);

  yield 0; // let listeners show a bar before the heavy sampling begins

  for (let k = 0; k < gz; k++) {
    const z = min[2] + k * step[2];
    for (let j = 0; j < gy; j++) {
      const y = min[1] + j * step[1];
      let base = gx * (j + gy * k);
      for (let i = 0; i < gx; i++) {
        field[base + i] = fn(min[0] + i * step[0], y, z);
      }
    }
    yield (P_SAMPLE * (k + 1)) / gz;
  }

  // cell -> vertex index
  const cellVert = new Int32Array(nx * ny * nz).fill(-1);
  const cidx = (i, j, k) => i + nx * (j + ny * k);
  const positions = [];

  const EDGES = [
    [0, 1], [1, 3], [3, 2], [2, 0],
    [4, 5], [5, 7], [7, 6], [6, 4],
    [0, 4], [1, 5], [3, 7], [2, 6],
  ];
  const CORNER = [
    [0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0],
    [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1],
  ];

  const corner = new Float64Array(8);
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        let mask = 0;
        for (let c = 0; c < 8; c++) {
          const v = field[gidx(i + CORNER[c][0], j + CORNER[c][1], k + CORNER[c][2])];
          corner[c] = v;
          if (v < 0) mask |= 1 << c;
        }
        if (mask === 0 || mask === 0xff) continue;

        // vertex = mean of edge crossings
        let sx = 0, sy = 0, sz = 0, n = 0;
        for (const [a, b] of EDGES) {
          const va = corner[a], vb = corner[b];
          if ((va < 0) === (vb < 0)) continue;
          const t = va / (va - vb);
          sx += CORNER[a][0] + t * (CORNER[b][0] - CORNER[a][0]);
          sy += CORNER[a][1] + t * (CORNER[b][1] - CORNER[a][1]);
          sz += CORNER[a][2] + t * (CORNER[b][2] - CORNER[a][2]);
          n++;
        }
        cellVert[cidx(i, j, k)] = positions.length / 3;
        positions.push(
          min[0] + (i + sx / n) * step[0],
          min[1] + (j + sy / n) * step[1],
          min[2] + (k + sz / n) * step[2]
        );
      }
    }
    yield P_SAMPLE + (P_CELLS * (k + 1)) / nz;
  }

  // Stitch quads: for each interior grid edge with a sign change, connect the
  // 4 cells sharing that edge. Winding chosen so normals point outward (+).
  const indices = [];
  const quad = (a, b, c, d, flip) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (flip) indices.push(a, d, c, a, c, b);
    else indices.push(a, b, c, a, c, d);
  };

  for (let k = 0; k < gz; k++) {
    for (let j = 0; j < gy; j++) {
      for (let i = 0; i < gx; i++) {
        const v0 = field[gidx(i, j, k)];
        // X-edge from (i,j,k) to (i+1,j,k): shared by cells (i, j-1..j, k-1..k)
        if (i < nx && j > 0 && j < ny && k > 0 && k < nz) {
          const v1 = field[gidx(i + 1, j, k)];
          if ((v0 < 0) !== (v1 < 0)) {
            quad(
              cellVert[cidx(i, j - 1, k - 1)], cellVert[cidx(i, j, k - 1)],
              cellVert[cidx(i, j, k)], cellVert[cidx(i, j - 1, k)],
              v0 < 0
            );
          }
        }
        // Y-edge
        if (j < ny && i > 0 && i < nx && k > 0 && k < nz) {
          const v1 = field[gidx(i, j + 1, k)];
          if ((v0 < 0) !== (v1 < 0)) {
            quad(
              cellVert[cidx(i - 1, j, k - 1)], cellVert[cidx(i - 1, j, k)],
              cellVert[cidx(i, j, k)], cellVert[cidx(i, j, k - 1)],
              v0 < 0
            );
          }
        }
        // Z-edge
        if (k < nz && i > 0 && i < nx && j > 0 && j < ny) {
          const v1 = field[gidx(i, j, k + 1)];
          if ((v0 < 0) !== (v1 < 0)) {
            quad(
              cellVert[cidx(i - 1, j - 1, k)], cellVert[cidx(i, j - 1, k)],
              cellVert[cidx(i, j, k)], cellVert[cidx(i - 1, j, k)],
              v0 < 0
            );
          }
        }
      }
    }
    yield P_SAMPLE + P_CELLS + (P_QUADS * (k + 1)) / gz;
  }

  const pos = new Float32Array(positions);
  const idx = new Uint32Array(indices);

  // Vertex normals from SDF gradient (central differences)
  const normals = new Float32Array(pos.length);
  const eps = Math.min(...step) * 0.5;
  const normalsBase = P_SAMPLE + P_CELLS + P_QUADS;
  const CHUNK = 3000; // components processed between yields (~1000 vertices)
  for (let v = 0; v < pos.length; v += 3) {
    const x = pos[v], y = pos[v + 1], z = pos[v + 2];
    let gxv = fn(x + eps, y, z) - fn(x - eps, y, z);
    let gyv = fn(x, y + eps, z) - fn(x, y - eps, z);
    let gzv = fn(x, y, z + eps) - fn(x, y, z - eps);
    const len = Math.hypot(gxv, gyv, gzv) || 1;
    normals[v] = gxv / len;
    normals[v + 1] = gyv / len;
    normals[v + 2] = gzv / len;
    if (v % CHUNK === 0 && pos.length > 0) {
      yield normalsBase + (P_NORMALS * (v + 3)) / pos.length;
    }
  }

  return {
    positions: pos,
    normals,
    indices: idx,
    stats: meshStats(pos, idx, bounds, dims),
  };
}

/** Synchronous mesher — drives the generator to completion, ignoring progress. */
export function meshSDF(fn, bounds, resolution = 80) {
  const gen = meshGenerator(fn, bounds, resolution);
  let step = gen.next();
  while (!step.done) step = gen.next();
  return step.value;
}

/**
 * Async mesher: identical output to meshSDF, but yields to the event loop
 * between chunks (so a server can flush WebSocket messages mid-mesh) and reports
 * progress via onProgress(fraction), 0..1, monotonically nondecreasing, with a
 * guaranteed final onProgress(1).
 */
export async function meshSDFAsync(fn, bounds, resolution = 80, onProgress = () => {}) {
  const gen = meshGenerator(fn, bounds, resolution);
  let step = gen.next();
  while (!step.done) {
    onProgress(step.value);
    await new Promise((resolve) => setImmediate(resolve));
    step = gen.next();
  }
  onProgress(1);
  return step.value;
}

export function meshStats(positions, indices, bounds, dims) {
  const triangleCount = indices.length / 3;
  const vertexCount = positions.length / 3;
  // Signed volume + area via divergence theorem over triangles
  let volume = 0, area = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
    const ax = positions[a], ay = positions[a + 1], az = positions[a + 2];
    const bx = positions[b], by = positions[b + 1], bz = positions[b + 2];
    const cx = positions[c], cy = positions[c + 1], cz = positions[c + 2];
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    const nxv = uy * vz - uz * vy, nyv = uz * vx - ux * vz, nzv = ux * vy - uy * vx;
    area += Math.hypot(nxv, nyv, nzv) / 2;
    volume += (ax * nxv + ay * nyv + az * nzv) / 6;
  }
  return {
    vertexCount,
    triangleCount,
    volume: Math.abs(volume),
    surfaceArea: area,
    bounds,
    gridDims: dims,
  };
}
