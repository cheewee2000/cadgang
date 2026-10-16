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
import path from 'node:path';
import express from 'express';
import { importCadFile } from '../core/step.js';

const DESKTOP = process.env.CADGANG_DESKTOP === '1';
export const CAD_EXT = /\.(step|stp|iges|igs|brep)$/i;

async function localFile(req) {
  if (!DESKTOP) throw Object.assign(new Error('Reading local paths is only available in the desktop app'), { status: 403 });
  const p = String(req.query.path || '');
  if (!path.isAbsolute(p)) throw Object.assign(new Error('path must be absolute'), { status: 400 });
  return { name: path.basename(p), buffer: await fs.readFile(p) };
}

/** Pack a tessellation as [u32 nPos, u32 nIdx, u32 nFaces][f32 pos][u32 idx][u32 first,count ...]. */
function pack(m) {
  const pos = Float32Array.from(m.positions), idx = Uint32Array.from(m.indices);
  const faces = new Uint32Array(m.faces.length * 2);
  m.faces.forEach((f, i) => { faces[2 * i] = f.first; faces[2 * i + 1] = f.count; });
  const head = Uint32Array.of(pos.length, idx.length, m.faces.length);
  return Buffer.concat([head, pos, idx, faces].map((a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength)));
}

export function viewRouter() {
  const r = express.Router();

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
