/**
 * CADgang · view — the fast file viewer.
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
import { parseDxf } from './dxf.js';
import { explodeOffsets } from './explode.js';
import { createMeasure } from './measure.js';
import { NURBSCurve } from 'three/addons/curves/NURBSCurve.js';

const $ = (s) => document.querySelector(s);
const ui = { edges: true, wire: false, grid: true, look: 'shaded', ortho: false, flat: false, color: false }; // flat: a 2D drawing is open
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
// One hue per body or layer when COLOR is on; golden-ratio spacing keeps any count apart.
const partColor = (i) => new THREE.Color().setHSL((i * 0.618034) % 1, 0.6, 0.5);
function styleMesh(m) {
  const i = model.children.indexOf(m);
  if (m.isLine) {   // a drawing keeps its ink unless coloured by layer
    m.material.color.set(ui.color ? partColor(i) : inkColor());
    m.material.clippingPlanes = section.axis && bbox ? [section.plane] : [];
    return;
  }
  const mat = PRESETS[ui.look]();
  if (ui.color && mat.color) mat.color.copy(partColor(i));
  mat.side = section.axis && bbox ? THREE.FrontSide : THREE.DoubleSide;
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
  ui.flat = false; $('#sideBtn').hidden = true;
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

function addMesh(geo, { edgeLines, faces, flat = false, name = '' } = {}) {
  if (!geo.getAttribute('normal')) geo.computeVertexNormals();
  const m = new THREE.Mesh(geo);
  m.userData.flat = flat;
  m.userData.name = name || `body ${model.children.length + 1}`;
  m.userData.faces = faces;   // B-rep face ranges, when the importer knew them: picked by measure
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

/** A DXF layer: line segments in the page's ink. Measure, markup and section see it like a body. */
function addLines(positions, name) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: inkColor() }));
  l.userData.name = name;
  model.add(l);
}
const inkColor = () => (document.documentElement.dataset.theme === 'dark' ? 0xffffff : 0x000000);
const addPart = (p, name) => (p.lines ? addLines(p.lines, p.name || name) : addMesh(p.geo, p.name ? p : { ...p, name }));

// ------------------------------------------------------------------- bodies
//
// One mesh per body (a STEP assembly, a multi-body compound). The panel lists
// them with a checkbox each; EXPLODE slides every body out from the assembly
// centre along its own offset (explode.js: a pocketed part leaves along the
// pocket's axis). Hiding a body hides its edges and its section cap.

