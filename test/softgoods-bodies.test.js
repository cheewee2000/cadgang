// What the cloth drapes on: mesh bodies in the solver, CAD solids in the design, pieces placed on them, and the full avatar.
// Each is run through the server's own simulation input and the page's solver and held to what the cloth should physically do.
// The first test holds every design that uses none of it exactly where it was.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { z } from 'zod';
import { SoftgoodsDocument, validateSoftgoodsDocument } from '../src/core/softgoods-document.js';
import { GraphError } from '../src/core/errors.js';
import { softgoodsRouter } from '../src/server/softgoods.js';
import { registerSoftgoodsTools } from '../src/mcp/softgoods.js';
import { simulate, advance } from '../web/softgoods-worker.js';
import { meshField } from '../web/softgoods-sdf.js';
import { drapeDocument, drapeDocumentAsync, simulationInput } from '../src/core/softgoods-drape.js';
import { fitReport, bodyCircumference } from '../src/core/softgoods-measure.js';
import { checkDesign } from '../src/core/softgoods-operations.js';
import { bodySolids, startPoint } from '../src/core/softgoods-bodies.js';
import { pack } from '../src/server/view.js';
import { drapeScene } from '../src/core/softgoods-drape-export.js';
import { SIZES, fullAvatarBody, measureAvatar, isFullAvatar } from '../src/core/softgoods-avatar.js';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const rect = (id, w, h, extra = {}) => { const s = ['bottom', 'right', 'top', 'left'], p = ['bl', 'br', 'tr', 'tl'], c = [[0, 0], [w, 0], [w, h], [0, h]]; return { id, name: id, material: 'canvas', cut: 1, points: p.map((k, i) => ({ id: `${id}_${k}`, x: c[i][0], y: c[i][1] })), segments: s.map((n, i) => ({ id: `${id}_${n}`, type: 'line', a: `${id}_${p[i]}`, b: `${id}_${p[(i + 1) % 4]}` })), contours: [s.map((n) => `${id}_${n}`)], allowances: {}, notches: [], grain: { angle: 90 }, ...extra }; };
const canvas = { canvas: { arealDensity: 340, thickness: 0.6, damping: 0.05 } }, RADIUS = 0.3;
// On the loopback address alone: a port taken on every address can be answered by another process that holds the same number on this one.
const listening = (app) => new Promise((resolve) => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
// A design goes in through PUT /document and comes back as the page gets it, with the design's check and the stored document.
async function served(design, target = 25, options = {}) {
  const doc = new SoftgoodsDocument(null), app = express(); app.use(express.json({ limit: '50mb' })); app.use('/s', softgoodsRouter(doc, options)); const server = await listening(app);
  const call = async (p, method = 'GET', body) => { const r = await fetch(`http://127.0.0.1:${server.address().port}/s${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) }), j = await r.json(); if (j.error) throw new Error(j.error); return j; };
  try { const document = await call('/document', 'PUT', { version: 1, ...design }); return { input: await call(`/simulation-input?target=${target}`), check: await call('/check'), document, doc }; } finally { server.close(); server.closeAllConnections(); }
}
const P = (f, i) => [f.positions[i * 3], f.positions[i * 3 + 1], f.positions[i * 3 + 2]];
function boxMesh(lo, hi) { const p = []; for (let k = 0; k < 8; k++) p.push(k & 1 ? hi[0] : lo[0], k & 2 ? hi[1] : lo[1], k & 4 ? hi[2] : lo[2]); return { positions: p, indices: [0, 2, 1, 1, 2, 3, 4, 5, 6, 5, 7, 6, 0, 1, 4, 1, 5, 4, 2, 6, 3, 3, 6, 7, 0, 4, 2, 2, 4, 6, 1, 3, 5, 3, 7, 5] }; }
function sphereMesh(c, r, around = 48, rings = 24) { const positions = [], indices = []; for (let j = 0; j <= rings; j++) for (let i = 0; i < around; i++) { const t = Math.PI * j / rings, a = 2 * Math.PI * i / around; positions.push(c[0] + r * Math.sin(t) * Math.cos(a), c[1] + r * Math.sin(t) * Math.sin(a), c[2] + r * Math.cos(t)); } for (let j = 0; j < rings; j++) for (let i = 0; i < around; i++) { const a = j * around + i, b = j * around + (i + 1) % around; indices.push(a, a + around, b, b, a + around, b + around); } return { positions, indices }; }
function cylinderMesh(c, r, z0, z1, around = 48) { const positions = [], indices = []; for (const z of [z0, z1]) for (let i = 0; i < around; i++) positions.push(c[0] + r * Math.cos(2 * Math.PI * i / around), c[1] + r * Math.sin(2 * Math.PI * i / around), z); positions.push(c[0], c[1], z0, c[0], c[1], z1); for (let i = 0; i < around; i++) { const j = (i + 1) % around; indices.push(i, j, i + around, j, j + around, i + around, 2 * around, j, i, 2 * around + 1, i + around, j + around); } return { positions, indices }; }
/** The exact signed distance to a box and to an upright cylinder: what the cloth is held to, whatever the solver's own field says. */
const boxDistance = (p, lo, hi) => { const d = [0, 1, 2].map((k) => Math.max(lo[k] - p[k], p[k] - hi[k])), out = Math.hypot(...d.map((v) => Math.max(v, 0))); return out > 0 ? out : Math.max(...d); };
const cylinderDistance = (p, c, r, z0, z1) => { const d = [Math.hypot(p[0] - c[0], p[1] - c[1]) - r, Math.max(z0 - p[2], p[2] - z1)], out = Math.hypot(Math.max(d[0], 0), Math.max(d[1], 0)); return out > 0 ? out : Math.max(...d); };
const sums = (f) => { let s = 0, w = 0; for (let i = 0; i < f.positions.length; i++) { s += f.positions[i]; w += f.positions[i] * (i % 97 + 1); } return [f.positions.length / 3, s, w]; };
const sha = (v) => crypto.createHash('sha1').update(JSON.stringify(v)).digest('hex');
// The sleeveless tunic of test/softgoods-review.test.js: two panels, shoulder and side seams, the neck and armholes left open.
function tunic() {
  const panel = (id, region) => { const corners = { bl: [0, 0], br: [520, 0], ar: [520, 450], tr: [520, 700], nr: [380, 700], nl: [140, 700], tl: [0, 700], al: [0, 450] }, seg = [['bottom', 'bl', 'br'], ['side_r', 'br', 'ar'], ['arm_r', 'ar', 'tr'], ['shoulder_r', 'tr', 'nr'], ['neck', 'nr', 'nl'], ['shoulder_l', 'nl', 'tl'], ['arm_l', 'tl', 'al'], ['side_l', 'al', 'bl']];
    return { id, name: id, material: 'canvas', cut: 1, points: Object.keys(corners).map((k) => ({ id: `${id}_${k}`, x: corners[k][0], y: corners[k][1] })), placement: { region, anchor: 'shoulder' }, segments: seg.map(([s, a, b]) => ({ id: `${id}_${s}`, type: 'line', a: `${id}_${a}`, b: `${id}_${b}` })), contours: [seg.map(([s]) => `${id}_${s}`)], allowances: {}, notches: [], grain: { angle: 90 } }; };
  const seam = (id, a, b) => ({ id, a: { pattern: 'front', segment: `front_${a}` }, b: { pattern: 'back', segment: `back_${b}` }, flip: true });
  return { materials: { canvas: { name: '12 oz canvas', arealDensity: 340, thickness: 0.6 } }, patterns: [panel('front', 'front'), panel('back', 'back')], seams: [seam('shoulder_right', 'shoulder_r', 'shoulder_l'), seam('shoulder_left', 'shoulder_l', 'shoulder_r'), seam('side_right', 'side_r', 'side_l'), seam('side_left', 'side_l', 'side_r')] };
}

test('a design with no body and only the old avatar fields is arranged, simulated, checked and reported exactly as it was', async () => {
  // Taken on origin/softgoods-physics at 9ffd7d0, before any of this was added, through the same routes: the hash of the whole simulation input, of the
  // arrangement and of the check, and after 60 steps the vertex count, the sum of every coordinate and that sum weighted by position in the array.
  const was = {
    tunic: { design: { ...tunic(), simulation: { avatar: { height: 1700, chest: 900 } } }, input: 'adc7de5209312677bb6e0e543a2b3fea00fe2c8e', sums: [1330, 1415765.1593390629, 69213168.82191639], check: '262e452ffd5a462139707adb2bdb737b1f851019', arrangement: '540e723073d95bb485d26bc2aa6a682d66379c8f' },
    tunicWide: { design: { ...tunic(), simulation: { avatar: { height: 1800, chest: 1000, depth: 260, shoulders: 440, ease: 30 } } }, input: '2a01c5f1340b7aff36a3cbfbdd8a36e558873c0f', sums: [1330, 1527507.1049861996, 74670133.32069649], check: '262e452ffd5a462139707adb2bdb737b1f851019', arrangement: '088e2d2115e78faa575b51b7b4432298ee164317' },
    flag: { design: { materials: { canvas: { arealDensity: 340, thickness: 0.6 } }, patterns: [rect('flag', 300, 200)], seams: [], attachments: [{ id: 'a', pattern: 'flag', at: [0, 200], to: [0, 0, 1000] }, { id: 'b', pattern: 'flag', at: [300, 200], to: [280, 0, 1000] }], arrangement: [{ pattern: 'flag', position: [0, 0, 800], rotation: [90, 0, 0] }] }, input: 'b6181f47a872fadd755e76863d45d70b0c9bff09', sums: [136, 139806.6716312915, 6693277.3165645], check: '4a5e92fa51373a3a43746206ab20f9f797ed5d26', arrangement: 'a9c4834276e39cb411185c2a8a65234994b558ad' },
  };
  for (const [name, w] of Object.entries(was)) {
    const { input, check, document } = await served(w.design, 30), got = sums(simulate(input, 60));
    // Flattening (a branch below this one) added each mesh's true segment lengths to the input; everything else is as it was at 9ffd7d0.
    const pinned = JSON.parse(JSON.stringify(input)); for (const m of pinned.meshes) delete m.segmentLengths;
    assert.equal(sha(pinned), w.input, `${name}: the simulation input`); assert.equal(sha(document.arrangement), w.arrangement, `${name}: the arrangement`); { const { warnings, ...was9 } = check; assert.equal(sha(was9), w.check, `${name}: the check (trims, below, adds allowance warnings)`); }
    assert.equal(got[0], w.sums[0]); assert.ok(Math.abs(got[1] - w.sums[1]) < 1e-3 && Math.abs(got[2] - w.sums[2]) < 1e-1, `${name} moved: ${got} against ${w.sums}`);
    assert.deepEqual(input, JSON.parse(JSON.stringify(simulationInput(document, 30))), `${name}: the server drapes what the page is given`);
    if (name === 'tunic') { assert.equal(isFullAvatar(document.simulation.avatar), false); assert.equal(input.collisionBody.shapes.length, 4); assert.equal(sha(fitReport(document, drapeDocument(document, { target: 60, steps: 200 }))), 'b200c0e352a079f9140c57468a5f3e856e400787', 'the fit report'); }
  }
});

test('a cloth dropped on a mesh box rests on its top at the clearance and hangs over its edges without passing through', () => {
  const lo = [-100, -100, 300], hi = [100, 100, 400], box = boxMesh(lo, hi), clearance = 1, pattern = rect('sheet', 400, 400), d = validateSoftgoodsDocument({ version: 1, materials: canvas, patterns: [pattern], seams: [], arrangement: [{ pattern: 'sheet', position: [-200, -200, 420], rotation: [0, 0, 0] }], bodies: [{ id: 'box', source: { mesh: box }, clearance }] });
  const input = simulationInput(d, 20), shape = input.collisionBody.shapes[0];
  assert.deepEqual([shape.type, shape.id, shape.clearance, shape.positions.length, shape.indices.length, input.collisionBody.floor], ['mesh', 'box', 1, 24, 36, 300], 'the body is a mesh shape, and the floor is under it');
  const f = simulate(input, 240), n = f.positions.length / 3; let onTop = 0, lowest = Infinity, nearest = Infinity;
  for (let i = 0; i < n; i++) {
    const p = P(f, i), dist = boxDistance(p, lo, hi); nearest = Math.min(nearest, dist); lowest = Math.min(lowest, p[2]);
    if (Math.abs(p[0]) < 80 && Math.abs(p[1]) < 80) { onTop++; assert.ok(Math.abs(p[2] - hi[2] - clearance - RADIUS) < 0.25, `the cloth lies on the top at its clearance: ${(p[2] - hi[2]).toFixed(2)} mm above it`); }
  }
  assert.ok(onTop > 30, `${onTop} vertices over the top`);
  assert.ok(nearest > clearance + RADIUS - 0.6, `no vertex is nearer the box than its clearance: ${nearest.toFixed(2)} mm`);
  assert.ok(lowest < hi[2] - 60, `the overhang hangs down the sides: lowest ${lowest.toFixed(0)}`);
});

test('a cloth dropped on a mesh sphere lies as it does on the ellipsoid primitive', () => {
  const C = [0, 0, 400], R = 100, d = validateSoftgoodsDocument({ version: 1, materials: canvas, patterns: [rect('sheet', 300, 300)], seams: [], arrangement: [{ pattern: 'sheet', position: [-150, -150, 505], rotation: [0, 0, 0] }], bodies: [{ id: 'ball', source: { mesh: sphereMesh(C, R) }, clearance: 0 }], simulation: { floor: 0 } });
  const input = simulationInput(d, 15), onMesh = simulate(input, 240), onBall = simulate({ ...input, collisionBody: { shapes: [{ type: 'ellipsoid', c: C, r: [R, R, R] }] } }, 240), n = onMesh.positions.length / 3;
  let apart = 0, crown = 0, meanMesh = 0, meanBall = 0;
  for (let i = 0; i < n; i++) {
    const p = P(onMesh, i), q = P(onBall, i); apart += Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) / n; meanMesh += p[2] / n; meanBall += q[2] / n;
    // On the crown the cloth lies on the ball: there the mesh must hold it at the ball's radius, less the facets' sag (0.2 mm). Nowhere is it inside.
    const r = Math.hypot(p[0] - C[0], p[1] - C[1], p[2] - C[2]) - R; assert.ok(r > -0.3, `a vertex is ${(-r).toFixed(2)} mm inside the ball`);
    if (Math.hypot(q[0], q[1]) < 30) { crown++; assert.ok(Math.abs(r - RADIUS) < 0.25, `on the crown the mesh holds the cloth ${r.toFixed(2)} mm off the ball's surface`); }
  }
  assert.ok(crown > 10); assert.ok(apart < 6, `the two drapes are ${apart.toFixed(1)} mm apart on average`); assert.ok(Math.abs(meanMesh - meanBall) < 2, `their mean heights: ${meanMesh.toFixed(1)} and ${meanBall.toFixed(1)}`);
});

test('a tube of cloth drawn over a mesh cylinder by its elastic ends stays outside it everywhere', () => {
  // The tube starts wrapped round the can (an arrangement row's wrap), 30 mm longer than it at either end; the elastics close the ends over the rims.
  const R = 60, rho = 66, W = +(2 * Math.PI * rho).toFixed(3), L = 260, clearance = 1;
  const d = validateSoftgoodsDocument({ version: 1, materials: canvas, patterns: [rect('tube', W, L)], seams: [{ id: 'closing', a: { pattern: 'tube', segment: 'tube_right' }, b: { pattern: 'tube', segment: 'tube_left' }, flip: true }],
    elastics: [{ id: 'top_elastic', pattern: 'tube', segment: 'tube_top', ratio: 0.6, stiffness: 8 }, { id: 'bottom_elastic', pattern: 'tube', segment: 'tube_bottom', ratio: 0.6, stiffness: 8 }],
    arrangement: [{ pattern: 'tube', position: [-W / 2, -rho, 270], rotation: [90, 0, 0], wrap: { radius: rho, centre: W / 2 } }], bodies: [{ id: 'can', source: { mesh: cylinderMesh([0, 0], R, 300, 500) }, clearance }], simulation: { floor: false } });
  const input = simulationInput(d, 15), start = simulate(input, 0), n = start.positions.length / 3, uv = input.meshes[0].uv;
  assert.equal(input.collisionBody.floor, false);
  for (let i = 0; i < n; i++) { const p = P(start, i); assert.ok(Math.abs(Math.hypot(p[0], p[1]) - rho) < 1e-3, 'the piece starts as a tube round the axis'); assert.deepEqual(startPoint([uv[i * 2], uv[i * 2 + 1]], d.arrangement[0]).map((v) => Math.fround(v)), p, 'the check places a point where the solver does'); }
  const f = advance(300), rim = { top: [], bottom: [] }; let nearest = Infinity, low = Infinity, high = -Infinity;
  for (let i = 0; i < n; i++) { const p = P(f, i); nearest = Math.min(nearest, cylinderDistance(p, [0, 0], R, 300, 500)); low = Math.min(low, p[2]); high = Math.max(high, p[2]); if (uv[i * 2 + 1] > L - 0.01) rim.top.push(Math.hypot(p[0], p[1])); if (uv[i * 2 + 1] < 0.01) rim.bottom.push(Math.hypot(p[0], p[1])); }
  const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  assert.ok(nearest > clearance + RADIUS - 0.6, `no vertex is nearer the can than its clearance: ${nearest.toFixed(2)} mm`);
  assert.ok(low < 300 && high > 500, `the tube still covers the can end to end: ${low.toFixed(0)} to ${high.toFixed(0)}`);
  assert.ok(mean(rim.top) < R - 10 && mean(rim.bottom) < R - 10, `the elastic ends have closed over the rims: ${mean(rim.top).toFixed(0)} and ${mean(rim.bottom).toFixed(0)} mm, the can is ${R}`);
});

test('the field of a hollow part is solid, a thin sheet is reported, and the sign needs no winding', () => {
  // A box with a 1.5 mm wall: an outer and an inner shell. Its cavity is inside, and a vertex in the wall is sent out, not into the cavity.
  const outer = boxMesh([0, 0, 0], [200, 100, 50]), inner = boxMesh([1.5, 1.5, 1.5], [198.5, 98.5, 48.5]), n = [0, 0, 0];
  const hollow = meshField([...outer.positions, ...inner.positions], [...outer.indices, ...inner.indices.map((i) => i + 8)], { reach: 3 });
  assert.ok(hollow.at(100, 50, 25, n) < -20, 'the cavity is inside'); assert.ok(Math.abs(hollow.at(100, 50, 49, n) + 1) < 0.3 && n[2] > 0.9, 'in the wall, the way out is out'); assert.ok(Math.abs(hollow.at(100, 50, 51.3, n) - 1.3) < 0.05);
  const flipped = meshField(outer.positions, outer.indices.map((v, i, a) => a[i - i % 3 + [0, 2, 1][i % 3]]), { reach: 3 }); assert.ok(flipped.at(100, 50, 25, n) < -20 && flipped.at(100, 50, 52, n) > 1.9, 'a mesh wound inside out reads the same');
  const sheet = meshField([0, 0, 0, 300, 0, 0, 300, 300, 0, 0, 300, 0], [0, 1, 2, 0, 2, 3]); assert.equal(sheet.inside, 0);
  const d = validateSoftgoodsDocument({ version: 1, patterns: [], seams: [], bodies: [{ id: 'sheet', source: { mesh: { positions: [0, 0, 0, 300, 0, 0, 300, 300, 0, 0, 300, 0], indices: [0, 1, 2, 0, 2, 3] } } }] });
  assert.match(checkDesign(d).bodies[0].message, /encloses no volume/);
});

test('a STEP file is a body: one solid of it or all, read once, and a piece placed on its top rests there', async () => {
  const cube = path.join(fixtures, 'cube.stp'), asm = path.join(fixtures, 'asm.step'), sheet = rect('cover', 200, 200, { placement: { body: 'cube', side: 'top' } });
  const { input, document, check } = await served({ materials: canvas, patterns: [sheet], seams: [], bodies: [{ id: 'cube', source: { step: cube } }, { id: 'boss', source: { step: asm, body: 'body 3#0' }, transform: { position: [1000, 0, 0] }, scale: 2 }] }, 25);
  const [box, boss] = input.collisionBody.shapes;
  assert.deepEqual([box.min, box.max, box.indices.length / 3], [[-160, -140, 0], [140, 160, 300], 12], 'the cube keeps the CAD model\'s own placement');
  assert.equal(boss.indices.length / 3, 100, 'one solid of the three'); assert.ok(boss.min[0] >= 1000 - 80 && boss.max[2] <= 98.001, 'scaled, then moved');
  assert.deepEqual(bodySolids(document.bodies[1]).map((s) => s.key), ['body 1#0', 'body 2#0', 'body 3#0']);
  assert.equal(input.collisionBody.floor, 0, 'the floor is under the lowest body'); assert.equal(check.bodies, undefined, 'nothing starts inside');
  // The piece is centred over the top face, its clearance and 5 mm above it, face up.
  const row = document.arrangement[0]; assert.equal(row.source, 'body'); assert.deepEqual(startPoint([100, 100], row).map((v) => +v.toFixed(3)), [-10, 10, 306]);
  const f = simulate(input, 120); for (let i = 0; i < f.positions.length / 3; i++) assert.ok(Math.abs(P(f, i)[2] - 301.3) < 0.2, 'the cover lies on the cube');
  assert.deepEqual(input, JSON.parse(JSON.stringify(simulationInput(document, 25))), 'the server drapes what the page is given');
  await assert.rejects(served({ patterns: [], seams: [], bodies: [{ id: 'part', source: { step: asm, body: 'lid' } }] }), /no solid 'lid'.*body 1#0, body 2#0, body 3#0/);
  await assert.rejects(served({ patterns: [], seams: [], bodies: [{ id: 'part', source: { step: path.join(fixtures, 'missing.step') } }] }), /no file/);
  await assert.rejects(served({ patterns: [], seams: [], bodies: [{ id: 'part', source: { model: true } }] }), /none is: open the part/);
  // The model open in CADgang: the design keeps which file that was.
  const open = await served({ patterns: [], seams: [], bodies: [{ id: 'part', source: { model: true, body: 'cube' } }] }, 25, { model: () => cube });
  assert.equal(open.document.bodies[0].source.model, cube); assert.equal(open.input.collisionBody.shapes[0].indices.length / 3, 12);
  // A project's live cells are a model too: the app hands over the pack a viewer window would get, and its bodies are named the same way.
  const b = boxMesh([0, 0, 0], [50, 40, 30]), cells = '/projects/speaker/cadgang/cells.json', packed = pack({ positions: Float32Array.from([...b.positions, ...b.positions.map((v) => v + 100)]), indices: Uint32Array.from([...b.indices, ...b.indices.map((i) => i + 8)]), normals: null, faces: [], bodies: [{ first: 0, count: 12, name: 'base' }, { first: 12, count: 12, name: 'lid' }] });
  const live = await served({ patterns: [], seams: [], bodies: [{ id: 'lid', source: { model: true, body: 'lid' } }] }, 25, { model: () => cells, live: async (file) => { assert.equal(file, cells); return packed; } });
  assert.deepEqual([live.input.collisionBody.shapes[0].min, live.input.collisionBody.shapes[0].max], [[100, 100, 100], [150, 140, 130]]);
  // The server drape runs on a thread of its own, which is handed the file already read; the export draws the body with the cloth.
  const drape = await drapeDocumentAsync(document, { target: 25, steps: 80 }), part = drapeScene(document, drape, { avatar: true }).parts.find((q) => q.name === 'cube');
  assert.equal(drape.body.shapes[0].id, 'cube'); assert.equal(part.indices.length / 3, 12); assert.ok(Math.abs(Math.max(...part.positions) - 0.3) < 1e-6, 'in metres, +Y up');
  for (const p of drape.pieces) for (let i = 0; i < p.count; i++) assert.ok(Math.abs(p.positions[i * 3 + 2] - 301.3) < 0.2, 'draped on the server, the cover lies on the cube too');
});

test('a piece is placed on a body by side or by point and normal, keeps a row it was given, and is told on when it starts inside', async () => {
  const box = boxMesh([0, 0, 0], [300, 200, 100]), piece = (id, placement) => rect(id, 120, 80, placement ? { placement } : {});
  const design = { materials: canvas, seams: [], bodies: [{ id: 'case', source: { mesh: box }, clearance: 2 }], patterns: [piece('lid', { body: 'case', side: 'top' }), piece('front', { body: 'case', side: 'front', layer: 1 }), piece('patch', { body: 'case', at: [300, 100, 50], normal: [1, 0, 0], up: [0, 0, 1], offset: [0, 0, 10] }), piece('flattened'), piece('buried')],
    arrangement: [{ pattern: 'flattened', position: [10, 20, 400], rotation: [0, 45, 0] }, { pattern: 'buried', position: [90, 60, 50], rotation: [0, 0, 0] }] };
  const { document, check } = await served(design), rows = Object.fromEntries(document.arrangement.map((a) => [a.pattern, a])), near = (a, b) => a.every((v, k) => Math.abs(v - b[k]) < 1e-3);
  // The middle of each piece is its clearance and 5 mm off the body (and 10 mm more a layer), its face looking away from it.
  const face = (row) => { const o = startPoint([0, 0], row), u = startPoint([1, 0], row), v = startPoint([0, 1], row), a = [0, 1, 2].map((k) => u[k] - o[k]), b = [0, 1, 2].map((k) => v[k] - o[k]); return { v: b, n: [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]] }; };
  assert.ok(near(startPoint([60, 40], rows.lid), [150, 100, 107]) && near(face(rows.lid).n, [0, 0, 1]) && near(face(rows.lid).v, [0, 1, 0]), 'on the top');
  assert.ok(near(startPoint([60, 40], rows.front), [150, -17, 50]) && near(face(rows.front).n, [0, -1, 0]) && near(face(rows.front).v, [0, 0, 1]), 'on the front, a layer out');
  assert.ok(near(startPoint([60, 40], rows.patch), [307, 100, 60]) && near(face(rows.patch).n, [1, 0, 0]) && near(face(rows.patch).v, [0, 0, 1]), 'at a point, along its normal');
  assert.deepEqual([rows.flattened.position, rows.flattened.rotation], [[10, 20, 400], [0, 45, 0]], 'a piece that arrives with a 3D row starts there');
  assert.equal(check.ok, true); assert.deepEqual(check.bodies.map((w) => [w.pattern, w.inside]), [['buried', 'case']]); assert.match(check.bodies[0].message, /starts \d+ mm inside 'case'/);
  for (const [bad, message] of [[{ bodies: [{ id: 'a', source: {} }] }, /source must be one of/], [{ bodies: [{ id: 'a', source: { step: 'part.step' } }] }, /absolute path/], [{ bodies: [{ id: 'a', source: { mesh: { positions: [0, 0, 0], indices: [0, 1, 2] } } }] }, /three to a vertex/], [{ bodies: [{ id: 'a', source: { mesh: box } }, { id: 'a', source: { mesh: box } }] }, /Two bodies/],
    [{ bodies: [{ id: 'a', source: { mesh: box }, clearance: -1 }] }, /clearance/], [{ patterns: [piece('p', { body: 'nobody', side: 'top' })] }, /missing body/], [{ bodies: [{ id: 'a', source: { mesh: box } }], patterns: [piece('p', { body: 'a', side: 'above' })] }, /side 'above'/], [{ patterns: [piece('p', { region: 'elbow' })] }, /region 'elbow'/],
    [{ patterns: [piece('p')], arrangement: [{ pattern: 'p', position: [0, 0, 0], rotation: [0, 0, 0], wrap: { radius: 0, centre: 0 } }] }, /wrap/], [{ simulation: { floor: 'low' } }, /floor/]]) assert.throws(() => validateSoftgoodsDocument({ version: 1, patterns: [], seams: [], ...bad }), (e) => e instanceof GraphError && message.test(e.message), String(message));
});

test('the full avatar: its chest, waist and hip are the stated girths, a size fills in what is not given, and the old avatar is untouched', () => {
  for (const avatar of [{ size: 'S' }, { size: 'M' }, { size: 'XL', pose: 'seated' }, { height: 1650, chest: 880, waist: 700, hip: 960, depth: 230 }, { size: 'L', waist: 1000, pose: 't' }]) {
    const m = measureAvatar(avatar), body = fullAvatarBody(m);
    for (const level of ['chest', 'waist', 'hip']) { const round = bodyCircumference(body, body.levels[level], ['torso']); assert.ok(Math.abs(round - m[level]) < 0.01 * m[level], `${JSON.stringify(avatar)} ${level}: ${round.toFixed(1)} round, stated ${m[level]}`); }
    assert.deepEqual(measureAvatar(m), m, 'a measured avatar measures the same again');
    assert.ok(Math.abs(Math.min(...body.shapes.filter((s) => s.type === 'capsule').flatMap((s) => [s.a[2] - s.r, s.b[2] - s.r]))) < 0.01, 'the feet are on the floor');
    assert.deepEqual(body.shapes.map((s) => s.name).slice(0, 9), ['torso', 'neck', 'head', 'left-upper-arm', 'left-forearm', 'left-hand', 'left-thigh', 'left-calf', 'left-foot']);
  }
  assert.deepEqual(measureAvatar({ size: 'M' }).chest, SIZES.M.chest); assert.equal(measureAvatar({ size: 'M', chest: 1010 }).chest, 1010, 'a field given beside the size replaces its own');
  assert.equal(isFullAvatar({ height: 1700, chest: 900, depth: 250, shoulders: 400, ease: 20, centreZ: 1054 }), false); assert.equal(isFullAvatar({ height: 1700, chest: 900, pose: 'a' }), true);
  assert.throws(() => measureAvatar({ size: 'XXL' }), /size 'XXL' is not one of XS, S, M, L, XL/); assert.throws(() => measureAvatar({ pose: 'lotus' }), /pose/); assert.throws(() => measureAvatar({ size: 'M', joints: { wrist: 10 } }), /joint 'wrist'/);
});

test('joint angles put the elbow, wrist and hand where the arm\'s lengths and angles say', () => {
  const m = measureAvatar({ size: 'M', pose: 't', joints: { leftElbow: 90, rightShoulder: { abduct: 45, flex: 30 }, rightElbow: 0 } }), body = fullAvatarBody(m), shape = (name) => body.shapes.find((s) => s.name === name), near = (a, b, what) => assert.ok(a.every((v, k) => Math.abs(v - b[k]) < 0.01), `${what}: ${a} against ${b}`);
  const upper = 0.55 * m.armLength, fore = 0.45 * m.armLength, hand = 0.02 * m.height, rad = Math.PI / 180;
  // Left (-x), arm level and the elbow bent a right angle: the forearm points forward, -y.
  const S = shape('left-upper-arm').a; near(shape('left-upper-arm').b, [S[0] - upper, S[1], S[2]], 'left elbow'); near(shape('left-forearm').b, [S[0] - upper, S[1] - fore, S[2]], 'left wrist'); near(shape('left-hand').a, [S[0] - upper, S[1] - fore - hand, S[2]], 'left hand');
  // Right, lifted 45 degrees from the side and swung 30 forward, straight.
  const T = shape('right-upper-arm').a, dir = [Math.sin(45 * rad) * Math.cos(30 * rad), -Math.sin(30 * rad), -Math.cos(45 * rad) * Math.cos(30 * rad)]; near(shape('right-forearm').b, T.map((v, k) => v + dir[k] * (upper + fore)), 'right wrist'); near(shape('right-hand').a, T.map((v, k) => v + dir[k] * (upper + fore + hand)), 'right hand');
  assert.ok(Math.abs(S[0] + m.shoulders / 2) < 0.01 && Math.abs(T[0] - m.shoulders / 2) < 0.01, 'the shoulders are the stated width apart');
  // Seated: hips and knees at right angles, so the knee is forward of the hip at its height and the shin hangs straight down to a foot on the floor.
  const seated = fullAvatarBody({ size: 'M', pose: 'seated' }), thigh = seated.shapes.find((s) => s.name === 'left-thigh'), calf = seated.shapes.find((s) => s.name === 'left-calf');
  assert.ok(Math.abs(thigh.a[2] - thigh.b[2]) < 0.01 && thigh.b[1] < thigh.a[1] - 300 && Math.abs(calf.a[1] - calf.b[1]) < 0.01 && calf.b[2] < calf.a[2] - 400);
});

test('a sleeve placed on left-arm starts as a tube round the arm and stays on it, held at the shoulder, in the A pose', async () => {
  const avatar = { size: 'M' }, body = fullAvatarBody(avatar), [S, E, W] = body.limbs['left-arm'].joints, width = 380, length = 450, sleeve = rect('sleeve', width, length, { placement: { region: 'left-arm' } });
  const design = { materials: canvas, patterns: [sleeve], seams: [{ id: 'underarm', a: { pattern: 'sleeve', segment: 'sleeve_right' }, b: { pattern: 'sleeve', segment: 'sleeve_left' }, flip: true }], simulation: { avatar } };
  const placed = await served(design), row = placed.document.arrangement[0];
  assert.equal(placed.document.simulation.avatar.pose, 'a'); assert.deepEqual([row.source, +row.wrap.radius.toFixed(2), row.wrap.centre], ['avatar', +(width / (2 * Math.PI)).toFixed(2), width / 2]); assert.equal(placed.check.bodies, undefined, 'it starts clear of the torso and the arm');
  // Four pins round its top edge stand for the armhole seam; a free tube would slide down a sloping arm and off the hand.
  const pins = [0, 1, 2, 3].map((k) => ({ id: `pin_${k}`, pattern: 'sleeve', at: [width * (k + 0.5) / 4, length], to: startPoint([width * (k + 0.5) / 4, length], row) }));
  const { input } = await served({ ...design, attachments: pins }), along = (a, b, p) => { const ab = [0, 1, 2].map((k) => b[k] - a[k]), t = Math.max(0, Math.min(1, [0, 1, 2].reduce((n, k) => n + (p[k] - a[k]) * ab[k], 0) / (ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2))); return [t, Math.hypot(...[0, 1, 2].map((k) => p[k] - a[k] - ab[k] * t))]; };
  const start = simulate(input, 0), n = start.positions.length / 3, uv = input.meshes[0].uv; for (let i = 0; i < n; i++) assert.ok(Math.abs(along(S, W, P(start, i))[1] - row.wrap.radius) < 0.01, 'every vertex starts on a tube round the line from shoulder to wrist');
  const f = advance(300), upperArm = input.collisionBody.shapes.find((s) => s.name === 'left-upper-arm'), forearm = input.collisionBody.shapes.find((s) => s.name === 'left-forearm'), angles = [];
  // Round the middle of the sleeve, look along the arm: the cloth must still go all the way round it.
  const axis = [0, 1, 2].map((k) => (W[k] - S[k]) / Math.hypot(W[0] - S[0], W[1] - S[1], W[2] - S[2])), e1 = [axis[2], 0, -axis[0]].map((v) => v / Math.hypot(axis[2], axis[0])), e2 = [axis[1] * e1[2] - axis[2] * e1[1], axis[2] * e1[0] - axis[0] * e1[2], axis[0] * e1[1] - axis[1] * e1[0]];
  for (let i = 0; i < n; i++) {
    const p = P(f, i), [t, r] = along(S, W, p), toUpper = along(upperArm.a, upperArm.b, p)[1], toFore = along(forearm.a, forearm.b, p)[1];
    assert.ok(toUpper > upperArm.r + RADIUS - 0.05 && toFore > forearm.r + RADIUS - 0.05, 'no vertex is inside the arm'); assert.ok(r < 2 * row.wrap.radius && t > 0 && t < 1, `the sleeve is still on the arm: ${r.toFixed(0)} mm from it, ${t.toFixed(2)} of the way down`);
    if (Math.abs(uv[i * 2 + 1] - length / 2) < 30) { const q = [0, 1, 2].map((k) => p[k] - S[k]); angles.push(Math.atan2(q[0] * e2[0] + q[1] * e2[1] + q[2] * e2[2], q[0] * e1[0] + q[1] * e1[1] + q[2] * e1[2])); }
  }
  angles.sort((a, b) => a - b); const gaps = angles.map((a, i) => (i ? a - angles[i - 1] : a + 2 * Math.PI - angles.at(-1))); assert.ok(Math.max(...gaps) < Math.PI / 2, `the cloth goes round the arm: its widest gap is ${(Math.max(...gaps) * 180 / Math.PI).toFixed(0)} degrees`);
  // On the old avatar a limb is an error that says what to do, and the limb regions are valid on a design with no avatar at all.
  await assert.rejects(served({ ...design, simulation: { avatar: { height: 1700, chest: 900 } } }), /needs the full avatar/);
});

test('a body and the full avatar together: the page and the server drape the same input, and the fit report has the limbs', async () => {
  // A pack on the back of a seated figure, a cover laid on the pack, and a tunic on the figure.
  const pack = boxMesh([-140, 160, 500], [140, 300, 950]), cover = rect('cover', 240, 120, { placement: { body: 'pack', side: 'top' } }), design = { ...tunic(), materials: canvas, bodies: [{ id: 'pack', name: 'backpack', source: { mesh: pack }, friction: 0.8, clearance: 2 }], simulation: { avatar: { size: 'M', joints: { elbow: 20 } } } };
  design.patterns = [...design.patterns, cover];
  const { input, document, check } = await served(design, 40), body = input.collisionBody;
  assert.deepEqual(input, JSON.parse(JSON.stringify(simulationInput(document, 40))), 'the server drapes what the page is given');
  assert.deepEqual(body.shapes.map((s) => s.type).join(' '), 'mesh capsule ellipsoid capsule capsule capsule capsule capsule capsule capsule capsule capsule capsule capsule capsule mesh');
  const shape = body.shapes.at(-1); assert.deepEqual([shape.id, shape.name, shape.friction, shape.clearance, shape.min, shape.max], ['pack', 'backpack', 0.8, 2, [-140, 160, 500], [140, 300, 950]]);
  assert.equal(body.floor, 0, 'with an avatar the floor stays where it stands'); assert.deepEqual(Object.keys(body.levels), ['shoulder', 'chest', 'waist', 'hip']); assert.deepEqual(Object.keys(body.limbs), ['left-arm', 'left-leg', 'right-arm', 'right-leg']);
  assert.equal(check.bodies, undefined); assert.equal(document.simulation.avatar.joints.elbow.flex, 20);
  // The solver's frame names the mesh shapes but does not carry their triangles every step.
  const frame = simulate(input, 2); assert.deepEqual(frame.body.at(-1), { type: 'mesh', name: 'backpack', id: 'pack' }); assert.deepEqual(frame.body[1], body.shapes[1]);
  const drape = drapeDocument(document, { target: 40, steps: 300 }), fit = fitReport(document, drape), by = Object.fromEntries(fit.ease.map((e) => [e.level, e]));
  assert.deepEqual(fit.ease.map((e) => e.level), ['chest', 'waist', 'hip', 'left-upper-arm', 'left-thigh', 'right-upper-arm', 'right-thigh']);
  for (const e of fit.ease) assert.ok(Math.abs(e.body - e.stated) < 0.01 * e.stated, `${e.level}: the body is ${e.body} round, stated ${e.stated}`);
  // The tunic is 1040 round: it closes round the waist with that much less the waist's 840 to spare, and has no sleeves or legs.
  assert.ok(by.waist.closed && Math.abs(by.waist.ease - 200) < 15, `ease at the waist: ${by.waist.ease}`); assert.equal(by['left-upper-arm'].closed, false); assert.equal(by['left-thigh'].ease, null);
  assert.match(fit.notes.join(' '), /built to the stated girths/);
  // The cover has settled on the pack, and stayed there.
  const lid = drape.pieces.find((p) => p.id === 'cover'); for (let i = 0; i < lid.count; i++) assert.ok(lid.positions[i * 3 + 2] > 950 && lid.positions[i * 3 + 2] < 953.5, `the cover lies on the pack: ${lid.positions[i * 3 + 2].toFixed(1)}`);
  // avatar: null takes the avatar away, where saying nothing keeps it; the bodies then stand alone on their own floor.
  const doc = new SoftgoodsDocument(null), app = express(); app.use(express.json({ limit: '50mb' })); app.use('/s', softgoodsRouter(doc)); const server = await listening(app);
  const call = async (p, method = 'GET', b) => (await fetch(`http://127.0.0.1:${server.address().port}/s${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: b && JSON.stringify(b) })).json();
  try {
    await call('/document', 'PUT', { version: 1, ...design }); const bag = { version: 1, materials: canvas, patterns: [cover], seams: [], bodies: design.bodies };
    assert.equal((await call('/document', 'PUT', bag)).simulation.avatar.size, 'M', 'a design set again keeps its avatar');
    const alone = await call('/document', 'PUT', { ...bag, simulation: { avatar: null } }); assert.equal(alone.simulation.avatar, null);
    const only = (await call('/simulation-input')).collisionBody; assert.deepEqual([only.shapes.length, only.floor], [1, 500]);
  } finally { server.close(); server.closeAllConnections(); }
});

test('the MCP set tool takes bodies, body placement, the full avatar and the floor, and says what they are', async () => {
  const tools = {}, calls = []; registerSoftgoodsTools({ registerTool: (name, spec, handler) => { tools[name] = { spec, handler }; } }, { call: async (p, o) => { calls.push([p, o]); return p === '/softgoods/document' ? { revision: 1, patterns: [], seams: [], arrangement: [], simulation: { avatar: o.body.simulation.avatar }, bodies: o.body.bodies } : {}; }, ok: (v) => v, fail: (e) => { throw e; } });
  const set = tools.cadgang_softgoods_set, schema = z.object(set.spec.inputSchema);
  const design = schema.parse({ patterns: [rect('cover', 200, 100, { placement: { body: 'case', at: [0, 0, 50], normal: [0, 0, 1], up: [0, 1, 0], layer: 1 } }), rect('sleeve', 300, 400, { placement: { region: 'left-arm' } })], seams: [],
    bodies: [{ id: 'case', source: { model: true, body: 'lid#0' }, clearance: 2, friction: 0.4, scale: 1000, transform: { position: [0, 0, 100], rotation: [0, 0, 90] } }, { id: 'block', source: { mesh: boxMesh([0, 0, 0], [10, 10, 10]) } }, { id: 'file', source: { step: '/parts/base.step' }, deflection: 0.005 }],
    avatar: { size: 'L', waist: 900, pose: 'seated', joints: { leftElbow: 45, shoulder: { abduct: 20, flex: 10 } } }, floor: false });
  assert.equal(design.patterns[0].placement.body, 'case'); assert.equal(design.avatar.joints.shoulder.flex, 10); assert.equal(design.bodies[0].source.model, true);
  const result = await set.handler(design), sent = calls[0][1].body; assert.deepEqual(sent.simulation, { status: 'not_run', avatar: design.avatar, floor: false }); assert.equal(sent.bodies.length, 3); assert.deepEqual(result.bodies[1], { id: 'block', source: { mesh: '12 triangles' } });
  await set.handler(schema.parse({ patterns: [], seams: [], avatar: null })); assert.equal(calls[2][1].body.simulation.avatar, null, 'avatar: null goes through, to take the avatar away');
  await set.handler(schema.parse({ patterns: [], seams: [] })); assert.equal('avatar' in calls[4][1].body.simulation, false);
  assert.throws(() => schema.parse({ patterns: [], seams: [], avatar: { size: 'XXL' } })); assert.throws(() => schema.parse({ patterns: [], seams: [], bodies: [{ id: 'a', source: {}, clearance: -1 }] }));
  for (const word of ['Bodies', 'source', 'clearance', 'left-arm', 'seated', 'NOT from a standard', 'check.bodies', 'avatar: null']) assert.ok(set.spec.description.includes(word), `the guide says '${word}'`);
});
