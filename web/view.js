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
import { explodeOffsets, radialOffsets, cylinders } from './explode.js';
import { normalizeJoint, solvePoses, sweepJoints, valueRange, clampValue, pitchFor, turns, eulerOf, planeAxes, JOINT_LABEL } from './joints.js';
import { renderDrawing } from './drawing.js';
import { createMeasure, cylinderFit, sphereFit } from './measure.js';
import { NURBSCurve } from 'three/addons/curves/NURBSCurve.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { MATERIALS, materialOf, pickMaterial, pickedMaterial, materialFor } from './materials.js';
import { silhouetteEdges, silhouetteFor } from './silhouette.js';
import { MeshBVH, acceleratedRaycast } from 'three-mesh-bvh';
import { createViewCube } from './viewcube.js';
import { createPlanes } from './planes.js';
import { turnAbout as turnOrbit, yawPitchOf, offsetOf } from './orbitmath.js';

const $ = (s) => document.querySelector(s);
const ui = { edges: true, wire: false, grid: true, ruler: false, units: 'mm', look: 'shaded', ortho: false, flat: false, color: false, mode: 'explode' };   // mode: what a drag and the right-click menu do to a part: 'explode' slides it out, 'joint' moves it on its joint // flat: a 2D drawing is open
const section = { plane: new THREE.Plane(new THREE.Vector3(0, 0, -1), 0), axis: '', flip: 1 };
const PROJECT_EXT = /\.cadgang$/i;
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
// See-through bodies and the user's colours: styleMesh reads both (the selection draws its own overlay).
// A colour the user gave a body, kept per file by body name (like the material picks); the solid looks and MATERIALS show it.
const TINT_KEY = 'cadgang-tints';
let tints = {};
try { tints = JSON.parse(localStorage.getItem(TINT_KEY)) || {}; } catch {}
const saveTints = () => { try { localStorage.setItem(TINT_KEY, JSON.stringify(tints)); } catch {} };
// A finish the user gave a body (matte, satin, gloss, polished), kept the same way: how rough it renders.
const FINISHES = { matte: { label: 'Matte', rough: 0.75 }, satin: { label: 'Satin', rough: 0.45 }, gloss: { label: 'Gloss', rough: 0.2 }, polished: { label: 'Polished', rough: 0.06 } };
const FINISH_KEY = 'cadgang-finishes';
let finishes = {};
try { finishes = JSON.parse(localStorage.getItem(FINISH_KEY)) || {}; } catch {}
const saveFinishes = () => { try { localStorage.setItem(FINISH_KEY, JSON.stringify(finishes)); } catch {} };
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
    if (!ui.color && m.userData.tint && mat.color && (SOLID_LOOKS.has(ui.look) || ui.look === 'materials')) mat.color.setRGB(...m.userData.tint, THREE.SRGBColorSpace);
    if (m.userData.finish && FINISHES[m.userData.finish] && 'roughness' in mat && (SOLID_LOOKS.has(ui.look) || ui.look === 'materials')) mat.roughness = FINISHES[m.userData.finish].rough;
    if (m.userData.opacity < 1 && SOLID_LOOKS.has(ui.look)) Object.assign(mat, { transparent: true, opacity: m.userData.opacity, depthWrite: false });
    if (m.userData.ghost) Object.assign(mat, { transparent: true, opacity: Math.min(mat.opacity, 0.15), depthWrite: false, transmission: 0 });
    mat.side = section.axis && bbox ? THREE.FrontSide : THREE.DoubleSide;
    mat.flatShading = !!m.userData.flat;
    // WIRE is a CAD wireframe: the model's real edges (a B-rep's face borders, a mesh's creases) with the
    // surfaces left out, not every triangle; a body too big for an edge overlay falls back to its triangles.
    const lines = ui.wire && !!m.userData.edges;
    mat.wireframe = ui.wire && !lines;
    if (lines) Object.assign(mat, { colorWrite: false, depthWrite: false });   // still there to pick, hover and measure
    mat.clippingPlanes = section.axis && bbox ? [section.plane] : [];
    return mat;
  });
  for (const x of [].concat(m.material ?? [])) x.dispose();
  m.material = m.userData.groups ? mats : mats[0];
  m.renderOrder = m.userData.ghost ? 2 : 0;   // see-through bodies draw after the solid ones
}
const eachMat = (m, f) => { for (const x of [].concat(m.material)) f(x); };
const edgeMaterial = new THREE.LineBasicMaterial({ color: 0x2f5d8a, transparent: true, opacity: 0.85 });
const model = new THREE.Group();     // meshes
const edges = new THREE.Group();     // their edge overlays
scene.add(model, edges);
let grid = null;
let bbox = null;
let joints = [];   // see JOINTS: the bodies that move on an axis
let sources = [];   // what each open file loaded as: [{name, cad, buffer}] (CAD tessellated), for Share to web and project files

function clearModel() {
  for (const g of [model, edges]) {
    for (const o of g.children) { o.geometry?.dispose(); o.userData.sil?.line?.geometry.dispose(); if (o.material !== edgeMaterial) for (const x of [].concat(o.material ?? [])) x.dispose?.(); }
    g.clear();
  }
  bbox = null;
  sources = [];
  joints = []; renderJoints();
  selected.clear(); paintSelection();
  rot.identity();
  setRender(false);
  ui.flat = false; $('#sideBtn').hidden = true;
  selected.clear(); treeRoot = null;
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

// Rays (hover, snaps, measure, picks) go through a BVH per body: a board's half-million triangles
// took ~50 ms a ray walked one by one, and a snap checks up to a dozen. Indirect, so the index and
// the B-rep face ranges stay as they are. Built on a body's first ray (and again after a turn
// rewrote its geometry or the explode solver dropped it), and ahead of time just after a load.
function bodyRaycast(raycaster, hits) {
  const g = this.geometry, tris = (g.index ? g.index.count : g.getAttribute('position').count) / 3;
  if (!g.boundsTree && tris > 2000) g.boundsTree = new MeshBVH(g, { indirect: true });
  acceleratedRaycast.call(this, raycaster, hits);
}
function warmRays() {
  const todo = model.children.filter((m) => m.isMesh && !m.geometry.boundsTree);
  const step = () => { const m = todo.shift(); if (!m) return; if (m.parent && !m.geometry.boundsTree) bodyRaycast.call(m, new THREE.Raycaster(new THREE.Vector3(1e9, 1e9, 1e9), new THREE.Vector3(0, 0, 1)), []); setTimeout(step, 0); };
  setTimeout(step, 200);   // one body per tick, after the first frame is up
}

// An inside-out mesh (negative volume: a mirrored Blender object, a flipped export) has front and
// back swapped, so the section cap painted its outside dark and left the cut hollow. Turn it right
// side out once, here: reverse each triangle, then point the normals the way the winding now does.
function rightSideOut(geo) {
  const p = geo.getAttribute('position'), nr = geo.getAttribute('normal'), ix = geo.index, n = ix ? ix.count : p.count;
  const at = (k) => (ix ? ix.getX(k) : k), a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  let vol = 0, agree = 0;
  for (let k = 0; k + 2 < n; k += 3) {
    a.fromBufferAttribute(p, at(k)); b.fromBufferAttribute(p, at(k + 1)); c.fromBufferAttribute(p, at(k + 2));
    vol += a.dot(new THREE.Vector3().crossVectors(b, c));
    if (nr) agree += c.sub(a).cross(b.sub(a)).dot(a.fromBufferAttribute(nr, at(k)));   // >0: normal opposes the winding
  }
  if (vol >= 0) return;
  if (ix) for (let k = 0; k + 2 < n; k += 3) { const t = ix.getX(k + 1); ix.setX(k + 1, ix.getX(k + 2)); ix.setX(k + 2, t); }
  else for (const attr of Object.values(geo.attributes)) for (let k = 0; k + 2 < n; k += 3)
    for (let d = 0; d < attr.itemSize; d++) { const t = attr.getComponent(k + 1, d); attr.setComponent(k + 1, d, attr.getComponent(k + 2, d)); attr.setComponent(k + 2, d, t); }
  if (nr && agree < 0) for (let i = 0; i < nr.count; i++) nr.setXYZ(i, -nr.getX(i), -nr.getY(i), -nr.getZ(i));
}

function addMesh(geo, { edgeLines, faces, flat = false, name = '', file = '', path = [], color = null, pbr = null, groups = null, material = '', opacity = 1 } = {}) {
  rightSideOut(geo);
  if (!geo.getAttribute('normal')) geo.computeVertexNormals();
  const m = new THREE.Mesh(geo);
  m.raycast = bodyRaycast;
  m.userData.flat = flat;
  m.userData.file = file;
  m.userData.name = name || `body ${model.children.length + 1}`;
  m.userData.path = path;     // the STEP assembly groups above it, outermost first
  m.userData.color = color;   // the file's colour for it [r, g, b] 0..1, or null
  m.userData.pbr = pbr;       // the file's roughness/metalness, or null
  m.userData.groups = groups; // [{color, pbr}] per geometry group: one body, several finishes (glTF multi-material mesh)
  m.userData.material = material;   // the file's own material name ("Steel - Satin"), shown after the body's name
  m.userData.opacity = opacity;     // the file's transparency (a STEP's SURFACE_STYLE_TRANSPARENT)
  m.userData.tint = tints[file]?.[m.userData.name] ?? null;   // the user's colour for it, kept from last time
  m.userData.finish = finishes[file]?.[m.userData.name] ?? null;   // and the finish
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
    if (ui.wire) styleMesh(m);   // styled before it had edges: now the wireframe can be them
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
  $('#resetBtn').hidden = model.children.length < 2;
  if (model.children.length > 1 && tris <= 300000) solveExplode();
  // Rows nest under the file's assembly groups (STEP): a group row folds, ticks all it holds, and solos on a click.
  const root = { name: '', kids: new Map(), bodies: [], parent: null };
  for (const m of model.children) {
    let node = root;
    for (const g of m.userData.path ?? []) { if (!node.kids.has(g)) node.kids.set(g, { name: g, kids: new Map(), bodies: [], parent: node }); node = node.kids.get(g); }
    node.bodies.push(m);
  }
  // Like items: a crowded group gathers three or more bodies of one stem (every copy of one capacitor)
  // into a group of their own; names that still repeat in a group get _1, _2… so each row is its own.
  (function tidy(node) {
    node.kids.forEach(tidy);
    if (node.bodies.length > 12) {
      const byStem = new Map();
      for (const m of node.bodies) { const k = stem(m.userData.name); if (!byStem.has(k)) byStem.set(k, []); byStem.get(k).push(m); }
      for (const [k, group] of byStem) {
        if (!k || group.length < 3 || group.length === node.bodies.length || node.kids.has(k)) continue;
        node.kids.set(k, { name: k, kids: new Map(), bodies: group, parent: node });
        node.bodies = node.bodies.filter((m) => !group.includes(m));
      }
    }
    const seen = new Map(), n = new Map();
    for (const m of node.bodies) seen.set(m.userData.name, (seen.get(m.userData.name) ?? 0) + 1);
    for (const m of node.bodies) {
      m.userData.node = node;
      m.userData.num = seen.get(m.userData.name) > 1 ? n.set(m.userData.name, (n.get(m.userData.name) ?? 0) + 1).get(m.userData.name) : 0;
    }
  })(root);
  treeRoot = root;
  const under = (node) => [...node.bodies, ...[...node.kids.values()].flatMap(under)];
  const see = (onclick) => Object.assign(document.createElement('button'), { className: 'ghost see', textContent: '◐', title: 'Transparent (T)', onclick: (e) => { e.preventDefault(); onclick(); } });
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
      nm.title = 'Click: only this group · Shift-click: add its bodies to the selection';
      nm.addEventListener('click', (e) => {
        e.preventDefault();
        if (e.shiftKey || e.metaKey || e.ctrlKey) { selectBodies(members, members.every((o) => selected.has(o)) ? 'toggle' : 'add'); return; }
        for (const o of model.children) setBodyVisible(o, members.includes(o));
        syncRows();
      });
      row.append(fold, cb, nm, see(() => { const on = !members.every((m) => m.userData.ghost); for (const m of members) setBodyGhost(m, on); syncRows(); }));
      kid.row = row; row._members = members;
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
      const nm = document.createElement('span'); nm.className = 'body-name'; nm._body = m; nm.textContent = labelOf(m);
      nm.title = 'Click: only this body · Shift-click: add it to the selection';
      nm.addEventListener('click', (e) => {
        e.preventDefault();
        if (e.shiftKey || e.metaKey || e.ctrlKey) { selectBodies([m], 'toggle'); return; }
        for (const o of model.children) setBodyVisible(o, o === m);
        selectBodies([m], 'set');
        syncRows();
      });
      m.userData.row = row;
      row.addEventListener('pointerenter', () => highlightBody(m));
      row.addEventListener('pointerleave', () => highlightBody(null));
      // a part with several finishes (a glTF mesh, one per material) opens to a row for each
      const finishes = (m.userData.groups ?? []).filter((g) => g.name || g.color);
      const subs = finishes.length > 1 && document.createElement('div');
      if (subs) {
        subs.className = 'finish-rows'; subs.hidden = true;
        const fold = Object.assign(document.createElement('button'), { className: 'ghost fold', textContent: '+', title: 'Its finishes' });
        fold.addEventListener('click', (e) => { e.preventDefault(); subs.hidden = !subs.hidden; fold.textContent = subs.hidden ? '+' : '−'; });
        row.append(fold);
        for (const g of finishes) {
          const f = finishFacts(m, g), r2 = document.createElement('div'); r2.className = 'finish-row';
          r2.append(Object.assign(document.createElement('span'), { className: 'fname', textContent: g.name || 'finish', title: g.name }), finishBits(f));
          subs.append(r2);
        }
      } else if (root.kids.size || model.children.some((o) => (o.userData.groups?.length ?? 0) > 1)) row.append(Object.assign(document.createElement('span'), { className: 'fold-gap' }));   // aligns with the +/−
      // the material word: a list that reads as text; a choice shows under the MATERIALS look, so it switches to it
      const pick = document.createElement('select'); pick.className = 'ghost mat-word';
      for (const [k, d] of Object.entries(MATERIALS)) pick.append(new Option(d.label, k));
      pick.addEventListener('pointerdown', (e) => e.stopPropagation());
      pick.addEventListener('click', (e) => e.stopPropagation());
      pick.addEventListener('change', () => {
        pickMaterial(m, pick.value);
        if (ui.look !== 'materials') { $('#look').value = 'materials'; $('#look').dispatchEvent(new Event('change', { bubbles: true })); }
        styleMesh(m); paintFinishes(); rerender(); commit();
      });
      const edit = Object.assign(document.createElement('span'), { className: 'body-edit', textContent: '✎', title: 'Rename this body' });
      edit.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); startRename(m); });
      const tag = Object.assign(document.createElement('span'), { className: 'mat-tag' }); tag._body = m;   // material · finish · colour (paintFinishes)
      tag.append(pick, Object.assign(document.createElement('span'), { className: 'bits' }));
      row.append(cb, nm, tag, edit, see(() => { setBodyGhost(m, !m.userData.ghost); syncRows(); }));
      into.appendChild(row);
      if (subs) into.appendChild(subs);
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
  requestAnimationFrame(fitNames);
  return dups.join(' · ');
}
/**
 * A long name takes two lines at most: each name gets the least width that does it, and the panel
 * grows (to 70% of the window) so the widest row still fits, its columns where every other row has them.
 */
function fitNames() {
  const panel = $('#bodies');
  if (!panel || panel.hidden || panel.classList.contains('min')) return;
  panel.style.minWidth = '';
  let over = 0;
  for (const el of panel.querySelectorAll('label > .body-name, label.group-row > span:not(.fold-gap):not(.mat-tag)')) {
    el.style.minWidth = '';
    if (!el.offsetParent) continue;   // in a folded folder
    el.style.whiteSpace = 'nowrap';
    const full = el.scrollWidth, line = el.offsetHeight;
    el.style.whiteSpace = '';
    if (el.offsetHeight <= line * 2 + 1) continue;
    let w = Math.ceil(full / 2);
    el.style.minWidth = `${w}px`;
    while (el.offsetHeight > line * 2 + 1 && w < full) { w += 4; el.style.minWidth = `${w}px`; }
    const row = el.parentElement;
    over = Math.max(over, row.scrollWidth - row.clientWidth);
  }
  if (over > 0) panel.style.minWidth = `${Math.min(innerWidth * 0.7, panel.offsetWidth + over)}px`;
}
new ResizeObserver(() => { clearTimeout(fitNames.t); fitNames.t = setTimeout(fitNames, 60); }).observe($('#bodies'));
/**
 * The panel's title row: − folds it to just the title, + brings it back. The grip on the
 * panel's right edge drags the width of the whole left column, so Section, Bodies and Joints stay
 * one width (CSS resize had an invisible corner and no touch).
 * Both are remembered per browser.
 */
const BODIES_KEY = 'cadgang.bodies';
function bodiesHead() {
  const panel = $('#bodies'), column = panel.parentElement;
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(BODIES_KEY) || '{}'); } catch {}
  if (saved.width) column.style.width = `${saved.width}px`;
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
    const x0 = e.clientX, w0 = column.offsetWidth;
    const move = (ev) => { column.style.width = `${Math.min(innerWidth * 0.7, Math.max(120, w0 + ev.clientX - x0))}px`; };
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
  const panel = $('#bodies'), column = panel.parentElement;
  try { localStorage.setItem(BODIES_KEY, JSON.stringify({ min: panel.classList.contains('min'), width: column.style.width ? column.offsetWidth : null })); } catch {}
}

