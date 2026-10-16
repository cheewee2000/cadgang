/**
 * cadgang · view — the fast file viewer.
 *
 * No document, no cells, no kernel on this page: a file comes in (drop, ⌘O, or
 * the macOS shell handing over a Finder path), it becomes one BufferGeometry,
 * and the GPU does the rest. Mesh formats parse here with three.js loaders;
 * B-rep formats go to the server, which tessellates with OpenCascade and
 * streams typed arrays back. Edges on a B-rep are the true face borders
 * (triangles on either side belong to different faces), not a crease
 * threshold guess.
 */

import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { ThreeMFLoader } from 'three/addons/loaders/3MFLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { attachOrbitInput } from './orbitinput.js';
import { createMarkup } from './markup.js';

const $ = (s) => document.querySelector(s);
const ui = { edges: true, wire: false, grid: true, look: 'shaded', ortho: false };
const section = { plane: new THREE.Plane(new THREE.Vector3(0, 0, -1), 0), axis: '', flip: 1 };
const CAD_EXT = /\.(step|stp|iges|igs|brep)$/i;

let statusTimer = null;
function say(text, isError = false) {
  const el = $('#status');
  el.textContent = text;
  el.classList.toggle('err', isError);
  clearTimeout(statusTimer);
  if (text && !isError) statusTimer = setTimeout(() => { el.textContent = ''; }, 4000);
}

// ----------------------------------------------------------------- viewport

const viewport = $('#viewport');
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance', stencil: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.localClippingEnabled = true;
viewport.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const persp = new THREE.PerspectiveCamera(40, 1, 0.1, 1e6);
const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, -1e6, 1e6);
let camera = persp;
const key = new THREE.DirectionalLight(0xfffdf8, 2.4);
key.position.set(60, -80, 120);
const fill = new THREE.DirectionalLight(0xf3e9d8, 0.9);
fill.position.set(-90, 50, -30);
scene.add(key, fill, new THREE.AmbientLight(0xffffff, 1.15), new THREE.HemisphereLight(0xffffff, 0xdedbd4, 0.6));

/** Render presets. Every mesh carries its own instance so per-mesh flags (flat, wire, clipping) never leak. */
const PRESETS = {
  shaded: () => new THREE.MeshStandardMaterial({ color: 0xb9b8b3, metalness: 0.25, roughness: 0.5 }),
  metal: () => new THREE.MeshStandardMaterial({ color: 0xcfd0d2, metalness: 0.95, roughness: 0.28 }),
  plastic: () => new THREE.MeshStandardMaterial({ color: 0xe8e4dc, metalness: 0, roughness: 0.65 }),
  glass: () => new THREE.MeshPhysicalMaterial({ color: 0xdfe8ee, metalness: 0, roughness: 0.05, transmission: 0.9, thickness: 2, transparent: true, opacity: 0.6 }),
  xray: () => new THREE.MeshBasicMaterial({ color: 0x2f5d8a, transparent: true, opacity: 0.18, depthWrite: false }),
  normals: () => new THREE.MeshNormalMaterial(),
};
function styleMesh(m) {
  const mat = PRESETS[ui.look]();
  mat.side = THREE.DoubleSide;
  mat.flatShading = !!m.userData.flat;
  mat.wireframe = ui.wire;
  mat.clippingPlanes = section.axis && bbox ? [section.plane] : [];
  m.material?.dispose();
  m.material = mat;
}
const edgeMaterial = new THREE.LineBasicMaterial({ color: 0x2f5d8a, transparent: true, opacity: 0.85 });
const model = new THREE.Group();     // meshes
const edges = new THREE.Group();     // their edge overlays
scene.add(model, edges);
let grid = null;
let bbox = null;

function clearModel() {
  for (const g of [model, edges]) {
    for (const o of g.children) { o.geometry?.dispose(); if (o.material !== edgeMaterial) o.material?.dispose?.(); }
    g.clear();
  }
  bbox = null;
  $('#bodies').replaceChildren(); $('#bodies').hidden = true;
  $('#explode').value = 0;
}

