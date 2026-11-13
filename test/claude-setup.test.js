/** The app's first launch installs the cadgang-notes mod into Claude Code once, and never again. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setupClaude } from '../src/server/claude-setup.js';

const fake = (list, installOk = true) => { const calls = []; return { calls, run: async (_bin, args) => { calls.push(args.slice(0, 2).join(' ')); return args[1] === 'list' ? { ok: true, stdout: list } : { ok: installOk, stdout: '' }; } }; };
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cadgang-setup-'));

test('installs once, then leaves Claude Code alone', async () => {
  const dataDir = dir(), f = fake('[]');
  assert.equal(await setupClaude({ dataDir, root: '/app', bin: 'claude', run: f.run, log() {} }), 'installed');
  assert.deepEqual(f.calls, ['plugin list', 'plugin install']);
  assert.equal(await setupClaude({ dataDir, root: '/app', bin: 'claude', run: f.run, log() {} }), 'done before');
  assert.equal(f.calls.length, 2);   // a mod the person removed is not put back
});

test('a mod already installed is left as it is', async () => {
  const f = fake('[{"id":"cadgang-notes@cadgang"}]');
  assert.equal(await setupClaude({ dataDir: dir(), root: '/app', bin: 'claude', run: f.run, log() {} }), 'already installed');
  assert.deepEqual(f.calls, ['plugin list']);
});

test('no Claude Code, or a failed install, leaves no marker: the next launch tries again', async () => {
  const a = dir(), b = dir();
  assert.equal(await setupClaude({ dataDir: a, root: '/app', bin: null, run: fake('[]').run }), 'no claude');
  assert.equal(await setupClaude({ dataDir: b, root: '/app', bin: 'claude', run: fake('[]', false).run, log() {} }), 'failed');
  assert.equal(fs.existsSync(path.join(a, 'claude-mod.json')) || fs.existsSync(path.join(b, 'claude-mod.json')), false);
});
