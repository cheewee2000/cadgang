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
import crypto from 'node:crypto';
import { fork } from 'node:child_process';
import express from 'express';
import { WebSocketServer } from 'ws';
import { viewRouter } from './view.js';
import { CellDocument } from '../core/cells.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const PORT = parseInt(process.env.CADGANG_PORT || '4477', 10);
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
// Markups (one file per opened subject) and the last screen live here; the Mac app points it at Application Support.
const DATA = process.env.CADGANG_DATA || path.join(ROOT, 'data');
// The cell stack (prompt -> code -> B-rep) is its own document: <project>/cadgang/cells.json once a project is set.
const CELLS_PATH = process.env.CADGANG_CELLS || path.join(DATA, 'cells.json');
// The app's cell document, read here for its path and revision only: its kernel (below) owns the edits.
const cells = new CellDocument(CELLS_PATH);
const appRevision = () => { cells.openAt(cells.filePath); return cells.revision; };

const app = express();
const json = express.json({ limit: '10mb' });
app.use((req, res, next) => (req.path.startsWith('/api/cells') ? next() : json(req, res, next)));   // a cells body streams through to its kernel
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
  brep: kernelStats(),
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
// The kernels: one process per cell document (kernel.js), so a build in one project blocks neither
// this server nor another project's build, and a kernel whose heap fills is replaced on its own —
// the app, its pages and its sessions stay up. The OCCT WASM heap only ever grows, so it exits 75
// between requests once over the limit and the next request forks a fresh one.
const kernels = new Map();   // cells.json path → { cells, child, port, ready, stats, used, inflight }
const KERNELS = parseInt(process.env.CADGANG_KERNELS || '4', 10);
function kernelFor(cellsPath) {
  let k = kernels.get(cellsPath);
  if (k) { k.used = Date.now(); return k; }
  // ponytail: past the cap the longest-idle kernel goes, and its cache with it; a byte budget if that ever shows
  const idle = [...kernels.values()].filter((x) => !x.inflight).sort((a, b) => a.used - b.used);
  while (kernels.size >= KERNELS && idle.length) { const x = idle.shift(); kernels.delete(x.cells); x.child.kill(); }
  const child = fork(path.join(__dirname, 'kernel.js'), [], { env: { ...process.env, CADGANG_CELLS: cellsPath }, stdio: 'inherit' });
  k = { cells: cellsPath, child, port: null, stats: null, used: Date.now(), inflight: 0 };
  k.ready = new Promise((resolve, reject) => {
    child.on('message', (m) => {
      if (m.type === 'listening') { k.port = m.port; resolve(k); }
      else if (m.type === 'stats') k.stats = m;
      else if (m.type === 'broadcast') broadcast(m.msg);
    });
    child.on('exit', (code) => {
      if (kernels.get(cellsPath) === k) kernels.delete(cellsPath);
      if (code === 75) console.error(`cadgang: kernel for ${cellsPath} left; the next request gets a fresh one`);
      reject(new Error(`The kernel for this project stopped (exit ${code ?? 'by signal'}) — try again`));
    });
  });
  k.ready.catch(() => {});   // reported to the request that finds it, not as a stray rejection
  kernels.set(cellsPath, k);
  return k;
}
/** For /api/health: the biggest heap, its operations, and every kernel. */
function kernelStats() {
  const all = [...kernels.values()].map((k) => ({ cells: k.cells, heapBytes: k.stats?.heapBytes ?? null, operations: k.stats?.operations ?? null }));
  const top = all.reduce((a, b) => (b.heapBytes > (a?.heapBytes ?? -1) ? b : a), null);
  return { heapBytes: top?.heapBytes ?? null, operations: top?.operations ?? null, kernels: all };
}
/** Hand a request to a kernel and stream its answer back. */
function proxy(k, req, res, extra) {
  const headers = { ...req.headers, ...extra };
  delete headers.host;
  const p = http.request({ host: '127.0.0.1', port: k.port, method: req.method, path: req.originalUrl, headers }, (r) => {
    res.writeHead(r.statusCode, r.headers);
    r.pipe(res);
  });
  p.on('error', (e) => { if (!res.headersSent) res.status(502).json({ error: `The kernel for this project stopped: ${e.message}` }); else res.destroy(e); });
  req.pipe(p);
}
// The project folder: where cell exports land and where the cell document lives (<project>/cadgang/cells.json).
// The MCP server sets it to Claude Code's cwd when it starts. Until one is set, CELLS_PATH applies.
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
    // ifUnset (the MCP server on connect): never swap a document someone is working in for a folder that merely came up.
    if (req.body?.ifUnset && (appRevision(), cells.cells.length)) return res.json({ dir: project.dir, cells: cells.filePath, kept: true });
    setProject(String(req.body?.dir || '')); res.json({ dir: project.dir, cells: cells.filePath });
  } catch (e) { next(e); }
});
// Each Claude session's MCP server names its folder (X-Cadgang-Project): it gets that folder's own
// document, exports and history, so two sessions never write into each other's project. The app's
// pages send no header and work in the app's project.
const sessions = new Map();   // folder → {key, dir}
const sessionKeys = new Map(); // opaque browser key → session entry
// The server restarts itself when the kernel heap fills (above), and the Cells page that follows a
// session by key must survive that: keys are a hash of the folder, and key → folder is kept on disk so a
// page's next request after a restart finds its session again instead of a 404 until Claude's next call.
const SESSIONS_PATH = path.join(DATA, 'sessions.json');
const sessionKey = (dir) => crypto.createHash('sha256').update(dir).digest('base64url').slice(0, 16);
let knownSessions = {}; try { knownSessions = JSON.parse(fs.readFileSync(SESSIONS_PATH, 'utf8')); } catch {}
function sessionFor(dir) {
  let entry = sessions.get(dir);
  if (entry) return entry;
  entry = { key: sessionKey(dir), dir };
  sessions.set(dir, entry); sessionKeys.set(entry.key, entry);
  if (knownSessions[entry.key] !== dir) { knownSessions[entry.key] = dir; try { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(SESSIONS_PATH, JSON.stringify(knownSessions)); } catch {} }
  return entry;
}
// A session's build holds its kernel, and the tabs on that project wait behind it: they say why.
let working = 0;
function busy(d, what) { working += d; if (d > 0 && working === 1) broadcast({ type: 'busy', what }); if (!working) broadcast({ type: 'busy', what: null }); }
app.use('/api/cells', (req, res, next) => {
  // MCP alone names a filesystem folder. The browser follows with an opaque
  // key, so no local path appears in its URL or becomes a read primitive.
  const header = req.get('x-cadgang-project');
  let dir = header && path.resolve(header), entry = null;
  if (header) {
    if (!fs.existsSync(dir)) return res.status(404).json({ error: `Project folder no longer exists: ${dir}` });
    if (dir !== project.dir) entry = sessionFor(dir);
    broadcast({ type: 'cells_project_active', session: entry?.key ?? null, name: path.basename(dir) });
  } else if (req.query.session) {
    const key = String(req.query.session), known = knownSessions[key];
    entry = sessionKeys.get(key) ?? (known && known !== project.dir && fs.existsSync(known) ? sessionFor(known) : null);
    if (!entry && known !== project.dir) return res.status(404).json({ error: 'That live authoring session is no longer available' });
  }
  if (header && dir && !req.query.wait) { busy(+1, `Claude (${path.basename(dir)}) is building…`); res.once('close', () => busy(-1)); }
  const k = kernelFor(entry ? path.join(entry.dir, 'cadgang', 'cells.json') : cells.filePath);
  k.inflight++; res.once('close', () => { k.inflight--; });
  k.ready.then(() => proxy(k, req, res, { 'x-cadgang-dir': entry?.dir ?? project.dir ?? '', 'x-cadgang-session': entry?.key ?? '' }), (e) => res.status(502).json({ error: e.message }));
});
// Fork the app's kernel now so the first evaluate does not pay the WASM load.
kernelFor(cells.filePath);
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
// Static assets revalidate rather than sit in the cache for days, so a deploy takes effect
// on the next load instead of whenever the proxy's default lifetime happens to expire.
app.use(express.static(path.join(ROOT, 'web'), { setHeaders: (res) => res.set('Cache-Control', 'no-cache') }));

// Pages compare this with what they loaded and reload themselves when the server came back newer.
wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'hello', version: VERSION, cellsRevision: appRevision() }));
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
