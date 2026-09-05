/**
 * Query-driven B-rep operations — the `brep` half of the cell API.
 *
 * These are the operations a cell program calls. They differ from the ones in
 * brep.js in exactly one way, and it is the whole point of v2: where the old
 * block-graph fillet took a direction keyword ('x' | 'y' | 'z' | 'all'), these
 * take a Query. That turns "fillet the vertical edges" from a fixed enum into
 * an expression the model can compose — and, because a query re-resolves
 * against the shape it is about to modify, into one that survives a parameter
 * change.
 *
 * Every operation resolves its query against its OWN working copy of the
 * shape, never against the caller's. OCCT sub-shape identity is per-shape, so
 * resolving anywhere else would hand a fillet builder edges belonging to a
 * different solid and it would silently select nothing.
 */

import { GraphError } from './errors.js';
import {
  borrowBrepShape as borrow,
  brepAttempt as attempt,
  trackBrepShape as track,
  brepKernel as kernelOf,
  brepSketchLoops,
  brepExtrude,
  brepRevolve,
  brepLoft,
  brepSweep,
  brepPolyline,
  brepSpline,
  brepHelix,
  brepOffset,
  brepDraft,
  brepCentroid,
  brepDistanceBetween,
  brepPlaneOfFace,
  brepDrawingSketch,
  requireSolid,
} from './brep.js';
import { Query } from './query.js';
import { Sketch } from './sketch.js';

/**
 * Turn a query into a replicad finder bound to `shape`.
 *
 * Refusing an empty match is deliberate. OCCT is perfectly happy to fillet zero
 * edges and hand back the original solid, which looks like success and ships a
 * part with no fillets on it. A query that matches nothing is a broken
 * reference, and it should read as one.
 */
function finderFor(query, shape, opName) {
  if (!(query instanceof Query)) {
    throw new GraphError(
      `${opName} needs a query — for example q.edges(shape).linear().along('z')`
    );
  }
  const matched = query.resolveOn(shape);
  if (!matched.length) {
    throw new GraphError(
      `${opName}: ${query.expression} matched no ${query.type}s on this shape. ` +
      'Inspect the shape\'s topology and loosen the query.'
    );
  }
  const elements = matched.map((e) => e.element);
  return { finder: (f) => f.inList(elements), count: elements.length, elements };
}

// ------------------------------------------------------------------ primitives

/** Box centred in X/Y, sitting on z = 0. `center: 'xyz'` centres it fully. */
export function box(sx, sy, sz, { center = 'xy' } = {}) {
  return attempt('box', () => {
    const rc = kernelOf();
    let s = track(rc.makeBaseBox(sx, sy, sz));
    if (String(center).includes('z')) s = track(s.translateZ(-sz / 2));
    if (!String(center).includes('x')) s = track(s.translateX(sx / 2));
    if (!String(center).includes('y')) s = track(s.translateY(sy / 2));
    return s;
  });
}

export function cylinder(radius, height, { center = '' } = {}) {
  return attempt('cylinder', () => {
    const rc = kernelOf();
    let s = track(rc.makeCylinder(radius, height));
    if (String(center).includes('z')) s = track(s.translateZ(-height / 2));
    return s;
  });
}

export function sphere(radius) {
  return attempt('sphere', () => track(kernelOf().makeSphere(radius)));
}

/** Torus about Z, centred on the origin: ring radius `major`, tube radius `minor`. */
export function torus(major, minor) {
  if (!(major > minor && minor > 0)) throw new GraphError('torus needs major > minor > 0');
  return attempt('torus', () => {
    const rc = kernelOf();
    return track(rc.drawCircle(minor).translate(major, 0).sketchOnPlane('XZ').revolve([0, 0, 1]));
  });
}

/** Cone (or frustum) sitting on z = 0: radius `r1` at the base, `r2` at height `h`. */
export function cone(r1, r2, h, { center = '' } = {}) {
  if (!(h > 0) || r1 < 0 || r2 < 0 || (r1 === 0 && r2 === 0)) {
    throw new GraphError('cone needs h > 0 and at least one non-zero radius');
  }
  return attempt('cone', () => {
    const rc = kernelOf();
    let pen = rc.draw([0, 0]);
    if (r1 > 0) pen = pen.lineTo([r1, 0]);
    pen = pen.lineTo([r2, h]);
    if (r2 > 0) pen = pen.lineTo([0, h]);
    let s = track(pen.close().sketchOnPlane('XZ').revolve([0, 0, 1]));
    if (String(center).includes('z')) s = track(s.translateZ(-h / 2));
    return s;
  });
}

