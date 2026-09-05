/**
 * cadgang topological queries — naming faces and edges by what they ARE.
 *
 * A prompt-authored model is written by something that cannot see the geometry.
 * It can never say "edge 7" — and it should not, because an index breaks the
 * moment a parameter changes and OCCT renumbers the topology. So every
 * reference to a face or an edge is a QUERY: a chain of predicates over
 * intrinsic properties. "The linear edges running along Z" still selects the
 * same four edges after the box grows from 60mm to 80mm; `edges[3]` does not.
 *
 * A Query is a description, not a result. It captures the shape it was built
 * from and re-resolves on demand, so an operation can resolve it against the
 * exact shape instance it is about to consume rather than against a stale copy.
 *
 * The descriptor objects `.where()` receives are byte-for-byte the ones
 * `topology()` reports over MCP. That is deliberate: whatever the model reads
 * when it inspects a shape is exactly what its predicates will be handed, so a
 * query can be written against observed values without a translation step.
 *
 * Lifetime: enumerating `shape.faces` mints OCCT heap objects. Everything this
 * module allocates is registered with the active brep scope (see
 * beginBrepScope in brep.js), so a compile pass frees them in one go.
 */

import { GraphError } from './errors.js';
import { brepKernel, trackBrepShape, faceGeometry, tightBounds } from './brep.js';

const RAD = Math.PI / 180;
const AXIS = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

// Tolerances. Angles are generous (1°) because OCCT surface normals on a
// filleted or booleaned face carry accumulated error; measures are relative
// because a 0.01mm slop means something different on a 2mm hole and a 200mm
// plate.
const ANGLE_TOL_DEG = 1;
const MEASURE_REL_TOL = 1e-3;
const POSITION_TOL = 1e-6;

// --------------------------------------------------------------- vector maths

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a) => Math.hypot(a[0], a[1], a[2]);

function unit(a) {
  const n = norm(a);
  if (n < 1e-12) return null;
  return [a[0] / n, a[1] / n, a[2] / n];
}

/**
 * Accept 'z', '+z', '-z', or a raw vector. The sign matters for faces (a top
 * face and a bottom face have opposite normals and are not interchangeable) and
 * does not for edges (an edge "along Z" has no preferred end), so the parsed
 * result reports whether a sign was actually written.
 */
export function parseDirection(d) {
  if (Array.isArray(d)) {
    const v = unit(d);
    if (!v) throw new GraphError(`Direction ${JSON.stringify(d)} has zero length`);
    return { vec: v, signed: true };
  }
  const m = /^([+-]?)([xyz])$/.exec(String(d).trim().toLowerCase());
  if (!m) {
    throw new GraphError(
      `Unknown direction '${d}'. Use 'x'/'y'/'z', '+z'/'-z', or a vector like [0,0,1]`
    );
  }
  const axis = AXIS[m[2]];
  return {
    vec: m[1] === '-' ? axis.map((c) => -c) : axis,
    signed: m[1] !== '',
  };
}

/** Read a replicad Vector into a plain tuple and free it. */
function readVector(v) {
  const out = [v.x, v.y, v.z];
  v.delete?.();
  return out;
}

function readBBox(shape) {
  const box = shape.boundingBox;
  const [min, max] = box.bounds;
  box.delete?.();
  return {
    min: [min[0], min[1], min[2]],
    max: [max[0], max[1], max[2]],
    center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
  };
}

/** Round for display and hashing — 1e-4 mm is far below anything we can hold. */
const r4 = (n) => Math.round(n * 1e4) / 1e4;
const r4v = (v) => v.map(r4);

// ------------------------------------------------------------- describing

/**
 * A stable-ish content hash for one entity.
 *
 * This is NOT the reference mechanism — queries are. It is the *anchor* used to
 * detect drift: when a stored user pick re-resolves, comparing anchors tells us
 * whether we found the same entity or something that merely also satisfies the
 * query. A changed anchor means "ask the human again", never "silently operate
 * on this instead".
 */
