// The explode solver scored against AutoMate's mates (compute/README.md, stage 1).
//   node compute/automate/explode.automate.mjs --root DIR --one ID [--dump OUT]                    one assembly, one JSON line
//   JOBS=n node compute/automate/explode.automate.mjs --root DIR --list ids.txt --out run.jsonl [--dump OUT]   all of them, resumable
// DIR holds assemblies/<id>.json and step/<part>.step as unzipped from the dataset. HINTS=1 feeds the mates to the solver as
// joints. EXPLODE=path runs another solver copy. SCALE converts the metadata's metres to the mesh's mm (1000).
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import * as THREE from 'three';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const root = arg('--root', process.env.AUTOMATE || `${process.env.HOME}/cadgang-corpus/automate`);
const R = new URL('../..', import.meta.url).pathname;
const SCALE = parseFloat(process.env.SCALE || '1000'), DEFL = parseFloat(process.env.DEFL || '0.0008');
const AXIAL = new Set(['SLIDER', 'CYLINDRICAL', 'REVOLUTE', 'PIN_SLOT']);
const HINT = { SLIDER: 'slider', CYLINDRICAL: 'cylindrical', REVOLUTE: 'revolute', BALL: 'ball', FASTENED: 'fixed' };
const KS = [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1];

async function one(id, dump) {
  const { importCadFile } = await import(`${R}/src/core/step.js`);
  const { explodeOffsets } = await import(process.env.EXPLODE ? `${R}/${process.env.EXPLODE}` : `${R}/web/explode.js`);
  const A = JSON.parse(fs.readFileSync(`${root}/assemblies/${id}.json`, 'utf8'));
  const t0 = Date.now(), bodies = [], byOcc = new Map(), parts = new Map();
  for (const [oi, o] of A.occurrences.entries()) {
    if (o.hidden || !o.has_step) continue;
    const p = A.parts[o.part];
    if (!parts.has(o.part)) parts.set(o.part, await importCadFile(fs.readFileSync(`${root}/step/${p.id}.step`), { name: `${p.id}.step`, linearDeflection: DEFL }));
    const m = parts.get(o.part); if (!m.positions?.length) continue;
    const T = new THREE.Matrix4().set(...o.transform);   // row-major in the json, as set() takes it
    T.elements[12] *= SCALE; T.elements[13] *= SCALE; T.elements[14] *= SCALE;
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(Float32Array.from(m.positions), 3)); g.setIndex(new THREE.BufferAttribute(Uint32Array.from(m.indices), 1)); g.applyMatrix4(T);
    const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
    mesh.userData.name = o.id; mesh.userData.faces = m.faces.map((f) => ({ first: f.first, count: f.count })); mesh.userData.T = T; mesh.userData.occ = oi; mesh.userData.part = p.id;
    bodies.push(mesh); byOcc.set(oi, mesh);
  }
  if (bodies.length < 2) return { id, bodies: bodies.length, error: 'fewer than two bodies with geometry' };
  const box = new THREE.Box3(); for (const b of bodies) { b.geometry.computeBoundingBox(); box.union(b.geometry.boundingBox); }
  const size = box.getSize(new THREE.Vector3()).length(), centre = box.getCenter(new THREE.Vector3());
  const diag = (b) => b.geometry.boundingBox.getSize(new THREE.Vector3()).length();
  // a mate's frame on an occurrence, taken as that part's own coordinates: z is the mate axis
  const frame = (oi, mcf, transform = true) => {
    const M = new THREE.Matrix4().set(...mcf), T = transform ? byOcc.get(oi).userData.T : new THREE.Matrix4();
    return { axis: new THREE.Vector3(M.elements[8], M.elements[9], M.elements[10]).transformDirection(T), origin: new THREE.Vector3(M.elements[12], M.elements[13], M.elements[14]).multiplyScalar(SCALE).applyMatrix4(T) };
  };
  const mates = A.mates.filter((mt) => mt.has_step && mt.occurrences.length === 2 && mt.occurrences.every((oi) => byOcc.has(oi)))
    .map((mt) => { const [a, b] = mt.occurrences.map((oi) => byOcc.get(oi)); const [small, big] = diag(a) <= diag(b) ? [a, b] : [b, a]; return { type: mt.mateType, a, b, small, big, ...frame(mt.occurrences[0], mt.mcfs[0]), agree: frame(mt.occurrences[0], mt.mcfs[0]).origin.distanceTo(frame(mt.occurrences[1], mt.mcfs[1]).origin) / size, agreeRaw: frame(mt.occurrences[0], mt.mcfs[0], false).origin.distanceTo(frame(mt.occurrences[1], mt.mcfs[1], false).origin) / size }; });
  const hints = new Map();
  if (process.env.HINTS === '1') for (const mt of mates) if (HINT[mt.type] && !hints.has(mt.small)) hints.set(mt.small, { type: HINT[mt.type], axis: mt.axis.clone(), origin: mt.origin.clone(), parent: mt.big });
  const t1 = Date.now(); explodeOffsets(bodies, centre, hints); const solveMs = Date.now() - t1;
  // score: along the mate axis for axial mates, together for fastened ones
  const rides = (P, Q) => { for (let x = P.userData.parent, n = 0; x && n <= bodies.length; x = x.userData.parent, n++) if (x === Q) return true; return false; };
  const dir = (b) => (b.userData.offset?.length() ? b.userData.offset.clone().normalize() : null);
  let axialN = 0, axialOk = 0, fastN = 0, fastOk = 0; const mateRows = [];
  for (const mt of mates) {
    const d = dir(mt.small), dot = d ? Math.abs(d.dot(mt.axis)) : 0, together = rides(mt.a, mt.b) || rides(mt.b, mt.a) || (dir(mt.a) && dir(mt.b) && dir(mt.a).dot(dir(mt.b)) > 0.95);
    if (AXIAL.has(mt.type)) { axialN++; if (dot > 0.95) axialOk++; }
    if (mt.type === 'FASTENED') { fastN++; if (together) fastOk++; }
    mateRows.push({ type: mt.type, occs: [mt.a.userData.occ, mt.b.userData.occ], axis: mt.axis.toArray().map((v) => +v.toFixed(4)), origin: mt.origin.toArray().map((v) => +v.toFixed(3)), dot: +dot.toFixed(3), together: !!together });
  }
  // collisions, as test/explode.harness.mjs counts them: vertices of A inside B at each slider position, staged like the viewer
  const S = 1 + Math.max(0, ...bodies.map((b) => b.userData.stage ?? 0)), frac = (b, k) => (S < 2 ? k : Math.min(1, Math.max(0, k * S - (b.userData.stage ?? 0))));
  const place = (k) => { const done = new Set(); const p = (b) => { if (done.has(b)) return b.position; done.add(b); b.position.copy(b.userData.offset ?? new THREE.Vector3()).multiplyScalar(frac(b, k) * 2); if (b.userData.parent) b.position.add(p(b.userData.parent)); return b.position; }; for (const b of bodies) p(b); for (const b of bodies) b.updateMatrixWorld(true); };
  const ray = new THREE.Raycaster(), inside = (p, B) => { ray.set(p, new THREE.Vector3(1, 0, 0)); return ray.intersectObject(B, false).length % 2 === 1; };
  const pairsAt = (k) => {
    place(k); const bad = new Set();
    for (const A of bodies) for (const B of bodies) {
      if (A === B) continue;
      const bA = A.geometry.boundingBox.clone().translate(A.position), bB = B.geometry.boundingBox.clone().translate(B.position);
      if (!bA.intersectsBox(bB)) continue;
      const P = A.geometry.getAttribute('position'), n = P.count, step = Math.max(1, Math.floor(n / 150));
      for (let i = 0; i < n; i += step) { const p = new THREE.Vector3().fromBufferAttribute(P, i).add(A.position); if (bB.containsPoint(p) && inside(p, B)) { bad.add([A.userData.occ, B.userData.occ].sort().join('~')); break; } }
    }
    return bad;
  };
  const at0 = pairsAt(0), caused = new Set(); let stillAtK1 = 0;
  for (const k of KS.slice(1)) { const c = [...pairsAt(k)].filter((x) => !at0.has(x)); c.forEach((x) => caused.add(x)); if (k === 1) stillAtK1 = c.length; }
  if (dump) {
    fs.mkdirSync(dump, { recursive: true }); let first = 0; const partRows = [], buf = [];
    for (const b of bodies) { const P = b.geometry.getAttribute('position'); partRows.push({ occ: b.userData.occ, part: b.userData.part, first, count: P.count, bbox: [...b.geometry.boundingBox.min.toArray(), ...b.geometry.boundingBox.max.toArray()].map((v) => +v.toFixed(3)) }); first += P.count; buf.push(P.array); }
    const all = new Float32Array(first * 3); let o = 0; for (const a of buf) { all.set(a, o); o += a.length; }
    fs.writeFileSync(`${dump}/${id}.f32`, Buffer.from(all.buffer));
    fs.writeFileSync(`${dump}/${id}.json`, JSON.stringify({ id, parts: partRows, mates: mateRows, solve: bodies.map((b) => ({ occ: b.userData.occ, dir: dir(b)?.toArray().map((v) => +v.toFixed(4)) ?? null, len: +(b.userData.offset?.length() ?? 0).toFixed(3), parent: b.userData.parent?.userData.occ ?? null, stage: b.userData.stage ?? 0 })) }));
  }
  const med = (xs) => (xs.length ? xs.sort((a, b) => a - b)[xs.length >> 1] : null);
  return { id, bodies: bodies.length, tris: bodies.reduce((n, b) => n + b.geometry.index.count / 3, 0), ms: Date.now() - t0, solveMs, mates: mates.length, axialN, axialOk, fastN, fastOk, modelOverlaps: at0.size, caused: caused.size, stillAtK1, mcfAgree: med(mates.map((m) => +m.agree.toFixed(4))), mcfAgreeRaw: med(mates.map((m) => +m.agreeRaw.toFixed(4))) };
}

