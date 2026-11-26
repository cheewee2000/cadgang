// The draped garment as data: the server-side drape, its GLB and OBJ, measurements on it and the fit report.
// Meshes are coarse (40 to 60 mm) to keep this quick; the numbers asserted hold at the page's 25 to 30 mm too.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { z } from 'zod';
import { GraphError } from '../src/core/errors.js';
import { SoftgoodsDocument, validateSoftgoodsDocument } from '../src/core/softgoods-document.js';
import { meshPattern } from '../src/core/softgoods-mesh.js';
import { arrangePatternsAroundAvatar } from '../src/core/softgoods-arrange.js';
import { drapeDocument, drapeDocumentAsync, simulationInput } from '../src/core/softgoods-drape.js';
import { drapeScene, drapeGLB, drapeOBJ } from '../src/core/softgoods-drape-export.js';
import { measureDrape, geodesic, circumference, bodyCircumference, fitReport } from '../src/core/softgoods-measure.js';
import { softgoodsRouter } from '../src/server/softgoods.js';
import { registerSoftgoodsTools } from '../src/mcp/softgoods.js';

const outline = (id, corners, extra = {}) => ({ id, name: id, material: 'canvas', cut: 1, points: Object.keys(corners).map((k) => ({ id: `${id}_${k}`, x: corners[k][0], y: corners[k][1] })), ...extra });
const rect = (id, w, h) => { const s = ['bottom', 'right', 'top', 'left'], p = ['bl', 'br', 'tr', 'tl']; return { ...outline(id, { bl: [0, 0], br: [w, 0], tr: [w, h], tl: [0, h] }), segments: s.map((n, i) => ({ id: `${id}_${n}`, type: 'line', a: `${id}_${p[i]}`, b: `${id}_${p[(i + 1) % 4]}` })), contours: [s.map((n) => `${id}_${n}`)], allowances: {}, notches: [], grain: { angle: 90 } }; };
// The sleeveless tunic of test/softgoods-review.test.js: two 520 x 700 panels, shoulder and side seams, neck and armholes open.
function tunic() {
  const panel = (id, region) => { const seg = [['bottom', 'bl', 'br'], ['side_r', 'br', 'ar'], ['arm_r', 'ar', 'tr'], ['shoulder_r', 'tr', 'nr'], ['neck', 'nr', 'nl'], ['shoulder_l', 'nl', 'tl'], ['arm_l', 'tl', 'al'], ['side_l', 'al', 'bl']];
    return { ...outline(id, { bl: [0, 0], br: [520, 0], ar: [520, 450], tr: [520, 700], nr: [380, 700], nl: [140, 700], tl: [0, 700], al: [0, 450] }, { placement: { region, anchor: 'shoulder' } }), segments: seg.map(([s, a, b]) => ({ id: `${id}_${s}`, type: 'line', a: `${id}_${a}`, b: `${id}_${b}` })), contours: [seg.map(([s]) => `${id}_${s}`)], allowances: {}, notches: [], grain: { angle: 90 } }; };
  const seam = (id, a, b) => ({ id, a: { pattern: 'front', segment: `front_${a}` }, b: { pattern: 'back', segment: `back_${b}` }, flip: true });
  return { version: 1, materials: { canvas: { name: '12 oz canvas', arealDensity: 340, thickness: 0.6, color: '#3366cc' } }, patterns: [panel('front', 'front'), panel('back', 'back')],
    seams: [seam('shoulder_right', 'shoulder_r', 'shoulder_l'), seam('shoulder_left', 'shoulder_l', 'shoulder_r'), seam('side_right', 'side_r', 'side_l'), seam('side_left', 'side_l', 'side_r')] };
}
const AVATAR = { height: 1700, chest: 900 }, COARSE = { target: 60 };
// As the server stores it: the pieces stood around the avatar.
const dressed = (() => { const d = tunic(), placed = arrangePatternsAroundAvatar(d.patterns, AVATAR); return validateSoftgoodsDocument({ ...d, arrangement: placed.arrangement, simulation: { avatar: placed.avatar } }); })();
// A rectangle held by attachments on whichever of its edges `hold` places: with nothing to collide with, it hangs from them.
function held(id, w, h, target, hold, seams = []) {
  const pattern = rect(id, w, h), mesh = meshPattern(pattern, { target }), attachments = [];
  for (const [edge, to] of Object.entries(hold)) for (const i of new Set(mesh.segmentVertices[`${id}_${edge}`])) attachments.push({ id: `${edge}_${i}`, pattern: id, at: [mesh.uv[i * 2], mesh.uv[i * 2 + 1]], to: to(mesh.uv[i * 2]) });
  return validateSoftgoodsDocument({ version: 1, materials: { canvas: { arealDensity: 340, thickness: 0.6 } }, patterns: [pattern], seams, attachments, arrangement: [{ pattern: id, position: [-w / 2, 0, 1000], rotation: [90, 0, 0] }] });
}
const everyNumber = (value, at = '') => { if (typeof value === 'number') assert.ok(Number.isFinite(value), `${at} is ${value}`); else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) everyNumber(v, `${at}.${k}`); };