/** The triangles of one body as their own geometry (vertices compacted so its bounding box is its own). */
function subGeometry(pos, idx, first, count) {
  const map = new Map(); const outIdx = new Uint32Array(count * 3); const outPos = [];
  for (let i = 0; i < count * 3; i++) {
    const v = idx[first * 3 + i];
    let j = map.get(v);
    if (j === undefined) { j = map.size; map.set(v, j); outPos.push(pos[3 * v], pos[3 * v + 1], pos[3 * v + 2]); }
    outIdx[i] = j;
  }
  return { pos: Float32Array.from(outPos), idx: outIdx };
}

/** Face-border edges from a tessellation that knows its B-rep faces. */
function faceBorderEdges(pos, idx, faces) {
  const faceOf = new Uint32Array(idx.length / 3);
  faces.forEach((f, fi) => faceOf.fill(fi, f.first, f.first + f.count));
  const seen = new Map(); // edge key -> face id of the first triangle that used it
  const out = [];
  const n = pos.length / 3;
  for (let t = 0; t < idx.length; t += 3) {
    const f = faceOf[t / 3];
    for (let e = 0; e < 3; e++) {
      const a = idx[t + e], b = idx[t + ((e + 1) % 3)];
      const k = a < b ? a * n + b : b * n + a;
      const prev = seen.get(k);
      if (prev === undefined) seen.set(k, f);
      else if (prev !== f) { out.push(pos[3 * a], pos[3 * a + 1], pos[3 * a + 2], pos[3 * b], pos[3 * b + 1], pos[3 * b + 2]); seen.set(k, f); }
    }
  }
  return new Float32Array(out);
}

function addMesh(geo, { edgeLines, flat = false, name = '' } = {}) {
  if (!geo.getAttribute('normal')) geo.computeVertexNormals();
  const m = new THREE.Mesh(geo);
  m.userData.flat = flat;
  m.userData.name = name || `body ${model.children.length + 1}`;
  styleMesh(m);
  model.add(m);
  // Crease edges on an arbitrary mesh are a guess; over a million triangles the
  // guess costs seconds and reads as noise, so skip it there.
  // ponytail: no edge LOD — a budget cut-off, add decimation if assemblies need outlines.
  const tris = (geo.index ? geo.index.count : geo.getAttribute('position').count) / 3;
  const lines = edgeLines ?? (tris < 1_000_000 ? new THREE.EdgesGeometry(geo, 25).getAttribute('position').array : null);
  if (lines?.length) {
    const eg = new THREE.BufferGeometry();
    eg.setAttribute('position', new THREE.BufferAttribute(lines, 3));
    const l = new THREE.LineSegments(eg, edgeMaterial);
    l.renderOrder = 1;
    edges.add(l);
    m.userData.edges = l;
  }
}

// ------------------------------------------------------------------- bodies
//
// One mesh per body (a STEP assembly, a multi-body compound). The panel lists
// them with a checkbox each; EXPLODE slides every body out from the assembly
// centre along its own offset. Hiding a body hides its edges and its section cap.

