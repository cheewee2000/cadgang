/**
 * cadgang server: REST API + WebSocket live updates + static web UI.
 *
 *   node src/server/index.js          # http://localhost:4477
 *   CADGANG_PORT=5000 npm start
 */

import http from 'node:http';
import path from 'node:path';
import url from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { ModelDocument } from '../core/document.js';
import { CellDocument } from '../core/cells.js';
import { apiRouter } from './api.js';
import { cellsRouter } from './cells.js';
import { initBrep } from '../core/brep.js';

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
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Expires', '0');
  next();
});
app.use('/api/cells', cellsRouter(cells, ROOT));
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
