import * as THREE from 'three';

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
 *   fixed        rides with its parent, nothing of its own
 *
 * `body` and `parent` are part keys (`name#n`); a null parent is the ground. Origin and axis are in the
 * file's own frame, the one the geometry is in before any explode. A joint's parent carries it: the
 * pose of a body is its parent's pose followed by its own joint, so a nut on a screw on a plate follows
 * the plate. `min`/`max` (null = free) limit `value`.
 */
export const JOINT_TYPES = ['revolute', 'slider', 'screw', 'cylindrical', 'ball', 'fixed'];
export const JOINT_LABEL = { revolute: 'Revolute', slider: 'Slider', screw: 'Screw', cylindrical: 'Cylindrical', ball: 'Ball', fixed: 'Fixed' };
export const turns = (type) => type === 'revolute' || type === 'screw' || type === 'cylindrical';

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
    value: num(j?.value, 0), value2: num(j?.value2, 0), pitch: type === 'screw' ? num(j?.pitch, 1.5) : 0,
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
  if (j.type === 'ball') {
    const o = new THREE.Vector3(...j.origin), q = new THREE.Quaternion().setFromEuler(new THREE.Euler(...j.rot.map(THREE.MathUtils.degToRad), 'XYZ'));
    return new THREE.Matrix4().makeTranslation(o.x, o.y, o.z).multiply(new THREE.Matrix4().makeRotationFromQuaternion(q)).multiply(new THREE.Matrix4().makeTranslation(-o.x, -o.y, -o.z));
  }
  const n = new THREE.Vector3(...j.axis).normalize(), o = new THREE.Vector3(...j.origin);
  const angle = turns(j.type) ? THREE.MathUtils.degToRad(j.value) : 0;
  const slide = j.type === 'slider' ? j.value : j.type === 'cylindrical' ? j.value2 : j.type === 'screw' ? (j.pitch * j.value) / 360 : 0;
  const m = new THREE.Matrix4().makeTranslation(n.x * slide, n.y * slide, n.z * slide);
  if (angle) {
    m.multiply(new THREE.Matrix4().makeTranslation(o.x, o.y, o.z))
      .multiply(new THREE.Matrix4().makeRotationAxis(n, angle))
      .multiply(new THREE.Matrix4().makeTranslation(-o.x, -o.y, -o.z));
  }
  return m;
}

/** Every jointed body's pose (rest → current) through its parents. A loop in the chain is cut at the
 *  point it closes, and a body with two joints takes the first. */
export function solvePoses(joints) {
  const byBody = new Map();
  for (const j of joints) if (!byBody.has(j.body)) byBody.set(j.body, j);
  const out = new Map(), busy = new Set();
  const pose = (key) => {
    if (out.has(key)) return out.get(key);
    const j = byBody.get(key);
    if (!j || busy.has(key)) return new THREE.Matrix4();
    busy.add(key);
    const m = (j.parent ? pose(j.parent).clone() : new THREE.Matrix4()).multiply(jointMatrix(j));
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