function listBodies() {
  const panel = $('#bodies');
  panel.replaceChildren();
  panel.hidden = model.children.length < 2;
  const centre = bbox.getCenter(new THREE.Vector3());
  for (const m of model.children) {
    m.geometry.computeBoundingBox();
    m.userData.offset = m.geometry.boundingBox.getCenter(new THREE.Vector3()).sub(centre);
    const row = document.createElement('label');
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = m.visible;
    cb.addEventListener('change', () => setBodyVisible(m, cb.checked));
    const nm = document.createElement('span'); nm.textContent = m.userData.name;
    nm.title = 'Click: only this body · Shift-click: all bodies';
    nm.addEventListener('click', (e) => {
      e.preventDefault();
      for (const o of model.children) setBodyVisible(o, e.shiftKey || o === m);
      for (const r of panel.querySelectorAll('input')) r.checked = model.children[[...panel.children].indexOf(r.parentElement)].visible;
    });
    row.append(cb, nm);
    panel.appendChild(row);
  }
}
function setBodyVisible(m, on) {
  m.visible = on;
  if (m.userData.edges) m.userData.edges.visible = on;
}
function applyExplode() {
  const k = parseFloat($('#explode').value) / 100;
  for (const m of model.children) {
    const off = m.userData.offset ?? new THREE.Vector3();
    m.position.copy(off).multiplyScalar(k * 2);
    if (m.userData.edges) m.userData.edges.position.copy(m.position);
  }
}
$('#explode').addEventListener('input', applyExplode);

function finishLoad(name, ms) {
  const box = new THREE.Box3().setFromObject(model);
  if (box.isEmpty()) { say(`${name}: nothing to show`, true); return; }
  bbox = box;
  const size = box.getSize(new THREE.Vector3());
  let tris = 0, verts = 0;
  for (const m of model.children) {
    const g = m.geometry; verts += g.getAttribute('position').count; tris += (g.index ? g.index.count : g.getAttribute('position').count) / 3;
  }
  $('#fileName').textContent = name;
  document.title = `cadgang · ${name}`;
  $('#measures').textContent = `${size.x.toFixed(2)} × ${size.y.toFixed(2)} × ${size.z.toFixed(2)}`;
  $('#stats').textContent = `${model.children.length} BOD${model.children.length === 1 ? 'Y' : 'IES'} · ${tris.toLocaleString()} TRIS · ${verts.toLocaleString()} VERTS · ${ms} MS`;
  $('#drop').hidden = true; $('#loadError').textContent = '';
  placeGrid();
  listBodies();
  setupSection();
  fit();
  edges.visible = ui.edges;
  say(`${name} in ${ms} ms`);
  postSnapshot();
}

function placeGrid() {
  if (grid) { scene.remove(grid); grid.geometry.dispose(); grid = null; }
  if (!bbox) return;
  const size = bbox.getSize(new THREE.Vector3());
  const span = Math.max(size.x, size.y) * 2 || 100;
  const step = Math.pow(10, Math.floor(Math.log10(span / 10)));
  const divs = Math.max(2, Math.round(span / step));
  grid = new THREE.GridHelper(divs * step, divs, 0xbdbdbd, 0xe3e3e3);
  grid.rotation.x = Math.PI / 2;            // the part's Z is up
  grid.position.set((bbox.min.x + bbox.max.x) / 2, (bbox.min.y + bbox.max.y) / 2, bbox.min.z);
  grid.visible = ui.grid;
  scene.add(grid);
}

// ------------------------------------------------------------------- camera

const orbit = { yaw: -0.6, pitch: 0.5, dist: 160, target: new THREE.Vector3() };
function applyCamera() {
  const cp = Math.cos(orbit.pitch), sp = Math.sin(orbit.pitch);
  camera.position.set(
    orbit.target.x + orbit.dist * cp * Math.sin(orbit.yaw),
    orbit.target.y - orbit.dist * cp * Math.cos(orbit.yaw),
    orbit.target.z + orbit.dist * sp
  );
  camera.up.set(0, 0, 1);
  camera.lookAt(orbit.target);
  if (camera === persp) {
    camera.near = Math.max(orbit.dist / 1000, 0.01);
    camera.far = orbit.dist * 100;
  } else {
    // Same framing as the perspective view at this distance: the visible half-height at the target.
    const h = orbit.dist * Math.tan(THREE.MathUtils.degToRad(persp.fov / 2));
    camera.top = h; camera.bottom = -h; camera.left = -h * persp.aspect; camera.right = h * persp.aspect;
    camera.near = -orbit.dist * 100; camera.far = orbit.dist * 100;
  }
  camera.updateProjectionMatrix();
}

