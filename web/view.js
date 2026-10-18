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
import { explodeOffsets, radialOffsets } from './explode.js';
import { renderDrawing } from './drawing.js';
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

// Loading bar. A CAD file tessellates on the server in one call with no progress signal, so the bar runs on
// the clock against how long this file took last time (kept per name); a file never seen before gets a
// sliding bar. ponytail: time estimate, not real progress — stream per-body progress if loads get long.
const LOAD_KEY = 'cadgang-load-ms';
const loadTimes = (() => { try { return JSON.parse(localStorage.getItem(LOAD_KEY) || '{}'); } catch { return {}; } })();
let progressTimer = null;
function progressStart(name) {
  const el = $('#progress'), bar = el.firstElementChild, est = loadTimes[name], t0 = performance.now();
  el.hidden = false; el.classList.toggle('guess', !est); bar.style.width = '0%';
  clearInterval(progressTimer);
  if (est) progressTimer = setInterval(() => { bar.style.width = `${Math.min(95, 100 * (performance.now() - t0) / est)}%`; }, 100);
}
function progressEnd(name, ms) {
  clearInterval(progressTimer);
  const el = $('#progress'); el.classList.remove('guess'); el.firstElementChild.style.width = '100%';
  setTimeout(() => { el.hidden = true; el.firstElementChild.style.width = '0%'; }, 300);
  if (name && ms) { loadTimes[name] = ms; try { localStorage.setItem(LOAD_KEY, JSON.stringify(loadTimes)); } catch {} }
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
function subGeometry(pos, idx, first, count, nrm = null) {
  const map = new Map(); const outIdx = new Uint32Array(count * 3); const outPos = [], outNrm = [];
  for (let i = 0; i < count * 3; i++) {
    const v = idx[first * 3 + i];
    let j = map.get(v);
    if (j === undefined) {
      j = map.size; map.set(v, j); outPos.push(pos[3 * v], pos[3 * v + 1], pos[3 * v + 2]);
      if (nrm) outNrm.push(nrm[3 * v], nrm[3 * v + 1], nrm[3 * v + 2]);
    }
    outIdx[i] = j;
  }
  return { pos: Float32Array.from(outPos), idx: outIdx, nrm: nrm ? Float32Array.from(outNrm) : null };
}

/**
 * Face-border edges from a tessellation that knows its B-rep faces: an edge two
 * faces share, or an edge only one triangle uses (vertices are welded per
 * surface normal, so a sharp border is an open edge on both sides).
 */
function faceBorderEdges(pos, idx, faces) {
  const faceOf = new Uint32Array(idx.length / 3);
  faces.forEach((f, fi) => faceOf.fill(fi, f.first, f.first + f.count));
  const seen = new Map(); // edge key -> face id of the first triangle that used it, -1 once a second triangle has
  const out = [];
  const n = pos.length / 3;
  const push = (a, b) => out.push(pos[3 * a], pos[3 * a + 1], pos[3 * a + 2], pos[3 * b], pos[3 * b + 1], pos[3 * b + 2]);
  for (let t = 0; t < idx.length; t += 3) {
    const f = faceOf[t / 3];
    for (let e = 0; e < 3; e++) {
      const a = idx[t + e], b = idx[t + ((e + 1) % 3)];
      const k = a < b ? a * n + b : b * n + a;
      const prev = seen.get(k);
      if (prev === undefined) seen.set(k, f);
      else { if (prev >= 0 && prev !== f) push(a, b); seen.set(k, -1); }
    }
  }
  for (const [k, f] of seen) if (f >= 0) push(Math.floor(k / n), k % n);
  return new Float32Array(out);
}

function addMesh(geo, { edgeLines, faces, flat = false, name = '', file = '' } = {}) {
  if (!geo.getAttribute('normal')) geo.computeVertexNormals();
  const m = new THREE.Mesh(geo);
  m.userData.flat = flat;
  m.userData.file = file;
  m.userData.name = name || `body ${model.children.length + 1}`;
  m.userData.faces = faces;   // B-rep face ranges, when the importer knew them: picked by measure
  model.add(m);
  styleMesh(m);               // after add: the part colour is its index in the model
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
  styleMesh(l);
}
const inkColor = () => (document.documentElement.dataset.theme === 'dark' ? 0xffffff : 0x000000);
const addPart = (p, name) => (p.lines ? addLines(p.lines, p.name || name) : addMesh(p.geo, { ...p, name: p.name || name, file: name }));

// ------------------------------------------------------------------- bodies
//
// One mesh per body (a STEP assembly, a multi-body compound). The panel lists
// them with a checkbox each; EXPLODE slides every body out from the assembly
// centre along its own offset (explode.js: a pocketed part leaves along the
// pocket's axis). Hiding a body hides its edges and its section cap.

/** Fill the bodies panel; returns a note when a later file repeated a body and it was unticked. */
function listBodies() {
  const panel = $('#bodies');
  panel.replaceChildren();
  panel.hidden = model.children.length < 2;
  // A body a later file repeats (the leg file opened over the bench that already holds the leg) would
  // draw twice in the same place and fight triangle by triangle: the same box to a micron → untick it.
  // (Not the vertex count: the standalone leg tessellates to 4041 vertices, the one in the bench to 3629.)
  const sig = (m) => { const b = m.geometry.boundingBox ?? (m.geometry.computeBoundingBox(), m.geometry.boundingBox); return [...b.min.toArray(), ...b.max.toArray()].map((v) => +v.toFixed(3)).join(); };
  const first = new Map(), dups = [];
  for (const m of model.children) {
    if (!m.isMesh) continue;
    const o = first.get(sig(m));
    if (o && o.userData.file !== m.userData.file) { setBodyVisible(m, false); m.userData.dup = `repeats ${o.userData.name} of ${o.userData.file}`; dups.push(`${m.userData.file} repeats ${o.userData.name} of ${o.userData.file}: unticked`); }
    else if (!o) first.set(sig(m), m);
  }
  // Explode vectors: radial at once; the solver (cylinders, contacts, collisions) runs now for small
  // files and behind the SOLVE button for big ones, where its rays and fits take seconds.
  radialOffsets(model.children, bbox.getCenter(new THREE.Vector3()));
  const tris = model.children.reduce((n, m) => n + (m.geometry.index ? m.geometry.index.count : m.geometry.getAttribute('position').count) / 3, 0);
  $('#solveBtn').hidden = model.children.length < 2;
  if (model.children.length > 1 && tris <= 300000) solveExplode();
  for (const m of model.children) {
    const row = document.createElement('label');
    if (m.userData.dup) row.title = m.userData.dup;
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
  return dups.join(' · ');
}
/** Solve the explode vectors from the bodies at rest, then put the explode back. */
function solveExplode() {
  const t0 = performance.now();
  for (const m of model.children) { m.position.set(0, 0, 0); m.updateMatrixWorld(true); }
  explodeOffsets(model.children, bbox.getCenter(new THREE.Vector3()));
  applyExplode();
  say(`explode vectors solved in ${Math.round(performance.now() - t0)} ms`);
}
$('#solveBtn').addEventListener('click', () => { say('solving explode vectors…'); setTimeout(solveExplode, 30); });
// For a headless drive or a console: what the solver decided.
window.cadgangExplode = () => model.children.map((m) => ({ name: m.userData.name, offset: m.userData.offset?.toArray().map((v) => +v.toFixed(2)), rides: m.userData.parent?.userData.name ?? null, axis: m.userData.axis ?? null, nudge: +(m.userData.nudge ?? 0).toFixed(2) }));
/** The tick of each body row takes its colour when COLOR is on. */
function paintRows() {
  [...$('#bodies').querySelectorAll('input')].forEach((cb, i) => { cb.style.accentColor = ui.color ? `#${partColor(i).getHexString()}` : ''; });
}
function setBodyVisible(m, on) {
  m.visible = on;
  if (m.userData.edges) m.userData.edges.visible = on;
  measure.invalidate();
}
// A body's explode vector at full slider: the solver's offset, or along the axis the
// user chose for it (`${sign}${axis}`, right-click menu), at least a body-length
// long so a part the solver left put still moves. A drag adds a nudge along that
// axis in world units, slider or not.
const AXES = ['+x', '-x', '+y', '-y', '+z', '-z'];
function explodeVec(m) {
  const o = m.userData.offset ?? new THREE.Vector3();
  if (!m.userData.axis) return o.clone();
  const len = Math.max(o.length(), m.geometry.boundingBox?.getSize(new THREE.Vector3()).length() ?? 0);
  return new THREE.Vector3().setComponent('xyz'.indexOf(m.userData.axis[1]), m.userData.axis[0] === '-' ? -len : len);
}
// Does the vector move the body at all? The base part's radial offset is a rounding away from zero.
const moves = (m, v) => v.length() > 0.01 * (m.geometry.boundingBox?.getSize(new THREE.Vector3()).length() ?? 1);
function applyExplode() {
  const k = parseFloat($('#explode').value) / 100;
  const done = new Set();
  const place = (m) => {   // a pocketed part rides on the body its pocket is in
    if (done.has(m)) return m.position;
    done.add(m);
    const v = explodeVec(m), len = v.length();
    m.position.copy(v).multiplyScalar(len ? k * 2 + (m.userData.nudge ?? 0) / len : 0);
    if (m.userData.parent) m.position.add(place(m.userData.parent));
    if (m.userData.edges) m.userData.edges.position.copy(m.position);
    return m.position;
  };
  for (const m of model.children) place(m);
  measure.invalidate();
}
$('#explode').addEventListener('input', applyExplode);
function setExplode(v) { $('#explode').value = Math.max(0, Math.min(100, v)); applyExplode(); }

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
  const dups = listBodies();
  setupSection();
  // A flat drawing is read from above and handled like paper: pan, turn in quarters, flip over.
  ui.flat = size.z < 1e-9; $('#sideBtn').hidden = !ui.flat;
  if (!keep) { if (ui.flat) setView('3'); fit(); }   // a reload of a changed file keeps the camera
  edges.visible = ui.edges;
  say(dups ? `${name} in ${ms} ms · ${dups}` : `${name} in ${ms} ms`);
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
  const b = new THREE.Box3().setFromObject(model);   // what is on screen now, exploded or not
  b.getCenter(orbit.target);
  const r = b.getSize(new THREE.Vector3()).length() / 2;
  orbit.dist = r / Math.sin(THREE.MathUtils.degToRad(persp.fov / 2)) * 1.1;
}

const VIEWS = { 1: [0, 0], 2: [Math.PI, 0], 3: [0, Math.PI / 2 - 1e-4], 4: [0, -Math.PI / 2 + 1e-4], 5: [Math.PI / 2, 0], 6: [-Math.PI / 2, 0], 7: [-0.6, 0.5] };
function setView(n) { const v = VIEWS[n]; if (v) { orbit.yaw = v[0]; orbit.pitch = v[1]; } }

let drag = null;
function pan(dx, dy) {
  const k = orbit.dist * 0.0015;
  const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
  const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
  orbit.target.addScaledVector(right, -dx * k).addScaledVector(up, dy * k);
}
// Fingers (an iPad): one turns, two pinch-zoom and pan. The pencil never gets here — markup takes it.
const touches = new Map();   // pointerId → last {x, y} of each finger down
const pair = () => { const [a, b] = [...touches.values()]; return { d: Math.hypot(a.x - b.x, a.y - b.y), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; };
for (const t of ['gesturestart', 'gesturechange', 'gestureend'])   // WebKit's own pinch would zoom a second time
  renderer.domElement.addEventListener(t, (e) => { if (touches.size) { e.preventDefault(); e.stopImmediatePropagation(); } }, { capture: true });
renderer.domElement.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'touch') {
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    renderer.domElement.setPointerCapture(e.pointerId);
    if (touches.size > 1) { drag = null; return; }
  }
  drag = { id: e.pointerId, x: e.clientX, y: e.clientY, pan: e.button === 2 || e.shiftKey, downX: e.clientX, downY: e.clientY, click: e.button === 0 };
  if (e.button === 0 && !e.shiftKey && !measure.on && onCap(e)) drag.sect = sectionScreenAxis(e);
  else if (e.button === 0 && !e.shiftKey && !measure.on && e.pointerType !== 'touch') {
    const hit = partAt(e);   // a part under the mouse slides along its explode axis; empty space orbits
    if (hit) { const v = explodeVec(hit.body); if (moves(hit.body, v)) drag.part = { m: hit.body, ...screenAxis(hit.point, v.normalize()) }; }
  }
  renderer.domElement.setPointerCapture(e.pointerId);
});
renderer.domElement.addEventListener('pointermove', (e) => {
  if (touches.size > 1) {
    if (!touches.has(e.pointerId)) return;
    const before = pair();
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const now = pair();
    if (before.d > 0 && now.d > 0) orbit.dist *= before.d / now.d;
    pan(now.x - before.x, now.y - before.y);
    return;
  }
  if (!drag) { if (measure.on) measure.hover(e); else renderer.domElement.classList.toggle('oncap', onCap(e) || (e.pointerType !== 'touch' && !!partAt(e))); return; }
  if (drag.id !== e.pointerId) return;
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
  if (drag.part) {
    drag.part.m.userData.nudge = (drag.part.m.userData.nudge ?? 0) + dx * drag.part.sx + dy * drag.part.sy;
    applyExplode();
    return;
  }
  if (drag.pan || ui.flat) {
    pan(dx, dy);
  } else {
    orbit.yaw += (e.pointerType === 'touch' ? -dx : dx) * 0.006;   // a finger drags the model with it; a mouse drags the camera
    orbit.pitch += dy * 0.006;
  }
});
renderer.domElement.addEventListener('pointerup', (e) => {
  const still = drag && Math.hypot(e.clientX - drag.downX, e.clientY - drag.downY) < 4;
  if (drag?.click && measure.on && still) measure.click(e);
  if (e.button === 2 && still) showMenu(e.clientX, e.clientY, partAt(e)?.body);
  if (drag?.sect || drag?.part) commit();
  drag = null;
  touches.delete(e.pointerId);
});
renderer.domElement.addEventListener('pointercancel', (e) => { drag = null; touches.delete(e.pointerId); });
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
  if (!hit) return false;
  // A model face within two slider steps of the plane is the cut face as far as the eye can tell: the plane
  // dragged onto a face left the face in front of the cap, and the cap could not be grabbed again.
  const i = 'xyz'.indexOf(section.axis), tol = 2e-3 * (bbox.max.getComponent(i) - bbox.min.getComponent(i));
  return hit.object.material === capMaterial || Math.abs(section.plane.distanceToPoint(hit.point)) < tol;
}
// The body under the pointer (a hit on its cap counts, a clipped-away face does not), with the point.
function partAt(e) {
  if ($('#bodies').hidden) return null;   // one body is not an assembly
  const r = renderer.domElement.getBoundingClientRect();
  raycaster.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
  const h = raycaster.intersectObjects(model.children, true).find((h) => h.object.isMesh && h.object.visible && h.object.parent.visible && (!section.axis || section.plane.distanceToPoint(h.point) > -1e-6));
  if (!h) return null;
  const body = model.children.includes(h.object) ? h.object : h.object.parent;
  return body.isMesh ? { body, point: h.point } : null;
}
// World units the plane moves per pixel of pointer travel in x and y: one unit
// along the axis, projected to screen at the grabbed cap point, then inverted.
// ponytail: onCap and partAt raycast every hover; a BVH is the upgrade if huge models drag.
function sectionScreenAxis(e) {
  const i = 'xyz'.indexOf(section.axis);
  const p0 = raycaster.ray.intersectPlane(section.plane, new THREE.Vector3()) ?? orbit.target.clone(); // raycaster set by onCap
  return screenAxis(p0, new THREE.Vector3().setComponent(i, 1));
}
function screenAxis(p0, dir) {
  const r = renderer.domElement.getBoundingClientRect();
  const p1 = p0.clone().add(dir);
  const a = p0.clone().project(camera), b = p1.project(camera);
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
  const [nPos, nIdx, nFaces, nBodies, nNameBytes, nNrm] = new Uint32Array(buffer, 0, 6);
  let off = 24;
  const pos = new Float32Array(buffer, off, nPos); off += nPos * 4;
  const nrm = nNrm ? new Float32Array(buffer, off, nNrm) : null; off += nNrm * 4;
  const idx = new Uint32Array(buffer, off, nIdx); off += nIdx * 4;
  const fr = new Uint32Array(buffer, off, nFaces * 2); off += nFaces * 8;
  const br = new Uint32Array(buffer, off, nBodies * 2); off += nBodies * 8;
  const names = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, off, nNameBytes)));
  const faces = Array.from({ length: nFaces }, (_, i) => ({ first: fr[2 * i], count: fr[2 * i + 1] }));
  const parts = [];
  for (let b = 0; b < nBodies; b++) {
    const first = br[2 * b], count = br[2 * b + 1];
    const sub = subGeometry(pos, idx, first, count, nrm);
    const own = faces.filter((f) => f.first >= first && f.first < first + count).map((f) => ({ first: f.first - first, count: f.count }));
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(sub.pos, 3));
    if (sub.nrm) geo.setAttribute('normal', new THREE.BufferAttribute(sub.nrm, 3));
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
    say(`loading ${name}…`); progressStart(name); const tf = performance.now();
    try {
      const parts = CAD_EXT.test(name)
        ? parseCad(await fetchBuffer(`/api/view/tessellate?name=${encodeURIComponent(name)}`, { method: 'POST', body: buffer }))
        : await parseMesh(ext, buffer, name);
      for (const p of parts) addPart(p, name);
      shown++; label = name; progressEnd(name, performance.now() - tf);
    } catch (e) { progressEnd(); loadFailed(name, e); return; }
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
    say(`loading ${name}…`); progressStart(name); const tf = performance.now();
    try {
      const q = `path=${encodeURIComponent(p)}`;
      const parts = CAD_EXT.test(name)
        ? parseCad(await fetchBuffer(`/api/view/tessellate?${q}`, { method: 'POST' }))
        : await parseMesh(name.toLowerCase().split('.').pop(), await fetchBuffer(`/api/view/file?${q}`), name);
      for (const part of parts) addPart(part, name);
      shown++; label = name; progressEnd(name, performance.now() - tf);
    } catch (e) { progressEnd(); loadFailed(name, e); return; }
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
// Drawing: the page registers what is open; Claude collects the spec over MCP and sends it back here to render.
$('#drawBtn').addEventListener('click', async () => {
  if (!model.children.length) return say('open a file first', true);
  const size = bbox.getSize(new THREE.Vector3()).toArray().map((v) => +v.toFixed(2));
  await api('/drawing/request', { method: 'POST', body: { subject, name: $('#fileName').textContent, size, bodies: model.children.map((m) => m.userData.name), dims: measure.dims.length } }).catch((e) => say(e.message, true));
  const prompt = 'Make the drawing for the file open in CADgang: call cadgang_drawing_request, ask me its questions one at a time, then cadgang_drawing_make.';
  try { await navigator.clipboard.writeText(prompt); } catch {}
  say('drawing requested — paste the copied prompt into Claude Code and answer its questions');
});
async function makeDrawing(spec) {
  say('rendering drawing…');
  try {
    const html = renderDrawing(spec, { renderer, scene, model, bbox, measure, hide: [grid, markup.group].filter(Boolean), restore: () => { resize(); renderer.setSize(viewport.clientWidth, viewport.clientHeight); } });
    const r = await api('/drawing/result', { method: 'POST', body: { html, subject } });
    say(`drawing saved: ${r.path}`);
    window.open('/api/view/drawing');
  } catch (e) { say(`drawing failed: ${e.message}`, true); api('/drawing/result', { method: 'POST', body: { error: e.message } }).catch(() => {}); }
}
// Only the Mac shell can register file associations; the button exists only inside it.
$('#defaultBtn').hidden = !window.cadgangDesktop;
$('#defaultBtn').addEventListener('click', () => window.webkit?.messageHandlers?.cadgang?.postMessage({ cmd: 'defaultApp' }));
window.cadgangNotify = say;
window.cadgangBodies = () => model.children.filter((m) => m.isMesh).map((m) => ({ name: m.userData.name, file: m.userData.file, verts: m.geometry.getAttribute('position').count, box: [...m.geometry.boundingBox.min.toArray(), ...m.geometry.boundingBox.max.toArray()].map((v) => +v.toFixed(3)), visible: m.visible }));
// For a headless drive: put the camera where a snapshot's {yaw, pitch, dist, target} had it.
window.cadgangCamera = (c) => { Object.assign(orbit, { yaw: c.yaw ?? orbit.yaw, pitch: c.pitch ?? orbit.pitch, dist: c.dist ?? orbit.dist }); if (c.target) orbit.target.fromArray(c.target); };
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
// ?follow — a second screen (an iPad with a pencil) on the Mac app's server: it opens what the Mac
// has open and follows when that changes. It is never Claude's eyes (no focus, no snapshots);
// its markups reach the Mac's window through the markup_changed broadcast like any other page's.
const follow = new URLSearchParams(location.search).has('follow');
const followTo = (s) => { if (follow && s && s !== subject && s.startsWith('/')) window.cadgangOpen(s.split('|'), { keep: true }); };
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
  if (follow) return;
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
const focus = () => { if (!follow && ws?.readyState === 1 && document.hasFocus()) ws.send(JSON.stringify({ type: 'focus' })); };
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
    if (msg.type === 'drawing' && msg.spec) makeDrawing(msg.spec);
    if (msg.type === 'subject') followTo(msg.subject);
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

