// What the cloth preview does beyond hanging and sewing: elastic, tacks and pins, stuffing, creased folds, shrinkage,
// frozen and strengthened pieces, and layers. Each is run through the server's own simulation input and the page's
// solver and held to what the cloth should physically do. The first test holds everything else exactly where it was.
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { z } from 'zod';
import { SoftgoodsDocument, validateSoftgoodsDocument } from '../src/core/softgoods-document.js';
import { meshPattern } from '../src/core/softgoods-mesh.js';
import { resolveSeamCorrespondence } from '../src/core/softgoods-seams.js';
import { arrangePatternsAroundAvatar, avatarBody } from '../src/core/softgoods-arrange.js';
import { checkDesign } from '../src/core/softgoods-operations.js';
import { softgoodsRouter } from '../src/server/softgoods.js';
import { registerSoftgoodsTools } from '../src/mcp/softgoods.js';
import { simulate } from '../web/softgoods-worker.js';
import { drapeDocument, simulationInput } from '../src/core/softgoods-drape.js';
import { editSoftgoods } from '../src/core/softgoods-edit.js';
import { billOfMaterials } from '../src/core/softgoods-bom.js';

const rect = (id, w, h, extra = {}) => { const s = ['bottom', 'right', 'top', 'left'], p = ['bl', 'br', 'tr', 'tl'], c = [[0, 0], [w, 0], [w, h], [0, h]]; return { id, name: id, material: 'canvas', cut: 1, points: p.map((k, i) => ({ id: `${id}_${k}`, x: c[i][0], y: c[i][1] })), segments: s.map((n, i) => ({ id: `${id}_${n}`, type: 'line', a: `${id}_${p[i]}`, b: `${id}_${p[(i + 1) % 4]}` })), contours: [s.map((n) => `${id}_${n}`)], allowances: {}, notches: [], grain: { angle: 90 }, ...extra }; };
const canvas = { arealDensity: 340, thickness: 0.6, damping: 0.05 };
const floor = { shapes: [] };
// The design goes in through PUT /document and comes back as the page gets it, with the design's check.
async function inputFor(design, target = 25) {
  const doc = new SoftgoodsDocument(null), app = express(); app.use(express.json()); app.use('/s', softgoodsRouter(doc)); const server = app.listen(0);
  const call = async (p, method = 'GET', body) => { const r = await fetch(`http://127.0.0.1:${server.address().port}/s${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) }), j = await r.json(); if (j.error) throw new Error(j.error); return j; };
  try { const document = await call('/document', 'PUT', { version: 1, ...design }); return { ...(await call(`/simulation-input?target=${target}`)), check: await call('/check'), document }; } finally { server.close(); }
}
// The sleeveless tunic of test/softgoods-review.test.js: two panels, shoulder and side seams, the neck and armholes left open.
function tunic(points = {}) {
  const outline = (id, corners, extra = {}) => ({ id, name: id, material: 'canvas', cut: 1, points: Object.keys(corners).map((k) => ({ id: `${id}_${k}`, x: corners[k][0], y: corners[k][1] })), ...extra });
  const panel = (id, region) => { const seg = [['bottom', 'bl', 'br'], ['side_r', 'br', 'ar'], ['arm_r', 'ar', 'tr'], ['shoulder_r', 'tr', 'nr'], ['neck', 'nr', 'nl'], ['shoulder_l', 'nl', 'tl'], ['arm_l', 'tl', 'al'], ['side_l', 'al', 'bl']];
    return { ...outline(id, { bl: [0, 0], br: [520, 0], ar: [520, 450], tr: [520, 700], nr: [380, 700], nl: [140, 700], tl: [0, 700], al: [0, 450], ...points }, { placement: { region, anchor: 'shoulder' } }), segments: seg.map(([s, a, b]) => ({ id: `${id}_${s}`, type: 'line', a: `${id}_${a}`, b: `${id}_${b}` })), contours: [seg.map(([s]) => `${id}_${s}`)], allowances: {}, notches: [], grain: { angle: 90 } }; };
  const seam = (id, a, b) => ({ id, a: { pattern: 'front', segment: `front_${a}` }, b: { pattern: 'back', segment: `back_${b}` }, flip: true });
  return { materials: { canvas: { name: '12 oz canvas', arealDensity: 340, thickness: 0.6 } }, patterns: [panel('front', 'front'), panel('back', 'back')], seams: [seam('shoulder_right', 'shoulder_r', 'shoulder_l'), seam('shoulder_left', 'shoulder_l', 'shoulder_r'), seam('side_right', 'side_r', 'side_l'), seam('side_left', 'side_l', 'side_r')] };
}
const P = (f, i) => [f.positions[i * 3], f.positions[i * 3 + 1], f.positions[i * 3 + 2]];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const piece = (f, id) => f.pieces.find((q) => q.id === id);
const meshOf = (input, id) => input.meshes.find((m) => m.id === id);
/** The length in 3D of a run of mesh vertices. */
const run = (f, input, id, chain) => chain.reduce((n, v, i) => i ? n + dist(P(f, piece(f, id).off + v), P(f, piece(f, id).off + chain[i - 1])) : 0, 0);
/** Where the flat point uv of a piece is in 3D. */
function at(f, input, id, uv) {
  const m = meshOf(input, id), off = piece(f, id).off;
  for (let t = 0; t < m.triangles.length; t += 3) { const [a, b, c] = [0, 1, 2].map((k) => m.triangles[t + k]), ax = m.uv[a * 2], ay = m.uv[a * 2 + 1], bx = m.uv[b * 2] - ax, by = m.uv[b * 2 + 1] - ay, cx = m.uv[c * 2] - ax, cy = m.uv[c * 2 + 1] - ay, d = bx * cy - by * cx, wb = ((uv[0] - ax) * cy - (uv[1] - ay) * cx) / d, wc = (bx * (uv[1] - ay) - by * (uv[0] - ax)) / d; if (wb >= -1e-9 && wc >= -1e-9 && wb + wc <= 1 + 1e-9) return [0, 1, 2].map((k) => (1 - wb - wc) * P(f, off + a)[k] + wb * P(f, off + b)[k] + wc * P(f, off + c)[k]); }
  throw new Error(`no triangle of ${id} holds ${uv}`);
}
const extent = (f, id, axis) => { const pc = piece(f, id); let lo = Infinity, hi = -Infinity; for (let i = 0; i < pc.count; i++) { const v = P(f, pc.off + i)[axis]; lo = Math.min(lo, v); hi = Math.max(hi, v); } return [lo, hi]; };
const within = (value, want, share, what) => assert.ok(Math.abs(value - want) <= share * Math.abs(want), `${what}: ${value.toFixed(2)}, wanted ${want.toFixed(2)} within ${share * 100}%`);

test('a design that uses none of the new physics simulates exactly as it did', async () => {
  // The same three designs as test/softgoods-review.test.js, 60 steps each. The numbers are the solver's on origin/main at bc0169e,
  // before any of this was added: the vertex count, the sum of every coordinate, and the sum weighted by position in the array.
  const design = tunic();
  const sums = (f) => { let s = 0, w = 0; for (let i = 0; i < f.positions.length; i++) { s += f.positions[i]; w += f.positions[i] * (i % 97 + 1); } return [f.positions.length / 3, s, w]; };
  const same = (got, want, what) => { assert.equal(got[0], want[0], `${what}: vertices`); assert.ok(Math.abs(got[1] - want[1]) < 1e-3 && Math.abs(got[2] - want[2]) < 1e-1, `${what} moved: ${got} against ${want}`); };

  const placed = arrangePatternsAroundAvatar(design.patterns, { height: 1700, chest: 900 }), meshes = design.patterns.map((p) => meshPattern(p, { target: 30 }));
  same(sums(simulate({ meshes, seams: resolveSeamCorrespondence(design.seams, meshes, { spacing: 15 }), attachments: [], arrangement: placed.arrangement, materials: design.materials, patterns: design.patterns, collisionBody: { ...placed.avatar, ...avatarBody(placed.avatar) } }, 60)), [1330, 1415765.1593390629, 69213168.82191639], 'the tunic on the avatar');
  const lower = rect('lower', 200, 200), upper = rect('upper', 150, 150);
  same(sums(simulate({ meshes: [meshPattern(lower, { target: 25 }), meshPattern(upper, { target: 25 })], seams: [], attachments: [], arrangement: [{ pattern: 'lower', position: [-100, -100, 600.5], rotation: [0, 0, 0] }, { pattern: 'upper', position: [-62, -81, 606], rotation: [0, 0, 0] }], materials: { canvas: { arealDensity: 340, thickness: 0.6 } }, patterns: [lower, upper], collisionBody: { shapes: [{ type: 'ellipsoid', c: [0, 0, 500], r: [5000, 5000, 100] }] } }, 60)), [207, 124944.35034191186, 5910639.035622472], 'cloth laid on cloth');
  const strip = rect('strip', 160, 40), mesh = meshPattern(strip, { target: 10 }), clamps = []; for (let i = 0; i < mesh.uv.length / 2; i++) if (mesh.uv[i * 2] <= 60 + 1e-6) clamps.push({ id: `clamp_${i}`, pattern: 'strip', at: [mesh.uv[i * 2], mesh.uv[i * 2 + 1]], to: [mesh.uv[i * 2], mesh.uv[i * 2 + 1], 500] });
  same(sums(simulate({ meshes: [mesh], seams: [], attachments: clamps, arrangement: [{ pattern: 'strip', position: [0, 0, 500], rotation: [0, 0, 0] }], materials: { canvas: { arealDensity: 340, thickness: 0.6, damping: 0.05, rigidity: 4 } }, patterns: [strip], collisionBody: null }, 60)), [136, 81134.7480287668, 3871929.7941571157], 'the stiff cantilever');

  // And the server hands such a design to the solver with nothing added.
  const input = await inputFor({ ...design, simulation: { avatar: { height: 1700, chest: 900 } } }, 30);
  assert.deepEqual(Object.keys(input).sort(), ['arrangement', 'attachments', 'check', 'collisionBody', 'document', 'materials', 'meshes', 'patterns', 'revision', 'seams']);
  assert.deepEqual(input.patterns[0], { id: 'front', material: 'canvas', grain: { angle: 90 } }); assert.deepEqual(input.meshes[0], JSON.parse(JSON.stringify(meshes[0])));
  assert.equal(input.check.physics, undefined); assert.equal(simulate(input, 1).stuffing, undefined);
});

test('an elastic gathers a strip to its ratio, and gives the length back under load', async () => {
  const design = (extra, material = canvas) => ({ materials: { canvas: material }, patterns: [rect('strip', 40, 300)], seams: [], elastics: [{ id: 'edge', pattern: 'strip', segment: 'strip_left', ratio: 0.6, stiffness: 0.5 }], ...extra });
  // Lying on a floor nothing pulls on it: the elastic edge draws up to 0.6 of its 300 mm and the cloth is not strained by it.
  const lying = await inputFor(design({ arrangement: [{ pattern: 'strip', position: [0, 0, 0.3], rotation: [0, 0, 0] }] }), 20), edge = meshOf(lying, 'strip').segmentVertices.strip_left;
  const relaxed = simulate({ ...lying, collisionBody: floor }, 120);
  within(run(relaxed, lying, 'strip', edge), 180, 0.02, 'the relaxed elastic edge'); assert.ok(relaxed.diagnostics.strain.max < 0.01, `gathered cloth is not strained: ${relaxed.diagnostics.strain.max}`);
  assert.ok(run(relaxed, lying, 'strip', meshOf(lying, 'strip').segmentVertices.strip_right) > 270, 'the far edge, 40 mm from the elastic, keeps most of its length');
  assert.deepEqual(lying.check.physics, [{ id: 'edge', kind: 'elastic', length: 300, relaxed: 180, ok: true, note: 'cut the elastic 180 mm for 300 mm of cloth' }]);
  // Its ends held the cloth's full length apart: it stretches back to 300 mm, and the cloth takes over there.
  const held = await inputFor(design({ arrangement: [{ pattern: 'strip', position: [0, 0, 700], rotation: [90, 0, 0] }], attachments: [{ id: 'top', pattern: 'strip', at: [0, 300], to: [0, 0, 1000] }, { id: 'bottom', pattern: 'strip', at: [0, 0], to: [0, 0, 700] }] }), 20), taut = simulate(held, 120);
  within(run(taut, held, 'strip', edge), 300, 0.01, 'the elastic edge pulled out'); assert.ok(taut.diagnostics.strain.max < 0.05, `the cloth holds: ${taut.diagnostics.strain.max}`);
  // Hung by one end with an elastic down each side, it stretches as a spring of that stiffness does: by W·L/2k under its own weight W.
  const hung = async (density) => { const d = design({ arrangement: [{ pattern: 'strip', position: [0, 0, 700], rotation: [90, 0, 0] }], attachments: [{ id: 'l', pattern: 'strip', at: [0, 300], to: [0, 0, 1000] }, { id: 'r', pattern: 'strip', at: [40, 300], to: [40, 0, 1000] }] }, { ...canvas, arealDensity: density }); d.elastics.push({ id: 'other', pattern: 'strip', segment: 'strip_right', ratio: 0.6, stiffness: 0.5 }); const input = await inputFor(d, 20); return run(simulate(input, 360), input, 'strip', edge); };
  const light = await hung(60), heavy = await hung(3000), weight = (density) => 0.04 * 0.3 * density * 9.81e-3;
  assert.ok(light < 195, `light cloth hangs near the relaxed length: ${light.toFixed(1)} mm`);
  within(heavy - light, 180 * (weight(3000) - weight(60)) / (2 * 2 * 0.5), 0.2, 'the stretch under fifty times the weight');
});

test('on the body an elastic hem draws a tunic in to its ratio, and an elastic at the waist draws it in to the body', async () => {
  const body = { avatar: { height: 1700, chest: 900 } }, round = (f, input, chains) => ['front', 'back'].reduce((n, id) => n + run(f, input, id, chains(meshOf(input, id), id)), 0);
  // The hem, 1040 mm round, hangs below the body: nothing stops the elastic and it comes to 0.6 of that.
  const hemmed = await inputFor({ ...tunic(), elastics: ['front', 'back'].map((p) => ({ id: `${p}_hem`, pattern: p, segment: `${p}_bottom`, ratio: 0.6 })), simulation: body }, 40), f = simulate(hemmed, 120);
  within(round(f, hemmed, (m, id) => m.segmentVertices[`${id}_bottom`]), 0.6 * 1040, 0.03, 'the hem');
  // At the waist, an internal line drawn across each panel 250 mm up with the internalLine edit and named by the elastic,
  // the body is 828 mm round and in the way of the same elastic.
  const lined = ['front', 'back'].reduce((d, p) => editSoftgoods(d, { op: 'internalLine', pattern: p, a: [0, 250], b: [520, 250], id: `${p}_waistline` }), validateSoftgoodsDocument({ version: 1, ...tunic() }));
  const waisted = await inputFor({ ...lined, elastics: ['front', 'back'].map((p) => ({ id: `${p}_waist`, pattern: p, line: `${p}_waistline`, ratio: 0.6 })), simulation: body }, 40), g = simulate(waisted, 120);
  assert.deepEqual(waisted.elastics[0].chain, meshOf(waisted, 'front').lineVertices[0], 'the mesh follows the line and the elastic lies on it');
  within(round(g, waisted, (m) => m.lineVertices[0]), 828, 0.03, 'the waist, drawn in until it fits the body');
  // Neither strains the cloth more than hanging from the shoulders already does.
  const plain = await inputFor({ ...tunic(), simulation: body }, 40), most = simulate(plain, 120).diagnostics.strain.max;
  assert.ok(f.diagnostics.strain.max < most + 0.01 && g.diagnostics.strain.max < most + 0.01, `strain ${f.diagnostics.strain.max.toFixed(3)} and ${g.diagnostics.strain.max.toFixed(3)} against ${most.toFixed(3)} without elastic`);
});

test('the server drapes elastic and stuffing as the page simulates them, until they settle, and the bill lists the elastic', async () => {
  // A strip hung by one end with an elastic down each side, and a pillow held by the corners of its top square, in a preset fabric.
  const design = { materials: { canvas: { preset: 'nylon-500d', damping: 0.05 } }, patterns: [rect('strip', 40, 300), rect('top', 200, 200), rect('under', 200, 200)],
    seams: ['bottom', 'right', 'top', 'left'].map((s) => ({ id: `sew_${s}`, a: { pattern: 'top', segment: `top_${s}` }, b: { pattern: 'under', segment: `under_${s}` }, flip: false })),
    elastics: ['left', 'right'].map((s) => ({ id: `edge_${s}`, pattern: 'strip', segment: `strip_${s}`, ratio: 0.6, stiffness: 0.5 })), stuffing: [{ id: 'fill', patterns: ['top', 'under'], volume: 0.8 }],
    attachments: [{ id: 'l', pattern: 'strip', at: [0, 300], to: [0, 0, 1000] }, { id: 'r', pattern: 'strip', at: [40, 300], to: [40, 0, 1000] }, ...[[0, 0], [200, 0], [200, 200], [0, 200]].map((c, k) => ({ id: `corner_${k}`, pattern: 'top', at: c, to: [300 + c[0], c[1], 500] }))],
    arrangement: [{ pattern: 'strip', position: [0, 0, 700], rotation: [90, 0, 0] }, { pattern: 'top', position: [300, 0, 500], rotation: [0, 0, 0] }, { pattern: 'under', position: [300, 0, 490], rotation: [0, 0, 0] }] };
  const { check, document, ...page } = await inputFor(design), input = simulationInput(document, 25);
  assert.deepEqual(page, JSON.parse(JSON.stringify(input)), 'the drape starts from what the page is given, elastics and stuffing included');
  assert.equal(input.elastics.length, 2); assert.equal(input.stuffing[0].id, 'fill'); assert.equal(input.materials.canvas.arealDensity, 270, 'and from the preset fabric, filled in');
  const drape = drapeDocument(document), f = simulate(input, drape.steps);
  assert.ok(drape.settled && drape.steps < 300, `settled after ${drape.steps} steps, moving ${drape.residual.toFixed(4)} mm a step, at the pillow's 23 substeps`);
  for (const p of drape.pieces) assert.deepEqual(p.positions, f.positions.slice(p.off * 3, (p.off + p.count) * 3), `${p.id} is draped where the page's solver puts it`);
  const strip = drape.pieces[0], edge = meshOf(page, 'strip').segmentVertices.strip_left, length = edge.reduce((n, v, i) => i ? n + dist([0, 1, 2].map((k) => strip.positions[v * 3 + k]), [0, 1, 2].map((k) => strip.positions[edge[i - 1] * 3 + k])) : 0, 0);
  assert.ok(length > 179 && length < 190, `the elastic edge of the draped strip is ${length.toFixed(1)} mm`); assert.ok(f.stuffing[0].volume > 0.72 && f.stuffing[0].volume <= 0.8, `the draped pillow holds ${f.stuffing[0].volume.toFixed(3)} L`);
  assert.deepEqual(billOfMaterials(document).trims, [{ kind: 'elastic', id: 'edge_left', count: 1, lengthMm: 180 }, { kind: 'elastic', id: 'edge_right', count: 1, lengthMm: 180 }]);
});

test('a pleat made by the pleat edit, given an angle, stands creased along its three fold lines in the drape', () => {
  // The fold angle at every mesh edge along a run of vertices, in degrees, positive toward the face of the pattern.
  const sub = (a, b) => a.map((v, i) => v - b[i]), cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]], dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const folds = (m, chain, at) => chain.slice(1).map((b, k) => { const a = chain[k], opp = []; for (let t = 0; t < m.triangles.length; t += 3) { const tri = [0, 1, 2].map((j) => m.triangles[t + j]); if (tri.includes(a) && tri.includes(b)) opp.push(tri.find((v) => v !== a && v !== b)); }
    const U = (i) => [m.uv[i * 2], m.uv[i * 2 + 1]], left = (U(b)[0] - U(a)[0]) * (U(opp[0])[1] - U(a)[1]) - (U(b)[1] - U(a)[1]) * (U(opp[0])[0] - U(a)[0]) > 0, [x1, x2, x3, x4] = [opp[left ? 0 : 1], opp[left ? 1 : 0], a, b].map(at), N1 = cross(sub(x1, x3), sub(x1, x4)), N2 = cross(sub(x2, x4), sub(x2, x3)), E = sub(x4, x3);
    return Math.atan2(-dot(cross(N1, N2), E) / Math.hypot(...E), dot(N1, N2)) * 180 / Math.PI; });
  const median = (v) => [...v].sort((p, q) => p - q)[Math.floor(v.length / 2)];
  for (const angle of [90, -90]) {
    let d = validateSoftgoodsDocument({ version: 1, materials: { canvas: { ...canvas, rigidity: 0.5 } }, patterns: [rect('panel', 300, 200)], seams: [], arrangement: [] });
    d = editSoftgoods(d, { op: 'pleat', pattern: 'panel', segment: 'panel_top', at: 0.5, intake: 40, bothEnds: true, id: 'tuck' });
    d.annotations.find((a) => a.id === 'tuck').angle = angle; d.arrangement = [{ pattern: 'panel', position: [0, 0, 1000], rotation: [0, 0, 0] }]; d = validateSoftgoodsDocument(d);
    // Into the pleat, back on itself at the fold in the middle, and level again: the middle fold turns twice as far, the other way (held 5° short of flat on itself).
    const input = simulationInput(d, 20), m = input.meshes[0]; assert.deepEqual(input.folds.map((q) => q.angle), [angle, -2 * angle, angle]); assert.equal(m.lineVertices.length, 3);
    const drape = drapeDocument(d, { target: 20, steps: 120 }), pos = drape.pieces[0].positions, at = (i) => [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]], want = [angle, -Math.sign(angle) * 175, angle];
    m.lineVertices.forEach((chain, k) => { const got = median(folds(m, chain, at)); assert.ok(Math.abs(got - want[k]) < 8, `fold line ${k + 1} of the ${angle}° pleat is creased ${got.toFixed(0)}°, wanted ${want[k]}°`); });
    for (const s of drape.seams) for (const pair of s.pairs) { const [a, b] = [pair.a, pair.b].map((side) => side.vertices.reduce((q, v, j) => q.map((x, i) => x + at(v)[i] * side.weights[j]), [0, 0, 0])); assert.ok(dist(a, b) < 2, `pleat seam ${s.id} is sewn shut`); }
  }
});

