/**
 * The v2 document: an ordered stack of cells.
 *
 * A cell is a prompt, the program that prompt compiled to, the parameters that
 * program exposes, and the picks and sketches it depends on. Two rules give the
 * model its character:
 *
 * **The prompt is source; the code is a lockfile.** Editing a prompt does not
 * rebuild geometry. It marks the cell `stale` and waits for an explicit
 * recompile. Without this, opening the same file twice could produce two
 * different parts, and a CAD document that is not reproducible is not a CAD
 * document.
 *
 * **Cells are ordered, not a free DAG.** Natural language leans on a running
 * current solid — "subtract that from the body" — so a cell's default input is
 * the previous cell's result, with explicit `refs` when the flow branches.
 * Because refs may only point backwards, cycles are structurally impossible
 * rather than something to detect.
 */

import fs from 'node:fs';
import path from 'node:path';
import { GraphError } from './errors.js';
import { compileCell, normalizeParams } from './sandbox.js';
import { cellApi, checkCellResult } from './cellapi.js';

const CELL_ID = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const UNDO_LIMIT = 100;
const UNDO_COALESCE_MS = 800;
const SELECTION_TYPES = new Set(['face', 'edge']);

/**
 * Where a cell stands relative to its own prompt. Note what is NOT here:
 * evaluation failure. A cell that throws is reported by `evaluateCells`, not
 * written back into the document — otherwise every viewport render of a broken
 * model would be a document write, and undo would fill with states the user
 * never authored.
 */
export const CELL_STATUS = Object.freeze({
  ok: 'ok',                       // code matches prompt
  stale: 'stale',                 // prompt edited since the code was compiled
  diverged: 'diverged',           // code hand-edited since it was compiled
  awaitingPick: 'awaiting_pick',  // declares a selection the user has not made
});

/**
 * What a cell is for.
 *
 * An assertion cell is a first-class member of the stack rather than a comment
 * or a test file, because the claim has to re-run on every parameter change —
 * and the moment it stops being part of the document is the moment it stops
 * being true.
 */
export const CELL_KIND = Object.freeze({
  model: 'model',    // builds geometry; its result feeds the next cell
  assert: 'assert',  // measures the geometry and passes it through unchanged
});

function validateKind(kind) {
  const k = String(kind ?? CELL_KIND.model);
  if (!Object.values(CELL_KIND).includes(k)) {
    throw new GraphError(`Cell kind '${kind}' must be one of: ${Object.values(CELL_KIND).join(', ')}`);
  }
  return k;
}

function validateId(id) {
  if (!CELL_ID.test(String(id ?? ''))) {
    throw new GraphError(`Cell id '${id}' must match ${CELL_ID} — it is used as a reference name`);
  }
  return String(id);
}

/**
 * A selection is unresolved until the user has picked. Resolution stores a
 * query plus an anchor (never an index), so a later evaluation can re-resolve
 * and check that it still matches the same entity.
 */
function validateSelections(selections) {
  if (selections == null) return {};
  if (typeof selections !== 'object' || Array.isArray(selections)) {
    throw new GraphError('selections must be an object of name -> declaration');
  }
  const out = {};
  for (const [name, decl] of Object.entries(selections)) {
    const spec = typeof decl === 'string' ? { type: decl } : { ...decl };
    if (!SELECTION_TYPES.has(spec.type)) {
      throw new GraphError(`Selection '${name}' must be of type ${[...SELECTION_TYPES].join(' or ')}`);
    }
    out[name] = spec;
  }
  return out;
}

const isResolved = (spec) => Boolean(spec && spec.query);

export const hasUnresolvedSelections = (cell) =>
  Object.values(cell.selections || {}).some((s) => !isResolved(s));

/** The status a cell should carry, given its own fields. */
function deriveStatus(cell, base = CELL_STATUS.ok) {
  return hasUnresolvedSelections(cell) ? CELL_STATUS.awaitingPick : base;
}

