/**
 * cadgang B-rep kernel — exact solid modelling via OpenCascade (replicad + OCCT WASM).
 *
 * This is the precision half of the tool. Where sdf.js represents a solid as a
 * distance field sampled on a grid, this module represents it the way STEP
 * does: exact analytic surfaces (planes, cylinders, NURBS) trimmed by exact
 * curves and sewn into a closed shell. That is what makes real STEP export,
 * filleting, and lossless round-tripping possible.
 *
 * The two representations meet in exactly one place and in exactly one
 * direction: brepDistance() turns a B-rep solid into an SDF closure so implicit
 * blocks can consume it. There is no inverse. Once a field operation touches a
 * shape, its subtree is mesh-only — see the note on the one-way bridge in
 * brepnodes.js.
 *
 * Lifecycle: initBrep() must resolve before any op runs (WASM load, ~1s, once
 * per process). Shapes are OCCT heap objects, so every op runs inside a
 * beginBrepScope()/dispose() pair that frees the intermediates.
 */

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import v8 from 'node:v8';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { GraphError } from './errors.js';
import { buildMeshDistance } from './mesh.js';

// The `with_exceptions` build is ~the same size as `single` (10.8 MB) but lets
// us recover OCCT's own failure text ("There are no suitable edges for chamfer
// or fillet") instead of a bare heap pointer. For a CAD tool that difference is
// the whole user experience of a failed operation, so it is worth the build.
const OCCT_BUILD = 'replicad_with_exceptions';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

let rc = null; // the replicad module namespace
let OC = null; // the raw OpenCascade WASM module
let failureProto = null; // $$ template used to decode thrown OCCT pointers
let initPromise = null;

// ------------------------------------------------------------------ startup

/**
 * Load the OCCT WASM module.
 *
 * The glue emscripten emits ends in `export default Module` (ESM) but its Node
 * branch also uses `require()` and `__dirname` (CJS). Node refuses to pick a
 * format for that and throws ERR_AMBIGUOUS_MODULE_SYNTAX, so the file is copied
 * to a `.mjs` under node_modules/.cache, which settles it as ESM.
 *
 * That leaves the two CJS globals it expects, which are supplied on globalThis.
 * They have to stay in place across BOTH the import and the factory call:
 * emscripten's MODULARIZE build wraps everything in the factory, so
 * `__dirname` and `require("fs")` are read when the factory runs and the WASM
 * is fetched, not when the module is evaluated. Removing them any earlier
 * fails at exactly this point. Once the factory has resolved, the module has
 * cached its own `fs` handle and no longer needs them.
 */
async function loadOcct() {
  const srcPath = require.resolve(`replicad-opencascadejs/src/${OCCT_BUILD}.js`);
  const srcDir = path.dirname(srcPath);
  const cacheDir = path.resolve(__dirname, '../../node_modules/.cache/cadgang');
  const mjsPath = path.join(cacheDir, `${OCCT_BUILD}.mjs`);

  fs.mkdirSync(cacheDir, { recursive: true });
  const stale = !fs.existsSync(mjsPath) ||
    fs.statSync(mjsPath).mtimeMs < fs.statSync(srcPath).mtimeMs;
  if (stale) fs.copyFileSync(srcPath, mjsPath);

  const hadRequire = 'require' in globalThis;
  const hadDirname = '__dirname' in globalThis;
  globalThis.require = createRequire(srcPath);
  globalThis.__dirname = srcDir + '/';
  try {
    const factory = (await import(url.pathToFileURL(mjsPath).href)).default;
    return await factory({
      locateFile: () => path.join(srcDir, `${OCCT_BUILD}.wasm`),
      // OCCT's STEP writer prints a transfer-statistics banner to stdout on
      // every export. Route its chatter to the debug channel so it does not
      // interleave with the server log (or, worse, with MCP's stdio protocol).
      print: (msg) => process.env.CADGANG_OCCT_LOG && console.error(`[occt] ${msg}`),
      printErr: (msg) => process.env.CADGANG_OCCT_LOG && console.error(`[occt] ${msg}`),
    });
  } finally {
    if (!hadRequire) delete globalThis.require;
    if (!hadDirname) delete globalThis.__dirname;
  }
}

/**
 * Load OCCT and hand it to replicad. Idempotent and safe to call concurrently —
 * every caller awaits the same promise.
 */