function anchorOf(kind, measure, center, extra) {
  const parts = [kind, r4(measure), ...r4v(center), ...(extra ? r4v(extra) : [])];
  let h = 2166136261;
  const s = parts.join('|');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/** Describe one edge. `i` is the enumeration index — valid only for this
 *  resolution pass and never persisted. */
export function describeEdge(edge, i) {
  let kind = edge.geomType;
  const length = edge.length;
  // A loft's side edges are splines even when dead straight; a query for the
  // "vertical corners" should still find them.
  if ((kind === 'BSPLINE_CURVE' || kind === 'BEZIER_CURVE') && length > 0 && isStraight(edge, length)) kind = 'LINE';
  const bbox = readBBox(edge);
  const start = readVector(edge.startPoint);
  const end = readVector(edge.endPoint);
  const closed = edge.isClosed;
  // A line's tangent is constant, so tangentAt(0) is the direction. A circle's
  // is not, and reporting one would invite a meaningless `.along()` match.
  const direction = kind === 'LINE' ? unit(readVector(edge.tangentAt(0))) : null;
  // Full circles are the overwhelmingly common curved edge (holes, fillet
  // seams) and their radius is the thing anyone wants to filter on.
  const radius = kind === 'CIRCLE' && closed ? length / (2 * Math.PI) : null;

  return {
    i,
    type: 'edge',
    kind,
    length: r4(length),
    center: r4v(bbox.center),
    start: r4v(start),
    end: r4v(end),
    direction: direction ? r4v(direction) : null,
    radius: radius === null ? null : r4(radius),
    closed,
    bbox: { min: r4v(bbox.min), max: r4v(bbox.max) },
    anchor: anchorOf(kind, length, bbox.center, direction),
  };
}

/** Every sample of the curve lies on the chord between its ends, to a millionth of its length. */
function isStraight(edge, length) {
  try {
    const a = readVector(edge.startPoint); const b = readVector(edge.endPoint);
    const chord = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const cl = Math.hypot(...chord);
    if (cl < 1e-9) return false;
    for (const t of [0.2, 0.4, 0.6, 0.8]) {
      const p = readVector(edge.pointAt(t));
      const d = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
      const s = (d[0] * chord[0] + d[1] * chord[1] + d[2] * chord[2]) / cl;
      const off = Math.hypot(d[0] - (s * chord[0]) / cl, d[1] - (s * chord[1]) / cl, d[2] - (s * chord[2]) / cl);
      if (off > 1e-6 * length) return false;
    }
    return true;
  } catch { return false; }
}

/** Describe one face. */
export function describeFace(face, i) {
  const rc = brepKernel();
  const geo = faceGeometry(face);
  const kind = geo.kind;
  const area = rc.measureArea(face);
  const bbox = readBBox(face);
  const center = readVector(face.center);
  // normalAt() with no argument samples at the face centre. For a plane that is
  // the normal; for a cylinder it is one sample of many, so it is reported but
  // `.facing()` only trusts it on planar faces.
  let normal = null;
  try {
    normal = unit(readVector(face.normalAt()));
  } catch {
    // Degenerate or seam faces can refuse a normal; absence is a valid answer.
  }
  // Cylindrical faces are how holes and bosses present themselves, so their
  // radius has to be filterable. Derive it from the face's own extent rather
  // than reaching into the OCCT adaptor.
  let radius = geo.radius;
  if (radius == null && kind === 'CYLINDER') {
    const span = [0, 1, 2].map((k) => bbox.max[k] - bbox.min[k]);
    // The two largest extents of a cylinder's bbox span its diameter.
    const sorted = [...span].sort((a, b) => b - a);
    radius = sorted[1] / 2;
  } else if (radius == null && kind === 'SPHERE') {
    radius = Math.max(...[0, 1, 2].map((k) => bbox.max[k] - bbox.min[k])) / 2;
  }

  return {
    i,
    type: 'face',
    kind,
    area: r4(area),
    center: r4v(center),
    normal: normal ? r4v(normal) : null,
    radius: radius === null ? null : r4(radius),
    bbox: { min: r4v(bbox.min), max: r4v(bbox.max) },
    anchor: anchorOf(kind, area, center, normal),
  };
}

// --------------------------------------------------------------- enumeration

/**
 * Enumerate every face or edge of a shape with its descriptor.
 *
 * The live OCCT wrappers come back alongside the plain descriptors because an
 * operation needs the wrappers and the model needs the descriptors. Both are
 * registered with the active brep scope.
 */
export function enumerate(shape, type) {
  if (type !== 'face' && type !== 'edge') {
    throw new GraphError(`Cannot enumerate '${type}' — expected 'face' or 'edge'`);
  }
  const elements = type === 'face' ? shape.faces : shape.edges;
  const describe = type === 'face' ? describeFace : describeEdge;
  return elements.map((element, i) => {
    trackBrepShape(element);
    return { element, d: describe(element, i) };
  });
}

/**
 * The full topology of a shape, as plain JSON.
 *
 * This is what replaces vision. A model that cannot look at the part calls
 * this, reads the actual faces and edges with their kinds, sizes, and
 * positions, writes a query against what it sees, and checks the count before
 * committing to an operation.
 */
export function topology(shape) {
  const faces = enumerate(shape, 'face').map((e) => e.d);
  const edges = enumerate(shape, 'edge').map((e) => e.d);
  const bbox = tightBounds(shape);
  return {
    bbox: { min: r4v(bbox.min), max: r4v(bbox.max) },
    counts: { faces: faces.length, edges: edges.length },
    faces,
    edges,
  };
}

// -------------------------------------------------------------------- Query

/** Compare two measures with a relative tolerance, floored for small values. */
function measureMatches(actual, want, tol) {
  const t = tol ?? Math.max(Math.abs(want) * MEASURE_REL_TOL, 1e-4);
  return Math.abs(actual - want) <= t;
}

const FACE_KINDS = {
  planar: 'PLANE',
  cylindrical: 'CYLINDER',
  conical: 'CONE',
  spherical: 'SPHERE',
  toroidal: 'TORUS',
};

const EDGE_KINDS = { linear: 'LINE', circular: 'CIRCLE', elliptical: 'ELLIPSE' };

/**
 * A chain of steps over a list of entities.
 *
 * Steps run in the order they were written, and a step is either a filter
 * (drops entities) or a reducer (`atExtreme`, which keeps only the entities at
 * one end of an axis). Keeping them in one ordered list is what makes
 * `.planar().atExtreme('+z')` mean "the topmost planar face" and
 * `.atExtreme('+z').planar()` mean "the topmost face, if it happens to be
 * planar" — both readable, neither surprising.
 */
export class Query {
  constructor(shape, type, steps = []) {
    this.shape = shape;
    this.type = type;
    this.steps = steps;
  }

  _add(step) {
    return new Query(this.shape, this.type, [...this.steps, step]);
  }

  /** Filter on the descriptor directly. The escape hatch for anything the
   *  named filters below do not cover. */
  where(fn) {
    if (typeof fn !== 'function') throw new GraphError('where() needs a function');
    return this._add({ kind: 'filter', label: 'where(…)', fn: (e) => Boolean(fn(e.d)) });
  }

  /** Match one or more OCCT surface/curve kinds ('PLANE', 'LINE', 'CIRCLE'…). */
  ofKind(...kinds) {
    const want = new Set(kinds.map((k) => String(k).toUpperCase()));
    return this._add({
      kind: 'filter',
      label: `ofKind(${[...want].join(', ')})`,
      fn: (e) => want.has(e.d.kind),
    });
  }

  planar() { return this._kindShorthand('planar', FACE_KINDS, 'face'); }
  cylindrical() { return this._kindShorthand('cylindrical', FACE_KINDS, 'face'); }
  conical() { return this._kindShorthand('conical', FACE_KINDS, 'face'); }
  spherical() { return this._kindShorthand('spherical', FACE_KINDS, 'face'); }
  toroidal() { return this._kindShorthand('toroidal', FACE_KINDS, 'face'); }
  linear() { return this._kindShorthand('linear', EDGE_KINDS, 'edge'); }
  circular() { return this._kindShorthand('circular', EDGE_KINDS, 'edge'); }
  elliptical() { return this._kindShorthand('elliptical', EDGE_KINDS, 'edge'); }

  _kindShorthand(name, table, forType) {
    if (this.type !== forType) {
      throw new GraphError(`.${name}() applies to ${forType}s, but this query selects ${this.type}s`);
    }
    return this.ofKind(table[name]);
  }

  /**
   * Edges whose direction is parallel to `dir`. Sign-insensitive unless the
   * direction was written with one: an edge running along Z is the same edge
   * whichever end you start from.
   */
  along(dir, toleranceDeg = ANGLE_TOL_DEG) {
    const { vec, signed } = parseDirection(dir);
    const cos = Math.cos(toleranceDeg * RAD);
    return this._add({
      kind: 'filter',
      label: `along(${JSON.stringify(dir)})`,
      fn: (e) => {
        if (!e.d.direction) return false;
        const d = dot(e.d.direction, vec);
        return signed ? d >= cos : Math.abs(d) >= cos;
      },
    });
  }

  /**
   * Faces whose normal points along `dir`. Unlike `.along()` this defaults to
   * caring about sign — `.facing('+z')` is the top of a box, `.facing('-z')`
   * the bottom, and conflating them would be a bug in every shell operation.
   * A bare axis ('z') matches both.
   */
  facing(dir, toleranceDeg = ANGLE_TOL_DEG) {
    const { vec, signed } = parseDirection(dir);
    const cos = Math.cos(toleranceDeg * RAD);
    return this._add({
      kind: 'filter',
      label: `facing(${JSON.stringify(dir)})`,
      fn: (e) => {
        if (!e.d.normal) return false;
        const d = dot(e.d.normal, vec);
        return signed ? d >= cos : Math.abs(d) >= cos;
      },
    });
  }

  ofLength(value, tolerance) {
    return this._measure('length', 'ofLength', value, tolerance);
  }

  ofArea(value, tolerance) {
    return this._measure('area', 'ofArea', value, tolerance);
  }

  ofRadius(value, tolerance) {
    return this._measure('radius', 'ofRadius', value, tolerance);
  }

  ofDiameter(value, tolerance) {
    return this._measure('radius', 'ofDiameter', value / 2, tolerance ? tolerance / 2 : undefined);
  }

  _measure(field, label, value, tolerance) {
    if (!Number.isFinite(value)) throw new GraphError(`.${label}() needs a finite number`);
    return this._add({
      kind: 'filter',
      label: `${label}(${value})`,
      fn: (e) => e.d[field] != null && measureMatches(e.d[field], value, tolerance),
    });
  }

  /** Compare the entity's primary measure (length for edges, area for faces). */
  largerThan(value) { return this._compare(value, 1); }
  smallerThan(value) { return this._compare(value, -1); }

  _compare(value, sign) {
    const field = this.type === 'edge' ? 'length' : 'area';
    const label = sign > 0 ? 'largerThan' : 'smallerThan';
    return this._add({
      kind: 'filter',
      label: `${label}(${value})`,
      fn: (e) => (sign > 0 ? e.d[field] > value : e.d[field] < value),
    });
  }

  /** Entities whose centre lies within `distance` of a point. */
  near(point, distance) {
    if (!Array.isArray(point) || point.length !== 3) {
      throw new GraphError('.near() needs a [x, y, z] point');
    }
    return this._add({
      kind: 'filter',
      label: `near(${JSON.stringify(point)}, ${distance})`,
      fn: (e) => {
        const c = e.d.center;
        return Math.hypot(c[0] - point[0], c[1] - point[1], c[2] - point[2]) <= distance;
      },
    });
  }

  /** Entities entirely inside an axis-aligned box. */
  inBox(min, max) {
    return this._add({
      kind: 'filter',
      label: `inBox(${JSON.stringify(min)}, ${JSON.stringify(max)})`,
      fn: (e) => [0, 1, 2].every(
        (k) => e.d.bbox.min[k] >= min[k] - POSITION_TOL && e.d.bbox.max[k] <= max[k] + POSITION_TOL
      ),
    });
  }

  /**
   * Keep only the entities furthest along a direction — "the top face", "the
   * innermost hole". Everything within `tolerance` of the extreme is kept, so
   * the four coplanar top faces of a shelled box all survive rather than one
   * winning by floating-point noise.
   */
  atExtreme(dir, tolerance = 1e-3) {
    const { vec } = parseDirection(dir);
    return this._add({
      kind: 'reduce',
      label: `atExtreme(${JSON.stringify(dir)})`,
      fn: (list) => {
        if (!list.length) return list;
        const score = (e) => dot(e.d.center, vec);
        const best = Math.max(...list.map(score));
        return list.filter((e) => score(e) >= best - tolerance);
      },
    });
  }

  /** Drop everything a sub-query would have matched. */
  exclude(build) {
    const sub = build(new Query(this.shape, this.type, []));
    return this._add({
      kind: 'reduce',
      label: `exclude(${sub._chainLabel()})`,
      fn: (list) => {
        const dropped = new Set(sub._run(list).map((e) => e.d.i));
        return list.filter((e) => !dropped.has(e.d.i));
      },
    });
  }

  /**
   * Keep the single entity that best matches a stored pick.
   *
   * This is what a human's "fillet *that* edge" turns into. The query in front
   * of it says what KIND of thing was picked; this step says WHICH one, and it
   * has to keep meaning the same edge after the part changes shape.
   *
   * Matching is in unit space — each entity's position as a fraction of the
   * shape's own bounding box — so the corner of a 60mm box is still the same
   * corner at 80mm, where an absolute centroid would be 10mm adrift. Measure
   * and direction are compared scale-free for the same reason.
   *
   * Two ways it refuses rather than guesses, and both matter more than the
   * matching itself: a best match too far from the anchor means the pick no
   * longer describes anything on this shape, and a best match too close to the
   * runner-up means the pick is genuinely ambiguous. Either way the answer is
   * "ask the human again", never "operate on this instead".
   */
  nearestTo(anchor) {
    if (!anchor?.kind) throw new GraphError('nearestTo() needs a stored anchor');
    return this._add({
      kind: 'reduce',
      label: `nearestTo(${anchor.kind}@${(anchor.unit || []).map((n) => n.toFixed(2)).join(',')})`,
      fn: (list, all) => {
        const sameKind = list.filter((e) => e.d.kind === anchor.kind);
        if (!sameKind.length) {
          throw repick(
            `The picked ${anchor.type} was a ${anchor.kind} and this shape has none left.`
          );
        }
        // An exact hash hit means nothing moved at all — the common case on a
        // re-render, and worth short-circuiting before any scoring.
        const exact = sameKind.filter((e) => e.d.anchor === anchor.hash);
        if (exact.length === 1) return exact;

        // Measured over every entity of this type, exactly as anchorFor did.
        const box = spanOf(all);
        const scored = sameKind
          .map((e) => ({ e, cost: anchorCost(e.d, anchor, box) }))
          .sort((a, b) => a.cost - b.cost);

        const best = scored[0];
        if (best.cost > DRIFT_TOL) {
          throw repick(
            `The pick no longer matches anything on this shape (best candidate is ` +
            `${best.cost.toFixed(2)} away, tolerance ${DRIFT_TOL}).`
          );
        }
        const runnerUp = scored[1];
        if (runnerUp && runnerUp.cost - best.cost < AMBIGUITY_GAP) {
          throw repick(
            `The pick is ambiguous — two ${anchor.type}s match it equally well ` +
            `(${best.cost.toFixed(3)} vs ${runnerUp.cost.toFixed(3)}).`
          );
        }
        return [best.e];
      },
    });
  }

  /** Union of several sub-queries — "the vertical edges OR the top rim". */
  either(...builds) {
    const subs = builds.map((b) => b(new Query(this.shape, this.type, [])));
    return this._add({
      kind: 'reduce',
      label: `either(${subs.map((s) => s._chainLabel()).join(' | ')})`,
      fn: (list) => {
        const keep = new Set();
        for (const sub of subs) for (const e of sub._run(list)) keep.add(e.d.i);
        return list.filter((e) => keep.has(e.d.i));
      },
    });
  }

  // ------------------------------------------------------------- resolution

  _chainLabel() {
    return this.steps.map((s) => s.label).join('.') || '(all)';
  }

  /** Human- and model-readable description of the chain itself. */
  get expression() {
    return `${this.type}s.${this._chainLabel()}`;
  }

  /**
   * Reducers get the ORIGINAL enumeration as a second argument as well as the
   * surviving candidates. `nearestTo` needs it: unit positions are only
   * comparable when both sides measure against the same population, and by the
   * time a reducer runs the list has usually been narrowed to one surface kind,
   * whose bounding box is nothing like the whole shape's.
   */
  _run(list) {
    let out = list;
    for (const step of this.steps) {
      out = step.kind === 'filter' ? out.filter(step.fn) : step.fn(out, list);
    }
    return out;
  }

  /**
   * Resolve against a specific shape instance.
   *
   * Operations call this with the working copy they are about to consume, so
   * the OCCT sub-shapes handed to a fillet belong to the shape being filleted.
   */
  resolveOn(shape) {
    return this._run(enumerate(shape, this.type));
  }

  _resolve() {
    if (!this.shape) throw new GraphError('Query has no shape to resolve against');
    return this.resolveOn(this.shape);
  }

  /** The matching descriptors. */
  all() {
    return this._resolve().map((e) => e.d);
  }

  count() {
    return this._resolve().length;
  }

  /** The single match, or an error naming what was found instead. */
  one() {
    const found = this.all();
    if (found.length !== 1) {
      throw new GraphError(
        `${this.expression} matched ${found.length} ${this.type}s, expected exactly 1${summarize(found)}`
      );
    }
    return found[0];
  }

  /**
   * Assert the match count and carry on.
   *
   * This is the safety valve that makes generated geometry code trustworthy:
   * the intent "fillet the four vertical edges" is written down as a number, so
   * a query that quietly starts matching twelve edges after a parameter change
   * fails the cell instead of producing a differently-shaped part.
   */
  expect(n) {
    const found = this.all();
    if (found.length !== n) {
      throw new GraphError(
        `${this.expression} matched ${found.length} ${this.type}s, expected ${n}${summarize(found)}`
      );
    }
    return this;
  }

  /** What this query selects right now, for logging and MCP replies. */
  explain() {
    const found = this.all();
    return { expression: this.expression, count: found.length, matches: found };
  }
}

/** Compact "what did I actually find" tail for error messages. */
function summarize(found) {
  if (!found.length) return '';
  const shown = found.slice(0, 6).map((d) => {
    const measure = d.type === 'edge' ? `len ${d.length}` : `area ${d.area}`;
    return `${d.kind} (${measure}) at [${d.center.join(', ')}]`;
  });
  const tail = found.length > shown.length ? `, …${found.length - shown.length} more` : '';
  return `. Found: ${shown.join('; ')}${tail}`;
}

// ------------------------------------------------------------------- anchors

/**
 * How far a candidate may sit from the anchor before the pick is treated as
 * lost, and how much better the winner must be than the runner-up.
 *
 * The units are the cost function below: roughly "fraction of the part's own
 * size". 0.35 tolerates a corner moving a third of the way across the part —
 * generous, because the alternative to re-matching is asking the human again,
 * and asking too often is its own failure.
 *
 * The ambiguity gap is small — 0.015 — and that number came from measuring real
 * parts rather than from taste. The competing candidate in practice is not some
 * unrelated edge; it is the one 2mm away across a shell wall, and the two are
 * separated in unit space by exactly wall/depth. A 2mm wall on a 40mm box is
 * 0.05 apart and must resolve; on a 300mm box it is 0.007 apart and honestly
 * cannot. Anything wider than about 0.02 made every thin-walled part unpickable,
 * which is the failure nobody would tolerate.
 *
 * KNOWN LIMIT, and it is a real one: if a parameter slides a whole array of
 * identical features along by exactly one pitch, the neighbour lands precisely
 * on the anchor and is returned confidently. No cost ranking can catch that —
 * the geometry genuinely does not record which hole was meant. The mitigations
 * are elsewhere: the transcript shows what each pick resolved to, and a pick is
 * cheap to redo.
 */
const DRIFT_TOL = 0.35;
const AMBIGUITY_GAP = 0.015;

/*
 * CONSIDERED AND MEASURED DOWN, 2026-08-04: making the gap proportional to the
 * winner's own drift, `AMBIGUITY_GAP + k * best.cost`.
 *
 * The argument for it is good. A flat gap is right where it was measured — best
 * near zero, rival one wall away — and says nothing about two candidates that
 * have BOTH drifted a third of the way across the part, where the ranking
 * between them is mostly noise and the flat rule still answers confidently.
 * That is the silent-wrong direction this whole design fears.
 *
 * The numbers refuse it at any useful strength. Costs from the eleven reshapes,
 * best → runner-up: {120,40,40} .011→.061, {45,40,60} .083→.133,
 * {200,40,15} .026→.076, {80,90,24} .042→.065, {30,30,30} .082→.149,
 * {60,25,100} .085→.165, {500,20,20} .032→.132, {80,40,200} .129→.179.
 * The binding case is {80,90,24}: a 0.023 gap over a 0.042 best caps k below
 * 0.190, and {80,40,200} caps it below 0.271. Anything strong enough to matter
 * at high drift (k ≈ 0.25 demands 0.09 at best = 0.30) turns a reshape that
 * works today into a re-pick.
 *
 * So it stays flat. What would change that is not a better constant but a test
 * that exhibits the failure being guarded against: a reshape where two
 * moderately separated parallel edges both drift and today's rule confidently
 * returns the wrong one. Without it, k would be a guess constrained only by the
 * cases it must not break — which is the shape of the tuning this file already
 * warns against.
 */

/**
 * A lost pick, flagged so callers can tell it apart from an ordinary modelling
 * error. "Your fillet radius is too big" is something to fix in the code; "I
 * can no longer tell which edge you meant" is something only the human can
 * answer, and the UI has to offer a re-pick rather than a stack trace.
 */
function repick(message) {
  const err = new GraphError(`${message} The pick needs to be made again.`);
  err.repick = true;
  return err;
}

/** Bounding span of a set of enumerated entities — the shape's own box. */
function spanOf(list) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const { d } of list) {
    for (let k = 0; k < 3; k++) {
      if (d.bbox.min[k] < min[k]) min[k] = d.bbox.min[k];
      if (d.bbox.max[k] > max[k]) max[k] = d.bbox.max[k];
    }
  }
  return { min, size: [0, 1, 2].map((k) => max[k] - min[k]) };
}

