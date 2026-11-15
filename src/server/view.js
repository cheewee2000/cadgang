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
import { execFile } from 'node:child_process';
import { importCadFileInWorker as importCadFile } from '../core/step.js';
import { deployShare } from './vercel.js';

// Imports kept on disk (see /tessellate): reopening a file, or the app restoring its windows, reads the import made
// last time. The stamp changes whenever the importer or this file does, so an old import is never served by new code.
// It is of what the files say, not their dates: a build gives the importer a new date, and every update emptied the cache.
// ponytail: the newest 200 by time, pruned when the server starts; a byte budget if huge assemblies fill the disk.
const IMPORT_DIR = process.env.CADGANG_DISK_CACHE === '0' ? null : path.join(os.homedir(), 'Library', 'Caches', 'cadgang', 'imports');
const IMPORT_STAMP = [process.env.CADGANG_WASM ?? '', ...['../../bin/cadgang-occt', '../core/step.js', './view.js'].map((f) => { try { return crypto.createHash('sha1').update(fsSync.readFileSync(new URL(f, import.meta.url))).digest('hex'); } catch { return '-'; } })].join('|');
const importing = new Map();   // key → the import under way: asked for twice (a reload, the same file in two windows), read once
if (IMPORT_DIR) try {
  const old = fsSync.readdirSync(IMPORT_DIR).map((f) => ({ f, t: fsSync.statSync(path.join(IMPORT_DIR, f)).mtimeMs })).sort((a, b) => b.t - a.t).slice(200);
  for (const { f } of old) fsSync.rmSync(path.join(IMPORT_DIR, f), { force: true });
} catch { /* no folder yet */ }

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
  // Import already returns these exact element types. Reuse them instead of
  // copying the complete model immediately before packing it for the browser.
  const pos = m.positions instanceof Float32Array ? m.positions : Float32Array.from(m.positions);
  const idx = m.indices instanceof Uint32Array ? m.indices : Uint32Array.from(m.indices);
  const nrm = m.normals?.length === m.positions.length
    ? (m.normals instanceof Float32Array ? m.normals : Float32Array.from(m.normals))
    : new Float32Array();
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
 *   GET/PUT /api/view/joints?subject=…  the joints of one file (+ the bodies the page reports, + its saved states)
 *   PUT     /api/view/project?path=/abs/x.cadgang  desktop only: write a saved project
 *   GET     /api/view/screen?fresh=1    latest snapshot (+its markups); fresh=1 asks open pages to post
 *                                       a new one first and waits up to ?wait= seconds (default 3)
 *   GET     /api/view/screen.png        the image alone
 *   POST    /api/view/open {paths}      tell every open page to open these files (the MCP tool)
 *   GET|PUT /api/view/parts?subject=    per-file explode axes and maxima, by body name
 *   POST    /api/view/ask {what, args, subject}  ask the page showing `subject` to compute something (a joint
 *                                       sweep) and wait up to ?wait= seconds (default 20) for its answer
 *   POST    /api/view/answer {id, ...}  the page's answer
 */
const VERCEL_TOKEN_FILE = path.join(os.homedir(), '.cadgang', 'vercel_token');
const vercelToken = () => { try { return fsSync.readFileSync(VERCEL_TOKEN_FILE, 'utf8').trim(); } catch { return ''; } };

/** The ONE page that renders and saves a drawing: every page that got the message wrote a sheet next to its
 *  own file, in whatever project it was showing. In order: the page showing the file the spec names (`source`,
 *  a path or a file name), else among the pages showing a file in the asking session's folder (`dir`; all open
 *  pages when none is) the active one, else the one that opened its file last. null when no page has a file. */
export function pickDrawingPage(pages, active, { dir, source } = {}) {
  const files = (c) => String(c.subject || '').split('|').filter(Boolean);
  const open = pages.filter((c) => files(c).length);
  const newest = (list) => [...list].sort((a, b) => (b.subjectAt || 0) - (a.subjectAt || 0))[0] ?? null;
  const under = (c) => !!dir && files(c).some((f) => (f + '/').startsWith(String(dir).replace(/\/+$/, '') + '/'));
  if (source) {
    const named = open.filter((c) => files(c).some((f) => f === source || path.basename(f) === path.basename(String(source))));
    if (named.length) return newest(named.some(under) ? named.filter(under) : named);
  }
  const mine = open.filter(under), pool = mine.length ? mine : open;
  return pool.includes(active) ? active : newest(pool);
}

