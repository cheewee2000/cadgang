/**
 * The viewer's own routes. The viewer is the desktop app's first job: open any
 * CAD or mesh file fast. Mesh formats (STL/OBJ/PLY/3MF/glTF/FBX) are parsed in
 * the browser by three.js; B-rep formats (STEP/IGES/BREP) are tessellated here
 * by occt-import-js and streamed back as one binary buffer, not JSON — a
 * million-triangle part is 24 MB of floats either way, but JSON.parse of it is
 * seconds and a typed-array view is free.
 *
 *   POST /api/view/tessellate?name=part.step       raw body = the file
 *   POST /api/view/tessellate?path=/abs/part.step  desktop only: read from disk
 *   GET  /api/view/file?path=/abs/part.stl         desktop only: raw bytes
 *
 * Reading arbitrary local paths is what a desktop app does (Finder hands it a
 * path) and what a web server must never do, so both are gated: the .app shell
 * sets CADGANG_DESKTOP, and a loopback request without a proxy header counts too.
 */

import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import fsSync from 'node:fs';
import path from 'node:path';
import express from 'express';
import { importCadFileInWorker as importCadFile } from '../core/step.js';

const DESKTOP = process.env.CADGANG_DESKTOP === '1';
export const CAD_EXT = /\.(step|stp|iges|igs|brep)$/i;

/**
 * Who may read files by local path: the desktop shell, or anything on THIS
 * machine. The app adopts a dev server already on 4477 (started without the
 * flag), and Finder opens then failed. A request from the loopback interface
 * that did not come through a proxy (the VPS sits behind Apache, which always
 * stamps X-Forwarded-For) is the user at this computer.
 */
export function mayReadLocal(req) {
  if (DESKTOP) return true;
  const ip = String(req.socket?.remoteAddress || req.ip || '');
  const loopback = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  return loopback && !req.headers['x-forwarded-for'] && !req.headers['x-real-ip'];
}

async function localFile(req) {
  if (!mayReadLocal(req)) throw Object.assign(new Error('Reading local paths is only available in the desktop app, or from this computer'), { status: 403 });
  const p = String(req.query.path || '');
  if (!path.isAbsolute(p)) throw Object.assign(new Error('path must be absolute'), { status: 400 });
  return { name: path.basename(p), path: p, buffer: await fs.readFile(p) };
}

/** Poll each opened local file; a changed mtime tells the pages to reload it in place. */
export function fileWatcher(broadcast) {
  const watched = new Set();   // ponytail: watchers live for the process; unwatch on page close if a long session opens thousands
  return (p) => {
    if (watched.has(p)) return;
    watched.add(p);
    fsSync.watchFile(p, { interval: 1000 }, (cur, prev) => {
      if (cur.mtimeMs !== prev.mtimeMs && cur.size > 0) broadcast({ type: 'file_changed', path: p });
    });
  };
}

/**
 * Pack a tessellation as
 *   [u32 nPos, nIdx, nFaces, nBodies, nNameBytes, nNrm][f32 pos][f32 nrm][u32 idx][u32 face first,count…][u32 body first,count…][utf8 JSON names]
 * nNrm is 0 or nPos: the importer's exact surface normals, when it had them.
 * Bodies are triangle ranges, one per imported solid, so the viewer can show, hide and explode them one by one.
 */
export function pack(m) {
  const pos = Float32Array.from(m.positions), idx = Uint32Array.from(m.indices);
  const nrm = Float32Array.from(m.normals?.length === m.positions.length ? m.normals : []);
  const faces = new Uint32Array(m.faces.length * 2);
  m.faces.forEach((f, i) => { faces[2 * i] = f.first; faces[2 * i + 1] = f.count; });
  const bodyList = m.bodies?.length ? m.bodies : [{ first: 0, count: idx.length / 3, name: m.name || 'body' }];
  const bodies = new Uint32Array(bodyList.length * 2);
  bodyList.forEach((b, i) => { bodies[2 * i] = b.first; bodies[2 * i + 1] = b.count; });
  const names = Buffer.from(JSON.stringify(bodyList.map((b) => b.name)), 'utf8');
  const head = Uint32Array.of(pos.length, idx.length, m.faces.length, bodyList.length, names.length, nrm.length);
  return Buffer.concat([...[head, pos, nrm, idx, faces, bodies].map((a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength)), names]);
}

