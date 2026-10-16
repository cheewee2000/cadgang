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
 * path) and what a web server must never do, so both are gated on
 * CADGANG_DESKTOP, which only the .app shell sets.
 */

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import express from 'express';
import { importCadFile } from '../core/step.js';

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
  return { name: path.basename(p), buffer: await fs.readFile(p) };
}

/**
 * Pack a tessellation as
 *   [u32 nPos, nIdx, nFaces, nBodies, nNameBytes][f32 pos][u32 idx][u32 face first,count…][u32 body first,count…][utf8 JSON names]
 * Bodies are triangle ranges, one per imported solid, so the viewer can show, hide and explode them one by one.
 */
export function pack(m) {
  const pos = Float32Array.from(m.positions), idx = Uint32Array.from(m.indices);
  const faces = new Uint32Array(m.faces.length * 2);
  m.faces.forEach((f, i) => { faces[2 * i] = f.first; faces[2 * i + 1] = f.count; });
  const bodyList = m.bodies?.length ? m.bodies : [{ first: 0, count: idx.length / 3, name: m.name || 'body' }];
  const bodies = new Uint32Array(bodyList.length * 2);
  bodyList.forEach((b, i) => { bodies[2 * i] = b.first; bodies[2 * i + 1] = b.count; });
  const names = Buffer.from(JSON.stringify(bodyList.map((b) => b.name)), 'utf8');
  const head = Uint32Array.of(pos.length, idx.length, m.faces.length, bodyList.length, names.length);
  return Buffer.concat([...[head, pos, idx, faces, bodies].map((a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength)), names]);
}

/**
 * Markups and the screen.
 *   GET/PUT /api/view/markup            the project's markups (<project>/cadgang/markup.json)
 *   POST    /api/view/snapshot          the page posts {png, camera, page, subject} — the live view
 *   GET     /api/view/screen?fresh=1    latest snapshot (+markups); fresh=1 asks open pages to post
 *                                       a new one first and waits up to ?wait= seconds (default 3)
 *   GET     /api/view/screen.png        the image alone
 */
export function viewRouter({ dirOf = () => null, broadcast = () => {} } = {}) {
  const r = express.Router();
  const markupPath = () => dirOf() && path.join(dirOf(), 'markup.json');
  const readMarkup = () => { try { return JSON.parse(fsSync.readFileSync(markupPath(), 'utf8')); } catch { return []; } };
  let latest = null;      // { png: Buffer, camera, page, subject, at }
  let waiters = [];

  r.get('/markup', (req, res) => res.json({ markups: readMarkup() }));
  r.put('/markup', (req, res, next) => {
    try {
      const markups = Array.isArray(req.body?.markups) ? req.body.markups : [];
      const p = markupPath();
      if (!p) throw Object.assign(new Error('No project folder yet'), { status: 400 });
      fsSync.mkdirSync(path.dirname(p), { recursive: true });
      fsSync.writeFileSync(p, JSON.stringify(markups));
      broadcast({ type: 'markup_changed', count: markups.length });
      res.json({ markups });
    } catch (e) { next(e); }
  });

  r.post('/snapshot', express.json({ limit: '40mb' }), (req, res, next) => {
    try {
      const m = /^data:image\/png;base64,(.+)$/.exec(String(req.body?.png || ''));
      if (!m) throw Object.assign(new Error('png must be a data:image/png;base64 URL'), { status: 400 });
      latest = { png: Buffer.from(m[1], 'base64'), camera: req.body.camera ?? null, page: req.body.page ?? null, subject: req.body.subject ?? null, at: new Date().toISOString() };
      if (dirOf()) { try { fsSync.mkdirSync(dirOf(), { recursive: true }); fsSync.writeFileSync(path.join(dirOf(), 'screen.png'), latest.png); } catch {} }
      const w = waiters; waiters = [];
      for (const fn of w) fn();
      res.json({ ok: true, at: latest.at, bytes: latest.png.length });
    } catch (e) { next(e); }
  });

  const screenJson = () => latest && { at: latest.at, page: latest.page, subject: latest.subject, camera: latest.camera, png: latest.png.toString('base64') };
  r.get('/screen', async (req, res) => {
    const fresh = req.query.fresh === '1';
    if (fresh) {
      const wait = Math.min(10, Math.max(0.2, parseFloat(req.query.wait || '3')));
      const before = latest?.at;
      await new Promise((done) => {
        const t = setTimeout(done, wait * 1000);
        waiters.push(() => { clearTimeout(t); done(); });
        broadcast({ type: 'snapshot_request' });
      });
      res.json({ screen: screenJson(), fresh: !!latest && latest.at !== before, markups: readMarkup() });
      return;
    }
    res.json({ screen: screenJson(), fresh: false, markups: readMarkup() });
  });
  r.get('/screen.png', (req, res) => latest ? res.type('png').send(latest.png) : res.status(404).json({ error: 'No snapshot yet — open the app' }));

  r.get('/file', async (req, res, next) => {
    try {
      const { name, buffer } = await localFile(req);
      res.set('Content-Type', 'application/octet-stream').set('X-Name', encodeURIComponent(name)).send(buffer);
    } catch (e) { next(e); }
  });

  r.post('/tessellate', express.raw({ type: () => true, limit: '500mb' }), async (req, res, next) => {
    try {
      const src = req.query.path ? await localFile(req) : { name: String(req.query.name || 'part.step'), buffer: req.body };
      if (!src.buffer?.length) throw Object.assign(new Error('Empty upload — send the file as the raw request body'), { status: 400 });
      const t0 = Date.now();
      // Deflection is a bbox ratio: 0.001 is CAD-viewer quality; coarser for huge assemblies is the caller's call.
      const m = await importCadFile(src.buffer, { name: src.name, linearDeflection: parseFloat(req.query.deflection || '0.0008') });
      res.set('Content-Type', 'application/octet-stream').set('X-Ms', String(Date.now() - t0)).send(pack(m));
    } catch (e) { next(e); }
  });

  return r;
}
