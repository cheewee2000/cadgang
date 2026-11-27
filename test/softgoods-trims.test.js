// Trims and hardware: placement is validated, geometry is derived from it, and the exports show it. Numbers are worked out by hand.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { z } from 'zod';
import { SoftgoodsDocument, validateSoftgoodsDocument } from '../src/core/softgoods-document.js';
import { patternDXF, techPack, techPackHTML, exportSoftgoods } from '../src/core/softgoods-export.js';
import { checkDesign } from '../src/core/softgoods-operations.js';
import { dxfEntities, makeMarkers } from '../src/core/softgoods-marker.js';
import { billOfMaterials, bomPage } from '../src/core/softgoods-bom.js';
import { printHTML, patternSVG } from '../src/core/softgoods-print.js';
import { astmStyleDXF, astmStyleOf, ASTM_STYLE } from '../src/core/softgoods-astm.js';
import { trimGeometry, trimMarks, rowSpacing, checkTrims, simulationTrims, trimSchedule, SEAM_KINDS, TRIM_KINDS } from '../src/core/softgoods-trims.js';
import { softgoodsRouter } from '../src/server/softgoods.js';
import { editSoftgoods } from '../src/core/softgoods-edit.js';
import { simulationInput } from '../src/core/softgoods-drape.js';
import { simulate } from '../web/softgoods-worker.js';
import { registerSoftgoodsTools } from '../src/mcp/softgoods.js';
import { tee } from './fixtures/softgoods-tee.js';
import { exportHashes } from './fixtures/softgoods-baseline.mjs';

