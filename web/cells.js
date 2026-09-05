/**
 * cadgang v2 — the cell transcript.
 *
 * There is no LLM in here and no authoring surface: cells are written by Claude
 * Code over MCP. This page is where a human READS the stack — the prompts in
 * order, the status of each cell against its own prompt — and turns the knobs.
 * That division is the whole point of hoisting `params`: the model writes the
 * structure once, the human drives the numbers forever, and driving a number
 * never re-prompts anything.
 *
 * It is a separate page from the v1 node editor rather than a mode inside it.
 * The two documents share a server and nothing else, and keeping the 2000-line
 * graph editor out of this file is worth a second entry point.
 */

import * as THREE from 'three';
import { sketchCanvas } from './sketchcanvas.js';
import { renderDepGraph } from './depgraph.js';

const $ = (sel) => document.querySelector(sel);
const API = '/api/cells';

// ---------------------------------------------------------------- transport

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

let statusTimer = null;
function say(text, isError = false) {
  const el = $('#status');
  el.textContent = text;
  el.classList.toggle('err', isError);
  clearTimeout(statusTimer);
  if (text && !isError) statusTimer = setTimeout(() => { el.textContent = ''; }, 2600);
}

// ----------------------------------------------------------------- viewport

const viewport = $('#viewport');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
viewport.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 5000);

const key = new THREE.DirectionalLight(0xfffdf8, 2.4);
key.position.set(60, -80, 120);
const fill = new THREE.DirectionalLight(0xf3e9d8, 0.9);
fill.position.set(-90, 50, -30);
const ambient = new THREE.AmbientLight(0xffffff, 1.15);
const hemi = new THREE.HemisphereLight(0xffffff, 0xdedbd4, 0.6);
scene.add(key, fill, ambient, hemi, new THREE.AxesHelper(14));

const material = new THREE.MeshStandardMaterial({
  color: 0xb9b8b3, metalness: 0.25, roughness: 0.5, side: THREE.DoubleSide,
});
const edgeMaterial = new THREE.LineBasicMaterial({ color: 0x2f5d8a, transparent: true, opacity: 0.85 });
let meshObj = null;
let edgeObj = null;
let grid = null;

// Cells are exact B-rep all the way through, so there is always real topology
// to draw — the wireframe here is the true trimmed curves, never a triangle
// overlay pretending to be edges.
function setGeometry(mesh) {
  for (const obj of [meshObj, edgeObj]) {
    if (obj) { scene.remove(obj); obj.geometry.dispose(); }
  }
  meshObj = edgeObj = null;
  if (!mesh?.positions?.length) return;

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(mesh.positions, 3));
  if (mesh.normals?.length) geo.setAttribute('normal', new THREE.Float32BufferAttribute(mesh.normals, 3));
  geo.setIndex(mesh.indices);
  if (!mesh.normals?.length) geo.computeVertexNormals();
  meshObj = new THREE.Mesh(geo, material);
  scene.add(meshObj);

  if (mesh.edges?.lines?.length) {
    const eg = new THREE.BufferGeometry();
    eg.setAttribute('position', new THREE.Float32BufferAttribute(mesh.edges.lines, 3));
    edgeObj = new THREE.LineSegments(eg, edgeMaterial);
    edgeObj.renderOrder = 1;
    scene.add(edgeObj);
  }
}

const orbit = { yaw: -0.6, pitch: 0.5, dist: 160, target: new THREE.Vector3(0, 0, 0) };
function applyCamera() {
  const cp = Math.cos(orbit.pitch), sp = Math.sin(orbit.pitch);
  camera.position.set(
    orbit.target.x + orbit.dist * cp * Math.sin(orbit.yaw),
    orbit.target.y - orbit.dist * cp * Math.cos(orbit.yaw),
    orbit.target.z + orbit.dist * sp
  );
  camera.up.set(0, 0, 1);
  camera.lookAt(orbit.target);
}

