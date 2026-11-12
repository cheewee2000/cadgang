// The server stopped in the middle of an import takes the importer with it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('stopping the server stops an import under way', async () => {
  const port = 5900 + (process.pid % 90), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadgang-stop-')), pidFile = path.join(dir, 'pid'), fake = path.join(dir, 'occt');
  fs.writeFileSync(fake, `#!/bin/sh\necho $$ > '${pidFile}'\nexec sleep 60\n`, { mode: 0o755 });   // an importer that never finishes
  const server = spawn(process.execPath, ['src/server/index.js'], { env: { ...process.env, CADGANG_PORT: String(port), CADGANG_DATA: dir, CADGANG_DISK_CACHE: '0', CADGANG_OCCT: fake }, stdio: 'ignore' });
  try {
    const up = async () => { for (let i = 0; i < 80; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return; } catch {} await new Promise((r) => setTimeout(r, 100)); } throw new Error('server did not start'); };
    await up();
    fetch(`http://127.0.0.1:${port}/api/view/tessellate?name=cube.stp`, { method: 'POST', body: fs.readFileSync('test/fixtures/cube.stp') }).catch(() => {});
    for (let i = 0; i < 80 && !fs.existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 100));
    const pid = +fs.readFileSync(pidFile, 'utf8');
    assert.doesNotThrow(() => process.kill(pid, 0), 'the importer is running');
    server.kill('SIGTERM');
    await new Promise((r) => server.once('exit', r));
    await new Promise((r) => setTimeout(r, 200));
    assert.throws(() => process.kill(pid, 0), 'and gone once the server is');
  } finally { server.kill('SIGKILL'); fs.rmSync(dir, { recursive: true, force: true }); }
});