/** Solve the explode vectors from the bodies at rest, then put the explode back. */
function solveExplode() {
  const t0 = performance.now();
  // Solve in the file's own frame: the probes run along x, y and z, and a model turned 45° has no faces on them.
  // The offsets turn back with the geometry.
  const q = rot.clone(), turned = q.w < 1 - 1e-9;
  if (turned) bakeRot(new THREE.Quaternion());
  for (const m of model.children) { m.position.set(0, 0, 0); m.quaternion.identity(); m.updateMatrixWorld(true); }
  explodeOffsets(model.children, bbox.getCenter(new THREE.Vector3()), jointHints());
  solvedFor = hintSig();
  if (turned) bakeRot(q);
  applyExplode();
  say(`explode vectors solved in ${Math.round(performance.now() - t0)} ms`);
}
// The joints tell the solver how the parts go together: a screw leaves along its axis, a fixed part goes with its parent.
let solvedFor = '[]', solveTimer = null;
function jointHints() {
  const byKey = new Map([...bodyKeys()].map(([m, k]) => [k, m])), out = new Map();
  for (const j of joints) {
    const m = byKey.get(j.body);
    if (m && !out.has(m)) out.set(m, { type: j.type, axis: new THREE.Vector3(...j.axis), origin: new THREE.Vector3(...j.origin), parent: (j.parent && byKey.get(j.parent)) || null });
  }
  return out;
}
const hintSig = () => JSON.stringify(joints.map((j) => [j.body, j.parent, j.type, j.axis]));
/** New joints change how the parts should explode: solve again, quietly, when the model is small enough to do it on load. */
function resolveForJoints() {
  clearTimeout(solveTimer);
  if (model.children.length < 2 || hintSig() === solvedFor) return;
  const tris = model.children.reduce((n, m) => n + (m.geometry.index ? m.geometry.index.count : m.geometry.getAttribute('position').count) / 3, 0);
  if (tris > 300000) return;
  solveTimer = setTimeout(() => { try { solveExplode(); say('explode re-solved from the joints'); } catch {} }, 250);
}
// For a headless drive or a console: what the solver decided.
window.cadgangExplode = () => model.children.map((m) => ({ name: m.userData.name, offset: m.userData.offset?.toArray().map((v) => +v.toFixed(2)), rides: m.userData.parent?.userData.name ?? null, stage: m.userData.stage ?? 0, axis: m.userData.axis ?? null, pull: m.userData.pull == null ? null : +m.userData.pull.toFixed(2), fixStage: m.userData.fixStage ?? null, at: m.position.toArray().map((v) => +v.toFixed(1)), box: (({ min, max }) => [...min.toArray(), ...max.toArray()].map((v) => +v.toFixed(1)))(new THREE.Box3().setFromObject(m)) }));
/** Body ticks in model order (a group tree renders them out of order). */
const bodyBoxes = () => { const by = new Map([...$('#bodies').querySelectorAll('input.body-cb')].map((cb) => [cb._body, cb])); return model.children.map((m) => by.get(m)).filter(Boolean); };
/** Ticks follow the bodies: a group is ticked when all of it shows, half when some does. */
/** A body's volume in mm³: the signed volume of its triangles, so a closed shell's own (an open one's is a guess). Cached. */
function volumeOf(m) {
  if (m.userData.vol != null) return m.userData.vol;
  const g = m.geometry, P = g.getAttribute('position'), I = g.index, n = I ? I.count : P.count;
  let v = 0;
  for (let t = 0; t < n; t += 3) {
    const a = I ? I.getX(t) : t, b = I ? I.getX(t + 1) : t + 1, c = I ? I.getX(t + 2) : t + 2;
    const ax = P.getX(a), ay = P.getY(a), az = P.getZ(a), bx = P.getX(b), by = P.getY(b), bz = P.getZ(b), cx = P.getX(c), cy = P.getY(c), cz = P.getZ(c);
    v += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return (m.userData.vol = Math.abs(v) / 6);
}
/** Grams of bodies, from each one's volume and its material's density. */
const gramsOf = (ms) => ms.reduce((w, m) => w + (m.isLine ? 0 : (volumeOf(m) / 1000) * (MATERIALS[materialOf(m)]?.density ?? 1.2)), 0);
const fmtMass = (g) => (g >= 453.592 ? `${(g / 453.592).toFixed(2)} lbs` : `${g.toFixed(g < 10 ? 2 : 1)} g`);   // grams up to a pound, then pounds
/** The bottom bar's weight: the shown bodies, by the material each has; with a selection, its share too. */
function paintWeight() {
  const el = $('#weight');
  if (!el) return;
  const shown = model.children.filter((m) => m.visible && !m.isLine);
  if (!shown.length) { el.textContent = ''; return; }
  const by = new Map();
  for (const m of shown) { const k = materialOf(m); by.set(k, (by.get(k) ?? 0) + gramsOf([m])); }
  const total = gramsOf(shown), picked = sel().filter((m) => m.visible && !m.isLine);
  el.textContent = `≈ ${picked.length ? `${fmtMass(gramsOf(picked))} of ` : ''}${fmtMass(total)}`;
  el.title = `Estimated weight of the shown bodies, from each body's volume and its material's density${picked.length ? ' (first: the selection)' : ''}:\n`
    + [...by].sort((a, b) => b[1] - a[1]).map(([k, g]) => `${MATERIALS[k]?.label ?? k} (${MATERIALS[k]?.density ?? 1.2} g/cm³): ${fmtMass(g)}`).join('\n');
}

function syncRows() {
  paintFinishes();
  for (const cb of $('#bodies').querySelectorAll('input.body-cb')) {
    const m = cb._body, row = cb.closest('label');
    cb.checked = m.visible;
    row.classList.toggle('ghosted', !!m.userData.ghost);
    row.classList.toggle('sel', selected.has(m));
  }
  for (const row of $('#bodies').querySelectorAll('label.group-row')) {
    row.classList.toggle('ghosted', row._members.every((m) => m.userData.ghost));
    row.classList.toggle('sel', row._members.every((m) => selected.has(m)));
  }
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
 * Hovering a body draws a thick outline round its outer silhouette, over everything, so the row
 * can be matched to its part even when it is buried inside the assembly. The body is stamped
 * into the stencil, then copies nudged a few pixels each way paint only outside the stamp.
 * Children of the body, so they ride the explode; they share the geometry and die on leave.
 */
let hoverOverlay = [];
let hovered = null;
const OUTLINE_PX = 3;
/** The body under the mouse: its overlay, and its row in the bodies list (or the folded group row that holds it). */
function hoverBody(m) {
  if (m === hovered) return;
  hovered = m;
  highlightBody(m);
  for (const r of $('#bodies').querySelectorAll('.hover')) r.classList.remove('hover');
  let row = m && bodyBoxes().find((cb) => cb._body === m)?.closest('label');
  while (row && !row.offsetParent) row = row.parentElement.closest('.group')?.querySelector(':scope > .group-row');
  if (!row) return;
  row.classList.add('hover');
  // out of sight: bring it to the top of the list, not the bottom edge where it's easy to miss
  const box = $('#bodies'), r = row.getBoundingClientRect(), b = box.getBoundingClientRect();
  if (r.top < b.top || r.bottom > b.bottom) box.scrollTop += r.top - b.top - 4;
}
function highlightBody(m) {
  for (const o of hoverOverlay) { o.parent?.remove(o); o.material.dispose(); }
  hoverOverlay = [];
  if (!m) return;
  const opts = { color: 0xff5a1f, depthTest: false, depthWrite: false, clippingPlanes: section.axis && bbox ? [section.plane] : [] };
  const add = (o, order) => { o.renderOrder = order; o.raycast = () => {}; m.add(o); hoverOverlay.push(o); };   // never a measure or markup target
  if (m.isLine) return add(new THREE.LineSegments(m.geometry, new THREE.LineBasicMaterial(opts)), 10);
  // Section caps leave the stencil at 0 (renderOrder 2), so ref 1 is free by now.
  add(new THREE.Mesh(m.geometry, new THREE.MeshBasicMaterial({ ...opts, side: THREE.DoubleSide, colorWrite: false,
    stencilWrite: true, stencilRef: 1, stencilFunc: THREE.AlwaysStencilFunc, stencilZPass: THREE.ReplaceStencilOp })), 10);
  for (let i = 0; i < 8; i++) {
    const a = i * Math.PI / 4;
    const mat = new THREE.MeshBasicMaterial({ ...opts, side: THREE.DoubleSide,
      stencilWrite: true, stencilRef: 1, stencilFunc: THREE.NotEqualStencilFunc });
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uNudge = { get value() { const c = renderer.domElement; return new THREE.Vector2(Math.cos(a) * 2 * OUTLINE_PX / c.clientWidth, Math.sin(a) * 2 * OUTLINE_PX / c.clientHeight); } };
      sh.vertexShader = 'uniform vec2 uNudge;\n' + sh.vertexShader.replace('#include <project_vertex>', '#include <project_vertex>\ngl_Position.xy += uNudge * gl_Position.w;');
    };
    add(new THREE.Mesh(m.geometry, mat), 11);
  }
}
function setBodyVisible(m, on) {
  m.visible = on;
  if (m.userData.edges) m.userData.edges.visible = on;
  if (!on && selected.delete(m)) paintSelection();
  measure.invalidate();
}

// SELECTION: shift- or ⌘-click a part, shift-drag a window over several, or shift-click names in the list, then hide,
// show, isolate or give them a material together (the bar over the viewport; H hides, ⇧H shows all, Esc clears).
// A plain click selects one part, a click on nothing clears. A window takes the parts it holds whole.
const selected = new Set();
const selOverlays = new Map();   // body → its tint
function paintSelection() {
  for (const [m, o] of selOverlays) if (!selected.has(m) || !model.children.includes(m)) { o.parent?.remove(o); o.material.dispose(); selOverlays.delete(m); }
  for (const m of selected) {
    if (selOverlays.has(m) || !model.children.includes(m)) continue;
    const opts = { color: 0x1d6bff, transparent: true, opacity: m.isLine ? 1 : 0.32, depthTest: false, depthWrite: false, clippingPlanes: section.axis && bbox ? [section.plane] : [] };
    const o = m.isLine ? new THREE.LineSegments(m.geometry, new THREE.LineBasicMaterial(opts)) : new THREE.Mesh(m.geometry, new THREE.MeshBasicMaterial({ ...opts, side: THREE.DoubleSide }));
    o.renderOrder = 9; o.raycast = () => {};   // never a measure or markup target
    m.add(o); selOverlays.set(m, o);
  }
  for (const cb of bodyBoxes()) cb.closest('label')?.classList.toggle('sel', selected.has(cb._body));
  const n = selected.size;
  $('#selBar').hidden = !n;
  const tools = $('#markupTools');   // under the Measure / markup row, right-aligned with it
  if (n && tools) $('#selBar').style.top = `${tools.offsetTop + tools.offsetHeight + 6}px`;
  $('#selCount').textContent = `${n} selected`;
  if (n) { const first = [...selected][0], c = $('#selColor'); if (c && !first.isLine) c.style.background = c.dataset.hex = hexOfRGB(finishFacts(first).color); }   // the colour they have, as the row shows it
  paintWeight();
}
/** mode: 'set' replaces the selection, 'add' joins it, 'toggle' flips each one. */
function selectBodies(list, mode = 'set') {
  if (mode === 'set') selected.clear();
  for (const m of list) { if (mode === 'toggle' && selected.has(m)) selected.delete(m); else selected.add(m); }
  paintSelection();
}
// The parts in a window, seen from here: dragged left→right, those whose whole outline lies inside it; right→left
// (`crossing`), any part with a vertex in it, as in a CAD "crossing" select.
function bodiesInWindow(x0, y0, x1, y1, crossing = false) {
  const r = renderer.domElement.getBoundingClientRect(), out = [], v = new THREE.Vector3(), [lx, hx] = [Math.min(x0, x1), Math.max(x0, x1)], [ly, hy] = [Math.min(y0, y1), Math.max(y0, y1)];
  const at = (m, x, y, z) => { v.set(x, y, z).applyMatrix4(m.matrixWorld).project(camera); const px = r.left + ((v.x + 1) / 2) * r.width, py = r.top + ((1 - v.y) / 2) * r.height; return v.z < 1 && px >= lx && px <= hx && py >= ly && py <= hy; };
  camera.updateMatrixWorld();
  for (const m of model.children) {
    if (!m.visible) continue;
    m.updateMatrixWorld(true);
    if (crossing) {
      const pos = m.geometry.getAttribute('position'), step = Math.max(1, Math.floor(pos.count / 600));
      for (let i = 0; i < pos.count; i += step) if (at(m, pos.getX(i), pos.getY(i), pos.getZ(i))) { out.push(m); break; }
      continue;
    }
    const b = m.geometry.boundingBox ?? (m.geometry.computeBoundingBox(), m.geometry.boundingBox);
    let inside = true;
    for (let i = 0; i < 8 && inside; i++) inside = at(m, i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z);
    if (inside) out.push(m);
  }
  return out;
}
const eachSelected = (f) => { for (const m of selected) f(m); syncRows(); commit(); };
function hideSelected() { eachSelected((m) => setBodyVisible(m, false)); }
function showAllBodies() { for (const m of model.children) setBodyVisible(m, true); syncRows(); commit(); }
const selActions = {
  hide: hideSelected,
  show: () => eachSelected((m) => setBodyVisible(m, true)),
  only: () => { for (const m of model.children) setBodyVisible(m, selected.has(m)); syncRows(); commit(); },
  clear: () => selectBodies([], 'set'),
};
for (const b of document.querySelectorAll('[data-sel]')) b.addEventListener('click', () => selActions[b.dataset.sel]());
for (const [k, d] of Object.entries(MATERIALS)) $('#selMaterial').append(new Option(d.label, k));
$('#selMaterial').addEventListener('change', (e) => {
  const key = e.target.value;
  if (!key) return;
  for (const m of selected) pickMaterial(m, key);
  if (ui.look !== 'materials') { $('#look').value = 'materials'; $('#look').dispatchEvent(new Event('change', { bubbles: true })); }   // a material only shows under that look
  for (const m of selected) styleMesh(m);
  paintFinishes();
  rerender();
  say(`${selected.size} bod${selected.size === 1 ? 'y' : 'ies'}: ${MATERIALS[key].label.toLowerCase()}`);
  e.target.value = '';
});

function setBodyGhost(m, on) {
  if (m.isLine || !!m.userData.ghost === on) return;
  m.userData.ghost = on;
  styleMesh(m);
  buildCaps();
}

const stem = (n) => String(n).replace(/(\s*\(\d+\)|[_\s-]\d+)$/, '');   // "CAP_3" → "CAP", "Lead (2)" → "Lead"
/** A row reads "name_n · material": the body's name, its number when the name repeats in its group, the file's material. */
function labelOf(m) {
  // a name the user gave (Rename) is theirs as it stands; the file's name gets its _n when it repeats
  return m.userData.label || m.userData.name.replace(/_part$/, '') + (m.userData.num ? `_${m.userData.num}` : '');   // _part: cadquery's leaf suffix
}
// What a body is made of, as its row says it: material · finish · colour. A STEP or glTF that names
// its finish ("Plastic - Matte (White)", Fusion's appearance names) is read word for word; otherwise
// the finish comes from how rough and metallic it renders and the colour is named from its RGB.
const COLOR_NAMES = [['White', [0.95, 0.95, 0.94]], ['Light grey', [0.78, 0.78, 0.78]], ['Grey', [0.5, 0.5, 0.5]], ['Dark grey', [0.25, 0.25, 0.25]], ['Black', [0.06, 0.06, 0.06]],
  ['Red', [0.8, 0.12, 0.1]], ['Orange', [0.95, 0.5, 0.1]], ['Yellow', [0.95, 0.85, 0.15]], ['Green', [0.15, 0.6, 0.2]], ['Teal', [0.1, 0.55, 0.55]], ['Blue', [0.15, 0.3, 0.8]],
  ['Navy', [0.08, 0.12, 0.35]], ['Purple', [0.5, 0.2, 0.6]], ['Pink', [0.95, 0.5, 0.7]], ['Brown', [0.45, 0.28, 0.15]], ['Tan', [0.82, 0.7, 0.5]], ['Gold', [0.88, 0.72, 0.36]]];
const colorName = (rgb) => COLOR_NAMES.reduce((b, [n, c]) => { const d = (c[0] - rgb[0]) ** 2 + (c[1] - rgb[1]) ** 2 + (c[2] - rgb[2]) ** 2; return d < b.d ? { n, d } : b; }, { n: '', d: Infinity }).n;
const hexRGB = (h) => [(h >> 16) & 255, (h >> 8) & 255, h & 255].map((v) => v / 255);
const finishWord = (name, rough, metal) => {
  const w = /polish|mirror/i.test(name) ? 'Polished' : /gloss/i.test(name) ? 'Gloss' : /satin|brush/i.test(name) ? 'Satin' : /matte|flat/i.test(name) ? 'Matte' : /anodi/i.test(name) ? 'Anodized' : /oxide/i.test(name) ? 'Oxide' : '';
  if (w || rough == null) return w;
  return rough < 0.15 ? 'Polished' : rough < 0.35 ? (metal ? 'Polished' : 'Gloss') : rough < 0.55 ? 'Satin' : 'Matte';
};
/** One finish of a body (its own, or a glTF group's): { name, finish, color: [r,g,b], colorText }. */
function finishFacts(m, src = m.userData) {
  const def = MATERIALS[materialOf(m)];
  const name = src.name ?? m.userData.material ?? '';
  const fileName = src === m.userData ? m.userData.material || '' : name;
  const rough = src.pbr?.roughness ?? def?.rough, metal = (src.pbr?.metalness ?? def?.metal ?? 0) > 0.5;
  const rgb = (src === m.userData && m.userData.tint) || src.color || m.userData.color || (def ? hexRGB(def.color) : [0.73, 0.72, 0.7]);
  const named = /\(([^()]+)\)\s*$/.exec(fileName)?.[1];   // Fusion: "Plastic - Matte (White)"
  return { name: fileName, finish: finishWord(fileName, rough, metal), color: rgb, colorText: (!m.userData.tint && named && !/\d/.test(named)) ? named : colorName(rgb) || 'Colour' };
}
const hexOfRGB = (rgb) => `#${new THREE.Color().setRGB(...rgb, THREE.SRGBColorSpace).getHexString(THREE.SRGBColorSpace)}`;
/**
 * The colour menu a swatch opens: the colours the model already uses (each body's, as its row shows it), then
 * Other…, the system picker. pick(rgb) runs live as a colour is tried; done() once it is chosen.
 */
let colorMenuEl = null;
const closeColorMenu = () => { colorMenuEl?.remove(); colorMenuEl = null; };
document.addEventListener('pointerdown', (e) => { if (colorMenuEl && !colorMenuEl.contains(e.target)) closeColorMenu(); }, true);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && colorMenuEl) { e.stopPropagation(); closeColorMenu(); } }, true);
function openColorMenu(anchor, current, pick, done) {
  closeColorMenu();
  const used = new Map();   // hex → name
  for (const m of model.children) {
    if (m.isLine) continue;
    for (const src of m.userData.groups?.length ? m.userData.groups : [m.userData]) { const f = finishFacts(m, src); used.set(hexOfRGB(f.color), f.colorText); }
  }
  const menu = colorMenuEl = Object.assign(document.createElement('div'), { className: 'color-menu' });
  menu.append(Object.assign(document.createElement('div'), { className: 'color-menu-head', textContent: 'In this model' }));
  const grid = Object.assign(document.createElement('div'), { className: 'color-menu-grid' });
  for (const [hex, name] of [...used].slice(0, 40)) {
    const b = Object.assign(document.createElement('button'), { className: 'color-chip' + (hex === current ? ' on' : ''), title: `${name} ${hex}` });
    b.style.background = hex;
    b.addEventListener('click', () => { pick(rgbOf(hex)); done(); closeColorMenu(); });
    grid.append(b);
  }
  const other = Object.assign(document.createElement('button'), { className: 'ghost color-other', textContent: 'Other…', title: 'Choose any colour' });
  const input = Object.assign(document.createElement('input'), { type: 'color', value: current || '#888888', className: 'color-other-input' });
  input.addEventListener('input', () => pick(rgbOf(input.value)));
  input.addEventListener('change', () => { done(); closeColorMenu(); });
  other.addEventListener('click', () => input.click());
  menu.append(grid, other, input);
  document.body.append(menu);
  const r = anchor.getBoundingClientRect(), w = menu.offsetWidth, h = menu.offsetHeight;
  menu.style.left = `${Math.max(8, Math.min(r.left, innerWidth - w - 8))}px`;
  menu.style.top = `${r.bottom + 4 + h > innerHeight ? Math.max(8, r.top - h - 4) : r.bottom + 4}px`;
}

/** The finish · swatch · colour part of a row, after its material word; for a body (m), finish and colour are lists to change. */
function finishBits(f, m = null) {
  const frag = document.createDocumentFragment();
  if (m) {
    const fin = Object.assign(document.createElement('select'), { className: 'fin-word', title: 'Its finish: click to change it' });
    fin.append(new Option(f.finish || 'Finish', ''), ...Object.entries(FINISHES).map(([k, d]) => new Option(d.label, k)));
    fin.value = m.userData.finish ?? '';
    if (!m.userData.finish) fin.options[0].textContent = f.finish || 'Finish';   // the file's (or the material's) until one is chosen
    for (const ev of ['pointerdown', 'click']) fin.addEventListener(ev, (e) => e.stopPropagation());
    fin.addEventListener('change', () => { setFinish([m], fin.value || null); commit(); });
    const sw = Object.assign(document.createElement('button'), { type: 'button', className: 'swatch-pick', title: `${hexOfRGB(f.color)}: click to change the colour` });
    sw.style.background = hexOfRGB(f.color);
    sw.addEventListener('pointerdown', (e) => e.stopPropagation());
    sw.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); openColorMenu(sw, hexOfRGB(f.color), (rgb) => { setTint([m], rgb); rerender(); paintFinishes(); paintSelection(); }, () => commit()); });
    const col = Object.assign(document.createElement('span'), { className: 'col pick', textContent: f.colorText, title: sw.title });
    col.addEventListener('pointerdown', (e) => e.stopPropagation());
    col.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); sw.click(); });   // the colour's name opens the same menu as its swatch
    frag.append(fin, sw, col);
    return frag;
  } else {
    if (f.finish) frag.append(Object.assign(document.createElement('span'), { className: 'fin', textContent: f.finish }));
    const sw = Object.assign(document.createElement('span'), { className: 'swatch', title: hexOfRGB(f.color) }); sw.style.background = hexOfRGB(f.color);
    frag.append(sw);
  }
  frag.append(Object.assign(document.createElement('span'), { className: 'col', textContent: f.colorText }));
  return frag;
}
/** The user's finish for these bodies (null: back to the file's). */
function setFinish(ms, key) {
  for (const m of ms) {
    m.userData.finish = key;
    const f = (finishes[m.userData.file] ??= {});
    if (key) f[m.userData.name] = key; else delete f[m.userData.name];
    styleMesh(m);
  }
  saveFinishes(); paintFinishes(); rerender();
}
function paintFinishes() {
  paintWeight();
  for (const el of document.querySelectorAll('#bodies .mat-tag')) {
    const m = el._body, sel = el.querySelector('select.mat-word'), picked = pickedMaterial(m);
    sel.value = materialOf(m);
    const guess = !picked && !m.userData.material && !(m.userData.groups ?? []).some((g) => g.name);
    sel.classList.toggle('guess', guess);
    sel.title = guess ? 'A guess from its name (the file names no material): click to choose one' : picked ? 'Your choice: click to change it' : `The file says ${m.userData.material || 'its finishes'}: click to choose another`;
    const groups = m.userData.groups?.filter((g) => g.name) ?? [];
    const f = groups.length > 1 ? { ...finishFacts(m, groups[0]), finish: `${groups.length} finishes` } : finishFacts(m, groups[0] ?? m.userData);
    if (m.userData.finish) f.finish = FINISHES[m.userData.finish].label;
    const bits = el.querySelector('.bits');
    if (bits.contains(document.activeElement)) continue;   // a list or picker open in it: leave it be
    bits.replaceChildren(finishBits(f, m));
  }
}
/** The body under the pointer: visible, on the kept side of a section, solid ones before see-through ones. */
function bodyAt(e) {
  const r = renderer.domElement.getBoundingClientRect();
  raycaster.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
  const hits = raycaster.intersectObjects(model.children.filter((m) => m.visible && m.isMesh), false)
    .filter((h) => !section.axis || section.plane.distanceToPoint(h.point) >= -1e-6);
  return (hits.find((h) => !h.object.userData.ghost) ?? hits[0])?.object ?? null;
}
const hexOf = (rgb) => `#${new THREE.Color().setRGB(...rgb, THREE.SRGBColorSpace).getHexString(THREE.SRGBColorSpace)}`;
const rgbOf = (hex) => { const o = {}; new THREE.Color().setStyle(hex, THREE.SRGBColorSpace).getRGB(o, THREE.SRGBColorSpace); return [o.r, o.g, o.b].map((v) => +v.toFixed(3)); };
const shownColor = (m) => m.userData.tint ?? m.userData.color ?? m.userData.groups?.[0]?.color ?? [0.73, 0.72, 0.7];
/** The user's colour for these bodies (null: back to the file's). */
function setTint(ms, rgb) {
  for (const m of ms) {
    m.userData.tint = rgb;
    const f = (tints[m.userData.file] ??= {});
    if (rgb) f[m.userData.name] = rgb; else delete f[m.userData.name];
    styleMesh(m);
  }
  saveTints();
}