export function initBrep() {
  initPromise ??= (async () => {
    // Emscripten installs process-wide 'uncaughtException'/'unhandledRejection'
    // handlers that rethrow. In a long-lived server that turns any stray
    // rejection anywhere into a crash, so we strip whatever it added.
    const before = {
      uncaughtException: process.listeners('uncaughtException').slice(),
      unhandledRejection: process.listeners('unhandledRejection').slice(),
    };

    OC = await loadOcct();
    rc = await import('replicad');
    rc.setOC(OC);

    for (const event of Object.keys(before)) {
      for (const fn of process.listeners(event)) {
        if (!before[event].includes(fn)) process.removeListener(event, fn);
      }
    }

    // Keep one live Standard_Failure so we can borrow its embind `$$` descriptor
    // when decoding a thrown pointer back into a message (see toGraphError).
    failureProto = new OC.Standard_Failure_1().$$;
    return rc;
  })();
  return initPromise;
}

/** True once the kernel is loaded and B-rep blocks can compile. */
export const brepReady = () => rc !== null;

/**
 * Size of the OCCT WASM heap in bytes, or null before the kernel loads.
 *
 * Emscripten heaps only ever grow, so this is a high-water mark: it rising
 * means OCCT genuinely needed more memory than it had, and it holding steady
 * means allocations are being reused. It is the honest signal for whether shape
 * memory is being reclaimed — process RSS is too noisy to read.
 */
export const brepHeapBytes = () => (OC?.HEAPU8 ? OC.HEAPU8.length : null);

/** Kernel diagnostics, surfaced on /api/health. */
export const brepStats = () => ({
  ready: rc !== null,
  heapBytes: brepHeapBytes(),
  gcAvailable: forceGC !== null,
  collections,
  scopesSinceCollect,
});

function kernel() {
  if (!rc) throw new GraphError('B-rep kernel is still loading — retry in a moment');
  return rc;
}

/** The replicad namespace, for modules that build on the kernel (query.js). */
export const brepKernel = kernel;

// ------------------------------------------------------------- error mapping

/**
 * OCCT compiled to WASM throws a raw heap pointer, not an Error. Rehydrate it
 * as a Standard_Failure to recover the real message; fall back to the pointer's
 * uselessness being at least labelled.
 */
function occtMessage(thrown) {
  if (typeof thrown !== 'number') return String(thrown?.message ?? thrown);
  if (!failureProto) return `OpenCascade error (code ${thrown})`;
  try {
    const wrapped = Object.create(OC.Standard_Failure.prototype);
    wrapped.$$ = { ...failureProto, ptr: thrown, count: { value: 1 } };
    return wrapped.GetMessageString() || `OpenCascade error (code ${thrown})`;
  } catch {
    return `OpenCascade error (code ${thrown})`;
  }
}

/** Wrap any kernel failure as a GraphError naming the operation that failed. */
function toGraphError(op, thrown) {
  if (thrown instanceof GraphError) return thrown;
  return new GraphError(`${op} failed: ${occtMessage(thrown)}`);
}

/** Run an OCCT call, translating its failure mode into a GraphError. */
function attempt(op, fn) {
  try {
    return fn();
  } catch (e) {
    throw toGraphError(op, e);
  }
}

// ------------------------------------------------------- shape memory scopes
//
// Every shape produced here is an object on the OCCT WASM heap; dropping the JS
// reference does not free it. A scope collects everything a compile/mesh/export
// pass allocates and frees it in one go when the pass is done.

let activeScope = null;

// --- reclaiming replicad's own intermediates -------------------------------
//
// track()/delete() only covers the shapes THIS module creates. replicad frees
// its internal intermediates (boolean algorithm objects, wires, faces) through
// a FinalizationRegistry, so they are released when V8 collects the small JS
// wrapper that owns them.
//
// That never happens often enough here. A wrapper is a few dozen bytes of JS
// holding ~100 KB of OCCT memory on the WASM heap, and V8 cannot see the WASM
// heap at all — so it feels no pressure and does not collect, while the WASM
// heap grows without bound. Measured: ~100 KB leaked per compile, growing
// linearly with no plateau over hundreds of requests.
//
// So we ask for the collection ourselves. `gc` is normally behind the
// --expose-gc CLI flag; setFlagsFromString lets us mint the handle at runtime
// and put the flag back, without the server needing special launch arguments.
//
// RESIDUAL GROWTH, measured and not fixed here: forcing collection reclaims
// what replicad's wrappers hold, but the OCCT heap still creeps upward in the
// tessellation path — ~100 MB per 800 mesh requests — and running gc() after
// EVERY single operation does not change that number. So it is not a JS
// reachability problem and no GC policy will fix it; it is inside OpenCascade's
// own allocator. /api/health reports `brep.heapBytes` so it can be watched.
// Restarting the server clears it. A worker thread recycled every N compiles
// is the real fix if it ever starts to matter.
const forceGC = (() => {
  try {
    v8.setFlagsFromString('--expose-gc');
    const gc = vm.runInNewContext('gc');
    v8.setFlagsFromString('--no-expose-gc');
    return typeof gc === 'function' ? gc : null;
  } catch {
    return null; // no handle available: fall back to V8's own schedule
  }
})();