test('an elastic in a seam gathers both of its sides alike', async () => {
  // Two strips sewn edge to edge with an elastic in the seam.
  const sewn = await inputFor({ materials: { canvas }, patterns: [rect('a', 40, 200), rect('b', 40, 200)], seams: [{ id: 'join', a: { pattern: 'a', segment: 'a_right' }, b: { pattern: 'b', segment: 'b_left' }, flip: true, elastic: { ratio: 0.7, stiffness: 1 } }],
    arrangement: [{ pattern: 'a', position: [0, 0, 0.3], rotation: [0, 0, 0] }, { pattern: 'b', position: [41, 0, 0.3], rotation: [0, 0, 0] }] }, 20);
  assert.deepEqual(sewn.elastics.map((e) => [e.id, e.pattern, e.ratio, e.stiffness]), [['join', 'a', 0.7, 1], ['join', 'b', 0.7, 0]], 'both sides gather; the spring is on one');
  // Lying flat, each strip would have to fan away from the other to gather all the way, so the seam draws up part of the way to its
  // 140 mm (ruffling out of the floor is what real cloth does, and nothing here starts it). Both sides gather alike and the cloth is not strained.
  const f = simulate({ ...sewn, collisionBody: floor }, 180), sides = [run(f, sewn, 'a', meshOf(sewn, 'a').segmentVertices.a_right), run(f, sewn, 'b', meshOf(sewn, 'b').segmentVertices.b_left)];
  assert.ok(sides[0] > 139 && sides[0] < 175, `the seam drew up from 200 to ${sides[0].toFixed(1)} mm`); within(sides[1], sides[0], 0.01, 'the other side of the seam'); assert.ok(f.diagnostics.strain.max < 0.03);
  // A seam that sews only part of an edge: 200 mm of strip a to the middle 200 mm of a 300 mm edge of b. The elastic lies on that span of b and nowhere else.
  const span = await inputFor({ materials: { canvas }, patterns: [rect('a', 40, 200), rect('b', 40, 300)], seams: [{ id: 'join', a: { pattern: 'a', segment: 'a_right' }, b: { pattern: 'b', segment: 'b_left', from: 1 / 6, to: 5 / 6 }, flip: true, elastic: { ratio: 0.7, stiffness: 1 } }],
    arrangement: [{ pattern: 'a', position: [0, 0, 0.3], rotation: [0, 0, 0] }, { pattern: 'b', position: [41, -50, 0.3], rotation: [0, 0, 0] }] }, 20), onB = span.elastics[1], ys = onB.chain.map((v) => meshOf(span, 'b').uv[v * 2 + 1]);
  assert.deepEqual([onB.pattern, onB.ratio, onB.stiffness], ['b', 0.7, 0]); assert.ok(Math.min(...ys) >= 50 - 1e-6 && Math.max(...ys) <= 250 + 1e-6 && Math.max(...ys) - Math.min(...ys) >= 160, `the elastic on b runs from ${Math.min(...ys)} to ${Math.max(...ys)} mm of its 300`);
  assert.deepEqual(span.check.physics.map((p) => [p.id, p.length, p.relaxed]), [['join', 200, 140]]);
  const h = simulate({ ...span, collisionBody: floor }, 180), drawn = run(h, span, 'a', meshOf(span, 'a').segmentVertices.a_right);
  assert.ok(drawn < 185 && h.positions.every(Number.isFinite), `the sewn span drew up to ${drawn.toFixed(1)} mm`); assert.ok(h.diagnostics.strain.max < 0.04);
});

