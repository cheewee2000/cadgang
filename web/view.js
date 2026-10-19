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
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { ThreeMFLoader } from 'three/addons/loaders/3MFLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { attachOrbitInput } from './orbitinput.js';
import { createMarkup } from './markup.js';
import { parseDxf } from './dxf.js';
import { explodeOffsets, radialOffsets } from './explode.js';
import { renderDrawing } from './drawing.js';
import { createMeasure } from './measure.js';
import { NURBSCurve } from 'three/addons/curves/NURBSCurve.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { MATERIALS, materialOf, pickMaterial, materialFor } from './materials.js';

const $ = (s) => document.querySelector(s);
const ui = { edges: true, wire: false, grid: true, look: 'shaded', ortho: false, flat: false, color: false }; // flat: a 2D drawing is open
const section = { plane: new THREE.Plane(new THREE.Vector3(0, 0, -1), 0), axis: '', flip: 1 };
const CAD_EXT = /\.(step|stp|iges|igs|brep)$/i;

let statusTimer = null;
function say(text, isError = false, keep = false) {
  const el = $('#status');
  el.textContent = text;
  el.classList.toggle('err', isError);
  clearTimeout(statusTimer);
  if (text && !isError && !keep) statusTimer = setTimeout(() => { el.textContent = ''; }, 4000);
}

// Loading bar. A CAD file tessellates on the server in one call with no progress signal, so the bar runs on
// the clock against how long this file took last time (kept per name); a file never seen before gets a
// sliding bar. ponytail: time estimate, not real progress — stream per-body progress if loads get long.
const LOAD_KEY = 'cadgang-load-ms';
const loadTimes = (() => { try { return JSON.parse(localStorage.getItem(LOAD_KEY) || '{}'); } catch { return {}; } })();
let progressTimer = null;
function progressStart(name, label = `loading ${name}…`) {
  const el = $('#progress'), bar = el.querySelector('.track > div'), est = loadTimes[name], t0 = performance.now();
  el.querySelector('span').textContent = label;
  el.hidden = false; el.classList.toggle('guess', !est); bar.style.width = '0%';
  clearInterval(progressTimer);
  if (est) progressTimer = setInterval(() => { bar.style.width = `${Math.min(95, 100 * (performance.now() - t0) / est)}%`; }, 100);
}
function progressEnd(name, ms) {
  clearInterval(progressTimer);
  const el = $('#progress'), bar = el.querySelector('.track > div'); el.classList.remove('guess'); bar.style.width = '100%';
  setTimeout(() => { el.hidden = true; bar.style.width = '0%'; }, 300);
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
const ambient = new THREE.AmbientLight(0xffffff, 1.15), hemi = new THREE.HemisphereLight(0xffffff, 0xdedbd4, 0.6);
scene.add(key, fill, ambient, hemi);

/** Render presets. Every mesh carries its own instance so per-mesh flags (flat, wire, clipping) never leak. */
const PRESETS = {
  shaded: () => new THREE.MeshStandardMaterial({ color: 0xb9b8b3, metalness: 0.25, roughness: 0.5 }),
  metal: () => new THREE.MeshStandardMaterial({ color: 0xcfd0d2, metalness: 0.95, roughness: 0.28 }),
  plastic: () => new THREE.MeshStandardMaterial({ color: 0xe8e4dc, metalness: 0, roughness: 0.65 }),
  glass: () => new THREE.MeshPhysicalMaterial({ color: 0xdfe8ee, metalness: 0, roughness: 0.05, transmission: 0.9, thickness: 0, transparent: true, opacity: 0.6 }),
  xray: () => new THREE.MeshBasicMaterial({ color: 0x2f5d8a, transparent: true, opacity: 0.18, depthWrite: false }),
  normals: () => new THREE.MeshNormalMaterial(),
  materials: null,   // per body, from what it is made of: materialFor (materials.js)
};
const SOLID_LOOKS = new Set(['shaded', 'metal', 'plastic']);
// One hue per body or layer when COLOR is on; golden-ratio spacing keeps any count apart.
const partColor = (i) => new THREE.Color().setHSL((i * 0.618034) % 1, 0.6, 0.5);
function styleMesh(m) {
  const i = model.children.indexOf(m);
  if (m.isLine) {   // a drawing keeps its ink unless coloured by layer
    m.material.color.set(ui.color ? partColor(i) : inkColor());
    m.material.clippingPlanes = section.axis && bbox ? [section.plane] : [];
    return;
  }
  // one material per finish: a body from a multi-material glTF mesh keeps a group per finish (userData.groups)
  const mats = (m.userData.groups ?? [m.userData]).map((src) => {
    const mat = ui.look === 'materials' ? materialFor(THREE, m, src) : PRESETS[ui.look]();
    if (ui.color && mat.color) mat.color.copy(partColor(i));
    // the file's own colour (a STEP part's material) on the solid looks; COLOR still overrides it
    else if (src.color && SOLID_LOOKS.has(ui.look)) mat.color.setRGB(...src.color, THREE.SRGBColorSpace);
    if (!ui.color && src.pbr && SOLID_LOOKS.has(ui.look)) Object.assign(mat, src.pbr);
    mat.side = section.axis && bbox ? THREE.FrontSide : THREE.DoubleSide;
    mat.flatShading = !!m.userData.flat;
    mat.wireframe = ui.wire;
    mat.clippingPlanes = section.axis && bbox ? [section.plane] : [];
    return mat;
  });
  for (const x of [].concat(m.material ?? [])) x.dispose();
  m.material = m.userData.groups ? mats : mats[0];
}
const eachMat = (m, f) => { for (const x of [].concat(m.material)) f(x); };
const edgeMaterial = new THREE.LineBasicMaterial({ color: 0x2f5d8a, transparent: true, opacity: 0.85 });
const model = new THREE.Group();     // meshes
const edges = new THREE.Group();     // their edge overlays
scene.add(model, edges);
let grid = null;
let bbox = null;
let sources = [];   // what each open file loaded as: [{name, cad, buffer}] (CAD tessellated), for Share to web

function clearModel() {
  for (const g of [model, edges]) {
    for (const o of g.children) { o.geometry?.dispose(); if (o.material !== edgeMaterial) for (const x of [].concat(o.material ?? [])) x.dispose?.(); }
    g.clear();
  }
  bbox = null;
  sources = [];
  rot.identity();
  setRender(false);
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

function addMesh(geo, { edgeLines, faces, flat = false, name = '', file = '', path = [], color = null, pbr = null, groups = null } = {}) {
  if (!geo.getAttribute('normal')) geo.computeVertexNormals();
  const m = new THREE.Mesh(geo);
  m.userData.flat = flat;
  m.userData.file = file;
  m.userData.name = name || `body ${model.children.length + 1}`;
  m.userData.path = path;     // the STEP assembly groups above it, outermost first
  m.userData.color = color;   // the file's colour for it [r, g, b] 0..1, or null
  m.userData.pbr = pbr;       // the file's roughness/metalness, or null
  m.userData.groups = groups; // [{color, pbr}] per geometry group: one body, several finishes (glTF multi-material mesh)
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
  highlightBody(null);
  panel.replaceChildren(bodiesHead());
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
  $('#resetBtn').hidden = model.children.length < 2;
  if (model.children.length > 1 && tris <= 300000) solveExplode();
  // Rows nest under the file's assembly groups (STEP): a group row folds, ticks all it holds, and solos on a click.
  const root = { kids: new Map(), bodies: [] };
  for (const m of model.children) {
    let node = root;
    for (const g of m.userData.path ?? []) { if (!node.kids.has(g)) node.kids.set(g, { kids: new Map(), bodies: [] }); node = node.kids.get(g); }
    node.bodies.push(m);
  }
  const under = (node) => [...node.bodies, ...[...node.kids.values()].flatMap(under)];
  const render = (node, into, depth) => {
    for (const [g, kid] of node.kids) {
      const box = document.createElement('div'); box.className = 'group';
      const row = document.createElement('label'); row.className = 'group-row';
      const fold = document.createElement('button'); fold.className = 'ghost fold';
      const inner = document.createElement('div'); inner.className = 'group-body'; inner.hidden = depth > 0;
      const paint = () => { fold.textContent = inner.hidden ? '+' : '−'; fold.title = inner.hidden ? 'Unfold' : 'Fold'; };
      fold.addEventListener('click', (e) => { e.preventDefault(); inner.hidden = !inner.hidden; paint(); });
      paint();
      const members = under(kid);
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.className = 'group-cb';
      cb.addEventListener('change', () => { for (const m of members) setBodyVisible(m, cb.checked); syncRows(); });
      cb._members = members;
      const nm = document.createElement('span'); nm.textContent = `${g} (${members.length})`;
      nm.title = 'Click: only this group · Shift-click: all bodies';
      nm.addEventListener('click', (e) => { e.preventDefault(); for (const o of model.children) setBodyVisible(o, e.shiftKey || members.includes(o)); syncRows(); });
      row.append(fold, cb, nm);
      box.append(row, inner);
      into.appendChild(box);
      render(kid, inner, depth + 1);
    }
    for (const m of node.bodies) {
      const row = document.createElement('label');
      if (m.userData.dup) row.title = m.userData.dup;
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.className = 'body-cb'; cb.checked = m.visible;
      cb._body = m;
      cb.addEventListener('change', () => { setBodyVisible(m, cb.checked); syncRows(); });
      const nm = document.createElement('span'); nm.textContent = m.userData.name.replace(/_part$/, '');   // cadquery's leaf suffix
      nm.title = 'Click: only this body · Shift-click: all bodies';
      nm.addEventListener('click', (e) => {
        e.preventDefault();
        for (const o of model.children) setBodyVisible(o, e.shiftKey || o === m);
        syncRows();
      });
      row.addEventListener('pointerenter', () => highlightBody(m));
      row.addEventListener('pointerleave', () => highlightBody(null));
      if (root.kids.size) row.append(Object.assign(document.createElement('span'), { className: 'fold-gap' }));   // aligns with the groups' +/−
      const pick = document.createElement('select'); pick.className = 'ghost mat-pick'; pick.title = 'What this body is made of (MATERIALS look)';
      for (const [k, d] of Object.entries(MATERIALS)) pick.append(new Option(d.label, k));
      pick.value = materialOf(m);
      pick.addEventListener('change', () => { pickMaterial(m, pick.value); styleMesh(m); rerender(); });
      row.append(cb, nm, pick);
      into.appendChild(row);
    }
  };
  render(root, panel, 0);
  const all = document.createElement('button'); all.className = 'ghost bodies-all'; all.textContent = 'SHOW ALL'; all.title = 'Show every body';
  all.addEventListener('click', () => {
    for (const m of model.children) setBodyVisible(m, true);
    syncRows();   // body ticks on, group ticks full (not half)
  });
  panel.append(all);
  syncRows();
  paintRows();
  return dups.join(' · ');
}
/**
 * The panel's title row: − folds it to just the title, + brings it back. The grip on the
 * panel's right edge drags its width (CSS resize had an invisible corner and no touch).
 * Both are remembered per browser.
 */
const BODIES_KEY = 'cadgang.bodies';
function bodiesHead() {
  const panel = $('#bodies');
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(BODIES_KEY) || '{}'); } catch {}
  if (saved.width) panel.style.width = `${saved.width}px`;
  panel.classList.toggle('min', !!saved.min);
  const head = document.createElement('div'); head.className = 'bodies-head';
  const btn = document.createElement('button'); btn.className = 'ghost';
  const paint = () => { const min = panel.classList.contains('min'); btn.textContent = min ? '+' : '−'; btn.title = min ? 'Show the bodies' : 'Fold the list'; };
  btn.addEventListener('click', () => { panel.classList.toggle('min'); paint(); saveBodies(); });
  paint();
  const tools = document.createElement('span'); tools.className = 'bodies-tools'; tools.append(btn);
  // Absolutely placed against the panel, so it spans the panel's full height from inside the head.
  const grip = document.createElement('div'); grip.className = 'bodies-grip'; grip.title = 'Drag to set the width';
  grip.addEventListener('pointerdown', (e) => {
    e.preventDefault(); e.stopPropagation();
    grip.setPointerCapture(e.pointerId);
    const x0 = e.clientX, w0 = panel.offsetWidth;
    const move = (ev) => { panel.style.width = `${Math.min(innerWidth * 0.7, Math.max(120, w0 + ev.clientX - x0))}px`; };
    const up = () => {
      for (const [t, f] of [['pointermove', move], ['pointerup', up], ['pointercancel', up]]) grip.removeEventListener(t, f);
      saveBodies();
    };
    grip.addEventListener('pointermove', move); grip.addEventListener('pointerup', up); grip.addEventListener('pointercancel', up);
  });
  head.append(Object.assign(document.createElement('span'), { textContent: 'BODIES' }), tools, grip);
  return head;
}
function saveBodies() {
  const panel = $('#bodies');
  try { localStorage.setItem(BODIES_KEY, JSON.stringify({ min: panel.classList.contains('min'), width: panel.style.width ? panel.offsetWidth : null })); } catch {}
}