/**
 * Markups, the screen, and files pushed from MCP.
 *   GET/PUT /api/view/markup?subject=…  the markups of one opened file (default: the file on screen)
 *   POST    /api/view/snapshot          the page posts {png, camera, subject} — the live view
 *   GET     /api/view/screen?fresh=1    latest snapshot (+its markups); fresh=1 asks open pages to post
 *                                       a new one first and waits up to ?wait= seconds (default 3)
 *   GET     /api/view/screen.png        the image alone
 *   POST    /api/view/open {paths}      tell every open page to open these files (the MCP tool)
 */
export function viewRouter({ dataDir, broadcast = () => {} } = {}) {
  const watch = fileWatcher(broadcast);
  const local = async (req) => { const f = await localFile(req); watch(f.path); return f; };
  const r = express.Router();
  const slug = (subject) => crypto.createHash('sha1').update(String(subject)).digest('hex').slice(0, 16);
  const markupPath = (subject) => path.join(dataDir, 'markups', `${slug(subject)}.json`);
  const readMarkup = (subject) => { if (!subject) return []; try { return JSON.parse(fsSync.readFileSync(markupPath(subject), 'utf8')); } catch { return []; } };
  let latest = null;      // { png: Buffer, camera, subject, at }
  let waiters = [];
  const subjectOf = (req) => String(req.query.subject || req.body?.subject || latest?.subject || '');

  r.get('/markup', (req, res) => { const subject = subjectOf(req); res.json({ subject, markups: readMarkup(subject) }); });
  r.put('/markup', (req, res, next) => {
    try {
      const subject = subjectOf(req);
      if (!subject) throw Object.assign(new Error('No file is open to attach markups to'), { status: 400 });
      const markups = Array.isArray(req.body?.markups) ? req.body.markups : [];
      fsSync.mkdirSync(path.dirname(markupPath(subject)), { recursive: true });
      fsSync.writeFileSync(markupPath(subject), JSON.stringify(markups));
      broadcast({ type: 'markup_changed', subject, count: markups.length });
      res.json({ subject, markups });
    } catch (e) { next(e); }
  });

  r.post('/snapshot', express.json({ limit: '40mb' }), (req, res, next) => {
    try {
      const m = /^data:image\/png;base64,(.+)$/.exec(String(req.body?.png || ''));
      if (!m) throw Object.assign(new Error('png must be a data:image/png;base64 URL'), { status: 400 });
      latest = { png: Buffer.from(m[1], 'base64'), camera: req.body.camera ?? null, subject: req.body.subject ?? null, at: new Date().toISOString() };
      try { fsSync.mkdirSync(dataDir, { recursive: true }); fsSync.writeFileSync(path.join(dataDir, 'screen.png'), latest.png); } catch {}
      const w = waiters; waiters = [];
      for (const fn of w) fn();
      res.json({ ok: true, at: latest.at, bytes: latest.png.length });
    } catch (e) { next(e); }
  });

  const screenJson = () => latest && { at: latest.at, subject: latest.subject, camera: latest.camera, png: latest.png.toString('base64') };
  r.get('/screen', async (req, res) => {
    if (req.query.fresh === '1') {
      const wait = Math.min(10, Math.max(0.2, parseFloat(req.query.wait || '3')));
      const before = latest?.at;
      await new Promise((done) => {
        const t = setTimeout(done, wait * 1000);
        waiters.push(() => { clearTimeout(t); done(); });
        broadcast({ type: 'snapshot_request' });
      });
      return res.json({ screen: screenJson(), fresh: !!latest && latest.at !== before, markups: readMarkup(latest?.subject) });
    }
    res.json({ screen: screenJson(), fresh: false, markups: readMarkup(latest?.subject) });
  });
  r.get('/screen.png', (req, res) => latest ? res.type('png').send(latest.png) : res.status(404).json({ error: 'No snapshot yet — open the app' }));

  r.post('/open', (req, res, next) => {
    try {
      const paths = [].concat(req.body?.paths || []).map(String).filter(Boolean);
      if (!paths.length) throw Object.assign(new Error('paths: one or more absolute file paths'), { status: 400 });
      broadcast({ type: 'open', paths });
      res.json({ ok: true, paths });
    } catch (e) { next(e); }
  });

  // Drawing: the page registers a request; Claude reads it, asks its questions, sends the spec; the
  // active page renders the sheet and posts the HTML back, which is written next to the model.
  let drawingRequest = null, drawing = null, drawingWaiters = [];
  r.post('/drawing/request', (req, res) => { drawingRequest = { ...req.body, at: new Date().toISOString() }; res.json({ ok: true }); });
  r.get('/drawing/request', (req, res) => res.json({ request: drawingRequest, drawing: drawing && { path: drawing.path, at: drawing.at } }));
  r.post('/drawing/make', async (req, res) => {
    const spec = req.body?.spec ?? req.body;
    const result = new Promise((done) => {
      const t = setTimeout(() => done({ error: 'The viewer did not answer in 90 s — is a file open in a CADgang window?' }), 90_000);
      drawingWaiters.push((r) => { clearTimeout(t); done(r); });
    });
    broadcast({ type: 'drawing', spec });
    const r2 = await result;
    if (r2.error) return res.status(500).json({ error: r2.error });
    res.json({ path: r2.path, url: '/api/view/drawing' });
  });
  r.post('/drawing/result', express.json({ limit: '80mb' }), (req, res) => {
    const w = drawingWaiters; drawingWaiters = [];
    if (req.body?.error) { for (const fn of w) fn({ error: req.body.error }); return res.json({ ok: false }); }
    const subject = String(req.body?.subject || drawingRequest?.subject || '').split('|')[0];
    const base = subject ? path.basename(subject).replace(/\.[^.]+$/, '') : 'drawing';
    const dir = subject && path.isAbsolute(subject) && mayReadLocal(req) ? path.dirname(subject) : dataDir;
    const file = path.join(dir, `${base}.drawing.html`);
    try { fsSync.mkdirSync(dir, { recursive: true }); fsSync.writeFileSync(file, String(req.body?.html || '')); } catch (e) { for (const fn of w) fn({ error: e.message }); return res.status(500).json({ error: e.message }); }
    drawing = { html: String(req.body.html), path: file, at: new Date().toISOString() };
    for (const fn of w) fn({ path: file });
    res.json({ ok: true, path: file });
  });
  r.get('/drawing', (req, res) => (drawing ? res.type('html').send(drawing.html) : res.status(404).json({ error: 'No drawing yet' })));

  r.get('/file', async (req, res, next) => {
    try {
      const { name, buffer } = await local(req);
      res.set('Content-Type', 'application/octet-stream').set('X-Name', encodeURIComponent(name)).send(buffer);
    } catch (e) { next(e); }
  });

  r.post('/tessellate', express.raw({ type: () => true, limit: '500mb' }), async (req, res, next) => {
    try {
      const src = req.query.path ? await local(req) : { name: String(req.query.name || 'part.step'), buffer: req.body };
      if (!src.buffer?.length) throw Object.assign(new Error('Empty upload — send the file as the raw request body'), { status: 400 });
      const t0 = Date.now();
      // Deflection is a bbox ratio: 0.001 is CAD-viewer quality; coarser for huge assemblies is the caller's call.
      const m = await importCadFile(src.buffer, { name: src.name, linearDeflection: parseFloat(req.query.deflection || '0.0008') });
      res.set('Content-Type', 'application/octet-stream').set('X-Ms', String(Date.now() - t0)).send(pack(m));
    } catch (e) { next(e); }
  });

  return r;
}
