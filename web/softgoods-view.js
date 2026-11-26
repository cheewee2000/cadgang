// The softgoods review in 3D: the draped pieces as lit cloth, the avatar as a neutral body, each seam drawn on the cloth
// and a thread across every seam pair that has not closed yet. The solver (web/softgoods-worker.js) owns the positions;
// this only draws them. z is up, the body faces -y, units are mm.
import * as THREE from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { attachOrbitInput } from './orbitinput.js';

// ---- colours, shared with the page's schedules, its legend and its painter's view (all sRGB, 0..1)

const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const unit = (v) => Math.max(0, Math.min(1, Number(v) || 0));
const NEUTRAL = [0.93, 0.93, 0.91], YELLOW = [1, 0.82, 0.24], RED = [0.86, 0.1, 0.08], BLUE = [0.14, 0.38, 1];
const warm = (t) => (t < 0.5 ? mix(NEUTRAL, YELLOW, t * 2) : mix(YELLOW, RED, t * 2 - 1));
/** Strain as a colour: cloth at rest is neutral, compression runs to blue at -10 %, tension through yellow to red at +20 %. */
export const strainRGB = (v) => (v < 0 ? mix(NEUTRAL, BLUE, unit(-v / 0.1)) : warm(unit(v / 0.2)));
/** Contact pressure as a colour: none is neutral, the frame's highest is red. */
export const pressureRGB = (v, max) => warm(unit(v / (max > 0 ? max : 1)));
export const css = (c) => `rgb(${c.map((v) => Math.round(v * 255)).join(',')})`;
/** A hue that stays with a material's name from one session to the next. */
export function materialHue(name) { let h = 2166136261; for (const ch of String(name)) h = Math.imul(h ^ ch.codePointAt(0), 16777619); return (h >>> 0) % 360; }
/** A piece is drawn in its material's own colour when the material carries one. Otherwise the document's materials take hues a
 *  golden angle apart, in the order they are listed, so no two are alike; a name the document does not list falls back on its own hue. */
export function materialCss(materials, name) {
  const own = materials?.[name]?.color, i = Object.keys(materials || {}).indexOf(name);
  return typeof own === 'string' && own ? own : `hsl(${(i < 0 ? materialHue(name) : (205 + i * 137.508) % 360).toFixed(1)},34%,74%)`;
}
/** Seams are told apart by colour, in schedule order: the seam line, its thread and its row in the schedule share it. */
export const seamCss = (i) => `hsl(${((Math.max(0, i) * 137.508 + 12) % 360).toFixed(1)},85%,45%)`;

// ---- the view

const MAX_PITCH = Math.PI / 2 - 0.002;
const VIEWS = { front: [0, 0], back: [Math.PI, 0], left: [-Math.PI / 2, 0], right: [Math.PI / 2, 0], top: [0, MAX_PITCH] };
// The body is drawn this much smaller than the solver's: cloth resting on it is flat between vertices and a curved body would show through.
// ponytail: a fixed 3 mm suits a mesh near 30 mm on this avatar; scale it with the mesh size if a coarser preview shows the body.
const SKIN = 3;
// A seam pair this close has closed: no thread is drawn for it.
const CLOSED = 2;

/** Build the view inside `host`. Throws where WebGL is not available, and the page then keeps its painter's view.
 *  scheme() is the viewer's Trackpad / Mouse choice, onSelect(id) a piece clicked, seamColour(id) the seam's CSS colour. */
