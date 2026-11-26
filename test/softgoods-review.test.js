// The softgoods path end to end: a prompt-authored design is checked, meshed, stood around the avatar, draped by the
// page's own solver and exported at every size. These run the code, where the older tests read its source.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { z } from 'zod';
import { SoftgoodsDocument } from '../src/core/softgoods-document.js';
import { meshPattern } from '../src/core/softgoods-mesh.js';
import { resolveSeamCorrespondence } from '../src/core/softgoods-seams.js';
import { arrangePatternsAroundAvatar, avatarBody } from '../src/core/softgoods-arrange.js';
import { checkDesign } from '../src/core/softgoods-operations.js';
import { exportSoftgoods } from '../src/core/softgoods-export.js';
import { softgoodsRouter } from '../src/server/softgoods.js';
import { registerSoftgoodsTools } from '../src/mcp/softgoods.js';
import { simulate } from '../web/softgoods-worker.js';

const outline = (id, corners, extra = {}) => { const names = Object.keys(corners); return { id, name: id, material: 'canvas', cut: 1, points: names.map((k) => ({ id: `${id}_${k}`, x: corners[k][0], y: corners[k][1] })), ...extra }; };
const rect = (id, w, h, extra = {}) => { const s = ['bottom', 'right', 'top', 'left'], p = ['bl', 'br', 'tr', 'tl']; return { ...outline(id, { bl: [0, 0], br: [w, 0], tr: [w, h], tl: [0, h] }, extra), segments: s.map((n, i) => ({ id: `${id}_${n}`, type: 'line', a: `${id}_${p[i]}`, b: `${id}_${p[(i + 1) % 4]}` })), contours: [s.map((n) => `${id}_${n}`)], allowances: Object.fromEntries(s.map((n) => [`${id}_${n}`, 10])), notches: [], grain: { angle: 90 } }; };
// A sleeveless tunic: two panels, shoulder and side seams, the neck and armholes left open.
function tunic() {
  const panel = (id, region) => { const seg = [['bottom', 'bl', 'br'], ['side_r', 'br', 'ar'], ['arm_r', 'ar', 'tr'], ['shoulder_r', 'tr', 'nr'], ['neck', 'nr', 'nl'], ['shoulder_l', 'nl', 'tl'], ['arm_l', 'tl', 'al'], ['side_l', 'al', 'bl']];
    return { ...outline(id, { bl: [0, 0], br: [520, 0], ar: [520, 450], tr: [520, 700], nr: [380, 700], nl: [140, 700], tl: [0, 700], al: [0, 450] }, { placement: { region, anchor: 'shoulder' } }), segments: seg.map(([s, a, b]) => ({ id: `${id}_${s}`, type: 'line', a: `${id}_${a}`, b: `${id}_${b}` })), contours: [seg.map(([s]) => `${id}_${s}`)], allowances: Object.fromEntries(seg.map(([s]) => [`${id}_${s}`, 10])), notches: [], grain: { angle: 90 } }; };
  const seam = (id, a, b) => ({ id, a: { pattern: 'front', segment: `front_${a}` }, b: { pattern: 'back', segment: `back_${b}` }, flip: true });
  return { version: 1, materials: { canvas: { name: '12 oz canvas', arealDensity: 340, thickness: 0.6 } }, patterns: [panel('front', 'front'), panel('back', 'back')],
    seams: [seam('shoulder_right', 'shoulder_r', 'shoulder_l'), seam('shoulder_left', 'shoulder_l', 'shoulder_r'), seam('side_right', 'side_r', 'side_l'), seam('side_left', 'side_l', 'side_r')] };
}
const P = (frame, i) => [frame.positions[i * 3], frame.positions[i * 3 + 1], frame.positions[i * 3 + 2]];

