// The full avatar: a torso lofted through its hip, waist and chest girths, a neck and head, and arms and legs that pose.
// An avatar with only the first fields (height, chest, depth, shoulders, ease, centreZ) is still the four shapes of
// src/core/softgoods-arrange.js, exactly; any of FULL below makes it this one.
// Units mm, z up, the floor at 0, the body facing -y. Left and right are as seen from the front, as the left and right
// placement regions already are: left is -x.

import { GraphError } from './errors.js';
import { arrangePatternsAroundAvatar, avatarBody } from './softgoods-arrange.js';

/** Typical adult measurements by size, mm. NOT from a standard: they are round figures to start from, and any field given beside size replaces its own. */
export const SIZES = {
  XS: { height: 1680, chest: 840, waist: 700, hip: 880, shoulders: 420, armLength: 590, inseam: 770, neck: 360 },
  S: { height: 1720, chest: 900, waist: 760, hip: 920, shoulders: 440, armLength: 610, inseam: 790, neck: 375 },
  M: { height: 1760, chest: 980, waist: 840, hip: 980, shoulders: 460, armLength: 630, inseam: 810, neck: 390 },
  L: { height: 1800, chest: 1060, waist: 920, hip: 1040, shoulders: 480, armLength: 650, inseam: 830, neck: 410 },
  XL: { height: 1830, chest: 1140, waist: 1010, hip: 1110, shoulders: 500, armLength: 665, inseam: 840, neck: 430 },
};
export const POSES = {
  a: { shoulder: { abduct: 30 }, hip: { abduct: 6 } },
  t: { shoulder: { abduct: 90 }, hip: { abduct: 6 } },
  down: { shoulder: { abduct: 8 }, hip: { abduct: 6 } },
  seated: { shoulder: { abduct: 30 }, hip: { flex: 90, abduct: 6 }, knee: 90 },
};
const MEASURES = ['height', 'chest', 'waist', 'hip', 'shoulders', 'armLength', 'inseam', 'neck', 'upperArm', 'thigh'];
const FULL = ['size', 'waist', 'hip', 'neck', 'armLength', 'inseam', 'upperArm', 'thigh', 'pose', 'joints'];
const JOINTS = ['shoulder', 'elbow', 'hip', 'knee'], SIDES = { left: -1, right: 1 };
export const LIMB_REGIONS = ['left-arm', 'right-arm', 'left-leg', 'right-leg'];
/** Does this avatar ask for the full body? */
export const isFullAvatar = (avatar) => !!avatar && FULL.some((k) => avatar[k] != null);

const positive = (v, name) => { if (!(Number.isFinite(Number(v)) && Number(v) > 0)) throw new GraphError(`Avatar ${name} must be greater than zero`); return Number(v); };
const angle = (v, name) => { if (!Number.isFinite(Number(v)) || Math.abs(Number(v)) > 180) throw new GraphError(`Avatar joint ${name} must be an angle in degrees, -180 to 180`); return Number(v); };
/** A joint as {abduct, flex}: a bare number is the shoulder's lift from the side (abduct), and the bend (flex) of any other joint. */
const jointOf = (name, v) => (v == null ? {} : typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => { if (!['abduct', 'flex'].includes(k)) throw new GraphError(`Avatar joint ${name} takes abduct and flex, not '${k}'`); return [k, angle(x, `${name}.${k}`)]; })) : { [name.toLowerCase().endsWith('shoulder') ? 'abduct' : 'flex']: angle(v, name) });