/** Solve the explode vectors from the bodies at rest, then put the explode back. */
function solveExplode() {
  const t0 = performance.now();
  // Solve in the file's own frame: the probes run along x, y and z, and a model turned 45° has no faces on them.
  // The offsets turn back with the geometry.
  const q = rot.clone(), turned = q.w < 1 - 1e-9;
  if (turned) bakeRot(new THREE.Quaternion());
  for (const m of model.children) { m.position.set(0, 0, 0); m.updateMatrixWorld(true); }
  explodeOffsets(model.children, bbox.getCenter(new THREE.Vector3()));
  if (turned) bakeRot(q);
  applyExplode();
  say(`explode vectors solved in ${Math.round(performance.now() - t0)} ms`);
}
$('#solveBtn').addEventListener('click', () => {
  say('solving explode vectors…'); progressStart('explode', 'solving explode vectors…');
  setTimeout(() => { const t = performance.now(); try { solveExplode(); } finally { progressEnd('explode', performance.now() - t); } }, 30);
});
// For a headless drive or a console: what the solver decided.
window.cadgangExplode = () => model.children.map((m) => ({ name: m.userData.name, offset: m.userData.offset?.toArray().map((v) => +v.toFixed(2)), rides: m.userData.parent?.userData.name ?? null, axis: m.userData.axis ?? null, pull: m.userData.pull == null ? null : +m.userData.pull.toFixed(2) }));
/** Body ticks in model order (a group tree renders them out of order). */
const bodyBoxes = () => { const by = new Map([...$('#bodies').querySelectorAll('input.body-cb')].map((cb) => [cb._body, cb])); return model.children.map((m) => by.get(m)).filter(Boolean); };
/** Ticks follow the bodies: a group is ticked when all of it shows, half when some does. */
function syncRows() {
  for (const cb of $('#bodies').querySelectorAll('input.body-cb')) cb.checked = cb._body.visible;
  for (const cb of $('#bodies').querySelectorAll('input.group-cb')) {
    const on = cb._members.filter((m) => m.visible).length;
    cb.checked = on === cb._members.length; cb.indeterminate = on > 0 && on < cb._members.length;
  }
}
/** The tick of each body row takes its colour when COLOR is on. */
function paintRows() {
  bodyBoxes().forEach((cb, i) => { cb.style.accentColor = ui.color ? `#${partColor(i).getHexString()}` : ''; });
}
/**
 * Hovering a body row lays a see-through overlay on that body, drawn over everything, so the
 * row can be matched to its part even when it is buried inside the assembly. A child of the
 * body, so it rides the explode; it shares the geometry and dies on leave.
 */