function parseGLB(buf) {
  assert.equal(buf.readUInt32LE(0), 0x46546c67, 'magic glTF'); assert.equal(buf.readUInt32LE(4), 2); assert.equal(buf.readUInt32LE(8), buf.length, 'the header states the whole length');
  const jsonLength = buf.readUInt32LE(12), binAt = 20 + jsonLength; assert.equal(buf.readUInt32LE(16), 0x4e4f534a, 'first chunk is JSON'); assert.equal(jsonLength % 4, 0);
  const json = JSON.parse(buf.subarray(20, binAt).toString()), binLength = buf.readUInt32LE(binAt); assert.equal(buf.readUInt32LE(binAt + 4), 0x004e4942, 'second chunk is BIN'); assert.equal(binLength % 4, 0);
  assert.equal(binAt + 8 + binLength, buf.length); assert.equal(json.buffers[0].byteLength, binLength); assert.equal(json.asset.version, '2.0');
  const bin = buf.subarray(binAt + 8), read = (index) => { const a = json.accessors[index], view = json.bufferViews[a.bufferView], size = { SCALAR: 1, VEC2: 2, VEC3: 3 }[a.type], n = a.count * size;
    assert.equal(view.byteLength, n * 4); assert.ok(view.byteOffset + view.byteLength <= binLength);
    return a.componentType === 5125 ? Uint32Array.from({ length: n }, (_, k) => bin.readUInt32LE(view.byteOffset + k * 4)) : Float32Array.from({ length: n }, (_, k) => bin.readFloatLE(view.byteOffset + k * 4)); };
  return { json, read };
}

test('a two-panel tunic drapes on the server until it settles, and a repeated request does not drape again', async () => {
  const began = performance.now(), drape = drapeDocument(dressed, COARSE), took = performance.now() - began;
  assert.ok(drape.settled && drape.steps < 600, `settled after ${drape.steps} steps`); assert.ok(drape.residual < drape.options.tolerance);
  assert.deepEqual(drape.pieces.map((p) => p.id), ['front', 'back']);
  for (const p of drape.pieces) { assert.equal(p.positions.length, p.count * 3); assert.equal(p.uv.length, p.count * 2); assert.equal(p.strain.length, p.count); assert.equal(p.pressure.length, p.count); assert.ok(p.positions.every(Number.isFinite)); assert.ok(Math.max(...p.triangles) < p.count); assert.ok(Math.abs(p.area.reduce((n, v) => n + v, 0) - 364000) < 1, 'vertex areas add up to the panel'); }
  assert.ok(drape.pressureAvailable && drape.body.shapes.length === 4);
  const again = performance.now(); assert.equal(drapeDocument(dressed, { ...COARSE }), drape, 'the same design and options return the drape already made'); assert.ok(performance.now() - again < took / 5);
  assert.notEqual(drapeDocument(dressed, { target: 60, steps: 20 }), drape, 'other options are another drape'); assert.equal(drapeDocument(dressed, { target: 60, steps: 20 }).settled, false);
  assert.throws(() => drapeDocument(validateSoftgoodsDocument({ version: 1 })), GraphError);
});

