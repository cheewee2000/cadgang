// The softgoods review's 3D view: its colour ramps and piece colours run here; what needs a browser (WebGL, the camera)
// is pinned in the source, as test/softgoods-document.test.js does for the page.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import express from 'express';
import { SoftgoodsDocument } from '../src/core/softgoods-document.js';
import { softgoodsRouter } from '../src/server/softgoods.js';
import { strainRGB, pressureRGB, css, materialHue, materialCss, seamCss, seamSide, sideLabel, cutLine, isCadBody, floorOf, nearestVertex, trimShapes, placeOnRow } from '../web/softgoods-view.js';
import { simulate } from '../web/softgoods-worker.js';

const read = (name) => fs.readFileSync(new URL(`../web/${name}`, import.meta.url), 'utf8');
const near = (a, b) => a.every((v, k) => Math.abs(v - b[k]) < 1e-6);

test('the strain map is neutral at rest, blue in compression, red in tension, and does not jump at zero', () => {
  const rest = strainRGB(0);
  assert.ok(Math.max(...rest) - Math.min(...rest) < 0.05 && rest[0] > 0.85, 'cloth at rest is a light neutral, so shading still reads under the map');
  assert.ok(near(strainRGB(-1e-9), rest) && near(strainRGB(1e-9), rest), 'a strain of a hair either side of zero is the same colour');
  const squeezed = strainRGB(-0.1), pulled = strainRGB(0.2), half = strainRGB(0.1);
  assert.ok(squeezed[2] > 0.9 && squeezed[0] < 0.3, 'compression runs to blue'); assert.ok(pulled[0] > 0.8 && pulled[1] < 0.2 && pulled[2] < 0.2, 'tension runs to red');
  assert.ok(half[0] > 0.9 && half[1] > 0.7 && half[2] < 0.4, 'through yellow half way');
  assert.deepEqual(strainRGB(-5), squeezed); assert.deepEqual(strainRGB(5), pulled);
  assert.equal(css(pulled), 'rgb(219,25,20)');
});

test('the pressure map runs from neutral at no contact to red at the frame\'s highest, whatever the highest is', () => {
  assert.deepEqual(pressureRGB(0, 400), strainRGB(0)); assert.deepEqual(pressureRGB(400, 400), strainRGB(0.2)); assert.deepEqual(pressureRGB(9, 3), pressureRGB(3, 3));
  for (const max of [0, undefined, NaN]) assert.ok(pressureRGB(0, max).every(Number.isFinite), 'a frame with no contact still has a colour');
  assert.ok(pressureRGB(undefined, 5).every(Number.isFinite));
});