function listBodies() {
  const panel = $('#bodies');
  panel.replaceChildren();
  panel.hidden = model.children.length < 2;
  explodeOffsets(model.children, bbox.getCenter(new THREE.Vector3()));
  for (const m of model.children) {
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
  paintRows();
}
/** The tick of each body row takes its colour when COLOR is on. */
function paintRows() {
  [...$('#bodies').querySelectorAll('input')].forEach((cb, i) => { cb.style.accentColor = ui.color ? `#${partColor(i).getHexString()}` : ''; });
}
function setBodyVisible(m, on) {
  m.visible = on;
  if (m.userData.edges) m.userData.edges.visible = on;
  measure.invalidate();
}
function applyExplode() {
  const k = parseFloat($('#explode').value) / 100;
  const done = new Set();
  const place = (m) => {   // a pocketed part rides on the body its pocket is in
    if (done.has(m)) return m.position;
    done.add(m);
    m.position.copy(m.userData.offset ?? new THREE.Vector3()).multiplyScalar(k * 2);
    if (m.userData.parent) m.position.add(place(m.userData.parent));
    if (m.userData.edges) m.userData.edges.position.copy(m.position);
    return m.position;
  };
  for (const m of model.children) place(m);
  measure.invalidate();
}
$('#explode').addEventListener('input', applyExplode);

function finishLoad(name, ms, keep = false) {
  const box = new THREE.Box3().setFromObject(model);
  if (box.isEmpty()) { say(`${name}: nothing to show`, true); return; }
  bbox = box;
  measure.clear();
  history.list = []; history.i = -1; queueMicrotask(commit);
  const size = box.getSize(new THREE.Vector3());
  let tris = 0, verts = 0, segs = 0;
  for (const m of model.children) {
    const g = m.geometry, n = g.index ? g.index.count : g.getAttribute('position').count;
    verts += g.getAttribute('position').count;
    if (m.isLine) segs += n / 2; else tris += n / 3;
  }
  $('#fileName').textContent = name;
  document.title = `CADgang · ${name}`;
  $('#measures').textContent = `${size.x.toFixed(2)} × ${size.y.toFixed(2)} × ${size.z.toFixed(2)}`;
  $('#stats').textContent = `${model.children.length} BOD${model.children.length === 1 ? 'Y' : 'IES'} · ${segs ? `${segs.toLocaleString()} SEGS · ` : ''}${tris ? `${tris.toLocaleString()} TRIS · ` : ''}${verts.toLocaleString()} VERTS · ${ms} MS`;
  $('#drop').hidden = true; $('#loadError').textContent = '';
  placeGrid();
  listBodies();
  setupSection();
  // A flat drawing is read from above and handled like paper: pan, turn in quarters, flip over.
  ui.flat = size.z < 1e-9; $('#sideBtn').hidden = !ui.flat;
  if (!keep) { if (ui.flat) setView('3'); fit(); }   // a reload of a changed file keeps the camera
  edges.visible = ui.edges;
  say(`${name} in ${ms} ms`);
  loadMarkup();
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
  grid.position.set((bbox.min.x + bbox.max.x) / 2, (bbox.min.y + bbox.max.y) / 2, bbox.min.z - step * 0.01); // a hair under a flat drawing
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
  camera.up.set(-sp * Math.sin(orbit.yaw), sp * Math.cos(orbit.yaw), cp);   // follows the orbit: no pole, no limit
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
  if (e.button === 0 && !e.shiftKey && !measure.on && onCap(e)) drag.sect = sectionScreenAxis(e);
  renderer.domElement.setPointerCapture(e.pointerId);
});
renderer.domElement.addEventListener('pointermove', (e) => {
  if (!drag) { if (measure.on) measure.hover(e); else renderer.domElement.classList.toggle('oncap', onCap(e)); return; }
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  drag.x = e.clientX; drag.y = e.clientY;
  if (drag.sect) {
    // slide the plane along its axis by the pointer's travel projected onto that axis on screen
    const { sx, sy } = drag.sect;
    const i = 'xyz'.indexOf(section.axis);
    const lo = bbox.min.getComponent(i), hi = bbox.max.getComponent(i);
    const at = lo + (hi - lo) * ($('#sectPos').value / 1000) + dx * sx + dy * sy;
    $('#sectPos').value = Math.round(THREE.MathUtils.clamp((at - lo) / (hi - lo), 0, 1) * 1000);
    updateSection();
    return;
  }
  if (drag.pan || ui.flat) {
    const k = orbit.dist * 0.0015;
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
    orbit.target.addScaledVector(right, -dx * k).addScaledVector(up, dy * k);
  } else {
    orbit.yaw += dx * 0.006;
    orbit.pitch += dy * 0.006;
  }
});
renderer.domElement.addEventListener('pointerup', (e) => {
  const still = drag && Math.hypot(e.clientX - drag.downX, e.clientY - drag.downY) < 4;
  if (drag?.click && measure.on && still) measure.click(e);
  if (e.button === 2 && still) showMenu(e.clientX, e.clientY);
  if (drag?.sect) commit();
  drag = null;
});
renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());
const raycaster = new THREE.Raycaster();
function hitAt(e) {
  const r = renderer.domElement.getBoundingClientRect();
  raycaster.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
  return raycaster.intersectObjects(model.children, false)[0]?.point ?? null;
}
attachOrbitInput(renderer.domElement, { orbit, getCamera: () => camera, THREE, hitAt, isFlat: () => ui.flat });