// Collect once a burst of edits settles, with a hard backstop so sustained
// load (dragging a slider) cannot defer it forever.
const COLLECT_IDLE_MS = 250;
const COLLECT_EVERY_SCOPES = 16;

let scopesSinceCollect = 0;
let collectTimer = null;

let collections = 0;

function collectNow() {
  clearTimeout(collectTimer);
  collectTimer = null;
  scopesSinceCollect = 0;
  if (!forceGC) return;
  collections++;
  // Three passes with a turn of the loop between them. One pass is not enough:
  // the first collection is what RUNS the finalizers, and the delete() calls
  // they make only land on the WASM heap once the queued callbacks have run.
  // Measured over 300 boolean compiles: no collection grows the OCCT heap
  // 16 -> 40 MB, this holds it at 16 -> 19 MB.
  try {
    forceGC();
    setImmediate(() => {
      try {
        forceGC();
        setImmediate(() => {
          try { forceGC(); } catch { /* shutting down */ }
        });
      } catch { /* shutting down */ }
    });
  } catch { /* shutting down */ }
}

/**
 * Ask for a collection after the current burst of B-rep work settles, with a
 * scope-count backstop so sustained load cannot defer it forever.
 *
 * Scope: this reclaims the OCCT objects held by replicad's JS wrappers, which
 * is a large win — over 300 boolean compiles the OCCT heap goes 16 -> 40 MB
 * without it and 16 -> 19 MB with it. It does NOT fix everything; see the note
 * on residual growth above.
 */
function scheduleCollect() {
  if (!forceGC) return;
  if (++scopesSinceCollect >= COLLECT_EVERY_SCOPES) return void setImmediate(collectNow);
  clearTimeout(collectTimer);
  collectTimer = setTimeout(collectNow, COLLECT_IDLE_MS);
  collectTimer.unref?.(); // never hold the process open just to collect
}

/**
 * Open a shape-allocation scope. Call dispose() when the pass has finished
 * consuming its results — anything derived from a shape (a tessellation, an SDF
 * closure's BVH, a STEP buffer) is plain JS by then and outlives the scope.
 * Scopes nest; disposing restores the enclosing one.
 */
export function beginBrepScope() {
  const outer = activeScope;
  const shapes = new Set();
  activeScope = shapes;
  let disposed = false;
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      activeScope = outer;
      for (const s of shapes) {
        try { s.delete(); } catch { /* already freed by a consuming op */ }
      }
      shapes.clear();
      // Only the outermost scope schedules a collection — nested scopes are
      // still inside the same unit of work.
      if (!outer) scheduleCollect();
    },
  };
}

/** Register a shape with the active scope so it gets freed. */
function track(shape) {
  if (activeScope && shape && typeof shape.delete === 'function') activeScope.add(shape);
  return shape;
}

/** Same, for the sub-shape wrappers query.js mints while enumerating topology. */
export const trackBrepShape = track;

/**
 * replicad's operations consume their operands — `a.translate(v)` frees `a` and
 * returns a new shape. A node's result can feed several parents, so every
 * operand is cloned before it is handed to an op.
 */
function borrow(shape, slot) {
  return track(requireSolid(shape, slot).clone());
}

// Re-exported so query-driven operations (ops.js) get the same operand
// discipline and the same OCCT error translation as the ops defined here,
// without query.js and brep.js having to import each other.
export const borrowBrepShape = borrow;
export const brepAttempt = attempt;

/** True for the {kind:'sketch'} values sketch blocks emit. */
export const isSketch = (v) => v?.kind === 'sketch';

/**
 * Stand-in for "this input IS wired, but what arrived is a distance field".
 * compileNode substitutes it for a null brep on a connected slot, so the errors
 * below can tell an unwired input apart from one that crossed the bridge.
 */
export const FIELD_VALUE = Object.freeze({ kind: 'field' });
export const isField = (v) => v === FIELD_VALUE;

/**
 * Assert that a graph value is an exact B-rep solid, with an error that names
 * the actual problem — the three ways to get here are a missing wire, a sketch
 * where a solid belongs, and the one-way bridge having already been crossed.
 */