test('a simulation mesh is near its target size, well shaped, and uses every vertex', () => {
  const m = meshPattern(rect('panel', 500, 600), { target: 30 }), n = m.uv.length / 2, at = (i) => [m.uv[i * 2], m.uv[i * 2 + 1]];
  assert.ok(n > 400 && n < 800, `${n} vertices for a 500 x 600 panel at 30 mm`);
  assert.equal(new Set(m.triangles).size, n, 'a vertex no triangle uses would fall free of the cloth, and a seam could be sewn to it');
  let area = 0, sharpest = 180;
  for (let i = 0; i < m.triangles.length; i += 3) { const q = [0, 1, 2].map((k) => at(m.triangles[i + k])); area += Math.abs((q[1][0] - q[0][0]) * (q[2][1] - q[0][1]) - (q[1][1] - q[0][1]) * (q[2][0] - q[0][0])) / 2;
    for (let k = 0; k < 3; k++) { const u = [q[(k + 1) % 3][0] - q[k][0], q[(k + 1) % 3][1] - q[k][1]], v = [q[(k + 2) % 3][0] - q[k][0], q[(k + 2) % 3][1] - q[k][1]]; sharpest = Math.min(sharpest, Math.acos((u[0] * v[0] + u[1] * v[1]) / (Math.hypot(...u) * Math.hypot(...v))) * 180 / Math.PI); } }
  assert.ok(Math.abs(area - 500 * 600) < 1e-6); assert.ok(sharpest > 15, `sharpest corner ${sharpest.toFixed(1)}°`);
});

test('a placed piece stands centred on its region, and a shoulder anchor hangs its top edge above the shoulder line', () => {
  const { arrangement, avatar } = arrangePatternsAroundAvatar([rect('front', 500, 600, { placement: { region: 'front', anchor: 'shoulder' } }), rect('back', 500, 600, { placement: { region: 'back' } })], { height: 1700, chest: 900 }), body = avatarBody(avatar);
  const [front, back] = arrangement;
  assert.deepEqual(front.rotation, [90, 0, 0]); assert.equal(front.position[0], -250); assert.equal(front.position[2] + 600, body.levels.shoulder + 30);
  assert.equal(back.position[0], 250, 'the back is turned to face out, so its origin is on the other side'); assert.equal(back.position[2] + 300, avatar.centreZ);
  assert.deepEqual(body.shapes.map((s) => s.name), ['torso', 'shoulders', 'neck', 'head']);
  assert.throws(() => arrangePatternsAroundAvatar([rect('a', 10, 10, { placement: { region: 'front', anchor: 'hem' } })]), /centre or shoulder/);
});

test('cloth resting on a body presses on it with its own weight, in pascals', () => {
  const sheet = rect('sheet', 200, 200), mesh = meshPattern(sheet, { target: 25 });
  const frame = simulate({ meshes: [mesh], seams: [], attachments: [], arrangement: [{ pattern: 'sheet', position: [-100, -100, 600.5], rotation: [0, 0, 0] }], materials: { canvas: { arealDensity: 340, thickness: 0.6 } }, patterns: [sheet],
    collisionBody: { shapes: [{ type: 'ellipsoid', c: [0, 0, 500], r: [5000, 5000, 100] }] } }, 120);
  const mean = frame.pressure.reduce((n, v) => n + v, 0) / frame.pressure.length, weight = 0.340 * 9.81;
  assert.equal(frame.diagnostics.pressure.unit, 'Pa'); assert.ok(Math.abs(mean - weight) < 0.1 * weight, `mean contact pressure ${mean.toFixed(2)} Pa, the cloth weighs ${weight.toFixed(2)} Pa`);
});

