/**
 * The API a cell program sees.
 *
 * This is the whole vocabulary of v2. Where v1 had `NODE_TYPES` — a closed list
 * of blocks, where "no brep_loft entry" meant "loft is not expressible" — a cell
 * writes JavaScript against these objects, so composition, control flow, and
 * arithmetic come free and only the *primitives* are curated. Adding an
 * operation here widens what can be built without touching the document model.
 *
 * Everything handed across is frozen. Cell programs share the underlying
 * modules, and a program that could add a property to `brep` would be leaving it
 * there for every later cell in the document.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import * as ops from './ops.js';
import { turnedBounds, brepSurfacesMeet, tessellate, compoundParts, movedMesh, trackBrepShape, brepHeapBytes } from './brep.js';
import { q as queryRoot, topology, Query } from './query.js';
import { Sketch } from './sketch.js';
import * as checks from './checks.js';
import { GraphError } from './errors.js';
import { sheetMetalNamespace } from './sheetmetal.js';
import { softNamespace } from './softgoods.js';

/**
 * Shape keys. A cell's inputs carry their cell's cache key (cells.js), and every op here stamps its result
 * with a key made of the op and its arguments' keys, so two shapes with one key are the same geometry.
 * An argument that cannot be keyed (a query, whose steps are functions; a callback) leaves the
 * result unkeyed, and so is anything built from it — a part's result is keyed again by its cell.
 */
