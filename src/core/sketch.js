/**
 * The 2D constraint solver — sketches as data, geometry as a consequence.
 *
 * A sketch is points, entities built on those points, and constraints over
 * both. Nothing in it stores a solved coordinate as truth: the numbers in
 * `points` are only ever a starting guess and the last thing the solver landed
 * on. Meaning lives in the constraints, which is what lets a person drag a
 * corner in the canvas and have the rest hold, and what lets a dimension read
 * `p.width` and move when the parameter does.
 *
 * The solver is Levenberg–Marquardt over a residual vector, with a numerical
 * Jacobian. Analytic derivatives would be faster and are not worth the bug
 * surface here: sketches authored from a prompt are small — tens of variables,
 * not thousands — and a wrong derivative fails by converging somewhere subtly
 * wrong rather than by throwing, which is the failure mode we can least afford.
 *
 * Owning the solver instead of binding planegcs buys one thing above all: when
 * a sketch is over-constrained the error names the constraints that fight,
 * which is a sentence a model can act on.
 */

import { GraphError } from './errors.js';

/** Residual magnitude below which a constraint counts as satisfied (mm). */
const TOL = 1e-9;

/** Two solved points closer than this are the same corner for loop-finding. */
const WELD = 1e-6;

// --------------------------------------------------------------- the document

/**
 * A sketch: plane, points, entities, constraints — plus builder methods.
 *
 * The builder and the persisted document are the same object on purpose. A
 * cell program writes `s.line(a, b)`, the UI writes a JSON blob into the cell's
 * `sketch` field, and both end up in the identical shape, so a sketch that was
 * authored in code can still be dragged.
 */
export class Sketch {
  constructor({ plane = 'XY', offset = 0, points = [], entities = [], constraints = [], params = {} } = {}) {
    this.plane = plane;
    this.offset = offset;
    // The cell's parameters, so `s.distance(l, 'width')` works without every
    // call site re-passing them. A sketch is only parametric if the values it
    // reads are the same ones the sliders move.
    this.params = params;
    this.points = points.map((p) => ({ x: Number(p.x), y: Number(p.y), fixed: !!p.fixed }));
    this.entities = entities.map((e) => ({ ...e }));
    this.constraints = constraints.map((c) => ({ ...c }));
    this.report = null;
    // A sketch built by the builder is checked call by call; one revived from
    // JSON has never been checked at all. An entity pointing at a point that
    // does not exist reads as NaN inside the solver and comes back as geometry
    // at the origin rather than as an error, so it is caught here instead.
    if (points.length || entities.length) this.#check();
  }

