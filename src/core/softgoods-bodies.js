// What the cloth drapes on besides a person: the hard product a cover, bag or sleeve is made for. A design's bodies[] name
// CAD solids, each {id, source, transform?, scale?, friction?, clearance?, deflection?}; source is one of
//   { step: '/abs/part.step', body? }   a STEP, IGES or BREP file, and one solid of it by name or key ('lid#0'), else all of it
//   { model: true | '<file>', body? }   the model open in CADgang (a CAD file, or a project's live cells); the server writes in which
//   { mesh: { positions, indices } }    triangles given outright, mm
// They become {type: 'mesh'} shapes of the collision body (web/softgoods-worker.js), in mm with the CAD model's own placement:
// scale first, then transform {position, rotation: degrees about x, y, z}. A file is read once and kept by source and deflection.
// Also here: placing a piece on a body (placement {body, side | at + normal}), and the check that a piece starts outside.

import fs from 'node:fs';
import crypto from 'node:crypto';
import { GraphError } from './errors.js';
import { bodyOfAvatar, arrangeOnAvatar, rowFacing, LIMB_REGIONS } from './softgoods-avatar.js';
import { meshField } from '../../web/softgoods-sdf.js';
import { startOn, startProblem } from '../../web/softgoods-start.js';

const ID = /^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/, CAD = /\.(step|stp|iges|igs|brep)$/i, LIVE = /[\\/]cadgang[\\/]cells\.json$/;
const SIDES = { top: [[0, 0, 1], [0, 1, 0]], bottom: [[0, 0, -1], [0, 1, 0]], front: [[0, -1, 0], [0, 0, 1]], back: [[0, 1, 0], [0, 0, 1]], left: [[-1, 0, 0], [0, 0, 1]], right: [[1, 0, 0], [0, 0, 1]] };
const REGIONS = ['front', 'back', 'left', 'right', ...LIMB_REGIONS];
// A body is tessellated to this share of its box unless it says otherwise: collision needs less than the viewer's 0.0008, and the page is sent every triangle.
const DEFLECTION = 0.002, CLEARANCE = 1, MAX_NUMBERS = 3_000_000;
// A piece placed on a body starts this far (mm) off it, beyond the body's clearance, and each layer this much further.
const START_GAP = 5, LAYER_GAP = 10;
const finite = (v) => v != null && typeof v !== 'boolean' && v !== '' && Number.isFinite(Number(v));
const vec3 = (v) => Array.isArray(v) && v.length === 3 && v.every(finite);
const pathsOf = (source) => String(source.step ?? source.model).split('|');
const fileKey = (b) => JSON.stringify([pathsOf(b.source), Number(b.deflection ?? DEFLECTION)]);