export function requireSolid(shape, slot) {
  if (!shape) throw new GraphError(`Input '${slot}' needs a connected B-rep block`);
  if (isSketch(shape)) {
    throw new GraphError(`Input '${slot}' got a 2D sketch — extrude or revolve it into a solid first`);
  }
  if (isField(shape) || typeof shape.clone !== 'function') {
    throw new GraphError(
      `Input '${slot}' is implicit (field) geometry. The bridge only runs B-rep -> field, ` +
      'so it cannot come back — keep this branch in B-rep blocks, or export it as STL.'
    );
  }
  return shape;
}

// ---------------------------------------------------------------- primitives

/** Box centred on the origin in X/Y, sitting on z = 0..height (replicad's basis). */
export function brepBox([sx, sy, sz]) {
  return attempt('box', () => track(kernel().makeBaseBox(sx, sy, sz)));
}

export function brepCylinder(radius, height) {
  return attempt('cylinder', () => track(kernel().makeCylinder(radius, height)));
}

export function brepSphere(radius) {
  return attempt('sphere', () => track(kernel().makeSphere(radius)));
}

// ------------------------------------------------------------------ sketches
//
// A sketch is a closed 2D profile plus the plane it lives on. It is NOT a solid:
// it has no volume, no distance field, and cannot be booleaned. It exists to be
// extruded or revolved.
//
// The plane is carried alongside the drawing rather than baked in, because the
// operation that consumes the sketch decides where on the plane normal to place
// it (see brepExtrude's symmetric handling).

export const SKETCH_PLANES = ['XY', 'XZ', 'YZ', 'YX', 'ZX', 'ZY'];

const isVec3 = (v) => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);

/** A plane object: {origin, normal, xDir?} — what brep.planeOf() hands back. */
const isPlaneObject = (p) => p && typeof p === 'object' && isVec3(p.origin) && isVec3(p.normal);

/** A sketch value as it flows through the graph. */
function sketchValue(drawing, plane, offset) {
  if (!SKETCH_PLANES.includes(plane) && !isPlaneObject(plane)) {
    throw new GraphError(
      `Unknown plane '${plane}'. Valid planes: ${SKETCH_PLANES.join(', ')}, or a {origin, normal} object`
    );
  }
  return { kind: 'sketch', drawing: track(drawing), plane, offset };
}

/** Place a sketch on its plane, shifted along the normal, as an OCCT Sketch. */
function placed(sketch, shift = 0) {
  if (sketch?.kind !== 'sketch') {
    throw new GraphError("Input 'profile' needs a sketch block (a 2D profile), not a solid");
  }
  const along = (sketch.offset || 0) + shift;
  if (isPlaneObject(sketch.plane)) {
    const { origin, normal, xDir = null } = sketch.plane;
    const o = origin.map((c, i) => c + normal[i] * along);
    return track(sketch.drawing.clone().sketchOnPlane(new (kernel().Plane)(o, xDir, normal)));
  }
  return track(sketch.drawing.clone().sketchOnPlane(sketch.plane, along));
}

/** The plane a planar face lies on, as a plain {origin, normal, xDir} object. */
export function brepPlaneOfFace(face) {
  return attempt('planeOf', () => {
    const pl = kernel().makePlaneFromFace(face);
    const out = {
      origin: [...pl.origin.toTuple()],
      normal: [...pl.zDir.toTuple()],
      xDir: [...pl.xDir.toTuple()],
    };
    pl.delete();
    return out;
  });
}

/** A sketch value from a raw replicad drawing on a named plane (for primitives). */
export const brepDrawingSketch = (drawing, plane = 'XY', offset = 0) => sketchValue(drawing, plane, offset);

export function sketchRect(plane, offset, width, height, radius, [cx, cy]) {
  const k = kernel();
  return attempt('rectangle sketch', () => {
    const d = radius > 0
      ? k.drawRoundedRectangle(width, height, radius)
      : k.drawRectangle(width, height);
    return sketchValue(d.translate(cx, cy), plane, offset);
  });
}

export function sketchCircle(plane, offset, radius, [cx, cy]) {
  const k = kernel();
  return attempt('circle sketch', () =>
    sketchValue(k.drawCircle(radius).translate(cx, cy), plane, offset));
}

export function sketchPolygon(plane, offset, sides, radius, [cx, cy]) {
  const k = kernel();
  const n = Math.max(3, Math.round(sides));
  return attempt('polygon sketch', () =>
    sketchValue(k.drawPolysides(radius, n).translate(cx, cy), plane, offset));
}

