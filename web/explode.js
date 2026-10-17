import * as THREE from 'three';
import { cylinderFit } from './measure.js';

/**
 * Explode vectors. radialOffsets is the instant default: out from the assembly centre.
 * explodeOffsets solves, per body, against the bodies at least as big as it (a part sits in or on
 * something bigger, never the other way round):
 *   - coaxial with a cylinder of another body (a pin in a bore, a bearing in a housing): along the
 *     shared axis, out of the freer end, riding on that body
 *   - touching walls on both sides of an axis with one axis fully open: a channel, slide along it
 *   - touching another body on a plane: away from it, perpendicular (sandwiched: along the stack)
 *   - the radial path blocked within the part's own size: a pocket, out by the clearest axis
 *   - otherwise radial
 * then a second pass turns any vector whose travel would run into a body that is not moving out
 * of its way onto the clearest of the candidates. Sets body.userData.offset and .parent.
 * Cost is one cylinder fit per B-rep face and a dozen rays per body: run it on load for small
 * files, behind a button for large ones.
 */
const DIRS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].map((d) => new THREE.Vector3(...d));
const axisOf = (d) => (Math.abs(d.x) > 0.5 ? 0 : Math.abs(d.y) > 0.5 ? 1 : 2);

export function radialOffsets(bodies, centre) {
  for (const m of bodies) {
    m.geometry.computeBoundingBox();
    m.userData.offset = m.geometry.boundingBox.getCenter(new THREE.Vector3()).sub(centre);
    m.userData.parent = null;
  }
}

/** The cylinders among a body's B-rep faces: axis, centre, radius, span. */
function cylinders(m) {
  const faces = m.userData.faces; if (!faces) return [];
  const pos = m.geometry.getAttribute('position'), idx = m.geometry.index?.array;
  const out = [];
  for (const f of faces) {
    if (f.count < 6) continue;
    const tris = [], centroid = new THREE.Vector3(), tmp = new THREE.Vector3(); let area = 0;
    for (let t = f.first; t < f.first + f.count; t++) {
      const v = (k) => new THREE.Vector3().fromBufferAttribute(pos, idx ? idx[3 * t + k] : 3 * t + k);
      const tri = new THREE.Triangle(v(0), v(1), v(2)); const a = tri.getArea(); if (!a) continue;
      tris.push(tri); area += a; centroid.addScaledVector(tri.getMidpoint(tmp), a);
    }
    if (tris.length < 6) continue;
    centroid.divideScalar(area);
    const n0 = tris[0].getNormal(new THREE.Vector3());
    if (tris.every((t) => t.getNormal(tmp).dot(n0) > 0.9998)) continue;   // planar
    const c = cylinderFit(tris, centroid);
    if (c && c.span > Math.PI / 3) out.push(c);
  }
  return out;
}

