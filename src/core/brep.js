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

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import v8 from 'node:v8';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
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
    fs.statSync(mjsPath).mtimeMs < fs.statSync(srcPath).mtimeMs ||
    !fs.readFileSync(mjsPath, 'utf8').includes(GLUE_PATCH_MARK);
  if (stale) fs.writeFileSync(mjsPath, patchGlue(fs.readFileSync(srcPath, 'utf8')));

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

// ------------------------------------------------- the by-value destructor leak
//
// opencascade.js registers every non-transient base class — TopoDS_Shape, gp_Pnt, Bnd_Box, TopLoc_Location
// and some 240 more — with a destructor that does nothing: one shared no-op function. Those classes are
// exactly what OCCT hands back by value (bop.Shape(), box.CornerMin(), curve.Value(u)), each as a fresh
// malloc'd copy, so every such object leaks its bytes — and a TopoDS_Shape also keeps its reference to the
// geometry, which is the whole part. Measured: a sheet-metal part grew the heap 96 MB per rebuild after
// a full collection; 100k boxes from BRepPrimAPI_MakeBox lost 1 GB. The constructor classes (gp_Pnt_3,
// Handle_*, transients) have real destructors and are left alone.
//
// Two hooks go into the glue when it is copied to the cache: runDestructor asks __cadgangDestroy first,
// and attachFinalizer also registers handles of these classes, so an orphaned copy nobody delete()s is
// freed when V8 collects its wrapper. The hooks are installed by patchBaseClassDestructors() below.
const GLUE_PATCH_MARK = 'cadgang-glue-patch-2';   // bump when patchGlue changes
function patchGlue(text) {
  const edits = [
    ['function runDestructor($$){if($$.smartPtr){$$.smartPtrType.rawDestructor($$.smartPtr)}else{$$.ptrType.registeredClass.rawDestructor($$.ptr)}}',
      'function runDestructor($$){if($$.smartPtr){$$.smartPtrType.rawDestructor($$.smartPtr)}else if(!(Module.__cadgangDestroy&&Module.__cadgangDestroy($$))){$$.ptrType.registeredClass.rawDestructor($$.ptr)}}'],
    ['if(hasSmartPtr){var info={$$:$$};finalizationRegistry.register(handle,info,handle)}',
      'if(hasSmartPtr||(Module.__cadgangFinalize&&Module.__cadgangFinalize($$))){var info={$$:$$};finalizationRegistry.register(handle,info,handle)}'],
    // C++ exceptions: this build throws them to JS and has no catch support, so nothing ever frees one. Every OCCT
    // throw replicad swallows (a projection with no point, a fillet that will not fit) left ~120 B behind. Record
    // each thrown pointer; freeThrownExceptions() runs its destructor and frees it once the JS handling is over.
    ['function ___cxa_throw(ptr,type,destructor){var info=new ExceptionInfo(ptr);info.init(type,destructor);exceptionLast=ptr;uncaughtExceptionCount++;throw ptr}',
      'function ___cxa_throw(ptr,type,destructor){var info=new ExceptionInfo(ptr);info.init(type,destructor);exceptionLast=ptr;uncaughtExceptionCount++;if(Module.__cadgangThrown)Module.__cadgangThrown.push(ptr);throw ptr}'
      + 'Module.__cadgangFreeException=function(ptr){var info=new ExceptionInfo(ptr);var d=info.get_destructor();if(d)getWasmTableEntry(d)(ptr);_free(info.ptr)};'],
  ];
  for (const [from, to] of edits) {
    if (text.split(from).length !== 2) throw new Error(`cadgang: the OCCT glue changed; the by-value destructor patch no longer fits (${from.slice(0, 40)}…)`);
    text = text.replace(from, () => to);   // a function: a string replacement would read the $$ in the glue as $
  }
  return `// ${GLUE_PATCH_MARK}\n${text}`;
}
function patchBaseClassDestructors(OC) {
  const probe = new OC.gp_Ax2d_1();
  const sample = probe.Location();   // a by-value gp_Pnt2d: its class carries the shared no-op destructor
  const NOOP = sample.$$.ptrType.registeredClass.rawDestructor;
  const isNoop = ($$) => !$$.smartPtr && $$.ptrType.registeredClass.rawDestructor === NOOP;
  // Handles come back by value too (GCE2d_MakeSegment.Value(), BRep_Tool.Surface()), as copies with a real
  // destructor that nobody calls — each holds a reference, so the curve or surface behind it leaks (~100 B per
  // line segment drawn). Finalizing the copy runs that destructor when V8 drops the wrapper.
  const isHandle = ($$) => !$$.smartPtr && $$.ptrType.registeredClass.name.startsWith('Handle_');
  // And what JS itself constructs — `new OC.Geom2dAPI_InterCurveCurve_1()` and every other suffixed
  // constructor class — is JS-owned, so a wrapper dropped without delete() can be destroyed on collection
  // (replicad forgets its intersector on every early return). Not transients: a `new Geom2d_TrimmedCurve_1`
  // belongs to the Handle it is wrapped in, which frees it.
  const owned = new WeakMap();   // registeredClass → is a non-transient constructor class
  const isOwned = ($$) => {
    const rc = $$.ptrType.registeredClass;
    let v = owned.get(rc);
    if (v === undefined) owned.set(rc, v = /_\d+$/.test(rc.name) && !OC.Standard_Transient.prototype.isPrototypeOf(rc.instancePrototype));
    return !$$.smartPtr && v;
  };
  OC.__cadgangFinalize = ($$) => isNoop($$) || isHandle($$) || isOwned($$);
  OC.__cadgangDestroy = ($$) => {
    if (!isNoop($$)) return false;
    // Let go of what the object holds first — a TopoDS_Shape its geometry, a TopLoc_Location its datum.
    const h = Object.create($$.ptrType.registeredClass.instancePrototype, { $$: { value: $$ } });
    try { if (typeof h.Nullify === 'function') h.Nullify(); else if (typeof h.Clear === 'function') h.Clear(); } catch { /* nothing held */ }
    OC._free($$.ptr);
    return true;
  };
  sample.delete(); probe.delete();
  OC.__cadgangThrown = [];
}

/** Free the C++ exceptions thrown since the last pass; called from collectNow(), between units of work. */
function freeThrownExceptions() {
  const thrown = OC?.__cadgangThrown;
  if (!thrown?.length) return;
  for (const ptr of thrown) { try { OC.__cadgangFreeException(ptr); } catch { /* already gone */ } }
  thrown.length = 0;
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
    patchBaseClassDestructors(OC);
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
  // A big heap gets its garbage collected BEFORE the next job rather than after
  // it: the OCCT heap never shrinks, so a rebuild that starts on top of the last
  // one's leftovers is what pushes it over the restart limit.
  return scopesSinceCollect >= 4 && brepHeapBytes() > BREP_ROOM_BYTES ? initPromise.then(settle) : initPromise;   // not after every request: a cache-hit request leaves nothing to collect, and a settle is 0.7 s
}

/** Above this many bytes the kernel makes room before building: see initBrep() and the cell cache. */
export const BREP_ROOM_BYTES = parseInt(process.env.CADGANG_BREP_ROOM || String(512 * 2 ** 20), 10);

/** Collect replicad's finalizer-held intermediates now, and wait for their frees to land. */
export const settleBrep = () => settle();

async function settle(rc) {
  collectNow();
  await new Promise((r) => setImmediate(() => setImmediate(() => setImmediate(r))));   // after collectNow's three passes and the finalizers they queue
  return rc;
}

/**
 * Size of the OCCT WASM heap in bytes, or null before the kernel loads.
 *
 * Emscripten heaps only ever grow, so this is a high-water mark: it rising
 * means OCCT genuinely needed more memory than it had, and it holding steady
 * means allocations are being reused. It is the honest signal for whether shape
 * memory is being reclaimed — process RSS is too noisy to read.
 */
export const brepHeapBytes = () => (OC?.HEAPU8 ? OC.HEAPU8.length : null);

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
/**
 * What the kernel's own words mean to a modeller. OCCT reports a fillet that
 * cannot fit as "StartSol echec" and two bodies meeting on the same surface as
 * a vertex without a point; the person who asked for the fillet needs the
 * cause, and the kernel's phrase after it for the record.
 */
