// The softgoods review in 3D: the draped pieces as lit cloth, the avatar (ellipsoids, capsules, its mesh torso) and any CAD body as solids, trims as discs and bands, each seam drawn on the cloth along
// the span it sews, a thread across every seam pair that has not closed yet, and the elastics and creased folds of the design. The solver (web/softgoods-worker.js) owns the positions;
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

/** A seam side is one segment, part of one (from and to: fractions of the first and the last segment's length) or several in a
 *  row, read as seamSide() in src/core/softgoods-seams.js reads it. */
export const seamSide = (ref) => ({ pattern: ref?.pattern, segments: Array.isArray(ref?.segments) ? ref.segments : ref?.segment != null ? [ref.segment] : [], from: Number(ref?.from ?? 0), to: Number(ref?.to ?? 1) });
export const sideLabel = (ref) => { const s = seamSide(ref); return `${s.pattern}.${s.segments.join('+')}${s.from > 0 || s.to < 1 ? ` ${+s.from.toFixed(3)}-${+s.to.toFixed(3)}` : ''}`; };
/** The part of a line of {x, y} points between two fractions of its length. */
export function cutLine(q, f0, f1) {
  const cum = [0]; for (let i = 1; i < q.length; i++) cum.push(cum[i - 1] + Math.hypot(q[i].x - q[i - 1].x, q[i].y - q[i - 1].y));
  const at = (d) => { let i = 1; while (i < q.length - 1 && cum[i] < d) i++; const t = cum[i] > cum[i - 1] ? (d - cum[i - 1]) / (cum[i] - cum[i - 1]) : 0; return { x: q[i - 1].x + (q[i].x - q[i - 1].x) * t, y: q[i - 1].y + (q[i].y - q[i - 1].y) * t }; };
  const a = f0 * cum.at(-1), b = f1 * cum.at(-1); return q.length < 2 ? [] : [at(a), ...q.filter((_, i) => cum[i] > a && cum[i] < b), at(b)];
}

// ---- bodies and trims, as the simulation input gives them

/** A mesh body that carries an id is a CAD part of the design (softgoods-bodies.js); the avatar's torso has none. */
export const isCadBody = (s) => s?.type === 'mesh' && s.id != null;
/** Where the floor is, as the solver reads collisionBody.floor: a height in mm, 0 when not given, null for floor: false. */
export const floorOf = (b) => (b?.floor === false ? null : Number(b?.floor ?? 0) || 0);
/** The vertex of a piece's rest mesh (uv: flat x, y pattern mm) nearest a spot on the pattern, of all of them or of `only` (vertex indices). */
export function nearestVertex(uv, x, y, only = null) { let best = -1, d = Infinity; for (const v of only || uv.keys()) { if (!only && v % 2) continue; const i = only ? v : v / 2, e = (uv[i * 2] - x) ** 2 + (uv[i * 2 + 1] - y) ** 2; if (e < d) { d = e; best = i; } } return best; }
/** The input's trim facts as what the view draws: discs at spots and lines along runs, each { trim, pattern, ... } in pattern mm.
 *  A button or snap pair is a disc on both pieces; a zipper is a line along both its sides; topstitching is not in the facts (2D only). */
export function trimShapes(trims, step = 5) {
  // A run is filled in every `step` mm: a straight edge comes as its two ends, and its middle must find the edge vertices too.
  const discs = [], runs = [], xy = (q) => (Array.isArray(q) ? q : [q.x, q.y]), fill = (q) => q.flatMap((b, i) => { if (!i) return [b]; const a = q[i - 1], n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step)); return Array.from({ length: n }, (_, k) => [a[0] + (b[0] - a[0]) * (k + 1) / n, a[1] + (b[1] - a[1]) * (k + 1) / n]); });
  for (const t of trims || []) {
    if (t.type === 'point') for (const q of t.points || []) discs.push({ trim: t.id, pattern: q.pattern, at: xy(q) });
    else if (t.type === 'tack') for (const a of t.attachments || []) discs.push({ trim: t.id, pattern: a.pattern, at: a.at }, { trim: t.id, pattern: a.to.pattern, at: a.to.at });
    else if (t.type === 'seam') for (const side of ['a', 'b']) { const q = (t.pairs || []).map((p) => p[side]); if (q.length > 1) runs.push({ trim: t.id, pattern: q[0].pattern, points: fill(q.map(xy)) }); }
    else for (const path of t.paths || []) runs.push({ trim: t.id, pattern: path.pattern, points: fill(path.points.map(xy)) });
  }
  return { discs, runs };
}

