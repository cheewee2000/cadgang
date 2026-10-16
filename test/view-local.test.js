/**
 * Local-path reads: open to the desktop shell and to loopback requests, closed
 * to anything proxied (the VPS) or remote — the app adopts a dev server that
 * was started without CADGANG_DESKTOP, and must still open Finder's files.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mayReadLocal } from '../src/server/view.js';

const req = (ip, headers = {}) => ({ socket: { remoteAddress: ip }, headers });

test('loopback without a proxy header may read local paths', () => {
  assert.equal(mayReadLocal(req('127.0.0.1')), true);
  assert.equal(mayReadLocal(req('::1')), true);
  assert.equal(mayReadLocal(req('::ffff:127.0.0.1')), true);
});

test('proxied or remote requests may not', () => {
  assert.equal(mayReadLocal(req('127.0.0.1', { 'x-forwarded-for': '203.0.113.9' })), false);
  assert.equal(mayReadLocal(req('127.0.0.1', { 'x-real-ip': '203.0.113.9' })), false);
  assert.equal(mayReadLocal(req('192.168.1.20')), false);
});

test('a watched local file broadcasts file_changed when rewritten', async () => {
  const { fileWatcher } = await import('../src/server/view.js');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const p = `${os.tmpdir()}/cadgang-watch-${process.pid}.stl`;
  fs.writeFileSync(p, 'a');
  const got = new Promise((ok) => fileWatcher((m) => ok(m))(p));
  await new Promise((r) => setTimeout(r, 1100));   // let the poller take its first stat
  fs.writeFileSync(p, 'bb');
  const msg = await Promise.race([got, new Promise((_, no) => setTimeout(() => no(new Error('no broadcast in 4s')), 4000))]);
  fs.unwatchFile(p); fs.unlinkSync(p);
  assert.deepEqual(msg, { type: 'file_changed', path: p });
});