// Is the pointer over a cut face? The first hit on the kept side of the plane
// being a back face means the ray entered the solid through the cut.
function onCap(e) {
  if (!section.axis || !bbox) return false;
  const r = renderer.domElement.getBoundingClientRect();
  raycaster.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
  const hit = raycaster.intersectObjects(model.children, true).find((h) => h.object.visible && h.object.parent.visible && section.plane.distanceToPoint(h.point) > -1e-6);
  return !!hit && hit.object.material === capMaterial;
}
// World units the plane moves per pixel of pointer travel in x and y: one unit
// along the axis, projected to screen at the grabbed cap point, then inverted.
// ponytail: onCap raycasts every hover; a BVH is the upgrade if huge models drag.
function sectionScreenAxis(e) {
  const r = renderer.domElement.getBoundingClientRect();
  const i = 'xyz'.indexOf(section.axis);
  const p0 = raycaster.ray.intersectPlane(section.plane, new THREE.Vector3()) ?? orbit.target.clone(); // raycaster set by onCap
  const p1 = p0.clone(); p1.setComponent(i, p1.getComponent(i) + 1);
  const a = p0.project(camera), b = p1.project(camera);
  const sx = (b.x - a.x) * r.width / 2, sy = -(b.y - a.y) * r.height / 2;
  const len2 = sx * sx + sy * sy || 1;
  return { sx: sx / len2, sy: sy / len2 };
}

// ------------------------------------------------------------------ section

// Caps: when a section is on, each body renders front faces only and a twin
// mesh renders its BACK faces in a flat cap colour. Looking into the cut you see
// solid material, hollow walls read as rings, and nothing depends on stencil
// parity — the stencil version held on a shelled box and failed on a merged
// STEP in WebKit.
const capMaterial = new THREE.MeshBasicMaterial({ color: 0x8e8c86, side: THREE.BackSide });
function buildCaps() {
  for (const m of model.children) {
    if (m.userData.cap) { m.remove(m.userData.cap); m.userData.cap = null; }
    if (m.isLine) continue;
    const on = !!section.axis && !!bbox;
    m.material.side = on ? THREE.FrontSide : THREE.DoubleSide;
    if (!on) continue;
    const cap = new THREE.Mesh(m.geometry, capMaterial);
    cap.renderOrder = -1;
    m.add(cap);
    m.userData.cap = cap;
  }
  capMaterial.clippingPlanes = section.axis && bbox ? [section.plane] : [];
}

function setSectionAxis(axis) {
  $('#sectAxis').dataset.axis = axis;
  for (const b of $('#sectAxis').querySelectorAll('[data-sect]')) b.classList.toggle('on', b.dataset.sect === axis);
  setupSection();
}
function setupSection() {
  const axis = $('#sectAxis').dataset.axis;
  section.axis = axis;
  $('#sectPos').disabled = $('#sectFlip').disabled = !axis;
  const planes = axis && bbox ? [section.plane] : [];
  for (const m of model.children) m.material.clippingPlanes = planes;
  edgeMaterial.clippingPlanes = planes; // edges follow the cut, or they float over the cap
  updateSection();
  buildCaps();
}
function updateSection() {
  if (!section.axis || !bbox) return;
  const i = 'xyz'.indexOf(section.axis);
  const lo = bbox.min.getComponent(i), hi = bbox.max.getComponent(i);
  const at = lo + (hi - lo) * ($('#sectPos').value / 1000);
  const n = new THREE.Vector3(); n.setComponent(i, -section.flip);
  section.plane.set(n, section.flip * at);
}
for (const b of $('#sectAxis').querySelectorAll('[data-sect]')) b.addEventListener('click', () => setSectionAxis(b.dataset.sect));
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
  if (ext === 'dxf') {
    const { parts, skipped } = parseDxf(new TextDecoder().decode(buffer), { THREE, NURBSCurve });
    const n = Object.values(skipped).reduce((a, b) => a + b, 0);
    if (n) say(`${name}: ${n} ${Object.keys(skipped).join('/')} entit${n === 1 ? 'y' : 'ies'} not drawn`);
    if (!parts.length) throw new Error('no drawable entities');
    return parts;
  }
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
    parts.push({ geo, edgeLines: faceBorderEdges(sub.pos, sub.idx, own), faces: own, name: names[b] });
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
  subject = files.map((f) => f.name).join('|');   // bytes have no path: markups attach by name

  let shown = 0, label = '';
  for (const { name, buffer } of files) {
    const ext = name.toLowerCase().split('.').pop();
    say(`loading ${name}…`);
    try {
      const parts = CAD_EXT.test(name)
        ? parseCad(await fetchBuffer(`/api/view/tessellate?name=${encodeURIComponent(name)}`, { method: 'POST', body: buffer }))
        : await parseMesh(ext, buffer, name);
      for (const p of parts) addPart(p, name);
      shown++; label = name;
    } catch (e) { loadFailed(name, e); return; }
  }
  if (shown) finishLoad(shown === 1 ? label : `${shown} files`, Math.round(performance.now() - t0));
}