// Our additions on the selection: T makes it transparent; a colour for it (every solid look); the tree's folders read it too.
let treeRoot = null;   // the list's tree
const sel = () => [...selected];
const under = (node) => [...node.bodies, ...[...node.kids.values()].flatMap(under)];
function ghostSelected() { const on = !sel().every((m) => m.userData.ghost); for (const m of sel()) setBodyGhost(m, on); syncRows(); commit(); }
const BODY_CMDS = [
  { key: 't', label: 'Selected transparent', run: ghostSelected, on: () => selected.size && sel().every((m) => m.userData.ghost) },
  { key: 's', label: 'Show only selected', run: () => selActions.only() },
];
// the selection bar gets Transparent, and a colour with its reset
{
  const bar = $('#selBar'), clear = bar.querySelector('[data-sel="clear"]');
  const btn = (text, title, run) => { const b = Object.assign(document.createElement('button'), { className: 'ghost', textContent: text, title }); b.addEventListener('click', run); return b; };
  const color = Object.assign(document.createElement('button'), { type: 'button', id: 'selColor', className: 'sel-swatch', title: 'Give them a colour (every solid look)' });
  color.addEventListener('click', () => openColorMenu(color, color.dataset.hex, (rgb) => { setTint(sel(), rgb); rerender(); paintFinishes(); color.style.background = color.dataset.hex = hexOfRGB(rgb); }, () => commit()));   // the rows' swatches and colour names follow
  const reset = btn('↺', "Back to the file's colour", () => { setTint(sel(), null); rerender(); paintFinishes(); paintSelection(); commit(); });
  bar.insertBefore(btn('Transparent', 'Make them transparent (T)', ghostSelected), clear);
  bar.insertBefore(color, clear); bar.insertBefore(reset, clear);
}
// A body's explode vector at full slider: the solver's offset, or along the axis the
// user chose for it (`${sign}${axis}`, right-click menu), at least a body-length
// long so a part the solver left put still moves. Every part travels the slider's fraction of its
// maximum travel: twice the solver's offset, or userData.pull (world units) once a drag pushed it
// further. Dragging a part IS the slider with that part as the handle: the whole model follows so
// each part sits at the same fraction of its own maximum; dragged past its maximum, the part's
// maximum grows to where it is (and the slider pins at 100). With the slider at 100, a drag moves that part
// alone and where it is let go is its maximum, nearer or further. RESET forgets maxima and axes.
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
  return h ? { body: h.object, faceIndex: h.faceIndex, point: h.point, normal: h.face.normal.clone().transformDirection(h.object.matrixWorld).normalize() } : null;
}
function startPickAxis(m) {
  pickAxis = { m };
  renderer.domElement.classList.add('picking');
  say(`${nameOf(m)}: click a face to explode along its normal · Esc cancels`);
}
function endPickAxis() { pickAxis = null; axisArrow.visible = false; renderer.domElement.classList.remove('picking'); }
function setPartAxis(m, n) {
  m.userData.axis = n.toArray().map((v) => +v.toFixed(4));
  m.userData.pull = undefined;
  applyExplode(); commit();
  say(`${nameOf(m)} explodes along (${m.userData.axis.map((v) => v.toFixed(2)).join(', ')})`);
}
// Does the vector move the body at all? The base part's radial offset is a rounding away from zero.
const moves = (m, v) => v.length() > 0.01 * (m.geometry.boundingBox?.getSize(new THREE.Vector3()).length() ?? 1);
// Stages (the solver's order of removal): a part waits for what stands in its way, so the slider's first stretch moves the
// outer parts and the next the ones under them. Part of stage s of S has its own slice of the slider.
// A stage saved with the file's explode edits (parts[key].stage, e.g. an assembly order written by a CAD script) beats the
// solver's, and that part moves along its own axis alone, not riding a parent.
const stageOf = (m) => m.userData.fixStage ?? m.userData.stage ?? 0;
const stageCount = () => 1 + Math.max(0, ...model.children.map(stageOf));
const stageFrac = (m, k) => { const S = stageCount(); return S < 2 ? k : THREE.MathUtils.clamp(k * S - stageOf(m), 0, 1); };
const maxTravel = (m) => m.userData.pull ?? explodeVec(m).length() * 2;   // the solver's full travel is twice its offset
// The user's explode edits (axis, maximum travel) are saved per file and come back on load and on a
// re-export, by body name: `${name}#${n}` for the n-th body of that name.
// RENAME: a body shows its label if the user gave it one, else its file name. Keys (joints, marks, explode edits)
// stay on the file name, so renaming never breaks them; the label is saved with the file (parts '@names') and in projects.
const nameOf = (m) => m.userData.label || m.userData.name.replace(/_part$/, '');   // cadquery's leaf suffix
const labelOfKey = (key) => { const m = bodyOfKey(key); return m ? nameOf(m) : key.replace(/#0$/, ''); };
function refreshNames() {
  for (const el of document.querySelectorAll('#bodies .body-name')) if (!el.querySelector('input')) el.textContent = labelOf(el._body);
  renderJoints();
}
function renameBody(m, label) {
  label = label.trim();
  m.userData.label = label && label !== m.userData.name.replace(/_part$/, '') ? label : undefined;
  refreshNames(); saveParts(); postBodies(); commit();
}
function applyNames(map) {
  const keys = bodyKeys();
  for (const m of model.children) m.userData.label = map?.[keys.get(m)] || undefined;
  refreshNames();
}
function loadNames() {
  const s = subject;
  api(`/parts?subject=${encodeURIComponent(s)}`).then((d) => {
    const names = d.parts?.['@names'] ?? {};
    if (s !== subject || JSON.stringify(names) === JSON.stringify(namesOf())) return;
    applyNames(names); commit();
  }).catch(() => {});
}
const namesOf = () => (model.children.some((m) => m.userData.label) ? Object.fromEntries([...bodyKeys()].filter(([m]) => m.userData.label).map(([m, k]) => [k, m.userData.label])) : {});
function startRename(m) {
  const el = [...document.querySelectorAll('#bodies .body-name')].find((e) => e._body === m);
  if (!el || el.offsetParent === null) {   // not in the list (folded group, hidden panel): ask
    const v = prompt(`Rename ${nameOf(m)}`, nameOf(m));
    if (v != null) renameBody(m, v);
    return;
  }
  const input = Object.assign(document.createElement('input'), { type: 'text', value: nameOf(m), className: 'body-rename' });
  let done = false;
  const finish = (ok) => { if (done) return; done = true; const v = input.value; input.remove(); if (ok) renameBody(m, v); else refreshNames(); };
  for (const t of ['click', 'pointerdown', 'dblclick']) input.addEventListener(t, (e) => e.stopPropagation());
  input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') finish(true); else if (e.key === 'Escape') finish(false); });
  input.addEventListener('blur', () => finish(true));
  el.replaceChildren(input);
  input.focus(); input.select();
}
const partKey = (m) => { const all = model.children; return `${m.userData.name}#${all.filter((o, i) => o.userData.name === m.userData.name && i < all.indexOf(m)).length}`; };
let partsReady = false, partsSaved = '{}', partsTimer = null;
function partsState() {
  const out = {};
  for (const m of model.children) if (m.userData.axis || m.userData.pull != null || m.userData.exTo || m.userData.fixStage != null) out[partKey(m)] = { axis: m.userData.axis ?? null, pull: m.userData.pull ?? null, ...(m.userData.exTo && { exTo: m.userData.exTo.toArray().map((v) => +v.toFixed(4)) }), ...(m.userData.fixStage != null && { stage: m.userData.fixStage }) };
  if (rot.w < 1 - 1e-9) out['@rot'] = rotArr();   // the axes and marks above are in this turned frame
  const names = namesOf();
  if (Object.keys(names).length) out['@names'] = names;
  return out;
}
function saveParts() {
  if (!partsReady || !subject) return;
  const json = JSON.stringify(partsState());
  if (json === partsSaved) return;
  partsSaved = json;
  clearTimeout(partsTimer);
  partsTimer = setTimeout(() => api('/parts', { method: 'PUT', body: { subject, parts: JSON.parse(json), from: clientId } }).catch((e) => say(e.message, true)), 300);
}
function loadParts() {
  if (fromBundle) {   // a project file is the truth: it brings its own explode edits, turn and names, and they replace what the server remembered for it
    partsReady = true; partsSaved = '';   // the next change (apply() runs right after this) writes them back
    return;
  }
  partsReady = false;
  const s = subject;
  api(`/parts?subject=${encodeURIComponent(s)}`).then((d) => {
    if (s !== subject) return;
    const r = d.parts?.['@rot'];
    if (r) { bakeRot(new THREE.Quaternion().fromArray(r)); history.list = []; history.i = -1; queueMicrotask(commit); }   // undo never goes back past the saved turn
    if (d.parts?.['@names']) { applyNames(d.parts['@names']); history.list = []; history.i = -1; queueMicrotask(commit); }
    for (const m of model.children) { const p = d.parts?.[partKey(m)]; if (p) { m.userData.axis = p.axis || undefined; m.userData.pull = p.pull ?? undefined; m.userData.exTo = p.exTo ? new THREE.Vector3(...p.exTo) : undefined; m.userData.fixStage = p.stage ?? undefined; } }
    partsSaved = JSON.stringify(partsState()); partsReady = true;
    applyExplode();
  }).catch(() => { partsReady = true; });
}
function applyExplode() {
  const k = ui.mode === 'joint' ? 0 : parseFloat($('#explode').value) / 100;   // in joint mode the assembly is together: only joints move parts
  const done = new Set();
  const place = (m) => {   // the explode offset; a pocketed part rides on the body its pocket is in
    const at = m.userData.exPos ??= new THREE.Vector3();
    if (done.has(m)) return at;
    done.add(m);
    const v = explodeVec(m), len = v.length();
    at.copy(v).multiplyScalar(len ? (maxTravel(m) * stageFrac(m, k)) / len : 0);
    if (m.userData.parent && m.userData.fixStage == null) at.add(place(m.userData.parent));
    if (m.userData.exTo) at.addScaledVector(m.userData.exTo, stageFrac(m, k));   // where it was dragged while exploded: it explodes to there
    return at;
  };
  for (const m of model.children) place(m);
  // A joint's pose (a turn about its axis, a slide) goes on top of the explode offset.
  poses = joints.length ? solvePoses(joints) : new Map();
  const keys = poses.size ? bodyKeys() : null;
  const P = new THREE.Vector3(), Q = new THREE.Quaternion(), S = new THREE.Vector3();
  for (const m of model.children) {
    const w = keys && poses.get(keys.get(m));
    m.position.copy(m.userData.exPos);
    if (w) { w.decompose(P, Q, S); m.position.add(P); m.quaternion.copy(Q); } else m.quaternion.identity();
    const e = m.userData.edges;
    if (e) { e.position.copy(m.position); e.quaternion.copy(m.quaternion); }
  }
  measure.invalidate();
  saveParts();
  drawJointLinks();
}
$('#explode').addEventListener('input', applyExplode);

// JOINT LINKS: for a moment after a joint is made, and while the pointer is on the Joints panel, each joint
// shows what it joins: a line from the moving part's centre to the joint, an arrow along its axis, and a line
// on to the part that carries it (none to the ground). Drawn over everything, redrawn as parts move.
const jointLinks = new THREE.Group();
jointLinks.renderOrder = 6;
scene.add(jointLinks);
let linksUntil = 0, linksHover = false, linksTimer = null;
function showJointLinks(ms) {
  linksUntil = performance.now() + ms;
  clearTimeout(linksTimer); linksTimer = setTimeout(drawJointLinks, ms + 20);
  drawJointLinks();
}
// LIMITS: a joint that moves on one value (a slider's travel, a turn) also shows that value's range: a dashed
// track along the axis or round it, with a handle at min and at max (solid when set, faint when free). Drag a
// handle to set that limit, double-click it to free it. In Joint mode the joint last driven keeps them showing.
const LIMITED = { slider: 'lin', revolute: 'ang', screw: 'ang', cylindrical: 'ang', planar: 'ang' };
let limitHandles = [];   // [{ j, which, p: world point }] as drawn
let lastJoint = null;   // the joint last made or driven: its limits stay up in Joint mode, a drag on its part drives it
function limitFrame(j, m, F, base, size) {   // the joint's axis now, and for a turn the arm its angle 0 points along
  const o = new THREE.Vector3(...j.origin).applyMatrix4(F).add(base), n = new THREE.Vector3(...j.axis).transformDirection(F).normalize();
  if (LIMITED[j.type] !== 'ang') return { o, n };
  const c = m.geometry.boundingBox.getCenter(new THREE.Vector3());
  if (j.align) c.applyMatrix4(new THREE.Matrix4().fromArray(j.align));
  const arm = c.applyMatrix4(F).add(base).sub(o); arm.addScaledVector(n, -arm.dot(n));
  const r = Math.max(arm.length(), size * 0.06);
  return { o, n, r, d0: arm.lengthSq() > 1e-9 ? arm.normalize() : planeAxes(n.toArray())[0] };
}
// Where the handles sit: the limits, and for a free end of a turn 270° from the other (a full ±360° would put
// both on one spot); a free end of a travel at the panel slider's span.
function limitRange(j, size) {
  if (LIMITED[j.type] !== 'ang') return valueRange(j, size);
  const lo = j.min ?? (j.max != null ? j.max - 270 : j.value - 135);
  return [lo, j.max ?? lo + 270];
}
function limitPoint(j, f, v) {
  if (!f.d0) return f.o.clone().addScaledVector(f.n, v);
  const p = f.o.clone().addScaledVector(f.d0.clone().applyAxisAngle(f.n, THREE.MathUtils.degToRad(v)), f.r);
  return j.type === 'screw' ? p.addScaledVector(f.n, (j.pitch * v) / 360) : p;
}
function drawJointLinks() {
  for (const c of [...jointLinks.children]) { jointLinks.remove(c); c.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); }); }
  limitHandles = [];
  const all = linksHover || performance.now() < linksUntil;
  // ticked joints: all of them in Joint mode or while the panel is pointed at; an unticked one never
  const shown = all || ui.mode === 'joint' ? joints.filter((j) => !j.hide) : [];
  if (!shown.length) return;
  const size = bbox ? bbox.getSize(new THREE.Vector3()).length() : 100;
  const mat = () => Object.assign(new THREE.LineDashedMaterial({ color: 0xd11d1d, dashSize: size * 0.012, gapSize: size * 0.008, depthTest: false, transparent: true }));
  const centre = (m) => new THREE.Box3().setFromObject(m).getCenter(new THREE.Vector3());
  for (const j of shown) {
    const m = bodyOfKey(j.body), p = j.parent && bodyOfKey(j.parent);
    if (!m) continue;
    const F = poses.frames?.get(j.id) || IDENT, base = m.userData.exPos ?? new THREE.Vector3();
    const o = new THREE.Vector3(...j.origin).applyMatrix4(F).add(base), n = new THREE.Vector3(...j.axis).transformDirection(F);
    const pts = [centre(m), o, ...(p ? [centre(p)] : [])];
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat());
    line.computeLineDistances(); line.renderOrder = 6;
    const len = size * 0.06, arrow = new THREE.ArrowHelper(n, o, len, 0xd11d1d, len * 0.25, len * 0.12);
    arrow.line.material.depthTest = arrow.cone.material.depthTest = false; arrow.renderOrder = 6;
    jointLinks.add(line, arrow);
    if (!LIMITED[j.type]) continue;
    const f = limitFrame(j, m, F, base, size), [lo, hi] = limitRange(j, size);
    const steps = f.d0 ? Math.min(384, Math.ceil(Math.abs(hi - lo) / 5)) : 1;
    const track = new THREE.Line(new THREE.BufferGeometry().setFromPoints(Array.from({ length: steps + 1 }, (_, i) => limitPoint(j, f, lo + ((hi - lo) * i) / steps))), mat());
    track.computeLineDistances(); track.renderOrder = 6;
    jointLinks.add(track);
    for (const which of ['min', 'max']) {
      // a square stop across the motion at each end: across the axis for a travel, across the arc for a turn
      const at = which === 'min' ? lo : hi, pt = limitPoint(j, f, at);
      const across = f.d0 ? limitPoint(j, f, at + 0.5).sub(limitPoint(j, f, at - 0.5)).normalize() : f.n;
      const dot = new THREE.Mesh(new THREE.PlaneGeometry(size * 0.014, size * 0.014), new THREE.MeshBasicMaterial({ color: 0xd11d1d, side: THREE.DoubleSide, depthTest: false, transparent: true, opacity: j[which] == null ? 0.35 : 1 }));
      dot.position.copy(pt); dot.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), across); dot.renderOrder = 7;
      jointLinks.add(dot);
      limitHandles.push({ j, which, p: pt });
    }
  }
}
function limitAt(e) {   // the handle within 10 px of the pointer, nearest first
  const r = renderer.domElement.getBoundingClientRect();
  let best = null, bd = 10;
  for (const h of limitHandles) {
    const s = h.p.clone().project(camera), d = Math.hypot(r.left + (s.x + 1) / 2 * r.width - e.clientX, r.top + (1 - s.y) / 2 * r.height - e.clientY);
    if (s.z < 1 && d < bd) { bd = d; best = h; }
  }
  return best;
}
function dragLimit(e, h) {   // the pointer's ray onto the joint's axis (a travel) or its plane (a turn)
  const { j, which } = h, m = bodyOfKey(j.body);
  if (!m) return;
  const size = bbox ? bbox.getSize(new THREE.Vector3()).length() : 100;
  const f = limitFrame(j, m, poses.frames?.get(j.id) || IDENT, m.userData.exPos ?? new THREE.Vector3(), size);
  const r = renderer.domElement.getBoundingClientRect();
  raycaster.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
  const { origin: ro, direction: rd } = raycaster.ray;
  let v;
  if (!f.d0) {   // the closest point on the axis line to the ray
    const w = ro.clone().sub(f.o), b = f.n.dot(rd), den = 1 - b * b;
    if (den < 1e-6) return;
    v = (f.n.dot(w) - b * rd.dot(w)) / den;
  } else {
    const p = raycaster.ray.intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(f.n, f.o), new THREE.Vector3());
    if (!p) return;
    const a = p.sub(f.o);
    const deg = THREE.MathUtils.radToDeg(Math.atan2(f.d0.clone().cross(a).dot(f.n), f.d0.dot(a)));
    const was = limitRange(j, size)[which === 'min' ? 0 : 1];
    v = deg + 360 * Math.round((was - deg) / 360);   // the turn nearest the one it had: a screw's limit can be turns away
  }
  v = Math.round(v * 10) / 10;
  if (which === 'min' && j.max != null) v = Math.min(v, j.max);
  if (which === 'max' && j.min != null) v = Math.max(v, j.min);
  j[which] = v; j.value = clampValue(j, j.value); lastJoint = j.id;
  syncJointRow(j); applyExplode(); saveJoints();
}
$('#joints').addEventListener('pointerenter', () => { linksHover = true; drawJointLinks(); });
$('#joints').addEventListener('pointerleave', () => { linksHover = false; drawJointLinks(); });

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
      for (const a of [g.attributes.position, g.attributes.normal]) if (a && sources.some((f) => f.buffer === a.array.buffer)) a.array = a.array.slice();   // never turn the bytes Share to web and project files send
      g.applyMatrix4(M); g.computeBoundingBox();
    }
    delete m.geometry.boundsTree;   // its ray tree answers for the old pose: rebuilt on the next ray
    if (m.userData.sil?.line) { m.remove(m.userData.sil.line); m.userData.sil.line.geometry.dispose(); }
    delete m.userData.sil;          // the silhouette candidates were in the old pose too
    m.userData.offset?.applyQuaternion(d);
  }
  rot.copy(q);
  bbox = new THREE.Box3(); for (const m of model.children) bbox.union(m.geometry.boundingBox);
  placeGrid(); setupSection(); applyExplode(); planes.render();
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
  setJoints(walk(joints));   // origins and axes turn with the geometry
  orbit.target.applyQuaternion(d);   // keep looking at the same spot on the part
  const marks = walk(markup.items); markup.load(marks); markupChanged(marks);
  measure.load(walk(measure.dims));
  setTimeout(postBodies, 300);
}
const rotStep = () => THREE.MathUtils.degToRad(+$('#rotStep').value);
for (const b of document.querySelectorAll('[data-rot]')) b.addEventListener('click', (e) =>
  turnModel(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3().setComponent('xyz'.indexOf(b.dataset.rot), 1), e.shiftKey ? -rotStep() : rotStep()).multiply(rot)));
