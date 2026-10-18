/**
 * STEP/IGES/BREP import via occt-import-js (WASM OpenCascade).
 *
 * importCadFile() tessellates a CAD file buffer into one merged, welded
 * triangle mesh plus per-B-rep-face triangle ranges — the exact shape that
 * ModelDocument.addAsset() stores and the imported_mesh / extrude_face
 * blocks consume.
 */

import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { weldVertices, positionsBBox } from './mesh.js';

/**
 * importCadFile in its own worker thread: the server stays responsive, and
 * every import gets a fresh WASM heap (the importer's heap never shrinks).
 * The 32-bit heap caps at 2–4 GB, so a very large file fails here with a
 * message that says so instead of "not a valid STEP".
 */
export function importCadFileInWorker(buffer, opts = {}, { timeoutMs = 600_000 } = {}) {
  return new Promise((resolve, reject) => {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const copy = new Uint8Array(bytes.byteLength); copy.set(bytes); // transfer our own copy, not the caller's
    const w = new Worker(fileURLToPath(new URL('./stepworker.js', import.meta.url)), { workerData: { buffer: copy, opts }, transferList: [copy.buffer] });
    const mb = (bytes.byteLength / 1048576).toFixed(0);
    const timer = setTimeout(() => { w.terminate(); reject(new Error(`Gave up reading '${opts.name || 'file'}' (${mb} MB) after ${timeoutMs / 1000} s`)); }, timeoutMs);
    const done = (fn) => (v) => { clearTimeout(timer); fn(v); };
    w.once('message', done((msg) => msg.ok ? resolve(msg.m) : reject(new Error(outOfMemory(msg.error) ? tooBig(opts.name, mb) : msg.error))));
    w.once('error', done((e) => reject(new Error(outOfMemory(e?.message) ? tooBig(opts.name, mb) : String(e?.message || e)))));
    w.once('exit', (code) => { if (code !== 0) done(reject)(new Error(tooBig(opts.name, mb))); });
  });
}
const outOfMemory = (msg) => /malloc failed|out of memory|Cannot enlarge memory|Aborted/i.test(String(msg || ''));
const tooBig = (name, mb) => `'${name || 'file'}' (${mb} MB) is too big for the built-in importer, which ran out of memory — export it lighter (fewer parts, no PCB copper detail) and it will open`;

let occtPromise = null;

/** One-time async WASM init (~70ms); afterwards calls are synchronous. */
function getOcct() {
  occtPromise ??= import('occt-import-js').then((m) => m.default());
  return occtPromise;
}

function readerFor(occt, name = '') {
  const ext = String(name).toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  if (ext === 'igs' || ext === 'iges') return occt.ReadIgesFile.bind(occt);
  if (ext === 'brep') return occt.ReadBrepFile.bind(occt);
  return occt.ReadStepFile.bind(occt);
}

/**
 * buffer: Buffer|Uint8Array of the CAD file.
 * Options: name (filename, picks the reader by extension), linearDeflection
 * (bounding-box ratio, smaller = finer), angularDeflection (radians).
 * Returns { name, positions, normals, indices, faces:[{first,count}], bbox,
 *           vertexCount, triangleCount, faceCount } with plain JSON arrays.
 */