/** Throws on a malformed body, placement, floor or wrapped arrangement row. Called from validateSoftgoodsDocument. */
export function validateBodies(d) {
  if (d.bodies != null && !Array.isArray(d.bodies)) throw new GraphError('bodies must be an array');
  const ids = new Set();
  for (const b of d.bodies || []) {
    if (!ID.test(String(b?.id || ''))) throw new GraphError(`body id '${b?.id}' must match ${ID}`);
    if (ids.has(b.id)) throw new GraphError(`Two bodies are named '${b.id}'`); ids.add(b.id);
    const s = b.source, kinds = s && typeof s === 'object' ? ['step', 'model', 'mesh'].filter((k) => s[k] != null) : [];
    if (kinds.length !== 1) throw new GraphError(`Body '${b.id}' source must be one of { step: '/abs/file.step' }, { model: true } or { mesh: { positions, indices } }`);
    if (s.step != null && !(typeof s.step === 'string' && /^(\/|[A-Za-z]:[\\/])/.test(s.step) && CAD.test(s.step))) throw new GraphError(`Body '${b.id}' source.step must be the absolute path of a .step, .stp, .iges, .igs or .brep file`);
    if (s.model != null && s.model !== true && !(typeof s.model === 'string' && s.model)) throw new GraphError(`Body '${b.id}' source.model must be true (the model open in CADgang) or the file it was open on`);
    if (s.body != null && (typeof s.body !== 'string' || s.mesh)) throw new GraphError(`Body '${b.id}' source.body names one solid of a file: a name or a key like 'lid#0'`);
    if (s.mesh) {
      const { positions: p, indices: t } = s.mesh;
      if (!Array.isArray(p) || p.length < 9 || p.length % 3 || !p.every((v) => typeof v === 'number' && Number.isFinite(v))) throw new GraphError(`Body '${b.id}' mesh positions must be finite numbers, three to a vertex`);
      if (!Array.isArray(t) || t.length < 3 || t.length % 3 || !t.every((v) => Number.isInteger(v) && v >= 0 && v < p.length / 3)) throw new GraphError(`Body '${b.id}' mesh indices must be vertex numbers, three to a triangle`);
      if (p.length + t.length > MAX_NUMBERS) throw new GraphError(`Body '${b.id}' mesh is too big to keep in a design (${p.length / 3} vertices): name its file with source.step`);
    }
    if (b.transform != null && !(typeof b.transform === 'object' && ['position', 'rotation'].every((k) => b.transform[k] == null || vec3(b.transform[k])))) throw new GraphError(`Body '${b.id}' transform must be { position: [x, y, z], rotation: [rx, ry, rz] }`);
    if (b.scale != null && !(finite(b.scale) && Number(b.scale) > 0)) throw new GraphError(`Body '${b.id}' scale must be positive`);
    if (b.friction != null && !(finite(b.friction) && Number(b.friction) >= 0 && Number(b.friction) <= 1)) throw new GraphError(`Body '${b.id}' friction must be between 0 and 1`);
    if (b.clearance != null && !(finite(b.clearance) && Number(b.clearance) >= 0 && Number(b.clearance) <= 100)) throw new GraphError(`Body '${b.id}' clearance must be 0 to 100 mm`);
    if (b.deflection != null && !(finite(b.deflection) && Number(b.deflection) >= 0.0002 && Number(b.deflection) <= 0.05)) throw new GraphError(`Body '${b.id}' deflection must be 0.0002 to 0.05 of the part's size`);
  }
  for (const p of d.patterns) {
    const spec = p.placement; if (spec == null) continue;
    if (spec.body == null) { if (!REGIONS.includes(spec.region)) throw new GraphError(`Pattern '${p.id}' placement region '${spec.region}' must be ${REGIONS.join(', ')}, or the placement names a body`); continue; }
    if (!ids.has(spec.body)) throw new GraphError(`Pattern '${p.id}' is placed on missing body '${spec.body}'`);
    if (spec.at != null || spec.normal != null) { if (!vec3(spec.at) || !vec3(spec.normal) || !Math.hypot(...spec.normal.map(Number)) || spec.side != null) throw new GraphError(`Pattern '${p.id}' placement on a body takes a side, or at: [x, y, z] with a normal: [x, y, z] pointing off the body`); }
    else if (!SIDES[spec.side]) throw new GraphError(`Pattern '${p.id}' placement side '${spec.side}' must be ${Object.keys(SIDES).join(', ')}`);
    if (spec.up != null && !vec3(spec.up)) throw new GraphError(`Pattern '${p.id}' placement up must be [x, y, z]`);
    if (spec.offset != null && !vec3(spec.offset)) throw new GraphError(`Pattern '${p.id}' placement offset must be [x, y, z]`);
    if (spec.layer != null && !finite(spec.layer)) throw new GraphError(`Pattern '${p.id}' placement layer must be a number`);
  }
  for (const a of d.arrangement) if (a.wrap != null && !(finite(a.wrap?.radius) && Number(a.wrap.radius) > 0 && finite(a.wrap.centre))) throw new GraphError(`Arrangement '${a.pattern}' wrap must be { radius: mm above zero, centre: the pattern x the tube is centred on }`);
  for (const a of d.arrangement) { const why = a.start != null && startProblem(a.start); if (why) throw new GraphError(`Arrangement '${a.pattern}' ${why}`); }
  const floor = d.simulation?.floor; if (floor != null && floor !== false && !finite(floor)) throw new GraphError('simulation.floor must be a height in mm, or false for no floor');
}

