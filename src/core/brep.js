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
/** The raw OCCT module, for the few operations replicad does not wrap. */
export const brepOC = () => OC;

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
/**
 * What the kernel's own words mean to a modeller. OCCT reports a fillet that
 * cannot fit as "StartSol echec" and two bodies meeting on the same surface as
 * a vertex without a point; the person who asked for the fillet needs the
 * cause, and the kernel's phrase after it for the record.
 */
const OCCT_MEANINGS = [
  [/StartSol echec|PerformSurf|Failed processing|BRepFilletAPI|ChFi3d/i,
    'the radius or distance is too large for the neighbouring faces — reduce it, or fillet/chamfer fewer edges at once'],
  [/hasn't gp_Pnt|TopoDS_Vertex/i,
    'the two bodies meet on coincident geometry too closely — move them apart by more than 0.01 mm, or overlap them'],
  [/self-?intersect/i, 'the result would intersect itself'],
  [/BRep_API: command not done/i, 'the kernel could not build this — the inputs are probably degenerate (zero size, a profile crossing itself, or faces that cannot be offset)'],
  [/out of memory|IncAllocator/i, 'the kernel ran out of memory on this shape — simplify it, or split the operation into cells'],
];

function toGraphError(op, thrown) {
  if (thrown instanceof GraphError) return thrown;
  const raw = occtMessage(thrown);
  const meaning = OCCT_MEANINGS.find(([re]) => re.test(raw))?.[1];
  return new GraphError(meaning ? `${op} failed: ${meaning} (kernel: ${raw})` : `${op} failed: ${raw}`);
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
  if (shape === undefined) {
    throw new GraphError(`Input '${slot}' is undefined — a ref name may be misspelled (inputs.<id>), or the value was never assigned`);
  }
  if (!shape) throw new GraphError(`Input '${slot}' is empty — the cell it comes from did not build`);
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

/**
 * The plane a planar face lies on, as a plain {origin, normal, xDir} object.
 * The origin is the face's CENTRE, so a sketch drawn about (0, 0) lands in the
 * middle of the face — OCCT's own plane origin is a parametric corner, which
 * put a "centred" cutout half off the wall.
 */
export function brepPlaneOfFace(face) {
  return attempt('planeOf', () => {
    const pl = kernel().makePlaneFromFace(face);
    const centre = face.center;
    const out = {
      origin: [...centre.toTuple()],
      normal: [...pl.zDir.toTuple()],
      xDir: [...pl.xDir.toTuple()],
    };
    centre.delete?.();
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
 * Loops arrive outermost first. Each one is a hole or an island by how many
 * larger loops contain it: inside an odd number, it is cut; inside an even
 * number (an island in a hole), it is fused back in. Containment is judged by
 * a point of the loop against the larger loop's outline, with arcs sampled —
 * a sketch whose loops cross is not a set of loops and is not distinguished here.
 */
export function brepSketchLoops(loops, plane, offset) {
  const k = kernel();
  if (!Array.isArray(loops) || !loops.length) {
    throw new GraphError('A profile needs at least one closed loop');
  }
  return attempt('sketch profile', () => {
    const outlines = loops.map(loopOutline);
    for (const o of outlines) {
      const hit = selfIntersection(o);
      if (hit) {
        throw new GraphError(
          `Sketch loop crosses itself near (${hit[0].toFixed(2)}, ${hit[1].toFixed(2)}) — ` +
          'check that an arc bulges the way you meant (sk.arc runs counter-clockwise from a to b) and that no line cuts across another'
        );
      }
    }
    for (let i = 0; i < outlines.length; i++) {
      for (let j = i + 1; j < outlines.length; j++) {
        const hit = outlinesCross(outlines[i], outlines[j]);
        if (hit) {
          throw new GraphError(
            `Sketch loops cross each other near (${hit[0].toFixed(2)}, ${hit[1].toFixed(2)}) — ` +
            'a hole must lie entirely inside its boundary, and two shapes may not overlap'
          );
        }
      }
    }
    const drawn = loops.map((loop) => drawLoop(k, loop));
    let acc = drawn[0];
    for (let i = 1; i < loops.length; i++) {
      const p = outlines[i][0];
      let depth = 0;
      for (let j = 0; j < i; j++) if (pointInPolygon(p, outlines[j])) depth++;
      acc = depth % 2 ? acc.cut(drawn[i]) : acc.fuse(drawn[i]);
    }
    return sketchValue(acc, plane, offset);
  });
}

/** A loop as a polygon: corners plus sampled arc points, enough for containment tests. */
function loopOutline(loop) {
  const pts = [];
  for (const s of loop.segments) {
    if (s.type === 'circle') {
      for (let i = 0; i < 24; i++) {
        const a = (2 * Math.PI * i) / 24;
        pts.push([s.center[0] + s.radius * Math.cos(a), s.center[1] + s.radius * Math.sin(a)]);
      }
      return pts;
    }
    pts.push(s.from);
    if (s.type === 'arc') {
      const a0 = Math.atan2(s.from[1] - s.center[1], s.from[0] - s.center[0]);
      const n = Math.max(2, Math.ceil(Math.abs(s.sweep) / (Math.PI / 12)));
      for (let i = 1; i < n; i++) {
        const a = a0 + (s.sweep * i) / n;
        pts.push([s.center[0] + s.radius * Math.cos(a), s.center[1] + s.radius * Math.sin(a)]);
      }
    }
  }
  return pts;
}

/** The first place two closed polylines cross, or null. Touching at a point does not count. */
function outlinesCross(a, b) {
  const cross = (o, p, r) => (p[0] - o[0]) * (r[1] - o[1]) - (p[1] - o[1]) * (r[0] - o[0]);
  for (let i = 0; i < a.length; i++) {
    const p1 = a[i]; const p2 = a[(i + 1) % a.length];
    for (let j = 0; j < b.length; j++) {
      const q1 = b[j]; const q2 = b[(j + 1) % b.length];
      const d1 = cross(p1, p2, q1); const d2 = cross(p1, p2, q2); const d3 = cross(q1, q2, p1); const d4 = cross(q1, q2, p2);
      // Touching counts: a sampled arc lands exactly on the line it crosses often enough.
      if (d1 * d2 <= 0 && d3 * d4 <= 0 && !(d1 === 0 && d2 === 0)) {
        const t = d1 === d2 ? 0 : d1 / (d1 - d2);
        return [q1[0] + t * (q2[0] - q1[0]), q1[1] + t * (q2[1] - q1[1])];
      }
    }
  }
  return null;
}

/** The first place a closed polyline crosses itself, or null. Adjacent segments share a vertex and are skipped. */
function selfIntersection(poly) {
  const n = poly.length;
  if (n < 4) return null;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  for (let i = 0; i < n; i++) {
    const a = poly[i]; const b = poly[(i + 1) % n];
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const c = poly[j]; const d = poly[(j + 1) % n];
      const d1 = cross(a, b, c); const d2 = cross(a, b, d); const d3 = cross(c, d, a); const d4 = cross(c, d, b);
      if (((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0)) && d1 !== 0 && d2 !== 0 && d3 !== 0 && d4 !== 0) {
        const t = d1 / (d1 - d2);
        return [c[0] + t * (d[0] - c[0]), c[1] + t * (d[1] - c[1])];
      }
    }
  }
  return null;
}

function pointInPolygon([x, y], poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
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
export function brepSweep(sketch, path, { frenet = false, xDir = null, guide = null, transition = 'right', contact = true } = {}) {
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
    if (guide) return track(guidedSweep(profile.wire, spine, track(guide.wire.clone()), { contact, transition }));
    return track(rc.genericSweep(profile.wire, spine, config));
  });
}

/**
 * A twisted solid built from faces, with no boolean, ONE TURN AT A TIME.
 *
 * The section drawing is swept along `direction` for `span`, turning once
 * per `pitch`, as a series of one-turn shells sewn together: a single sweep
 * over twenty turns is one BSpline face the mesher spends a minute and 650k
 * triangles on, where twenty one-turn faces mesh in under a second. Each
 * piece starts exactly where the last ended (a whole turn brings the section
 * back to itself), so the pieces sew on plain planar wires.
 *
 * With `cylinderRadius`, the solid is a ring: the other wall is a plain
 * cylinder about the same axis and the caps are annuli. `waveInside` puts
 * the swept wall on the inside (an internal thread's teeth). Every boolean
 * that touches the swept surface costs seconds, where sewing costs nothing
 * and the result then meets the part only on planar caps and one cylinder.
 */
export function brepTwistedSolid({ drawing, p0, direction, span, pitch, lefthand = false, cylinderRadius = null, waveInside = false }) {
  return attempt('twisted solid', () => {
    const rc = kernel();
    const at = (z) => p0.map((c, k) => c + direction[k] * z);
    const parts = [];
    let first = null; let last = null;
    for (let z0 = 0; z0 < span - 1e-9; z0 += pitch) {
      const len = Math.min(pitch, span - z0);
      const section = track(drawing.clone().sketchOnPlane(new rc.Plane(at(z0), null, direction)));
      const spine = track(rc.assembleWire([rc.makeLine(at(z0), at(z0 + len))]));
      const aux = track(rc.makeHelix(pitch, len, 1, at(z0), direction, lefthand));
      const [shell, w0, w1] = rc.genericSweep(section.wire, spine, { auxiliarySpine: aux }, true);
      track(shell); track(w0); track(w1);
      parts.push(shell);
      if (!first) first = w0;
      last = w1;
    }
    const p1 = at(span);
    if (cylinderRadius == null) {
      parts.push(track(rc.makeFace(first)), track(rc.makeFace(last)));
    } else {
      const flip = direction.map((c) => -c);
      // A wire becomes a hole by running the other way; a circle drawn with the reversed normal does.
      const circle = (o, reversed) => track(rc.assembleWire([rc.makeCircle(cylinderRadius, o, reversed ? flip : direction)]));
      parts.push(track(rc.loft([circle(p0, false), circle(p1, false)], { ruled: true }, true)));
      if (waveInside) {
        parts.push(track(rc.makeFace(circle(p0, false), [track(new rc.Wire(OC.TopoDS.Wire_1(first.wrapped.Reversed())))])));
        parts.push(track(rc.makeFace(circle(p1, false), [track(new rc.Wire(OC.TopoDS.Wire_1(last.wrapped.Reversed())))])));
      } else {
        parts.push(track(rc.makeFace(first, [circle(p0, true)])), track(rc.makeFace(last, [circle(p1, true)])));
      }
    }
    return track(rc.makeSolid(parts));
  });
}

/**
 * A sweep steered by a guide rail. replicad's sweep only lets the rail set the
 * profile's twist (BRepFill_NoContact); a rail is for keeping the profile in
 * touch with it as it goes, which is OCCT's KeepContact mode — so the pipe
 * shell is built here directly, with the same sequence replicad uses.
 */
function guidedSweep(profileWire, spine, rail, { contact = true, transition = 'right' } = {}) {
  const rc = kernel();
  const builder = new OC.BRepOffsetAPI_MakePipeShell(spine.wrapped);
  const modes = {
    transformed: OC.BRepBuilderAPI_TransitionMode.BRepBuilderAPI_Transformed,
    round: OC.BRepBuilderAPI_TransitionMode.BRepBuilderAPI_RoundCorner,
    right: OC.BRepBuilderAPI_TransitionMode.BRepBuilderAPI_RightCorner,
  };
  if (modes[transition]) builder.SetTransitionMode(modes[transition]);
  builder.SetMode_5(rail.wrapped, false, contact ? OC.BRepFill_TypeOfContact.BRepFill_Contact : OC.BRepFill_TypeOfContact.BRepFill_NoContact);
  builder.Add_1(profileWire.wrapped, contact, transition === 'round');
  builder.Build(new OC.Message_ProgressRange_1());
  builder.MakeSolid();
  const shape = rc.cast(builder.Shape());
  builder.delete();
  return shape;
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

/**
 * What a face's surface really is.
 *
 * OCCT keeps a revolved line as a "surface of revolution" and a shelled
 * cylinder as an "offset surface", which is true and useless: a query for the
 * cylindrical faces of a revolved, shelled bottle would match nothing. The
 * kernel build binds no way to read those surfaces' basis geometry, so the
 * surface is SAMPLED instead: a grid of points, and a cylinder is recognised by
 * fitting one (all normals perpendicular to one axis, all points one radius
 * from it, to a millionth); a surface of revolution — whose axis the adaptor
 * does give — by the curve its samples trace in (axial, radial): a line for a
 * cone, a circle for a torus or, centred on the axis, a sphere. What does not
 * fit keeps its raw kind. Elementary surfaces are read exactly, as before.
 */
export function faceGeometry(face) {
  const adaptor = face._geomAdaptor();
  try {
    return classifySurface(adaptor, face);
  } catch {
    return { kind: faceKindName(face.geomType), axis: null, radius: null };
  } finally {
    adaptor.delete?.();
  }
}

const pnt = (p) => [p.X(), p.Y(), p.Z()];
const axisOf = (ax) => {
  const loc = ax.Location(); const dir = ax.Direction();
  const out = { origin: pnt(loc), direction: pnt(dir) };
  loc.delete?.(); dir.delete?.(); ax.delete?.();
  return out;
};
const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit3 = (a) => { const n = Math.hypot(...a); return n > 0 ? a.map((c) => c / n) : null; };
const distToAxis = (p, { origin, direction }) => {
  const d = sub3(p, origin);
  const t = dot3(d, direction);
  return Math.hypot(...d.map((c, k) => c - t * direction[k]));
};

/** replicad names the kind in French; the descriptors speak the query vocabulary. */
export const faceKindName = (k) => (k === 'CYLINDRE' ? 'CYLINDER' : k);

function classifySurface(adaptor, face) {
  const raw = face.geomType;
  const kind = faceKindName(raw);
  if (raw === 'CYLINDRE') {
    const c = adaptor.Cylinder(); const out = { kind, axis: axisOf(c.Axis()), radius: c.Radius() }; c.delete?.(); return out;
  }
  if (kind === 'CONE') {
    const c = adaptor.Cone(); const out = { kind, axis: axisOf(c.Axis()), radius: c.RefRadius() }; c.delete?.(); return out;
  }
  if (kind === 'SPHERE') {
    const c = adaptor.Sphere(); const loc = c.Location();
    const out = { kind, axis: null, radius: c.Radius(), center: pnt(loc) }; loc.delete?.(); c.delete?.(); return out;
  }
  if (kind === 'TORUS') {
    const c = adaptor.Torus(); const out = { kind, axis: axisOf(c.Axis()), radius: c.MinorRadius(), majorRadius: c.MajorRadius() }; c.delete?.(); return out;
  }
  if (kind === 'PLANE') return { kind, axis: null, radius: null };

  const samples = sampleFace(face);
  const cyl = fitCylinder(samples);
  if (cyl) return { kind: 'CYLINDER', ...cyl };
  if (kind === 'REVOLUTION_SURFACE') {
    const axis = axisOf(adaptor.AxeOfRevolution());
    const profile = samples.map(({ p }) => [dot3(sub3(p, axis.origin), axis.direction), distToAxis(p, axis)]);
    const scale = Math.max(1, ...profile.map(([z, r]) => Math.abs(z) + r));
    if (collinear(profile, 1e-7 * scale)) return { kind: 'CONE', axis, radius: null };
    const circle = fitCircle(profile);
    if (circle && circle.residual < 1e-7 * scale) {
      return Math.abs(circle.center[1]) < 1e-7 * scale
        ? { kind: 'SPHERE', axis, radius: circle.radius, center: axis.origin.map((c, k) => c + circle.center[0] * axis.direction[k]) }
        : { kind: 'TORUS', axis, radius: circle.radius, majorRadius: circle.center[1] };
    }
    return { kind, axis, radius: null };
  }
  return { kind, axis: null, radius: null };
}

/** A 4×4 grid of surface points with finite-difference normals (replicad's u, v run 0..1 across the face). */
function sampleFace(face) {
  const N = 4;
  const h = 1e-5;
  const at = (u, v) => { const p = face.pointOnSurface(u, v); const t = [...p.toTuple()]; p.delete?.(); return t; };
  const out = [];
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const u = (i + 0.5) / N;
      const v = (j + 0.5) / N;
      const p = at(u, v);
      const n = unit3(cross3(sub3(at(u + h, v), p), sub3(at(u, v + h), p)));
      if (n) out.push({ p, n });
    }
  }
  return out;
}

/** The cylinder through the samples, or null if they do not lie on one. */
function fitCylinder(samples) {
  if (samples.length < 6) return null;
  let axis = null; let best = 0;
  for (let i = 0; i < samples.length; i++) {
    for (let j = i + 1; j < samples.length; j++) {
      const c = cross3(samples[i].n, samples[j].n); const m = Math.hypot(...c);
      if (m > best) { best = m; axis = c.map((k) => k / m); }
    }
  }
  if (!axis || best < 1e-3) return null;
  if (samples.some(({ n }) => Math.abs(dot3(n, axis)) > 1e-3)) return null;
  // Project onto the plane normal to the axis; the points must sit on one circle.
  const e1 = unit3(cross3(axis, Math.abs(axis[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]));
  const e2 = cross3(axis, e1);
  const circle = fitCircle(samples.map(({ p }) => [dot3(p, e1), dot3(p, e2)]));
  if (!circle || circle.residual > 1e-6 * circle.radius) return null;
  const origin = [0, 1, 2].map((k) => circle.center[0] * e1[k] + circle.center[1] * e2[k]);
  return { axis: { origin, direction: axis }, radius: circle.radius };
}

function collinear(pts, tol) {
  const [a, b] = [pts[0], pts[pts.length - 1]];
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (len < tol) return false;
  return pts.every(([x, y]) => Math.abs((b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0])) / len < tol);
}

/** Algebraic least-squares circle through 2D points: {center, radius, residual}. */
function fitCircle(pts) {
  let sxx = 0, sxy = 0, syy = 0, sx = 0, sy = 0, n = 0, sxz = 0, syz = 0, sz = 0;
  for (const [x, y] of pts) {
    const z = x * x + y * y;
    sxx += x * x; sxy += x * y; syy += y * y; sx += x; sy += y; n++; sxz += x * z; syz += y * z; sz += z;
  }
  // Solve [sxx sxy sx; sxy syy sy; sx sy n] [a b c] = -[sxz syz sz] for x²+y²+ax+by+c=0.
  const M = [[sxx, sxy, sx], [sxy, syy, sy], [sx, sy, n]];
  const R = [-sxz, -syz, -sz];
  const det = (m) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const D = det(M);
  if (Math.abs(D) < 1e-18) return null;
  const col = (k) => M.map((row, i) => row.map((v, j) => (j === k ? R[i] : v)));
  const [a, b, c] = [0, 1, 2].map((k) => det(col(k)) / D);
  const center = [-a / 2, -b / 2];
  const r2 = center[0] ** 2 + center[1] ** 2 - c;
  if (!(r2 > 0)) return null;
  const radius = Math.sqrt(r2);
  const residual = Math.max(...pts.map(([x, y]) => Math.abs(Math.hypot(x - center[0], y - center[1]) - radius)));
  return { center, radius, residual };
}

/** Axis of a cylindrical or conical face: {origin, direction, radius}. */
export function brepAxisOfFace(face, fallbackRadius = null) {
  return attempt('axisOf', () => {
    const g = faceGeometry(face);
    if (!g.axis || (g.kind !== 'CYLINDER' && g.kind !== 'CONE')) {
      throw new GraphError(`axisOf: the face is ${g.kind}, not cylindrical or conical`);
    }
    const radius = g.radius ?? fallbackRadius;
    if (radius == null) throw new GraphError('axisOf: could not measure the face radius');
    return { origin: g.axis.origin, direction: g.axis.direction, radius };
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
  return attempt('offset', () => {
    try {
      return track(kernel().makeOffset(shape, distance));
    } catch (e) {
      if (distance < 0 && /null|not type/i.test(String(e?.message))) {
        throw new GraphError(
          `offset by ${distance} mm left nothing: every wall of the part is thinner than ${2 * -distance} mm, so shrinking it that far collapses it`
        );
      }
      throw e;
    }
  });
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

/** How many separate solids a result holds: a union of bodies that do not touch is two. */
export function brepBodies(shape) {
  return attempt('bodies', () => {
    let n = 0;
    for (const _ of kernel().iterTopo(shape.wrapped, 'solid')) n++;
    return n;
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
/**
 * Triangles above this from a COARSE pass mean the shape is dense enough that
 * the fine pass would run the kernel out of memory — a twenty-turn thread
 * meshed at 0.01 mm grew the WASM heap to 2 GB and took the process down. The
 * coarse mesh is what such a shape gets; everything ordinary is refined.
 */
const MESH_BUDGET = 40000;
const COARSE = 0.1;

export function tessellate(shape, { tolerance = 0.01, angularTolerance = 0.3 } = {}) {
  requireSolid(shape, 'shape');
  return attempt('tessellation', () => {
    let mesh = shape.mesh({ tolerance: Math.max(tolerance, COARSE), angularTolerance });
    if (tolerance < COARSE && mesh.triangles.length / 3 <= MESH_BUDGET) {
      mesh = shape.mesh({ tolerance, angularTolerance });
    }
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
    return tightBounds(target);
  } catch {
    return null;
  }
}

/**
 * The bounding box the geometry actually occupies.
 *
 * OCCT's default box is the basis surface's box grown by every offset and
 * tolerance, so a shelled revolve reports itself one wall thickness larger on
 * every side — a number that fails a fitsIn() the part passes. AddOptimal
 * bounds the surfaces themselves.
 */
export function tightBounds(shape) {
  // Offset and spline surfaces still come back a few tenths too big from the
  // analytic box; their triangulation is the honest extent, to its deflection.
  const faces = Array.isArray(shape.faces) ? shape.faces : [];
  const curvedFree = faces.every((f) => ['PLANE', 'CYLINDRE', 'CONE', 'SPHERE', 'TORUS'].includes(f.geomType));
  if (faces.length && !curvedFree) {
    const tol = 0.01;
    const { positions } = tessellate(shape, { tolerance: tol });
    const min = [Infinity, Infinity, Infinity]; const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < positions.length; i += 3) {
      for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], positions[i + k]); max[k] = Math.max(max[k], positions[i + k]); }
    }
    return { min: min.map((v) => v - tol), max: max.map((v) => v + tol) };
  }
  const box = new OC.Bnd_Box_1();
  OC.BRepBndLib.AddOptimal(shape.wrapped, box, true, false);
  const lo = box.CornerMin();
  const hi = box.CornerMax();
  const out = { min: [lo.X(), lo.Y(), lo.Z()], max: [hi.X(), hi.Y(), hi.Z()] };
  lo.delete(); hi.delete(); box.delete();
  return out;
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
