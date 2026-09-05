/**
 * REST surface for the v2 cell document, mounted at /api/cells.
 *
 * It sits alongside the v1 node-graph API rather than replacing it: the two
 * documents share a process and a kernel but nothing else, so the old block
 * graph keeps working while v2 is built out.
 *
 * The routes are shaped by the authoring loop the design doc describes —
 * build, introspect, write a query, check the count, apply, render, assert.
 * `/topology` and `/query` are the two that carry the most weight, because
 * Claude cannot see the model and these are what it uses instead of looking.
 */

import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import { GraphError } from '../core/errors.js';
import {
  evaluateCells, evaluationOrder, dependenciesOf, dependencyGraph, hasUnresolvedSelections,
} from '../core/cells.js';
import { compileCell } from '../core/sandbox.js';
import { cellApi } from '../core/cellapi.js';
import { topology, Query, enumerate, anchorFor } from '../core/query.js';
import { solveWithDrag } from '../core/sketch.js';
import { drawOn, eraseEntity, eraseConstraint, dimensionOn } from '../core/sketchdraw.js';
import * as ops from '../core/ops.js';
import { meshingBounds } from '../core/sdf.js';
import { meshStats } from '../core/mesher.js';
import { renderPreview } from '../core/render.js';
import {
  initBrep, beginBrepScope, tessellate, tessellateEdges, exportStep, tightBounds,
  brepDistance, brepBBox,
} from '../core/brep.js';

/** A sketch with nothing in it yet — where drawing on an empty cell starts. */
const emptySketch = () => ({ plane: 'XY', points: [], entities: [], constraints: [] });

