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

export function createMarkup({ THREE, renderer, scene, getCamera, orbit, getTargets, layer, tools, onChange }) {
  const group = new THREE.Group();
  group.renderOrder = 5;
  scene.add(group);
  const raycaster = new THREE.Raycaster();
  const COLOR = '#d11d1d', WIDTH = 1;   // what items without a colour or width (older files) get
  // The pen: colour + width (px) for the next mark, kept per viewer
  const PEN_KEY = 'cadgang.pen';
  let pen = { color: COLOR, width: 2 };
  try { pen = { ...pen, ...JSON.parse(localStorage.getItem(PEN_KEY) || '{}') }; } catch {}
  // Fat lines (a WebGL line is always 1 px): one pair of materials per colour+width, resolution kept per frame
  const mats = new Map();
  const matFor = (color = COLOR, width = WIDTH) => {
    const k = `${color}/${width}`;
    if (!mats.has(k)) mats.set(k, { line: new LineMaterial({ color, linewidth: width, depthTest: false, transparent: true }), solid: new THREE.MeshBasicMaterial({ color, depthTest: false }) });
    return mats.get(k);
  };
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
  function pointAt(e) {
    const cam = getCamera();
    raycaster.setFromCamera(ndc(e), cam);
    const hit = raycaster.intersectObjects(getTargets(), false)[0];
    hitBody = hit?.object ?? null;
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
    raycaster.setFromCamera(ndc(e), cam);
    const hit = raycaster.intersectObjects(getTargets(), false)[0];
    if (!hit?.face) return null;
    const n = hit.face.normal.clone().transformDirection(hit.object.matrixWorld).normalize();
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
    const { line: lineMat, solid: solidMat } = matFor(item.color, item.width);
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
    } else if (item.kind === 'note') {
      const dot = new THREE.Mesh(new THREE.SphereGeometry(scale * 0.25, 12, 8), solidMat);
      dot.position.copy(pts[0]);
      objs.push(dot);
    }
    const holder = new THREE.Group();   // moved by the part's explode offset each frame
    holder.userData.item = item; holder.position.copy(shift(item));
    for (const o of objs) { o.renderOrder = Math.max(o.renderOrder, 5); o.userData.item = item; holder.add(o); }
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
    ctx.strokeStyle = item.color || COLOR; ctx.lineWidth = 4; ctx.strokeRect(2, 2, c.width - 4, c.height - 4);
    ctx.font = `${px}px "Space Mono", monospace`; ctx.fillStyle = '#000000'; ctx.textBaseline = 'middle';
    ctx.fillText(item.text, px / 2, c.height / 2);
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
    const h = scale * 1.1, w = h * c.width / c.height;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex, depthTest: false, transparent: true, side: THREE.DoubleSide }));
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

  function rebuild() {
    for (const o of [...group.children]) { group.remove(o); o.traverse((x) => { x.geometry?.dispose(); if (x.userData.own) { x.material.map?.dispose(); x.material.dispose(); } }); }
    for (const l of layer.querySelectorAll('.note-label')) l.remove();
    for (const item of items) {
      build(item);
      if (item.text && !item.normal) {   // planar text is in the scene already
        const el = document.createElement('div');
        el.className = 'note-label';
        el.textContent = item.text || '…';
        el.dataset.id = item.id;
        el.style.borderColor = item.color || COLOR;
        layer.appendChild(el);
      }
    }
    if (current) build(current);
  }

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
  const mine = (e) => (current ? e.pointerId === last.id : !!tool);

  canvas.addEventListener('pointerdown', (e) => {
    const using = e.button === 0 ? toolFor(e) : null;
    if (!using) return;
    e.stopImmediatePropagation(); e.preventDefault();
    if (current) return;   // a second finger mid-stroke: neither draws nor orbits
    const p = pointAt(e);
    if (!p) return;
    canvas.setPointerCapture(e.pointerId);
    last = { x: e.clientX, y: e.clientY, id: e.pointerId };
    const body = hitBody ? { body: keyOf(hitBody) } : {};
    if (using === 'pen') { current = { id: uid(), kind: 'pen', ...body, ...pen }; current.points = [toRest(current, p)]; }
    else if (using === 'arrow') { current = { id: uid(), kind: 'arrow', ...body, ...pen, ...faceFrame(e) }; const q = toRest(current, p); current.points = [q, q]; }
    else if (using === 'note') { startNote(p, e, null, body.body); }   // startNote reads pen for its colour
    else if (using === 'erase') { eraseAt(e); }
    rebuild();
  }, { capture: true });

  canvas.addEventListener('pointermove', (e) => {
    if (!mine(e)) return;
    e.stopImmediatePropagation();
    if (!current) return;
    if (current.kind === 'pen') {
      if (Math.hypot(e.clientX - last.x, e.clientY - last.y) < 3) return;
      const p = pointAt(e); if (!p) return;
      current.points.push(toRest(current, p)); last = { x: e.clientX, y: e.clientY };
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

  canvas.addEventListener('pointerup', (e) => {
    if (!mine(e)) return;
    e.stopImmediatePropagation();
    if (!current) return;
    const ok = current.kind === 'pen' ? current.points.length > 1 : true;   // an arrow with no drag is a dot
    if (ok) {
      const item = { ...current, at: new Date().toISOString() };
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
  }

  function changed() { onChange?.(items); }

  // --------------------------------------------------------------- tools

  function setTool(name) {
    tool = tool === name ? null : name;
    for (const b of tools.querySelectorAll('[data-tool]')) b.classList.toggle('on', b.dataset.tool === tool);
    canvas.style.cursor = tool ? 'crosshair' : '';
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