test('a tunic stood around the avatar closes its seams over the shoulders and hangs there', () => {
  const d = tunic(), placed = arrangePatternsAroundAvatar(d.patterns, { height: 1700, chest: 900 }), body = avatarBody(placed.avatar), meshes = d.patterns.map((p) => meshPattern(p, { target: 30 })), seams = resolveSeamCorrespondence(d.seams, meshes, { spacing: 15 });
  const input = { meshes, seams, attachments: [], arrangement: placed.arrangement, materials: d.materials, patterns: d.patterns, collisionBody: { ...placed.avatar, ...body } };
  const start = simulate(input, 0), offsets = Object.fromEntries(start.pieces.map((p) => [p.id, p.off]));
  assert.ok(P(start, offsets.front).every(Number.isFinite) && Math.abs(P(start, offsets.front)[1] + 146) < 1e-6, 'the front panel stands in front of the body before the first step');
  const frame = simulate(input, 240); let top = -Infinity, low = Infinity, hanging = 0;
  assert.ok(frame.positions.every(Number.isFinite));
  for (let i = 0; i < frame.positions.length / 3; i++) { top = Math.max(top, P(frame, i)[2]); low = Math.min(low, P(frame, i)[2]); }
  assert.ok(Math.abs(top - body.levels.shoulder) < 25, `the shoulder seam rests at the shoulder line: ${top.toFixed(0)} against ${body.levels.shoulder}`);
  assert.ok(low > body.levels.shoulder - 760, `the hem is ${low.toFixed(0)} mm up: the tunic has not slid off`);
  for (const s of seams) for (const pair of s.pairs) { const at = (side, off) => side.vertices.reduce((q, v, k) => P(frame, off + v).map((x, j) => q[j] + x * side.weights[k]), [0, 0, 0]), a = at(pair.a, offsets.front), b = at(pair.b, offsets.back); assert.ok(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 5, `seam ${s.id} is closed: its sides started 292 mm apart`); }
  // Below the armholes the cloth only hangs: it must not read as stretched.
  const front = meshes[0]; for (let i = 0; i < front.uv.length / 2; i++) if (front.uv[i * 2 + 1] < 400) hanging = Math.max(hanging, Math.abs(frame.strain[offsets.front + i]));
  assert.ok(hanging < 0.02, `hanging cloth shows ${(hanging * 100).toFixed(2)}% strain`);
  assert.ok(frame.diagnostics.pressure.available && frame.diagnostics.pressure.max > 1 && frame.body.length === 4);
});

const graded = () => ({ version: 1, patterns: [rect('front', 300, 400), rect('back', 300, 400)], seams: [{ id: 'side', a: { pattern: 'front', segment: 'front_right' }, b: { pattern: 'back', segment: 'back_left' }, flip: true }],
  constraints: [{ id: 'hem', name: 'Front hem', type: 'length', pattern: 'front', segments: ['front_bottom'], target: 300, tolerance: 1 }],
  grades: [{ size: 'L', rules: [['front', 'front_tr'], ['front', 'front_tl'], ['back', 'back_tr'], ['back', 'back_tl']].map(([pattern, point]) => ({ pattern, point, dx: 0, dy: 20 })) }, { size: 'XL', rules: [{ pattern: 'front', point: 'front_tr', dx: 0, dy: 40 }, { pattern: 'front', point: 'front_br', dx: 30, dy: 0 }] }] });

test('the check measures every constraint and both sides of every seam, at the base size and at each graded size', () => {
  const doc = new SoftgoodsDocument(null), check = checkDesign(doc.replace(graded()));
  assert.equal(check.constraints[0].measured, 300); assert.ok(check.seams[0].ok); assert.equal(check.ok, false);
  const [l, xl] = check.sizes; assert.ok(l.ok, 'L lengthens both sides of the seam alike'); assert.equal(l.seams[0].lengthA, 420);
  assert.equal(xl.ok, false); assert.ok(!xl.seams[0].ok, 'XL lengthens one side only'); assert.ok(!xl.constraints[0].withinTolerance); assert.equal(xl.constraints[0].measured, 330);
  assert.throws(() => doc.replace({ ...graded(), grades: [{ size: 'L', rules: [{ pattern: 'front', point: 'nowhere', dx: 0, dy: 1 }] }] }), /missing point 'front\.nowhere'/);
});