/** Frame the part once, on first load — never on a parameter change, or the
 *  camera would lurch every time the user scrubbed a dimension. */
let framed = false;
function frame(bbox) {
  if (framed || !bbox) return;
  const c = [0, 1, 2].map((i) => (bbox.min[i] + bbox.max[i]) / 2);
  orbit.target.set(c[0], c[1], c[2]);
  orbit.dist = Math.max(30, Math.hypot(...bbox.size) * 1.6);
  framed = true;
}

// --------------------------------------------------------------- pick mode

/**
 * Some references genuinely need a human: "fillet *that* edge."
 *
 * A cell declares what it needs and parks. This is the other end of that — the
 * viewport goes into pick mode, the click is turned into a point or a face
 * index, and the server converts it into a query plus an anchor. What the
 * document stores is never the thing that was clicked; it is a description of
 * it that can be re-found after the part changes.
 */
let pick = null;          // { cell, name, type, source }
const raycaster = new THREE.Raycaster();
const DRAG_SLOP = 4;      // px before a press counts as an orbit, not a click

function pointerNDC(e) {
  const rect = renderer.domElement.getBoundingClientRect();
  return new THREE.Vector2(
    ((e.clientX - rect.left) / rect.width) * 2 - 1,
    -((e.clientY - rect.top) / rect.height) * 2 + 1
  );
}

/** Which B-rep face owns triangle `tri`, by binary search over the ranges. */
function faceOfTriangle(faces, tri) {
  let lo = 0, hi = faces.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const f = faces[mid];
    if (tri < f.first) hi = mid - 1;
    else if (tri >= f.first + f.count) lo = mid + 1;
    else return mid;
  }
  return -1;
}

/**
 * Turn a click into a pick request.
 *
 * Faces go by index: the tessellation ships them in enumeration order, so the
 * index means the same thing on both sides, and the revision stamp catches a
 * stale mesh. Edges cannot — OCCT tessellates them in a different order than it
 * enumerates them — so the click's position in space is sent instead and the
 * server matches on that. Sending an edge index would name the wrong edge, and
 * it would do it silently.
 */
async function doPick(e) {
  if (!pick || !meshObj || !lastMesh) return;
  raycaster.setFromCamera(pointerNDC(e), camera);
  const [hit] = raycaster.intersectObject(meshObj, false);
  if (!hit) { say('Click on the part', true); return; }

  const body = pick.type === 'face'
    ? { type: 'face', index: faceOfTriangle(lastMesh.faces || [], hit.faceIndex), revision: lastMesh.revision }
    : { type: 'edge', point: [hit.point.x, hit.point.y, hit.point.z] };

  if (pick.type === 'face' && body.index < 0) { say('That triangle has no B-rep face', true); return; }

  try {
    await api(`/${encodeURIComponent(pick.cell)}/selections/${encodeURIComponent(pick.name)}`,
      { method: 'POST', body });
    say(`picked ${pick.type} for ${pick.cell}.${pick.name}`);
    pick = null;
    await refresh();
  } catch (err) {
    say(err.message, true);
  }
}

function setPick(next) {
  pick = next;
  viewport.classList.toggle('picking', Boolean(next));
  renderPending();
}

let drag = null;
viewport.addEventListener('contextmenu', (e) => e.preventDefault());
viewport.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 && e.button !== 2) return;
  if (e.target.closest('button')) return;
  viewport.setPointerCapture?.(e.pointerId);
  drag = { x: e.clientX, y: e.clientY, pan: e.button === 2 || e.shiftKey, downX: e.clientX, downY: e.clientY, click: e.button === 0 };
});
window.addEventListener('pointerup', (e) => {
  // A press that barely moved is a click, not an orbit — so picking never
  // fights with looking at the thing you are about to pick on.
  if (drag?.click && pick && Math.hypot(e.clientX - drag.downX, e.clientY - drag.downY) < DRAG_SLOP) {
    doPick(e);
  }
  drag = null;
});
window.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  drag.x = e.clientX; drag.y = e.clientY;
  if (drag.pan) {
    const scale = orbit.dist * 0.0016;
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 1);
    orbit.target.addScaledVector(right, -dx * scale);
    orbit.target.addScaledVector(up, dy * scale);
  } else {
    orbit.yaw -= dx * 0.006;
    orbit.pitch = Math.max(-1.45, Math.min(1.45, orbit.pitch + dy * 0.006));
  }
});
viewport.addEventListener('wheel', (e) => {
  e.preventDefault();
  orbit.dist = Math.max(2, Math.min(3000, orbit.dist * (1 + Math.sign(e.deltaY) * 0.1)));
}, { passive: false });