test('the server drapes on a thread of its own, and hands back the same drape to whoever asks next', async () => {
  const doc = held('flag', 200, 200, 50, { top: (u) => [u - 100, 0, 1200] }), [a, b] = await Promise.all([drapeDocumentAsync(doc, { target: 50 }), drapeDocumentAsync(doc, { target: 50 })]);
  assert.equal(a, b, 'two requests in flight share one drape'); assert.ok(a.settled && a.pieces[0].positions instanceof Float32Array && a.pieces[0].triangles instanceof Uint32Array);
  assert.equal(drapeDocument(doc, { target: 50 }), a); assert.equal(await drapeDocumentAsync(doc, { target: 50 }), a);
  await assert.rejects(drapeDocumentAsync(validateSoftgoodsDocument({ version: 1 })), GraphError);
});

test('the GLB is valid binary glTF: a mesh per piece in metres with +Y up, pattern coordinates as texture coordinates, a material per fabric', () => {
  const drape = drapeDocument(dressed, COARSE), scene = drapeScene(dressed, drape, { textureMm: 500 }), { json, read } = parseGLB(drapeGLB(scene, 'tunic'));
  const garment = json.nodes[json.scenes[0].nodes[0]]; assert.equal(json.scenes[0].nodes.length, 1); assert.equal(garment.name, 'garment'); assert.deepEqual(garment.children.map((n) => json.nodes[n].name), ['front', 'back']);
  assert.deepEqual(json.scenes[0].extras.uv.mmPerUnit, 500); assert.equal(json.scenes[0].extras.units, 'm'); assert.equal(json.scenes[0].extras.up, '+Y');
  assert.equal(json.materials.length, 1); assert.equal(json.materials[0].name, 'canvas'); assert.ok(Math.abs(json.materials[0].pbrMetallicRoughness.baseColorFactor[2] - ((0.8 + 0.055) / 1.055) ** 2.4) < 1e-6, 'the fabric colour, in linear light');
  drape.pieces.forEach((piece, k) => {
    const prim = json.meshes[json.nodes[garment.children[k]].mesh].primitives[0], position = json.accessors[prim.attributes.POSITION], xyz = read(prim.attributes.POSITION), normal = read(prim.attributes.NORMAL), uv = read(prim.attributes.TEXCOORD_0), index = read(prim.indices);
    for (const name of ['POSITION', 'NORMAL', 'TEXCOORD_0', '_STRAIN', '_PRESSURE']) assert.equal(json.accessors[prim.attributes[name]].count, piece.count, `${name} has one entry per vertex`);
    assert.equal(index.length, piece.triangles.length); assert.ok(Math.max(...index) < piece.count); assert.equal(json.materials[prim.material].name, 'canvas');
    // Solver (x, y, z) mm is glTF (x, z, -y) m, and the accessor's bounds are the piece's.
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < piece.count; i++) { const want = [piece.positions[i * 3] / 1000, piece.positions[i * 3 + 2] / 1000, -piece.positions[i * 3 + 1] / 1000]; for (let j = 0; j < 3; j++) { assert.ok(Math.abs(xyz[i * 3 + j] - want[j]) < 1e-6); lo[j] = Math.min(lo[j], want[j]); hi[j] = Math.max(hi[j], want[j]); }
      assert.ok(Math.abs(Math.hypot(normal[i * 3], normal[i * 3 + 1], normal[i * 3 + 2]) - 1) < 1e-4);
      assert.ok(Math.abs(uv[i * 2] - piece.uv[i * 2] / 500) < 1e-6 && Math.abs(1 - uv[i * 2 + 1] - piece.uv[i * 2 + 1] / 500) < 1e-6, 'u = x / textureMm, v = 1 - y / textureMm'); }
    for (let j = 0; j < 3; j++) { assert.ok(Math.abs(position.min[j] - lo[j]) < 1e-6 && Math.abs(position.max[j] - hi[j]) < 1e-6); }
    assert.ok(position.min[1] > 0.6 && position.max[1] < 1.5 && position.max[0] - position.min[0] < 0.6, 'a garment in metres, standing up along +Y');
  });
  assert.ok(json.accessors[json.meshes[0].primitives[0].attributes.POSITION].max[2] > json.accessors[json.meshes[1].primitives[0].attributes.POSITION].max[2], 'the front panel is toward +Z');
});

