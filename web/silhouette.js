/**
 * Silhouette edges for the wireframe: where a curved surface turns away from the eye, the line
 * SolidWorks draws along a cylinder's side or round a fillet. A model's real edges (face borders,
 * creases) stay put; these depend on the view, so they are found again whenever it moves.
 *
 * Once per body: every edge two triangles share by position (vertices are split per face, so
 * shared means same place, not same index), kept only where the two triangles bend: coplanar
 * ones never show. On a mesh the crease overlay already draws bends past 25°, so those go too;
 * on a B-rep the overlay is its face borders, so a pair across two faces goes, and a pair inside
 * one stays however far it bends (a coarse cylinder bends ~29° per facet).
 * Per view: an edge is on the silhouette when one of its triangles faces the eye and the other
 * faces away. Done in the body's own space, so explode and turns cost nothing.
 */

const CREASE = Math.cos((25 * Math.PI) / 180);   // sharper than the crease overlay's 25°: already drawn

/**
 * The candidate edges of a geometry: { pos: [a, b] per edge, n: [n1, n2] per edge }, or null if none.
 * creases: the body's overlay is crease lines (a mesh), so sharp bends are drawn already.
 * faces: a B-rep's face ranges [{first, count}] in triangles, whose borders are drawn already.
 */
export function silhouetteEdges(geo, { creases = false, faces = null } = {}) {
  const P = geo.getAttribute('position'), I = geo.index;
  const tris = (I ? I.count : P.count) / 3;
  const vid = (k) => (I ? I.getX(k) : k);
  // one id per position: vertices split per face or per normal still meet here
  const box = geo.boundingBox ?? (geo.computeBoundingBox(), geo.boundingBox);
  const q = (box.max.distanceTo(box.min) || 1) * 1e-6;
  const ids = new Map(), canon = new Int32Array(P.count);
  for (let v = 0; v < P.count; v++) {
    const k = `${Math.round(P.getX(v) / q)},${Math.round(P.getY(v) / q)},${Math.round(P.getZ(v) / q)}`;
    let id = ids.get(k);
    if (id === undefined) { id = ids.size; ids.set(k, id); }
    canon[v] = id;
  }
  // triangle normals
  const N = new Float32Array(tris * 3);
  for (let t = 0; t < tris; t++) {
    const a = vid(3 * t), b = vid(3 * t + 1), c = vid(3 * t + 2);
    const ux = P.getX(b) - P.getX(a), uy = P.getY(b) - P.getY(a), uz = P.getZ(b) - P.getZ(a);
    const vx = P.getX(c) - P.getX(a), vy = P.getY(c) - P.getY(a), vz = P.getZ(c) - P.getZ(a);
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    N[3 * t] = nx / l; N[3 * t + 1] = ny / l; N[3 * t + 2] = nz / l;
  }
  let faceOf = null;
  if (faces?.length) { faceOf = new Int32Array(tris).fill(-1); faces.forEach((f, i) => faceOf.fill(i, f.first, f.first + f.count)); }
  // pair triangles across each shared edge
  const n = ids.size, first = new Map(), pos = [], nrm = [];
  for (let t = 0; t < tris; t++) {
    for (let e = 0; e < 3; e++) {
      const va = vid(3 * t + e), vb = vid(3 * t + ((e + 1) % 3));
      const a = canon[va], b = canon[vb];
      if (a === b) continue;
      const key = a < b ? a * n + b : b * n + a;
      const o = first.get(key);
      if (o === undefined) { first.set(key, t); continue; }
      first.delete(key);   // a third triangle on the edge (non-manifold) starts a new pair
      const d = N[3 * o] * N[3 * t] + N[3 * o + 1] * N[3 * t + 1] + N[3 * o + 2] * N[3 * t + 2];
      if (d > 0.99999 || (creases && d < CREASE) || (faceOf && faceOf[o] !== faceOf[t])) continue;   // flat, or already drawn
      pos.push(P.getX(va), P.getY(va), P.getZ(va), P.getX(vb), P.getY(vb), P.getZ(vb));
      nrm.push(N[3 * o], N[3 * o + 1], N[3 * o + 2], N[3 * t], N[3 * t + 1], N[3 * t + 2]);
    }
  }
  return pos.length ? { pos: Float32Array.from(pos), n: Float32Array.from(nrm) } : null;
}

/**
 * Fill `out` (a Float32Array of the same length as edges.pos) with the silhouette for an eye at
 * `eye` (the body's own space; an orthographic view passes `dir`, the direction it looks along).
 * Returns how many floats it wrote.
 */
export function silhouetteFor(edges, eye, dir, out) {
  const { pos, n } = edges;
  let w = 0;
  for (let i = 0; i < pos.length; i += 6) {
    let vx, vy, vz;
    if (dir) { vx = -dir.x; vy = -dir.y; vz = -dir.z; }
    else { vx = eye.x - (pos[i] + pos[i + 3]) / 2; vy = eye.y - (pos[i + 1] + pos[i + 4]) / 2; vz = eye.z - (pos[i + 2] + pos[i + 5]) / 2; }
    const f1 = n[i] * vx + n[i + 1] * vy + n[i + 2] * vz, f2 = n[i + 3] * vx + n[i + 4] * vy + n[i + 5] * vz;
    if ((f1 > 0) === (f2 > 0)) continue;
    for (let k = 0; k < 6; k++) out[w + k] = pos[i + k];
    w += 6;
  }
  return w;
}