// ---- the view

const MAX_PITCH = Math.PI / 2 - 0.002;
const VIEWS = { front: [0, 0], back: [Math.PI, 0], left: [-Math.PI / 2, 0], right: [Math.PI / 2, 0], top: [0, MAX_PITCH] };
// The body is drawn this much smaller than the solver's: cloth resting on it is flat between vertices and a curved body would show through.
// ponytail: a fixed 3 mm suits a mesh near 30 mm on this avatar; scale it with the mesh size if a coarser preview shows the body.
const SKIN = 3;
// A seam pair this close has closed: no thread is drawn for it.
const CLOSED = 2;
// ponytail: every point trim is a 10 mm disc whatever its spec; read spec.diameter from the design if the size matters in review.
const DISC = 10;

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
  const cadMat = new THREE.MeshStandardMaterial({ color: 0x8e8e8e, roughness: 0.55, metalness: 0.1, side: THREE.DoubleSide });   // a CAD part: a darker, harder grey than the avatar
  const discMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5, metalness: 0.2, side: THREE.DoubleSide });
  const cloth = new THREE.Group(), body = new THREE.Group(), ball = new THREE.SphereGeometry(1, 48, 32), UP = new THREE.Vector3(0, 1, 0);
  const ground = new THREE.Mesh(new THREE.CircleGeometry(1, 96), new THREE.ShadowMaterial({ opacity: 0.18 })); ground.receiveShadow = true;
  ground.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(Array.from({ length: 96 }, (_, i) => new THREE.Vector3(Math.cos(i / 48 * Math.PI), Math.sin(i / 48 * Math.PI), 0))), new THREE.LineBasicMaterial({ color: 0xc4c4c4 })));
  scene.add(ground, body, cloth);
  let discs = new THREE.InstancedMesh(new THREE.CircleGeometry(DISC / 2, 20), discMat, 1), discAt = [];
  discs.count = 0; discs.frustumCulled = false; discs.castShadow = true; scene.add(discs);
  const pose = new THREE.Object3D(), normal = new THREE.Vector3(), ZUP = new THREE.Vector3(0, 0, 1);

  // Lines a few pixels wide whose ends follow the cloth. An end is a point on the cloth: two vertices and their weights (a seam
  // pair lies between two boundary vertices; a mesh vertex is itself, weight 1). load() allocates, once per mesh or selection;
  // write() only fills what is there, leaving out any segment shorter than `min` and packing the rest to the front.
  const tint = new THREE.Color(), linear = (style) => { tint.setStyle(style); return [tint.r, tint.g, tint.b]; };
  function lineSet(linewidth) {
    // Each set is drawn after the one before and a little nearer, so two lines on the same edge do not flicker through each other.
    const order = scene.children.length, obj = new LineSegments2(new LineSegmentsGeometry(), new LineMaterial({ linewidth, vertexColors: true, polygonOffset: true, polygonOffsetFactor: -order, polygonOffsetUnits: -2 * order }));
    obj.frustumCulled = false; obj.visible = false; obj.renderOrder = order; scene.add(obj);
    let n = 0, ends, w, rgb, pos, col;
    return {
      load(segs) {
        obj.geometry.dispose(); obj.geometry = new LineSegmentsGeometry(); obj.visible = false; n = segs.length; if (!n) return;
        ends = new Int32Array(n * 4); w = new Float32Array(n * 4); rgb = new Float32Array(n * 3); pos = new Float32Array(n * 6); col = new Float32Array(n * 6);
        segs.forEach((s, i) => { ends.set([s.a[0], s.a[1], s.b[0], s.b[1]], i * 4); w.set([s.a[2], s.a[3], s.b[2], s.b[3]], i * 4); rgb.set(s.c, i * 3); });
        obj.geometry.setPositions(pos); obj.geometry.setColors(col);
      },
      write(P, min = 0) {
        if (!n) return; let m = 0;
        for (let i = 0; i < n; i++) {
          const at = m * 6;
          for (let e = 0; e < 2; e++) { const k = i * 4 + e * 2, i0 = ends[k] * 3, i1 = ends[k + 1] * 3; for (let j = 0; j < 3; j++) pos[at + e * 3 + j] = P[i0 + j] * w[k] + P[i1 + j] * w[k + 1]; }
          if (min && Math.hypot(pos[at] - pos[at + 3], pos[at + 1] - pos[at + 4], pos[at + 2] - pos[at + 5]) < min) continue;
          for (let j = 0; j < 3; j++) col[at + j] = col[at + 3 + j] = rgb[i * 3 + j];
          m++;
        }
        obj.visible = m > 0; obj.geometry.instanceCount = m; obj.geometry.attributes.instanceStart.data.needsUpdate = true; obj.geometry.attributes.instanceColorStart.data.needsUpdate = true;
      },
    };
  }
  const vertex = (v) => [v, v, 1, 0], between = (side, off) => [off + side.vertices[0], off + (side.vertices[1] ?? side.vertices[0]), side.weights[0], side.weights[1] ?? 0];
  const along = (off, chain, c) => chain.slice(1).map((v, k) => ({ a: vertex(off + chain[k]), b: vertex(off + v), c }));
  // In this order, each over the one before: the selected piece's edge, the seams inside it, an elastic as a black line with a
  // white core (no seam has that), a creased fold as a thin black line, and the threads.
  // An edge trim (zipper, binding, piping, hook-and-loop, elastic, drawcord) is a violet band over all of these.
  const outline = lineSet(4), seamLines = lineSet(2.5), elasticEdge = lineSet(5), elasticCore = lineSet(1.5), foldLines = lineSet(1.5), threadLines = lineSet(1.25), trimLines = lineSet(4);
  const BLACK = [0, 0, 0], WHITE = [1, 1, 1], ORANGE = linear('#e35a1e'), VIOLET = linear('#6b2bd9'), DARK = linear('#262626');

  let input = null, stale = true, pieces = [], total = 0, last = null, fitted = false, wire = false, coloured = '', outlined, trimmed, refit = false, dirty = true, radius = 1000, floor = 0, shapes = { discs: [], runs: [] };

  function setBody(shapes) {
    for (const m of body.children) if (m.geometry !== ball) m.geometry.dispose();
    body.clear();
    for (const s of shapes || []) {
      let m = null;
      if (s.type === 'ellipsoid' && s.c && s.r) { m = new THREE.Mesh(ball, bodyMat); m.position.fromArray(s.c); m.scale.fromArray(s.r.map((v) => Math.max(1, v - SKIN))); }
      else if (s.type === 'mesh' && s.positions?.length && s.indices?.length) {
        // Built once from the input: frames name a mesh shape and carry nothing else. Drawn SKIN inside, as the other shapes are.
        const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(s.positions, 3)); g.setIndex(s.indices); g.computeVertexNormals();
        const P = g.attributes.position.array, N = g.attributes.normal.array; for (let i = 0; i < P.length; i++) P[i] -= N[i] * SKIN; g.computeVertexNormals();
        m = new THREE.Mesh(g, isCadBody(s) ? cadMat : bodyMat);
      }
      else if (s.a && s.b && s.r > 0) { const a = new THREE.Vector3().fromArray(s.a), b = new THREE.Vector3().fromArray(s.b), l = a.distanceTo(b); m = new THREE.Mesh(new THREE.CapsuleGeometry(Math.max(1, s.r - SKIN), l, 12, 32), bodyMat); m.position.copy(a).add(b).multiplyScalar(0.5); if (l > 1e-6) m.quaternion.setFromUnitVectors(UP, b.sub(a).normalize()); }
      if (m) { m.castShadow = m.receiveShadow = true; body.add(m); }   // a shape this does not know is not drawn
    }
    body.updateMatrixWorld(true);
  }

  /** What the solver was given: the meshes' boundary chains, the seams' pairs, elastics, folds, the materials and the body. */
  function setInput(next) { input = next; stale = true; setBody(next?.collisionBody?.shapes); floor = next?.collisionBody ? floorOf(next.collisionBody) : 0; shapes = trimShapes(next?.trims); if (!fitted) refit = true; dirty = true; }   // the bodies are framed before the first frame comes

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
    const byId = new Map(pieces.map((p) => [p.id, p])), seamSegs = [], threadSegs = [];
    for (const s of input?.seams || []) {
      const c = linear(seamColour(s.id)), A = byId.get(s.a?.pattern), B = byId.get(s.b?.pattern), pairs = (s.pairs || []).filter((q) => q?.a?.vertices && q?.b?.vertices); if (!A || !B) continue;
      // A seam may sew part of an edge, or several edges in a row: its pairs run along exactly what is sewn, on both sides.
      for (let k = 1; k < pairs.length; k++) seamSegs.push({ a: between(pairs[k - 1].a, A.off), b: between(pairs[k].a, A.off), c }, { a: between(pairs[k - 1].b, B.off), b: between(pairs[k].b, B.off), c });
      pairs.forEach((q, k) => { if (k % 2 === 0) threadSegs.push({ a: between(q.a, A.off), b: between(q.b, B.off), c }); });   // every other pair: enough threads to see where a seam is going
    }
    // Elastics and creased folds come resolved onto the mesh: { pattern, chain } is a run of that piece's vertices.
    const runs = (list, c) => (list || []).flatMap((l) => { const p = byId.get(l?.pattern); return p && Array.isArray(l.chain) ? along(p.off, l.chain, c) : []; });
    seamLines.load(seamSegs); threadLines.load(threadSegs); elasticEdge.load(runs(input?.elastics, BLACK)); elasticCore.load(runs(input?.elastics, WHITE)); foldLines.load(runs(input?.folds, BLACK));
    // Trims are given on the pattern in mm: each spot and each point of a run goes to the nearest vertex of its piece's rest mesh.
    // A run lies along the outline, so it takes only the piece's edge vertices: an inner one would zigzag it across the cloth.
    const uvOf = new Map((input?.meshes || []).map((m) => [m.id, m.uv || []])), vertexAt = (pattern, [x, y], edge) => { const p = byId.get(pattern), i = p ? nearestVertex(uvOf.get(pattern) || [], x, y, edge ? [...new Set(Object.values(p.chains).flat())] : null) : -1; return i < 0 ? -1 : p.off + i; };
    discAt = shapes.discs.map((d) => ({ trim: d.trim, v: vertexAt(d.pattern, d.at) })).filter((d) => d.v >= 0);
    for (const r of shapes.runs) r.chain = r.points.map((q) => vertexAt(r.pattern, q, true)).filter((v, i, a) => v >= 0 && v !== a[i - 1]);
    if (discAt.length * 2 > discs.instanceMatrix.count) { scene.remove(discs); discs.dispose(); discs = new THREE.InstancedMesh(discs.geometry, discMat, discAt.length * 2); discs.frustumCulled = false; discs.castShadow = true; scene.add(discs); }
    stale = false; coloured = ''; outlined = trimmed = undefined; stage(frame);
  }

  // The floor and the sun follow the size of what is drawn.
  function bounds(frame) { const box = new THREE.Box3(); if (frame) box.setFromArray(frame.positions); return box.expandByObject(body); }
  function stage(frame) {
    const box = bounds(frame); if (box.isEmpty()) return; const s = box.getBoundingSphere(new THREE.Sphere()); radius = Math.max(1, s.radius);
    ground.visible = floor != null; ground.position.set(s.center.x, s.center.y, floor ?? 0); ground.scale.setScalar(radius * 2);   // no floor: no disc
    sun.position.set(s.center.x - radius * 0.7, s.center.y - radius * 1.1, s.center.z + radius * 4); sun.target.position.copy(s.center);   // high, so the shadow lies under the cloth
    const c = sun.shadow.camera; c.left = c.bottom = -radius * 1.6; c.right = c.top = radius * 1.6; c.near = radius; c.far = radius * 6 + s.center.z * 1.2; c.updateProjectionMatrix();   // far enough to reach the floor
  }
  /** Bring the cloth and the body into view, from where the camera already looks. */
  function fit() {
    const box = bounds(last); if (box.isEmpty()) return; if (floor != null && box.min.z - floor < 0.4 * (box.max.z - box.min.z)) box.min.z = Math.min(box.min.z, floor);   // what stands on the floor, or near it, is framed with the floor and its shadow
    const s = box.getBoundingSphere(new THREE.Sphere()), half = THREE.MathUtils.degToRad(camera.fov / 2);
    orbit.target.copy(s.center); orbit.dist = Math.max(1, s.radius) / Math.sin(Math.min(half, Math.atan(Math.tan(half) * camera.aspect))) * 1.04; dirty = true;
  }
  function look(name) { const v = VIEWS[name]; if (!v) return; orbit.yaw = v[0]; orbit.pitch = v[1]; fit(); }
  function setWire(on) { wire = !!on; for (const p of pieces) p.over.visible = wire; dirty = true; }

  /** Draw a solver frame. Positions, normals, colours and line ends are written into the buffers build() made. */
  function draw({ frame, mapMode = 'off', selected = null, trim = null }) {
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
    if (selected !== outlined) { outlined = selected; const p = pieces.find((q) => q.id === selected); outline.load(p ? Object.values(p.chains).flatMap((chain) => along(p.off, chain, ORANGE)) : []); }   // the selected piece's own edge
    if (trim !== trimmed) {   // the selected trim is drawn orange, discs and lines
      trimmed = trim; trimLines.load(shapes.runs.flatMap((r) => r.chain.slice(1).map((v, k) => ({ a: vertex(r.chain[k]), b: vertex(v), c: r.trim === trim ? ORANGE : VIOLET }))));
      discAt.forEach((d, i) => { tint.setRGB(...(d.trim === trim ? ORANGE : DARK)); discs.setColorAt(2 * i, tint); discs.setColorAt(2 * i + 1, tint); }); if (discs.instanceColor) discs.instanceColor.needsUpdate = true;
    }
    for (const set of [outline, seamLines, elasticEdge, elasticCore, foldLines, trimLines]) set.write(P);
    // A disc sits square to the cloth at its vertex, a little off each face (which face is outside, the view does not know): the normal is the one computeVertexNormals just gave the piece.
    discAt.forEach((d, i) => {
      const p = pieces.find((q) => d.v >= q.off && d.v < q.off + q.count), n = p.geo.attributes.normal.array, j = (d.v - p.off) * 3;
      normal.set(n[j], n[j + 1], n[j + 2]); pose.quaternion.setFromUnitVectors(ZUP, normal);
      for (const side of [0, 1]) { pose.position.set(P[d.v * 3], P[d.v * 3 + 1], P[d.v * 3 + 2]).addScaledVector(normal, side ? -1.5 : 1.5); pose.updateMatrix(); discs.setMatrixAt(2 * i + side, pose.matrix); }
    });
    discs.count = discAt.length * 2; discs.instanceMatrix.needsUpdate = true;
    threadLines.write(P, CLOSED);   // only the pairs still open
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
    if (refit) { refit = false; stage(last); fit(); }
    orbit.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, orbit.pitch));
    const key = `${orbit.yaw},${orbit.pitch},${orbit.dist},${orbit.target.x},${orbit.target.y},${orbit.target.z}`; if (!dirty && key === seen) return;
    seen = key; dirty = false;
    const cp = Math.cos(orbit.pitch); camera.position.set(orbit.target.x + orbit.dist * cp * Math.sin(orbit.yaw), orbit.target.y - orbit.dist * cp * Math.cos(orbit.yaw), orbit.target.z + orbit.dist * Math.sin(orbit.pitch));
    camera.near = Math.max(1, orbit.dist / 100); camera.far = orbit.dist + radius * 20; camera.updateProjectionMatrix(); camera.lookAt(orbit.target);
    renderer.render(scene, camera);
  })();

  return { setInput, draw, fit, look, setWire };
}