$('#rotReset').addEventListener('click', () => turnModel(new THREE.Quaternion()));
// ← → nudge the explode 1%; held, they scrub it at a steady rate (key repeat is too jumpy) until let go.
const scrub = { dir: 0, raf: 0 };
function scrubExplode(dir) {
  if (ui.mode === 'joint') return setExplode(0);
  setExplode(+$('#explode').value + dir);
  scrub.dir = dir; cancelAnimationFrame(scrub.raf);
  const t0 = performance.now();
  let last = t0 + 250;   // a tap is a nudge; scrubbing starts after a beat
  const tick = (t) => {
    if (!scrub.dir) return;
    if (t > last) { setExplode(+$('#explode').value + scrub.dir * 40 * (t - last) / 1000); last = t; }
    scrub.raf = requestAnimationFrame(tick);
  };
  scrub.raf = requestAnimationFrame(tick);
}
window.addEventListener('keyup', (e) => { if (scrub.dir && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) { scrub.dir = 0; commit(); } });
window.addEventListener('blur', () => { scrub.dir = 0; });
function setExplode(v) { if (ui.mode === 'joint') return say('explode is off in joint mode: switch to Explode (E)'); $('#explode').value = Math.max(0, Math.min(100, v)); applyExplode(); }
$('#resetBtn').addEventListener('click', () => { for (const m of model.children) { m.userData.axis = undefined; m.userData.pull = undefined; m.userData.exTo = undefined; } applyExplode(); say('explode positions reset'); });

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
  $('#measures').textContent = `BOUNDING BOX ${size.x.toFixed(2)} × ${size.y.toFixed(2)} × ${size.z.toFixed(2)}`;
  paintWeight();
  $('#stats').textContent = `${model.children.length} BOD${model.children.length === 1 ? 'Y' : 'IES'} · ${segs ? `${segs.toLocaleString()} SEGS · ` : ''}${tris ? `${tris.toLocaleString()} TRIS · ` : ''}${verts.toLocaleString()} VERTS · ${ms} MS`;
  $('#drop').hidden = true; $('#loadError').textContent = '';
  placeGrid();
  planes.load();   // this file's planes, sized to it
  const dups = listBodies();
  warmRays();
  setupSection();
  // A flat drawing is read from above and handled like paper: pan, turn in quarters, flip over.
  ui.flat = size.z < 1e-9; $('#sideBtn').hidden = !ui.flat;
  if (!keep) { if (ui.flat) setView('3'); fit(); }   // a reload of a changed file keeps the camera
  edges.visible = ui.edges || ui.wire;   // the wireframe is the edges
  say(dups ? `${name} in ${ms} ms · ${dups}` : `${name} in ${ms} ms`);
  loadParts();
  if (!fromBundle) { loadMarkup(); loadJoints(); }   // a bundle brings its own markups and joints
  setTimeout(postBodies, 600);
  postSnapshot();
}

// Units for the grid and the ruler: mm, or inches (the grid then steps in ⅛, ¼, ½, 1 … inches).
const UNIT_MM = { mm: 1, in: 25.4 };
let gridStep = 0;   // the grid's spacing in mm: what ⇧ snaps a dragged part to
const fmtLen = (mm) => (ui.units === 'in' ? `${(mm / 25.4).toFixed(3)} in` : `${mm.toFixed(2)} mm`);

// RULER: the grid's scale along its front (X) and left (Y) edges, in the chosen unit, counting from 0 at the
// grid crossing on the model's front left corner, + one way and − the other: a tick on every grid line, a
// longer one with its number every few (about ten an edge).
let ruler = null;
function placeRuler(gridStepMM, gridDivs, x0, y0, z, ox = x0, oy = y0) {
  if (ruler) { scene.remove(ruler); ruler.traverse((o) => { o.geometry?.dispose(); o.material?.map?.dispose(); o.material?.dispose(); }); ruler = null; }
  // A tick on every grid line; a number about ten times an edge (mm), or at every inch (in: every
  // other ½" line, or every few inches on a big grid).
  const unit = UNIT_MM[ui.units], extent = gridStepMM * gridDivs;
  const stepU = gridStepMM / unit, stepMM = gridStepMM, divs = gridDivs;
  const perInch = ui.units === 'in' ? Math.round(1 / stepU) : 0;
  const every = perInch ? perInch * Math.max(1, Math.ceil(divs / perInch / 12)) : Math.max(1, Math.ceil(divs / 10));
  const ink = document.documentElement.dataset.theme === 'dark' ? '#d8d8d4' : '#55544f';
  const g = new THREE.Group(), segs = [], span = extent;
  const dec = Math.max(0, Math.min(4, Math.ceil(-Math.log10(stepU * every) + 1e-9)));
  const th = stepMM * Math.min(every, 4) * 0.13;   // label height: small, a fraction of the labelled spacing
  const label = (text, x, y, align) => {
    const c = document.createElement('canvas'), ctx = c.getContext('2d'), px = 36;
    ctx.font = `${px}px "Space Mono", monospace`;
    c.width = Math.ceil(ctx.measureText(text).width + 8); c.height = px + 8;
    ctx.font = `${px}px "Space Mono", monospace`; ctx.fillStyle = ink; ctx.textBaseline = 'middle'; ctx.textAlign = 'center'; ctx.fillText(text, c.width / 2, c.height / 2);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, depthTest: false, transparent: true }));
    const w = th * c.width / c.height;
    sp.scale.set(w, th, 1);
    sp.position.set(align === 'right' ? x - w / 2 : x, y, z); sp.renderOrder = 3;
    g.add(sp);
  };
  segs.push(x0, y0, z, x0 + span, y0, z, x0, y0, z, x0, y0 + span, z);   // the two edges
  const ix = Math.round((ox - x0) / stepMM), iy = Math.round((oy - y0) / stepMM);   // the lines through the origin
  const num = (n) => (n < 0 ? '−' : '') + (Math.abs(n) * stepU).toFixed(dec);
  const mod = (a, b) => ((a % b) + b) % b;
  for (let i = 0; i <= divs; i++) {
    const x = x0 + i * stepMM, y = y0 + i * stepMM;
    const mx = mod(i - ix, every) === 0, my = mod(i - iy, every) === 0;
    segs.push(x, y0, z, x, y0 - th * (mx ? 0.9 : 0.45), z, x0, y, z, x0 - th * (my ? 0.9 : 0.45), y, z);
    if (mx) label(num(i - ix), x, y0 - th * 0.9 - th * 0.7);              // under the front edge
    if (my) label(num(i - iy), x0 - th * 0.9 - th * 0.25, y, 'right');    // left of the left edge
  }
  label(ui.units, x0 + span + th * 1.2, y0 - th * 0.9 - th * 0.7);
  const lines = new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(segs, 3)), new THREE.LineBasicMaterial({ color: ink }));
  lines.renderOrder = 3;
  g.add(lines);
  g.traverse((o) => { o.raycast = () => {}; });   // never a pick
  g.visible = ui.ruler;
  scene.add(ruler = g);
}

function placeGrid() {
  if (grid) { scene.remove(grid); grid.geometry.dispose(); grid = null; }
  if (!bbox) { if (ruler) { scene.remove(ruler); ruler = null; } return; }
  const size = bbox.getSize(new THREE.Vector3());
  const span = Math.max(size.x, size.y) * 2 || 100;
  // inches: a line every ½" and a darker one every inch (a whole number of inches, so they line up);
  // a very large model steps in whole inches instead. mm: a power of ten, as always.
  const inch = ui.units === 'in', PER_INCH = 2;
  const sub = inch && span / (25.4 / PER_INCH) <= 400;
  const step = inch ? (sub ? 25.4 / PER_INCH : 25.4) : Math.pow(10, Math.floor(Math.log10(span / 10)));
  gridStep = step;
  let divs = Math.max(2, Math.round(span / step));
  divs = Math.ceil(divs / (sub ? 2 * PER_INCH : 2)) * (sub ? 2 * PER_INCH : 2);   // even, in lines and in inches: one runs through the middle
  grid = new THREE.GridHelper(divs * step, divs, 0xbdbdbd, 0xe3e3e3);
  if (sub) {   // the inch lines, over the halves (a child: it rides the grid's turn and place)
    const major = new THREE.GridHelper(divs * step, divs / PER_INCH, 0xa9a9a6, 0xa9a9a6);
    major.position.y = 1e-4 * step;
    grid.add(major);
  }
  grid.rotation.x = Math.PI / 2;            // the part's Z is up
  // A grid line crosses at the model's lower left corner seen from the top (its front left), and the ruler
  // counts from there. The grid sits as near centred on the model as that allows: its middle a whole number of
  // (inch) lines from the corner, with an even count of them, so a line runs through the middle and the corner.
  const ox = bbox.min.x, oy = bbox.min.y, big = sub ? step * PER_INCH : step;
  const snap = (c, o) => o + Math.round((c - o) / big) * big;
  grid.position.set(snap((bbox.min.x + bbox.max.x) / 2, ox), snap((bbox.min.y + bbox.max.y) / 2, oy), bbox.min.z - step * 0.01); // a hair under a flat drawing
  grid.visible = ui.grid;
  scene.add(grid);
  placeRuler(step, divs, grid.position.x - divs * step / 2, grid.position.y - divs * step / 2, grid.position.z, ox, oy);
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
/** Turn the view about a point (null: the orbit's centre): what was pressed on stays put (orbitmath.js). */
const turnAbout = (pivot, dyaw, dpitch) => turnOrbit(THREE, orbit, pivot, dyaw, dpitch);
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
  if (pickPlane) {   // a new plane on the face clicked; anything else backs out
    const done = pickPlane; pickPlane = null; renderer.domElement.classList.remove('picking');
    const h = e.button === 0 && faceAt(e);
    if (h) { done(h.point, h.normal); say('plane added'); } else say('no face there: no plane');
    return;
  }
  if (pickJoint) { e.stopPropagation(); if (e.button === 0) pickJointFace(e); else endPickJoint(); return; }   // a new joint: left takes faces, anything else backs out (and the click that opens its type menu must not reach the document, which closes menus)
  const lim = e.button === 0 && limitAt(e);
  if (lim) { drag = { id: e.pointerId, x: e.clientX, y: e.clientY, downX: e.clientX, downY: e.clientY, limit: lim }; renderer.domElement.setPointerCapture(e.pointerId); return; }
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
  // Bambu Studio mouse in Explode mode: left drag rotates about the point pressed on, right or wheel drag pans,
  // the wheel zooms to the pointer; ⌥-drag on a part slides it along its explode axis. Shift-drag is a window
  // select, shift-click adds a part. Joint mode: a drag drives the part's joint, as before.
  if (e.button === 1) e.preventDefault();
  const tooling = measure.on || !!$('[data-tool].on');   // a markup or measure tool owns shift
  drag = { id: e.pointerId, x: e.clientX, y: e.clientY, pan: e.button === 2 || e.button === 1 || (e.shiftKey && tooling), downX: e.clientX, downY: e.clientY, click: e.button === 0 };
  if (e.button === 0 && e.shiftKey && !tooling && e.pointerType !== 'touch') drag.marquee = true;
  if (e.button === 0 && !e.shiftKey && !measure.on && onCap(e)) drag.sect = sectionScreenAxis(e);
  else if (e.button === 0 && !e.shiftKey && !measure.on && e.pointerType !== 'touch') {
    const hit = partAt(e);
    const j = ui.mode === 'joint' && hit && (e.metaKey ? jointOf(hit.body) : drivingJoint(hit.body));   // ⌘: the part's own joint offset, even on a rigid one
    if (ui.mode === 'joint') { if (j && !(e.metaKey && j.type === 'ball')) drag.joint = { j, offset: e.metaKey, m: bodyOfKey(j.body), hit: hit.body, local: hit.point.clone().applyMatrix4(hit.body.matrixWorld.clone().invert()) }; }   // joint mode: a jointed part turns or slides on its joint, anything else orbits
    else if (hit && e.altKey) {
      const v = explodeVec(hit.body), full = +$('#explode').value >= 100;
      // fully exploded, a part in a selection carries the others: each slides the same distance along its own axis
      const group = full && selected.has(hit.body) && selected.size > 1 ? [...selected].filter((m) => m.isMesh && moves(m, explodeVec(m))) : null;
      if (moves(hit.body, v)) drag.part = { m: hit.body, full, group, ...screenAxis(hit.point, v.normalize()) };
    }
  }
  // Exploded, a part pressed on and dragged moves in the screen's plane (up and down too): the selection when the
  // part is in it, else that part alone. The move is part of its explode: the slider brings it home at 0 and back
  // out to where it was put. ⇧ snaps to grid steps. Assembled, a drag rotates as always.
  if (e.button === 0 && !e.altKey && !e.shiftKey && !drag.sect && !drag.part && !measure.on && !ui.flat && e.pointerType !== 'touch' && ui.mode !== 'joint' && !$('[data-tool].on')) {
    const m = bodyAt(e), h = m && hitAt(e);
    if (m && h) {
      const bodies = selected.has(m) ? sel() : [m];
      const k = parseFloat($('#explode').value) / 100, fracs = bodies.map((b) => stageFrac(b, k));
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(camera.getWorldDirection(new THREE.Vector3()), h);
      if (fracs.some((f) => f > 0.02)) drag.move = { m, bodies, plane, fracs, from: h.clone(), startEx: bodies.map((b) => b.userData.exTo?.clone() ?? new THREE.Vector3()) };
    }
  }
  if (!drag.pan && !drag.sect && !drag.part && !drag.move && !drag.marquee && !drag.joint && !ui.flat) drag.pivot = hitAt(e);   // orbit about what was pressed on
  renderer.domElement.setPointerCapture(e.pointerId);
});
renderer.domElement.addEventListener('pointermove', (e) => {
  if (pickJoint) {
    const { h, a } = jointFaceAt(e) ?? {};
    axisArrow.visible = !!a;
    if (a) {   // the axis it would take, drawn where the face's own frame puts it
      const len = 0.35 * (h.body.geometry.boundingBox?.getSize(new THREE.Vector3()).length() || 10);
      axisArrow.position.copy(a.origin).applyMatrix4(h.body.matrixWorld);
      axisArrow.setDirection(a.axis.clone().transformDirection(h.body.matrixWorld)); axisArrow.setLength(len, len * 0.25, len * 0.12);
      axisRing.scale.setScalar(len * 0.08);
    }
    return;
  }
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
    // A press on a cut face drags the section, anywhere else on a part drags the part: over a cut face the
    // caps light up and the cursor turns to an up-down arrow, over a part it gets its outline and a hand.
    const sect = onCap(e), p = !sect && e.pointerType !== 'touch' ? partAt(e) : null;
    hoverBody($('[data-tool].on') ? null : p?.body ?? null);   // no tool chosen: the body under the mouse and its row light up
    litCaps(sect);
    renderer.domElement.classList.toggle('onsect', sect);
    renderer.domElement.classList.toggle('oncap', !sect && (!!p || !!limitAt(e)));
    return;
  }
  if (drag.id !== e.pointerId) return;
  if (drag.limit) { dragLimit(e, drag.limit); return; }
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  drag.x = e.clientX; drag.y = e.clientY;
  if (drag.marquee) {
    const box = $('#marquee'), x0 = drag.downX, y0 = drag.downY;
    box.hidden = Math.hypot(e.clientX - x0, e.clientY - y0) < 4;
    box.classList.toggle('crossing', e.clientX < x0);   // right→left: anything it touches
    Object.assign(box.style, { left: `${Math.min(x0, e.clientX)}px`, top: `${Math.min(y0, e.clientY)}px`, width: `${Math.abs(e.clientX - x0)}px`, height: `${Math.abs(e.clientY - y0)}px` });
    return;
  }
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
  if (drag.joint) { driveJoint(drag.joint, dx, dy, e.altKey); return; }   // ⌘ was read at the press
  if (drag.part) {
    const m = drag.part.m, max = maxTravel(m), S = stageCount();
    const d = Math.max(0, max * stageFrac(m, +$('#explode').value / 100) + dx * drag.part.sx + dy * drag.part.sy);
    if (drag.part.group) { const step = dx * drag.part.sx + dy * drag.part.sy; for (const g of drag.part.group) g.userData.pull = Math.max(0, maxTravel(g) + step); applyExplode(); return; }
    if (drag.part.full) { m.userData.pull = d; applyExplode(); return; }   // fully exploded: the drag places this part alone, there is its maximum
    if (d > max) m.userData.pull = d;   // past its maximum: that is the new maximum
    const f = Math.min(1, d / maxTravel(m));
    $('#explode').value = 100 * (S < 2 ? f : ((m.userData.stage ?? 0) + f) / S);   // the part is the slider's handle, in its own slice
    applyExplode();
    return;
  }
  if (drag.move) {   // exploded: slide the selection in the screen's plane, under the pointer
    const r = renderer.domElement.getBoundingClientRect();
    raycaster.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
    const q = raycaster.ray.intersectPlane(drag.move.plane, new THREE.Vector3());
    if (!q) return;
    const d = q.sub(drag.move.from);
    if (!drag.move.started) { drag.move.started = true; if (!selected.has(drag.move.m)) selectBodies([drag.move.m], 'set'); }   // what moves is what is selected
    if (e.shiftKey && gridStep) { d.x = Math.round(d.x / gridStep) * gridStep; d.y = Math.round(d.y / gridStep) * gridStep; d.z = Math.round(d.z / gridStep) * gridStep; }
    drag.move.bodies.forEach((m, i) => {
      const f = drag.move.fracs[i];
      if (f > 0.02) m.userData.exTo = drag.move.startEx[i].clone().addScaledVector(d, 1 / f);   // scaled so it sits under the pointer now and goes further at full explode (a part whose stage hasn't started stays)
    });
    applyExplode();
    say(`moved ${fmtLen(d.x)}, ${fmtLen(d.y)}, ${fmtLen(d.z)}: it explodes to here`);
    return;
  }
  if (drag.pan || ui.flat) {
    pan(dx, dy);
  } else {
    turnAbout(drag.pivot, -dx * 0.006, dy * 0.006);   // finger or mouse, the model follows: drag left and its front turns left
  }
});
renderer.domElement.addEventListener('pointerup', (e) => {
  const still = drag && Math.hypot(e.clientX - drag.downX, e.clientY - drag.downY) < 4;
  if (drag?.click && measure.on && still) measure.click(e);
  if (drag?.marquee) {
    $('#marquee').hidden = true;
    if (still) { const p = partAt(e); if (p) selectBodies([p.body], 'toggle'); }
    else selectBodies(bodiesInWindow(drag.downX, drag.downY, e.clientX, e.clientY, e.clientX < drag.downX), 'add');
  } else if (drag?.click && still && !drag.sect && !measure.on && !$('[data-tool].on') && e.button === 0) {   // a plain click: that part alone, or nothing
    const p = partAt(e), add = e.metaKey || e.ctrlKey;   // ⌘-click toggles one, as in Finder
    if (add) { if (p) selectBodies([p.body], 'toggle'); } else selectBodies(p ? [p.body] : [], 'set');
  }
  if (e.button === 2 && still) showMenu(e.clientX, e.clientY, partAt(e)?.body);
  if (drag?.limit) renderJoints();   // the min/max fields take the dragged limit
  if (drag?.sect || drag?.part || drag?.joint || drag?.limit || drag?.move) commit();
  drag = null;
  touches.delete(e.pointerId);
});
renderer.domElement.addEventListener('pointerleave', () => { hoverBody(null); litCaps(false); });
renderer.domElement.addEventListener('pointercancel', (e) => { drag = null; touches.delete(e.pointerId); });
renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());
renderer.domElement.addEventListener('dblclick', (e) => { const h = limitAt(e); if (h) { h.j[h.which] = null; renderJoints(); applyExplode(); saveJoints(); commit(); } });   // a limit's handle, double-clicked: free again
const raycaster = new THREE.Raycaster();
function hitAt(e) {
  const r = renderer.domElement.getBoundingClientRect();
  raycaster.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
  return raycaster.intersectObjects(model.children, false)[0]?.point ?? null;
}
attachOrbitInput(renderer.domElement, { orbit, getCamera: () => camera, THREE, hitAt, isFlat: () => ui.flat, scheme: () => ui.scroll });

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

