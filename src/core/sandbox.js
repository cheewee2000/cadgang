/**
 * Running a cell's committed program.
 *
 * A cell's `code` is stored in the document as ES-module source, because that
 * is the form a human reads and hand-edits:
 *
 *     export const params = { w: 60, h: 24 };
 *     export default ({ p, brep, q }) => brep.box(p.w, p.w, p.h);
 *
 * Node cannot evaluate module source in a `vm` context without a flag, so the
 * two export forms the contract allows are rewritten into assignments on a
 * carrier object before compiling. The rewrite is deliberately narrow — exactly
 * two anchored patterns — and any other `export` is rejected rather than
 * silently mangled.
 *
 * ## What the isolation is and is not
 *
 * A fresh `vm` context is a new realm: it has the ECMAScript intrinsics and
 * nothing else. No `process`, `require`, `fetch`, `Buffer`, or timers, so a
 * program cannot touch the filesystem, the network, or the clock, and a runaway
 * loop is cut off by the wall-clock budget.
 *
 * It is NOT a security boundary. The kernel functions handed in as `brep` come
 * from the host realm, and any host function reaches the host `Function`
 * constructor through its prototype. Code written specifically to escape will
 * escape. The threat model this fits is the real one: cell programs are written
 * by Claude Code, which the user is already running with full tool access, so
 * the risk being managed is a mistake — an infinite loop, an accidental file
 * write — not an adversary. Moving execution into a worker with its own kernel
 * would close the gap, and cannot happen while the OCCT instance lives in this
 * process and shapes are non-transferable.
 */

import vm from 'node:vm';
import { GraphError } from './errors.js';

/** Wall-clock budget for evaluating the module body (defining params + fn). */
const COMPILE_TIMEOUT_MS = 2000;
/** Wall-clock budget for one call of the cell's default export. */
const RUN_TIMEOUT_MS = 20000;
/** Console lines kept per run; a program that logs in a loop truncates. */
const LOG_LIMIT = 200;

const CARRIER = '__cadgangCell';
const ARGS = '__cadgangArgs';

/**
 * Rewrite the two permitted export forms into assignments on the carrier.
 *
 * `export const params = X` becomes `const params = CARRIER.params = X`, which
 * both captures the value and leaves the binding in scope, so a program may
 * legally refer to `params` further down.
 */
export function transformCellSource(code) {
  const src = String(code ?? '');
  // An export is recognised at any statement boundary — the start of the
  // source, a line, or after a semicolon — so a one-line module is as valid
  // as a formatted one.
  let out = src.replace(
    /(^|[;\n])[ \t]*export[ \t]+const[ \t]+params[ \t]*=/,
    (_, lead) => `${lead}const params = ${CARRIER}.params =`
  );
  out = out.replace(/(^|[;\n])[ \t]*export[ \t]+default[ \t]+/, (_, lead) => `${lead}${CARRIER}.default = `);
  // A dynamic import cannot be refused from inside the realm: Node invokes the
  // loader callback in a microtask, so the failure lands after the cell has
  // returned, as a process-level exception. Refuse it before it can run.
  if (/\bimport\s*\(/.test(out)) {
    throw new GraphError('import() is not available in a cell program — the API is passed in as arguments');
  }
  const leftover = out.match(/(?:^|[;\n])[ \t]*(export\b.*)/);
  if (leftover) {
    throw new GraphError(
      `A cell may only 'export const params' and 'export default'. Found: ${leftover[1].trim()}`
    );
  }
  if (!out.includes(`${CARRIER}.default`)) {
    throw new GraphError(
      'A cell program must have an `export default` — the function that builds the geometry'
    );
  }
  return out;
}

/** Collector for a cell's console output, capped so a hot loop cannot blow up. */
function makeConsole(logs) {
  const write = (level) => (...args) => {
    if (logs.length >= LOG_LIMIT) return;
    logs.push({
      level,
      text: args.map((a) => (typeof a === 'string' ? a : safeInspect(a))).join(' '),
    });
  };
  return { log: write('log'), warn: write('warn'), error: write('error') };
}

function safeInspect(value) {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Compile a cell program.
 *
 * Returns the declared default params and a `run(api)` that invokes the
 * program. Both the module body and the call happen inside the context under a
 * timeout — the timeout interrupts JavaScript, so it catches a runaway loop,
 * but it cannot interrupt a kernel call already down inside OCCT.
 */
export function compileCell(code, { id = 'cell', timeoutMs = RUN_TIMEOUT_MS } = {}) {
  const transformed = transformCellSource(code);
  const logs = [];
  const context = vm.createContext({ console: makeConsole(logs) });
  context[CARRIER] = {};

  // The wrapper's opening brace sits on line 1 with the program starting on
  // line 2, so a negative offset puts stack traces back on the author's lines.
  const wrapped = `(function (${CARRIER}) { 'use strict';\n${transformed}\n})(${CARRIER});`;
  const filename = `cell:${id}`;
  let carrier;
  try {
    new vm.Script(wrapped, { filename, lineOffset: -1 }).runInContext(context, {
      timeout: COMPILE_TIMEOUT_MS,
    });
    carrier = context[CARRIER];
  } catch (err) {
    throw new GraphError(`Cell '${id}' failed to compile: ${err.message}`);
  }
  if (typeof carrier.default !== 'function') {
    throw new GraphError(`Cell '${id}': export default must be a function, got ${typeof carrier.default}`);
  }

  const call = new vm.Script(`${CARRIER}.default(${ARGS});`, { filename });

  return {
    id,
    params: normalizeParams(carrier.params, id),
    logs,
    run(api) {
      // Compiled cells are cached and re-run on every parameter change, so the
      // log buffer belongs to the run, not to the compilation.
      logs.length = 0;
      context[ARGS] = api;
      try {
        return call.runInContext(context, { timeout: timeoutMs });
      } catch (err) {
        if (err instanceof GraphError) throw err;
        if (/Script execution timed out/i.test(err.message)) {
          throw new GraphError(`Cell '${id}' ran longer than ${timeoutMs}ms and was stopped`);
        }
        if (err.code === 'ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING_FLAG' || /dynamic import callback/i.test(err.message)) {
          throw new GraphError(`Cell '${id}': import() is not available in a cell program — the API is passed in as arguments`);
        }
        throw new GraphError(`Cell '${id}' threw: ${err.message}`);
      } finally {
        context[ARGS] = undefined;
      }
    },
  };
}

/**
 * Params are the direct-manipulation surface, so they are restricted to values
 * a slider or a text field can round-trip through JSON. A program that wants a
 * derived object computes it in its body from `p`.
 */
export function normalizeParams(params, id = 'cell') {
  if (params == null) return {};
  if (typeof params !== 'object' || Array.isArray(params)) {
    throw new GraphError(`Cell '${id}': params must be an object of named values`);
  }
  const out = {};
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new GraphError(`Cell '${id}': param '${key}' is not finite`);
      out[key] = value;
    } else if (typeof value === 'string' || typeof value === 'boolean') {
      out[key] = value;
    } else {
      throw new GraphError(
        `Cell '${id}': param '${key}' must be a number, string, or boolean — got ${typeof value}`
      );
    }
  }
  return out;
}
