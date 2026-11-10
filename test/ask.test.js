import test from 'node:test';
import assert from 'node:assert/strict';
import { partialString } from '../src/ask.js';

test('code is read off a tool call that is still being written', () => {
  const whole = JSON.stringify({ id: 'battery_lid', prompt: 'a "lid"', code: 'export default ({ brep }) =>\n  brep.box(60, 40, 2); // 60 × 40 "lid"' });
  let last = '';
  for (let n = 1; n <= whole.length; n++) {   // every prefix, as the stream delivers it
    const code = partialString(whole.slice(0, n), 'code');
    if (code == null) continue;
    assert.ok(code.startsWith(last.slice(0, -1)), 'only ever grows');
    last = code;
  }
  assert.equal(last, JSON.parse(whole).code);
  assert.equal(partialString(whole, 'id'), 'battery_lid');
  assert.equal(partialString('{"id":"x","edits":[{"old":"a","new":"b1"},{"old":"c","new":"d2', 'new'), 'd2');   // the edit being typed
  assert.equal(partialString('{"id":"x"', 'code'), null);
});
