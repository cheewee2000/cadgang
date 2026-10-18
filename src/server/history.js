/**
 * Version history + autosave policy for the cell document.
 *
 * The document already writes itself on every change; that is persistence,
 * not history. A VERSION is a change worth coming back to, and the policy
 * that decides is deliberately dumb:
 *
 *   structural change (cell added/removed/moved, code, prompt, sketch,
 *   selections, refs, output)   → a version 1.5 s after the burst settles
 *   parameter scrub only         → a version once the knobs have been idle 20 s
 *   revert / explicit save       → a version now
 *
 * Every version carries an automatic annotation (src/core/history.js) and a
 * rendered thumbnail, so the strip in the UI and the MCP listing both read as
 * a story: what changed, and what it looks like.
 */

import path from 'node:path';
import express from 'express';
import { CellDocument } from '../core/cells.js';
import { HistoryStore, diffSnapshots } from '../core/history.js';

const STRUCTURAL_MS = 1500;
const PARAM_IDLE_MS = 20000;

export function historyRouter(doc, { dirOf, modelOf, broadcast = () => {} }) {
  const r = express.Router();
  const store = () => new HistoryStore(dirOf());

  let base = null;         // snapshot the next diff is taken against
  let baseMeasures = null;
  let baseFile = doc.filePath;
  let timer = null;
  let pendingStructural = false;
  let capturing = null;

  function reset() {
    const last = store().last();
    base = last?.snapshot ?? null;
    baseMeasures = last?.measures ?? null;
    baseFile = doc.filePath;
  }
  reset();

  function snapshotOf(d) { return { cells: structuredClone(d.cells), output: d.output, counter: d._counter }; }

  function isStructural(diff) {
    return diff.added.length || diff.removed.length || diff.reordered || diff.output
      || diff.changed.some((c) => c.fields.some((f) => f !== 'params'));
  }

  async function capture({ kind = 'auto', note = '' } = {}) {
    if (capturing) await capturing.catch(() => {});
    capturing = (async () => {
      const snapshot = snapshotOf(doc);
      let measures = null, png = null;
      if (snapshot.cells.length) {
        try { ({ measures, png } = await modelOf(doc, { png: true })); } catch { /* a broken stack is still a version */ }
      }
      const auto = diffSnapshots(base, snapshot, { measures, prevMeasures: baseMeasures });
      if (kind === 'auto' && auto.text === 'no change in the stack' && base) return null;
      const entry = store().add({ snapshot, auto, note, measures, png, kind });
      base = snapshot; baseMeasures = measures;
      broadcast({ type: 'history_changed', n: entry.n });
      return entry;
    })();
    try { return await capturing; } finally { capturing = null; }
  }

  doc.onChange(() => {
    if (doc.filePath !== baseFile) { clearTimeout(timer); timer = null; pendingStructural = false; reset(); return; }
    const diff = diffSnapshots(base, snapshotOf(doc));
    if (diff.text === 'no change in the stack' && base) return;
    pendingStructural = pendingStructural || !!isStructural(diff);
    clearTimeout(timer);
    timer = setTimeout(() => { timer = null; pendingStructural = false; capture().catch(() => {}); },
      pendingStructural ? STRUCTURAL_MS : PARAM_IDLE_MS);
  });

  const strip = ({ snapshot, ...meta }) => ({ ...meta, cells: snapshot.cells.length });
  const entryOr404 = (req, res) => {
    const e = store().get(parseInt(req.params.n, 10));
    if (!e) res.status(404).json({ error: `No version #${req.params.n}` });
    return e;
  };

  r.get('/', (req, res) => res.json({ dir: dirOf(), versions: store().list() }));
  r.post('/', async (req, res, next) => {
    try {
      clearTimeout(timer); timer = null; pendingStructural = false;
      const e = await capture({ kind: 'manual', note: String(req.body?.note || '') });
      res.json(e ? strip(e) : { saved: false, reason: 'nothing changed since the last version' });
    } catch (e) { next(e); }
  });
  r.get('/:n(\\d+).png', (req, res) => res.sendFile(store().pngPath(req.params.n), (err) => err && res.status(404).json({ error: 'no preview' })));
  r.get('/:n(\\d+)', (req, res) => { const e = entryOr404(req, res); if (e) res.json(e); });
  r.get('/:n(\\d+)/mesh', async (req, res, next) => {
    try {
      const e = entryOr404(req, res); if (!e) return;
      const tmp = new CellDocument(null);
      tmp.cells = structuredClone(e.snapshot.cells); tmp.output = e.snapshot.output ?? null;
      const { mesh, measures, shown } = await modelOf(tmp, { mesh: true });
      res.json({ n: e.n, shown, measures, ...mesh });
    } catch (e) { next(e); }
  });
  r.post('/:n(\\d+)/revert', async (req, res, next) => {
    try {
      const e = entryOr404(req, res); if (!e) return;
      clearTimeout(timer); timer = null; pendingStructural = false;
      doc.restore(e.snapshot);
      const v = await capture({ kind: 'revert', note: `reverted to #${e.n}` });
      res.json({ reverted: e.n, version: v ? strip(v) : null, revision: doc.revision });
    } catch (e) { next(e); }
  });
  r.post('/:n(\\d+)/note', (req, res) => {
    const e = store().setNote(parseInt(req.params.n, 10), String(req.body?.note || ''));
    if (!e) return res.status(404).json({ error: `No version #${req.params.n}` });
    broadcast({ type: 'history_changed', n: e.n });
    res.json(strip(e));
  });
  return r;
}
