import express from 'express';
import { GraphError } from '../core/errors.js';

export function softgoodsRouter(doc, { broadcast = () => {} } = {}) {
  const r = express.Router();
  const fail = (res, e) => res.status(e instanceof GraphError ? 400 : 500).json({ error: e.message || String(e) });
  r.get('/document', (_req, res) => res.json(doc.toJSON()));
  r.put('/document', (req, res) => { try { res.json(doc.replace(req.body)); } catch (e) { fail(res, e); } });
  r.post('/patterns/rectangle', (req, res) => { try { res.json(doc.addRectangle(req.body || {})); } catch (e) { fail(res, e); } });
  r.patch('/patterns/:pattern/points/:point', (req, res) => { try { res.json(doc.updatePoint(req.params.pattern, req.params.point, req.body?.x, req.body?.y)); } catch (e) { fail(res, e); } });
  r.post('/seams', (req, res) => { try { res.json(doc.addSeam(req.body || {})); } catch (e) { fail(res, e); } });
  r.patch('/arrangement/:pattern', (req, res) => { try { res.json(doc.updateArrangement(req.params.pattern, req.body || {})); } catch (e) { fail(res, e); } });
  doc.onChange(() => broadcast({ type: 'softgoods_changed', revision: doc.data.revision }));
  return r;
}
