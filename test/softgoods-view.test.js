// The softgoods review's 3D view: its colour ramps and piece colours run here; what needs a browser (WebGL, the camera)
// is pinned in the source, as test/softgoods-document.test.js does for the page.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import express from 'express';
import { SoftgoodsDocument } from '../src/core/softgoods-document.js';
import { softgoodsRouter } from '../src/server/softgoods.js';
import { strainRGB, pressureRGB, css, materialHue, materialCss, seamCss } from '../web/softgoods-view.js';

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