export function cellsRouter(doc, rootDir) {
  const r = express.Router();

  const fail = (res, err, code = 400) =>
    res.status(err instanceof GraphError ? code : 500).json({ error: err.message });

  const state = () => doc.toJSON();

  /**
   * Evaluate up to the requested cell and hand the result to `body`.
   *
   * Same contract as the v1 API: the shape belongs to the scope opened here and
   * is freed on the way out, so `body` must convert to plain JS — triangles, a
   * buffer, a measurement — before it returns.
   *
   * `partial` is for the two routes that feed the viewport. Mid-edit the newest
   * cell is broken most of the time, and blanking the model would hide the four
   * cells that did work — so they fall back to the deepest shape that built and
   * say which cell that was. Everything else stays strict: introspecting or
   * exporting a different cell than the one asked for is worse than an error.
   */
  async function withShape(req, body, { partial = false, requireAssertions = false } = {}) {
    const target = req.query.cell || req.body?.cell || doc.terminal;
    if (!target) throw new GraphError('The cell document is empty — add a cell first');
    await initBrep();
    const scope = beginBrepScope();
    try {
      const run = evaluateCells(doc, target, { stopOnError: !partial });
      const shown = run.value ? target : partial ? run.lastGood : null;
      if (!shown) {
        const failed = run.report.find((c) => c.status !== 'ok');
        throw new GraphError(failed?.error || `Cell '${target}' produced no geometry`);
      }
      // A failed assertion stops an EXPORT and nothing else. The model still
      // renders, still measures, still answers topology questions — because
      // looking at the part is how you fix the wall that is too thin. What it
      // does not do is leave the building. The escape hatch is deliberate and
      // explicit: delete the assertion cell, which is an edit the document
      // records, rather than a flag on a URL that it does not.
      if (requireAssertions && !run.assertionsPass) {
        const failed = run.assertions.filter((c) => !c.ok);
        throw new GraphError(
          `Refusing to export: ${failed.length} assertion${failed.length === 1 ? '' : 's'} failing — ` +
          failed.map((c) => `${c.cell}: ${c.label} ${c.value}${c.unit ? ' ' + c.unit : ''} vs ${c.limit}`).join('; ')
        );
      }
      return await body({
        ...run,
        shape: run.value ?? run.results.get(run.lastGood),
        shown,
        partial: shown !== target,
      });
    } finally {
      scope.dispose();
    }
  }

  /**
   * Mesh deflection for the viewport: explicit if asked, else scaled to the
   * part. A fixed 0.01 mm is invisible on a 100 mm bottle and costs half a
   * minute on a thread; a two-thousandth of the diagonal, clamped, reads the
   * same on screen at a fraction of the triangles.
   */
  const tolerance = (req, shape = null) => {
    const t = parseFloat(req.query.tolerance ?? '');
    if (Number.isFinite(t) && t > 0) return Math.min(t, 5);
    if (!shape) return 0.01;
    try {
      const { min, max } = tightBounds(shape);
      const diag = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
      return Math.min(0.1, Math.max(0.01, diag / 2000));
    } catch { return 0.01; }
  };

  // ------------------------------------------------------------------ document

  r.get('/document', (req, res) => res.json(state()));

  /**
   * The dependency DAG, derived from the stack.
   *
   * v1's node graph was the document; this is a picture of one. It is computed
   * here rather than in the browser because `dependenciesOf` is the only thing
   * that knows what a cell's default input is — a second copy of that rule in
   * the client would go stale the first time this one changed.
   */
  r.get('/graph', (req, res) => {
    try {
      res.json({ revision: doc.revision, ...dependencyGraph(doc, req.query.cell || doc.terminal) });
    } catch (e) { fail(res, e); }
  });

  r.post('/', (req, res) => {
    try { res.json(doc.addCell(req.body || {})); } catch (e) { fail(res, e); }
  });

  r.patch('/:id', (req, res) => {
    try { res.json(doc.updateCell(req.params.id, req.body || {})); } catch (e) { fail(res, e); }
  });

  /** Commit a recompile: the only path back to status 'ok'. */
  r.post('/:id/compile', (req, res) => {
    try { res.json(doc.commitCompile(req.params.id, req.body || {})); } catch (e) { fail(res, e); }
  });

  r.post('/:id/move', (req, res) => {
    try { res.json(doc.moveCell(req.params.id, req.body?.to)); } catch (e) { fail(res, e); }
  });

  /**
   * Solve a cell's sketch, optionally with one point dragged.
   *
   * Deliberately does NOT persist. A drag fires this on every pointermove, and
   * writing each intermediate pose into the document would fill undo with a
   * hundred steps of one gesture. The client saves once, on release, with an
   * ordinary PATCH.
   *
   * The solve runs against the cell's current parameters, so a dimension
   * written as `'width'` means the same number here as it does when the cell
   * evaluates — a sketch that dragged against different values than it builds
   * with would be a different sketch.
   */
  r.post('/:id/sketch/solve', (req, res) => {
    try {
      const cell = doc.get(req.params.id);
      const data = req.body?.sketch ?? cell.sketch;
      if (!data) throw new GraphError(`Cell '${cell.id}' has no sketch`);
      res.json(solveWithDrag(data, req.body?.move ?? null, cell.params || {}));
    } catch (e) { fail(res, e); }
  });

  /**
   * Draw a line, rectangle, circle, or arc into a cell's sketch.
   *
   * The opposite of `/solve` in the one way that matters: this one PERSISTS.
   * A drag is sixty events that mean one edit, so it saves on release; drawing
   * is one gesture that means one edit, so it saves here — and a mis-drawn line
   * comes off with the same ⌘Z as everything else.
   *
   * A cell with no sketch yet gets an empty one, so the first line a person
   * draws is also how a sketch begins. What their program does with it is still
   * the program's business: nothing appears until it reads `sk.saved()`.
   */
  r.post('/:id/sketch/draw', (req, res) => {
    try {
      const cell = doc.get(req.params.id);
      const data = req.body?.sketch ?? cell.sketch ?? emptySketch();
      const result = drawOn(data, req.body?.op, {
        params: cell.params || {},
        snap: Number(req.body?.snap) || 0,
      });
      doc.updateCell(cell.id, { sketch: result.sketch });
      res.json(result);
    } catch (e) { fail(res, e); }
  });

  /**
   * Dimension a line, a curve, or the gap between two points.
   *
   * `value` may be a number or the name of one of the cell's params, which is
   * the whole point: it is how an outline someone drew by hand becomes
   * parametric, driven by the same slider the program declares.
   */
  r.post('/:id/sketch/dimension', (req, res) => {
    try {
      const cell = doc.get(req.params.id);
      const data = req.body?.sketch ?? cell.sketch;
      if (!data) throw new GraphError(`Cell '${cell.id}' has no sketch`);
      const result = dimensionOn(data, req.body?.op, { params: cell.params || {} });
      doc.updateCell(cell.id, { sketch: result.sketch });
      res.json(result);
    } catch (e) { fail(res, e); }
  });

  /**
   * Erase one entity from a cell's sketch and whatever only it held up, or one
   * constraint on its own — which is how a dimension comes back off.
   */
  r.post('/:id/sketch/erase', (req, res) => {
    try {
      const cell = doc.get(req.params.id);
      const data = req.body?.sketch ?? cell.sketch;
      if (!data) throw new GraphError(`Cell '${cell.id}' has no sketch`);
      const params = cell.params || {};
      const result = Number.isInteger(req.body?.constraint)
        ? eraseConstraint(data, req.body.constraint, { params })
        : eraseEntity(data, req.body?.entity, { params });
      doc.updateCell(cell.id, { sketch: result.sketch });
      res.json(result);
    } catch (e) { fail(res, e); }
  });

  /**
   * Record a pick.
   *
   * Whatever the client sends is transient by construction — resolved against a
   * fresh evaluation inside this one request. What gets STORED is the entity's
   * kind and anchor, never an index, so the pick survives the next parameter
   * change instead of quietly sliding onto a different edge.
   *
   * Two ways in, because the two clients know different things:
   *
   *  - `index`, the enumeration index. This is what `topology` reports as `i`,
   *    so it is the natural path for a model picking from what it read. The
   *    tessellation ships faces in enumeration order, so the viewport can use
   *    it for faces too — guarded by `revision`, since an index from a stale
   *    mesh would point at the wrong face rather than fail.
   *  - `point`, a position in space. The viewport has to use this for EDGES:
   *    OCCT tessellates edges in a different order than it enumerates them, so
   *    an edge index derived from the rendered wireframe would silently name
   *    the wrong edge. A click is a point; matching on the point is honest.
   *
   * The pick resolves against the cell's INPUT, because a pick is a click on
   * the geometry the cell is about to modify.
   */
  r.post('/:id/selections/:name', async (req, res) => {
    try {
      const { id, name } = req.params;
      const { type, index, point, revision } = req.body || {};
      const cell = doc.get(id);
      const spec = cell.selections?.[name];
      if (!spec) throw new GraphError(`Cell '${id}' does not declare a selection named '${name}'`);
      const wanted = type || spec.type;
      const byIndex = Number.isInteger(index) && index >= 0;
      const byPoint = Array.isArray(point) && point.length === 3 && point.every(Number.isFinite);
      if (!byIndex && !byPoint) {
        throw new GraphError('A pick needs either an enumeration index or a clicked point [x, y, z]');
      }
      if (byIndex && revision != null && revision !== doc.revision) {
        throw new GraphError(
          `That index came from revision ${revision} and the document is now at ${doc.revision}. ` +
          'Refetch the mesh and pick again.'
        );
      }

      await initBrep();
      const scope = beginBrepScope();
      try {
        const source = pickSource(doc, id);
        const shape = evaluateCells(doc, source).value;
        if (!shape) throw new GraphError(`Cannot pick on '${id}': '${source}' produced no geometry`);

        const list = enumerate(shape, wanted);
        const hit = byIndex ? list[index] : nearestTo(list, point, wanted, source);
        if (!hit) {
          throw new GraphError(
            `There is no ${wanted} ${index} on '${source}' — it has ${list.length}`
          );
        }
        const anchor = anchorFor(hit.d, list);
        const query = `${wanted}s.ofKind('${anchor.kind}').nearestTo(${anchor.unit.join(', ')})`;
        res.json(doc.resolveSelection(id, name, { query, anchor }));
      } finally {
        scope.dispose();
      }
    } catch (e) { fail(res, e); }
  });

  r.delete('/:id', (req, res) => {
    try { doc.deleteCell(req.params.id); res.json({ deleted: req.params.id }); } catch (e) { fail(res, e); }
  });

  r.post('/document/output', (req, res) => {
    try { doc.setOutput(req.body?.cell ?? null); res.json(state()); } catch (e) { fail(res, e); }
  });

  r.post('/document/clear', (req, res) => { doc.clear(); res.json(state()); });

  r.post('/undo', (req, res) => {
    try { res.json(doc.undo()); } catch (e) { fail(res, e); }
  });

  r.post('/redo', (req, res) => {
    try { res.json(doc.redo()); } catch (e) { fail(res, e); }
  });

  /**
   * Every pick still waiting on a human, with the cell to click on.
   *
   * One list serves both clients: the UI drops into pick mode from it, and a
   * model that has just authored a cell needing a pick polls it to find out
   * whether the human has answered yet.
   */
  function pendingPicks() {
    const pending = [];
    for (const cell of doc.cells) {
      if (!hasUnresolvedSelections(cell)) continue;
      let source = null;
      let reason = null;
      try {
        source = pickSource(doc, cell.id);
      } catch (e) {
        reason = e.message;
      }
      for (const [name, spec] of Object.entries(cell.selections)) {
        if (spec.query) continue;
        pending.push({ cell: cell.id, name, type: spec.type, prompt: cell.prompt, source, reason });
      }
    }
    return pending;
  }

  /**
   * `?wait=<seconds>` long-polls until the pending set changes.
   *
   * This is what lets a modelling session interleave machine authoring with
   * human disambiguation without either side blocking permanently: Claude
   * declares a pick, waits here, and the request comes back the moment someone
   * clicks — or on the timeout, so a session never hangs on a human who has
   * wandered off.
   */
  r.get('/pending', (req, res) => {
    const wait = Math.min(60, Math.max(0, parseFloat(req.query.wait ?? '0') || 0));
    const before = JSON.stringify(pendingPicks());
    if (!wait) {
      return res.json({ revision: doc.revision, pending: JSON.parse(before) });
    }

    let done = false;
    const finish = (timedOut) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsubscribe();
      res.json({ revision: doc.revision, pending: pendingPicks(), timedOut });
    };
    const unsubscribe = doc.onChange(() => {
      if (JSON.stringify(pendingPicks()) !== before) finish(false);
    });
    const timer = setTimeout(() => finish(true), wait * 1000);
    // A client that gives up must not leave a listener on the document.
    res.on('close', () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsubscribe();
    });
  });

  // ---------------------------------------------------------------- evaluation

  /**
   * Run the stack and report per-cell status, console output, and timings —
   * without shipping any geometry. This is the cheap "did my edit work" call,
   * and `stopOnError=0` makes it show every broken cell in one pass instead of
   * one round trip per failure.
   */
  r.get('/evaluate', async (req, res) => {
    try {
      const target = req.query.cell || doc.terminal;
      if (!target) throw new GraphError('The cell document is empty — add a cell first');
      await initBrep();
      const scope = beginBrepScope();
      try {
        const stopOnError = req.query.stopOnError !== '0';
        const run = evaluateCells(doc, target, { stopOnError });
        // Measures follow the same fallback as the viewport: a broken tail cell
        // should not also blank the numbers for the part that did build.
        const shape = run.value ?? run.results.get(run.lastGood) ?? null;
        res.json({
          target: run.target,
          shown: run.value ? run.target : run.lastGood,
          revision: doc.revision,
          order: evaluationOrder(doc, target).map((c) => c.id),
          cells: run.report,
          assertions: run.assertions,
          assertionsPass: run.assertionsPass,
          measures: shape ? measuresOf(shape) : null,
        });
      } finally {
        scope.dispose();
      }
    } catch (e) { fail(res, e); }
  });

  /**
   * Full topology of a cell's result — the call that replaces vision.
   *
   * Every face and edge with the properties a query filters on, so the model
   * can read the shape it just built and write a reference that means something
   * about the geometry rather than about an index.
   */
  r.get('/topology', async (req, res) => {
    try {
      await withShape(req, ({ shape, target }) => {
        const t = topology(shape);
        res.json({ cell: target, revision: doc.revision, ...t, measures: measuresOf(shape) });
      });
    } catch (e) { fail(res, e); }
  });

  /**
   * Resolve a query expression against a cell's result and report what it
   * catches, without committing it to a cell.
   *
   * This is the step that makes generated geometry code trustworthy: confirm
   * the expression selects four edges and not twelve *before* filleting. The
   * expression is ordinary cell-language JavaScript with `q` and `shape` in
   * scope, so what is tested here is exactly what gets pasted into the cell.
   */
  r.post('/query', async (req, res) => {
    try {
      const expression = String(req.body?.expression ?? '').trim();
      if (!expression) {
        throw new GraphError(
          "Send an expression, e.g. { expression: \"q.edges(shape).linear().along('z')\" }"
        );
      }
      await withShape(req, ({ shape, target }) => {
        const probe = compileCell(
          `export default ({ q, input }) => { const shape = input; return (${expression}); };`,
          { id: `query:${target}` }
        );
        const result = probe.run(cellApi({ input: shape }));
        if (!(result instanceof Query)) {
          throw new GraphError(
            'That expression did not produce a query. Build one with q.faces(shape) or q.edges(shape).'
          );
        }
        res.json({ cell: target, source: expression, ...result.explain() });
      });
    } catch (e) { fail(res, e); }
  });

  // ------------------------------------------------------------------ geometry

  /** Triangles for the viewport, tessellated from the real surfaces. */
  r.get('/mesh', async (req, res) => {
    try {
      await withShape(req, ({ shape, target, shown, partial }) => {
        const t = tessellate(shape, { tolerance: tolerance(req, shape) });
        const bounds = meshingBounds(brepBBox(shape));
        res.json({
          cell: shown,
          requested: target,
          partial,
          revision: doc.revision,
          exact: true,
          positions: Array.from(t.positions),
          normals: Array.from(t.normals),
          indices: Array.from(t.indices),
          faces: t.faces,
          edges: tessellateEdges(shape, { tolerance: tolerance(req, shape) }),
          stats: meshStats(t.positions, t.indices, bounds, null),
        });
      }, { partial: true });
    } catch (e) { fail(res, e); }
  });

  /** Write an export to exports/<name>.<ext> when ?file= was given. */
  function saveExport(fileParam, ext, data) {
    if (!fileParam) return null;
    const safe = String(fileParam).replace(/[^\w.-]/g, '_').replace(new RegExp(`\\.${ext}$`, 'i'), '');
    const dir = path.join(rootDir, 'exports');
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, `${safe}.${ext}`);
    fs.writeFileSync(target, data);
    return target;
  }

  /** STEP download — the only export. Cells are exact all the way through, so this never degrades. */
  r.get('/export/step', async (req, res) => {
    try {
      await withShape(req, async ({ shape, target }) => {
        const step = await exportStep(shape);
        const savedTo = saveExport(req.query.file, 'step', step);
        res.setHeader('Content-Type', 'model/step');
        res.setHeader('Content-Disposition', `attachment; filename="${target}.step"`);
        if (savedTo) res.setHeader('X-Saved-To', savedTo);
        res.send(step);
      }, { requireAssertions: true });
    } catch (e) { fail(res, e); }
  });

  /**
   * Raymarched PNG preview. The raymarcher wants a distance field, which the
   * one-way bridge derives from the exact solid — the same path a B-rep block
   * takes in v1, so cells get previews for free.
   */
  r.get('/preview.png', async (req, res) => {
    try {
      await withShape(req, ({ shape }) => {
        const png = renderPreview(brepDistance(shape, { tolerance: tolerance(req, shape) }), meshingBounds(brepBBox(shape)), {
          width: parseInt(req.query.width || '640', 10),
          height: parseInt(req.query.height || '480', 10),
          yaw: parseFloat(req.query.yaw ?? '-35'),
          pitch: parseFloat(req.query.pitch ?? '25'),
        });
        res.setHeader('Content-Type', 'image/png');
        res.send(png);
      });
    } catch (e) { fail(res, e); }
  });

  return r;
}