const isShape = (v) => !!v && typeof v === 'object' && typeof v.clone === 'function' && 'wrapped' in v;
let keyable = true;
// A sketch is its points, lines and constraints, plus the parameters its dimensions name (it carries every one of
// the cell's, and a knob no dimension reads must not make it a new drawing): the same drawing extrudes to the same solid.
const sketchKey = (sk) => {
  const sketch = sk.toJSON(), text = JSON.stringify(sketch.constraints);
  const read = Object.entries(sk.params ?? {}).filter(([k]) => new RegExp(`\\b${k.replace(/[^\w]/g, '\\$&')}\\b`).test(text));
  return { sketch, params: read.map(([k, x]) => [k, argKey(x)]) };
};
const argKey = (v) => {
  if (isShape(v)) { if (!v.__key) keyable = false; return v.__key; }
  if (v == null || typeof v !== 'object') { if (typeof v === 'function') keyable = false; return v; }
  if (Array.isArray(v)) return v.map(argKey);
  if (v instanceof Sketch) return sketchKey(v);
  const proto = Object.getPrototypeOf(v);   // a cell's own {center: 'xy'} comes from the sandbox's realm, so its prototype is that realm's Object
  if (proto === null || proto === Object.prototype || proto.constructor?.name === 'Object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, argKey(x)]));
  keyable = false; return null;
};
const keyOf = (op, args) => { keyable = true; const s = JSON.stringify(args.map(argKey)); return keyable ? crypto.createHash('sha1').update(op).update(s).digest('base64url').slice(0, 20) : null; };
// A keyed op's result is kept too (an untracked clone the memo owns; a hit hands out a tracked clone), so a
// check cell's clips and poses, which re-run on every evaluate, are lookups once made. Primitives are
// cheaper to redo than to keep, and a compound carries its parts, which a clone would not.
// ponytail: a count, not bytes — a kept copy shares its geometry with the part it was copied from, so most cost nothing;
// one cell that builds a whole assembly (40 bodies, 900 moves) needs every step kept or an edit rebuilds them all.
// Over 1 GB of heap the count drops to 256, so stale versions of big parts do not walk the kernel to its limit.
const SHAPE_MEMO_MAX = 4096, SHAPE_MEMO_SKIP = new Set(['box', 'cylinder', 'sphere', 'cone', 'torus', 'compound', 'plane', 'planeThrough', 'pivotPlane', 'midplane', 'axisOf']);   // a moved copy shares its geometry: cheap to keep, and a check's 86 poses cost 1 s to redo
const shapeMemo = new Map();
export function clearShapeMemo() { for (const v of shapeMemo.values()) { try { v.delete(); } catch { /* gone */ } } shapeMemo.clear(); }
const keyed = (op, fn) => (...args) => {
  const k = keyOf(op, args);
  if (k && !SHAPE_MEMO_SKIP.has(op) && shapeMemo.has(k)) {
    const kept = shapeMemo.get(k);
    if (alive(kept)) { shapeMemo.delete(k); shapeMemo.set(k, kept); const r = trackBrepShape(kept.clone()); r.__key = k; return r; }
    shapeMemo.delete(k);
  }
  const r = fn(...args);
  if (isShape(r) && k) {
    r.__key = k;
    if (!SHAPE_MEMO_SKIP.has(op)) {
      if (shapeMemo.size >= (brepHeapBytes() > 2 ** 30 ? 256 : SHAPE_MEMO_MAX)) { const [old, v] = shapeMemo.entries().next().value; shapeMemo.delete(old); try { v.delete(); } catch { /* gone */ } }
      shapeMemo.set(k, r.clone());
    }
  }
  return r;
};

/**
 * A fillet that had to be fitted (a radius reduced, an edge left sharp) says so in the cell's log, as a warning.
 * The note is kept by the shape's key, because a remembered shape comes back as a copy without it.
 */
const fitNotes = new Map();
const notedFillet = (logs) => (...args) => {
  const r = brep.fillet(...args), k = r?.__key;
  if (r?.__note && k) { if (fitNotes.size >= 1000) fitNotes.clear(); fitNotes.set(k, r.__note); }
  const note = r?.__note ?? (k ? fitNotes.get(k) : null);
  if (note) logs.push({ level: 'warn', text: note });
  return r;
};

/**
 * Measures (a clash volume, a bounding box) of a keyed shape are remembered, so a check of two parts
 * that did not change is a lookup. This is what makes an assertion cell over a whole assembly cost only
 * the pairs the edit touched: the cell itself re-runs, the kernel work does not.
 */
const MEMO_MAX = 20000;
const memo = new Map();   // op + argument keys → the number or plain object it measured
export function clearMeasureMemo() { memo.clear(); }
// A kernel keeps the memo in a file too (kernel.js names it), so a fresh kernel's clash checks over
// unchanged parts are lookups as well: with the parts on disk (cells.js) that is the whole cold start.
let memoFile = null, memoTimer = null;
export function persistMeasureMemo(file) {
  memoFile = file;
  try { for (const [k, v] of JSON.parse(fs.readFileSync(file, 'utf8'))) memo.set(k, v); } catch { /* nothing kept yet */ }
  process.once('exit', saveMeasureMemo);   // a kernel leaving at its heap limit takes its measures with it
}
export function saveMeasureMemo() {
  clearTimeout(memoTimer); memoTimer = null;
  if (!memoFile) return;
  try { fs.mkdirSync(path.dirname(memoFile), { recursive: true }); fs.writeFileSync(memoFile, JSON.stringify([...memo])); } catch (e) { console.error(`memo: not saved: ${e.message}`); }
}
const memoSave = () => { if (memoFile && !memoTimer) memoTimer = setTimeout(saveMeasureMemo, 2000).unref(); };
const remembered = (k, make) => {
  if (memo.has(k)) { const v = memo.get(k); memo.delete(k); memo.set(k, v); return structuredClone(v); }   // re-insert: Map order is the LRU order
  const t = performance.now(), v = make();
  if (process.env.CADGANG_MEMO_DEBUG) console.error(`memo: miss ${k} ${(performance.now() - t).toFixed(1)} ms = ${JSON.stringify(v).slice(0, 40)}`);
  if (memo.size >= MEMO_MAX) memo.delete(memo.keys().next().value);
  memo.set(k, v);
  memoSave();
  return structuredClone(v);
};
const measured = (op, fn) => (...args) => {
  const k = keyOf(op, args);
  if (k == null) { if (process.env.CADGANG_MEMO_DEBUG) console.error(`memo: ${op} unkeyed (${args.map((a) => isShape(a) ? a.__key ?? 'shape?' : typeof a).join(', ')})`); return fn(...args); }
  return remembered(k, () => fn(...args));
};

// A compound remembers what went into it, so its box is the union of its parts' boxes (each a memo hit
// when that part is unchanged) instead of a coarse mesh of the whole assembly on every evaluate, and a
// clash check against it is a check against each part. A moved compound's parts are the moved parts,
// made only when something asks (a thunk).
const children = new WeakMap();
function alive(s) { try { return !s.wrapped.isDeleted(); } catch { return false; } }
/** A kept shape by its key (a tracked copy), or null: how a part made inside one cell outlives that cell's scope. */
export const keptShape = (k) => { const kept = k && shapeMemo.get(k); return kept && alive(kept) ? Object.assign(trackBrepShape(kept.clone()), { __key: k }) : null; };
const parts = (s) => {
  let kids = children.get(s);
  if (typeof kids === 'function') { kids = kids() ?? null; children.set(s, kids); }
  if (kids?.some((k) => k?.__key && !alive(k))) { kids = kids.map((k) => (k?.__key && !alive(k) ? keptShape(k.__key) : k)); children.set(s, kids); }   // built in a cell whose scope has closed
  return kids && kids.every((k) => k?.__key && alive(k)) ? kids : null;
};
const compound = keyed('compound', (...shapes) => { const r = ops.compound(...shapes); children.set(r, shapes.flat().filter(Boolean)); return r; });
const moved = (op) => {
  const move = keyed(op, ops[op]);
  return (shape, ...rest) => {
    const r = move(shape, ...rest);   // kept or fresh: either way a moved compound's parts are the moved parts
    if ((op === 'translate' || op === 'rotate') && shape?.__key && r?.__key && !moves.has(r.__key)) {
      if (moves.size >= 20000) moves.delete(moves.keys().next().value);
      moves.set(r.__key, { op, from: shape.__key, rest: rest.map((a) => (Array.isArray(a) ? [...a] : a)) });
    }
    if (children.has(shape) && !children.has(r) && !(op === 'mirror' && rest[2]?.keep)) children.set(r, () => parts(shape)?.map((k) => brep[op](k, ...rest)));
    return r;
  };
};
// A translated or rotated copy remembers its source by key, so its mesh is the source's mesh moved (brep.js tessellate).
const moves = new Map();   // moved shape's key → { op, from: the source's key, rest: the move's arguments }
movedMesh.of = (shape) => {
  const m = shape?.__key && moves.get(shape.__key);
  if (!m) return null;
  let apply;
  if (m.op === 'translate') { const [x, y, z] = m.rest[0]; apply = (a, dir) => { if (!dir) for (let i = 0; i < a.length; i += 3) { a[i] += x; a[i + 1] += y; a[i + 2] += z; } }; }
  else {
    const [deg, axis = [0, 0, 1], o = [0, 0, 0]] = m.rest, n = Math.hypot(...axis), [kx, ky, kz] = axis.map((v) => v / n), c = Math.cos(deg * Math.PI / 180), s = Math.sin(deg * Math.PI / 180);
    apply = (a, dir) => {   // Rodrigues, about the axis through o
      const [ox, oy, oz] = dir ? [0, 0, 0] : o;
      for (let i = 0; i < a.length; i += 3) {
        const x = a[i] - ox, y = a[i + 1] - oy, z = a[i + 2] - oz, d = (kx * x + ky * y + kz * z) * (1 - c);
        a[i] = ox + x * c + (ky * z - kz * y) * s + kx * d; a[i + 1] = oy + y * c + (kz * x - kx * z) * s + ky * d; a[i + 2] = oz + z * c + (kx * y - ky * x) * s + kz * d;
      }
    };
  }
  return { from: () => keptShape(m.from), apply };
};
compoundParts.of = parts;   // brep.js meshes, boxes and measures an assembly part by part
/** A cached cell result is a clone (cells.js); its parts come back by their keys, looked up when asked. */
export const childKeys = (shape) => parts(shape)?.map((k) => k.__key) ?? null;
export const adoptChildren = (shape, thunk) => children.set(shape, thunk);
const bboxOfOne = measured('bbox', ops.bbox);
const bbox = (shape) => {
  const kids = parts(shape);
  if (!kids) return bboxOfOne(shape);
  const boxes = kids.map(bbox);
  const min = [0, 1, 2].map((k) => Math.min(...boxes.map((b) => b.min[k]))), max = [0, 1, 2].map((k) => Math.max(...boxes.map((b) => b.max[k])));
  return { min, max, size: [0, 1, 2].map((k) => max[k] - min[k]) };
};
// Interference with a compound is the sum over its parts (the same number when the parts are clear of
// each other, which is what a clash check asserts), so an edit to one part re-measures its pairs only.
// Where a moved copy sits: the part it was moved from (down the whole chain of moves) and the 3×4 rigid motion from there.
const IDENT = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
const mul = (a, b) => { const r = new Array(12); for (let i = 0; i < 3; i++) for (let j = 0; j < 4; j++) r[i * 4 + j] = a[i * 4] * b[j] + a[i * 4 + 1] * b[4 + j] + a[i * 4 + 2] * b[8 + j] + (j === 3 ? a[i * 4 + 3] : 0); return r; };
const inv = (m) => { const r = [m[0], m[4], m[8], 0, m[1], m[5], m[9], 0, m[2], m[6], m[10], 0]; for (let i = 0; i < 3; i++) r[i * 4 + 3] = -(r[i * 4] * m[3] + r[i * 4 + 1] * m[7] + r[i * 4 + 2] * m[11]); return r; };
const moveMatrix = ({ op, rest }) => {
  if (op === 'translate') { const [x, y, z] = rest[0]; return [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z]; }
  const [deg, axis = [0, 0, 1], o = [0, 0, 0]] = rest, n = Math.hypot(...axis), [x, y, z] = axis.map((v) => v / n), c = Math.cos(deg * Math.PI / 180), s = Math.sin(deg * Math.PI / 180), t = 1 - c;
  const R = [t * x * x + c, t * x * y - s * z, t * x * z + s * y, 0, t * x * y + s * z, t * y * y + c, t * y * z - s * x, 0, t * x * z - s * y, t * y * z + s * x, t * z * z + c, 0];
  for (let i = 0; i < 3; i++) R[i * 4 + 3] = o[i] - (R[i * 4] * o[0] + R[i * 4 + 1] * o[1] + R[i * 4 + 2] * o[2]);   // about the axis through o
  return R;
};
const poseOf = (key) => {
  let m = IDENT;
  for (let e; (e = moves.get(key)); key = e.from) m = mul(m, e.m ??= moveMatrix(e));   // the latest move is applied last: outermost on the left
  return { base: key, m };
};
// Two parts share nothing when no face of one meets a face of the other and neither is inside the other. Most pairs a
// clash check asks about are like that (a gear turning on its pin, pose after pose), and a boolean with a 60-tooth gear
// is 40 ms whatever it finds. The kernel intersects only the faces whose boxes come near each other, so the gear costs
// its bore, not its teeth. Being inside takes one part's box inside the other's, and then a point of it inside the
// other's mesh: a part's mesh and its BVH are kept in the frame it was first made in, so every pose of it is one mesh.
// CADGANG_NEAR=0 sends every pair to the boolean.
// Tried before this and dropped: telling pairs clear by the distance between their meshes (three-mesh-bvh). It could
// only pass pairs more than 0.3 mm apart, and its queries cost more than the face test that now settles those too.
const MESH_TOL = 0.05, MESH_KEEP = 256;
const partMeshes = new Map();   // base key → { geometry, bvh, samples, tolerance }
const partMesh = (shape, pose) => {
  let m = partMeshes.get(pose.base);
  if (m) { partMeshes.delete(pose.base); partMeshes.set(pose.base, m); return m; }
  const t = tessellate(shape, { tolerance: MESH_TOL }), back = inv(pose.m), positions = Float32Array.from(t.positions);
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    for (let k = 0; k < 3; k++) positions[i + k] = back[k * 4] * x + back[k * 4 + 1] * y + back[k * 4 + 2] * z + back[k * 4 + 3];
  }
  // one point per face: with the surfaces apart a body is wholly inside the other part or wholly outside, and every body has a face
  const samples = new Float32Array(t.faces.filter((f) => f.count > 0).flatMap((f) => { const v = t.indices[f.first * 3] * 3; return [positions[v], positions[v + 1], positions[v + 2]]; }));
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(Uint32Array.from(t.indices), 1));   // a copy: the BVH reorders it
  geometry.boundsTree = new MeshBVH(geometry); geometry.computeBoundingBox();
  m = { geometry, bvh: geometry.boundsTree, samples };
  if (partMeshes.size >= MESH_KEEP) partMeshes.delete(partMeshes.keys().next().value);
  partMeshes.set(pose.base, m);
  return m;
};
const RAYS = [[0.3, 0.5, 0.81], [-0.71, 0.2, 0.67], [0.45, -0.83, 0.33]].map((d) => new THREE.Vector3(...d).normalize());
const holds = (m, points, to) => {   // is one of these points, brought into m's frame, inside m's mesh? Any of three rays crossing it an odd number of times says so
  const p = new THREE.Vector3(), ray = new THREE.Ray();
  for (let i = 0; i < points.length; i += 3) {
    p.set(points[i], points[i + 1], points[i + 2]).applyMatrix4(to);
    if (!m.geometry.boundingBox.containsPoint(p)) continue;
    for (const d of RAYS) { ray.set(p, d); if (m.bvh.raycast(ray, THREE.DoubleSide).length % 2) return true; }
  }
  return false;
};
const BOX_LONG = 0.5;   // an analytic box is at most a few tenths long
const within = (p, q) => [0, 1, 2].every((k) => q.min[k] <= p.min[k] + BOX_LONG && p.max[k] - BOX_LONG <= q.max[k]);
const surfacesApart = (a, A, b, B) => {
  try {
    if (brepSurfacesMeet(a, b)) return false;
    const P = turned(a)[0], Q = turned(b)[0];
    if (!within(P, Q) && !within(Q, P)) return true;
    const ma = partMesh(a, A), mb = partMesh(b, B), r = mul(inv(A.m), B.m), bToA = new THREE.Matrix4().set(...r, 0, 0, 0, 1);
    return !holds(ma, mb.samples, bToA) && !holds(mb, ma.samples, bToA.clone().invert());
  } catch { return false; }   // the kernel measures
};
// The volume two parts share depends only on how one sits relative to the other, so the pair is remembered by the two
// parts as first made and that relative placement: a hammer and its screw swung together through every pose of a
// check are measured once, as are two parts each moved the same way.
const interferenceOfOne = (a, b) => {
  let A = poseOf(a.__key), B = poseOf(b.__key);
  if (A.base > B.base) [A, B, a, b] = [B, A, b, a];
  const rel = (P, Q) => mul(inv(P.m), Q.m).map((v) => Math.round(v * 1e6) / 1e6 + 0).join(',');   // to a nanometre; + 0 turns -0 into 0
  let r = rel(A, B);
  if (A.base === B.base) { const back = rel(B, A); if (back < r) r = back; }   // two copies of one part: either may be the first
  return remembered(`interference|${A.base}|${B.base}|${r}`, () => {
    if (process.env.CADGANG_NEAR !== '0' && surfacesApart(a, A, b, B)) return 0;
    return ops.interference(a, b);
  });
};
// Boxes a part apart skip the boolean: the analytic boxes (a tight one meshes an imported caster for 1.5 s), in ten
// frames, since a pin beside a gear is inside the gear's own box. The pad made no difference to what is skipped (1 to 0.01 mm).
const BOX_PAD = 1;
const turned = measured('turnedbox', turnedBounds);
const apart = (a, b) => {
  if (!isShape(a) || !isShape(b) || !a.__key || !b.__key) return false;
  const P = turned(a), Q = turned(b);
  return P.some((p, i) => [0, 1, 2].some((k) => p.min[k] > Q[i].max[k] + BOX_PAD || Q[i].min[k] > p.max[k] + BOX_PAD));
};
const volumeOfOne = measured('volume', ops.volume), areaOfOne = measured('area', ops.area), bodiesOfOne = measured('bodies', ops.bodies);
const summed = (one, self) => (shape) => { const kids = parts(shape); return kids ? kids.reduce((n, k) => n + self(k), 0) : one(shape); };
const volume = summed(volumeOfOne, (k) => volume(k)), area = summed(areaOfOne, (k) => area(k)), bodies = summed(bodiesOfOne, (k) => bodies(k));
/** What a result reports (the pane, the history, Claude): each a memo hit for a part that did not change. */
export const measuresOf = (shape) => ({ volume: volume(shape), area: area(shape), bbox: bbox(shape), bodies: bodies(shape) });
const interference = (a, b) => {
  const A = parts(a), B = parts(b);
  if (!A && !B) return apart(a, b) ? 0 : a?.__key && b?.__key ? interferenceOfOne(a, b) : ops.interference(a, b);   // symmetric: one memo entry per pair
  let v = 0;
  for (const x of A ?? [a]) for (const y of B ?? [b]) v += interference(x, y);
  return v;
};