// ------------------------------------------------------------------ joints
// A joint lets a body move on an axis instead of only exploding: a screw turns and advances, a hinge
// swings, a drawer slides. web/joints.js is the math (a pose per jointed body, through its parents);
// applyExplode puts that pose on the mesh over the explode offset. Here are the rest: picking the axis
// off a face, the panel, dragging the part, and keeping the joints per file so Claude can read and drive them.
let poses = new Map();   // body key → rest→current matrix of its joint chain, refreshed by applyExplode
const IDENT = new THREE.Matrix4();
const r6 = (v) => +v.toFixed(6);
function bodyKeys() {   // partKey for every body at once
  const seen = new Map(), out = new Map();
  for (const m of model.children) { const n = seen.get(m.userData.name) ?? 0; seen.set(m.userData.name, n + 1); out.set(m, `${m.userData.name}#${n}`); }
  return out;
}
const jointsOf = (key) => joints.filter((j) => j.body === key);
// A body's joint for ⌘-drag and the menu: the one last driven (a slider, a field, a drag), else its first.
const jointOf = (m) => { const list = joints.length ? jointsOf(bodyKeys().get(m)) : []; return list.find((j) => j.id === lastJoint) ?? list[0]; };
// The joint a drag on this body moves: its last-driven one that can move, else its first that can, or, for a
// body that only rides on another (a lens fixed in its cell, a claw on the housing), the first up its chain.
function drivingJoint(m) {
  let key = bodyKeys().get(m);
  for (let n = 0; key && n < 32; n++) {
    const list = jointsOf(key), moving = list.filter((j) => j.type !== 'fixed');
    if (moving.length) return moving.find((j) => j.id === lastJoint) ?? moving[0];
    key = list[0]?.parent;
  }
  return null;
}
const bodyOfKey = (key) => [...bodyKeys()].find(([, k]) => k === key)?.[0] ?? null;
const jointId = () => 'j' + Math.random().toString(36).slice(2, 8);
function setJoints(list) {
  joints = list.map(normalizeJoint);
  renderJoints(); applyExplode(); saveJoints(); resolveForJoints();
}
const jointVal = (j, key) => (key.startsWith('rot') ? j.rot[+key.slice(3)] : j[key]);
function setJointValue(j, key, v) {
  lastJoint = j.id;
  if (key.startsWith('rot')) j.rot = j.rot.map((r, i) => (i === +key.slice(3) ? v : r));
  else j[key] = key === 'value' ? clampValue(j, v) : v;
  syncJointRow(j); applyExplode(); saveJoints();
}
function removeJoint(j) { joints = joints.filter((x) => x !== j); renderJoints(); applyExplode(); saveJoints(); commit(); }
function addJoint(m, type, a, parent = null, align = null) {
  const key = bodyKeys().get(m), first = jointsOf(key)[0];
  const parentKey = first ? first.parent : parent ? bodyKeys().get(parent) : null;   // a stacked joint rides on the first: same parent
  const centre = m.geometry.boundingBox.getCenter(new THREE.Vector3());
  const j = normalizeJoint({
    id: jointId(), type, body: key, parent: parentKey,
    name: `${JOINT_LABEL[type]} · ${nameOf(m)}${parent ? ` on ${nameOf(parent)}` : ''}`,
    origin: (a ? a.origin : centre).toArray().map(r6), axis: (a ? a.axis : new THREE.Vector3(0, 0, 1)).toArray().map(r6),
    pitch: type === 'screw' ? pitchFor(a?.radius ? a.radius * 2 : 4) : 0, align: align?.toArray().map(r6) ?? null,
  });
  setJoints([...joints, j]);   // a body's joints stack: this one rides on the ones it already has
  lastJoint = j.id;
  showJointLinks(3000);
  commit();
  say(type === 'fixed' ? `${nameOf(m)} rides on ${parent ? nameOf(parent) : 'the ground'}` : `${nameOf(m)}: ${type} joint — drag the part, or use its slider`);
}

// NEW JOINT, as in Fusion: click a face on the part that moves, then a face on the part it moves on (empty
// space: the ground), then the motion. The joint turns or slides about a round face of the two (a screw's
// shank, a bore, a pin, a ball), else along the first face's normal; the menu offers the type the faces
// suggest first. The arrow shows what a click would take. The parts stay where they are (Fusion's as-built joint).
let pickJoint = null;   // { first: { m, a } } once the moving part's face is in
function startPickJoint() {   // in either mode: an exploded assembly stays exploded, its faces easier to reach
  hideMenu();
  setMeasure(false);   // the face picks are the joint's: no measure or markup tool in the way
  const t = $('[data-tool].on')?.dataset.tool; if (t) markup.setTool(t);
  pickJoint = {};
  renderer.domElement.classList.add('picking');
  $('#newJointBtn').classList.add('on');
  say('new joint: click a face on the part that moves · Esc cancels');
}
function endPickJoint() { pickJoint = null; axisArrow.visible = false; renderer.domElement.classList.remove('picking'); $('#newJointBtn').classList.remove('on'); }
// The face under the pointer and the axis it gives, its origin moved onto the snap near the pointer, as
// Fusion's joint origins: a circle's centre (its axis is the circle's: a hole picked by its rim), an edge's
// end or middle. A round face keeps its axis and slides along it to the snap; a ball keeps its centre.
function jointFaceAt(e) {
  const h = faceAt(e);
  if (!h) return null;
  let a = faceAxis(h);
  const s = a.kind !== 'sphere' && measure.pointSnapAt(e);
  if (s && new THREE.Box3().setFromObject(h.body).expandByScalar(1e-3 * (bbox ? bbox.getSize(new THREE.Vector3()).length() : 1)).containsPoint(s.p)) {   // a snap on this part, not one behind it
    const inv = h.body.matrixWorld.clone().invert(), p = s.p.clone().applyMatrix4(inv);
    if (s.kind === 'centre') a = { kind: 'cyl', origin: p, axis: s.f.n.clone().transformDirection(inv), radius: s.f.r };
    else if (a.kind === 'cyl') a = { ...a, origin: a.origin.clone().addScaledVector(a.axis, p.clone().sub(a.origin).dot(a.axis)) };
    else a = { ...a, origin: p };
  }
  return { h, a };
}
function pickJointFace(e) {
  const { h, a: picked } = jointFaceAt(e) ?? {};
  if (!pickJoint.first) {
    if (!h) return say('click a face on the part that moves · Esc cancels');
    pickJoint.first = { m: h.body, a: picked };
    selectBodies([h.body], 'set');
    return say(`${nameOf(h.body)} moves: click a face on the part it moves on, or empty space for the ground · Esc cancels`);
  }
  if (h?.body === pickJoint.first.m) return say('click a face on another part, or empty space for the ground');
  const { m, a: a1 } = pickJoint.first, parent = h?.body ?? null, a2 = h && picked;
  const round = (a) => a && a.kind !== 'plane';
  const align = parent && !jointsOf(bodyKeys().get(m)).length ? snapFace(a1, a2) : null;   // a part already jointed is where its joints put it: only its first joint snaps
  const a = round(a2) ? a2 : round(a1) ? moved(a1, align) : a2 ?? a1;   // the joint lives on the parent: the faces meet there
  const flatOnFlat = a1.kind === 'plane' && a2?.kind === 'plane' && Math.abs(a1.axis.dot(a2.axis)) > 0.999;   // two faces that mate (or a face on the ground): it slides about on them
  const suggest = a.kind === 'sphere' ? 'ball' : a.kind === 'cyl' ? 'revolute' : flatOnFlat || !parent ? 'planar' : 'slider';
  endPickJoint();
  const types = [suggest, ...['revolute', 'slider', 'screw', 'cylindrical', 'planar', 'ball', 'fixed'].filter((t) => t !== suggest)];
  showItems(e.clientX, e.clientY, [
    { head: `${nameOf(m)} on ${parent ? nameOf(parent) : 'the ground'}` },
    ...types.map((t) => ({ label: t === 'fixed' ? 'Rigid' : JOINT_LABEL[t], on: () => t === suggest, run: () => addJoint(m, t, a, parent, align) })),   // a rigid joint keeps the face too: its offset goes along it
  ]);
}
// Where the moving part goes, as Fusion snaps it: its face's centre onto the other's, a flat face turned to
// face the other (they touch), a round one onto the other's axis (the nearer way round). Rest frames throughout.
function snapFace(a1, a2) {
  let q = new THREE.Quaternion();
  if (a1.kind !== 'sphere' && a2.kind !== 'sphere') {
    const to = a1.kind === 'plane' && a2.kind === 'plane' ? a2.axis.clone().negate() : a2.axis.clone().multiplyScalar(Math.sign(a1.axis.dot(a2.axis)) || 1);
    q = new THREE.Quaternion().setFromUnitVectors(a1.axis.clone().normalize(), to.normalize());
  }
  const o = a1.origin.clone().applyQuaternion(q);
  return new THREE.Matrix4().makeRotationFromQuaternion(q).setPosition(a2.origin.clone().sub(o));
}
const moved = (a, M) => ({ ...a, origin: a.origin.clone().applyMatrix4(M ?? IDENT), axis: a.axis.clone().transformDirection(M ?? IDENT) });
let axisMemo = null;   // the last face fitted: the pointer stays on one face for many moves
function faceAxis(h) {   // { kind, origin, axis, radius? } in the geometry's own (rest) frame
  const m = h.body, f = m.userData.faces?.find((f) => h.faceIndex >= f.first && h.faceIndex < f.first + f.count);
  const turn = rot.toArray().join();
  if (f && axisMemo?.f === f && axisMemo.turn === turn) return axisMemo.res;
  let res = null;
  if (f) {
    const pos = m.geometry.getAttribute('position'), ix = m.geometry.index?.array;
    const tris = [], centroid = new THREE.Vector3(), tmp = new THREE.Vector3(), nAvg = new THREE.Vector3(); let area = 0;
    for (let t = f.first; t < f.first + f.count; t++) {
      const v = (k) => new THREE.Vector3().fromBufferAttribute(pos, ix ? ix[3 * t + k] : 3 * t + k);
      const tri = new THREE.Triangle(v(0), v(1), v(2)), ar = tri.getArea();
      if (!ar) continue;
      tris.push(tri); area += ar; centroid.addScaledVector(tri.getMidpoint(tmp), ar); nAvg.addScaledVector(tri.getNormal(tmp), ar);
    }
    if (tris.length) {
      centroid.divideScalar(area); nAvg.normalize();
      if (tris.every((t) => t.getNormal(tmp).dot(nAvg) > 0.9998)) res = { kind: 'plane', origin: centroid, axis: nAvg };
      else {
        const c = cylinderFit(tris, centroid);
        if (c) res = { kind: 'cyl', origin: c.c, axis: c.axis, radius: c.r };
        else {   // a ball: the sphere through the face's corners
          const verts = []; for (const t of tris) verts.push(t.a, t.b, t.c);
          const sp = sphereFit(verts);
          if (sp && sp.rms < sp.r * 0.01) res = { kind: 'sphere', origin: sp.c, axis: new THREE.Vector3(0, 0, 1), radius: sp.r };
        }
      }
    }
  }
  if (!res) {   // no B-rep face (a mesh): the triangle under the pointer
    const inv = m.matrixWorld.clone().invert();
    res = { kind: 'plane', origin: h.point.clone().applyMatrix4(inv), axis: h.normal.clone().transformDirection(inv) };
  } else if (f) axisMemo = { f, turn, res };
  return res;
}
// A jointed part follows the pointer: a slider along its axis, the rest by the turn the pointer makes about the axis.
function driveJoint(d, dx, dy, alt) {
  const { j, m } = d;
  d.hit.updateMatrixWorld(true);
  const Wp = poses.frames?.get(j.id) || IDENT;   // where the joint's own frame is now: its parent, then the body's joints before it
  const n = new THREE.Vector3(...j.axis).transformDirection(Wp);
  const o = new THREE.Vector3(...j.origin).applyMatrix4(Wp).add(m.userData.exPos);
  if (j.type === 'ball') {   // a trackball: the pointer turns the part about its centre, as the camera sees it
    const cam = camera, right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0), up = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1);
    const k = THREE.MathUtils.degToRad(0.5);
    const world = new THREE.Quaternion().setFromAxisAngle(up, dx * k).multiply(new THREE.Quaternion().setFromAxisAngle(right, dy * k));
    const R = new THREE.Quaternion().setFromRotationMatrix(Wp);
    const delta = R.clone().invert().multiply(world).multiply(R);   // the turn in the joint's own (rest) frame
    const cur = new THREE.Quaternion().setFromEuler(new THREE.Euler(...j.rot.map(THREE.MathUtils.degToRad), 'XYZ'));
    j.rot = eulerOf(delta.multiply(cur));
    syncJointRow(j); applyExplode(); saveJoints();
    return;
  }
  const P = d.local.clone().applyMatrix4(d.hit.matrixWorld);   // the grabbed point, where it is now
  if (d.offset) { const { sx, sy } = screenAxis(P, n); setJointValue(j, 'offset', j.offset + dx * sx + dy * sy); return; }   // ⌘-drag: along the axis, past the motion
  if (j.type === 'planar' && !alt) {   // slides under the pointer: the screen move undone through the plane's x and y (⌥ turns it)
    const [u, v] = planeAxes(j.axis).map((a) => a.transformDirection(Wp));
    const px = (dir) => { const r = renderer.domElement.getBoundingClientRect(), a = P.clone().project(camera), b = P.clone().add(dir).project(camera); return [(b.x - a.x) * r.width / 2, -(b.y - a.y) * r.height / 2]; };
    const [[ux, uy], [vx, vy]] = [px(u), px(v)], det = ux * vy - vx * uy;
    if (Math.abs(det) < 1e-6) return;   // the plane edge-on: no way to tell x from y
    j.value2 += (dx * vy - dy * vx) / det; j.value3 += (ux * dy - uy * dx) / det;
    syncJointRow(j); applyExplode(); saveJoints();
    return;
  }
  if (j.type === 'slider' || (j.type === 'cylindrical' && alt)) {
    const { sx, sy } = screenAxis(P, n);
    setJointValue(j, j.type === 'slider' ? 'value' : 'value2', (j.type === 'slider' ? j.value : j.value2) + dx * sx + dy * sy);
    return;
  }
  const r = P.clone().sub(o); r.addScaledVector(n, -r.dot(n));
  const rl = r.length(), size = bbox ? bbox.getSize(new THREE.Vector3()).length() : 100;
  let deg;
  if (rl < size * 0.01) deg = dx * 0.5;   // grabbed on the axis (the middle of a screw head): across the screen turns it
  else { const t = n.clone().cross(r).divideScalar(rl), { sx, sy } = screenAxis(P, t); deg = THREE.MathUtils.radToDeg((dx * sx + dy * sy) / rl); }
  setJointValue(j, 'value', j.value + THREE.MathUtils.clamp(deg, -45, 45));
}

// MODE: the part under the pointer does one thing at a time. Explode: drag slides it out, the menu sets its
// explode axis. Joint: drag moves it on its joint, the menu adds joints, explode is off. Joints keep their pose in both.
function setMode(mode) {
  if (mode === ui.mode) return;
  ui.mode = mode;
  document.documentElement.dataset.mode = mode;
  for (const b of document.querySelectorAll('[data-mode]')) b.classList.toggle('on', b.dataset.mode === mode);
  renderJoints();
  endPickAxis(); endPickJoint();
  applyExplode();
  say(mode === 'joint' ? 'joint mode: drag a jointed part to move it · ⌘-drag sets its offset · New joint (J) joins two parts' : 'explode mode: drag a part to slide it out · right-click a part for its explode axis');
}
for (const b of document.querySelectorAll('[data-mode]')) b.addEventListener('click', () => setMode(b.dataset.mode));
$('#newJointBtn').addEventListener('click', () => (pickJoint ? endPickJoint() : startPickJoint()));   // on while picking; a second click backs out
document.documentElement.dataset.mode = ui.mode;

// The panel: one row per joint, a slider to drive it, its parent and limits; how to make and move them under.
const JOINT_HINTS = 'J: new joint (moving part, then base). Drag: drive · ⌥ turn · ⌘ offset.\nTrack dots: min/max, double-click frees.';
function renderJoints() {
  const el = $('#joints');
  el.hidden = !joints.length && ui.mode !== 'joint';   // the joints in either mode; in Joint mode the hints even before the first one
  const div = (className, textContent) => Object.assign(document.createElement('div'), { className, textContent });
  const head = div('joints-head', '');
  head.append(Object.assign(document.createElement('span'), { textContent: 'Joints' }));
  if (joints.length) head.append(Object.assign(document.createElement('button'), { className: 'ghost', textContent: 'Check', title: 'Drive every joint through its range, find what its parts run into, and set its limits just short of the first crash each way', onclick: checkJoints }));
  el.replaceChildren(head, ...joints.map(jointRow), div('joints-hint', JOINT_HINTS));
}
/**
 * The Check button: each joint's crashes over its whole range (its old limits ignored, so a check can widen them
 * as well as tighten them) in the status line, and its limits snapped to the last clear
 * value before the first crash on either side of where it sits (found coarse, then refined between the
 * last clear step and the first hit). The joint is driven to the limit nearest its first crash, so you see it.
 */
