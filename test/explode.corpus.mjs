// Explode the corpus: `node test/explode.corpus.mjs import.jsonl outdir` runs explode.harness.mjs on every assembly the import
// run found (3..200 bodies, <= 400k tris), one child per file, and writes outdir/<n>.txt plus outdir/summary.jsonl with the
// collisions the SOLVER caused: pairs inside each other at k>0 that were not at k=0 (k=0 overlaps are the model's own).
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const harness = fileURLToPath(new URL('./explode.harness.mjs', import.meta.url));
const [jsonl, outdir = 'explode-corpus'] = process.argv.slice(2);
fs.mkdirSync(outdir, { recursive: true });
const sum = `${outdir}/summary.jsonl`;
const done = new Set(fs.existsSync(sum) ? fs.readFileSync(sum, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).file) : []);
const rows = fs.readFileSync(jsonl, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  .filter((r) => r.ok && r.bodies >= 3 && r.bodies <= 200 && r.tris <= 400000 && !done.has(r.file)).sort((a, b) => a.tris - b.tris);
const JOBS = +(process.env.JOBS || 4);
let i = 0, n = 0;
const pairs = (line) => new Set((line.split('COLLIDING ')[1] || '').split(' | ').filter(Boolean).map((s) => s.replace(/: \d+\/\d+$/, '').split(' in ').sort().join(' ~ ')));   // unordered: 'A in B' and 'B in A' are one pair
const run = (r) => new Promise((resolve) => {
  const t0 = Date.now(), name = r.file.split('/').pop();
  execFile(process.execPath, ['--max-old-space-size=16384', harness, r.file], { timeout: 600000, maxBuffer: 1 << 26, env: { ...process.env, DEFL: process.env.DEFL || '0.0008' } }, (e, stdout, stderr) => {
    const out = String(stdout), id = String(++n).padStart(4, '0');
    fs.writeFileSync(`${outdir}/${id}.txt`, out + (stderr ? '\n--- stderr\n' + stderr : ''));
    const ks = Object.fromEntries(out.split('\n').filter((l) => /^\s+k=/.test(l)).map((l) => [l.match(/k=([\d.]+)/)[1], pairs(l)]));
    const base = ks['0'] || new Set(), caused = [...new Set(Object.entries(ks).filter(([k]) => k !== '0').flatMap(([, s]) => [...s].filter((p) => !base.has(p))))];
    const still = [...(ks['1'] || [])].filter((p) => !base.has(p));   // colliding even fully exploded
    const solved = out.match(/solved in (\d+) ms/)?.[1];
    const row = { file: r.file, id, bodies: r.bodies, tris: r.tris, ok: !e && !!solved, solveMs: solved ? +solved : null, ms: Date.now() - t0, modelOverlaps: base.size, caused: caused.length, stillAtK1: still.length, pairs: caused.slice(0, 8), error: e ? (e.killed ? 'TIMEOUT' : String(stderr).trim().split('\n').pop()?.slice(0, 200)) : undefined };
    fs.appendFileSync(sum, JSON.stringify(row) + '\n');
    process.stderr.write(`${n}/${rows.length} ${row.ok ? 'ok  ' : 'FAIL'} ${String(row.ms).padStart(7)} ms ${String(r.bodies).padStart(3)} bodies caused ${String(row.caused).padStart(3)}  ${name}\n`);
    resolve();
  });
});
await Promise.all(Array.from({ length: JOBS }, async () => { while (i < rows.length) await run(rows[i++]); }));