test('thickness makes each piece a closed shell of its fabric, and the avatar comes as a node of its own', () => {
  const drape = drapeDocument(dressed, COARSE), { json, read } = parseGLB(drapeGLB(drapeScene(dressed, drape, { thickness: true, avatar: true })));
  assert.deepEqual(json.scenes[0].nodes.map((n) => json.nodes[n].name), ['garment', 'avatar']); assert.deepEqual(json.nodes[json.scenes[0].nodes[1]].children.map((n) => json.nodes[n].name), ['torso', 'shoulders', 'neck', 'head']);
  assert.deepEqual(json.materials.map((m) => m.name), ['canvas', 'body']);
  const prim = json.meshes[0].primitives[0], xyz = read(prim.attributes.POSITION), index = read(prim.indices), n = drape.pieces[0].count, edges = new Map();
  assert.equal(xyz.length, n * 6);
  for (let i = 0; i < n; i++) assert.ok(Math.abs(Math.hypot(xyz[i * 3] - xyz[(i + n) * 3], xyz[i * 3 + 1] - xyz[(i + n) * 3 + 1], xyz[i * 3 + 2] - xyz[(i + n) * 3 + 2]) - 0.0006) < 2e-6, 'the two faces are 0.6 mm apart');
  for (let t = 0; t < index.length; t += 3) for (let k = 0; k < 3; k++) { const key = `${index[t + k]}/${index[t + (k + 1) % 3]}`; edges.set(key, (edges.get(key) || 0) + 1); }
  for (const [key, count] of edges) { const [a, b] = key.split('/'); assert.equal(count, 1); assert.equal(edges.get(`${b}/${a}`), 1, 'every edge has a triangle on each side, turned the other way: the shell is closed'); }
  const torso = json.meshes[json.nodes[json.nodes[json.scenes[0].nodes[1]].children[0]].mesh].primitives[0], box = json.accessors[torso.attributes.POSITION];
  assert.ok(Math.abs(box.max[0] - 0.9 / (2 * Math.PI)) < 1e-3 && Math.abs((box.max[1] + box.min[1]) / 2 - 1.054) < 1e-3, 'the torso, in metres, at chest height'); assert.equal(torso.attributes.TEXCOORD_0, undefined);
});

test('the OBJ has a group per piece, faces that index its own vertices, and an MTL', () => {
  const drape = drapeDocument(dressed, COARSE), { obj, mtl } = drapeOBJ(drapeScene(dressed, drape), 'tunic_drape'), lines = obj.split('\n'), count = (prefix) => lines.filter((l) => l.startsWith(prefix)).length, total = drape.pieces.reduce((n, p) => n + p.count, 0);
  assert.equal(count('v '), total); assert.equal(count('vt '), total); assert.equal(count('vn '), total); assert.equal(count('f '), drape.pieces.reduce((n, p) => n + p.triangles.length / 3, 0));
  assert.deepEqual(lines.filter((l) => l.startsWith('g ')), ['g front', 'g back']); assert.ok(lines.includes('mtllib tunic_drape.mtl') && lines.includes('usemtl canvas')); assert.match(mtl, /newmtl canvas\nKd 0\.2 0\.4 0\.8/);
  // A group's faces use that group's vertices only.
  let group = -1; const ranges = drape.pieces.map((p) => [p.off + 1, p.off + p.count]);
  for (const l of lines) { if (l.startsWith('g ')) group++; if (!l.startsWith('f ')) continue; for (const corner of l.slice(2).split(' ')) { const [v, vt, vn] = corner.split('/').map(Number); assert.ok(v >= ranges[group][0] && v <= ranges[group][1] && vt === v && vn === v, `face corner ${corner} is outside its group`); } }
  const first = lines.find((l) => l.startsWith('v ')).split(' ').slice(1).map(Number), p = drape.pieces[0].positions;
  assert.ok(Math.abs(first[0] - p[0] / 1000) < 1e-6 && Math.abs(first[1] - p[2] / 1000) < 1e-6 && Math.abs(first[2] + p[1] / 1000) < 1e-6, 'metres, +Y up');
  assert.ok(Math.abs(Number(lines.find((l) => l.startsWith('vt ')).split(' ')[2]) - drape.pieces[0].uv[1] / 1000) < 1e-6, 'vt is the pattern coordinate over textureMm, v up');
});

