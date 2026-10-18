/**
 * The cell model under test.
 *
 * Three properties matter more than the rest, and each has a test that fails
 * loudly if it stops holding:
 *
 *  - the prompt is source and the code is a lockfile — editing a prompt must
 *    not change geometry;
 *  - a parameter change re-runs the committed program and nothing else;
 *  - a cell program cannot reach the filesystem, the network, or the clock.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { initBrep, beginBrepScope } from '../src/core/brep.js';
import {
  CellDocument, CELL_STATUS, evaluateCells, evaluationOrder, dependenciesOf,
} from '../src/core/cells.js';
import { compileCell, transformCellSource } from '../src/core/sandbox.js';
import { checkCellResult, brep as apiBrep } from '../src/core/cellapi.js';
import { q, enumerate, anchorFor, topology } from '../src/core/query.js';
import * as ops from '../src/core/ops.js';
import { GraphError } from '../src/core/errors.js';

await initBrep();

function inScope(fn) {
  const scope = beginBrepScope();
  try {
    return fn();
  } finally {
    scope.dispose();
  }
}

const BOX_CODE = `
export const params = { w: 60, d: 40, h: 24 };
export default ({ p, brep }) => brep.box(p.w, p.d, p.h);
`;

const FILLET_CODE = `
export const params = { r: 3 };
export default ({ p, brep, q, input }) =>
  brep.fillet(input, q.edges(input).linear().along('z').expect(4), p.r);
`;

/** A document with the design doc's own example: box, then fillet its verticals. */
function enclosure() {
  const doc = new CellDocument();
  doc.addCell({ id: 'body', prompt: '60×40×24 enclosure', code: BOX_CODE });
  doc.addCell({ id: 'round', prompt: '3mm fillet on the vertical edges', code: FILLET_CODE });
  return doc;
}

// ------------------------------------------------------------------- sandbox

test('the module form the document stores is the form the author writes', () => {
  const out = transformCellSource(BOX_CODE);
  assert.ok(!/^\s*export/m.test(out), 'no export statement survives the rewrite');
  const compiled = compileCell(BOX_CODE, { id: 'body' });
  assert.deepEqual(compiled.params, { w: 60, d: 40, h: 24 });
});

test('a cell may still read its own params binding after the rewrite', () => {
  const compiled = compileCell(`
    export const params = { n: 7 };
    export default () => params.n;
  `, { id: 'x' });
  assert.equal(compiled.run({}), 7);
});

test('exports other than params and default are refused, not mangled', () => {
  assert.throws(
    () => transformCellSource('export function helper() {}\nexport default () => 1;'),
    GraphError
  );
  assert.throws(() => transformCellSource('export const params = {};'), /export default/);
});

test('a cell program cannot reach the host', () => {
  for (const global of ['process', 'require', 'fetch', 'setTimeout', 'Buffer']) {
    const compiled = compileCell(
      `export default () => typeof ${global};`,
      { id: 'probe' }
    );
    assert.equal(compiled.run({}), 'undefined', `${global} must not exist in a cell`);
  }
});

test('a runaway cell is stopped rather than hanging the server', () => {
  const compiled = compileCell('export default () => { while (true) {} };', {
    id: 'spin',
    timeoutMs: 200,
  });
  assert.throws(() => compiled.run({}), /ran longer than 200ms/);
});

test('console output is captured per run, not accumulated across runs', () => {
  const compiled = compileCell(`
    export default ({ p }) => { console.log('w is', p.w); return 1; };
  `, { id: 'chatty' });
  compiled.run({ p: { w: 60 } });
  assert.deepEqual(compiled.logs, [{ level: 'log', text: 'w is 60' }]);
  compiled.run({ p: { w: 80 } });
  assert.deepEqual(compiled.logs, [{ level: 'log', text: 'w is 80' }]);
});

test('params are restricted to values a slider can round-trip', () => {
  assert.throws(
    () => compileCell('export const params = { f: () => 1 };\nexport default () => 1;', { id: 'x' }),
    /must be a number, string, or boolean/
  );
});

