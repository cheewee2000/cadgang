// Deterministic initial placement of flat patterns around a measured avatar.
// Placement is metadata-driven: no pattern name guessing, no change to 2D geometry.

import { GraphError } from './errors.js';
// A flat piece is turned about x, then y, then z (degrees): web/softgoods-worker.js poses the mesh the same way.
function rotate([rx, ry, rz], [u, v]) { const r = (d) => d * Math.PI / 180; let x = u, y = v * Math.cos(r(rx)), z = v * Math.sin(r(rx)); [x, z] = [x * Math.cos(r(ry)) + z * Math.sin(r(ry)), -x * Math.sin(r(ry)) + z * Math.cos(r(ry))]; [x, y] = [x * Math.cos(r(rz)) - y * Math.sin(r(rz)), x * Math.sin(r(rz)) + y * Math.cos(r(rz))]; return [x, y, z]; }

/** What the cloth collides with: a torso, shoulders, a neck and a head, from the avatar's measurements. z is up, the front faces -y. */
export function avatarBody(avatar) {
  const { height, chest, depth, centreZ } = avatar, shoulders = Number(avatar.shoulders ?? height * 0.235), shoulderZ = height * 0.82, r = depth * 0.2;
  return { levels: { shoulder: shoulderZ, chest: centreZ, waist: height * 0.6, hip: height * 0.5 }, shapes: [
    { type: 'ellipsoid', name: 'torso', c: [0, 0, centreZ], r: [chest / (2 * Math.PI), depth / 2, height * 0.22] },
    { type: 'capsule', name: 'shoulders', a: [-shoulders / 2 + r, 0, shoulderZ - r], b: [shoulders / 2 - r, 0, shoulderZ - r], r },
    { type: 'capsule', name: 'neck', a: [0, 0, shoulderZ - r], b: [0, 0, height * 0.87], r: height * 0.034 },
    { type: 'ellipsoid', name: 'head', c: [0, 0, height * 0.935], r: [height * 0.045, height * 0.055, height * 0.065] },
  ] };
}

// Each layer starts this far (mm) outside the one under it, so a shell stands clear of its lining before the first step.
const LAYER_GAP = 10;
const finitePositive = (v, name) => { if (!(Number.isFinite(Number(v)) && Number(v) > 0)) throw new GraphError(`Avatar ${name} must be greater than zero`); return Number(v); };

/** Return arrangement rows for patterns carrying `placement.region`. Each piece is centred on its region, standing upright;
 *  `placement.anchor: 'shoulder'` instead hangs its top edge just above the shoulder line, where a shoulder seam can close over it. */
export function arrangePatternsAroundAvatar(patterns, avatar = {}) {
  const height = finitePositive(avatar.height ?? 1700, 'height'), chest = finitePositive(avatar.chest ?? 900, 'chest'), depth = finitePositive(avatar.depth ?? chest * 0.28, 'depth');
  const centreZ = Number(avatar.centreZ ?? height * 0.62), ease = Number(avatar.ease ?? 20);
  if (!Number.isFinite(ease) || ease < 0) throw new GraphError('Avatar ease must be non-negative');
  if (avatar.shoulders != null) finitePositive(avatar.shoulders, 'shoulders');
  const measured = { height, chest, depth, centreZ, ease, ...(avatar.shoulders != null ? { shoulders: Number(avatar.shoulders) } : {}) }, body = avatarBody(measured);
  const radiusX = chest / (2 * Math.PI) + ease, radiusY = depth / 2 + ease, seen = new Set(), rows = [];
  const poses = {
    front: { position: [0, -radiusY, centreZ], rotation: [90, 0, 0], out: [0, -1, 0] },
    back: { position: [0, radiusY, centreZ], rotation: [90, 0, 180], out: [0, 1, 0] },
    left: { position: [-radiusX, 0, centreZ], rotation: [90, 0, -90], out: [-1, 0, 0] },
    right: { position: [radiusX, 0, centreZ], rotation: [90, 0, 90], out: [1, 0, 0] },
  };
  for (const p of patterns) {
    const spec = p.placement; if (!spec) continue;
    const region = String(spec.region || ''), pose = poses[region];
    if (!pose) throw new GraphError(`Pattern '${p.id}' placement region '${region}' must be front, back, left or right`);
    const slot = `${region}:${Number(spec.layer || 0)}`; if (seen.has(slot)) throw new GraphError(`Two patterns occupy avatar placement '${slot}'; give them different layers`); seen.add(slot);
    const offset = Array.isArray(spec.offset) && spec.offset.length === 3 && spec.offset.every(Number.isFinite) ? spec.offset : [0, 0, 0];
    if (spec.anchor != null && !['centre', 'shoulder'].includes(spec.anchor)) throw new GraphError(`Pattern '${p.id}' placement anchor '${spec.anchor}' must be centre or shoulder`);
    const xs = (p.points || []).map((q) => q.x), ys = (p.points || []).map((q) => q.y), mid = xs.length ? [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2] : [0, 0], centre = rotate(pose.rotation, mid);
    const lift = spec.anchor === 'shoulder' ? body.levels.shoulder + 30 - (Math.max(...ys) - mid[1]) - centreZ : 0;
    rows.push({ pattern: p.id, position: pose.position.map((v, i) => +(v + offset[i] - centre[i] + (i === 2 ? lift : 0) + pose.out[i] * Number(spec.layer || 0) * LAYER_GAP).toFixed(6)), rotation: [...pose.rotation], layer: Number(spec.layer || 0), source: 'avatar' });
  }
  return { avatar: measured, arrangement: rows };
}
