/**
 * Machine-checkable intent.
 *
 * A model authored by a machine needs claims that can be tested, or the user is
 * trusting generated code on faith. These are the measurements those claims are
 * made of: how thin the thinnest wall gets, how close two faces come, whether
 * the mesh that would be printed is actually closed.
 *
 * Each function MEASURES and returns a number or a report. Deciding whether a
 * measurement passes belongs to the `assert` namespace in cellapi.js, which is
 * where the limit and the error message live — a measurement that threw could
 * not be printed, and a number a person can read is worth more than a green
 * tick.
 */

import { GraphError } from './errors.js';
import { tessellate, brepKernel as kernelOf } from './brep.js';
import { buildMeshRaycaster, weldVertices } from './mesh.js';
import { Query } from './query.js';

/**
 * The thinnest the material gets, measured by casting a ray straight into the
 * solid from points all over its surface.
 *
 * Sampled, and honest about it: the answer is the thinnest wall FOUND, and a
 * thin spot smaller than the sample spacing can hide between samples. Two
 * things make that acceptable. Tessellation chords fall INSIDE a curved
 * surface, so faceting biases the measurement downward — the direction that
 * never claims a wall is thicker than it is. And a real thin wall is a region,
 * not a point: the sample grid follows the tessellation, so it is denser
 * exactly where the geometry is detailed.
 *
 * What it does not do is find the thinnest wall in a direction nobody's surface
 * normal points along. It measures thickness the way a wall is thick — straight
 * through — not the radius of the largest inscribed sphere.
 */
export function minWallThickness(shape, { tolerance = 0.02, maxSamples = 4000 } = {}) {
  const { positions, indices } = tessellate(shape, { tolerance });
  const triCount = indices.length / 3;
  if (!triCount) throw new GraphError('Wall thickness: the shape produced no mesh');
  const { cast } = buildMeshRaycaster(positions, indices);

  // Step off the surface before casting, so the triangle we started from
  // cannot be the triangle we hit.
  const eps = Math.max(tolerance, 1e-4);
  const stride = Math.max(1, Math.ceil(triCount / maxSamples));

  let min = Infinity;
  let at = null;
  let samples = 0;
  for (let t = 0; t < triCount; t += stride) {
    const i0 = indices[t * 3] * 3, i1 = indices[t * 3 + 1] * 3, i2 = indices[t * 3 + 2] * 3;
    const cx = (positions[i0] + positions[i1] + positions[i2]) / 3;
    const cy = (positions[i0 + 1] + positions[i1 + 1] + positions[i2 + 1]) / 3;
    const cz = (positions[i0 + 2] + positions[i1 + 2] + positions[i2 + 2]) / 3;

    const ux = positions[i1] - positions[i0];
    const uy = positions[i1 + 1] - positions[i0 + 1];
    const uz = positions[i1 + 2] - positions[i0 + 2];
    const vx = positions[i2] - positions[i0];
    const vy = positions[i2 + 1] - positions[i0 + 1];
    const vz = positions[i2 + 2] - positions[i0 + 2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (!len) continue; // degenerate sliver from the tessellator
    nx /= len; ny /= len; nz /= len;

    const hit = cast(cx - nx * eps, cy - ny * eps, cz - nz * eps, -nx, -ny, -nz);
    if (!Number.isFinite(hit)) continue; // grazed out of the solid; not a wall
    samples++;
    const thickness = hit + eps;
    if (thickness < min) {
      min = thickness;
      at = [cx, cy, cz];
    }
  }

  if (!samples) throw new GraphError('Wall thickness: no ray found material to measure');
  return { value: min, at, samples, triangles: triCount };
}

/**
 * The closest two sets of faces or edges come to each other.
 *
 * Exact, not sampled: OCCT's own distance between sub-shapes. Clearance is the
 * measurement most likely to be checked against a tolerance a part is actually
 * built to, so an approximation would be the wrong kind of cheap.
 */
export function clearance(shape, a, b) {
  const k = kernelOf();
  const left = elements(shape, a, 'clearance');
  const right = elements(shape, b, 'clearance');
  let min = Infinity;
  let pair = null;
  for (const [i, x] of left.entries()) {
    for (const [j, y] of right.entries()) {
      const d = k.measureDistanceBetween(x, y);
      if (d < min) { min = d; pair = [i, j]; }
    }
  }
  return { value: min, pair, counts: [left.length, right.length] };
}

function elements(shape, query, opName) {
  if (!(query instanceof Query)) {
    throw new GraphError(`${opName} needs queries — for example q.faces(shape).facing('+z')`);
  }
  const found = query.resolveOn(shape);
  if (!found.length) {
    throw new GraphError(`${opName}: ${query.expression} matched no ${query.type}s on this shape`);
  }
  return found.map((e) => e.element);
}

/**
 * Whether the mesh that would be exported is closed.
 *
 * This deliberately tests the TESSELLATION rather than the B-rep. Solids built
 * by these operations are closed by construction, so a B-rep check would pass
 * on everything; what actually ships to a printer is the triangle mesh, and a
 * mesh with a boundary edge is a mesh that will not slice. Every edge of a
 * closed, consistently wound surface is shared by exactly two triangles, once
 * in each direction.
 */
export function watertight(shape, { tolerance = 0.02 } = {}) {
  const mesh = tessellate(shape, { tolerance });
  // OCCT tessellates face by face and gives each face its own vertices, so the
  // raw index arrays share nothing across a face boundary and every edge would
  // read as a boundary edge. Welding by position is what turns the triangle
  // soup back into the surface it came from — and it is also what an STL
  // consumer does, which is the thing being asked about.
  const { positions, indices } = weldVertices(mesh.positions, mesh.indices, Math.max(tolerance, 1e-4) / 10);
  const edges = new Map();
  const key = (a, b) => (a < b ? `${a}:${b}` : `${b}:${a}`);
  for (let t = 0; t < indices.length; t += 3) {
    const tri = [indices[t], indices[t + 1], indices[t + 2]];
    for (let k = 0; k < 3; k++) {
      const a = tri[k];
      const b = tri[(k + 1) % 3];
      if (a === b) continue; // degenerate sliver contributes no boundary
      const e = key(a, b);
      const seen = edges.get(e) || { forward: 0, backward: 0 };
      if (a < b) seen.forward++; else seen.backward++;
      edges.set(e, seen);
    }
  }
  let boundary = 0;
  let nonManifold = 0;
  let flipped = 0;
  for (const { forward, backward } of edges.values()) {
    const total = forward + backward;
    if (total === 1) boundary++;
    else if (total > 2) nonManifold++;
    else if (forward !== 1 || backward !== 1) flipped++;
  }
  return {
    ok: boundary === 0 && nonManifold === 0 && flipped === 0,
    boundary,
    nonManifold,
    flipped,
    triangles: indices.length / 3,
    vertices: positions.length / 3,
  };
}