function fit() {
  if (!bbox) return;
  bbox.getCenter(orbit.target);
  const r = bbox.getSize(new THREE.Vector3()).length() / 2;
  orbit.dist = r / Math.sin(THREE.MathUtils.degToRad(persp.fov / 2)) * 1.1;
}

const VIEWS = { 1: [0, 0], 2: [Math.PI, 0], 3: [0, Math.PI / 2 - 1e-4], 4: [0, -Math.PI / 2 + 1e-4], 5: [Math.PI / 2, 0], 6: [-Math.PI / 2, 0], 7: [-0.6, 0.5] };
function setView(n) { const v = VIEWS[n]; if (v) { orbit.yaw = v[0]; orbit.pitch = v[1]; } }

let drag = null;
renderer.domElement.addEventListener('pointerdown', (e) => {
  drag = { x: e.clientX, y: e.clientY, pan: e.button === 2 || e.shiftKey, downX: e.clientX, downY: e.clientY, click: e.button === 0 };
  renderer.domElement.setPointerCapture(e.pointerId);
});
renderer.domElement.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  drag.x = e.clientX; drag.y = e.clientY;
  if (drag.pan) {
    const k = orbit.dist * 0.0015;
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
    orbit.target.addScaledVector(right, -dx * k).addScaledVector(up, dy * k);
  } else {
    orbit.yaw += dx * 0.006;
    orbit.pitch = THREE.MathUtils.clamp(orbit.pitch + dy * 0.006, -Math.PI / 2 + 0.01, Math.PI / 2 - 0.01);
  }
});
renderer.domElement.addEventListener('pointerup', (e) => {
  if (drag?.click && measure.on && Math.hypot(e.clientX - drag.downX, e.clientY - drag.downY) < 4) measureClick(e);
  drag = null;
});
renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());
const raycaster = new THREE.Raycaster();
function hitAt(e) {
  const r = renderer.domElement.getBoundingClientRect();
  raycaster.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
  return raycaster.intersectObjects(model.children, false)[0]?.point ?? null;
}
attachOrbitInput(renderer.domElement, { orbit, getCamera: () => camera, THREE, hitAt });

// ------------------------------------------------------------------ section

// Caps: the classic stencil trick. For every body, its back faces increment the
// stencil and its front faces decrement it where the plane cuts; where the count
// is non-zero the cap quad shows — a solid-looking cut instead of a hollow shell.
const caps = new THREE.Group();
scene.add(caps);
const capPlane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshStandardMaterial({
  color: 0x9a9892, metalness: 0.2, roughness: 0.6, stencilWrite: true, stencilRef: 0,
  stencilFunc: THREE.NotEqualStencilFunc, stencilFail: THREE.ReplaceStencilOp, stencilZFail: THREE.ReplaceStencilOp, stencilZPass: THREE.ReplaceStencilOp,
}));
capPlane.renderOrder = 2;
capPlane.onAfterRender = () => renderer.clearStencil();
capPlane.visible = false;
scene.add(capPlane);
function stencilMaterial(side, op) {
  return new THREE.MeshBasicMaterial({
    side, depthWrite: false, depthTest: false, colorWrite: false, stencilWrite: true, stencilFunc: THREE.AlwaysStencilFunc,
    stencilFail: op, stencilZFail: op, stencilZPass: op, clippingPlanes: [section.plane],
  });
}
function buildCaps() {
  for (const o of caps.children) o.children.forEach((c) => c.material.dispose());
  caps.clear();
  if (!section.axis || !bbox) { capPlane.visible = false; return; }
  for (const m of model.children) {
    const g = new THREE.Group();
    const back = new THREE.Mesh(m.geometry, stencilMaterial(THREE.BackSide, THREE.IncrementWrapStencilOp));
    const front = new THREE.Mesh(m.geometry, stencilMaterial(THREE.FrontSide, THREE.DecrementWrapStencilOp));
    back.renderOrder = 1; front.renderOrder = 1;
    g.add(back, front);
    g.userData.body = m;
    caps.add(g);
  }
  const size = bbox.getSize(new THREE.Vector3()).length() * 3;
  capPlane.geometry.dispose(); capPlane.geometry = new THREE.PlaneGeometry(size, size);
  capPlane.visible = true;
}
function placeCaps() {
  if (!capPlane.visible) return;
  for (const g of caps.children) { g.visible = g.userData.body.visible; g.position.copy(g.userData.body.position); }
  const n = section.plane.normal;
  capPlane.position.copy(n).multiplyScalar(-section.plane.constant);
  capPlane.lookAt(capPlane.position.clone().add(n));
}

