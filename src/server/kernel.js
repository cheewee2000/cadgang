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

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import express from 'express';
import { CellDocument } from '../core/cells.js';
import { persistMeasureMemo } from '../core/cellapi.js';
import { cellsRouter, packBinaryMesh } from './cells.js';
import { historyRouter } from './history.js';
import { optionsRouter } from './options.js';
import { initBrep, brepHeapBytes, brepOperationStats, progress, tessellate, brepBBox } from '../core/brep.js';
import { setImportRoot } from '../core/ops.js';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../..');
const CELLS_PATH = process.env.CADGANG_CELLS;
const send = (m) => { try { process.send?.(m); } catch { /* the main server is gone; so are we, shortly */ } };
const broadcast = (msg) => send({ type: 'broadcast', msg });

const doc = new CellDocument(CELLS_PATH), proj = { dir: null };
if (process.env.CADGANG_DISK_CACHE !== '0') persistMeasureMemo(path.join(os.homedir(), 'Library', 'Caches', 'cadgang', 'measures.json'));   // with the parts on disk (cells.js), a fresh kernel's checks are lookups too
let session = null;
const api = cellsRouter(doc, ROOT, { project: proj }), routes = express.Router();
// The document rides along: the page draws the stack from it at once, since a build may be holding
// this process for the next minute and a fetch would wait behind it.
doc.onChange(() => broadcast({ type: 'cells_changed', revision: doc.revision, session, doc: { ...doc.toJSON(), checks: doc.checks !== false } }));
routes.use('/history', historyRouter(doc, { dirOf: () => path.join(path.dirname(doc.filePath || CELLS_PATH), 'history'), modelOf: api.modelOf, broadcast }));
routes.use('/options', optionsRouter(doc, { modelOf: api.modelOf, broadcast }));
routes.use(api);

// Live building: a cell program runs for a minute or more with this process blocked in OCCT, so the page
// could not even ask for a mesh. Instead, after a feature op lands and a second has passed since the last
// draft, the shape it made is tessellated coarse into a file (a synchronous write; the IPC pipe would fill
// and queue behind the blocked loop) and a one-line notice goes to the main server, which tells the page
// (cells_progress) and serves the file (/api/cells/draft). Primitives and moves are skipped: they are
// usually tools about to be cut or joined, and a lone cylinder flashing over the model says nothing.
const DRAFT_MS = parseInt(process.env.CADGANG_DRAFT_MS || '1000', 10);
const DRAFT_FILE = path.join(os.tmpdir(), `cadgang-draft-${process.pid}.bin`);
// A primitive is usually a tool about to be cut or joined, so it is not a step; a move is one only in a
// check cell, where the moved pose IS the test (the lid swung open, a caster turned). A render (what
// Claude asked to see, with its mesh already made) always goes out.
const PRIMITIVES = new Set(['box', 'cylinder', 'sphere', 'cone', 'torus', 'coil']), MOVES = new Set(['translate', 'rotate', 'scale', 'mirror']);
let draftAt = 0, draftCost = 0, requestAt = 0;   // when the last draft was written, what it cost, and when this request began
progress.fn = (op, shape, { cell = progress.cell, mesh = null, edges = null } = {}) => {
  if (DRAFT_MS < 0) return;
  if (op === 'cell') { send({ type: 'draft', session, cell, op, kind: progress.asserting ? 'assert' : 'build', file: null }); return; }   // a cell began: no mesh, the pane lights it at once
  if (op === 'done') { send({ type: 'draft', session, cell: null, op, kind: 'done', file: null }); return; }
  // A check's poses cost as much as the check, so a check done in a few seconds is not drafted; a part being built shows from the first second.
  const now = performance.now(), quiet = progress.asserting ? DRAFT_AFTER_MS : Math.min(DRAFT_AFTER_MS, DRAFT_MS);
  if (op !== 'render' && (PRIMITIVES.has(op) || (MOVES.has(op) && !progress.asserting) || now - requestAt < quiet || now - draftAt < Math.max(DRAFT_MS, draftCost * 4))) return;   // a 2 s draft waits 8 s: drafting never takes the build over
  const kind = op === 'render' ? 'render' : progress.asserting ? 'assert' : 'build';
  const begun = performance.now();
  try {
    const bb = brepBBox(shape); if (!bb) return;
    const size = bb.max.map((v, i) => v - bb.min[i]);
    const t = mesh ?? tessellate(shape, { tolerance: Math.min(5, Math.max(0.1, Math.hypot(...size) / 300)), angularTolerance: 0.6 });
    fs.writeFileSync(`${DRAFT_FILE}.part`, packBinaryMesh({ cell, op, kind, bbox: { ...bb, size } }, t, edges));
    fs.renameSync(`${DRAFT_FILE}.part`, DRAFT_FILE);   // never half a file on the other side
    send({ type: 'draft', session, cell, op, kind, file: DRAFT_FILE });
  } catch (e) { console.error(`kernel: draft after ${op} skipped: ${e.message}`); }
  draftAt = performance.now(); draftCost = draftAt - begun;   // after the tessellation: its cost does not shorten the gap
};
process.on('exit', () => { try { fs.unlinkSync(DRAFT_FILE); } catch { /* none written */ } });

const app = express();
app.use(express.json({ limit: '10mb' }));
let inflight = 0;
const DRAFT_AFTER_MS = parseInt(process.env.CADGANG_DRAFT_AFTER_MS || '3000', 10);
app.use('/api/cells', (req, res, next) => {
  inflight++; res.once('close', () => { inflight--; });
  requestAt = performance.now();
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
