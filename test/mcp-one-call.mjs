// Drives the real MCP server over stdio against a running cadgang: node test/mcp-one-call.mjs <url> <project dir>
// One call per step: an edit answers with its evaluation (and a picture with look), and 'edits' patches code in place.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const [url = 'http://localhost:4499', cwd = process.cwd()] = process.argv.slice(2);
const client = new Client({ name: 'one-call', version: '0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../src/mcp/index.js', import.meta.url))], cwd, env: { ...process.env, CADGANG_URL: url } }));
const tool = async (name, args) => { const t = performance.now(); const r = await client.callTool({ name, arguments: args }); console.log(`${name} ${Math.round(performance.now() - t)} ms`); assert.ok(!r.isError, r.content[0].text); return r; };
for (const c of JSON.parse((await tool('cadgang_cells_get', {})).content[0].text).cells.reverse()) await tool('cadgang_cells_delete', { id: c.id });
let r = await tool('cadgang_cells_add', { id: 'block', prompt: 'a block', code: 'export const params = { w: 60 }; export default ({ p, brep }) => brep.box(p.w, 40, 24);', look: true });
assert.equal(r.structuredContent.evaluation.cells[0].status, 'ok');
assert.equal(r.structuredContent.evaluation.measures.volume, 57600);
assert.equal(Buffer.from(r.content[1].data, 'base64').subarray(1, 4).toString(), 'PNG');
r = await tool('cadgang_cells_compile', { id: 'block', edits: [{ old: '40, 24', new: '40, 10' }] });
assert.equal(r.structuredContent.evaluation.measures.volume, 24000);
r = await client.callTool({ name: 'cadgang_cells_compile', arguments: { id: 'block', edits: [{ old: 'nowhere', new: 'x' }] } });
assert.ok(r.isError && /exactly once/.test(r.content[0].text));
r = await tool('cadgang_cells_add', { id: 'broken', code: 'export default ({ brep, input }) => brep.fillet(input, [], 99);' });
assert.equal(r.structuredContent.evaluation.cells.find((c) => c.id === 'broken').status, 'error');
assert.deepEqual(r.structuredContent.evaluation.ok, ['block']);
await tool('cadgang_cells_delete', { id: 'broken' });
r = await tool('cadgang_cells_render', {});
assert.equal(Buffer.from(r.content[0].data, 'base64').subarray(1, 4).toString(), 'PNG');
console.log('ok'); await client.close();
