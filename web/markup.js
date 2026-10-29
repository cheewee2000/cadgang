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

export function createMarkup({ THREE, renderer, scene, getCamera, orbit, getTargets, layer, tools, onChange, snap = null, planeAt = null, say = () => {}, tipAt = () => {} }) {
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
  let editId = null, imgDrag = null;   // the picture being edited (by id: the server's echo replaces items), and its drag
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
  // A part moves by its explode offset and by its joint (a turn about an axis), so a mark rides its pose, not just its position.
  const IDENT = new THREE.Matrix4();
  const bodyOf = (item) => (item.body && byKey(item.body)) || null;
  const poseOf = (item) => { const b = bodyOf(item); if (!b) return IDENT; b.updateMatrix(); return b.matrix; };
  const toWorld = (item, p) => new THREE.Vector3(...p).applyMatrix4(poseOf(item)).toArray();
  const toRest = (item, p) => new THREE.Vector3(...p).applyMatrix4(poseOf(item).clone().invert()).toArray();
  const follow = (holder, item) => { const b = bodyOf(item); if (b) { holder.position.copy(b.position); holder.quaternion.copy(b.quaternion); } else { holder.position.set(0, 0, 0); holder.quaternion.identity(); } };
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
  // The pencil follows the part's surfaces, face to face. Off the part (past its edge, or over a reference
  // plane or the ground behind it) it carries on in the plane of the face it last touched, so a stroke
  // never jumps onto a plane — unless it started on one; then it draws on planes as any mark does.
  let penRef = null, penOnRef = false;
  function penAt(e) {
    if (penOnRef) return pointAt(e);
    raycaster.setFromCamera(ndc(e), getCamera());
    const hit = raycaster.intersectObjects(getTargets(), false)[0];
    if (hit?.face) { penRef = { o: hit.point.clone(), n: hit.face.normal.clone().transformDirection(hit.object.matrixWorld).normalize() }; return hit.point.toArray(); }
    if (!penRef) return pointAt(e);
    return onPlane(e, penRef.o, penRef.n) ?? onPlane(e, penRef.o, getCamera().getWorldDirection(new THREE.Vector3()));   // that face edge-on: square to the eye
  }
  // Where the pointer meets the plane through `origin` with normal `n` (null when that plane is edge-on).
  function onPlane(e, origin, n) {
    raycaster.setFromCamera(ndc(e), getCamera());
    if (Math.abs(raycaster.ray.direction.dot(n)) < 0.15) return null;
    const p = new THREE.Vector3();
    return raycaster.ray.intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(n, origin), p) ? p.toArray() : null;
  }

  // Square to a view (front, top, right… within a degree): a pen line or path is drawn flat, on the plane
  // through where it starts that faces the eye, instead of following the model's depth point by point.
  // Saved on the mark as plane {o (rest frame), n (world)}; its anchors and drags stay on that plane.
  const SQUARE = Math.cos(Math.PI / 180);
  function squareAxis() {
    const d = getCamera().getWorldDirection(new THREE.Vector3());
    for (const a of [[1, 0, 0], [0, 1, 0], [0, 0, 1]]) {
      const v = new THREE.Vector3(...a), k = d.dot(v);
      if (Math.abs(k) > SQUARE) return v.multiplyScalar(-Math.sign(k));   // pointing back at the eye
    }
    return null;
  }
  const flatPlane = (item) => item.plane && { o: new THREE.Vector3(...toWorld(item, item.plane.o)), n: new THREE.Vector3(...item.plane.n) };
  /** Where the pointer meets the mark's flat plane (world), or null. */
  function flatAt(e, item) { const f = flatPlane(item); return f ? onPlane(e, f.o, f.n) : null; }
  /** A world point pushed onto the mark's flat plane along its normal (a snap stays where it was seen). */
  function flatten(item, p) {
    const f = flatPlane(item); if (!f || !p) return p;
    const q = new THREE.Vector3(...p);
    return q.addScaledVector(f.n, -q.clone().sub(f.o).dot(f.n)).toArray();
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
      objs.push(dotAt(pts[1], 0.012 * 0.3, solidMat));   // a leader ends in a dot
    } else if (item.kind === 'path' && pts.length > 1) {
      objs.push(fatLine(pts, lineMat));
    } else if (item.kind === 'text' && item.text) {
      objs.push(item.normal ? flatText(item, pts[0]) : null);
    } else if (item.kind === 'image' && item.src) {
      objs.push(picture(item, pts[0]));
    } else if (item.kind === 'note') {
      objs.push(dotAt(pts[0], 0.012 * 0.25, solidMat));
    }
    const holder = new THREE.Group();   // moved by the part's explode offset each frame
    holder.userData.item = item; follow(holder, item);
    for (const o of objs.filter(Boolean)) { o.renderOrder = Math.max(o.renderOrder, 5); o.userData.item = item; holder.add(o); }
    group.add(holder);
    return objs;
  }

  // A dot that stays the same size on screen: a unit sphere, scaled to k × the camera distance every frame
  // (projectLabels), so a zoom after the mark was built does not leave it the old size.
  function dotAt(p, k, mat) {
    const dot = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), mat);
    dot.position.copy(p); dot.userData.dotK = k; dot.scale.setScalar(orbit.dist * k);
    return dot;
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
    const moving = item === current || (imgDrag && item.id === editId);
    const part = !moving && item.body && byKey(item.body);   // while it is placed, moved or sized: flat, the projection waits for the release
    let geo = null;
    if (part?.isMesh) {
      part.geometry.computeBoundingBox();
      const key = `${item.id}|${w}|${item.aspect}|${item.crop?.join()}|${item.points[0].join()}|${item.normal?.join()}|${item.up?.join()}|${part.geometry.boundingBox.min.toArray().join()}|${part.quaternion.toArray().map((v) => v.toFixed(4)).join()}`;
      geo = decals.get(key);
      if (!geo) {
        // projected onto the part in its pose now (explode offset, joint turn), then brought back to its rest frame
        part.updateMatrix(); part.updateMatrixWorld(true);
        const M = part.matrix, world = at.clone().applyMatrix4(M);
        const turned = new THREE.Matrix4().extractRotation(M).multiply(basis);
        geo = new DecalGeometry(part, world, new THREE.Euler().setFromRotationMatrix(turned), new THREE.Vector3(w, h, Math.max(w, h) * 0.6));
        geo.applyMatrix4(M.clone().invert());
        if (!geo.getAttribute('position').count) { geo.dispose(); geo = null; }
        else { cropUV(geo, item.crop); decals.set(key, geo); }
      }
    }
    const mesh = geo ? new THREE.Mesh(geo, mat) : new THREE.Mesh(cropUV(new THREE.PlaneGeometry(w, h), item.crop), mat);
    if (!geo) { mesh.quaternion.setFromRotationMatrix(basis); mesh.position.copy(at).addScaledVector(n, w * 0.002); }
    mesh.renderOrder = 4;
    mesh.userData.keepGeo = !!geo;   // a cached decal outlives a rebuild
    mesh.userData.own = true;
    if (item.id !== editId) return mesh;
    // being edited: its outline, and a dot at each corner to drag for size
    const g = new THREE.Group(); g.add(mesh);
    const lift = n.clone().multiplyScalar(w * 0.004);
    const cs = imageCorners(item, at).map((c) => c.add(lift));
    g.add(fatLine([...cs, cs[0]], matFor('#2f5d8a', 2).line));
    for (const c of cs) { const d = new THREE.Mesh(new THREE.SphereGeometry(orbit.dist * 0.004, 10, 8), matFor('#2f5d8a', 2).solid); d.position.copy(c); g.add(d); }
    g.traverse((x) => { x.renderOrder = Math.max(x.renderOrder, 4); });
    return g;
  }
  /** Show only a window of the picture: crop [u0, v0, u1, v1] of the whole image (0..1, v up). */
  function cropUV(geo, crop) {
    if (!crop) return geo;
    const uv = geo.getAttribute('uv');
    for (let i = 0; i < uv.count; i++) uv.setXY(i, crop[0] + uv.getX(i) * (crop[2] - crop[0]), crop[1] + uv.getY(i) * (crop[3] - crop[1]));
    uv.needsUpdate = true;
    return geo;
  }
  /** A picture's corners in its rest frame: centre ± half its width along its right, ± half its height along its up. */
  function imageCorners(item, at = V3(item.points[0])) {
    const w = item.size, h = w / (item.aspect || 1), n = V3(item.normal ?? [0, 0, 1]), u = V3(item.up ?? [0, 1, 0]), r = u.clone().cross(n);
    return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => at.clone().addScaledVector(r, a * w / 2).addScaledVector(u, b * h / 2));
  }

  // Double-click a picture to edit it: drag it to move it (over the part's surface, or within its
  // plane), drag a corner dot to size it; ⌫ deletes it, Esc, Enter or a click elsewhere is done.
  const editing = () => (editId ? items.find((i) => i.id === editId) ?? null : null);
  function imageUnder(e) {
    raycaster.setFromCamera(ndc(e), getCamera());
    const h = raycaster.intersectObjects(group.children, true).find((x) => x.object.userData.item?.kind === 'image' || x.object.parent?.userData.item?.kind === 'image');
    const it = h && (h.object.userData.item ?? h.object.parent.userData.item);
    return it ? items.find((i) => i.id === it.id) ?? null : null;
  }
  // Where the pointer is on the picture being edited, as Figma reads it: on a corner dot (size; with ⌘,
  // crop), just outside a corner (rotate), on an edge's middle with ⌘ (crop that edge), inside (move).
  const ROTATE_CURSOR = `url("data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><path d="M5 12a7 7 0 1 1 3 5.7" fill="none" stroke="white" stroke-width="4"/><path d="M5 12a7 7 0 1 1 3 5.7" fill="none" stroke="black" stroke-width="1.6"/><path d="M2 9l3 4 3-4" fill="black" stroke="white" stroke-width="1"/></svg>')}") 12 12, alias`;
  function zoneAt(e, ed) {
    const r = canvas.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    const at = V3(toWorld(ed, ed.points[0])), cs = imageCorners(ed, at), sc = cs.map((c) => toScreen(c.toArray()));
    const ctr = toScreen(at.toArray());
    for (let i = 0; i < 4; i++) {
      const d = Math.hypot(sc[i].x - x, sc[i].y - y);
      if (d < 10) return { kind: 'corner', i };
      // just outside it: farther from the centre than the corner, and within 30 px of it
      const out = Math.hypot(x - ctr.x, y - ctr.y) > Math.hypot(sc[i].x - ctr.x, sc[i].y - ctr.y);
      if (d < 30 && out) return { kind: 'rotate', i };
    }
    if (e.metaKey) for (let i = 0; i < 4; i++) {
      const a = sc[i], b = sc[(i + 1) % 4];
      if (Math.hypot((a.x + b.x) / 2 - x, (a.y + b.y) / 2 - y) < 10) return { kind: 'edge', i };
    }
    return imageUnder(e)?.id === ed.id ? { kind: 'inside' } : null;
  }
  const cursorFor = (z, e) => (!z ? '' : z.kind === 'rotate' ? ROTATE_CURSOR : z.kind === 'corner' ? (e.metaKey ? 'crosshair' : 'nwse-resize') : z.kind === 'edge' ? 'crosshair' : 'move');
  /** The picture's frame on its plane, for a drag: centre, normal, right, up, its visible rect and the whole image's. */
  function frameOf(ed) {
    const at = V3(toWorld(ed, ed.points[0])), n = V3(ed.normal ?? [0, 0, 1]), u = V3(ed.up ?? [0, 1, 0]), r = u.clone().cross(n);
    const w = ed.size, h = w / (ed.aspect || 1), c = ed.crop ?? [0, 0, 1, 1];
    const W = w / (c[2] - c[0]), H = h / (c[3] - c[1]);   // the whole image, at this scale
    const L = -w / 2, B = -h / 2;
    return { at, n, u, r, w, h, L, R: w / 2, B, T: h / 2, FL: L - c[0] * W, FB: B - c[1] * H, W, H };
  }
  const localOn = (e, f) => { const q = onPlane(e, f.at, f.n); if (!q) return null; const d = V3(q).sub(f.at); return { a: d.dot(f.r), b: d.dot(f.u) }; };

  function endEdit() { if (!editId) return; editId = null; imgDrag = null; canvas.style.cursor = tool ? 'crosshair' : ''; rebuild(); }
  canvas.addEventListener('dblclick', (e) => {
    const it = imageUnder(e);
    if (!it) return;
    e.stopImmediatePropagation(); e.preventDefault();   // not the view's re-centre
    editId = it.id; rebuild(); tipAt(null, e);
  }, { capture: true });
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
      if (item.text) {
        const el = document.createElement('div');
        el.className = 'note-label' + (item.done ? ' done' : '');
        el.textContent = item.text;
        el.dataset.id = item.id;
        el.style.setProperty('--tag', item.done ? DONE : item.color || COLOR);
        layer.appendChild(el);
      }
    }
    if (current) build(current);
    if (draft) buildDraft();
    const sel = selected();
    if (sel) buildSelection(sel);
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
    holder.userData.item = draft; follow(holder, draft);
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
  // ⇧ with the pen, as in Figma: the next anchor goes horizontal, vertical or at 45° from the last one,
  // as seen on screen (and a handle being dragged locks the same way about its anchor).
  const STEP45 = Math.PI / 4;
  function lockScreen(e, fromWorld) {
    const r = canvas.getBoundingClientRect(), o = toScreen(fromWorld.toArray());
    const dx = e.clientX - r.left - o.x, dy = e.clientY - r.top - o.y;
    const ang = Math.round(Math.atan2(dy, dx) / STEP45) * STEP45, len = dx * Math.cos(ang) + dy * Math.sin(ang);
    return { clientX: r.left + o.x + Math.cos(ang) * len, clientY: r.top + o.y + Math.sin(ang) * len };
  }
  /** Where the pen's next anchor goes for this pointer: locked with ⇧ (on the model or a plane there, else in the
   *  plane through the last anchor facing the eye), otherwise the snap or the surface under the pointer. */
  function penPoint(e) {
    if (!(e.shiftKey && draft?.nodes.length)) return null;
    const lastW = V3(toWorld(draft, draft.nodes[draft.nodes.length - 1].p)), at = lockScreen(e, lastW);
    const p = pointAt(at);
    if (hitBody || hitPlane) return p;
    return onPlane(at, lastW, getCamera().getWorldDirection(new THREE.Vector3()));
  }
  function penDown(e, p, body) {
    // on the first anchor again: close the shape
    if (draft && draft.nodes.length > 1) {
      const f = toScreen(toWorld(draft, draft.nodes[0].p)), r = canvas.getBoundingClientRect();
      if (Math.hypot(f.x - (e.clientX - r.left), f.y - (e.clientY - r.top)) < 10) { draft.closed = true; finishDraft(); return; }
    }
    if (!draft) {
      draft = { id: uid(), kind: 'path', ...body, ...pen, nodes: [] };
      const sq = squareAxis();
      if (sq) draft.plane = { o: toRest(draft, p), n: sq.toArray() };   // square to a view: the path is flat
    }
    p = flatten(draft, p);
    const node = { p: toRest(draft, p), in: [0, 0, 0], out: [0, 0, 0] };
    draft.nodes.push(node);
    const fr = draft.plane ? null : faceFrame(e), n = draft.plane ? V3(draft.plane.n) : fr ? V3(fr.normal) : new THREE.Vector3();
    if (!fr && !draft.plane) getCamera().getWorldDirection(n);
    handle = { node, origin: V3(p), n, id: e.pointerId, x: e.clientX, y: e.clientY };
    canvas.setPointerCapture(e.pointerId);
    rebuild();
  }
  function penMove(e) {
    if (Math.hypot(e.clientX - handle.x, e.clientY - handle.y) < 3) return;   // a click, not a drag: a corner
    const at = e.shiftKey ? lockScreen(e, handle.origin) : e;   // ⇧: the handle at 0°, 45°, 90°…
    let q = onPlane(at, handle.origin, handle.n);
    if (!q) { const n = new THREE.Vector3(); getCamera().getWorldDirection(n); q = onPlane(at, handle.origin, n); }
    if (!q) return;
    const out = V3(q).sub(handle.origin);
    handle.node.out = out.toArray().map((v) => +v.toFixed(4));
    handle.node.in = out.negate().toArray().map((v) => +v.toFixed(4));   // mirrored, as Figma's pen
    rebuild();
  }
  window.addEventListener('keydown', (e) => {
    if (!editId || e.target.matches?.('input,textarea')) return;
    if (e.key === 'Backspace' || e.key === 'Delete') { items = items.filter((i) => i.id !== editId); editId = null; changed(); rebuild(); }
    else if (e.key === 'Escape' || e.key === 'Enter') endEdit();
    else return;
    e.preventDefault(); e.stopImmediatePropagation();
  }, { capture: true });
  window.addEventListener('keydown', (e) => {
    if (!draft || e.target.matches?.('input,textarea')) return;
    if (e.key === 'Enter' || e.key === 'Escape') { finishDraft(); }
    else if (e.key === 'Backspace' || e.key === 'Delete') { draft.nodes.pop(); if (!draft.nodes.length) draft = null; rebuild(); }
    else return;
    e.preventDefault(); e.stopImmediatePropagation();
  }, { capture: true });

  // Esc twice, as in Figma: the first ends the path being drawn (the pen stays up for the next one), the
  // second, with nothing being drawn, puts the tool down. (The draft's own Esc above runs first and stops here.)
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !tool || draft || current || noteInput || e.target.matches?.('input,textarea')) return;
    setTool(null);
    e.preventDefault(); e.stopImmediatePropagation();
  }, { capture: true });

  // ------------------------------------------------------------- select and edit a line (Figma's)
  //
  // With no tool chosen, a click on a pen line or path selects it: its anchors and handles show. Drag the
  // line to move it, an anchor to move that anchor (its handles come along), a handle to bend the curve
  // (the opposite handle mirrors its angle; ⌥ moves one alone). ⌫ deletes it, Esc or a click elsewhere
  // is done. Drags run on the mark's flat plane when it has one, else on the plane through the grabbed
  // point that faces the eye.
  let selId = null, selDrag = null, lineCursor = false;
  const SEL = '#2f5d8a';
  const selected = () => (selId ? items.find((i) => i.id === selId) ?? null : null);
  const editable = (it) => it.kind === 'path' || it.kind === 'pen';
  const pxAt = (e) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  function segDist(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y, l = dx * dx + dy * dy;
    const t = l ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l)) : 0;
    return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
  }
  /** The pen line or path drawn under the pointer (within 6 px of its stroke), topmost first. */
  function lineAt(e) {
    const m = pxAt(e);
    for (const it of [...items].reverse()) {
      if (!editable(it) || it.points.length < 2) continue;
      const s = it.points.map((q) => toScreen(toWorld(it, q)));
      for (let i = 0; i + 1 < s.length; i++) if (!s[i].behind && !s[i + 1].behind && segDist(m, s[i], s[i + 1]) < 6 + (it.width || 1) / 2) return it;
    }
    return null;
  }
  /** On the selected mark: an anchor or a handle end (paths), else the stroke itself. */
  function selZone(e, it) {
    const m = pxAt(e), near = (q) => { const s = toScreen(toWorld(it, q)); return Math.hypot(s.x - m.x, s.y - m.y) < 9; };
    if (it.kind === 'path') {
      for (let i = 0; i < it.nodes.length; i++) {
        const n = it.nodes[i];
        for (const which of ['out', 'in']) if (V3(n[which]).lengthSq() > 0 && near(V3(n.p).add(V3(n[which])).toArray())) return { kind: 'handle', i, which };
      }
      for (let i = 0; i < it.nodes.length; i++) if (near(it.nodes[i].p)) return { kind: 'anchor', i };
    }
    return lineAt(e)?.id === it.id ? { kind: 'line' } : null;
  }
  function buildSelection(it) {
    const holder = new THREE.Group();
    holder.userData.item = it; follow(holder, it);
    const add = (o) => { o.renderOrder = 8; holder.add(o); };
    const { line, solid } = matFor(SEL, 1);
    const r = orbit.dist * 0.004;
    const dot = (p, size, mat) => { const m = new THREE.Mesh(new THREE.SphereGeometry(size, 10, 8), mat); m.position.copy(p); add(m); };
    const white = new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false });
    add(fatLine(it.points.map(V3), line));   // the stroke outlined in blue
    if (it.kind === 'path') {
      for (const n of it.nodes) {
        const a = V3(n.p);
        for (const h of [n.in, n.out]) if (V3(h).lengthSq() > 0) { add(fatLine([a, a.clone().add(V3(h))], line)); dot(a.clone().add(V3(h)), r * 0.7, solid); }
        dot(a, r * 1.3, solid); dot(a, r * 0.8, white);   // anchors: hollow squares in Figma, hollow dots here
      }
    } else {
      dot(V3(it.points[0]), r, solid); dot(V3(it.points[it.points.length - 1]), r, solid);
    }
    group.add(holder);
  }
  function selectNone() { if (!selId) return; selId = null; selDrag = null; canvas.style.cursor = tool ? 'crosshair' : ''; rebuild(); }
  /** Start a drag on the selected mark from this press. */
  function selStart(e, it, zone) {
    const f = flatPlane(it);
    const grab = zone.kind === 'anchor' ? V3(toWorld(it, it.nodes[zone.i].p))
      : zone.kind === 'handle' ? V3(toWorld(it, V3(it.nodes[zone.i].p).add(V3(it.nodes[zone.i][zone.which])).toArray()))
      : V3(pointAt(e) ?? toWorld(it, it.points[0]));
    const n = f ? f.n : getCamera().getWorldDirection(new THREE.Vector3()).negate();
    const o = f ? V3(flatten(it, grab.toArray())) : grab;
    const start = onPlane(e, o, n);
    if (!start) return false;
    selDrag = { zone, id: e.pointerId, o, n, start: V3(start), orig: JSON.parse(JSON.stringify({ nodes: it.nodes, points: it.points, plane: it.plane })) };
    canvas.setPointerCapture(e.pointerId);
    return true;
  }
  /** A rest-frame point moved by a world-space delta. */
  const shifted = (it, rest, d) => toRest(it, V3(toWorld(it, rest)).add(d).toArray());
  function selMove(e) {
    const it = selected(); if (!it) { selDrag = null; return; }
    const q = onPlane(e, selDrag.o, selDrag.n); if (!q) return;
    const d = V3(q).sub(selDrag.start), { zone, orig } = selDrag;
    if (zone.kind === 'line') {
      if (it.kind === 'path') it.nodes = orig.nodes.map((n) => ({ ...n, p: shifted(it, n.p, d) }));
      else it.points = orig.points.map((p) => shifted(it, p, d));
      if (orig.plane) it.plane = { ...orig.plane, o: shifted(it, orig.plane.o, d) };
    } else if (zone.kind === 'anchor') {
      it.nodes = orig.nodes.map((n, i) => (i === zone.i ? { ...n, p: shifted(it, n.p, d) } : n));
    } else {   // a handle: its end follows the pointer, kept as an offset from its anchor
      const n0 = orig.nodes[zone.i], a = V3(n0.p);
      const end = V3(shifted(it, a.clone().add(V3(n0[zone.which])).toArray(), d));
      const h = end.sub(a), other = zone.which === 'out' ? 'in' : 'out';
      const node = { ...n0, [zone.which]: h.toArray().map((v) => +v.toFixed(4)) };
      const len = V3(n0[other]).length();
      if (!e.altKey && len > 0 && h.lengthSq() > 0) node[other] = h.clone().normalize().multiplyScalar(-len).toArray().map((v) => +v.toFixed(4));
      it.nodes = orig.nodes.map((n, i) => (i === zone.i ? node : n));
    }
    if (it.kind === 'path') it.points = curvePoints(it.nodes, it.closed);
    rebuild();
  }
  window.addEventListener('keydown', (e) => {
    if (!selId || e.target.matches?.('input,textarea')) return;
    if (e.key === 'Backspace' || e.key === 'Delete') { items = items.filter((i) => i.id !== selId); selId = null; selDrag = null; changed(); rebuild(); }
    else if (e.key === 'Escape' || e.key === 'Enter') selectNone();
    else return;
    e.preventDefault(); e.stopImmediatePropagation();
  }, { capture: true });

  // Text is a tag in screen space, not a quad on the face: it stays upright and the same size at any
  // angle or zoom. A tag sits on the arrow's text end (the tail), on the side away from the head, so
  // the leader runs into it; a note's tag sits above its dot. Tags that would overlap are pushed apart.
  const GAP = 8, SPACE = 4;
  let tags = [];   // the last layout: { item, text, x, y, w, h, color } in canvas pixels
  function layoutTags() {
    const r = canvas.getBoundingClientRect(), out = [];
    for (const el of layer.querySelectorAll('.note-label')) {
      const item = items.find((i) => i.id === el.dataset.id);
      if (!item) continue;
      const tail = toScreen(toWorld(item, item.points[0]));
      el.hidden = tail.behind;
      if (tail.behind) continue;
      const w = el.offsetWidth, h = el.offsetHeight;
      let dx = 0, dy = -1;   // which way the tag lies from its anchor
      if (item.kind === 'arrow' && item.points[1]) {
        const head = toScreen(toWorld(item, item.points[1]));
        if (Math.hypot(tail.x - head.x, tail.y - head.y) > 10) { dx = tail.x - head.x; dy = tail.y - head.y; }
      }
      let x, y;
      if (Math.abs(dx) >= Math.abs(dy) * 0.6) { x = dx > 0 ? tail.x + GAP : tail.x - GAP - w; y = tail.y - h / 2; }
      else { x = tail.x - w / 2; y = dy > 0 ? tail.y + GAP : tail.y - GAP - h; }
      x = Math.max(SPACE, Math.min(r.width - w - SPACE, x));
      y = Math.max(SPACE, Math.min(r.height - h - SPACE, y));
      out.push({ el, item, text: item.text, x, y, w, h, color: item.color || COLOR });
    }
    out.sort((a, b) => a.y - b.y || a.x - b.x);
    for (let i = 0; i < out.length; i++) {
      for (let j = 0; j < i; j++) {
        const a = out[j], b = out[i];
        if (b.x < a.x + a.w + SPACE && a.x < b.x + b.w + SPACE && b.y < a.y + a.h + SPACE && a.y < b.y + b.h + SPACE) b.y = a.y + a.h + SPACE;
      }
      out[i].y = Math.min(out[i].y, r.height - out[i].h - SPACE);
    }
    return out;
  }

  /** Called every frame: keep the tags on their anchors. */
  function projectLabels() {
    const r = canvas.getBoundingClientRect();
    for (const m of mats.values()) m.line.resolution.set(r.width, r.height);
    for (const h of group.children) { follow(h, h.userData.item); for (const o of h.children) if (o.userData.dotK) o.scale.setScalar(orbit.dist * o.userData.dotK); }
    tags = layoutTags();
    for (const t of tags) { t.el.style.transform = `translate(${Math.round(t.x)}px, ${Math.round(t.y)}px)`; }
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
    const ed = editing();
    if (ed && e.button === 0) {
      const z = zoneAt(e, ed);
      if (z) {
        e.stopImmediatePropagation(); e.preventDefault();
        const f = frameOf(ed), at = f.at;
        const hit = pointAt(e);
        const mode = z.kind === 'rotate' ? 'rotate' : z.kind === 'edge' || (z.kind === 'corner' && e.metaKey) ? 'crop' : z.kind === 'corner' ? 'size' : 'move';
        imgDrag = { mode, zone: z, id: e.pointerId, grab: hit ? V3(hit).sub(at) : new THREE.Vector3(), f, start: localOn(e, f), crop: [...(ed.crop ?? [0, 0, 1, 1])] };
        canvas.setPointerCapture(e.pointerId);
        rebuild();
        return;
      }
      endEdit();   // a press elsewhere ends the edit; it goes on to the view or a tool
    }
    if (e.button === 0 && !toolFor(e) && !current) {   // no tool: a press on a line selects it and starts its drag
      const sel = selected(), z = sel && selZone(e, sel);
      if (z) { if (selStart(e, sel, z)) { e.stopImmediatePropagation(); e.preventDefault(); } return; }
      const it = lineAt(e);
      if (it) { e.stopImmediatePropagation(); e.preventDefault(); selId = it.id; selStart(e, it, { kind: 'line' }); rebuild(); return; }
      if (sel) selectNone();   // a press elsewhere is done; it goes on to the view
    }
    const using = e.button === 0 ? toolFor(e) : null;
    if (!using) return;
    if (current) { e.stopImmediatePropagation(); e.preventDefault(); return; }   // a second finger mid-stroke: neither draws nor orbits
    if (using !== 'erase' && tagAt(e)) { e.stopImmediatePropagation(); e.preventDefault(); return; }   // a press on a tag is a double-click's first half: no mark under it
    if (using === 'erase') {
      if (!markNear(e)) return;   // nothing to erase here: the view's
      e.stopImmediatePropagation(); e.preventDefault();
      eraseAt(e); rebuild();
      return;
    }
    let p = pointAt(e);
    const locked = using === 'path' ? penPoint(e) : null;   // ⇧ with the pen: on the 45° lines from the last anchor
    if (locked) p = locked;
    // an arrow's head, or a pen anchor, goes exactly on the corner, centre or edge the hover lit up (⌥: anywhere)
    const s = !locked && (using === 'arrow' || using === 'path') && snap?.snapAt(e);
    if (s) p = s.toArray();
    // a flat path (drawn square to a view) takes its next anchors anywhere on its plane, on the model or not
    const flatNext = using === 'path' && draft?.plane && !s && !locked ? flatAt(e, draft) : null;
    if (flatNext) p = flatNext;
    // a mark lives on the model: pressed on nothing, the press is the view's (orbit), and no mark is made
    if (!p || (!hitBody && !hitPlane && !s && !locked && !flatNext)) return;
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
    if (using === 'pen') {
      current = { id: uid(), kind: 'pen', ...body, ...pen }; current.points = [toRest(current, p)];
      penOnRef = !!hitPlane; penRef = null; if (!penOnRef) penAt(e);   // remember the face it starts on
      const sq = squareAxis();
      if (sq) current.plane = { o: current.points[0], n: sq.toArray() };   // square to a view: the stroke is flat
    }
    else if (using === 'arrow') { current = { id: uid(), kind: 'arrow', ...body, ...pen, ...faceFrame(e) }; const q = toRest(current, p); current.points = [q, q]; }
    else if (using === 'note') { startNote(p, e, null, body.body); }   // startNote reads pen for its colour
    rebuild();
  }, { capture: true });

  canvas.addEventListener('pointermove', (e) => {
    if (imgDrag && e.pointerId === imgDrag.id) {
      e.stopImmediatePropagation();
      const ed = editing(); if (!ed) { imgDrag = null; return; }
      const at = V3(toWorld(ed, ed.points[0])), n = V3(ed.normal ?? [0, 0, 1]);
      if (imgDrag.mode === 'size') {
        const q = onPlane(e, at, n); if (!q) return;
        const d = V3(q).sub(at), u = V3(ed.up ?? [0, 1, 0]), r = u.clone().cross(n);
        ed.size = +Math.max(Math.abs(d.dot(r)) * 2, Math.abs(d.dot(u)) * 2 * (ed.aspect || 1), orbit.dist * 0.01).toFixed(4);
      } else if (imgDrag.mode === 'rotate') {   // about its normal, by the pointer's turn round its centre; ⇧ in 15° steps
        const f = imgDrag.f, p = localOn(e, f); if (!p || !imgDrag.start) return;
        let ang = Math.atan2(p.b, p.a) - Math.atan2(imgDrag.start.b, imgDrag.start.a);
        if (e.shiftKey) ang = Math.round(ang / (Math.PI / 12)) * (Math.PI / 12);
        ed.up = f.u.clone().applyAxisAngle(f.n, ang).toArray().map((v) => +v.toFixed(6));
      } else if (imgDrag.mode === 'crop') {
        // the dragged corner or edge moves, within the whole image; the rest of the picture stays on the model
        const f = imgDrag.f, p = localOn(e, f); if (!p) return;
        let { L, R, B, T } = f;
        const min = Math.max(f.w, f.h) * 0.04;
        const z = imgDrag.zone, i = z.i;   // corners 0 ↙ 1 ↘ 2 ↗ 3 ↖; edges 0 bottom, 1 right, 2 top, 3 left
        const left = z.kind === 'corner' ? i === 0 || i === 3 : i === 3, right = z.kind === 'corner' ? i === 1 || i === 2 : i === 1;
        const bottom = z.kind === 'corner' ? i === 0 || i === 1 : i === 0, top = z.kind === 'corner' ? i === 2 || i === 3 : i === 2;
        if (left) L = Math.min(Math.max(p.a, f.FL), R - min);
        if (right) R = Math.max(Math.min(p.a, f.FL + f.W), L + min);
        if (bottom) B = Math.min(Math.max(p.b, f.FB), T - min);
        if (top) T = Math.max(Math.min(p.b, f.FB + f.H), B + min);
        const at = f.at.clone().addScaledVector(f.r, (L + R) / 2).addScaledVector(f.u, (B + T) / 2);
        ed.points = [toRest(ed, at.toArray())];
        ed.size = +(R - L).toFixed(4); ed.aspect = +((R - L) / (T - B)).toFixed(6);
        ed.imgAspect ??= +(f.W / f.H).toFixed(6);
        ed.crop = [(L - f.FL) / f.W, (B - f.FB) / f.H, (R - f.FL) / f.W, (T - f.FB) / f.H].map((v) => +v.toFixed(5));
      } else if (ed.body) {   // on a part: slide over its surface, onto each face it crosses, keeping its turn
        const p = pointAt(e); if (!p || !hitBody) return;
        const fr = faceFrame(e);
        ed.points = [toRest(ed, V3(p).sub(imgDrag.grab.clone().projectOnPlane(n)).toArray())];
        if (fr) {
          const n2 = V3(fr.normal), up = V3(ed.up ?? fr.up).projectOnPlane(n2);
          ed.normal = fr.normal; ed.up = (up.lengthSq() > 1e-6 ? up.normalize() : V3(fr.up)).toArray().map((v) => +v.toFixed(6));
        }
      } else {   // on a plane: within the plane
        const q = onPlane(e, at, n); if (!q) return;
        ed.points = [toRest(ed, V3(q).sub(imgDrag.grab).toArray())];
        imgDrag.grab.set(0, 0, 0);
      }
      rebuild();
      return;
    }
    if (handle && e.pointerId === handle.id) { e.stopImmediatePropagation(); penMove(e); return; }
    if (selDrag && e.pointerId === selDrag.id) { e.stopImmediatePropagation(); selMove(e); return; }
    if (editId && !imgDrag && !e.buttons) { const ed = editing(); if (ed) canvas.style.cursor = cursorFor(zoneAt(e, ed), e); }
    else if (!tool && !current && !e.buttons && e.pointerType !== 'touch') {   // no tool: show what a click would pick
      const sel = selected(), z = sel && selZone(e, sel);
      const c = z ? (z.kind === 'line' ? 'move' : 'pointer') : lineAt(e) ? 'pointer' : null;
      if (c) { canvas.style.cursor = c; lineCursor = true; }
      else if (lineCursor) { canvas.style.cursor = ''; lineCursor = false; }   // only undo our own cursor, not the view's
      tipAt(!c && imageUnder(e) ? 'Double-click to adjust the picture' : null, e);   // a picture on a surface can be moved, sized, turned, cropped
    }
    if (!current) {   // ARROW, PEN: light up the point or edge it would land on (not while the view is dragged)
      if ((tool === 'arrow' || tool === 'path') && !e.buttons && e.pointerType !== 'touch') { const lit = snap?.showSnap(e); canvas.style.cursor = lit ? 'cell' : 'crosshair'; }
      if (tool === 'image' && !e.buttons && e.pointerType !== 'touch') snap?.showFace?.(e);   // the surface the picture would land on
      if (draft && tool === 'path' && !e.buttons) {
        const lockedP = penPoint(e), snapP = !lockedP && snap?.snapAt(e)?.toArray();
        hoverP = lockedP ?? (snapP ? flatten(draft, snapP) : null) ?? (draft.plane ? flatAt(e, draft) : pointAt(e));
        rebuild();
      }
      return;
    }
    if (!mine(e)) return;
    e.stopImmediatePropagation();
    if (current.kind === 'pen') {
      if (Math.hypot(e.clientX - last.x, e.clientY - last.y) < 3) return;
      const p = current.plane ? flatAt(e, current) : penAt(e); if (!p) return;
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

  canvas.addEventListener('pointerleave', (e) => { if (!current) snap?.clearSnap(); tipAt(null, e); });

  canvas.addEventListener('pointerup', (e) => {
    if (imgDrag && e.pointerId === imgDrag.id) { e.stopImmediatePropagation(); imgDrag = null; changed(); rebuild(); return; }   // projected again, where it now is
    if (handle && e.pointerId === handle.id) { e.stopImmediatePropagation(); handle = null; rebuild(); return; }
    if (selDrag && e.pointerId === selDrag.id) {
      e.stopImmediatePropagation();
      const it = selected(), o = selDrag.orig;
      selDrag = null;
      if (it && JSON.stringify(it.points) !== JSON.stringify(o.points)) changed();   // a click that only selects saves nothing
      rebuild();
      return;
    }
    if (!mine(e)) return;
    e.stopImmediatePropagation();
    if (!current) return;
    const ok = current.kind === 'pen' ? current.points.length > 1 : true;   // an arrow with no drag is a dot
    if (ok) {
      const { origin, n, ...rest } = current;   // an image's drag helpers stay out of the saved mark
      const item = { ...rest, at: new Date().toISOString() };
      items.push(item); changed();
      if (item.kind === 'arrow') startNote(toWorld(item, item.points[0]), e, item);   // an arrow says something: ask what, where the drag ended
      if (item.kind === 'image') {   // one picture per ADD AN IMAGE; it opens for adjusting at once (later: double-click it)
        current = null; setTool(null); editId = item.id; rebuild();
        say('picture: drag to move · corner dots size · just outside a corner turns (⇧ 15°) · ⌘ corner or edge crops · ⌫ deletes · Esc done · double-click it later to adjust');
        return;
      }
    }
    current = null;
    rebuild();
  }, { capture: true });

  /** The note or arrow tag under the pointer (its text box), topmost first, or null. */
  function tagAt(e) {
    const r = canvas.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    return [...tags].reverse().find((t) => x >= t.x && x <= t.x + t.w && y >= t.y && y <= t.y + t.h) ?? null;
  }
  // Double-click a tag (or, with no tool chosen, the dot it hangs on) to edit its text in place. With a
  // tool chosen the press on the tag made no mark (pointerdown yields there), so the double-click edits too.
  canvas.addEventListener('dblclick', (e) => {
    if (noteInput || tool === 'erase') return;
    const r = canvas.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    const hit = tagAt(e)
      || (!tool && tags.find((t) => t.item.points.some((q) => { const s = toScreen(toWorld(t.item, q)); return Math.hypot(s.x - x, s.y - y) < 12; })));
    if (!hit) return;
    e.preventDefault(); e.stopPropagation();
    startNote(toWorld(hit.item, hit.item.points[0]), e, hit.item);
    noteInput.value = hit.item.text; noteInput.select(); noteInput.dispatchEvent(new Event('input'));
    noteInput.style.left = `${hit.x + hit.w / 2}px`; noteInput.style.top = `${hit.y + hit.h + 12}px`;   // over its own tag
    noteInput.style.width = `${Math.max(180, hit.w)}px`;
    hit.el.style.visibility = 'hidden';
  });

  /** Note input at p; with `item`, the text goes on that item (an arrow) instead of a new note. */
  function startNote(p, e, item = null, body = undefined) {   // p in world space
    noteInput?.remove();
    const el = document.createElement('textarea');   // Enter saves, Shift+Enter starts a new line
    el.className = 'note-input';
    el.placeholder = 'note… (Enter saves, Shift+Enter for a new line)';
    el.rows = 1;
    const grow = () => { el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px`; };
    el.addEventListener('input', grow);
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
    el.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); done(true); } else if (ev.key === 'Escape') done(false); ev.stopPropagation(); });
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
    selectNone();
    tool = tool === name ? null : name;
    for (const b of document.querySelectorAll('[data-tool]')) b.classList.toggle('on', b.dataset.tool === tool);   // ADD AN IMAGE sits by the planes, not in the markup bar
    canvas.style.cursor = tool ? 'crosshair' : '';
    canvas.classList.toggle('drawing', !!tool);   // under the view's grab hand over parts, even after measure clears the cursor
    if (tool !== 'arrow' && tool !== 'path') snap?.clearSnap();   // (and the IMAGE tool's lit face)
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
    // a clicked tool button gives up focus: the keys that follow (Esc, Enter, ⌫) are the pen's, not a
    // second press of the button, and no focus ring is left round it
    e.target.closest('button')?.blur();
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
    projectLabels();
    const px = 12 * k, pad = 8 * k, line = 16 * k;
    ctx.font = `${px}px "Space Mono", monospace`; ctx.textBaseline = 'middle';
    for (const t of tags) {
      const x = t.x * k, w = t.w * k;
      const rows = [];   // the same wrap the tag has: words to the tag's width
      for (const para of t.text.split('\n')) {
        let row = '';
        for (const word of para.split(/\s+/).filter(Boolean)) {
          const next = row ? `${row} ${word}` : word;
          if (row && ctx.measureText(next).width > w - 2 * pad - 3 * k) { rows.push(row); row = word; } else row = next;
        }
        rows.push(row);
      }
      const h = Math.max(t.h * k, rows.length * line + 8 * k), y = t.y * k + (t.h * k - h) / 2;   // as tall as its text needs
      ctx.fillStyle = '#ffffff'; ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = 'rgba(0,0,0,0.25)'; ctx.lineWidth = k; ctx.strokeRect(x, y, w, h);
      ctx.fillStyle = t.color; ctx.fillRect(x, y, 3 * k, h);
      ctx.fillStyle = '#000000';
      const top = y + (h - rows.length * line) / 2 + line / 2;
      rows.forEach((text, i) => ctx.fillText(text, x + pad + 3 * k, top + i * line));
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
