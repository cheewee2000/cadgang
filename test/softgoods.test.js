import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { initBrep, beginBrepScope, tessellate } from '../src/core/brep.js';
import * as ops from '../src/core/ops.js';
import { softNamespace, fabric } from '../src/core/softgoods.js';

before(async () => { await initBrep(); });

const rect = (w, h) => [[0, 0], [w, 0], [w, h], [0, h]];
const row = (checked, label) => checked.find((c) => c.label === label);

test('a strap pinned at both ends sags onto a bar: one trimmed face, resting on the bar, pattern in the flats', () => {
  const scope = beginBrepScope();
  try {
    const checked = [], flats = [], soft = softNamespace(checked, flats);
    const bar = ops.translate(ops.rotate(ops.cylinder(30, 400, { center: 'xyz' }), 90, [0, 1, 0]), [200, 30, 0]);  // along x, top at z 30
    const g = soft.garment('test');
    g.piece('strap', rect(400, 60), fabric('cordura-500d'))
      .place([0, 0, 80], [1, 0, 0], [0, 1, 0])          // laid flat 80 up, u along x
      .pin([0, 0], [20, 0, 80]).pin([0, 60], [20, 60, 80]).pin([400, 0], [380, 0, 80]).pin([400, 60], [380, 60, 80]);   // corners held 360 apart: 40 mm of slack
    const shape = g.make({ body: bar });
    const m = tessellate(shape, { tolerance: 0.1 });
    assert.equal(m.faces.length, 1, 'one B-spline face');
    const bb = ops.bbox(shape);
    assert.ok(bb.min[2] > 5 && bb.min[2] < 60, `the strap came down onto the bar and its edges curl down its sides (min z ${bb.min[2].toFixed(1)}; bar top 30, start 80)`);
    assert.ok(bb.max[2] <= 100, `only the 20 mm tails past the pins rise above them (max z ${bb.max[2].toFixed(1)})`);
    assert.ok(bb.size[1] > 45 && bb.size[1] < 65, `width stays about 60, less what curls down the bar's sides (${bb.size[1].toFixed(1)})`);
    assert.ok(row(checked, 'test body clearance').ok, `the strap keeps its clearance off the bar: ${JSON.stringify(row(checked, 'test body clearance'))}`);
    assert.ok(row(checked, 'strap stretch').value < 6, `stretch within the solver's residual, 1 to 4% (${row(checked, 'strap stretch').value}%)`);
    assert.equal(flats.length, 1);
    assert.deepEqual(flats[0].size, [420, 80], 'pattern is the outline plus 10 mm allowance all round');
    assert.equal(flats[0].gauge, 'cordura-500d');
    assert.match(flats[0].dxf, /\nSTITCH\n/, 'stitch line on its own layer');
    assert.match(flats[0].dxf, /\nCUT\n/, 'cut line with allowance');
    assert.match(flats[0].dxf, /\nLINE\n8\nGRAIN\n/, 'grain line');
    assert.match(flats[0].dxf, /\nTEXT\n8\nTEXT\n[\s\S]*\nstrap  cut 1  cordura-500d  420 x 80 mm  allowance 10/, 'label with the cut count, fabric and size');
    assert.doesNotMatch(flats[0].dxf, /\nLINE\n8\nNOTCH\n/, 'no seams, no notches');
    assert.ok(g.timing.total < 15000, `relaxed in ${g.timing.total} ms`);
  } finally { scope.dispose(); }
});

test('two panels sewn along their facing edges close the gap between them and hang as two faces', () => {
  const scope = beginBrepScope();
  try {
    const checked = [], flats = [], soft = softNamespace(checked, flats);
    const g = soft.garment('pair'), ny = fabric('nylon-210d');
    const left = g.piece('left', rect(100, 100), ny, { pattern: 'panel' }).place([0, 0, 0], [1, 0, 0], [0, 0, 1]).pin([0, 100], [0, 0, 100]);
    const right = g.piece('right', rect(100, 100), ny, { pattern: 'panel' }).place([120, 0, 0], [1, 0, 0], [0, 0, 1]).pin([100, 100], [200, 0, 100]);   // pins 200 apart: 20 mm of slack for two 100 wide panels
    g.seam(left.edge(1), right.edge(3), { flip: true });   // left's right edge (u 100, v 0 -> 100) to right's left edge (u 0, v 100 -> 0)
    const shape = g.make();
    assert.equal(tessellate(shape, { tolerance: 0.1 }).faces.length, 2);
    const bb = ops.bbox(shape);
    assert.ok(bb.size[0] < 215, `the panels hang between the pins (span ${bb.size[0].toFixed(1)}; 220 at the start, 200 pin to pin)`);
    assert.ok(row(checked, 'seam left/right gap').ok, `the seam closed: ${JSON.stringify(row(checked, 'seam left/right gap'))}`);
    assert.ok(row(checked, 'seam left/right length match').ok);
    assert.equal(flats.length, 1, 'both panels share the pattern');
    assert.equal(flats[0].qty, 2);
    assert.match(flats[0].dxf, /panel  cut 2  nylon-210d/);
    assert.equal((flats[0].dxf.match(/\nLINE\n8\nNOTCH\n/g) || []).length, 2, 'a notch at each end of the sewn edge');
  } finally { scope.dispose(); }
});