// -------------------------------------------------------------- cell document

test('a cell with no refs eats the previous cell', () => {
  const doc = enclosure();
  assert.deepEqual(dependenciesOf(doc, 1), ['body']);
  assert.deepEqual(evaluationOrder(doc, 'round').map((c) => c.id), ['body', 'round']);
});

test('refs may only point backwards', () => {
  const doc = enclosure();
  assert.throws(() => doc.updateCell('body', { refs: ['round'] }), /comes later in the stack/);
  assert.throws(() => doc.updateCell('body', { refs: ['body'] }), /cannot reference itself/);
  assert.throws(() => doc.addCell({ id: 'x', code: BOX_CODE, refs: ['nope'] }), /unknown cell/);
});

test('a program that does not compile never enters the document', () => {
  const doc = new CellDocument();
  assert.throws(() => doc.addCell({ id: 'bad', code: 'export default (' }), /failed to compile/);
  assert.equal(doc.cells.length, 0);
});

test('declared params seed the cell and unknown params are refused', () => {
  const doc = enclosure();
  assert.deepEqual(doc.get('body').params, { w: 60, d: 40, h: 24 });
  doc.updateCell('body', { params: { w: 80 } });
  assert.equal(doc.get('body').params.w, 80);
  assert.throws(() => doc.updateCell('body', { params: { nope: 1 } }), /has no parameter 'nope'/);
});

test('editing a prompt makes the cell stale and leaves the code alone', () => {
  const doc = enclosure();
  const before = doc.get('body').code;
  doc.updateCell('body', { prompt: 'make it 80 wide' });
  const cell = doc.get('body');
  assert.equal(cell.status, CELL_STATUS.stale);
  assert.equal(cell.code, before, 'the lockfile does not move on a prompt edit');
  assert.equal(inScope(() => Math.round(ops.bbox(evaluateCells(doc, 'body').value).size[0])), 60);
});

test('a hand edit diverges; only a commit returns to ok', () => {
  const doc = enclosure();
  doc.updateCell('body', { code: BOX_CODE.replace('60', '61') });
  assert.equal(doc.get('body').status, CELL_STATUS.diverged);
  doc.commitCompile('body', {
    prompt: '61×40×24 enclosure',
    code: BOX_CODE.replace('60', '61'),
    compiledBy: 'claude-opus-5',
  });
  const cell = doc.get('body');
  assert.equal(cell.status, CELL_STATUS.ok);
  assert.equal(cell.compiledBy, 'claude-opus-5');
  assert.ok(cell.compiledAt);
});

test('a commit keeps dialled-in values but drops params the program removed', () => {
  const doc = enclosure();
  doc.updateCell('body', { params: { w: 80 } });
  doc.commitCompile('body', {
    code: 'export const params = { w: 60, d: 40 };\nexport default ({ p, brep }) => brep.box(p.w, p.d, 10);',
    params: { w: 80 },
  });
  assert.deepEqual(doc.get('body').params, { w: 80, d: 40 });
});

/** Build a pick the way the server does: enumerate, take one, anchor it. */
function pick(doc, sourceId, type, choose) {
  return inScope(() => {
    const shape = evaluateCells(doc, sourceId).value;
    const list = enumerate(shape, type);
    const hit = list[choose(list.map((e) => e.d))];
    return { query: `${type}s.picked`, anchor: anchorFor(hit.d, list) };
  });
}

test('a declared selection parks the cell until the user picks', () => {
  const doc = enclosure();
  doc.updateCell('round', { selections: { lip: 'edge' } });
  assert.equal(doc.get('round').status, CELL_STATUS.awaitingPick);
  assert.throws(() => evaluateCells(doc, 'round'), /waiting for a pick: lip \(edge\)/);

  doc.resolveSelection('round', 'lip', pick(doc, 'body', 'edge',
    (ds) => ds.findIndex((d) => d.kind === 'LINE')));
  assert.equal(doc.get('round').status, CELL_STATUS.ok);
});