/**
 * General closed profile from an authored point list. Each point is [x, y] or
 * [x, y, r], where r rounds that corner — the sketcher equivalent of dropping a
 * fillet on a sketch vertex.
 *
 * The rounding on a point applies to the corner at that point, so it is only
 * meaningful for points 1..n-1; the start point is where the closing segment
 * meets the first, and replicad has no hook to round it. Authoring the profile
 * so its start sits mid-edge (or leaving that corner sharp) sidesteps it.
 */
export function sketchProfile(plane, offset, points) {
  const k = kernel();
  if (!Array.isArray(points) || points.length < 3) {
    throw new GraphError('Profile needs at least 3 points, each [x, y] or [x, y, cornerRadius]');
  }
  for (const [i, p] of points.entries()) {
    if (!Array.isArray(p) || p.length < 2 || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) {
      throw new GraphError(`Profile point ${i} must be [x, y] or [x, y, cornerRadius] with finite numbers`);
    }
  }
  return attempt('profile sketch', () => {
    let pen = k.draw([points[0][0], points[0][1]]);
    for (const [x, y, r] of points.slice(1)) {
      pen = pen.lineTo([x, y]);
      if (Number.isFinite(r) && r > 0) pen = pen.customCorner(r);
    }
    return sketchValue(pen.close(), plane, offset);
  });
}

/**
 * A drawing from solved sketch loops — the bridge out of the 2D solver.
 *
 * Loops arrive outermost first, so the first one is the boundary and the rest
 * are cut out of it. Nesting deeper than that (an island inside a hole) is not
 * distinguished: each further loop is cut, which for the common case of a plate
 * with holes is right, and for an island would need a containment test that no
 * prompt has asked for yet.
 */
export function brepSketchLoops(loops, plane, offset) {
  const k = kernel();
  if (!Array.isArray(loops) || !loops.length) {
    throw new GraphError('A profile needs at least one closed loop');
  }
  return attempt('sketch profile', () => {
    const drawn = loops.map((loop) => drawLoop(k, loop));
    const outer = drawn.slice(1).reduce((d, hole) => d.cut(hole), drawn[0]);
    return sketchValue(outer, plane, offset);
  });
}

/** One closed loop as a replicad drawing: a circle, or a pen walked round it. */
function drawLoop(k, loop) {
  const segments = loop.segments || [];
  if (segments.length === 1 && segments[0].type === 'circle') {
    const [cx, cy] = segments[0].center;
    return k.drawCircle(segments[0].radius).translate(cx, cy);
  }
  if (!segments.length) throw new GraphError('A profile loop has no segments');
  let pen = k.draw(segments[0].from);
  for (const s of segments) {
    // Arcs go in as three points rather than centre-and-flag: the mid-point
    // already encodes which way the arc bulges, so there is no orientation
    // convention left to disagree about across the boundary.
    pen = s.type === 'arc' ? pen.threePointsArcTo(s.to, s.mid) : pen.lineTo(s.to);
  }
  return pen.close();
}

// --------------------------------------------------------------- sketch -> 3D

/**
 * Extrude a sketch along its plane normal.
 *
 * `symmetric` centres the solid on the sketch plane. It is done by sliding the
 * sketch back half the height along the SAME normal the extrusion uses, so it
 * lands centred on every plane without this module needing to know which way
 * any given plane's normal points.
 */
export function brepExtrude(sketch, distance, symmetric, { twist = 0, endScale = 1 } = {}) {
  if (distance === 0) throw new GraphError('Extrude distance cannot be zero');
  if (!(endScale > 0)) throw new GraphError('Extrude endScale must be greater than zero');
  return attempt('extrude', () => {
    const height = symmetric ? Math.abs(distance) : distance;
    const opts = {};
    if (twist) opts.twistAngle = twist;
    if (endScale !== 1) opts.extrusionProfile = { profile: 'linear', endFactor: endScale };
    return track(placed(sketch, symmetric ? -Math.abs(distance) / 2 : 0).extrude(height, opts));
  });
}

/** Revolve a sketch about `axis` through `origin`, by `angle` degrees (360 = full turn). */
export function brepRevolve(sketch, axis, { origin = [0, 0, 0], angle = 360 } = {}) {
  if (!axis.some(Boolean)) throw new GraphError('Revolve axis cannot be [0, 0, 0]');
  if (!(angle > 0 && angle <= 360)) throw new GraphError('Revolve angle must be in (0, 360]');
  return attempt('revolve', () => track(placed(sketch).revolve(axis, { origin, angle })));
}

/** Loft through the sections, each placed on its own plane and offset. */
export function brepLoft(sketches, { ruled = false } = {}) {
  if (sketches.length < 2) throw new GraphError('Loft needs at least two sections');
  return attempt('loft', () => {
    const wires = sketches.map((s) => placed(s).wire);
    return track(kernel().loft(wires, { ruled }));
  });
}

