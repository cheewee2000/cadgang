/**
 * A STEP with several solids comes back as several BODIES: triangle ranges the
 * viewer turns into one mesh each (show/hide, explode, caps, colour). The binary
 * pack carries the ranges and names after the faces.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { importCadFile, importCadFileInWorker, parseNative } from '../src/core/step.js';
import { pack } from '../src/server/view.js';

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'asm.step');

test('a three-solid STEP imports as three bodies whose ranges tile the triangles', async () => {
  const m = await importCadFile(fs.readFileSync(fixture), { name: 'asm.step' });
  assert.ok(m.positions instanceof Float32Array);
  assert.ok(m.indices instanceof Uint32Array);
  assert.ok(m.normals == null || m.normals instanceof Float32Array);
  assert.ok(['wasm', 'native'].includes(m.timings.importer));
  assert.ok(m.timings.totalMs >= 0);
  assert.equal(m.bodies.length, 3);
  assert.equal(m.bodies[0].first, 0);
  for (let i = 1; i < m.bodies.length; i++) assert.equal(m.bodies[i - 1].first + m.bodies[i - 1].count, m.bodies[i].first);
  const last = m.bodies[m.bodies.length - 1];
  assert.equal(last.first + last.count, m.triangleCount);
  assert.ok(m.faces.length >= 3 + 6 + 6, `faces carry B-rep ranges (${m.faces.length})`);
  const buf = pack(m);
  const head = new Uint32Array(buf.buffer, buf.byteOffset, 5);
  assert.equal(head[3], 3, 'three bodies in the header');
  const names = JSON.parse(buf.subarray(buf.length - head[4]).toString('utf8'));
  assert.equal(names.length, 3);
});

test('a nested STEP assembly gives each body its group path and colour (the importer alone flattens it)', async () => {
  // fixtures/nested.step (cadquery): root > G > H > {leaf1 red, leaf2}, root > G > leaf3, root > loose
  const m = await importCadFile(fs.readFileSync(path.join(path.dirname(fixture), 'nested.step')), { name: 'nested.step' });
  const by = Object.fromEntries(m.bodies.map((b) => [b.name.replace(/_part$/, ''), b]));
  assert.deepEqual(by.leaf1.path, ['G', 'H']);
  assert.deepEqual(by.leaf2.path, ['G', 'H']);
  assert.deepEqual(by.leaf3.path, ['G']);
  assert.deepEqual(by.loose.path ?? [], []);
  assert.deepEqual(by.leaf1.color, [1, 0, 0]);
  const buf = pack(m);
  const head = new Uint32Array(buf.buffer, buf.byteOffset, 5);
  const names = JSON.parse(buf.subarray(buf.length - head[4]).toString('utf8'));
  assert.deepEqual(names.find((n) => n.name === by.leaf1.name).path, ['G', 'H']);
});

test('a solid styled in the file keeps its name, colour and material', async () => {
  const { stepSolidStyles } = await import('../src/core/stepstyle.js');
  const step = `ISO-10303-21;
DATA;
#1=ADVANCED_BREP_SHAPE_REPRESENTATION('',(#2,#3),#9);
#2=MANIFOLD_SOLID_BREP('Case front',#8);
#3=MANIFOLD_SOLID_BREP('Lens',#8);
#4=STYLED_ITEM('',(#5),#2);
#5=PRESENTATION_STYLE_ASSIGNMENT((#6));
#6=SURFACE_STYLE_USAGE(.BOTH.,#7);
#7=SURFACE_SIDE_STYLE('',(#10,#13));
#10=SURFACE_STYLE_FILL_AREA(#11);
#11=FILL_AREA_STYLE('Steel - Satin',(#12));
#12=FILL_AREA_STYLE_COLOUR('Steel - Satin',#14);
#13=SURFACE_STYLE_TRANSPARENT(0.25);
#14=COLOUR_RGB('Steel - Satin',0.6,0.5,0.4);
ENDSEC;
END-ISO-10303-21;
`;
  assert.deepEqual(stepSolidStyles(step).solids, [
    { name: 'Case front', color: [0.6, 0.5, 0.4], opacity: 0.75, material: 'Steel - Satin' },
    { name: 'Lens', color: null, opacity: 1, material: '' },
  ]);
});

test("a product OpenCascade named after itself is no folder", async () => {
  // the fixture's three solids sit in products OCCT's writer called "Open CASCADE STEP translator 7.6 1.n"
  const m = await importCadFile(fs.readFileSync(fixture), { name: 'asm.step' });
  for (const b of m.bodies) assert.ok(!(b.path ?? []).some((g) => /^Open CASCADE/i.test(g)), JSON.stringify(b.path));
});

test('the import worker transfers typed geometry and reports round-trip timing', async () => {
  const m = await importCadFileInWorker(fs.readFileSync(fixture), { name: 'asm.step' });
  assert.ok(m.positions instanceof Float32Array);
  assert.ok(m.indices instanceof Uint32Array);
  assert.ok(m.normals == null || m.normals instanceof Float32Array);
  assert.ok(m.timings.workerRoundTripMs >= m.timings.totalMs);
  assert.doesNotThrow(() => pack(m));
});

test('an empty STEP export (header and product, no faces) says so instead of blaming the format', async () => {
  const txt = "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nENDSEC;\nDATA;\n#1=PRODUCT('x','x','',(#2));\nENDSEC;\nEND-ISO-10303-21;\n";
  await assert.rejects(importCadFile(Buffer.from(txt), { name: 'empty.step' }), /no geometry/);
  // a colour with nothing to colour: FACE is in SURFACE_STYLE_USAGE, and there is still no face
  await assert.rejects(importCadFile(Buffer.from(txt.replace('ENDSEC;\nEND', '#3=SURFACE_STYLE_USAGE(.BOTH.,#4);\nENDSEC;\nEND')), { name: 'empty.step' }), /no geometry/);
});

test('a file the native importer dies on is read by the WASM one; a file it refuses is not tried twice', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadgang-occt-')), fake = path.join(dir, 'occt');
  try {
    fs.writeFileSync(fake, '#!/bin/sh\nkill -ABRT $$\n', { mode: 0o755 });
    process.env.CADGANG_OCCT = fake;
    const m = await importCadFile(fs.readFileSync(fixture), { name: 'asm.step' });
    assert.equal(m.timings.importer, 'wasm');
    assert.ok(m.triangleCount > 0);
    fs.writeFileSync(fake, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    await assert.rejects(importCadFile(fs.readFileSync(fixture), { name: 'asm.step' }), /Could not read/);
  } finally { delete process.env.CADGANG_OCCT; fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the native importer gives every body the same name, path and colour as the WASM one', { skip: !fs.existsSync(new URL('../bin/cadgang-occt', import.meta.url)) && 'no bin/cadgang-occt (bash mac/occt/build.sh)' }, async () => {
  const dir = path.dirname(fixture);
  for (const name of ['nested.step', 'asm.step']) {
    const buf = fs.readFileSync(path.join(dir, name)), seen = {};
    try {
      for (const wasm of ['0', '1']) {
        process.env.CADGANG_WASM = wasm;
        const m = await importCadFile(buf, { name });
        assert.equal(m.timings.importer, wasm === '1' ? 'wasm' : 'native');
        seen[wasm] = m.bodies.map((b) => ({ name: b.name, path: b.path ?? [], color: b.color ?? null }));
      }
    } finally { delete process.env.CADGANG_WASM; }
    assert.deepEqual(seen['0'], seen['1'], name);
    // the fixtures are simple enough for the text fallbacks, so check the part tree the bodies hang from too
    const native = parseNative(execFileSync(fileURLToPath(new URL('../bin/cadgang-occt', import.meta.url)), ['step', path.join(dir, name), '0.001', '0.5'], { maxBuffer: 2 ** 30 }));
    const occt = await (await import('occt-import-js')).default();
    const tree = (t) => ({ name: t.name, meshes: [...t.meshes], children: t.children.map(tree) });
    assert.deepEqual(tree(native.root), tree(occt.ReadStepFile(new Uint8Array(buf), {}).root), name);
  }
});