test('the simulation mesh follows a line drawn inside a pattern, and is untouched without one', () => {
  const panel = rect('panel', 200, 120), plain = meshPattern(panel, { target: 20 });
  assert.deepEqual(meshPattern(panel, { target: 20, lines: [] }), plain);
  for (const line of [[[0, 60], [200, 60]], [[37, 11], [171, 103]], [[100, 0], [100, 120]]]) {
    const m = meshPattern(panel, { target: 20, lines: [line] }), chain = m.lineVertices[0], edges = new Set(); for (let i = 0; i < m.edges.length; i += 2) { edges.add(`${m.edges[i]}/${m.edges[i + 1]}`); edges.add(`${m.edges[i + 1]}/${m.edges[i]}`); }
    assert.deepEqual([chain[0], chain.at(-1)].map((v) => [m.uv[v * 2], m.uv[v * 2 + 1]]), line, 'the run starts and ends on the line');
    for (let k = 1; k < chain.length; k++) assert.ok(edges.has(`${chain[k - 1]}/${chain[k]}`), 'every step of the run is an edge of the mesh');
    assert.ok(chain.length >= 6 && m.uv.length < plain.uv.length * 1.5, `${chain.length} vertices on the line, ${m.uv.length / 2} in all against ${plain.uv.length / 2}`);
    let area = 0; for (let i = 0; i < m.triangles.length; i += 3) { const [a, b, c] = [0, 1, 2].map((k) => [m.uv[m.triangles[i + k] * 2], m.uv[m.triangles[i + k] * 2 + 1]]); area += Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2; } assert.ok(Math.abs(area - 200 * 120) < 1e-6, 'the triangles still cover the panel once');
  }
  assert.throws(() => meshPattern(panel, { target: 20, lines: [[[100, 60], [300, 60]]] }), /leaves its outline/);
});