/**
 * Sweep a profile along a path.
 *
 * The profile's own plane is ignored: it is placed at the path's start with
 * its normal along the path's tangent, so the same circle sweeps a helix, an
 * arc or a polyline without the caller computing a start frame.
 */
export function brepSweep(sketch, path, { frenet = false, xDir = null, guide = null, transition = 'right' } = {}) {
  if (sketch?.kind !== 'sketch') throw new GraphError('sweep needs a sketch profile');
  if (path?.kind !== 'path') throw new GraphError('sweep needs a path — brep.polyline, brep.spline or brep.helix');
  if (guide && guide.kind !== 'path') throw new GraphError('sweep guide must be a path');
  return attempt('sweep', () => {
    const rc = kernel();
    const spine = track(path.wire.clone());
    const start = spine.startPoint;
    const normal = spine.tangentAt(1e-9).normalize();
    const plane = new rc.Plane(start, xDir, normal);
    const profile = track(sketch.drawing.clone().sketchOnPlane(plane));
    const config = { frenet, transitionMode: transition, forceProfileSpineOthogonality: true };
    if (guide) config.auxiliarySpine = track(guide.wire.clone());
    return track(rc.genericSweep(profile.wire, spine, config));
  });
}

/** Point and unit tangent at parameter `t` in [0, 1] along a path. */
export function brepPathAt(path, t) {
  if (path?.kind !== 'path') throw new GraphError('expected a path — brep.polyline, brep.spline or brep.helix');
  return attempt('path sample', () => ({
    point: [...path.wire.pointAt(t).toTuple()],
    tangent: [...path.wire.tangentAt(t).normalize().toTuple()],
  }));
}

/** Extrude one face of a solid along a vector; the caller fuses or cuts it. */
export function brepFacePrism(face, vector) {
  return attempt('face extrude', () => track(kernel().basicFaceExtrusion(face, new (kernel().Vector)(vector))));
}

/** Axis of a cylindrical or conical face: {origin, direction, radius}. */
export function brepAxisOfFace(face) {
  return attempt('axisOf', () => {
    const kind = face.geomType;
    if (kind !== 'CYLINDRE' && kind !== 'CONE') {
      throw new GraphError(`axisOf: the face is ${kind}, not cylindrical or conical`);
    }
    const adaptor = face._geomAdaptor();
    const surf = kind === 'CYLINDRE' ? adaptor.Cylinder() : adaptor.Cone();
    const ax = surf.Axis();
    const loc = ax.Location();
    const dir = ax.Direction();
    const out = {
      origin: [loc.X(), loc.Y(), loc.Z()],
      direction: [dir.X(), dir.Y(), dir.Z()],
      radius: kind === 'CYLINDRE' ? surf.Radius() : surf.RefRadius(),
    };
    for (const o of [loc, dir, ax, surf, adaptor]) o.delete?.();
    return out;
  });
}

/** Merge coplanar faces and collinear edges left behind by booleans and patterns. */
export function brepSimplify(shape) {
  return attempt('simplify', () => {
    const u = new OC.ShapeUpgrade_UnifySameDomain_2(shape.wrapped, true, true, false);
    u.Build();
    const out = track(kernel().cast(u.Shape()));
    u.delete();
    return out;
  });
}

export function brepEdgeLength(edge) {
  return attempt('length', () => kernel().measureLength(edge));
}

/** A path value: a wire a profile can be swept along. */
const pathValue = (wire) => ({ kind: 'path', wire: track(wire) });

export function brepPolyline(points) {
  if (!Array.isArray(points) || points.length < 2) throw new GraphError('polyline needs at least two points');
  return attempt('polyline', () => {
    const rc = kernel();
    const edges = points.slice(1).map((p, i) => rc.makeLine(points[i], p));
    return pathValue(rc.assembleWire(edges));
  });
}

export function brepSpline(points) {
  if (!Array.isArray(points) || points.length < 2) throw new GraphError('spline needs at least two points');
  return attempt('spline', () => {
    const rc = kernel();
    return pathValue(rc.assembleWire([rc.makeBSplineApproximation(points, { tolerance: 1e-4 })]));
  });
}

export function brepHelix(radius, pitch, height, { center = [0, 0, 0], axis = [0, 0, 1], lefthand = false } = {}) {
  if (!(radius > 0 && pitch > 0 && height > 0)) throw new GraphError('helix needs radius, pitch and height > 0');
  return attempt('helix', () => pathValue(kernel().makeHelix(pitch, height, radius, center, axis, lefthand)));
}

