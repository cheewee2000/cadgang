import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { GraphError } from '../core/errors.js';
import { exportProduction, PRODUCTION_FORMATS } from '../core/softgoods-production.js';
import { resolveMaterials, FABRICS } from '../core/softgoods-fabrics.js';
import { meshPatternFine } from '../core/softgoods-mesh.js';
import { resolveSeamCorrespondence } from '../core/softgoods-seams.js';
import { arrangeDesign, collisionBody, loadBodies } from '../core/softgoods-bodies.js';
import { drapeDocumentAsync } from '../core/softgoods-drape.js';
import { exportDrape, DRAPE_FORMATS } from '../core/softgoods-drape-export.js';
import { measureDrape, fitReport } from '../core/softgoods-measure.js';
import { checkDesign } from '../core/softgoods-operations.js';
import { validateSoftgoodsDocument } from '../core/softgoods-document.js';
import { closures, listTrims, trimsInput, trimMarks } from '../core/softgoods-trims.js';
import { editSoftgoods, editChanges } from '../core/softgoods-edit.js';
import { conformLines, physicsInput } from '../core/softgoods-physics.js';
import { flattenMesh, describeFaces, mergeFlattened } from '../core/softgoods-flatten.js';
import { importCadFile } from '../core/step.js';
import { CAD_EXT, mayReadLocal } from './view.js';
import { cutContours } from '../core/softgoods-export.js';

/** The viewer's packed mesh (view.js pack) back as {positions, normals, indices, faces, bodies}. */
function unpackMesh(buf) {
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), [np, ni, nf, nb, nn, nr] = new Uint32Array(ab, 0, 6);
  let o = 24; const take = (Type, n) => { const a = new Type(ab, o, n); o += n * 4; return a; };
  const positions = take(Float32Array, np), normals = take(Float32Array, nr), indices = take(Uint32Array, ni), f = take(Uint32Array, nf * 2), b = take(Uint32Array, nb * 2), names = JSON.parse(Buffer.from(ab, o, nn).toString('utf8'));
  return { positions, normals, indices, faces: Array.from({ length: nf }, (_, i) => ({ first: f[2 * i], count: f[2 * i + 1] })), bodies: Array.from({ length: nb }, (_, i) => ({ first: b[2 * i], count: b[2 * i + 1], name: names[i]?.name ?? names[i] })) };
}

/**
 * The model a flattening reads: a CAD file by path, a cell's result, or with neither the CAD file on screen in the
 * viewer and, when there is none, the cell document's output. Both arrive as the mesh the viewer shows (bodies with
 * names, B-rep face ranges), tessellated finer than the viewer needs: a pattern edge is as long as its facets, and
 * these settings keep a round edge within a thousandth of its true length.
 */
async function sourceMesh(req) {
  const { path: given, cell, deflection } = req.body || {}, self = `http://127.0.0.1:${req.socket.localPort}/api`;
  const headers = req.get('x-cadgang-project') ? { 'x-cadgang-project': req.get('x-cadgang-project') } : {};
  let file = given;
  if (!file && !cell) file = String((await fetch(`${self}/view/joints`, { headers }).then((r) => r.json()).catch(() => null))?.subject || '').split('|').find((f) => CAD_EXT.test(f));
  if (file) {
    if (!mayReadLocal(req)) throw new GraphError('Reading a file by path is only available in the desktop app, or from this computer');
    if (!path.isAbsolute(file) || !CAD_EXT.test(file)) throw new GraphError('path must be the absolute path of a STEP, IGES or BREP file');
    const buffer = await fs.promises.readFile(file).catch(() => { throw new GraphError(`Cannot read '${file}'`); });
    return { source: { file }, mesh: await importCadFile(buffer, { name: path.basename(file), linearDeflection: Number(deflection) > 0 ? Number(deflection) : 0.0003, angularDeflection: 0.15 }) };
  }
  const query = new URLSearchParams({ tolerance: String(Number(deflection) > 0 ? Number(deflection) : 0.02) }); if (cell) query.set('cell', cell);
  const r = await fetch(`${self}/cells/live?${query}`, { headers }).catch(() => null);
  if (!r?.ok) throw new GraphError((await r?.json().catch(() => null))?.error || 'There is no model to flatten: pass path (a STEP file) or build one in the cell document');
  return { source: { cell: cell || 'output' }, mesh: unpackMesh(Buffer.from(await r.arrayBuffer())) };
}

