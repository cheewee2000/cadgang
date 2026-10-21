import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';

/**
 * Joints, as in Fusion 360: a body that moves on an axis instead of sitting still. The math only; the
 * viewer owns the state and the UI.
 *
 *   { id, name, type, body, parent, origin: [x,y,z], axis: [x,y,z], value, value2, pitch, min, max }
 *
 *   revolute     turns `value` degrees about the axis through `origin`
 *   slider       slides `value` mm along the axis
 *   screw        turns `value` degrees and advances pitch · value / 360 mm along the axis (right-handed:
 *                a positive turn about the axis goes along it; a negative pitch is a left-hand thread)
 *   cylindrical  turns `value` degrees and slides `value2` mm, independently
 *   ball         turns freely about the point `origin`: `rot` is the turn as Euler angles [x, y, z] in degrees
 *   planar       slides on the plane through `origin` with normal `axis` and turns about that normal:
 *                `value` degrees, `value2` / `value3` mm along the plane's own x / y (planeAxes)
 *   fixed        rides with its parent, nothing of its own
 *
 * `offset` (every type but ball) moves the body that many mm along the axis, as Fusion's joint offset: a
 * gap under a part on a face, a pin pushed further into its hole. It is not limited by min/max.
 * `align` (16 numbers, column-major, or null) is where the joint first put the body, as Fusion's joint
 * snaps the moving part onto the other: its picked face onto the parent's. The motion comes after it.
 * `body` and `parent` are part keys (`name#n`); a null parent is the ground. Origin and axis are in the
 * file's own frame, the one the geometry is in before any explode. A joint's parent carries it: the
 * pose of a body is its parent's pose followed by its own joint, so a nut on a screw on a plate follows
 * the plate. `min`/`max` (null = free) limit `value`.
 *
 * A body may have several joints: they stack in list order, each riding on the ones before it (a pin in
 * a slot slides along the slot, then turns about the pin, whose axis has slid with it). The first one's
 * parent carries the stack; the others' parents are the same. Only the first snaps (`align`).
 */
export const JOINT_TYPES = ['revolute', 'slider', 'screw', 'cylindrical', 'planar', 'ball', 'fixed'];
export const JOINT_LABEL = { revolute: 'Revolute', slider: 'Slider', screw: 'Screw', cylindrical: 'Cylindrical', planar: 'Planar', ball: 'Ball', fixed: 'Fixed' };
export const turns = (type) => type === 'revolute' || type === 'screw' || type === 'cylindrical' || type === 'planar';

