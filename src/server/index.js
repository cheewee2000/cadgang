/**
 * CADgang server: the viewer page, its file routes, markups, and the screen
 * Claude sees — plus a WebSocket so open pages learn about restarts, new
 * markups and files pushed from MCP.
 *
 *   node src/server/index.js          # http://localhost:4477
 *   CADGANG_PORT=5000 npm start
 */

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { viewRouter } from './view.js';
import { CellDocument } from '../core/cells.js';
import { cellsRouter } from './cells.js';
import { historyRouter } from './history.js';
import { optionsRouter } from './options.js';
import { initBrep, brepHeapBytes, brepOperationStats } from '../core/brep.js';
import { setImportRoot } from '../core/ops.js';
import { SoftgoodsDocument } from '../core/softgoods-document.js';
import { softgoodsRouter } from './softgoods.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const PORT = parseInt(process.env.CADGANG_PORT || '4477', 10);
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
// Markups (one file per opened subject) and the last screen live here; the Mac app points it at Application Support.
const DATA = process.env.CADGANG_DATA || path.join(ROOT, 'data');
// The cell stack (prompt -> code -> B-rep) is its own document: <project>/cadgang/cells.json once a project is set.
const CELLS_PATH = process.env.CADGANG_CELLS || path.join(DATA, 'cells.json');
const cells = new CellDocument(CELLS_PATH);
const softgoods = new SoftgoodsDocument(path.join(path.dirname(CELLS_PATH), 'softgoods.json'));

const app = express();
app.use(express.json({ limit: '10mb' }));
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

/** JSON-stringify an object and send it to every open WebSocket client — except an `open` or a
 *  screen request, which go to the page the user last touched: tabs and windows share this server.
 *  A screen request with `dir` (the asking Claude session's folder) goes to the pages showing a file in it. */
let active = null;
const under = (subject, dir) => !!dir && String(subject || '').split('|').some((f) => (f + '/').startsWith(dir.replace(/\/+$/, '') + '/'));
function broadcast(obj) {
  const msg = JSON.stringify(obj);
  const mine = obj.type === 'snapshot_request' && obj.dir ? [...wss.clients].filter((c) => c.readyState === 1 && under(c.subject, obj.dir)) : [];
  const to = mine.length ? mine : (obj.type === 'open' || obj.type === 'snapshot_request') && active?.readyState === 1 ? [active] : wss.clients;
  for (const client of to) if (client.readyState === 1) client.send(msg);
}

// The API is live state — never let it be cached. Behind a reverse proxy that stamps a
// default freshness lifetime on responses (DreamHost's Apache adds max-age=172800) a cached
// answer freezes the page against a stale state forever.
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Expires', '0');
  next();
});
/** This machine's first LAN IPv4: an iPad on the same Wi-Fi reaches the viewer at http://<lan>:PORT/view?follow. */
// Only the desktop app lets a LAN client open local paths (mayReadLocal), so only it offers the link.
const lan = () => process.env.CADGANG_DESKTOP === '1' && Object.values(os.networkInterfaces()).flat().find((i) => i.family === 'IPv4' && !i.internal)?.address || null;
app.get('/api/health', (req, res) => res.json({
  ok: true, version: VERSION, clients: wss.clients.size, lan: lan(), port: PORT, cells: cells.filePath,
  brep: { heapBytes: brepHeapBytes(), operations: brepOperationStats() },
}));
/** The open files: one per page that announced its subject (a ?follow page never does), the focused
 *  one flagged. An iPad follower shows them as tabs and trails the flagged one (v0.14.12: before it
 *  only ever saw the window that last posted a snapshot). */