test('a pick must be the type the cell asked for', () => {
  const doc = enclosure();
  doc.updateCell('round', { selections: { lip: 'edge' } });
  assert.throws(
    () => doc.resolveSelection('round', 'lip', pick(doc, 'body', 'face', () => 0)),
    /wants a edge, but the pick was a face/
  );
});

test('a pick becomes an ordinary query the program can use', () => {
  const doc = new CellDocument();
  doc.addCell({ id: 'body', code: BOX_CODE });
  doc.addCell({
    id: 'spot',
    prompt: 'chamfer that one edge',
    selections: { lip: 'edge' },
    code: `export const params = { c: 2 };
      export default ({ p, brep, sel, input }) => brep.chamfer(input, sel.lip, p.c);`,
  });
  // The top edge running along X at +y.
  doc.resolveSelection('spot', 'lip', pick(doc, 'body', 'edge', (ds) =>
    ds.findIndex((d) => d.kind === 'LINE' && d.center[2] > 23 && d.center[1] > 19)));

  inScope(() => {
    const before = ops.volume(evaluateCells(doc, 'body').value);
    const after = ops.volume(evaluateCells(doc, 'spot').value);
    assert.ok(after < before, 'the chamfer removed material');
    // Exactly one edge was chamfered: a box gains one face per chamfered edge.
    assert.equal(topology(evaluateCells(doc, 'spot').value).counts.faces, 7);
  });
});

test('a pick survives the parameter change that would break an index', () => {
  const doc = new CellDocument();
  doc.addCell({ id: 'body', code: BOX_CODE });
  doc.addCell({
    id: 'spot',
    selections: { lip: 'edge' },
    code: `export default ({ brep, sel, input }) => brep.chamfer(input, sel.lip, 2);`,
  });
  const target = (ds) =>
    ds.findIndex((d) => d.kind === 'LINE' && d.center[2] > 23 && d.center[1] > 19);
  doc.resolveSelection('spot', 'lip', pick(doc, 'body', 'edge', target));

  const picked = () => inScope(() => {
    const shape = evaluateCells(doc, 'body').value;
    const list = enumerate(shape, 'edge');
    const spec = doc.get('spot').selections.lip;
    const found = q.edges(shape).ofKind(spec.anchor.kind).nearestTo(spec.anchor).one();
    return { center: found.center, index: found.i, count: list.length };
  });

  const at60 = picked();
  doc.updateCell('body', { params: { w: 80, h: 40 } });
  const at80 = picked();

  // Same edge — the top +y edge — even though it moved and the box is a
  // different shape. This is the property an index cannot have.
  assert.ok(at80.center[2] > 39 && at80.center[1] > 19, `moved to ${at80.center}`);
  assert.notDeepEqual(at60.center, at80.center, 'the edge really did move');
  inScope(() => {
    assert.equal(topology(evaluateCells(doc, 'spot').value).counts.faces, 7);
  });
});

/**
 * The property the whole anchor mechanism exists for, on a shape that is not a
 * bare primitive: hold a pick on the top rim of a filleted, shelled box while
 * the box is reshaped underneath it.
 *
 * This is the test that caught the two real bugs in the matcher — unit space
 * being measured against the kind-filtered subset instead of the whole
 * enumeration, and honest parametric growth being scored as drift — so it is
 * worth keeping pointed at the awkward cases rather than the easy one.
 */
