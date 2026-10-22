/**
 * The move triad, as SolidWorks has it: on the selected parts, three arrows (x red, y green, z blue)
 * that slide them along that axis, and three rings that turn them about it. It keeps one size on
 * screen at any zoom and is drawn over the model. Turned on and off by its button (and Q); it shows
 * only while something is selected.
 *
 * It only draws and picks. What a drag means is the caller's: hit(e) names the handle under the
 * pointer, along(e, from) and angle(e, from) read a drag along an axis or round it.
 */
const AXES = [
  { key: 'x', dir: [1, 0, 0], color: 0xd0524c },
  { key: 'y', dir: [0, 1, 0], color: 0x56a85a },
  { key: 'z', dir: [0, 0, 1], color: 0x2a35a8 },   // a deep blue: it must read on the selection's blue
];
const HOVER = 0xffc400;

export function createTriad({ THREE, scene, getCamera, canvas }) {
  const group = new THREE.Group();
  group.name = 'move triad';
  group.renderOrder = 20;
  group.visible = false;
  scene.add(group);
  const handles = [];   // { mesh, kind: 'move' | 'turn', axis: Vector3, key, material, color }
  const mat = (color) => new THREE.MeshBasicMaterial({ color, depthTest: false, depthWrite: false, transparent: true, opacity: 0.95 });
  const pickMat = new THREE.MeshBasicMaterial({ visible: false });
  for (const a of AXES) {
    const dir = new THREE.Vector3(...a.dir), m = mat(a.color);
    // an arrow: a shaft and a cone head, along +axis from the centre; a fatter invisible rod to grab
    const arrow = new THREE.Group();
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.8, 12), m); shaft.position.y = 0.4;
    const head = new THREE.Mesh(new THREE.ConeGeometry(0.065, 0.2, 20), m); head.position.y = 0.9;
    const grab = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 1.05, 8), pickMat); grab.position.y = 0.52;
    arrow.add(shaft, head, grab);
    arrow.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    group.add(arrow);
    handles.push({ obj: arrow, pick: grab, kind: 'move', axis: dir, key: a.key, material: m, color: a.color });
    // a ring round the axis, a little inside the arrows' reach; its grab is a thicker invisible torus
    const rm = mat(a.color);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.62, 0.011, 8, 96), rm);
    const rgrab = new THREE.Mesh(new THREE.TorusGeometry(0.62, 0.09, 8, 48), pickMat);
    const r = new THREE.Group(); r.add(ring, rgrab);
    r.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);   // a torus lies in XY: its axis is z
    group.add(r);
    handles.push({ obj: r, pick: rgrab, kind: 'turn', axis: dir, key: a.key, material: rm, color: a.color });
  }
  const centre = new THREE.Mesh(new THREE.SphereGeometry(0.05, 16, 12), mat(0x3a3a38));
  group.add(centre);
  group.traverse((o) => { o.renderOrder = 20; });

  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  const aim = (e) => {
    const r = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, getCamera());
    return ray.ray;
  };
  /** Keep one size on screen: its arrows about a tenth of the view's height. */
  function scaleToView() {
    const cam = getCamera();
    const h = cam.isOrthographicCamera ? (cam.top - cam.bottom) / cam.zoom : 2 * Math.tan((cam.fov * Math.PI) / 360) * cam.position.distanceTo(group.position);
    group.scale.setScalar(h * 0.1);
  }
  let hovered = null;
  const paint = (h) => {
    if (h === hovered) return;
    if (hovered) hovered.material.color.set(hovered.color);
    hovered = h;
    if (h) h.material.color.set(HOVER);
  };

  return {
    group,
    get visible() { return group.visible; },
    /** Show it at `at` (world), or hide it (null). */
    place(at) {
      group.visible = !!at;
      if (at) { group.position.copy(at); scaleToView(); }
      else paint(null);
    },
    /** Each frame: one size on screen. */
    frame() { if (group.visible) scaleToView(); },
    /** The handle under the pointer: { kind, axis, key }, or null. */
    hit(e) {
      if (!group.visible) return null;
      group.updateMatrixWorld(true);
      ray.ray.copy(aim(e));
      const hits = ray.intersectObjects(handles.map((h) => h.pick), false);
      return hits.length ? handles.find((h) => h.pick === hits[0].object) : null;
    },
    hover(e) { paint(this.hit(e)); return hovered; },
    /** Along `axis` through `origin`: how far along it the pointer is (the closest point of the line to its ray). */
    along(e, origin, axis) {
      const r = aim(e), w0 = origin.clone().sub(r.origin);
      const b = axis.dot(r.direction), d = axis.dot(w0), ee = r.direction.dot(w0);
      const den = 1 - b * b;
      return den < 1e-6 ? null : (b * ee - d) / den;
    },
    /** Round `axis` through `origin`: the pointer's angle in that plane (radians), or null edge-on. */
    angle(e, origin, axis, ref) {
      const r = aim(e), plane = new THREE.Plane().setFromNormalAndCoplanarPoint(axis, origin);
      const p = r.intersectPlane(plane, new THREE.Vector3());
      if (!p) return null;
      const v = p.sub(origin), u = ref, w = new THREE.Vector3().crossVectors(axis, u);
      return Math.atan2(v.dot(w), v.dot(u));
    },
  };
}