function tabs() {
  const seen = new Map();
  for (const c of wss.clients) {
    if (!c.subject || c.readyState !== 1) continue;
    const t = seen.get(c.subject) ?? { subject: c.subject, active: false };
    if (c === active) t.active = true;
    seen.set(c.subject, t);
  }
  return [...seen.values()];
}
const broadcastTabs = () => broadcast({ type: 'tabs', tabs: tabs() });
app.get('/api/view/tabs', (req, res) => res.json({ tabs: tabs() }));
app.use('/api/view', viewRouter({ dataDir: DATA, broadcast }));
app.use('/api/softgoods', softgoodsRouter(softgoods, { exportDir: () => project.dir || process.cwd(), broadcast }));
// The OCCT WASM heap only ever grows; near its 2 GB cap every operation fails with malloc errors and
// nothing crashes, so the supervisor never restarts it. Leave on purpose between requests instead.
let inflight = 0;
app.use('/api/cells', (req, res, next) => { inflight++; res.once('close', () => { inflight--; }); next(); });
const HEAP_LIMIT = parseInt(process.env.CADGANG_HEAP_LIMIT || String(1.5 * 2 ** 30), 10);
setInterval(() => {
  const heap = brepHeapBytes();
  if (heap > HEAP_LIMIT && inflight === 0) {
    console.error(`cadgang: kernel heap ${(heap / 2 ** 20).toFixed(0)} MB over the ${(HEAP_LIMIT / 2 ** 20).toFixed(0)} MB limit — restarting for a fresh kernel`);
    process.exit(75);
  }
}, 5000).unref();
// The project folder: where cell exports land and where the cell document lives (<project>/cadgang/cells.json).
// The MCP server sets it to Claude Code's cwd when it starts. Until one is set, CELLS_PATH applies.
const project = { dir: process.env.CADGANG_PROJECT || null };
function setProject(dir) {
  dir = path.resolve(dir);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw Object.assign(new Error(`Not a folder: ${dir}`), { status: 400 });
  if (project.dir === dir) return;
  project.dir = dir;
  setImportRoot(dir);
  cells.openAt(path.join(dir, 'cadgang', 'cells.json'));
  softgoods.filePath = path.join(dir, 'cadgang', 'softgoods.json'); softgoods.load();
}
if (project.dir) setProject(project.dir);
app.get('/api/project', (req, res) => res.json({ dir: project.dir, cells: cells.filePath }));
app.post('/api/project', (req, res, next) => {
  try {
    // ifUnset (the MCP server on connect): never swap a document someone is working in for a folder that merely came up.
    if (req.body?.ifUnset && cells.cells.length) return res.json({ dir: project.dir, cells: cells.filePath, kept: true });
    setProject(String(req.body?.dir || '')); res.json({ dir: project.dir, cells: cells.filePath });
  } catch (e) { next(e); }
});
/** A cell document's routes: the cells, their history and option sets. */
function cellRoutes(doc, proj) {
  const api = cellsRouter(doc, ROOT, { project: proj }), r = express.Router();
  r.use('/history', historyRouter(doc, { dirOf: () => path.join(path.dirname(doc.filePath || CELLS_PATH), 'history'), modelOf: api.modelOf, broadcast }));
  r.use('/options', optionsRouter(doc, { modelOf: api.modelOf, broadcast }));
  r.use(api);
  return r;
}
const appRoutes = cellRoutes(cells, project);
// Each Claude session's MCP server names its folder (X-Cadgang-Project): it gets that folder's own
// document, exports and history, so two sessions never write into each other's project. The app's
// pages send no header and work in the app's project.
const sessions = new Map();   // folder → routes
// A session's build holds the one thread, and every tab's load waits behind it: the tabs say why.
let working = 0;
function busy(d, what) { working += d; if (d > 0 && working === 1) broadcast({ type: 'busy', what }); if (!working) broadcast({ type: 'busy', what: null }); }
app.use('/api/cells', (req, res, next) => {
  const h = req.get('x-cadgang-project');
  const dir = h && path.resolve(h);
  if (dir && !req.query.wait) { busy(+1, `Claude (${path.basename(dir)}) is building…`); res.once('close', () => busy(-1)); }
  if (!dir || dir === project.dir || !fs.existsSync(dir)) { setImportRoot(project.dir || process.cwd()); return appRoutes(req, res, next); }
  if (!sessions.has(dir)) sessions.set(dir, cellRoutes(new CellDocument(path.join(dir, 'cadgang', 'cells.json')), { dir }));
  // ponytail: importStep reads one global root, set per request; two sessions evaluating in the same tick could cross. Pass the root down if that bites.
  setImportRoot(dir);
  sessions.get(dir)(req, res, next);
});
// Load the kernel now so the first evaluate does not pay the WASM load.
initBrep().catch((e) => console.error('B-rep kernel failed to load:', e.message));
// Everything that goes wrong on the API answers in its own shape, never as HTML.
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
// A stray rejection must not take the open window down with it: log it and keep serving.
process.on('unhandledRejection', (e) => console.error('unhandled rejection:', e?.stack || e));
process.on('uncaughtException', (e) => console.error('uncaught exception:', e?.stack || e));

// The viewer is the whole site. /view stays as an alias for the Mac shell and old links.
app.get(['/', '/view'], (req, res) => res.sendFile(path.join(ROOT, 'web', 'view.html')));
// The cell stack is its own page; it shares the server and the kernel with the viewer, nothing else.
app.get('/cells', (req, res) => res.sendFile(path.join(ROOT, 'web', 'cells.html')));
app.get('/softgoods', (req, res) => res.sendFile(path.join(ROOT, 'web', 'softgoods.html')));
// Static assets revalidate rather than sit in the cache for days, so a deploy takes effect
// on the next load instead of whenever the proxy's default lifetime happens to expire.
app.use(express.static(path.join(ROOT, 'web'), { setHeaders: (res) => res.set('Cache-Control', 'no-cache') }));

// Pages compare this with what they loaded and reload themselves when the server came back newer.
cells.onChange(() => broadcast({ type: 'cells_changed', revision: cells.revision }));
wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'hello', version: VERSION, cellsRevision: cells.revision }));
  active ??= ws;
  ws.on('message', (m) => {
    try {
      const msg = JSON.parse(m);
      if (msg.type === 'focus' && active !== ws) { active = ws; broadcastTabs(); }
      if (msg.type === 'open_subject') { ws.subject = String(msg.subject || ''); broadcastTabs(); }
    } catch {}
  });
  ws.on('close', () => { if (ws.subject) broadcastTabs(); });
});

server.listen(PORT, () => console.log(`CADgang ${VERSION} at http://localhost:${PORT} (data: ${DATA})`));
