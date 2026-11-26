// A draped garment (src/core/softgoods-drape.js) written as binary glTF 2.0 and as OBJ + MTL, for a renderer or another
// cloth tool. One mesh per pattern piece, named after it, with normals, the pattern coordinate as its texture coordinate
// and one material per fabric. The solver works in mm with z up and the body facing -y; both files are in metres with
// +Y up and the body facing +Z, which is what glTF asks for: (x, y, z) mm becomes (x, z, -y) / 1000.
// Texture coordinates: one unit is `textureMm` of cloth (1000 by default), so a texture that pictures a `textureMm`
// square of fabric lies on the cloth at 1:1. OBJ has v up like the pattern's y: (x, y) / textureMm. glTF has v down
// from the image's top: (x / textureMm, 1 - y / textureMm). Both show the fabric the same way round.

import fs from 'node:fs';
import path from 'node:path';
import { GraphError } from './errors.js';
import { resolveMaterials } from './softgoods-fabrics.js';

export const DRAPE_FORMATS = ['glb', 'obj', 'fit'];

const M = 0.001;
const GREY = [0.8, 0.8, 0.8], BODY = [0.6, 0.6, 0.6];
const colourOf = (hex) => { const m = /^#([0-9a-f]{6})$/i.exec(String(hex || '')); return m ? [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255) : null; };
const linear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/** A unit normal per vertex: the mean of its triangles' normals, weighted by their areas. */
function normalsOf(positions, indices) {
  const n = new Float32Array(positions.length);
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3, ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2], vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
    const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx;
    for (const i of [a, b, c]) { n[i] += x; n[i + 1] += y; n[i + 2] += z; }
  }
  for (let i = 0; i < n.length; i += 3) { const l = Math.hypot(n[i], n[i + 1], n[i + 2]); if (l > 0) { n[i] /= l; n[i + 1] /= l; n[i + 2] /= l; } else n[i + 1] = 1; }
  return n;
}

function clothPart(piece, thicknessMm, textureMm) {
  const n = piece.count, flat = new Float32Array(n * 3), uv = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) { flat[i * 3] = piece.positions[i * 3] * M; flat[i * 3 + 1] = piece.positions[i * 3 + 2] * M; flat[i * 3 + 2] = -piece.positions[i * 3 + 1] * M; uv[i * 2] = piece.uv[i * 2] / textureMm; uv[i * 2 + 1] = piece.uv[i * 2 + 1] / textureMm; }
  const part = { name: piece.id, title: piece.name, material: piece.material || 'cloth', positions: flat, normals: normalsOf(flat, piece.triangles), uv, indices: piece.triangles, strain: piece.strain, pressure: piece.pressure };
  if (!(thicknessMm > 0)) return part;
  // A shell: the surface moved half the thickness out along its normals, a second one half the thickness in and facing
  // the other way, and a wall round every edge of the piece (an edge only one triangle has).
  const h = thicknessMm * M / 2, twice = (a, size) => { const out = new Float32Array(a.length * 2); out.set(a); out.set(a, n * size); return out; };
  const positions = twice(flat, 3), normals = twice(part.normals, 3), tris = piece.triangles, edges = new Set(), indices = [];
  for (let i = 0; i < n * 3; i++) { positions[i] += part.normals[i] * h; positions[n * 3 + i] -= part.normals[i] * h; normals[n * 3 + i] = -part.normals[i]; }
  for (let t = 0; t < tris.length; t += 3) { indices.push(tris[t], tris[t + 1], tris[t + 2], tris[t] + n, tris[t + 2] + n, tris[t + 1] + n); for (let k = 0; k < 3; k++) edges.add(tris[t + k] * n + tris[t + (k + 1) % 3]); }
  for (const e of edges) { const a = Math.floor(e / n), b = e % n; if (!edges.has(b * n + a)) indices.push(a, a + n, b + n, a, b + n, b); }
  return { ...part, positions, normals, uv: twice(uv, 2), indices: Uint32Array.from(indices), strain: twice(part.strain, 1), pressure: twice(part.pressure, 1) };
}