/**
 * An entity's centre as a fraction of the shape's bounding box.
 *
 * This is the trick that makes a pick survive a parameter change: the top-right
 * corner of a box is at (1, 1, 1) whether the box is 60mm or 80mm wide. A
 * degenerate axis (a flat shape) collapses to the middle rather than dividing
 * by zero.
 */
function unitPos(center, box) {
  return [0, 1, 2].map((k) =>
    box.size[k] > 1e-9 ? (center[k] - box.min[k]) / box.size[k] : 0.5
  );
}

const measureOf = (d) => (d.type === 'edge' ? d.length : d.area);

/**
 * The direction an entity faces, when that is a fact about the entity rather
 * than about where it happened to be sampled.
 *
 * A plane's normal is the same everywhere and an edge's `direction` is already
 * null unless it is a line. A cylinder's `normalAt()` is one sample taken at
 * the parametric centre, which `describeFace` says out loud — so matching does
 * not use it. (`.facing()` still does, filtering on `e.d.normal` whatever the
 * surface kind. That is a separate open gap: there it produces a wrong ANSWER
 * to a question someone asked, which they can see; here it would produce a
 * silent change of which entity a stored pick means.) It is usually harmless,
 * because a rebuild reproduces the same parameterization and the sample lands
 * in the same place; the case it is not is a face re-trimmed by a boolean,
 * where the centre moves and the term changes across rebuilds that are
 * otherwise identical. Non-deterministic evidence is the worst kind: it can
 * flip two adjacent fillet faces on some rebuilds and not others.
 */