test('a tube sewn from a rectangle of width W measures W around, at any height', () => {
  // A lampshade: the rectangle's top and bottom edges on two hoops of circumference W, its sides sewn together at the back.
  const W = 600, H = 300, R = W / (2 * Math.PI), hoop = (z) => (u) => { const a = 2 * Math.PI * (u - W / 2) / W; return [R * Math.sin(a), -R * Math.cos(a), z]; };
  const doc = held('shade', W, H, 40, { top: hoop(1000 + H), bottom: hoop(1000) }, [{ id: 'close', a: { pattern: 'shade', segment: 'shade_left' }, b: { pattern: 'shade', segment: 'shade_right' }, flip: true }]);
  doc.arrangement[0].position[1] = -R;
  const drape = drapeDocument(doc, { target: 40 }); assert.ok(drape.settled);
  for (const f of [0.15, 0.5, 0.85]) { const cut = circumference(drape, 1000 + H * f); assert.equal(cut.loops.length, 1); assert.ok(cut.loops[0].closed && cut.loops[0].encloses, 'one closed loop round the axis'); assert.ok(Math.abs(cut.circumference - W) < 0.02 * W, `${cut.circumference} mm round at ${f} of the height, the rectangle is ${W} wide`); }
  const [seam, across, bounds] = measureDrape(doc, drape, [{ type: 'seam', seam: 'close' }, { type: 'distance', a: { pattern: 'shade', at: [30, 150] }, b: { pattern: 'shade', at: [W - 30, 150] } }, { type: 'bounds' }]);
  assert.ok(seam.gap < 3 && Math.abs(seam.a.stretch) < 0.01 && Math.abs(seam.b.draped - H) < 0.01 * H, 'the seam is closed and neither side stretched');
  assert.equal(across.seamsCrossed, 1); assert.ok(Math.abs(across.distance - 60) < 3, `30 mm either side of the seam is ${across.distance} mm apart along the cloth, not ${W - 60}`); assert.equal(across.pattern, null);
  assert.ok(Math.abs(bounds.size[0] - 2 * R) < 0.02 * 2 * R && Math.abs(bounds.size[2] - H) < 0.01 * H);
  assert.equal(circumference(drape, 500).circumference, null, 'no cloth at that height');
});

test('distance along a flat hung panel is the pattern distance, and round a garment it goes through the seams', () => {
  const doc = held('panel', 400, 500, 40, { top: (u) => [u - 200, 0, 1500] }), drape = drapeDocument(doc, { target: 40 }); assert.ok(drape.settled);
  for (const [a, b] of [[[20, 30], [380, 470]], [[37, 211], [391, 260]], [[200, 10], [203, 490]], [[0, 0], [400, 500]], [[310, 420], [45, 77]]]) {
    const g = geodesic(doc, drape, { pattern: 'panel', at: a }, { pattern: 'panel', at: b }), flat = Math.hypot(a[0] - b[0], a[1] - b[1]);
    assert.ok(Math.abs(g.distance - flat) < 0.01 * flat, `${g.distance} mm along the cloth, ${flat.toFixed(2)} mm in the pattern`); assert.ok(Math.abs(g.pattern - flat) < 0.01); assert.equal(g.seamsCrossed, 0);
  }
  const corner = geodesic(doc, drape, { pattern: 'panel', point: 'panel_bl' }, { pattern: 'panel', point: 'panel_tr' }); assert.ok(Math.abs(corner.distance - Math.hypot(400, 500)) < 6.5, 'points may be named by id');
  // Mid front to mid back of the tunic, below the armholes: half way round, 520 mm, through a side seam.
  const worn = drapeDocument(dressed, COARSE), [round, hem, unsewn, lost] = measureDrape(dressed, worn, [{ type: 'distance', a: { pattern: 'front', at: [260, 200] }, b: { pattern: 'back', at: [260, 200] } }, { type: 'edge', pattern: 'front', segment: 'front_bottom' }, { type: 'edge', pattern: 'front', segment: 'nope' }, { type: 'distance', a: { pattern: 'front', point: 'nope' }, b: { pattern: 'back', at: [0, 0] } }]);
  assert.equal(round.seamsCrossed, 1); assert.ok(Math.abs(round.distance - 520) < 0.02 * 520, `${round.distance} mm half way round`); assert.ok(round.straight < 400, 'the straight line goes through the body');
  assert.ok(Math.abs(hem.draped - 520) < 5 && hem.flat === 520 && Math.abs(hem.stretch) < 0.01);
  assert.match(unsewn.error, /No segment/); assert.match(lost.error, /No point/);
});