export class CellDocument {
  constructor(filePath = null) {
    this.filePath = filePath;
    this.revision = 0;
    this.cells = [];
    this.output = null;
    this._counter = 0;
    this._listeners = new Set();
    this._undo = [];
    this._redo = [];
    this._lastSig = null;
    this._lastPushT = 0;
    if (filePath && fs.existsSync(filePath)) {
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        this.revision = data.revision ?? 0;
        // A document written before assertion cells existed has no `kind`;
        // everything in it modelled, so that is what it becomes.
        this.cells = (Array.isArray(data.cells) ? data.cells : [])
          .map((c) => ({ kind: CELL_KIND.model, ...c }));
        this.output = data.output ?? null;
        this._counter = data.counter ?? this.cells.length;
      } catch {
        // Corrupt file: start empty rather than refuse to boot.
      }
    }
  }

  onChange(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  toJSON() {
    return {
      version: 2,
      revision: this.revision,
      output: this.output,
      cells: this.cells,
      counter: this._counter,
    };
  }

  _touch() {
    this.revision++;
    if (this.filePath) {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.toJSON(), null, 2));
    }
    for (const fn of this._listeners) fn(this);
  }

  // ------------------------------------------------------------------ lookup

  indexOf(id) {
    return this.cells.findIndex((c) => c.id === id);
  }

  get(id) {
    const cell = this.cells[this.indexOf(id)];
    if (!cell) throw new GraphError(`Cell '${id}' does not exist`);
    return cell;
  }

  /**
   * The cell geometry resolves to: the explicit output, else the last cell
   * that builds anything.
   *
   * Assertion cells are skipped. The natural place to put a check is at the
   * bottom of the stack, and a document whose output was its own last check
   * would be naming a pass-through as the thing it produces.
   */
  get terminal() {
    if (this.output) return this.output;
    for (let i = this.cells.length - 1; i >= 0; i--) {
      if (this.cells[i].kind !== CELL_KIND.assert) return this.cells[i].id;
    }
    return this.cells.length ? this.cells[this.cells.length - 1].id : null;
  }

  // --------------------------------------------------------------- undo/redo

  _snapshot() {
    return { cells: structuredClone(this.cells), output: this.output, counter: this._counter };
  }

  _pushUndo(sig = null) {
    const now = Date.now();
    if (sig && sig === this._lastSig && now - this._lastPushT < UNDO_COALESCE_MS) {
      this._lastPushT = now;
      return;
    }
    this._undo.push(this._snapshot());
    if (this._undo.length > UNDO_LIMIT) this._undo.shift();
    this._redo = [];
    this._lastSig = sig;
    this._lastPushT = now;
  }

  _restore(s) {
    this.cells = s.cells;
    this.output = s.output;
    this._counter = s.counter;
    this._lastSig = null;
    this._touch();
  }

  undo() {
    if (!this._undo.length) throw new GraphError('Nothing to undo');
    this._redo.push(this._snapshot());
    this._restore(this._undo.pop());
    return this.toJSON();
  }

  redo() {
    if (!this._redo.length) throw new GraphError('Nothing to redo');
    this._undo.push(this._snapshot());
    this._restore(this._redo.pop());
    return this.toJSON();
  }

  // -------------------------------------------------------------- validation

  /**
   * Refs must name cells that already exist and sit earlier in the stack.
   * `atIndex` is where the referring cell lives (or will live).
   */
  _validateRefs(refs, atIndex, selfId = null) {
    if (refs == null) return [];
    if (!Array.isArray(refs)) throw new GraphError('refs must be an array of cell ids');
    return refs.map((ref) => {
      if (ref === selfId) throw new GraphError(`Cell '${selfId}' cannot reference itself`);
      const at = this.indexOf(ref);
      if (at < 0) throw new GraphError(`Cell references unknown cell '${ref}'`);
      if (at >= atIndex) {
        throw new GraphError(
          `Cell may only reference earlier cells, and '${ref}' comes later in the stack`
        );
      }
      return ref;
    });
  }

  // ----------------------------------------------------------------- mutators

  /**
   * Append (or insert) a cell.
   *
   * `code` is optional: a cell may be created from a prompt alone and compiled
   * later, which is exactly the state the authoring loop passes through when
   * Claude writes the prompt before it has looked at the topology.
   */
  addCell({
    id, prompt = '', code = null, params, refs = [], selections, sketch = null,
    kind = CELL_KIND.model, compiledBy = null, at = null,
  } = {}) {
    const cellId = id ? validateId(id) : `cell_${this._counter + 1}`;
    if (this.indexOf(cellId) >= 0) throw new GraphError(`Cell id '${cellId}' already exists`);
    const index = at == null ? this.cells.length : clampIndex(at, this.cells.length);
    const cleanRefs = this._validateRefs(refs, index);
    const cleanSelections = validateSelections(selections);
    // Compile before mutating: a program that will not compile should not land
    // in the document at all.
    const declared = code == null ? {} : compileCell(code, { id: cellId }).params;

    this._pushUndo();
    this._counter++;
    const cell = {
      id: cellId,
      kind: validateKind(kind),
      prompt: String(prompt ?? ''),
      refs: cleanRefs,
      selections: cleanSelections,
      sketch,
      params: { ...declared, ...normalizeParams(params, cellId) },
      code,
      compiledBy,
      compiledAt: code == null ? null : new Date().toISOString(),
      status: CELL_STATUS.ok,
    };
    cell.status = deriveStatus(cell);
    this.cells.splice(index, 0, cell);
    this._touch();
    return cell;
  }

  /**
   * Edit a cell's fields.
   *
   * The status rules are the point of this method. A prompt edit makes the code
   * `stale`; a code edit makes it `diverged`; a parameter change does neither,
   * because turning a knob is not a change of intent.
   */
  updateCell(id, { prompt, code, params, refs, selections, sketch, kind } = {}) {
    const cell = this.get(id);
    const index = this.indexOf(id);
    const cleanRefs = refs !== undefined ? this._validateRefs(refs, index, id) : null;
    const cleanSelections = selections !== undefined ? validateSelections(selections) : null;
    const declared = code !== undefined && code != null ? compileCell(code, { id }).params : null;
    const cleanParams = params !== undefined ? normalizeParams(params, id) : null;
    if (cleanParams) {
      const known = { ...(declared ?? {}), ...cell.params };
      for (const key of Object.keys(cleanParams)) {
        if (!(key in known)) {
          throw new GraphError(
            `Cell '${id}' has no parameter '${key}'. Declared: ${Object.keys(known).join(', ') || '(none)'}`
          );
        }
      }
    }

    // A slider dragging one parameter should be one undo step, not fifty.
    const onlyParams = params !== undefined &&
      [prompt, code, refs, selections, sketch, kind].every((v) => v === undefined);
    this._pushUndo(onlyParams ? `params:${id}:${Object.keys(cleanParams).sort().join(',')}` : null);

    if (cleanRefs) cell.refs = cleanRefs;
    if (cleanSelections) cell.selections = cleanSelections;
    if (sketch !== undefined) cell.sketch = sketch;
    if (kind !== undefined) cell.kind = validateKind(kind);
    if (declared) cell.params = { ...declared, ...cell.params };
    if (cleanParams) cell.params = { ...cell.params, ...cleanParams };

    let base = cell.status === CELL_STATUS.awaitingPick ? CELL_STATUS.ok : cell.status;
    if (prompt !== undefined && String(prompt) !== cell.prompt) {
      cell.prompt = String(prompt);
      if (cell.code != null) base = CELL_STATUS.stale;
    }
    if (code !== undefined && code !== cell.code) {
      cell.code = code;
      base = CELL_STATUS.diverged;
    }
    cell.status = deriveStatus(cell, base);
    this._touch();
    return cell;
  }

  /**
   * Commit a compile: new code that the recorded prompt is the source of.
   *
   * This is the only path back to `ok`, and it is deliberately separate from
   * `updateCell` — the difference between "the model regenerated this from the
   * prompt" and "someone edited the code by hand" is the provenance the
   * lockfile exists to record.
   */
  commitCompile(id, { code, prompt, params, compiledBy = null } = {}) {
    const cell = this.get(id);
    if (typeof code !== 'string' || !code.trim()) {
      throw new GraphError(`commitCompile needs the compiled code for cell '${id}'`);
    }
    const declared = compileCell(code, { id }).params;
    const overrides = normalizeParams(params ?? {}, id);

    this._pushUndo();
    if (prompt !== undefined) cell.prompt = String(prompt);
    cell.code = code;
    // Declared defaults win on keys the program no longer exposes; surviving
    // keys keep whatever the user had dialled in.
    cell.params = { ...declared };
    for (const [key, value] of Object.entries(overrides)) cell.params[key] = value;
    cell.compiledBy = compiledBy;
    cell.compiledAt = new Date().toISOString();
    cell.status = deriveStatus(cell, CELL_STATUS.ok);
    this._touch();
    return cell;
  }

  /**
   * Record a user's pick for a declared selection.
   *
   * Two things are stored and they do different jobs. `query` is the
   * human-readable record of what was resolved — it is what the transcript
   * shows and what a model reads back. `anchor` is the mechanism: kind, unit
   * position, measure and heading, which is what actually re-finds the entity
   * on a later version of the shape. Neither is an index, because an index
   * stops meaning anything the moment OCCT renumbers the topology.
   */
  resolveSelection(id, name, { query, anchor = null }) {
    const cell = this.get(id);
    const spec = cell.selections?.[name];
    if (!spec) throw new GraphError(`Cell '${id}' does not declare a selection named '${name}'`);
    if (typeof query !== 'string' || !query.trim()) {
      throw new GraphError('A resolved selection needs a query expression');
    }
    if (!anchor?.kind) {
      throw new GraphError('A resolved selection needs an anchor — pick through the viewport');
    }
    if (anchor.type !== spec.type) {
      throw new GraphError(
        `Selection '${name}' wants a ${spec.type}, but the pick was a ${anchor.type}`
      );
    }
    this._pushUndo();
    cell.selections[name] = { ...spec, query, anchor, pickedAt: new Date().toISOString() };
    cell.status = deriveStatus(cell, cell.status === CELL_STATUS.awaitingPick ? CELL_STATUS.ok : cell.status);
    this._touch();
    return cell;
  }

  deleteCell(id) {
    const index = this.indexOf(id);
    if (index < 0) throw new GraphError(`Cell '${id}' does not exist`);
    const users = this.cells.filter((c) => (c.refs || []).includes(id)).map((c) => c.id);
    if (users.length) {
      throw new GraphError(
        `Cannot delete '${id}': cell(s) ${users.join(', ')} reference it. Rewire them first.`
      );
    }
    this._pushUndo();
    this.cells.splice(index, 1);
    if (this.output === id) this.output = null;
    this._touch();
  }

  /**
   * Reorder the stack.
   *
   * Refuses any move that would put a cell before something it references, or
   * after something that references it — the backwards-only rule is what makes
   * cycles impossible, so it is enforced here rather than repaired later.
   */
  moveCell(id, to) {
    const from = this.indexOf(id);
    if (from < 0) throw new GraphError(`Cell '${id}' does not exist`);
    const target = clampIndex(to, this.cells.length - 1);
    if (target === from) return this.cells[from];

    const reordered = [...this.cells];
    const [moved] = reordered.splice(from, 1);
    reordered.splice(target, 0, moved);
    const position = new Map(reordered.map((c, i) => [c.id, i]));
    for (const cell of reordered) {
      for (const ref of cell.refs || []) {
        if (position.get(ref) >= position.get(cell.id)) {
          throw new GraphError(
            `Moving '${id}' would put '${cell.id}' before the cell it references ('${ref}')`
          );
        }
      }
    }
    this._pushUndo();
    this.cells = reordered;
    this._touch();
    return moved;
  }

  setOutput(id) {
    if (id !== null && this.indexOf(id) < 0) throw new GraphError(`Cell '${id}' does not exist`);
    this._pushUndo();
    this.output = id;
    this._touch();
  }

  clear() {
    this._pushUndo();
    this.cells = [];
    this.output = null;
    this._counter = 0;
    this._touch();
  }
}