// addRectangle draws a panel counter-clockwise from its bottom-left: bottom runs +x, right runs +y, top runs -x, left runs -y.
function panels(...list) { const d = new SoftgoodsDocument(null); for (const [id, width, height, allowance = 10] of list) d.addRectangle({ id, width, height, allowance }); return d; }
const withTrims = (d, ...trims) => validateSoftgoodsDocument({ ...d.toJSON(), trims });
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} is not ${b}`);
// A shirt front in two halves: the placket edges are left.left_right (x = 200, running up) and right.right_left (x = 0, running down).
const shirt = () => panels(['left', 200, 600], ['right', 200, 600]);
const buttons = (extra = {}) => ({ id: 'placket_buttons', kind: 'button', spec: { diameter: 15 }, along: [{ pattern: 'left', segment: 'left_right' }], mate: [{ pattern: 'right', segment: 'right_left' }], flip: true, count: 5, inset: 15, ...extra });

test('a trim that cannot be placed is refused with a message that says why', () => {
  const d = shirt(), bad = (trim, message) => assert.throws(() => withTrims(d, trim), message);
  bad({ id: 'a', kind: 'rivet', at: { pattern: 'pocket', u: 1, v: 1 } }, /Trim 'a' refers to missing pattern 'pocket'/);
  bad({ id: 'a', kind: 'rivet', at: { pattern: 'left', point: 'nowhere' } }, /missing point 'left.nowhere'/);
  bad({ id: 'a', kind: 'rivet', at: { pattern: 'left' } }, /needs a spot: \{ pattern, u, v \}/);
  bad({ id: 'a', kind: 'rivet', at: { pattern: 'left', segment: 'left_top', t: 1.5 } }, /t between 0 and 1/);
  bad({ id: 'a', kind: 'zipper', along: [{ pattern: 'left', segment: 'left_hem' }] }, /missing segment 'left.left_hem'/);
  bad({ id: 'a', kind: 'zipper', along: [{ pattern: 'left', segment: 'left_top', from: 0.6, to: 0.4 }] }, /from and to on 'left.left_top' must be fractions 0\.\.1 of its first and last segment, from before to/);
  bad({ id: 'a', kind: 'zipper', along: [{ pattern: 'left', segments: ['left_top', 'left_bottom'] }] }, /segments 'left_top' and 'left_bottom' do not follow one another along the outline/);
  bad({ id: 'a', kind: 'zipper', along: [{ pattern: 'left', segment: 'left_top', segments: ['left_top'] }] }, /names segment or segments on 'left', not both/);
  bad({ id: 'a', kind: 'topstitch', path: { pattern: 'left', line: 'pocket_line' } }, /missing internal line 'left.pocket_line'/);
  bad({ id: 'a', kind: 'elastic', elastic: 'waist' }, /refers to missing elastic 'waist': the id of an elastics\[\] entry or of a seam with elastic/);
  bad({ id: 'a', kind: 'webbing', elastic: 'waist' }, /exactly one placement|elastic is the id of the design's own elastic, for a trim of kind elastic/);
  bad({ id: 'a', kind: 'zipper', along: [{ pattern: 'left', contour: 3 }] }, /missing contour 3/);
  bad({ id: 'a', kind: 'zipper', at: { pattern: 'left', u: 1, v: 1 } }, /is a zipper: place it along edges or on a path/);
  bad({ id: 'a', kind: 'zipper' }, /needs exactly one placement/);
  bad({ id: 'a', kind: 'rivet', at: { pattern: 'left', u: 1, v: 1 }, along: [{ pattern: 'left', segment: 'left_top' }] }, /exactly one placement/);
  bad({ id: 'a', kind: 'binding', along: [{ pattern: 'left', contour: 0 }], mate: [{ pattern: 'right', contour: 0 }] }, /binding, which has one side/);
  bad({ id: 'a', kind: 'button', at: { pattern: 'left', u: 20, v: 20 } }, /is a button: give spec.diameter/);
  bad({ id: 'a', kind: 'button', diameter: 15, at: { pattern: 'left', u: 20, v: 20 } }, /unknown field 'diameter': sizes belong in spec, as spec.diameter/);
  bad({ id: 'a', kind: 'snap', where: 'top' , at: { pattern: 'left', u: 20, v: 20 } }, /unknown field 'where'\. Known: id, kind/);
  bad(buttons({ count: undefined }), /runs along an edge: give a count or a pitch/);
  bad(buttons({ pitch: 200 }), /Trim 'placket_buttons': 5 marks at 200 mm pitch need 800 mm; the edge has 600 mm/);
  bad(buttons({ mate: { pattern: 'right', u: 1, v: 1 } }), /mate must be a run of edges/);
  bad({ id: 'a', kind: 'webbing', path: { pattern: 'left', points: ['left_bl', 'left_xx'] } }, /path refers to missing point 'left.left_xx'/);
  bad({ id: 'a', kind: 'ziper', along: [{ pattern: 'left', segment: 'left_top' }] }, /kind 'ziper' is not a known length trim \(zipper, /);
  bad({ id: 'a', kind: 'elastic', spec: { ratio: 1.4 }, along: [{ pattern: 'left', segment: 'left_top' }] }, /spec.ratio is the relaxed length over the edge/);
  bad({ id: 'a', kind: 'zipper', spec: { chain: 'big' }, along: [{ pattern: 'left', segment: 'left_top' }] }, /zipper size such as '#5'/);
  bad({ id: '9a', kind: 'rivet', at: { pattern: 'left', u: 1, v: 1 } }, /trim id '9a' must match/);
  assert.throws(() => withTrims(d, buttons(), buttons()), /Two trims are named 'placket_buttons'/);
  assert.throws(() => validateSoftgoodsDocument({ ...d.toJSON(), trims: {} }), /trims must be an array/);
  // An unlisted kind is a piece of hardware at a spot, and an old document simply has no trims.
  assert.equal(withTrims(d, { id: 'lock', kind: 'cord-lock', at: { pattern: 'left', segment: 'left_top', t: 0.5, inset: 12 } }).trims.length, 1);
  assert.deepEqual(validateSoftgoodsDocument({ version: 1, patterns: [], seams: [] }).trims, []);
});

test('a row is spaced from a count or a pitch, with or without margins', () => {
  assert.deepEqual(rowSpacing(600, { count: 5 }).at, [60, 180, 300, 420, 540]);                       // half a pitch (60) at each end
  assert.deepEqual(rowSpacing(600, { count: 5, margin: [50, 70] }), { count: 5, pitch: 120, at: [50, 170, 290, 410, 530] });
  assert.deepEqual(rowSpacing(600, { pitch: 100 }).at, [50, 150, 250, 350, 450, 550]);              // six fit, the 100 left over is shared
  assert.deepEqual(rowSpacing(600, { pitch: 100, margin: 20 }).at, [20, 120, 220, 320, 420, 520]);  // (600 - 40) / 100 → five steps
  assert.deepEqual(rowSpacing(600, { count: 3, pitch: 90 }).at, [210, 300, 390]);                   // centred on the edge
  assert.deepEqual(rowSpacing(600, { count: 1 }).at, [300]); assert.deepEqual(rowSpacing(600, { count: 1, margin: [100, 0] }).at, [350]);
  assert.throws(() => rowSpacing(600, {}), /needs a count or a pitch/); assert.throws(() => rowSpacing(600, { count: 2.5 }), /whole number/); assert.throws(() => rowSpacing(100, { count: 2, margin: 60 }), /margins \(60 \+ 60 mm\) are longer than the 100 mm edge/);
});

test('five buttons down a placket, and their buttonholes at the same heights on the other front', () => {
  const d = withTrims(shirt(), buttons()), g = trimGeometry(d, d.trims[0]);
  assert.equal(g.count, 5); assert.equal(g.pitchMm, 120); assert.equal(g.buttonholeLengthMm, 18);      // 15 mm button + 3 mm
  // 15 mm in from x = 200 on the left front, 15 mm in from x = 0 on the right; the edges run opposite ways, so flip pairs t with 1 - t.
  assert.deepEqual(g.positions.map((p) => [p.pattern, p.x, p.y, p.t]), [60, 180, 300, 420, 540].map((y, i) => ['left', 185, y, [0.1, 0.3, 0.5, 0.7, 0.9][i]]));
  assert.deepEqual(g.mate.map((p) => [p.pattern, p.x, p.y, p.t]), [60, 180, 300, 420, 540].map((y, i) => ['right', 15, y, [0.9, 0.7, 0.5, 0.3, 0.1][i]]));
  g.positions.forEach((p, i) => near(p.t, 1 - g.mate[i].t));
  // Without flip the same fractions run the other way up the mate edge; a spec can say how long the hole is.
  const plain = withTrims(shirt(), buttons({ flip: false, spec: { diameter: 20, thickness: 5 }, mateInset: 12 })), h = trimGeometry(plain, plain.trims[0]);
  assert.deepEqual(h.mate.map((p) => [p.x, p.y, p.t]), [[12, 540, 0.1], [12, 420, 0.3], [12, 300, 0.5], [12, 180, 0.7], [12, 60, 0.9]]); assert.equal(h.buttonholeLengthMm, 25);
  // A row that fits the base size but not a smaller one is a finding about that size, not a crash: 5 at 120 mm need 480 of a 400 mm edge.
  const small = checkDesign(validateSoftgoodsDocument({ ...withTrims(shirt(), buttons({ pitch: 120, mate: undefined })), grades: [{ size: 'S', rules: [{ pattern: 'left', point: 'left_tr', dx: 0, dy: -200 }, { pattern: 'left', point: 'left_tl', dx: 0, dy: -200 }] }] }));
  assert.equal(small.trims[0].ok, true); assert.equal(small.sizes[0].ok, false); assert.match(small.sizes[0].trims[0].issues[0], /5 marks at 120 mm pitch need 480 mm; the edge has 400 mm/);
  // One snap and its socket, each at a spot; a piece cut twice carries two.
  const json = shirt().toJSON(); json.patterns[0].cut = 2;
  const snap = validateSoftgoodsDocument({ ...json, trims: [{ id: 'flap_snap', kind: 'snap', spec: { diameter: 12 }, at: { pattern: 'left', segment: 'left_top', t: 0.25, inset: 20 }, mate: { pattern: 'right', point: 'right_tl' } }] }), s = trimGeometry(snap, snap.trims[0]);
  assert.deepEqual([s.positions[0].x, s.positions[0].y], [150, 580]); assert.deepEqual([s.mate[0].x, s.mate[0].y], [0, 600]); assert.equal(s.count, 2);
});

test('a zipper is as long as its edge, snaps to a stocked length, and two sides that differ are reported', () => {
  const zip = (extra = {}) => ({ id: 'top_zip', kind: 'zipper', spec: { chain: '#5', separating: false }, along: [{ pattern: 'front', segment: 'front_top' }], mate: [{ pattern: 'back', segment: 'back_top' }], flip: true, ...extra });
  const bag = panels(['front', 300, 200], ['back', 300, 200]), d = withTrims(bag, zip()), g = trimGeometry(d, d.trims[0]);
  assert.equal(g.lengthMm, 300); assert.equal(g.mateLengthMm, 300); assert.equal(g.cutLengthMm, 300); assert.equal(g.gapMm, 0);
  assert.deepEqual(checkDesign(d).trims, [{ id: 'top_zip', kind: 'zipper', ok: true, count: 1, lengthMm: 300, cutLengthMm: 300, mateLengthMm: 300, issues: [] }]); assert.ok(!('warnings' in checkDesign(d)));
  // Part of an edge: from 10% to 90% of 300 mm.
  const part = withTrims(bag, zip({ along: [{ pattern: 'front', segment: 'front_top', from: 0.1, to: 0.9 }], mate: [{ pattern: 'back', segment: 'back_top', from: 0.1, to: 0.9 }] })); near(trimGeometry(part, part.trims[0]).lengthMm, 240, 1e-9);
  // Stocked lengths: 280 and 320 are equally near 300, the shorter is taken, and the check says it is 20 mm short.
  const stocked = withTrims(bag, zip({ spec: { chain: 5, lengths: [320, 250, 280] } })), s = trimGeometry(stocked, stocked.trims[0]);
  assert.equal(s.cutLengthMm, 280); assert.equal(s.gapMm, 20); assert.deepEqual(checkDesign(stocked).warnings, ["Zipper 'top_zip' is 280 mm on a 300 mm opening: 20 mm too short"]); assert.equal(checkDesign(stocked).ok, true);
  // The back made 320 wide: its top edge no longer matches the front's.
  bag.updatePoint('back', 'back_br', 320, 0); bag.updatePoint('back', 'back_tr', 320, 200);
  const off = checkDesign(withTrims(bag, zip()));
  assert.equal(off.ok, false); assert.equal(off.trims[0].ok, false); assert.deepEqual(off.trims[0].issues, ['its two sides are 300 mm and 320 mm long']);
  // A #5 on a typical 32 mm tape has (32 - 5) / 2 = 13.5 mm of tape a side; three quarters of that, 10 mm, is the least allowance.
  const narrow = panels(['front', 300, 200, 6], ['back', 300, 200]);
  assert.deepEqual(checkDesign(withTrims(narrow, zip())).warnings, ["Zipper 'top_zip': front.front_top has a 6 mm allowance and its tape needs at least 10 mm"]);
  assert.ok(!('warnings' in checkDesign(withTrims(narrow, zip({ spec: { chain: '#5', allowance: 6 } })))));
  // The zipper follows the pattern into a graded size.
  const graded = { ...withTrims(panels(['front', 300, 200], ['back', 300, 200]), zip()), grades: [{ size: 'L', rules: [{ pattern: 'front', point: 'front_br', dx: 20, dy: 0 }, { pattern: 'front', point: 'front_tr', dx: 20, dy: 0 }, { pattern: 'back', point: 'back_br', dx: 20, dy: 0 }, { pattern: 'back', point: 'back_tr', dx: 20, dy: 0 }] }] };
  assert.equal(checkDesign(validateSoftgoodsDocument(graded)).sizes[0].trims[0].lengthMm, 320);
});

test('the seam vocabulary warns about an allowance too small for the construction, and old kinds stay free', () => {
  const d = panels(['front', 200, 150, 6], ['back', 200, 150, 6]);
  d.addSeam({ id: 'side', a: { pattern: 'front', segment: 'front_right' }, b: { pattern: 'back', segment: 'back_left' }, kind: 'french' });
  d.addSeam({ id: 'base', a: { pattern: 'front', segment: 'front_bottom' }, b: { pattern: 'back', segment: 'back_bottom' }, kind: 'whatever-the-shop-calls-it' });
  const check = checkDesign(d.toJSON());
  assert.deepEqual(check.warnings, ["Seam 'side' is french: front.front_right has a 6 mm allowance and needs at least 10 mm", "Seam 'side' is french: back.back_left has a 6 mm allowance and needs at least 10 mm"]);
  assert.equal(check.ok, true, 'a warning is not a failure'); assert.ok(!('trims' in check));
  for (const kind of ['plain', 'flat-felled', 'french', 'lapped', 'bound', 'topstitched']) assert.ok(SEAM_KINDS[kind].rows >= 1 && SEAM_KINDS[kind].allowance >= SEAM_KINDS[kind].min, kind);
  assert.equal(TRIM_KINDS.zipper.place, 'length'); assert.equal(TRIM_KINDS.button.mate, 'buttonhole');
});

// A 200 × 100 panel with 20 mm corners: straights 2 × 160 + 2 × 60, and four quarter circles that make one of radius 20.
function rounded() {
  const points = [['a', 20, 0], ['b', 180, 0], ['c', 200, 20], ['d', 200, 80], ['e', 180, 100], ['f', 20, 100], ['g', 0, 80], ['h', 0, 20], ['c1', 180, 20], ['c2', 180, 80], ['c3', 20, 80], ['c4', 20, 20]].map(([id, x, y]) => ({ id, x, y }));
  const segments = [['bottom', 'line', 'a', 'b'], ['br', 'arc', 'b', 'c', 'c1'], ['right', 'line', 'c', 'd'], ['tr', 'arc', 'd', 'e', 'c2'], ['top', 'line', 'e', 'f'], ['tl', 'arc', 'f', 'g', 'c3'], ['left', 'line', 'g', 'h'], ['bl', 'arc', 'h', 'a', 'c4']].map(([id, type, a, b, c]) => ({ id, type, a, b, ...(c ? { c } : {}) }));
  return { version: 1, patterns: [{ id: 'flap', name: 'Flap', material: 'canvas', cut: 1, points, segments, contours: [segments.map((s) => s.id)], allowances: {}, notches: [], grain: { angle: 90 } }], seams: [] };
}

test('binding goes all the way round a contour: straights, arcs, corners and the join', () => {
  const perimeter = 2 * 160 + 2 * 60 + 2 * Math.PI * 20;                                           // 565.66 mm
  const d = validateSoftgoodsDocument({ ...rounded(), trims: [{ id: 'edge_binding', kind: 'binding', spec: { finishedWidth: 10, tapeWidth: 40, overlap: 20 }, along: [{ pattern: 'flap', contour: 0 }], pricePerMeter: 3 }] }), g = trimGeometry(d, d.trims[0]);
  near(g.lengthMm, perimeter, 0.01); near(g.cutLengthMm, perimeter + 20, 0.01); assert.equal(g.corners, 0, 'rounded corners need no mitre'); assert.equal(g.chains.length, 1, 'eight segments, one closed chain');
  // The extent is drawn 10 mm inside the edge: a rounded rectangle 180 × 80 with 10 mm corners.
  const inner = trimMarks(d, 'flap').lines.filter((l) => l.layer === 'TRIM'), xs = inner.flatMap((l) => [l.a[0], l.b[0]]), ys = inner.flatMap((l) => [l.a[1], l.b[1]]);
  near(Math.min(...xs), 10, 0.01); near(Math.max(...xs), 190, 0.01); near(Math.min(...ys), 10, 0.01); near(Math.max(...ys), 90, 0.01);
  near(inner.reduce((n, l) => n + Math.hypot(l.b[0] - l.a[0], l.b[1] - l.a[1]), 0), 2 * 160 + 2 * 60 + 2 * Math.PI * 10, 0.01);
  // A square panel has four corners to mitre, each given 5 mm: 2 × (200 + 150) + 4 × 5.
  const square = withTrims(panels(['panel', 200, 150]), { id: 'b', kind: 'binding', spec: { cornerAllowance: 5 }, along: [{ pattern: 'panel', contour: 0 }] }), q = trimGeometry(square, square.trims[0]);
  assert.equal(q.lengthMm, 700); assert.equal(q.corners, 4); assert.equal(q.cutLengthMm, 720);
  // Elastic is cut shorter than the edge it gathers; a drawcord longer than its channel.
  const waist = withTrims(panels(['panel', 200, 150]), { id: 'waist', kind: 'elastic', spec: { width: 25, ratio: 0.8, overlap: 15 }, along: [{ pattern: 'panel', segment: 'panel_top' }] }, { id: 'cord', kind: 'drawcord', spec: { width: 12, tailLengths: [150, 150] }, along: [{ pattern: 'panel', segment: 'panel_bottom' }] });
  assert.equal(trimGeometry(waist, waist.trims[0]).cutLengthMm, 175); assert.equal(trimGeometry(waist, waist.trims[1]).cutLengthMm, 500);
});

test('an edge trim is written like a seam side, and a line trim may follow an internal line', () => {
  // Round a corner: the last 40% of the bottom (80 mm) and the first half of the right edge (75 mm), as one length.
  const d = panels(['panel', 200, 150]), json = d.toJSON(); json.patterns[0].points.push({ id: 'pocket_a', x: 40, y: 100 }, { id: 'pocket_b', x: 160, y: 100 }); json.patterns[0].internalLines = [{ id: 'pocket_line', type: 'line', a: 'pocket_a', b: 'pocket_b' }];
  const doc = validateSoftgoodsDocument({ ...json, trims: [
    { id: 'corner_piping', kind: 'piping', along: [{ pattern: 'panel', segments: ['panel_bottom', 'panel_right'], from: 0.6, to: 0.5 }] },
    { id: 'pocket_stitch', kind: 'topstitch', spec: { rows: 2, spacing: 5 }, path: { pattern: 'panel', line: 'pocket_line' } },
  ] }), piping = trimGeometry(doc, doc.trims[0]), stitch = trimGeometry(doc, doc.trims[1]);
  assert.equal(piping.lengthMm, 155); assert.equal(piping.chains.length, 1); assert.deepEqual(piping.chains[0].points, [[120, 0], [200, 0], [200, 75]]);
  assert.equal(stitch.lengthMm, 120); assert.equal(stitch.stitchedMm, 240);
  assert.deepEqual(trimMarks(doc, 'panel').lines.filter((l) => l.layer === 'TOPSTITCH').map((l) => [l.a, l.b]), [[[40, 100], [160, 100]], [[40, 105], [160, 105]]], 'on the line and 5 mm to its left');
  assert.deepEqual(trimSchedule(doc).map((r) => r.where), ['panel.panel_bottom+panel_right 0.6-0.5', 'panel, internal line pocket_line']);
});

test('an elastic trim points at the design\'s own elastic: one ratio, in one place', () => {
  // The design already gathers its waist: elastics[] is what the cloth preview reads. The trim adds what is bought.
  const d = panels(['band', 400, 60]), json = { ...d.toJSON(), elastics: [{ id: 'waist', pattern: 'band', segment: 'band_top', ratio: 0.8 }] };
  const doc = validateSoftgoodsDocument({ ...json, trims: [{ id: 'waist_elastic', kind: 'elastic', elastic: 'waist', spec: { width: 25, overlap: 20 }, pricePerMeter: 1.5 }] }), g = trimGeometry(doc, doc.trims[0]);
  assert.equal(g.lengthMm, 400); assert.equal(g.relaxedRatio, 0.8); assert.equal(g.cutLengthMm, 340);                // 400 × 0.8 + 20
  assert.equal(billOfMaterials(doc).trims[0].cost, 0.51); assert.equal(trimSchedule(doc)[0].where, 'elastic waist');
  assert.throws(() => validateSoftgoodsDocument({ ...json, trims: [{ id: 'w', kind: 'elastic', elastic: 'waist', spec: { ratio: 0.7 } }] }), /points at elastic 'waist', which has the ratio: leave spec.ratio out/);
  // The bill: without trims an elastic keeps the row it always had; with trims, one a trim points at is that trim's row, once, and any other keeps a row of the same shape.
  assert.deepEqual(billOfMaterials(validateSoftgoodsDocument(json)).trims, [{ kind: 'elastic', id: 'waist', count: 1, lengthMm: 320 }]);
  const both = validateSoftgoodsDocument({ ...json, elastics: [...json.elastics, { id: 'hem', pattern: 'band', segment: 'band_bottom', ratio: 0.5 }], trims: doc.trims }), bill = billOfMaterials(both, { sizes: { base: 2 } });
  assert.deepEqual(bill.trims.map((t) => [t.id, t.count, t.lengthMm, t.totalLengthMm, t.cost]), [['waist_elastic', 2, 340, 680, 1.02], ['hem', 2, 200, 400, null]]); assert.match(bomPage(bill), /<td>hem<\/td><td>elastic<\/td><td><\/td><td>2<\/td><td>200<\/td><td>400<\/td>/);
  assert.equal(checkDesign(doc).physics[0].id, 'waist', 'the preview checks the same elastic');
  // An elastic seam is one too: it relaxes to its ratio of the shorter side.
  const two = panels(['band', 400, 60], ['body', 500, 300]); two.addSeam({ id: 'waist_seam', a: { pattern: 'band', segment: 'band_bottom' }, b: { pattern: 'body', segment: 'body_top' }, kind: 'elastic' });
  const sewn = two.toJSON(); sewn.seams[0].elastic = { ratio: 0.9 };
  const s = validateSoftgoodsDocument({ ...sewn, trims: [{ id: 'e', kind: 'elastic', elastic: 'waist_seam', spec: { width: 30 } }] }); assert.equal(trimGeometry(s, s.trims[0]).cutLengthMm, 360);
  // Added through the document on one whole edge with a ratio, the trim brings its elastic with it, and the ratio lives there.
  const live = panels(['band', 400, 60]), added = live.addTrim({ id: 'cuff', kind: 'elastic', spec: { width: 20, ratio: 0.75 }, along: [{ pattern: 'band', segment: 'band_bottom' }] });
  assert.deepEqual(added, { id: 'cuff', kind: 'elastic', spec: { width: 20 }, elastic: 'cuff' }); assert.deepEqual(live.data.elastics, [{ id: 'cuff', pattern: 'band', segment: 'band_bottom', ratio: 0.75 }]);
  assert.equal(simulationTrims(live.toJSON())[0].elastic, 'cuff'); assert.equal(simulationTrims(live.toJSON())[0].relaxedLengthMm, 300);
  live.updateTrim('cuff', { spec: { ratio: 0.6, width: 25 } }); assert.equal(live.data.elastics[0].ratio, 0.6); assert.deepEqual(live.data.trims[0].spec, { width: 25 }); assert.equal(trimGeometry(live.data, live.data.trims[0]).cutLengthMm, 240);
  // Between two points of the piece it is a line; part of an edge is not something the preview gathers, so that one keeps its own ratio.
  const line = live.addTrim({ id: 'back_elastic', kind: 'elastic', spec: { ratio: 0.5 }, path: { pattern: 'band', points: ['band_bl', 'band_tr'] } }); assert.equal(line.elastic, 'back_elastic'); assert.deepEqual(live.data.elastics[1].line, ['band_bl', 'band_tr']);
  const part = live.addTrim({ id: 'part', kind: 'elastic', spec: { ratio: 0.5 }, along: [{ pattern: 'band', segment: 'band_top', from: 0.25, to: 0.75 }] }); assert.ok(!('elastic' in part)); assert.equal(live.data.elastics.length, 2); assert.equal(trimGeometry(live.data, part).cutLengthMm, 100);
  live.removeTrim('cuff'); assert.deepEqual(live.data.elastics.map((e) => e.id), ['back_elastic'], 'the elastic it brought goes with it');
  const kept = new SoftgoodsDocument(null); kept.replace(doc); kept.removeTrim('waist_elastic'); assert.equal(kept.data.elastics.length, 1, 'one the design already had stays');
});

test('trims follow pattern edits: a cut edge, a dart and a piece cut in two', () => {
  const zip = { id: 'top_zip', kind: 'zipper', along: [{ pattern: 'front', segment: 'front_top' }], mate: [{ pattern: 'back', segment: 'back_top' }], flip: true };
  const d = withTrims(panels(['front', 300, 200], ['back', 300, 200]), zip, { id: 'tab', kind: 'snap', at: { pattern: 'front', segment: 'front_bottom', t: 0.75, inset: 20 } }, { id: 'badge', kind: 'label', at: { pattern: 'front', u: 250, v: 100 } }, { id: 'hem', kind: 'topstitch', along: [{ pattern: 'front', segment: 'front_bottom' }] });
  const length = (doc, id) => trimGeometry(doc, doc.trims.find((t) => t.id === id)).lengthMm, spot = (doc, id) => { const p = trimGeometry(doc, doc.trims.find((t) => t.id === id)).positions[0]; return [p.pattern, p.x, p.y]; };
  // A pleat slashes the front from the middle of its top edge to its bottom edge and spreads it 40 mm: both edges are cut, and both grow.
  const pleated = editSoftgoods(d, { op: 'pleat', pattern: 'front', segment: 'front_top', at: 0.5, intake: 40, bothEnds: true });
  assert.deepEqual(pleated.trims[0].along, [{ pattern: 'front', segment: 'front_top' }, { pattern: 'front', segment: 'front_top_2' }], 'the zipper runs over both parts of the cut edge');
  assert.equal(length(pleated, 'top_zip'), 300, 'and not over the cloth folded into the pleat'); assert.equal(length(pleated, 'hem'), 300); assert.equal(checkDesign(pleated).trims[0].ok, true);
  assert.equal(spot(pleated, 'tab')[2], 20, 'the snap is still 20 mm above the bottom edge');
  // Its side is now two entries, which is not one seam side: closed in the preview, it is held point for point instead.
  const held = simulationInput(pleated, 40); assert.equal(held.seams.some((s) => s.id === 'top_zip'), false); assert.ok(held.attachments.filter((a) => a.kind === 'zipper' && a.to.pattern === 'back').length >= 8);
  // Cut the front in two from the middle of its bottom edge to the middle of its top: the snap and the label go to the half they sit on.
  const cut = editSoftgoods(d, { op: 'split', pattern: 'front', from: { segment: 'front_bottom', at: 0.5 }, to: { segment: 'front_top', at: 0.5 } }), home = (id) => { const t = cut.trims.find((q) => q.id === id); return (t.at || t.along[0]).pattern; };
  assert.deepEqual(spot(cut, 'tab'), [home('tab'), 225, 20]); assert.deepEqual(spot(cut, 'badge'), [home('badge'), 250, 100]); assert.equal(home('tab'), home('badge'));
  assert.ok(['front_a', 'front_b'].includes(home('tab')));
  // The zipper and the hem ran across the cut: they cannot belong to one half, and the edit says so instead of guessing.
  assert.throws(() => editSoftgoods(withTrims(panels(['front', 300, 200]), { id: 'all_round', kind: 'binding', along: [{ pattern: 'front', contour: 0 }] }), { op: 'split', pattern: 'front', from: { segment: 'front_bottom', at: 0.5 }, to: { segment: 'front_top', at: 0.5 } }), /Trim 'all_round' refers to missing pattern 'front'/);
});

// Where the flat point uv of a piece is in 3D, in a frame of the solver.
function draped(f, input, id, uv) {
  const m = input.meshes.find((q) => q.id === id), off = f.pieces.find((q) => q.id === id).off, P = (i) => [0, 1, 2].map((k) => f.positions[(off + i) * 3 + k]);
  for (let t = 0; t < m.triangles.length; t += 3) { const [a, b, c] = [0, 1, 2].map((k) => m.triangles[t + k]), ax = m.uv[a * 2], ay = m.uv[a * 2 + 1], bx = m.uv[b * 2] - ax, by = m.uv[b * 2 + 1] - ay, cx = m.uv[c * 2] - ax, cy = m.uv[c * 2 + 1] - ay, d = bx * cy - by * cx, wb = ((uv[0] - ax) * cy - (uv[1] - ay) * cx) / d, wc = (bx * (uv[1] - ay) - by * (uv[0] - ax)) / d; if (wb >= -1e-9 && wc >= -1e-9 && wb + wc <= 1 + 1e-9) return [0, 1, 2].map((k) => (1 - wb - wc) * P(a)[k] + wb * P(b)[k] + wc * P(c)[k]); }
  throw new Error(`no triangle of ${id} holds ${uv}`);
}
// A front in two halves, 200 × 300 each, standing upright. The left half hangs from two pins at its top corners; the right half is held by nothing but the trim.
function hungFront(trim, rightAt, { height = 300, pins = [] } = {}) {
  const d = new SoftgoodsDocument(null); d.addRectangle({ id: 'left', width: 200, height: 300 }); d.addRectangle({ id: 'right', width: 200, height });
  return validateSoftgoodsDocument({ ...d.toJSON(), materials: { canvas: { arealDensity: 340, thickness: 0.6, damping: 0.05 } }, arrangement: [{ pattern: 'left', position: [0, 0, 700], rotation: [90, 0, 0] }, { pattern: 'right', position: rightAt, rotation: [90, 0, 0] }],
    attachments: [{ id: 'pin_l', pattern: 'left', at: [0, 300], to: [0, 0, 1000] }, { id: 'pin_r', pattern: 'left', at: [200, 300], to: [200, 0, 1000] }, ...pins], trims: [trim] });
}
const apart = (f, input, a, b) => Math.hypot(...draped(f, input, 'left', a).map((v, k) => v - draped(f, input, 'right', b)[k]));

test('a closed zipper zips the two fronts together in the preview, and closed: false leaves them open', () => {
  const zip = (extra = {}) => ({ id: 'front_zip', kind: 'zipper', spec: { chain: '#5' }, along: [{ pattern: 'left', segment: 'left_right' }], mate: [{ pattern: 'right', segment: 'right_left' }], flip: true, ...extra });
  const gaps = (f, input) => [0, 150, 300].map((y) => apart(f, input, [200, y], [0, y]));
  // The right front starts 30 mm from the left one. Closed (the default for a zipper), its edge ends on the left front's, and it hangs there.
  const input = simulationInput(hungFront(zip(), [230, 0, 700]), 40);
  assert.deepEqual(input.seams.map((s) => [s.id, s.kind, Math.round(s.lengthA)]), [['front_zip', 'zipper', 300]]); assert.equal(input.trims[0].closed, true);
  for (const g of gaps(simulate(input, 0), input)) assert.ok(Math.abs(g - 30) < 0.01, `starts ${g} mm open`);
  const shut = simulate(input, 240); for (const g of gaps(shut, input)) assert.ok(g < 1, `ends ${g.toFixed(2)} mm apart`);
  assert.ok(draped(shut, input, 'right', [100, 300])[2] > 850, 'the right front hangs from the zipper');
  // Worn open: the input is what it would be without the closure, and nothing holds the right front, which falls away.
  const open = simulationInput(hungFront(zip({ closed: false }), [230, 0, 700]), 40);
  assert.deepEqual(open.seams, []); assert.deepEqual(open.attachments.map((a) => a.id), ['pin_l', 'pin_r']); assert.ok(!('closed' in open.trims[0]));
  for (const g of gaps(simulate(open, 240), open)) assert.ok(g > 300, `open, yet ${g.toFixed(0)} mm apart`);
  // A zipper whose two sides differ is not sewn and does not stop the preview: the check reports it.
  const off = hungFront(zip(), [230, 0, 700], { height: 340 }), unsewn = simulationInput(off, 40);
  assert.deepEqual(unsewn.seams, []); assert.equal(checkDesign(off).trims[0].ok, false); assert.match(checkDesign(off).trims[0].issues[0], /300 mm and 340 mm/);
  assert.throws(() => hungFront({ id: 'r', kind: 'rivet', at: { pattern: 'left', u: 5, v: 5 }, closed: true }, [230, 0, 700]), /can only be closed onto a mate/);
});

test('three buttons hold a placket at three points, and it gapes between them', () => {
  // The right front laps 30 mm over the left; its far edge is pulled 60 mm forward, as a body would push it. Buttons at 50, 150 and 250 mm up.
  const buttoned = (extra = {}) => hungFront({ id: 'placket', kind: 'button', spec: { diameter: 15 }, along: [{ pattern: 'left', segment: 'left_right' }], mate: [{ pattern: 'right', segment: 'right_left' }], flip: true, count: 3, inset: 15, ...extra }, [170, -5, 700],
    { pins: [{ id: 'pin_bl', pattern: 'left', at: [0, 0], to: [0, 0, 700] }, { id: 'pin_br', pattern: 'left', at: [200, 0], to: [200, 0, 700] }, { id: 'pull_t', pattern: 'right', at: [200, 300], to: [355, -60, 1000] }, { id: 'pull_b', pattern: 'right', at: [200, 0], to: [355, -60, 700] }] });
  const input = simulationInput(buttoned(), 40), f = simulate(input, 240), gap = (frame, from, y) => apart(frame, from, [185, y], [15, y]);
  assert.deepEqual(input.attachments.filter((a) => a.kind === 'button').map((a) => [a.id, a.at, a.to]), [['placket_1', [185, 50], { pattern: 'right', at: [15, 50] }], ['placket_2', [185, 150], { pattern: 'right', at: [15, 150] }], ['placket_3', [185, 250], { pattern: 'right', at: [15, 250] }]]);
  for (const y of [50, 150, 250]) assert.ok(gap(f, input, y) < 0.5, `the button at ${y} holds: ${gap(f, input, y).toFixed(2)} mm`);
  for (const y of [100, 200]) assert.ok(gap(f, input, y) > 1, `between the buttons at ${y} it gapes: ${gap(f, input, y).toFixed(2)} mm`);
  for (const y of [0, 300]) assert.ok(gap(f, input, y) > 5, `beyond the last button at ${y} it gapes more: ${gap(f, input, y).toFixed(2)} mm`);
  // Unbuttoned, nothing holds the placket at all.
  const open = simulationInput(buttoned({ closed: false }), 40); assert.equal(open.attachments.some((a) => a.kind === 'button'), false);
  assert.ok(gap(simulate(open, 240), open, 150) > 50);
});

// A pouch front with everything on it: buttons with buttonholes on the back, a zipper across both tops, two topstitch rows, a rivet, a label, and a strap on the back.
function pouch() {
  return withTrims(panels(['front', 200, 150], ['back', 200, 150]),
    { id: 'top_zip', kind: 'zipper', name: 'Top zip', spec: { chain: '#5' }, along: [{ pattern: 'front', segment: 'front_top' }], mate: [{ pattern: 'back', segment: 'back_top' }], flip: true, unitPrice: 1.5, supplier: 'YKK', partNumber: '5C-200' },
    { id: 'side_buttons', kind: 'button', spec: { diameter: 12 }, along: [{ pattern: 'front', segment: 'front_left' }], mate: [{ pattern: 'back', segment: 'back_right' }], flip: true, count: 4, inset: 15, unitPrice: 0.25 },
    { id: 'hem_stitch', kind: 'topstitch', spec: { rows: 2, offset: 3, spacing: 6 }, along: [{ pattern: 'front', segment: 'front_bottom' }] },
    { id: 'corner_rivet', kind: 'rivet', spec: { diameter: 8 }, at: { pattern: 'front', u: 180, v: 20 } },
    { id: 'brand', kind: 'label', spec: { width: 30, height: 12 }, at: { pattern: 'front', u: 100, v: 75 } },
    { id: 'strap', kind: 'webbing', spec: { width: 20, tailLengths: [30, 20] }, path: { pattern: 'back', points: [[50, 20], [50, 120]] }, pricePerMeter: 2, hardware: [{ kind: 'buckle', unitPrice: 0.8, partNumber: 'SR-20' }] });
}
const count = (text, pattern) => (text.match(pattern) || []).length;

test('the pattern DXF carries the marks on DRILL, TRIM and TOPSTITCH, and the print, the marker and the astm-style file show them', () => {
  const d = pouch(), front = d.patterns[0], back = d.patterns[1], dxf = patternDXF(front, [], trimMarks(d, 'front')), { layers, lines, texts } = dxfEntities(dxf), on = (layer) => lines.filter((l) => l.layer === layer);
  assert.deepEqual([layers.DRILL, layers.TRIM, layers.TOPSTITCH], [1, 5, 3]); assert.match(dxf, /\n0\nTABLE\n2\nLAYER\n70\n13\n/);
  // Four buttons and a rivet: a cross (two lines) and a POINT each. Buttons sit 15 mm in from x = 0, every 37.5 mm down a 150 mm edge.
  assert.equal(on('DRILL').length, 10); assert.equal(count(dxf, /\n0\nPOINT\n8\nDRILL\n/g), 5);
  for (const y of [131.25, 93.75, 56.25, 18.75]) assert.match(dxf, new RegExp(`\\n0\\nPOINT\\n8\\nDRILL\\n10\\n15\\n20\\n${y}\\n`));
  assert.match(dxf, /\n0\nPOINT\n8\nDRILL\n10\n180\n20\n20\n/);
  assert.deepEqual(on('DRILL').slice(-2).map((l) => [l.a, l.b]), [[[176, 20], [184, 20]], [[180, 16], [180, 24]]], 'the rivet cross spans its 8 mm');
  // Two topstitch rows 3 and 9 mm above the hem; the zipper tape 13.5 mm outside the top edge with a tick at each end; the label's 30 × 12 box.
  assert.deepEqual(on('TOPSTITCH').map((l) => [l.a, l.b]), [[[0, 3], [200, 3]], [[0, 9], [200, 9]]]);
  assert.deepEqual(on('TRIM').slice(0, 3).map((l) => [l.a, l.b]), [[[200, 163.5], [0, 163.5]], [[200, 163.5], [200, 150]], [[0, 163.5], [0, 150]]]);
  assert.deepEqual(on('TRIM').slice(3).map((l) => l.a), [[85, 69], [115, 69], [115, 81], [85, 81]]);
  assert.deepEqual(texts.slice(-5).map((t) => t.value), ['Top zip', 'side_buttons x4', 'hem_stitch', 'corner_rivet', 'brand']);
  // The back: four buttonholes 15 mm long (12 + 3) along its right edge, the other zipper side, and the strap's outline, centre line and two bartacks.
  const b = dxfEntities(patternDXF(back, [], trimMarks(d, 'back'))).lines, holes = b.filter((l) => l.layer === 'TRIM' && l.a[0] === 185 && l.b[0] === 185 && l.a[1] !== l.b[1]);
  assert.deepEqual(holes.map((l) => [l.a[1], l.b[1]]), [[123.75, 138.75], [86.25, 101.25], [48.75, 63.75], [11.25, 26.25]], 'top to bottom, facing the buttons');
  assert.deepEqual(b.filter((l) => l.layer === 'TOPSTITCH').map((l) => [l.a, l.b]), [[[60, 25], [40, 25]], [[60, 115], [40, 115]]], 'a bartack 5 mm in from each end, across the 20 mm strap');
  assert.ok(b.some((l) => l.layer === 'TRIM' && l.a[0] === 40 && l.b[0] === 40) && b.some((l) => l.layer === 'TRIM' && l.a[0] === 60 && l.b[0] === 60) && b.some((l) => l.layer === 'TRIM' && l.a[0] === 50 && l.b[0] === 50));
  assert.equal(b.filter((l) => l.layer === 'DRILL').length, 0);
  // The print draws each layer, styles and names them only when there are trims; the SVG has a group per layer.
  const print = printHTML(d, { name: 'pouch' }), drill = print.match(/class="ln DRILL" d="([^"]*)"/)[1];
  assert.equal(count(drill, /M/g), 10, 'ten strokes: five crosses'); assert.match(print, /class="ln TRIM"/); assert.match(print, /class="ln TOPSTITCH"/); assert.match(print, /\.TOPSTITCH\{stroke-width:\.35;stroke-dasharray/); assert.match(print, /CROSSES: DRILL AND PLACEMENT MARKS/);
  const bare = printHTML(panels(['front', 200, 150]).toJSON(), { name: 'pouch' }); assert.ok(!/DRILL|TOPSTITCH/.test(bare));
  assert.match(patternSVG(front, [], trimMarks(d, 'front')), /<g id="DRILL"/);
  assert.ok(makeMarkers(d, { width: 600 }).markers[0].placements.some((p) => p.lines.some((l) => l.layer === 'DRILL')), 'drill marks ride along on the marker');
  // astm-style: a POINT on layer 13 per drilled spot, no cross, and the trim lines among the internal lines on 8.
  const astm = astmStyleDXF(d, { name: 'pouch' });
  assert.equal(count(astm, /\n0\nPOINT\n8\n13\n/g), 5); assert.match(astm, /\n0\nLAYER\n2\n13\n/); assert.ok(!astm.includes('DRILL')); assert.match(astm, /\n0\nLINE\n8\n8\n10\n0\n20\n3\n30\n0\n11\n200\n21\n3\n/);
  assert.match(astmStyleOf(d).layers[13], /drill holes/); assert.equal(astmStyleOf({ trims: [] }), ASTM_STYLE); assert.ok(!(13 in ASTM_STYLE.layers));
});

test('the bill counts trims, their lengths and their cost, and topstitching joins the thread estimate', () => {
  const d = pouch(); d.seams.push({ id: 'side', a: { pattern: 'front', segment: 'front_right' }, b: { pattern: 'back', segment: 'back_left' }, flip: true, kind: 'french' });
  const one = billOfMaterials(d), row = (bom, id) => bom.trims.find((t) => t.id === id);
  assert.deepEqual(one.trims.map((t) => [t.id, t.kind, t.count, t.lengthMm, t.totalLengthMm, t.cost]), [
    ['top_zip', 'zipper', 1, 200, 200, 1.5],            // one, by the piece
    ['side_buttons', 'button', 4, null, null, 1],       // 4 × 0.25
    ['corner_rivet', 'rivet', 1, null, null, null],     // no price given
    ['brand', 'label', 1, null, null, null],
    ['strap', 'webbing', 1, 150, 150, 0.3],             // 100 sewn + 30 + 20 of tail, at 2 a metre
    ['strap.buckle', 'buckle', 1, null, null, 0.8],
  ]);
  assert.equal(row(one, 'top_zip').supplier, 'YKK'); assert.equal(row(one, 'top_zip').spec, 'chain #5'); assert.equal(row(one, 'top_zip').where, 'front.front_top to back.back_top'); assert.equal(row(one, 'strap.buckle').where, 'on strap');
  assert.equal(one.cost.trims, 3.6); assert.equal(one.cost.cloth, null); assert.equal(one.cost.total, 3.6); assert.equal(one.cost.complete, false, 'the cloth, the rivet and the label have no price');
  // Thread: the french seam is 150 mm sewn twice (× 2.5 × 2 rows = 750), the hem has two 200 mm topstitch rows (400 × 2.5 = 1000).
  assert.deepEqual(one.seams.byKind, [{ kind: 'french', count: 1, lengthMm: 150, threadMultiplier: 5, threadMm: 750 }]);
  assert.equal(one.thread.topstitchMm, 400); assert.equal(one.thread.lengthMm, 1750); assert.match(one.thread.basis, /plus the topstitch rows/);
  assert.equal(billOfMaterials(d, { threadMultiplier: { french: 6, topstitch: 3, default: 2 } }).thread.lengthMm, 150 * 6 + 400 * 3, 'a kind named in the multiplier is taken as given');
  // Two units, and a front cut twice: everything on the front doubles again.
  d.patterns[0].cut = 2;
  const two = billOfMaterials(d, { sizes: { base: 2 } });
  assert.deepEqual(two.trims.map((t) => [t.id, t.count, t.totalLengthMm, t.cost]), [['top_zip', 4, 800, 6], ['side_buttons', 16, null, 4], ['corner_rivet', 4, null, null], ['brand', 4, null, null], ['strap', 2, 300, 0.6], ['strap.buckle', 2, null, 1.6]]);
  assert.equal(two.cost.trims, 12.2); assert.equal(two.thread.topstitchMm, 1600);
  // qty says how many there really are.
  d.trims[0].qty = 1; assert.equal(row(billOfMaterials(d), 'top_zip').count, 1);
  const page = bomPage(one, 'pouch');
  assert.match(page, /<h2>TRIMS<\/h2><table><tr><th>Trim<\/th>/); assert.match(page, /<td>Top zip<\/td><td>zipper<\/td><td>chain #5<\/td><td>1<\/td><td>200<\/td><td>200<\/td><td>YKK 5C-200<\/td><td>1.5<\/td>/); assert.match(page, /Trims cost 3.6 · total 3.6 \(some lines have no price\)/);
});

test('the tech pack has a trims schedule and a placement drawing of every piece with a mark', () => {
  const d = pouch(), pack = techPack(d, 'pouch'), html = techPackHTML(pack);
  assert.deepEqual(pack.trims.schedule.map((r) => [r.id, r.count, r.lengthMm]), [['top_zip', 1, 200], ['side_buttons', 4, null], ['hem_stitch', 1, 200], ['corner_rivet', 1, null], ['brand', 1, null], ['strap', 1, 150], ['strap.buckle', 1, null]]);
  assert.deepEqual(trimSchedule(d), pack.trims.schedule); assert.deepEqual(pack.trims.drawings.map((x) => x.pattern), ['front', 'back']); assert.deepEqual(pack.check.trims.map((t) => t.ok), [true, true, true, true, true, true]);
  assert.match(html, /<h2>TRIMS SCHEDULE<\/h2>/); assert.match(html, /<td>side_buttons<\/td><td>button<\/td><td>diameter 12<\/td><td>4<\/td><td><\/td><td>front\.front_left to back\.back_right<\/td>/);
  assert.match(html, /<h2>TRIM PLACEMENT<\/h2>/); assert.equal(count(html, /<figure><figcaption>/g), 2); assert.match(html, /<figcaption>FRONT<\/figcaption><svg /); assert.match(pack.notes.at(-1), /DRILL holds a cross and a POINT/);
  // The section is in the design system whatever the page around it does: Space Mono 400, pure black, square.
  const css = html.match(/<section class="trims"><style>([^<]*)<\/style>/)[1];
  assert.match(css, /\.trims,\.trims \*\{font-family:"Space Mono",monospace;font-weight:400;font-style:normal;color:#000000;border-radius:0\}/); assert.ok(!/#(?!000000)[0-9a-f]{3,6}\b/i.test(css), 'no colour but black');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadgang-soft-trims-'));
  try { const r = exportSoftgoods(d, dir, 'pouch'); assert.match(fs.readFileSync(path.join(dir, 'pouch_front.dxf'), 'utf8'), /\n8\nDRILL\n/); assert.deepEqual(r.check.trims, []); assert.ok(!('warnings' in r.check)); } finally { fs.rmSync(dir, { recursive: true }); }
});

test('a design without trims exports the same bytes as before trims existed', () => {
  // softgoods-no-trims-baseline.json was written at dba27ca (softgoods-physics), from the T-shirt fixture: every pattern and graded
  // DXF, the astm-style files, the marker, the SVGs, the print, the bill and the tech pack (its timestamp aside).
  const baseline = JSON.parse(fs.readFileSync(new URL('./fixtures/softgoods-no-trims-baseline.json', import.meta.url), 'utf8')), now = exportHashes(tee());
  assert.equal(Object.keys(baseline).length, 40); assert.equal(Object.keys(baseline).filter((f) => f.endsWith('.dxf')).length, 19);
  assert.deepEqual(now, baseline);
  const d = validateSoftgoodsDocument(tee()); assert.equal(trimMarks(d, 'front'), null); assert.equal(patternDXF(d.patterns[0]), patternDXF(d.patterns[0], [], trimMarks(d, 'front')));
  const check = checkDesign(d); assert.ok(!('trims' in check) && !('warnings' in check)); assert.deepEqual(billOfMaterials(d).trims, []); assert.ok(!('trims' in techPack(d)));
});

test('trims are added, changed and removed through the document, the REST routes and the MCP tool', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cadgang-soft-trims-')), 'softgoods.json'), doc = new SoftgoodsDocument(file), app = express(), seen = [];
  doc.addRectangle({ id: 'front', width: 300, height: 200 }); doc.addRectangle({ id: 'back', width: 300, height: 200 }); doc.onChange((x) => seen.push(x.data.revision));
  app.use(express.json()); app.use('/s', softgoodsRouter(doc));
  const server = app.listen(0), call = async (p, method = 'GET', body) => { const r = await fetch(`http://127.0.0.1:${server.address().port}/s${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) }); return { status: r.status, ...(await r.json()) }; };
  try {
    const before = doc.data.revision;
    // "add a #5 zipper along the top opening"
    const added = await call('/trims', 'POST', { id: 'top_zip', kind: 'zipper', spec: { chain: '#5' }, along: [{ pattern: 'front', segment: 'front_top' }], mate: [{ pattern: 'back', segment: 'back_top' }], flip: true });
    assert.equal(added.status, 200); assert.equal(added.added, 'top_zip'); assert.equal(added.revision, before + 1); assert.deepEqual(seen, [before + 1], 'the page is told');
    assert.equal(added.trims[0].geometry.lengthMm, 300); assert.ok(!('chains' in added.trims[0].geometry)); assert.deepEqual(added.check.trims.map((t) => t.ok), [true]);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).trims[0].id, 'top_zip', 'and it is saved');
    // "five 15 mm buttons down the placket", with no id given
    const row = await call('/trims', 'POST', { kind: 'button', spec: { diameter: 15 }, along: [{ pattern: 'front', segment: 'front_right' }], count: 5, inset: 15 });
    assert.match(row.added, /^button_[0-9a-f]{10}$/); assert.equal(row.trims[1].geometry.positions.length, 5); assert.equal(row.trims[1].geometry.pitchMm, 40);
    // An update merges spec and takes away what is set to null; a bad one changes nothing.
    const patched = await call('/trims/top_zip', 'PATCH', { spec: { separating: true, lengths: [250, 310] }, flip: null, unitPrice: 2 });
    assert.deepEqual(patched.trims[0].spec, { chain: '#5', separating: true, lengths: [250, 310] }); assert.ok(!('flip' in patched.trims[0])); assert.equal(patched.trims[0].geometry.cutLengthMm, 310); assert.match(patched.check.warnings[0], /10 mm too long/);
    const refused = await call('/trims/top_zip', 'PATCH', { along: [{ pattern: 'front', segment: 'front_lid' }] }); assert.equal(refused.status, 400); assert.match(refused.error, /missing segment 'front.front_lid'/);
    assert.equal((await call('/trims/top_zip', 'PATCH', { id: 'zip' })).status, 400); assert.equal((await call('/trims', 'POST', { id: 'top_zip', kind: 'rivet', at: { pattern: 'front', u: 5, v: 5 } })).status, 400); assert.equal((await call('/trims/none', 'DELETE')).status, 400);
    assert.equal((await call('/trims')).trims.length, 2); assert.equal(doc.data.revision, before + 3);
    // What the cloth preview is handed: the zipper as a seam between its edges, paired point for point.
    await call('/trims', 'POST', { id: 'flap_snap', kind: 'snap', spec: { mass: 2, strength: 4, diameter: 12 }, at: { pattern: 'front', u: 150, v: 100 }, mate: { pattern: 'back', u: 150, v: 100 } });
    await call('/trims', 'POST', { id: 'strap', kind: 'webbing', spec: { width: 25, massPerMeter: 30 }, path: { pattern: 'back', points: [[50, 20], [50, 180]] } });
    await call('/trims', 'POST', { id: 'waist', kind: 'elastic', spec: { width: 20, ratio: 0.75 }, along: [{ pattern: 'back', segment: 'back_bottom' }] });
    await call('/trims', 'POST', { id: 'hem', kind: 'topstitch', along: [{ pattern: 'front', segment: 'front_bottom' }] });
    const input = await call('/simulation-input?target=50'), fact = (id) => input.trims.find((t) => t.id === id);
    assert.deepEqual(input.trims.map((t) => [t.id, t.type]), [['top_zip', 'seam'], [row.added, 'point'], ['flap_snap', 'tack'], ['strap', 'strip'], ['waist', 'elastic']], 'topstitching holds nothing together');
    assert.equal(fact('top_zip').pairs.length, 13); assert.deepEqual(fact('top_zip').pairs[0], { a: { pattern: 'front', x: 300, y: 200 }, b: { pattern: 'back', x: 300, y: 200 } });
    assert.deepEqual(fact('top_zip').seam, { id: 'top_zip', a: { pattern: 'front', segment: 'front_top' }, b: { pattern: 'back', segment: 'back_top' }, flip: false, kind: 'zipper' }, 'written as a seam of the design'); assert.equal(fact('top_zip').widthMm, 13.5);
    assert.equal(fact('top_zip').rigidity, 5); assert.equal(fact('top_zip').rigiditySource, 'typical, not measured'); assert.equal(fact('top_zip').massPerMeterG, null, 'a mass nobody gave is not invented');
    // A snap is written as the design's own cloth-to-cloth tack: an attachment whose target is a spot on another piece.
    assert.deepEqual(fact('flap_snap').attachments, [{ id: 'flap_snap_1', pattern: 'front', at: [150, 100], to: { pattern: 'back', at: [150, 100] }, kind: 'snap', strength: 4 }]); assert.equal(fact('flap_snap').massG, 2); assert.equal(fact('flap_snap').diameterMm, 12, 'the review draws it this size');
    assert.deepEqual([fact('strap').widthMm, fact('strap').massPerMeterG, fact('strap').lengthMm], [25, 30, 160]); assert.deepEqual(fact('strap').paths, [{ pattern: 'back', points: [[50, 20], [50, 180]] }]);
    assert.deepEqual([fact('waist').relaxedRatio, fact('waist').relaxedLengthMm, fact('waist').rigidity, fact('waist').elastic], [0.75, 225, null, 'waist']);
    assert.deepEqual(simulationTrims(doc.toJSON(), { spacing: 25 }), input.trims); assert.deepEqual(input, { status: 200, ...JSON.parse(JSON.stringify(simulationInput(doc.toJSON(), 50))) }, 'the server drape starts from the same input');
    const removed = await call('/trims/top_zip', 'DELETE'); assert.equal(removed.removed, 'top_zip'); assert.ok(!removed.trims.some((t) => t.id === 'top_zip'));
    // A whole-design set carries trims too, and one that refers to a piece that is gone is refused.
    const whole = doc.toJSON(); assert.equal((await call('/document', 'PUT', whole)).trims.length, 5);
    const gone = await call('/document', 'PUT', { ...whole, elastics: [], patterns: whole.patterns.slice(0, 1), arrangement: [] }); assert.equal(gone.status, 400); assert.match(gone.error, /Trim 'flap_snap' mate refers to missing pattern 'back'/);
  } finally { server.close(); fs.rmSync(path.dirname(file), { recursive: true }); }

  const tools = {}, sent = [];
  registerSoftgoodsTools({ registerTool: (name, spec, handler) => { tools[name] = { spec, handler }; } }, { call: async (p, opts) => { sent.push([p, opts]); return {}; }, ok: (v) => v, fail: (e) => { throw e; } });
  const tool = tools.cadgang_softgoods_trim, schema = z.object(tool.spec.inputSchema), zip = { id: 'top_zip', kind: 'zipper', spec: { chain: '#5' }, along: [{ pattern: 'front', segment: 'front_top' }], mate: [{ pattern: 'back', segment: 'back_top' }], flip: true };
  assert.deepEqual(schema.parse({ action: 'add', trim: zip }), { action: 'add', trim: zip }); assert.deepEqual(schema.parse({ action: 'update', id: 'top_zip', trim: { flip: null, spec: { sliders: 2 } } }).trim, { flip: null, spec: { sliders: 2 } });
  assert.throws(() => schema.parse({ action: 'paint' })); assert.throws(() => schema.parse({ action: 'add', trim: { ...zip, along: [] } }));
  await tool.handler({ action: 'add', trim: zip }); assert.deepEqual(sent.at(-1), ['/softgoods/trims', { method: 'POST', body: zip }]);
  await tool.handler({ action: 'update', id: 'top_zip', trim: { unitPrice: 2 } }); assert.deepEqual(sent.at(-1), ['/softgoods/trims/top_zip', { method: 'PATCH', body: { unitPrice: 2 } }]);
  await tool.handler({ action: 'remove', id: 'top_zip' }); assert.deepEqual(sent.at(-1), ['/softgoods/trims/top_zip', { method: 'DELETE' }]);
  await tool.handler({ action: 'list' }); assert.deepEqual(sent.at(-1), ['/softgoods/trims', undefined]); await assert.rejects(() => tool.handler({ action: 'remove' }), /needs the id/);
  for (const word of ['zipper', 'buttonhole', 'DRILL', 'layer 13', 'tailLengths', 'count or pitch']) assert.ok(tool.spec.description.includes(word), word);
  const set = tools.cadgang_softgoods_set.spec; assert.deepEqual(set.inputSchema.trims.parse([zip]), [zip]); assert.match(set.description, /flat-felled \(2 rows, usually 15 mm, at least 10\)/); assert.match(set.description, /cadgang_softgoods_trim/);
});