function resize() {
  for (const canvas of sketches.values()) canvas.redraw();
  const w = viewport.clientWidth, h = viewport.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);

(function loop() {
  requestAnimationFrame(loop);
  applyCamera();
  renderer.render(scene, camera);
})();

// -------------------------------------------------------------------- theme

let theme = localStorage.getItem('cadgang-theme') || 'light';
function applyTheme() {
  document.documentElement.dataset.theme = theme;
  $('#themeToggle').textContent = theme === 'dark' ? 'LIGHT' : 'DARK';
  const dark = theme === 'dark';
  scene.background = new THREE.Color(dark ? 0x1a1a18 : 0xf6f5f2);
  if (grid) { scene.remove(grid); grid.geometry.dispose(); grid.material.dispose(); }
  grid = new THREE.GridHelper(200, 20,
    dark ? 0x2c2b28 : 0xd8d7d3, dark ? 0x242320 : 0xe9e8e4);
  grid.rotation.x = Math.PI / 2; // cadgang is Z-up
  scene.add(grid);
  for (const canvas of sketches.values()) canvas.redraw();
  key.intensity = dark ? 2.0 : 2.4;
  fill.intensity = dark ? 0.75 : 0.9;
  ambient.intensity = dark ? 0.5 : 1.15;
  hemi.intensity = dark ? 0.4 : 0.6;
}
$('#themeToggle').onclick = () => {
  theme = theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem('cadgang-theme', theme);
  applyTheme();
};

// ------------------------------------------------------------------- layout

let dragBar = false;
$('#dragbar').addEventListener('pointerdown', (e) => {
  dragBar = true;
  $('#dragbar').setPointerCapture?.(e.pointerId);
});
window.addEventListener('pointerup', () => { if (dragBar) { dragBar = false; resize(); } });
window.addEventListener('pointermove', (e) => {
  if (!dragBar) return;
  const w = Math.max(300, Math.min(window.innerWidth * 0.7, e.clientX));
  $('#panel').style.flexBasis = `${w}px`;
  resize();
});

// --------------------------------------------------------------- the stack

let doc = { cells: [] };
let report = new Map();   // cell id -> evaluation entry
let structureSig = null;
let lastMesh = null;      // the mesh currently in the viewport, for raycasting
let pendingPicks = [];    // picks waiting on a human
const sketches = new Map(); // cell id -> its mounted sketch canvas
const sketchUi = new Map(); // cell id -> the drawing state that outlives a mount

const badge = (status) => `<span class="badge ${status}">${status.replace('_', ' ')}</span>`;

/**
 * What a cell's badge says.
 *
 * The document's own status is about the cell's prompt and code; the
 * evaluation's is about what happened when it ran. When they disagree the run
 * wins, or an assertion cell whose claim just missed would sit there reading
 * 'ok'.
 */
function shownStatus(cell, entry) {
  if (entry?.status === 'error' || entry?.status === 'failed') return entry.status;
  return cell?.status ?? 'ok';
}
const fmt = (n) => (Math.abs(n) >= 1000 ? n.toFixed(0) : parseFloat(n.toPrecision(6)).toString());

/**
 * Rebuild the transcript.
 *
 * Only called when the STRUCTURE changed — ids, prompts, code, refs. A
 * parameter change updates values in place instead, because rebuilding the DOM
 * mid-scrub would yank focus out of the field being dragged.
 */