const headingOf = (d) => {
  if (d.type === 'edge') return d.direction;
  return d.kind === 'PLANE' ? d.normal : null;
};

const diagOf = (box) => Math.hypot(...box.size) || 1;

/**
 * An entity's size as a fraction of the part's size.
 *
 * Raw length is the wrong thing to compare. The top rim of an 80mm box is 74mm
 * and of a 120mm box is 114mm — the same edge, doing the same job, and reading
 * that 54% growth as evidence the pick has drifted would break exactly the
 * parameter changes picks are supposed to survive. Relative extent barely moves.
 * Area is rooted first so faces and edges are on the same linear footing.
 */
function extentOf(d, box) {
  const raw = measureOf(d);
  if (!(raw > 0)) return 0;
  return (d.type === 'edge' ? raw : Math.sqrt(raw)) / diagOf(box);
}

/**
 * Everything needed to find this entity again on a later version of the shape.
 *
 * `list` must be the FULL enumeration of that type — the whole of
 * `enumerate(shape, 'edge')`, not a filtered subset. Unit positions are
 * fractions of that population's bounding box, and `nearestTo` measures against
 * the same population, so narrowing it here would silently shift every anchor.
 */
export function anchorFor(descriptor, list) {
  const box = spanOf(list);
  return {
    type: descriptor.type,
    kind: descriptor.kind,
    measure: measureOf(descriptor),        // absolute, for humans reading the record
    extent: r4(extentOf(descriptor, box)), // relative, what matching actually uses
    center: descriptor.center,
    unit: r4v(unitPos(descriptor.center, box)),
    heading: headingOf(descriptor),
    hash: descriptor.anchor,
  };
}

