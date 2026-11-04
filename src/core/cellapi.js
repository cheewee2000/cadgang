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
import * as ops from './ops.js';
import { q as queryRoot, topology, Query } from './query.js';
import { Sketch } from './sketch.js';
import * as checks from './checks.js';
import { GraphError } from './errors.js';
import { sheetMetalNamespace } from './sheetmetal.js';
import { softNamespace } from './softgoods.js';

/**
 * Shape keys. A cell's inputs carry their cell's cache key (cells.js), and every op here stamps its result
 * with a key made of the op and its arguments' keys, so two shapes with one key are the same geometry.
 * An argument that cannot be keyed (a query, whose steps are functions; a sketch; a callback) leaves the
 * result unkeyed, and so is anything built from it — a part's result is keyed again by its cell.
 */
const isShape = (v) => !!v && typeof v === 'object' && typeof v.clone === 'function' && 'wrapped' in v;
let keyable = true;
const argKey = (v) => {
  if (isShape(v)) { if (!v.__key) keyable = false; return v.__key; }
  if (v == null || typeof v !== 'object') { if (typeof v === 'function') keyable = false; return v; }
  if (Array.isArray(v)) return v.map(argKey);
  const proto = Object.getPrototypeOf(v);   // a cell's own {center: 'xy'} comes from the sandbox's realm, so its prototype is that realm's Object
  if (proto === null || proto === Object.prototype || proto.constructor?.name === 'Object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, argKey(x)]));
  keyable = false; return null;
};
const keyOf = (op, args) => { keyable = true; const s = JSON.stringify(args.map(argKey)); return keyable ? crypto.createHash('sha1').update(op).update(s).digest('base64url').slice(0, 20) : null; };
const keyed = (op, fn) => (...args) => { const r = fn(...args); if (isShape(r)) { const k = keyOf(op, args); if (k) r.__key = k; } return r; };

/**
 * Measures (a clash volume, a bounding box) of a keyed shape are remembered, so a check of two parts
 * that did not change is a lookup. This is what makes an assertion cell over a whole assembly cost only
 * the pairs the edit touched: the cell itself re-runs, the kernel work does not.
 */
const MEMO_MAX = 20000;
const memo = new Map();   // op + argument keys → the number or plain object it measured
export function clearMeasureMemo() { memo.clear(); }
const measured = (op, fn) => (...args) => {
  const k = keyOf(op, args);
  if (k == null) return fn(...args);
  if (memo.has(k)) { const v = memo.get(k); memo.delete(k); memo.set(k, v); return structuredClone(v); }   // re-insert: Map order is the LRU order
  const v = fn(...args);
  if (memo.size >= MEMO_MAX) memo.delete(memo.keys().next().value);
  memo.set(k, v);
  return structuredClone(v);
};

// A compound remembers what went into it, so its box is the union of its parts' boxes (each a memo hit
// when that part is unchanged) instead of a coarse mesh of the whole assembly on every evaluate.
const children = new WeakMap();
const alive = (s) => { try { return !s.wrapped.isDeleted(); } catch { return false; } };
const compound = keyed('compound', (...shapes) => { const r = ops.compound(...shapes); children.set(r, shapes.flat().filter(Boolean)); return r; });
const bboxOfOne = measured('bbox', ops.bbox);
const bbox = (shape) => {
  const kids = children.get(shape);
  if (!kids || !kids.every((s) => s.__key && alive(s))) return bboxOfOne(shape);
  const boxes = kids.map(bbox);
  const min = [0, 1, 2].map((k) => Math.min(...boxes.map((b) => b.min[k]))), max = [0, 1, 2].map((k) => Math.max(...boxes.map((b) => b.max[k])));
  return { min, max, size: [0, 1, 2].map((k) => max[k] - min[k]) };
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
  name: keyed('name', ops.name),
  subtract: keyed('subtract', ops.subtract),
  intersect: keyed('intersect', ops.intersect),
  fillet: keyed('fillet', ops.fillet),
  chamfer: keyed('chamfer', ops.chamfer),
  shell: keyed('shell', ops.shell),
  translate: keyed('translate', ops.translate),
  scoped: ops.scoped,
  rotate: keyed('rotate', ops.rotate),
  scale: keyed('scale', ops.scale),
  mirror: keyed('mirror', ops.mirror),
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
  interference: measured('interference', ops.interference),
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
  volume: measured('volume', ops.volume),
  area: measured('area', ops.area),
  bbox,
  centroid: measured('centroid', ops.centroid),
  distance: measured('distance', ops.distance),
  bodies: measured('bodies', ops.bodies),
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
function assertions(sink) {
  const record = ({ label, ok, value, limit, unit = 'mm', detail = null, message }) => {
    sink.push({ label, ok, value, limit, unit, detail });
    if (!ok) throw new GraphError(message);
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
  params = {}, input = null, inputs = {}, selections = {}, sketch = null, checked = [], flats = [],
}) {
  return Object.freeze({
    p: Object.freeze({ ...params }),
    brep,
    q,
    sk: sketchNamespace(params, sketch),
    assert: assertions(checked),
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