  #check() {
    const point = (i, what) => {
      if (!Number.isInteger(i) || i < 0 || i >= this.points.length) {
        throw new GraphError(`${what} refers to point ${i}, which this sketch does not have`);
      }
    };
    const entity = (i, what) => {
      if (!Number.isInteger(i) || i < 0 || i >= this.entities.length) {
        throw new GraphError(`${what} refers to entity ${i}, which this sketch does not have`);
      }
    };
    for (const [i, p] of this.points.entries()) {
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) {
        throw new GraphError(`Point ${i} is not at finite coordinates`);
      }
    }
    for (const [i, e] of this.entities.entries()) {
      const what = `entity ${i} (${e.type})`;
      if (e.type === 'line') { point(e.a, what); point(e.b, what); }
      else if (e.type === 'circle') { point(e.c, what); }
      else if (e.type === 'arc') { point(e.c, what); point(e.a, what); point(e.b, what); }
      else throw new GraphError(`${what}: unknown entity type '${e.type}'`);
    }
    for (const [i, c] of this.constraints.entries()) {
      const what = `constraint ${i} (${c.type})`;
      for (const key of ['a', 'b', 'p']) if (c[key] !== undefined) point(c[key], what);
      for (const key of ['e', 'f']) if (c[key] !== undefined) entity(c[key], what);
    }
  }

  // ------------------------------------------------------------- construction

  /** Add a point, returning its index. `fixed` removes it from the unknowns. */
  point(x, y, { fixed = false } = {}) {
    this.points.push({ x: Number(x), y: Number(y), fixed: !!fixed });
    return this.points.length - 1;
  }

  /** A pinned point — every sketch wants at least one or it can drift freely. */
  anchor(x = 0, y = 0) {
    return this.point(x, y, { fixed: true });
  }

  line(a, b) {
    this.#requirePoints('line', a, b);
    this.entities.push({ type: 'line', a, b });
    return this.entities.length - 1;
  }

  circle(c, r) {
    this.#requirePoints('circle', c);
    this.entities.push({ type: 'circle', c, r: Number(r) });
    return this.entities.length - 1;
  }

  /**
   * An arc as centre plus two endpoints, going counter-clockwise from `a` to
   * `b`. The radius is not a variable — it is |c−a|, held equal to |c−b| by an
   * implicit residual. Storing it separately would let a drag put the endpoints
   * somewhere the stated radius cannot reach.
   */
  arc(c, a, b) {
    this.#requirePoints('arc', c, a, b);
    this.entities.push({ type: 'arc', c, a, b });
    return this.entities.length - 1;
  }

  /** A closed rectangle from two opposite corners; returns its four lines. */
  rectangle(x1, y1, x2, y2) {
    const p = [
      this.point(x1, y1),
      this.point(x2, y1),
      this.point(x2, y2),
      this.point(x1, y2),
    ];
    const l = p.map((_, i) => this.line(p[i], p[(i + 1) % 4]));
    this.horizontal(l[0]);
    this.vertical(l[1]);
    this.horizontal(l[2]);
    this.vertical(l[3]);
    return l;
  }

  // -------------------------------------------------------------- constraints

  /** A regular polygon of `n` sides on a circle of radius `r` about (cx, cy); returns its line indices. */
  polygon(cx, cy, n, r) {
    if (!(Number.isInteger(n) && n >= 3)) throw new GraphError('polygon needs at least 3 sides');
    const pts = Array.from({ length: n }, (_, i) => {
      const a = (2 * Math.PI * i) / n;
      return this.point(cx + r * Math.cos(a), cy + r * Math.sin(a));
    });
    const lines = pts.map((p, i) => this.line(p, pts[(i + 1) % n]));
    for (let i = 1; i < n; i++) this.equal(lines[0], lines[i]);
    return lines;
  }

  /** A slot of radius `r` whose semicircle centres are (x1, y1) and (x2, y2); returns [line, arc, line, arc]. */
  slot(x1, y1, x2, y2, r) {
    const len = Math.hypot(x2 - x1, y2 - y1);
    if (!(len > 0 && r > 0)) throw new GraphError('slot needs distinct centres and r > 0');
    const [nx, ny] = [-(y2 - y1) / len * r, (x2 - x1) / len * r];
    const c1 = this.point(x1, y1);
    const c2 = this.point(x2, y2);
    const p1 = this.point(x1 + nx, y1 + ny);
    const p2 = this.point(x2 + nx, y2 + ny);
    const p3 = this.point(x2 - nx, y2 - ny);
    const p4 = this.point(x1 - nx, y1 - ny);
    const l1 = this.line(p1, p2);
    const a1 = this.arc(c2, p3, p2);
    const l2 = this.line(p3, p4);
    const a2 = this.arc(c1, p1, p4);
    this.radius(a1, r);
    this.equal(a1, a2);
    this.tangent(l1, a1);
    this.tangent(l2, a2);
    this.parallel(l1, l2);
    return [l1, a1, l2, a2];
  }

  coincident(a, b) { return this.#add({ type: 'coincident', a, b }); }
  horizontal(e) { return this.#add({ type: 'horizontal', e }); }
  vertical(e) { return this.#add({ type: 'vertical', e }); }
  distance(a, b, value) {
    return value === undefined
      ? this.#add({ type: 'distance', e: a, value: b })
      : this.#add({ type: 'distance', a, b, value });
  }
  distanceX(a, b, value) { return this.#add({ type: 'distanceX', a, b, value }); }
  distanceY(a, b, value) { return this.#add({ type: 'distanceY', a, b, value }); }
  radius(e, value) { return this.#add({ type: 'radius', e, value }); }
  diameter(e, value) { return this.#add({ type: 'diameter', e, value }); }
  equal(e, f) { return this.#add({ type: 'equal', e, f }); }
  parallel(e, f) { return this.#add({ type: 'parallel', e, f }); }
  perpendicular(e, f) { return this.#add({ type: 'perpendicular', e, f }); }
  angle(e, f, value) { return this.#add({ type: 'angle', e, f, value }); }
  tangent(e, f) { return this.#add({ type: 'tangent', e, f }); }
  pointOn(p, e) { return this.#add({ type: 'pointOn', p, e }); }
  concentric(e, f) { return this.#add({ type: 'concentric', e, f }); }

  #add(c) {
    this.constraints.push(c);
    return this.constraints.length - 1;
  }

  #requirePoints(what, ...idx) {
    for (const i of idx) {
      if (!Number.isInteger(i) || i < 0 || i >= this.points.length) {
        throw new GraphError(`${what}: ${i} is not a point in this sketch`);
      }
    }
  }

  // ------------------------------------------------------------------- solving

  /**
   * Solve in place. Returns the report; throws only when the constraints
   * cannot all be met, because that is the one case a caller cannot proceed
   * from. An under-constrained sketch is a normal state — it is what a sketch
   * looks like while it is being written — so it comes back with a `dof` count
   * rather than an exception.
   */
  solve({ params = this.params, maxIterations = 200 } = {}) {
    this.report = solveSketch(this, { params, maxIterations });
    if (!this.report.converged) throw new GraphError(this.report.message);
    return this.report;
  }

  /**
   * Put the sketch on a plane: a name ('XY', 'XZ', 'YZ', 'YX', 'ZX', 'ZY') or a
   * plane object such as brep.planeOf(shape, faceQuery) returns. `offset`
   * slides it along the plane normal — a loft's sections are the same sketch
   * placed at different offsets.
   */
  on(plane, offset = 0) {
    this.plane = plane;
    this.offset = offset;
    return this;
  }

  /** Degrees of freedom left after the last solve; null if never solved. */
  get dof() {
    return this.report ? this.report.dof : null;
  }

  /** Closed loops of solved geometry, outermost first. */
  loops() {
    return sketchLoops(this);
  }

  toJSON() {
    return {
      plane: this.plane,
      ...(this.offset ? { offset: this.offset } : {}),
      points: this.points.map((p) => ({ x: p.x, y: p.y, ...(p.fixed ? { fixed: true } : {}) })),
      entities: this.entities.map((e) => ({ ...e })),
      constraints: this.constraints.map((c) => ({ ...c })),
    };
  }
}

/** Build a sketch, from nothing or from a persisted document. */
export function sketch(data) {
  return new Sketch(data);
}

// ------------------------------------------------------------------- the system

/**
 * Turn a sketch into a residual system: which numbers may move, and what has
 * to be zero.
 */
function buildSystem(sk, params) {
  const { points, entities, constraints } = sk;

  // Variable layout. Fixed points contribute nothing — dropping their columns
  // is what makes the reported degrees of freedom mean "things still floating"
  // rather than "things floating plus the datum I already pinned".
  const px = new Int32Array(points.length).fill(-1);
  const py = new Int32Array(points.length).fill(-1);
  const initial = [];
  points.forEach((p, i) => {
    if (p.fixed) return;
    px[i] = initial.push(p.x) - 1;
    py[i] = initial.push(p.y) - 1;
  });
  const rv = new Int32Array(entities.length).fill(-1);
  entities.forEach((e, i) => {
    if (e.type === 'circle') rv[i] = initial.push(Number(e.r)) - 1;
  });

  /** Read the geometry out of a variable vector. */
  const read = (x) => {
    const X = points.map((p, i) => (px[i] < 0 ? p.x : x[px[i]]));
    const Y = points.map((p, i) => (py[i] < 0 ? p.y : x[py[i]]));
    const R = entities.map((e, i) => {
      if (e.type === 'circle') return x[rv[i]];
      if (e.type === 'arc') return Math.hypot(X[e.c] - X[e.a], Y[e.c] - Y[e.a]);
      return NaN;
    });
    return { X, Y, R };
  };

  // Residual blocks, each tagged with the constraint it came from so a failure
  // can name it. Arcs contribute an implicit block of their own.
  const blocks = [];
  entities.forEach((e, i) => {
    if (e.type !== 'arc') return;
    blocks.push({
      label: `arc ${i}`,
      size: 1,
      implicit: true,
      fn: (g) => [dist(g, e.c, e.b) - dist(g, e.c, e.a)],
    });
  });

  const sides = new Map(); // tangency branch, chosen once from the input pose
  const g0 = read(initial);
  constraints.forEach((c, i) => {
    const block = residualBlock(sk, c, i, params, g0, sides);
    blocks.push(block);
  });

  const residuals = (x) => {
    const g = read(x);
    const out = [];
    for (const b of blocks) out.push(...b.fn(g));
    return out;
  };

  return { initial, residuals, blocks, read, px, py, rv };
}

/** Resolve a dimension: a number, or the name of a cell parameter. */
function dimension(value, params, what) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const v = params[value];
    if (typeof v !== 'number') {
      throw new GraphError(`${what}: no parameter named '${value}' to use as a dimension`);
    }
    return v;
  }
  throw new GraphError(`${what}: needs a numeric value or a parameter name`);
}

const dist = (g, a, b) => Math.hypot(g.X[a] - g.X[b], g.Y[a] - g.Y[b]);

/** The two endpoints a constraint means, whether it named a line or two points. */
function endpoints(sk, c, what) {
  if (c.e !== undefined && c.a === undefined) {
    const e = line(sk, c.e, what);
    return [e.a, e.b];
  }
  if (Number.isInteger(c.a) && Number.isInteger(c.b)) return [c.a, c.b];
  throw new GraphError(`${what}: needs a line, or two points`);
}

function line(sk, i, what) {
  const e = sk.entities[i];
  if (!e) throw new GraphError(`${what}: ${i} is not an entity in this sketch`);
  if (e.type !== 'line') throw new GraphError(`${what}: entity ${i} is a ${e.type}, not a line`);
  return e;
}

function curve(sk, i, what) {
  const e = sk.entities[i];
  if (!e) throw new GraphError(`${what}: ${i} is not an entity in this sketch`);
  if (e.type !== 'circle' && e.type !== 'arc') {
    throw new GraphError(`${what}: entity ${i} is a ${e.type}, not a circle or arc`);
  }
  return e;
}

/** Unit-ish direction of a line, plus its length. */
function dir(g, e) {
  const dx = g.X[e.b] - g.X[e.a];
  const dy = g.Y[e.b] - g.Y[e.a];
  const len = Math.hypot(dx, dy) || 1e-12;
  return { dx, dy, len };
}

/** Signed perpendicular distance from a point to a line's infinite extension. */
function perpDistance(g, e, p) {
  const d = dir(g, e);
  return ((g.X[p] - g.X[e.a]) * d.dy - (g.Y[p] - g.Y[e.a]) * d.dx) / d.len;
}

/**
 * One constraint's residuals.
 *
 * Angular constraints are divided by the two lengths so they stay unitless;
 * mixing a raw cross product (mm²) with a distance (mm) in the same vector
 * makes long edges dominate the step and short ones never converge.
 */
function residualBlock(sk, c, index, params, g0, sides) {
  const what = `constraint ${index} (${c.type})`;
  switch (c.type) {
    case 'coincident': {
      const [a, b] = [c.a, c.b];
      return { label: what, size: 2, fn: (g) => [g.X[a] - g.X[b], g.Y[a] - g.Y[b]] };
    }
    case 'concentric': {
      const a = curve(sk, c.e, what).c;
      const b = curve(sk, c.f, what).c;
      return { label: what, size: 2, fn: (g) => [g.X[a] - g.X[b], g.Y[a] - g.Y[b]] };
    }
    case 'horizontal': {
      const [a, b] = endpoints(sk, c, what);
      return { label: what, size: 1, fn: (g) => [g.Y[a] - g.Y[b]] };
    }
    case 'vertical': {
      const [a, b] = endpoints(sk, c, what);
      return { label: what, size: 1, fn: (g) => [g.X[a] - g.X[b]] };
    }
    case 'distance': {
      const [a, b] = endpoints(sk, c, what);
      const v = dimension(c.value, params, what);
      return { label: what, size: 1, fn: (g) => [dist(g, a, b) - v] };
    }
    case 'distanceX': {
      const v = dimension(c.value, params, what);
      return { label: what, size: 1, fn: (g) => [g.X[c.b] - g.X[c.a] - v] };
    }
    case 'distanceY': {
      const v = dimension(c.value, params, what);
      return { label: what, size: 1, fn: (g) => [g.Y[c.b] - g.Y[c.a] - v] };
    }
    case 'radius': {
      curve(sk, c.e, what);
      const v = dimension(c.value, params, what);
      return { label: what, size: 1, fn: (g) => [g.R[c.e] - v] };
    }
    case 'diameter': {
      curve(sk, c.e, what);
      const v = dimension(c.value, params, what);
      return { label: what, size: 1, fn: (g) => [2 * g.R[c.e] - v] };
    }
    case 'equal': {
      const a = sk.entities[c.e];
      const b = sk.entities[c.f];
      if (!a || !b) throw new GraphError(`${what}: needs two entities`);
      if (a.type === 'line' && b.type === 'line') {
        return { label: what, size: 1, fn: (g) => [dist(g, a.a, a.b) - dist(g, b.a, b.b)] };
      }
      if (a.type !== 'line' && b.type !== 'line') {
        return { label: what, size: 1, fn: (g) => [g.R[c.e] - g.R[c.f]] };
      }
      throw new GraphError(`${what}: cannot equate a ${a.type} to a ${b.type}`);
    }
    case 'parallel': {
      const a = line(sk, c.e, what);
      const b = line(sk, c.f, what);
      return {
        label: what,
        size: 1,
        fn: (g) => {
          const u = dir(g, a);
          const v = dir(g, b);
          return [(u.dx * v.dy - u.dy * v.dx) / (u.len * v.len)];
        },
      };
    }
    case 'perpendicular': {
      const a = line(sk, c.e, what);
      const b = line(sk, c.f, what);
      return {
        label: what,
        size: 1,
        fn: (g) => {
          const u = dir(g, a);
          const v = dir(g, b);
          return [(u.dx * v.dx + u.dy * v.dy) / (u.len * v.len)];
        },
      };
    }
    case 'angle': {
      const a = line(sk, c.e, what);
      const b = line(sk, c.f, what);
      const target = (dimension(c.value, params, what) * Math.PI) / 180;
      return {
        label: what,
        size: 1,
        fn: (g) => {
          const u = dir(g, a);
          const v = dir(g, b);
          const theta = Math.atan2(u.dx * v.dy - u.dy * v.dx, u.dx * v.dx + u.dy * v.dy);
          return [wrap(theta - target)];
        },
      };
    }
    case 'tangent': {
      const a = sk.entities[c.e];
      const b = sk.entities[c.f];
      if (!a || !b) throw new GraphError(`${what}: needs two entities`);
      const lineIdx = a.type === 'line' ? c.e : b.type === 'line' ? c.f : -1;
      if (lineIdx >= 0) {
        const other = lineIdx === c.e ? c.f : c.e;
        curve(sk, other, what);
        const l = sk.entities[lineIdx];
        // Tangency has two solutions — the curve on either side of the line.
        // Pick the side the sketch is already on and hold it, or a drag flips
        // the geometry inside out on the way to a technically valid answer.
        const side = Math.sign(perpDistance(g0, l, sk.entities[other].c)) || 1;
        sides.set(index, side);
        return {
          label: what,
          size: 1,
          fn: (g) => [perpDistance(g, l, sk.entities[other].c) - side * g.R[other]],
        };
      }
      const ca = curve(sk, c.e, what);
      const cb = curve(sk, c.f, what);
      const d0 = Math.hypot(g0.X[ca.c] - g0.X[cb.c], g0.Y[ca.c] - g0.Y[cb.c]);
      const external = Math.abs(d0 - (g0.R[c.e] + g0.R[c.f])) <=
        Math.abs(d0 - Math.abs(g0.R[c.e] - g0.R[c.f]));
      return {
        label: what,
        size: 1,
        fn: (g) => {
          const d = Math.hypot(g.X[ca.c] - g.X[cb.c], g.Y[ca.c] - g.Y[cb.c]);
          const want = external ? g.R[c.e] + g.R[c.f] : Math.abs(g.R[c.e] - g.R[c.f]);
          return [d - want];
        },
      };
    }
    case 'pointOn': {
      const e = sk.entities[c.e];
      if (!e) throw new GraphError(`${what}: ${c.e} is not an entity in this sketch`);
      if (e.type === 'line') {
        return { label: what, size: 1, fn: (g) => [perpDistance(g, e, c.p)] };
      }
      return {
        label: what,
        size: 1,
        fn: (g) => [Math.hypot(g.X[c.p] - g.X[e.c], g.Y[c.p] - g.Y[e.c]) - g.R[c.e]],
      };
    }
    default:
      throw new GraphError(`Unknown constraint type '${c.type}'`);
  }
}

const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

// ------------------------------------------------------------------- the solve

/**
 * Solve a sketch and report on it. Writes solved coordinates back into the
 * sketch's points and circle radii whether or not it converged — a failed
 * solve that leaves the geometry where it started tells a person nothing about
 * which way the constraints were pulling.
 */
export function solveSketch(sk, { params = {}, maxIterations = 200 } = {}) {
  const { initial, residuals, blocks, read, px, py, rv } = buildSystem(sk, params);

  const solved = initial.length === 0
    ? { x: initial, iterations: 0 }
    : levenberg(residuals, initial, maxIterations);

  const g = read(solved.x);
  sk.points.forEach((p, i) => {
    if (px[i] >= 0) p.x = g.X[i];
    if (py[i] >= 0) p.y = g.Y[i];
  });
  sk.entities.forEach((e, i) => {
    if (rv[i] >= 0) e.r = solved.x[rv[i]];
  });

  const r = residuals(solved.x);
  const worst = r.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  const converged = worst <= Math.max(TOL, 1e-7 * scaleOf(sk));

  // Rank of the Jacobian at the answer is the honest measure of both freedoms
  // and redundancies: columns it cannot reach are what is still floating, rows
  // it cannot distinguish are constraints that repeat something already said.
  //
  // Redundancy is counted over the WRITTEN constraints only. An arc's implicit
  // "both endpoints share a radius" row is usually implied by whatever pinned
  // those endpoints, and reporting the arc's own definition as a redundant
  // constraint would train a reader to ignore the warning.
  const J = jacobian(residuals, solved.x, r.length);
  const rank = matrixRank(J, initial.length);
  const dof = initial.length - rank;
  const userRows = J.filter((_, i) => !implicitRow(blocks, i));
  const redundant = userRows.length - matrixRank(userRows, initial.length);

  const offenders = blocks
    .map((b, i) => ({ block: b, residual: blockResidual(blocks, r, i) }))
    .filter((o) => Math.abs(o.residual) > Math.max(TOL, 1e-7 * scaleOf(sk)))
    .sort((a, b) => Math.abs(b.residual) - Math.abs(a.residual));

  return {
    converged,
    dof,
    redundant: converged && redundant > 0 ? redundant : 0,
    iterations: solved.iterations,
    residual: worst,
    conflicts: offenders.map((o) => ({ constraint: o.block.label, off: o.residual })),
    message: converged
      ? `solved, ${dof} degree${dof === 1 ? '' : 's'} of freedom left`
      : overConstrainedMessage(offenders, worst),
  };
}

function overConstrainedMessage(offenders, worst) {
  if (!offenders.length) {
    return `Sketch did not converge (worst residual ${worst.toExponential(2)})`;
  }
  const named = offenders.slice(0, 3).map((o) => `${o.block.label} off by ${fmt(o.residual)}`);
  return `Sketch is over-constrained — these cannot all hold at once: ${named.join('; ')}`;
}

const fmt = (v) => (Math.abs(v) < 1e-3 ? v.toExponential(2) : v.toFixed(4));

/** Whether residual row `i` came from an entity's own definition, not a constraint. */
function implicitRow(blocks, i) {
  let at = 0;
  for (const b of blocks) {
    if (i < at + b.size) return !!b.implicit;
    at += b.size;
  }
  return false;
}

/** Sum of one block's residuals, for blaming a constraint. */
function blockResidual(blocks, r, i) {
  let at = 0;
  for (let k = 0; k < i; k++) at += blocks[k].size;
  let worst = 0;
  for (let k = 0; k < blocks[i].size; k++) {
    if (Math.abs(r[at + k]) > Math.abs(worst)) worst = r[at + k];
  }
  return worst;
}

/** A characteristic length, so tolerances mean something on a 500mm sketch. */
function scaleOf(sk) {
  let s = 1;
  for (const p of sk.points) s = Math.max(s, Math.abs(p.x), Math.abs(p.y));
  return s;
}

/**
 * Levenberg–Marquardt: gradient descent when far away, Gauss–Newton when
 * close, with λ sliding between them on every accepted or rejected step.
 */
function levenberg(f, x0, maxIterations) {
  let x = x0.slice();
  let r = f(x);
  let cost = sumSquares(r);
  let lambda = 1e-3;
  let iterations = 0;

  for (; iterations < maxIterations; iterations++) {
    if (maxAbs(r) <= TOL) break;
    const J = jacobian(f, x, r.length);
    const n = x.length;

    // Normal equations: (JᵀJ + λ·diag) dx = −Jᵀr.
    const JtJ = Array.from({ length: n }, () => new Float64Array(n));
    const Jtr = new Float64Array(n);
    for (let i = 0; i < r.length; i++) {
      for (let a = 0; a < n; a++) {
        if (J[i][a] === 0) continue;
        Jtr[a] += J[i][a] * r[i];
        for (let b = a; b < n; b++) JtJ[a][b] += J[i][a] * J[i][b];
      }
    }
    for (let a = 0; a < n; a++) for (let b = 0; b < a; b++) JtJ[a][b] = JtJ[b][a];

    let stepped = false;
    for (let attempt = 0; attempt < 12; attempt++) {
      const A = JtJ.map((row, a) => {
        const copy = Array.from(row);
        // A floor under the damping keeps the matrix invertible when a point
        // has no constraints touching it at all — its column is zero, and the
        // right answer for an unconstrained point is to leave it alone.
        copy[a] += lambda * Math.max(JtJ[a][a], 1e-3);
        return copy;
      });
      const dx = solveLinear(A, Array.from(Jtr, (v) => -v));
      if (!dx) {
        lambda *= 10;
        continue;
      }
      const xn = x.map((v, i) => v + dx[i]);
      const rn = f(xn);
      const cn = sumSquares(rn);
      if (cn < cost) {
        const moved = maxAbs(dx);
        x = xn;
        r = rn;
        cost = cn;
        lambda = Math.max(lambda / 3, 1e-12);
        stepped = true;
        if (moved < 1e-14) return { x, iterations };
        break;
      }
      lambda *= 10;
    }
    if (!stepped) break; // no downhill direction — over-constrained, or converged
  }
  return { x, iterations };
}

/**
 * Central-difference Jacobian. Central rather than forward because tangency
 * and angle residuals are curved enough near the solution that a one-sided
 * slope costs iterations and, on a nearly singular system, accuracy.
 */
function jacobian(f, x, m) {
  const n = x.length;
  const J = Array.from({ length: m }, () => new Float64Array(n));
  for (let j = 0; j < n; j++) {
    const h = 1e-7 * Math.max(1, Math.abs(x[j]));
    const xp = x.slice();
    const xm = x.slice();
    xp[j] += h;
    xm[j] -= h;
    const rp = f(xp);
    const rm = f(xm);
    for (let i = 0; i < m; i++) J[i][j] = (rp[i] - rm[i]) / (2 * h);
  }
  return J;
}

/** Gaussian elimination with partial pivoting; null if singular. */
function solveLinear(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(M[row][col]) > Math.abs(M[pivot][col])) pivot = row;
    }
    if (Math.abs(M[pivot][col]) < 1e-14) return null;
    [M[col], M[pivot]] = [M[pivot], M[col]];
    for (let row = col + 1; row < n; row++) {
      const factor = M[row][col] / M[col][col];
      if (factor === 0) continue;
      for (let k = col; k <= n; k++) M[row][k] -= factor * M[col][k];
    }
  }
  const x = new Array(n).fill(0);
  for (let row = n - 1; row >= 0; row--) {
    let sum = M[row][n];
    for (let k = row + 1; k < n; k++) sum -= M[row][k] * x[k];
    x[row] = sum / M[row][row];
  }
  return x.every(Number.isFinite) ? x : null;
}

/** Rank by row reduction, with the tolerance scaled to the largest entry. */
function matrixRank(J, n) {
  const M = J.map((row) => Array.from(row));
  let biggest = 0;
  for (const row of M) for (const v of row) biggest = Math.max(biggest, Math.abs(v));
  const eps = Math.max(biggest, 1) * 1e-9;
  let rank = 0;
  for (let col = 0; col < n && rank < M.length; col++) {
    let pivot = -1;
    let best = eps;
    for (let row = rank; row < M.length; row++) {
      if (Math.abs(M[row][col]) > best) {
        best = Math.abs(M[row][col]);
        pivot = row;
      }
    }
    if (pivot < 0) continue;
    [M[rank], M[pivot]] = [M[pivot], M[rank]];
    for (let row = 0; row < M.length; row++) {
      if (row === rank) continue;
      const factor = M[row][col] / M[rank][col];
      if (factor === 0) continue;
      for (let k = col; k < n; k++) M[row][k] -= factor * M[rank][k];
    }
    rank++;
  }
  return rank;
}

const sumSquares = (v) => v.reduce((s, x) => s + x * x, 0);
const maxAbs = (v) => v.reduce((m, x) => Math.max(m, Math.abs(x)), 0);

/**
 * Solve a sketch with one point dragged to a new position.
 *
 * The dragged point is pinned for the duration of the solve, so the rest of the
 * sketch moves to accommodate the hand rather than the hand losing to the
 * constraints. When pinning makes the system impossible — dragging a corner of
 * a fully dimensioned rectangle — the pin is dropped and the sketch is solved
 * from the dragged position as a starting guess instead, which is what "you
 * cannot move that, but here is the nearest thing you can" looks like.
 *
 * The pin is never persisted: what comes back has the point's original `fixed`
 * flag, or a drag would silently weld the sketch down one corner at a time.
 */
export function solveWithDrag(data, move, params = {}) {
  const sk = new Sketch({ ...data, params });
  if (!move || !sk.points[move.point]) {
    const report = solveSketch(sk, { params });
    return { sketch: sk.toJSON(), report, pinned: false };
  }

  const point = sk.points[move.point];
  const wasFixed = point.fixed;
  point.x = Number(move.x);
  point.y = Number(move.y);
  point.fixed = true;
  let report = solveSketch(sk, { params });
  point.fixed = wasFixed;
  if (report.converged) return { sketch: sk.toJSON(), report, pinned: true };

  report = solveSketch(sk, { params });
  return { sketch: sk.toJSON(), report, pinned: false };
}

// -------------------------------------------------------------------- profiles

/**
 * Chain the solved entities into closed loops.
 *
 * Endpoints are welded both by coincident constraints and by proximity, so a
 * profile drawn as four independent lines that the solver pulled together is
 * as closed as one drawn with shared points. Loops come back outermost first
 * by absolute area, which is the order extrude wants: boundary, then holes.
 */
export function sketchLoops(sk) {
  const parent = sk.points.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const join = (a, b) => {
    const [ra, rb] = [find(a), find(b)];
    if (ra !== rb) parent[rb] = ra;
  };
  for (const c of sk.constraints) if (c.type === 'coincident') join(c.a, c.b);
  for (let i = 0; i < sk.points.length; i++) {
    for (let j = i + 1; j < sk.points.length; j++) {
      if (Math.hypot(sk.points[i].x - sk.points[j].x, sk.points[i].y - sk.points[j].y) < WELD) {
        join(i, j);
      }
    }
  }

  const loops = [];
  const segments = [];
  sk.entities.forEach((e, i) => {
    if (e.type === 'circle') {
      loops.push({ closed: true, segments: [circleSegment(sk, e)] });
    } else {
      segments.push({ index: i, entity: e, a: find(e.a), b: find(e.b), used: false });
    }
  });

  const at = new Map();
  for (const s of segments) {
    for (const node of [s.a, s.b]) {
      if (!at.has(node)) at.set(node, []);
      at.get(node).push(s);
    }
  }
  for (const [node, list] of at) {
    if (list.length !== 2) {
      throw new GraphError(
        `Sketch is not a set of closed loops: point ${node} joins ${list.length} edge${list.length === 1 ? '' : 's'}, not 2`
      );
    }
  }

  for (const start of segments) {
    if (start.used) continue;
    const chain = [];
    let current = start;
    let from = start.a;
    while (current && !current.used) {
      current.used = true;
      const to = current.a === from ? current.b : current.a;
      chain.push(segmentGeometry(sk, current.entity, current.a === from));
      const next = at.get(to).find((s) => !s.used);
      from = to;
      current = next;
    }
    if (from !== start.a) throw new GraphError('Sketch has an open chain of edges');
    loops.push({ closed: true, segments: chain });
  }

  return loops.sort((a, b) => Math.abs(loopArea(b)) - Math.abs(loopArea(a)));
}

function circleSegment(sk, e) {
  const c = sk.points[e.c];
  return { type: 'circle', center: [c.x, c.y], radius: Number(e.r) };
}

/** One entity as directed geometry — reversed when the chain arrives at `b`. */
function segmentGeometry(sk, e, forward) {
  const P = (i) => [sk.points[i].x, sk.points[i].y];
  if (e.type === 'line') {
    return forward
      ? { type: 'line', from: P(e.a), to: P(e.b) }
      : { type: 'line', from: P(e.b), to: P(e.a) };
  }
  const c = sk.points[e.c];
  const radius = Math.hypot(sk.points[e.a].x - c.x, sk.points[e.a].y - c.y);
  // Arcs are authored counter-clockwise from a to b; traversing one backwards
  // makes it clockwise, and the mid-point below has to follow or the arc bulges
  // out the wrong side of its chord.
  const ccw = forward;
  const [from, to] = forward ? [P(e.a), P(e.b)] : [P(e.b), P(e.a)];
  const { mid, sweep } = arcSpan([c.x, c.y], radius, from, to, ccw);
  return { type: 'arc', from, to, center: [c.x, c.y], radius, ccw, mid, sweep };
}

/**
 * The arc's signed sweep, and a third point on it — which is how most kernels
 * prefer to be told about an arc, since three points fix the bulge without a
 * separate "which way round" flag to get wrong.
 */
function arcSpan(center, radius, from, to, ccw) {
  const a0 = Math.atan2(from[1] - center[1], from[0] - center[0]);
  let a1 = Math.atan2(to[1] - center[1], to[0] - center[0]);
  if (ccw) {
    while (a1 <= a0) a1 += 2 * Math.PI;
  } else {
    while (a1 >= a0) a1 -= 2 * Math.PI;
  }
  const mid = (a0 + a1) / 2;
  return {
    mid: [center[0] + radius * Math.cos(mid), center[1] + radius * Math.sin(mid)],
    sweep: a1 - a0,
  };
}

/**
 * Signed area of a loop: the polygon through the corners, plus each arc's
 * circular segment. The segment term carries the arc's own sign, so a loop
 * walked clockwise comes back negative whichever way its arcs bulge — which is
 * what lets `sketchLoops` sort boundary before holes by magnitude alone.
 */
export function loopArea(loop) {
  let area = 0;
  const pts = [];
  for (const s of loop.segments) {
    if (s.type === 'circle') return Math.PI * s.radius * s.radius;
    pts.push(s.from);
    if (s.type === 'arc') area += (s.radius * s.radius / 2) * (s.sweep - Math.sin(s.sweep));
  }
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    area += (x1 * y2 - x2 * y1) / 2;
  }
  return area;
}
