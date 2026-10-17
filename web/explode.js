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
  // Rays test front faces only, whatever material the viewer draws the bodies with (double-sided
  // shading would make every wall hit from both sides): probe meshes over the same geometry.
  const probe = bodies.map((m) => new THREE.Mesh(m.geometry));
  const hitFrom = (c, d, among) => {
    ray.set(c, d.clone().normalize());
    const h = ray.intersectObjects(among.map((b) => probe[bodies.indexOf(b)]), false)[0];
    return h && { distance: h.distance, object: bodies[probe.indexOf(h.object)] };
  };
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
        // on the line, but is it in THIS bore? the two must overlap along the axis (the facing pocket of
        // another part shares the line and touches, but does not overlap)
        const flip = a.axis.dot(b.axis) < 0, a0 = flip ? -a.t1 : a.t0, a1 = flip ? -a.t0 : a.t1;
        if (Math.min(a1, b.t1) - Math.max(a0, b.t0) < 0.1 * (a1 - a0)) continue;
        // which end is open: ask the body that owns the bore alone (a blind pocket's floor blocks one way;
        // whatever else sits in front of the opening is moving out of the way itself)
        const plus = a.axis.clone(), minus = a.axis.clone().negate();
        const own = (d) => { const h = hitFrom(c, d, [bodies[j]]); return h ? h.distance : Infinity; };
        const fp = own(plus), fm = own(minus);
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
  // no collisions, judged pair by pair on relative motion (a part riding on its pocket's body moves with
  // it): seen from body Q, body P travels along P.abs - Q.abs; if that path runs into Q within the travel,
  // P takes the clearest of its candidates whose whole travel is clear of everyone. None clear, it keeps
  // the direction the rules gave it.
  const absOf = (P, seen = new Set()) => { if (!P.parent || seen.has(P)) return P.offset.clone(); seen.add(P); return P.offset.clone().add(absOf(plan[bodies.indexOf(P.parent)], seen)); };
  for (const P of plan) P.abs = absOf(P);
  const parentAbs = (P) => (P.parent ? plan[bodies.indexOf(P.parent)].abs : new THREE.Vector3());
  // clearance of P moving by `abs`: the smallest gap left to any other body along the relative path (Infinity: none in the way)
  const clearance = (P, abs) => {
    let worst = Infinity;
    for (const Q of plan) {
      if (Q === P || Q.m === P.parent) continue;
      const v = abs.clone().sub(Q.abs); if (v.lengthSq() < 1e-9) continue;
      if (info[P.i].c.distanceTo(info[Q.i].c) > info[P.i].r + info[Q.i].r + 2 * v.length()) continue;
      const h = hitFrom(info[P.i].c, v, [Q.m]); if (!h) continue;
      worst = Math.min(worst, (h.distance - P.ext(v)) - 2 * v.length());   // negative: they meet before full explode
    }
    return worst;
  };
  for (const P of plan) {
    if (!P.dir) continue;
    const c0 = clearance(P, P.abs);
    if (c0 >= 0) continue;
    let best = null;
    for (const d of P.cands) {
      const abs = d.clone().multiplyScalar(P.len(d)).add(parentAbs(P));
      const score = clearance(P, abs) + 1e-3 * d.dot(P.radial);   // clearest; ties toward the radial
      if (!best || score > best.score) best = { d, score };
    }
    // strictly better only: parts modelled overlapping at rest get the least-bad way out, never a worse one
    if (best && best.score > c0) { P.dir = best.d; P.offset = best.d.clone().multiplyScalar(P.len(best.d)); P.abs = P.offset.clone().add(parentAbs(P)); }
  }
  for (const P of plan) { P.m.userData.offset = P.offset; P.m.userData.parent = P.parent; }
}
