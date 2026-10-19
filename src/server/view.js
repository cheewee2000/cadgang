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
import net from 'node:net';
import os from 'node:os';
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
  // each body: its name, or {name, path, color, material, opacity} when the file says more (the viewer takes both)
  const names = Buffer.from(JSON.stringify(bodyList.map((b) => (b.path || b.color || b.material ? { name: b.name, path: b.path ?? [], color: b.color ?? null, ...(b.material && { material: b.material }), ...(b.opacity < 1 && { opacity: b.opacity }) } : b.name))), 'utf8');
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
 *   GET|PUT /api/view/parts?subject=    per-file explode axes and maxima, by body name
 */
/** The one file in a multipart/form-data body (what Share to web sends; ponytail: one part, no streaming). */
function multipartFile(buf, ctype) {
  const b = Buffer.from('--' + /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(ctype).slice(1).find(Boolean));
  const start = buf.indexOf('\r\n\r\n', buf.indexOf(b)) + 4;
  return buf.subarray(start, buf.indexOf(Buffer.concat([Buffer.from('\r\n'), b]), start));
}
const SHARE_HOST = process.env.CADGANG_SHARE_HOST || 'https://www.experiments.cwandt.com/cadgang';
const SHARE_KEY_FILE = path.join(os.homedir(), '.cadgang', 'share_key');
const shareKey = () => { try { return fsSync.readFileSync(SHARE_KEY_FILE, 'utf8').trim(); } catch { return process.env.CADGANG_SHARE_KEY || ''; } };