/** The avatar with every measurement filled in: the size's, else in proportion to height and chest, and each given field over that. */
export function measureAvatar(avatar = {}) {
  if (avatar.size != null && !SIZES[avatar.size]) throw new GraphError(`Avatar size '${avatar.size}' is not one of ${Object.keys(SIZES).join(', ')}`);
  if (avatar.pose != null && !POSES[avatar.pose]) throw new GraphError(`Avatar pose '${avatar.pose}' is not one of ${Object.keys(POSES).join(', ')}`);
  const size = SIZES[avatar.size] || {}, height = positive(avatar.height ?? size.height ?? 1700, 'height'), chest = positive(avatar.chest ?? size.chest ?? 900, 'chest');
  const typical = { waist: chest * 0.86, hip: chest, shoulders: height * 0.26, armLength: height * 0.36, inseam: height * 0.46, neck: chest * 0.4, ...size, height, chest };
  const m = {}; for (const k of MEASURES.slice(0, 8)) m[k] = +positive(avatar[k] ?? typical[k], k).toFixed(3);
  m.upperArm = +positive(avatar.upperArm ?? m.chest * 0.31, 'upperArm').toFixed(3); m.thigh = +positive(avatar.thigh ?? m.hip * 0.58, 'thigh').toFixed(3);
  if (m.inseam > m.height * 0.6) throw new GraphError('Avatar inseam must be less than 0.6 of its height');
  const ease = Number(avatar.ease ?? 20); if (!Number.isFinite(ease) || ease < 0) throw new GraphError('Avatar ease must be non-negative');
  const joints = {}; for (const [k, v] of Object.entries(avatar.joints || {})) { if (!JOINTS.some((j) => k === j || k === `left${j[0].toUpperCase()}${j.slice(1)}` || k === `right${j[0].toUpperCase()}${j.slice(1)}`)) throw new GraphError(`Avatar joint '${k}' is not shoulder, elbow, hip or knee (or left/right of one, as leftElbow)`); joints[k] = jointOf(k, v); }
  return { ...(avatar.size ? { size: avatar.size } : {}), ...m, ...(avatar.depth != null ? { depth: positive(avatar.depth, 'depth') } : {}), ...(avatar.centreZ != null ? { centreZ: Number(avatar.centreZ) } : {}), ease, pose: avatar.pose || 'a', ...(Object.keys(joints).length ? { joints } : {}) };
}

/** Semi-axes [across, deep] of the ellipse `around` mm round: deep is `ratio` of across, or the half depth itself when given (Ramanujan's perimeter). */
function ellipse(around, ratio, deep) {
  const per = (a, b) => Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)));
  if (deep == null) { const a = around / per(1, ratio); return [a, a * ratio]; }
  let lo = 0, hi = around; for (let i = 0; i < 60; i++) { const mid = (lo + hi) / 2; if (per(mid, deep) < around) lo = mid; else hi = mid; }
  return [lo, deep];
}
const AROUND = 48;
/** One ring of the torso. With `around`, the ring is scaled until its own length is that, so a tape round the mesh reads the stated girth. */
function ring(z, [a, b], around = null) {
  const p = Array.from({ length: AROUND }, (_, i) => [a * Math.cos(2 * Math.PI * i / AROUND), b * Math.sin(2 * Math.PI * i / AROUND), z]);
  const k = around ? around / p.reduce((n, q, i) => n + Math.hypot(q[0] - p[(i + 1) % AROUND][0], q[1] - p[(i + 1) % AROUND][1]), 0) : 1;
  return p.map((q) => [q[0] * k, q[1] * k, z]);
}
const add = (a, b, k = 1) => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const R3 = (v) => v.map((x) => +x.toFixed(3));

/**
 * What the cloth collides with, from a measured avatar: shapes (a 'torso' mesh, 'neck' and limb capsules, a 'head' ellipsoid),
 * levels (the heights of shoulder, chest, waist and hip), limbs (each arm and leg's joints, for placing a sleeve or a trouser
 * leg) and girths (where the fit report takes a tape to body and garment).
 */
