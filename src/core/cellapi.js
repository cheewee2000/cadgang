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

import * as ops from './ops.js';
import { q as queryRoot, topology, Query } from './query.js';
import { Sketch } from './sketch.js';
import * as checks from './checks.js';
import { GraphError } from './errors.js';

/** The `brep` namespace: primitives, booleans, modifiers, measures. */
const brep = Object.freeze({
  box: ops.box,
  cylinder: ops.cylinder,
  sphere: ops.sphere,
  torus: ops.torus,
  cone: ops.cone,
  union: ops.union,
  subtract: ops.subtract,
  intersect: ops.intersect,
  fillet: ops.fillet,
  chamfer: ops.chamfer,
  shell: ops.shell,
  translate: ops.translate,
  rotate: ops.rotate,
  scale: ops.scale,
  mirror: ops.mirror,
  extrude: ops.extrude,
  revolve: ops.revolve,
  loft: ops.loft,
  sweep: ops.sweep,
  pipe: ops.pipe,
  coil: ops.coil,
  rib: ops.rib,
  emboss: ops.emboss,
  thread: ops.thread,
  pushPull: ops.pushPull,
  simplify: ops.simplify,
  pathPattern: ops.pathPattern,
  plane: ops.plane,
  planeThrough: ops.planeThrough,
  pivotPlane: ops.pivotPlane,
  midplane: ops.midplane,
  axisOf: ops.axisOf,
  mass: ops.mass,
  length: ops.length,
  interference: ops.interference,
  polyline: ops.polyline,
  spline: ops.spline,
  helix: ops.helix,
  hole: ops.hole,
  linearPattern: ops.linearPattern,
  circularPattern: ops.circularPattern,
  offset: ops.offset,
  draft: ops.draft,
  split: ops.split,
  planeOf: ops.planeOf,
  volume: ops.volume,
  area: ops.area,
  bbox: ops.bbox,
  centroid: ops.centroid,
  distance: ops.distance,
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
      const v = ops.volume(shape);
      return record({
        label: 'volume under', ok: v < limit, value: round(v), limit, unit: 'mm³',
        message: `Volume ${v.toFixed(2)} mm³ is not under ${limit} mm³`,
      });
    },

    volumeOver(shape, limit) {
      const v = ops.volume(shape);
      return record({
        label: 'volume over', ok: v > limit, value: round(v), limit, unit: 'mm³',
        message: `Volume ${v.toFixed(2)} mm³ is not over ${limit} mm³`,
      });
    },

    fitsIn(shape, [x, y, z]) {
      const { size } = ops.bbox(shape);
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
  params = {}, input = null, inputs = {}, selections = {}, sketch = null, checked = [],
}) {
  return Object.freeze({
    p: Object.freeze({ ...params }),
    brep,
    q,
    sk: sketchNamespace(params, sketch),
    assert: assertions(checked),
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