/** The `brep` namespace: primitives, booleans, modifiers, measures. */
const brep = Object.freeze({
  box: keyed('box', ops.box),
  cylinder: keyed('cylinder', ops.cylinder),
  sphere: keyed('sphere', ops.sphere),
  torus: keyed('torus', ops.torus),
  cone: keyed('cone', ops.cone),
  union: keyed('union', ops.union),
  compound,
  name: ops.name,   // a label on the same geometry: the key (and every measure of it) stays
  subtract: keyed('subtract', ops.subtract),
  intersect: keyed('intersect', ops.intersect),
  fillet: keyed('fillet', ops.fillet),
  chamfer: keyed('chamfer', ops.chamfer),
  shell: keyed('shell', ops.shell),
  translate: moved('translate'),
  scoped: ops.scoped,
  rotate: moved('rotate'),
  scale: moved('scale'),
  mirror: moved('mirror'),
  extrude: keyed('extrude', ops.extrude),
  revolve: keyed('revolve', ops.revolve),
  loft: keyed('loft', ops.loft),
  sweep: keyed('sweep', ops.sweep),
  pipe: keyed('pipe', ops.pipe),
  coil: keyed('coil', ops.coil),
  rib: keyed('rib', ops.rib),
  emboss: keyed('emboss', ops.emboss),
  thread: keyed('thread', ops.thread),
  pushPull: keyed('pushPull', ops.pushPull),
  simplify: keyed('simplify', ops.simplify),
  pathPattern: keyed('pathPattern', ops.pathPattern),
  plane: keyed('plane', ops.plane),
  planeThrough: keyed('planeThrough', ops.planeThrough),
  pivotPlane: keyed('pivotPlane', ops.pivotPlane),
  midplane: keyed('midplane', ops.midplane),
  axisOf: keyed('axisOf', ops.axisOf),
  mass: measured('mass', ops.mass),
  length: measured('length', ops.length),
  interference,
  polyline: keyed('polyline', ops.polyline),
  spline: keyed('spline', ops.spline),
  helix: keyed('helix', ops.helix),
  hole: keyed('hole', ops.hole),
  linearPattern: keyed('linearPattern', ops.linearPattern),
  circularPattern: keyed('circularPattern', ops.circularPattern),
  offset: keyed('offset', ops.offset),
  draft: keyed('draft', ops.draft),
  split: keyed('split', ops.split),
  planeOf: keyed('planeOf', ops.planeOf),
  volume,
  area,
  bbox,
  centroid: measured('centroid', ops.centroid),
  distance: measured('distance', ops.distance),
  bodies,
  importStep: keyed('importStep', ops.importStep),
});

