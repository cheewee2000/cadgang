/**
 * A STEP with several solids comes back as several BODIES: triangle ranges the
 * viewer turns into one mesh each (show/hide, explode, caps, colour). The binary
 * pack carries the ranges and names after the faces.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importCadFile } from '../src/core/step.js';
import { pack } from '../src/server/view.js';

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'asm.step');

test('a three-solid STEP imports as three bodies whose ranges tile the triangles', async () => {
  const m = await importCadFile(fs.readFileSync(fixture), { name: 'asm.step' });
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