let hoverOverlay = null;
let hovered = null;
/** The body under the mouse: its overlay, and its row in the bodies list (or the folded group row that holds it). */
function hoverBody(m) {
  if (m === hovered) return;
  hovered = m;
  highlightBody(m);
  for (const r of $('#bodies').querySelectorAll('.hover')) r.classList.remove('hover');
  let row = m && bodyBoxes().find((cb) => cb._body === m)?.closest('label');
  while (row && !row.offsetParent) row = row.parentElement.closest('.group')?.querySelector(':scope > .group-row');
  if (row) { row.classList.add('hover'); row.scrollIntoView({ block: 'nearest' }); }
}
function highlightBody(m) {
  if (hoverOverlay) { hoverOverlay.parent?.remove(hoverOverlay); hoverOverlay.material.dispose(); hoverOverlay = null; }
  if (!m) return;
  const opts = { color: 0xff5a1f, transparent: true, opacity: m.isLine ? 1 : 0.45, depthTest: false, depthWrite: false,
    clippingPlanes: section.axis && bbox ? [section.plane] : [] };
  hoverOverlay = m.isLine
    ? new THREE.LineSegments(m.geometry, new THREE.LineBasicMaterial(opts))
    : new THREE.Mesh(m.geometry, new THREE.MeshBasicMaterial({ ...opts, side: THREE.DoubleSide }));
  hoverOverlay.renderOrder = 10;
  hoverOverlay.raycast = () => {};   // never a measure or markup target
  m.add(hoverOverlay);
}
function setBodyVisible(m, on) {
  m.visible = on;
  if (m.userData.edges) m.userData.edges.visible = on;
  measure.invalidate();
}
// A body's explode vector at full slider: the solver's offset, or along the axis the
// user chose for it (`${sign}${axis}`, right-click menu), at least a body-length
// long so a part the solver left put still moves. Every part travels the slider's fraction of its
// maximum travel: twice the solver's offset, or userData.pull (world units) once a drag pushed it
// further. Dragging a part IS the slider with that part as the handle: the whole model follows so
// each part sits at the same fraction of its own maximum; dragged past its maximum, the part's
// maximum grows to where it is (and the slider pins at 100). RESET forgets maxima and axes.
// (v0.14.16: before, a drag pinned only that part at a fixed spot and the rest stayed put.)
// userData.axis: a world unit vector [x, y, z] picked off a face (v0.14.10), or a `${sign}${axis}`
// string from the old menu (still honoured when a saved view carries one).
function explodeVec(m) {
  const o = m.userData.offset ?? new THREE.Vector3();
  const a = m.userData.axis;
  if (!a) return o.clone();
  const len = Math.max(o.length(), m.geometry.boundingBox?.getSize(new THREE.Vector3()).length() ?? 0);
  if (Array.isArray(a)) return new THREE.Vector3().fromArray(a).normalize().multiplyScalar(len);
  return new THREE.Vector3().setComponent('xyz'.indexOf(a[1]), a[0] === '-' ? -len : len);
}
// PICK EXPLODE DIRECTION: from a part's right-click menu. The pointer then shows the normal of
// the face under it as an arrow on the model; a click takes that normal as the part's explode
// direction (world), right-click or Esc backs out. Faces of any body count — you may want a
// part to leave along a neighbour's face — but the arrow sits where you point, so what you get is
// never in doubt (the old ±X/±Y/±Z menu was: which way is +Y on a turned part?).
let pickAxis = null;
const axisArrow = new THREE.ArrowHelper(new THREE.Vector3(0, 0, 1), new THREE.Vector3(), 1, 0xd11d1d, 0.25, 0.12);
axisArrow.visible = false; axisArrow.renderOrder = 6;
axisArrow.line.material.depthTest = axisArrow.cone.material.depthTest = false;
// A ring on the face around the pointer: the arrow alone vanishes when the face looks straight at you.
const axisRing = new THREE.Mesh(new THREE.RingGeometry(0.8, 1, 48), new THREE.MeshBasicMaterial({ color: 0xd11d1d, side: THREE.DoubleSide, depthTest: false }));
axisRing.renderOrder = 6;
axisArrow.add(axisRing);   // rides the arrow: the ring geometry's +Z follows the arrow's direction below
axisRing.rotation.x = Math.PI / 2;   // ArrowHelper points along its local +Y; a RingGeometry faces +Z
scene.add(axisArrow);
function faceAt(e) {   // the body face under the pointer (caps and clipped-away faces skipped), with its world normal
  const r = renderer.domElement.getBoundingClientRect();
  raycaster.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
  const h = raycaster.intersectObjects(model.children, true).find((h) => h.face && model.children.includes(h.object) && h.object.visible && (!section.axis || section.plane.distanceToPoint(h.point) > -1e-6));
  return h ? { body: h.object, point: h.point, normal: h.face.normal.clone().transformDirection(h.object.matrixWorld).normalize() } : null;
}
function startPickAxis(m) {
  pickAxis = { m };
  renderer.domElement.classList.add('picking');
  say(`${m.userData.name}: click a face to explode along its normal · Esc cancels`);
}
function endPickAxis() { pickAxis = null; axisArrow.visible = false; renderer.domElement.classList.remove('picking'); }
function setPartAxis(m, n) {
  m.userData.axis = n.toArray().map((v) => +v.toFixed(4));
  m.userData.pull = undefined;
  applyExplode(); commit();
  say(`${m.userData.name} explodes along (${m.userData.axis.map((v) => v.toFixed(2)).join(', ')})`);
}
// Does the vector move the body at all? The base part's radial offset is a rounding away from zero.
const moves = (m, v) => v.length() > 0.01 * (m.geometry.boundingBox?.getSize(new THREE.Vector3()).length() ?? 1);
const maxTravel = (m) => m.userData.pull ?? explodeVec(m).length() * 2;   // the solver's full travel is twice its offset
// The user's explode edits (axis, maximum travel) are saved per file and come back on load and on a
// re-export, by body name: `${name}#${n}` for the n-th body of that name.
const partKey = (m) => { const all = model.children; return `${m.userData.name}#${all.filter((o, i) => o.userData.name === m.userData.name && i < all.indexOf(m)).length}`; };
let partsReady = false, partsSaved = '{}', partsTimer = null;
function partsState() {
  const out = {};
  for (const m of model.children) if (m.userData.axis || m.userData.pull != null) out[partKey(m)] = { axis: m.userData.axis ?? null, pull: m.userData.pull ?? null };
  if (rot.w < 1 - 1e-9) out['@rot'] = rotArr();   // the axes and marks above are in this turned frame
  return out;
}
function saveParts() {
  if (!partsReady || !subject) return;
  const json = JSON.stringify(partsState());
  if (json === partsSaved) return;
  partsSaved = json;
  clearTimeout(partsTimer);
  partsTimer = setTimeout(() => api('/parts', { method: 'PUT', body: { subject, parts: JSON.parse(json) } }).catch((e) => say(e.message, true)), 300);
}
function loadParts() {
  partsReady = false;
  const s = subject;
  api(`/parts?subject=${encodeURIComponent(s)}`).then((d) => {
    if (s !== subject) return;
    const r = d.parts?.['@rot'];
    if (r) { bakeRot(new THREE.Quaternion().fromArray(r)); history.list = []; history.i = -1; queueMicrotask(commit); }   // undo never goes back past the saved turn
    for (const m of model.children) { const p = d.parts?.[partKey(m)]; if (p) { m.userData.axis = p.axis || undefined; m.userData.pull = p.pull ?? undefined; } }
    partsSaved = JSON.stringify(partsState()); partsReady = true;
    applyExplode();
  }).catch(() => { partsReady = true; });
}
function applyExplode() {
  const k = parseFloat($('#explode').value) / 100;
  const done = new Set();
  const place = (m) => {   // a pocketed part rides on the body its pocket is in
    if (done.has(m)) return m.position;
    done.add(m);
    const v = explodeVec(m), len = v.length();
    const dist = maxTravel(m) * k;
    m.position.copy(v).multiplyScalar(len ? dist / len : 0);
    if (m.userData.parent) m.position.add(place(m.userData.parent));
    if (m.userData.edges) m.userData.edges.position.copy(m.position);
    return m.position;
  };
  for (const m of model.children) place(m);
  measure.invalidate();
  saveParts();
}
$('#explode').addEventListener('input', applyExplode);