// ---- reading the files

// The files read so far: key (paths and deflection) → { stamp, solids: [{ key, name, positions, indices }] }. The newest KEEP stay.
const KEEP = 6, files = new Map();
/** A viewer pack (src/server/view.js pack) back into positions, indices and its bodies' triangle ranges: a live cell model arrives as one. */
function unpack(buffer) {
  const bytes = Buffer.from(buffer), at = bytes.byteOffset, head = new Uint32Array(bytes.buffer.slice(at, at + 24)), [nPos, nIdx, nFaces, nBodies, nNames, nNrm] = head; let off = at + 24;
  const take = (Type, n) => { const a = new Type(bytes.buffer.slice(off, off + n * 4)); off += n * 4; return a; };
  const positions = take(Float32Array, nPos); take(Float32Array, nNrm); const indices = take(Uint32Array, nIdx); take(Uint32Array, nFaces * 2); const ranges = take(Uint32Array, nBodies * 2), names = JSON.parse(bytes.subarray(bytes.length - nNames).toString('utf8'));
  return { positions, indices, bodies: names.map((n, i) => ({ name: typeof n === 'string' ? n : n.name, first: ranges[i * 2], count: ranges[i * 2 + 1] })) };
}
/** Each solid of a model as its own compact mesh, keyed as the viewer keys bodies: name#n, n counting solids of that name. */
function solidsOf(model, seen) {
  return (model.bodies?.length ? model.bodies : [{ first: 0, count: model.indices.length / 3, name: model.name || 'body' }]).map((b) => {
    const n = seen.get(b.name) ?? 0, map = new Map(), positions = [], indices = []; seen.set(b.name, n + 1);
    for (let i = b.first * 3; i < (b.first + b.count) * 3; i++) { const v = model.indices[i]; let to = map.get(v); if (to === undefined) { to = positions.length / 3; map.set(v, to); positions.push(model.positions[v * 3], model.positions[v * 3 + 1], model.positions[v * 3 + 2]); } indices.push(to); }
    return { key: `${b.name}#${n}`, name: b.name, positions, indices };
  });
}
/**
 * Read every file the design's bodies name that is not already in hand, or has changed on disk. Call it before building a
 * simulation input, draping or checking: those are synchronous and use what is kept here.
 * local: may this caller read files by path (src/server/view.js mayReadLocal). live(file): the pack of a project's live cells.
 */
