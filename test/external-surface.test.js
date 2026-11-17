/**
 * What other people's tools call. Eddie's industrial-design-app opens a model here, counts the open
 * marks on it, and runs Claude Code sessions with these MCP tools by name. Renaming any of these
 * breaks a tool nobody here runs, so a failure means: tell its owner before changing it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const index = read('src/server/index.js');
const view = read('src/server/view.js');
const mcp = read('src/mcp/index.js');
const page = read('web/view.js');

test('GET /api/health answers with the count of open windows', () => {
  assert.match(index, /app\.get\('\/api\/health'[^]{0,120}clients: wss\.clients\.size/);
});

test('/api/view/markup?subject= returns {subject, markups}, and /api/view/open takes {paths}', () => {
  assert.ok(index.includes("app.use('/api/view', viewRouter("));
  assert.match(view, /r\.get\('\/markup'[^\n]*res\.json\(\{ subject, markups:/);
  assert.ok(view.includes("r.put('/markup'"));
  assert.ok(view.includes("r.post('/open'"));
  assert.match(view, /req\.query\.subject/);
});

test('a mark keeps id, kind, text, body and done', () => {
  for (const field of ['m.id', 'm.done', 'done: true']) assert.ok(mcp.includes(field), field);
  for (const kind of ["'pen'", "'arrow'", "'note'", "'path'", "'text'", "'image'"]) assert.ok(mcp.includes(kind), `kind ${kind}`);
});

test('/view?open=a|b opens files, and the Mac app ships cadgang-open', () => {
  assert.match(page, /params\.get\('open'\)/);
  assert.ok(page.includes("openArg.split('|')"));
  assert.ok(fs.existsSync(new URL('../mac/cadgang-open', import.meta.url)));
  assert.ok(read('mac/build.sh').includes('Contents/MacOS/cadgang-open'));
});

test('the MCP server is src/mcp/index.js and keeps the tool names sessions are allowed by', () => {
  for (const name of ['cadgang_screen', 'cadgang_feedback', 'cadgang_markup_done', 'cadgang_open', 'cadgang_drawing_make']) {
    assert.match(mcp, new RegExp(`^\\s*'${name}',$`, 'm'), name);
  }
  assert.match(mcp, /inputSchema: \{ fresh: z\.boolean\(\)/);   // cadgang_screen({fresh})
});

test('the one-sheet drawing is saved beside the model as <name>.drawing.html', () => {
  assert.ok(view.includes('.drawing.html`'));
});