function clampIndex(value, max) {
  const n = Number(value);
  if (!Number.isInteger(n)) throw new GraphError('Index must be an integer');
  return Math.max(0, Math.min(max, n));
}

// ------------------------------------------------------------------ evaluation

/**
 * What a cell consumes: its explicit refs, or — the common case — the previous
 * cell in the stack, which is the "that" natural language keeps pointing at.
 */
export function dependenciesOf(doc, index) {
  const cell = doc.cells[index];
  if (cell.refs?.length) return [...cell.refs];
  // Walk back past assertion cells. A check is not a step in the model, so it
  // must not become a link in the chain — otherwise inserting one would make
  // every cell below it depend on what the check happened to be about, and a
  // check that changes the model is not a check.
  for (let i = index - 1; i >= 0; i--) {
    if (doc.cells[i].kind !== CELL_KIND.assert) return [doc.cells[i].id];
  }
  return [];
}

/**
 * The cells that must run to produce `targetId`, in stack order.
 *
 * A branch the target does not consume is skipped: a document whose tail is an
 * abandoned experiment should not pay for it on every parameter drag.
 *
 * Assertion cells are the exception, and they have to be. A check is not
 * consumed by anything — that is its nature — so under the rule above a check
 * written as a side branch would quietly never run, and "assertions fail the
 * document" would be false exactly when it mattered. Every assertion cell at or
 * before the target runs, and drags its own dependencies in with it. An
 * assertion cell AFTER the target does not: it is asking about geometry that
 * this evaluation is not producing.
 */
