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

test('a Z bend: one flange folds the other way, flat is the outside sizes less one bend deduction per bend', () => {
  const scope = beginBrepScope();
  try {
    const checked = [], sm = sheetMetalNamespace(checked, []);
    const p = sm.part('z', g).base(100, 60).flange('base.b', 20).flange('base.t', 25, { reverse: true });
    const s = p.make();
    assert.equal(ops.bodies(s), 1);
    const bb = ops.bbox(s);
    assert.ok(Math.abs(bb.min[2] - (g.t - 25)) < 0.01 && Math.abs(bb.max[2] - 20) < 0.01, `z from ${bb.min[2]} to ${bb.max[2]}`);
    assert.ok(Math.abs(p.flat().size[1] - (60 + 20 + 25 - 2 * g.bd)) < 0.05, `flat ${p.flat().size}`);
    assert.match(p.dxf(), /\nBEND_REVERSE\n/);
    assert.ok(checked.every((c) => c.ok), JSON.stringify(checked.filter((c) => !c.ok)));
  } finally { scope.dispose(); }
});

test('PEM hardware: placed by a frame point, fused in, counted; the catalog distances bite', () => {
  const scope = beginBrepScope();
  try {
    const checked = [], flats = [], sm = sheetMetalNamespace(checked, flats);
    const frame = { origin: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] };
    const p = sm.part('nutted', g).base(200, 100).flange('base.b', 25);
    p.pem('base.b', 'SP-M5-0', p.at('base.b', [100, 0, 14], frame)).pem('base', 'FH4-M5-10', [100, 50], { face: 'out' });
    const s = p.make(frame);
    assert.equal(ops.bodies(s), 1, 'hardware fused in');
    assert.ok(Math.abs(ops.bbox(s).min[2] - (g.t - 0.394 * 25.4)) < 0.01, 'the stud stands out of the outer face, its head flush in the inside one');
    assert.deepEqual(flats[0].hardware, { 'SP-M5-0': 1, 'FH4-M5-10': 1 });
    assert.ok(checked.some((c) => /hardware 1 SP-M5-0, 1 FH4-M5-10/.test(c.label) && c.ok));
    // 5 mm up the flange is inside its .313 in of the bend
    assert.throws(() => sm.part('tight', g).base(200, 100).flange('base.b', 25).pem('base.b', 'SP-M5-0', [100, 5]).make(), /from an edge or bend/);
    assert.throws(() => sm.part('x', g).base(50, 50).pem('base', 'SP-M9', [25, 25]), /no hardware 'SP-M9'/);
    assert.throws(() => sm.part('thin', sm.gauge('scs-304', 0.048)).base(80, 80).pem('base', 'SP-M6-1', [40, 40]).make(), /wants 0.06 to 0.5 in sheet/);
  } finally { scope.dispose(); }
});

test('pem: an SP nut is drawn from PEM\'s drawing, collar and shank, bored through with the sheet', () => {
  const scope = beginBrepScope();
  try {
    const sm = sheetMetalNamespace([], []), r = (d) => Math.PI * (d / 2) ** 2, H = 0.25 * 25.4;
    const v = ops.volume(sm.part('plate', g).base(80, 80).pem('base', 'SP-M5-0', [40, 40]).make());
    const want = (80 * 80 - 4 * (9 - r(6) / 4)) * g.t - r(H) * g.t + (r(8.64) - r(5)) * 2 + (r(H) - r(5)) * 0.77;
    assert.ok(Math.abs(v - want) < 2, `volume ${v.toFixed(1)}, want ${want.toFixed(1)}`);
  } finally { scope.dispose(); }
});

