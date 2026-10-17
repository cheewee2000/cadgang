// Explode harness on a real file: `node test/explode.harness.mjs path/to/assembly.step` prints each body's vector and counts points of one body inside another at half and full explode.
import fs from 'node:fs';
import * as THREE from 'three';
const R = new URL('..', import.meta.url).pathname;
const { importCadFile } = await import(`${R}/src/core/step.js`);
const { explodeOffsets } = await import(`${R}/web/explode.js`);
const file = process.argv[2];
const m = await importCadFile(fs.readFileSync(file), { name: file.split('/').pop(), linearDeflection: parseFloat(process.env.DEFL || "0.002") });
const pos = m.positions, idx = m.indices;
const bodies = m.bodies.map((b) => {
  const map = new Map(), oi = new Uint32Array(b.count * 3), op = [];
  for (let i = 0; i < b.count * 3; i++) { const v = idx[b.first * 3 + i]; let j = map.get(v); if (j === undefined) { j = map.size; map.set(v, j); op.push(pos[3 * v], pos[3 * v + 1], pos[3 * v + 2]); } oi[i] = j; }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(op, 3)); g.setIndex(new THREE.BufferAttribute(oi, 1));
  const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide })); mesh.userData.name = b.name;   // double-sided like the viewer
  mesh.userData.faces = m.faces.filter((f) => f.first >= b.first && f.first < b.first + b.count).map((f) => ({ first: f.first - b.first, count: f.count }));
  return mesh;
});
const box = new THREE.Box3(); for (const b of bodies) { b.geometry.computeBoundingBox(); box.union(b.geometry.boundingBox); }
const centre = box.getCenter(new THREE.Vector3());
const t0 = Date.now(); explodeOffsets(bodies, centre); const ms = Date.now() - t0;
console.log(`${file.split('/').pop()}: ${bodies.length} bodies, ${idx.length / 3} tris, solved in ${ms} ms, size ${box.getSize(new THREE.Vector3()).toArray().map((v) => v.toFixed(0))}`);
const place = (k) => { const done = new Set(); const p = (b) => { if (done.has(b)) return b.position; done.add(b); b.position.copy(b.userData.offset).multiplyScalar(k * 2); if (b.userData.parent) b.position.add(p(b.userData.parent)); return b.position; }; for (const b of bodies) p(b); for (const b of bodies) b.updateMatrixWorld(true); };
for (const b of bodies) { const o = b.userData.offset, d = o.length() ? o.clone().normalize().toArray().map((v) => v.toFixed(2)) : '-'; console.log(`  ${b.userData.name.padEnd(22).slice(0, 22)} at ${b.geometry.boundingBox.getCenter(new THREE.Vector3()).toArray().map((v) => v.toFixed(0)).join(",").padEnd(14)} len ${o.length().toFixed(1).padStart(7)} dir ${String(d).padEnd(18)} ${b.userData.parent ? 'rides ' + b.userData.parent.userData.name : ''}`); }
// collisions: sample vertices of A inside B (ray parity along +X)
const ray = new THREE.Raycaster();
const inside = (p, B) => { ray.set(p, new THREE.Vector3(1, 0, 0)); return ray.intersectObject(B, false).length % 2 === 1; };
for (const k of [0.5, 1]) {
  place(k); const bad = [];
  for (const A of bodies) for (const B of bodies) {
    if (A === B) continue;
    const bA = A.geometry.boundingBox.clone().translate(A.position), bB = B.geometry.boundingBox.clone().translate(B.position);
    if (!bA.intersectsBox(bB)) continue;
    const P = A.geometry.getAttribute('position'), n = P.count, step = Math.max(1, Math.floor(n / 150)); let hits = 0, tested = 0;
    for (let i = 0; i < n; i += step) { const p = new THREE.Vector3().fromBufferAttribute(P, i).add(A.position); if (!bB.containsPoint(p)) continue; tested++; if (inside(p, B)) hits++; }
    if (hits) bad.push(`${A.userData.name} in ${B.userData.name}: ${hits}/${tested}`);
  }
  console.log(`  k=${k}: ${bad.length ? 'COLLIDING ' + bad.join(' | ') : 'no collisions'}`);
}