test('a pick holds through reshaping, and says so when it cannot', () => {
  const doc = new CellDocument();
  doc.addCell({
    id: 'body',
    code: `export const params = { w: 80, d: 40, h: 24, r: 3, wall: 2 };
      export default ({ p, brep, q }) => {
        let s = brep.box(p.w, p.d, p.h);
        s = brep.fillet(s, q.edges(s).linear().along('z').expect(4), p.r);
        return brep.shell(s, q.faces(s).planar().facing('+z').expect(1), p.wall);
      };`,
  });
  doc.addCell({
    id: 'nick',
    selections: { lip: 'edge' },
    code: 'export default ({ brep, sel, input }) => brep.chamfer(input, sel.lip, 0.5);',
  });
  // The outer top rim — the long straight run at +y, at the top.
  doc.resolveSelection('nick', 'lip', pick(doc, 'body', 'edge', (ds) => {
    let best = -1;
    ds.forEach((d, i) => {
      if (d.kind !== 'LINE') return;
      if (best < 0 || d.center[2] > ds[best].center[2] ||
          (d.center[2] === ds[best].center[2] && d.center[1] > ds[best].center[1])) best = i;
    });
    return best;
  }));

  const holds = (params) => {
    doc.updateCell('body', { params });
    return inScope(() => {
      const { report } = evaluateCells(doc, 'nick', { stopOnError: false });
      return report.find((r) => r.id === 'nick').status === 'ok';
    });
  };

  // Reshaped hard in every direction, including aspect-ratio inversions.
  for (const params of [
    { w: 80, d: 40, h: 24 }, { w: 120, d: 40, h: 40 }, { w: 45, d: 40, h: 60 },
    { w: 200, d: 40, h: 15 }, { w: 80, d: 90, h: 24 }, { w: 30, d: 30, h: 30 },
    { w: 60, d: 25, h: 100 }, { w: 500, d: 20, h: 20 }, { w: 80, d: 40, h: 200 },
  ]) {
    assert.ok(holds(params), `pick lost at ${JSON.stringify(params)}`);
  }

  // And the honest limit: a 2mm wall on a 300mm box puts the inner and outer
  // rim 0.7% of the part apart, which is below what the anchor can resolve. It
  // asks rather than guesses.
  assert.equal(holds({ w: 300, d: 300, h: 300 }), false, 'a 0.7% separation should refuse');
});

/**
 * An anchor may only record a heading it can vouch for.
 *
 * `describeFace` reports `normal` for every face, but on anything curved it is
 * one sample taken at the parametric centre, and it says so. Matching has to
 * hold that line even though `.facing()` does not yet, because a boolean
 * that re-trims a cylindrical face moves that centre and changes the sample
 * across two rebuilds that are otherwise identical. Bounded noise is tolerable;
 * NON-DETERMINISTIC evidence is not, since it can rank two adjacent fillet
 * faces one way on some rebuilds and the other way on others.
 */
test('an anchor only records a heading where the heading means something', () => {
  const doc = new CellDocument();
  doc.addCell({
    id: 'body',
    code: `export const params = { w: 60, d: 40, h: 20, bore: 8 };
      export default ({ p, brep, q }) => {
        const s = brep.box(p.w, p.d, p.h);
        const hole = brep.translate(brep.cylinder(p.bore / 2, p.h * 2), [0, 0, -p.h]);
        return brep.subtract(s, hole);
      };`,
  });

  inScope(() => {
    const shape = evaluateCells(doc, 'body').value;
    const list = enumerate(shape, 'face');
    const bore = list.find((e) => e.d.kind === 'CYLINDER');
    const top = list.find((e) => e.d.kind === 'PLANE');
    assert.ok(bore && top, 'the part has both a bore and a planar face');

    assert.ok(bore.d.normal, 'the descriptor still REPORTS the sampled normal');
    assert.equal(
      anchorFor(bore.d, list).heading, null,
      'but the anchor refuses to match on it'
    );
    assert.ok(anchorFor(top.d, list).heading, 'a plane\'s normal is still evidence');
  });
});