test('the fit report has finite numbers, strain against the fabric\'s limit, pressure in kPa, and positive ease where the garment is larger than the body', () => {
  const drape = drapeDocument(dressed, COARSE), fit = fitReport(dressed, drape); everyNumber(fit);
  assert.equal(fit.schema, 'cadgang.softgoods-fit.v1'); assert.ok(fit.ok && fit.drape.settled); assert.deepEqual(fit.pieces.map((p) => p.id), ['front', 'back']);
  for (const q of [fit.overall, ...fit.pieces]) { assert.ok(q.strain.p50 <= q.strain.p90 && q.strain.p90 <= q.strain.p99 && q.strain.p99 <= q.strain.max && q.strain.max < 5, 'strain percentiles in %, under the 5% default limit'); assert.equal(q.strain.unit, '%'); assert.equal(q.pressure.unit, 'kPa'); assert.ok(q.pressure.max > 0 && q.pressure.max < 5 && q.pressure.p50 <= q.pressure.max, 'a hanging tunic presses pascals, not kilopascals'); assert.ok(q.contact > 0.02 && q.contact < 0.6, `${(q.contact * 100).toFixed(0)}% of the cloth touches the body`); }
  assert.equal(fit.pieces[0].strain.limit, 5); assert.equal(fit.pieces[0].strain.limitSource, 'default'); assert.equal(fit.overall.areaMm2, 728000);
  const chest = fit.ease.find((e) => e.level === 'chest'), body = bodyCircumference(drape.body, drape.body.levels.chest);
  assert.deepEqual(fit.ease.map((e) => e.level), ['chest', 'waist', 'hip']); assert.ok(Math.abs(chest.garment - 1040) < 0.02 * 1040, `the tunic is ${chest.garment} mm round the chest, two 520 mm panels`);
  assert.ok(Math.abs(chest.body - body) < 0.01 && body > 800 && body < 900 && chest.stated === 900, 'the body is measured round the shapes the cloth collides with');
  for (const e of fit.ease) assert.ok(e.closed && e.ease > 0 && e.gap > 0 && Math.abs(e.ease - (e.garment - e.body)) < 0.02, `ease at the ${e.level} is ${e.ease} mm`);
  assert.ok(fit.bounds.size[2] > 650 && fit.bounds.size[2] < 720);
  // A fabric that says how far it may stretch is held to that.
  const strict = fitReport({ ...dressed, materials: { canvas: { ...dressed.materials.canvas, strainLimit: 0.001 } } }, drape);
  assert.equal(strict.pieces[0].strain.limit, 0.1); assert.equal(strict.pieces[0].strain.limitSource, 'material'); assert.ok(strict.overall.strain.overLimit > 0.01 && !strict.ok && !strict.pieces[0].strain.ok);
  // Above the armholes the tunic does not close round the body: there is no ease to state.
  const high = circumference(drape, 1300); assert.equal(high.circumference, null); assert.equal(high.loops.length, 2);
});