/** The `q` namespace: face and edge queries. */
const q = Object.freeze({
  faces: (shape) => queryRoot.faces(shape),
  edges: (shape) => queryRoot.edges(shape),
});

/**
 * The `assert` namespace: claims a cell makes about the part.
 *
 * Every one MEASURES first and records the number, then throws if the number
 * misses. Recording on the way past is the whole design: a passing assertion
 * that leaves nothing behind is indistinguishable from an assertion nobody
 * wrote, and "min wall 1.84 ≥ 1.5" in the transcript is worth more than a green
 * tick. The record is kept even on failure, so the reader sees how far off it
 * was rather than only that it was.
 *
 * `sink` is the array the evaluator hands in to collect them.
 */
function assertions(sink, quick = null) {
  const record = ({ label, ok, value, limit, unit = 'mm', detail = null, message }) => {
    sink.push({ label, ok, value, limit, unit, detail });
    if (!ok && quick) quick.skipped = true;   // a quick run draws on: its clash volumes are 0, so a failure here says nothing yet
    else if (!ok) throw new GraphError(message);
    return value;
  };
  const round = (v) => (Number.isFinite(v) ? Number(v.toFixed(4)) : v);

  return Object.freeze({
    ok(condition, message) {
      return record({
        label: message || 'assertion',
        ok: Boolean(condition),
        value: null,
        limit: null,
        unit: null,
        message: message || 'Assertion failed',
      });
    },

    volumeUnder(shape, limit) {
      const v = brep.volume(shape);
      return record({
        label: 'volume under', ok: v < limit, value: round(v), limit, unit: 'mm³',
        message: `Volume ${v.toFixed(2)} mm³ is not under ${limit} mm³`,
      });
    },

    volumeOver(shape, limit) {
      const v = brep.volume(shape);
      return record({
        label: 'volume over', ok: v > limit, value: round(v), limit, unit: 'mm³',
        message: `Volume ${v.toFixed(2)} mm³ is not over ${limit} mm³`,
      });
    },

    fitsIn(shape, [x, y, z]) {
      const { size } = brep.bbox(shape);
      const over = size.map((s, i) => s - [x, y, z][i]).findIndex((d) => d > 1e-9);
      record({
        label: 'fits in', ok: over < 0, value: size.map(round), limit: [x, y, z], unit: 'mm',
        message: over < 0 ? '' :
          `Bounding box ${size.map((s) => s.toFixed(2)).join(' × ')} exceeds ${[x, y, z].join(' × ')} on ${'XYZ'[over]}`,
      });
      return size;
    },

    /** The thinnest wall anywhere on the solid must be at least `limit`. */
    minWall(shape, limit, options) {
      const t = checks.minWallThickness(shape, options);
      return record({
        label: 'min wall', ok: t.value >= limit, value: round(t.value), limit, unit: 'mm',
        detail: { at: t.at?.map(round), samples: t.samples },
        message: `Thinnest wall is ${t.value.toFixed(3)} mm, under the ${limit} mm minimum` +
          (t.at ? ` (near ${t.at.map((c) => c.toFixed(1)).join(', ')})` : ''),
      });
    },

    /** Two sets of faces or edges must stay at least `limit` apart. */
    clearance(shape, a, b, limit) {
      const c = checks.clearance(shape, a, b);
      return record({
        label: 'clearance', ok: c.value >= limit, value: round(c.value), limit, unit: 'mm',
        message: `Clearance is ${c.value.toFixed(3)} mm, under the ${limit} mm minimum`,
      });
    },

    /** The result must be ONE connected solid — a union of bodies that never touch is two. */
    singleBody(shape) {
      const n = brep.bodies(shape);
      return record({
        label: 'single body', ok: n === 1, value: n, limit: 1, unit: null,
        message: `The result is ${n} separate bodies, not one — the parts do not touch (a gap under the kernel tolerance counts as a gap)`,
      });
    },

    /** The mesh that would be exported must be closed. */
    watertight(shape) {
      const w = checks.watertight(shape);
      return record({
        label: 'watertight', ok: w.ok, value: w.ok ? 'closed' : 'open', limit: 'closed', unit: null,
        detail: { boundary: w.boundary, nonManifold: w.nonManifold, flipped: w.flipped },
        message: `Mesh is not closed: ${w.boundary} boundary edge${w.boundary === 1 ? '' : 's'}, ` +
          `${w.nonManifold} non-manifold, ${w.flipped} inconsistently wound`,
      });
    },
  });
}

