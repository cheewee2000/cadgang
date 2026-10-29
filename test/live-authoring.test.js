import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

const port = 5000 + (process.pid % 500), data = fs.mkdtempSync(path.join(os.tmpdir(), 'cadgang-live-')), project = fs.mkdtempSync(path.join(os.tmpdir(), 'cadgang-project-'));
const root = `http://127.0.0.1:${port}`; let server;

test.before(async () => {
  server = spawn(process.execPath, ['src/server/index.js'], { env: { ...process.env, CADGANG_PORT: String(port), CADGANG_DATA: data }, stdio: 'ignore' });
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`${root}/api/health`)).ok) return; } catch {} await new Promise((r) => setTimeout(r, 100)); }
  throw new Error('server did not start');
});
test.after(() => { server?.kill(); fs.rmSync(data, { recursive: true, force: true }); fs.rmSync(project, { recursive: true, force: true }); });

const next = (ws, type) => new Promise((resolve, reject) => { const t = setTimeout(() => reject(new Error(`no ${type} event`)), 5000); const on = (raw) => { const m = JSON.parse(raw); if (m.type !== type) return; clearTimeout(t); ws.off('message', on); resolve(m); }; ws.on('message', on); });

test('a Cells page can follow the session project and receives every document change', async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`); await new Promise((ok, bad) => { ws.once('open', ok); ws.once('error', bad); });
  const active = next(ws, 'cells_project_active'), changed = next(ws, 'cells_changed');
  const res = await fetch(`${root}/api/cells`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Cadgang-Project': project }, body: JSON.stringify({ id: 'base', prompt: 'the visible first step' }) });
  assert.equal(res.status, 200);
  const live = await active; assert.match(live.session, /^[A-Za-z0-9_-]+$/); assert.equal(live.name, path.basename(project));
  const event = await changed; assert.equal(event.session, live.session); assert.equal(event.revision, 1);
  const followed = await fetch(`${root}/api/cells/document?session=${encodeURIComponent(live.session)}`).then((r) => r.json());
  assert.equal(followed.cells[0].id, 'base');
  const refused = await fetch(`${root}/api/cells/document?session=not-a-session`); assert.equal(refused.status, 404);
  const appDefault = await fetch(`${root}/api/cells/document`).then((r) => r.json());
  assert.equal(appDefault.cells.length, 0, 'the session document remains isolated from the app default');
  ws.close();
});