test('a tack holds two panels together at one point and leaves the rest to hang; a pin holds the very point it names', async () => {
  // Panel a hangs from two pins. Panel b is tacked to it by one point near its own top edge and by nothing else.
  const input = await inputFor({ materials: { canvas }, patterns: [rect('a', 200, 200), rect('b', 200, 200)], seams: [], arrangement: [{ pattern: 'a', position: [0, 0, 800], rotation: [90, 0, 0] }, { pattern: 'b', position: [0, -10, 720], rotation: [90, 0, 0] }],
    attachments: [{ id: 'pin_l', pattern: 'a', at: [0, 200], to: [0, 0, 1000] }, { id: 'pin_r', pattern: 'a', at: [200, 200], to: [200, 0, 1000] }, { id: 'tack', pattern: 'b', at: [93, 177], to: { pattern: 'a', at: [107, 93] } }] });
  const f = simulate(input, 240), on = { a: at(f, input, 'a', [107, 93]), b: at(f, input, 'b', [93, 177]) };
  assert.ok(dist(on.a, on.b) < 0.5, `the tacked points are ${dist(on.a, on.b).toFixed(3)} mm apart: neither is a mesh vertex`);
  within(on.b[2] - extent(f, 'b', 2)[0], 177 + 20, 0.15, 'b hangs from the tack by its own length');
  for (const corner of [[0, 200], [200, 200]]) assert.ok(at(f, input, 'b', corner)[2] < on.b[2] - 30, 'the corners of b above the tack have fallen over: nothing else holds it');
  assert.deepEqual(input.check.physics, [{ id: 'tack', kind: 'tack', ok: true, note: "holds 'b' to 'a'" }]);
  // exact: the point itself is held, not the vertex nearest to it. strength: the pin is a spring, and sags by weight / stiffness.
  const one = (attachments) => inputFor({ materials: { canvas }, patterns: [rect('a', 200, 200)], seams: [], arrangement: [{ pattern: 'a', position: [0, 0, 800], rotation: [90, 0, 0] }], attachments });
  const exact = await one([{ id: 'p', pattern: 'a', at: [100, 188], to: [100, 0, 988], exact: true }]); assert.ok(dist(at(simulate(exact, 120), exact, 'a', [100, 188]), [100, 0, 988]) < 0.01);
  const snapped = await one([{ id: 'p', pattern: 'a', at: [100, 188], to: [100, 0, 988] }]); assert.ok(dist(at(simulate(snapped, 120), snapped, 'a', [100, 188]), [100, 0, 988]) > 3, 'without exact the nearest vertex, 8 mm away, is taken to the target, as before');
  const soft = await one([{ id: 'p', pattern: 'a', at: [100, 200], to: [100, 0, 1000], exact: true, strength: 0.01 }]);
  within(1000 - at(simulate(soft, 480), soft, 'a', [100, 200])[2], 0.04 * 340 * 9.81e-3 / 0.01, 0.1, 'the sag of a 0.01 N/mm pin under the panel');
});