function renderStack() {
  const stack = $('#stack');
  sketches.clear();
  $('#stackCount').textContent = doc.cells.length
    ? `${doc.cells.length} cell${doc.cells.length === 1 ? '' : 's'}`
    : '';

  if (!doc.cells.length) {
    stack.innerHTML = `<div class="empty">
      No cells yet.<br /><br />
      Cells are authored from Claude Code over MCP — ask it to model something and
      it will call <code>cadgang_cells_add</code>. This page is the transcript:
      prompts, parameters, and status.
    </div>`;
    return;
  }

  stack.innerHTML = '';
  doc.cells.forEach((cell, i) => {
    const entry = report.get(cell.id);
    const status = shownStatus(cell, entry);
    const el = document.createElement('div');
    const asserting = cell.kind === 'assert';
    el.className = `cell${asserting ? ' assert' : ''}` +
      `${status === 'error' ? ' failed' : ''}${status === 'failed' ? ' missed' : ''}`;
    el.dataset.id = cell.id;

    const refs = cell.refs?.length
      ? `← ${cell.refs.join(', ')}`
      : (i > 0 ? `← ${doc.cells[i - 1].id}` : '');

    el.innerHTML = `
      <div class="cell-head">
        <span class="cell-index">${asserting ? '✓' : i + 1}</span>
        <span class="cell-id" title="Make this the output">${cell.id}</span>
        ${badge(status)}
        <span class="cell-refs">${refs}</span>
        <span class="cell-ms">${entry?.ms ? `${entry.ms}ms` : ''}</span>
        <button class="cell-del ghost" title="Delete this cell (Undo brings it back)">×</button>
      </div>
      <textarea class="cell-prompt" rows="2" placeholder="no prompt">${escapeHtml(cell.prompt || '')}</textarea>
      ${hasSketch(cell) ? '<div class="sketch-wrap"><div class="sketch-tools"></div><canvas class="sketch-canvas"></canvas><div class="sketch-note"></div></div>' : ''}
      <div class="checks"></div>
      <div class="params"></div>
      ${cell.code ? '<button class="cell-toggle">Show code</button><pre class="cell-code" hidden></pre>' : ''}
      <div class="cell-meta"></div>
    `;

    // Params: the human's half of the document.
    const params = el.querySelector('.params');
    for (const [name, value] of Object.entries(cell.params || {})) {
      params.append(paramRow(cell.id, name, value));
    }

    el.querySelector('.cell-del').onclick = async () => {
      try {
        await api(`/${cell.id}`, { method: 'DELETE' });
        await refresh();
      } catch (e) { say(e.message, true); }
    };

    const prompt = el.querySelector('.cell-prompt');
    // Grow to the text. A prompt is a sentence, not a form field, and a stack of
    // half-empty boxes stops the transcript reading like a document.
    const autosize = () => {
      prompt.style.height = 'auto';
      prompt.style.height = `${prompt.scrollHeight}px`;
    };
    prompt.addEventListener('input', autosize);
    requestAnimationFrame(autosize);
    prompt.addEventListener('blur', async () => {
      const next = prompt.value.trim();
      if (next === (cell.prompt || '')) return;
      try {
        await api(`/${encodeURIComponent(cell.id)}`, { method: 'PATCH', body: { prompt: next } });
        say(`'${cell.id}' is stale — recompile it from Claude Code`);
        await refresh();
      } catch (e) { say(e.message, true); }
    });

    const toggle = el.querySelector('.cell-toggle');
    if (toggle) {
      const pre = el.querySelector('.cell-code');
      pre.textContent = cell.code;
      toggle.onclick = () => {
        pre.hidden = !pre.hidden;
        toggle.textContent = pre.hidden ? 'Show code' : 'Hide code';
      };
    }

    // A sketch cell gets its profile inline, under its own prompt. This is the
    // authoring the rest of the page does not do: the constraints are the
    // model's, but the shape of the profile and where its corners sit are the
    // human's, drawn here rather than described to Claude.
    const canvas = el.querySelector('.sketch-canvas');
    if (canvas) {
      const at = (suffix) => `/${encodeURIComponent(cell.id)}${suffix}`;
      // Drawing and erasing persist server-side, so the document is refreshed
      // after them rather than saved — one gesture, one write, one undo step.
      const persisted = async (body, route) => {
        const result = await api(at(route), { method: 'POST', body });
        await refresh({ structural: false });
        return result;
      };
      // Which tool is up, and the corner a chained line is waiting on, belong to
      // the page rather than to the canvas: any document change re-renders this
      // whole stack, and a half-drawn profile must not be a casualty of Claude
      // editing the cell above it.
      if (!sketchUi.has(cell.id)) sketchUi.set(cell.id, {});
      sketches.set(cell.id, sketchCanvas({
        sketch: cell.sketch || emptySketch(),
        canvas,
        note: el.querySelector('.sketch-note'),
        tools: el.querySelector('.sketch-tools'),
        ui: sketchUi.get(cell.id),
        solve: (body) => api(at('/sketch/solve'), { method: 'POST', body }),
        save: async (sketch) => {
          await api(at(''), { method: 'PATCH', body: { sketch } });
          await refresh({ structural: false });
        },
        draw: (body) => persisted(body, '/sketch/draw'),
        erase: (body) => persisted(body, '/sketch/erase'),
        dimension: (body) => persisted(body, '/sketch/dimension'),
      }));
    }

    el.querySelector('.cell-id').onclick = async () => {
      try {
        await api('/document/output', { method: 'POST', body: { cell: cell.id } });
        framed = false;
        await refresh();
      } catch (e) { say(e.message, true); }
    };

    stack.append(el);
  });
  paintReport();
}

