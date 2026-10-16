/**
 * Options: Claude proposes several versions of one cell, the user picks one.
 *
 * Each option is evaluated on a scratch copy of the document — never on the
 * real one — so a broken option is just a card with an error on it, and the
 * stack does not move until somebody chooses. One set at a time: proposing
 * again replaces the set, choosing or dismissing clears it.
 *
 *   POST   /api/cells/options            {cell?, options:[{label, prompt?, code, params?}]}
 *   GET    /api/cells/options?wait=30    the set (long-polls until chosen/dismissed when wait>0)
 *   GET    /api/cells/options/:i.png     a rendered look
 *   GET    /api/cells/options/:i/mesh    the viewport mesh of one option
 *   POST   /api/cells/options/choose     {i}
 *   DELETE /api/cells/options
 */

import express from 'express';
import { CellDocument } from '../core/cells.js';

export function optionsRouter(doc, { modelOf, broadcast = () => {} }) {
  const r = express.Router();
  let set = null;
  let waiters = [];
  const wake = () => { const w = waiters; waiters = []; for (const fn of w) fn(); };

  function scratch() {
    const tmp = new CellDocument(null);
    tmp.cells = structuredClone(doc.cells); tmp.output = doc.output; tmp._counter = doc._counter;
    return tmp;
  }
  /** Apply one option to a document (scratch or real) through the document's own validation. */
  function apply(target, cell, opt) {
    if (cell && target.indexOf(cell) >= 0) {
      return target.commitCompile(cell, { code: opt.code, prompt: opt.prompt, params: opt.params, compiledBy: 'option' });
    }
    return target.addCell({ id: cell || undefined, prompt: opt.prompt || opt.label, code: opt.code, params: opt.params, compiledBy: 'option' });
  }

  const publicSet = () => set && {
    id: set.id, cell: set.cell, at: set.at, chosen: set.chosen,
    options: set.options.map(({ png, ...o }, i) => ({ i, ...o })),
  };

  r.post('/', async (req, res, next) => {
    try {
      const { cell = null, options } = req.body || {};
      if (!Array.isArray(options) || options.length < 2 || options.length > 8) throw Object.assign(new Error('Send 2–8 options'), { status: 400 });
      const results = [];
      for (const opt of options) {
        const entry = { label: String(opt.label || `option ${results.length + 1}`), prompt: opt.prompt ?? null, code: String(opt.code || ''), params: opt.params ?? null, measures: null, error: null, png: null };
        try {
          const tmp = scratch();
          apply(tmp, cell, entry);
          const { measures, png } = await modelOf(tmp, { png: true });
          entry.measures = measures; entry.png = png;
        } catch (e) { entry.error = e.message; }
        results.push(entry);
      }
      set = { id: Date.now().toString(36), cell, at: new Date().toISOString(), chosen: null, options: results };
      wake();
      broadcast({ type: 'options_changed' });
      res.json(publicSet());
    } catch (e) { next(e); }
  });

  r.get('/', (req, res) => {
    const wait = Math.min(60, Math.max(0, parseFloat(req.query.wait ?? '0') || 0));
    const settled = () => !set || set.chosen !== null;
    if (!wait || settled()) return res.json({ set: publicSet(), timedOut: false });
    let done = false;
    const finish = (timedOut) => { if (done) return; done = true; clearTimeout(t); res.json({ set: publicSet(), timedOut }); };
    const t = setTimeout(() => finish(true), wait * 1000);
    const onWake = () => { if (settled()) finish(false); else waiters.push(onWake); };
    waiters.push(onWake);
    res.on('close', () => { done = true; clearTimeout(t); });
  });

  const optionOr404 = (req, res) => {
    const o = set?.options[parseInt(req.params.i, 10)];
    if (!o) res.status(404).json({ error: 'No such option' });
    return o;
  };
  r.get('/:i(\\d+).png', (req, res) => { const o = optionOr404(req, res); if (o) o.png ? res.type('png').send(o.png) : res.status(404).json({ error: o.error || 'no look' }); });
  r.get('/:i(\\d+)/mesh', async (req, res, next) => {
    try {
      const o = optionOr404(req, res); if (!o) return;
      const tmp = scratch();
      apply(tmp, set.cell, o);
      const { mesh, measures } = await modelOf(tmp, { mesh: true });
      res.json({ i: parseInt(req.params.i, 10), measures, ...mesh });
    } catch (e) { next(e); }
  });
  r.post('/choose', (req, res, next) => {
    try {
      const i = parseInt(req.body?.i, 10);
      const o = set?.options[i];
      if (!o) throw Object.assign(new Error('No such option'), { status: 404 });
      if (o.error) throw Object.assign(new Error(`Option '${o.label}' did not build: ${o.error}`), { status: 400 });
      const cell = apply(doc, set.cell, o);
      set.chosen = i;
      wake();
      broadcast({ type: 'options_changed' });
      const chosen = publicSet();
      set = null;
      res.json({ chosen: i, label: o.label, cell: cell.id, set: chosen });
    } catch (e) { next(e); }
  });
  r.delete('/', (req, res) => { set = null; wake(); broadcast({ type: 'options_changed' }); res.json({ dismissed: true }); });
  return r;
}
