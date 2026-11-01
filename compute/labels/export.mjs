// Labelled part shapes from a corpus of CAD files, for compute/README.md stage 3: one JSON line per named body with its
// class (from the body's name), 1024 sampled vertices (mm, centred on the body's bbox centre) and bbox size.
//   node compute/labels/export.mjs --one file.step                      prints the body records of one file
//   JOBS=n node compute/labels/export.mjs --list corpus.tsv --out parts-labelled.jsonl   size<TAB>path per line, resumable (one '#file' line per file done)
// Bodies with CAD feature names (body12, fillet3, cut-extrude1) count as unnamed and are skipped. Within a file, bodies
// with the same name and vertex count are one record (a pattern of 20 screws is one screw). 'other' is capped at 4 per
// file so the named enclosures and brackets do not swamp the fasteners. File paths are reduced to the basename.
import fs from 'node:fs';
import { execFile } from 'node:child_process';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const R = new URL('../..', import.meta.url).pathname;
const CLASSES = [   // first match wins; the name is lower-cased, cut at '|' and stripped of parentheses first
  ['screw', /\b(screws?|bolts?|shcs|bhcs|fhcs|torx|thumbscrews?)\b|^m\d+\s*x\s*\d|^#\d+-\d+/],
  ['nut', /\b(nuts?|nyloc)\b/], ['washer', /\bwashers?\b/], ['standoff', /\b(standoffs?|stand-offs?|spacers?)\b/],
  ['bearing', /\bbearings?\b/], ['magnet', /\bmagnets?\b/], ['spring', /\bsprings?\b/], ['oring', /\b(o-rings?|orings?|gaskets?|seals?)\b/],
  ['pcb', /\b(pcb|sub-board|board|circuit)\b/],
  ['component', /^[rcjuldqy]\d+\b|\b(connector|resistor|capacitor|inductor|mosfet|diode|led|ic|chip|switch|header|usb|jst|ffc|antenna|sensor|microphone|speaker|module|crystal)\b/],
  ['battery', /\b(battery|lipo|18650|coin cell)\b/],
];
const CAP = { other: 4, component: 10 };   // per file: enclosures and passives would swamp the fasteners
const UNNAMED = /^(body|solid|part|fillet|chamfer|cut-extrude|boss-extrude|extrude|revolve|lpattern|cirpattern|mirror|shell|sweep|loft|component|\d+|[a-z]?\d+[a-z]?)(\s*\d*|\[\d+\])?$/i;
const clean = (n) => n.toLowerCase().split('|')[0].replace(/\(.*?\)/g, ' ').replace(/_part(\s*\d+)?$/, '').replace(/[\s_-]*\d+$|\[\d+\]$/, '').trim();
const label = (n) => CLASSES.find(([, rx]) => rx.test(clean(n)))?.[0] ?? 'other';

async function one(file) {
  const { importCadFile } = await import(`${R}/src/core/step.js`);
  const m = await importCadFile(fs.readFileSync(file), { name: file.split('/').pop(), linearDeflection: 0.002 });
  const pos = m.positions, idx = m.indices, seen = new Set(), out = [], n = {};
  for (const b of m.bodies) {
    const name = (b.name || '').trim(); if (!name || UNNAMED.test(name)) continue;
    const vs = new Set(); for (let i = 0; i < b.count * 3; i++) vs.add(idx[b.first * 3 + i]);
    const V = [...vs], lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const v of V) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], pos[3 * v + k]); hi[k] = Math.max(hi[k], pos[3 * v + k]); }
    const lab = label(name), key = `${lab}|${V.length}|${hi.map((h, k) => (h - lo[k]).toFixed(1))}`;   // the same shape again (a pattern of screws) is one record
    if (seen.has(key)) continue; seen.add(key); n[lab] = (n[lab] ?? 0) + 1; if (n[lab] > (CAP[lab] ?? Infinity)) continue;
    const c = lo.map((l, k) => (l + hi[k]) / 2), step = V.length / 1024, pts = [];
    for (let i = 0; i < 1024; i++) { const v = V[Math.floor(i * step) % V.length]; pts.push(+(pos[3 * v] - c[0]).toFixed(2), +(pos[3 * v + 1] - c[1]).toFixed(2), +(pos[3 * v + 2] - c[2]).toFixed(2)); }
    out.push({ label: lab, name, file: file.split('/').pop(), nVerts: V.length, size: hi.map((h, k) => +(h - lo[k]).toFixed(2)), pts });
  }
  return out;
}

if (arg('--one')) {
  for (const r of await one(arg('--one'))) console.log(JSON.stringify(r));
} else {
  const out = arg('--out'), done = new Set(fs.existsSync(out) ? fs.readFileSync(out, 'utf8').split('\n').filter((l) => l.startsWith('#')).map((l) => l.slice(1)) : []);
  const rows = fs.readFileSync(arg('--list'), 'utf8').split('\n').filter(Boolean).map((l) => { const [size, ...p] = l.split('\t'); return { size: +size, path: p.join('\t') }; })
    .filter((r) => !done.has(r.path) && r.size <= +(process.env.MAX_MB || 50) * 1e6 && /\.(ste?p|igs|iges)$/i.test(r.path));
  const jobs = +(process.env.JOBS || 4); let next = 0, n = 0; const t0 = Date.now();
  console.error(`${rows.length} files to run (${done.size} done), ${jobs} at a time`);
  await Promise.all(Array.from({ length: jobs }, async () => {
    while (next < rows.length) {
      const r = rows[next++];
      const text = await new Promise((res) => execFile(process.execPath, [process.argv[1], '--one', r.path], { timeout: Math.round((120 + 4 * r.size / 1e6) * 1000), maxBuffer: 1 << 28, env: process.env }, (err, stdout) => res(err ? '' : stdout)));
      fs.appendFileSync(out, text + `#${r.path}\n`);
      if (++n % 100 === 0) console.error(`${n}/${rows.length} in ${((Date.now() - t0) / 60000).toFixed(1)} min`);
    }
  }));
}
