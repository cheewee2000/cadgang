import * as THREE from 'three';

/**
 * Explode offsets, from six axis rays out of each body's centre against the bodies at least as
 * big as it (a part sits in or on something bigger, never the other way round):
 *   - touching walls on both sides of an axis with one axis fully open: a channel, slide along it
 *   - touching another body on a plane: move away perpendicular to it (sandwiched: along the stack)
 *   - the radial path out from the assembly centre blocked within the part's own size: a pocket,
 *     leave by the clearest axis and ride on the body whose wall blocked it
 *   - otherwise: out from the assembly centre along the radial
 * Sets body.userData.offset and body.userData.parent.
 */
const DIRS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].map((d) => new THREE.Vector3(...d));
const axisOf = (d) => (d.x ? 0 : d.y ? 1 : 2);

export function explodeOffsets(bodies, centre) {
  const ray = new THREE.Raycaster();
  const info = bodies.map((m) => {
    m.geometry.computeBoundingBox();
    const b = m.geometry.boundingBox;
    return { c: b.getCenter(new THREE.Vector3()), half: b.getSize(new THREE.Vector3()).multiplyScalar(0.5) };
  });
  bodies.forEach((m, i) => {
    const { c, half } = info[i], r = half.length();
    const radial = c.clone().sub(centre);
    const bigger = bodies.filter((o, j) => j !== i && info[j].half.length() >= r);
    const hit = (d) => { ray.set(c, d.clone().normalize()); return ray.intersectObjects(bigger, false)[0]; };
    const ext = (d) => Math.abs(d.x) * half.x + Math.abs(d.y) * half.y + Math.abs(d.z) * half.z;   // half-extent along d
    // ponytail: one ray per direction from the centre; sample the surface if thin parts slip through
    const rays = DIRS.map((d) => { const h = hit(d); return { d, h, free: h ? h.distance : Infinity, touch: !!h && h.distance <= ext(d) + 0.1 * r }; });
    const rideOn = (o) => { const j = bodies.indexOf(o); return info[j].half.length() > r || j < i ? o : null; };   // no cycles: bigger, ties by order
    const set = (dir, len, parent) => { m.userData.offset = dir.clone().normalize().multiplyScalar(len); m.userData.parent = parent ? rideOn(parent) : null; };
    const touching = rays.filter((x) => x.touch);
    const walled = [0, 1, 2].some((a) => touching.filter((x) => axisOf(x.d) === a).length === 2);
    const open = [0, 1, 2].filter((a) => rays.filter((x) => axisOf(x.d) === a).every((x) => x.free > 2 * r));
    if (walled && open.length === 1) {
      const a = open[0], d = new THREE.Vector3().setComponent(a, Math.sign(radial.getComponent(a)) || 1);
      return set(d, Math.max(Math.abs(radial.getComponent(a)), 2 * ext(d)), touching[0].h.object);
    }
    if (touching.length) {
      const v = new THREE.Vector3();
      for (const x of touching) v.sub(x.d);
      if (v.lengthSq() === 0) { const a = axisOf(touching[0].d); v.setComponent(a, Math.sign(radial.getComponent(a)) || 1); }
      return set(v, Math.max(Math.abs(radial.dot(v.clone().normalize())), 2 * ext(v)), null);
    }
    m.userData.offset = radial; m.userData.parent = null;
    const block = radial.lengthSq() > 1e-12 && hit(radial);
    if (!block || block.distance > 2 * r) return;
    const best = rays.reduce((a, b) => (b.free > a.free ? b : a));
    if (best.free > 2 * r) set(best.d, Math.max(radial.length(), 2 * r), block.object);
  });
}