export function viewRouter({ dataDir, broadcast = () => {} } = {}) {
  const watch = fileWatcher(broadcast);
  const local = async (req) => { const f = await localFile(req); watch(f.path); return f; };
  const r = express.Router();
  const slug = (subject) => crypto.createHash('sha1').update(String(subject)).digest('hex').slice(0, 16);
  const markupPath = (subject) => path.join(dataDir, 'markups', `${slug(subject)}.json`);
  const sharePath = (id) => path.join(dataDir, 'shares', `${id}.bin`);
  const readMarkup = (subject) => { if (!subject) return []; try { return JSON.parse(fsSync.readFileSync(markupPath(subject), 'utf8')); } catch { return []; } };
  let latest = null;      // { png: Buffer, camera, subject, at }
  const shots = new Map();   // subject → its newest snapshot: each Claude session gets the tab showing its own project
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

  // Per-file explode settings the user made (axis picked off a face, maximum travel set by a drag),
  // keyed `${body name}#${n}` so a re-exported file gets them back without redoing them.
  const partsPath = (subject) => path.join(dataDir, 'explode', `${slug(subject)}.json`);
  r.get('/parts', (req, res) => { const subject = subjectOf(req); let parts = {}; try { parts = JSON.parse(fsSync.readFileSync(partsPath(subject), 'utf8')); } catch {} res.json({ subject, parts }); });
  r.put('/parts', (req, res, next) => {
    try {
      const subject = subjectOf(req);
      if (!subject) throw Object.assign(new Error('No file is open'), { status: 400 });
      const parts = req.body?.parts && typeof req.body.parts === 'object' ? req.body.parts : {};
      fsSync.mkdirSync(path.dirname(partsPath(subject)), { recursive: true });
      fsSync.writeFileSync(partsPath(subject), JSON.stringify(parts));
      res.json({ subject, parts });
    } catch (e) { next(e); }
  });

  r.post('/snapshot', express.json({ limit: '40mb' }), (req, res, next) => {
    try {
      const m = /^data:image\/png;base64,(.+)$/.exec(String(req.body?.png || ''));
      if (!m) throw Object.assign(new Error('png must be a data:image/png;base64 URL'), { status: 400 });
      const was = latest?.subject;
      latest = { png: Buffer.from(m[1], 'base64'), camera: req.body.camera ?? null, subject: req.body.subject ?? null, at: new Date().toISOString() };
      if (latest.subject !== was) broadcast({ type: 'subject', subject: latest.subject });   // a ?follow page opens it too
      shots.set(latest.subject, latest);
      try { fsSync.mkdirSync(dataDir, { recursive: true }); fsSync.writeFileSync(path.join(dataDir, 'screen.png'), latest.png); } catch {}
      const w = waiters; waiters = [];
      for (const fn of w) fn();
      res.json({ ok: true, at: latest.at, bytes: latest.png.length });
    } catch (e) { next(e); }
  });

  // SEND TO CLAUDE: frames the user wants Claude to look at, until the cadgang_feedback tool takes them.
  let feedback = [];
  // Claude Code sessions that run the cadgang MCP server say which Knife Terminal tab they live in
  // (KNIFE_TAB). The button then types the review prompt into the newest live one, which is the one
  // thing that makes Claude act without the user typing. Other terminals: the prompt lands on the clipboard.
  // The list outlives a server restart (the Mac app restarts it on every update; before v0.14.13 that
  // forgot every session and the button fell back to the clipboard until a session reconnected).
  const CLAUDE_FILE = path.join(dataDir, 'claude-tabs.json');
  const claude = new Map();   // tab → { cwd, at }
  try { for (const [tab, v] of Object.entries(JSON.parse(fsSync.readFileSync(CLAUDE_FILE, 'utf8')))) claude.set(tab, v); } catch {}
  const saveClaude = () => { try { fsSync.mkdirSync(dataDir, { recursive: true }); fsSync.writeFileSync(CLAUDE_FILE, JSON.stringify(Object.fromEntries(claude))); } catch {} };
  const KNIFE = path.join(os.homedir(), '.knife-terminal.sock');
  const knife = (msg) => new Promise((resolve) => {
    if (!fsSync.existsSync(KNIFE)) return resolve(null);
    let out = ''; const s = net.createConnection(KNIFE);
    const done = (x) => { clearTimeout(t); s.destroy(); resolve(x); };
    const t = setTimeout(() => done(out || null), 1500);
    s.on('connect', () => s.end(msg)); s.on('data', (d) => { out += d; }); s.on('end', () => done(out)); s.on('error', () => done(null));
  });
  r.post('/claude', express.json(), (req, res) => {
    const tab = String(req.body?.tab ?? '').trim();
    // `at` = when the session first registered; the 30 s heartbeat must not make every session "newest"
    if (tab) { claude.set(tab, { cwd: req.body.cwd ?? null, at: claude.get(tab)?.cwd === (req.body.cwd ?? null) ? claude.get(tab).at : new Date().toISOString() }); saveClaude(); }
    res.json({ ok: true, tab: tab || null, sessions: [...claude.keys()] });
  });
  const PROMPT = 'Review the view I just sent from CADgang: call cadgang_feedback and give me feedback on what you see, anchored to my markups.';
  // Which session gets it: the one working in the folder that holds the viewed file (deepest folder
  // wins), then the most recently started. (v0.14.16: before, always the newest registration — and
  // only sessions started in the cadgang repo registered, so every press went to the cadgang session.)
  const inside = (file, dir) => !!dir && (file + '/').startsWith(dir.replace(/\/+$/, '') + '/');
  function order(subject) {
    const files = String(subject || '').split('|').filter((f) => f.startsWith('/'));
    const depth = (v) => (files.some((f) => inside(f, v.cwd)) ? v.cwd.length : -1);
    return [...claude.entries()].sort(([, a], [, b]) => depth(b) - depth(a) || String(b.at).localeCompare(String(a.at))).map(([tab]) => tab);
  }
  async function sendToClaude(subject) {
    for (const tab of order(subject)) {
      const status = ((await knife(`tab status ${tab}`)) || '').trim();
      if (!status || status === 'gone') { claude.delete(tab); saveClaude(); continue; }
      const reply = ((await knife(`tab type ${tab} ${PROMPT}`)) || '').trim();
      if (reply === 'ok') return { tab, status };
    }
    return null;
  }
  r.post('/feedback', express.json({ limit: '40mb' }), async (req, res, next) => {
    try {
      const m = /^data:image\/png;base64,(.+)$/.exec(String(req.body?.png || ''));
      if (!m) throw Object.assign(new Error('png must be a data:image/png;base64 URL'), { status: 400 });
      feedback.push({ png: m[1], camera: req.body.camera ?? null, subject: req.body.subject ?? null, markups: Array.isArray(req.body.markups) ? req.body.markups : [], at: new Date().toISOString() });
      feedback = feedback.slice(-5);
      const delivered = req.body.deliver === false ? null : await sendToClaude(req.body.subject);
      res.json({ ok: true, pending: feedback.length, delivered, prompt: PROMPT });
    } catch (e) { next(e); }
  });
  r.get('/feedback', (req, res) => {   // ?keep=1 peeks (the Claude Code hook); a plain GET takes them
    const items = feedback;
    if (req.query.keep !== '1') feedback = [];
    res.json({ pending: req.query.keep === '1' ? items.map(({ png, ...f }) => f) : items });
  });

  // ?dir=: the asking session's folder; the newest frame of a file inside it, else the newest of all.
  const shotFor = (dir) => [...shots.values()].filter((s) => s.subject && dir && inside(s.subject.split('|')[0], dir)).sort((a, b) => b.at.localeCompare(a.at))[0] ?? latest;
  const screenJson = (s) => s && { at: s.at, subject: s.subject, camera: s.camera, png: s.png.toString('base64') };
  r.get('/screen', async (req, res) => {
    const dir = req.query.dir ? String(req.query.dir) : null;
    if (req.query.fresh === '1') {
      const wait = Math.min(10, Math.max(0.2, parseFloat(req.query.wait || '3')));
      const before = shotFor(dir)?.at;
      await new Promise((done) => {
        let over = false;
        const t = setTimeout(() => { over = true; done(); }, wait * 1000);
        const check = () => { if (over) return; if (shotFor(dir)?.at !== before) { clearTimeout(t); done(); } else waiters.push(check); };
        waiters.push(check);
        broadcast({ type: 'snapshot_request', dir });
      });
      const s = shotFor(dir);
      return res.json({ screen: screenJson(s), fresh: !!s && s.at !== before, markups: readMarkup(s?.subject), pendingFeedback: feedback.length });
    }
    const s = shotFor(dir);
    res.json({ screen: screenJson(s), fresh: false, markups: readMarkup(s?.subject), pendingFeedback: feedback.length });
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

  // Share to web: a frozen copy of the view (the page's bundle: u32 header length, header JSON, then
  // each file's bytes) stored on the VPS under an unguessable id; anyone with the link opens it in a
  // browser and gets the whole viewer, starting from the shared view. The Mac app's server forwards
  // the bundle with the share key (~/.cadgang/share_key on both machines); the page never sees it.
  r.post('/share', express.raw({ type: () => true, limit: '1gb' }), async (req, res, next) => {
    try {
      if (!mayReadLocal(req)) throw Object.assign(new Error('Sharing starts from the Mac app'), { status: 403 });
      const key = shareKey();
      if (!key) throw Object.assign(new Error(`No share key: put it in ${SHARE_KEY_FILE}`), { status: 500 });
      // DreamHost's ModSecurity refuses plain bodies over 2.5 MB (and flags small binary ones as attacks),
      // and its proxy drops multipart ones over ~5 MB: the bundle goes up as 1 MB file parts.
      const CHUNK = 1 << 20, of = Math.max(1, Math.ceil(req.body.length / CHUNK));
      let id = '';
      for (let part = 0; part < of; part++) {
        const form = new FormData();
        form.append('part', new Blob([req.body.subarray(part * CHUNK, (part + 1) * CHUNK)], { type: 'application/octet-stream' }), 'part.bin');
        const up = await fetch(`${SHARE_HOST}/api/view/share/store?part=${part}&of=${of}${id ? `&id=${id}` : ''}`, { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form });
        const d = await up.json().catch(() => ({}));
        if (!up.ok) throw Object.assign(new Error(d.error || `share host: HTTP ${up.status} on part ${part + 1} of ${of}`), { status: 502 });
        id = d.id;
      }
      res.json({ id, url: `${SHARE_HOST}/view?share=${id}` });
    } catch (e) { next(e); }
  });
  r.post('/share/store', express.raw({ type: () => true, limit: '8mb' }), async (req, res, next) => {
    try {
      const key = shareKey(), got = String(req.headers.authorization || '').replace(/^Bearer /, '');
      if (!key || got.length !== key.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(key))) throw Object.assign(new Error('Bad share key'), { status: 401 });
      const part = parseInt(req.query.part) || 0, of = parseInt(req.query.of) || 1;
      const chunk = /multipart/i.test(req.headers['content-type'] || '') ? multipartFile(req.body, req.headers['content-type']) : req.body;
      let id = String(req.query.id || '');
      const tmp = () => `${sharePath(id)}.part`;
      if (part === 0) {
        id = crypto.randomBytes(12).toString('base64url');
        await fs.mkdir(path.join(dataDir, 'shares'), { recursive: true });
        await fs.writeFile(tmp(), chunk);
      } else {
        if (!/^[\w-]{16}$/.test(id) || !fsSync.existsSync(tmp())) throw Object.assign(new Error('No such upload'), { status: 404 });
        await fs.appendFile(tmp(), chunk);
      }
      if (part === of - 1) {
        const buf = await fs.readFile(tmp());
        JSON.parse(buf.subarray(4, 4 + buf.readUInt32LE(0)).toString('utf8'));   // a bundle that does not parse is refused
        await fs.rename(tmp(), sharePath(id));
      }
      res.json({ id });
    } catch (e) { next(e); }
  });
  r.get('/share/:id', (req, res) => {
    if (!/^[\w-]{16}$/.test(req.params.id)) return res.status(404).json({ error: 'No such share' });
    res.sendFile(sharePath(req.params.id), { headers: { 'Content-Type': 'application/octet-stream' } }, (e) => e && !res.headersSent && res.status(404).json({ error: 'No such share — the link may be mistyped' }));
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