function setupSection() {
  const axis = $('#sectAxis').value;
  section.axis = axis;
  $('#sectPos').disabled = $('#sectFlip').disabled = !axis;
  const planes = axis && bbox ? [section.plane] : [];
  for (const m of model.children) m.material.clippingPlanes = planes;
  edgeMaterial.clippingPlanes = planes; // edges follow the cut, or they float over the cap
  updateSection();
  buildCaps();
  clearMeasure();
}
function updateSection() {
  if (!section.axis || !bbox) return;
  const i = 'xyz'.indexOf(section.axis);
  const lo = bbox.min.getComponent(i), hi = bbox.max.getComponent(i);
  const at = lo + (hi - lo) * ($('#sectPos').value / 1000);
  const n = new THREE.Vector3(); n.setComponent(i, -section.flip);
  section.plane.set(n, section.flip * at);
}
$('#sectAxis').addEventListener('change', setupSection);
$('#sectPos').addEventListener('input', updateSection);
$('#sectFlip').addEventListener('click', () => { section.flip *= -1; updateSection(); });

// ------------------------------------------------------------------ loaders

const loaders = {
  stl: () => new STLLoader(), obj: () => new OBJLoader(), ply: () => new PLYLoader(),
  gltf: () => new GLTFLoader(), glb: () => new GLTFLoader(), '3mf': () => new ThreeMFLoader(), fbx: () => new FBXLoader(),
};

function collectGeometries(obj, out = []) {
  obj.updateMatrixWorld(true);
  obj.traverse((o) => {
    if (o.isMesh) { const g = o.geometry.clone().applyMatrix4(o.matrixWorld); out.push(g); }
  });
  return out;
}

async function parseMesh(ext, buffer, name) {
  const loader = loaders[ext]();
  if (ext === 'stl') return [{ geo: loader.parse(buffer), flat: true }];
  if (ext === 'ply') return [{ geo: loader.parse(buffer) }];
  if (ext === 'obj') return collectGeometries(loader.parse(new TextDecoder().decode(buffer))).map((geo) => ({ geo }));
  if (ext === '3mf' || ext === 'fbx') return collectGeometries(loader.parse(buffer, '')).map((geo) => ({ geo }));
  const gltf = await new Promise((ok, bad) => loader.parse(buffer, '', ok, bad));
  return collectGeometries(gltf.scene).map((geo) => ({ geo }));
}