test('countersinks: aluminium .187 takes M4, stainless and .125 do not', () => {
  const scope = beginBrepScope();
  try {
    const sm = sheetMetalNamespace([], []), al = (t) => sm.gauge('scs-5052', t);
    const plate = sm.part('plate', al(0.187)).base(90, 110).countersink('base', 'M4', [10, 10]);
    const before = 90 * 110 * al(0.187).t;
    assert.ok(ops.volume(plate.make()) < before - 50, 'the cone is cut');
    assert.throws(() => sm.part('thin plate', al(0.125)).base(90, 110).countersink('base', 'M4', [10, 10]).make(), /M4 is 1.93 mm deep/);
    assert.throws(() => sm.part('steel plate', g).base(90, 110).countersink('base', 'M4', [10, 10]).make(), /not countersunk/);
    assert.throws(() => sm.part('small', al(0.187)).base(70, 70).countersink('base', 'M4', [10, 10]).make(), /outside 1 x 4/);
    assert.throws(() => sm.part('bent al', al(0.313)).base(90, 110).flange('base.b', 20), /cut flat only/);
    const kick = sm.part('kick', al(0.080)).base(300, 120).flange('base.b', 30).pem('base.b', 'FH-M5-10', [150, 15], { face: 'out' });
    assert.ok(ops.volume(kick.make()) > 0);
    assert.deepEqual(kick.bom(), { 'FH-M5-10': 1 }, 'aluminium takes FH-M5-10 studs');
    assert.ok(kick.rules().every((r) => r.ok), kick.rules().filter((r) => !r.ok).map((r) => r.label).join('; '));
  } finally { scope.dispose(); }
});

test('a 45° flange: the flat is the two outside sizes less the 45° deduction, the folded flange leans in at 45°, and chamfer corners mitre', () => {
  const g = gauge('scs-304', 0.074), sm = sheetMetalNamespace(), sb = (g.r + g.t) * Math.tan(Math.PI / 8), ba = g.ba / 2;
  const p = sm.part('chamfer', g).base(100, 60).flange('base.r', 20, { angle: 45 });
  const f = p.flat();
  assert.ok(Math.abs(f.size[0] - (100 + 20 - (2 * sb - ba))) < 1e-4, `flat ${f.size[0]} should be ${100 + 20 - (2 * sb - ba)}`);
  const s = p.make({ origin: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] });
  const bb = ops.bbox(s), tip = 100 - (g.r + g.t) + Math.SQRT1_2 * (g.r + g.t);  // the flange's tip stands 20 - sb along a 45° line from the mold corner
  assert.ok(bb.max[2] > 14 && bb.max[2] < 16, `a 20 mm 45° flange tops out at ${bb.max[2].toFixed(2)}, 20 sin 45° plus the sheet, between 14 and 16`);
  assert.ok(bb.max[0] > 100 + 10 && bb.max[0] < 100 + 15, `and reaches ${bb.max[0].toFixed(2)} along x, between 110 and 115 (${tip.toFixed(1)} is its bend)`);
  const tray = sm.part('chamfer_tray', g).base(100, 60).flange('base.b', 15, { angle: 45 }).flange('base.r', 15, { angle: 45 });
  assert.ok(tray.rules(tray.flat()).every((r) => r.ok || /flange|box/.test(r.label)), 'a mitred chamfer corner passes the overlap checks');
  tray.make({ origin: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] });
  assert.ok(tray.rules(tray.flat()).find((r) => /folded pieces/.test(r.label)).ok, 'its two chamfers do not pass through each other');
});

test('tabs: a second flange on the same edge, tagged, each held off the corners', () => {
  const sm = sheetMetalNamespace([], []);
  const p = sm.part('tabs', g).base(100, 80).flange('base.t', 15, { angle: 45 })
    .flange('base.r', 12, { angle: 90, reverse: true, from: 10, to: 30 }).flange('base.r#2', 12, { angle: 90, reverse: true, from: 45, to: 65 });
  assert.throws(() => sm.part('dup', g).base(10, 10).flange('base.r', 5).flange('base.r', 5), /already has a flange/);
  const s = p.make({ origin: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] }), bb = ops.bbox(s);
  assert.ok(Math.abs(bb.max[0] - 100) < 1e-6, `reverse tabs fold in: the part ends at x = ${bb.max[0].toFixed(2)}, not past the base edge`);
  assert.equal(p._layout().bends.filter((b) => b.id.startsWith('base.r')).length, 2, 'two bends on the right edge');
  assert.ok(p.rules(p.flat()).every((r) => r.ok), p.rules(p.flat()).filter((r) => !r.ok).map((r) => r.label).join('; '));
});

test('a flange run past its parent edge bends only along the parent (no bend-strip tail past it)', () => {
  const scope = beginBrepScope();
  try {
    const sm = sheetMetalNamespace([], []);
    const p = sm.part('point', g).base(100, 50).flange('base.b', 20, { angle: 45, from: -10, to: 110 });
    const bend = p.flat().parts.find((x) => x.id === 'base.b bend').d.boundingBox;
    assert.ok(bend.width < 100.01, `bend strip ${bend.width} mm long on a 100 mm edge`);
  } finally { scope.dispose(); }
});
