// The astm-style DXF: a block per piece, information on the numbered ASTM D6673 layers.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateSoftgoodsDocument } from '../src/core/softgoods-document.js';
import { cutContours } from '../src/core/softgoods-export.js';
import { astmStyleDXF, ASTM_STYLE } from '../src/core/softgoods-astm.js';
import { exportProduction } from '../src/core/softgoods-production.js';
import { tee } from './fixtures/softgoods-tee.js';

test('every piece is one block, inserted once, with its boundary, sew line, grain and notch on their numbered layers', () => {
  const d = validateSoftgoodsDocument(tee()), dxf = astmStyleDXF(d, { name: 'tee' }), blocks = dxf.split('\n0\nBLOCK\n').slice(1).map((b) => b.split('\n0\nENDBLK\n')[0]);
  assert.ok(dxf.indexOf('\n2\nTABLES\n') < dxf.indexOf('\n2\nBLOCKS\n') && dxf.indexOf('\n2\nBLOCKS\n') < dxf.indexOf('\n2\nENTITIES\n'));
  assert.equal(blocks.length, 5); assert.equal(dxf.match(/\n0\nINSERT\n/g).length, 5);
  for (const n of Object.keys(ASTM_STYLE.layers)) assert.match(dxf, new RegExp(`\\n0\\nLAYER\\n2\\n${n}\\n`), `layer ${n} is in the table`);
  const front = blocks.find((b) => b.startsWith('8\n1\n2\nfront\n')), on = (layer, type) => front.split(`\n0\n${type}\n8\n${layer}\n`).length - 1;
  assert.equal(on(1, 'POLYLINE'), 1); assert.match(front, /\n0\nPOLYLINE\n8\n1\n66\n1\n70\n1\n/, 'the boundary is closed');
  assert.equal(on(1, 'VERTEX'), cutContours(d.patterns[0])[0].length, 'the boundary is the cut contour');
  assert.equal(on(14, 'POLYLINE'), 1, 'the stitch contour is one closed sew line'); assert.equal(on(7, 'LINE'), 1); assert.equal(on(4, 'LINE'), 1); assert.equal(on(11, 'POLYLINE'), 0);
  for (const t of ['Piece Name: Front', 'Size: base', 'Quantity: 1', 'Material: jersey']) assert.ok(front.includes(`\n1\n${t}`), t);
  assert.ok(blocks.find((b) => b.startsWith('8\n1\n2\nsleeve\n')).includes('\n1\nQuantity: 2')); assert.match(dxf, /\n1\nUnits: METRIC\n/);
  assert.ok(!/\n8\n(STITCH|CUT|NOTCH|GRAIN|TEXT)\n/.test(dxf), 'layers are numbered, not named');
});

test('the export writes one astm-style file per size and says what is on which layer', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadgang-soft-astm-')), d = validateSoftgoodsDocument(tee()), r = exportProduction(d, dir, 'tee', { dxf: 'astm-style' });
  assert.deepEqual(exportProduction(d, dir, 'tee', { dxf: 'aama-style' }).files, r.files, 'the name the brief used is taken as the same flavour');
  for (const f of ['tee_astm-style.dxf', 'tee_astm-style_L.dxf', 'tee_astm-style_XL.dxf']) assert.ok(fs.existsSync(path.join(dir, f)), f);
  assert.equal(r.files.length, 17 + 3); assert.equal(r.astmStyle.layers[14], 'sew lines (STITCH)'); assert.match(r.astmStyle.verified, /not verified/);
  assert.match(fs.readFileSync(path.join(dir, 'tee_astm-style_L.dxf'), 'utf8'), /\n1\nSize: L\n/);
  assert.throws(() => exportProduction(d, dir, 'tee', { dxf: 'gerber' }), /Unknown DXF flavour/); fs.rmSync(dir, { recursive: true });
});