/** A plane's own x and y for its normal: world x (or y, for a normal near x) laid into the plane, then n × x. */
export function planeAxes(n) {
  n = new THREE.Vector3(...n).normalize();
  const ref = Math.abs(n.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const u = ref.addScaledVector(n, -ref.dot(n)).normalize();
  return [u, n.clone().cross(u)];
}

// ISO metric coarse pitch by nominal diameter: a good first guess for a screw read off its shank.
const ISO = [[2, 0.4], [2.5, 0.45], [3, 0.5], [4, 0.7], [5, 0.8], [6, 1], [8, 1.25], [10, 1.5], [12, 1.75], [16, 2], [20, 2.5], [24, 3]];
export const pitchFor = (diameter) => ISO.reduce((b, p) => (Math.abs(p[0] - diameter) < Math.abs(b[0] - diameter) ? p : b))[1];

const num = (v, d) => (Number.isFinite(+v) && v !== null && v !== '' ? +v : d);
const vec = (v, d) => (Array.isArray(v) && v.length === 3 && v.every(Number.isFinite) ? v.map(Number) : d);

/** A joint from untrusted data (a project file, a request): known type, finite numbers, unit axis. */
export function normalizeJoint(j) {
  const type = JOINT_TYPES.includes(j?.type) ? j.type : 'revolute';
  const a = new THREE.Vector3(...vec(j?.axis, [0, 0, 1]));
  if (a.lengthSq() < 1e-12) a.set(0, 0, 1);
  a.normalize();
  const out = {
    id: String(j?.id ?? ''), name: String(j?.name ?? ''), type, body: String(j?.body ?? ''), parent: j?.parent ? String(j.parent) : null,
    origin: vec(j?.origin, [0, 0, 0]), axis: a.toArray().map((v) => +v.toFixed(6)),
    rot: vec(j?.rot, [0, 0, 0]),
    align: Array.isArray(j?.align) && j.align.length === 16 && j.align.every(Number.isFinite) ? j.align.map(Number) : null,
    value: num(j?.value, 0), value2: num(j?.value2, 0), value3: num(j?.value3, 0), offset: num(j?.offset, 0), pitch: type === 'screw' ? num(j?.pitch, 1.5) : 0,
    min: j?.min == null || j.min === '' ? null : num(j.min, null), max: j?.max == null || j.max === '' ? null : num(j.max, null),
  };
  out.value = clampValue(out, out.value);
  return out;
}

export function clampValue(j, v) {
  if (j.min != null) v = Math.max(j.min, v);
  if (j.max != null) v = Math.min(j.max, v);
  return v;
}

/** The joint's motion as a matrix in the file's frame (a point at rest → where the joint has put it). */
export function jointMatrix(j) {
  const m = motion(j);
  return j.align ? m.multiply(new THREE.Matrix4().fromArray(j.align)) : m;
}
function motion(j) {
  if (j.type === 'ball') {
    const o = new THREE.Vector3(...j.origin), q = new THREE.Quaternion().setFromEuler(new THREE.Euler(...j.rot.map(THREE.MathUtils.degToRad), 'XYZ'));
    return new THREE.Matrix4().makeTranslation(o.x, o.y, o.z).multiply(new THREE.Matrix4().makeRotationFromQuaternion(q)).multiply(new THREE.Matrix4().makeTranslation(-o.x, -o.y, -o.z));
  }
  const n = new THREE.Vector3(...j.axis).normalize(), o = new THREE.Vector3(...j.origin);
  const angle = turns(j.type) ? THREE.MathUtils.degToRad(j.value) : 0;
  const slide = j.type === 'slider' ? j.value : j.type === 'cylindrical' ? j.value2 : j.type === 'screw' ? (j.pitch * j.value) / 360 : 0;
  const t = n.clone().multiplyScalar(slide + j.offset);
  if (j.type === 'planar') { const [u, v] = planeAxes(j.axis); t.addScaledVector(u, j.value2).addScaledVector(v, j.value3); }
  const m = new THREE.Matrix4().makeTranslation(t.x, t.y, t.z);
  if (angle) {
    m.multiply(new THREE.Matrix4().makeTranslation(o.x, o.y, o.z))
      .multiply(new THREE.Matrix4().makeRotationAxis(n, angle))
      .multiply(new THREE.Matrix4().makeTranslation(-o.x, -o.y, -o.z));
  }
  return m;
}

/** Every jointed body's pose (rest → current) through its parents, its joints stacked in order. A loop in
 *  the chain is cut at the point it closes. `frames` holds, per joint id, the pose it moves from: its
 *  parent's, then the body's joints before it (what a drag turns the pointer through). */
export function solvePoses(joints) {
  const byBody = new Map();
  for (const j of joints) byBody.set(j.body, [...(byBody.get(j.body) ?? []), j]);
  const out = new Map(), busy = new Set(), frames = new Map();
  out.frames = frames;
  const pose = (key) => {
    if (out.has(key)) return out.get(key);
    const stack = byBody.get(key);
    if (!stack || busy.has(key)) return new THREE.Matrix4();
    busy.add(key);
    const m = stack[0].parent ? pose(stack[0].parent).clone() : new THREE.Matrix4();
    for (const j of stack) { frames.set(j.id, m.clone()); m.multiply(jointMatrix(j)); }
    busy.delete(key);
    out.set(key, m);
    return m;
  };
  for (const key of byBody.keys()) pose(key);
  return out;
}

/** The range a slider shows for a joint's value: its limits, else a sensible span (`size` = the model's diagonal). */
export function valueRange(j, size = 100, second = false) {
  const angular = turns(j.type) && !second;
  const span = angular ? (j.type === 'screw' ? 2160 : 360) : Math.max(size / 2, 1);
  if (second) return [-span, span].map((v) => +v.toFixed(3));   // the limits belong to `value`
  return [j.min ?? -span, j.max ?? span].map((v) => +v.toFixed(3));
}

/** Euler XYZ degrees for a quaternion: how a ball joint's turn is stored and shown. */
export const eulerOf = (q) => new THREE.Euler().setFromQuaternion(q, 'XYZ').toArray().slice(0, 3).map((r) => +THREE.MathUtils.radToDeg(r).toFixed(4));

/**
 * Drive each joint through its range (its limits, else valueRange) in `steps` and find where the parts it moves
 * run into, or come within `gap` mm of, the parts it does not move. The assembly is together (no explode); every
 * other joint stays where it is. `meshes` maps a body key to its mesh, geometry in the file frame.
 *   [{ id, name, body, range: [lo, hi], unit, current, contacts: [{ body, spans: [[a, b], ...], always, first }] }]
 * `always`: touching at every step — a pin in its bore, a part on its face: a fit, not a crash. `first`: the
 * sampled value nearest the current one where they meet. Ball and fixed joints have no one value to sweep.
 * ponytail: sampled, so a thin part can pass between steps; moving-vs-moving pairs (a stacked joint's own
 * parts) are not tested. Add both if a real assembly misses a crash.
 */
export function sweepJoints(meshes, joints, { steps = 36, gap = 0, only = null, size = 100 } = {}) {
  const bvh = new Map();
  for (const [k, m] of meshes) { m.geometry.boundsTree = new MeshBVH(m.geometry, { indirect: true }); bvh.set(k, m.geometry.boundsTree); m.geometry.computeBoundingBox(); }
  const boxAt = (k, M) => meshes.get(k).geometry.boundingBox.clone().applyMatrix4(M).expandByScalar(gap / 2);
  const out = [];
  for (const j of joints) {
    if (j.type === 'ball' || j.type === 'fixed' || (only && j.id !== only)) continue;
    const [lo, hi] = j.type === 'revolute' && j.min == null && j.max == null ? [-180, 180] : valueRange(j, size);
    const vals = Array.from({ length: steps + 1 }, (_, i) => +(lo + ((hi - lo) * i) / steps).toFixed(4));
    const poses = vals.map((v) => solvePoses(joints.map((x) => (x === j ? { ...x, value: v } : x))));
    const keys = [...meshes.keys()], I = new THREE.Matrix4();
    const at = (P, k) => P.get(k) ?? I;
    const moving = keys.filter((k) => poses.some((P) => !at(P, k).equals(at(poses[0], k))));
    const still = keys.filter((k) => !moving.includes(k));
    const hits = new Map();   // still body → [value index, ...]
    poses.forEach((P, i) => {
      for (const a of moving) for (const b of still) {
        const A = at(P, a), B = at(P, b);
        if (!boxAt(a, A).intersectsBox(boxAt(b, B))) continue;
        const BtoA = A.clone().invert().multiply(B), g = meshes.get(b).geometry;
        const touch = bvh.get(a).intersectsGeometry(g, BtoA) || (gap > 0 && bvh.get(a).closestPointToGeometry(g, BtoA, {}, {}, 0, gap));
        if (touch) hits.set(b, [...new Set([...(hits.get(b) ?? []), i])]);
      }
    });
    const contacts = [...hits].map(([b, is]) => {
      const spans = [];
      for (const i of is) { const s = spans.at(-1); if (s && s[2] === i - 1) { s[1] = vals[i]; s[2] = i; } else spans.push([vals[i], vals[i], i]); }
      const first = is.map((i) => vals[i]).sort((x, y) => Math.abs(x - j.value) - Math.abs(y - j.value))[0];
      return { body: b, spans: spans.map(([x, y]) => [x, y]), always: is.length === vals.length, first };
    });
    out.push({ id: j.id, name: j.name, body: j.body, range: [lo, hi], unit: turns(j.type) ? '°' : 'mm', current: j.value, contacts });
  }
  return out;
}