/** Offset every face of a solid outward by `distance` (inward when negative). */
export function brepOffset(shape, distance) {
  if (!distance) throw new GraphError('Offset distance cannot be zero');
  return attempt('offset', () => track(kernel().makeOffset(shape, distance)));
}

/**
 * Tilt the selected faces by `angle` degrees about the neutral plane, the way a
 * mould draft does. Faces are tilted so the solid narrows along `pull`.
 */
export function brepDraft(shape, faces, angle, pull, neutralAt) {
  if (!Number.isFinite(angle) || angle === 0) throw new GraphError('Draft angle must be a non-zero number of degrees');
  return attempt('draft', () => {
    const rc = kernel();
    const builder = new OC.BRepOffsetAPI_DraftAngle_2(shape.wrapped);
    const dir = new OC.gp_Dir_4(...pull);
    const pln = new OC.gp_Pln_3(new OC.gp_Pnt_3(...neutralAt), dir);
    for (const f of faces) {
      builder.Add(f.wrapped, dir, (angle * Math.PI) / 180, pln, false);
      if (!builder.AddDone()) {
        throw new GraphError('draft: a selected face cannot be drafted — it must be planar and meet the neutral plane');
      }
    }
    builder.Build(new OC.Message_ProgressRange_1());
    const out = track(rc.cast(builder.Shape()));
    builder.delete();
    return out;
  });
}

/** Centre of mass of a solid. */
export function brepCentroid(shape) {
  return attempt('centroid', () => {
    const props = kernel().measureShapeVolumeProperties(shape);
    const c = props.centerOfMass;
    return [c[0], c[1], c[2]];
  });
}

/** Exact closest distance between two shapes. */
export function brepDistanceBetween(a, b) {
  return attempt('distance', () => kernel().measureDistanceBetween(a, b));
}

/** Tessellated outline of a sketch, for drawing the profile in the viewport. */
export function sketchOutline(sketch, { tolerance = 0.05 } = {}) {
  try {
    const wire = placed(sketch).wire;
    const e = wire.meshEdges({ tolerance, angularTolerance: 0.3, keepMesh: true });
    return { lines: Array.from(e.lines), groups: e.edgeGroups ?? [] };
  } catch {
    return null; // preview only; never fail a build over it
  }
}

// ---------------------------------------------------------------- operations

const BOOLEAN_OPS = { union: 'fuse', subtract: 'cut', intersect: 'intersect' };

export function brepBoolean(op, base, tools) {
  const method = BOOLEAN_OPS[op];
  if (!method) {
    throw new GraphError(`Unknown boolean '${op}'. Valid: ${Object.keys(BOOLEAN_OPS).join(', ')}`);
  }
  const list = (Array.isArray(tools) ? tools : [tools]).filter(Boolean);
  if (!list.length) throw new GraphError(`Boolean '${op}' needs at least one shape in the 'tool' input`);
  return attempt(`boolean ${op}`, () => {
    let acc = borrow(base, 'base');
    for (const tool of list) acc = track(acc[method](borrow(tool, 'tool')));
    return acc;
  });
}

// Edge selection for fillet/chamfer. Full topological picking belongs in the
// viewport; these cover the cases a graph can express without one.
const EDGE_FILTERS = {
  all: null,
  x: (e) => e.inDirection([1, 0, 0]),
  y: (e) => e.inDirection([0, 1, 0]),
  z: (e) => e.inDirection([0, 0, 1]),
};

function edgeFilter(select, op) {
  if (!(select in EDGE_FILTERS)) {
    throw new GraphError(`Unknown ${op} edge selection '${select}'. Valid: ${Object.keys(EDGE_FILTERS).join(', ')}`);
  }
  return EDGE_FILTERS[select];
}

export function brepFillet(solid, radius, select) {
  if (radius <= 0) throw new GraphError('Fillet radius must be greater than zero');
  const filter = edgeFilter(select, 'fillet');
  return attempt('fillet', () => {
    const s = borrow(solid, 'shape');
    return track(filter ? s.fillet(radius, filter) : s.fillet(radius));
  });
}

export function brepChamfer(solid, distance, select) {
  if (distance <= 0) throw new GraphError('Chamfer distance must be greater than zero');
  const filter = edgeFilter(select, 'chamfer');
  return attempt('chamfer', () => {
    const s = borrow(solid, 'shape');
    return track(filter ? s.chamfer(distance, filter) : s.chamfer(distance));
  });
}