// ------------------------------------------------------------------ booleans

const BOOLEAN_METHOD = { union: 'fuse', subtract: 'cut', intersect: 'intersect' };

function boolean(op, base, tools) {
  const method = BOOLEAN_METHOD[op];
  const list = (Array.isArray(tools) ? tools : [tools]).filter(Boolean);
  if (!list.length) throw new GraphError(`${op}() needs at least one shape to combine`);
  return attempt(op, () => {
    let acc = borrow(base, 'base');
    for (const tool of list) acc = track(acc[method](borrow(tool, 'tool')));
    return acc;
  });
}

export const union = (base, ...tools) => boolean('union', base, tools.flat());
export const subtract = (base, ...tools) => boolean('subtract', base, tools.flat());
export const intersect = (base, ...tools) => boolean('intersect', base, tools.flat());

// ---------------------------------------------------------------- modifiers

/**
 * Roll a ball of `radius` along every edge the query selects.
 *
 * `radius` may be a number or a function of the edge descriptor, so a variable
 * fillet ("bigger on the long edges") is one expression rather than four
 * separate operations.
 */
export function fillet(shape, query, radius) {
  if (typeof radius === 'number' && radius <= 0) {
    throw new GraphError('Fillet radius must be greater than zero');
  }
  return attempt('fillet', () => {
    const s = borrow(shape, 'shape');
    const { finder } = finderFor(query, s, 'fillet');
    return track(s.fillet(radius, finder));
  });
}

export function chamfer(shape, query, distance) {
  if (typeof distance === 'number' && distance <= 0) {
    throw new GraphError('Chamfer distance must be greater than zero');
  }
  return attempt('chamfer', () => {
    const s = borrow(shape, 'shape');
    const { finder } = finderFor(query, s, 'chamfer');
    return track(s.chamfer(distance, finder));
  });
}

/**
 * Hollow the solid to a wall of `thickness`, removing the faces the query
 * selects. A null query shells it closed (a sealed void).
 */
export function shell(shape, query, thickness) {
  if (!thickness) throw new GraphError('Shell thickness cannot be zero');
  return attempt('shell', () => {
    const s = borrow(shape, 'shape');
    if (query == null) return track(s.shell(thickness));
    const { finder } = finderFor(query, s, 'shell');
    return track(s.shell(thickness, finder));
  });
}

export function translate(shape, [x, y, z]) {
  return attempt('translate', () => track(borrow(shape, 'shape').translate(x, y, z)));
}

export function rotate(shape, angle, axis = [0, 0, 1], origin = [0, 0, 0]) {
  return attempt('rotate', () => track(borrow(shape, 'shape').rotate(angle, origin, axis)));
}

export function scale(shape, factor, origin = [0, 0, 0]) {
  if (factor <= 0) throw new GraphError('Scale must be greater than zero');
  return attempt('scale', () => track(borrow(shape, 'shape').scale(factor, origin)));
}

export function mirror(shape, plane = 'XY', origin = [0, 0, 0]) {
  return attempt('mirror', () => track(borrow(shape, 'shape').mirror(plane, origin)));
}

/** Rotate a shape so its +Z axis points along `dir` (no-op when dir is already +Z). */
function alignZ(shape, dir) {
  const n = Math.hypot(...dir);
  if (!(n > 0)) throw new GraphError('Direction cannot be [0, 0, 0]');
  const [x, y, z] = dir.map((c) => c / n);
  if (z > 1 - 1e-12) return shape;
  if (z < -1 + 1e-12) return track(shape.rotate(180, [0, 0, 0], [1, 0, 0]));
  const axis = [-y, x, 0]; // z × dir
  return track(shape.rotate((Math.acos(z) * 180) / Math.PI, [0, 0, 0], axis));
}

/**
 * Drill a hole into the solid from the point `at`, along `direction` (default
 * straight down: into a top face). `depth` omitted means through everything.
 * `counterbore: {diameter, depth}` and `countersink: {diameter, angle}` add
 * the recess at the surface, as Fusion's Hole does.
 */