export function viewRouter({ dataDir, broadcast = () => {}, pointed = async () => null } = {}) {
  const watch = fileWatcher(broadcast);
  const local = async (req) => { const f = await localFile(req); watch(f.path); return f; };
  const r = express.Router();
  // Which Claude session last used cadgang's tools, by its folder (the MCP server sends it on every
  // call): ASK CLAUDE's fallback target when no session works in the viewed file's folder.
  const lastUse = new Map();
  r.use((req, _res, next) => { const cwd = req.get('x-cadgang-project'); if (cwd) lastUse.set(cwd, Date.now()); next(); });
  const slug = (subject) => crypto.createHash('sha1').update(String(subject)).digest('hex').slice(0, 16);
  const markupPath = (subject) => path.join(dataDir, 'markups', `${slug(subject)}.json`);
  const sharePath = (id) => path.join(dataDir, 'shares', `${id}.bin`);
  const readMarkup = (subject) => { if (!subject) return []; try { return JSON.parse(fsSync.readFileSync(markupPath(subject), 'utf8')); } catch { return []; } };
  let latest = null;      // { png: Buffer, camera, subject, at }
  const shots = new Map();   // subject → its newest snapshot: each Claude session gets the tab showing its own project
  let waiters = [];
  const subjectOf = (req) => String(req.query.subject || req.body?.subject || latest?.subject || '');

  r.get('/markup', (req, res) => { const subject = subjectOf(req); res.json({ subject, markups: readMarkup(subject) }); });
  // OPEN MARKUPS, for the cadgang-notes Claude Code mod: it asks every few seconds and hands new ones to its
  // session, so nobody types "check notes". ?dir= is the asking session's folder. It gets the files inside it
  // (the home folder holds everything, so it does not count) and, when it is the session that last used cadgang's
  // tools, the files no other session's folder holds: ASK CLAUDE's own rule (order(), below), so the two agree.
  // Only files seen since the server started: one a window showed, or one whose markups were written.
  // ?since=<rev>&wait=<s> holds the answer until a markup is written (rev is in every answer), so the mod hears of
  // a note as it lands and not at its next look. ?brief=1 adds each file's brief: what Claude needs to act at once.
  const marked = new Set();
  let rev = Date.now(); const waiting = new Set();
  const wrote = (subject, markups) => { marked.add(subject); rev++; for (const go of [...waiting]) go(); broadcast({ type: 'markup_changed', subject, count: markups.length }); };
  // Handed to Claude (the brief went out): the file's open marks are working, drawn orange until they are done.
  // ponytail: nothing takes it back if that session dies first; the mark stays orange and open, and the next session is handed it again.
  const began = (subject) => {
    const markups = readMarkup(subject);
    if (!markups.some((m) => !m.done && !m.working)) return;
    const next = markups.map((m) => (m.done || m.working ? m : { ...m, working: true }));
    fsSync.writeFileSync(markupPath(subject), JSON.stringify(next)); wrote(subject, next);
  };
  r.get('/markup/open', async (req, res) => {
    if (req.query.wait && Number(req.query.since) === rev) await new Promise((done) => {
      const go = () => { clearTimeout(timer); waiting.delete(go); done(); };
      const timer = setTimeout(go, Math.min(Number(req.query.wait) || 0, 25) * 1000);
      waiting.add(go); res.once('close', go);
    });
    const dir = String(req.query.dir || ''), home = os.homedir();
    const held = (s, d) => !!d && d !== home && s.split('|').some((f) => inside(f, d));
    const newest = [...lastUse.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    const files = [...new Set([...shots.keys(), ...marked, latest?.subject])].filter(Boolean)
      .filter((s) => held(s, dir) || (!!dir && dir === newest && ![...claude.values()].some((v) => held(s, v.cwd))))
      .map((subject) => { const open = readMarkup(subject).filter((m) => !m.done), noted = open.filter((m) => m.text); return { subject, ids: open.map((m) => m.id), noted: noted.map((m) => m.id) }; })   // noted: the ones that carry text
      .filter((f) => f.ids.length);
    if (req.query.brief === '1') for (const f of files) { f.brief = await brief(f.subject, readMarkup(f.subject).filter((m) => !m.done)); began(f.subject); }
    res.json({ rev, files });
  });
  // THE BRIEF: a file's open markups as Claude reads them, with the note. On a live cell document each note comes
  // with the edges it points at and the code of the cell that makes that body (the kernel's /pointed), so the
  // first thing Claude does is the edit: finding those took it three calls, and each call is a model turn.
  // ponytail: the mod can only send the brief as the prompt itself, in the person's sight (a mod's own prompt takes no
  // hidden context), so a cell's code rides along only when short. Raise CODE_MAX if a mod's prompt ever can carry it.
  const LIVE = /\/cadgang\/cells\.json$/, CODE_MAX = 4000;
  const n3 = (v) => `[${v.map((x) => +Number(x).toFixed(2)).join(', ')}]`;
  const edgeLine = (e) => `${e.kind === 'LINE' ? `a straight edge along ${n3(e.direction)}, ${e.length} mm, ${n3(e.start)} to ${n3(e.end)}` : `${e.kind === 'CIRCLE' ? `a circular edge, radius ${e.radius}` : `a ${e.kind.toLowerCase()} edge`}, ${e.length} mm long, centred ${n3(e.center)}`} (${e.away} mm from the point)`;
  async function brief(subject, open) {
    const live = subject.split('|').find((f) => LIVE.test(f)), shown = new Set(), lines = [];
    for (const m of open) {
      const p = m.points?.[m.points.length - 1];   // an arrow's head, a note's anchor
      let line = `Note ${m.id}${m.text ? `: "${m.text}"` : ` (a ${m.kind} mark, no text)`}`;
      if (p && m.kind !== 'pen' && m.kind !== 'path') line += `, ${m.kind === 'arrow' ? 'an arrow pointing at' : 'at'} ${n3(p)} mm`;
      if (m.body) line += ` on body "${m.body.replace(/#\d+$/, '')}"`;
      if (m.normal) line += `, on a face whose normal is ${n3(m.normal)}`;
      const hit = live && p && m.text ? await Promise.race([pointed(live, m.body, p), new Promise((r) => setTimeout(r, 2500))]).catch(() => null) : null;   // a kernel deep in a build: the note goes without
      if (hit?.edges?.length) line += `.\n  The edges of that body nearest the point (world mm): ${hit.edges.map(edgeLine).join('; ')}. In cell code the first of them is q.edges(s).near(${n3(hit.edges[0].center)}, 0.1), s being the shape it is on`;
      const cells = hit?.cells ?? [];
      if (cells.length === 1 && shown.has(cells[0].id)) line += `.\n  Cell '${cells[0].id}' (above) makes that body`;
      else if (cells.length === 1 && cells[0].code.length <= CODE_MAX) { shown.add(cells[0].id); line += `.\n  Cell '${cells[0].id}' makes that body. Its code now:\n\`\`\`js\n${cells[0].code}\n\`\`\``; }
      else if (cells.length) line += `.\n  ${cells.length === 1 ? `Cell '${cells[0].id}' makes that body` : `One of these cells makes that body: ${cells.map((c) => c.id).join(', ')}`}`;
      lines.push(line.endsWith('```') ? line : line + '.');
    }
    const ids = JSON.stringify(open.filter((m) => m.text).map((m) => m.id));
    return live
      ? `CADgang notes on the live cell document of ${path.dirname(path.dirname(live))}, to be made now (the window is being watched):\n\n${lines.join('\n')}\n\nMake each change with ONE cadgang_cells_update call on that cell: edits [{old, new}] for the code, and done ${ids} (the ids of the notes that call answers), which marks them done once it evaluates. Do not call cadgang_screen or cadgang_cells_topology first, do not export, and do not look the cell language up: what a note points at is above, and the window redraws by itself. A cell is export default ({ p, brep, q }) => shape, with brep.fillet(s, edges, radius) and brep.chamfer(s, edges, distance) taking a q.edges(s) query on the shape s they change (a selector above holds where the body is not moved after that step). A cell's code that is not above: edit it from this conversation if you wrote or read it here (an edit that no longer matches changes nothing and answers with the code as it stands), otherwise read that one cell with cadgang_cells_get {id}. Look further only if the evaluation reports an error. Then say what changed in one line.`
      : `CADgang notes on ${subject}:\n\n${lines.join('\n')}\n\nMake each change in the model's source, re-export, check it in CADgang (cadgang_screen shows the picture with every markup drawn on), and mark the ones you did with cadgang_markup_done.`;
  }
  // Mark notes done by id, whichever file they are on: cadgang_cells_update's 'done', so the edit and the mark are one call.
  r.post('/markup/done', express.json(), (req, res) => {
    const want = new Set(Array.isArray(req.body?.ids) ? req.body.ids.map(String) : []), at = new Date().toISOString(), done = [];
    for (const subject of new Set([...shots.keys(), ...marked, latest?.subject].filter(Boolean))) {
      const markups = readMarkup(subject);
      if (!markups.some((m) => want.has(m.id) && !m.done)) continue;
      const next = markups.map((m) => (want.has(m.id) && !m.done ? (done.push(m.id), { ...m, done: true, doneAt: at }) : m));
      fsSync.writeFileSync(markupPath(subject), JSON.stringify(next));
      wrote(subject, next);
    }
    res.json({ done, unknown: [...want].filter((id) => !done.includes(id)) });
  });
  r.put('/markup', (req, res, next) => {
    try {
      const subject = subjectOf(req);
      if (!subject) throw Object.assign(new Error('No file is open to attach markups to'), { status: 400 });
      const markups = Array.isArray(req.body?.markups) ? req.body.markups : [];
      fsSync.mkdirSync(path.dirname(markupPath(subject)), { recursive: true });
      fsSync.writeFileSync(markupPath(subject), JSON.stringify(markups));
      wrote(subject, markups);
      res.json({ subject, markups });
    } catch (e) { next(e); }
  });

  // Joints of one file, and the bodies they can be made on (the page posts those: name key, box, cylinders).
  // Claude reads both and writes joints; the page loads what changed unless it made the change itself (`from`).
  const jointsPath = (subject) => path.join(dataDir, 'joints', `${slug(subject)}.json`);
  const readJoints = (subject) => { try { const d = JSON.parse(fsSync.readFileSync(jointsPath(subject), 'utf8')); return { joints: d.joints ?? [], bodies: d.bodies ?? [], states: d.states ?? [] }; } catch { return { joints: [], bodies: [], states: [] }; } };
  r.get('/joints', (req, res) => { const subject = subjectOf(req); res.json({ subject, ...readJoints(subject) }); });
  r.put('/joints', (req, res, next) => {
    try {
      const subject = subjectOf(req);
      if (!subject) throw Object.assign(new Error('No file is open to attach joints to'), { status: 400 });
      const cur = readJoints(subject), has = Array.isArray(req.body?.joints);
      const next_ = { joints: has ? req.body.joints : cur.joints, bodies: Array.isArray(req.body?.bodies) ? req.body.bodies : cur.bodies, states: Array.isArray(req.body?.states) ? req.body.states : cur.states };
      fsSync.mkdirSync(path.dirname(jointsPath(subject)), { recursive: true });
      fsSync.writeFileSync(jointsPath(subject), JSON.stringify(next_));
      if (has) broadcast({ type: 'joints_changed', subject, from: String(req.body.from || '') });
      res.json({ subject, ...next_ });
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
      broadcast({ type: 'parts_changed', subject, from: String(req.body?.from || '') });   // other windows on this file pick up renames
      res.json({ subject, parts });
    } catch (e) { next(e); }
  });

  // An error in the page (view.html sends it): into the server's log, where the app keeps it. ponytail: 500 a run, so a page stuck in a loop cannot fill the disk.
  let pageErrors = 0;
  r.post('/pagelog', express.text({ type: () => true, limit: '8kb' }), (req, res) => {
    if (pageErrors++ < 500) console.error(new Date().toISOString(), 'page error:', String(req.body).slice(0, 4000));
    res.status(204).end();
  });

  // CAPTURE: the page's clean picture, written straight to the Desktop with no dialog. A name already there gets -2, -3…
  r.post('/capture', express.raw({ type: 'image/png', limit: '200mb' }), async (req, res, next) => {
    try {
      const png = req.body;
      if (!Buffer.isBuffer(png) || png.subarray(0, 8).toString('latin1') !== '\x89PNG\r\n\x1a\n') throw Object.assign(new Error('Send the picture as the raw image/png body'), { status: 400 });
      const base = path.basename(String(req.query.name || '')).replace(/\.png$/i, '').replace(/[^\w.-]+/g, '_').replace(/^\.+/, '') || 'cadgang';
      const dir = process.env.CADGANG_CAPTURE_DIR || path.join(os.homedir(), 'Desktop');   // the env is for tests
      for (let n = 1; ; n++) {
        const file = path.join(dir, `${base}${n > 1 ? `-${n}` : ''}.png`);
        try { await fs.writeFile(file, png, { flag: 'wx' }); return res.json({ path: file, name: path.basename(file) }); } catch (e) { if (e.code !== 'EEXIST' || n > 99) throw e; }
      }
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
  const PROMPT = "I sent you my view from CADgang: call cadgang_feedback to see it and my markups, make each open markup's change in the model's source, re-export, check it in CADgang, and mark the ones you did with cadgang_markup_done.";
  // Which session gets it, so the prompt never lands in an unrelated chat: the one working in the
  // folder that holds the viewed file (deepest wins; the home folder holds everything, so it does
  // not count), else the one that last used cadgang's tools. Neither: nobody, and the page puts the
  // prompt on the clipboard instead. (Before v0.14.63 it fell back to the newest session of all,
  // which typed into whatever chat was opened last.) Only a tab where Claude is running takes it:
  // typed into an idle shell, the prompt would run as a command.
  const inside = (file, dir) => !!dir && (file + '/').startsWith(dir.replace(/\/+$/, '') + '/');
  function order(subject) {
    const files = String(subject || '').split('|').filter((f) => f.startsWith('/'));
    const depth = (v) => (v.cwd && v.cwd !== os.homedir() && files.some((f) => inside(f, v.cwd)) ? v.cwd.length : -1);
    const used = (v) => lastUse.get(v.cwd) ?? 0;
    return [...claude.entries()].filter(([, v]) => depth(v) >= 0 || used(v) > 0)
      .sort(([, a], [, b]) => depth(b) - depth(a) || used(b) - used(a)).map(([tab]) => tab);
  }
  async function sendToClaude(subject) {
    for (const tab of order(subject)) {
      const status = ((await knife(`tab status ${tab}`)) || '').trim();
      if (!status || status === 'gone') { claude.delete(tab); saveClaude(); continue; }
      if (status !== 'working' && status !== 'attention') continue;   // no Claude running in it
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
  // A question only the page can answer (it holds the meshes): the first page with the file answers.
  const asks = new Map();   // id → resolve
  r.post('/ask', async (req, res) => {
    const id = crypto.randomUUID(), wait = Math.min(120, Math.max(1, parseFloat(req.query.wait || '20')));
    const answer = await new Promise((done) => {
      const t = setTimeout(() => { asks.delete(id); done(null); }, wait * 1000);
      asks.set(id, (v) => { clearTimeout(t); asks.delete(id); done(v); });
      broadcast({ type: 'ask', id, what: String(req.body?.what || ''), args: req.body?.args ?? {}, subject: subjectOf(req) });
    });
    if (!answer) return res.status(504).json({ error: 'No CADgang window with this file answered: is it open?' });
    if (answer.error) return res.status(400).json({ error: answer.error });
    res.json(answer.result);
  });
  r.post('/answer', (req, res) => { asks.get(String(req.body?.id))?.(req.body); res.json({ ok: true }); });

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
    broadcast({ type: 'drawing', spec, dir: req.get('x-cadgang-project') || null });
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

  // Save project: the page's bundle (same layout as a shared link) written to a .cadgang file chosen
  // by the shell's Save panel. Local paths only, like reading them; written beside the target and
  // renamed in, so a crash mid-save never leaves a half project over a good one.
  r.put('/project', express.raw({ type: () => true, limit: '2gb' }), async (req, res, next) => {
    try {
      if (!mayReadLocal(req)) throw Object.assign(new Error('Saving to a path is only available in the desktop app, or from this computer'), { status: 403 });
      const p = String(req.query.path || '');
      if (!path.isAbsolute(p) || !/\.cadgang$/i.test(p)) throw Object.assign(new Error('path must be an absolute .cadgang path'), { status: 400 });
      if (!Buffer.isBuffer(req.body) || req.body.length < 4) throw Object.assign(new Error('empty project'), { status: 400 });
      const tmp = `${p}.${process.pid}.part`;
      await fs.writeFile(tmp, req.body);
      await fs.rename(tmp, p);
      res.json({ path: p, bytes: req.body.length });
    } catch (e) { next(e); }
  });

  // Send to Bambu Studio: the page PUTs one STL per part into a batch folder under the temp dir, then
  // asks for the batch to open, all at once, in the slicer. Local only, like saving.
  const slicerDir = (batch) => path.join(os.tmpdir(), 'cadgang-slicer', batch);
  r.put('/slicer', express.raw({ type: () => true, limit: '1gb' }), async (req, res, next) => {
    try {
      if (!mayReadLocal(req)) throw Object.assign(new Error('Sending to the slicer is only available in the desktop app'), { status: 403 });
      const batch = String(req.query.batch || ''), name = String(req.query.name || '').replace(/[^\w .-]/g, '_');
      if (!/^\w{8,32}$/.test(batch) || !/\.stl$/i.test(name)) throw Object.assign(new Error('need batch and a .stl name'), { status: 400 });
      await fs.mkdir(slicerDir(batch), { recursive: true });
      await fs.writeFile(path.join(slicerDir(batch), name), req.body);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });
  r.post('/slicer/open', express.json(), async (req, res, next) => {
    try {
      if (!mayReadLocal(req)) throw Object.assign(new Error('Sending to the slicer is only available in the desktop app'), { status: 403 });
      const batch = String(req.body?.batch || '');
      if (!/^\w{8,32}$/.test(batch)) throw Object.assign(new Error('need batch'), { status: 400 });
      const files = (await fs.readdir(slicerDir(batch))).map((f) => path.join(slicerDir(batch), f));
      await new Promise((ok, fail) => execFile('open', ['-a', 'BambuStudio', ...files], (e) => (e ? fail(Object.assign(new Error('Bambu Studio did not open — is it installed?'), { status: 500 })) : ok())));
      res.json({ files: files.length });
    } catch (e) { next(e); }
  });

  // Share to web: the page's bundle deployed to the user's own Vercel account (vercel.js), with the
  // token they pasted once (~/.cadgang/vercel_token, 0600; the page never reads it back).
  r.get('/share/vercel', (req, res) => res.json({ token: !!vercelToken() }));
  r.put('/share/vercel', express.json(), async (req, res, next) => {
    try {
      if (!mayReadLocal(req)) throw Object.assign(new Error('Sharing starts from the Mac app'), { status: 403 });
      const token = String(req.body?.token || '').trim();
      if (token) {
        const me = await fetch('https://api.vercel.com/v2/user', { headers: { Authorization: `Bearer ${token}` } });
        if (!me.ok) throw Object.assign(new Error('Vercel did not accept that token'), { status: 400 });
      }
      await fs.mkdir(path.dirname(VERCEL_TOKEN_FILE), { recursive: true });
      await (token ? fs.writeFile(VERCEL_TOKEN_FILE, token, { mode: 0o600 }) : fs.rm(VERCEL_TOKEN_FILE, { force: true }));
      res.json({ token: !!token });
    } catch (e) { next(e); }
  });
  r.post('/share', express.raw({ type: () => true, limit: '1gb' }), async (req, res, next) => {
    try {
      if (!mayReadLocal(req)) throw Object.assign(new Error('Sharing starts from the Mac app'), { status: 403 });
      const token = vercelToken();
      if (!token) throw Object.assign(new Error('Add a Vercel token first'), { status: 428 });
      res.json({ url: await deployShare(req.body, token) });
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
      const deflection = parseFloat(req.query.deflection || '0.0008');
      // The same bytes, read the same way, by the same importer: the import made last time is on disk.
      const key = crypto.createHash('sha1').update(src.buffer).update(`|${path.basename(src.name)}|${deflection}|${IMPORT_STAMP}`).digest('hex');
      const file = IMPORT_DIR && path.join(IMPORT_DIR, key);
      let packed = file && await fs.readFile(file).catch(() => null), timings = { cached: true };
      if (packed) fs.utimes(file, new Date(), new Date()).catch(() => {});   // read again: the last to be pruned
      else if (importing.has(key)) ({ packed, timings } = await importing.get(key).then((r) => ({ ...r, timings: { ...r.timings, shared: true } })));
      else {
        const job = importCadFile(src.buffer, { name: src.name, linearDeflection: deflection }).then((m) => ({ packed: pack(m), timings: m.timings ?? {} })).finally(() => importing.delete(key));
        importing.set(key, job);
        ({ packed, timings } = await job);
        if (file) fs.mkdir(IMPORT_DIR, { recursive: true }).then(() => fs.writeFile(`${file}.tmp`, packed)).then(() => fs.rename(`${file}.tmp`, file)).catch(() => {});   // a cache: never half a file under the real name
      }
      res.set('Content-Type', 'application/octet-stream')
        .set('X-Ms', String(Date.now() - t0))
        .set('X-Cadgang-Timings', JSON.stringify(timings))
        .send(packed);
    } catch (e) { next(e); }
  });

  return r;
}
