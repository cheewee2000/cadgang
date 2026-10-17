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

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const PORT = parseInt(process.env.CADGANG_PORT || '4477', 10);
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
// Markups (one file per opened subject) and the last screen live here; the Mac app points it at Application Support.
const DATA = process.env.CADGANG_DATA || path.join(ROOT, 'data');

const app = express();
app.use(express.json({ limit: '10mb' }));
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

/** JSON-stringify an object and send it to every open WebSocket client — except an `open` or a
 *  screen request, which go to the page the user last touched: tabs and windows share this server. */
let active = null;
function broadcast(obj) {
  const msg = JSON.stringify(obj);
  const to = (obj.type === 'open' || obj.type === 'snapshot_request') && active?.readyState === 1 ? [active] : wss.clients;
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
const PRIVATE = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;   // a VPS's public address is no LAN
const lan = () => Object.values(os.networkInterfaces()).flat().find((i) => i.family === 'IPv4' && !i.internal && PRIVATE.test(i.address))?.address || null;
app.get('/api/health', (req, res) => res.json({ ok: true, version: VERSION, clients: wss.clients.size, lan: lan(), port: PORT }));
app.use('/api/view', viewRouter({ dataDir: DATA, broadcast }));
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
// Static assets revalidate rather than sit in the cache for days, so a deploy takes effect
// on the next load instead of whenever the proxy's default lifetime happens to expire.
app.use(express.static(path.join(ROOT, 'web'), { setHeaders: (res) => res.set('Cache-Control', 'no-cache') }));

// Pages compare this with what they loaded and reload themselves when the server came back newer.
wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'hello', version: VERSION }));
  active ??= ws;
  ws.on('message', (m) => { try { if (JSON.parse(m).type === 'focus') active = ws; } catch {} });
});

server.listen(PORT, () => console.log(`CADgang ${VERSION} at http://localhost:${PORT} (data: ${DATA})`));