export function hole(shape, at, diameter, {
  depth = null, direction = [0, 0, -1], counterbore = null, countersink = null,
} = {}) {
  if (!(diameter > 0)) throw new GraphError('Hole diameter must be greater than zero');
  return attempt('hole', () => {
    const s = borrow(shape, 'shape');
    const reach = depth ?? Math.hypot(...bbox(s).size) * 2;
    const lead = Math.max(1, reach * 0.01); // the tool starts above the surface so no face is coplanar
    const tools = [track(cylinder(diameter / 2, reach + lead).translateZ(-lead))];
    if (counterbore) {
      const { diameter: d, depth: cd } = counterbore;
      if (!(d > diameter && cd > 0)) throw new GraphError('counterbore needs diameter > hole diameter and depth > 0');
      tools.push(track(cylinder(d / 2, cd + lead).translateZ(-lead)));
    }
    if (countersink) {
      const { diameter: d, angle = 90 } = countersink;
      if (!(d > diameter && angle > 0 && angle < 180)) {
        throw new GraphError('countersink needs diameter > hole diameter and an angle in (0, 180)');
      }
      const cd = ((d - diameter) / 2) / Math.tan((angle * Math.PI) / 360);
      tools.push(track(cone(d / 2, diameter / 2, cd)));
      tools.push(track(cylinder(d / 2, lead).translateZ(-lead)));
    }
    // Tools are built drilling along +Z from z = 0; flip to drill along -Z, then aim and place.
    let tool = tools.reduce((acc, t) => track(acc.fuse(t)));
    tool = track(tool.rotate(180, [0, 0, 0], [1, 0, 0]));
    tool = alignZ(tool, direction.map((c) => -c));
    tool = track(tool.translate(...at));
    return track(s.cut(tool));
  });
}

/** `count` copies of the shape, each `step` further along, fused into one shape. */
export function linearPattern(shape, step, count) {
  if (!(Number.isInteger(count) && count >= 1)) throw new GraphError('linearPattern count must be a whole number ≥ 1');
  return attempt('linearPattern', () => {
    const s = borrow(shape, 'shape');
    let acc = s;
    for (let i = 1; i < count; i++) {
      acc = track(acc.fuse(track(s.clone().translate(...step.map((c) => c * i)))));
    }
    return acc;
  });
}

/** `count` copies spread over `angle` degrees about `axis` through `origin`, fused. */
export function circularPattern(shape, count, { axis = [0, 0, 1], origin = [0, 0, 0], angle = 360 } = {}) {
  if (!(Number.isInteger(count) && count >= 1)) throw new GraphError('circularPattern count must be a whole number ≥ 1');
  return attempt('circularPattern', () => {
    const s = borrow(shape, 'shape');
    const stepAngle = angle >= 360 ? 360 / count : angle / Math.max(1, count - 1);
    let acc = s;
    for (let i = 1; i < count; i++) {
      acc = track(acc.fuse(track(s.clone().rotate(stepAngle * i, origin, axis))));
    }
    return acc;
  });
}

/** Grow (or shrink, negative) every face by `distance`; Fusion's Offset Face on the whole body. */
export function offset(shape, distance) {
  return brepOffset(borrow(shape, 'shape'), distance);
}

/**
 * Draft the selected faces by `angle` degrees so the body tapers along `pull`
 * (the direction the part leaves the mould). Faces stay put on the neutral
 * plane, which passes through `neutralAt` — by default the face of the
 * bounding box that the pull direction points away from.
 */
export function draft(shape, query, angle, { pull = [0, 0, 1], neutralAt = null } = {}) {
  return attempt('draft', () => {
    const s = borrow(shape, 'shape');
    const faces = finderFor(query, s, 'draft').elements;
    let at = neutralAt;
    if (!at) {
      const { min, max } = bbox(s);
      at = pull.map((c, i) => (c < 0 ? max[i] : min[i]));
    }
    return brepDraft(s, faces, angle, pull, at);
  });
}

/** Cut the solid by a plane; returns the two halves `{ above, below }` (either may be empty). */
export function split(shape, origin, normal) {
  return attempt('split', () => {
    const s = borrow(shape, 'shape');
    const L = Math.hypot(...bbox(s).size) * 2 + 1;
    const half = (sign) => {
      let b = track(kernelOf().makeBaseBox(4 * L, 4 * L, 2 * L)); // centred in xy, z from 0
      if (sign < 0) b = track(b.translateZ(-2 * L));
      b = alignZ(b, normal);
      return track(b.translate(...origin));
    };
    return {
      above: track(s.clone().intersect(half(1))),
      below: track(s.clone().intersect(half(-1))),
    };
  });
}

// -------------------------------------------------------------- sketch -> 3D

/**
 * Solve a sketch if it has not been solved, and hand back its profile.
 *
 * Solving on demand is deliberate: a cell program reads as "draw it, dimension
 * it, extrude it", and forcing an explicit `.solve()` in the middle adds a step
 * whose only job is to be forgotten. A sketch that was already solved is left
 * alone, so a caller who wants to inspect degrees of freedom first still can.
 */