test('a pick that no longer means anything asks for a re-pick', () => {
  const doc = new CellDocument();
  doc.addCell({ id: 'body', code: BOX_CODE });
  doc.addCell({
    id: 'spot',
    selections: { lip: 'edge' },
    code: `export default ({ brep, sel, input }) => brep.chamfer(input, sel.lip, 1);`,
  });
  doc.resolveSelection('spot', 'lip', pick(doc, 'body', 'edge',
    (ds) => ds.findIndex((d) => d.kind === 'LINE')));

  // Replace the box with a sphere: nothing linear survives, so the pick is lost.
  doc.updateCell('body', { code: 'export default ({ brep }) => brep.sphere(30);' });
  inScope(() => {
    const { report } = evaluateCells(doc, 'spot', { stopOnError: false });
    const spot = report.find((r) => r.id === 'spot');
    assert.equal(spot.status, 'awaiting_pick', 'a lost pick is a question, not a bug');
    assert.match(spot.error, /needs to be made again/);
  });
});

/**
 * Two identical features sitting closer together than the anchor can resolve.
 *
 * This is where re-matching genuinely cannot be trusted, and the refusal is the
 * point: if the array's pitch had shifted by one hole, the "obvious" nearest
 * match would be the WRONG hole, and a confident answer there is silently wrong
 * geometry. Refusing costs a re-pick; choosing costs a wrong part.
 */
test('an ambiguous pick refuses rather than choosing', () => {
  const doc = new CellDocument();
  doc.addCell({
    id: 'body',
    code: `export const params = { t: 10 };
      export default ({ p, brep }) => {
        const plate = brep.box(100, 20, p.t, { center: 'xy' });
        const a = brep.translate(brep.cylinder(0.4, p.t * 3), [-0.5, 0, -p.t]);
        const b = brep.translate(brep.cylinder(0.4, p.t * 3), [0.5, 0, -p.t]);
        return brep.subtract(plate, a, b);
      };`,
  });
  doc.addCell({
    id: 'spot',
    selections: { rim: 'edge' },
    code: `export default ({ brep, sel, input }) => brep.chamfer(input, sel.rim, 0.1);`,
  });
  // Pick the top rim of the left-hand hole.
  doc.resolveSelection('spot', 'rim', pick(doc, 'body', 'edge', (ds) =>
    ds.findIndex((d) => d.kind === 'CIRCLE' && d.center[0] < 0 && d.center[2] > 9)));

  // Changing the thickness moves every centre, so the exact hash no longer
  // hits and the two holes have to be told apart on position alone. They are
  // 1mm apart on a 100mm plate — far inside the gap the matcher trusts.
  doc.updateCell('body', { params: { t: 14 } });
  inScope(() => {
    const { report } = evaluateCells(doc, 'spot', { stopOnError: false });
    const spot = report.find((r) => r.id === 'spot');
    assert.equal(spot.status, 'awaiting_pick');
    assert.match(spot.error, /ambiguous/);
  });
});

test('deleting or reordering may not break a reference', () => {
  const doc = enclosure();
  doc.updateCell('round', { refs: ['body'] });
  assert.throws(() => doc.deleteCell('body'), /cell\(s\) round reference it/);
  assert.throws(() => doc.moveCell('body', 1), /before the cell it references/);
  doc.deleteCell('round');
  doc.deleteCell('body');
  assert.equal(doc.cells.length, 0);
});

test('undo restores the whole stack', () => {
  const doc = enclosure();
  doc.updateCell('body', { params: { w: 80 } });
  doc.deleteCell('round');
  assert.equal(doc.cells.length, 1);
  doc.undo();
  assert.equal(doc.cells.length, 2);
  doc.undo();
  assert.equal(doc.get('body').params.w, 60);
  doc.redo();
  assert.equal(doc.get('body').params.w, 80);
});

// ---------------------------------------------------------------- evaluation

test('a cell stack builds the part its prompts describe', () => {
  const doc = enclosure();
  doc.addCell({
    id: 'hollow',
    prompt: '2mm wall, open at the top',
    code: `
      export const params = { wall: 2 };
      export default ({ p, brep, q, input }) =>
        brep.shell(input, q.faces(input).planar().facing('+z').expect(1), p.wall);
    `,
  });
  inScope(() => {
    const { value, report } = evaluateCells(doc);
    assert.equal(report.length, 3);
    assert.ok(report.every((r) => r.status === 'ok'));
    const { size } = ops.bbox(value);
    assert.deepEqual(size.map(Math.round), [60, 40, 24]);
    // Filleted and hollow: well under the solid box it started as.
    assert.ok(ops.volume(value) < 60 * 40 * 24 * 0.4);
  });
});

