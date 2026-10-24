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
    assert.ok(row(checked, 'test inside body').ok, `no pass into the bar: ${JSON.stringify(row(checked, 'test inside body'))}`);
    assert.ok(row(checked, 'strap stretch').value < 6, `stretch within the solver's residual, 1 to 4% (${row(checked, 'strap stretch').value}%)`);
    assert.equal(flats.length, 1);
    assert.deepEqual(flats[0].size, [420, 80], 'pattern is the outline plus 10 mm allowance all round');
    assert.equal(flats[0].gauge, 'cordura-500d');
    assert.match(flats[0].dxf, /\nSTITCH\n/, 'stitch line on its own layer');
    assert.match(flats[0].dxf, /\nCUT\n/, 'cut line with allowance');
    assert.ok(g.timing.total < 15000, `relaxed in ${g.timing.total} ms`);
  } finally { scope.dispose(); }
});

test('two panels sewn along their facing edges close the gap between them and hang as two faces', () => {
  const scope = beginBrepScope();
  try {
    const checked = [], flats = [], soft = softNamespace(checked, flats);
    const g = soft.garment('pair'), ny = fabric('nylon-210d');
    const left = g.piece('left', rect(100, 100), ny).place([0, 0, 0], [1, 0, 0], [0, 0, 1]).pin([0, 100], [0, 0, 100]);
    const right = g.piece('right', rect(100, 100), ny).place([120, 0, 0], [1, 0, 0], [0, 0, 1]).pin([100, 100], [200, 0, 100]);   // pins 200 apart: 20 mm of slack for two 100 wide panels
    g.seam(left.edge(1), right.edge(3), { flip: true });   // left's right edge (u 100, v 0 -> 100) to right's left edge (u 0, v 100 -> 0)
    const shape = g.make();
    assert.equal(tessellate(shape, { tolerance: 0.1 }).faces.length, 2);
    const bb = ops.bbox(shape);
    assert.ok(bb.size[0] < 215, `the panels hang between the pins (span ${bb.size[0].toFixed(1)}; 220 at the start, 200 pin to pin)`);
    assert.ok(row(checked, 'seam left/right gap').ok, `the seam closed: ${JSON.stringify(row(checked, 'seam left/right gap'))}`);
    assert.ok(row(checked, 'seam left/right length match').ok);
    assert.equal(flats.length, 2);
  } finally { scope.dispose(); }
});

test('avatar: one solid torso the height asked for; seam and fabric errors name the problem', () => {
  const scope = beginBrepScope();
  try {
    const soft = softNamespace();
    const body = soft.avatar({ torso: 480 });
    assert.equal(ops.bodies(body), 1);
    const bb = ops.bbox(body);
    assert.ok(Math.abs(bb.size[2] - 480 * 1.08) < 1, `height ${bb.size[2].toFixed(1)}`);
    assert.ok(bb.size[0] > bb.size[1], 'wider than deep');
    assert.throws(() => fabric('denim'), /no fabric 'denim'/);
    assert.throws(() => soft.garment().piece('x', [[0, 0], [1, 0]]), /at least 3/);
    assert.throws(() => soft.garment().make(), /no pieces/);
  } finally { scope.dispose(); }
});
