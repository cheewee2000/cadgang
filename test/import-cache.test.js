// An import is kept on disk: the second open of the same bytes is read back, not imported again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const port = 5600 + (process.pid % 300), data = fs.mkdtempSync(path.join(os.tmpdir(), 'cadgang-import-')), root = `http://127.0.0.1:${port}`;
let server;
test.before(async () => {
  server = spawn(process.execPath, ['src/server/index.js'], { env: { ...process.env, CADGANG_PORT: String(port), CADGANG_DATA: data, CADGANG_DISK_CACHE: '' }, stdio: 'ignore' });
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`${root}/api/health`)).ok) return; } catch {} await new Promise((r) => setTimeout(r, 100)); }
  throw new Error('server did not start');
});
test.after(() => { server?.kill(); fs.rmSync(data, { recursive: true, force: true }); });

test('the same file opened twice is imported once', async () => {
  const step = fs.readFileSync('test/fixtures/cube.stp'), name = `cube-${process.pid}-${Date.now()}.stp`;   // the name is part of what is kept, so this run's import is its own
  const open = async () => { const r = await fetch(`${root}/api/view/tessellate?name=${name}`, { method: 'POST', body: step }); assert.equal(r.status, 200); return { timings: JSON.parse(r.headers.get('x-cadgang-timings')), bytes: Buffer.from(await r.arrayBuffer()) }; };
  const first = await open();
  assert.ok(!first.timings.cached, 'the first open imports');
  await new Promise((r) => setTimeout(r, 200));   // the write is not waited for
  const second = await open();
  assert.equal(second.timings.cached, true);
  assert.ok(second.bytes.equals(first.bytes), 'and the page gets the same model');
});