export function evaluationOrder(doc, targetId) {
  const targetIndex = doc.indexOf(targetId);
  if (targetIndex < 0) throw new GraphError(`Cell '${targetId}' does not exist`);
  const needed = new Set([targetId]);
  // An assertion cell is included when everything it asks about sits at or
  // before the target — which is not the same as the CELL sitting before it.
  // The natural place to write a check is at the bottom of the stack, past the
  // last cell that builds anything, and bounding on the check's own position
  // would skip exactly those.
  doc.cells.forEach((cell, i) => {
    if (cell.kind !== CELL_KIND.assert) return;
    if (dependenciesOf(doc, i).every((d) => doc.indexOf(d) <= targetIndex)) needed.add(cell.id);
  });
  for (let i = doc.cells.length - 1; i >= 0; i--) {
    if (!needed.has(doc.cells[i].id)) continue;
    for (const dep of dependenciesOf(doc, i)) needed.add(dep);
  }
  return doc.cells.filter((c) => needed.has(c.id));
}

/**
 * The dependency graph, derived rather than authored.
 *
 * v1's node graph was the document; here it is a read-only picture OF the
 * document, and that is the whole point of deriving it here instead of in the
 * browser: `dependenciesOf` is the one place that knows what "the previous
 * result" means, including that assertion cells are not in the chain. A second
 * copy of that rule in the client would be wrong the first time this one
 * changed — which it already has, once.
 *
 * `lane` is the column to draw a cell in. The trunk — everything the output
 * actually consumes — is lane 0. A cell off the trunk inherits its parent's
 * lane if the parent is also off it, and otherwise opens a new one. Lanes are
 * never reused: a document with many abandoned branches gets a wide picture,
 * which is honest about what it is.
 */