// ROTATE turns the whole model about the origin, a step at a time. The turn is baked into every body's
// geometry, so the grid, section axes, views and floor read the new way up; what rides on the model turns
// with it (explode vectors and axes, marks, dims), so nothing loses its place. It is saved with the file's
// explode edits (parts['@rot']) and in the view state, so reloads, undo and shared links keep it.
const rot = new THREE.Quaternion();   // the file's frame → what is on screen
const rotArr = () => rot.toArray().map((v) => +v.toFixed(6));
/** Put the geometry (and the solver's offsets) at turn `q`; returns the delta applied. */
function bakeRot(q) {
  const d = q.clone().multiply(rot.clone().invert());
  const M = new THREE.Matrix4().makeRotationFromQuaternion(d);
  for (const m of model.children) {
    for (const g of [m.geometry, m.userData.edges?.geometry]) {
      if (!g) continue;
      for (const a of [g.attributes.position, g.attributes.normal]) if (a && sources.some((f) => f.buffer === a.array.buffer)) a.array = a.array.slice();   // never turn the bytes Share to web sends
      g.applyMatrix4(M); g.computeBoundingBox();
    }
    m.userData.offset?.applyQuaternion(d);
  }
  rot.copy(q);
  bbox = new THREE.Box3(); for (const m of model.children) bbox.union(m.geometry.boundingBox);
  placeGrid(); setupSection(); applyExplode();
  return d;
}
function turnModel(q) {
  if (!bbox) return;
  const d = bakeRot(q);
  const turn = (v) => new THREE.Vector3().fromArray(v).applyQuaternion(d).toArray().map((x) => +x.toFixed(6));
  // every [x, y, z] in a mark or a dim is a point or a direction about the same origin: both just turn
  const walk = (o) => (Array.isArray(o) ? (o.length === 3 && o.every(Number.isFinite) ? turn(o) : o.map(walk)) : o && typeof o === 'object' ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, walk(v)])) : o);
  for (const m of model.children) {
    const a = m.userData.axis;
    if (a) m.userData.axis = turn(Array.isArray(a) ? a : [0, 1, 2].map((j) => (j === 'xyz'.indexOf(a[1]) ? (a[0] === '-' ? -1 : 1) : 0)));
  }
  applyExplode();
  orbit.target.applyQuaternion(d);   // keep looking at the same spot on the part
  const marks = walk(markup.items); markup.load(marks); markupChanged(marks);
  measure.load(walk(measure.dims));
}
const rotStep = () => THREE.MathUtils.degToRad(+$('#rotStep').value);
for (const b of document.querySelectorAll('[data-rot]')) b.addEventListener('click', (e) =>
  turnModel(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3().setComponent('xyz'.indexOf(b.dataset.rot), 1), e.shiftKey ? -rotStep() : rotStep()).multiply(rot)));
