/**
 * The MCP module must load. Its tool descriptions are template literals, and
 * an unescaped backtick inside one has silently taken the whole server down
 * twice; the ordinary suite never imported it, so nothing noticed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

test('the MCP cell tools module loads and describes the vocabulary', async () => {
  const mod = await import('../src/mcp/cells.js');
  assert.equal(typeof mod.registerCellTools, 'function');
  const src = await import('node:fs').then((fs) => fs.readFileSync(new URL('../src/mcp/cells.js', import.meta.url), 'utf8'));
  for (const name of ['thread', 'loft', 'sweep', 'hole', 'planeOf', 'console.log', 'sk.saved()']) {
    assert.ok(src.includes(name), `CELL_API mentions ${name}`);
  }
});