/** One parameter: a scrubbable name and an exact number field. */
function paramRow(cellId, name, value) {
  const frag = document.createDocumentFragment();
  const label = document.createElement('span');
  label.className = 'param-name';
  label.textContent = name;
  const input = document.createElement('input');
  input.className = 'param-input';
  input.dataset.cell = cellId;
  input.dataset.param = name;
  input.value = value;

  const numeric = typeof value === 'number';
  if (numeric) {
    // Drag the NAME to scrub. A slider would need a min and a max the program
    // never declares; a drag needs neither and stays exact at any magnitude.
    let scrub = null;
    label.addEventListener('pointerdown', (e) => {
      scrub = { x: e.clientX, start: parseFloat(input.value) || 0 };
      label.setPointerCapture?.(e.pointerId);
      e.preventDefault();
    });
    label.addEventListener('pointermove', (e) => {
      if (!scrub) return;
      const step = e.shiftKey ? 0.01 : e.altKey ? 10 : 0.1;
      const next = Math.round((scrub.start + (e.clientX - scrub.x) * step) * 1000) / 1000;
      input.value = next;
      push(cellId, name, next);
    });
    label.addEventListener('pointerup', () => { scrub = null; });
  } else {
    label.style.cursor = 'default';
  }

  input.addEventListener('change', () => {
    const next = numeric ? parseFloat(input.value) : input.value;
    if (numeric && !Number.isFinite(next)) { input.value = value; return; }
    push(cellId, name, next);
  });

  frag.append(label, input);
  return frag;
}

/**
 * Send a parameter change.
 *
 * Coalesced: a scrub fires on every pointermove, and the server would happily
 * re-run the whole stack for each one. Only the latest value per parameter is
 * ever in flight, and a new value queued during a request supersedes it.
 */
