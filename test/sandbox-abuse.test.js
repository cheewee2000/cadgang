/**
 * What a cell program may not do to the process: a one-line module must
 * compile, import() must fail inside the cell rather than reject later as an
 * unhandled rejection (a process crash), and exports are found at any
 * statement boundary.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { compileCell, transformCellSource } from '../src/core/sandbox.js';
import { cellApi } from '../src/core/cellapi.js';

test('a one-line module compiles', () => {
  const c = compileCell('export const params = { w: 2 }; export default ({ p }) => p.w * 2;');
  assert.equal(c.run(cellApi({ params: { w: 2 } })), 4);
  assert.throws(() => transformCellSource('export const params = {}; export function nope() {}'), /may only 'export const params' and 'export default'/);
});

test('import() is refused at compile time, so nothing can escape the sandbox later', async () => {
  // Node invokes a dynamic-import callback in a microtask, after the cell has
  // returned — as an unhandled rejection or an uncaught exception, never as the
  // cell's own error. The only safe refusal is before the program runs.
  assert.throws(() => compileCell('export default () => { import("fs"); return 1; }'), /import\(\) is not available/);
  assert.throws(() => compileCell('export default () => { try { import ("node:fs"); } catch {} return 1; }'), /import\(\) is not available/);
  assert.equal(compileCell('export default () => "important()"').run(cellApi({})), 'important()');
});