/** Open from absolute paths — the macOS shell calls this with what Finder handed it. */
window.cadgangOpen = async function cadgangOpen(paths, { keep = false } = {}) {
  paths = [].concat(paths);
  // Another file is on screen: this one gets its own tab, or its own window in the Mac app (the shell
  // turns window.open into a window). A blocked popup falls back to opening in place.
  if (!keep && model.children.length && paths.join('|') !== subject
      && window.open(`${location.pathname}?open=${encodeURIComponent(paths.join('|'))}`)) return;
  const t0 = performance.now();
  clearModel();
  subject = paths.join('|');   // markups attach to the file by path
  let shown = 0, label = '';
  for (const p of paths) {
    const name = p.split('/').pop();
    say(`loading ${name}…`);
    try {
      const q = `path=${encodeURIComponent(p)}`;
      const parts = CAD_EXT.test(name)
        ? parseCad(await fetchBuffer(`/api/view/tessellate?${q}`, { method: 'POST' }))
        : await parseMesh(name.toLowerCase().split('.').pop(), await fetchBuffer(`/api/view/file?${q}`), name);
      for (const part of parts) addPart(part, name);
      shown++; label = name;
    } catch (e) { loadFailed(name, e); return; }
  }
  if (shown) finishLoad(shown === 1 ? label : `${shown} files`, Math.round(performance.now() - t0), keep);
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
$('#newBtn').addEventListener('click', () => window.open(location.pathname));
// Only the Mac shell can register file associations; the button exists only inside it.
$('#defaultBtn').hidden = !window.cadgangDesktop;
$('#defaultBtn').addEventListener('click', () => window.webkit?.messageHandlers?.cadgang?.postMessage({ cmd: 'defaultApp' }));
window.cadgangNotify = say;
$('#fileInput').addEventListener('change', async (e) => { if (e.target.files.length) openBuffers(await filesToBuffers(e.target.files)); e.target.value = ''; });

// ----------------------------------------------------------------- toggles

function toggle(name, btn) {
  ui[name] = !ui[name];
  $(btn).classList.toggle('on', ui[name]);
  edges.visible = ui.edges;
  if (grid) grid.visible = ui.grid;
  for (const m of model.children) styleMesh(m);
  paintRows();
}
$('#colorBtn').addEventListener('click', () => toggle('color', '#colorBtn'));
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
// Snapping dimensions that stay on the page; see measure.js. They live in the
// undo history as data, so ⌘Z removes the last one.

const measure = createMeasure({
  THREE, scene, renderer, model, layer: $('#measureLayer'),
  getCamera: () => camera, getOrbit: () => orbit, say, onChange: () => commit(),
});
function setMeasure(on) {
  measure.setOn(on);
  $('#measureBtn').classList.toggle('on', on);
}
$('#measureBtn').addEventListener('click', () => setMeasure(!measure.on));

// ------------------------------------------------------------------- theme

const THEME_KEY = 'cwt-theme';
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  $('#themeToggle').textContent = t === 'dark' ? 'LIGHT' : 'DARK';
  scene.background = new THREE.Color(t === 'dark' ? 0x1a1a18 : 0xffffff);
  for (const m of model.children) if (m.isLine) styleMesh(m);
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
  onChange: (items) => { markupChanged(items); commit(); },
});
let markupTimer = null;
let subject = '';   // what is open: the file path(s) from the shell, or the dropped file name(s)
function markupChanged(items) {
  clearTimeout(markupTimer);
  markupTimer = setTimeout(() => {
    if (subject) api('/markup', { method: 'PUT', body: { subject, markups: items } }).catch((e) => say(e.message, true));
    postSnapshot();
  }, 400);
}
function loadMarkup() {
  if (!subject) return;
  api(`/markup?subject=${encodeURIComponent(subject)}`).then((d) => { markup.load(d.markups); commit(); }).catch(() => {});
}
let snapshotTimer = null;
/** Post what is on screen; coalesced, since a stroke is many change events. */
function postSnapshot() {
  clearTimeout(snapshotTimer);
  snapshotTimer = setTimeout(() => {
    try {
      const png = markup.snapshot();
      fetch('/api/view/snapshot', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ png, subject, camera: { yaw: orbit.yaw, pitch: orbit.pitch, dist: orbit.dist, target: orbit.target.toArray() } }) }).catch(() => {});
    } catch {}
  }, 150);
}