test('turning a knob re-runs the program without re-prompting', () => {
  const doc = enclosure();
  const widthOf = () => inScope(() => ops.bbox(evaluateCells(doc).value).size[0]);
  assert.equal(Math.round(widthOf()), 60);
  doc.updateCell('body', { params: { w: 80 } });
  assert.equal(doc.get('body').status, CELL_STATUS.ok, 'a knob is not a change of intent');
  assert.equal(Math.round(widthOf()), 80);
  // The query in the fillet cell still means the same four edges at the new size.
  assert.equal(doc.get('round').code.includes("along('z')"), true);
});

test('a query that stops matching fails the cell instead of quietly changing the part', () => {
  const doc = new CellDocument();
  doc.addCell({ id: 'body', code: BOX_CODE });
  doc.addCell({
    id: 'wrong',
    code: `export default ({ brep, q, input }) =>
      brep.fillet(input, q.edges(input).circular().expect(4), 1);`,
  });
  inScope(() => {
    assert.throws(() => evaluateCells(doc), /matched 0 edges, expected 4/);
  });
});

test('an error names the cell it came from', () => {
  const doc = new CellDocument();
  doc.addCell({ id: 'boom', code: 'export default () => { throw new Error("nope"); };' });
  assert.throws(() => evaluateCells(doc), /Cell 'boom' threw: nope/);
});

test('a cell that returns nothing is an error, not a silent no-op', () => {
  const doc = enclosure();
  doc.addCell({ id: 'forgetful', code: 'export default ({ input }) => { input; };' });
  inScope(() => {
    assert.throws(() => evaluateCells(doc), /returned nothing/);
  });
  assert.throws(() => checkCellResult(q.faces(null), 'x'), /returned a query/);
});

test('an abandoned branch is not paid for on every evaluation', () => {
  const doc = enclosure();
  doc.addCell({ id: 'experiment', code: BOX_CODE, refs: ['body'] });
  doc.addCell({ id: 'final', code: FILLET_CODE, refs: ['round'] });
  assert.deepEqual(
    evaluationOrder(doc, 'final').map((c) => c.id),
    ['body', 'round', 'final'],
    'the experiment cell is skipped'
  );
});

test('stopOnError reports every broken cell in one pass', () => {
  const doc = new CellDocument();
  doc.addCell({ id: 'body', code: BOX_CODE });
  doc.addCell({ id: 'boom', code: 'export default () => { throw new Error("nope"); };' });
  inScope(() => {
    const { report } = evaluateCells(doc, 'boom', { stopOnError: false });
    assert.deepEqual(report.map((r) => r.status), ['ok', 'error']);
    assert.match(report[1].error, /nope/);
  });
});

test('the API handed to cells is frozen against cross-cell tampering', () => {
  assert.throws(() => { apiBrep.box = null; }, TypeError);
  const doc = new CellDocument();
  doc.addCell({
    id: 'meddle',
    code: `export default ({ brep, p }) => { try { brep.box = 1; } catch {} return brep.box(1, 1, 1); };`,
  });
  inScope(() => {
    assert.ok(evaluateCells(doc).value);
    assert.equal(typeof apiBrep.box, 'function');
  });
});

test('a cell can assert its own intent', () => {
  const doc = new CellDocument();
  doc.addCell({
    id: 'checked',
    code: `
      export const params = { s: 50 };
      export default ({ p, brep, assert }) => {
        const s = brep.box(p.s, p.s, p.s);
        assert.fitsIn(s, [40, 40, 40]);
        return s;
      };
    `,
  });
  inScope(() => {
    assert.throws(() => evaluateCells(doc), /exceeds 40 × 40 × 40 on X/);
  });
});