/** One of the avatar's shapes as a mesh: an ellipsoid, or a capsule (a sphere pulled apart along its axis). */
function bodyPart(shape, around = 24, rings = 12) {
  const capsule = shape.type === 'capsule', norm = (v) => { const l = Math.hypot(...v) || 1; return v.map((x) => x / l); };
  const w = capsule ? norm([0, 1, 2].map((k) => shape.b[k] - shape.a[k])) : [0, 0, 1], seed = Math.abs(w[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const u = norm([seed[1] * w[2] - seed[2] * w[1], seed[2] * w[0] - seed[0] * w[2], seed[0] * w[1] - seed[1] * w[0]]), v = [w[1] * u[2] - w[2] * u[1], w[2] * u[0] - w[0] * u[2], w[0] * u[1] - w[1] * u[0]];
  const rows = []; for (let i = 0; i <= rings; i++) { const lat = -Math.PI / 2 + Math.PI * i / rings; if (!capsule) rows.push([lat, shape.c]); else { if (i <= rings / 2) rows.push([lat, shape.a]); if (i >= rings / 2) rows.push([lat, shape.b]); } }
  const positions = new Float32Array(rows.length * around * 3), indices = [];
  rows.forEach(([lat, centre], r) => { for (let j = 0; j < around; j++) { const phi = 2 * Math.PI * j / around, d = [0, 1, 2].map((k) => Math.cos(lat) * (Math.cos(phi) * u[k] + Math.sin(phi) * v[k]) + Math.sin(lat) * w[k]), p = [0, 1, 2].map((k) => centre[k] + d[k] * (capsule ? shape.r : shape.r[k])), o = (r * around + j) * 3; positions[o] = p[0] * M; positions[o + 1] = p[2] * M; positions[o + 2] = -p[1] * M; } });
  for (let r = 0; r < rows.length - 1; r++) for (let j = 0; j < around; j++) { const a = r * around + j, b = r * around + (j + 1) % around, c = b + around, d = a + around; if (r) indices.push(a, b, c); if (r < rows.length - 2) indices.push(a, c, d); }
  const ix = Uint32Array.from(indices);
  return { name: shape.name || shape.type, material: 'body', group: 'avatar', positions, normals: normalsOf(positions, ix), uv: null, indices: ix };
}

/** The draped pieces, and the avatar's shapes if asked, as meshes in metres with +Y up, and the materials they use. */
export function drapeScene(document, drape, { thickness = false, avatar = false, textureMm = 1000 } = {}) {
  if (!(Number(textureMm) > 0)) throw new GraphError('textureMm must be greater than zero');
  const fabrics = resolveMaterials(document.materials), fabric = (name) => fabrics[name] || {};
  const parts = drape.pieces.map((p) => clothPart(p, thickness ? Number(fabric(p.material).thickness || fabric(p.material).thicknessMm || 0.6) : 0, Number(textureMm)));
  if (avatar) for (const s of drape.body?.shapes || []) parts.push(bodyPart(s));
  const materials = [...new Set(parts.map((p) => p.material))].map((name) => ({ name, colour: name === 'body' && !fabrics.body ? BODY : colourOf(fabric(name).color) || GREY }));
  return { parts, materials, units: 'm', up: '+Y', front: '+Z', uv: { mmPerUnit: Number(textureMm), obj: '(x, y) / mmPerUnit', gltf: '(x / mmPerUnit, 1 - y / mmPerUnit)' }, thickness: !!thickness, avatar: !!avatar && parts.some((p) => p.group === 'avatar') };
}

/** Binary glTF 2.0: a 12-byte header, the JSON chunk, the BIN chunk. Typed arrays are written as they lie in memory, which is little-endian on every machine this runs on. */
export function drapeGLB(scene, name = 'softgoods') {
  const bytes = [], bufferViews = [], accessors = []; let length = 0;
  const add = (array, type, target, bounds = false) => {
    const size = { SCALAR: 1, VEC2: 2, VEC3: 3 }[type], accessor = { bufferView: bufferViews.length, componentType: array instanceof Uint32Array ? 5125 : 5126, count: array.length / size, type };
    if (bounds) { accessor.min = Array(size).fill(Infinity); accessor.max = Array(size).fill(-Infinity); for (let i = 0; i < array.length; i++) { accessor.min[i % size] = Math.min(accessor.min[i % size], array[i]); accessor.max[i % size] = Math.max(accessor.max[i % size], array[i]); } }
    bufferViews.push({ buffer: 0, byteOffset: length, byteLength: array.byteLength, target }); bytes.push(Buffer.from(array.buffer, array.byteOffset, array.byteLength)); length += array.byteLength;
    return accessors.push(accessor) - 1;
  };
  const nodes = [], meshes = [], groups = new Map();
  for (const p of scene.parts) {
    const attributes = { POSITION: add(p.positions, 'VEC3', 34962, true), NORMAL: add(p.normals, 'VEC3', 34962) };
    if (p.uv) attributes.TEXCOORD_0 = add(Float32Array.from(p.uv, (x, i) => (i % 2 ? 1 - x : x)), 'VEC2', 34962);
    if (p.strain) attributes._STRAIN = add(p.strain, 'SCALAR', 34962); if (p.pressure) attributes._PRESSURE = add(p.pressure, 'SCALAR', 34962);
    meshes.push({ name: p.name, primitives: [{ attributes, indices: add(p.indices, 'SCALAR', 34963), material: scene.materials.findIndex((m) => m.name === p.material), mode: 4 }] });
    const group = p.group || 'garment'; if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(nodes.push({ name: p.name, mesh: meshes.length - 1, ...(p.title && p.title !== p.name ? { extras: { title: p.title } } : {}) }) - 1);
  }
  const roots = [...groups].map(([group, children]) => nodes.push({ name: group, children }) - 1);
  const json = { asset: { version: '2.0', generator: 'CADgang softgoods' }, scene: 0, scenes: [{ name, nodes: roots, extras: { units: scene.units, up: scene.up, front: scene.front, uv: scene.uv, attributes: { _STRAIN: 'ratio', _PRESSURE: 'Pa' } } }], nodes, meshes,
    materials: scene.materials.map((m) => ({ name: m.name, pbrMetallicRoughness: { baseColorFactor: [...m.colour.map(linear), 1], metallicFactor: 0, roughnessFactor: 0.9 }, doubleSided: true })), accessors, bufferViews, buffers: [{ byteLength: length }] };
  let text = Buffer.from(JSON.stringify(json)); text = Buffer.concat([text, Buffer.alloc((4 - text.length % 4) % 4, 0x20)]);
  const head = Buffer.alloc(20); head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(28 + text.length + length, 8); head.writeUInt32LE(text.length, 12); head.writeUInt32LE(0x4e4f534a, 16);
  const bin = Buffer.alloc(8); bin.writeUInt32LE(length, 0); bin.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([head, text, bin, ...bytes]);
}

/** Wavefront OBJ with an object and a group per piece, and its MTL (base colour only). */
export function drapeOBJ(scene, name = 'softgoods') {
  const safe = (s) => String(s).replace(/\s+/g, '_'), f = (x, d = 6) => +x.toFixed(d), out = [`# CADgang softgoods drape · units ${scene.units} · ${scene.up} up · front ${scene.front} · vt = pattern ${scene.uv.obj}, mmPerUnit ${scene.uv.mmPerUnit}`, `mtllib ${name}.mtl`];
  let v = 0, vt = 0;
  for (const p of scene.parts) {
    const n = p.positions.length / 3; out.push(`o ${safe(p.name)}`, `g ${safe(p.name)}`, `usemtl ${safe(p.material)}`);
    for (let i = 0; i < n; i++) out.push(`v ${f(p.positions[i * 3])} ${f(p.positions[i * 3 + 1])} ${f(p.positions[i * 3 + 2])}`);
    if (p.uv) for (let i = 0; i < n; i++) out.push(`vt ${f(p.uv[i * 2])} ${f(p.uv[i * 2 + 1])}`);
    for (let i = 0; i < n; i++) out.push(`vn ${f(p.normals[i * 3], 4)} ${f(p.normals[i * 3 + 1], 4)} ${f(p.normals[i * 3 + 2], 4)}`);
    const corner = (i) => `${v + i + 1}/${p.uv ? vt + i + 1 : ''}/${v + i + 1}`;
    for (let t = 0; t < p.indices.length; t += 3) out.push(`f ${corner(p.indices[t])} ${corner(p.indices[t + 1])} ${corner(p.indices[t + 2])}`);
    v += n; if (p.uv) vt += n;
  }
  return { obj: out.join('\n') + '\n', mtl: scene.materials.map((m) => `newmtl ${safe(m.name)}\nKd ${m.colour.map((c) => f(c, 4)).join(' ')}\nd 1\nillum 1\n`).join('\n') };
}

/** Write the drape beside the patterns: <name>_drape.glb and/or <name>_drape.obj + .mtl. */
export function exportDrape(document, drape, dir, name, { formats = ['glb'], ...options } = {}) {
  if (!/^[\w.-]+$/.test(name)) throw new GraphError('Export name may contain letters, digits, dot, dash and underscore only');
  fs.mkdirSync(dir, { recursive: true });
  const scene = drapeScene(document, drape, options), base = `${name}_drape`, files = [], write = (ext, data) => { const file = path.join(dir, `${base}.${ext}`); fs.writeFileSync(file, data); files.push(file); };
  if (formats.includes('glb')) write('glb', drapeGLB(scene, name));
  if (formats.includes('obj')) { const { obj, mtl } = drapeOBJ(scene, base); write('obj', obj); write('mtl', mtl); }
  const { parts, materials, ...stated } = scene;
  return { files, ...stated, pieces: drape.pieces.length, vertices: parts.reduce((n, p) => n + p.positions.length / 3, 0), triangles: parts.reduce((n, p) => n + p.indices.length / 3, 0), materials: materials.map((m) => m.name) };
}