const pending = new Map();
let inFlight = false;
function push(cellId, name, value) {
  pending.set(`${cellId}\u0000${name}`, { cellId, name, value });
  drain();
}
async function drain() {
  if (inFlight || !pending.size) return;
  inFlight = true;
  const batch = new Map();
  for (const { cellId, name, value } of pending.values()) {
    if (!batch.has(cellId)) batch.set(cellId, {});
    batch.get(cellId)[name] = value;
  }
  pending.clear();
  try {
    for (const [cellId, params] of batch) {
      await api(`/${encodeURIComponent(cellId)}`, { method: 'PATCH', body: { params } });
    }
    await refresh({ structural: false });
  } catch (e) {
    say(e.message, true);
  } finally {
    inFlight = false;
    if (pending.size) drain();
  }
}

/** Paint evaluation results onto the already-rendered cells. */
function paintReport() {
  for (const el of document.querySelectorAll('.cell')) {
    const cell = doc.cells.find((c) => c.id === el.dataset.id);
    const entry = report.get(el.dataset.id);
    const status = shownStatus(cell, entry);

    const b = el.querySelector('.badge');
    if (b) { b.className = `badge ${status}`; b.textContent = status.replace('_', ' '); }
    el.classList.toggle('failed', status === 'error');
    el.classList.toggle('missed', status === 'failed');
    el.querySelector('.cell-ms').textContent = entry?.ms ? `${entry.ms}ms` : '';

    // Every claim the cell made, with the number behind it. A passing check
    // that showed nothing would be indistinguishable from a check nobody wrote,
    // which is the whole reason the measurement is recorded rather than a tick.
    const slot = el.querySelector('.checks');
    if (slot) {
      slot.innerHTML = '';
      for (const c of entry?.checks || []) {
        const row = document.createElement('div');
        row.className = `check${c.ok ? '' : ' bad'}`;
        const shown = Array.isArray(c.value) ? c.value.map(fmt).join(' × ') :
          typeof c.value === 'number' ? fmt(c.value) : c.value ?? '';
        const limit = Array.isArray(c.limit) ? c.limit.join(' × ') : c.limit;
        row.innerHTML = `<span class="check-mark">${c.ok ? '✓' : '✕'}</span>
          <span class="check-label">${escapeHtml(c.label)}</span>
          <span class="check-value">${escapeHtml(String(shown))}${c.unit ? ` ${c.unit}` : ''}</span>
          ${limit == null ? '' : `<span class="check-limit">vs ${escapeHtml(String(limit))}</span>`}`;
        slot.append(row);
      }
    }

    el.querySelectorAll('.cell-error, .cell-log').forEach((n) => n.remove());
    if (entry?.error) {
      const err = document.createElement('div');
      err.className = 'cell-error';
      err.textContent = entry.error;
      el.append(err);
    }
    for (const line of entry?.logs || []) {
      const log = document.createElement('div');
      log.className = 'cell-log';
      log.textContent = `${line.level}: ${line.text}`;
      el.append(log);
    }

    const meta = el.querySelector('.cell-meta');
    if (meta && cell) {
      meta.textContent = cell.compiledAt
        ? `compiled ${new Date(cell.compiledAt).toLocaleString()}${cell.compiledBy ? ` · ${cell.compiledBy}` : ''}`
        : '';
    }
  }
}

/**
 * The pick prompt over the viewport.
 *
 * A parked cell is not an error and should not read like one — it is the model
 * asking a question only the person looking at the part can answer. So it gets
 * a prompt at the point of action rather than a red badge in the margin.
 */
function renderPending() {
  const bar = $('#pickBar');
  if (pick) {
    bar.hidden = false;
    bar.innerHTML = `<span>Click the <b>${pick.type}</b> for
      <b>${pick.cell}.${pick.name}</b> — showing <b>${pick.source}</b></span>
      <button class="ghost" id="pickCancel">Cancel</button>`;
    $('#pickCancel').onclick = () => { setPick(null); refresh(); };
    return;
  }
  if (!pendingPicks.length) { bar.hidden = true; bar.innerHTML = ''; return; }
  bar.hidden = false;
  bar.innerHTML = `<span>${pendingPicks.length} pick${pendingPicks.length === 1 ? '' : 's'} needed</span>`;
  for (const p of pendingPicks) {
    const btn = document.createElement('button');
    btn.className = 'ghost';
    btn.textContent = p.reason ? `${p.cell}.${p.name} — ${p.reason}` : `Pick ${p.name} (${p.type})`;
    btn.disabled = Boolean(p.reason);
    btn.onclick = () => { setPick(p); refresh(); };
    bar.append(btn);
  }
}