test('every graded size is exported as its own DXF per pattern, and the tech pack carries the check', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadgang-soft-grade-')), result = exportSoftgoods(new SoftgoodsDocument(null).replace(graded()), dir, 'tee');
  assert.deepEqual(result.sizes, ['L', 'XL']); assert.deepEqual(result.check.sizes, ['XL']); assert.equal(result.files.filter((f) => f.endsWith('.dxf')).length, 6);
  const base = fs.readFileSync(path.join(dir, 'tee_front.dxf'), 'utf8'), large = fs.readFileSync(path.join(dir, 'tee_front_l.dxf'), 'utf8');
  assert.ok(base.includes('\n400\n') && !base.includes('\n420\n')); assert.ok(large.includes('\n420\n') && large.includes('front L'));
  const pack = JSON.parse(fs.readFileSync(path.join(dir, 'tee_tech-pack.json'), 'utf8')), html = fs.readFileSync(path.join(dir, 'tee_tech-pack.html'), 'utf8');
  assert.equal(pack.check.sizes[1].size, 'XL'); assert.match(html, /GRADED SIZES/); assert.match(html, /measured 300 mm · OK/);
  fs.rmSync(dir, { recursive: true });
});

test('a design set again keeps its avatar; placed pieces stand around it and the rest are laid side by side', async () => {
  const doc = new SoftgoodsDocument(null), app = express(); app.use(express.json()); app.use('/s', softgoodsRouter(doc));
  const server = app.listen(0), call = async (p, method = 'GET', body) => { const r = await fetch(`http://127.0.0.1:${server.address().port}/s${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) }); return r.json(); };
  try {
    const design = { ...tunic(), patterns: [...tunic().patterns, rect('pocket', 120, 140), rect('strap', 40, 300)] };
    const first = await call('/document', 'PUT', { ...design, simulation: { avatar: { height: 1700, chest: 900 } } });
    assert.deepEqual(first.arrangement.map((a) => a.source || 'flat'), ['avatar', 'avatar', 'flat', 'flat']); assert.equal(first.arrangement[3].position[0], 160, 'the strap lies beside the pocket');
    const again = await call('/document', 'PUT', design);
    assert.equal(again.simulation.avatar.chest, 900); assert.equal(again.arrangement[0].source, 'avatar');
    const input = await call('/simulation-input?target=40');
    assert.equal(input.collisionBody.shapes.length, 4); assert.equal(input.meshes.length, 4);
    assert.equal((await call('/check')).ok, true);
  } finally { server.close(); }
});

test('the prompt tool carries everything the document holds: placement, measured materials, constraints, annotations, grades and the avatar', async () => {
  const tools = {}, sent = [];
  registerSoftgoodsTools({ registerTool: (name, spec, handler) => { tools[name] = { spec, handler }; } }, { call: async (p, opts) => { sent.push([p, opts]); return p.endsWith('/check') ? { ok: true } : { revision: 1, patterns: [], seams: [], arrangement: [], simulation: opts?.body?.simulation }; }, ok: (v) => v, fail: (e) => { throw e; } });
  const design = { ...graded(), materials: { canvas: { arealDensity: 340, thickness: 0.6, tensile: { warp: 400, weft: 300 }, shearRigidity: 2, friction: 0.4 } }, annotations: [{ id: 'fold', type: 'fold_line', pattern: 'front', lines: [['front_bl', 'front_tl']] }], avatar: { height: 1700, chest: 900 } };
  design.patterns[0].placement = { region: 'front', anchor: 'shoulder' };
  const parsed = z.object(tools.cadgang_softgoods_set.spec.inputSchema).parse(design), result = await tools.cadgang_softgoods_set.handler(parsed), body = sent[0][1].body;
  assert.deepEqual(body.constraints, design.constraints); assert.deepEqual(body.grades, design.grades); assert.deepEqual(body.annotations, design.annotations);
  assert.deepEqual(body.materials, design.materials); assert.deepEqual(body.patterns[0].placement, { region: 'front', anchor: 'shoulder' }); assert.deepEqual(body.simulation.avatar, design.avatar);
  assert.deepEqual(result.check, { ok: true });
});