export function createClothView({ host, scheme = () => 'trackpad', onSelect = () => {}, seamColour = () => seamCss(0) }) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2)); renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const el = renderer.domElement; host.appendChild(el);
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(30, 1, 1, 1e5), orbit = { yaw: -0.45, pitch: 0.18, dist: 3000, target: new THREE.Vector3(0, 0, 900) };
  camera.up.set(0, 0, 1); scene.add(camera);

  // Soft light: sky and ground fill everything, a high sun gives the shadow on the floor and under folds, and a lamp
  // over the viewer's shoulder rakes across the cloth so folds read from every side.
  const sky = new THREE.HemisphereLight(0xffffff, 0xc9c5bc, 1.0), sun = new THREE.DirectionalLight(0xffffff, 1.5), lamp = new THREE.DirectionalLight(0xffffff, 1.5);
  sky.position.set(0, 0, 1); sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048); sun.shadow.normalBias = 4; sun.shadow.bias = -0.0004;
  lamp.position.set(-1.1, 0.7, 0); lamp.target.position.set(0, 0, -1); camera.add(lamp, lamp.target); scene.add(sky, sun, sun.target);

  const clothMat = new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.85, metalness: 0, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
  const wireMat = new THREE.MeshBasicMaterial({ color: 0x000000, wireframe: true, transparent: true, opacity: 0.3 });
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0xd2d0cb, roughness: 1, metalness: 0 });
  const cloth = new THREE.Group(), body = new THREE.Group(), ball = new THREE.SphereGeometry(1, 48, 32), UP = new THREE.Vector3(0, 1, 0);
  const ground = new THREE.Mesh(new THREE.CircleGeometry(1, 96), new THREE.ShadowMaterial({ opacity: 0.18 })); ground.receiveShadow = true;
  ground.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(Array.from({ length: 96 }, (_, i) => new THREE.Vector3(Math.cos(i / 48 * Math.PI), Math.sin(i / 48 * Math.PI), 0))), new THREE.LineBasicMaterial({ color: 0xc4c4c4 })));
  scene.add(ground, body, cloth);

  // Lines a few pixels wide whose ends follow the cloth. size() allocates, once per mesh or selection; a frame only writes into what is there.
  const tint = new THREE.Color(), linear = (style) => { tint.setStyle(style); return [tint.r, tint.g, tint.b]; };
  function lineSet(linewidth) {
    const obj = new LineSegments2(new LineSegmentsGeometry(), new LineMaterial({ linewidth, vertexColors: true })); obj.frustumCulled = false; obj.visible = false; obj.renderOrder = scene.children.length; scene.add(obj);
    const set = { pos: null, col: null,
      size(n) { obj.geometry.dispose(); obj.geometry = new LineSegmentsGeometry(); obj.visible = false; if (!n) { set.pos = set.col = null; return; } set.pos = new Float32Array(n * 6); set.col = new Float32Array(n * 6); obj.geometry.setPositions(set.pos); obj.geometry.setColors(set.col); },
      show(n) { obj.visible = n > 0 && !!set.pos; if (!set.pos) return; obj.geometry.instanceCount = n; obj.geometry.attributes.instanceStart.data.needsUpdate = true; obj.geometry.attributes.instanceColorStart.data.needsUpdate = true; } };
    return set;
  }
  const outline = lineSet(4), seamLines = lineSet(2.5), threadLines = lineSet(1.25);   // in this order: a seam shows inside the selected piece's edge

  let input = null, stale = true, pieces = [], total = 0, last = null, fitted = false, wire = false, coloured = '', outlined, dirty = true, radius = 1000;
  let seamIdx = [], threads = [], outlineIdx = [];

  function setBody(shapes) {
    for (const m of body.children) if (m.geometry !== ball) m.geometry.dispose();
    body.clear();
    for (const s of shapes || []) {
      let m = null;
      if (s.type === 'ellipsoid' && s.c && s.r) { m = new THREE.Mesh(ball, bodyMat); m.position.fromArray(s.c); m.scale.fromArray(s.r.map((v) => Math.max(1, v - SKIN))); }
      else if (s.a && s.b && s.r > 0) { const a = new THREE.Vector3().fromArray(s.a), b = new THREE.Vector3().fromArray(s.b), l = a.distanceTo(b); m = new THREE.Mesh(new THREE.CapsuleGeometry(Math.max(1, s.r - SKIN), l, 12, 32), bodyMat); m.position.copy(a).add(b).multiplyScalar(0.5); if (l > 1e-6) m.quaternion.setFromUnitVectors(UP, b.sub(a).normalize()); }
      if (m) { m.castShadow = m.receiveShadow = true; body.add(m); }   // a shape this does not know is not drawn
    }
    body.updateMatrixWorld(true);
  }

  /** What the solver was given: the meshes' seam chains, the seams' pairs, the materials and the body. */
  function setInput(next) { input = next; stale = true; setBody(next?.collisionBody?.shapes); dirty = true; }

  // One mesh per piece, with buffers the size of the piece. Runs when the solver's mesh changes, never per frame.
  function build(frame) {
    for (const p of pieces) p.geo.dispose();
    cloth.clear();
    const meshOf = new Map((input?.meshes || []).map((m) => [m.id, m])), specOf = new Map((input?.patterns || []).map((p) => [p.id, p]));
    pieces = frame.pieces.map((pc) => {
      const geo = new THREE.BufferGeometry(), attr = () => new THREE.BufferAttribute(new Float32Array(pc.count * 3), 3).setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute('position', attr()); geo.setAttribute('normal', attr()); geo.setAttribute('color', attr()); geo.setIndex(Array.from(pc.triangles));
      const mesh = new THREE.Mesh(geo, clothMat), over = new THREE.Mesh(geo, wireMat);
      mesh.castShadow = mesh.receiveShadow = true; mesh.frustumCulled = over.frustumCulled = false; mesh.userData.piece = pc.id; over.visible = wire; over.raycast = () => {}; cloth.add(mesh, over);
      return { id: pc.id, off: pc.off, count: pc.count, geo, mesh, over, base: linear(materialCss(input?.materials, specOf.get(pc.id)?.material || pc.id)), chains: meshOf.get(pc.id)?.segmentVertices || {} };
    });
    total = frame.positions.length / 3;
    const byId = new Map(pieces.map((p) => [p.id, p])), seamCol = []; seamIdx = []; threads = [];
    for (const s of input?.seams || []) {
      const c = linear(seamColour(s.id)), A = byId.get(s.a?.pattern), B = byId.get(s.b?.pattern);
      for (const [piece, ref] of [[A, s.a], [B, s.b]]) { const chain = piece?.chains[ref?.segment] || []; for (let k = 1; k < chain.length; k++) { seamIdx.push(piece.off + chain[k - 1], piece.off + chain[k]); seamCol.push(...c, ...c); } }
      if (A && B) (s.pairs || []).forEach((pair, k) => { if (k % 2 === 0 && pair?.a?.vertices && pair?.b?.vertices) threads.push({ a: pair.a.vertices.map((v) => A.off + v), wa: pair.a.weights, b: pair.b.vertices.map((v) => B.off + v), wb: pair.b.weights, c }); });   // every other pair: enough threads to see where a seam is going
    }
    seamLines.size(seamIdx.length / 2); seamLines.col?.set(seamCol); threadLines.size(threads.length);
    stale = false; coloured = ''; outlined = undefined; stage(frame);
  }

  // The floor and the sun follow the size of what is drawn.
  function bounds(frame) { const box = new THREE.Box3(); if (frame) box.setFromArray(frame.positions); return box.expandByObject(body); }
  function stage(frame) {
    const box = bounds(frame); if (box.isEmpty()) return; const s = box.getBoundingSphere(new THREE.Sphere()); radius = Math.max(1, s.radius);
    ground.position.set(s.center.x, s.center.y, 0); ground.scale.setScalar(radius * 2);
    sun.position.set(s.center.x - radius * 0.7, s.center.y - radius * 1.1, s.center.z + radius * 4); sun.target.position.copy(s.center);   // high, so the shadow lies under the cloth
    const c = sun.shadow.camera; c.left = c.bottom = -radius * 1.6; c.right = c.top = radius * 1.6; c.near = radius; c.far = radius * 6 + s.center.z * 1.2; c.updateProjectionMatrix();   // far enough to reach the floor
  }
  /** Bring the cloth and the body into view, from where the camera already looks. */
  function fit() {
    const box = bounds(last); if (box.isEmpty()) return; if (box.min.z < 0.4 * (box.max.z - box.min.z)) box.min.z = 0;   // what stands on the floor, or near it, is framed with the floor and its shadow
    const s = box.getBoundingSphere(new THREE.Sphere()), half = THREE.MathUtils.degToRad(camera.fov / 2);
    orbit.target.copy(s.center); orbit.dist = Math.max(1, s.radius) / Math.sin(Math.min(half, Math.atan(Math.tan(half) * camera.aspect))) * 1.04; dirty = true;
  }
  function look(name) { const v = VIEWS[name]; if (!v) return; orbit.yaw = v[0]; orbit.pitch = v[1]; fit(); }
  function setWire(on) { wire = !!on; for (const p of pieces) p.over.visible = wire; dirty = true; }

  const copy = (out, at, P, i) => { out[at] = P[i * 3]; out[at + 1] = P[i * 3 + 1]; out[at + 2] = P[i * 3 + 2]; };
  /** Draw a solver frame. Positions, normals, colours and line ends are written into the buffers build() made. */
  function draw({ frame, mapMode = 'off', selected = null }) {
    if (!frame?.pieces || !frame.positions) return;
    if (stale || frame.positions.length !== total * 3 || frame.pieces.length !== pieces.length) build(frame);
    const P = frame.positions, recolour = mapMode !== 'off' || coloured !== 'off', values = mapMode === 'strain' ? frame.strain : frame.pressure, max = frame.diagnostics?.pressure?.max || 1;
    for (const p of pieces) {
      p.geo.attributes.position.array.set(P.subarray(p.off * 3, (p.off + p.count) * 3)); p.geo.attributes.position.needsUpdate = true; p.geo.computeVertexNormals();
      if (!recolour) continue;
      const col = p.geo.attributes.color.array;
      for (let i = 0; i < p.count; i++) {
        if (mapMode === 'off') { col[i * 3] = p.base[0]; col[i * 3 + 1] = p.base[1]; col[i * 3 + 2] = p.base[2]; continue; }
        const c = mapMode === 'strain' ? strainRGB(values?.[p.off + i] || 0) : pressureRGB(values?.[p.off + i] || 0, max); tint.setRGB(c[0], c[1], c[2], THREE.SRGBColorSpace);
        col[i * 3] = tint.r; col[i * 3 + 1] = tint.g; col[i * 3 + 2] = tint.b;
      }
      p.geo.attributes.color.needsUpdate = true;
    }
    coloured = mapMode;
    if (selected !== outlined) {   // the selected piece's own edge
      outlined = selected; outlineIdx = []; const p = pieces.find((q) => q.id === selected);
      for (const chain of Object.values(p?.chains || {})) for (let k = 1; k < chain.length; k++) outlineIdx.push(p.off + chain[k - 1], p.off + chain[k]);
      outline.size(outlineIdx.length / 2); if (outline.col) { const c = linear('#e35a1e'); for (let i = 0; i < outline.col.length; i += 3) outline.col.set(c, i); }
    }
    for (const [set, idx] of [[seamLines, seamIdx], [outline, outlineIdx]]) { if (!set.pos) continue; for (let i = 0; i < idx.length; i++) copy(set.pos, i * 3, P, idx[i]); set.show(idx.length / 2); }
    if (threadLines.pos) {   // only the open pairs, packed to the front of the buffer
      let n = 0; const pos = threadLines.pos, col = threadLines.col;
      for (const t of threads) {
        const at = n * 6; pos.fill(0, at, at + 6);
        for (let k = 0; k < t.a.length; k++) for (let j = 0; j < 3; j++) pos[at + j] += P[t.a[k] * 3 + j] * t.wa[k];
        for (let k = 0; k < t.b.length; k++) for (let j = 0; j < 3; j++) pos[at + 3 + j] += P[t.b[k] * 3 + j] * t.wb[k];
        if (Math.hypot(pos[at] - pos[at + 3], pos[at + 1] - pos[at + 4], pos[at + 2] - pos[at + 5]) < CLOSED) continue;
        col.set(t.c, at); col.set(t.c, at + 3); n++;
      }
      threadLines.show(n);
    }
    last = frame; if (!fitted) { fit(); fitted = true; }   // framed once: a revised pattern must not swing the camera
    dirty = true;
  }

  // ---- camera: the wheel, pinch and 3D mouse are the viewer's own (web/orbitinput.js); a drag turns, ⇧ or the right button pans, a click picks
  const ray = new THREE.Raycaster();
  function hit(e, objects) { const r = el.getBoundingClientRect(); for (const p of pieces) p.geo.computeBoundingSphere(); ray.setFromCamera(new THREE.Vector2((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1), camera); return ray.intersectObjects(objects, false)[0] || null; }
  attachOrbitInput(el, { orbit, camera, THREE, scheme, hitAt: (e) => hit(e, [...pieces.map((p) => p.mesh), ...body.children])?.point ?? null });
  let drag = null;
  el.addEventListener('contextmenu', (e) => e.preventDefault());
  el.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, pan: e.button !== 0 || e.shiftKey, moved: false }; el.setPointerCapture(e.pointerId); });
  el.addEventListener('pointermove', (e) => {
    if (!drag) return; const dx = e.clientX - drag.x, dy = e.clientY - drag.y; if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true; drag.x = e.clientX; drag.y = e.clientY;
    if (drag.pan) { const k = orbit.dist * 0.0016; orbit.target.addScaledVector(new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0), -dx * k).addScaledVector(new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1), dy * k); }
    else { orbit.yaw -= dx * 0.006; orbit.pitch += dy * 0.006; }
  });
  el.addEventListener('pointerup', (e) => { if (drag && !drag.moved && e.button === 0) { const h = hit(e, pieces.map((p) => p.mesh)); if (h) onSelect(h.object.userData.piece); } drag = null; });
  el.addEventListener('pointercancel', () => { drag = null; });

  // Drawn only when something changed: a frame, the camera, the size of the pane.
  const size = new THREE.Vector2(); let seen = '';
  (function loop() {
    requestAnimationFrame(loop);
    const w = host.clientWidth, h = host.clientHeight; if (!w || !h) return;
    renderer.getSize(size); if (size.x !== w || size.y !== h) { renderer.setSize(w, h, false); camera.aspect = w / h; dirty = true; }
    orbit.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, orbit.pitch));
    const key = `${orbit.yaw},${orbit.pitch},${orbit.dist},${orbit.target.x},${orbit.target.y},${orbit.target.z}`; if (!dirty && key === seen) return;
    seen = key; dirty = false;
    const cp = Math.cos(orbit.pitch); camera.position.set(orbit.target.x + orbit.dist * cp * Math.sin(orbit.yaw), orbit.target.y - orbit.dist * cp * Math.cos(orbit.yaw), orbit.target.z + orbit.dist * Math.sin(orbit.pitch));
    camera.near = Math.max(1, orbit.dist / 100); camera.far = orbit.dist + radius * 20; camera.updateProjectionMatrix(); camera.lookAt(orbit.target);
    renderer.render(scene, camera);
  })();

  return { setInput, draw, fit, look, setWire };
}
