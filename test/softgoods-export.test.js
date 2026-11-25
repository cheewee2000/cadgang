import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SoftgoodsDocument } from '../src/core/softgoods-document.js';
import { patternDXF, cutContours, techPack, exportSoftgoods } from '../src/core/softgoods-export.js';

function design() {
  const d = new SoftgoodsDocument(null); const a = d.addRectangle({ id: 'front', name: 'Front panel', width: 200, height: 150, allowance: 12, material: 'canvas' }); d.addRectangle({ id: 'back', width: 200, height: 150, allowance: 12, material: 'canvas' });
  d.data.patterns[0].notches.push({ segment: 'front_right', at: 0.5, depth: 4 });
  d.addSeam({ id: 'side', a: { pattern: 'front', segment: 'front_right' }, b: { pattern: 'back', segment: 'back_left' } }); return d.toJSON();
}

test('softgoods DXF carries stitch, allowance, notch, grain and text layers', () => {
  const d = design(), x = patternDXF(d.patterns[0]);
  for (const layer of ['STITCH', 'CUT', 'ALLOWANCE', 'NOTCH', 'GRAIN', 'TEXT']) assert.match(x, new RegExp(`\\n8\\n${layer}\\n`));
  assert.match(x, /Front panel  CUT 1  canvas/);
});

test('tech pack schedules authoritative patterns and paired seam lengths', () => {
  const p = techPack(design(), 'pouch');
  assert.equal(p.patterns.length, 2); assert.equal(p.seams.length, 1);
  assert.equal(p.seams[0].lengthAmm, 150); assert.equal(p.seams[0].lengthBmm, 150);
  assert.equal(p.patterns[0].allowances.front_right, 12);
  assert.match(p.notes.join(' '), /closed seam-allowance cutting boundary/);
});

test('manufacturing export writes one DXF per pattern and JSON/HTML tech packs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadgang-soft-export-')), r = exportSoftgoods(design(), dir, 'pouch');
  assert.equal(r.files.length, 4); for (const f of r.files) assert.ok(fs.existsSync(f), f);
  assert.match(fs.readFileSync(path.join(dir, 'pouch_tech-pack.html'), 'utf8'), /SEAM SCHEDULE/);
  fs.rmSync(dir, { recursive: true });
});


test('closed CUT contour offsets a rectangular pattern by its allowance', () => {
  const p = design().patterns[0], cut = cutContours(p)[0];
  assert.equal(cut.length, 4);
  assert.deepEqual(cut.map((q) => q.map((x) => +x.toFixed(6))), [[-12, -12], [212, -12], [212, 162], [-12, 162]]);
  const dxf = patternDXF(p), cutLines = dxf.split('\n0\nLINE\n').slice(1).filter((e) => e.includes('8\nCUT\n'));
  assert.equal(cutLines.length, 4, 'four closed cutting edges');
});

test('variable allowances use bounded corners and holes offset into the opening', () => {
  const d = new SoftgoodsDocument(null); d.addRectangle({ id: 'panel', width: 100, height: 80, allowance: 10 });
  const p = d.toJSON().patterns[0]; p.allowances.panel_right = 20;
  const outer = cutContours(p)[0]; assert.ok(outer.some((q) => Math.abs(q[0] - 120) < 1e-6));
  const ids = ['h0','h1','h2','h3'], seg = ['hb','hr','ht','hl'];
  p.points.push({id:'h0',x:30,y:25},{id:'h1',x:70,y:25},{id:'h2',x:70,y:55},{id:'h3',x:30,y:55});
  p.segments.push(...seg.map((id,i)=>({id,type:'line',a:ids[i],b:ids[(i+1)%4]})));
  p.contours.push(seg); Object.assign(p.allowances,{hb:5,hr:5,ht:5,hl:5});
  const hole = cutContours(p)[1], xs=hole.map(q=>q[0]), ys=hole.map(q=>q[1]);
  assert.equal(Math.min(...xs),35); assert.equal(Math.max(...xs),65); assert.equal(Math.min(...ys),30); assert.equal(Math.max(...ys),50);
});

test('notches start at CUT and point inward toward the stitch line', () => {
  const p = design().patterns[0], dxf = patternDXF(p), notch = dxf.split('\n0\nLINE\n').slice(1).find((e) => e.includes('8\nNOTCH\n'));
  const number = (code) => Number(notch.match(new RegExp(`\\n${code}\\n([^\\n]+)`))[1]);
  assert.equal(number(10), 212); assert.equal(number(11), 208); assert.equal(number(20), 75); assert.equal(number(21), 75);
});