fetch('/api/health').then((r) => r.json()).then((h) => {
  $('#version').textContent = 'v' + h.version;
  if (!h.lan || follow) return;   // the VPS has no LAN; a follower is already the iPad
  const link = `http://${h.lan}:${h.port}/view?follow`;
  $('#ipadBtn').hidden = false;
  // In the Mac app the button AirDrops the link: pick the iPad, Safari opens it. Elsewhere it copies.
  $('#ipadBtn').addEventListener('click', () => window.webkit?.messageHandlers?.cadgang
    ? window.webkit.messageHandlers.cadgang.postMessage({ cmd: 'airdrop', url: link })
    : navigator.clipboard.writeText(link).then(() => say(`copied ${link}`), () => say(link)));
}).catch(() => {});
// For headless drives: the scene objects behind the page.
window.__view = { model, section, orbit, ui, measure, THREE, get camera() { return camera; },
  project: (x, y, z) => { const r = renderer.domElement.getBoundingClientRect(), v = new THREE.Vector3(x, y, z).project(camera); return { x: r.left + (v.x + 1) / 2 * r.width, y: r.top + (1 - v.y) / 2 * r.height }; } };
// Files queued by the shell before the page was ready.
if (window.cadgangPending?.length) window.cadgangOpen(window.cadgangPending);
// ?open=/abs/a.step|/abs/b.stl — the same local-path door, for the shell and for headless tests.
// ?section=z:0.3 and ?explode=0.4 set the tools once the file is in (a pushed view, a test harness).
const params = new URLSearchParams(location.search);
const openArg = params.get('open');
if (follow) fetch('/api/view/screen').then((r) => r.json()).then((d) => followTo(d.screen?.subject)).catch(() => {});
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
  { sep: true },
  { key: '0', label: 'Explode all / none', btn: '#explode', run: () => setExplode(+$('#explode').value ? 0 : 100), on: () => +$('#explode').value > 0 },
  { key: '=', label: 'Explode more', run: () => setExplode(+$('#explode').value + 10) },
  { key: '-', label: 'Explode less', run: () => setExplode(+$('#explode').value - 10) },
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
    bodies: model.children.map((m) => m.visible), parts: model.children.map((m) => [m.userData.axis ?? null, +(m.userData.nudge ?? 0).toFixed(3)]),
    markup: markup.items, dims: measure.dims });
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
  model.children.forEach((m, i) => { const [axis, nudge] = st.parts?.[i] ?? [null, 0]; m.userData.axis = axis || undefined; m.userData.nudge = nudge || 0; });
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
// Right-clicked on a body: its explode axis first (Auto = the solver's, with the way it went).
function partCmds(m) {
  if (!m) return [];
  const v = explodeVec(m), i = ['x', 'y', 'z'].reduce((b, _, j) => (Math.abs(v.getComponent(j)) > Math.abs(v.getComponent(b)) ? j : b), 0);
  const auto = moves(m, v) ? ` (${v.getComponent(i) < 0 ? '−' : '+'}${'XYZ'[i]})` : '';
  const set = (axis) => { m.userData.axis = axis; if (!axis) m.userData.nudge = 0; applyExplode(); commit(); };
  return [
    { head: m.userData.name },
    { label: `Explode auto${auto}`, run: () => set(undefined), on: () => !m.userData.axis },
    ...AXES.map((a) => ({ label: `Explode ${a.replace('-', '−').toUpperCase()}`, run: () => set(a), on: () => m.userData.axis === a })),
    { sep: true },
  ];
}
function showMenu(x, y, part) {
  menu.replaceChildren(...[...partCmds(part), ...CMDS].map((c) => {
    if (c.sep) return document.createElement('hr');
    if (c.head) return Object.assign(document.createElement('div'), { className: 'hd', textContent: c.head });
    const b = document.createElement('button');
    b.className = 'ghost' + (c.on?.() ? ' on' : '');
    b.append(Object.assign(document.createElement('span'), { textContent: c.label }), Object.assign(document.createElement('kbd'), { textContent: c.key ? keyLabel(c) : '' }));
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
