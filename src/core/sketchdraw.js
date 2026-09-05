/**
 * Drawing into a sketch — the authoring half of the canvas.
 *
 * Dragging moves geometry that already exists. This is how it comes to exist:
 * a person draws a line, and what gets stored is not the two coordinates they
 * happened to click but a line, its endpoints, and whatever the gesture implied
 * about them — that this end is the same corner as that one, that the line was
 * meant to be horizontal, that this point rides on that circle. A click is
 * evidence about intent, and the constraints are where the intent goes.
 *
 * It lives on the server, next to the solver, for the same reason the solver
 * does: inference that ran in the browser would be a second set of rules to
 * keep true, and the rule that matters most here — whether the sketch still
 * solves once the guess is in — can only be answered by solving it.
 *
 * Two rules run through everything below.
 *
 * A snap to an existing point REUSES that point rather than adding a coincident
 * constraint between two points at the same place. Identity is exact, costs the
 * solver two variables and two residuals less, and cannot be dragged apart —
 * which is what "these are the same corner" should mean.
 *
 * Every constraint a draw infers is provisional. If the sketch stops solving
 * with them in, they come out and the geometry stays. A person who drew a line
 * wants the line; they did not ask for the horizontal, we did.
 */

import { GraphError } from './errors.js';
import { Sketch, solveSketch } from './sketch.js';

/** A line drawn within this of an axis was meant to be on it. */
const AXIS_TOL = (4 * Math.PI) / 180;

/** Below this a gesture is a mis-click rather than geometry. */
const EPS = 1e-9;

/**
 * Draw one entity into a sketch and return the solved result.
 *
 * `snap` is a distance in sketch units, not pixels — the canvas divides its
 * hit radius by the view scale before sending it, so zooming in snaps to what
 * looks close on screen rather than to a tolerance that means nothing at 40×.
 *
 * The incoming sketch is copied, never mutated: a draw that turns out to be
 * unsolvable must leave the document exactly as it was.
 */
export function drawOn(data, op, { params = {}, snap = 0 } = {}) {
  const sk = new Sketch({ ...(data || {}), params });

  // Whether the sketch solved BEFORE the draw decides how a failure after it is
  // read. Breaking a sketch that worked is this function's fault and refuses;
  // failing to fix one that was already over-constrained is not.
  const wasSolvable = solveSketch(sk, { params }).converged;

  const soft = [];   // constraints this draw guessed at, newest last
  const notes = [];  // what it did, in words, for the canvas to echo back

  // A drawn sketch starts on XY; a draw may say otherwise, once, up front.
  if (op?.plane) sk.plane = op.plane;
  const tool = op?.tool === 'rectangle' ? 'rect' : op?.tool;
  switch (tool) {
    case 'line': {
      const a = resolve(sk, op.from, snap, soft, notes);
      const b = resolve(sk, op.to, snap, soft, notes);
      if (a === b) throw new GraphError('A line needs two different points');
      const e = sk.line(a, b);
      inferAxis(sk, e, soft, notes);
      break;
    }
    case 'rect': {
      const [x1, y1] = coords(op.from, 'rect from');
      const [x2, y2] = coords(op.to, 'rect to');
      if (Math.abs(x2 - x1) < EPS || Math.abs(y2 - y1) < EPS) {
        throw new GraphError('A rectangle needs width and height');
      }
      // Only the two clicked corners can snap. The other two are implied by
      // them, and letting an implied corner grab a nearby point would silently
      // weld the rectangle to geometry the person never pointed at.
      const p0 = resolve(sk, [x1, y1], snap, soft, notes);
      const p2 = resolve(sk, [x2, y2], snap, soft, notes);
      if (p0 === p2) throw new GraphError('A rectangle needs two different corners');
      const p1 = sk.point(x2, y1);
      const p3 = sk.point(x1, y2);
      const l = [sk.line(p0, p1), sk.line(p1, p2), sk.line(p2, p3), sk.line(p3, p0)];
      for (const [k, e] of l.entries()) {
        const horizontal = k % 2 === 0;
        soft.push({
          index: horizontal ? sk.horizontal(e) : sk.vertical(e),
          label: horizontal ? 'horizontal' : 'vertical',
        });
      }
      notes.push('rectangle');
      break;
    }
    case 'circle': {
      const c = resolve(sk, op.center, snap, soft, notes);
      const r = radiusOf(sk, op, c);
      sk.circle(c, r);
      break;
    }
    case 'arc': {
      // Centre, then the two ends, counter-clockwise from `from` to `to` — the
      // same shape the entity is stored in, so nothing has to be fitted or
      // guessed. The second end is pulled onto the first one's radius by the
      // arc's own implicit residual, so the third click only picks the angle.
      const c = resolve(sk, op.center, snap, soft, notes);
      const a = resolve(sk, op.from, snap, soft, notes);
      const b = resolve(sk, op.to, snap, soft, notes);
      if (a === b || a === c || b === c) {
        throw new GraphError('An arc needs a centre and two different ends');
      }
      sk.arc(c, a, b);
      break;
    }
    default:
      throw new GraphError(
        `Unknown drawing tool '${tool}'. Use line {from,to}, rect {from,to}, circle {center,radius}, or arc {center,from,to} (points are [x,y]).`
      );
  }

  let report = solveSketch(sk, { params });
  let dropped = [];
  if (!report.converged && soft.length) {
    // Newest first, so each splice leaves the earlier indices where they were.
    for (const s of [...soft].sort((x, y) => y.index - x.index)) {
      sk.constraints.splice(s.index, 1);
    }
    dropped = [...new Set(soft.map((s) => s.label))];
    report = solveSketch(sk, { params });
  }

  if (!report.converged && wasSolvable) {
    throw new GraphError(`That would break the sketch: ${report.message}`);
  }

  return {
    sketch: sk.toJSON(),
    report,
    inferred: [...new Set(notes.concat(soft.filter((s) => !dropped.includes(s.label)).map((s) => s.label)))],
    dropped,
  };
}

