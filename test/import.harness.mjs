// Import harness over a corpus: `node test/import.harness.mjs list.tsv out.jsonl` (tsv: size<TAB>path, or one path per line).
// Each file imports in its own child process (a crash or hang costs one file, not the run); a line of JSON per file.
// Resumable: files already in out.jsonl are skipped. JOBS=6 parallel, CADGANG_WASM=1 for the WASM importer.
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const self = fileURLToPath(import.meta.url);

if (process.argv[2] === '--one') {   // child: import one file, print one JSON line
  const file = process.argv[3], t0 = performance.now();
  const { importCadFile } = await import('../src/core/step.js');
  const buf = fs.readFileSync(file), size = buf.length;
  try {
    const m = await importCadFile(buf, { name: file.split('/').pop(), linearDeflection: parseFloat(process.env.DEFL || '0.002') });
    const P = m.positions; let nan = 0; for (let i = 0; i < P.length; i++) if (!Number.isFinite(P[i])) nan++;
    const empty = m.bodies.filter((b) => b.count === 0).length, unnamed = m.bodies.filter((b) => !b.name || /^body \d+$/.test(b.name)).length;
    const colored = m.bodies.filter((b) => b.color).length, pathed = m.bodies.filter((b) => b.path?.length).length;
    const names = [...new Set(m.bodies.map((b) => b.name))].slice(0, 12);
    console.log(JSON.stringify({ file, size, ok: true, importer: m.timings.importer, ms: Math.round(performance.now() - t0), t: m.timings,
      bodies: m.bodies.length, tris: m.triangleCount, faces: m.faceCount, empty, unnamed, colored, pathed, nan, bbox: m.bbox, names }));
  } catch (e) {
    console.log(JSON.stringify({ file, size, ok: false, importer: process.env.CADGANG_WASM === '1' ? 'wasm' : 'native', ms: Math.round(performance.now() - t0), error: String(e?.message || e).slice(0, 300) }));
  }
  process.exit(0);
}

const [list, out = 'import.jsonl'] = process.argv.slice(2);
const done = new Set(fs.existsSync(out) ? fs.readFileSync(out, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).file) : []);
const files = fs.readFileSync(list, 'utf8').split('\n').filter(Boolean).map((l) => l.split('\t').pop()).filter((f) => !done.has(f) && fs.existsSync(f));
const JOBS = +(process.env.JOBS || 6);
let i = 0, n = 0;
const run = (file) => new Promise((resolve) => {
  const mb = fs.statSync(file).size / 1048576, timeout = Math.round((120 + 4 * mb) * 1000);   // ponytail: linear budget, 400 MB → 29 min
  const t0 = Date.now();
  execFile(process.execPath, ['--max-old-space-size=16384', self, '--one', file], { timeout, maxBuffer: 1 << 26, env: process.env }, (e, stdout, stderr) => {
    let line = stdout.trim().split('\n').pop();
    if (!line || !line.startsWith('{')) line = JSON.stringify({ file, size: Math.round(mb * 1048576), ok: false, importer: process.env.CADGANG_WASM === '1' ? 'wasm' : 'native', ms: Date.now() - t0, error: (e?.killed ? 'TIMEOUT ' : 'CRASH ') + String(e?.signal || e?.code || '') + ' ' + String(stderr).trim().split('\n').pop()?.slice(0, 200) });
    fs.appendFileSync(out, line + '\n');
    const r = JSON.parse(line); process.stderr.write(`${++n}/${files.length} ${r.ok ? 'ok  ' : 'FAIL'} ${String(r.ms).padStart(7)} ms ${r.bodies ?? '-'} bodies  ${file.split('/').pop()}\n`);
    resolve();
  });
});
await Promise.all(Array.from({ length: JOBS }, async () => { while (i < files.length) await run(files[i++]); }));
