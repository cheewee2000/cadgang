import express from 'express';
import path from 'node:path';
import { GraphError } from '../core/errors.js';
import { exportSoftgoods } from '../core/softgoods-export.js';
import { meshPattern } from '../core/softgoods-mesh.js';
import { resolveSeamCorrespondence } from '../core/softgoods-seams.js';
import { arrangePatternsAroundAvatar, avatarBody } from '../core/softgoods-arrange.js';
import { checkDesign } from '../core/softgoods-operations.js';
import { validateSoftgoodsDocument } from '../core/softgoods-document.js';

// Where every piece starts in 3D. A piece with placement stands at its region of the avatar; one without keeps the row it was given,
// or is laid flat beside the others. A design set again keeps the avatar it had, so re-prompting a pattern does not lose the body.
function arranged(value, avatar) {
  const d = validateSoftgoodsDocument(value), rows = new Map(d.arrangement.map((a) => [a.pattern, a]));
  if (avatar) { const result = arrangePatternsAroundAvatar(d.patterns, avatar); for (const a of result.arrangement) rows.set(a.pattern, a); d.simulation = { ...(d.simulation || {}), avatar: result.avatar, status: 'not_run' }; }
  let x = 0;
  d.arrangement = d.patterns.map((p) => { const xs = p.points.map((q) => q.x), row = rows.get(p.id) || { pattern: p.id, position: [x - Math.min(...xs, 0), 0, 0], rotation: [0, 0, 0], layer: 0 }; if (!rows.has(p.id)) x += (xs.length ? Math.max(...xs) - Math.min(...xs) : 0) + 40; return row; });
  return d;
}

export function softgoodsRouter(doc, { exportDir = () => process.cwd(), broadcast = () => {} } = {}) {
  const r = express.Router();
  const fail = (res, e) => res.status(e instanceof GraphError ? 400 : 500).json({ error: e.message || String(e) });
  r.get('/simulation-input', (req, res) => { try { const d = doc.toJSON(), target = Math.max(5, Math.min(100, Number(req.query.target || 25))), meshes = d.patterns.map((p) => meshPattern(p, { target })), seams = resolveSeamCorrespondence(d.seams, meshes, { spacing: target / 2 }); res.json({ revision: d.revision, meshes, seams, attachments: d.attachments || [], arrangement: d.arrangement, materials: d.materials, patterns: d.patterns.map((p) => ({ id: p.id, material: p.material, grain: p.grain })), collisionBody: d.simulation?.avatar ? { ...d.simulation.avatar, ...avatarBody(d.simulation.avatar) } : null }); } catch (e) { fail(res, e); } });
  r.get('/document', (_req, res) => res.json(doc.toJSON()));
  r.put('/document', (req, res) => { try { res.json(doc.replace(arranged(req.body, req.body?.simulation?.avatar || doc.data.simulation?.avatar))); } catch (e) { fail(res, e); } });
  r.get('/check', (_req, res) => { try { res.json(checkDesign(doc.toJSON())); } catch (e) { fail(res, e); } });
  r.post('/patterns/rectangle', (req, res) => { try { res.json(doc.addRectangle(req.body || {})); } catch (e) { fail(res, e); } });
  r.patch('/patterns/:pattern/points/:point', (req, res) => { try { res.json(doc.updatePoint(req.params.pattern, req.params.point, req.body?.x, req.body?.y)); } catch (e) { fail(res, e); } });
  r.post('/seams', (req, res) => { try { res.json(doc.addSeam(req.body || {})); } catch (e) { fail(res, e); } });
  r.post('/arrange/avatar', (req, res) => { try { const d = arranged(doc.toJSON(), req.body || {}), result = { avatar: d.simulation.avatar, arrangement: d.arrangement.filter((a) => a.source === 'avatar') }; d.simulation = { ...(d.simulation || {}), avatar: result.avatar, status: 'not_run' }; res.json({ ...result, document: doc.replace(d) }); } catch (e) { fail(res, e); } });
  r.post('/export', (req, res) => { try { res.json(exportSoftgoods(doc.toJSON(), path.resolve(exportDir()), String(req.body?.name || 'softgoods'))); } catch (e) { fail(res, e); } });
  r.patch('/arrangement/:pattern', (req, res) => { try { res.json(doc.updateArrangement(req.params.pattern, req.body || {})); } catch (e) { fail(res, e); } });
  doc.onChange(() => broadcast({ type: 'softgoods_changed', revision: doc.data.revision }));
  return r;
}