// The server restarts under the app (a deploy); reconnect, and when
// it comes back as a NEWER version reload so the page is never older than its server.
let pageVersion = null;
let ws = null;
// Several tabs or windows share one server; the one the user last touched is the one Claude opens into and screens.
const focus = () => { if (ws?.readyState === 1 && document.hasFocus()) ws.send(JSON.stringify({ type: 'focus' })); };
window.addEventListener('focus', focus);
document.addEventListener('pointerdown', focus);
document.addEventListener('visibilitychange', focus);
(function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onopen = focus;
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'hello' && msg.version) { if (pageVersion && pageVersion !== msg.version) location.reload(); pageVersion = msg.version; }
    if (msg.type === 'snapshot_request') postSnapshot();
    if (msg.type === 'markup_changed' && msg.subject === subject) loadMarkup();
    if (msg.type === 'open' && msg.paths?.length) window.cadgangOpen(msg.paths);   // pushed from MCP
    if (msg.type === 'file_changed' && subject.split('|').includes(msg.path)) { say('file changed, reloading…'); window.cadgangOpen(subject.split('|'), { keep: true }); }
  };
  ws.onclose = () => setTimeout(connect, 1500);
})();

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
  renderer.render(scene, camera);
  measure.projectLabels();
  markup.projectLabels();
  requestAnimationFrame(loop);
})();

fetch('/api/health').then((r) => r.json()).then((h) => { $('#version').textContent = 'v' + h.version; }).catch(() => {});
// For headless drives: the scene objects behind the page.
window.__view = { model, section, orbit, ui, measure, THREE, get camera() { return camera; },
  project: (x, y, z) => { const r = renderer.domElement.getBoundingClientRect(), v = new THREE.Vector3(x, y, z).project(camera); return { x: r.left + (v.x + 1) / 2 * r.width, y: r.top + (1 - v.y) / 2 * r.height }; } };
// Files queued by the shell before the page was ready.
if (window.cadgangPending?.length) window.cadgangOpen(window.cadgangPending);
// ?open=/abs/a.step|/abs/b.stl — the same local-path door, for the shell and for headless tests.
// ?section=z:0.3 and ?explode=0.4 set the tools once the file is in (a pushed view, a test harness).
const params = new URLSearchParams(location.search);
const openArg = params.get('open');
if (openArg) window.cadgangOpen(openArg.split('|')).then(() => {
  const sec = params.get('section')?.match(/^([xyz]):([\d.]+)$/);
  if (sec) { $('#sectPos').value = Math.round(parseFloat(sec[2]) * 1000); setSectionAxis(sec[1]); }
  const ex = parseFloat(params.get('explode'));
  if (ex > 0) { $('#explode').value = Math.round(ex * 100); applyExplode(); }
});

// ------------------------------------------------------------- commands
// One table drives the hotkeys, the right-click menu and the hover tips.