/** The bare namespace, for callers with nowhere to record to (tests, v1). */
const assert = assertions([]);

/**
 * Build the argument object for one cell's program.
 *
 * `input` is the running current solid — the thing natural language keeps
 * pointing at ("subtract that from the body"). `inputs` is the same results
 * keyed by cell id, for the cases where the flow branches and a prompt has to
 * name what it means.
 */
export function cellApi({
  params = {}, input = null, inputs = {}, selections = {}, sketch = null, checked = [], flats = [], logs = null, quick = null,
}) {
  // A quick run is for the picture: a clash volume is not measured (0, and `quick.skipped` says the result is not
  // the checked one). ponytail: only brep.interference, where the time is; the assert namespace still measures.
  const own = { ...(logs && { fillet: notedFillet(logs) }), ...(quick && { interference: () => { quick.skipped = true; return 0; } }) };
  return Object.freeze({
    p: Object.freeze({ ...params }),
    brep: Object.keys(own).length ? Object.freeze({ ...brep, ...own }) : brep,
    q,
    sk: sketchNamespace(params, sketch),
    assert: assertions(checked, quick),
    sm: sheetMetalNamespace(checked, flats),
    soft: softNamespace(checked, flats),
    topology,
    input,
    inputs: Object.freeze({ ...inputs }),
    sel: selectionQueries(selections, input),
  });
}