// Where every piece starts in 3D. A piece with placement stands at its region of the avatar, or on the body it names; one without keeps the row it was given
// (a piece flattened from a 3D surface arrives with the row it was flattened from), or is laid flat beside the others. A design set again keeps the avatar it had, so re-prompting a pattern does not lose the body.
function arranged(value, avatar) {
  const d = validateSoftgoodsDocument(value), rows = new Map(d.arrangement.map((a) => [a.pattern, a]));
  const result = arrangeDesign(d, avatar); for (const a of result.arrangement) rows.set(a.pattern, a);
  if (avatar) d.simulation = { ...(d.simulation || {}), avatar: result.avatar, status: 'not_run' };
  let x = 0;
  d.arrangement = d.patterns.map((p) => { const xs = p.points.map((q) => q.x), row = rows.get(p.id) || { pattern: p.id, position: [x - Math.min(...xs, 0), 0, 0], rotation: [0, 0, 0], layer: 0 }; if (!rows.has(p.id)) x += (xs.length ? Math.max(...xs) - Math.min(...xs) : 0) + 40; return row; });
  return d;
}

const EXPORT_FORMATS = [...PRODUCTION_FORMATS, ...DRAPE_FORMATS];

// model(): the file the viewer has open ('a.step', or several joined by '|'); live(file): the pack of a project's live cells. A design's bodies may name either.
export function softgoodsRouter(doc, { exportDir = () => process.cwd(), broadcast = () => {}, model = () => null, live = null } = {}) {
  const r = express.Router();
  // A body read from a file is read (once, then kept) before anything is arranged on it, simulated or checked; only this computer may name a path.
  const bodies = (req) => ({ local: mayReadLocal(req), live }), ready = (req, d) => (d.bodies?.length ? loadBodies(d, bodies(req)) : d);
  // source {model: true} is the model open now: the design keeps which file that was. avatar: null takes the avatar away (a bag has no wearer); no word of one keeps the design's.
  const pinned = (body) => { for (const b of Array.isArray(body?.bodies) ? body.bodies : []) if (b?.source?.model === true) { const open = model(); if (!open) throw new GraphError(`Body '${b.id}' names the model open in CADgang, and none is: open the part, or name its file with source.step`); b.source = { ...b.source, model: String(open) }; } return body; };
  const avatarOf = (body) => (body?.simulation && 'avatar' in body.simulation && !body.simulation.avatar ? null : body?.simulation?.avatar || doc.data.simulation?.avatar);
  const fail = (res, e) => res.status(e instanceof GraphError ? 400 : 500).json({ error: e.message || String(e) });
  r.get('/simulation-input', async (req, res) => { try { const d = await ready(req, doc.toJSON()), target = Math.max(5, Math.min(100, Number(req.query.target || 25))), meshes = d.patterns.map((p) => meshPatternFine(p, { target, lines: conformLines(d, p) })), shut = closures(d, meshes, { spacing: target / 2 }), seams = [...resolveSeamCorrespondence(d.seams, meshes, { spacing: target / 2 }), ...shut.seams]; res.json({ revision: d.revision, meshes, seams, attachments: [...(d.attachments || []), ...shut.attachments], arrangement: d.arrangement, materials: resolveMaterials(d.materials), patterns: d.patterns.map((p) => ({ id: p.id, material: p.material, grain: p.grain, shrink: p.shrink, freeze: p.freeze, strengthen: p.strengthen, source: p.source })), ...physicsInput(d, meshes), ...trimsInput(d, { spacing: target / 2 }), collisionBody: d.simulation?.avatar || d.bodies?.length ? collisionBody(d) : null }); } catch (e) { fail(res, e); } });
  r.get('/document', (_req, res) => res.json(doc.toJSON()));
  r.get('/fabrics', (_req, res) => res.json(FABRICS));
  r.put('/document', async (req, res) => { try { const body = pinned(req.body); await ready(req, validateSoftgoodsDocument(body)); res.json(doc.replace(arranged(body, avatarOf(body)))); } catch (e) { fail(res, e); } });
  // One pattern-making operation ({ op, ...args }, see src/core/softgoods-edit.js) on the stored design: a new revision, like a set.
  r.post('/edit', async (req, res) => { try { const before = await ready(req, doc.toJSON()), d = doc.replace(arranged(editSoftgoods(before, req.body || {}), doc.data.simulation?.avatar)); res.json({ revision: d.revision, patterns: d.patterns.map((p) => p.id), ...editChanges(before, d), check: checkDesign(d) }); } catch (e) { fail(res, e); } });
  // ?fit=1 adds the fit report of the draped design. It costs a drape (seconds, on a thread of its own), so only when asked.
  r.get('/check', async (req, res) => { try { const d = await ready(req, doc.toJSON()), check = checkDesign(d); res.json(req.query.fit ? { ...check, fit: fitReport(d, await drapeDocumentAsync(d, { target: req.query.target }, bodies(req))) } : check); } catch (e) { fail(res, e); } });
  // Measure the draped design: body {measures: [{type: distance|circumference|edge|seam|bounds, ...}], drape: {target, steps, tolerance}}.
  r.post('/measure', async (req, res) => { try { const d = doc.toJSON(), drape = await drapeDocumentAsync(d, req.body?.drape, bodies(req)); res.json({ revision: d.revision, drape: { settled: drape.settled, steps: drape.steps, residual: drape.residual, target: drape.options.target }, units: 'mm', results: measureDrape(d, drape, req.body?.measures || []) }); } catch (e) { fail(res, e); } });
  // The cut line of every pattern, as the DXF carries it, for the page's 2D drawing. A pattern whose allowance cannot be offset has none.
  r.get('/cut', (_req, res) => { const out = {}; for (const p of doc.toJSON().patterns) { try { out[p.id] = cutContours(p); } catch { out[p.id] = []; } } res.json(out); });
  // Each pattern's trim marks as the tech pack draws them (lines by layer TRIM, TOPSTITCH, DRILL; drills), one entry per trim so the page can pick one out.
  r.get('/trim-marks', (_req, res) => { const d = doc.toJSON(), out = {}; for (const p of d.patterns) out[p.id] = (d.trims || []).flatMap((t) => { try { const m = trimMarks({ ...d, trims: [t] }, p.id); return m ? [{ trim: t.id, kind: t.kind, ...m }] : []; } catch { return []; } }); res.json(out); });
  r.post('/patterns/rectangle', (req, res) => { try { res.json(doc.addRectangle(req.body || {})); } catch (e) { fail(res, e); } });
  r.patch('/patterns/:pattern/points/:point', (req, res) => { try { res.json(doc.updatePoint(req.params.pattern, req.params.point, req.body?.x, req.body?.y)); } catch (e) { fail(res, e); } });
  r.post('/seams', (req, res) => { try { res.json(doc.addSeam(req.body || {})); } catch (e) { fail(res, e); } });
  // Trims and hardware: every answer is the whole list with its derived geometry and check, so a prompt sees what its change did.
  const trims = (extra) => ({ ...extra, ...listTrims(doc.toJSON()) });
  r.get('/trims', (_req, res) => { try { res.json(trims()); } catch (e) { fail(res, e); } });
  r.post('/trims', (req, res) => { try { res.json(trims({ added: doc.addTrim(req.body || {}).id })); } catch (e) { fail(res, e); } });
  r.patch('/trims/:id', (req, res) => { try { res.json(trims({ updated: doc.updateTrim(req.params.id, req.body || {}).id })); } catch (e) { fail(res, e); } });
  r.delete('/trims/:id', (req, res) => { try { res.json(trims({ removed: doc.removeTrim(req.params.id).id })); } catch (e) { fail(res, e); } });
  r.post('/arrange/avatar', async (req, res) => { try { const d = arranged(await ready(req, doc.toJSON()), req.body || {}), result = { avatar: d.simulation.avatar, arrangement: d.arrangement.filter((a) => a.source === 'avatar') }; d.simulation = { ...(d.simulation || {}), avatar: result.avatar, status: 'not_run' }; res.json({ ...result, document: doc.replace(d) }); } catch (e) { fail(res, e); } });
  // Faces of a hard part as pattern pieces with their seams (core/softgoods-flatten.js). mode: append | replace write
  // the document; preview returns the same result and writes nothing; list names the bodies and faces to choose from.
  // ponytail: flattens on the server's own thread (a second for 10k triangles of dome); a worker if big bodies make the window wait
  r.post('/flatten', async (req, res) => {
    try {
      const { path: _p, cell: _c, deflection: _d, mode = 'append', ...options } = req.body || {};
      if (!['append', 'replace', 'preview', 'list'].includes(mode)) throw new GraphError("mode must be 'append', 'replace', 'preview' or 'list'");
      const { mesh, source } = await sourceMesh(req);
      if (mode === 'list') return res.json({ source, ...describeFaces(mesh, options) });
      const current = await ready(req, doc.toJSON()), flat = flattenMesh(mesh, { ...options, source, avoid: mode === 'append' ? [...current.patterns.map((p) => p.id), ...current.seams.map((s) => s.id)] : [] });
      const written = mode === 'preview' ? null : doc.replace(arranged(mergeFlattened(current, flat, mode), current.simulation?.avatar));
      res.json({ mode, source: { ...source, body: flat.body }, revision: (written || current).revision, ...flat.report, ...(mode === 'preview' && { patterns: flat.patterns }) });
    } catch (e) { fail(res, e); }
  });
  // One export. The patterns and tech pack always; formats adds the production outputs ('marker', 'bom', 'print', 'svg', and dxf: 'astm-style')
  // and the draped garment ('glb', 'obj' with its .mtl, 'fit': a fit report, also in the tech pack), any of them in one request.
  // The drape runs first, on a thread of its own, so a design that cannot be draped or laid on its roll writes nothing.
  r.post('/export', async (req, res) => { try {
    const b = req.body || {}, d = await ready(req, doc.toJSON()), dir = path.resolve(exportDir()), name = String(b.name || 'softgoods'), formats = b.formats ?? [];
    if (!Array.isArray(formats)) throw new GraphError('formats must be an array');
    const unknown = formats.find((f) => !EXPORT_FORMATS.includes(f)); if (unknown !== undefined) throw new GraphError(`Unknown export format '${unknown}'. Known: ${EXPORT_FORMATS.join(', ')}`);
    const draped = formats.filter((f) => DRAPE_FORMATS.includes(f)), drape = draped.length ? await drapeDocumentAsync(d, b.drape, bodies(req)) : null, fit = draped.includes('fit') ? fitReport(d, drape) : null;
    const result = exportProduction(d, dir, name, { ...b, formats: formats.filter((f) => PRODUCTION_FORMATS.includes(f)), fit });
    if (drape) { const { files, ...stated } = exportDrape(d, drape, dir, name, { formats: draped, thickness: !!b.thickness, avatar: !!b.avatar, textureMm: b.textureMm ?? 1000 }); result.files.push(...files); result.drape = { settled: drape.settled, steps: drape.steps, residual: drape.residual, target: drape.options.target, ...stated }; }
    if (fit) { const file = path.join(dir, `${name}_fit.json`); fs.writeFileSync(file, JSON.stringify(fit, null, 2)); result.files.push(file); result.fit = { ok: fit.ok, strain: fit.overall.strain, pressure: fit.overall.pressure, contact: fit.overall.contact, ease: fit.ease }; }
    res.json(result);
  } catch (e) { fail(res, e); } });
  r.patch('/arrangement/:pattern', (req, res) => { try { res.json(doc.updateArrangement(req.params.pattern, req.body || {})); } catch (e) { fail(res, e); } });
  doc.onChange(() => broadcast({ type: 'softgoods_changed', revision: doc.data.revision }));
  return r;
}