/**
 * Distance from a candidate to an anchor. Lower is better; 0 is identical.
 *
 * Every term is scale-free, so the same tolerance works on a 10mm part and a
 * 1000mm one. Position dominates because it is what actually distinguishes the
 * four identical vertical edges of a box; measure and heading are corroborating
 * evidence and are weighted as such.
 */
function anchorCost(d, anchor, box) {
  const unit = unitPos(d.center, box);
  const posCost = Math.hypot(...[0, 1, 2].map((k) => unit[k] - (anchor.unit?.[k] ?? 0.5)));

  // Relative extent, and a ratio rather than a difference: a 3mm fillet growing
  // to 4mm should read the same as a 30mm edge growing to 40mm. An anchor
  // stored before `extent` existed falls back to no size evidence at all rather
  // than to the raw-length comparison that used to punish honest growth.
  const now = extentOf(d, box);
  const then = anchor.extent;
  const measureCost = now > 1e-9 && then > 1e-9
    ? Math.min(1, Math.abs(Math.log(now / then)))
    : 0;

  const a = headingOf(d);
  const b = anchor.heading;
  const headingCost = a && b
    ? (1 - Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2])) / 2
    : 0;

  // Position carries the weight because it is what actually tells the four
  // identical vertical edges of a box apart. Heading is nearly free evidence —
  // it separates edges meeting at a corner and barely moves otherwise.
  //
  // Size is weighted down near to nothing, and that is a measured result rather
  // than taste. Across eleven reshapes of a filleted, shelled box, holding a
  // pick on the top rim: weight 0.5 survived 8, weight 0.15 survived 10, and
  // weight 0 also survived 10. Normalising an edge against the part diagonal
  // still punishes an aspect-ratio change — a top rim tracks `w` alone while
  // the diagonal tracks all three — so a deeper box reads as the rim shrinking.
  // It stays non-zero only because it is the sole term that separates two
  // entities at nearly the same place with very different extents, such as a
  // small pocket face against the wall it sits in, which that suite never
  // exercises. Cheap insurance at 0.15; actively harmful at 0.5.
  return posCost + 0.15 * measureCost + 0.5 * headingCost;
}

/** Entry point handed to cell programs as `q`. */
export const q = {
  faces: (shape) => new Query(shape, 'face'),
  edges: (shape) => new Query(shape, 'edge'),
};

/**
 * Resolve a query (or a plain list of already-resolved entries) to the live
 * OCCT elements of `shape`, for handing to a replicad finder.
 */
export function elementsFor(query, shape) {
  if (!(query instanceof Query)) {
    throw new GraphError('Expected a query built with q.faces(...) or q.edges(...)');
  }
  return query.resolveOn(shape).map((e) => e.element);
}