/**
 * Dimension something: a line's length, a curve's radius, or the gap between
 * two points.
 *
 * The opposite policy from `drawOn`'s inference, and deliberately so. A guessed
 * horizontal is ours and gets dropped when it does not fit; a dimension is a
 * statement the person made, so if it cannot hold, the answer is to say which
 * constraints fight rather than to quietly not apply it. The solver already
 * names them, which is the whole reason for owning it.
 *
 * `value` may be a NUMBER or the NAME OF A PARAM. The name is the interesting
 * case: it is what turns a drawn outline into a parametric one, so a slider the
 * program declares moves geometry a person drew by hand.
 */
export function dimensionOn(data, op, { params = {} } = {}) {
  const sk = new Sketch({ ...(data || {}), params });
  const before = solveSketch(sk, { params });

  const pinning = op?.constraint === 'fixed' || op?.kind === 'fixed';
  const value = pinning ? null : dimensionValue(op?.value, params);
  let label;

  if (Number.isInteger(op?.constraint)) {
    // Changing a dimension already written, rather than adding another one.
    // Without this the only way to fix a typed number is to remove it and say
    // it again, and the second saying is a different constraint — which loses
    // whatever else pointed at the first.
    const c = sk.constraints[op.constraint];
    if (!c) throw new GraphError(`This sketch has no constraint ${op.constraint}`);
    if (c.value === undefined) {
      throw new GraphError(`Constraint ${op.constraint} (${c.type}) has no value to set`);
    }
    c.value = value;
    label = c.type;
  } else if (Number.isInteger(op?.entity)) {
    const e = sk.entities[op.entity];
    if (!e) throw new GraphError(`This sketch has no entity ${op.entity}`);
    if (e.type === 'line') {
      sk.distance(op.entity, value);
      label = 'length';
    } else if (op.kind === 'diameter') {
      sk.diameter(op.entity, value);
      label = 'diameter';
    } else {
      sk.radius(op.entity, value);
      label = 'radius';
    }
  } else if (Array.isArray(op?.points) && op.points.length === 1 && (op.constraint === 'fixed' || op.kind === 'fixed')) {
    const [i] = op.points;
    if (!Number.isInteger(i) || !sk.points[i]) throw new GraphError(`This sketch has no point ${i}`);
    sk.points[i].fixed = true;
    label = 'fixed';
  } else if (Array.isArray(op?.points) && op.points.length === 2) {
    const [a, b] = op.points;
    for (const i of [a, b]) {
      if (!Number.isInteger(i) || !sk.points[i]) {
        throw new GraphError(`This sketch has no point ${i}`);
      }
    }
    if (a === b) throw new GraphError('A dimension needs two different points');
    const which = op.constraint ?? op.kind ?? (op.axis === 'x' ? 'distanceX' : op.axis === 'y' ? 'distanceY' : 'distance');
    if (which === 'distanceX') { sk.distanceX(a, b, value); label = 'horizontal gap'; }
    else if (which === 'distanceY') { sk.distanceY(a, b, value); label = 'vertical gap'; }
    else if (which === 'distance') { sk.distance(a, b, value); label = 'distance'; }
    else throw new GraphError(`A two-point dimension is 'distance', 'distanceX' or 'distanceY', not '${which}'`);
  } else {
    throw new GraphError("A dimension needs an entity, two points, or one point with constraint 'fixed'");
  }

  const report = solveSketch(sk, { params });
  if (!report.converged && before.converged) {
    throw new GraphError(`That ${label} cannot hold: ${report.message}`);
  }

  return {
    sketch: sk.toJSON(),
    report,
    applied: label,
    // Saying it twice is not an error — the geometry is still right — but it is
    // worth saying out loud, because a redundant dimension looks like a
    // dimension that works right up until the one it duplicates is changed.
    redundant: report.redundant > 0,
  };
}

