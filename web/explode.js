import * as THREE from 'three';

/**
 * Explode offsets. A body slides out from the assembly centre along its own radial, unless that
 * path is blocked by another body within its own size: then it is a part in a pocket (a magnet,
 * a pin, a bearing) and it leaves along the clearest of the six axis directions instead, riding
 * on the body whose wall blocked it, so the pocket and its part move together.
 * Sets body.userData.offset and body.userData.parent.
 */
const DIRS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].map((d) => new THREE.Vector3(...d));
export function explodeOffsets(bodies, centre) {
  const ray = new THREE.Raycaster();
  for (const m of bodies) {
    m.geometry.computeBoundingBox();
    const c = m.geometry.boundingBox.getCenter(new THREE.Vector3());
    const r = m.geometry.boundingBox.getSize(new THREE.Vector3()).length() / 2;
    const radial = c.clone().sub(centre);
    const hit = (d) => { ray.set(c, d.clone().normalize()); return ray.intersectObjects(bodies.filter((o) => o !== m), false)[0]; };
    m.userData.offset = radial; m.userData.parent = null;
    const block = radial.lengthSq() > 1e-12 && hit(radial);
    if (!block || block.distance > 2 * r) continue;   // ponytail: one ray from the centre; sample the surface if thin parts slip through
    let best = { free: -1 };
    for (const d of DIRS) { const h = hit(d); const free = h ? h.distance : Infinity; if (free > best.free) best = { d, free }; }
    if (best.free <= 2 * r) continue;   // boxed in on every side: radial it is
    m.userData.offset = best.d.clone().multiplyScalar(Math.max(radial.length(), 2 * r));
    m.userData.parent = block.object;
  }
}