export async function importCadFile(buffer, { name = 'import.step', linearDeflection = 0.001, angularDeflection = 0.5 } = {}) {
  const occt = await getOcct();
  const read = readerFor(occt, name);
  const result = read(new Uint8Array(buffer), {
    linearUnit: 'millimeter',
    linearDeflectionType: 'bounding_box_ratio',
    linearDeflection,
    angularDeflection,
  });
  if (!result?.success || !result.meshes?.length) {
    // The importer swallows its own out-of-memory (a 465 MB PCB export: 10 M
    // entities, 14k solids) and reports plain failure; size tells the two apart.
    const mb = buffer.byteLength / 1048576;
    if (mb > 150) throw new Error(tooBig(name, mb.toFixed(0)));
    throw new Error(`Could not read '${name}' — not a valid STEP/IGES/BREP file?`);
  }

  // Merge sub-meshes, re-offsetting vertex indices and face triangle ranges.
  let vTotal = 0, iTotal = 0;
  for (const m of result.meshes) {
    vTotal += m.attributes.position.array.length / 3;
    iTotal += m.index.array.length;
  }
  const positions = new Float32Array(vTotal * 3);
  // OCCT's exact surface normals; null if any mesh lacks them (the viewer then averages its own).
  let normals = result.meshes.every((m) => m.attributes.normal?.array?.length === m.attributes.position.array.length) ? new Float32Array(vTotal * 3) : null;
  const indices = new Uint32Array(iTotal);
  const faces = [];
  const bodies = []; // one per imported solid: {first, count, name} in triangles
  let vOff = 0, iOff = 0;
  for (const m of result.meshes) {
    positions.set(m.attributes.position.array, vOff * 3);
    normals?.set(m.attributes.normal.array, vOff * 3);
    const idx = m.index.array;
    for (let i = 0; i < idx.length; i++) indices[iOff + i] = idx[i] + vOff;
    const triOff = iOff / 3, triCount = idx.length / 3;
    // OCCT's writer names unnamed solids after itself ("Open CASCADE STEP translator 7.6 1.2"); say "body 2".
    const raw = String(m.name || '').trim();
    const color = Array.isArray(m.color) && m.color.length === 3 ? m.color.map((c) => +c.toFixed(3)) : null;
    bodies.push({ first: triOff, count: triCount, name: raw && !/^Open CASCADE/i.test(raw) ? raw : `body ${bodies.length + 1}`, color });
    const brep = Array.isArray(m.brep_faces) && m.brep_faces.length ? m.brep_faces : null;
    if (brep) {
      for (const f of brep) {
        const count = f.last - f.first + 1;
        if (count > 0) faces.push({ first: triOff + f.first, count });
      }
    } else {
      faces.push({ first: triOff, count: triCount });
    }
    vOff += m.attributes.position.array.length / 3;
    iOff += idx.length;
  }

  // Groups: the importer flattens nested assemblies, so read the product tree from the STEP text itself.
  if (!/\.(igs|iges|brep)$/i.test(name)) {
    const parents = stepParents(buffer);
    for (const b of bodies) { const p = parents.get(b.name); if (p?.length) b.path = p; }
  }

  // Weld duplicated vertices along B-rep face borders (triangle order is
  // preserved, so the face ranges stay valid).
  const bbox = positionsBBox(positions);
  const diag = bbox ? Math.hypot(bbox.max[0] - bbox.min[0], bbox.max[1] - bbox.min[1], bbox.max[2] - bbox.min[2]) : 1;
  const welded = weldVertices(positions, indices, Math.max(diag * 1e-6, 1e-5), normals);

  return {
    name,
    positions: Array.from(welded.positions),
    normals: welded.normals ? Array.from(welded.normals) : null,
    indices: Array.from(welded.indices),
    faces,
    bodies,
    bbox,
    vertexCount: welded.positions.length / 3,
    triangleCount: welded.indices.length / 3,
    faceCount: faces.length,
  };
}

/**
 * The assembly path of each product in a STEP file, from its text: PRODUCT names joined through
 * PRODUCT_DEFINITION(_FORMATION) and NEXT_ASSEMBLY_USAGE_OCCURRENCE (parent → child). Returns
 * Map(product name → [group, subgroup, …]) without the single top assembly, and without a wrapper
 * that holds only that one part (cadquery writes every part as `name` → `name_part`).
 * ponytail: a product used under several parents takes its first one; instance paths if that matters.
 */
export function stepParents(buffer) {
  const out = new Map();
  if (buffer.byteLength > 200 * 1048576) return out;   // the importer refuses these anyway
  const text = Buffer.from(buffer.buffer ?? buffer, buffer.byteOffset ?? 0, buffer.byteLength).toString('latin1');
  if (!text.includes('NEXT_ASSEMBLY_USAGE_OCCURRENCE')) return out;
  const unq = (s) => s.replace(/''/g, "'").replace(/\\X2\\([0-9A-F]+)\\X0\\/g, (_, h) => String.fromCharCode(...h.match(/.{4}/g).map((x) => parseInt(x, 16))));
  const prod = new Map(), formation = new Map(), def = new Map(), up = new Map(), kids = new Map();
  for (const m of text.matchAll(/#(\d+)\s*=\s*PRODUCT\s*\(\s*'((?:[^']|'')*)'/g)) prod.set(m[1], unq(m[2]));
  for (const m of text.matchAll(/#(\d+)\s*=\s*PRODUCT_DEFINITION_FORMATION(?:_WITH_SPECIFIED_SOURCE)?\s*\([^;]*?#(\d+)\s*(?:,\s*\.\w+\.\s*)?\)\s*;/g)) formation.set(m[1], m[2]);
  for (const m of text.matchAll(/#(\d+)\s*=\s*PRODUCT_DEFINITION\s*\(\s*'(?:[^']|'')*'\s*,\s*'(?:[^']|'')*'\s*,\s*#(\d+)/g)) def.set(m[1], prod.get(formation.get(m[2])));
  for (const m of text.matchAll(/NEXT_ASSEMBLY_USAGE_OCCURRENCE\s*\([^#;]*#(\d+)\s*,\s*#(\d+)/g)) {
    const parent = def.get(m[1]), child = def.get(m[2]);
    if (parent == null || child == null) continue;
    if (!up.has(child)) up.set(child, parent);
    kids.set(parent, (kids.get(parent) ?? 0) + 1);
  }
  const tops = new Set([...up.values()].filter((p) => !up.has(p)));
  for (const child of up.keys()) {
    const path = [];
    for (let p = up.get(child), guard = 0; p != null && guard < 64; p = up.get(p), guard++) path.unshift(p);
    if (tops.size === 1 && tops.has(path[0])) path.shift();
    if (path.length && kids.get(path[path.length - 1]) === 1 && !kids.has(child)) path.pop();
    out.set(child, path);
  }
  return out;
}