const CMDS = [
  { key: 'f', label: 'Fit', run: fit, btn: '#fitBtn' },
  { key: 'e', label: 'Edges', run: () => toggle('edges', '#edgesBtn'), btn: '#edgesBtn', on: () => ui.edges },
  { key: 'w', label: 'Wireframe', run: () => toggle('wire', '#wireBtn'), btn: '#wireBtn', on: () => ui.wire },
  { key: 'g', label: 'Grid', run: () => toggle('grid', '#gridBtn'), btn: '#gridBtn', on: () => ui.grid },
  { key: 'c', label: 'Color parts', run: () => toggle('color', '#colorBtn'), btn: '#colorBtn', on: () => ui.color },
  { key: 'o', label: 'Orthographic', run: () => setOrtho(!ui.ortho), btn: '#orthoBtn', on: () => ui.ortho },
  { key: 'l', label: 'Next look', btn: '#look', run: () => { const s = $('#look'); s.selectedIndex = (s.selectedIndex + 1) % s.options.length; s.dispatchEvent(new Event('change', { bubbles: true })); } },
  { key: 'm', label: 'Measure', run: () => setMeasure(!measure.on), btn: '#measureBtn', on: () => measure.on },
  { sep: true },
  { key: 'b', label: 'Flip drawing over', btn: '#sideBtn', run: () => { orbit.pitch = -orbit.pitch; } },
  { key: '[', label: 'Turn left 90°', run: () => { orbit.yaw -= Math.PI / 2; } },
  { key: ']', label: 'Turn right 90°', run: () => { orbit.yaw += Math.PI / 2; } },
  { sep: true },
  ...['x', 'y', 'z'].map((a) => ({ key: a, label: `Section ${a.toUpperCase()}`, btn: `[data-sect="${a}"]`, run: () => setSectionAxis(section.axis === a ? '' : a), on: () => section.axis === a })),
  { key: 'i', label: 'Invert section', btn: '#sectFlip', run: () => { if (section.axis) { section.flip *= -1; updateSection(); } } },
  { key: 'Escape', label: 'Section off', btn: '[data-sect=""]', run: () => { if (measure.cancel()) return; setSectionAxis(''); setMeasure(false); } },
  { sep: true },
  ...['front', 'back', 'top', 'bottom', 'right', 'left', 'iso'].map((n, i) => ({ key: String(i + 1), label: `View ${n}`, run: () => setView(String(i + 1)) })),
  { sep: true },
  ...[['p', 'pen', 'Pen'], ['a', 'arrow', 'Arrow'], ['n', 'note', 'Note'], ['r', 'erase', 'Erase']].map(([key, t, label]) => ({ key, label, btn: `[data-tool="${t}"]`, run: () => markup.setTool(t), on: () => $(`[data-tool="${t}"]`).classList.contains('on') })),
  { key: 'Backspace', label: 'Clear markup', btn: '[data-clear]', run: () => $('[data-clear]').click() },
  { sep: true },
  { key: 'd', label: 'Dark / light', btn: '#themeToggle', run: () => $('#themeToggle').click(), on: () => document.documentElement.dataset.theme === 'dark' },
  { key: 'o', meta: true, label: 'Open…', btn: '#openBtn', run: () => $('#fileInput').click() },
  { key: 'z', meta: true, label: 'Undo', run: undo },
  { key: 'z', meta: true, shift: true, label: 'Redo', run: redo },
];
const keyLabel = (c) => (c.shift ? '⇧' : '') + (c.meta ? '⌘' : '') + ({ Escape: 'Esc', Backspace: '⌫' }[c.key] ?? c.key.toUpperCase());

window.addEventListener('keydown', (e) => {
  if (e.target.matches?.('input,select,textarea') || e.altKey) return;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const c = CMDS.find((c) => c.key === key && !!c.meta === (e.metaKey || e.ctrlKey) && !!c.shift === e.shiftKey);
  if (!c) return;
  e.preventDefault(); hideMenu(); c.run(); commit();
});

