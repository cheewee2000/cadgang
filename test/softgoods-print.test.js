// Paper at 1:1: the tiles cover the whole piece, the page is the paper's size in mm, and the check square is exactly 100 mm.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SoftgoodsDocument, validateSoftgoodsDocument } from '../src/core/softgoods-document.js';
import { cutContours, patternDXF } from '../src/core/softgoods-export.js';
import { dxfEntities } from '../src/core/softgoods-marker.js';
import { gradeDocument } from '../src/core/softgoods-operations.js';
import { patternSVG, printHTML, tileLayout, PAPERS } from '../src/core/softgoods-print.js';
import { tee } from './fixtures/softgoods-tee.js';

const panel = () => { const d = new SoftgoodsDocument(null); d.addRectangle({ id: 'front', name: 'Front panel', width: 200, height: 150, allowance: 12 }); const json = d.toJSON(); json.patterns[0].notches.push({ segment: 'front_right', at: 0.5, depth: 4 }); return json; };
const numbers = (d) => d.match(/-?\d+(\.\d+)?/g).map(Number);

test('tiles cover the whole drawing and neighbours share exactly the overlap', () => {
  for (const options of [{}, { paper: 'letter' }, { margin: 6, overlap: 0 }, { paper: 'letter', orientation: 'landscape', overlap: 15 }]) for (const [w, h] of [[50, 60], [190, 277], [190.01, 277.01], [500, 700], [1234.5, 87], [370, 544]]) {
    const t = tileLayout(w, h, options), overlap = options.overlap ?? 10, at = (r, c) => t.tiles.find((q) => q.row === r && q.col === c);
    assert.equal(t.tiles.length, t.rows * t.cols); assert.equal(at(1, 1).x, 0); assert.equal(at(1, 1).y, 0);
    for (let c = 1; c < t.cols; c++) assert.ok(Math.abs(at(1, c).x + at(1, c).width - at(1, c + 1).x - overlap) < 1e-9, 'columns share the overlap');
    for (let r = 1; r < t.rows; r++) assert.ok(Math.abs(at(r, 1).y + at(r, 1).height - at(r + 1, 1).y - overlap) < 1e-9, 'rows share the overlap');
    const last = at(t.rows, t.cols); assert.ok(last.x + last.width >= w - 1e-9 && last.y + last.height >= h - 1e-9, `the last tile reaches the far corner of ${w} × ${h}`);
    // No page is wasted: one column or row fewer would not reach.
    if (t.cols > 1) assert.ok(at(1, t.cols).x + overlap < w); if (t.rows > 1) assert.ok(at(t.rows, 1).y + overlap < h);
    assert.ok(Math.abs(t.window[0] + 2 * t.margin - t.page[0]) < 1e-9 && Math.abs(t.window[1] + 2 * t.margin - t.page[1]) < 1e-9);
  }
  assert.equal(tileLayout(190, 277).tiles.length, 1); assert.equal(tileLayout(190.01, 277).cols, 2);
  assert.deepEqual([tileLayout(500, 700).cols, tileLayout(500, 700).rows], [3, 3]);      // 190 × 277 window stepping 180 × 267
  assert.deepEqual(tileLayout(10, 10, { paper: 'letter', orientation: 'landscape' }).page, [279.4, 215.9]);
  assert.throws(() => tileLayout(10, 10, { paper: 'a3' }), /Unknown paper 'a3'/); assert.throws(() => tileLayout(10, 10, { margin: 95 }), /fresh paper/);
});