export async function loadBodies(d, { local = true, live = null } = {}) {
  for (const b of d?.bodies || []) {
    if (b.source.mesh) continue;
    if (b.source.model === true) throw new GraphError(`Body '${b.id}' names the model open in CADgang, and none was open when the design was set: open the part, or name its file with source.step`);
    if (!local) throw new GraphError(`Body '${b.id}' is read from a file on this computer, which only the desktop app or this computer itself may ask for`);
    const key = fileKey(b), paths = pathsOf(b.source), stamps = [];
    for (const file of paths) {
      if (LIVE.test(file)) { stamps.push(`live:${Math.floor(Date.now() / 3000)}`); continue; }   // ponytail: a live model is asked for again every 3 s; follow its revision if that costs
      if (!CAD.test(file)) throw new GraphError(`Body '${b.id}': '${file}' is not a STEP, IGES or BREP file or a project's cells.json. Export the part as STEP and name it with source.step`);
      const stat = await fs.promises.stat(file).catch(() => null); if (!stat?.isFile()) throw new GraphError(`Body '${b.id}': no file '${file}'`);
      stamps.push(`${stat.mtimeMs}:${stat.size}`);
    }
    const stamp = stamps.join('|'), had = files.get(key); if (had?.stamp === stamp) { files.delete(key); files.set(key, had); continue; }
    const seen = new Map(), solids = [];
    for (const file of paths) {
      let model;
      if (LIVE.test(file)) { if (!live) throw new GraphError(`Body '${b.id}' is a project's live cells, which only the running app can build`); model = unpack(await live(file)); }
      else { const { importCadFileInWorker } = await import('./step.js'); try { model = await importCadFileInWorker(await fs.promises.readFile(file), { name: file.split(/[\\/]/).pop(), linearDeflection: Number(b.deflection ?? DEFLECTION) }); } catch (e) { throw new GraphError(`Body '${b.id}': ${e.message || e}`); } }
      solids.push(...solidsOf(model, seen));
    }
    files.delete(key); files.set(key, { stamp, solids }); while (files.size > KEEP) files.delete(files.keys().next().value);
  }
  return d;
}
/** What loadBodies has in hand for a design, to hand to another thread (primeBodies there), and its stamps, which change when a file does. */
export const loadedBodies = (d) => (d?.bodies || []).filter((b) => !b.source.mesh && files.has(fileKey(b))).map((b) => [fileKey(b), files.get(fileKey(b))]);
export const primeBodies = (entries) => { for (const [key, value] of entries || []) files.set(key, value); };
export const bodyStamps = (d) => (d?.bodies || []).map((b) => (b.source.mesh ? '' : files.get(fileKey(b))?.stamp ?? ''));
/** Every solid a file body could name: [{ key, name, triangles }]. */
export const bodySolids = (b) => (files.get(fileKey(b))?.solids || []).map((s) => ({ key: s.key, name: s.name, triangles: s.indices.length / 3 }));

// ---- the shapes

const shapes = new Map();   // what a body resolved to, by everything that decides it
/** Turn about x, then y, then z (degrees), as an arrangement row does: web/softgoods-worker.js transform. */
function turn([rx, ry, rz], [x, y, z]) { const r = (v) => v * Math.PI / 180; [y, z] = [y * Math.cos(r(rx)) - z * Math.sin(r(rx)), y * Math.sin(r(rx)) + z * Math.cos(r(rx))]; [x, z] = [x * Math.cos(r(ry)) + z * Math.sin(r(ry)), -x * Math.sin(r(ry)) + z * Math.cos(r(ry))]; [x, y] = [x * Math.cos(r(rz)) - y * Math.sin(r(rz)), x * Math.sin(r(rz)) + y * Math.cos(r(rz))]; return [x, y, z]; }
function shapeOf(b) {
  let mesh = b.source.mesh, stamp = '';
  if (!mesh) {
    const file = files.get(fileKey(b)); if (!file) throw new GraphError(`Body '${b.id}' has not been read yet: its file is loaded when the design is set or opened`);
    stamp = file.stamp;
    if (b.source.body == null) { mesh = { positions: [], indices: [] }; for (const s of file.solids) { const off = mesh.positions.length / 3; for (const v of s.positions) mesh.positions.push(v); for (const i of s.indices) mesh.indices.push(i + off); } }
    else { const named = file.solids.filter((s) => s.name === b.source.body); mesh = file.solids.find((s) => s.key === b.source.body) ?? (named.length === 1 ? named[0] : null); if (!mesh) throw new GraphError(`Body '${b.id}': no solid '${b.source.body}' in its file${named.length ? ' (the name is not unique: use a key)' : ''}. Solids: ${file.solids.map((s) => s.key).join(', ')}`); }
  }
  // ponytail: a mesh given outright is hashed whole each time it is asked for; keep big parts in files.
  const key = crypto.createHash('sha1').update(JSON.stringify([b.source.mesh ?? [fileKey(b), stamp, b.source.body ?? null], b.transform ?? null, b.scale ?? 1, b.clearance ?? null, b.friction ?? null, b.id, b.name ?? null])).digest('hex');
  if (shapes.has(key)) return shapes.get(key);
  const scale = Number(b.scale ?? 1), rotation = (b.transform?.rotation || [0, 0, 0]).map(Number), position = (b.transform?.position || [0, 0, 0]).map(Number), positions = new Array(mesh.positions.length), min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) { const p = turn(rotation, [mesh.positions[i] * scale, mesh.positions[i + 1] * scale, mesh.positions[i + 2] * scale]); for (let k = 0; k < 3; k++) { const v = +(p[k] + position[k]).toFixed(3); positions[i + k] = v; if (v < min[k]) min[k] = v; if (v > max[k]) max[k] = v; } }
  const shape = { type: 'mesh', id: b.id, name: b.name || b.id, positions, indices: Array.from(mesh.indices), clearance: Number(b.clearance ?? CLEARANCE), ...(b.friction != null ? { friction: Number(b.friction) } : {}), min, max };
  shapes.set(key, shape); while (shapes.size > 2 * KEEP) shapes.delete(shapes.keys().next().value);
  return shape;
}
/** The design's bodies as collision shapes: {type: 'mesh', id, name, positions, indices, clearance, friction?, min, max}, positions in mm in the world. */
export const bodyShapes = (d) => (d?.bodies || []).map(shapeOf);