function escapeHtml(s) {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

/**
 * Whether this cell gets a canvas.
 *
 * A stored sketch obviously earns one. So does a program that READS one:
 * `sk.saved()` is a cell saying its profile is the human's to draw, and it has
 * to be drawable before anything has been drawn or the first line would have
 * nowhere to go. Nothing else about the code is inspected here — this is the
 * one thing a cell can say about itself that the UI needs to know.
 */
function hasSketch(cell) {
  return Boolean(cell.sketch) || /\bsk\s*\.\s*saved\s*\(/.test(cell.code || '');
}

/** A sketch with nothing in it yet — where drawing on an empty cell starts. */
const emptySketch = () => ({ plane: 'XY', points: [], entities: [], constraints: [] });

// -------------------------------------------------------------- graph view

/**
 * The derived DAG, shown on demand.
 *
 * Hidden by default and remembered per browser: the stack IS the document, and
 * for the straight-line case the graph says nothing the list does not. It earns
 * its place the moment a cell reaches back past its neighbour.
 */
let graphOpen = localStorage.getItem('cadgang-cells-graph') === '1';

async function renderGraph() {
  const panel = $('#graphPanel');
  panel.hidden = !graphOpen;
  $('#graphToggle').classList.toggle('on', graphOpen);
  if (!graphOpen || !doc.cells.length) return;
  try {
    const graph = await api('/graph');
    renderDepGraph(panel, {
      graph,
      status: new Map(doc.cells.map((c) => [c.id, shownStatus(c, report.get(c.id))])),
      onSelect: (id) => {
        const el = document.querySelector(`.cell[data-id="${id}"]`);
        el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el?.classList.add('flash');
        setTimeout(() => el?.classList.remove('flash'), 900);
      },
    });
  } catch (e) {
    panel.innerHTML = '';
  }
}

$('#graphToggle').onclick = () => {
  graphOpen = !graphOpen;
  localStorage.setItem('cadgang-cells-graph', graphOpen ? '1' : '0');
  renderGraph();
};

// ------------------------------------------------------------------ refresh

/**
 * Pull the document, evaluate it, and pull the mesh.
 *
 * `stopOnError: 0` so one broken cell does not hide the state of every other
 * one — the transcript should show the whole stack's health at once, which is
 * exactly what the authoring loop wants to look at after an edit.
 */
async function refresh({ structural = true } = {}) {
  try {
    doc = await api('/document');
  } catch (e) {
    say(e.message, true);
    return;
  }

  const sig = JSON.stringify(doc.cells.map((c) => [c.id, c.prompt, c.code, c.refs, c.status, Object.keys(c.params || {})]));
  const changed = sig !== structureSig;
  structureSig = sig;

  let evaluation = null;
  if (doc.cells.length) {
    try {
      evaluation = await api('/evaluate?stopOnError=0');
      report = new Map(evaluation.cells.map((c) => [c.id, c]));
    } catch (e) {
      report = new Map();
      say(e.message, true);
    }
  } else {
    report = new Map();
  }

  try {
    pendingPicks = (await api('/pending')).pending;
    // A pick that got answered elsewhere (by Claude, or in another tab) should
    // drop this window out of pick mode rather than leave it waiting.
    if (pick && !pendingPicks.some((p) => p.cell === pick.cell && p.name === pick.name)) pick = null;
  } catch {
    pendingPicks = [];
  }
  renderPending();

  if (changed || structural) renderStack();
  else {
    paintReport();
    // Values the server settled on (a clamp, a coerced type) win over what the
    // field currently shows — unless the user is typing in it.
    for (const input of document.querySelectorAll('.param-input')) {
      if (input === document.activeElement) continue;
      const cell = doc.cells.find((c) => c.id === input.dataset.cell);
      const value = cell?.params?.[input.dataset.param];
      if (value !== undefined && String(value) !== input.value) input.value = value;
    }
    // A sketch dimension can read a parameter, so turning a knob moves the
    // profile too. Re-solve it here rather than waiting for the next structural
    // rebuild, or the canvas would disagree with the solid above it.
    for (const [id, canvas] of sketches) {
      canvas.refresh(doc.cells.find((c) => c.id === id)?.sketch);
    }
  }

  await renderGraph();

  // A failed assertion is a property of the DOCUMENT, so it is said once at the
  // top of the stack rather than only inside the cell that noticed.
  const warn = $('#docWarn');
  const failing = (evaluation?.assertions || []).filter((c) => !c.ok);
  warn.hidden = !failing.length;
  warn.textContent = failing.length
    ? `${failing.length} assertion${failing.length === 1 ? '' : 's'} failing — exports refused`
    : '';

  const m = evaluation?.measures;
  $('#measures').textContent = m
    ? `vol ${fmt(m.volume)} mm³ · area ${fmt(m.area)} mm² · bbox ${m.bbox.size.map(fmt).join(' × ')} mm`
    : '';

  if (!doc.cells.length) { setGeometry(null); $('#stats').textContent = ''; return; }

  try {
    // In pick mode the viewport must show the shape being picked ON — the
    // cell's input — not the document's output, which cannot even build until
    // the pick is made.
    const mesh = await api(pick ? `/mesh?cell=${encodeURIComponent(pick.source)}` : '/mesh');
    lastMesh = mesh;
    setGeometry(mesh);
    frame(m?.bbox);
    // When the newest cell is broken the server falls back to the deepest one
    // that built. Say so — a viewport quietly showing an older state is worse
    // than one showing nothing.
    const showing = mesh.partial ? ` · showing ${mesh.cell}` : '';
    $('#stats').textContent =
      `${mesh.indices.length / 3} tris · ${mesh.faces?.length ?? 0} faces · exact${showing}`;
  } catch (e) {
    lastMesh = null;
    setGeometry(null);
    $('#stats').textContent = 'no geometry';
  }
}

// -------------------------------------------------------------- undo / redo

async function history(which) {
  try {
    await api(`/${which}`, { method: 'POST' });
    await refresh();
  } catch (e) { say(e.message, true); }
}
$('#undoBtn').onclick = () => history('undo');
$('#redoBtn').onclick = () => history('redo');
window.addEventListener('keydown', (e) => {
  if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z') return;
  if (document.activeElement?.matches('input, textarea')) return;
  e.preventDefault();
  history(e.shiftKey ? 'redo' : 'undo');
});

// ----------------------------------------------------------------- export

/**
 * STEP is the only export. A refusal (a failing assertion) comes back as JSON
 * with the reason, which is worth more in the status line than a broken download.
 */
$('#stepBtn').onclick = async () => {
  say('Exporting STEP…');
  try {
    const res = await fetch(`${API}/export/step`);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    const blob = await res.blob();
    const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '')?.[1] || 'model.step';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    say(`Saved ${name}`);
  } catch (e) { say(e.message, true); }
};

// ------------------------------------------------------------------- live

function connect() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    // Only cell traffic matters here; the v1 graph shares the socket.
    if (msg.type === 'cells_changed' && msg.revision !== doc.revision) refresh();
  };
  // Claude Code authoring in the background is the normal case, so a dropped
  // socket must not leave the transcript silently stale.
  ws.onclose = () => setTimeout(connect, 1500);
}

// -------------------------------------------------------------------- boot

applyTheme();
resize();
fetch('/api/health')
  .then((r) => r.json())
  .then((h) => { $('#version').textContent = `v${h.version}`; })
  .catch(() => {});
await refresh();
connect();