export function fullAvatarBody(avatar) {
  const m = measureAvatar(avatar), h = m.height, shoulderZ = h * 0.82, rArm = m.upperArm / (2 * Math.PI), rFore = rArm * 0.82, rHand = h * 0.02, rThigh = m.thigh / (2 * Math.PI), rCalf = rThigh * 0.64, rFoot = h * 0.02, rNeck = m.neck / (2 * Math.PI);
  const levels = { shoulder: shoulderZ, chest: h * 0.73, waist: h * 0.62, hip: m.inseam + h * 0.05 }, chest = ellipse(m.chest, 0.74, m.depth != null ? m.depth / 2 : null);
  // The torso's sections, bottom to top: [height, [across, deep], girth held]. Between them the half widths follow a cubic through all of them.
  const sections = [
    [m.inseam, [Math.min(2 * rThigh, ellipse(m.hip, 0.72)[0]), rThigh]], [levels.hip, ellipse(m.hip, 0.72), m.hip], [levels.waist, ellipse(m.waist, 0.76), m.waist], [levels.chest, chest, m.chest],
    [shoulderZ - rArm, [m.shoulders / 2, Math.max(rArm * 1.15, chest[1] * 0.62)]], [shoulderZ, [Math.max(m.shoulders * 0.27, rNeck * 1.4), rNeck * 1.3]], [shoulderZ + h * 0.02, [rNeck * 1.05, rNeck * 1.05]],
  ];
  const slope = (i, k) => { const a = sections[Math.max(0, i - 1)], b = sections[Math.min(sections.length - 1, i + 1)]; return (b[1][k] - a[1][k]) / (b[0] - a[0]); }, rings = [], STEPS = 5;
  for (let i = 0; i < sections.length; i++) {
    rings.push(ring(sections[i][0], sections[i][1], sections[i][2]));
    if (i + 1 < sections.length) for (let s = 1; s < STEPS; s++) { const t = s / STEPS, dz = sections[i + 1][0] - sections[i][0], mix = (k) => (2 * t ** 3 - 3 * t * t + 1) * sections[i][1][k] + (t ** 3 - 2 * t * t + t) * dz * slope(i, k) + (-2 * t ** 3 + 3 * t * t) * sections[i + 1][1][k] + (t ** 3 - t * t) * dz * slope(i + 1, k); rings.push(ring(sections[i][0] + dz * t, [mix(0), mix(1)])); }
  }
  const positions = rings.flat(), indices = [], last = (rings.length - 1) * AROUND, bottom = positions.push([0, 0, sections[0][0]]) - 1, top = positions.push([0, 0, sections.at(-1)[0]]) - 1;
  for (let j = 0; j + 1 < rings.length; j++) for (let i = 0; i < AROUND; i++) { const a = j * AROUND + i, b = j * AROUND + (i + 1) % AROUND; indices.push(a, b, a + AROUND, b, b + AROUND, a + AROUND); }
  for (let i = 0; i < AROUND; i++) indices.push(bottom, (i + 1) % AROUND, i, top, last + i, last + (i + 1) % AROUND);
  // The limbs. A direction is the sagittal angle (0 straight down, 90 forward) swung out sideways by the abduction.
  const pose = POSES[m.pose], joint = (name, side) => ({ ...jointOf(name, pose[name]), ...(m.joints?.[name] || {}), ...(m.joints?.[`${side}${name[0].toUpperCase()}${name.slice(1)}`] || {}) });
  const dir = (s, sagittal, abduct) => { const a = sagittal * Math.PI / 180, b = abduct * Math.PI / 180; return [s * Math.sin(b) * Math.cos(a), -Math.sin(a), -Math.cos(b) * Math.cos(a)]; };
  const shapes = [{ type: 'mesh', name: 'torso', positions, indices, clearance: 0 }, { type: 'capsule', name: 'neck', a: [0, 0, shoulderZ], b: [0, 0, h * 0.87], r: rNeck }, { type: 'ellipsoid', name: 'head', c: [0, 0, h * 0.935], r: [h * 0.045, h * 0.055, h * 0.065] }], limbs = {};
  for (const [side, s] of Object.entries(SIDES)) {
    const sh = joint('shoulder', side), el = joint('elbow', side), hp = joint('hip', side), kn = joint('knee', side);
    const S = [s * m.shoulders / 2, 0, shoulderZ - rArm], up = dir(s, sh.flex || 0, sh.abduct || 0), fore = dir(s, (sh.flex || 0) + (el.flex || 0), sh.abduct || 0), E = add(S, up, m.armLength * 0.55), W = add(E, fore, m.armLength * 0.45);
    const H = [s * (rThigh + 10), 0, m.inseam + rThigh * 0.6], thigh = dir(s, hp.flex || 0, hp.abduct || 0), shin = dir(s, (hp.flex || 0) - (kn.flex || 0), hp.abduct || 0), K = add(H, thigh, H[2] - h * 0.285), A = add(K, shin, h * 0.24), sole = h * 0.045 - rFoot;
    shapes.push({ type: 'capsule', name: `${side}-upper-arm`, a: S, b: E, r: rArm }, { type: 'capsule', name: `${side}-forearm`, a: E, b: W, r: rFore }, { type: 'capsule', name: `${side}-hand`, a: add(W, fore, rHand), b: add(W, fore, h * 0.105 - rHand), r: rHand },
      { type: 'capsule', name: `${side}-thigh`, a: H, b: K, r: rThigh }, { type: 'capsule', name: `${side}-calf`, a: K, b: A, r: rCalf }, { type: 'capsule', name: `${side}-foot`, a: add(A, [0, h * 0.025, -sole]), b: add(A, [0, -h * 0.105, -sole]), r: rFoot });
    limbs[`${side}-arm`] = { joints: [S, E, W], radius: rArm, out: [s, 0, 0] }; limbs[`${side}-leg`] = { joints: [H, K, A], radius: rThigh, out: [s, 0, 0], clear: +(rThigh * 0.6).toFixed(3) };
  }
  // A pose that lifts the feet (seated) lowers the whole body until its lowest point is back on the floor.
  const lowest = Math.min(...shapes.filter((q) => q.type === 'capsule').flatMap((q) => [q.a[2] - q.r, q.b[2] - q.r])), drop = Math.abs(lowest) > 1e-6 ? [0, 0, -lowest] : null;
  if (drop) { for (const q of shapes) { if (q.positions) q.positions = q.positions.map((p) => add(p, drop)); for (const k of ['a', 'b', 'c']) if (q[k]) q[k] = add(q[k], drop); } for (const l of Object.values(limbs)) l.joints = l.joints.map((p) => add(p, drop)); for (const k of Object.keys(levels)) levels[k] += drop[2]; }
  for (const q of shapes) { if (q.positions) q.positions = q.positions.flat().map((x) => +x.toFixed(3)); for (const k of ['a', 'b', 'c']) if (q[k]) q[k] = R3(q[k]); if (q.type === 'capsule') q.r = +q.r.toFixed(3); else if (q.r) q.r = R3(q.r); }
  for (const l of Object.values(limbs)) { l.joints = l.joints.map(R3); l.radius = +l.radius.toFixed(3); }
  for (const k of Object.keys(levels)) levels[k] = +levels[k].toFixed(3);
  // Where a tape goes: round the torso at a height, and square across a limb a third of the way down its upper part.
  const across = (limb) => { const [a, b] = limbs[limb].joints, n = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]); return { at: R3(add(a, [b[0] - a[0], b[1] - a[1], b[2] - a[2]], 1 / 3)), normal: R3([(b[0] - a[0]) / n, (b[1] - a[1]) / n, (b[2] - a[2]) / n]) }; };
  const girths = [...['chest', 'waist', 'hip'].map((level) => ({ level, shapes: ['torso'], at: [0, 0, levels[level]], normal: [0, 0, 1], stated: m[level] })),
    ...Object.keys(SIDES).flatMap((side) => [{ level: `${side}-upper-arm`, shapes: [`${side}-upper-arm`], ...across(`${side}-arm`), stated: m.upperArm }, { level: `${side}-thigh`, shapes: [`${side}-thigh`], ...across(`${side}-leg`), stated: m.thigh }])];
  return { levels, limbs, girths, shapes };
}

