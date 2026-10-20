/**
 * Markup over a 3D viewport — pen strokes, arrows and notes anchored ON the
 * model (every point is a raycast hit, or a point on the plane through the
 * orbit target when the pointer misses), so they turn with the part instead
 * of floating on the glass.
 *
 * This is how the user talks back to Claude without a screenshot: the list is
 * persisted per project, and `snapshot()` composites the live canvas and the
 * notes into one PNG the server hands to the `cadgang_screen` MCP tool.
 */
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { DecalGeometry } from 'three/addons/geometries/DecalGeometry.js';

export function createMarkup({ THREE, renderer, scene, getCamera, orbit, getTargets, layer, tools, onChange, snap = null, planeAt = null }) {
  const group = new THREE.Group();
  group.renderOrder = 5;
  scene.add(group);
  const raycaster = new THREE.Raycaster();
  const COLOR = '#d11d1d', WIDTH = 1;   // what items without a colour or width (older files) get
  // A mark Claude has acted on (done: true, via cadgang_markup_done) stays as a record, in Infinite
  // Machine green at 30%: what was asked and where, without competing with what is still open.
  const DONE = '#00ff57', DONE_ALPHA = 0.3;
  // The pen: colour + width (px) for the next mark, kept per viewer
  const PEN_KEY = 'cadgang.pen';
  let pen = { color: COLOR, width: 2 };
  try { pen = { ...pen, ...JSON.parse(localStorage.getItem(PEN_KEY) || '{}') }; } catch {}
  // Fat lines (a WebGL line is always 1 px): one pair of materials per colour+width, resolution kept per frame
  const mats = new Map();
  const matFor = (color = COLOR, width = WIDTH, opacity = 1) => {
    const k = `${color}/${width}/${opacity}`;
    if (!mats.has(k)) mats.set(k, { line: new LineMaterial({ color, linewidth: width, depthTest: false, transparent: true, opacity }), solid: new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: opacity < 1, opacity }) });
    return mats.get(k);
  };
  const looks = (item) => (item.done ? [DONE, item.width, DONE_ALPHA] : [item.color, item.width, 1]);
  const fatLine = (pts, mat) => new Line2(new LineGeometry().setPositions(pts.flatMap((p) => p.toArray())), mat);
  let tool = null;
  let items = [];
  let current = null;
  let noteInput = null;
  const canvas = renderer.domElement;

  const ndc = (e) => {
    const r = canvas.getBoundingClientRect();
    return new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  };
  const toScreen = (p) => {
    const r = canvas.getBoundingClientRect();
    const v = new THREE.Vector3(...p).project(getCamera());
    return { x: (v.x + 1) / 2 * r.width, y: (1 - v.y) / 2 * r.height, behind: v.z > 1 };
  };
  // A mark rides the part its first point landed on: item.body = `${name}#${n}` (the n-th body of that
  // name, so it survives a re-export), and its points are in that part's REST frame (exploded offset
  // taken off). Each frame the mark is moved by the part's current offset, so leaders explode and
  // collapse with their part. Marks off any part (body unset) stay in world space.
  let hitBody = null;
  const keyOf = (m) => { const all = getTargets(); const n = all.filter((o, i) => o.userData.name === m.userData.name && i < all.indexOf(m)).length; return `${m.userData.name}#${n}`; };
  const byKey = (k) => { const i = k.lastIndexOf('#'), name = k.slice(0, i), n = +k.slice(i + 1); return getTargets().filter((o) => o.userData.name === name)[n] ?? null; };
  const ZERO = new THREE.Vector3();
  const shift = (item) => (item.body && byKey(item.body)?.position) || ZERO;
  const toWorld = (item, p) => new THREE.Vector3(...p).add(shift(item)).toArray();
  const toRest = (item, p) => new THREE.Vector3(...p).sub(shift(item)).toArray();
  // A visible reference plane is a surface too (planeAt: the nearest along the ray): a mark on it is in
  // world space (no part to ride), and the model wins where it is in front.
  let hitPlane = null;
  function surfaceAt(e) {
    raycaster.setFromCamera(ndc(e), getCamera());
    const hit = raycaster.intersectObjects(getTargets(), false)[0] ?? null;
    const ph = planeAt?.(raycaster) ?? null;
    return ph && (!hit || ph.distance < hit.distance) ? { plane: ph } : { hit };
  }
  function pointAt(e) {
    const cam = getCamera();
    const { hit, plane: onRef } = surfaceAt(e);
    hitBody = hit?.object ?? null; hitPlane = onRef ?? null;
    if (onRef) return onRef.point.toArray();
    raycaster.setFromCamera(ndc(e), cam);
    if (hit) return [hit.point.x, hit.point.y, hit.point.z];
    const n = new THREE.Vector3(); cam.getWorldDirection(n);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, orbit.target);
    const p = new THREE.Vector3();
    return raycaster.ray.intersectPlane(plane, p) ? [p.x, p.y, p.z] : null;
  }
  // The face under the pointer: its world normal, turned to face the camera, and the camera's up laid
  // into that plane (an arrow's text lies on the face it points at, upright as seen when it was made).
  function faceFrame(e) {
    const cam = getCamera();
    const { hit, plane } = surfaceAt(e);
    if (!plane && !hit?.face) return null;
    const n = plane ? plane.normal.clone() : hit.face.normal.clone().transformDirection(hit.object.matrixWorld).normalize();
    const look = new THREE.Vector3(); cam.getWorldDirection(look);
    if (n.dot(look) > 0) n.negate();
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
    up.addScaledVector(n, -up.dot(n));
    if (up.length() < 1e-3) return null;
    return { normal: n.toArray().map((v) => +v.toFixed(4)), up: up.normalize().toArray().map((v) => +v.toFixed(4)) };
  }
  // Where the pointer meets the plane through `origin` with normal `n` (null when that plane is edge-on).
  function onPlane(e, origin, n) {
    raycaster.setFromCamera(ndc(e), getCamera());
    if (Math.abs(raycaster.ray.direction.dot(n)) < 0.15) return null;
    const p = new THREE.Vector3();
    return raycaster.ray.intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(n, origin), p) ? p.toArray() : null;
  }

  // ------------------------------------------------------------ geometry

  function build(item) {
    const objs = [];
    const pts = item.points.map((p) => new THREE.Vector3(...p));
    const scale = orbit.dist * 0.012;
    const { line: lineMat, solid: solidMat } = matFor(...looks(item));
    if (item.kind === 'pen' && pts.length > 1) {
      objs.push(fatLine(pts, lineMat));
    } else if (item.kind === 'arrow' && pts.length === 2) {
      // points: [tail, head]. The head is where the press landed; the tail, where the drag ended, holds
      // the text. A click with no drag is a dot.
      const dir = pts[1].clone().sub(pts[0]);
      if (dir.length() > scale * 0.3) {
        objs.push(fatLine(pts, lineMat));
      }
      const dot = new THREE.Mesh(new THREE.SphereGeometry(scale * 0.3, 12, 8), solidMat);   // a leader ends in a dot
      dot.position.copy(pts[1]);
      objs.push(dot);
      if (item.text && item.normal) objs.push(planeText(item, pts, scale));
    } else if (item.kind === 'path' && pts.length > 1) {
      objs.push(fatLine(pts, lineMat));
    } else if (item.kind === 'text' && item.text) {
      objs.push(item.normal ? flatText(item, pts[0]) : null);
    } else if (item.kind === 'image' && item.src) {
      objs.push(picture(item, pts[0]));
    } else if (item.kind === 'note') {
      const dot = new THREE.Mesh(new THREE.SphereGeometry(scale * 0.25, 12, 8), solidMat);
      dot.position.copy(pts[0]);
      objs.push(dot);
    }
    const holder = new THREE.Group();   // moved by the part's explode offset each frame
    holder.userData.item = item; holder.position.copy(shift(item));
    for (const o of objs.filter(Boolean)) { o.renderOrder = Math.max(o.renderOrder, 5); o.userData.item = item; holder.add(o); }
    group.add(holder);
    return objs;
  }

  // An arrow's text drawn flat on the plane of the face it points at: a label texture on a quad in
  // that plane, running along the arrow and starting at its tail (read left to right as seen when it
  // was drawn: an arrow pointing right puts its text on its left end). A dot's text sits upright above it.
  function planeText(item, [tail, head], scale) {
    const c = document.createElement('canvas'), ctx = c.getContext('2d'), px = 48;
    ctx.font = `${px}px "Space Mono", monospace`;
    c.width = Math.ceil(ctx.measureText(item.text).width + px); c.height = Math.ceil(px * 1.6);
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.strokeStyle = item.done ? DONE : item.color || COLOR; ctx.lineWidth = 4; ctx.strokeRect(2, 2, c.width - 4, c.height - 4);
    ctx.font = `${px}px "Space Mono", monospace`; ctx.fillStyle = '#000000'; ctx.textBaseline = 'middle';
    ctx.fillText(item.text, px / 2, c.height / 2);
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
    const h = scale * 1.1, w = h * c.width / c.height;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex, depthTest: false, transparent: true, opacity: item.done ? DONE_ALPHA : 1, side: THREE.DoubleSide }));
    const n = new THREE.Vector3(...item.normal), camUp = new THREE.Vector3(...item.up), camRight = camUp.clone().cross(n);
    const away = tail.clone().sub(head); away.addScaledVector(n, -away.dot(n));   // head → tail, in the plane
    let r = camRight, u = camUp;
    const along = away.length() > scale * 0.3;   // an arrow, not a dot
    if (along) {
      away.normalize();
      r = away.dot(camRight) < 0 ? away.clone().negate() : away.clone();   // never upside down
      u = n.clone().cross(r);
    }
    mesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(r, u, n));
    mesh.position.copy(tail);
    if (along) mesh.position.addScaledVector(away, w / 2 + scale * 0.2);   // starts at the tail, away from the head
    else mesh.position.addScaledVector(u, h * 0.9);   // a dot: above it
    mesh.renderOrder = 6; mesh.userData.own = true;
    return mesh;
  }

  // TEXT: words laid on the face that was clicked, centred on the click, at the size they were made
  // (item.size, world units: the height of a line), upright as the view was then.
  function flatText(item, at) {
    const c = document.createElement('canvas'), ctx = c.getContext('2d'), px = 64;
    const font = `600 ${px}px "Space Mono", monospace`;
    ctx.font = font;
    const lines = String(item.text).split('\n');
    c.width = Math.ceil(Math.max(...lines.map((l) => ctx.measureText(l).width)) + px * 0.4); c.height = Math.ceil(px * 1.25 * lines.length + px * 0.2);
    ctx.font = font; ctx.fillStyle = item.done ? DONE : item.color || COLOR; ctx.textBaseline = 'middle';
    lines.forEach((l, i) => ctx.fillText(l, px * 0.2, px * (0.725 + 1.25 * i)));
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
    const h = (item.size || orbit.dist * 0.02) * lines.length, w = h * c.width / c.height;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: item.done ? DONE_ALPHA : 1, depthTest: false, side: THREE.DoubleSide }));
    const n = V3(item.normal), u = V3(item.up), r = u.clone().cross(n);
    mesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(r, u, n));
    mesh.position.copy(at);
    mesh.renderOrder = 6; mesh.userData.own = true;
    return mesh;
  }

  // IMAGE: a PNG or JPEG laid on the surface clicked, projected onto the part so it follows a curve
  // (three's DecalGeometry); off a part, a flat picture. item.size is its width in world units.
  // The projection runs over every triangle of the part, so it is kept per item until the part changes.
  const decals = new Map(), textures = new Map();
  function picture(item, at) {
    let tex = textures.get(item.src);
    if (!tex) { tex = new THREE.TextureLoader().load(item.src, () => rebuild()); tex.colorSpace = THREE.SRGBColorSpace; textures.set(item.src, tex); }
    const w = item.size, h = w / (item.aspect || 1);
    const n = V3(item.normal ?? [0, 0, 1]), u = V3(item.up ?? [0, 1, 0]), r = u.clone().cross(n);
    const basis = new THREE.Matrix4().makeBasis(r, u, n);
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: item.done ? DONE_ALPHA : 1, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4, side: THREE.DoubleSide });
    const part = item !== current && item.body && byKey(item.body);   // while it is being sized: flat, the projection waits for the release
    let geo = null;
    if (part?.isMesh) {
      part.geometry.computeBoundingBox();
      const key = `${item.id}|${w}|${part.geometry.boundingBox.min.toArray().join()}`;
      geo = decals.get(key);
      if (!geo) {
        part.updateMatrixWorld(true);
        const world = at.clone().add(part.position);   // the part where it is now; the decal comes back to rest below
        geo = new DecalGeometry(part, world, new THREE.Euler().setFromRotationMatrix(basis), new THREE.Vector3(w, h, Math.max(w, h) * 0.6));
        geo.translate(-part.position.x, -part.position.y, -part.position.z);
        if (!geo.getAttribute('position').count) { geo.dispose(); geo = null; }
        else decals.set(key, geo);
      }
    }
    const mesh = geo ? new THREE.Mesh(geo, mat) : new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
    if (!geo) { mesh.quaternion.setFromRotationMatrix(basis); mesh.position.copy(at).addScaledVector(n, w * 0.002); }
    mesh.renderOrder = 4;
    mesh.userData.keepGeo = !!geo;   // a cached decal outlives a rebuild
    mesh.userData.own = true;
    return mesh;
  }
  // The picture the IMAGE tool places next: chosen when the tool is picked, kept until another is.
  let picked = null;
  const fileInput = Object.assign(document.createElement('input'), { type: 'file', accept: 'image/png,image/jpeg' });
  fileInput.addEventListener('change', () => {
    const f = fileInput.files?.[0];
    fileInput.value = '';
    if (!f) { if (!picked) setTool(null); return; }
    const img = new Image();
    img.onload = () => {
      // at most 1024 px on its long side: a markup file stays small, and the picture still reads
      const k = Math.min(1, 1024 / Math.max(img.width, img.height));
      const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      picked = { src: c.toDataURL(f.type === 'image/jpeg' ? 'image/jpeg' : 'image/png', 0.9), aspect: c.width / c.height, name: f.name };
      URL.revokeObjectURL(img.src);
    };
    img.src = URL.createObjectURL(f);
  });
  function startText(p, e, body) {
    noteInput?.remove();
    const frame = faceFrame(e);
    if (!frame) return;   // edge-on or off a face: nowhere flat to write
    const el = Object.assign(document.createElement('input'), { className: 'note-input', placeholder: 'text… (Enter)' });
    const sc = toScreen(p);
    el.style.left = `${sc.x}px`; el.style.top = `${sc.y}px`;
    layer.appendChild(el); noteInput = el;
    setTimeout(() => el.focus(), 0);
    let finished = false;
    const done = (commit) => {
      if (finished) return;
      finished = true;
      if (commit && el.value.trim()) {
        const t = { id: uid(), kind: 'text', body, text: el.value.trim(), color: pen.color, size: +(orbit.dist * 0.025).toFixed(4), ...frame, at: new Date().toISOString() };
        t.points = [toRest(t, p)];
        items.push(t); changed();
      }
      el.remove(); noteInput = null; rebuild();
    };
    el.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') done(true); else if (ev.key === 'Escape') done(false); ev.stopPropagation(); });
    el.addEventListener('blur', () => done(true));
  }

  function rebuild() {
    for (const o of [...group.children]) {
      group.remove(o);
      o.traverse((x) => {
        if (!x.userData.keepGeo) x.geometry?.dispose();
        if (x.userData.own) { if (x.userData.item?.kind !== 'image') x.material.map?.dispose(); x.material.dispose(); }   // pictures keep their cached texture
      });
    }
    for (const l of layer.querySelectorAll('.note-label')) l.remove();
    for (const item of items) {
      build(item);
      if (item.text && !item.normal) {   // planar text is in the scene already
        const el = document.createElement('div');
        el.className = 'note-label' + (item.done ? ' done' : '');
        el.textContent = item.text || '…';
        el.dataset.id = item.id;
        el.style.borderColor = item.done ? DONE : item.color || COLOR;
        layer.appendChild(el);
      }
    }
    if (current) build(current);
    if (draft) buildDraft();
  }

  // ------------------------------------------------------------- pen (Figma's): anchors and handles
  //
  // A path is anchors with handles: a click places a corner, a click-drag pulls out mirrored handles
  // for a smooth one, a click on the first anchor closes it, Enter or Esc ends it open, ⌫ takes the
  // last anchor back. Anchors sit on the model (snapped like the arrow's head); a handle is dragged in
  // the plane of the face under its anchor. Saved as kind 'path': nodes [{p, in, out}] (p in the
  // part's rest frame, handles as offsets) and points, the curve sampled, so it reads like a stroke.
  let draft = null, handle = null, hoverP = null;
  const V3 = (a) => new THREE.Vector3(...a);
  function curvePoints(nodes, closed) {
    const out = [nodes[0].p];
    const seg = (a, b) => {
      const p0 = V3(a.p), p3 = V3(b.p), p1 = p0.clone().add(V3(a.out)), p2 = p3.clone().add(V3(b.in));
      const curved = V3(a.out).lengthSq() > 0 || V3(b.in).lengthSq() > 0;
      const n = curved ? 24 : 1;
      for (let i = 1; i <= n; i++) {
        const t = i / n, u = 1 - t;
        const q = p0.clone().multiplyScalar(u * u * u).addScaledVector(p1, 3 * u * u * t).addScaledVector(p2, 3 * u * t * t).addScaledVector(p3, t * t * t);
        out.push(q.toArray().map((v) => +v.toFixed(4)));
      }
    };
    for (let i = 0; i + 1 < nodes.length; i++) seg(nodes[i], nodes[i + 1]);
    if (closed && nodes.length > 2) seg(nodes[nodes.length - 1], nodes[0]);
    return out;
  }
  function buildDraft() {
    const holder = new THREE.Group();
    holder.userData.item = draft; holder.position.copy(shift(draft));
    const { line, solid } = matFor(draft.color, draft.width);
    const add = (o) => { o.renderOrder = 7; holder.add(o); };
    if (draft.nodes.length > 1) add(fatLine(curvePoints(draft.nodes, false).map(V3), line));
    const last = draft.nodes[draft.nodes.length - 1];
    if (hoverP && !handle) {   // where the next segment would go
      const end = V3(toRest(draft, hoverP)), a = V3(last.p), c = a.clone().add(V3(last.out));
      const pts = V3(last.out).lengthSq() > 0 ? Array.from({ length: 17 }, (_, i) => { const t = i / 16, u = 1 - t; return a.clone().multiplyScalar(u * u).addScaledVector(c, 2 * u * t).addScaledVector(end, t * t); }) : [a, end];
      add(fatLine(pts, matFor(draft.color, 1, 0.5).line));
    }
    const r = orbit.dist * 0.004;
    const dot = (p, size, mat) => { const m = new THREE.Mesh(new THREE.SphereGeometry(size, 10, 8), mat); m.position.copy(p); add(m); };
    const white = new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false });
    draft.nodes.forEach((n, i) => {
      const a = V3(n.p);
      for (const h of [n.in, n.out]) if (V3(h).lengthSq() > 0) { add(fatLine([a, a.clone().add(V3(h))], matFor(draft.color, 1).line)); dot(a.clone().add(V3(h)), r * 0.7, solid); }
      dot(a, r * 1.3, solid); dot(a, r * 0.8, i === 0 && draft.nodes.length > 1 ? white : solid);   // the first anchor shows hollow: click it to close
    });
    group.add(holder);
  }
  function finishDraft() {
    if (!draft) return;
    if (draft.nodes.length > 1) {
      const { nodes, closed } = draft;
      items.push({ ...draft, points: curvePoints(nodes, closed), at: new Date().toISOString() });
      changed();
    }
    draft = null; handle = null; hoverP = null;
    rebuild();
  }
  function penDown(e, p, body) {
    // on the first anchor again: close the shape
    if (draft && draft.nodes.length > 1) {
      const f = toScreen(toWorld(draft, draft.nodes[0].p)), r = canvas.getBoundingClientRect();
      if (Math.hypot(f.x - (e.clientX - r.left), f.y - (e.clientY - r.top)) < 10) { draft.closed = true; finishDraft(); return; }
    }
    if (!draft) draft = { id: uid(), kind: 'path', ...body, ...pen, nodes: [] };
    const node = { p: toRest(draft, p), in: [0, 0, 0], out: [0, 0, 0] };
    draft.nodes.push(node);
    const fr = faceFrame(e), n = fr ? V3(fr.normal) : new THREE.Vector3();
    if (!fr) getCamera().getWorldDirection(n);
    handle = { node, origin: V3(p), n, id: e.pointerId, x: e.clientX, y: e.clientY };
    canvas.setPointerCapture(e.pointerId);
    rebuild();
  }
  function penMove(e) {
    if (Math.hypot(e.clientX - handle.x, e.clientY - handle.y) < 3) return;   // a click, not a drag: a corner
    let q = onPlane(e, handle.origin, handle.n);
    if (!q) { const n = new THREE.Vector3(); getCamera().getWorldDirection(n); q = onPlane(e, handle.origin, n); }
    if (!q) return;
    const out = V3(q).sub(handle.origin);
    handle.node.out = out.toArray().map((v) => +v.toFixed(4));
    handle.node.in = out.negate().toArray().map((v) => +v.toFixed(4));   // mirrored, as Figma's pen
    rebuild();
  }
  window.addEventListener('keydown', (e) => {
    if (!draft || e.target.matches?.('input,textarea')) return;
    if (e.key === 'Enter' || e.key === 'Escape') { finishDraft(); }
    else if (e.key === 'Backspace' || e.key === 'Delete') { draft.nodes.pop(); if (!draft.nodes.length) draft = null; rebuild(); }
    else return;
    e.preventDefault(); e.stopImmediatePropagation();
  }, { capture: true });

  /** Called every frame: keep note labels on their anchors. */
  function projectLabels() {
    const r = canvas.getBoundingClientRect();
    for (const m of mats.values()) m.line.resolution.set(r.width, r.height);
    for (const h of group.children) h.position.copy(shift(h.userData.item));
    for (const el of layer.querySelectorAll('.note-label')) {
      const item = items.find((i) => i.id === el.dataset.id);
      if (!item) continue;
      const s = toScreen(toWorld(item, item.points[0]));
      el.style.left = `${s.x}px`; el.style.top = `${s.y}px`;
      el.hidden = s.behind;
    }
  }

  // ------------------------------------------------------------- pointer

  const uid = () => Math.random().toString(36).slice(2, 9);
  let last = null;

  // Which tool a press uses: the chosen one, whatever presses (mouse, finger or pencil) — and with
  // none chosen, a stylus (Apple Pencil) still draws with the pen while fingers orbit. On an iPad
  // the pencil marks up and the hand turns the part with no mode switch; pick a tool and a finger
  // draws too (v0.14.14: before, a finger never drew, so PEN/ARROW did nothing without a pencil).
  const toolFor = (e) => tool || (e.pointerType === 'pen' ? 'pen' : null);
  // Only a stroke in progress owns the pointer. With a tool chosen, a press that lands off the model
  // (or, erasing, on no mark) is the view's: it orbits, pans and zooms as with no tool at all.
  const mine = (e) => !!current && e.pointerId === last.id;

  canvas.addEventListener('pointerdown', (e) => {
    const using = e.button === 0 ? toolFor(e) : null;
    if (!using) return;
    if (current) { e.stopImmediatePropagation(); e.preventDefault(); return; }   // a second finger mid-stroke: neither draws nor orbits
    if (using === 'erase') {
      if (!markNear(e)) return;   // nothing to erase here: the view's
      e.stopImmediatePropagation(); e.preventDefault();
      eraseAt(e); rebuild();
      return;
    }
    let p = pointAt(e);
    // an arrow's head, or a pen anchor, goes exactly on the corner, centre or edge the hover lit up (⌥: anywhere)
    const s = (using === 'arrow' || using === 'path') && snap?.snapAt(e);
    if (s) p = s.toArray();
    // a mark lives on the model: pressed on nothing, the press is the view's (orbit), and no mark is made
    if (!p || (!hitBody && !hitPlane && !s)) return;
    e.stopImmediatePropagation(); e.preventDefault();
    snap?.clearSnap();
    const body = hitBody ? { body: keyOf(hitBody) } : {};
    if (using === 'path') { penDown(e, p, body); return; }
    if (using === 'text') { startText(p, e, body.body); return; }
    if (using === 'image') {
      if (!picked) { fileInput.click(); return; }
      const fr = faceFrame(e);
      current = { id: uid(), kind: 'image', ...body, src: picked.src, aspect: picked.aspect, name: picked.name, size: +(orbit.dist * 0.15).toFixed(4), ...(fr ?? {}) };
      current.points = [toRest(current, p)];
      current.origin = p; current.n = fr ? fr.normal : null;
      canvas.setPointerCapture(e.pointerId);
      last = { x: e.clientX, y: e.clientY, id: e.pointerId };
      rebuild();
      return;
    }
    canvas.setPointerCapture(e.pointerId);
    last = { x: e.clientX, y: e.clientY, id: e.pointerId };
    if (using === 'pen') { current = { id: uid(), kind: 'pen', ...body, ...pen }; current.points = [toRest(current, p)]; }
    else if (using === 'arrow') { current = { id: uid(), kind: 'arrow', ...body, ...pen, ...faceFrame(e) }; const q = toRest(current, p); current.points = [q, q]; }
    else if (using === 'note') { startNote(p, e, null, body.body); }   // startNote reads pen for its colour
    rebuild();
  }, { capture: true });

  canvas.addEventListener('pointermove', (e) => {
    if (handle && e.pointerId === handle.id) { e.stopImmediatePropagation(); penMove(e); return; }
    if (!current) {   // ARROW, PEN: light up the point or edge it would land on (not while the view is dragged)
      if ((tool === 'arrow' || tool === 'path') && !e.buttons && e.pointerType !== 'touch') { const lit = snap?.showSnap(e); canvas.style.cursor = lit ? 'cell' : 'crosshair'; }
      if (draft && tool === 'path' && !e.buttons) { hoverP = snap?.snapAt(e)?.toArray() ?? pointAt(e); rebuild(); }
      return;
    }
    if (!mine(e)) return;
    e.stopImmediatePropagation();
    if (current.kind === 'pen') {
      if (Math.hypot(e.clientX - last.x, e.clientY - last.y) < 3) return;
      const p = pointAt(e); if (!p) return;
      current.points.push(toRest(current, p)); last.x = e.clientX; last.y = e.clientY;   // keep last.id: it is how the stroke knows its pointer
    } else if (current.kind === 'image') {
      // the drag's reach from the centre is half the picture's width
      if (Math.hypot(e.clientX - last.x, e.clientY - last.y) < 4) return;
      const o = V3(current.origin), n = current.n ? V3(current.n) : getCamera().getWorldDirection(new THREE.Vector3());
      const q = onPlane(e, o, n);
      if (!q) return;
      current.size = +(V3(q).distanceTo(o) * 2).toFixed(4);
    } else if (current.kind === 'arrow') {
      // the tail (text end) slides on the plane of the face the head is on; edge-on or off a face, on
      // the plane through the head that faces the camera, and the text then faces the screen
      const head = new THREE.Vector3(...toWorld(current, current.points[1]));
      let p = current.normal && onPlane(e, head, new THREE.Vector3(...current.normal));
      if (!p) {
        delete current.normal; delete current.up;
        const n = new THREE.Vector3(); getCamera().getWorldDirection(n);
        p = onPlane(e, head, n);
      }
      if (!p) return;
      current.points[0] = toRest(current, p);
    }
    rebuild();
  }, { capture: true });

  canvas.addEventListener('pointerleave', () => { if (!current) snap?.clearSnap(); });

  canvas.addEventListener('pointerup', (e) => {
    if (handle && e.pointerId === handle.id) { e.stopImmediatePropagation(); handle = null; rebuild(); return; }
    if (!mine(e)) return;
    e.stopImmediatePropagation();
    if (!current) return;
    const ok = current.kind === 'pen' ? current.points.length > 1 : true;   // an arrow with no drag is a dot
    if (ok) {
      const { origin, n, ...rest } = current;   // an image's drag helpers stay out of the saved mark
      const item = { ...rest, at: new Date().toISOString() };
      items.push(item); changed();
      if (item.kind === 'arrow') startNote(toWorld(item, item.points[0]), e, item);   // an arrow says something: ask what, where the drag ended
    }
    current = null;
    rebuild();
  }, { capture: true });

  /** Note input at p; with `item`, the text goes on that item (an arrow) instead of a new note. */
  function startNote(p, e, item = null, body = undefined) {   // p in world space
    noteInput?.remove();
    const el = document.createElement('input');
    el.className = 'note-input';
    el.placeholder = 'note… (Enter)';
    const s = toScreen(p);
    el.style.left = `${s.x}px`; el.style.top = `${s.y}px`;
    layer.appendChild(el);
    noteInput = el;
    setTimeout(() => el.focus(), 0);
    let finished = false;   // Enter removes the input, which blurs it — one commit, not two
    const done = (commit) => {
      if (finished) return;
      finished = true;
      if (commit && el.value.trim()) {
        // By id: the server's change echo reloads `items` while the user types, so `item` may be stale.
        const live = item && (items.find((i) => i.id === item.id) || item);
        if (live) live.text = el.value.trim();
        else { const n = { id: uid(), kind: 'note', body, text: el.value.trim(), color: pen.color, at: new Date().toISOString() }; n.points = [toRest(n, p)]; items.push(n); }
        changed();
      }
      el.remove(); noteInput = null; rebuild();
    };
    el.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') done(true); else if (ev.key === 'Escape') done(false); ev.stopPropagation(); });
    el.addEventListener('blur', () => done(true));
  }

  function eraseAt(e) {
    const r = canvas.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    let best = null, bestD = 12;
    for (const item of items) {
      for (const p of item.points) {
        const s = toScreen(toWorld(item, p));
        const d = Math.hypot(s.x - x, s.y - y);
        if (d < bestD) { bestD = d; best = item; }
      }
    }
    if (best) { items = items.filter((i) => i !== best); changed(); }
    return !!best;
  }
  /** Is there a mark within reach of the pointer (what ERASE would take)? */
  const markNear = (e) => {
    const r = canvas.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    return items.some((item) => item.points.some((p) => { const s = toScreen(toWorld(item, p)); return Math.hypot(s.x - x, s.y - y) < 12; }));
  };

  function changed() { onChange?.(items); }

  // --------------------------------------------------------------- tools

  function setTool(name) {
    finishDraft();   // leaving (or re-picking) the pen ends its path, open
    tool = tool === name ? null : name;
    for (const b of document.querySelectorAll('[data-tool]')) b.classList.toggle('on', b.dataset.tool === tool);   // ADD AN IMAGE sits by the planes, not in the markup bar
    canvas.style.cursor = tool ? 'crosshair' : '';
    if (tool !== 'arrow' && tool !== 'path') snap?.clearSnap();
    if (tool === 'image') { picked = null; fileInput.click(); }   // choose the picture, then click (or drag) on a face
    if (!tool) { current = null; rebuild(); }
  }
  function setPen(next) {
    pen = { ...pen, ...next };
    try { localStorage.setItem(PEN_KEY, JSON.stringify(pen)); } catch {}
    for (const b of tools.querySelectorAll('[data-color]')) b.classList.toggle('on', b.dataset.color === pen.color);
    for (const b of tools.querySelectorAll('[data-width]')) b.classList.toggle('on', +b.dataset.width === pen.width);
  }
  setPen({});
  tools.addEventListener('click', (e) => {
    const b = e.target.closest('[data-tool]');
    if (b) { setTool(b.dataset.tool); return; }
    const c = e.target.closest('[data-color]'); if (c) { setPen({ color: c.dataset.color }); return; }
    const w = e.target.closest('[data-width]'); if (w) { setPen({ width: +w.dataset.width }); return; }
    if (e.target.closest('[data-clear]')) { items = []; changed(); rebuild(); }
  });

  // ------------------------------------------------------------ snapshot

  /** One PNG of what the user sees: the live render with notes drawn on. */
  function snapshot() {
    renderer.render(scene, getCamera());
    const c = document.createElement('canvas');
    c.width = canvas.width; c.height = canvas.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(canvas, 0, 0);
    const k = canvas.width / canvas.getBoundingClientRect().width;
    ctx.font = `${13 * k}px "Space Mono", monospace`;
    ctx.textBaseline = 'bottom';
    for (const item of items) {
      if (!item.text || item.normal) continue;   // planar text is in the render already
      const s = toScreen(toWorld(item, item.points[0]));
      if (s.behind) continue;
      const text = item.text, w = ctx.measureText(text).width + 12 * k, h = 20 * k;
      ctx.fillStyle = '#ffffff'; ctx.fillRect(s.x * k - w / 2, s.y * k - 12 * k - h, w, h);
      ctx.strokeStyle = item.color || COLOR; ctx.lineWidth = k; ctx.strokeRect(s.x * k - w / 2, s.y * k - 12 * k - h, w, h);
      ctx.fillStyle = '#000000'; ctx.fillText(text, s.x * k - w / 2 + 6 * k, s.y * k - 12 * k - 3 * k);
    }
    return c.toDataURL('image/png');
  }

  return {
    setTool, projectLabels, snapshot, group,
    get items() { return items; },
    load(list) { items = Array.isArray(list) ? list : []; rebuild(); },
    get active() { return !!tool; },
  };
}