test('avatar: torso, neck, head and two arms at the sizes asked for; seam and fabric errors name the problem', () => {
  const scope = beginBrepScope();
  try {
    const soft = softNamespace();
    const body = soft.avatar({ torso: 480, head: 230, shoulders: 400 });
    assert.equal(ops.bodies(body), 11, 'torso, neck, head, and shoulder, upper arm, elbow, forearm each side');
    const bb = ops.bbox(body);
    assert.ok(Math.abs(bb.max[2] - (480 * 1.08 + 75 + 230)) < 1, `crown at ${bb.max[2].toFixed(1)}: shoulder line, 75 of neck, 230 of head`);
    assert.ok(bb.size[0] > 400 && bb.size[0] < 600, `arms hang just outside the 400 shoulder line (${bb.size[0].toFixed(0)} wide)`);
    assert.ok(bb.size[0] > bb.size[1], 'wider than deep');
    assert.throws(() => fabric('denim'), /no fabric 'denim'/);
    assert.throws(() => soft.garment().piece('x', [[0, 0], [1, 0]]), /at least 3/);
    assert.throws(() => soft.garment().make(), /no pieces/);
  } finally { scope.dispose(); }
});

test('a weight sinks into a slack strap until the cloth under it is taut, and is carried there', () => {
  const scope = beginBrepScope();
  try {
    const checked = [], soft = softNamespace(checked, []);
    const g = soft.garment('sling');
    // 300 of strap between corners held 260 apart: a 60 wide block in the middle hangs it in a V, 120 of cloth over 100 of span each side
    g.piece('strap', rect(300, 100), fabric('cordura-500d'), { grid: 12.5 }).place([0, 0, 0], [1, 0, 0], [0, 1, 0])
      .pin([0, 0], [20, 0, 0]).pin([0, 100], [20, 100, 0]).pin([300, 0], [280, 0, 0]).pin([300, 100], [280, 100, 0]);
    const w = g.weight('block', [60, 60, 20], 1000, { at: [150, 50, 15] });
    g.make({ steps: 8000, settle: 10 });
    const drop = Math.sqrt(120 * 120 - 100 * 100);   // 66: how far below the pins the taut V puts the block's underside
    assert.ok(row(checked, 'sling settled').ok, `settled: ${JSON.stringify(row(checked, 'sling settled'))}`);
    assert.ok(Math.abs(w.at[2] - (10 - drop)) < 10, `the block hangs where the taut cloth puts it (centre z ${w.at[2]}, a taut V gives ${(10 - drop).toFixed(1)})`);
    assert.ok(Math.abs(w.at[0] - 150) < 3 && Math.abs(w.at[1] - 50) < 3 && w.tilt < 5, `and stays put on it, level (at ${w.at}, tilt ${w.tilt})`);
    assert.equal(row(checked, 'block carried').value, w.moved);
  } finally { scope.dispose(); }
});

test('a fabric with a measured rigidity droops as a beam does; without one it hangs', () => {
  const tip = (fab) => {
    const scope = beginBrepScope();
    try {
      const g = softNamespace([], []).garment('flag');
      // 100 of strip held flat over its first 12.5 (two rows of tacks), the other 87.5 free
      g.piece('strip', rect(100, 40), fab, { grid: 12.5 }).place([0, 0, 0], [1, 0, 0], [0, 1, 0])
        .pin([0, 0], [0, 0, 0]).pin([0, 40], [0, 40, 0]).pin([12.5, 0], [12.5, 0, 0]).pin([12.5, 40], [12.5, 40, 0]);
      return -ops.bbox(g.make({ steps: 8000, settle: 5 })).min[2];
    } finally { scope.dispose(); }
  };
  const limp = tip(fabric('cordura-500d')), stiff = tip(fabric({ name: 'stiff', rigidity: 0.5 }));
  // a cantilever under its own weight: q L^4 / (8 D), q = 250 g/m2 = 2.45e-6 N/mm2, L = 87.5, D = 0.5 N.mm
  const beam = (2.45e-6 * 87.5 ** 4) / (8 * 0.5);
  assert.ok(limp > 60, `the limp strip hangs down (tip ${limp.toFixed(1)} mm below the tacks)`);
  assert.ok(Math.abs(stiff - beam) < 0.25 * beam, `the stiff strip droops ${stiff.toFixed(1)} mm; a beam of that rigidity droops ${beam.toFixed(1)}`);
});