const CHECK_STEPS = 120, REFINE_STEPS = 16;
// mm of overlap that is a fit, not a crash: a tight fit, a seated face, and the mesh's own chordal error, which the
// importer sets at 0.0008 of the model's size (0.25 mm on a 300 mm bench: a fillet sliding past an edge read as a crash)
const checkTol = () => Math.max(0.1, 0.001 * (bbox ? bbox.getSize(new THREE.Vector3()).length() : 100));
function checkJoints() {
  say('checking joints…', false, true);
  setTimeout(() => {   // let the status paint before the sweep holds the thread
    const res = sweep({ steps: CHECK_STEPS, tol: checkTol(), free: true }), fmt = (r, [a, b]) => (a === b ? `${a}` : `${a}…${b}`) + r.unit;
    const crash = res.flatMap((r) => r.contacts.filter((c) => !c.always).map((c) => ({ r, c })));
    const fits = res.flatMap((r) => r.contacts.filter((c) => c.always).map((c) => `${r.label} on ${c.label}`));
    const text = crash.map(({ r, c }) => `${r.label} hits ${c.label} at ${c.spans.map((s) => fmt(r, s)).join(', ')}`);
    if (fits.length) text.push(`always touching (a fit?): ${fits.join(', ')}`);
    const snapped = snapLimits(res);
    if (snapped.length) text.push(`limits set: ${snapped.join(', ')}`);
    say(text.join(' · ') || 'every joint moves clear through its range', false, !!text.length);
    if (crash.length) {
      const { r, c } = crash[0], j = joints.find((x) => x.id === r.id);
      if (j) setJointValue(j, 'value', [j.min, j.max].filter((v) => v != null).sort((a, b) => Math.abs(a - c.first) - Math.abs(b - c.first))[0] ?? c.first);
    }
    renderJoints(); drawJointLinks(); saveJoints(); commit();
  }, 30);
}
function snapLimits(res) {
  const keys = bodyKeys(), meshes = new Map([...keys].map(([m, k]) => [k, m])), size = bbox ? bbox.getSize(new THREE.Vector3()).length() : 100, out = [];
  for (const r of res) {
    const j = joints.find((x) => x.id === r.id);
    const crashes = r.contacts.filter((c) => !c.always);
    if (!j || !crashes.length) continue;
    const hitBodies = new Set(crashes.map((c) => c.body)), spans = crashes.flatMap((c) => c.spans), step = (r.range[1] - r.range[0]) / CHECK_STEPS, v = j.value;
    // between the last clear sample and the first hit, the first hit again at a finer step; the limit is the sample before it
    const edge = (clear, hit) => {
      const sub = sweepJoints(meshes, joints.map((x) => (x === j ? { ...x, min: Math.min(clear, hit), max: Math.max(clear, hit) } : x)), { steps: REFINE_STEPS, tol: checkTol(), only: j.id, size })[0];
      const hs = (sub?.contacts ?? []).filter((c) => hitBodies.has(c.body)).flatMap((c) => c.spans.flat());
      const first = hs.length ? (hit > clear ? Math.min(...hs) : Math.max(...hs)) : hit, back = (hit - clear) / REFINE_STEPS;
      return hit > clear ? Math.floor((first - back) * 10) / 10 : Math.ceil((first - back) * 10) / 10;
    };
    const up = Math.min(...spans.map(([a]) => a).filter((a) => a > v)), dn = Math.max(...spans.map(([, b]) => b).filter((b) => b < v));
    if (Number.isFinite(up)) j.max = Math.max(v, edge(up - step, up));
    if (Number.isFinite(dn)) j.min = Math.min(v, edge(dn + step, dn));
    if (Number.isFinite(up) || Number.isFinite(dn)) { j.value = clampValue(j, j.value); out.push(`${r.label} ${j.min ?? '…'}…${j.max ?? '…'}${r.unit}`); }
  }
  return out;
}
function jointRow(j) {
  const mk = (tag, props, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
  const size = bbox ? bbox.getSize(new THREE.Vector3()).length() : 100;
  const row = mk('div', { className: 'joint' });
  row.dataset.id = j.id;
  const tick = mk('input', { type: 'checkbox', checked: !j.hide, title: 'Show this joint’s axis and limit handles' });
  tick.addEventListener('change', () => { j.hide = !tick.checked; drawJointLinks(); saveJoints(); commit(); });
  row.append(mk('div', { className: 'jl' }, tick, mk('b', { textContent: JOINT_LABEL[j.type] }), mk('span', { className: 'jname', textContent: labelOfKey(j.body), title: j.name }),
    mk('button', { className: 'ghost', textContent: '×', title: 'Remove this joint', onclick: () => removeJoint(j) })));
  const drive = (key, second) => {
    const [lo, hi] = valueRange(j, size, second), unit = turns(j.type) && !second ? '°' : ' mm';
    const rng = mk('input', { type: 'range', min: lo, max: hi, step: 'any', value: j[key] });
    const num = mk('input', { type: 'number', step: 'any', className: 'jv', value: +j[key].toFixed(3) });
    rng.dataset.key = num.dataset.key = key;
    rng.addEventListener('input', () => setJointValue(j, key, +rng.value));
    num.addEventListener('input', () => { if (num.value !== '' && Number.isFinite(+num.value)) setJointValue(j, key, +num.value); });
    row.append(mk('div', { className: 'jr' }, rng, num, mk('span', { textContent: unit })));
  };
  if (j.type === 'ball') {
    for (const [i, ax] of ['x', 'y', 'z'].entries()) {
      const key = `rot${i}`;
      const rng = mk('input', { type: 'range', min: -180, max: 180, step: 'any', value: j.rot[i] });
      const num = mk('input', { type: 'number', step: 'any', className: 'jv', value: +j.rot[i].toFixed(2) });
      rng.dataset.key = num.dataset.key = key;
      rng.addEventListener('input', () => setJointValue(j, key, +rng.value));
      num.addEventListener('input', () => { if (num.value !== '' && Number.isFinite(+num.value)) setJointValue(j, key, +num.value); });
      row.append(mk('div', { className: 'jr' }, mk('span', { textContent: ax }), rng, num, mk('span', { textContent: '°' })));
    }
  } else if (j.type !== 'fixed') drive('value', false);
  if (j.type === 'cylindrical') drive('value2', true);
  if (j.type === 'planar') for (const [key, ax] of [['value2', 'x'], ['value3', 'y']]) { drive(key, true); row.lastChild.prepend(mk('span', { textContent: ax })); }
  if (j.type !== 'ball') { drive('offset', true); row.lastChild.prepend(mk('span', { textContent: 'offset', title: '⌘-drag the part to set it' })); }
  const opt = (field, label, props = {}) => {
    const i = mk('input', { type: 'number', step: 'any', className: 'jv', value: j[field] ?? '', ...props });
    const take = () => {   // as you type: the joint always holds what the field shows, so a save never misses it
      if (i.value !== '' && !Number.isFinite(+i.value)) return;
      j[field] = i.value === '' ? null : +i.value;
      if (field === 'min' || field === 'max') j.value = clampValue(j, j.value);
      applyExplode(); saveJoints();
    };
    i.addEventListener('input', take);
    i.addEventListener('change', () => { take(); syncJointRow(j); });   // done: the slider takes the new range. Not a whole redraw: the blur that fires this is the press on × or Flip, and a redraw swapped that button out before its click landed
    return mk('label', {}, label, i);
  };
  const keys = bodyKeys(), sel = mk('select', { className: 'ghost' }, mk('option', { value: '', textContent: 'ground' }),
    ...[...keys.values()].filter((k) => k !== j.body).map((k) => mk('option', { value: k, textContent: labelOfKey(k), selected: k === j.parent })));
  sel.addEventListener('change', () => { for (const x of jointsOf(j.body)) x.parent = sel.value || null; applyExplode(); saveJoints(); });   // the stack moves together
  const flip = () => {   // Fusion's flip: the snapped part turned over on the joint's face, about the plane's x through the origin
    const o = new THREE.Vector3(...j.origin), [u] = planeAxes(j.axis);
    const F = new THREE.Matrix4().makeTranslation(o.x, o.y, o.z).multiply(new THREE.Matrix4().makeRotationAxis(u, Math.PI)).multiply(new THREE.Matrix4().makeTranslation(-o.x, -o.y, -o.z));
    j.align = F.multiply(new THREE.Matrix4().fromArray(j.align)).toArray().map(r6);
    applyExplode(); saveJoints(); commit();
  };
  const stacked = jointsOf(j.body)[0] !== j;   // a second joint on the body rides on the first: its carrier is set there
  row.append(mk('div', { className: 'jo' }, stacked ? mk('span', { textContent: `then, on its ${JOINT_LABEL[jointsOf(j.body)[0].type].toLowerCase()} joint` }) : mk('label', {}, 'on ', sel), ...(j.align ? [mk('button', { className: 'ghost', textContent: 'Flip', title: 'Turn the part over on the joint face', onclick: flip })] : []),
    ...(j.type === 'screw' ? [opt('pitch', 'pitch ')] : []), ...(j.type === 'fixed' || j.type === 'ball' ? [] : [opt('min', 'min '), opt('max', 'max ')])));
  return row;
}
function syncJointRow(j) {
  const row = document.querySelector(`#joints .joint[data-id="${j.id}"]`);
  if (!row) return;
  const size = bbox ? bbox.getSize(new THREE.Vector3()).length() : 100;
  for (const i of row.querySelectorAll('[data-key]')) {
    const v = jointVal(j, i.dataset.key);
    if (i.type === 'range') { if (i.dataset.key === 'value') [i.min, i.max] = valueRange(j, size); i.value = v; }   // min/max moved its range
    else if (document.activeElement !== i) i.value = +v.toFixed(3);
  }
}

// Joints are kept per file on the server, so a reload brings them back and Claude can read and write them
// (cadgang_joints / cadgang_joint). `from` marks the page's own writes so it does not reload its own echo.
const clientId = Math.random().toString(36).slice(2);
let jointsTimer = null, jointsSaved = '[]';
function saveJoints() {
  clearTimeout(jointsTimer);
  jointsTimer = setTimeout(() => {
    const json = JSON.stringify(joints);
    if (!subject || json === jointsSaved) return;
    jointsSaved = json;
    api('/joints', { method: 'PUT', body: { subject, joints, from: clientId } }).catch(() => {});
  }, 400);
}
let jointsReq = 0;
function loadJoints() {
  const s = subject;
  if (!s) return;
  const mine = ++jointsReq;   // replies can cross when Claude drives quickly: only the newest one counts, or an old pose lands last and is saved back over the new
  api(`/joints?subject=${encodeURIComponent(s)}`).then((d) => {
    if (s !== subject || mine !== jointsReq) return;
    const next = (d.joints ?? []).map(normalizeJoint);
    if (JSON.stringify(next) !== JSON.stringify(joints)) { setJoints(next); commit(); }
    jointsSaved = JSON.stringify(joints);   // this is what the server holds: nothing to write back
  }).catch(() => {});
}
// What Claude needs to make a joint without guessing: each body's key and box, and its round faces (axis, centre, radius).
function postBodies() {
  if (!subject || !model.children.length) return;
  const s = subject, keys = bodyKeys(), r3 = (v) => +v.toFixed(3), r3a = (v) => v.toArray().map(r3);
  const tris = model.children.reduce((n, m) => n + (m.geometry.index ? m.geometry.index.count : m.geometry.getAttribute('position').count) / 3, 0);
  const bodies = model.children.filter((m) => m.isMesh).map((m) => {
    const b = m.geometry.boundingBox ?? (m.geometry.computeBoundingBox(), m.geometry.boundingBox);
    let round = [];
    if (tris <= 300000) try { round = cylinders(m).filter((c) => c.closed).sort((a, c) => (c.t1 - c.t0) * c.r - (a.t1 - a.t0) * a.r).slice(0, 12).map((c) => ({ origin: r3a(c.c), axis: r3a(c.axis), radius: r3(c.r), length: r3(c.t1 - c.t0) })); } catch {}
    return { key: keys.get(m), name: m.userData.name, ...(m.userData.label ? { label: m.userData.label } : {}), box: [...b.min.toArray(), ...b.max.toArray()].map(r3), cylinders: round };
  });
  api('/joints', { method: 'PUT', body: { subject: s, bodies } }).catch(() => {});
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
// Where two solids overlap (a screw's thread crests inside a standoff's) the other's face lies
// inside the cut body, nearer than its back faces, and showed through the cap (v0.14.81). So closed
// bodies also count into the stencil (back faces +1, front −1, every layer) and one quad ON the plane
// paints wherever the count is non-zero: that cap sits at the cut itself and nothing kept can be in
// front of it. Open meshes would break the count, so they keep only the back-face twin; and if the
// stencil ever draws nothing (it did in WKWebView at v0.8) the twins still cap as before.
const capColor = () => new THREE.Color(0x3a3a3a);
const stencilOp = (side, op) => new THREE.MeshBasicMaterial({ side, depthWrite: false, depthTest: false, colorWrite: false,
  stencilWrite: true, stencilFunc: THREE.AlwaysStencilFunc, stencilFail: op, stencilZFail: op, stencilZPass: op, clippingPlanes: [section.plane] });
const capPlane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: capColor(), side: THREE.DoubleSide,
  stencilWrite: true, stencilRef: 0, stencilFunc: THREE.NotEqualStencilFunc,
  stencilFail: THREE.ReplaceStencilOp, stencilZFail: THREE.ReplaceStencilOp, stencilZPass: THREE.ReplaceStencilOp }));
capPlane.renderOrder = 2; capPlane.visible = false; capPlane.raycast = () => {};
scene.add(capPlane);
// Closed and consistently wound once its vertices are welded: every edge a→b has exactly one b→a.
function closedMesh(g) {
  if (g.userData.closed !== undefined) return g.userData.closed;
  const p = g.getAttribute('position'), ix = g.index, n = ix ? ix.count : p.count;
  if (n > 3e6) return (g.userData.closed = false);   // ponytail: skip the weld on huge meshes, they keep the back-face cap
  g.computeBoundingBox();
  const q = 1e5 / (g.boundingBox.getSize(new THREE.Vector3()).length() || 1), weld = new Map(), id = new Int32Array(p.count);
  for (let i = 0; i < p.count; i++) {
    const k = `${Math.round(p.getX(i) * q)},${Math.round(p.getY(i) * q)},${Math.round(p.getZ(i) * q)}`;
    let j = weld.get(k); if (j === undefined) weld.set(k, (j = weld.size));
    id[i] = j;
  }
  const N = weld.size, edges = new Map(), at = (k) => id[ix ? ix.getX(k) : k];
  for (let k = 0; k + 2 < n; k += 3) for (let e = 0; e < 3; e++) {
    const a = at(k + e), b = at(k + (e + 1) % 3);
    if (a === b) continue;
    const key = a < b ? a * N + b : b * N + a, d = a < b ? 1 : -1;
    edges.set(key, (edges.get(key) ?? 0) + d * 1e6 + 1);   // count + 1e6·(forward − backward)
  }
  for (const v of edges.values()) if (v !== 2) return (g.userData.closed = false);
  return (g.userData.closed = true);
}
// The cut faces in the hover orange while the pointer is on one: a drag there moves the section.
let capsLit = false;
function litCaps(on) {
  if (on === capsLit) return;
  capsLit = on;
  const c = on ? new THREE.Color(0xff5a1f) : capColor();
  capPlane.material.color.copy(c);
  for (const m of model.children) m.userData.cap?.material.color.copy(c);
}
function buildCaps() {
  const on = !!section.axis && !!bbox;
  litCaps(false);
  capPlane.visible = on;
  model.children.forEach((m, i) => {
    if (m.userData.cap) { m.remove(m.userData.cap); m.userData.cap.material.dispose(); m.userData.cap = null; }
    for (const t of m.userData.stencil ?? []) { m.remove(t); t.material.dispose(); }
    m.userData.stencil = null;
    if (m.isLine) return;
    eachMat(m, (x) => { x.side = on ? THREE.FrontSide : THREE.DoubleSide; });
    if (!on || m.userData.ghost) return;   // a see-through body shows no cut face
    if (closedMesh(m.geometry)) {
      m.userData.stencil = [stencilOp(THREE.BackSide, THREE.IncrementWrapStencilOp), stencilOp(THREE.FrontSide, THREE.DecrementWrapStencilOp)].map((x) => {
        const t = new THREE.Mesh(m.geometry, x); t.renderOrder = 1; t.raycast = () => {}; m.add(t); return t;
      });
    }
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
  capPlane.position.copy(section.plane.coplanarPoint(new THREE.Vector3()));
  capPlane.lookAt(capPlane.position.clone().add(n));
  capPlane.scale.setScalar(bbox.getSize(new THREE.Vector3()).length() * 20);   // explode carries parts well past the box
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
  const look = (mat) => ({ name: mat?.name || '', color: mat?.color ? mat.color.getRGB(new THREE.Color(), THREE.SRGBColorSpace).toArray() : null,
    pbr: mat?.isMeshStandardMaterial ? { roughness: mat.roughness, metalness: mat.metalness } : null });
  const geoOf = (o) => o.geometry.clone().applyMatrix4(o.matrixWorld);
  // the named nodes above a body, outermost first: the tree's folders (as a STEP's assembly path)
  const pathOf = (o) => { const p = []; for (let a = o.parent; a && a !== obj; a = a.parent) if (a.name && a.name !== p[0]) p.unshift(a.name); return p; };
  const done = new Set();
  obj.traverse((o) => {
    // a glTF mesh with several primitives (one per material) loads as a Group of meshes: it is ONE body, a group per finish
    const prims = assoc?.get(o)?.meshes !== undefined && o.isGroup ? o.children.filter((c) => c.isMesh) : null;
    if (prims?.length > 1) {
      const geos = prims.map((c) => { done.add(c); const g = geoOf(c); for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k); return g; });
      const geo = mergeGeometries(geos.map((g) => (g.index ? g : g.setIndex([...Array(g.attributes.position.count).keys()]))), true);
      if (geo) { out.push({ geo, name: o.name || undefined, path: pathOf(o), groups: prims.map((c) => look(c.material)) }); return; }
      for (const c of prims) done.delete(c);
    }
    if (!o.isMesh || done.has(o)) return;
    const mat = [].concat(o.material)[0];
    out.push({ geo: geoOf(o), ...look(mat), name: o.name || undefined, path: pathOf(o), material: mat?.name ?? '' });   // the part's name, not its material's
  });
  return out;
}

/**
 * The name an STL carries, if any: cadgang writes "cadgang: <cell>" into a binary header, and an
 * ASCII file opens "solid <name>". Other binary headers are mostly an exporter's banner, so they're ignored.
 */
function stlName(buffer) {
  const head = new TextDecoder('latin1').decode(new Uint8Array(buffer, 0, Math.min(80, buffer.byteLength))).replace(/\0.*$/s, '').trim();
  const n = head.match(/^cadgang:\s*(.+)$/)?.[1]
    ?? (buffer.byteLength >= 84 && 84 + new DataView(buffer).getUint32(80, true) * 50 === buffer.byteLength ? null : head.match(/^solid\s+([^\r\n]+)/)?.[1]);
  return n && !/^(ascii|mesh|stl|cadgang|part|model|object|untitled)$/i.test(n.trim()) ? n.trim() : undefined;
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
  if (ext === 'stl') return [{ geo: loader.parse(buffer), flat: true, name: stlName(buffer) }];
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
    parts.push({ geo, edgeLines: faceBorderEdges(sub.pos, sub.idx, own), faces: own, name: n.name, path: n.path ?? [], color: n.color ?? null, material: n.material ?? '', opacity: n.opacity ?? 1 });
  }
  return parts;
}

async function api(path, { method = 'GET', body } = {}) {
  if (window.cadgangServerless && !path.startsWith('/markup')) { if (method === 'GET') throw new Error('no server'); return {}; }   // a Vercel share keeps only its markups (vercel/api/view/markup.js)
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
// Each open takes a ticket; an older one still loading (a reload behind a file change) drops its
// result instead of stacking it onto the newer one.
let loadTicket = 0;
async function openBuffers(files) {
  if (files.length === 1 && PROJECT_EXT.test(files[0].name)) return openProject(files[0].buffer, files[0].name);
  const t0 = performance.now(), ticket = ++loadTicket;
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
      if (ticket !== loadTicket) return;   // the newer load owns the progress bar
      sources.push({ name, cad, buffer: buf });
      for (const p of parts) addPart(p, name);
      shown++; label = name; progressEnd(name, performance.now() - tf);
    } catch (e) { if (ticket === loadTicket) { progressEnd(); loadFailed(name, e); } return; }
  }
  if (shown) finishLoad(shown === 1 ? label : `${shown} files`, Math.round(performance.now() - t0));
}

/** Open from absolute paths — the macOS shell calls this with what Finder handed it. */
// A load in flight counts as a file on screen, and only the newest load may add parts: at launch a window still
// fetching its restored file took a Finder or Claude open in place, and both loads landed in it (wrong file, wrong tab).
let loadSeq = 0, loading = false;
window.cadgangOpen = async function cadgangOpen(paths, { keep = false } = {}) {
  paths = [].concat(paths);
  // Another file is on screen (or on its way): this one gets its own tab, or its own window in the Mac app (the
  // shell turns window.open into a window). A blocked popup falls back to opening in place.
  if (!keep && (model.children.length || loading) && paths.join('|') !== subject
      && window.open(`${location.pathname}?open=${encodeURIComponent(paths.join('|'))}`)) return;
  const my = ++loadSeq, mine = () => my === loadSeq;
  loading = true;
  try { await openPaths(paths, keep, mine); } finally { if (mine()) loading = false; }
};
async function openPaths(paths, keep, mine) {
  if (paths.length === 1 && PROJECT_EXT.test(paths[0])) {
    const buf = await fetchBuffer(`api/view/file?path=${encodeURIComponent(paths[0])}`);
    return mine() && openProject(buf, paths[0].split('/').pop(), paths[0]);
  }
  const sameFile = paths.join('|') === subject;   // the camera stays only for a reload of the file on screen
  const t0 = performance.now(), ticket = ++loadTicket;
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
      if (!mine()) return;   // a newer open took this window
      const parts = cad ? parseCad(buf) : await parseMesh(name.toLowerCase().split('.').pop(), buf, name);
      if (!mine() || ticket !== loadTicket) return;   // a newer open took this window, or a newer load the progress bar
      sources.push({ name, cad, buffer: buf });
      for (const part of parts) addPart(part, name);
      shown++; label = name; progressEnd(name, performance.now() - tf);
    } catch (e) { if (mine() && ticket === loadTicket) { progressEnd(); loadFailed(name, e); } return; }
  }
  if (shown) { finishLoad(shown === 1 ? label : `${shown} files`, Math.round(performance.now() - t0), keep && sameFile); remember(paths); }
}

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

