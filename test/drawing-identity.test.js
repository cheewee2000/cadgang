/** A title block carries the user's own company and name, from their identity file: never a built-in one. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { identity } from '../src/mcp/identity.js';

test('identity: the file wins; without one the author is git\'s and the company is empty', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cadgang-id-')), 'identity.json');
  assert.deepEqual(identity(f, () => 'Git Name'), { company: '', author: 'Git Name', set: false });
  assert.deepEqual(identity(f, () => { throw new Error('no git'); }), { company: '', author: '', set: false });
  fs.writeFileSync(f, JSON.stringify({ company: 'Acme Works', author: 'Sam Doe' }));
  assert.deepEqual(identity(f, () => 'Git Name'), { company: 'Acme Works', author: 'Sam Doe', set: true });
  fs.writeFileSync(f, JSON.stringify({ company: 'Acme Works' }));
  assert.deepEqual(identity(f, () => 'Git Name'), { company: 'Acme Works', author: 'Git Name', set: true });
});