/**
 * What the cloth collides with: the avatar's shapes, then the design's bodies. A design with neither has none (null). With bodies
 * and no avatar the floor is under the lowest body, where a product stands; simulation.floor moves it, and false takes it away.
 * Both simulation inputs are built from this (src/server/softgoods.js and src/core/softgoods-drape.js).
 */
export function collisionBody(d) {
  const avatar = d.simulation?.avatar, meshes = bodyShapes(d), floor = d.simulation?.floor;
  if (!avatar && !meshes.length) return null;
  const body = avatar ? { ...avatar, ...bodyOfAvatar(avatar) } : { shapes: [] };
  if (!meshes.length && floor == null) return body;
  return { ...body, shapes: [...body.shapes, ...meshes], floor: floor ?? (avatar ? 0 : +Math.min(...meshes.map((s) => s.min[2])).toFixed(3)) };
}

// ---- placing pieces

/** Arrangement rows for the patterns placed on a body: on a side of its box, or at a point of it with the normal there. */
export function arrangeOnBodies(d) {
  const placed = d.patterns.filter((p) => p.placement?.body != null); if (!placed.length) return [];
  const byId = new Map(bodyShapes(d).map((s) => [s.id, s]));
  return placed.map((p) => {
    const spec = p.placement, s = byId.get(spec.body), layer = Number(spec.layer || 0), gap = s.clearance + START_GAP + layer * LAYER_GAP, offset = (spec.offset || [0, 0, 0]).map(Number);
    const [normal, up] = spec.side ? SIDES[spec.side] : [spec.normal.map(Number), spec.up?.map(Number) ?? null], n = normal.map((v) => v / Math.hypot(...normal));
    const at = spec.side ? [0, 1, 2].map((k) => (n[k] > 0 ? s.max[k] : n[k] < 0 ? s.min[k] : (s.min[k] + s.max[k]) / 2)) : spec.at.map(Number);
    const { mid, size, ...row } = rowFacing(p, [0, 1, 2].map((k) => at[k] + n[k] * gap + offset[k]), n, up);
    return { ...row, layer, source: 'body' };
  });
}
/** Every placed piece's row: round the avatar when there is one, and on the bodies. Returns { avatar: the measured avatar or null, arrangement }. */
export function arrangeDesign(d, avatar) {
  const onAvatar = avatar ? arrangeOnAvatar(d.patterns, avatar) : { avatar: null, arrangement: [] };
  return { avatar: onAvatar.avatar, arrangement: [...onAvatar.arrangement, ...arrangeOnBodies(d)] };
}