/** A dimension is a number, or the name of a param the cell actually declares. */
function dimensionValue(value, params) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const text = String(value ?? '').trim();
  if (text === '') throw new GraphError('A dimension needs a value');
  const n = Number(text);
  if (Number.isFinite(n)) return n;
  if (!/^[A-Za-z_$][\w$]*$/.test(text)) {
    throw new GraphError(`'${text}' is neither a number nor a parameter name`);
  }
  if (typeof params[text] !== 'number') {
    const known = Object.keys(params).filter((k) => typeof params[k] === 'number');
    throw new GraphError(
      `This cell has no numeric parameter '${text}'.` +
      (known.length ? ` It has: ${known.join(', ')}.` : ' It declares none.')
    );
  }
  return text;
}

/**
 * Remove one constraint by index.
 *
 * The way back out of a dimension that was a mistake, and the reason the draw
 * tools can afford to guess: anything they add can be taken off individually
 * rather than by undoing the geometry it came with.
 */
export function eraseConstraint(data, index, { params = {} } = {}) {
  const sk = new Sketch({ ...(data || {}), params });
  if (!Number.isInteger(index) || index < 0 || index >= sk.constraints.length) {
    throw new GraphError(`This sketch has no constraint ${index}`);
  }
  sk.constraints.splice(index, 1);
  const report = solveSketch(sk, { params });
  return { sketch: sk.toJSON(), report };
}

/**
 * Remove an entity, and with it the constraints that spoke about it.
 *
 * Points that nothing refers to any more go too, because a stray dot on the
 * canvas reads as geometry and counts as two degrees of freedom that no longer
 * mean anything. Fixed points are kept regardless: a datum is a statement about
 * the sketch, not a leftover of whatever was drawn on it.
 */
export function eraseEntity(data, index, { params = {} } = {}) {
  const sk = new Sketch({ ...(data || {}), params });
  if (!Number.isInteger(index) || index < 0 || index >= sk.entities.length) {
    throw new GraphError(`This sketch has no entity ${index}`);
  }

  sk.entities.splice(index, 1);
  const shiftEntity = (i) => (i > index ? i - 1 : i);
  sk.constraints = sk.constraints
    .filter((c) => c.e !== index && c.f !== index)
    .map((c) => ({
      ...c,
      ...(c.e !== undefined ? { e: shiftEntity(c.e) } : {}),
      ...(c.f !== undefined ? { f: shiftEntity(c.f) } : {}),
    }));

  const used = new Set();
  for (const e of sk.entities) for (const k of ['a', 'b', 'c']) {
    if (Number.isInteger(e[k])) used.add(e[k]);
  }
  for (const c of sk.constraints) for (const k of ['a', 'b', 'p']) {
    if (Number.isInteger(c[k])) used.add(c[k]);
  }
  sk.points.forEach((p, i) => { if (p.fixed) used.add(i); });

  const keep = sk.points.map((_, i) => i).filter((i) => used.has(i));
  const remap = new Map(keep.map((old, next) => [old, next]));
  sk.points = keep.map((i) => sk.points[i]);
  sk.entities = sk.entities.map((e) => ({
    ...e,
    ...(Number.isInteger(e.a) ? { a: remap.get(e.a) } : {}),
    ...(Number.isInteger(e.b) ? { b: remap.get(e.b) } : {}),
    ...(Number.isInteger(e.c) ? { c: remap.get(e.c) } : {}),
  }));
  sk.constraints = sk.constraints.map((c) => ({
    ...c,
    ...(Number.isInteger(c.a) ? { a: remap.get(c.a) } : {}),
    ...(Number.isInteger(c.b) ? { b: remap.get(c.b) } : {}),
    ...(Number.isInteger(c.p) ? { p: remap.get(c.p) } : {}),
  }));

  const report = solveSketch(sk, { params });
  return { sketch: sk.toJSON(), report };
}

// ------------------------------------------------------------------- inference