export function dependencyGraph(doc, targetId = doc.terminal) {
  if (!targetId) return { nodes: [], edges: [], target: null };
  const targetIndex = doc.indexOf(targetId);
  if (targetIndex < 0) throw new GraphError(`Cell '${targetId}' does not exist`);

  // What the output consumes — NOT evaluationOrder, which deliberately also
  // pulls in assertion cells nothing consumes.
  const trunk = new Set([targetId]);
  for (let i = targetIndex; i >= 0; i--) {
    if (!trunk.has(doc.cells[i].id)) continue;
    for (const dep of dependenciesOf(doc, i)) trunk.add(dep);
  }

  const lanes = new Map();
  let widest = 0;
  const edges = [];
  const nodes = doc.cells.map((cell, i) => {
    const deps = dependenciesOf(doc, i);
    for (const dep of deps) edges.push({ from: dep, to: cell.id, explicit: Boolean(cell.refs?.length) });

    let lane = 0;
    if (!trunk.has(cell.id)) {
      const parent = deps.map((d) => lanes.get(d)).find((l) => l > 0);
      lane = parent ?? ++widest;
    }
    lanes.set(cell.id, lane);
    return {
      id: cell.id,
      index: i,
      kind: cell.kind || CELL_KIND.model,
      lane,
      onTrunk: trunk.has(cell.id),
      isOutput: cell.id === targetId,
      deps,
    };
  });

  return { nodes, edges, target: targetId, lanes: widest + 1 };
}

/** Compiled programs, keyed by source text — a param drag must not recompile. */
const compiledCache = new Map();
const COMPILE_CACHE_LIMIT = 64;

function compiledFor(cell) {
  const cached = compiledCache.get(cell.code);
  if (cached) return cached;
  const compiled = compileCell(cell.code, { id: cell.id });
  if (compiledCache.size >= COMPILE_CACHE_LIMIT) {
    compiledCache.delete(compiledCache.keys().next().value);
  }
  compiledCache.set(cell.code, compiled);
  return compiled;
}

/**
 * Run the document up to `targetId` and return its shape.
 *
 * The caller owns the OCCT scope: every shape produced here — including the one
 * returned — belongs to whatever `beginBrepScope()` is active, and is freed when
 * that scope is disposed. Callers must convert to plain JS (a tessellation, a
 * STEP buffer, a measurement) before disposing, exactly as the v1 API layer
 * does.
 *
 * Failure is per-cell and named. `stopOnError: false` keeps going so the report
 * can show every broken cell in one pass, which is what the authoring loop
 * wants — but geometry is then only whatever the last successful cell produced.
 */