function parseCad(buffer) {
  const [nPos, nIdx, nFaces, nBodies, nNameBytes] = new Uint32Array(buffer, 0, 5);
  let off = 20;
  const pos = new Float32Array(buffer, off, nPos); off += nPos * 4;
  const idx = new Uint32Array(buffer, off, nIdx); off += nIdx * 4;
  const fr = new Uint32Array(buffer, off, nFaces * 2); off += nFaces * 8;
  const br = new Uint32Array(buffer, off, nBodies * 2); off += nBodies * 8;
  const names = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, off, nNameBytes)));
  const faces = Array.from({ length: nFaces }, (_, i) => ({ first: fr[2 * i], count: fr[2 * i + 1] }));
  const parts = [];
  for (let b = 0; b < nBodies; b++) {
    const first = br[2 * b], count = br[2 * b + 1];
    const sub = subGeometry(pos, idx, first, count);
    const own = faces.filter((f) => f.first >= first && f.first < first + count).map((f) => ({ first: f.first - first, count: f.count }));
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(sub.pos, 3));
    geo.setIndex(new THREE.BufferAttribute(sub.idx, 1));
    parts.push({ geo, edgeLines: faceBorderEdges(sub.pos, sub.idx, own), name: names[b] });
  }
  return parts;
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch('/api/view' + path, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function fetchBuffer(url, init) {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
  return res.arrayBuffer();
}

/** A load that failed shows its reason in the empty viewport, not only in the footer. */
function loadFailed(name, e) {
  say(`${name}: ${e.message}`, true);
  const drop = $('#drop');
  drop.hidden = false;
  $('#loadError').textContent = `${name}: ${e.message}`;
}

/** Open from bytes (drop / file picker). Several files stack into one scene. */
async function openBuffers(files) {
  const t0 = performance.now();
  clearModel();
  let shown = 0, label = '';
  for (const { name, buffer } of files) {
    const ext = name.toLowerCase().split('.').pop();
    say(`loading ${name}…`);
    try {
      const parts = CAD_EXT.test(name)
        ? parseCad(await fetchBuffer(`/api/view/tessellate?name=${encodeURIComponent(name)}`, { method: 'POST', body: buffer }))
        : await parseMesh(ext, buffer, name);
      for (const p of parts) addMesh(p.geo, p.name ? p : { ...p, name });
      shown++; label = name;
    } catch (e) { loadFailed(name, e); return; }
  }
  if (shown) finishLoad(shown === 1 ? label : `${shown} files`, Math.round(performance.now() - t0));
}

/** Open from absolute paths — the macOS shell calls this with what Finder handed it. */
window.cadgangOpen = async function cadgangOpen(paths) {
  const t0 = performance.now();
  clearModel();
  // The folder of the opened file becomes the project folder (exports land beside it) —
  // unless a cell document is already open; viewing a stray STEP must not swap that.
  const dir = String([].concat(paths)[0]).replace(/\/[^/]*$/, '') || '/';
  fetch('/api/project', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dir, ifUnset: true }) }).catch(() => {});
  let shown = 0, label = '';
  for (const p of [].concat(paths)) {
    const name = p.split('/').pop();
    say(`loading ${name}…`);
    try {
      const q = `path=${encodeURIComponent(p)}`;
      const parts = CAD_EXT.test(name)
        ? parseCad(await fetchBuffer(`/api/view/tessellate?${q}`, { method: 'POST' }))
        : await parseMesh(name.toLowerCase().split('.').pop(), await fetchBuffer(`/api/view/file?${q}`), name);
      for (const part of parts) addMesh(part.geo, part.name ? part : { ...part, name });
      shown++; label = name;
    } catch (e) { loadFailed(name, e); return; }
  }
  if (shown) finishLoad(shown === 1 ? label : `${shown} files`, Math.round(performance.now() - t0));
};

async function filesToBuffers(fileList) {
  return Promise.all([...fileList].map(async (f) => ({ name: f.name, buffer: await f.arrayBuffer() })));
}
// The whole page is the drop zone: a file let go over the toolbar should open too.
document.addEventListener('dragover', (e) => { e.preventDefault(); viewport.classList.add('dragover'); });
document.addEventListener('dragleave', () => viewport.classList.remove('dragover'));
document.addEventListener('drop', async (e) => {
  e.preventDefault(); viewport.classList.remove('dragover');
  if (e.dataTransfer.files.length) openBuffers(await filesToBuffers(e.dataTransfer.files));
});
$('#openBtn').addEventListener('click', () => $('#fileInput').click());
$('#fileInput').addEventListener('change', async (e) => { if (e.target.files.length) openBuffers(await filesToBuffers(e.target.files)); e.target.value = ''; });

// ----------------------------------------------------------------- toggles