// ---- checks

const fields = new WeakMap();
/** How deep (mm) a point is inside a shape; negative or zero outside. */
function depthIn(s, p) {
  if (s.type === 'ellipsoid') { const q = Math.hypot(...[0, 1, 2].map((k) => (p[k] - s.c[k]) / s.r[k])); return (1 - q) * Math.min(...s.r); }
  if (s.type === 'capsule') { const ab = [0, 1, 2].map((k) => s.b[k] - s.a[k]), t = Math.max(0, Math.min(1, [0, 1, 2].reduce((m, k) => m + (p[k] - s.a[k]) * ab[k], 0) / (ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2 || 1))); return s.r - Math.hypot(...[0, 1, 2].map((k) => p[k] - s.a[k] - ab[k] * t)); }
  if (s.type !== 'mesh') return 0;
  if (!fields.has(s)) fields.set(s, meshField(s.positions, s.indices));
  return -fields.get(s).at(p[0], p[1], p[2], null);
}
/** Where the flat point (u, v) of a piece starts, by its arrangement row: the solver's own transform, wrap included. */
export function startPoint([u, v], row = {}) {
  if (row.start) return startOn(row.start, u, v);
  let x = u, z = 0; if (row.wrap) { const t = (u - row.wrap.centre) / row.wrap.radius; x = row.wrap.centre + row.wrap.radius * Math.sin(t); z = row.wrap.radius * (Math.cos(t) - 1); }
  const p = turn(row.rotation || [0, 0, 0], [x, v, z]), at = row.position || [0, 0, 0]; return [p[0] + at[0], p[1] + at[1], p[2] + at[2]];
}
// A piece is told on when a point of it starts deeper in a body than this (mm): less is a touch the first step undoes.
const DEEP = 2;
/**
 * Warnings about the bodies: a piece that starts inside one (the solver pushes it out, but through whichever side is nearest,
 * so it may end up on the wrong one), and a mesh that encloses nothing. They do not fail the design's check.
 */
export function checkBodies(d) {
  let body; try { body = collisionBody(d); } catch (e) { if (!(e instanceof GraphError)) throw e; return [{ ok: false, message: e.message }]; }
  if (!body) return [];
  const out = [], rows = new Map((d.arrangement || []).map((a) => [a.pattern, a]));
  for (const s of body.shapes) if (s.type === 'mesh' && s.id != null) { depthIn(s, s.min); const f = fields.get(s); if (!f.inside) out.push({ body: s.id, ok: false, message: `Body '${s.id}' encloses no volume the cloth can find (an open surface, or thinner than ${f.cell.toFixed(1)} mm): cloth will fall through it` }); }
  for (const p of d.patterns) {
    const row = rows.get(p.id); if (!row || !p.points?.length) continue;
    // The outline's points, and those drawn in a quarter of the way toward its middle.
    const cx = p.points.reduce((n, q) => n + q.x, 0) / p.points.length, cy = p.points.reduce((n, q) => n + q.y, 0) / p.points.length, samples = p.points.flatMap((q) => [[q.x, q.y], [q.x + (cx - q.x) * 0.25, q.y + (cy - q.y) * 0.25]]).concat([[cx, cy]]);
    let worst = null;
    for (const uv of samples) { const at = startPoint(uv, row); for (const s of body.shapes) { const depth = depthIn(s, at); if (depth > DEEP && depth > (worst?.depth ?? 0)) worst = { depth, shape: s.id ?? s.name ?? s.type }; } }
    if (worst) out.push({ pattern: p.id, inside: worst.shape, depth: +worst.depth.toFixed(1), ok: false, message: `Pattern '${p.id}' starts ${worst.depth.toFixed(0)} mm inside '${worst.shape}': move it out with its placement (side, at and normal, offset or layer) or its arrangement row` });
  }
  return out;
}