test('a piece takes its material\'s colour: the material\'s own, or a hue no other listed material has', () => {
  const materials = { canvas: {}, ripstop: {}, mesh: {}, binding: { color: '#224466' } }, hue = (name) => Number(/^hsl\(([\d.]+),/.exec(materialCss(materials, name))[1]);
  assert.equal(materialCss(materials, 'binding'), '#224466');
  const hues = ['canvas', 'ripstop', 'mesh'].map(hue);
  for (let i = 0; i < hues.length; i++) for (let j = 0; j < i; j++) { const d = Math.abs(hues[i] - hues[j]); assert.ok(Math.min(d, 360 - d) > 60, `${hues[i]} and ${hues[j]} are told apart`); }
  assert.equal(materialCss(materials, 'canvas'), materialCss({ ...materials }, 'canvas'), 'and keeps it from one draw to the next');
  assert.equal(materialCss(materials, 'unlisted'), materialCss({}, 'unlisted')); assert.equal(materialHue('unlisted'), materialHue('unlisted')); assert.ok(materialHue('a') >= 0 && materialHue('a') < 360);
  assert.notEqual(seamCss(0), seamCss(1)); assert.equal(seamCss(-1), seamCss(0), 'a seam the schedule does not list still has a colour');
});

test('the review camera is the viewer\'s: the shared input, and the Trackpad / Mouse choice read from cadgang-view', () => {
  const page = read('softgoods.js'), view = read('softgoods-view.js');
  assert.match(page, /localStorage\.getItem\('cadgang-view'\)\)\?\.scroll==='mouse'\?'mouse':'trackpad'/); assert.match(page, /createClothView\(\{host:\$\('#view3d'\),scheme,/);
  assert.match(view, /import \{ attachOrbitInput \} from '\.\/orbitinput\.js'/); assert.match(view, /attachOrbitInput\(el, \{ orbit, camera, THREE, scheme,/);
  assert.doesNotMatch(view, /addEventListener\('wheel'/, 'the view does not read the wheel itself');
  assert.match(page, /e\.key\.toLowerCase\(\)==='f'/); for (const name of ['front', 'back', 'left', 'right', 'top']) assert.match(read('softgoods.html'), new RegExp(`data-view="${name}"`));
});

test('without WebGL the page keeps the painter\'s view, and a frame never allocates geometry', () => {
  const page = read('softgoods.js'), view = read('softgoods-view.js'), html = read('softgoods.html');
  assert.match(page, /try\{view=createClothView\(/); assert.match(page, /catch\(e\)\{console\.warn\('softgoods: WebGL is not available/);
  assert.match(page, /const lit=!!view&&\(!!frame\|\|loading\);/); assert.match(html, /id="arrangeCanvas"/); assert.match(html, /id="view3d"/);
  const draw = view.slice(view.indexOf('function draw('), view.indexOf('// ---- camera'));
  assert.ok(draw.length > 500); assert.doesNotMatch(draw, /new THREE\.|new Float32Array|new LineSegments/, 'drawing a frame writes into the buffers build() made');
  assert.match(draw, /computeVertexNormals\(\)/); assert.match(view, /setUsage\(THREE\.DynamicDrawUsage\)/); assert.match(view, /side: THREE\.DoubleSide/);
});

test('the page gets each pattern\'s cut line from the server: the contour the DXF carries', async () => {
  const doc = new SoftgoodsDocument(null), app = express(); app.use(express.json()); app.use('/s', softgoodsRouter(doc));
  doc.addRectangle({ id: 'panel', width: 300, height: 400, allowance: 12 });
  const server = app.listen(0);
  try {
    const cut = await (await fetch(`http://127.0.0.1:${server.address().port}/s/cut`)).json(), xs = cut.panel[0].map((q) => q[0]), ys = cut.panel[0].map((q) => q[1]);
    assert.deepEqual([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)], [-12, 312, -12, 412]);
  } finally { server.close(); }
});

test('a seam side is read as a span: one edge, part of one, or several in a row, and only the sewn part of its line is taken', () => {
  assert.deepEqual(seamSide({ pattern: 'front', segment: 'hem' }), { pattern: 'front', segments: ['hem'], from: 0, to: 1 });
  assert.deepEqual(seamSide({ pattern: 'front', segments: ['hem', 'side'], from: 0.25 }), { pattern: 'front', segments: ['hem', 'side'], from: 0.25, to: 1 });
  assert.equal(sideLabel({ pattern: 'front', segment: 'hem' }), 'front.hem'); assert.equal(sideLabel({ pattern: 'front', segments: ['hem', 'side'], from: 0.25, to: 0.5 }), 'front.hem+side 0.25-0.5');
  // An L of 100 mm then 100 mm: from a quarter to three quarters of its length is 50 mm of each leg, through the corner.
  const corner = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }];
  assert.deepEqual(cutLine(corner, 0.25, 0.75), [{ x: 50, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }]); assert.deepEqual(cutLine(corner, 0, 1), corner);
  assert.deepEqual(cutLine(corner, 0.6, 0.9), [{ x: 100, y: 20 }, { x: 100, y: 80 }]); assert.deepEqual(cutLine([], 0, 1), []);
});

test('the page shows what the physics adds, for review: sewn spans, elastics, creased folds, stuffing, frozen pieces, and both exports', () => {
  const page = read('softgoods.js'), view = read('softgoods-view.js'), html = read('softgoods.html');
  assert.match(page, /path\(spanLine\(p,seg,side\),\{width:5,color:seamCss\(i\)\}\)/, 'the 2D pattern colours the sewn span, not the whole edge');
  assert.match(view, /between\(pairs\[k - 1\]\.a, A\.off\), b: between\(pairs\[k\]\.a, A\.off\)/, 'and the 3D seam line runs through the seam\'s own pairs');
  assert.match(view, /runs\(input\?\.elastics, BLACK\)/); assert.match(view, /runs\(input\?\.folds, BLACK\)/); assert.match(page, /for\(const e of doc\.elastics\|\|\[\]\)/); assert.match(page, /if\(s\.elastic\)for\(const side of\[s\.a,s\.b\]\)/);
  assert.match(page, /a\.angle!=null\?` \$\{a\.angle\}°`/); assert.match(page, /\(frame\.stuffing\|\|\[\]\)\.map\(g=>` · stuffing \$\{g\.id\} \$\{Number\(g\.volume\)\.toFixed\(2\)\} L at/);
  assert.match(page, /p\.freeze\?' · FROZEN':''/); assert.match(page, /doc\.materials\[p\.material\]\.preset/); assert.match(page, /check\.physics\|\|\[\]/);
  // Every toggle is drawn inverted while it is on; the exports are actions.
  assert.match(page, /\$\('#map'\)\.classList\.toggle\('on',mapMode!=='off'\)/); assert.match(page, /\$\('#wire'\)\.classList\.toggle\('on'\)/); assert.match(page, /\$\('#simulate'\)\.classList\.toggle\('on',running\)/);
  assert.match(html, /id="exportDrape"/); assert.match(page, /\$\('#exportDrape'\)\.onclick=exportAs\(\['glb','obj','fit'\]\)/);
});

test('bodies: a CAD mesh is told from the avatar\'s torso, the floor is where the solver puts it, and frames reuse the input\'s meshes', () => {
  assert.equal(isCadBody({ type: 'mesh', id: 'can', name: 'can' }), true); assert.equal(isCadBody({ type: 'mesh', name: 'torso' }), false); assert.equal(isCadBody({ type: 'capsule', name: 'left-forearm', id: 'x' }), false);
  assert.equal(floorOf({}), 0); assert.equal(floorOf({ floor: 12.5 }), 12.5); assert.equal(floorOf({ floor: false }), null);
  const view = read('softgoods-view.js'), page = read('softgoods.js');
  assert.match(view, /s\.type === 'mesh' && s\.positions\?\.length && s\.indices\?\.length/, 'a mesh shape is built from the input, once');
  assert.match(view, /isCadBody\(s\) \? cadMat : bodyMat/, 'a CAD body in its own grey, the avatar\'s torso as the body');
  assert.match(view, /else if \(s\.a && s\.b && s\.r > 0\)/, 'every capsule, the neck and the limbs among them, is drawn');
  assert.match(view, /function setInput\(next\) \{[^\n]*setBody\(next\?\.collisionBody\?\.shapes\)/, 'bodies come from the input, never from a frame');
  assert.match(view, /ground\.visible = floor != null/, 'floor: false draws no floor'); assert.match(view, /floor != null && box\.min\.z - floor </);
  assert.match(page, /\(frame\.body\|\|\[\]\)\.filter\(s=>s\.type!=='mesh'\)/, 'the painter\'s view skips a frame\'s bare mesh entries');
});

test('trims: spots become discs on both pieces, runs become lines filled in along their edge, and a spot finds its nearest vertex', () => {
  const uv = [0, 0, 10, 0, 10, 10, 0, 10, 5, 5];
  assert.equal(nearestVertex(uv, 6, 4), 4); assert.equal(nearestVertex(uv, 6, 4, [0, 1, 2, 3]), 1, 'held to the edge vertices it is given'); assert.equal(nearestVertex([], 0, 0), -1);
  const { discs, runs } = trimShapes([
    { id: 'rivet', type: 'point', points: [{ pattern: 'front', x: 4, y: 5 }] },
    { id: 'buttons', type: 'tack', attachments: [{ pattern: 'front', at: [1, 2], to: { pattern: 'back', at: [3, 4] } }] },
    { id: 'zip', type: 'seam', pairs: [{ a: { pattern: 'front', x: 0, y: 0 }, b: { pattern: 'back', x: 0, y: 20 } }, { a: { pattern: 'front', x: 0, y: 20 }, b: { pattern: 'back', x: 0, y: 0 } }] },
    { id: 'binding', type: 'strip', paths: [{ pattern: 'front', points: [[0, 0], [12, 0]] }] },
  ]);
  assert.deepEqual(discs, [{ trim: 'rivet', pattern: 'front', at: [4, 5] }, { trim: 'buttons', pattern: 'front', at: [1, 2] }, { trim: 'buttons', pattern: 'back', at: [3, 4] }]);
  assert.deepEqual(runs.map((r) => [r.trim, r.pattern, r.points.length]), [['zip', 'front', 5], ['zip', 'back', 5], ['binding', 'front', 4]]);
  assert.deepEqual(runs[2].points, [[0, 0], [4, 0], [8, 0], [12, 0]]); assert.deepEqual(trimShapes(undefined), { discs: [], runs: [] });
  const view = read('softgoods-view.js'), page = read('softgoods.js'), html = read('softgoods.html');
  assert.match(view, /shapes = trimShapes\(next\?\.trims\)/); assert.match(view, /vertexAt\(r\.pattern, q, true\)/, 'a run keeps to the edge');
  assert.match(view, /for \(const set of \[outline, seamLines, elasticEdge, elasticCore, foldLines, trimLines\]\) set\.write\(P\)/);
  assert.match(page, /l\.layer==='TOPSTITCH'\?\{dash:\[4,3\],color\}/, 'topstitch rows dashed in 2D'); assert.match(page, /api\('\/trim-marks'\)/);
  assert.match(html, /<div id="seams"><\/div><div id="trims"><\/div>/, 'the TRIMS schedule sits under the seams'); assert.match(page, /el\.innerHTML='<b>TRIMS<\/b>'/);
  assert.match(page, /select\(trimPattern\(t\)\|\|selectedPattern,t\.id===selectedTrim\?null:t\.id\)/, 'a click picks a trim out, a second click lets it go');
});

test('the page gets each pattern\'s trim marks, one entry per trim, and a flattened piece says where it came from', async () => {
  const doc = new SoftgoodsDocument(null), app = express(); app.use(express.json()); app.use('/s', softgoodsRouter(doc));
  doc.addRectangle({ id: 'panel', width: 300, height: 400, allowance: 12 }); doc.addTrim({ id: 'rivet', kind: 'rivet', spec: { diameter: 9 }, at: { pattern: 'panel', u: 50, v: 60 } });
  const server = app.listen(0);
  try {
    const marks = await (await fetch(`http://127.0.0.1:${server.address().port}/s/trim-marks`)).json();
    assert.equal(marks.panel.length, 1); assert.equal(marks.panel[0].trim, 'rivet'); assert.deepEqual(marks.panel[0].drills[0].at, [50, 60]); assert.ok(marks.panel[0].lines.every((l) => l.layer === 'DRILL'));
  } finally { server.close(); }
  const page = read('softgoods.js');
  assert.match(page, /flattened from \$\{esc\(q\.body\|\|'a body'\)\}/); assert.match(page, /'lies flat':`does not lie flat: strain \$\{\(\(q\.distortion\?\.maxStrain\|\|0\)\*100\)\.toFixed\(1\)\}%`/);
});

test('the page places a piece from its arrangement row where the solver starts it, wrap included, so a wrapped piece never shows flat', () => {
  const uv = [0, 0, 40, 0, 40, 30, 0, 30, 20, 15], row = { pattern: 'p', position: [10, -20, 300], rotation: [90, 15, 30], wrap: { radius: 25, centre: 20 } };
  const input = { meshes: [{ id: 'p', uv, triangles: [0, 1, 4, 1, 2, 4, 2, 3, 4, 3, 0, 4], edges: [], boundaryCount: 4, segmentVertices: {} }], seams: [], attachments: [], arrangement: [row], materials: {}, patterns: [{ id: 'p' }] };
  const start = simulate(input, 0).positions;
  for (let i = 0; i < uv.length / 2; i++) assert.ok(placeOnRow(uv[2 * i], uv[2 * i + 1], row).every((v, k) => Math.abs(v - start[3 * i + k]) < 1e-3), `vertex ${i} starts where the page puts it`);   // float32 positions
  assert.ok(Math.abs(placeOnRow(0, 0, row)[2] - placeOnRow(0, 0, { ...row, wrap: undefined })[2]) > 1 || Math.abs(placeOnRow(0, 0, row)[1] - placeOnRow(0, 0, { ...row, wrap: undefined })[1]) > 1, 'and the wrap moves it');
  assert.match(read('softgoods.js'), /fill\(sample\(p,s\)\)\.map\(q=>placeOnRow\(q\.x,q\.y,a\)\)/, 'the painter\'s outlines use it');
});