// --- undo: a snapshot of the view state after every action; ⌘Z walks back.
// ponytail: whole-state JSON snapshots, not deltas — the state is a few hundred bytes.
const history = { list: [], i: -1 };
function snap() {
  return JSON.stringify({ look: ui.look, edges: ui.edges, wire: ui.wire, grid: ui.grid, color: ui.color, ortho: ui.ortho,
    section: { axis: section.axis, pos: $('#sectPos').value, flip: section.flip }, explode: $('#explode').value,
    bodies: model.children.map((m) => m.visible), markup: markup.items, dims: measure.dims });
}
function commit() {
  const s = snap();
  if (s === history.list[history.i]) return;
  history.list.splice(history.i + 1); history.list.push(s); history.i = history.list.length - 1;
  try { localStorage.setItem(PREFS_KEY, JSON.stringify({ look: ui.look, edges: ui.edges, wire: ui.wire, grid: ui.grid, color: ui.color, ortho: ui.ortho })); } catch {}
}
// View preferences outlive the page, like the theme. Section, explode and body
// visibility belong to a file and start fresh with it.
const PREFS_KEY = 'cadgang-view';
try {
  const p = JSON.parse(localStorage.getItem(PREFS_KEY));
  if (p?.look in PRESETS) ui.look = $('#look').value = p.look;
  for (const k of ['edges', 'wire', 'grid', 'color']) if (typeof p?.[k] === 'boolean' && ui[k] !== p[k]) toggle(k, `#${k}Btn`);
  if (p?.ortho) setOrtho(true);
} catch {}
function apply(s) {
  const st = JSON.parse(s);
  if (st.look !== ui.look) { ui.look = $('#look').value = st.look; for (const m of model.children) styleMesh(m); }
  for (const k of ['edges', 'wire', 'grid', 'color']) if (ui[k] !== st[k]) toggle(k, `#${k}Btn`);
  if (ui.ortho !== st.ortho) setOrtho(st.ortho);
  $('#sectPos').value = st.section.pos; section.flip = st.section.flip; setSectionAxis(st.section.axis);
  $('#explode').value = st.explode; applyExplode();
  model.children.forEach((m, i) => setBodyVisible(m, st.bodies[i] ?? true));
  [...$('#bodies').querySelectorAll('input')].forEach((cb, i) => { cb.checked = model.children[i]?.visible ?? true; });
  if (JSON.stringify(markup.items) !== JSON.stringify(st.markup)) { markup.load(st.markup); markupChanged(st.markup); }
  if (JSON.stringify(measure.dims) !== JSON.stringify(st.dims ?? [])) measure.load(st.dims ?? []);
}
function undo() { if (history.i > 0) apply(history.list[--history.i]); }
function redo() { if (history.i < history.list.length - 1) apply(history.list[++history.i]); }
document.addEventListener('click', commit);   // after every button handler has run
document.addEventListener('change', commit);  // sliders on release, selects, body ticks

// --- right-click menu
const menu = Object.assign(document.createElement('div'), { id: 'ctx', hidden: true });
document.body.appendChild(menu);
function showMenu(x, y) {
  menu.replaceChildren(...CMDS.map((c) => {
    if (c.sep) return document.createElement('hr');
    const b = document.createElement('button');
    b.className = 'ghost' + (c.on?.() ? ' on' : '');
    b.append(Object.assign(document.createElement('span'), { textContent: c.label }), Object.assign(document.createElement('kbd'), { textContent: keyLabel(c) }));
    b.addEventListener('click', () => { hideMenu(); c.run(); });
    return b;
  }));
  menu.hidden = false;
  menu.style.left = `${Math.min(x, innerWidth - menu.offsetWidth - 8)}px`;
  menu.style.top = `${Math.min(y, innerHeight - menu.offsetHeight - 8)}px`;
}
function hideMenu() { menu.hidden = true; }
document.addEventListener('pointerdown', (e) => { if (!menu.contains(e.target)) hideMenu(); });

// --- hover tips: the element's title, shown at once and with its hotkey
const tip = Object.assign(document.createElement('div'), { id: 'tip', hidden: true });
document.body.appendChild(tip);
for (const c of CMDS) {
  const el = c.btn && $(c.btn);
  if (el) { el.dataset.tip = `${(el.title || c.label).replace(/\s*\([^)]*\)\s*$/, '')} · ${keyLabel(c)}`; el.removeAttribute('title'); }
}
document.addEventListener('pointerover', (e) => {
  const el = e.target.closest?.('[data-tip],[title]');
  if (!el) { tip.hidden = true; return; }
  if (el.title) { el.dataset.tip = el.title; el.removeAttribute('title'); }
  tip.textContent = el.dataset.tip; tip.hidden = false;
  const r = el.getBoundingClientRect();
  tip.style.left = `${Math.max(8, Math.min(r.left, innerWidth - tip.offsetWidth - 8))}px`;
  tip.style.top = `${r.bottom + 6}px`;
});
document.addEventListener('pointerout', (e) => { if (!e.relatedTarget?.closest?.('[data-tip],[title]')) tip.hidden = true; });
document.addEventListener('pointerdown', () => { tip.hidden = true; });