/** The body of any avatar: the full one, or the four shapes an avatar with only the first fields has always had. */
export const bodyOfAvatar = (avatar) => (isFullAvatar(avatar) ? fullAvatarBody(avatar) : avatarBody(avatar));

/** A rotation [rx, ry, rz] (degrees about x, then y, then z, as an arrangement row has it) that takes the flat piece's u, v and face to these three unit vectors. */
export function eulerOf(u, v, n) {
  const deg = (r) => +(r * 180 / Math.PI).toFixed(6), ry = Math.asin(Math.max(-1, Math.min(1, -u[2])));
  return Math.abs(Math.cos(ry)) > 1e-6 ? [deg(Math.atan2(v[2], n[2])), deg(ry), deg(Math.atan2(u[1], u[0]))] : [deg(Math.atan2(-n[1], v[1])), deg(ry), 0];
}
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]], unit = (a) => { const l = Math.hypot(...a); return l > 1e-9 ? a.map((x) => x / l) : null; };
/** An arrangement row that puts the middle of a pattern at `at`, its face looking along `normal` and its v axis as near `up` as that allows. */
export function rowFacing(pattern, at, normal, up = null, extra = {}) {
  const n = unit(normal), lean = (a) => unit(add(a, n, -(a[0] * n[0] + a[1] * n[1] + a[2] * n[2]))), v = (up && lean(up)) || lean([0, 0, 1]) || lean([0, 1, 0]), u = cross(v, n);
  const xs = (pattern.points || []).map((q) => q.x), ys = (pattern.points || []).map((q) => q.y), mid = xs.length ? [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2] : [0, 0];
  return { pattern: pattern.id, position: [0, 1, 2].map((k) => +(at[k] - u[k] * mid[0] - v[k] * mid[1]).toFixed(6)), rotation: eulerOf(u, v, n), ...extra, mid, size: xs.length ? [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)] : [0, 0] };
}