export function evaluateCells(doc, targetId = doc.terminal, { stopOnError = true } = {}) {
  if (!targetId) throw new GraphError('Document has no cells to evaluate');
  const order = evaluationOrder(doc, targetId);
  const results = new Map();
  const report = [];
  let previous = null;
  let lastGood = null;

  for (const cell of order) {
    const index = doc.indexOf(cell.id);
    const entry = {
      id: cell.id, kind: cell.kind || CELL_KIND.model,
      status: 'ok', error: null, logs: [], checks: [], ms: 0,
    };
    report.push(entry);

    if (cell.code == null) {
      entry.status = 'error';
      entry.error = `Cell '${cell.id}' has a prompt but no compiled program yet`;
      if (stopOnError) throw new GraphError(entry.error.includes(`'${cell.id}'`) ? entry.error : `Cell '${cell.id}': ${entry.error}`);
      continue;
    }
    if (hasUnresolvedSelections(cell)) {
      entry.status = 'awaiting_pick';
      const names = Object.entries(cell.selections)
        .filter(([, s]) => !isResolved(s))
        .map(([n, s]) => `${n} (${s.type})`);
      entry.error = `Cell '${cell.id}' is waiting for a pick: ${names.join(', ')}`;
      if (stopOnError) throw new GraphError(entry.error.includes(`'${cell.id}'`) ? entry.error : `Cell '${cell.id}': ${entry.error}`);
      continue;
    }

    const inputs = {};
    for (const dep of dependenciesOf(doc, index)) inputs[dep] = results.get(dep) ?? null;
    const input = cell.refs?.length ? inputs[cell.refs[0]] : previous;

    const started = Date.now();
    const asserting = cell.kind === CELL_KIND.assert;
    try {
      const compiled = compiledFor(cell);
      const value = compiled.run(cellApi({
        params: cell.params, input, inputs, selections: cell.selections, sketch: cell.sketch,
        checked: entry.checks,
      }));
      entry.logs = compiled.logs.map((l) => ({ ...l }));
      // An assertion cell measures; it does not model. Its result is whatever
      // came in, so a check can be dropped anywhere in the stack without
      // becoming a link in the chain that later cells depend on.
      results.set(cell.id, asserting ? input : checkCellResult(value, cell.id));
      // An assertion cell is TRANSPARENT to the running "that": it does not
      // become the previous result, so the next cell sees what it would have
      // seen if the check were not there. Otherwise dropping a check into the
      // middle of a stack would redirect everything below it — and a check
      // that changes the model is not a check.
      if (!asserting) {
        previous = results.get(cell.id);
        lastGood = cell.id;
      }
    } catch (err) {
      // A lost pick is not a bug in the code — it is a question only the human
      // can answer, so it reports as awaiting_pick and the UI offers a re-pick
      // rather than showing a modelling error nobody can act on.
      entry.status = err.repick ? 'awaiting_pick' : asserting ? 'failed' : 'error';
      entry.error = err.message;
      // A failed assertion fails the DOCUMENT, not the stack. Stopping here
      // would hide the geometry that the check is about — and looking at the
      // part is the first thing anyone does when told a wall is too thin. So
      // the shape passes through, later cells still build, and the refusal
      // happens where it has teeth: at export.
      if (asserting) {
        results.set(cell.id, input);
      } else if (stopOnError) {
        throw err instanceof GraphError ? err : new GraphError(err.message);
      }
    } finally {
      entry.ms = Date.now() - started;
    }
  }

  // Every check every cell made, in stack order. Assertion cells are the usual
  // source, but a modelling cell that states its own intent with assert.* lands
  // here too — the distinction is where the claim is written, not how it counts.
  const assertions = report.flatMap((e) =>
    e.checks.map((c) => ({ cell: e.id, ...c })));

  return {
    value: results.get(targetId) ?? null,
    results,
    report,
    assertions,
    // The one flag exports look at. A document with a failed assertion still
    // renders; it just does not ship.
    assertionsPass: assertions.every((c) => c.ok),
    target: targetId,
    // The deepest cell that actually produced a shape. When the newest cell is
    // broken — the normal state mid-edit — this is what the viewport should
    // still be showing, rather than going blank and hiding the four cells that
    // worked. Exports deliberately do not use it: shipping a partial model as
    // if it were the model is a different kind of wrong.
    lastGood,
  };
}
