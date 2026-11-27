// Every garment size on every avatar size, in each fabric: does it fit? Drapes the design once per combination and
// writes the fit report's verdict, the ease at chest, waist and hip, the share of cloth stretched past its limit and the
// pressure. Fit is judged on cadgang's own solver and the avatar's typical (not measured) size table.
//   node bench/softgoods-size-sweep.mjs [design.json] [--fabrics a,b] [--avatars XS,S] [--target 40] [--steps 600] [--jobs 8] [--out sweep]
// With no design it sweeps the T-shirt body of test/fixtures/softgoods-tee.js placed front and back on the avatar.
import fs from 'node:fs';
import os from 'node:os';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { drapeDocument } from '../src/core/softgoods-drape.js';
import { fitReport } from '../src/core/softgoods-measure.js';
import { sizeSet } from '../src/core/softgoods-marker.js';
import { SIZES } from '../src/core/softgoods-avatar.js';
import { arrangeDesign } from '../src/core/softgoods-bodies.js';
import { validateSoftgoodsDocument } from '../src/core/softgoods-document.js';

function oneFit({ document, target, steps }) {
  const d = validateSoftgoodsDocument(document), placed = arrangeDesign(d, d.simulation.avatar), rows = new Map(d.arrangement.map((a) => [a.pattern, a]));
  for (const a of placed.arrangement) rows.set(a.pattern, a); d.arrangement = d.patterns.map((p) => rows.get(p.id)).filter(Boolean); d.simulation = { ...d.simulation, avatar: placed.avatar };
  const t0 = Date.now(), drape = drapeDocument(d, { target, steps }), fit = fitReport(d, drape), ease = Object.fromEntries((fit.ease || []).map((e) => [e.level, e.ease]));
  return { settled: drape.settled, steps: drape.steps, ok: fit.ok, chest: ease.chest ?? null, waist: ease.waist ?? null, hip: ease.hip ?? null, overLimit: fit.overall.strain.overLimit ?? null, pressureP90: fit.overall.pressure?.p90 ?? null, contact: fit.overall.contact, seconds: (Date.now() - t0) / 1000 };
}
if (!isMainThread) { parentPort.on('message', (job) => { try { parentPort.postMessage({ ...job.key, ...oneFit(job) }); } catch (e) { parentPort.postMessage({ ...job.key, error: e.message }); } }); }
else {
  const args = process.argv.slice(2), opt = (k, v) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args.splice(i, 2)[1] : v; };
  const fabrics = opt('fabrics', 'cotton-jersey,denim-12oz,neoprene-3mm').split(','), avatars = opt('avatars', Object.keys(SIZES).join(',')).split(','), target = Number(opt('target', 40)), steps = Number(opt('steps', 600));
  const jobs = Number(opt('jobs', Math.max(1, os.availableParallelism() - 2))), out = opt('out', 'softgoods-size-sweep');
  let design;
  if (args[0]) design = JSON.parse(fs.readFileSync(args[0], 'utf8'));
  else {
    const { tee } = await import('../test/fixtures/softgoods-tee.js'), t = tee(), keep = new Set(['front', 'back']);
    design = { ...t, patterns: t.patterns.filter((p) => keep.has(p.id)).map((p) => ({ ...p, placement: { region: p.id } })), trims: [], arrangement: [],
      seams: [...t.seams, { id: 'shoulder_left', a: { pattern: 'front', segment: 'front_shoulder_l' }, b: { pattern: 'back', segment: 'back_shoulder_r' }, flip: true }] };
  }
  const garments = sizeSet(design, ['base', ...(design.grades || []).map((g) => g.size)]), queue = [];
  for (const g of garments) for (const a of avatars) for (const f of fabrics) {
    const doc = structuredClone(g.document); for (const m of Object.keys(doc.materials || {})) doc.materials[m] = { ...doc.materials[m], preset: f };
    doc.grades = []; doc.simulation = { ...(doc.simulation || {}), avatar: { ...(doc.simulation?.avatar || {}), size: a } };
    queue.push({ key: { garment: g.size, avatar: a, fabric: f }, document: doc, target, steps });
  }
  console.error(`${queue.length} drapes on ${jobs} threads`);
  const results = []; let next = 0;
  await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, () => new Promise((done) => {
    const w = new Worker(new URL(import.meta.url)), feed = () => (next < queue.length ? w.postMessage(queue[next++]) : (w.terminate(), done()));
    w.on('message', (r) => { results.push(r); console.error(`${results.length}/${queue.length} ${r.garment} on ${r.avatar} in ${r.fabric}: ${r.error || (r.ok ? 'fits' : 'no')}`); feed(); }); feed();
  })));
  const order = (r) => [r.garment, r.avatar, r.fabric].join(' '); results.sort((a, b) => order(a).localeCompare(order(b)));
  const cell = (v) => (v == null ? '' : typeof v === 'number' ? +v.toFixed(3) : v), cols = ['garment', 'avatar', 'fabric', 'ok', 'settled', 'chest', 'waist', 'hip', 'overLimit', 'pressureP90', 'contact', 'steps', 'seconds', 'error'];
  fs.writeFileSync(`${out}.json`, JSON.stringify({ target, steps, results }, null, 2));
  fs.writeFileSync(`${out}.md`, `# Size sweep\n\nEase in mm (garment minus body round each level); overLimit is the share of cloth stretched past its fabric's limit; pressure kPa. Avatar sizes are typical, not measured. Mesh ${target} mm, at most ${steps} steps.\n\n| ${cols.join(' | ')} |\n|${cols.map(() => '---').join('|')}|\n${results.map((r) => `| ${cols.map((c) => cell(r[c])).join(' | ')} |`).join('\n')}\n`);
  console.error(`wrote ${out}.md and ${out}.json`);
}