// RECENT, beside Open: the last ten files (or sets of files) opened by path, newest first, kept in
// this browser. A file dropped in has no path to open again, so it is not listed.
const RECENT_KEY = 'cadgang-recent';
const recentList = () => { try { return JSON.parse(localStorage.getItem(RECENT_KEY)) || []; } catch { return []; } };
function remember(paths) {
  if (follow || !paths.every((p) => p.startsWith('/'))) return;
  const k = paths.join('|');
  const list = [{ paths, at: new Date().toISOString() }, ...recentList().filter((r) => r.paths.join('|') !== k)].slice(0, 10);
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)); } catch {}
}
const recentMenu = $('#recentMenu');
function showRecent() {
  const list = recentList();
  recentMenu.replaceChildren(...(list.length ? list.map((r) => {
    const b = Object.assign(document.createElement('button'), { className: 'ghost recent-item', title: r.paths.join('\n') });
    const name = r.paths.map((p) => p.split('/').pop()).join(' + ');
    const dir = r.paths[0].split('/').slice(0, -1).join('/').replace(/^\/Users\/[^/]+/, '~');
    b.append(Object.assign(document.createElement('span'), { textContent: name }), Object.assign(document.createElement('small'), { textContent: dir }));
    b.addEventListener('click', () => { recentMenu.hidden = true; window.cadgangOpen(r.paths); });
    return b;
  }) : [Object.assign(document.createElement('div'), { className: 'recent-empty', textContent: 'No recent files yet' })]));
  if (list.length) {
    const clear = Object.assign(document.createElement('button'), { className: 'ghost recent-clear', textContent: 'Clear the list' });
    clear.addEventListener('click', () => { try { localStorage.removeItem(RECENT_KEY); } catch {} showRecent(); });
    recentMenu.append(document.createElement('hr'), clear);
  }
}
$('#recentBtn').addEventListener('click', (e) => { e.stopPropagation(); if (recentMenu.hidden) showRecent(); recentMenu.hidden = !recentMenu.hidden; });
document.addEventListener('pointerdown', (e) => { if (!recentMenu.contains(e.target) && e.target !== $('#recentBtn')) recentMenu.hidden = true; });
$('#newBtn').addEventListener('click', () => window.open(location.pathname));
// Drawing: the page registers what is open; Claude collects the spec over MCP and sends it back here to render.
$('#drawBtn').addEventListener('click', async () => {
  if (!model.children.length) return say('open a file first', true);
  const size = bbox.getSize(new THREE.Vector3()).toArray().map((v) => +v.toFixed(2));
  await api('/drawing/request', { method: 'POST', body: { subject, name: $('#fileName').textContent, size, bodies: model.children.map((m) => nameOf(m)), dims: measure.dims.length } }).catch((e) => say(e.message, true));
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
  edges.visible = ui.edges || ui.wire;   // the wireframe is the edges
  if (grid) grid.visible = ui.grid;
  for (const m of model.children) styleMesh(m);
  paintRows();
}
$('#colorBtn').addEventListener('click', () => toggle('color', '#colorBtn'));
$('#rulerBtn').addEventListener('click', () => toggle('ruler', '#rulerBtn'));
function setUnits(u) {
  if (!UNIT_MM[u] || u === ui.units) return;
  ui.units = u; $('#unitsSel').value = u;
  placeGrid();   // inches: ¼" lines, darker every inch; mm: as always
}
$('#unitsSel').addEventListener('change', (e) => { setUnits(e.target.value); commit(); });
ui.scroll = 'trackpad';
$('#scrollSel').addEventListener('change', (e) => {
  ui.scroll = e.target.value;
  try { localStorage.setItem(PREFS_KEY, JSON.stringify({ ...JSON.parse(localStorage.getItem(PREFS_KEY)), scroll: ui.scroll })); } catch {}
});
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
// Measure and the markup tools are one at a time: picking one puts the other down.
function setMeasure(on) {
  const t = on && $('[data-tool].on')?.dataset.tool;
  if (t) markup.setTool(t);   // setTool on the chosen tool toggles it off
  measure.setOn(on);
  $('#measureBtn').classList.toggle('on', on);
}
$('#measureBtn').addEventListener('click', () => setMeasure(!measure.on));
// PEN ▾: colour and thickness in a little menu under the pen; the ▾ wears the colour.
const penColor = () => { const c = $('#penMenu .swatch.on')?.dataset.color; if (c) $('#penMenuBtn').style.setProperty('--pen', c); };
penColor();
$('#penMenuBtn').addEventListener('click', () => { $('#penMenu').hidden = !$('#penMenu').hidden; });
$('#penMenu').addEventListener('click', () => setTimeout(penColor));   // after markup's handler marks the new swatch
document.addEventListener('pointerdown', (e) => { if (!e.target.closest?.('.pen-split')) $('#penMenu').hidden = true; });
document.addEventListener('click', (e) => { if (e.target.closest?.('[data-tool]') && $('[data-tool].on')) setMeasure(false); });   // after markup's own handler

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
  snap: { snapAt: (e) => measure.snapAt(e), showSnap: (e) => measure.showSnap(e), clearSnap: () => measure.clearSnap() },   // the arrow snaps like measure
  planeAt: (ray) => planes.hit(ray),   // marks draw on the visible reference planes too
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
// Claude asks what only the page knows (cadgang_interference): the reply goes back through the server.
function answer({ id, what, args }) {
  let body;
  try {
    if (what !== 'sweep') throw new Error(`Unknown question: ${what}`);
    body = { id, result: { subject, joints: sweep(args) } };
  } catch (e) { body = { id, error: e.message }; }
  fetch('api/view/answer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {});
}
/** Every joint (or `joint`, an id) through its range: what its parts run into. Labels in, so Claude names parts as the user sees them. */
function sweep({ joint = null, steps = 36, gap = 0, tol = checkTol(), free = false } = {}) {   // free: the whole range, past the limits
  const keys = bodyKeys(), meshes = new Map([...keys].map(([m, k]) => [k, m]));
  const size = bbox ? bbox.getSize(new THREE.Vector3()).length() : 100;
  const res = sweepJoints(meshes, free ? joints.map((j) => ({ ...j, min: null, max: null })) : joints, { steps: Math.min(360, Math.max(2, steps)), gap: Math.max(0, gap), tol: Math.max(0, tol), only: joint, size });
  for (const r of res) { r.label = labelOfKey(r.body); for (const c of r.contacts) c.label = labelOfKey(c.body); }
  return res;
}
let snapshotTimer = null;
/** Post what is on screen; coalesced, since a stroke is many change events. */
// ASK CLAUDE: the frame, camera and markups queue on the server for cadgang_feedback, and the
// server types the request into the Claude Code session it can name (Knife Terminal: the one working
// in this file's folder, else the one that last used cadgang). With none, the request goes on the
// clipboard to paste.
async function sendToClaude() {
  if (!subject || !bbox) { say('open a file first', true); return; }
  say('asking Claude…');
  try {
    const body = { png: markup.snapshot(), subject, markups: markup.items, camera: { yaw: orbit.yaw, pitch: orbit.pitch, dist: orbit.dist, target: orbit.target.toArray() } };
    const r = await fetch('api/view/feedback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || r.statusText);
    const open = markup.items.filter((m) => !m.done).length;
    if (j.delivered) { say(`asked Claude in Knife Terminal tab ${j.delivered.tab} · ${open} open markup${open === 1 ? '' : 's'}`); return; }
    let copied = false; try { await navigator.clipboard.writeText(j.prompt); copied = true; } catch {}
    say(copied ? 'no Claude session to ask: the request is copied, paste it into Claude Code (⌘V)' : 'no Claude session to ask: tell Claude to call cadgang_feedback', true);
  } catch (e) { say(`could not ask Claude: ${e.message}`, true); }
}
$('#sendBtn').addEventListener('click', sendToClaude);

function postSnapshot() {
  if (follow || window.cadgangServerless) return;
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
  if (new URLSearchParams(location.search).has('share')) return;   // a shared link is on its own: Vercel and the VPS proxy carry no WebSocket
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${location.pathname.replace(/[^/]*$/, '')}ws`);
  ws.onopen = () => { focus(); announce(); };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'hello' && msg.version) { if (pageVersion && pageVersion !== msg.version) location.reload(); pageVersion = msg.version; }
    if (msg.type === 'snapshot_request') postSnapshot();
    if (msg.type === 'ask' && !follow && msg.subject === subject && model.children.length) answer(msg);
    if (msg.type === 'busy') showBusy(msg.what);
    if (msg.type === 'markup_changed' && msg.subject === subject) loadMarkup();
    if (msg.type === 'parts_changed' && msg.subject === subject && msg.from !== clientId) loadNames();   // Claude (or another window) renamed bodies
    if (msg.type === 'joints_changed' && msg.subject === subject && msg.from !== clientId) loadJoints();   // Claude set or drove a joint
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
  rt.hidden = [...scene.children, ...model.children.flatMap((m) => [m.userData.cap, ...(m.userData.stencil ?? [])])]
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
// WIRE draws a curved surface's outline where it turns away from the eye, as SolidWorks does
// (silhouette.js). A body's candidate edges are found the first time the wireframe shows it; the
// outline is redone only when the eye moves relative to the body (orbit, explode, a turn).
const silEye = new THREE.Vector3(), silDir = new THREE.Vector3(), silInv = new THREE.Matrix4();
function updateSilhouettes() {
  for (const m of model.children) {
    if (!m.isMesh) continue;
    const show = ui.wire && m.visible && !!m.userData.edges;
    let sil = m.userData.sil;
    if (!show) { if (sil?.line) sil.line.visible = false; continue; }
    if (!sil) {
      const found = silhouetteEdges(m.geometry, m.userData.faces?.length ? { faces: m.userData.faces } : { creases: true });
      sil = m.userData.sil = { found, key: '' };
      if (found) {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(found.pos.length), 3).setUsage(THREE.DynamicDrawUsage));
        sil.line = new THREE.LineSegments(g, edgeMaterial);
        sil.line.raycast = () => {};   // never a pick, measure or markup target
        sil.line.frustumCulled = false;   // its points change every view: a bounds check would go stale
        sil.line.renderOrder = 1;
        m.add(sil.line);
      }
    }
    if (!sil.line) continue;
    sil.line.visible = true;
    m.updateMatrixWorld();
    silInv.copy(m.matrixWorld).invert();
    silEye.copy(camera.position).applyMatrix4(silInv);
    if (ui.ortho) silDir.copy(camera.getWorldDirection(new THREE.Vector3())).transformDirection(silInv);
    const key = ui.ortho ? `o${silDir.x.toFixed(5)},${silDir.y.toFixed(5)},${silDir.z.toFixed(5)}` : `p${silEye.x.toFixed(4)},${silEye.y.toFixed(4)},${silEye.z.toFixed(4)}`;
    if (key === sil.key) continue;
    sil.key = key;
    const attr = sil.line.geometry.getAttribute('position');
    const n = silhouetteFor(sil.found, silEye, ui.ortho ? silDir : null, attr.array);
    attr.needsUpdate = true;
    sil.line.geometry.setDrawRange(0, n / 3);
  }
}

// The view cube (lower right): a face, edge or corner turns the view to look from there, over a
// quarter second; the orbit's centre stays where it is. Its button fits the model.
let viewTween = null;
function lookFrom(dir) {
  const { yaw, pitch } = yawPitchOf(THREE, dir);
  // start from the same view in the plain range (the orbit has no pole, so it may be past one)
  const { yaw: y0, pitch: p0 } = yawPitchOf(THREE, offsetOf(THREE, orbit.yaw, orbit.pitch));
  const dy = Math.atan2(Math.sin(yaw - y0), Math.cos(yaw - y0));   // the short way round
  viewTween = { y0, p0, dy, dp: pitch - p0, t0: performance.now() };
}
function stepViewTween() {
  if (!viewTween) return;
  const t = Math.min(1, (performance.now() - viewTween.t0) / 250), k = t * t * (3 - 2 * t);
  orbit.yaw = viewTween.y0 + viewTween.dy * k; orbit.pitch = viewTween.p0 + viewTween.dp * k;
  if (t === 1) { viewTween = null; commit(); }
}
// Reference planes (Front / Top / Right on and off, and your own), next to Section (planes.js).
let pickPlane = null;   // set while a new plane waits for its face
const planes = createPlanes({
  THREE, scene, getSubject: () => subject,
  // the bodies where they are now (dragged, exploded): their own boxes, not their overlays
  getBox: () => { if (!bbox) return null; const b = new THREE.Box3(); for (const m of model.children) { m.updateMatrixWorld(); if (m.geometry.boundingBox) b.union(m.geometry.boundingBox.clone().applyMatrix4(m.matrixWorld)); } return b.isEmpty() ? bbox : b; },
  pickFace: (done) => { pickPlane = done; renderer.domElement.classList.add('picking'); say('click a face for the new plane · Esc cancels'); },
});
const planesRow = Object.assign(document.createElement('div'), { className: 'hud-row' });   // Planes and Add an image, one line under Section
$('#sectAxis').after(planesRow);
planesRow.append(planes.el);
// ADD AN IMAGE, beside the planes: choose a PNG or JPEG, then click a face (drag to size it). It is the markup's IMAGE tool.
const imageBtn = Object.assign(document.createElement('button'), { className: 'ghost add-image', textContent: 'Add an image', title: 'Put a PNG or JPEG on a surface: choose it, then click a face (drag to size it)' });
imageBtn.dataset.tool = 'image';
imageBtn.addEventListener('click', () => markup.setTool('image'));
const imageBox = Object.assign(document.createElement('span'), { className: 'sect' });   // the Planes box's size and line
imageBox.append(imageBtn);
planesRow.append(imageBox);
const viewCube = createViewCube({ THREE, container: viewport, getCamera: () => camera, onView: lookFrom, onFit: () => { fit(); commit(); } });
// Lower right: the view cube, and the section bar under it.
const hudBR = Object.assign(document.createElement('div'), { className: 'hud hud-br' });
viewport.append(hudBR);
hudBR.append(viewCube.el, $('#sectAxis'));

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
  stepViewTween();
  planes.follow();
  applyCamera();
  updateSilhouettes();
  // The ground goes as soon as it would hide the model: seen from under it (camera below it, or an ortho view
  // looking up, whose rays start below it). The grid, and the WebGL render's floor; the Metal render drops its own.
  const above = (z) => (ui.ortho ? camera.getWorldDirection(new THREE.Vector3()).z < 0 : camera.position.z >= z);
  if (grid) grid.visible = ui.grid && above(grid.position.z);
  if (ruler) ruler.visible = ui.ruler && !!grid && above(grid.position.z);
  if (rt.on && !NATIVE && rt.floor && rt.floor.visible !== above(rt.floor.position.z)) { rt.floor.visible = !rt.floor.visible; syncRender(); }
  if (sky.visible) { sky.position.copy(orbit.target); sky.scale.setScalar(orbit.dist * 50); sky.material.uniforms.center.value.copy(orbit.target); }
  if (rt.on && NATIVE) nativeCam(); else if (rt.pt && rt.on) renderSample(); else renderer.render(scene, camera);
  viewCube.hidden = !bbox || ui.flat;
  viewCube.render();
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
// The share icon opens a menu: COPY SCREENSHOT puts a PNG of the view (markups and notes on it) on the
// clipboard, SAVE SCREENSHOT downloads it; SHARE TO WEB deploys a frozen copy of this view (meshes + view state)
// to the user's own Vercel account and copies its link (the first time, it asks for their token);
// SHARE TO IPAD is the old iPad button. A shared link (?share=<id>) opens the whole viewer from that
// view; its visitors orbit, cut, explode and mark up, but cannot open, save or share files.
const shareMenu = $('#shareMenu');
$('#shareBtn').addEventListener('click', (e) => { e.stopPropagation(); shareMenu.hidden = !shareMenu.hidden; $('#vercelForm').hidden = true; });
shareMenu.addEventListener('click', (e) => e.stopPropagation());
document.addEventListener('click', () => { shareMenu.hidden = true; });
const shotBlob = () => fetch(markup.snapshot()).then((r) => r.blob());
const shotName = () => `${String($('#fileName').textContent || 'cadgang').replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_')}.png`;
$('#shareShot').addEventListener('click', () => {
  shareMenu.hidden = true;
  if (!bbox) return say('open a file first', true);
  // the item is made now, with the picture still to come: Safari (and the Mac app) only let the click itself write
  navigator.clipboard.write([new ClipboardItem({ 'image/png': shotBlob() })])
    .then(() => say('screenshot copied: paste it anywhere'), (e) => say(`could not copy the screenshot (${e.message}): use Save screenshot`, true));
});
$('#shareShotSave').addEventListener('click', async () => {
  shareMenu.hidden = true;
  if (!bbox) return say('open a file first', true);
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(await shotBlob()), download: shotName() });
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  say(`saved ${a.download}`);
});
$('#shareWeb').addEventListener('click', async () => {
  if (!sources.length) return say('open a file first', true);
  const has = await api('/share/vercel').then((d) => d.token, () => false);
  if (!has) { $('#vercelForm').hidden = false; return $('#vercelToken').focus(); }
  shareWeb();
});
$('#vercelForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try { await api('/share/vercel', { method: 'PUT', body: { token: $('#vercelToken').value } }); }
  catch (err) { return say(err.message, true); }
  $('#vercelToken').value = ''; $('#vercelForm').hidden = true;
  shareWeb();
});
async function shareWeb() {
  shareMenu.hidden = true;
  progressStart('vercel-share', 'sharing to Vercel…');   // the bar runs on the clock against the last share's time
  const t0 = performance.now();
  try {
    const res = await fetch('api/view/share', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: packBundle({ parts: model.children.length, preview: await previewCard() }) });
    const d = await res.json();
    if (res.status === 401) await api('/share/vercel', { method: 'PUT', body: { token: '' } }).catch(() => {});   // a revoked token asks again next time
    if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
    progressEnd('vercel-share', performance.now() - t0);
    copyText(d.url);
    $('#shareLink').href = $('#shareLink').textContent = d.url;
    $('#shareDialog').showModal();
  } catch (e) { progressEnd(); say(`share failed: ${e.message}`, true); }
}
// The link's preview card picture: the view as it is (markups and notes too), cropped to 1200×630.
async function previewCard() {
  const img = new Image();
  img.src = markup.snapshot();
  await img.decode();
  const c = Object.assign(document.createElement('canvas'), { width: 1200, height: 630 });
  const k = Math.max(c.width / img.width, c.height / img.height);
  c.getContext('2d').drawImage(img, (c.width - img.width * k) / 2, (c.height - img.height * k) / 2, img.width * k, img.height * k);
  return c.toDataURL('image/jpeg', 0.85);
}
function copyText(text) {
  const shell = window.webkit?.messageHandlers?.cadgang;
  if (shell) shell.postMessage({ cmd: 'copy', text });
  else navigator.clipboard.writeText(text).catch(() => {});
}
$('#shareCopy').addEventListener('click', () => { copyText($('#shareLink').href); say('link copied'); });
// A bundle is u32 header length, header JSON, then each source file's bytes: what Share to web uploads
// and what a .cadgang project file holds. The header carries the view state (snap()), camera, theme and
// materials, so unpacking it puts back everything the page was showing.
function packBundle(extra = {}) {
  const head = new TextEncoder().encode(JSON.stringify({
    name: $('#fileName').textContent, files: sources.map((f) => ({ name: f.name, cad: f.cad, bytes: f.buffer.byteLength })),
    state: snap(), camera: { yaw: orbit.yaw, pitch: orbit.pitch, dist: orbit.dist, target: orbit.target.toArray() },
    theme: document.documentElement.dataset.bg, materials: model.children.map(materialOf), ...extra,
  }));
  return new Blob([new Uint8Array(new Uint32Array([head.length]).buffer), head, ...sources.map((f) => f.buffer)]);
}
let fromBundle = false;
async function loadBundle(buf, { markupFromServer = false } = {}) {
  const n = new DataView(buf).getUint32(0, true);
  if (!n || n > buf.byteLength - 4) throw new Error('not a CADgang file');
  const head = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, n)));
  if (!Array.isArray(head.files) || typeof head.state !== 'string') throw new Error('not a CADgang file');
  clearModel();
  let off = 4 + n;
  for (const f of head.files) {
    const part = buf.slice(off, off + f.bytes); off += f.bytes;
    const parts = f.cad ? parseCad(part) : await parseMesh(f.name.toLowerCase().split('.').pop(), part, f.name);
    sources.push({ name: f.name, cad: f.cad, buffer: part });
    for (const p of parts) addPart(p, f.name);
  }
  progressEnd();
  fromBundle = true;
  try { finishLoad(head.name, 0); } finally { fromBundle = false; }
  model.children.forEach((m, i) => head.materials?.[i] && pickMaterial(m, head.materials[i]));
  const st = JSON.parse(head.state);
  if (markupFromServer) {
    const marks = await api(`/markup?subject=${encodeURIComponent(subject)}`).then((d) => d.markups).catch(() => null);
    if (Array.isArray(marks) && (marks.length || window.cadgangServerless)) st.markup = marks;   // on Vercel, erasing every mark sticks too   // later visitors' marks, not just the ones it was shared with
  }
  apply(JSON.stringify(st)); commit();
  if (!markupFromServer) markupChanged(markup.items);
  if (st.joints === undefined) loadJoints();   // a file saved before joints or names existed: what the server kept for it stands
  if (st.names === undefined) loadNames();   // the file's markups replace whatever the server kept for this subject
  applyTheme(head.theme);
  window.cadgangCamera(head.camera);
  return head;
}