/** Resolve a clicked position to a point index, snapping if something is near. */
function resolve(sk, at, snap, soft, notes) {
  const [x, y] = coords(at, 'point');

  let best = -1;
  let bestD = snap;
  sk.points.forEach((p, i) => {
    const d = Math.hypot(p.x - x, p.y - y);
    if (d <= bestD) { bestD = d; best = i; }
  });
  if (best >= 0) {
    notes.push(`shares point ${best}`);
    return best;
  }

  const hit = nearestEntity(sk, x, y, snap);
  // Start the new point ON the entity rather than where the pointer was, so the
  // constraint it just acquired is already satisfied and the solver has nothing
  // to yank straight.
  const i = sk.point(hit ? hit.x : x, hit ? hit.y : y);
  if (hit) {
    soft.push({
      index: sk.pointOn(i, hit.entity),
      label: `on ${sk.entities[hit.entity].type} ${hit.entity}`,
    });
  }
  return i;
}

/** Read a line as horizontal or vertical when it was drawn close enough to one. */
function inferAxis(sk, e, soft, notes) {
  const a = sk.points[sk.entities[e].a];
  const b = sk.points[sk.entities[e].b];
  const dx = Math.abs(b.x - a.x);
  const dy = Math.abs(b.y - a.y);
  if (Math.hypot(dx, dy) < EPS) throw new GraphError('A line needs some length');
  const angle = Math.atan2(dy, dx); // 0 along X, π/2 along Y
  if (angle <= AXIS_TOL) soft.push({ index: sk.horizontal(e), label: 'horizontal' });
  else if (Math.PI / 2 - angle <= AXIS_TOL) soft.push({ index: sk.vertical(e), label: 'vertical' });
}

/**
 * The entity nearest a position, within `snap`, and where on it that lands.
 *
 * Lines measure to the SEGMENT, not to the infinite line the constraint will
 * later use: snapping to a line's invisible extension is a surprise, whereas
 * riding along the drawn part of it is what the person aimed at.
 */
export function nearestEntity(sk, x, y, snap) {
  let best = null;
  sk.entities.forEach((e, i) => {
    const hit = footOn(sk, e, x, y);
    if (!hit) return;
    const d = Math.hypot(hit.x - x, hit.y - y);
    if (d <= snap && (!best || d < best.d)) best = { entity: i, x: hit.x, y: hit.y, d };
  });
  return best;
}

function footOn(sk, e, x, y) {
  const P = (i) => sk.points[i];
  if (e.type === 'line') {
    const a = P(e.a);
    const b = P(e.b);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    if (len2 < EPS) return null;
    const t = Math.min(1, Math.max(0, ((x - a.x) * dx + (y - a.y) * dy) / len2));
    return { x: a.x + t * dx, y: a.y + t * dy };
  }
  if (e.type === 'circle' || e.type === 'arc') {
    const c = P(e.c);
    const r = e.type === 'circle'
      ? Math.abs(e.r)
      : Math.hypot(P(e.a).x - c.x, P(e.a).y - c.y);
    const d = Math.hypot(x - c.x, y - c.y);
    if (d < EPS || r < EPS) return null;
    const angle = Math.atan2(y - c.y, x - c.x);
    if (e.type === 'arc' && !withinSweep(sk, e, angle)) return null;
    return { x: c.x + ((x - c.x) / d) * r, y: c.y + ((y - c.y) / d) * r };
  }
  return null;
}

/** Whether an angle falls inside an arc's counter-clockwise sweep. */
function withinSweep(sk, e, angle) {
  const c = sk.points[e.c];
  const a0 = Math.atan2(sk.points[e.a].y - c.y, sk.points[e.a].x - c.x);
  const a1 = Math.atan2(sk.points[e.b].y - c.y, sk.points[e.b].x - c.x);
  const norm = (t) => ((t % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  return norm(angle - a0) <= norm(a1 - a0);
}

function radiusOf(sk, op, c) {
  if (op.radius !== undefined) {
    const r = Number(op.radius);
    if (!(r > EPS)) throw new GraphError('A circle needs a positive radius');
    return r;
  }
  const [x, y] = coords(op.through, 'circle through');
  const r = Math.hypot(x - sk.points[c].x, y - sk.points[c].y);
  if (!(r > EPS)) throw new GraphError('A circle needs a positive radius');
  return r;
}

function coords(at, what) {
  const pair = Array.isArray(at) ? at : [at?.x, at?.y];
  const [x, y] = pair.map(Number);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new GraphError(`${what}: expected a position like [x, y]`);
  }
  return [x, y];
}