const LAYER_GAP = 10;
/**
 * Arrangement rows for the patterns placed by region on an avatar (placement.body is src/core/softgoods-bodies.js's).
 * On the full avatar front, back, left and right stand a piece off the chest, and left-arm, right-arm, left-leg and right-leg
 * wrap it into a tube round that limb, its two side edges meeting on the inside. The tube's top edge starts where it is clear of the torso:
 * at the crotch on a leg, and one and a half tube radii down an arm from the shoulder, from where an armhole seam draws it up.
 */
export function arrangeOnAvatar(patterns, avatar = {}) {
  const placed = patterns.filter((p) => p.placement && p.placement.body == null);
  if (!isFullAvatar(avatar)) { const limb = placed.find((p) => LIMB_REGIONS.includes(p.placement.region)); if (limb) throw new GraphError(`Pattern '${limb.id}' is placed on '${limb.placement.region}', which needs the full avatar: give the avatar a size or a pose`); return arrangePatternsAroundAvatar(placed, avatar); }
  const measured = measureAvatar(avatar), body = fullAvatarBody(measured), torso = body.shapes[0].positions, centreZ = measured.centreZ ?? (body.levels.chest + body.levels.waist) / 2, seen = new Set(), rows = [];
  // The chest ring is where the torso is widest across and deepest.
  let rx = 0, ry = 0; for (let i = 0; i < torso.length; i += 3) if (Math.abs(torso[i + 2] - body.levels.chest) < 0.01) { rx = Math.max(rx, torso[i]); ry = Math.max(ry, torso[i + 1]); }
  const out = { front: [0, -1, 0], back: [0, 1, 0], left: [-1, 0, 0], right: [1, 0, 0] };
  for (const p of placed) {
    const spec = p.placement, region = String(spec.region || ''), layer = Number(spec.layer || 0), slot = `${region}:${layer}`, limb = body.limbs[region];
    if (!out[region] && !limb) throw new GraphError(`Pattern '${p.id}' placement region '${region}' must be front, back, left, right, ${LIMB_REGIONS.join(', ')}`);
    if (seen.has(slot)) throw new GraphError(`Two patterns occupy avatar placement '${slot}'; give them different layers`); seen.add(slot);
    if (spec.anchor != null && !['centre', 'shoulder'].includes(spec.anchor)) throw new GraphError(`Pattern '${p.id}' placement anchor '${spec.anchor}' must be centre or shoulder`);
    const offset = Array.isArray(spec.offset) && spec.offset.length === 3 && spec.offset.every(Number.isFinite) ? spec.offset : [0, 0, 0];
    let row;
    if (limb) {
      const [from, , to] = limb.joints, along = unit([to[0] - from[0], to[1] - from[1], to[2] - from[2]]), up = along.map((x) => -x), flat = rowFacing(p, [0, 0, 0], limb.out, up), radius = flat.size[0] / (2 * Math.PI) + layer * LAYER_GAP;
      const side = unit(add(limb.out, along, -(limb.out[0] * along[0] + limb.out[1] * along[1] + limb.out[2] * along[2]))) || [0, 0, 1];
      row = rowFacing(p, add(add(add(from, along, (limb.clear ?? 1.5 * radius) + flat.size[1] / 2), side, radius), offset), side, up, { wrap: { radius: +radius.toFixed(6), centre: flat.mid[0] } });
    } else {
      const reach = (region === 'front' || region === 'back' ? ry : rx) + measured.ease + layer * LAYER_GAP, flat = rowFacing(p, [0, 0, 0], out[region]);
      const z = spec.anchor === 'shoulder' ? body.levels.shoulder + 30 - flat.size[1] / 2 : centreZ;
      row = rowFacing(p, add(add([0, 0, z], out[region], reach), offset), out[region]);
    }
    const { mid, size, ...kept } = row; rows.push({ ...kept, layer, source: 'avatar' });
  }
  return { avatar: measured, arrangement: rows };
}
