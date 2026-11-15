// A note on a live cell document reaches Claude as a brief it can act on in one call, and that call marks the
// note done: node test/note-brief.mjs <url> <project dir>   (a running cadgang; the project's cells are replaced)
// `setup` as a third argument stops after leaving the plate and its open note in place.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const [url = 'http://localhost:4499', dir = process.cwd(), only] = process.argv.slice(2);
const cwd = fs.realpathSync(dir), subject = `${cwd}/cadgang/cells.json`;
const client = new Client({ name: 'note-brief', version: '0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../src/mcp/index.js', import.meta.url))], cwd, env: { ...process.env, CADGANG_URL: url } }));
const tool = async (name, args) => { const r = await client.callTool({ name, arguments: args }); assert.ok(!r.isError, r.content?.[0]?.text); return r; };
const api = async (p, init) => (await fetch(`${url}/api/view${p}`, init)).json();
const open = (more = '') => api(`/markup/open?dir=${encodeURIComponent(cwd)}${more}`);

for (const c of JSON.parse((await tool('cadgang_cells_get', {})).content[0].text).cells.reverse()) await tool('cadgang_cells_delete', { id: c.id });
await tool('cadgang_cells_add', { id: 'plate', prompt: 'a plate with a hole', code: "export const params = { w: 60, d: 40, t: 8 };\nexport default ({ p, brep }) => brep.name(brep.subtract(brep.box(p.w, p.d, p.t), brep.cylinder(5, p.t)), 'mounting plate, aluminum');" });
const edge = JSON.parse((await tool('cadgang_cells_topology', {})).content[0].text).edges.find((e) => e.kind === 'LINE' && Math.abs(e.direction[2]) === 1 && !e.seam);
const mid = [0, 1, 2].map((k) => (edge.start[k] + edge.end[k]) / 2), head = [mid[0] + 0.4, mid[1], mid[2]];
const note = { id: 'n1', kind: 'arrow', body: 'mounting plate, aluminum#0', points: [[head[0] + 20, head[1] - 20, head[2] + 15], head], normal: [0, -1, 0], text: 'fillet this corner 3mm' };

// The mod's long-poll: asked with the counter it was given, the answer waits for the note and comes with it.
const { rev } = await open();
const t = performance.now(), held = open(`&since=${rev}&wait=10`);
setTimeout(() => api(`/markup?subject=${encodeURIComponent(subject)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ markups: [note] }) }), 300);
const heard = await held, ms = performance.now() - t;
assert.deepEqual(heard.files.map((f) => f.noted), [['n1']]);
assert.ok(ms > 250 && ms < 2000, `held ${Math.round(ms)} ms`);

const { files: [{ brief }] } = await open('&brief=1');
console.log(brief);
assert.match(brief, /"fillet this corner 3mm"/);
assert.match(brief, new RegExp(`a straight edge along \\[0, 0, -?1\\], ${edge.length} mm.*\\(0\\.4 mm from the point\\)`));   // the edge it points at, first
assert.match(brief, /Cell 'plate' makes that body\. Its code now:\n```js\nexport const params/);
assert.match(brief, /done \["n1"\]/);
assert.equal((await api(`/markup?subject=${encodeURIComponent(subject)}`)).markups[0].working, true);   // handed over: orange in the window
if (only === 'setup') { await client.close(); process.exit(0); }

// A change that fails to evaluate leaves the note open; one that works marks it.
const filleted = "export const params = { w: 60, d: 40, t: 8, r: 3 };\nexport default ({ p, brep, q }) => { if (p.r === 3) throw new Error('not yet'); const s = brep.subtract(brep.box(p.w, p.d, p.t), brep.cylinder(5, p.t)); return brep.name(brep.fillet(s, q.edges(s).linear().along('z').noSeams(), p.r), 'mounting plate, aluminum'); };";
let r = await tool('cadgang_cells_update', { id: 'plate', code: filleted, done: ['n1'] });
assert.equal(r.structuredContent.notes.done.length, 0);
assert.equal((await open()).files.length, 1);
r = await tool('cadgang_cells_update', { id: 'plate', params: { r: 2 }, done: ['n1'] });
console.log(JSON.stringify(r.structuredContent.notes), JSON.stringify(r.structuredContent.evaluation.cells));
assert.deepEqual(r.structuredContent.notes.done, ['n1']);
assert.equal((await open()).files.length, 0);
r = await client.callTool({ name: 'cadgang_cells_update', arguments: { id: 'plate', edits: [{ old: 'not in the code', new: 'x' }] } });
assert.ok(r.isError && /The cell's code now:\nexport const params/.test(r.content[0].text));
console.log('ok'); await client.close();