function profileOf(sketch, opName) {
  if (!(sketch instanceof Sketch)) {
    throw new GraphError(`${opName} needs a sketch — build one with sk.sketch()`);
  }
  if (!sketch.report) sketch.solve();
  return { loops: sketch.loops(), plane: sketch.plane, offset: sketch.offset || 0 };
}

/** A solved sketch as a kernel sketch value on its own plane and offset. */
function placedProfile(sketch, opName, extraOffset = 0) {
  const { loops, plane, offset } = profileOf(sketch, opName);
  return brepSketchLoops(loops, plane, offset + extraOffset);
}

/**
 * Extrude a solved sketch along its plane normal.
 *
 * `symmetric: true` centres the solid on the sketch plane instead of growing
 * from it, and `offset` slides the profile along the normal before extruding —
 * the two things a prompt asks for that a sketch's own plane cannot say.
 */
export function extrude(sketch, distance, { symmetric = false, offset = 0, twist = 0, endScale = 1 } = {}) {
  return brepExtrude(placedProfile(sketch, 'extrude', offset), distance, symmetric, { twist, endScale });
}

/** Revolve a solved sketch about `axis` through `origin`, by `angle` degrees. */
export function revolve(sketch, axis = [0, 0, 1], { offset = 0, origin = [0, 0, 0], angle = 360 } = {}) {
  return brepRevolve(placedProfile(sketch, 'revolve', offset), axis, { origin, angle });
}

/** Loft through two or more sketches, each on its own plane and offset (`s.on('XY', 30)`). */
export function loft(sketches, { ruled = false } = {}) {
  if (!Array.isArray(sketches)) throw new GraphError('loft needs an array of sketches');
  return brepLoft(sketches.map((s) => placedProfile(s, 'loft')), { ruled });
}

/** Sweep a sketch profile along a path from brep.polyline / brep.spline / brep.helix. */
export function sweep(sketch, path, { frenet = false } = {}) {
  return brepSweep(placedProfile(sketch, 'sweep'), path, { frenet });
}

/** A round tube of `radius` along the path; `wall` > 0 hollows it to that wall thickness. */
export function pipe(path, radius, { wall = 0 } = {}) {
  if (!(radius > 0)) throw new GraphError('pipe radius must be greater than zero');
  if (wall < 0 || wall >= radius) throw new GraphError('pipe wall must be between 0 and the radius');
  return attempt('pipe', () => {
    const rc = kernelOf();
    const round = (r) => brepSweep(brepDrawingSketch(rc.drawCircle(r)), path);
    const outer = round(radius);
    return wall ? track(outer.cut(round(radius - wall))) : outer;
  });
}

// ------------------------------------------------------------------- paths

export const polyline = (points) => brepPolyline(points);
export const spline = (points) => brepSpline(points);
export const helix = (radius, pitch, height, options) => brepHelix(radius, pitch, height, options);

// ------------------------------------------------------------------- planes

/** The plane of one planar face, ready for `sketch.on(plane)`. */
export function planeOf(shape, query) {
  return attempt('planeOf', () => {
    const s = borrow(shape, 'shape');
    const { elements } = finderFor(query, s, 'planeOf');
    if (elements.length !== 1) {
      throw new GraphError(`planeOf: the query matched ${elements.length} faces; it must match exactly one`);
    }
    if (elements[0].geomType !== 'PLANE') throw new GraphError('planeOf: the face is not planar');
    return brepPlaneOfFace(elements[0]);
  });
}

// ----------------------------------------------------------------- measures

export function volume(shape) {
  return attempt('volume', () => kernelOf().measureVolume(requireSolid(shape, 'shape')));
}

export function area(shape) {
  return attempt('area', () => kernelOf().measureArea(requireSolid(shape, 'shape')));
}

export function centroid(shape) {
  return brepCentroid(requireSolid(shape, 'shape'));
}

/** Exact closest distance between two shapes (0 when they touch or overlap). */
export function distance(a, b) {
  return brepDistanceBetween(requireSolid(a, 'a'), requireSolid(b, 'b'));
}

export function bbox(shape) {
  return attempt('bbox', () => {
    const b = requireSolid(shape, 'shape').boundingBox;
    const [min, max] = b.bounds;
    b.delete?.();
    return { min: [...min], max: [...max], size: [0, 1, 2].map((k) => max[k] - min[k]) };
  });
}