/**
 * The `sk` namespace: 2D sketches under constraint.
 *
 * `sk.sketch()` is a fresh sketch bound to this cell's parameters, so a
 * dimension written as `'width'` follows the slider. `sk.saved()` is the same
 * sketch the person has been dragging in the canvas — the cell's stored
 * `sketch` field. A program that calls it is saying the points are the human's
 * to move, and the code's job is only to constrain and extrude them.
 */
function sketchNamespace(params, stored) {
  return Object.freeze({
    sketch: (data) => new Sketch({ ...(data || {}), params }),
    saved: () => {
      if (!stored) {
        throw new GraphError(
          'sk.saved(): this cell has no stored sketch. Build one with sk.sketch(), or draw one in the canvas.'
        );
      }
      return new Sketch({ ...stored, params });
    },
    hasSaved: () => !!stored,
  });
}

/**
 * Turn the cell's resolved picks into ordinary queries.
 *
 * A pick becomes `sel.lip` — a Query like any other, so it goes straight into
 * brep.fillet(...) and re-resolves against the shape being modified exactly the
 * way a written query does. That is the whole reason picks are stored as a kind
 * plus an anchor rather than as an index: "that edge" and "the vertical edges"
 * end up as the same kind of thing, and both survive a parameter change.
 *
 * Selections resolve against the cell's `input`. A pick is made by clicking the
 * geometry the cell is about to modify, so there is nothing else it could mean.
 */
function selectionQueries(selections, input) {
  const out = {};
  for (const [name, spec] of Object.entries(selections || {})) {
    if (!spec?.anchor) continue; // unresolved; evaluation refuses before we get here
    const root = spec.type === 'face' ? q.faces(input) : q.edges(input);
    out[name] = root.ofKind(spec.anchor.kind).nearestTo(spec.anchor);
  }
  return Object.freeze(out);
}

/**
 * Check what a cell program returned.
 *
 * A program that forgets to return leaves the previous cell's solid as the
 * document's current geometry, which reads as "my edit did nothing" — far more
 * confusing than an error naming the cell.
 */
export function checkCellResult(value, id) {
  if (value == null) {
    throw new GraphError(`Cell '${id}' returned nothing — a cell program must return a shape`);
  }
  if (value instanceof Query) {
    throw new GraphError(
      `Cell '${id}' returned a query, not a shape. Pass it to an operation such as brep.fillet(...).`
    );
  }
  if (typeof value.clone !== 'function') {
    const what = typeof value;
    throw new GraphError(`Cell '${id}' returned ${/^[aeiou]/.test(what) ? 'an' : 'a'} ${what}, not a shape`);
  }
  return value;
}

export { brep, q, assert };