test('two sewn squares stuffed into a pillow: more pressure, more volume, and the cloth does not stretch to make room', async () => {
  const pillow = (stuffing) => inputFor({ materials: { canvas }, patterns: [rect('top', 200, 200), rect('under', 200, 200)], seams: ['bottom', 'right', 'top', 'left'].map((s) => ({ id: `sew_${s}`, a: { pattern: 'top', segment: `top_${s}` }, b: { pattern: 'under', segment: `under_${s}` }, flip: false })),
    arrangement: [{ pattern: 'top', position: [-100, -100, 12], rotation: [0, 0, 0] }, { pattern: 'under', position: [-100, -100, 2], rotation: [0, 0, 0] }], stuffing: [{ id: 'fill', patterns: ['top', 'under'], ...stuffing }] });
  // The volume inside, measured here from the triangles: the top square faces up and the one under it faces down.
  const volume = (f, input) => { let v = 0; for (const [id, sign] of [['top', 1], ['under', -1]]) { const m = meshOf(input, id), off = piece(f, id).off; for (let t = 0; t < m.triangles.length; t += 3) { const [a, b, c] = [0, 1, 2].map((k) => P(f, off + m.triangles[t + k])), [ua, ub, uc] = [0, 1, 2].map((k) => [m.uv[m.triangles[t + k] * 2], m.uv[m.triangles[t + k] * 2 + 1]]), wound = Math.sign((ub[0] - ua[0]) * (uc[1] - ua[1]) - (ub[1] - ua[1]) * (uc[0] - ua[0])); v += sign * wound * (a[0] * (b[1] * c[2] - b[2] * c[1]) + a[1] * (b[2] * c[0] - b[0] * c[2]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6; } } return v / 1e6; };
  const filled = {};
  for (const pressure of [10, 150]) { const input = await pillow({ pressure }), f = simulate({ ...input, collisionBody: floor }, 150); filled[pressure] = volume(f, input);
    if (pressure === 150) within(f.stuffing[0].volume, filled[pressure], 0.01, `the volume the solver reports at ${pressure} Pa`); assert.equal(f.stuffing[0].pressure, pressure);
    assert.ok(f.diagnostics.strain.max < 0.05, `at ${pressure} Pa the cloth is strained ${(f.diagnostics.strain.max * 100).toFixed(1)}%`); }
  assert.ok(filled[10] > 0.2 && filled[150] > filled[10] * 1.5, `${filled[10].toFixed(2)} L at 10 Pa, which barely lifts the top square, and ${filled[150].toFixed(2)} L at 150 Pa`);
  // Two 200 mm squares of cloth that does not stretch hold at most 0.19 × 200³ mm³ = 1.52 L (the paper-bag problem), however hard they are blown up.
  assert.ok(filled[150] < 1.52 * 1.12, `the pillow holds ${filled[150].toFixed(2)} L: cloth that stretched would hold more`);
  // A target volume instead: the fill stops pushing as the pillow reaches it.
  const input = await pillow({ volume: 0.8 }), f = simulate({ ...input, collisionBody: floor }, 150);
  assert.ok(f.stuffing[0].volume > 0.72 && f.stuffing[0].volume <= 0.8, `filled to ${f.stuffing[0].volume.toFixed(3)} of 0.8 L`); assert.ok(f.stuffing[0].pressure < 20 && f.diagnostics.strain.max < 0.02);
  assert.deepEqual(input.check.physics, [{ id: 'fill', kind: 'stuffing', ok: true, note: 'fills toward 0.8 L' }]);
});

test('a strip of stiff cloth with a 90° fold line settles on a table at a right angle', async () => {
  const strip = rect('strip', 200, 40); strip.points.push({ id: 'fold_a', x: 100, y: 0 }, { id: 'fold_b', x: 100, y: 40 });
  const folded = (angle, target) => inputFor({ materials: { canvas: { ...canvas, rigidity: 2 } }, patterns: [strip], seams: [], arrangement: [{ pattern: 'strip', position: [-100, -20, 0.3], rotation: [0, 0, 0] }], annotations: [{ id: 'crease', type: 'fold_line', pattern: 'strip', lines: [['fold_a', 'fold_b']], angle }] }, target);
  // The angle between the two halves, from the normals of their triangles away from the fold itself.
  const turn = (f, input) => { const m = meshOf(input, 'strip'), n = [[0, 0, 0], [0, 0, 0]]; for (let t = 0; t < m.triangles.length; t += 3) { const ids = [0, 1, 2].map((k) => m.triangles[t + k]), u = ids.reduce((s, i) => s + m.uv[i * 2], 0) / 3; if (Math.abs(u - 100) < 25) continue; const [a, b, c] = ids.map((i) => P(f, i)), wound = Math.sign((m.uv[ids[1] * 2] - m.uv[ids[0] * 2]) * (m.uv[ids[2] * 2 + 1] - m.uv[ids[0] * 2 + 1]) - (m.uv[ids[1] * 2 + 1] - m.uv[ids[0] * 2 + 1]) * (m.uv[ids[2] * 2] - m.uv[ids[0] * 2])), e = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], g = [c[0] - a[0], c[1] - a[1], c[2] - a[2]], side = n[u < 100 ? 0 : 1]; side[0] += wound * (e[1] * g[2] - e[2] * g[1]); side[1] += wound * (e[2] * g[0] - e[0] * g[2]); side[2] += wound * (e[0] * g[1] - e[1] * g[0]); } return Math.acos((n[0][0] * n[1][0] + n[0][1] * n[1][1] + n[0][2] * n[1][2]) / (Math.hypot(...n[0]) * Math.hypot(...n[1]))) * 180 / Math.PI; };
  for (const target of [20, 10]) { const input = await folded(90, target), f = simulate({ ...input, collisionBody: floor }, 240), angle = turn(f, input);
    assert.ok(Math.abs(angle - 90) < 8, `at ${target} mm the halves meet at ${angle.toFixed(1)}°`); assert.ok(extent(f, 'strip', 2)[1] > 80, 'one half stands on the other'); assert.ok(f.diagnostics.strain.max < 0.02); }
  const flat = await folded(0, 20); assert.equal(flat.folds, undefined, 'a fold of 0° is only a mark'); assert.ok(turn(simulate({ ...flat, collisionBody: floor }, 60), flat) < 1);
  // A pleat is folded one way and then the other.
  const pleated = rect('skirt', 200, 100); pleated.points.push({ id: 'in_a', x: 80, y: 0 }, { id: 'in_b', x: 80, y: 100 }, { id: 'out_a', x: 120, y: 0 }, { id: 'out_b', x: 120, y: 100 });
  const pleat = await inputFor({ materials: { canvas }, patterns: [pleated], seams: [], annotations: [{ id: 'knife', type: 'pleat', pattern: 'skirt', lines: [['in_a', 'in_b'], ['out_a', 'out_b']], angle: 170 }] });
  assert.deepEqual(pleat.folds.map((q) => q.angle), [170, -170]);
});

test('shrinkage shortens a piece along its warp and weft, a frozen piece stays put, a strengthened one stretches less', async () => {
  // Grain 90°: the warp runs up the strip. 5% off the 300 mm and 10% off the 100 mm, measured along its edges as it lies on a floor.
  const shrunk = await inputFor({ materials: { canvas }, patterns: [rect('strip', 100, 300, { shrink: { warp: 5, weft: 10 } })], seams: [], arrangement: [{ pattern: 'strip', position: [0, 0, 0.3], rotation: [0, 0, 0] }] }, 20), f = simulate({ ...shrunk, collisionBody: floor }, 120);
  within(run(f, shrunk, 'strip', meshOf(shrunk, 'strip').segmentVertices.strip_left), 285, 0.01, 'the shrunk warp'); within(run(f, shrunk, 'strip', meshOf(shrunk, 'strip').segmentVertices.strip_bottom), 90, 0.01, 'the shrunk weft');
  assert.ok(Math.abs(f.diagnostics.strain.max) < 0.005 && Math.abs(f.diagnostics.strain.min) < 0.005, 'shrunk cloth is at rest, not strained'); assert.equal(shrunk.check.physics[0].ok, true);
  // A frozen piece in mid air does not fall, to the last bit, and a loose sheet dropped on it lands on it.
  const d = { materials: { canvas }, patterns: [rect('held', 200, 200, { freeze: true }), rect('loose', 100, 100), rect('falling', 100, 100)], seams: [], arrangement: [{ pattern: 'held', position: [-100, -100, 500], rotation: [0, 0, 0] }, { pattern: 'loose', position: [-45, -52, 505], rotation: [0, 0, 0] }, { pattern: 'falling', position: [300, 0, 500], rotation: [0, 0, 0] }] };
  const frozen = await inputFor(d), before = simulate(frozen, 0), after = simulate(frozen, 120), held = piece(after, 'held');
  assert.deepEqual(after.positions.slice(held.off * 3, (held.off + held.count) * 3), before.positions.slice(held.off * 3, (held.off + held.count) * 3)); assert.ok(after.positions.every(Number.isFinite));
  assert.ok(extent(after, 'falling', 2)[1] < 0, 'the piece beside it fell'); const landed = extent(after, 'loose', 2); assert.ok(landed[0] > 500.3 && landed[1] < 501.5, `the sheet over it rests on it: ${landed}`);
  // The same heavy, stretchy strip, hung: four times as strong, about a quarter of the stretch.
  const hung = async (strengthen) => { const input = await inputFor({ materials: { canvas: { arealDensity: 3000, thickness: 0.6, damping: 0.05, tensile: { warp: 0.02, weft: 0.02 }, shearRigidity: 0.02 } }, patterns: [rect('strip', 40, 300, strengthen ? { strengthen } : {})], seams: [], arrangement: [{ pattern: 'strip', position: [0, 0, 700], rotation: [90, 0, 0] }], attachments: [0, 20, 40].map((x) => ({ id: `pin_${x}`, pattern: 'strip', at: [x, 300], to: [x, 0, 1000] })) }, 20), z = extent(simulate(input, 360), 'strip', 2); return z[1] - z[0] - 300; };
  const plain = await hung(), strong = await hung(4); assert.ok(plain > 20 && plain / strong > 2.5 && plain / strong < 4.5, `stretched ${plain.toFixed(1)} mm, strengthened ${strong.toFixed(1)} mm`);
});

test('two panels on the same region keep the order of their layers against the body, whichever way they start', async () => {
  // A lining and a shell hung by their top corners and pushed 40 mm into the chest, so the body presses one against the other.
  const design = (lining, shell) => ({ materials: { canvas }, patterns: [['lining', lining], ['shell', shell]].map(([id, layer]) => rect(id, 300, 400, { placement: { region: 'front', anchor: 'shoulder', layer, offset: [0, 40, -150] } })), seams: [], simulation: { avatar: { height: 1700, chest: 900 } } });
  const input = await inputFor(design(0, 1), 30), start = simulate(input, 0), [inner, outer] = input.arrangement;
  assert.deepEqual([inner.layer, outer.layer], [0, 1]); assert.equal(outer.position[1], inner.position[1] - 10, 'the shell starts 10 mm farther out from the front of the body');
  const corners = (id) => [[0, 400], [300, 400]].map((uv, k) => ({ id: `${id}_${k}`, pattern: id, at: uv, to: at(start, input, id, uv) }));
  // The gap from lining to shell at each vertex (the two meshes are the same), outward from the front of the body.
  const gaps = (f) => { const a = piece(f, 'lining'), b = piece(f, 'shell'), out = []; for (let i = 0; i < a.count; i++) out.push(P(f, a.off + i)[1] - P(f, b.off + i)[1]); return out; };
  const draped = gaps(simulate({ ...input, attachments: [...corners('lining'), ...corners('shell')] }, 240));
  assert.ok(Math.min(...draped) > 0.3, `the shell is outside the lining everywhere: the closest is ${Math.min(...draped).toFixed(2)} mm, and the cloth is 0.6 mm thick`);
  assert.ok(draped.filter((g) => g < 1.5).length > 10, 'and the body does press them together');
  // Started the wrong way round, 6 mm through each other, they are put in order.
  const crossed = gaps(simulate({ ...input, attachments: [...corners('lining'), ...corners('shell')], arrangement: [{ ...inner, position: [inner.position[0], inner.position[1] - 8, inner.position[2]] }, { ...outer, position: [outer.position[0], outer.position[1] + 8, outer.position[2]] }] }, 240));
  assert.ok(crossed.filter((g) => g < 0.3).length <= 2 * 2, `${crossed.filter((g) => g < 0.3).length} vertices are still inside out: only the pinned corners may be`);
  // The other way round in the design, the other way round in the cloth.
  const turned = await inputFor(design(1, 0), 30), begun = simulate(turned, 0), pins = (id) => [[0, 400], [300, 400]].map((uv, k) => ({ id: `${id}_${k}`, pattern: id, at: uv, to: at(begun, turned, id, uv) }));
  assert.ok(Math.max(...gaps(simulate({ ...turned, attachments: [...pins('lining'), ...pins('shell')] }, 240))) < -0.3);
});

test('the new fields are validated with a reason, checked, and carried by the prompt tool', async () => {
  const base = () => ({ version: 1, patterns: [rect('a', 100, 100), rect('b', 100, 100)], seams: [{ id: 'join', a: { pattern: 'a', segment: 'a_right' }, b: { pattern: 'b', segment: 'b_left' }, flip: true }] });
  const bad = (change, reason) => { const d = base(); change(d); assert.throws(() => validateSoftgoodsDocument(d), reason); };
  bad((d) => { d.seams[0].elastic = { ratio: 1.4 }; }, /Seam 'join' elastic needs a ratio above 0 and at most 1/);
  bad((d) => { d.elastics = [{ id: 'e', pattern: 'a', segment: 'a_top', ratio: 0.6, stiffness: -1 }]; }, /stiffness must be positive/);
  bad((d) => { d.elastics = [{ id: 'e', pattern: 'a', segment: 'a_top', line: ['a_bl', 'a_tr'], ratio: 0.6 }]; }, /give segment or line/);
  bad((d) => { d.elastics = [{ id: 'e', pattern: 'a', segment: 'nowhere', ratio: 0.6 }]; }, /missing segment 'a\.nowhere'/);
  bad((d) => { d.elastics = [{ id: 'e', pattern: 'a', line: ['a_bl', 'b_tr'], ratio: 0.6 }]; }, /two different points of pattern 'a'/);
  bad((d) => { d.elastics = [{ id: 'e', pattern: 'a', line: 'casing', ratio: 0.6 }]; }, /missing internal line 'a\.casing'/);
  bad((d) => { d.patterns[0].points.push({ id: 'h1', x: 30, y: 60 }, { id: 'h2', x: 60, y: 30 }); d.patterns[0].internalLines = [{ id: 'casing', type: 'bezier', a: 'a_bl', b: 'a_tr', c1: 'h1', c2: 'h2' }]; d.elastics = [{ id: 'e', pattern: 'a', line: 'casing', ratio: 0.6 }]; }, /follows a straight line, and internal line 'casing' is curved \(bezier\)/);
  bad((d) => { d.attachments = [{ id: 't', pattern: 'a', at: [10, 10], to: { pattern: 'c', at: [1, 1] } }]; }, /tacks to missing pattern 'c'/);
  bad((d) => { d.attachments = [{ id: 't', pattern: 'a', at: [10, 10], to: [0, 0, 0], strength: 0 }]; }, /strength must be positive/);
  bad((d) => { d.stuffing = [{ id: 's', patterns: ['a', 'b'] }]; }, /needs a pressure \(Pa\) or a volume \(litres\)/);
  bad((d) => { d.stuffing = [{ id: 's', patterns: ['a', 'z'], pressure: 100 }]; }, /ids of the patterns that enclose it/);
  bad((d) => { d.annotations = [{ id: 'd', type: 'dart', pattern: 'a', lines: [['a_bl', 'a_tr']], angle: 30 }]; }, /only a fold_line or a pleat takes an angle/);
  bad((d) => { d.annotations = [{ id: 'f', type: 'fold_line', pattern: 'a', lines: [['a_bl', 'a_tr']], angle: 200 }]; }, /between -180 and 180/);
  bad((d) => { d.patterns[0].shrink = { warp: 150 }; }, /shrink must be \{ warp, weft \} in percent/);
  bad((d) => { d.patterns[0].freeze = 'yes'; }, /freeze must be true or false/);
  bad((d) => { d.patterns[0].strengthen = 0; }, /strengthen must be a positive multiplier/);
  bad((d) => { d.arrangement = [{ pattern: 'a', position: [0, 0, 0], rotation: [0, 0, 0], layer: 'outer' }]; }, /layer must be a number/);

  // The check says what to cut and flags what cannot be meant.
  const design = { ...base(), elastics: [{ id: 'cuff', pattern: 'a', segment: 'a_bottom', ratio: 0.2 }], stuffing: [{ id: 'fill', patterns: ['a'], pressure: 100 }, { id: 'pad', patterns: ['a', 'b'], volume: 0.2 }],
    attachments: [{ id: 'tack', pattern: 'a', at: [50, 500], to: { pattern: 'b', at: [50, 50] } }, { id: 'plain_pin', pattern: 'a', at: [0, 0], to: [0, 0, 0] }], annotations: [{ id: 'crease', type: 'fold_line', pattern: 'a', lines: [['a_bl', 'a_tr']], angle: 90 }] };
  design.patterns[1].shrink = { warp: 40, weft: 2 }; design.patterns[0].strengthen = 2; design.seams[0].elastic = { ratio: 0.8, stiffness: 6 };
  const check = checkDesign(validateSoftgoodsDocument(design)), row = (id) => check.physics.find((p) => p.id === id);
  assert.equal(check.ok, false); assert.equal(row('cuff').ok, false); assert.match(row('cuff').note, /under a third/); assert.deepEqual([row('join').ok, row('join').relaxed], [true, 80]);
  assert.equal(row('fill').ok, false); assert.match(row('fill').note, /the volume is open/); assert.equal(row('pad').ok, true);
  assert.equal(row('tack').ok, false); assert.match(row('tack').note, /off pattern 'a'/); assert.equal(row('plain_pin'), undefined, 'an attachment as it always was is not reported');
  assert.equal(row('b').ok, false); assert.match(row('b').note, /shrink is in percent/);
  assert.equal(checkDesign(validateSoftgoodsDocument(base())).physics, undefined);

  // The prompt tool's schema takes every one of them and sends them on; its guide says what each is.
  const tools = {}, sent = [];
  registerSoftgoodsTools({ registerTool: (name, spec, handler) => { tools[name] = { spec, handler }; } }, { call: async (p, opts) => { sent.push([p, opts]); return p.endsWith('/check') ? { ok: true } : { revision: 1, patterns: [], seams: [], arrangement: [] }; }, ok: (v) => v, fail: (e) => { throw e; } });
  const { version, ...authored } = design, parsed = z.object(tools.cadgang_softgoods_set.spec.inputSchema).parse(authored); await tools.cadgang_softgoods_set.handler(parsed);
  const body = sent[0][1].body; for (const key of ['elastics', 'stuffing', 'attachments', 'annotations']) assert.deepEqual(body[key], design[key], key);
  assert.deepEqual(body.seams[0].elastic, { ratio: 0.8, stiffness: 6 }); assert.deepEqual(body.patterns[1].shrink, { warp: 40, weft: 2 }); assert.equal(body.patterns[0].strengthen, 2);
  assert.throws(() => z.object(tools.cadgang_softgoods_set.spec.inputSchema).parse({ ...authored, elastics: [{ id: 'e', pattern: 'a', segment: 'a_top', ratio: 2 }] }));
  for (const word of [/elastic \{ratio, stiffness\}/, /to:\{pattern, at:\[x,y\]\}/, /stuffing \[\{id, patterns/, /fold_line or pleat annotation creases/, /shrink \{warp, weft\}/, /freeze:true/, /strengthen/, /higher layer/]) assert.match(tools.cadgang_softgoods_set.spec.description, word);
});
