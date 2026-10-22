import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { initBrep, beginBrepScope } from '../src/core/brep.js';
import * as ops from '../src/core/ops.js';
import { gauge, sheetMetalNamespace } from '../src/core/sheetmetal.js';

before(async () => { await initBrep(); });

const g = gauge('scs-304', 0.060);

test('gauge: SendCutSend .060 304, allowance from their bend deduction', () => {
  assert.ok(Math.abs(g.t - 1.524) < 1e-9);
  assert.ok(Math.abs(g.ba - (2 * (g.r + g.t) - g.bd)) < 1e-9);
  assert.ok(Math.abs(g.reliefDepth - 0.150 * 25.4) < 0.01, 'relief depth t + r + .02 in is the .150 in their sheet lists');
  assert.throws(() => gauge('scs-304', 0.051), /no 0.051 in sheet/);
});

test('a four sided tray: flat is the outside size plus the flanges less one bend deduction per bend, corners closed with reliefs', () => {
  const scope = beginBrepScope();
  try {
    const checked = [], flats = [], sm = sheetMetalNamespace(checked, flats);
    const p = sm.part('tray', g).base(200, 100).flange('base.b', 20).flange('base.t', 20).flange('base.l', 20).flange('base.r', 20);
    const s = p.make();
    assert.equal(ops.bodies(s), 1, 'one piece');
    const bb = ops.bbox(s).size;
    assert.ok(Math.abs(bb[0] - 200) < 0.01 && Math.abs(bb[1] - 100) < 0.01 && Math.abs(bb[2] - 20) < 0.01, `folded ${bb}`);
    const [w, h] = p.flat().size;
    assert.ok(Math.abs(w - (200 + 40 - 2 * g.bd)) < 0.05, `flat width ${w}`);
    assert.ok(Math.abs(h - (100 + 40 - 2 * g.bd)) < 0.05, `flat height ${h}`);
    assert.ok(checked.every((c) => c.ok), JSON.stringify(checked.filter((c) => !c.ok)));
    assert.equal(flats.length, 1);
    assert.match(flats[0].dxf, /ENTITIES[\s\S]*LINE[\s\S]*BEND/);
    assert.equal((flats[0].dxf.match(/\nBEND\n/g) || []).length - 1, 4, 'four bend lines (plus the layer entry)');
  } finally { scope.dispose(); }
});

test('a wrapped tray (face, wrap round one corner, lip, returns): folds clean and lies flat', () => {
  const scope = beginBrepScope();
  try {
    const checked = [], sm = sheetMetalNamespace(checked, []);
    const p = sm.part('wrap', g, { hardware: true }).base(600, 670)
      .flange('base.b', 25).flange('base.t', 25).flange('base.l', 25).flange('base.r', 76)
      .flange('base.r.t', 25).flange('base.r.l', 25, { from: 30 }).flange('base.r.r', 25, { from: 30 });
    p.make();
    assert.ok(checked.every((c) => c.ok), JSON.stringify(checked.filter((c) => !c.ok)));
  } finally { scope.dispose(); }
});

test('a window bend: four mitred flaps lie flat in the opening without overlapping', () => {
  const scope = beginBrepScope();
  try {
    const checked = [], sm = sheetMetalNamespace(checked, []);
    sm.part('window', g).base(300, 200).window('base', [80, 50, 220, 150], 15).make();
    assert.ok(checked.every((c) => c.ok), JSON.stringify(checked.filter((c) => !c.ok)));
  } finally { scope.dispose(); }
});

test('the rules bite: a flange under the minimum, a part over the sheet, flanges that collide', () => {
  const scope = beginBrepScope();
  try {
    const sm = sheetMetalNamespace([], []);
    assert.throws(() => sm.part('short', g).base(100, 100).flange('base.r', 5).make(), /under the .* minimum/);
    assert.throws(() => sm.part('big', g).base(1200, 600).make(), /flat 23\.62 x 47\.24 in within 30 x 44/);
    // a flange on a flange's side edge, started at the root, runs into the neighbouring bend
    assert.throws(() => sm.part('clash', g).base(200, 200).flange('base.r', 40).flange('base.t', 40).flange('base.r.r', 30).make(), /clear of each other/);
  } finally { scope.dispose(); }
});
