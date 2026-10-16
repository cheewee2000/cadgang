/**
 * cadgang server: REST API + WebSocket live updates + static web UI.
 *
 *   node src/server/index.js          # http://localhost:4477
 *   CADGANG_PORT=5000 npm start
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { ModelDocument } from '../core/document.js';
import { CellDocument } from '../core/cells.js';
import { apiRouter } from './api.js';
import { cellsRouter } from './cells.js';
import { viewRouter } from './view.js';
import { historyRouter } from './history.js';
import { optionsRouter } from './options.js';
import { initBrep, brepHeapBytes } from '../core/brep.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const PORT = parseInt(process.env.CADGANG_PORT || '4477', 10);
const DOC_PATH = process.env.CADGANG_DOC || path.join(ROOT, 'data', 'document.json');
const CELLS_PATH = process.env.CADGANG_CELLS || path.join(ROOT, 'data', 'cells.json');

const doc = new ModelDocument(DOC_PATH);
// The v2 cell stack is a second, independent document. There is no migration
// between them by design — they share the process and the kernel, nothing else.
const cells = new CellDocument(CELLS_PATH);
const app = express();
app.use(express.json({ limit: '10mb' }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

/** JSON-stringify an object and send it to every open WebSocket client. */
function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(msg);
  }
}

// The API is live state — never let it be cached. Behind a reverse proxy that stamps a
// default freshness lifetime on responses (DreamHost's Apache adds max-age=172800) a cached
// /api/health or /api/document freezes the UI against a stale revision forever.
let inflight = 0;
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Expires', '0');
  inflight++; res.once('close', () => { inflight--; });
  next();
});
// The OCCT WASM heap only ever grows; near its 2 GB cap every operation fails
// with malloc errors and nothing crashes, so the supervisor never restarts it.
// Leave on purpose between requests instead — the documents are autosaved and
// supervise.js brings the server straight back.
const HEAP_LIMIT = parseInt(process.env.CADGANG_HEAP_LIMIT || String(1.5 * 2 ** 30), 10);
setInterval(() => {
  const heap = brepHeapBytes();
  if (heap > HEAP_LIMIT && inflight === 0) {
    console.error(`cadgang: kernel heap ${(heap / 2 ** 20).toFixed(0)} MB over the ${(HEAP_LIMIT / 2 ** 20).toFixed(0)} MB limit — restarting for a fresh kernel`);
    process.exit(75);
  }
}, 5000).unref();
// The project folder: where exports land and where the cell document lives
// (<project>/cadgang/cells.json). The MCP server sets it to Claude Code's cwd
// when it starts; opening a file in the desktop app sets it to that file's
// folder. Until one is set, the env/default paths above apply.
const project = { dir: process.env.CADGANG_PROJECT || null };
function setProject(dir) {
  dir = path.resolve(dir);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw Object.assign(new Error(`Not a folder: ${dir}`), { status: 400 });
  if (project.dir === dir) return;
  project.dir = dir;
  cells.openAt(path.join(dir, 'cadgang', 'cells.json'));
}
if (project.dir) setProject(project.dir);
app.get('/api/project', (req, res) => res.json({ dir: project.dir, cells: cells.filePath }));
app.post('/api/project', (req, res, next) => {
  try {
    // ifUnset (the MCP server on connect): never swap a document someone is
    // working in for the folder Claude Code happened to start in.
    if (req.body?.ifUnset && project.dir && cells.cells.length) {
      return res.json({ dir: project.dir, cells: cells.filePath, kept: true });
    }
    setProject(String(req.body?.dir || '')); res.json({ dir: project.dir, cells: cells.filePath });
  } catch (e) { next(e); }
});
const cellsApi = cellsRouter(cells, ROOT, { project });
// Versions live beside the document: <project>/cadgang/history/ (or data/history/ in dev).
app.use('/api/cells/history', historyRouter(cells, {
  dirOf: () => path.join(path.dirname(cells.filePath || CELLS_PATH), 'history'),
  modelOf: cellsApi.modelOf, broadcast,
}));
app.use('/api/cells/options', optionsRouter(cells, { modelOf: cellsApi.modelOf, broadcast }));
app.use('/api/cells', cellsApi);
app.use('/api/view', viewRouter({ dirOf: () => path.dirname(cells.filePath || CELLS_PATH), broadcast }));
// A body that is not JSON (a literal NaN, a stray comma) is a client error in
// the API's own shape, not Express's HTML page with a stack trace on it.
app.use('/api', (err, req, res, next) => {
  if (err?.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    return res.status(400).json({ error: `Request body is not valid JSON: ${err.message}` });
  }
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'Request body is too large' });
  return next(err);
});
// A stray rejection or exception anywhere must not take every open document
// down with it: log it and keep serving. The supervisor restarts a real crash.
process.on('unhandledRejection', (e) => console.error('unhandled rejection:', e?.stack || e));
process.on('uncaughtException', (e) => console.error('uncaught exception:', e?.stack || e));

// Load the kernel now rather than on the first geometry request, so /api/health's
// brepKernel flag means "ready" and the first evaluate does not pay the WASM load.
initBrep().catch((e) => console.error('B-rep kernel failed to load:', e.message));
app.use('/api', apiRouter(doc, ROOT, broadcast, cells));
app.use('/api', (req, res) => res.status(404).json({ error: `No such API route: ${req.method} ${req.originalUrl}` }));
// Whatever else goes wrong on the API answers in its own shape, never as HTML.
app.use('/api', (err, req, res, next) => {
  if (res.headersSent) return next(err);
  console.error('API error:', err?.stack || err);
  res.status(err?.status || 500).json({ error: err?.message || String(err) });
});

// The v2 cell transcript is its own page rather than a mode inside the node
// editor — the two documents share a server and nothing else.
app.get('/cells', (req, res) => res.sendFile(path.join(ROOT, 'web', 'cells.html')));
// The viewer: the desktop app's home page. Opens any mesh or CAD file, no document behind it.
app.get('/view', (req, res) => res.sendFile(path.join(ROOT, 'web', 'view.html')));

// Static assets revalidate rather than sit in the cache for days, so a deploy takes effect
// on the next load instead of whenever the proxy's default lifetime happens to expire.
app.use(express.static(path.join(ROOT, 'web'), {
  setHeaders: (res) => res.set('Cache-Control', 'no-cache'),
}));

doc.onChange(() => broadcast({ type: 'document_changed', revision: doc.revision }));
cells.onChange(() => broadcast({ type: 'cells_changed', revision: cells.revision }));

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'hello', revision: doc.revision, cellsRevision: cells.revision }));
});

server.listen(PORT, () => {
  console.log(`cadgang server running at http://localhost:${PORT}`);
  console.log(`model document: ${DOC_PATH}`);
});