test('every page is the paper in mm, and page 1 carries a 100 mm and a 4 inch check square', () => {
  for (const [paper, size] of Object.entries(PAPERS)) {
    const html = printHTML(panel(), { name: 'pouch', paper }), pages = html.match(/<section class="page">.*?<\/section>/gs);
    assert.ok(html.includes(`@page{size:${size[0]}mm ${size[1]}mm;margin:0}`));
    for (const p of pages) assert.ok(p.includes(`<svg xmlns="http://www.w3.org/2000/svg" width="${size[0]}mm" height="${size[1]}mm" viewBox="0 0 ${size[0]} ${size[1]}">`), 'one SVG unit is one mm');
    assert.match(pages[0], /<rect class="frame scale-100mm" x="[\d.]+" y="[\d.]+" width="100" height="100"\/>/);
    assert.match(pages[0], /<rect class="frame scale-4in" x="[\d.]+" y="[\d.]+" width="101.6" height="101.6"\/>/);
    assert.match(pages[0], /PRINT AT 100% \(ACTUAL SIZE\)/); assert.ok(!pages.slice(1).some((p) => p.includes('scale-100mm')));
    // Both squares are wholly on the page.
    for (const [, x, y, s] of pages[0].matchAll(/scale-\w+" x="([\d.]+)" y="([\d.]+)" width="([\d.]+)"/g)) assert.ok(+x + +s <= size[0] - 10 && +y + +s <= size[1] - 10);
  }
  const landscape = printHTML(panel(), { orientation: 'landscape' }).match(/<section class="page">.*?<\/section>/s)[0];
  for (const [, x, y, s] of landscape.matchAll(/scale-\w+" x="([\d.]+)" y="([\d.]+)" width="([\d.]+)"/g)) assert.ok(+x + +s <= 287 && +y + +s <= 200);
});

test('page counts: a cover plus every tile of every piece, each labelled with its row and column', () => {
  const html = printHTML(panel(), { name: 'pouch' }), pages = html.match(/<section class="page">/g);
  assert.equal(pages.length, 3, 'a 230 × 180 drawing takes two A4 columns, after the cover');     // cut 224 × 174 plus 3 mm all round
  assert.match(html, /FRONT PANEL · CUT 1 · CANVAS · ROW 1 OF 1 · COL 1 OF 2 · PAGE 2 OF 3/); assert.match(html, /ROW 1 OF 1 · COL 2 OF 2 · PAGE 3 OF 3/);
  assert.match(html, /FRONT PANEL · 1 × 2 · P2-3/);
  assert.equal(html.match(/class="mark"/g).length, 2, 'the one registration diamond is printed on both pages that share the join');
  const d = validateSoftgoodsDocument(tee());
  const tiles = (doc) => doc.patterns.reduce((sum, p) => { const lines = dxfEntities(patternDXF(p)).lines, xs = lines.flatMap((l) => [l.a[0], l.b[0]]), ys = lines.flatMap((l) => [l.a[1], l.b[1]]); return sum + tileLayout(Math.max(...xs) - Math.min(...xs) + 6, Math.max(...ys) - Math.min(...ys) + 6).tiles.length; }, 0);
  const two = printHTML(d, { name: 'tee', sizes: ['base', 'L'] });
  assert.equal(printHTML(d, { name: 'tee' }).match(/<section class="page">/g).length, 1 + tiles(d));
  assert.equal(two.match(/<section class="page">/g).length, 1 + tiles(d) + tiles(gradeDocument(d, d.grades[0]))); assert.match(two, /FRONT · SIZE L · CUT 1 · JERSEY · ROW 1 OF 3/);
  assert.throws(() => printHTML({ patterns: [] }), /No softgoods patterns/);
});

test('each tile shows its window of the piece at true scale: cut, stitch, grain and notch lines, clipped to the frame', () => {
  const html = printHTML(panel(), { name: 'pouch' }), pages = html.match(/<section class="page">.*?<\/section>/gs).slice(1);
  for (const layer of ['CUT', 'STITCH', 'GRAIN', 'NOTCH', 'ALLOWANCE']) assert.ok(pages[0].includes(`class="ln ${layer}"`), layer);
  assert.match(pages[0], /<clipPath id="tile1"><rect x="10" y="10" width="190" height="277"\/>/); assert.match(pages[0], /<g transform="translate\(10 10\)">/); assert.match(pages[1], /<g transform="translate\(-170 10\)">/);
  // The cut line is the 224 × 174 rectangle, 3 mm in from the drawing's corner, in mm.
  const cut = numbers(pages[0].match(/class="ln CUT" d="([^"]+)"/)[1]), xs = cut.filter((_, i) => i % 2 === 0), ys = cut.filter((_, i) => i % 2 === 1);
  assert.deepEqual([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)], [3, 227, 3, 177]);
  assert.match(pages[0], /Front panel {2}CUT 1 {2}canvas/);
  assert.ok(!/font-weight:\s*(bold|[5-9]00)|italic|border-radius:\s*[1-9]/.test(html)); assert.match(html, /font-family:"Space Mono",monospace;font-weight:400/); assert.ok(!/https?:\/\/(?!www\.w3\.org)/.test(html), 'self-contained: nothing is fetched');
});

test('a pattern exports as a plain 1:1 SVG with a group per layer and a closed cut path', () => {
  const p = panel().patterns[0], svg = patternSVG(p);
  assert.match(svg, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" width="234mm" height="184mm" viewBox="0 0 234 184">/);      // cut 224 × 174 plus 5 mm all round
  for (const layer of ['STITCH', 'CUT', 'ALLOWANCE', 'NOTCH', 'GRAIN', 'TEXT']) assert.ok(svg.includes(`<g id="${layer}"`), layer);
  assert.match(svg, /<g id="CUT" fill="none" stroke="#000000" stroke-width="0.25"><path d="M5 179L229 179L229 5L5 5Z"\/>/);
  assert.equal(cutContours(p)[0].length, 4); assert.match(svg, />Front panel {2}CUT 1 {2}canvas</);
});