if (arg('--one')) {
  console.log(JSON.stringify(await one(arg('--one'), arg('--dump')).catch((e) => ({ id: arg('--one'), error: String(e.message ?? e).slice(0, 300) }))));
} else {
  const out = arg('--out'), done = new Set(fs.existsSync(out) ? fs.readFileSync(out, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).id) : []);
  const ids = fs.readFileSync(arg('--list'), 'utf8').split('\n').filter((x) => x && !done.has(x)), jobs = +(process.env.JOBS || 4);
  let next = 0, n = 0; const t0 = Date.now();
  console.error(`${ids.length} assemblies to run (${done.size} done), ${jobs} at a time`);
  await Promise.all(Array.from({ length: jobs }, async () => {
    while (next < ids.length) {
      const id = ids[next++], bodies = +(JSON.parse(fs.readFileSync(`${root}/assemblies/${id}.json`, 'utf8')).n_occurrences ?? 20);
      const args = [process.argv[1], '--root', root, '--one', id, ...(arg('--dump') ? ['--dump', arg('--dump')] : [])];
      const line = await new Promise((res) => execFile(process.execPath, args, { timeout: Math.round((120 + 2 * bodies) * 1000), maxBuffer: 1 << 24, env: process.env }, (err, stdout) => res(stdout.trim().split('\n').pop() || JSON.stringify({ id, error: err ? (err.killed ? 'timeout' : String(err.message).slice(0, 300)) : 'no output' }))));
      fs.appendFileSync(out, line + '\n');
      if (++n % 100 === 0) console.error(`${n}/${ids.length} in ${((Date.now() - t0) / 60000).toFixed(1)} min`);
    }
  }));
}
