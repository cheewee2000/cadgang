// The draped garment as data. The page's own cloth solver (web/softgoods-worker.js) runs here, without a page, on the
// input the page gets, until the cloth stops moving. What comes back is each pattern piece's draped vertices with the
// pattern coordinate, strain and contact pressure of every one: src/core/softgoods-drape-export.js writes it as GLB and
// OBJ, src/core/softgoods-measure.js measures it and reports fit. Units as in the solver: mm, z up, the body faces -y.

import crypto from 'node:crypto';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { GraphError } from './errors.js';
import { meshPattern } from './softgoods-mesh.js';
import { resolveSeamCorrespondence } from './softgoods-seams.js';
import { avatarBody } from './softgoods-arrange.js';
import { resolveMaterials } from './softgoods-fabrics.js';
import { closures, trimsInput } from './softgoods-trims.js';
import { conformLines, physicsInput } from './softgoods-physics.js';
import { simulate, advance, FOLDING } from '../../web/softgoods-worker.js';

/** What the solver starts from: the meshed patterns, their resolved seams, where each piece stands and the body.
 *  The page gets the same from GET /api/softgoods/simulation-input (src/server/softgoods.js); test/softgoods-drape.test.js holds the two equal. */
export function simulationInput(d, target = 25) {
  target = Math.max(5, Math.min(100, Number(target) || 25));
  const meshes = d.patterns.map((p) => meshPattern(p, { target, lines: conformLines(d, p) })), shut = closures(d, meshes, { spacing: target / 2 }), seams = [...resolveSeamCorrespondence(d.seams, meshes, { spacing: target / 2 }), ...shut.seams];
  return { revision: d.revision, meshes, seams, attachments: [...(d.attachments || []), ...shut.attachments], arrangement: d.arrangement, materials: resolveMaterials(d.materials), patterns: d.patterns.map((p) => ({ id: p.id, material: p.material, grain: p.grain, shrink: p.shrink, freeze: p.freeze, strengthen: p.strengthen })), ...physicsInput(d, meshes), ...trimsInput(d, { spacing: target / 2 }), collisionBody: d.simulation?.avatar ? { ...d.simulation.avatar, ...avatarBody(d.simulation.avatar) } : null };
}

// The cloth is stepped CHUNK steps at a time and has settled when its vertices moved, root mean square, less than
// `tolerance` mm per step over a chunk. Only the rest shape is wanted, so every fabric is damped at least `damping`:
// the tunic of test/softgoods-review.test.js then rests in about 200 steps, where at the page's damping it still swings after 600.
const CHUNK = 20;
const DEFAULTS = { target: 25, steps: 600, tolerance: 0.02, damping: 0.05 };
const optionsOf = (o) => { const n = (k, lo, hi) => { const v = Number(o?.[k] ?? DEFAULTS[k]); return Math.max(lo, Math.min(hi, Number.isFinite(v) ? v : DEFAULTS[k])); }; return { target: n('target', 5, 100), steps: Math.round(n('steps', 1, 5000)), tolerance: n('tolerance', 1e-6, 100), damping: n('damping', 0, 1) }; };
const keyOf = (document, options) => crypto.createHash('sha1').update(JSON.stringify([document, options])).digest('hex');

function run(document, options) {
  if (!document.patterns?.length) throw new GraphError('No softgoods patterns to drape');
  const input = simulationInput(document, options.target), names = new Set(document.patterns.map((p) => p.material)), materials = { ...input.materials };
  for (const name of names) materials[name] = { ...materials[name], damping: Math.max(options.damping, Number(materials[name]?.damping ?? 0)) };
  // A creased fold closes over the solver's first FOLDING steps, and a slight one moves the cloth less than the tolerance while it does: the cloth is not at rest before then.
  const closing = input.folds?.length ? FOLDING : 0;
  let frame = simulate({ ...input, materials }, 0), before = frame.positions, steps = 0, residual = Infinity;
  while (steps < options.steps && !(residual < options.tolerance && steps >= closing)) {
    const n = Math.min(CHUNK, options.steps - steps); frame = advance(n); steps += n;
    let sum = 0; for (let i = 0; i < before.length; i++) sum += (frame.positions[i] - before[i]) ** 2;
    residual = Math.sqrt(sum / (before.length / 3)) / n; before = frame.positions;
  }
  if (!frame.positions.every(Number.isFinite)) throw new GraphError('The cloth solver lost the cloth (a position is not finite); the design may have seams it cannot close');
  const pieces = input.meshes.map((m, k) => {
    const { off, count } = frame.pieces[k], pattern = document.patterns[k], area = new Float32Array(count);
    for (let i = 0; i < m.triangles.length; i += 3) { const [a, b, c] = [0, 1, 2].map((j) => m.triangles[i + j]), third = Math.abs((m.uv[b * 2] - m.uv[a * 2]) * (m.uv[c * 2 + 1] - m.uv[a * 2 + 1]) - (m.uv[b * 2 + 1] - m.uv[a * 2 + 1]) * (m.uv[c * 2] - m.uv[a * 2])) / 6; area[a] += third; area[b] += third; area[c] += third; }
    return { id: m.id, name: pattern.name || m.id, material: pattern.material || '', off, count, positions: frame.positions.slice(off * 3, (off + count) * 3), uv: Float32Array.from(m.uv), triangles: Uint32Array.from(m.triangles), strain: frame.strain.slice(off, off + count), pressure: frame.pressure.slice(off, off + count), area, segmentVertices: m.segmentVertices };
  });
  return { revision: document.revision ?? 0, options, steps, settled: residual < options.tolerance, residual, units: { length: 'mm', strain: 'ratio', pressure: 'Pa', residual: 'mm per step, root mean square' }, up: 'z', pressureAvailable: !!frame.diagnostics.pressure.available, pieces, seams: input.seams, body: input.collisionBody };
}

// The last few drapes, by what was draped and how: an export of three formats, or a fit report after a measurement, runs the solver once.
const KEEP = 4, results = new Map(), pending = new Map();
function remember(key, result) { results.delete(key); results.set(key, result); while (results.size > KEEP) results.delete(results.keys().next().value); return result; }

/** Drape a softgoods document as it is stored (arranged, with its avatar if it has one). options: target (mesh edge, mm), steps (the cap), tolerance (mm per step), damping. */
export function drapeDocument(document, options) {
  const o = optionsOf(options), key = keyOf(document, o);
  return remember(key, results.get(key) || run(document, o));
}

/** The same, on a thread of its own: a drape takes seconds and the server has pages to answer meanwhile. Two requests for one drape share it. */
export function drapeDocumentAsync(document, options) {
  const o = optionsOf(options), key = keyOf(document, o);
  if (results.has(key)) return Promise.resolve(remember(key, results.get(key)));
  if (!pending.has(key)) pending.set(key, new Promise((resolve, reject) => {
    const thread = new Worker(new URL(import.meta.url), { workerData: { softgoodsDrape: { document, options: o } } });
    thread.once('message', (m) => (m.error ? reject(m.graph ? new GraphError(m.error) : new Error(m.error)) : resolve(remember(key, m.result))));
    thread.once('error', reject);
    thread.once('exit', (code) => { if (code) reject(new Error(`The drape thread stopped with code ${code}`)); });
  }).finally(() => pending.delete(key)));
  return pending.get(key);
}

if (!isMainThread && workerData?.softgoodsDrape) {
  try { parentPort.postMessage({ result: run(workerData.softgoodsDrape.document, workerData.softgoodsDrape.options) }); }
  catch (e) { parentPort.postMessage({ error: e.message || String(e), graph: e instanceof GraphError }); }
}