function toggle(name, btn) {
  ui[name] = !ui[name];
  $(btn).classList.toggle('on', ui[name]);
  edges.visible = ui.edges;
  if (grid) grid.visible = ui.grid;
  for (const m of model.children) styleMesh(m);
}
$('#edgesBtn').addEventListener('click', () => toggle('edges', '#edgesBtn'));
$('#wireBtn').addEventListener('click', () => toggle('wire', '#wireBtn'));
$('#gridBtn').addEventListener('click', () => toggle('grid', '#gridBtn'));
$('#fitBtn').addEventListener('click', fit);
$('#look').addEventListener('change', (e) => { ui.look = e.target.value; for (const m of model.children) styleMesh(m); });
function setOrtho(on) {
  ui.ortho = on;
  camera = on ? ortho : persp;
  $('#orthoBtn').classList.toggle('on', on);
}
$('#orthoBtn').addEventListener('click', () => setOrtho(!ui.ortho));

// ------------------------------------------------------------------ measure
//
// Two clicks on the model, one distance. Points are kept in world space and
// their labels are DOM nodes projected every frame, so they stay crisp at any
// zoom. ponytail: point-to-point only — edge/face/radius picking needs the
// B-rep topology, which the viewer gets once the cell document is wired in.

const measure = { on: false, pts: [], objs: [], labels: [] };
const measureLayer = $('#measureLayer');
function clearMeasure() {
  for (const o of measure.objs) { scene.remove(o); o.geometry?.dispose(); }
  for (const l of measure.labels) l.remove();
  measure.pts = []; measure.objs = []; measure.labels = [];
}
function setMeasure(on) {
  measure.on = on;
  $('#measureBtn').classList.toggle('on', on);
  renderer.domElement.style.cursor = on ? 'crosshair' : '';
  if (!on) clearMeasure();
}
$('#measureBtn').addEventListener('click', () => setMeasure(!measure.on));
function addLabel(text, pos) {
  const el = document.createElement('div');
  el.className = 'mlabel';
  el.textContent = text;
  el.userData = { pos };
  measureLayer.appendChild(el);
  measure.labels.push(el);
}
function markerAt(p) {
  const r = orbit.dist * 0.004;
  const m = new THREE.Mesh(new THREE.SphereGeometry(r, 12, 8), new THREE.MeshBasicMaterial({ color: 0xd11d1d, depthTest: false }));
  m.position.copy(p); m.renderOrder = 3;
  scene.add(m); measure.objs.push(m);
}
function measureClick(e) {
  const p = hitAt(e);
  if (!p) return;
  if (measure.pts.length === 2) clearMeasure();
  measure.pts.push(p.clone());
  markerAt(p);
  if (measure.pts.length === 2) {
    const [a, b] = measure.pts;
    const g = new THREE.BufferGeometry().setFromPoints([a, b]);
    const line = new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0xd11d1d, depthTest: false }));
    line.renderOrder = 3;
    scene.add(line); measure.objs.push(line);
    const d = a.distanceTo(b), dx = Math.abs(a.x - b.x), dy = Math.abs(a.y - b.y), dz = Math.abs(a.z - b.z);
    addLabel(`${d.toFixed(3)}`, a.clone().lerp(b, 0.5));
    say(`${d.toFixed(3)}  (Δx ${dx.toFixed(3)}  Δy ${dy.toFixed(3)}  Δz ${dz.toFixed(3)})`);
    $('#measures').textContent = `${d.toFixed(3)} · Δx ${dx.toFixed(3)} · Δy ${dy.toFixed(3)} · Δz ${dz.toFixed(3)}`;
  }
}
function projectLabels() {
  const r = renderer.domElement.getBoundingClientRect();
  for (const l of measure.labels) {
    const v = l.userData.pos.clone().project(camera);
    l.style.left = `${(v.x + 1) / 2 * r.width}px`;
    l.style.top = `${(1 - v.y) / 2 * r.height}px`;
    l.hidden = v.z > 1;
  }
}
window.addEventListener('keydown', (e) => {
  if (e.target.matches('input,select,textarea')) return;
  if (e.metaKey && e.key === 'o') { e.preventDefault(); $('#fileInput').click(); return; }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'f') fit();
  else if (e.key === 'e') toggle('edges', '#edgesBtn');
  else if (e.key === 'w') toggle('wire', '#wireBtn');
  else if (e.key === 'g') toggle('grid', '#gridBtn');
  else if (e.key === 'o') setOrtho(!ui.ortho);
  else if (e.key === 'm') setMeasure(!measure.on);
  else if (e.key === 'Escape') setMeasure(false);
  else if (VIEWS[e.key]) setView(e.key);
});

