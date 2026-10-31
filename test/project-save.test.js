/**
 * Saving a .cadgang project: PUT /api/view/project writes the page's bundle to an absolute local path,
 * refuses anything else, and the bytes read back through /api/view/file unchanged.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const port = 4600 + (process.pid % 300);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadgang-proj-'));
let server;
const base = `http://127.0.0.1:${port}/api/view`;

test.before(async () => {
  server = spawn(process.execPath, ['src/server/index.js'], { env: { ...process.env, CADGANG_PORT: String(port), CADGANG_DATA: dir }, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) { try { await fetch(`${base}/screen`); return; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  throw new Error('server did not start');
});
test.after(() => { server.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

const put = (p, body) => fetch(`${base}/project?path=${encodeURIComponent(p)}`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body });

test('a project is written to the chosen path and reads back byte for byte', async () => {
  const head = Buffer.from(JSON.stringify({ name: 'x', files: [], state: '{}' }));
  const bytes = Buffer.concat([Buffer.from(new Uint32Array([head.length]).buffer), head]);
  const p = path.join(dir, 'part.cadgang');
  const res = await put(p, bytes);
  assert.equal(res.status, 200);
  assert.deepEqual(fs.readFileSync(p), bytes);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.part')), []);
  const back = Buffer.from(await (await fetch(`${base}/file?path=${encodeURIComponent(p)}`)).arrayBuffer());
  assert.deepEqual(back, bytes);
});

test('only absolute .cadgang paths with a body are accepted', async () => {
  assert.equal((await put('relative.cadgang', Buffer.alloc(8))).status, 400);
  assert.equal((await put(path.join(dir, 'x.txt'), Buffer.alloc(8))).status, 400);
  assert.equal((await put(path.join(dir, 'empty.cadgang'), Buffer.alloc(0))).status, 400);
  assert.equal(fs.existsSync(path.join(dir, 'x.txt')), false);
});

test('a proxied request may not write', async () => {
  const res = await fetch(`${base}/project?path=${encodeURIComponent(path.join(dir, 'p.cadgang'))}`, { method: 'PUT', headers: { 'X-Forwarded-For': '203.0.113.9' }, body: Buffer.alloc(8) });
  assert.equal(res.status, 403);
});

test('joints are stored per file; the page posting bodies does not clear them, and only joint writes broadcast', async () => {
  const subject = '/tmp/asm.step', q = `subject=${encodeURIComponent(subject)}`;
  const put = (body) => fetch(`${base}/joints?${q}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  const joint = { id: 'j1', type: 'screw', body: 'screw#0', parent: null, origin: [0, 0, 0], axis: [0, 0, 1], value: 720, pitch: 1.5 };
  await put({ joints: [joint], from: 'mcp' });
  const afterBodies = await put({ bodies: [{ key: 'screw#0', name: 'screw', box: [0, 0, 0, 1, 1, 1], cylinders: [] }] });   // the page reports its bodies
  assert.equal(afterBodies.joints.length, 1);
  assert.equal(afterBodies.bodies[0].key, 'screw#0');
  const got = await fetch(`${base}/joints?${q}`).then((r) => r.json());
  assert.deepEqual(got.joints, [joint]);
  assert.deepEqual((await put({ joints: [] })).joints, []);   // clearing is a joint write
  // saved states live beside the joints: a states write keeps the joints, a joints write keeps the states
  const state = { id: 's1', name: 'open', mode: 'joint', explode: 0, joints: { j1: [90, null, null] }, parts: {} };
  await put({ joints: [joint] });
  assert.deepEqual((await put({ states: [state] })).joints, [joint]);
  const both = await put({ joints: [] });
  assert.deepEqual(both.states, [state]);
  assert.deepEqual((await fetch(`${base}/joints?${q}`).then((r) => r.json())).states, [state]);
});
