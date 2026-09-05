/**
 * Drawing into a sketch, under test.
 *
 * The thing being checked is not that a line appears — it is what the gesture
 * is understood to have MEANT: that a second line starting where the first
 * ended shares its endpoint rather than owning a duplicate, that a nearly
 * horizontal line becomes horizontal, that a guess which cannot hold is thrown
 * away instead of taking the geometry down with it, and that erasing leaves
 * nothing dangling behind it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { drawOn, eraseEntity, eraseConstraint, dimensionOn } from '../src/core/sketchdraw.js';
import { sketch, loopArea, Sketch } from '../src/core/sketch.js';
import { GraphError } from '../src/core/errors.js';

const near = (a, b, tol = 1e-6) =>
  assert.ok(Math.abs(a - b) < tol, `expected ${a} to be within ${tol} of ${b}`);

const empty = () => ({ plane: 'XY', points: [], entities: [], constraints: [] });

test('a drawn line becomes two points and a line', () => {
  const { sketch: s, report } = drawOn(empty(), {
    tool: 'line', from: [0, 0], to: [30, 21],
  });
  assert.equal(s.points.length, 2);
  assert.deepEqual(s.entities, [{ type: 'line', a: 0, b: 1 }]);
  assert.equal(s.constraints.length, 0, 'a diagonal line implies nothing');
  assert.ok(report.converged);
  assert.equal(report.dof, 4, 'four free coordinates, nothing pinned');
});

test('a nearly horizontal line is meant to be horizontal', () => {
  const { sketch: s, inferred } = drawOn(empty(), {
    tool: 'line', from: [0, 0], to: [40, 1.5], // 2.1°, inside the tolerance
  });
  assert.deepEqual(s.constraints, [{ type: 'horizontal', e: 0 }]);
  assert.ok(inferred.includes('horizontal'));
  near(s.points[1].y, s.points[0].y);
});

test('a line drawn well off an axis is left alone', () => {
  const { sketch: s } = drawOn(empty(), {
    tool: 'line', from: [0, 0], to: [40, 6], // 8.5°, outside it
  });
  assert.equal(s.constraints.length, 0);
  near(s.points[1].y, 6);
});

test('a second line starting at the first one\'s end shares the point', () => {
  const first = drawOn(empty(), { tool: 'line', from: [0, 0], to: [40, 0] }).sketch;
  const { sketch: s, inferred } = drawOn(
    first,
    { tool: 'line', from: [40.4, 0.3], to: [40, 30] },
    { snap: 1 }
  );
  assert.equal(s.points.length, 3, 'the shared corner is one point, not two');
  assert.equal(s.entities[1].a, 1, 'the new line starts on the old line\'s end');
  assert.ok(inferred.some((n) => n.includes('shares point 1')));
});

test('snapping is a distance, not a magnet — far clicks make new points', () => {
  const first = drawOn(empty(), { tool: 'line', from: [0, 0], to: [40, 0] }).sketch;
  const { sketch: s } = drawOn(
    first,
    { tool: 'line', from: [38, 2], to: [10, 30] },
    { snap: 1 }
  );
  assert.equal(s.points.length, 4);
});

test('a point dropped on a line rides it', () => {
  const first = drawOn(empty(), { tool: 'line', from: [0, 0], to: [40, 0] }).sketch;
  const { sketch: s, inferred } = drawOn(
    first,
    { tool: 'line', from: [20, 0.4], to: [20, 25] },
    { snap: 1 }
  );
  assert.ok(s.constraints.some((c) => c.type === 'pointOn' && c.e === 0));
  assert.ok(inferred.some((n) => n.includes('on line 0')));
  near(s.points[2].y, 0, 1e-6);
});

test('a click past the end of a line does not ride its extension', () => {
  const first = drawOn(empty(), { tool: 'line', from: [0, 0], to: [40, 0] }).sketch;
  const { sketch: s } = drawOn(
    first,
    { tool: 'line', from: [46, 0.2], to: [46, 25] },
    { snap: 1 }
  );
  assert.ok(!s.constraints.some((c) => c.type === 'pointOn'));
});

test('a rectangle is four lines that stay a rectangle', () => {
  const { sketch: s, report } = drawOn(empty(), {
    tool: 'rect', from: [0, 0], to: [60, 40],
  });
  assert.equal(s.points.length, 4);
  assert.equal(s.entities.length, 4);
  assert.equal(s.constraints.filter((c) => c.type === 'horizontal').length, 2);
  assert.equal(s.constraints.filter((c) => c.type === 'vertical').length, 2);
  assert.ok(report.converged);
  const loops = sketch(s).loops();
  assert.equal(loops.length, 1, 'and it closes');
});

test('a circle keeps its radius as a variable', () => {
  const { sketch: s } = drawOn(empty(), {
    tool: 'circle', center: [10, 10], through: [10, 17],
  });
  assert.equal(s.entities[0].type, 'circle');
  near(s.entities[0].r, 7);
  assert.equal(s.points.length, 1, 'the rim is not a point');
});

test('an arc pulls its second end onto the radius of the first', () => {
  const { sketch: s, report } = drawOn(empty(), {
    tool: 'arc', center: [0, 0], from: [10, 0], to: [0, 6], // 6 is not 10
  });
  assert.ok(report.converged);
  // Measured from the solved centre, not the origin: nothing here was pinned,
  // so the solver is free to move the centre as well as the ends.
  const c = s.points[0];
  const r0 = Math.hypot(s.points[1].x - c.x, s.points[1].y - c.y);
  const r1 = Math.hypot(s.points[2].x - c.x, s.points[2].y - c.y);
  near(r0, r1, 1e-6);
});

test('a guess that cannot hold is dropped, and the geometry survives', () => {
  // Two points held 50 apart on a diagonal. A line between them drawn close
  // enough to horizontal would ask them to be level as well, which they cannot
  // be — so the horizontal goes and the line stays.
  const s = sketch();
  const a = s.anchor(0, 0);
  const b = s.point(50, 1);
  s.distanceX(a, b, 50);
  s.distanceY(a, b, 1);

  const { sketch: out, dropped, report } = drawOn(s.toJSON(), {
    tool: 'line', from: [0, 0], to: [50, 1],
  }, { snap: 0.5 });

  assert.ok(report.converged, 'the sketch still solves');
  assert.equal(out.entities.length, 1, 'the line is there');
  assert.ok(dropped.includes('horizontal'), 'the guess is reported as dropped');
  assert.ok(!out.constraints.some((c) => c.type === 'horizontal'));
  near(out.points[1].y, 1);
});

test('a draw that breaks a working sketch refuses', () => {
  // Three pinned points, and an arc drawn onto all three. An arc holds its two
  // ends at one radius, and these are at 10 and 6 with nothing free to move —
  // the one failure a draw cannot talk its way out of, since it comes from the
  // entity's own definition rather than from a constraint that can be dropped.
  const s = sketch();
  s.anchor(0, 0);
  s.anchor(10, 0);
  s.anchor(0, 6);
  assert.throws(
    () => drawOn(
      s.toJSON(),
      { tool: 'arc', center: [0, 0], from: [10, 0], to: [0, 6] },
      { snap: 0.5 }
    ),
    (e) => e instanceof GraphError && /break the sketch/.test(e.message)
  );
});

test('degenerate gestures are mis-clicks, not geometry', () => {
  assert.throws(() => drawOn(empty(), { tool: 'line', from: [5, 5], to: [5, 5] }, { snap: 1 }), GraphError);
  assert.throws(() => drawOn(empty(), { tool: 'rect', from: [0, 0], to: [0, 40] }), GraphError);
  assert.throws(() => drawOn(empty(), { tool: 'circle', center: [0, 0], through: [0, 0] }), GraphError);
  assert.throws(() => drawOn(empty(), { tool: 'spline', from: [0, 0], to: [1, 1] }), GraphError);
});

test('erasing takes the constraints that spoke about it', () => {
  let s = drawOn(empty(), { tool: 'rect', from: [0, 0], to: [60, 40] }).sketch;
  s = drawOn(s, { tool: 'circle', center: [30, 20], through: [30, 28] }).sketch;
  assert.equal(s.entities.length, 5);

  const { sketch: out, report } = eraseEntity(s, 0); // the bottom line
  assert.equal(out.entities.length, 4);
  assert.equal(out.constraints.filter((c) => c.type === 'horizontal').length, 1);
  assert.ok(report.converged);

  // Every remaining reference still points at what it used to.
  const circle = out.entities.find((e) => e.type === 'circle');
  near(out.points[circle.c].x, 30);
  near(out.points[circle.c].y, 20);
  for (const c of out.constraints) {
    if (c.e !== undefined) assert.ok(out.entities[c.e], `constraint names entity ${c.e}`);
  }
});

test('erasing garbage-collects points, but never a datum', () => {
  const s = sketch();
  s.anchor(0, 0); // a datum nothing is drawn on
  const drawn = drawOn(s.toJSON(), { tool: 'line', from: [10, 10], to: [40, 10] }).sketch;
  assert.equal(drawn.points.length, 3);

  const { sketch: out } = eraseEntity(drawn, 0);
  assert.equal(out.entities.length, 0);
  assert.deepEqual(out.points, [{ x: 0, y: 0, fixed: true }]);
});

// ----------------------------------------------------------------- dimensions

test('dimensioning a line makes it that long', () => {
  const s = drawOn(empty(), { tool: 'line', from: [0, 0], to: [37, 0.4] }).sketch;
  const { sketch: out, report, applied } = dimensionOn(s, { entity: 0, value: 40 });
  assert.equal(applied, 'length');
  assert.ok(report.converged);
  const [a, b] = out.points;
  near(Math.hypot(b.x - a.x, b.y - a.y), 40);
});

test('a dimension may be a parameter name, and then it follows the slider', () => {
  const s = drawOn(empty(), { tool: 'line', from: [0, 0], to: [37, 0] }).sketch;
  const { sketch: out } = dimensionOn(s, { entity: 0, value: 'width' }, { params: { width: 40 } });
  assert.deepEqual(out.constraints.at(-1), { type: 'distance', e: 0, value: 'width' });

  // The same sketch, solved against a different value of that param, is a
  // different length — which is the entire reason to write a name.
  const wider = new Sketch({ ...out, params: { width: 65 } });
  wider.solve();
  near(Math.hypot(wider.points[1].x - wider.points[0].x, wider.points[1].y - wider.points[0].y), 65);
});

test('a dimension naming a parameter that does not exist says which do', () => {
  const s = drawOn(empty(), { tool: 'line', from: [0, 0], to: [37, 0] }).sketch;
  assert.throws(
    () => dimensionOn(s, { entity: 0, value: 'heigth' }, { params: { width: 40, depth: 20 } }),
    (e) => e instanceof GraphError && /no numeric parameter 'heigth'/.test(e.message) &&
      /width, depth/.test(e.message)
  );
  assert.throws(() => dimensionOn(s, { entity: 0, value: '' }), /needs a value/);
  assert.throws(() => dimensionOn(s, { entity: 0, value: '2 + 2' }), /neither a number nor/);
});

test('dimensioning a circle sets its radius', () => {
  const s = drawOn(empty(), { tool: 'circle', center: [0, 0], through: [7.3, 0] }).sketch;
  const { sketch: out, applied } = dimensionOn(s, { entity: 0, value: 6 });
  assert.equal(applied, 'radius');
  near(out.entities[0].r, 6);
});

test('a dimension between two points can be signed along an axis', () => {
  let s = drawOn(empty(), { tool: 'line', from: [0, 0], to: [30, 18] }).sketch;
  s = dimensionOn(s, { points: [0, 1], value: 40, axis: 'x' }).sketch;
  near(s.points[1].x - s.points[0].x, 40);
  s = dimensionOn(s, { points: [0, 1], value: 25, axis: 'y' }).sketch;
  near(s.points[1].y - s.points[0].y, 25);
  near(s.points[1].x - s.points[0].x, 40, 1e-6);
});

test('a dimension that cannot hold is refused, and names what it fights', () => {
  // A rectangle whose width is already 40 cannot also be 60.
  const s = drawOn(empty(), { tool: 'rect', from: [0, 0], to: [40, 25] }).sketch;
  const once = dimensionOn(s, { entity: 0, value: 40 });
  assert.throws(
    () => dimensionOn(once.sketch, { entity: 0, value: 60 }),
    (e) => e instanceof GraphError &&
      /cannot hold/.test(e.message) && /over-constrained/.test(e.message)
  );
  // And the sketch it refused on is untouched.
  assert.equal(once.sketch.constraints.length, 5);
});

test('saying the same thing twice is allowed, and reported', () => {
  let s = drawOn(empty(), { tool: 'rect', from: [0, 0], to: [40, 25] }).sketch;
  s = dimensionOn(s, { entity: 0, value: 40 }).sketch;
  const again = dimensionOn(s, { entity: 2, value: 40 }); // the opposite side
  assert.ok(again.report.converged, 'still solves');
  assert.ok(again.redundant, 'but it is noise, and says so');
});

test('a dimension comes back off on its own, without the geometry', () => {
  let s = drawOn(empty(), { tool: 'line', from: [0, 0], to: [37, 0] }).sketch;
  s = dimensionOn(s, { entity: 0, value: 40 }).sketch;
  const at = s.constraints.length - 1;
  const { sketch: out, report } = eraseConstraint(s, at);
  assert.equal(out.constraints.length, at);
  assert.equal(out.entities.length, 1, 'the line is still there');
  assert.ok(report.converged);
  assert.ok(report.dof > 0, 'and it is free again');

  assert.throws(() => eraseConstraint(out, 99), GraphError);
});

test('erasing an entity that is not there says so', () => {
  const s = drawOn(empty(), { tool: 'line', from: [0, 0], to: [10, 0] }).sketch;
  assert.throws(() => eraseEntity(s, 3), GraphError);
});

test('a drawn profile is a profile — it extrudes', () => {
  let s = drawOn(empty(), { tool: 'line', from: [0, 0], to: [40, 0.2] }, { snap: 1 }).sketch;
  s = drawOn(s, { tool: 'line', from: [40, 0], to: [40.1, 25] }, { snap: 1 }).sketch;
  s = drawOn(s, { tool: 'line', from: [40, 25], to: [0.2, 25] }, { snap: 1 }).sketch;
  s = drawOn(s, { tool: 'line', from: [0, 25], to: [0, 0] }, { snap: 1 }).sketch;

  assert.equal(s.points.length, 4, 'four clicks around a loop, four corners');
  const loops = sketch(s).loops();
  assert.equal(loops.length, 1);
  assert.equal(loops[0].segments.length, 4);
  assert.ok(Math.abs(loopArea(loops[0])) > 900, 'and it encloses roughly 40×25');
});

test('a dimension on a circle can be its diameter', () => {
  const sk = { plane: 'XY', points: [{ x: 0, y: 0, fixed: true }], entities: [{ type: 'circle', c: 0, r: 5 }], constraints: [] };
  const out = dimensionOn(sk, { entity: 0, kind: 'diameter', value: 12 });
  assert.equal(out.sketch.constraints.at(-1).type, 'diameter');
  assert.equal(out.sketch.constraints.at(-1).value, 12);
});

test('two-point dimensions take a constraint name, and a point can be pinned', () => {
  const sk = { plane: 'XY', points: [{ x: 0, y: 0 }, { x: 10, y: 3 }], entities: [{ type: 'line', a: 0, b: 1 }], constraints: [] };
  const out = dimensionOn(sk, { points: [0, 1], constraint: 'distanceX', value: 12 });
  assert.equal(out.sketch.constraints.at(-1).type, 'distanceX');
  assert.throws(() => dimensionOn(sk, { points: [0, 1], constraint: 'sideways', value: 1 }), /'distance', 'distanceX' or 'distanceY'/);
  const pinned = dimensionOn(sk, { points: [0], constraint: 'fixed' });
  assert.equal(pinned.sketch.points[0].fixed, true);
  const onXZ = drawOn({ plane: 'XY', points: [], entities: [], constraints: [] }, { tool: 'rectangle', from: [0, 0], to: [10, 5], plane: 'XZ' });
  assert.equal(onXZ.sketch.plane, 'XZ');
  assert.equal(onXZ.sketch.entities.length, 4);
});