/**
 * The entity nearest a clicked point.
 *
 * Distance is to the entity's centre, which is precise for edges — you click
 * within a millimetre or two of the line you mean — and is why this path is
 * used for edges rather than faces. A tie is refused: two entities the same
 * distance from the click means the click did not say which, and guessing here
 * would poison the anchor that every later evaluation trusts.
 */
function nearestTo(list, point, type, source) {
  if (!list.length) throw new GraphError(`'${source}' has no ${type}s to pick`);
  const scored = list
    .map((e) => ({ e, d: Math.hypot(...[0, 1, 2].map((k) => e.d.center[k] - point[k])) }))
    .sort((a, b) => a.d - b.d);
  const [best, next] = scored;
  if (next && next.d - best.d < 1e-6) {
    throw new GraphError(
      `That click is equidistant from two ${type}s — zoom in and click closer to the one you mean`
    );
  }
  return best.e;
}

/**
 * The cell whose geometry a pick is made against: the picking cell's own input.
 *
 * You click the shape the cell is about to modify, not the shape it produces —
 * the whole reason the cell is parked is that it cannot produce anything until
 * the pick is made.
 */
function pickSource(doc, id) {
  const [source] = dependenciesOf(doc, doc.indexOf(id));
  if (!source) {
    throw new GraphError(
      `Cell '${id}' is first in the stack, so there is no geometry to pick on. ` +
      'Selections belong on a cell that modifies an earlier one.'
    );
  }
  return source;
}

/** Cheap facts about a result that a text-only client can act on. */
function measuresOf(shape) {
  const { min, max, size } = ops.bbox(shape);
  return { volume: ops.volume(shape), area: ops.area(shape), bbox: { min, max, size } };
}