export function brepShell(solid, thickness, openFace) {
  if (thickness === 0) throw new GraphError('Shell thickness cannot be zero');
  return attempt('shell', () => {
    const s = borrow(solid, 'shape');
    const box = s.boundingBox.bounds;
    const finder = openFace === 'none'
      ? null
      : (f) => f.inPlane('XY', openFace === 'top' ? box[1][2] : box[0][2]);
    return track(finder ? s.shell(thickness, finder) : s.shell(thickness));
  });
}

export function brepTransform(solid, translate, rotate, scale) {
  return attempt('transform', () => {
    let s = borrow(solid, 'shape');
    if (scale !== 1) {
      if (scale <= 0) throw new GraphError('Scale must be greater than zero');
      s = track(s.scale(scale));
    }
    const [rx, ry, rz] = rotate;
    if (rx) s = track(s.rotate(rx, [0, 0, 0], [1, 0, 0]));
    if (ry) s = track(s.rotate(ry, [0, 0, 0], [0, 1, 0]));
    if (rz) s = track(s.rotate(rz, [0, 0, 0], [0, 0, 1]));
    if (translate.some(Boolean)) s = track(s.translate(translate));
    return s;
  });
}

// -------------------------------------------------------------- STEP file I/O

/** Serialise a B-rep solid as a STEP AP214 file. Returns a Buffer. */
export async function exportStep(shape) {
  requireSolid(shape, 'shape');
  if (typeof shape.blobSTEP !== 'function') {
    throw new GraphError('This shape has no exact B-rep to write — export it as STL instead');
  }
  const blob = await attempt('STEP export', () => shape.blobSTEP());
  return Buffer.from(await blob.arrayBuffer());
}

/** Read a STEP file into an exact B-rep solid (no tessellation). */
export async function importStepExact(buffer) {
  const k = kernel();
  const blob = new Blob([buffer]);
  const shape = await attempt('STEP import', () => k.importSTEP(blob));
  return track(shape);
}

// -------------------------------------------------------------- tessellation

/**
 * Triangulate a B-rep solid for display and for the bridge into the SDF graph.
 * Unlike surface nets over a field, this is OCCT's own tessellation of the exact
 * surfaces: planar faces come out flat, circles come out round, and every
 * triangle carries the id of the B-rep face it belongs to.
 *
 * tolerance is the maximum chord deviation in mm.
 */
export function tessellate(shape, { tolerance = 0.01, angularTolerance = 0.3 } = {}) {
  requireSolid(shape, 'shape');
  return attempt('tessellation', () => {
    const mesh = shape.mesh({ tolerance, angularTolerance });
    const groups = mesh.faceGroups ?? [];
    return {
      positions: Float32Array.from(mesh.vertices),
      normals: Float32Array.from(mesh.normals),
      indices: Uint32Array.from(mesh.triangles),
      // Match the {first, count} shape imported assets already use, so face
      // picking in the viewport works the same for both.
      faces: groups.map((g) => ({ first: g.start / 3, count: g.count / 3, faceId: g.faceId })),
    };
  });
}

/** Crisp B-rep edge polylines for the wireframe overlay. */
export function tessellateEdges(shape, { tolerance = 0.01, angularTolerance = 0.3 } = {}) {
  if (!shape || typeof shape.meshEdges !== 'function') return null;
  try {
    const e = shape.meshEdges({ tolerance, angularTolerance, keepMesh: true });
    return { lines: Array.from(e.lines), groups: e.edgeGroups ?? [] };
  } catch {
    return null; // wireframe is cosmetic; never fail a build over it
  }
}

/**
 * Exact bounding box of a shape, in the {min, max} form sdf.js uses.
 *
 * For a sketch this is the box of the placed wire — flat in one axis, which is
 * correct and lets the viewport frame a sketch-only graph sensibly.
 */
export function brepBBox(shape) {
  if (!shape) return null;
  try {
    const target = isSketch(shape) ? placed(shape) : shape;
    const [min, max] = target.boundingBox.bounds;
    return { min: [...min], max: [...max] };
  } catch {
    return null;
  }
}

/**
 * The one-way bridge: B-rep -> signed distance field.
 *
 * Tessellates the exact solid and builds the same BVH-backed exact-to-the-mesh
 * distance function that imported STEP assets use. Everything downstream is a
 * field, so the exactness stops here — that is the whole point of the bridge
 * being one-way.
 *
 * The returned closure captures only plain typed arrays, so it stays valid
 * after the shape's scope is disposed.
 */
export function brepDistance(shape, options) {
  const { positions, indices } = tessellate(shape, options);
  return buildMeshDistance(positions, indices).distance;
}