export function explodeOffsets(bodies, centre) {
  const ray = new THREE.Raycaster();
  const info = bodies.map((m) => {
    m.geometry.computeBoundingBox();
    const b = m.geometry.boundingBox;
    const half = b.getSize(new THREE.Vector3()).multiplyScalar(0.5);
    return { c: b.getCenter(new THREE.Vector3()), half, r: half.length(), cyl: cylinders(m) };
  });
  const hitFrom = (c, d, among) => { ray.set(c, d.clone().normalize()); return ray.intersectObjects(among, false)[0]; };
  const plan = bodies.map((m, i) => {
    const { c, half, r } = info[i];
    const radial = c.clone().sub(centre);
    const bigger = bodies.filter((o, j) => j !== i && info[j].r >= r);
    const hit = (d) => hitFrom(c, d, bigger);
    const ext = (d) => Math.abs(d.x) * half.x + Math.abs(d.y) * half.y + Math.abs(d.z) * half.z;   // half-extent along d
    const free = (d) => { const h = hit(d); return h ? h.distance : Infinity; };
    const len = (d) => Math.max(Math.abs(radial.dot(d.clone().normalize())), 2 * ext(d));
    const rideOn = (o) => { const j = bodies.indexOf(o); return info[j].r > r || j < i ? o : null; };   // no cycles: bigger, ties by order
    const P = { m, i, radial, ext, len, free, hit, cands: [], dir: null, parent: null };
    // shared cylinder axes with bigger bodies: candidates first, and the rule of first resort
    for (const a of info[i].cyl) for (const j of bodies.keys()) {
      if (j === i || info[j].r < r) continue;
      for (const b of info[j].cyl) {
        if (Math.abs(a.axis.dot(b.axis)) < 0.999 || b.r < 0.98 * a.r || b.r > 1.25 * a.r) continue;
        const off = a.c.clone().sub(b.c); off.addScaledVector(b.axis, -off.dot(b.axis));
        if (off.length() > 0.02 * a.r + 1e-6) continue;   // not on the same line
        const plus = a.axis.clone(), minus = a.axis.clone().negate();
        const fp = free(plus), fm = free(minus);
        const d = fp > fm ? plus : fm > fp ? minus : (radial.dot(plus) >= 0 ? plus : minus);
        P.cands.push(plus, minus);
        if (!P.dir) { P.dir = d; P.parent = rideOn(bodies[j]); }
      }
    }
    P.cands.push(...DIRS);
    if (P.dir) return P;
    // ponytail: one ray per direction from the centre; sample the surface if thin parts slip through
    const rays = DIRS.map((d) => { const h = hit(d); return { d, h, free: h ? h.distance : Infinity, touch: !!h && h.distance <= ext(d) + 0.1 * r }; });
    const touching = rays.filter((x) => x.touch);
    const walled = [0, 1, 2].some((a) => touching.filter((x) => axisOf(x.d) === a).length === 2);
    const open = [0, 1, 2].filter((a) => rays.filter((x) => axisOf(x.d) === a).every((x) => x.free > 2 * r));
    if (walled && open.length === 1) {
      const a = open[0];
      P.dir = new THREE.Vector3().setComponent(a, Math.sign(radial.getComponent(a)) || 1);
      P.parent = rideOn(touching[0].h.object);
      return P;
    }
    if (touching.length) {
      const v = new THREE.Vector3();
      for (const x of touching) v.sub(x.d);
      if (v.lengthSq() === 0) { const a = axisOf(touching[0].d); v.setComponent(a, Math.sign(radial.getComponent(a)) || 1); }
      P.dir = v.normalize();
      return P;
    }
    const block = radial.lengthSq() > 1e-12 && hit(radial);
    if (block && block.distance <= 2 * r) {
      const best = rays.reduce((a, b) => (b.free > a.free ? b : a));
      if (best.free > 2 * r) { P.dir = best.d; P.parent = rideOn(block.object); P.radialLen = Math.max(radial.length(), 2 * r); return P; }
    }
    P.dir = radial.lengthSq() ? radial.clone().normalize() : null;   // the central body stays
    P.radialLen = radial.length();
    return P;
  });
  for (const P of plan) P.offset = P.dir ? P.dir.clone().multiplyScalar(P.radialLen ?? P.len(P.dir)) : new THREE.Vector3();
  // no collisions: a body whose travel runs into another that is not moving out of its way takes the clearest candidate
  for (const P of plan) {
    if (!P.dir) continue;
    const others = bodies.filter((o) => o !== P.m && o !== P.parent);
    const blockedBy = (d, travel) => {
      const h = hitFrom(info[P.i].c, d, others); if (!h || h.distance > P.ext(d) + travel) return null;
      const Q = plan[bodies.indexOf(h.object)];
      const ahead = Q.offset.dot(d) >= P.offset.length();   // it moves along my way at least as far as I do: the gap only grows
      return ahead ? null : h;
    };
    if (!blockedBy(P.dir, 2 * P.offset.length())) continue;
    let best = null;
    for (const d of P.cands) {
      const h = hitFrom(info[P.i].c, d, others), f = h ? h.distance : Infinity;
      const score = f + 1e-3 * d.dot(P.radial);   // clearest; ties toward the radial
      if (!best || score > best.score) best = { d, score, f };
    }
    if (best && best.f > P.ext(best.d)) { P.dir = best.d; P.offset = best.d.clone().multiplyScalar(P.len(best.d)); }
  }
  for (const P of plan) { P.m.userData.offset = P.offset; P.m.userData.parent = P.parent; }
}
