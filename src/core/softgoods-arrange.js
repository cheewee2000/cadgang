// Deterministic initial placement of flat patterns around a measured avatar.
// Placement is metadata-driven: no pattern name guessing, no change to 2D geometry.

import { GraphError } from './errors.js';
const finitePositive = (v, name) => { if (!(Number.isFinite(Number(v)) && Number(v) > 0)) throw new GraphError(`Avatar ${name} must be greater than zero`); return Number(v); };

/** Return arrangement rows for patterns carrying `placement.region`. */
export function arrangePatternsAroundAvatar(patterns, avatar = {}) {
  const height = finitePositive(avatar.height ?? 1700, 'height'), chest = finitePositive(avatar.chest ?? 900, 'chest'), depth = finitePositive(avatar.depth ?? chest * 0.28, 'depth');
  const centreZ = Number(avatar.centreZ ?? height * 0.62), ease = Number(avatar.ease ?? 20);
  if (!Number.isFinite(ease) || ease < 0) throw new GraphError('Avatar ease must be non-negative');
  const radiusX = chest / (2 * Math.PI) + ease, radiusY = depth / 2 + ease, seen = new Set(), rows = [];
  const poses = {
    front: { position: [0, -radiusY, centreZ], rotation: [90, 0, 0] },
    back: { position: [0, radiusY, centreZ], rotation: [90, 0, 180] },
    left: { position: [-radiusX, 0, centreZ], rotation: [90, 0, -90] },
    right: { position: [radiusX, 0, centreZ], rotation: [90, 0, 90] },
  };
  for (const p of patterns) {
    const spec = p.placement; if (!spec) continue;
    const region = String(spec.region || ''), pose = poses[region];
    if (!pose) throw new GraphError(`Pattern '${p.id}' placement region '${region}' must be front, back, left or right`);
    const slot = `${region}:${Number(spec.layer || 0)}`; if (seen.has(slot)) throw new GraphError(`Two patterns occupy avatar placement '${slot}'; give them different layers`); seen.add(slot);
    const offset = Array.isArray(spec.offset) && spec.offset.length === 3 && spec.offset.every(Number.isFinite) ? spec.offset : [0, 0, 0];
    rows.push({ pattern: p.id, position: pose.position.map((v, i) => v + offset[i]), rotation: [...pose.rotation], layer: Number(spec.layer || 0), source: 'avatar' });
  }
  return { avatar: { height, chest, depth, centreZ, ease }, arrangement: rows };
}
