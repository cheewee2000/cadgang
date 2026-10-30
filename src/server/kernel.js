/**
 * A kernel host: one per cell document, forked by index.js. It owns an OCCT kernel and the
 * document's cells, history and options routes. The main server proxies /api/cells here and keeps
 * answering while a build runs; projects build in parallel, each in its own kernel. When this heap
 * fills, it exits 75 and the main server forks a fresh one — the app, its pages and its sessions
 * never restart.
 *
 * From the main server, per request: X-Cadgang-Dir (the project folder, where exports land) and
 * X-Cadgang-Session (the browser key the change broadcasts carry).
 */

import http from 'node:http';
import path from 'node:path';
import url from 'node:url';
import express from 'express';
import { CellDocument } from '../core/cells.js';
import { cellsRouter } from './cells.js';
import { historyRouter } from './history.js';
import { optionsRouter } from './options.js';
import { initBrep, brepHeapBytes, brepOperationStats } from '../core/brep.js';
import { setImportRoot } from '../core/ops.js';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../..');
const CELLS_PATH = process.env.CADGANG_CELLS;
const send = (m) => { try { process.send?.(m); } catch { /* the main server is gone; so are we, shortly */ } };
const broadcast = (msg) => send({ type: 'broadcast', msg });

const doc = new CellDocument(CELLS_PATH), proj = { dir: null };
let session = null;
const api = cellsRouter(doc, ROOT, { project: proj }), routes = express.Router();
doc.onChange(() => broadcast({ type: 'cells_changed', revision: doc.revision, session }));
routes.use('/history', historyRouter(doc, { dirOf: () => path.join(path.dirname(doc.filePath || CELLS_PATH), 'history'), modelOf: api.modelOf, broadcast }));
routes.use('/options', optionsRouter(doc, { modelOf: api.modelOf, broadcast }));
routes.use(api);

const app = express();
app.use(express.json({ limit: '10mb' }));
let inflight = 0;
app.use('/api/cells', (req, res, next) => {
  inflight++; res.once('close', () => { inflight--; });
  proj.dir = req.get('x-cadgang-dir') || null;
  session = req.get('x-cadgang-session') || null;
  setImportRoot(proj.dir || process.cwd());
  routes(req, res, next);
});
app.use('/api', (err, req, res, next) => {
  if (err?.type === 'entity.parse.failed' || err instanceof SyntaxError) return res.status(400).json({ error: `Request body is not valid JSON: ${err.message}` });
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'Request body is too large' });
  return next(err);
});
app.use('/api', (req, res) => res.status(404).json({ error: `No such API route: ${req.method} ${req.originalUrl}` }));
app.use('/api', (err, req, res, next) => {
  if (res.headersSent) return next(err);
  console.error('API error:', err?.stack || err);
  res.status(err?.status || 500).json({ error: err?.message || String(err) });
});

// The OCCT WASM heap only ever grows; near its 2 GB cap every operation fails with malloc errors and
// nothing crashes. Leave on purpose between requests instead; the main server forks a fresh kernel.
const HEAP_LIMIT = parseInt(process.env.CADGANG_HEAP_LIMIT || String(1.5 * 2 ** 30), 10);
setInterval(() => {
  const heap = brepHeapBytes();
  if (heap > HEAP_LIMIT && inflight === 0) {
    console.error(`cadgang: kernel heap ${(heap / 2 ** 20).toFixed(0)} MB over the ${(HEAP_LIMIT / 2 ** 20).toFixed(0)} MB limit — leaving for a fresh kernel`);
    process.exit(75);
  }
}, 5000).unref();
setInterval(() => send({ type: 'stats', heapBytes: brepHeapBytes(), operations: brepOperationStats() }), 5000).unref();
process.on('disconnect', () => process.exit(0));   // the main server went away
process.on('unhandledRejection', (e) => console.error('kernel: unhandled rejection:', e?.stack || e));
process.on('uncaughtException', (e) => console.error('kernel: uncaught exception:', e?.stack || e));

initBrep().catch((e) => console.error('B-rep kernel failed to load:', e.message));
const server = http.createServer(app);
server.requestTimeout = 0; server.headersTimeout = 0;   // a build can run for minutes
server.listen(0, '127.0.0.1', () => send({ type: 'listening', port: server.address().port }));