// ----------------------------------------------------------------- projects (.cadgang)
// Save writes the bundle: the Mac app asks its Save panel for a path and the server writes it; a plain
// browser downloads it. Open reads it back through the same door as any model (picker, drop, Finder).
let projectPath = '';   // where this window's project was last saved or opened (Mac app / local), so ⌘S saves in place
const projectName = () => ($('#fileName').textContent || 'project').replace(/\.[^.]+$/, '') + '.cadgang';
function saveProject(asNew = false) {
  document.activeElement?.blur?.();   // a field still being typed in commits first (its change event fires on blur)
  if (document.documentElement.classList.contains('shared')) return;   // a shared link has no Save
  if (!sources.length) return say('open a file first', true);
  const shell = window.webkit?.messageHandlers?.cadgang;
  if (shell) {
    if (projectPath && !asNew) return writeProject(projectPath);
    shell.postMessage({ cmd: 'saveProject', name: projectName(), dir: projectPath.replace(/\/[^/]*$/, '') });
  } else {
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(packBundle({ format: 'cadgang', version: 1 })), download: projectName() });
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    say(`saved ${a.download}`);
  }
}
async function writeProject(p) {
  say('saving…');
  try {
    const res = await fetch(`api/view/project?path=${encodeURIComponent(p)}`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: packBundle({ format: 'cadgang', version: 1 }) });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
    projectPath = p;
    say(`saved ${p.split('/').pop()}`);
  } catch (e) { say(`save failed: ${e.message}`, true); }
}
window.cadgangSaveTo = (p) => { if (p) writeProject(p); };   // the shell's Save panel answers here
async function openProject(buffer, name, path = '') {
  say(`loading ${name}…`); progressStart(name);
  try {
    subject = path || `project:${name}`;   // markups come from the file itself
    announce(); renderTabs();
    await loadBundle(buffer);
    projectPath = path;
    if (path && !follow) window.history.replaceState(null, '', `${location.pathname}?open=${encodeURIComponent(path)}`);
    document.title = `${name} · CADgang`;
    say(`opened ${name}`);
  } catch (e) { progressEnd(); loadFailed(name, e); }
}
$('#saveBtn').addEventListener('click', () => saveProject());
window.cadgangSave = saveProject;   // the shell's File menu

// A Vercel share keeps its bundle gzipped in parts (Vercel's 100 MB file limit): share.json says how many.
async function vercelBundle() {
  const { parts } = await fetch('share.json').then((r) => r.json());
  const blobs = await Promise.all(Array.from({ length: parts }, (_, i) => fetchBuffer(`share.${i}.bin`)));
  return new Response(new Blob(blobs).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
}
async function openShare(id) {
  document.documentElement.classList.add('shared');
  say('loading shared view…'); progressStart('share');
  try {
    const buf = window.cadgangServerless ? await vercelBundle() : await fetchBuffer(`api/view/share/${encodeURIComponent(id)}`);
    subject = `share:${id}`;   // markups attach to the link: everyone who opens it sees the same ones
    const head = await loadBundle(buf, { markupFromServer: true });
    document.title = `${head.name} · CADgang`;
  } catch (e) { progressEnd(); loadFailed('shared view', e); }
}
// For headless drives: the scene objects behind the page.
window.__view = { fitNames, selected, selectBodies, bodiesInWindow, model, section, orbit, ui, measure, rt, THREE, planes, get joints() { return joints; }, get poses() { return poses; }, jointLinks, get limitHandles() { return limitHandles; }, addJoint, setJointValue, faceAxis, partAt, faceAt, startPickAxis, applyExplode, get camera() { return camera; },
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
  { label: 'Edges', run: () => toggle('edges', '#edgesBtn'), btn: '#edgesBtn', on: () => ui.edges },
  { key: 'w', label: 'Wireframe', run: () => toggle('wire', '#wireBtn'), btn: '#wireBtn', on: () => ui.wire },
  { key: 'g', label: 'Grid', run: () => toggle('grid', '#gridBtn'), btn: '#gridBtn', on: () => ui.grid },
  { key: 'g', shift: true, label: 'Ruler', run: () => toggle('ruler', '#rulerBtn'), btn: '#rulerBtn', on: () => ui.ruler },
  { key: 'c', label: 'Color parts', run: () => toggle('color', '#colorBtn'), btn: '#colorBtn', on: () => ui.color },
  { key: 'k', label: 'Render (global illumination)', run: () => setRender(!rt.on), btn: '#renderBtn', on: () => rt.on },
  { key: 'o', label: 'Orthographic', run: () => setOrtho(!ui.ortho), btn: '#orthoBtn', on: () => ui.ortho },
  { key: 'l', label: 'Next look', btn: '#look', run: () => { const s = $('#look'); s.selectedIndex = (s.selectedIndex + 1) % s.options.length; s.dispatchEvent(new Event('change', { bubbles: true })); } },
  { key: 'm', label: 'Measure', run: () => setMeasure(!measure.on), btn: '#measureBtn', on: () => measure.on },
  { sep: true },
  ...BODY_CMDS.map((c) => ({ ...c, label: { h: 'Hide selected', t: 'Selected transparent', s: 'Show only selected' }[c.shift ? '' : c.key] ?? c.label })),
  { sep: true },
  { key: 'b', label: 'Flip drawing over', btn: '#sideBtn', run: () => { orbit.pitch = -orbit.pitch; } },
  { key: '[', label: 'Turn left 90°', run: () => { orbit.yaw -= Math.PI / 2; } },
  { key: ']', label: 'Turn right 90°', run: () => { orbit.yaw += Math.PI / 2; } },
  { sep: true },
  ...['x', 'y', 'z'].map((a) => ({ key: a, label: `Section ${a.toUpperCase()}`, btn: `[data-sect="${a}"]`, run: () => setSectionAxis(section.axis === a ? '' : a), on: () => section.axis === a })),
  { key: 'i', label: 'Invert section', btn: '#sectFlip', run: () => { if (section.axis) { section.flip *= -1; updateSection(); } } },
  { sep: true },
  { key: 'j', label: 'New joint', btn: '#newJointBtn', run: () => startPickJoint() },
  { key: 'e', label: 'Joint / explode mode', btn: '[data-mode="joint"]', run: () => setMode(ui.mode === 'joint' ? 'explode' : 'joint'), on: () => ui.mode === 'joint' },
  { key: 'v', label: 'Explode direction of the part under the mouse (or the one selected)', run: () => {
    const m = hovered ?? (selected.size === 1 ? [...selected][0] : null);
    if (m?.isMesh) startPickAxis(m); else say('point at a part, or select one, then press V');
  } },
  { key: '0', label: 'Explode all / none', btn: '#explode', run: () => setExplode(+$('#explode').value ? 0 : 100), on: () => +$('#explode').value > 0 },
  { key: '=', label: 'Explode more', run: () => setExplode(+$('#explode').value + 10) },
  { key: '-', label: 'Explode less', run: () => setExplode(+$('#explode').value - 10) },
  { key: 'ArrowRight', hold: true, label: 'Nudge explode out (hold to scrub)', run: () => scrubExplode(1) },
  { key: 'ArrowLeft', hold: true, label: 'Nudge explode in (hold to scrub)', run: () => scrubExplode(-1) },
  { key: 'h', label: 'Hide selected', run: hideSelected },
  { key: 'h', shift: true, label: 'Show all bodies', run: showAllBodies },
  { key: 'Escape', label: 'Section off', btn: '[data-sect=""]', run: () => { if (pickPlane) { pickPlane = null; renderer.domElement.classList.remove('picking'); say(''); return; } if (pickAxis) { endPickAxis(); return; } if (pickJoint) { endPickJoint(); return; } if (measure.on) { measure.cancel(); setMeasure(false); return; } const t = $('[data-tool].on')?.dataset.tool; if (t) { markup.setTool(t); return; } if (selected.size) { selectBodies([], 'set'); return; } setSectionAxis(''); setMeasure(false); } },
  { sep: true },
  ...['front', 'back', 'top', 'bottom', 'right', 'left', 'iso'].map((n, i) => ({ key: String(i + 1), label: `View ${n}`, run: () => setView(String(i + 1)) })),
  { sep: true },
  // P pen and ⇧P pencil, as in Figma ('pen' is the pencil's stroke kind in saved markups, kept for old files)
  ...[['p', 'path', 'Pen'], ['p', 'pen', 'Pencil', true], ['a', 'arrow', 'Arrow'], ['n', 'note', 'Note'], ['t', 'text', 'Text', true], ['i', 'image', 'Image', true], ['r', 'erase', 'Erase']].map(([key, t, label, shift]) => ({ key, shift, label, btn: `[data-tool="${t}"]`, run: () => { markup.setTool(t); if ($('[data-tool].on')) setMeasure(false); }, on: () => $(`[data-tool="${t}"]`).classList.contains('on') })),
  { key: 'Backspace', label: 'Clear markup', btn: '[data-clear]', run: () => $('[data-clear]').click() },
  { sep: true },
  { key: 'd', label: 'Background: light / dark / dusk / dawn / night', btn: '#themeToggle', run: () => $('#themeToggle').click(), on: () => document.documentElement.dataset.bg !== 'light' },
  { key: 'o', meta: true, label: 'Open…', btn: '#openBtn', run: () => $('#fileInput').click() },
  { key: 'Enter', meta: true, label: 'Ask Claude', btn: '#sendBtn', run: sendToClaude },
  { key: 's', meta: true, label: 'Save project…', btn: '#saveBtn', run: () => saveProject() },
  { key: 's', meta: true, shift: true, label: 'Save project as…', run: () => saveProject(true) },
  { key: 'z', meta: true, label: 'Undo', run: undo },
  { key: 'z', meta: true, shift: true, label: 'Redo', run: redo },
];
const keyLabel = (c) => (c.shift ? '⇧' : '') + (c.meta ? '⌘' : '') + ({ Escape: 'Esc', Backspace: '⌫', Enter: '↵', ArrowLeft: '←', ArrowRight: '→' }[c.key] ?? c.key.toUpperCase());

window.addEventListener('keydown', (e) => {
  const nudge = e.target.id === 'explode' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight');   // the focused slider's own arrows would step it, not scrub
  if ((e.target.matches?.('input,select,textarea') && !nudge && !((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's')) || e.altKey || $('#shareDialog').open) return;   // typing keeps its keys, but ⌘S saves from inside a field
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const c = CMDS.find((c) => c.key === key && !!c.meta === (e.metaKey || e.ctrlKey) && !!c.shift === e.shiftKey);
  if (!c) return;
  e.preventDefault();
  if (c.hold && e.repeat) return;
  hideMenu(); c.run(); commit();
});

// --- undo: a snapshot of the view state after every action; ⌘Z walks back.
// ponytail: whole-state JSON snapshots, not deltas — the state is a few hundred bytes.
const history = { list: [], i: -1 };
function snap() {
  return JSON.stringify({ look: ui.look, edges: ui.edges, wire: ui.wire, grid: ui.grid, ruler: ui.ruler, units: ui.units, color: ui.color, ortho: ui.ortho,
    section: { axis: section.axis, pos: $('#sectPos').value, flip: section.flip }, explode: $('#explode').value, rot: rotArr(),
    bodies: model.children.map((m) => m.visible), ghosts: model.children.map((m) => !!m.userData.ghost), tints: model.children.map((m) => m.userData.tint ?? null), finishes: model.children.map((m) => m.userData.finish ?? null), parts: model.children.map((m) => [m.userData.axis ?? null, m.userData.pull == null ? null : +m.userData.pull.toFixed(3), null, m.userData.exTo?.toArray().map((v) => +v.toFixed(4)) ?? null]),
    markup: markup.items, dims: measure.dims, joints, names: namesOf() });
}
function commit() {
  const s = snap();
  if (s === history.list[history.i]) return;
  rerender();
  history.list.splice(history.i + 1); history.list.push(s); history.i = history.list.length - 1;
  try { localStorage.setItem(PREFS_KEY, JSON.stringify({ look: ui.look, edges: ui.edges, wire: ui.wire, grid: ui.grid, ruler: ui.ruler, units: ui.units, scroll: ui.scroll, color: ui.color, ortho: ui.ortho, mode: ui.mode })); } catch {}
}
// View preferences outlive the page, like the theme. Section, explode and body
// visibility belong to a file and start fresh with it.
const PREFS_KEY = 'cadgang-view';
try {
  const p = JSON.parse(localStorage.getItem(PREFS_KEY));
  if (p?.look in PRESETS) ui.look = document.documentElement.dataset.look = $('#look').value = p.look;
  if (UNIT_MM[p?.units]) { ui.units = $('#unitsSel').value = p.units; }
  if (p?.scroll === 'mouse') ui.scroll = $('#scrollSel').value = 'mouse';
  for (const k of ['edges', 'wire', 'grid', 'ruler', 'color']) if (typeof p?.[k] === 'boolean' && ui[k] !== p[k]) toggle(k, `#${k}Btn`);
  if (p?.ortho) setOrtho(true);
  if (p?.mode === 'joint') setMode('joint');
} catch {}
function apply(s) {
  const st = JSON.parse(s);
  const r = st.rot ?? [0, 0, 0, 1];   // the state's marks, dims and axes are in its own turn: only the geometry follows
  if (bbox && JSON.stringify(r) !== JSON.stringify(rotArr())) bakeRot(new THREE.Quaternion().fromArray(r));
  if (st.look !== ui.look) { ui.look = document.documentElement.dataset.look = $('#look').value = st.look; for (const m of model.children) styleMesh(m); }
  for (const k of ['edges', 'wire', 'grid', 'ruler', 'color']) if (ui[k] !== st[k]) toggle(k, `#${k}Btn`);
  if (ui.ortho !== st.ortho) setOrtho(st.ortho);
  if (st.units && st.units !== ui.units) setUnits(st.units);
  $('#sectPos').value = st.section.pos; section.flip = st.section.flip; setSectionAxis(st.section.axis);
  model.children.forEach((m, i) => { const [axis, pull, , exTo] = st.parts?.[i] ?? []; m.userData.axis = axis || undefined; m.userData.pull = pull ?? undefined; m.userData.exTo = exTo ? new THREE.Vector3(...exTo) : undefined; });
  if (st.names !== undefined && JSON.stringify(st.names) !== JSON.stringify(namesOf())) applyNames(st.names);   // a state from an older file has no names or joints: leave them be
  if (st.joints !== undefined) setJoints(st.joints);
  $('#explode').value = st.explode; applyExplode();
  model.children.forEach((m, i) => {
    setBodyVisible(m, st.bodies[i] ?? true); setBodyGhost(m, !!st.ghosts?.[i]);
    const t = st.tints?.[i] ?? null;
    if (JSON.stringify(m.userData.tint ?? null) !== JSON.stringify(t)) setTint([m], t);
    const fin = st.finishes?.[i] ?? null;
    if ((m.userData.finish ?? null) !== fin) setFinish([m], fin);
  });
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
function jointCmds(m) {
  return [
    { label: 'New joint…', run: startPickJoint },
    ...(jointOf(m) ? [{ label: 'Remove joint', run: () => removeJoint(jointOf(m)) }] : []),
    { sep: true },
  ];
}
function partCmds(m) {
  if (!m) return [];
  const v = explodeVec(m), i = ['x', 'y', 'z'].reduce((b, _, j) => (Math.abs(v.getComponent(j)) > Math.abs(v.getComponent(b)) ? j : b), 0);
  const auto = moves(m, v) ? ` (${v.getComponent(i) < 0 ? '−' : '+'}${'XYZ'[i]})` : '';
  const set = (axis) => { m.userData.axis = axis; if (!axis) m.userData.pull = undefined; applyExplode(); commit(); };
  return [
    { head: nameOf(m) },
    { label: 'Rename…', run: () => startRename(m) },
    ...(window.cadgangServerless ? [] : [{ label: selected.has(m) && selected.size > 1 ? `Send ${selected.size} selected to Bambu Studio` : 'Send to Bambu Studio', run: () => sendToSlicer(selected.has(m) ? [...selected] : [m]) }]),
    ...(ui.mode === 'joint' ? jointCmds(m) : [
    { label: `Explode auto${auto}`, run: () => set(undefined), on: () => !m.userData.axis },
    { key: 'v', label: 'Explode direction: pick a face…', run: () => startPickAxis(m), on: () => !!m.userData.axis },
    { label: 'New joint…', run: startPickJoint },
    { sep: true },
    ]),
  ];
}
// SEND TO BAMBU STUDIO: each part as a binary STL in mm, placed as it sits now (explode, joints, turn), all
// opened in the slicer together so they keep their places on the plate.
function stlOf(m) {
  const g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry, p = g.getAttribute('position'), n = p.count / 3 | 0;
  const dv = new DataView(new ArrayBuffer(84 + 50 * n)), a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), nm = new THREE.Vector3();
  dv.setUint32(80, n, true);
  m.updateWorldMatrix(true, false);
  for (let t = 0, o = 84; t < n; t++, o += 50) {
    a.fromBufferAttribute(p, 3 * t).applyMatrix4(m.matrixWorld); b.fromBufferAttribute(p, 3 * t + 1).applyMatrix4(m.matrixWorld); c.fromBufferAttribute(p, 3 * t + 2).applyMatrix4(m.matrixWorld);
    THREE.Triangle.getNormal(a, b, c, nm);
    [nm, a, b, c].forEach((v, k) => { dv.setFloat32(o + 12 * k, v.x, true); dv.setFloat32(o + 12 * k + 4, v.y, true); dv.setFloat32(o + 12 * k + 8, v.z, true); });
  }
  if (g !== m.geometry) g.dispose();
  return dv.buffer;
}
async function sendToSlicer(bodies) {
  bodies = bodies.filter((m) => m.isMesh && model.children.includes(m));
  if (!bodies.length) return;
  const batch = Date.now().toString(36) + Math.random().toString(36).slice(2, 8), used = new Map();
  try {
    for (const m of bodies) {
      const base = nameOf(m).replace(/\.[^.]+$/, '').replace(/[^\w .-]/g, '_') || 'part', k = used.get(base) ?? 0;
      used.set(base, k + 1);
      await fetchBuffer(`api/view/slicer?batch=${batch}&name=${encodeURIComponent(`${base}${k ? `_${k}` : ''}.stl`)}`, { method: 'PUT', body: stlOf(m) });
    }
    await api('/slicer/open', { method: 'POST', body: { batch } });
    say(`sent ${bodies.length} part${bodies.length > 1 ? 's' : ''} to Bambu Studio`);
  } catch (e) { say(`send to Bambu Studio failed: ${e.message}`, true); }
}
function showMenu(x, y, part) { showItems(x, y, [...partCmds(part), ...CMDS.filter((c) => !(ui.mode === 'joint' && /^Explode/.test(c.label)))]); }
function showItems(x, y, items) {
  menu.replaceChildren(...items.map((c) => {
    if (c.sep) return document.createElement('hr');
    if (c.head) return Object.assign(document.createElement('div'), { className: 'hd', textContent: c.head });
    const b = document.createElement('button');
    b.className = 'ghost' + (c.on?.() ? ' on' : '');
    b.append(Object.assign(document.createElement('span'), { textContent: c.label }), Object.assign(document.createElement('kbd'), { textContent: c.key ? keyLabel(c) : '' }));
    b.addEventListener('click', () => { hideMenu(); c.run(); });
    return b;
  }));
  menu.hidden = false;
  menu.scrollTop = 0;
  menu.style.left = `${Math.max(8, Math.min(x, innerWidth - menu.offsetWidth - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, innerHeight - menu.offsetHeight - 8))}px`;   // never above the window's top: it scrolls instead
}
function hideMenu() { menu.hidden = true; }
document.addEventListener('pointerdown', (e) => { if (!menu.contains(e.target)) hideMenu(); });

// --- hover tips: the element's title, shown at once and with its hotkey
const tip = Object.assign(document.createElement('div'), { id: 'tip', hidden: true });
document.body.appendChild(tip);
for (const c of CMDS) {
  const el = c.btn && $(c.btn);
  if (el) { el.dataset.tip = (el.title || c.label).replace(/\s*\([^)]*\)\s*$/, '') + (c.key ? ` · ${keyLabel(c)}` : ''); el.removeAttribute('title'); }
}
for (const el of [$('#explode'), $('#explodeSect')]) el.dataset.tip = `${el.dataset.tip ?? el.title} · ← → nudge, hold to scrub`, el.removeAttribute('title');
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