test('export, measure and check reach the drape over REST and the MCP tools', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadgang-soft-drape-')), doc = new SoftgoodsDocument(null), app = express(); app.use(express.json()); app.use('/s', softgoodsRouter(doc, { exportDir: () => dir }));
  const server = app.listen(0), call = async (p, { method = 'GET', body } = {}) => { const r = await fetch(`http://127.0.0.1:${server.address().port}/s${p.replace(/^\/softgoods/, '')}`, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) }), d = await r.json(); if (!r.ok) throw new Error(d.error); return d; };
  const tools = {}; registerSoftgoodsTools({ registerTool: (name, spec, handler) => { tools[name] = { spec, handler }; } }, { call, ok: (v) => v, fail: (e) => { throw e; } });
  const run = (name, input) => tools[name].handler(z.object(tools[name].spec.inputSchema).parse(input));
  try {
    await call('/document', { method: 'PUT', body: { ...tunic(), materials: { ...tunic().materials, lining: { preset: 'nylon-500d' } }, simulation: { avatar: AVATAR } } });
    assert.deepEqual(await call('/simulation-input?target=60'), JSON.parse(JSON.stringify(simulationInput(doc.toJSON(), 60))), 'the server drapes what the page is given, fabric presets filled in');
    const plain = await run('cadgang_softgoods_export', { name: 'plain' }); assert.equal(plain.drape, undefined); assert.ok(plain.files.every((f) => !/drape|fit/.test(path.basename(f))), 'without formats the export is the patterns and tech pack, as before');
    const out = await run('cadgang_softgoods_export', { name: 'tunic', formats: ['glb', 'obj', 'fit'], avatar: true, drape: COARSE }), names = out.files.map((f) => path.basename(f));
    for (const f of ['tunic_front.dxf', 'tunic_tech-pack.html', 'tunic_drape.glb', 'tunic_drape.obj', 'tunic_drape.mtl', 'tunic_fit.json']) assert.ok(names.includes(f) && fs.statSync(path.join(dir, f)).size > 0, `${f} is written`);
    assert.ok(out.drape.settled && out.drape.units === 'm' && out.drape.up === '+Y' && out.drape.uv.mmPerUnit === 1000 && out.drape.pieces === 2 && out.drape.avatar); assert.ok(out.fit.ok && out.fit.ease[0].ease > 0);
    const { json } = parseGLB(fs.readFileSync(path.join(dir, 'tunic_drape.glb'))); assert.equal(json.meshes.length, 6);
    assert.match(fs.readFileSync(path.join(dir, 'tunic_tech-pack.html'), 'utf8'), /FIT · DRAPED PREVIEW[\s\S]*chest/); assert.doesNotMatch(fs.readFileSync(path.join(dir, 'plain_tech-pack.html'), 'utf8'), /FIT ·/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'tunic_tech-pack.json'), 'utf8')).fit.schema, 'cadgang.softgoods-fit.v1');
    const measured = await run('cadgang_softgoods_measure', { measures: [{ type: 'circumference', level: 'chest' }, { type: 'bounds' }], drape: COARSE });
    assert.ok(measured.drape.settled); assert.ok(Math.abs(measured.results[0].circumference - 1040) < 21); assert.equal(measured.results[0].level, 'chest'); assert.equal(measured.results[1].size.length, 3);
    assert.equal((await run('cadgang_softgoods_get', {})).check.fit, undefined, 'the check drapes only when asked');
    assert.equal((await call('/check?fit=1&target=60')).fit.ease[0].level, 'chest');
    // The production outputs and the drape in one request, one tech pack with the bill and the fit.
    const both = await run('cadgang_softgoods_export', { name: 'both', formats: ['marker', 'bom', 'glb', 'fit'], gap: 5, drape: COARSE }), made = both.files.map((f) => path.basename(f));
    for (const f of ['both_front.dxf', 'both_marker_canvas.dxf', 'both_bom.json', 'both_drape.glb', 'both_fit.json', 'both_tech-pack.html']) assert.ok(made.includes(f), `${f} is written`);
    assert.ok(!made.includes('both_drape.obj')); assert.equal(both.markers[0].gapMm, 5); assert.ok(both.bom && both.drape.settled && both.fit.ok);
    assert.match(fs.readFileSync(path.join(dir, 'both_tech-pack.html'), 'utf8'), /BILL OF MATERIALS[\s\S]*FIT · DRAPED PREVIEW/);
    await assert.rejects(call('/export', { method: 'POST', body: { name: 'x', formats: ['stl'] } }), /Unknown export format 'stl'\. Known: marker, bom, print, svg, glb, obj, fit/);
    await assert.rejects(call('/export', { method: 'POST', body: { name: 'wide', formats: ['marker', 'glb'], width: 300, drape: COARSE } }), /across the roll/); assert.ok(!fs.readdirSync(dir).some((f) => f.startsWith('wide_')), 'a marker that cannot be laid writes nothing, the drape included');
  } finally { server.close(); fs.rmSync(dir, { recursive: true }); }
});