$('#rotReset').addEventListener('click', () => turnModel(new THREE.Quaternion()));
function setExplode(v) { $('#explode').value = Math.max(0, Math.min(100, v)); applyExplode(); }
$('#resetBtn').addEventListener('click', () => { for (const m of model.children) { m.userData.axis = undefined; m.userData.pull = undefined; } applyExplode(); say('explode positions reset'); });

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
  loadParts();
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
  if (pickAxis) {   // picking an explode direction: left takes the face under the pointer, anything else backs out
    if (e.button === 0) { const h = faceAt(e); if (h) setPartAxis(pickAxis.m, h.normal); }
    endPickAxis();
    return;
  }
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
  if (pickAxis) {
    const h = faceAt(e);
    axisArrow.visible = !!h;
    if (h) {
      const len = 0.35 * (pickAxis.m.geometry.boundingBox?.getSize(new THREE.Vector3()).length() || 10);
      axisArrow.position.copy(h.point); axisArrow.setDirection(h.normal); axisArrow.setLength(len, len * 0.25, len * 0.12);
      axisRing.scale.setScalar(len * 0.08);
    }
    return;
  }
  if (touches.size > 1) {
    if (!touches.has(e.pointerId)) return;
    const before = pair();
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const now = pair();
    if (before.d > 0 && now.d > 0) orbit.dist *= before.d / now.d;
    pan(now.x - before.x, now.y - before.y);
    return;
  }
  if (!drag) {
    if (measure.on) { measure.hover(e); return; }
    const p = e.pointerType !== 'touch' ? partAt(e) : null;
    hoverBody($('[data-tool].on') ? null : p?.body ?? null);   // no tool chosen: the body under the mouse and its row light up
    renderer.domElement.classList.toggle('oncap', onCap(e) || !!p);
    return;
  }
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
    const m = drag.part.m, max = maxTravel(m);
    const d = Math.max(0, max * (+$('#explode').value / 100) + dx * drag.part.sx + dy * drag.part.sy);
    if (d > max) m.userData.pull = d;   // past its maximum: that is the new maximum
    $('#explode').value = 100 * Math.min(1, d / maxTravel(m));
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
renderer.domElement.addEventListener('pointerleave', () => hoverBody(null));
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
  return hit.object === hit.object.parent?.userData.cap || Math.abs(section.plane.distanceToPoint(hit.point)) < tol;
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
// The cut is flat dark grey on every body (user call, v0.14.8): far darker than the shaded grey
// bodies and than any part colour, so cut material reads as cut without borrowing the palette.
// The cap draws AFTER the bodies and a hair nearer (polygon offset): where a mating part's face
// lies on the cut body's inner surface (a lid on a box, a chassis in a shell) the two were
// z-fighting and the cap lost in patches — "some caps render, others don't" (v0.14.9).
const capColor = () => new THREE.Color(0x3a3a3a);
function buildCaps() {
  model.children.forEach((m, i) => {
    if (m.userData.cap) { m.remove(m.userData.cap); m.userData.cap.material.dispose(); m.userData.cap = null; }
    if (m.isLine) return;
    const on = !!section.axis && !!bbox;
    eachMat(m, (x) => { x.side = on ? THREE.FrontSide : THREE.DoubleSide; });
    if (!on) return;
    const cap = new THREE.Mesh(m.geometry, new THREE.MeshBasicMaterial({ color: capColor(i), side: THREE.BackSide, clippingPlanes: [section.plane],
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }));
    cap.renderOrder = 1;
    m.add(cap);
    m.userData.cap = cap;
  });
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
  for (const m of model.children) eachMat(m, (x) => { x.clippingPlanes = planes; });
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

function collectGeometries(obj, assoc = null, out = []) {
  obj.updateMatrixWorld(true);
  // keep the file's part name and its material's colour, roughness and metalness (glTF carries them)
  const look = (mat) => ({ color: mat?.color ? mat.color.getRGB(new THREE.Color(), THREE.SRGBColorSpace).toArray() : null,
    pbr: mat?.isMeshStandardMaterial ? { roughness: mat.roughness, metalness: mat.metalness } : null });
  const geoOf = (o) => o.geometry.clone().applyMatrix4(o.matrixWorld);
  const done = new Set();
  obj.traverse((o) => {
    // a glTF mesh with several primitives (one per material) loads as a Group of meshes: it is ONE body, a group per finish
    const prims = assoc?.get(o)?.meshes !== undefined && o.isGroup ? o.children.filter((c) => c.isMesh) : null;
    if (prims?.length > 1) {
      const geos = prims.map((c) => { done.add(c); const g = geoOf(c); for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k); return g; });
      const geo = mergeGeometries(geos.map((g) => (g.index ? g : g.setIndex([...Array(g.attributes.position.count).keys()]))), true);
      if (geo) { out.push({ geo, name: o.name || undefined, groups: prims.map((c) => look(c.material)) }); return; }
      for (const c of prims) done.delete(c);
    }
    if (!o.isMesh || done.has(o)) return;
    out.push({ geo: geoOf(o), name: o.name || undefined, ...look([].concat(o.material)[0]) });
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
  if (ext === 'obj') return collectGeometries(loader.parse(new TextDecoder().decode(buffer)));
  if (ext === '3mf' || ext === 'fbx') return collectGeometries(loader.parse(buffer, ''));
  const gltf = await new Promise((ok, bad) => loader.parse(buffer, '', ok, bad));
  return collectGeometries(gltf.scene, gltf.parser.associations);
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
    const n = typeof names[b] === 'string' ? { name: names[b] } : names[b];   // older servers send bare names
    parts.push({ geo, edgeLines: faceBorderEdges(sub.pos, sub.idx, own), faces: own, name: n.name, path: n.path ?? [], color: n.color ?? null });
  }
  return parts;
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch('api/view' + path, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
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
  announce(); renderTabs();

  let shown = 0, label = '';
  for (const { name, buffer } of files) {
    const ext = name.toLowerCase().split('.').pop();
    say(`loading ${name}…`); progressStart(name); const tf = performance.now();
    try {
      const cad = CAD_EXT.test(name);
      const buf = cad ? await fetchBuffer(`api/view/tessellate?name=${encodeURIComponent(name)}`, { method: 'POST', body: buffer }) : buffer;
      const parts = cad ? parseCad(buf) : await parseMesh(ext, buf, name);
      sources.push({ name, cad, buffer: buf });
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
  const sameFile = paths.join('|') === subject;   // the camera stays only for a reload of the file on screen
  const t0 = performance.now();
  clearModel();
  subject = paths.join('|');   // markups attach to the file by path
  announce(); renderTabs();
  // The address says what is open, from the first byte: a reload brings the file back, and the Mac app
  // reads its windows' addresses to reopen the same files after a quit or a crash, even one mid-load.
  if (!follow) window.history.replaceState(null, '', `${location.pathname}?open=${encodeURIComponent(subject)}`);   // window.history: `history` here is the undo stack
  let shown = 0, label = '';
  for (const p of paths) {
    const name = p.split('/').pop();
    say(`loading ${name}…`); progressStart(name); const tf = performance.now();
    try {
      const q = `path=${encodeURIComponent(p)}`;
      const cad = CAD_EXT.test(name);
      const buf = await fetchBuffer(cad ? `api/view/tessellate?${q}` : `api/view/file?${q}`, cad ? { method: 'POST' } : undefined);
      const parts = cad ? parseCad(buf) : await parseMesh(name.toLowerCase().split('.').pop(), buf, name);
      sources.push({ name, cad, buffer: buf });
      for (const part of parts) addPart(part, name);
      shown++; label = name; progressEnd(name, performance.now() - tf);
    } catch (e) { progressEnd(); loadFailed(name, e); return; }
  }
  if (shown) finishLoad(shown === 1 ? label : `${shown} files`, Math.round(performance.now() - t0), keep && sameFile);
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
  say('rendering drawing…'); progressStart('drawing', 'rendering the drawing…');
  await new Promise((r) => setTimeout(r, 30));   // paint the box before the render takes the thread
  try {
    const html = renderDrawing(spec, { renderer, scene, model, bbox, measure, hide: [grid, markup.group].filter(Boolean), restore: () => { resize(); renderer.setSize(viewport.clientWidth, viewport.clientHeight); } });
    const r = await api('/drawing/result', { method: 'POST', body: { html, subject } });
    say(`drawing saved: ${r.path}`);
    window.open('api/view/drawing');
    progressEnd();
  } catch (e) { progressEnd(); say(`drawing failed: ${e.message}`, true); api('/drawing/result', { method: 'POST', body: { error: e.message } }).catch(() => {}); }
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
$('#look').addEventListener('change', (e) => { ui.look = document.documentElement.dataset.look = e.target.value; for (const m of model.children) styleMesh(m); });
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

// Five backgrounds: light and dark are flat paper, night is flat dusk-navy; dusk and dawn are
// skies. The sky is a sphere around the orbit target shaded by the WORLD height of each point
// (Z up, horizon at the model's Z = 0 plane), so it turns with the model and the horizon says
// which way is up (v0.14.10 — the v0.14.9 screen-space gradient stayed put while you orbited).
// Dusk and night take the dark UI chrome, dawn the light one (data-theme); data-bg names the mode.
const THEME_KEY = 'cwt-theme';
const THEMES = ['light', 'dark', 'dusk', 'dawn', 'night'];
const NIGHT = 0x12172e;
// Sky stops: straight down, 25° below the horizon, the horizon, 25° above, straight up (sRGB).
// Most of the change sits within ±25° of the horizon so a 40° view always has the gradient
// running across it (v0.14.11 — spread evenly over 180° it read as one flat colour per view).
const SKIES = {
  dusk: ['#1a1420', '#6b3a4a', '#e8864f', '#5a3f7a', '#12172e'],
  dawn: ['#e6d2bf', '#f5c9b0', '#f6a9a0', '#9a8fc0', '#2f4272'],
};
const srgb = (hex) => { const n = parseInt(hex.slice(1), 16); return new THREE.Vector3((n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255); };
// A unit sphere, scaled each frame to 50 orbit distances: inside the far plane (100, set on fit)
// and far beyond the model.
const sky = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 32), new THREE.ShaderMaterial({
  side: THREE.BackSide, depthWrite: false, depthTest: false,
  uniforms: { stops: { value: SKIES.dusk.map(srgb) }, center: { value: new THREE.Vector3() } },
  vertexShader: 'varying vec3 vW; void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }',
  fragmentShader: `uniform vec3 stops[5]; uniform vec3 center; varying vec3 vW;
    void main() {
      float e = asin(clamp(normalize(vW - center).z, -1.0, 1.0));   // elevation, radians
      const float B = 0.4363;   // 25°: the band either side of the horizon that carries the colour
      const float H = 1.5708;
      float t = e < -B ? (e + H) / (H - B) : e < 0.0 ? 1.0 + (e + B) / B : e < B ? 2.0 + e / B : 3.0 + (e - B) / (H - B);
      vec3 c = t < 1.0 ? mix(stops[0], stops[1], t) : t < 2.0 ? mix(stops[1], stops[2], t - 1.0) : t < 3.0 ? mix(stops[2], stops[3], t - 2.0) : mix(stops[3], stops[4], t - 3.0);
      gl_FragColor = vec4(c, 1.0);   // stops are sRGB already: written straight to the sRGB canvas
    }`,
}));
sky.renderOrder = -10; sky.frustumCulled = false; sky.visible = false;
scene.add(sky);
const isDarkTheme = (t) => t === 'dark' || t === 'dusk' || t === 'night';
function applyTheme(t) {
  if (!THEMES.includes(t)) t = 'light';
  document.documentElement.dataset.theme = isDarkTheme(t) ? 'dark' : 'light';
  document.documentElement.dataset.bg = t;
  $('#themeToggle').textContent = t.toUpperCase();
  sky.visible = !!SKIES[t];
  if (SKIES[t]) sky.material.uniforms.stops.value = SKIES[t].map(srgb);
  scene.background = new THREE.Color(t === 'dark' ? 0x1a1a18 : t === 'light' ? 0xffffff : NIGHT);
  for (const m of model.children) if (m.isLine) styleMesh(m);
  try { localStorage.setItem(THEME_KEY, t); } catch {}
}
$('#themeToggle').addEventListener('click', () => applyTheme(THEMES[(THEMES.indexOf(document.documentElement.dataset.bg) + 1) % THEMES.length]));
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
let following = follow;   // trailing the Mac's focused window; tapping a tab pins the iPad to that file until FOLLOW
const followTo = (s) => { if (follow && following && s && s !== subject && s.startsWith('/')) window.cadgangOpen(s.split('|'), { keep: true }); };
// Every page tells the server what it has open, so a follower can list the Mac's windows as tabs.
function announce() { if (!follow && subject && ws?.readyState === 1) ws.send(JSON.stringify({ type: 'open_subject', subject })); }
// The tab strip (follower only): the Mac's open files, ● on the one in front; FOLLOW trails that one.
let tabList = [];
function renderTabs() {
  if (!follow) return;
  const bar = $('#tabs');
  bar.hidden = tabList.length === 0;
  const btn = (text, on, title, onclick) => Object.assign(document.createElement('button'), { className: 'ghost' + (on ? ' on' : ''), textContent: text, title, onclick });
  bar.replaceChildren(
    btn('FOLLOW', following, 'Show whatever the Mac has in front', () => { following = true; renderTabs(); followTo(tabList.find((t) => t.active)?.subject); }),
    ...tabList.map((t) => btn(t.subject.split('|').map((p) => p.split('/').pop()).join(' + ') + (t.active ? ' ●' : ''), t.subject === subject, t.subject,
      () => { following = false; renderTabs(); if (t.subject !== subject) window.cadgangOpen(t.subject.split('|'), { keep: true }); })),
  );
}
function setTabs(tabs) { tabList = tabs; renderTabs(); if (following) followTo(tabs.find((t) => t.active)?.subject); }
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
// The server is working for someone else (a Claude session building cells): say so where the user is looking,
// since a load in this tab waits behind it. Only past 400 ms, so quick requests never flash it.
let busyTimer = null;
function showBusy(what) {
  clearTimeout(busyTimer);
  const el = $('#busy');
  if (!what) { el.hidden = true; return; }
  el.querySelector('span').textContent = what;
  busyTimer = setTimeout(() => { el.hidden = false; }, 400);
}
let snapshotTimer = null;
/** Post what is on screen; coalesced, since a stroke is many change events. */
function postSnapshot() {
  if (follow) return;
  clearTimeout(snapshotTimer);
  snapshotTimer = setTimeout(() => {
    try {
      const png = markup.snapshot();
      fetch('api/view/snapshot', { method: 'POST', headers: { 'Content-Type': 'application/json' },
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
  if (new URLSearchParams(location.search).has('share')) return;   // a shared link is on its own: the VPS proxy carries no WebSocket
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${location.pathname.replace(/[^/]*$/, '')}ws`);
  ws.onopen = () => { focus(); announce(); };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'hello' && msg.version) { if (pageVersion && pageVersion !== msg.version) location.reload(); pageVersion = msg.version; }
    if (msg.type === 'snapshot_request') postSnapshot();
    if (msg.type === 'busy') showBusy(msg.what);
    if (msg.type === 'markup_changed' && msg.subject === subject) loadMarkup();
    if (msg.type === 'open' && msg.paths?.length) window.cadgangOpen(msg.paths);   // pushed from MCP
    if (msg.type === 'drawing' && msg.spec) makeDrawing(msg.spec);
    if (msg.type === 'subject') followTo(msg.subject);
    if (msg.type === 'tabs') setTabs(msg.tabs || []);
    if (msg.type === 'file_changed' && subject.split('|').includes(msg.path)) { say('file changed, reloading…'); window.cadgangOpen(subject.split('|'), { keep: true }); }
  };
  ws.onclose = () => setTimeout(connect, 1500);
})();

// ------------------------------------------------------------------ render
// RENDER (K): path-traced global illumination (three-gpu-pathtracer, vendored at 0.0.23, the
// last one for three r165). The visible bodies, a matte floor under them and a studio-gradient
// sky; samples pile up while the view holds still and any orbit starts them over. Lines, grid,
// edges, sky, markup and section caps sit it out, and the path tracer ignores clipping, so a
// section shows whole bodies.
// In the Mac app RENDER is native instead (mac/render.swift, Metal ray tracing): the page sends
// the visible triangles and the camera + section plane, and turns see-through over the viewport
// so the shell's render view under it shows. Sections render, with caps.
let NATIVE = !!window.webkit?.messageHandlers?.cadgang;
const post = (m) => window.webkit.messageHandlers.cadgang.postMessage(m);
window.cadgangNativeRender = (ok) => { if (ok || !NATIVE) return; NATIVE = false; document.documentElement.classList.remove('native-render'); rt.on = false; setRender(true); };   // no Metal ray tracing: the WebGL one
const rt = { on: false, pt: null, floor: null, env: null, hidden: [], cam: new THREE.Matrix4(), proj: new THREE.Matrix4(), last: '' };
async function setRender(on) {
  if (on === rt.on) return;
  rt.on = on;
  $('#renderBtn').classList.toggle('on', on);
  if (NATIVE) {
    document.documentElement.classList.toggle('native-render', on);
    if (on) { nativeScene(); rt.last = ''; } else post({ cmd: 'render' });
    return;
  }
  if (!on) {
    for (const o of rt.hidden) o.visible = true;
    rt.hidden = [];
    if (rt.floor) scene.remove(rt.floor);
    scene.environment = null;
    renderer.toneMapping = THREE.NoToneMapping;
    return;
  }
  if (!rt.pt) {
    say('loading the path tracer…');
    const { WebGLPathTracer, GradientEquirectTexture } = await import('./vendor/three-gpu-pathtracer.module.js');
    rt.pt = new WebGLPathTracer(renderer);
    rt.pt.dynamicLowRes = true;   // a quick low-res pass while orbiting
    rt.pt.bounces = 6;
    rt.env = new GradientEquirectTexture();
    rt.env.topColor.set(0xffffff); rt.env.bottomColor.set(0x6f6a64); rt.env.update();
    rt.floor = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshStandardMaterial({ color: 0xf2f0ec, roughness: 0.9 }));
  }
  if (rt.on) syncRender();
}
/** Hand the scene to the path tracer again: on entering and after every action that changed the view state. */
function syncRender() {
  for (const o of rt.hidden) o.visible = true;
  rt.hidden = [...scene.children, ...model.children.map((m) => m.userData.cap)]
    .filter((o) => o?.visible && o !== model && o !== rt.floor && !o.isLight);
  for (const o of rt.hidden) o.visible = false;
  const b = new THREE.Box3().setFromObject(model), r = b.getSize(new THREE.Vector3()).length() || 1;
  rt.floor.scale.setScalar(r * 40);
  rt.floor.position.set((b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, b.min.z - r * 1e-4);
  scene.add(rt.floor);
  scene.environment = rt.env;
  scene.environmentIntensity = 0.8;
  renderer.toneMapping = THREE.NeutralToneMapping;   // the lights plus the sky overexpose a linear canvas; Neutral keeps white white
  scene.environmentRotation.set(Math.PI / 2, 0, 0);   // the gradient is Y-up, the model is Z-up
  rt.pt.setScene(scene, camera);
}
function renderSample() {
  camera.updateMatrixWorld();
  if (rt.pt.camera !== camera || !rt.cam.equals(camera.matrixWorld) || !rt.proj.equals(camera.projectionMatrix)) {
    rt.cam.copy(camera.matrixWorld); rt.proj.copy(camera.projectionMatrix);
    rt.pt.setCamera(camera);   // any move starts the samples over
  }
  rt.pt.renderSample();
}
/** The render, if on, takes the scene again. */
function rerender() { if (rt.on) { if (NATIVE) nativeScene(); else if (rt.pt) syncRender(); } }
const b64 = (a) => {
  const u = new Uint8Array(a.buffer, a.byteOffset, a.byteLength); let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(s);
};
/** The visible bodies as world-space triangles with their materials, to the shell. */
function nativeScene() {
  model.updateMatrixWorld(true);
  const meshes = model.children.filter((m) => m.isMesh && m.visible);
  let nv = 0, nt = 0;
  for (const m of meshes) { nv += m.geometry.attributes.position.count; nt += (m.geometry.index?.count ?? m.geometry.attributes.position.count) / 3; }
  const verts = new Float32Array(nv * 6), idx = new Uint32Array(nt * 3), tri = new Uint32Array(nt), mats = [];
  const v = new THREE.Vector3(), nm = new THREE.Matrix3();
  const inGlass = (bbox?.getSize(v).length() || 1) * 2e-4;   // 10× the tracer's ray offset
  let vo = 0, to = 0;
  meshes.forEach((m, mi) => {
    const g = m.geometry;
    if (!g.attributes.normal) g.computeVertexNormals();
    const pos = g.attributes.position, nrm = g.attributes.normal;
    nm.getNormalMatrix(m.matrixWorld);
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld); verts.set([v.x, v.y, v.z], (vo + i) * 6);
      v.fromBufferAttribute(nrm, i).applyMatrix3(nm).normalize(); verts.set([v.x, v.y, v.z], (vo + i) * 6 + 3);
    }
    const ms = [].concat(m.material), base = mats.length;
    if (ms.some((x) => (x.transmission ?? 0) > 0.5)) inset(verts, vo, pos.count, inGlass);
    const n = (g.index?.count ?? pos.count);
    for (let i = 0; i < n; i++) idx[to * 3 + i] = vo + (g.index ? g.index.getX(i) : i);
    // a body with a material per group (several finishes) sends one material per group
    if (ms.length > 1) for (const gr of g.groups) tri.fill(base + gr.materialIndex, to + gr.start / 3, to + Math.min(gr.start + gr.count, n) / 3);
    else tri.fill(base, to, to + n / 3);
    for (const mat of ms) { const c = mat.color ?? new THREE.Color(0xb9b8b3); mats.push([c.r, c.g, c.b, mat.metalness ?? 0, mat.roughness ?? 0.5, mat.transmission ?? 0, mat.ior ?? 1.5]); }
    vo += pos.count; to += n / 3;
  });
  const cap = capColor(), bg = scene.background ?? new THREE.Color(0xffffff);
  post({ cmd: 'renderScene', verts: b64(verts), idx: b64(idx), tri: b64(tri), mats, cap: [cap.r, cap.g, cap.b], bg: [bg.r, bg.g, bg.b] });
}
// Glass pulled in by `d` along its welded normals (every copy of a corner moves the same way: no cracks), for
// the tracer only. A pane lying on aluminium shares that face: the tracer took either surface per ray (speckle),
// and a ray leaving the glass started a hair past the plane, inside the metal.
function inset(verts, from, count, d) {
  const keys = [], sum = new Map();
  for (let i = from; i < from + count; i++) {
    const k = `${verts[i * 6]},${verts[i * 6 + 1]},${verts[i * 6 + 2]}`, a = sum.get(k) ?? [0, 0, 0];
    for (let j = 0; j < 3; j++) a[j] += verts[i * 6 + 3 + j];
    keys.push(k); sum.set(k, a);
  }
  keys.forEach((k, n) => {
    const a = sum.get(k), len = Math.hypot(...a) || 1;
    for (let j = 0; j < 3; j++) verts[(from + n) * 6 + j] -= a[j] / len * d;
  });
}
/** Camera, section plane and viewport rect, whenever any of them moved. */
function nativeCam() {
  camera.updateMatrixWorld();
  const r = renderer.domElement.getBoundingClientRect(), e = camera.matrixWorld.elements;
  const clip = section.axis && bbox ? [section.plane.normal.x, section.plane.normal.y, section.plane.normal.z, section.plane.constant] : null;
  const c = { cmd: 'renderCam', pos: [e[12], e[13], e[14]], fwd: [-e[8], -e[9], -e[10]], right: [e[0], e[1], e[2]], up: [e[4], e[5], e[6]],
    fov: persp.fov, ortho: ui.ortho, orthoH: camera.top ?? 1, clip, rect: [r.left, r.top, r.width, r.height] };
  const key = JSON.stringify(c);
  if (key !== rt.last) { rt.last = key; post(c); }
}
$('#renderBtn').addEventListener('click', () => { setRender(!rt.on); commit(); });

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
// MATERIALS needs something for metal and glass to reflect in the live view: a soft studio room.
let roomEnv = null;
(function loop() {
  resize();
  if (!(rt.on && rt.pt)) {   // the WebGL path tracer owns the environment while it runs
    const env = ui.look === 'materials' ? (roomEnv ??= new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture) : null;
    if (scene.environment !== env) {
      scene.environment = env;
      ambient.intensity = env ? 0 : 1.15; hemi.intensity = env ? 0 : 0.6;   // the room is the ambient light under MATERIALS; both washed plastic out
    }
  }
  applyCamera();
  // The ground goes as soon as it would hide the model: seen from under it (camera below it, or an ortho view
  // looking up, whose rays start below it). The grid, and the WebGL render's floor; the Metal render drops its own.
  const above = (z) => (ui.ortho ? camera.getWorldDirection(new THREE.Vector3()).z < 0 : camera.position.z >= z);
  if (grid) grid.visible = ui.grid && above(grid.position.z);
  if (rt.on && !NATIVE && rt.floor && rt.floor.visible !== above(rt.floor.position.z)) { rt.floor.visible = !rt.floor.visible; syncRender(); }
  if (sky.visible) { sky.position.copy(orbit.target); sky.scale.setScalar(orbit.dist * 50); sky.material.uniforms.center.value.copy(orbit.target); }
  if (rt.on && NATIVE) nativeCam(); else if (rt.pt && rt.on) renderSample(); else renderer.render(scene, camera);
  measure.projectLabels();
  markup.projectLabels();
  requestAnimationFrame(loop);
})();

fetch('api/health').then((r) => r.json()).then((h) => {
  $('#version').textContent = 'v' + h.version;
  if (!h.lan || follow) return;   // the VPS has no LAN; a follower is already the iPad
  const link = `http://${h.lan}:${h.port}/view?follow`;
  $('#shareIpad').hidden = false;
  // In the Mac app the button AirDrops the link: pick the iPad, Safari opens it. Elsewhere it copies.
  $('#shareIpad').addEventListener('click', () => window.webkit?.messageHandlers?.cadgang
    ? window.webkit.messageHandlers.cadgang.postMessage({ cmd: 'airdrop', url: link })
    : navigator.clipboard.writeText(link).then(() => say(`copied ${link}`), () => say(link)));
}).catch(() => {});
// ------------------------------------------------------------------- share
// The share icon opens a menu: SHARE TO WEB uploads a frozen copy of this view (meshes + view state)
// and copies its link; SHARE TO IPAD is the old iPad button. A shared link (?share=<id>) opens the
// whole viewer from that view; its visitors orbit, cut, explode and mark up (markup is shared by
// everyone with the link), but cannot open, save or share files.
const shareMenu = $('#shareMenu');
$('#shareBtn').addEventListener('click', (e) => { e.stopPropagation(); shareMenu.hidden = !shareMenu.hidden; });
document.addEventListener('click', () => { shareMenu.hidden = true; });
$('#shareWeb').addEventListener('click', shareWeb);
async function shareWeb() {
  if (!sources.length) return say('open a file first', true);
  say('sharing…');
  const head = new TextEncoder().encode(JSON.stringify({
    name: $('#fileName').textContent, files: sources.map((f) => ({ name: f.name, cad: f.cad, bytes: f.buffer.byteLength })),
    state: snap(), camera: { yaw: orbit.yaw, pitch: orbit.pitch, dist: orbit.dist, target: orbit.target.toArray() },
    theme: document.documentElement.dataset.bg, materials: model.children.map(materialOf),
  }));
  const len = new Uint8Array(new Uint32Array([head.length]).buffer);
  try {
    const res = await fetch('api/view/share', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: new Blob([len, head, ...sources.map((f) => f.buffer)]) });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
    const shell = window.webkit?.messageHandlers?.cadgang;
    if (shell) shell.postMessage({ cmd: 'copy', text: d.url });
    else await navigator.clipboard.writeText(d.url).catch(() => {});
    say(`link copied: ${d.url}`, false, true);
  } catch (e) { say(`share failed: ${e.message}`, true); }
}
async function openShare(id) {
  document.documentElement.classList.add('shared');
  say('loading shared view…'); progressStart('share');
  try {
    const buf = await fetchBuffer(`api/view/share/${encodeURIComponent(id)}`);
    const n = new DataView(buf).getUint32(0, true), head = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, n)));
    clearModel();
    subject = `share:${id}`;   // markups attach to the link: everyone who opens it sees the same ones
    let off = 4 + n;
    for (const f of head.files) {
      const part = buf.slice(off, off + f.bytes); off += f.bytes;
      const parts = f.cad ? parseCad(part) : await parseMesh(f.name.toLowerCase().split('.').pop(), part, f.name);
      for (const p of parts) addPart(p, f.name);
    }
    progressEnd();
    finishLoad(head.name, 0);
    model.children.forEach((m, i) => head.materials?.[i] && pickMaterial(m, head.materials[i]));
    const st = JSON.parse(head.state);
    const marks = await api(`/markup?subject=${encodeURIComponent(subject)}`).then((d) => d.markups).catch(() => []);
    if (marks.length) st.markup = marks;   // later visitors' marks, not just the ones it was shared with
    apply(JSON.stringify(st)); commit();
    applyTheme(head.theme);
    window.cadgangCamera(head.camera);
    document.title = `${head.name} · CADgang`;
  } catch (e) { progressEnd(); loadFailed('shared view', e); }
}
// For headless drives: the scene objects behind the page.
window.__view = { model, section, orbit, ui, measure, rt, THREE, partAt, faceAt, startPickAxis, applyExplode, get camera() { return camera; },
  project: (x, y, z) => { const r = renderer.domElement.getBoundingClientRect(), v = new THREE.Vector3(x, y, z).project(camera); return { x: r.left + (v.x + 1) / 2 * r.width, y: r.top + (1 - v.y) / 2 * r.height }; } };
// Files queued by the shell before the page was ready.
if (window.cadgangPending?.length) window.cadgangOpen(window.cadgangPending);
// ?open=/abs/a.step|/abs/b.stl — the same local-path door, for the shell and for headless tests.
// ?section=z:0.3, ?explode=0.4, ?look=materials and ?render set the tools once the file is in (a pushed view, a test harness).
const params = new URLSearchParams(location.search);
if (params.get('share')) openShare(params.get('share'));
const openArg = params.get('open');
if (follow) fetch('api/view/tabs').then((r) => r.json()).then((d) => { setTabs(d.tabs || []); if (!d.tabs?.length) return fetch('api/view/screen').then((r) => r.json()).then((s) => followTo(s.screen?.subject)); }).catch(() => {});
if (openArg) window.cadgangOpen(openArg.split('|')).then(() => {
  const sec = params.get('section')?.match(/^([xyz]):([\d.]+)$/);
  if (sec) { $('#sectPos').value = Math.round(parseFloat(sec[2]) * 1000); setSectionAxis(sec[1]); }
  const ex = parseFloat(params.get('explode'));
  if (ex > 0) { $('#explode').value = Math.round(ex * 100); applyExplode(); }
  const look = params.get('look');
  if (look in PRESETS) { $('#look').value = look; $('#look').dispatchEvent(new Event('change')); }
  if (params.has('render')) setRender(true);
});

// ------------------------------------------------------------- commands
// One table drives the hotkeys, the right-click menu and the hover tips.

const CMDS = [
  { key: 'f', label: 'Fit', run: fit, btn: '#fitBtn' },
  { key: 'e', label: 'Edges', run: () => toggle('edges', '#edgesBtn'), btn: '#edgesBtn', on: () => ui.edges },
  { key: 'w', label: 'Wireframe', run: () => toggle('wire', '#wireBtn'), btn: '#wireBtn', on: () => ui.wire },
  { key: 'g', label: 'Grid', run: () => toggle('grid', '#gridBtn'), btn: '#gridBtn', on: () => ui.grid },
  { key: 'c', label: 'Color parts', run: () => toggle('color', '#colorBtn'), btn: '#colorBtn', on: () => ui.color },
  { key: 'k', label: 'Render (global illumination)', run: () => setRender(!rt.on), btn: '#renderBtn', on: () => rt.on },
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
  { key: 'Escape', label: 'Section off', btn: '[data-sect=""]', run: () => { if (pickAxis) { endPickAxis(); return; } if (measure.cancel()) return; setSectionAxis(''); setMeasure(false); } },
  { sep: true },
  ...['front', 'back', 'top', 'bottom', 'right', 'left', 'iso'].map((n, i) => ({ key: String(i + 1), label: `View ${n}`, run: () => setView(String(i + 1)) })),
  { sep: true },
  ...[['p', 'pen', 'Pen'], ['a', 'arrow', 'Arrow'], ['n', 'note', 'Note'], ['r', 'erase', 'Erase']].map(([key, t, label]) => ({ key, label, btn: `[data-tool="${t}"]`, run: () => markup.setTool(t), on: () => $(`[data-tool="${t}"]`).classList.contains('on') })),
  { key: 'Backspace', label: 'Clear markup', btn: '[data-clear]', run: () => $('[data-clear]').click() },
  { sep: true },
  { key: 'd', label: 'Background: light / dark / dusk / dawn / night', btn: '#themeToggle', run: () => $('#themeToggle').click(), on: () => document.documentElement.dataset.bg !== 'light' },
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
    section: { axis: section.axis, pos: $('#sectPos').value, flip: section.flip }, explode: $('#explode').value, rot: rotArr(),
    bodies: model.children.map((m) => m.visible), parts: model.children.map((m) => [m.userData.axis ?? null, m.userData.pull == null ? null : +m.userData.pull.toFixed(3)]),
    markup: markup.items, dims: measure.dims });
}
function commit() {
  const s = snap();
  if (s === history.list[history.i]) return;
  rerender();
  history.list.splice(history.i + 1); history.list.push(s); history.i = history.list.length - 1;
  try { localStorage.setItem(PREFS_KEY, JSON.stringify({ look: ui.look, edges: ui.edges, wire: ui.wire, grid: ui.grid, color: ui.color, ortho: ui.ortho })); } catch {}
}
// View preferences outlive the page, like the theme. Section, explode and body
// visibility belong to a file and start fresh with it.
const PREFS_KEY = 'cadgang-view';
try {
  const p = JSON.parse(localStorage.getItem(PREFS_KEY));
  if (p?.look in PRESETS) ui.look = document.documentElement.dataset.look = $('#look').value = p.look;
  for (const k of ['edges', 'wire', 'grid', 'color']) if (typeof p?.[k] === 'boolean' && ui[k] !== p[k]) toggle(k, `#${k}Btn`);
  if (p?.ortho) setOrtho(true);
} catch {}
function apply(s) {
  const st = JSON.parse(s);
  const r = st.rot ?? [0, 0, 0, 1];   // the state's marks, dims and axes are in its own turn: only the geometry follows
  if (bbox && JSON.stringify(r) !== JSON.stringify(rotArr())) bakeRot(new THREE.Quaternion().fromArray(r));
  if (st.look !== ui.look) { ui.look = document.documentElement.dataset.look = $('#look').value = st.look; for (const m of model.children) styleMesh(m); }
  for (const k of ['edges', 'wire', 'grid', 'color']) if (ui[k] !== st[k]) toggle(k, `#${k}Btn`);
  if (ui.ortho !== st.ortho) setOrtho(st.ortho);
  $('#sectPos').value = st.section.pos; section.flip = st.section.flip; setSectionAxis(st.section.axis);
  model.children.forEach((m, i) => { const [axis, pull] = st.parts?.[i] ?? [null, null]; m.userData.axis = axis || undefined; m.userData.pull = pull ?? undefined; });
  $('#explode').value = st.explode; applyExplode();
  model.children.forEach((m, i) => setBodyVisible(m, st.bodies[i] ?? true));
  syncRows();
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
  const set = (axis) => { m.userData.axis = axis; if (!axis) m.userData.pull = undefined; applyExplode(); commit(); };
  return [
    { head: m.userData.name },
    { label: `Explode auto${auto}`, run: () => set(undefined), on: () => !m.userData.axis },
    { label: 'Explode direction: pick a face…', run: () => startPickAxis(m), on: () => !!m.userData.axis },
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
