/**
 * Assertion cells under test.
 *
 * The claim being tested is not "assertions can throw" — any test file can do
 * that. It is that a claim written into the DOCUMENT keeps being checked: it
 * re-runs on a parameter change, it records the number it measured whether it
 * passed or failed, it fails the document rather than the stack, and a failing
 * document does not export.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { initBrep, beginBrepScope } from '../src/core/brep.js';
import { CellDocument, evaluateCells, dependencyGraph, CELL_KIND } from '../src/core/cells.js';
import * as checks from '../src/core/checks.js';
import * as ops from '../src/core/ops.js';
import { q } from '../src/core/query.js';

await initBrep();

function inScope(fn) {
  const scope = beginBrepScope();
  try {
    return fn();
  } finally {
    scope.dispose();
  }
}

const near = (a, b, tol) =>
  assert.ok(Math.abs(a - b) < tol, `expected ${a} to be within ${tol} of ${b}`);

// ------------------------------------------------------------- measurements

test('wall thickness measures a solid the way a wall is thick', () => {
  inScope(() => {
    near(checks.minWallThickness(ops.box(60, 40, 24)).value, 24, 1e-6);
    near(checks.minWallThickness(ops.box(60, 40, 3)).value, 3, 1e-6);
    // Curved: the tessellation's chords fall inside the true surface, so the
    // measurement is biased LOW — the safe direction for a minimum.
    const c = checks.minWallThickness(ops.cylinder(10, 30)).value;
    assert.ok(c > 19.9 && c <= 20 + 1e-9, `cylinder thickness ${c} should approach 20 from below`);
  });
});

test('wall thickness finds the wall a shell left behind', () => {
  inScope(() => {
    let s = ops.box(60, 40, 24);
    s = ops.shell(s, q.faces(s).planar().facing('+z'), 2);
    const t = checks.minWallThickness(s);
    near(t.value, 2, 1e-3);
    assert.equal(t.at.length, 3);
    assert.ok(t.samples > 0);
  });
});

test('clearance between two face sets is exact', () => {
  inScope(() => {
    const plate = ops.box(60, 40, 10);
    // Top to bottom of a 10mm plate.
    const c = checks.clearance(
      plate,
      q.faces(plate).planar().facing('+z'),
      q.faces(plate).planar().facing('-z')
    );
    near(c.value, 10, 1e-6);

    // A hole 8mm across in a 60mm plate: wall from bore to the +x face.
    const bored = ops.subtract(plate, ops.cylinder(4, 30));
    const d = checks.clearance(
      bored,
      q.faces(bored).cylindrical(),
      q.faces(bored).planar().facing('+x')
    );
    near(d.value, 26, 1e-6);
  });
});

test('watertightness is judged on the mesh that would ship', () => {
  inScope(() => {
    const w = checks.watertight(ops.box(30, 20, 10));
    assert.equal(w.ok, true);
    assert.equal(w.boundary, 0);
    assert.equal(w.nonManifold, 0);
    assert.equal(w.flipped, 0);
  });
});

// ---------------------------------------------------------------- the cells

const BODY = `
export const params = { w: 60, d: 40, h: 24, wall: 2 };
export default ({ p, brep, q }) => {
  const s = brep.box(p.w, p.d, p.h);
  return brep.shell(s, q.faces(s).planar().facing('+z').expect(1), p.wall);
};
`;

const WALL_CHECK = `
export const params = { minimum: 1.5 };
export default ({ p, assert, input }) => assert.minWall(input, p.minimum);
`;

function enclosure() {
  const doc = new CellDocument();
  doc.addCell({ id: 'body', prompt: 'hollow enclosure', code: BODY });
  doc.addCell({
    id: 'thickenough', prompt: 'nothing thinner than 1.5mm',
    kind: 'assert', code: WALL_CHECK,
  });
  return doc;
}

test('an assertion cell records the number it measured, not just a verdict', () => {
  const doc = enclosure();
  inScope(() => {
    const run = evaluateCells(doc, 'thickenough');
    assert.equal(run.assertionsPass, true);
    assert.equal(run.assertions.length, 1);
    const [c] = run.assertions;
    assert.equal(c.cell, 'thickenough');
    assert.equal(c.label, 'min wall');
    assert.equal(c.ok, true);
    near(c.value, 2, 1e-3);
    assert.equal(c.limit, 1.5);
    assert.equal(c.unit, 'mm');
  });
});

test('an assertion cell passes its input through unchanged', () => {
  const doc = enclosure();
  inScope(() => {
    const run = evaluateCells(doc, 'thickenough');
    // The document's geometry is the body, untouched by the check above it.
    near(ops.volume(run.value), ops.volume(run.results.get('body')), 1e-9);
  });
});

test('turning a parameter re-checks the claim', () => {
  const doc = enclosure();
  inScope(() => {
    assert.equal(evaluateCells(doc, 'thickenough').assertionsPass, true);
  });

  doc.updateCell('body', { params: { wall: 1 } });
  inScope(() => {
    const run = evaluateCells(doc, 'thickenough');
    assert.equal(run.assertionsPass, false);
    const [c] = run.assertions;
    assert.equal(c.ok, false);
    near(c.value, 1, 1e-3);
    // The measurement survives the failure — how far off matters.
    assert.equal(c.limit, 1.5);
  });
});

test('a failed assertion fails the document, not the stack', () => {
  const doc = enclosure();
  doc.updateCell('body', { params: { wall: 1 } });
  doc.addCell({
    id: 'after', prompt: 'chamfer the rim',
    code: 'export default ({ brep, input }) => brep.translate(input, [0, 0, 5]);',
  });

  inScope(() => {
    // stopOnError is on, and this still does not throw: the check reports, the
    // geometry keeps building, and the cell after the failed assertion runs.
    const run = evaluateCells(doc, 'after');
    assert.equal(run.assertionsPass, false);
    assert.ok(run.value, 'geometry after a failed assertion should still build');
    const entry = run.report.find((c) => c.id === 'thickenough');
    assert.equal(entry.status, 'failed');
    assert.match(entry.error, /Thinnest wall is 1\.0/);
    assert.equal(run.report.find((c) => c.id === 'after').status, 'ok');
  });
});

test('a modelling cell can state its own intent and it counts the same', () => {
  const doc = new CellDocument();
  doc.addCell({
    id: 'body',
    prompt: 'a box that must fit the enclosure',
    code: `
export const params = { w: 60 };
export default ({ p, brep, assert }) => {
  const s = brep.box(p.w, 40, 24);
  assert.fitsIn(s, [50, 50, 50]);
  return s;
};
`,
  });
  inScope(() => {
    const run = evaluateCells(doc, 'body', { stopOnError: false });
    assert.equal(run.assertionsPass, false);
    assert.equal(run.assertions[0].cell, 'body');
    assert.equal(run.assertions[0].label, 'fits in');
    // A modelling cell that asserts still FAILS on the spot — the difference is
    // only where the claim is written, not how seriously it is taken.
    assert.equal(run.report[0].status, 'error');
  });
});

test('an assertion cell is a kind, and it round-trips', () => {
  const doc = enclosure();
  assert.equal(doc.get('thickenough').kind, CELL_KIND.assert);
  assert.equal(doc.get('body').kind, CELL_KIND.model);
  const revived = JSON.parse(JSON.stringify(doc.toJSON()));
  assert.equal(revived.cells[1].kind, 'assert');
  assert.throws(() => doc.addCell({ id: 'nope', kind: 'wishful' }), /must be one of/);
});

test('several claims in one cell all report', () => {
  const doc = new CellDocument();
  doc.addCell({ id: 'body', prompt: 'plate', code: 'export default ({ brep }) => brep.box(60, 40, 5);' });
  doc.addCell({
    id: 'checks', prompt: 'watertight, under 20cc, at least 3mm thick', kind: 'assert',
    code: `
export default ({ assert, input }) => {
  assert.watertight(input);
  assert.volumeUnder(input, 20000);
  assert.minWall(input, 3);
};
`,
  });
  inScope(() => {
    const run = evaluateCells(doc, 'checks');
    assert.equal(run.assertionsPass, true);
    assert.deepEqual(run.assertions.map((c) => c.label), ['watertight', 'volume under', 'min wall']);
  });
});

test('a claim that fails stops the ones after it in the same cell', () => {
  const doc = new CellDocument();
  doc.addCell({ id: 'body', prompt: 'plate', code: 'export default ({ brep }) => brep.box(60, 40, 5);' });
  doc.addCell({
    id: 'checks', prompt: 'too thick, then something else', kind: 'assert',
    code: `
export default ({ assert, input }) => {
  assert.minWall(input, 8);
  assert.volumeUnder(input, 1);
};
`,
  });
  inScope(() => {
    const run = evaluateCells(doc, 'checks');
    assert.equal(run.assertionsPass, false);
    // One record, not two: the cell stopped at the first failure. That is the
    // cost of writing checks as ordinary statements, and it is worth naming —
    // put independent claims in separate cells if you want all of them.
    assert.equal(run.assertions.length, 1);
    assert.equal(run.assertions[0].ok, false);
  });
});

test('an assertion nothing consumes still runs', () => {
  const doc = new CellDocument();
  doc.addCell({ id: 'body', prompt: 'thin plate', code: 'export default ({ brep }) => brep.box(60, 40, 1);' });
  // A side branch: it refs 'body' and nothing refs it back. Under the ordinary
  // rule — skip what the target does not consume — this would never run, and a
  // check nobody runs is worse than no check at all.
  doc.addCell({
    id: 'thick', prompt: 'at least 5mm everywhere', kind: 'assert', refs: ['body'],
    code: 'export default ({ assert, inputs }) => assert.minWall(inputs.body, 5);',
  });
  doc.addCell({ id: 'lift', prompt: 'raise it', refs: ['body'], code: 'export default ({ brep, input }) => brep.translate(input, [0, 0, 10]);' });

  inScope(() => {
    const run = evaluateCells(doc, 'lift');
    assert.equal(run.assertionsPass, false, 'the side-branch assertion should have run');
    assert.equal(run.assertions[0].cell, 'thick');
  });
});

test('an assertion cell is transparent to the running "that"', () => {
  const doc = new CellDocument();
  doc.addCell({ id: 'first', prompt: 'small', code: 'export default ({ brep }) => brep.box(10, 10, 10);' });
  doc.addCell({ id: 'second', prompt: 'big', code: 'export default ({ brep }) => brep.box(40, 40, 40);' });
  // Asserts about 'first' while sitting after 'second'. The cell below it must
  // still see 'second' — a check that redirected the stack would not be a check.
  doc.addCell({
    id: 'check', prompt: 'the small one is watertight', kind: 'assert', refs: ['first'],
    code: 'export default ({ assert, inputs }) => assert.watertight(inputs.first);',
  });
  doc.addCell({ id: 'after', prompt: 'lift whatever came before', code: 'export default ({ brep, input }) => brep.translate(input, [0, 0, 1]);' });

  inScope(() => {
    const run = evaluateCells(doc, 'after');
    assert.equal(run.assertionsPass, true);
    near(ops.volume(run.value), 40 * 40 * 40, 1e-6);
  });
});

test('the dependency graph is derived, and knows checks are not links', () => {
  const doc = new CellDocument();
  doc.addCell({ id: 'body', prompt: 'box', code: 'export default ({ brep }) => brep.box(10, 10, 10);' });
  doc.addCell({
    id: 'check', prompt: 'watertight', kind: 'assert',
    code: 'export default ({ assert, input }) => assert.watertight(input);',
  });
  doc.addCell({ id: 'lift', prompt: 'raise it', code: 'export default ({ brep, input }) => brep.translate(input, [0, 0, 5]);' });
  doc.addCell({ id: 'spare', prompt: 'an abandoned experiment', refs: ['body'], code: 'export default ({ brep, input }) => brep.scale(input, 2);' });

  const g = dependencyGraph(doc, 'lift');
  const lane = Object.fromEntries(g.nodes.map((n) => [n.id, n.lane]));
  const trunk = g.nodes.filter((n) => n.onTrunk).map((n) => n.id);

  // 'lift' takes its input from 'body': the check between them is not a link.
  assert.deepEqual(g.nodes.find((n) => n.id === 'lift').deps, ['body']);
  assert.deepEqual(trunk, ['body', 'lift']);
  assert.equal(lane.body, 0);
  assert.equal(lane.lift, 0);
  // The check and the abandoned branch each get a lane of their own.
  assert.ok(lane.check > 0, 'an assertion cell hangs off the trunk');
  assert.ok(lane.spare > 0 && lane.spare !== lane.check, 'a side branch gets its own lane');
  assert.ok(g.edges.some((e) => e.from === 'body' && e.to === 'check'));
  assert.equal(g.nodes.find((n) => n.id === 'lift').isOutput, true);
});

test('a check written below the last modelling cell still runs', () => {
  const doc = new CellDocument();
  doc.addCell({ id: 'body', prompt: 'thin plate', code: 'export default ({ brep }) => brep.box(60, 40, 1);' });
  // The natural place to write a check: at the bottom, past everything that
  // builds. The output resolves to 'body', so bounding assertion inclusion on
  // the check's own position would skip exactly this case.
  doc.addCell({
    id: 'thick', prompt: 'at least 5mm', kind: 'assert',
    code: 'export default ({ assert, input }) => assert.minWall(input, 5);',
  });

  assert.equal(doc.terminal, 'body', 'the output is the last cell that builds something');
  inScope(() => {
    const run = evaluateCells(doc, doc.terminal);
    assert.equal(run.assertionsPass, false);
    assert.equal(run.assertions[0].cell, 'thick');
    assert.ok(run.value, 'and the geometry is still the body');
  });
});

test('an assertion cell that cannot run its claim does not count as passing', () => {
  const doc = new CellDocument();
  doc.addCell({ id: 'box', code: 'export default ({ brep }) => brep.box(10, 10, 10);' });
  doc.addCell({ id: 'claim', kind: 'assert', code: 'export default ({ assert, inputs }) => assert.minWall(inputs.nothing, 1);' });
  const run = inScope(() => evaluateCells(doc, doc.terminal, { stopOnError: false }));
  const claim = run.report.find((e) => e.id === 'claim');
  assert.equal(claim.status, 'failed');
  assert.equal(run.assertionsPass, false);
});
