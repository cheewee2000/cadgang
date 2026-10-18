import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { diffSnapshots, HistoryStore } from '../src/core/history.js';

const cell = (id, extra = {}) => ({ id, kind: 'model', prompt: `make ${id}`, code: 'export default () => 1', params: {}, ...extra });

test('diffSnapshots names adds, removes, param changes and measure deltas', () => {
  const prev = { cells: [cell('body', { params: { h: 10 } }), cell('old')], output: null };
  const next = { cells: [cell('body', { params: { h: 20 } }), cell('lid', { prompt: 'a lid for it' })], output: 'lid' };
  const d = diffSnapshots(prev, next, {
    prevMeasures: { volume: 100, bbox: { size: [10, 10, 1] }, bodies: 1 },
    measures: { volume: 150, bbox: { size: [10, 10, 1.5] }, bodies: 2 },
  });
  assert.deepEqual(d.added, ['lid']);
  assert.deepEqual(d.removed, ['old']);
  assert.deepEqual(d.changed[0].params, [{ name: 'h', from: 10, to: 20 }]);
  assert.equal(d.delta.volumePct, 50);
  assert.match(d.text, /added 'lid' \("a lid for it"\); removed 'old'; changed params \(h 10 → 20\) on 'body'; output → 'lid'; volume \+50%, size z \+0.5, 2 bodies \(was 1\)/);
  assert.equal(diffSnapshots(next, structuredClone(next)).text, 'no change in the stack');
});

test('HistoryStore numbers versions monotonically and keeps notes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadgang-hist-'));
  const store = new HistoryStore(dir);
  assert.equal(store.last(), null);
  const a = store.add({ snapshot: { cells: [cell('a')], output: null }, auto: { text: 'added a' }, png: Buffer.from('png') });
  const b = store.add({ snapshot: { cells: [], output: null }, auto: { text: 'removed a' }, note: 'oops' });
  assert.deepEqual([a.n, b.n], [1, 2]);
  assert.equal(store.list().length, 2);
  assert.equal(store.list()[0].cells, 1);
  assert.equal(store.setNote(1, 'keep').note, 'keep');
  assert.equal(store.last().n, 2);
  assert.ok(fs.existsSync(store.pngPath(1)));
  fs.rmSync(dir, { recursive: true });
});
