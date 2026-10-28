import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SoftgoodsDocument } from '../src/core/softgoods-document.js';
import { patternDXF, techPack, exportSoftgoods } from '../src/core/softgoods-export.js';

function design() {
  const d = new SoftgoodsDocument(null); const a = d.addRectangle({ id: 'front', name: 'Front panel', width: 200, height: 150, allowance: 12, material: 'canvas' }); d.addRectangle({ id: 'back', width: 200, height: 150, allowance: 12, material: 'canvas' });
  d.data.patterns[0].notches.push({ segment: 'front_right', at: 0.5, depth: 4 });
  d.addSeam({ id: 'side', a: { pattern: 'front', segment: 'front_right' }, b: { pattern: 'back', segment: 'back_left' } }); return d.toJSON();
}

test('softgoods DXF carries stitch, allowance, notch, grain and text layers', () => {
  const d = design(), x = patternDXF(d.patterns[0]);
  for (const layer of ['STITCH', 'ALLOWANCE', 'NOTCH', 'GRAIN', 'TEXT']) assert.match(x, new RegExp(`\\n8\\n${layer}\\n`));
  assert.match(x, /Front panel  CUT 1  canvas/);
});

test('tech pack schedules authoritative patterns and paired seam lengths', () => {
  const p = techPack(design(), 'pouch');
  assert.equal(p.patterns.length, 2); assert.equal(p.seams.length, 1);
  assert.equal(p.seams[0].lengthAmm, 150); assert.equal(p.seams[0].lengthBmm, 150);
  assert.equal(p.patterns[0].allowances.front_right, 12);
  assert.match(p.notes.join(' '), /offset joins are not generated/);
});

test('manufacturing export writes one DXF per pattern and JSON/HTML tech packs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadgang-soft-export-')), r = exportSoftgoods(design(), dir, 'pouch');
  assert.equal(r.files.length, 4); for (const f of r.files) assert.ok(fs.existsSync(f), f);
  assert.match(fs.readFileSync(path.join(dir, 'pouch_tech-pack.html'), 'utf8'), /SEAM SCHEDULE/);
  fs.rmSync(dir, { recursive: true });
});
