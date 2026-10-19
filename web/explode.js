import * as THREE from 'three';
import { MeshBVH, acceleratedRaycast } from 'three-mesh-bvh';
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
export function cylinders(m) {
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
    // Surface sample: a triangle's midpoint and its outward normal. Probes only cast from faces that lead the
    // travel; a face swept along its own plane (a bore wall sliding on its pin) is not in the way of anything.
    // ponytail: sample by triangle stride — dense fillets get more probes than flat faces; a thin flange with
    // two triangles may get none
    const pos = m.geometry.getAttribute('position'), idx = m.geometry.index?.array, nTri = (idx ? idx.length : pos.count) / 3;
    const step = Math.max(1, Math.floor(nTri / 64)), pts = [], tri = new THREE.Triangle();
    for (let t = 0; t < nTri; t += step) {
      const v = (k) => new THREE.Vector3().fromBufferAttribute(pos, idx ? idx[3 * t + k] : 3 * t + k);
      tri.set(v(0), v(1), v(2));
      const n = tri.getNormal(new THREE.Vector3()); if (!n.lengthSq()) continue;
      pts.push({ p: tri.getMidpoint(new THREE.Vector3()), n });
    }
    return { c: b.getCenter(new THREE.Vector3()), half, r: half.length(), cyl: cylinders(m), pts };
  });
  // Rays test front faces only, whatever material the viewer draws the bodies with (double-sided
  // shading would make every wall hit from both sides): probe meshes over the same geometry.
  // A BVH per body (indirect: the index, and so the B-rep face ranges, stay as they are). Without one every ray
  // walked every triangle: a 200k-triangle STL opened with a 90-part STEP took over three minutes.
  // Built fresh each solve: a turn of the model rewrites the geometry, and a kept tree would answer for the old pose.
  for (const m of bodies) m.geometry.boundsTree = new MeshBVH(m.geometry, { indirect: true });
  const probe = bodies.map((m) => Object.assign(new THREE.Mesh(m.geometry), { raycast: acceleratedRaycast }));
  const extOf = (half, v) => Math.abs(v.x) * half.x + Math.abs(v.y) * half.y + Math.abs(v.z) * half.z;   // half-extent along unit v
  // Probe body i's travel along d: a ray from each of its sampled surface points, front faces only, the
  // nearest hit as the gap to the first thing it would run into. One ray from the centre saw through
  // every hole on the axis — a screw's threaded its own standoff and the shell's clearance hole and called
  // "down" free where the head lands on the standoff. Origins start a hair behind the surface so a face
  // resting on another registers as a touch, not a miss.
  // skip(h): hits to look past (the lip of a hole whose pin is bigger than it)
  // lead: how square a face must face d to probe (flat faces only: 0.9)
  const hitFrom = (i, d, among, skip, lead = 0.3) => {
    d = d.clone().normalize();
    const { c, r, pts } = info[i], eps = 1e-3 * r;
    const meshes = among.map((b) => probe[bodies.indexOf(b)]);
    let best = null;
    for (const { p, n } of pts) {
      if (n.dot(d) < lead) continue;   // not a leading face
      // a hair behind the surface along the travel, and a hair inward: a point on a neighbour's edge must not
      // graze its side face (a lid's rim ran along the box's side and read as "walled")
      const o = p.clone().addScaledVector(d, -eps); if (o.distanceToSquared(c) > eps * eps) o.add(c.clone().sub(o).setLength(eps));
      ray.set(o, d);
      const h = ray.intersectObjects(meshes, false).find((h) => !skip || !skip(h));
      if (h && (!best || h.distance < best.distance)) best = h;
    }
    return best && { gap: Math.max(0, best.distance - eps), object: bodies[probe.indexOf(best.object)] };
  };
  // Contact probes, double-sided: an outward ray from just under a face meets a back face first when that face sits
  // inside another body (a head in its countersink, a thread in its tap drill), a front face within a touch when it rests on one.
  const probe2 = bodies.map((m) => Object.assign(new THREE.Mesh(m.geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide })), { raycast: acceleratedRaycast }));
  // The body a pin's shoulder bears on as it leaves along d: its faces looking back (n·d < -0.3) that rest on or sit in a
  // body other than the housing. A screw rides the lid under its head, not the standoff it threads into — riding the
  // standoff, which leaves the other way, it would sink with the board instead of coming out of the lid.
  const bearing = (i, d, housing) => {
    const { r, pts } = info[i], eps = 1e-3 * r; let best = -1;
    for (const { p, n } of pts) {
      if (n.dot(d) > -0.3) continue;
      ray.set(p.clone().addScaledVector(n, -eps), n);
      const h = ray.intersectObjects(probe2, false).find((h) => h.object !== probe2[i]);
      if (!h) continue;
      const j = probe2.indexOf(h.object);
      if (j === housing || (h.face.normal.dot(n) < 0 && h.distance > 0.1 * r + eps)) continue;   // a front face beyond a touch: not resting on it
      if (best < 0 || info[j].r > info[best].r) best = j;
    }
    return best < 0 ? null : bodies[best];
  };
  const plan = bodies.map((m, i) => {
    const { c, half, r } = info[i];
    const radial = c.clone().sub(centre);
    const bigger = bodies.filter((o, j) => j !== i && info[j].r >= r);
    const hit = (d) => hitFrom(i, d, bigger);
    const ext = (d) => extOf(half, d);
    const free = (d) => hit(d)?.gap ?? Infinity;
    const len = (d) => Math.max(Math.abs(radial.dot(d.clone().normalize())), 2 * ext(d));
    const rideOn = (o) => { const j = bodies.indexOf(o); return info[j].r > r || j < i ? o : null; };   // no cycles: bigger, ties by order
    const P = { m, i, radial, ext, len, free, hit, cands: [], dir: null, parent: null };
    // shared cylinder axes with bigger bodies: candidates first, and the rule of first resort
    for (const a of info[i].cyl) for (const j of bodies.keys()) {
      if (j === i || info[j].r < r) continue;
      for (const b of info[j].cyl) {
        // the hole may be smaller than the pin: a thread's major in its tap drill (M8 in 7.65), a press fit
        if (Math.abs(a.axis.dot(b.axis)) < 0.999 || b.r < 0.75 * a.r || b.r > 1.25 * a.r) continue;
        const off = a.c.clone().sub(b.c); off.addScaledVector(b.axis, -off.dot(b.axis));
        if (off.length() > 0.02 * a.r + 1e-6) continue;   // not on the same line
        // on the line, but is it in THIS bore? the two must overlap along the axis (the facing pocket of
        // another part shares the line and touches, but does not overlap)
        const flip = a.axis.dot(b.axis) < 0, a0 = flip ? -a.t1 : a.t0, a1 = flip ? -a.t0 : a.t1;
        if (Math.min(a1, b.t1) - Math.max(a0, b.t0) < 0.1 * (a1 - a0)) continue;
        // which end is open: ask the body that owns the bore alone (a blind pocket's floor blocks one way;
        // whatever else sits in front of the opening is moving out of the way itself)
        const plus = a.axis.clone(), minus = a.axis.clone().negate();
        // a pin bigger than its hole (a thread) is already past the lip; its teeth hitting the lip's ring is not a wall
        const lip = (h) => { const q = h.point.clone().sub(b.c); q.addScaledVector(b.axis, -q.dot(b.axis)); const rr = q.length(); return rr > 0.98 * b.r && rr < 1.05 * a.r; };
        const own = (d) => hitFrom(i, d, [bodies[j]], lip)?.gap ?? Infinity;
        const fp = own(plus), fm = own(minus);
        const d = fp > fm ? plus : fm > fp ? minus : (radial.dot(plus) >= 0 ? plus : minus);
        P.cands.push(plus, minus);
        if (!P.dir) {
          // its way out blocked on contact by something bigger (an SMT nut on its board): held there, it rides that
          // and lifts off it, the way a part leaves the face it sits on. A flat face on it: a countersunk head only
          // grazes its countersink, and comes out of it.
          const front = hitFrom(i, d, bigger.filter((o) => o !== bodies[j]), undefined, 0.9), held = front && front.gap <= 1e-3 * r;
          P.dir = held ? d.clone().negate() : d; P.parent = rideOn(held ? front.object : bearing(i, d, j) ?? bodies[j]); P.housing = bodies[j]; P.lip = lip;
        }
      }
    }
    // a ring on a smaller shaft (a washer under a screw head: wider than the screw, so the loop above never
    // paired them): along the shaft, out the freer end. Thin along the axis only — a standoff is not a ring.
    if (!P.dir) for (const a of info[i].cyl) {
      if (2 * ext(a.axis) > 2 * a.r) continue;
      const shaft = [...bodies.keys()].some((j) => j !== i && info[j].r < r && info[j].cyl.some((b) => {
        if (Math.abs(a.axis.dot(b.axis)) < 0.999 || b.r < 0.75 * a.r || b.r > 1.25 * a.r) return false;
        const off = a.c.clone().sub(b.c); off.addScaledVector(b.axis, -off.dot(b.axis));
        if (off.length() > 0.02 * a.r + 1e-6) return false;
        const t = info[i].c.clone().sub(info[j].c).dot(a.axis);   // through it: the shaft body reaches past the ring both ways
        return Math.abs(t) + ext(a.axis) < extOf(info[j].half, a.axis);
      }));
      if (!shaft) continue;
      const plus = a.axis.clone(), minus = a.axis.clone().negate(), fp = free(plus), fm = free(minus);
      P.dir = fp > fm ? plus : fm > fp ? minus : (radial.dot(plus) >= 0 ? plus : minus);
      P.cands.push(plus, minus);
      break;
    }
    P.cands.push(...DIRS);
    if (P.dir) return P;
    // ponytail: one ray per direction from the centre; sample the surface if thin parts slip through
    const rays = DIRS.map((d) => { const h = hit(d); return { d, h, free: h ? h.gap : Infinity, touch: !!h && h.gap <= 0.1 * r }; });
    const touching = rays.filter((x) => x.touch);
    // walls on both sides of an axis, both of ONE body: a slot. Two different bodies either side is a stack
    // (a standoff between the board and the lid), and a stack separates along its axis, not sideways.
    const walled = [0, 1, 2].some((a) => { const w = touching.filter((x) => axisOf(x.d) === a); return w.length === 2 && w[0].h.object === w[1].h.object; });
    const open = [0, 1, 2].filter((a) => rays.filter((x) => axisOf(x.d) === a).every((x) => x.free > 2 * r));
    if (walled && open.length === 1) {
      const a = open[0];
      P.dir = new THREE.Vector3().setComponent(a, Math.sign(radial.getComponent(a)) || 1);
      P.parent = rideOn(touching[0].h.object);
      return P;
    }
    const exits = rays.filter((x) => x.free > 2 * r);
    if (walled && exits.length === 1) {   // a blind channel, or a bore the cylinder fit did not pair: out its one open end
      P.dir = exits[0].d;
      P.parent = rideOn(touching[0].h.object);
      return P;
    }
    if (touching.length) {
      const v = new THREE.Vector3();
      for (const x of touching) v.sub(x.d);
      if (v.lengthSq() === 0) { const a = axisOf(touching[0].d); v.setComponent(a, Math.sign(radial.getComponent(a)) || 1); }
      P.dir = v.normalize();
      P.parent = rideOn(touching[0].h.object);   // a part rests on what it touches and moves with it: a screw head on a lid that slides away
      P.leave = touching.find((x) => x.d.dot(P.dir) < -0.5)?.h.object;   // what it backs away from
      return P;
    }
    const block = radial.lengthSq() > 1e-12 && hit(radial);
    if (block && block.gap <= 2 * r) {
      const best = rays.reduce((a, b) => (b.free > a.free ? b : a));
      if (best.free > 2 * r) { P.dir = best.d; P.parent = rideOn(block.object); P.radialLen = Math.max(radial.length(), 2 * r); return P; }
    }
    P.dir = radial.lengthSq() ? radial.clone().normalize() : null;   // the central body stays
    P.radialLen = radial.length(); P.fallback = true;
    return P;
  });
  for (const P of plan) P.offset = P.dir ? P.dir.clone().multiplyScalar(P.radialLen ?? P.len(P.dir)) : new THREE.Vector3();
  // A body backing away from what it rests against takes what rides on it out of that body too: a board under a
  // cover went its own thickness, and the parts on it stayed in the cover's pockets. Far enough that each rider,
  // with its own travel, clears the far face of the body left behind. Only a body wholly behind it: a part leaving
  // a shell through its side wall would cross the whole shell to its far wall.
  const span = (i, d) => { const c = info[i].c.dot(d), e = extOf(info[i].half, d); return [c - e, c + e]; };
  for (const P of plan) {
    if (!P.leave || !P.dir) continue;
    const d = P.dir.clone().normalize(), top = span(bodies.indexOf(P.leave), d)[1];
    if (top > span(P.i, d)[1] + 1e-6) continue;
    let need = P.offset.length();
    for (const R of plan) {
      const rel = new THREE.Vector3(); let x = R;   // R's travel relative to P, through its chain of rides
      for (let n = 0; x && x !== P && n < plan.length; x = x.parent && plan[bodies.indexOf(x.parent)], n++) rel.add(x.offset);
      if (x !== P) continue;
      need = Math.max(need, top - span(R.i, d)[0] - rel.dot(d));
    }
    P.offset.setLength(need);
  }
  // no collisions, judged pair by pair on relative motion (a part riding on its pocket's body moves with
  // it): seen from body Q, body P travels along P.abs - Q.abs; if that path runs into Q within the travel,
  // P takes the clearest of its candidates whose whole travel is clear of everyone. None clear, it keeps
  // the direction the rules gave it.
  const absOf = (P, seen = new Set()) => { if (!P.parent || seen.has(P)) return P.offset.clone(); seen.add(P); return P.offset.clone().add(absOf(plan[bodies.indexOf(P.parent)], seen)); };
  for (const P of plan) P.abs = absOf(P);
  const parentAbs = (P) => (P.parent ? plan[bodies.indexOf(P.parent)].abs : new THREE.Vector3());
  // does Q ride on P (through any chain)? its position is then P's plus its own, and that own travel is Q's to clear
  const ridesOn = (Q, P) => { const seen = new Set(); for (let x = Q; x && x.parent && !seen.has(x); x = plan[bodies.indexOf(x.parent)]) { seen.add(x); if (x.parent === P.m) return true; } return false; };
  // clearance of P moving by `abs`: the smallest gap left to any other body along the relative path (Infinity: none in the way)
  const clearance = (P, abs) => {
    let worst = Infinity;
    for (const Q of plan) {
      if (Q === P || ridesOn(Q, P)) continue;   // the parent too: a part leaving its pocket is judged on the relative path, which is its own offset
      const v = abs.clone().sub(Q.abs); if (v.length() < 0.1 * abs.length()) continue;   // same way, a tenth of the drift: not a collision
      if (info[P.i].c.distanceTo(info[Q.i].c) > info[P.i].r + info[Q.i].r + 2 * v.length()) continue;
      const h = hitFrom(P.i, v, [Q.m], Q.m === P.housing ? P.lip : undefined); if (!h) continue;
      worst = Math.min(worst, h.gap - 2 * v.length());   // negative: they meet before full explode
    }
    return worst;
  };
  for (const P of plan) {
    if (!P.dir) continue;
    const c0 = clearance(P, P.abs);
    if (c0 >= 0) continue;
    let best = null, far = null;
    const want = P.fallback ? new THREE.Vector3() : P.dir.clone().normalize();   // plain radial is no rule: no pull
    for (const d of P.cands) for (const ride of P.parent ? [true, false] : [false]) {   // riding, or alone if the ride is what collides
      const len = P.len(d), abs = d.clone().multiplyScalar(len); if (ride) abs.add(parentAbs(P));
      // clearest; ties toward what the rules wanted (a lens along its thread), then the shorter trip (a part boxed in
      // under a wall slid 27 mm along its board toward the radial), then the radial, then the ride. Capped: Infinity
      // plus a tie-break is Infinity, and the first axis in the list won (a button above the board went sideways).
      const clear = Math.min(clearance(P, abs), 1e6), score = clear + 1e-3 * d.dot(want) - 1e-6 * len + 1e-8 * d.dot(P.radial) + (ride ? 1e-10 : 0);
      // gap: how far it could go before hitting. ponytail: the radial term is a knife edge kept as it was (a screw under
      // a sweeping sub-board stays out along its axis by it); a proper fix sequences the sweep
      const c = { d, score, ride, len, gap: clear + 1e-3 * d.dot(P.radial) + 2 * len };
      if (!best || score > best.score) best = c;
      if (!far || c.gap > far.gap) far = c;
    }
    const take = (c, len) => { P.dir = c.d; if (!c.ride) P.parent = null; P.offset = c.d.clone().multiplyScalar(len); P.abs = P.offset.clone().add(parentAbs(P)); };
    if (best && best.score >= 0) take(best, best.len);
    // nothing is clear (a knob in its slot, a part boxed in): go the roomiest way and stop where it would hit,
    // rather than the least-bad full travel through a wall
    else if (far && far.gap > 0) take(far, Math.min(far.len, far.gap / 2));
  }
  for (const P of plan) { P.m.userData.offset = P.offset; P.m.userData.parent = P.parent; }
  for (const m of bodies) delete m.geometry.boundsTree;
}
