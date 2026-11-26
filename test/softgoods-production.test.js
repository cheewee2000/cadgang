// The production outputs through the export path: the core call, the REST route and the MCP tool.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { z } from 'zod';
import { SoftgoodsDocument, validateSoftgoodsDocument } from '../src/core/softgoods-document.js';
import { exportProduction } from '../src/core/softgoods-production.js';
import { FABRICS } from '../src/core/softgoods-fabrics.js';
import { softgoodsRouter } from '../src/server/softgoods.js';
import { registerSoftgoodsTools } from '../src/mcp/softgoods.js';
import { tee } from './fixtures/softgoods-tee.js';

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cadgang-soft-production-'));
const names = (r) => r.files.map((f) => path.basename(f));

test('without formats the export is what it always was', () => {
  const dir = temp(), r = exportProduction(validateSoftgoodsDocument(tee()), dir, 'tee');
  assert.equal(r.files.length, 5 * 3 + 2, 'a DXF per pattern and size, and the two tech packs'); assert.ok(!('markers' in r) && !('bom' in r));
  assert.deepEqual(fs.readdirSync(dir).sort(), names(r).sort()); fs.rmSync(dir, { recursive: true });
});

test('formats add the marker, the bill, the tiled print and the SVGs beside the standard export', () => {
  const dir = temp(), r = exportProduction(validateSoftgoodsDocument(tee()), dir, 'tee', { formats: ['marker', 'bom', 'print', 'svg'], sizes: { base: 1, L: 1 }, paper: 'letter', gap: 5 });
  for (const f of r.files) assert.ok(fs.statSync(f).size > 0, f);
  for (const f of ['tee_marker_jersey.dxf', 'tee_marker_jersey.svg', 'tee_bom.json', 'tee_bom.html', 'tee_print_letter.html', 'tee_front.svg', 'tee_sleeve_xl.svg', 'tee_front.dxf', 'tee_tech-pack.html']) assert.ok(names(r).includes(f), f);
  assert.equal(r.files.length, 17 + 2 + 2 + 1 + 15);
  assert.equal(r.markers.length, 1); assert.equal(r.markers[0].gapMm, 5); assert.equal(r.markers[0].units, 2); assert.ok(r.markers[0].efficiency > 0.6 && r.markers[0].lengthMm > 700); assert.ok(!('placements' in r.markers[0]));
  assert.equal(r.bom.materials[0].markerLengthMm, r.markers[0].lengthMm, 'the bill buys the marker that was laid');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'tee_bom.json'), 'utf8')), r.bom);
  assert.match(fs.readFileSync(path.join(dir, 'tee_print_letter.html'), 'utf8'), /@page\{size:215\.9mm 279\.4mm/); assert.match(fs.readFileSync(path.join(dir, 'tee_front_l.svg'), 'utf8'), /Front L {2}CUT 1/);
  fs.rmSync(dir, { recursive: true });
});

test('a marker that cannot be laid stops the export before anything is written', () => {
  const dir = temp(), d = validateSoftgoodsDocument(tee());
  assert.throws(() => exportProduction(d, dir, 'tee', { formats: ['marker'], width: 300 }), /across the roll/); assert.deepEqual(fs.readdirSync(dir), []);
  assert.throws(() => exportProduction(d, dir, 'tee', { formats: ['pdf'] }), /Unknown export format 'pdf'. Known: marker, bom, print, svg/); assert.deepEqual(fs.readdirSync(dir), []);
  fs.rmSync(dir, { recursive: true });
});

test('the REST route takes the options, and the simulation input gets a preset resolved', async () => {
  const dir = temp(), doc = new SoftgoodsDocument(null), app = express(); app.use(express.json()); app.use('/s', softgoodsRouter(doc, { exportDir: () => dir }));
  const server = app.listen(0), call = async (p, method = 'GET', body) => { const r = await fetch(`http://127.0.0.1:${server.address().port}/s${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) }); return { status: r.status, ...(await r.json()) }; };
  try {
    doc.addRectangle({ id: 'panel', width: 300, height: 200, material: 'shell' }); doc.replace({ ...doc.toJSON(), materials: { shell: { preset: 'waxed-canvas', friction: 0.4 } } });
    const input = await call('/simulation-input');
    assert.equal(input.materials.shell.arealDensity, FABRICS['waxed-canvas'].arealDensity); assert.equal(input.materials.shell.friction, 0.4); assert.equal(input.materials.shell.source, 'typical, not measured');
    const plain = await call('/export', 'POST', { name: 'bag' }); assert.equal(plain.status, 200); assert.equal(plain.files.length, 3);
    const made = await call('/export', 'POST', { name: 'bag', formats: ['marker', 'bom'], width: 600, gap: 0 });
    assert.equal(made.status, 200); assert.equal(made.markers[0].widthMm, 600); assert.equal(made.markers[0].lengthMm, 220); assert.equal(made.bom.materials[0].netWeightG, +(0.32 * 0.22 * 400).toFixed(1));
    assert.ok(fs.existsSync(path.join(dir, 'bag_marker_shell.dxf')) && fs.existsSync(path.join(dir, 'bag_bom.html')));
    const narrow = await call('/export', 'POST', { name: 'bag', formats: ['marker'], width: 200 }); assert.equal(narrow.status, 400); assert.match(narrow.error, /200 mm wide/);
  } finally { server.close(); fs.rmSync(dir, { recursive: true }); }
});

test('the MCP tools carry presets, mirrored pairs and the production options', async () => {
  const tools = {}, sent = [];
  registerSoftgoodsTools({ registerTool: (name, spec, handler) => { tools[name] = { spec, handler }; } }, { call: async (p, opts) => { sent.push([p, opts]); return {}; }, ok: (v) => v, fail: (e) => { throw e; } });
  const set = tools.cadgang_softgoods_set.spec, out = tools.cadgang_softgoods_export, schema = z.object(out.spec.inputSchema);
  assert.deepEqual(set.inputSchema.materials.parse({ shell: { preset: 'nylon-1000d', rollWidth: 1500, pricePerMeter: 14, pricePerSqm: 9 } }).shell, { preset: 'nylon-1000d', rollWidth: 1500, pricePerMeter: 14, pricePerSqm: 9 });
  assert.equal(set.inputSchema.patterns.parse([{ id: 'sleeve', points: [], segments: [], contours: [['a', 'b', 'c']], cut: 2, mirror: true }])[0].mirror, true);
  assert.match(set.description, /typical, NOT measured/); for (const id of Object.keys(FABRICS)) assert.ok(set.description.includes(id), id);
  const options = { name: 'tee', formats: ['marker', 'bom', 'print', 'svg'], width: { jersey: 1600 }, gap: 3, turns: 'free', sizes: { base: 1, L: 2 }, threadMultiplier: { overlock: 14 }, paper: 'letter', orientation: 'landscape', margin: 8, overlap: 12 };
  assert.deepEqual(schema.parse(options), options); assert.deepEqual(schema.parse({ name: 'tee' }), { name: 'tee' }, 'the old call still stands');
  assert.throws(() => schema.parse({ name: 'tee', formats: ['pdf'] })); assert.throws(() => schema.parse({ name: 'tee', turns: 45 }));
  await out.handler(options); assert.deepEqual(sent.at(-1), ['/softgoods/export', { method: 'POST', body: options }]);
  assert.match(out.spec.description, /"marker".*"bom".*"print".*"svg"/s);
});