// ------------------------------------------------------------------- theme

const THEME_KEY = 'cwt-theme';
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  $('#themeToggle').textContent = t === 'dark' ? 'LIGHT' : 'DARK';
  scene.background = new THREE.Color(t === 'dark' ? 0x1a1a18 : 0xffffff);
  try { localStorage.setItem(THEME_KEY, t); } catch {}
}
$('#themeToggle').addEventListener('click', () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
let theme = 'light';
try { theme = localStorage.getItem(THEME_KEY) || theme; } catch {}
applyTheme(theme);


// ------------------------------------------------------------------ markup

const markup = createMarkup({
  THREE, renderer, scene, orbit, layer: $('#markupLayer'), tools: $('#markupTools'),
  getCamera: () => camera, getTargets: () => model.children,
  onChange: (items) => {
    clearTimeout(markupTimer);
    markupTimer = setTimeout(() => {
      api('/markup', { method: 'PUT', body: { markups: items } }).catch((e) => say(e.message, true));
      postSnapshot();
    }, 400);
  },
});
let markupTimer = null;
let snapshotTimer = null;
/** Post what is on screen; coalesced, since a stroke is many change events. */
function postSnapshot() {
  clearTimeout(snapshotTimer);
  snapshotTimer = setTimeout(() => {
    try {
      const png = markup.snapshot();
      fetch('/api/view/snapshot', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ png, page: 'view', subject: $('#fileName').textContent, camera: { yaw: orbit.yaw, pitch: orbit.pitch, dist: orbit.dist, target: orbit.target.toArray() } }) }).catch(() => {});
    } catch {}
  }, 150);
}
fetch('/api/view/markup').then((r) => r.json()).then((d) => markup.load(d.markups)).catch(() => {});

const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.type === 'snapshot_request') postSnapshot();
  if (msg.type === 'markup_changed') fetch('/api/view/markup').then((r) => r.json()).then((d) => markup.load(d.markups)).catch(() => {});
};

// -------------------------------------------------------------------- loop

function resize() {
  const w = viewport.clientWidth, h = viewport.clientHeight;
  if (renderer.domElement.width !== w * renderer.getPixelRatio() || renderer.domElement.height !== h * renderer.getPixelRatio()) {
    renderer.setSize(w, h);
    persp.aspect = w / h;
    persp.updateProjectionMatrix();
  }
}
new ResizeObserver(resize).observe(viewport);
(function loop() {
  resize();
  applyCamera();
  placeCaps();
  renderer.render(scene, camera);
  projectLabels();
  markup.projectLabels();
  requestAnimationFrame(loop);
})();

fetch('/api/health').then((r) => r.json()).then((h) => { $('#version').textContent = 'v' + h.version; }).catch(() => {});
// For headless drives: the scene objects behind the page.
window.__view = { model, caps, capPlane, section };
// Files queued by the shell before the page was ready.
if (window.cadgangPending?.length) window.cadgangOpen(window.cadgangPending);
// ?open=/abs/a.step|/abs/b.stl — the same local-path door, for the shell and for headless tests.
const openArg = new URLSearchParams(location.search).get('open');
if (openArg) window.cadgangOpen(openArg.split('|'));