const OCCT_MEANINGS = [
  [/StartSol echec|PerformSurf|Failed processing|BRepFilletAPI|ChFi3d|ChFiDS|too big radiuses|no suitable edges/i,
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

/**
 * Aggregate timings for exact-kernel calls. The map stays bounded because op is
 * a vocabulary label from this module/ops.js, never user input. These are
 * inclusive timings: a high-level operation such as thread includes the
 * lower-level sweeps and booleans it invokes, which remain visible separately.
 */
const operationStats = new Map();
function recordOperation(op, ms, failed) {
  const s = operationStats.get(op) ?? { count: 0, failures: 0, totalMs: 0, maxMs: 0 };
  s.count++;
  if (failed) s.failures++;
  s.totalMs += ms;
  s.maxMs = Math.max(s.maxMs, ms);
  operationStats.set(op, s);
}

/** A snapshot safe to expose from /api/health and benchmark tools. */
export function brepOperationStats() {
  return Object.fromEntries([...operationStats].sort((a, b) => b[1].totalMs - a[1].totalMs).map(([op, s]) => [op, {
    count: s.count, failures: s.failures,
    totalMs: +s.totalMs.toFixed(2), maxMs: +s.maxMs.toFixed(2),
    meanMs: +(s.totalMs / s.count).toFixed(2),
  }]));
}

/** Tests and benchmark runs use a fresh observation window. */
export function resetBrepOperationStats() { operationStats.clear(); }

/**
 * Live building: after every op that made a shape, `progress.fn(op, shape)` sees it (the kernel host
 * sends the viewer a rough draft, throttled), and `progress.cell` names the cell building it.
 */
export const progress = { fn: null, cell: null, asserting: false };
let progressing = false;
/** Run an OCCT call, translating its failure mode into a GraphError. */
function attempt(op, fn) {
  const started = performance.now();
  try {
    const value = fn();
    recordOperation(op, performance.now() - started, false);
    if (progress.fn && !progressing && value?.wrapped && typeof value.mesh === 'function') {
      progressing = true;   // the hook's own tessellation is an op too
      try { progress.fn(op, value); } catch { /* a draft is cosmetic */ } finally { progressing = false; }
    }
    return value;
  } catch (e) {
    recordOperation(op, performance.now() - started, true);
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

function collectNow() {
  clearTimeout(collectTimer);
  collectTimer = null;
  scopesSinceCollect = 0;
  freeThrownExceptions();
  if (!forceGC) return;
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
    dispose(keep = []) {   // keep: shapes (or one) that move to the enclosing scope instead of being freed — a part's result, its scraps gone
      if (disposed) return;
      disposed = true;
      activeScope = outer;
      for (const k of [keep].flat()) if (k && shapes.delete(k) && outer) outer.add(k);
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

const BOP = { union: 'BRepAlgoAPI_Fuse_1', subtract: 'BRepAlgoAPI_Cut_1' };

/**
 * One boolean with every tool at once. replicad's fuse()/cut() take one tool and
 * simplify the result each time, so N tools cost N operations on an ever-bigger
 * part: a sheet-metal part with 250 nuts spent 16 s fusing them in one by one.
 * OCCT takes the whole list in one go. Fuse and cut mean the same either way;
 * common of several tools would not (base ∩ (t1 ∪ t2), not base ∩ t1 ∩ t2).
 */
export function brepBoolean(op, base, tools) {
  const args = new OC.TopTools_ListOfShape_1(), list = new OC.TopTools_ListOfShape_1();
  const bop = new OC[BOP[op]](), progress = new OC.Message_ProgressRange_1();
  try {
    args.Append_1(base.wrapped);
    for (const t of tools) list.Append_1(t.wrapped);
    bop.SetArguments(args);
    bop.SetTools(list);
    bop.Build(progress);
    return track(kernel().cast(unified(bop.Shape())));
  } finally {
    for (const o of [bop, progress, args, list]) o.delete();
  }
}

/** Does the shape hold a solid at all? A boolean that removed everything, or gave up without an error, hands back an empty compound. */
export function brepHasSolid(shape) {
  const ex = new OC.TopExp_Explorer_2(shape.wrapped, OC.TopAbs_ShapeEnum.TopAbs_SOLID, OC.TopAbs_ShapeEnum.TopAbs_SHAPE);
  try { return ex.More(); } finally { ex.delete(); }
}

/** A shape passes the kernel's full check, geometry included: what a rescue's result must do before it is believed. */
export function brepIsValid(shape) {
  const check = new OC.BRepCheck_Analyzer(shape.wrapped, true, false);
  try { return check.IsValid_2(); } finally { check.delete(); }
}

/** For each of `edges`, the set of faces of `shape` it borders (by face index). */
export function brepEdgeFaces(shape, edges) {
  const sets = edges.map(() => new Set()); let f = 0;
  for (const face of kernel().iterTopo(shape.wrapped, 'face')) {
    for (const e of kernel().iterTopo(face, 'edge')) edges.forEach((sel, i) => { if (e.IsSame(sel.wrapped)) sets[i].add(f); });
    f++;
  }
  return sets;
}

/** Topology of a result is intact (cheap: no geometry controls). */
function isSound(wrapped) {
  const check = new OC.BRepCheck_Analyzer(wrapped, false, false);
  try { return check.IsValid_2(); } finally { check.delete(); }
}

/**
 * A boolean's result with coplanar faces and collinear edges merged, or the result as it was if merging broke it.
 *
 * This used to be the builder's own SimplifyResult(true, true, 1e-3), as replicad does. On a body with lofted
 * faces (an imported horn: a bell lofted onto tubes) that call threw, or handed back a shape missing the bell,
 * AND damaged the operand it was given, so every later operation on that body was wrong too. Any angular
 * tolerance set by hand did the same (1e-3 down to 1e-7). The unifier on its own, at its default tolerance,
 * merges what is exactly coplanar and leaves the operands alone.
 */
function unified(wrapped) {
  const u = new OC.ShapeUpgrade_UnifySameDomain_2(wrapped, true, true, false);
  try { u.Build(); const s = u.Shape(); return isSound(s) ? s : wrapped; } catch { return wrapped; } finally { u.delete(); }
}

/** The volume two shapes share, by one raw Common: no simplification of a result that is only measured, and
 *  OCCT's oriented boxes (SetUseOBB) to pass over the sub-shapes that cannot meet.
 *  brepSurfacesMeet (below) spares most pairs this: a Section of whole shapes was tried first and dropped, half the
 *  cost on gears but up to 10× the Common on spline faces that are clear of each other. */
export function brepCommonVolume(a, b) {
  const args = new OC.TopTools_ListOfShape_1(), list = new OC.TopTools_ListOfShape_1();
  const bop = new OC.BRepAlgoAPI_Common_1(), progress = new OC.Message_ProgressRange_1();
  let common = null;
  try {
    args.Append_1(a.wrapped); list.Append_1(b.wrapped);
    bop.SetArguments(args); bop.SetTools(list); bop.SetUseOBB(true);
    bop.Build(progress);
    common = kernel().cast(bop.Shape());
    try { return kernel().measureVolume(common); } catch { return 0; }
  } finally {
    try { common?.delete(); } catch { /* gone */ }
    for (const o of [bop, progress, args, list]) o.delete();
  }
}

// Each face's box, in the order the explorer walks them; kept by key, since a gear's 250 faces are asked for per neighbour.
const faceBoxCache = new Map();
const eachFace = (wrapped, fn) => {
  const ex = new OC.TopExp_Explorer_2(wrapped, OC.TopAbs_ShapeEnum.TopAbs_FACE, OC.TopAbs_ShapeEnum.TopAbs_SHAPE);
  try { for (let i = 0; ex.More(); ex.Next(), i++) { const f = ex.Current(); try { fn(f, i); } finally { f.delete(); } } } finally { ex.delete(); }
};
const faceBoxes = (shape) => {
  const k = shape.__key;
  if (k && faceBoxCache.has(k)) return faceBoxCache.get(k);
  const out = [], ga = OC.GeomAbs_SurfaceType, easy = new Set([ga.GeomAbs_Plane, ga.GeomAbs_Cylinder, ga.GeomAbs_Cone, ga.GeomAbs_Sphere, ga.GeomAbs_Torus, ga.GeomAbs_SurfaceOfExtrusion]);
  out.hard = [];   // per face: a surface whose intersections are slow to find (splines, offsets, revolutions)
  eachFace(shape.wrapped, (f) => {
    const face = OC.TopoDS.Face_1(f), ad = new OC.BRepAdaptor_Surface_2(face, false);
    out.hard.push(!easy.has(ad.GetType())); ad.delete(); face.delete();
    const box = new OC.Bnd_Box_1(); OC.BRepBndLib.Add(f, box, true);
    const lo = box.CornerMin(), hi = box.CornerMax();
    out.push(lo.X(), lo.Y(), lo.Z(), hi.X(), hi.Y(), hi.Z());
    lo.delete(); hi.delete(); box.delete();
  });
  if (k) { if (faceBoxCache.size >= 1024) faceBoxCache.delete(faceBoxCache.keys().next().value); faceBoxCache.set(k, out); }
  return out;
};
/**
 * Do the surfaces of two shapes cross or touch? Only the faces whose boxes come within `pad` of a face of the other
 * are intersected, so a 60-tooth gear on a pin costs its bore and the pin, not every tooth. False means no face of
 * one meets a face of the other: the shapes share volume only if one lies wholly inside the other (the caller's to rule out).
 * True also when it was not worth finding out (spline faces): the caller measures.
 */
export function brepSurfacesMeet(a, b, pad = 0.01) {
  const started = performance.now();
  try { return surfacesMeet(a, b, pad); } finally { recordOperation('nearFaces', performance.now() - started, false); }   // counted like any op: /api/health shows what the test costs
}
function surfacesMeet(a, b, pad) {
  const A = faceBoxes(a), B = faceBoxes(b), keepA = new Set(), keepB = new Set();
  for (let i = 0; i < A.length; i += 6) for (let j = 0; j < B.length; j += 6) {
    if (A[i] - pad > B[j + 3] || B[j] - pad > A[i + 3] || A[i + 1] - pad > B[j + 4] || B[j + 1] - pad > A[i + 4] || A[i + 2] - pad > B[j + 5] || B[j + 2] - pad > A[i + 5]) continue;
    keepA.add(i / 6); keepB.add(j / 6);
  }
  if (!keepA.size) return false;
  // ponytail: one spline face near the other part sends the pair to the boolean. Intersecting two spline faces that
  // are clear of each other took up to ten times the boolean (Attention Object).
  if ([...keepA].some((i) => A.hard[i]) || [...keepB].some((j) => B.hard[j])) return true;
  const builder = new OC.TopoDS_Builder(), ca = new OC.TopoDS_Compound(), cb = new OC.TopoDS_Compound(), progress = new OC.Message_ProgressRange_1();
  let sec = null, ex = null;
  try {
    builder.MakeCompound(ca); builder.MakeCompound(cb);
    eachFace(a.wrapped, (f, i) => { if (keepA.has(i)) builder.Add(ca, f); });
    eachFace(b.wrapped, (f, i) => { if (keepB.has(i)) builder.Add(cb, f); });
    sec = new OC.BRepAlgoAPI_Section_3(ca, cb, false); sec.Build(progress);
    if (!sec.IsDone()) return true;
    ex = new OC.TopExp_Explorer_2(sec.Shape(), OC.TopAbs_ShapeEnum.TopAbs_VERTEX, OC.TopAbs_ShapeEnum.TopAbs_SHAPE);
    return ex.More();
  } finally { for (const o of [ex, sec, progress, ca, cb, builder]) try { o?.delete(); } catch { /* gone */ } }
}

/** A shape as OCCT's binary BRep, and back (UNTRACKED: the caller owns the shape). The on-disk cell cache (cells.js). */
export function brepToBuffer(shape) {
  const name = `/cache-${process.pid}-${Date.now()}.brep`, progress = new OC.Message_ProgressRange_1();
  try {
    if (!OC.BinTools.Write_3(shape.wrapped, name, progress)) throw new Error('BRep write failed');
    return Buffer.from(OC.FS.readFile(name));
  } finally { progress.delete(); try { OC.FS.unlink(name); } catch { /* never written */ } }
}
export function brepFromBuffer(buffer) {
  const name = `/cache-${process.pid}-${Date.now()}.brep`, progress = new OC.Message_ProgressRange_1();
  const shape = new OC.TopoDS_Shape();
  try {
    OC.FS.writeFile(name, new Uint8Array(buffer));
    if (!OC.BinTools.Read_2(shape, name, progress)) throw new Error('BRep read failed');
    return kernel().cast(shape);
  } finally { progress.delete(); try { OC.FS.unlink(name); } catch { /* never written */ } }
}

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

// ------------------------------------------------------------ local fillet
//
// OCCT's fillet walks each seam to its end vertices and gives up when an end is complicated (several
// faces meeting, a seam running into a bend): "PerformSurf: failed approximation", at any radius, although
// the middle of the seam is easy. So when the whole-body fillet fails, each seam is filleted on its own
// inside a tube cut out around it: the tube's flat caps are the only ends the fillet ever sees. The seam
// stops `setback` short of its real ends and the radius runs out to almost nothing over `runout`, so the
// fillet fades into the corner instead of stopping at a step. Then the tube is fused back.

const EDGE_SAMPLES = 96;

/** An edge as positions along its length: samples [[x,y,z]…] at even parameter steps, and its tangents at both ends. */
function edgeTrack(edge) {
  const c = new OC.BRepAdaptor_Curve_2(edge), p = new OC.gp_Pnt_1(), v = new OC.gp_Vec_1();
  try {
    const u0 = c.FirstParameter(), u1 = c.LastParameter(), pts = [];
    for (let i = 0; i <= EDGE_SAMPLES; i++) { c.D1(u0 + (u1 - u0) * i / EDGE_SAMPLES, p, v); pts.push(pnt(p)); }
    c.D1(u0, p, v); const t0 = unit3([v.X(), v.Y(), v.Z()]);
    c.D1(u1, p, v); const t1 = unit3([v.X(), v.Y(), v.Z()]);
    let length = 0; const at = [0];
    for (let i = 1; i < pts.length; i++) { length += Math.hypot(...sub3(pts[i], pts[i - 1])); at.push(length); }
    return { edge, u0, u1, pts, at, length, t0, t1 };
  } finally { c.delete(); p.delete(); v.delete(); }
}

/** Selected edges joined end to end where they meet tangent: [{ links: [{ e, rev }], closed }]. */
function tangentChains(tracks) {
  const TOL = 1e-4, left = new Set(tracks), chains = [];
  const end = (l, tail) => { const first = tail === l.rev; return { p: first ? l.e.pts[0] : l.e.pts[EDGE_SAMPLES], t: first ? l.e.t0 : l.e.t1 }; };
  const joins = (a, b) => Math.hypot(...sub3(a.p, b.p)) < TOL && Math.abs(dot3(a.t, b.t)) > 0.999;
  while (left.size) {
    const first = left.values().next().value; left.delete(first);
    const links = [{ e: first, rev: false }];
    for (const grow of [true, false]) {             // forwards off the tail, then backwards off the head
      for (let found = true; found;) {
        found = false;
        const here = grow ? end(links[links.length - 1], true) : end(links[0], false);
        for (const e of left) {
          for (const rev of [false, true]) {
            const l = { e, rev };
            if (!joins(here, end(l, !grow))) continue;
            left.delete(e); if (grow) links.push(l); else links.unshift(l);
            found = true; break;
          }
          if (found) break;
        }
      }
    }
    const closed = links.length > 0 && joins(end(links[links.length - 1], true), end(links[0], false))
      && (links.length > 1 || Math.hypot(...sub3(first.pts[0], first.pts[EDGE_SAMPLES])) < TOL);
    chains.push({ links, closed, length: links.reduce((n, l) => n + l.e.length, 0) });
  }
  return chains;
}

/** The stretch of a chain between two distances along it: its polyline, and the point and tangent at each end. */
function chainStretch(chain, from, to, trash) {
  const line = []; let base = 0, start = null, finish = null;
  for (const { e, rev } of chain.links) {
    const a = Math.max(from, base) - base, b = Math.min(to, base + e.length) - base; base += e.length;
    if (b - a < 1e-7) continue;
    // distance along the edge -> parameter, through the samples (a spline's parameter is not its length)
    const param = (d) => {
      const want = rev ? e.length - d : d; let i = 1;
      while (i < EDGE_SAMPLES && e.at[i] < want) i++;
      const f = (want - e.at[i - 1]) / Math.max(e.at[i] - e.at[i - 1], 1e-12);
      return e.u0 + (e.u1 - e.u0) * (i - 1 + Math.min(Math.max(f, 0), 1)) / EDGE_SAMPLES;
    };
    const ua = param(a), ub = param(b), lo = Math.min(ua, ub), hi = Math.max(ua, ub);
    const curve = OC.BRep_Tool.Curve_2(e.edge, { current: 0 }, { current: 0 }), mk = new OC.BRepBuilderAPI_MakeEdge_25(curve, lo, hi);
    trash.push(curve, mk);
    const piece = mk.Edge(), c = new OC.BRepAdaptor_Curve_2(piece), p = new OC.gp_Pnt_1(), v = new OC.gp_Vec_1();
    trash.push(c, p, v);
    const N = Math.max(16, Math.ceil((b - a) / 0.25)), seg = [];   // 0.25 mm steps: the chord error stays far under the on-the-seam test
    for (let i = 0; i <= N; i++) seg.push(pnt(c.Value(lo + (hi - lo) * i / N)));
    if (ua > ub) seg.reverse();
    const way = ua > ub ? -1 : 1;   // tangents point the way the chain runs, which on a reversed edge is against its parameter
    if (!start) { c.D1(ua, p, v); start = { p: pnt(p), t: unit3([v.X() * way, v.Y() * way, v.Z() * way]) }; }
    c.D1(ub, p, v); finish = { p: pnt(p), t: unit3([v.X() * way, v.Y() * way, v.Z() * way]) };
    line.push(...seg);
  }
  const at = [0];
  for (let i = 1; i < line.length; i++) at.push(at[i - 1] + Math.hypot(...sub3(line[i], line[i - 1])));
  return { start, finish, line, at };
}

/** Closest approach of a point to a polyline, and how far along the polyline that is. */
function alongPolyline(line, at, p) {
  let best = Infinity, where = 0;
  for (let i = 1; i < line.length; i++) {
    const ab = sub3(line[i], line[i - 1]), len2 = dot3(ab, ab);
    const f = len2 > 0 ? Math.min(Math.max(dot3(sub3(p, line[i - 1]), ab) / len2, 0), 1) : 0;
    const d = Math.hypot(...sub3(p, line[i - 1].map((c, k) => c + ab[k] * f)));
    if (d < best) { best = d; where = at[i - 1] + (at[i] - at[i - 1]) * f; }
  }
  return { distance: best, where };
}

/** Degrees a chain has turned through by a distance along it: fn(distance). */
function chainTurns(chain) {
  const at = [0], deg = [0]; let prev = null;
  for (const { e, rev } of chain.links) {
    const pts = rev ? [...e.pts].reverse() : e.pts;
    for (let i = 1; i < pts.length; i++) {
      const d = sub3(pts[i], pts[i - 1]), len = Math.hypot(...d), t = unit3(d);
      if (!t) continue;
      const bend = prev ? Math.acos(Math.min(1, Math.max(-1, dot3(prev, t)))) * 180 / Math.PI : 0;
      at.push(at[at.length - 1] + len); deg.push(deg[deg.length - 1] + bend); prev = t;
    }
  }
  return (d) => { let i = 1; while (i < at.length - 1 && at[i] < d) i++; return deg[i]; };
}

/**
 * The block a stretch of seam is filleted in: a cylinder along it, `reach` to every side, with flat ends square to
 * the seam where the stretch starts and stops. Flat-sided on purpose: a tube swept along a curved seam took over a
 * minute to cut out of a lofted body, planes take a fraction of a second.
 */
function stretchBlock(st, reach, trash, progress) {
  // a cylinder along the stretch's chord, `reach` to every side (plus the stretch's own bulge): it hugs the seam,
  // where an axis-aligned box around a diagonal stretch is fat enough to swallow a later part of a seam that curls back
  const p0 = st.line[0], p1 = st.line[st.line.length - 1], chord = sub3(p1, p0), len = Math.hypot(...chord);
  const n0 = unit3(chord) ?? st.start.t, x0 = unit3(cross3(n0, Math.abs(n0[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0])), y0 = cross3(n0, x0);
  const bulge = Math.max(...st.line.map((q) => { const d = sub3(q, p0), along = dot3(d, n0); return Math.hypot(...d.map((c, k) => c - n0[k] * along)); }));
  const half = reach + bulge, origin = p0.map((c, k) => c - half * n0[k]);
  const o0 = new OC.gp_Pnt_3(...origin), nd0 = new OC.gp_Dir_4(...n0), xd0 = new OC.gp_Dir_4(...x0), ax0 = new OC.gp_Ax2_2(o0, nd0, xd0);
  const box = new OC.BRepPrimAPI_MakeCylinder_3(ax0, half, len + 2 * half);   // round, not square: a cylinder cuts out of tube-shaped parts several times faster than flat sides do
  trash.push(o0, nd0, xd0, ax0, box);
  let block = box.Shape();
  const S = 8 * (len + half);
  for (const [end, sign] of [[st.start, -1], [st.finish, 1]]) block = sliceBeyond(block, end.p, end.t.map((c) => c * sign), S, trash, progress);
  return block;
}

/** `block` without what lies beyond the plane through `p` with outward normal `n`. */
function sliceBeyond(block, p, n, S, trash, progress) {
  const x = unit3(cross3(n, Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0])), y = cross3(n, x);
  const corner = p.map((c, k) => c - S * x[k] - S * y[k]);
  const o = new OC.gp_Pnt_3(...corner), nd = new OC.gp_Dir_4(...n), xd = new OC.gp_Dir_4(...x), ax = new OC.gp_Ax2_2(o, nd, xd);
  const beyond = new OC.BRepPrimAPI_MakeBox_5(ax, 2 * S, 2 * S, 2 * S), cut = new OC.BRepAlgoAPI_Cut_3(block, beyond.Shape(), progress);
  trash.push(o, nd, xd, ax, beyond, cut);
  return cut.Shape();
}

/** A box from corner to corner: the block for a whole seam, or for a small closed loop filleted in one go. */
function wholeBlock(lo, hi, trash) {
  const a = new OC.gp_Pnt_3(...lo), b = new OC.gp_Pnt_3(...hi), box = new OC.BRepPrimAPI_MakeBox_4(a, b);
  trash.push(a, b, box);
  return box.Shape();
}

/**
 * Fillet `edges` of `shape` one tangent chain at a time, each inside a tube cut out around it.
 * `runout`: length over which the radius fades at each open end (default 3 × radius); `setback`: how far short of
 * the seam's ends it stops (default 0.1 × radius, at least 0.2); `reach`: how far the block extends around the seam (default 3 × radius + 1).
 */
export function brepLocalFillet(shape, edges, radius, { runout = null, setback = null, reach = null } = {}) {
  const progress = new OC.Message_ProgressRange_1();
  const solidsIn = [...kernel().iterTopo(shape.wrapped, 'solid')].length;
  const around = reach ?? radius * 3 + 1, back = setback ?? Math.max(0.2, radius * 0.1), tip = Math.max(radius * 0.05, 0.05);
  const trace = process.env.CADGANG_FILLET_TRACE ? (m, t0) => console.error(`  [fillet] ${m} ${Date.now() - t0} ms`) : () => {};
  let cur = shape.wrapped;
  try {
    for (const chain of tangentChains(edges.map((e) => edgeTrack(e.wrapped)))) {
      const where = chain.links[0].e.pts[EDGE_SAMPLES / 2].map((c) => +c.toFixed(1));
      const L = chain.length, turn = chainTurns(chain), all = chain.links.flatMap((l) => l.e.pts);
      const lo = [0, 1, 2].map((k) => Math.min(...all.map((q) => q[k])) - around), hi = [0, 1, 2].map((k) => Math.max(...all.map((q) => q[k])) + around);
      if (!chain.closed && L - 2 * back < radius) throw new GraphError(`fillet: the seam near [${where}] is too short (${L.toFixed(1)} mm) for a local R${radius} fillet`);
      // Stretches of the chain, each with the radius at its two ends. The constant part goes in pieces that each
      // turn under 60 degrees, so a piece's flat ends never slice the seam twice; a small closed loop goes whole.
      const steady = (from, to, least = 1) => { const n = Math.max(least, Math.ceil((turn(to) - turn(from)) / 60)); return Array.from({ length: n }, (_, i) => [from + (to - from) * i / n, from + (to - from) * (i + 1) / n, radius, radius]); };
      const whole = chain.closed && Math.max(...hi.map((h, k) => h - lo[k])) - 2 * around <= 6 * around;
      const fade = chain.closed ? 0 : Math.min(runout ?? radius * 3, (L - 2 * back) * 0.45);
      const stretches = whole ? [[0, L, radius, radius]] : chain.closed ? steady(0, L, 3)
        : [[back, back + fade, tip, radius], ...steady(back + fade, L - back - fade), [L - back - fade, L - back, radius, tip]];

      // One stretch at a time, each cut out of the body in a block that hugs it, filleted, and fused back. Every
      // larger cut tried instead was worse on a body with lofted faces: a box around the whole seam reaches past
      // its ends into the corners it was meant to avoid and came back EMPTY without an error (caught below: no
      // seam edge in the piece); the union of the stretches' blocks took over ten minutes to cut out.
      for (const [from, to, r0, r1] of stretches) {
        if (to - from < 1e-6) continue;
        const trash = []; let t0 = Date.now();
        try {
          const st = chainStretch(chain, from, to, trash);
          const block = whole ? wholeBlock(lo, hi, trash) : stretchBlock(st, around, trash, progress);
          // On a body with lofted faces the kernel sometimes answers a Common with nothing and no error: ask again
          // the other way round, then with a hair of fuzz, before giving up.
          const hasEdges = (sh) => !kernel().iterTopo(sh, 'edge').next().done;
          let taken = new OC.BRepAlgoAPI_Common_3(cur, block, progress); trash.push(taken);
          if (!hasEdges(taken.Shape())) { taken = new OC.BRepAlgoAPI_Common_3(block, cur, progress); trash.push(taken); if (process.env.CADGANG_FILLET_TRACE) console.error('  [fillet] empty piece, asked the other way round'); }
          if (!hasEdges(taken.Shape())) {
            const la = new OC.TopTools_ListOfShape_1(), lt = new OC.TopTools_ListOfShape_1(); taken = new OC.BRepAlgoAPI_Common_1(); trash.push(taken, la, lt);
            la.Append_1(cur); lt.Append_1(block); taken.SetArguments(la); taken.SetTools(lt); taken.SetFuzzyValue(1e-3); taken.Build(progress);
            if (process.env.CADGANG_FILLET_TRACE) console.error('  [fillet] empty piece, asked with fuzz');
          }
          const outside = new OC.BRepAlgoAPI_Cut_3(cur, block, progress);
          trash.push(outside);
          const fil = new OC.BRepFilletAPI_MakeFillet(taken.Shape(), OC.ChFi3d_FilletShape.ChFi3d_Rational); trash.push(fil);
          let added = 0, seen = 0, nearest = Infinity;
          for (const sub of kernel().iterTopo(taken.Shape(), 'edge')) {
            const e = OC.TopoDS.Edge_1(sub), c = new OC.BRepAdaptor_Curve_2(e);
            const u0 = c.FirstParameter(), u1 = c.LastParameter();
            const on = [0, 0.25, 0.5, 0.75, 1].map((f) => alongPolyline(st.line, st.at, pnt(c.Value(u0 + (u1 - u0) * f))));
            c.delete(); seen++; nearest = Math.min(nearest, Math.max(...on.map((h) => h.distance)));
            if (on.some((h) => h.distance > 0.01) || Math.abs(on[4].where - on[0].where) < 1e-3) continue;   // not the seam
            const span = st.at[st.at.length - 1], rAt = (h) => r0 + (r1 - r0) * (span > 0 ? h.where / span : 0);
            try {
              if (r0 === r1) fil.Add_2(radius, e); else fil.Add_3(rAt(on[0]), rAt(on[4]), e);
              added++;
            } catch { /* already part of a contour that an earlier edge started */ }
          }
          if (!added) {
            const vol = (sh) => { const g = new OC.GProp_GProps_1(); try { OC.BRepGProp.VolumeProperties_1(sh, g, false, false, false); return g.Mass().toFixed(0); } catch { return '?'; } finally { g.delete(); } };
            console.error(`  [fillet] block ${vol(block)} mm3, piece ${vol(taken.Shape())} mm3, ends ${JSON.stringify([st.start, st.finish].map((q) => [q.p.map((c) => +c.toFixed(1)), q.t.map((c) => +c.toFixed(2))]))}`);
          }
          if (!added) throw new GraphError(`fillet: lost the seam near [${where}] inside its block (stretch ${from.toFixed(1)}-${to.toFixed(1)} of ${L.toFixed(1)} mm; ${seen} edges there, the closest ${nearest.toFixed(3)} mm off the seam) — try a smaller reach`);
          try { fil.Build(progress); } catch (e) { throw new GraphError(`fillet: the local fillet near [${where}] failed too (${occtMessage(e)}) — try a smaller radius or a longer setback`); }
          if (!fil.IsDone()) throw new GraphError(`fillet: the local fillet near [${where}] failed too — try a smaller radius or a longer setback`);
          // the two pieces only touch, on the block's flat faces: say so (glue) and the fuse skips looking for overlaps
          const fuse = new OC.BRepAlgoAPI_Fuse_1(), fa = new OC.TopTools_ListOfShape_1(), ft = new OC.TopTools_ListOfShape_1(); trash.push(fuse, fa, ft);
          fa.Append_1(outside.Shape()); ft.Append_1(fil.Shape()); fuse.SetArguments(fa); fuse.SetTools(ft);
          fuse.SetGlue(OC.BOPAlgo_GlueEnum.BOPAlgo_GlueShift); fuse.Build(progress);
          cur = unified(fuse.Shape());   // merges the faces the block's cuts split back together
          trace(`near [${where}] stretch ${from.toFixed(1)}-${to.toFixed(1)} of ${L.toFixed(1)} mm`, t0);
        } finally {
          for (const o of trash) { try { o.delete(); } catch { /* a handle the kernel already released */ } }
        }
      }
    }
    const check = new OC.BRepCheck_Analyzer(cur, true, false);
    const sound = check.IsValid_2(); check.delete();
    const out = track(kernel().cast(cur));
    if (!sound || [...kernel().iterTopo(cur, 'solid')].length !== solidsIn) throw new GraphError('fillet: the local fillet could not be fused back into one valid solid');
    return out;
  } finally {
    progress.delete();
  }
}

// ------------------------------------------------------------ the fillet itself
//
// The builder is driven here rather than through replicad so that a radius can vary along a seam, the result
// is checked, and, when the whole selection will not build, each seam can be tried on its own.

/** One build: every item's edge at its radius [a, b] (a at the seam's end nearer `from`, else its lower end) or by its law. The checked result. */
function filletBuild(wrapped, items, from, trash, progress) {
  const fil = new OC.BRepFilletAPI_MakeFillet(wrapped, OC.ChFi3d_FilletShape.ChFi3d_Rational); trash.push(fil);
  const far = (q, o) => Math.hypot(...sub3(q, o));
  for (const { edge, r, law } of items) {
    const before = fil.NbContours(), constant = !law && r[0] === r[1];
    try { if (constant) fil.Add_2(r[0], edge); else fil.Add_1(edge); } catch { continue; }
    if (constant || fil.NbContours() === before) continue;   // constant, or already on a seam an earlier edge started
    const ic = fil.NbContours(), closed = fil.Closed(ic);
    const v0 = fil.FirstVertex(ic), v1 = fil.LastVertex(ic), p0 = pnt(OC.BRep_Tool.Pnt(v0)), p1 = pnt(OC.BRep_Tool.Pnt(v1));
    const startsAtFirst = closed || (from ? far(p0, from) <= far(p1, from) : ((p0[2] - p1[2]) || (p0[1] - p1[1]) || (p0[0] - p1[0])) <= 0);
    if (!law) {
      if (closed) throw new GraphError('fillet: [start, end] needs a seam with two ends, and this one is a closed loop — give it one radius, or stops [[0, r], …, [1, r]]');
      fil.SetRadius_6(startsAtFirst ? r[0] : r[1], ic, v0); fil.SetRadius_6(startsAtFirst ? r[1] : r[0], ic, v1);
      continue;
    }
    // A law: the radius at 17 places along every edge of the seam, which the kernel interpolates. Each edge is
    // walked the way the seam runs, whichever way its own parameter does.
    const tracks = []; let run = p0, L = 0;
    for (let j = 1; j <= fil.NbEdges(ic); j++) {
      const tr = edgeTrack(fil.Edge(ic, j)), fwd = far(tr.pts[0], run) <= far(tr.pts[EDGE_SAMPLES], run);
      run = fwd ? tr.pts[EDGE_SAMPLES] : tr.pts[0]; L += tr.length; tracks.push({ tr, fwd });
    }
    let cum = 0;
    tracks.forEach(({ tr, fwd }, j) => {
      const K = 16, arr = new OC.TColgp_Array1OfPnt2d_2(1, K + 1); trash.push(arr);
      for (let k = 0; k <= K; k++) {
        const i = Math.round(k / K * EDGE_SAMPLES), pi = fwd ? i : EDGE_SAMPLES - i;
        const t = L > 0 ? (cum + (fwd ? tr.at[pi] : tr.length - tr.at[pi])) / L : 0;
        const g = new OC.gp_Pnt2d_3(k / K, Math.max(law(tr.pts[pi], startsAtFirst ? t : 1 - t), 0.02));
        arr.SetValue(k + 1, g); g.delete();
      }
      fil.SetRadius_4(arr, ic, j + 1); cum += tr.length;
    });
  }
  if (!fil.NbContours()) throw new GraphError('fillet: none of the selected edges can be filleted');
  fil.Build(progress);
  if (!fil.IsDone()) throw new GraphError('fillet failed: the radius or distance is too large for the neighbouring faces — reduce it, or fillet/chamfer fewer edges at once');
  const out = fil.Shape(), check = new OC.BRepCheck_Analyzer(out, true, false), sound = check.IsValid_2(); check.delete();
  // The kernel also answers a radius that cannot fit with a broken shape and no error (a box filleted past half
  // its height came back with more volume than the box).
  if (!sound) throw new GraphError('fillet failed: the radius or distance is too large for the neighbouring faces — reduce it, or fillet/chamfer fewer edges at once (the kernel built a broken shape)');
  return out;
}

const released = (trash) => { for (const o of trash) { try { o.delete(); } catch { /* a handle the kernel already released */ } } };

/** Positions along an edge, and how far a point is from it: what a radius law is written with. */
export function brepEdgePoints(edge) { return edgeTrack(edge).pts; }
export function brepEdgeDistance(edge) { const tr = edgeTrack(edge); return (p) => alongPolyline(tr.pts, tr.at, p).distance; }

/** Fillet every item of `shape` in one build: { edge, r: [a, b] }, or { edge, law: (point, t) => radius } with t 0…1 along the seam. */
export function brepFillet(shape, items, { from = null } = {}) {
  const progress = new OC.Message_ProgressRange_1(), trash = [progress];
  try { return track(kernel().cast(filletBuild(shape.wrapped, items, from, trash, progress))); } finally { released(trash); }
}

/**
 * Fillet the items one seam at a time, for a selection that will not build at once: a seam that fails at its
 * radius is tried at a half and a quarter, then left sharp, and the others still get theirs.
 * Returns { shape (null when no seam took a fillet), reduced: [{ at, r, to }], skipped: [{ at, r }] }.
 */
export function brepFilletEach(shape, items, { from = null, budgetMs = 30000 } = {}) {
  const progress = new OC.Message_ProgressRange_1(), trash = [progress], started = Date.now(), reduced = [], skipped = [];
  const solids = (w) => [...kernel().iterTopo(w, 'solid')].length, solidsIn = solids(shape.wrapped);
  let cur = shape.wrapped, done = 0;
  try {
    for (const it of items) {
      // What is left of this edge on the body as it now stands: an earlier seam's fillet may have trimmed it, or run through it.
      const tr = edgeTrack(it.edge), tol = 0.01 + 0.01 * tr.length / EDGE_SAMPLES, live = [];
      for (const sub of kernel().iterTopo(cur, 'edge')) {
        const e = OC.TopoDS.Edge_1(sub), c = new OC.BRepAdaptor_Curve_2(e), u0 = c.FirstParameter(), u1 = c.LastParameter();
        const on = [0, 0.25, 0.5, 0.75, 1].map((f) => alongPolyline(tr.pts, tr.at, pnt(c.Value(u0 + (u1 - u0) * f))));
        c.delete();
        if (on.every((h) => h.distance < tol) && Math.abs(on[4].where - on[0].where) > 1e-3) live.push(e);
      }
      if (!live.length) continue;
      // ponytail: every seam is a build of the whole body; past the budget the rest stay sharp and are reported
      let took = false;
      for (const k of Date.now() - started > budgetMs ? [] : [1, 0.5, 0.25]) {
        try {
          const out = filletBuild(cur, live.map((edge) => ({ edge, r: it.r.map((v) => v * k) })), from, trash, progress);
          if (solids(out) !== solidsIn) continue;
          cur = out; took = true; done++;
          if (k < 1) reduced.push({ at: it.at, r: it.r, to: it.r.map((v) => v * k) });
          break;
        } catch (e) { if (e instanceof GraphError && /closed loop/.test(e.message)) throw e; }
      }
      if (!took) skipped.push({ at: it.at, r: it.r });
    }
    return { shape: done ? track(kernel().cast(cur)) : null, reduced, skipped };
  } finally { released(trash); }
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
      const out = track(kernel().makeOffset(shape, distance));
      // A body with fillets meeting at a corner comes back as a bare shell, which no boolean accepts
      // ("This shape has not type, it is null"): close it into the solid it bounds.
      return kernel().iterTopo(out.wrapped, 'solid').next().done ? track(kernel().makeSolid([out])) : out;
    } catch (e) {
      if (distance < 0 && /null|not type/i.test(String(e?.message))) {
        throw new GraphError(
          `offset by ${distance} mm left nothing: some feature of the part is thinner than ${2 * -distance} mm and collapsed — ` +
          `a fillet with a radius under the wall thickness is the usual one (shell BEFORE filleting, or fillet with radius ≥ wall)`
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

// ------------------------------------------------------------ part names
// What a STEP file calls each solid. A cell's result is named after the cell ("lid"); a compound of
// named results keeps each one's name for its solids, in order. Kept beside the shape, not on it:
// an op that makes a new shape (a translate, a fuse) starts it unnamed, and the cell it ends in names it.
const partNames = new WeakMap();   // shape → [{ name, count }]: `count` solids in a row are `name`

/** The parts of a shape, in solid order, or null when nothing named it. */
export const partsOf = (shape) => (shape && partNames.get(shape)) || null;
/** Set a shape's parts. */
export function setParts(shape, parts) { if (shape && parts?.length) partNames.set(shape, parts); return shape; }
/** Name a shape's solids `name` unless it already carries part names (a compound of named parts). */
export function nameParts(shape, name) {
  if (!shape || partNames.has(shape) || typeof shape.blobSTEP !== 'function') return shape;
  try { partNames.set(shape, [{ name, count: brepBodies(shape) }]); } catch { /* not a solid: nothing to name */ }
  return shape;
}

/** Several shapes kept as separate bodies in one compound: an assembly, nothing fused. */
export function brepCompound(shapes) {
  // a boolean often hands back its one solid wrapped in a compound: add the solid, so only a real group (two or more) becomes a sub-assembly in the STEP
  const one = (s) => {
    if (s.wrapped.ShapeType() !== OC.TopAbs_ShapeEnum.TopAbs_COMPOUND) return s;
    const solids = [...rc.iterTopo(s.wrapped, 'solid')];
    if (solids.length !== 1) return s;
    s.delete();
    return rc.cast(solids[0]);
  };
  return attempt('compound', () => track(rc.compoundShapes(shapes.map(one))));
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

// -------------------------------------------------------------- STEP file I/O

/**
 * Serialise a B-rep solid as a STEP AP214 file. Returns a Buffer. Each solid is written as a product
 * named for its part (partsOf), else `name`: "lid", "tray" in the file, not OCCT's "Open CASCADE STEP
 * translator 7.6 1.2". A part of several solids is "name", "name 2", … No colours are written, as before.
 */
export async function exportStep(shape, { name = 'part' } = {}) {
  requireSolid(shape, 'shape');
  if (typeof shape.blobSTEP !== 'function') {
    throw new GraphError('This shape has no exact B-rep to write — export it as STL instead');
  }
  try {
    return namedStep(shape, name);
  } catch {
    const blob = await attempt('STEP export', () => shape.blobSTEP());   // the plain writer, unnamed, if the named one fails
    return Buffer.from(await blob.arrayBuffer());
  }
}

/** The solids of a shape with their names: [{ solid (TopoDS), name }] in file order. */
function namedSolids(shape, name) {
  const solids = [...kernel().iterTopo(shape.wrapped, 'solid')];
  const parts = partsOf(shape);
  const names = [];
  if (parts && parts.reduce((n, p) => n + p.count, 0) === solids.length) {
    const seen = new Map();
    for (const p of parts) for (let i = 0; i < p.count; i++) {
      const base = p.name || name, k = (seen.get(base) ?? 0) + 1;
      seen.set(base, k);
      names.push(k === 1 ? base : `${base} ${k}`);
    }
  } else solids.forEach((_, i) => names.push(solids.length === 1 ? name : `${name} ${i + 1}`));
  return solids.map((solid, i) => ({ solid, name: names[i] }));
}

function namedStep(shape, name) {
  const file = `/export-${Date.now()}-${Math.random().toString(36).slice(2)}.step`;
  const str = (s) => new OC.TCollection_ExtendedString_2(s, true);
  const doc = new OC.TDocStd_Document(str('XmlOcaf'));
  try {
    OC.XCAFDoc_ShapeTool.SetAutoNaming(false);
    const tool = OC.XCAFDoc_DocumentTool.ShapeTool(doc.Main()).get();
    // the shape as it was built: a compound is an assembly, a compound inside it a sub-assembly (a cell's groups), the solids its parts
    const root = tool.AddShape(shape.wrapped, true, false);
    OC.TDataStd_Name.Set_1(root, str(name));
    let g = 0;   // sub-assemblies by walking the components (child labels 1, 2, …): an explorer stops at the first compound it meets
    const groups = (asm) => {
      for (let t = 1, comp; !(comp = asm.FindChild(t, false)).IsNull(); t++) {
        const ref = new OC.TDF_Label();
        if (OC.XCAFDoc_ShapeTool.GetReferredShape(comp, ref) && OC.XCAFDoc_ShapeTool.IsAssembly(ref)) { OC.TDataStd_Name.Set_1(ref, str(`${name} group ${++g}`)); groups(ref); }
      }
    };
    groups(root);
    for (const { solid, name: n } of namedSolids(shape, name)) {
      const label = tool.FindShape_2(solid, false);
      if (!label.IsNull()) OC.TDataStd_Name.Set_1(label, str(n));
    }
    tool.UpdateAssemblies();
    // the session and the document belong to the handles made from them: nothing here is freed by hand (freeing them broke the next export)
    const session = new OC.XSControl_WorkSession();
    const writer = new OC.STEPCAFControl_Writer_2(new OC.Handle_XSControl_WorkSession_2(session), false);
    writer.SetNameMode(true);
    writer.SetColorMode(false);
    OC.Interface_Static.SetIVal('write.step.assembly', 2);
    OC.Interface_Static.SetIVal('write.step.schema', 5);
    const progress = new OC.Message_ProgressRange_1();
    if (!writer.Transfer_1(new OC.Handle_TDocStd_Document_2(doc), OC.STEPControl_StepModelType.STEPControl_AsIs, null, progress)) throw new Error('transfer');
    if (writer.Write(file) !== OC.IFSelect_ReturnStatus.IFSelect_RetDone) throw new Error('write');
    return Buffer.from(OC.FS.readFile(file));
  } finally {
    try { OC.FS.unlink(file); } catch { /* never written */ }
  }
}

/**
 * The same, synchronously, for cell programs (which cannot await): the bytes go
 * to OCCT through its virtual FS. Returns the file's solids in file order,
 * UNTRACKED — the caller owns them (ops.importStep keeps them across runs).
 */
export function importStepSolids(buffer) {
  const k = kernel();
  const name = `/import-${Date.now()}-${Math.random().toString(36).slice(2)}.step`;
  return attempt('STEP import', () => {
    OC.FS.writeFile(name, new Uint8Array(buffer));
    const reader = new OC.STEPControl_Reader_1();
    try {
      if (!reader.ReadFile(name)) throw new GraphError('the file is not readable STEP');
      reader.TransferRoots(new OC.Message_ProgressRange_1());
      return [...k.iterTopo(reader.OneShape(), 'solid')].map((s) => k.cast(s));
    } finally {
      OC.FS.unlink(name);
      reader.delete();
    }
  });
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

// One edit is tessellated three times at the same tolerance — the pane's mesh, the history's look, Claude's
// render — so a keyed shape's mesh is kept (keys are content hashes: a hit is the same geometry).
// A byte budget, not a count: an assembly's parts each hold a viewport mesh, its edges, a render mesh and a
// scrub mesh, and a count of 24 thrashed on fifteen parts (every request re-meshed them all).
const MESH_CACHE_BYTES = parseInt(process.env.CADGANG_MESH_CACHE_MB || '192', 10) * 2 ** 20;
const meshCache = new Map();
let meshCacheBytes = 0;
const meshBytes = (v) => (v.positions?.byteLength ?? 0) + (v.normals?.byteLength ?? 0) + (v.indices?.byteLength ?? 0) + (v.lines?.length ?? 0) * 8 + 1024;
const cachedMesh = (shape, tolerance, angularTolerance, make, tag = '') => {
  const k = shape?.__key ? `${shape.__key}|${tolerance}|${angularTolerance}${tag}` : null;
  if (k && meshCache.has(k)) { const v = meshCache.get(k); meshCache.delete(k); meshCache.set(k, v); return v; }
  const v = make();
  if (k && v) {
    meshCache.set(k, v); meshCacheBytes += meshBytes(v);
    while (meshCacheBytes > MESH_CACHE_BYTES && meshCache.size > 1) { const [old, gone] = meshCache.entries().next().value; meshCache.delete(old); meshCacheBytes -= meshBytes(gone); }
  }
  return v;
};
// The same meshes on disk, when the kernel asks for it (persistMeshes): a fresh kernel reads a part's BRep from the
// cell cache in milliseconds and then spent a second meshing forty-eight bodies it had meshed before.
// ponytail: a file per part mesh, pruned by count when the kernel starts; bump the folder's number if the mesher changes.
let meshDir = null;
export function persistMeshes(dir, keep = 3000) {
  if (!dir) { meshDir = null; return; }
  try {
    meshDir = path.join(dir, '1'); fs.mkdirSync(meshDir, { recursive: true });
    const files = fs.readdirSync(meshDir);
    if (files.length > keep) {
      const at = (f) => { try { return fs.statSync(path.join(meshDir, f)).mtimeMs; } catch { return 0; } };
      for (const f of files.sort((a, b) => at(a) - at(b)).slice(0, files.length - keep * 2 / 3)) try { fs.unlinkSync(path.join(meshDir, f)); } catch { /* gone */ }
    }
  } catch { meshDir = null; }
}
const meshOnDisk = (shape, tolerance, angularTolerance, make) => {
  if (!meshDir || !shape?.__key) return make();
  const file = path.join(meshDir, crypto.createHash('sha1').update(`${shape.__key}|${tolerance}|${angularTolerance}`).digest('hex'));
  try { return v8.deserialize(fs.readFileSync(file)); } catch { /* not there, or cut short: mesh it */ }
  const v = make();
  try { fs.writeFileSync(file + '.tmp', v8.serialize(v)); fs.renameSync(file + '.tmp', file); } catch { /* a cache */ }
  return v;
};
const mergeMeshes = (parts) => {
  const positions = new Float32Array(parts.reduce((n, p) => n + p.positions.length, 0)), normals = new Float32Array(positions.length);
  const indices = new Uint32Array(parts.reduce((n, p) => n + p.indices.length, 0)), faces = [];
  let v = 0, i = 0;
  for (const p of parts) {
    positions.set(p.positions, v * 3); normals.set(p.normals, v * 3);
    for (let k = 0; k < p.indices.length; k++) indices[i + k] = p.indices[k] + v;
    for (const f of p.faces) faces.push({ ...f, first: f.first + i / 3 });
    v += p.positions.length / 3; i += p.indices.length;
  }
  return { positions, normals, indices, faces };
};
export function tessellate(shape, opts = {}) {
  const { tolerance = 0.01, angularTolerance = 0.3, fit = false } = opts, tag = fit ? '|fit' : '';   // fit: a mesh to PRINT (below)
  requireSolid(shape, 'shape');
  const kids = compoundParts.of(shape);
  if (kids?.length) return cachedMesh(shape, tolerance, angularTolerance, () => mergeMeshes(kids.map((k) => tessellate(k, opts))), tag);
  return cachedMesh(shape, tolerance, angularTolerance, () => {
    // A moved copy's mesh is its source's mesh, moved: a knob turn or an explode re-meshes nothing.
    const mv = movedMesh.of(shape), src = mv?.from();
    if (src) { const t = tessellate(src, opts), positions = Float32Array.from(t.positions), normals = Float32Array.from(t.normals); mv.apply(positions, false); mv.apply(normals, true); return { ...t, positions, normals }; }
    // Triangle count grows about linearly with 1/tolerance, so judge the budget
    // on the FINE count the coarse one predicts — judging the coarse count let a
    // 21k-triangle thread refine into 259k triangles and 9 s.
    // The coarse mesh is asked for as a mesh of its own, so it is kept: a part over the budget is the same mesh at
    // every finer tolerance, and the viewer (diag/2000) and the clash checks (0.05) each meshed an engraved cap for half a second.
    const meshAt = (tolerance) => meshOnDisk(shape, tolerance, angularTolerance, () => attempt('tessellation', () => {
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
    }));
    if (tolerance < COARSE) {
      const coarse = tessellate(shape, { tolerance: COARSE, angularTolerance });
      const finest = COARSE * (coarse.indices.length / 3) / MESH_BUDGET;   // the finest tolerance that guess allows
      if (tolerance < finest) {
        if (!fit || finest >= COARSE) return coarse;
        // fit: a mesh to PRINT wants round, not fast: a knob with a serrated bore, sent to the slicer at the coarse 0.1,
        // printed as a 45-sided polygon. So it starts at the finest the guess allows and is refined by halves while the
        // REAL count stays under half the budget (many small faces make the guess several times too high).
        let t = finest, mesh = meshAt(t);
        while (t > tolerance && mesh.indices.length / 3 < MESH_BUDGET / 2) { t = Math.max(tolerance, t / 2); mesh = meshAt(t); }
        return mesh;
      }
    }
    return meshAt(tolerance);
  }, tag);
}

const HEX_IN_NAME = /\s*#([0-9a-f]{6})\b/i;

/**
 * The mesh with its bodies, [{first, count, name, color?}] in triangle order: what the viewer's body list needs.
 * An assembly goes part by part (an unchanged part's mesh is a cache hit); anything else solid by solid.
 * A body's colour rides in its name, brep.name(s, 'knob, plastic #e4572e'): the viewer gets it as the body's own
 * colour [r, g, b] 0..1 (what a STEP's colour is) and the name without it.
 */
export function tessellateBodies(shape, opts = {}, name = 'body') {
  const meshes = [], bodies = []; let first = 0;
  const add = (s, label) => {
    const t = tessellate(s, opts), count = t.indices.length / 3, hex = HEX_IN_NAME.exec(label)?.[1];
    meshes.push(t);
    bodies.push({ first, count, name: hex ? label.replace(HEX_IN_NAME, '').trim() : label, ...(hex && { color: [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) }) });
    first += count;
  };
  const kids = compoundParts.of(shape);
  if (kids?.length) {
    const names = partsOf(shape)?.flatMap((p) => Array(p.count).fill(p.name || name)) ?? [];
    let solid = 0;
    for (const k of kids) { add(k, names[solid] ?? name); solid += brepBodies(k); }
  } else {
    const solids = namedSolids(shape, name);
    if (solids.length < 2) add(shape, solids[0]?.name ?? name);
    else solids.forEach(({ solid, name: n }, i) => { const s = track(kernel().cast(solid)); if (shape.__key) s.__key = `${shape.__key}#${i}`; add(s, n); });   // keyed by its place in a keyed shape: the next look is a lookup
  }
  return { ...mergeMeshes(meshes), bodies };
}

/** Crisp B-rep edge polylines for the wireframe overlay. */
export function tessellateEdges(shape, opts = {}) {
  const { tolerance = 0.01, angularTolerance = 0.3 } = opts;
  if (!shape || typeof shape.meshEdges !== 'function') return null;
  const kids = compoundParts.of(shape);
  if (kids?.length) return cachedMesh(shape, `edges ${tolerance}`, angularTolerance, () => {
    const all = kids.map((k) => tessellateEdges(k, opts)); if (all.some((e) => !e)) return null;
    const lines = [], groups = [];
    for (const e of all) { const at = lines.length / 3; for (const g of e.groups) groups.push({ ...g, start: g.start + at }); for (const x of e.lines) lines.push(x); }
    return { lines, groups };
  });
  return cachedMesh(shape, `edges ${tolerance}`, angularTolerance, () => {
    const mv = movedMesh.of(shape), src = mv?.from(), from = src && tessellateEdges(src, opts);
    if (from) { const lines = Float32Array.from(from.lines); mv.apply(lines, false); return { lines, groups: from.groups }; }
    try {
      const e = shape.meshEdges({ tolerance, angularTolerance, keepMesh: true });
      return { lines: Array.from(e.lines), groups: e.edgeGroups ?? [] };
    } catch {
      return null; // wireframe is cosmetic; never fail a build over it
    }
  });
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
/** A compound's parts, when something upstream (cellapi.js) recorded them: an assembly is meshed, boxed
 *  and measured part by part, each a cache hit when that part did not change. */
export const compoundParts = { of: () => null };
/** Set by cellapi.js: for a translated or rotated copy, { from() → the source shape or null, apply(xyz array, isDirection) }. */
export const movedMesh = { of: () => null };
// Bounds by shape key: a request meshes a part for its box, then meshes it for its mesh, then measures
// it — and the history's look and Claude's render ask the same again. Keys are content hashes.
const boundsCache = new Map();
const unionBounds = (boxes) => ({ min: [0, 1, 2].map((k) => Math.min(...boxes.map((b) => b.min[k]))), max: [0, 1, 2].map((k) => Math.max(...boxes.map((b) => b.max[k]))) });
const keyedBounds = (shape, kind, make) => {
  const k = shape?.__key ? `${kind}|${shape.__key}` : null;
  if (k && boundsCache.has(k)) { const v = boundsCache.get(k); return { min: [...v.min], max: [...v.max] }; }
  const v = make();
  if (k) { if (boundsCache.size >= 512) boundsCache.delete(boundsCache.keys().next().value); boundsCache.set(k, { min: [...v.min], max: [...v.max] }); }
  return v;
};
/** The analytic box, never short, at most a few tenths long on curved faces: enough to tell two parts apart. */
export function looseBounds(shape) {
  return keyedBounds(shape, 'loose', () => {
    const kids = compoundParts.of(shape);
    if (kids?.length) return unionBounds(kids.map(looseBounds));
    const box = new OC.Bnd_Box_1();
    OC.BRepBndLib.Add(shape.wrapped, box, true);   // poles and existing triangulation: fast, never short
    const lo = box.CornerMin(), hi = box.CornerMax();
    const out = { min: [lo.X(), lo.Y(), lo.Z()], max: [hi.X(), hi.Y(), hi.Z()] };
    lo.delete(); hi.delete(); box.delete();
    return out;
  });
}
// The same box in nine more frames, the part turned 22.5° at a time about each axis. A round part's box has corners the
// part is nowhere near, and a neighbour standing in one (a pin beside a gear) is clear of it in one of these frames.
let turnLocs = null;
const turnFrames = () => turnLocs ??= [0, 1, 2].flatMap((ax) => [1, 2, 3].map((n) => {
  const o = new OC.gp_Pnt_3(0, 0, 0), d = new OC.gp_Dir_4(+(ax === 0), +(ax === 1), +(ax === 2)), a = new OC.gp_Ax1_2(o, d), t = new OC.gp_Trsf_1();
  t.SetRotation_1(a, n * Math.PI / 8);
  const loc = new OC.TopLoc_Location_2(t);
  for (const x of [o, d, a, t]) x.delete();
  return loc;
}));
const turnedCache = new Map();
/** looseBounds, then the same in each turned frame: ten boxes, and two parts apart in any one of them are apart. */
export function turnedBounds(shape) {
  const k = shape?.__key;
  if (k && turnedCache.has(k)) return turnedCache.get(k);
  const kids = compoundParts.of(shape);
  let out;
  if (kids?.length) { const all = kids.map(turnedBounds); out = all[0].map((_, i) => unionBounds(all.map((b) => b[i]))); }
  else out = [looseBounds(shape), ...turnFrames().map((loc) => {
    const turned = shape.wrapped.Moved(loc, false), box = new OC.Bnd_Box_1();
    OC.BRepBndLib.Add(turned, box, true);
    const lo = box.CornerMin(), hi = box.CornerMax(), b = { min: [lo.X(), lo.Y(), lo.Z()], max: [hi.X(), hi.Y(), hi.Z()] };
    lo.delete(); hi.delete(); box.delete(); turned.delete();
    return b;
  })];
  if (k) { if (turnedCache.size >= 4096) turnedCache.delete(turnedCache.keys().next().value); turnedCache.set(k, out); }
  return out;
}
export function tightBounds(shape) { return keyedBounds(shape, 'tight', () => { const kids = compoundParts.of(shape); return kids?.length ? unionBounds(kids.map(tightBounds)) : tightBoundsOf(shape); }); }
function tightBoundsOf(shape) {
  // Offset and spline surfaces still come back a few tenths too big from the
  // analytic box; their triangulation is the honest extent, to its deflection.
  const faces = Array.isArray(shape.faces) ? shape.faces : [];
  const curvedFree = faces.every((f) => ['PLANE', 'CYLINDRE', 'CONE', 'SPHERE', 'TORUS'].includes(f.geomType));
  const box = new OC.Bnd_Box_1();
  // Never from a triangulation when the faces are analytic: a shape someone already meshed (the pane, a draft)
  // came back grown by that mesh's deflection on every side, so a 60 mm plate measured 60.015 and failed its
  // own fitsIn(60) — or passed, depending on who looked first. Below, the box only clips the mesh's extent.
  OC.BRepBndLib.AddOptimal(shape.wrapped, box, !curvedFree, false);
  const lo = box.CornerMin();
  const hi = box.CornerMax();
  const out = { min: [lo.X(), lo.Y(), lo.Z()], max: [hi.X(), hi.Y(), hi.Z()] };
  lo.delete(); hi.delete(); box.delete();
  if (faces.length && !curvedFree) {
    // The COARSE mesh is enough: its vertices lie ON the surface and OCCT puts
    // vertices on every edge and seam, so the box is exact on planar extents and
    // short by at most the deflection at a curved extreme between vertices —
    // never long, so it is not padded (the old 0.01 pad read an 80 mm part as
    // 80.02). Clipped to the analytic box, which is exact on planar faces and a
    // wall thickness too wide on offset surfaces. A fixed 0.01 mesh here cost
    // 5.7 s and 224k triangles on a small thread, on EVERY evaluate, and was
    // what made threaded parts stall the app.
    const tol = 0;
    const { positions } = tessellate(shape, { tolerance: COARSE });
    const min = [Infinity, Infinity, Infinity]; const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < positions.length; i += 3) {
      for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], positions[i + k]); max[k] = Math.max(max[k], positions[i + k]); }
    }
    return {
      min: min.map((v, k) => Math.max(v - tol, out.min[k])),
      max: max.map((v, k) => Math.min(v + tol, out.max[k])),
    };
  }
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
