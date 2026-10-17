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
export function createMarkup({ THREE, renderer, scene, getCamera, orbit, getTargets, layer, tools, onChange }) {
  const group = new THREE.Group();
  group.renderOrder = 5;
  scene.add(group);
  const raycaster = new THREE.Raycaster();
  const COLOR = 0xd11d1d;
  const lineMat = new THREE.LineBasicMaterial({ color: COLOR, depthTest: false, transparent: true });
  const solidMat = new THREE.MeshBasicMaterial({ color: COLOR, depthTest: false });
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
  function pointAt(e) {
    const cam = getCamera();
    raycaster.setFromCamera(ndc(e), cam);
    const hit = raycaster.intersectObjects(getTargets(), false)[0];
    if (hit) return [hit.point.x, hit.point.y, hit.point.z];
    const n = new THREE.Vector3(); cam.getWorldDirection(n);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, orbit.target);
    const p = new THREE.Vector3();
    return raycaster.ray.intersectPlane(plane, p) ? [p.x, p.y, p.z] : null;
  }

  // ------------------------------------------------------------ geometry

  function build(item) {
    const objs = [];
    const pts = item.points.map((p) => new THREE.Vector3(...p));
    const scale = orbit.dist * 0.012;
    if (item.kind === 'pen' && pts.length > 1) {
      objs.push(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), lineMat));
    } else if (item.kind === 'arrow' && pts.length === 2) {
      objs.push(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), lineMat));
      const dir = pts[1].clone().sub(pts[0]);
      if (dir.length() > 1e-6) {
        const cone = new THREE.Mesh(new THREE.ConeGeometry(scale * 0.35, scale, 12), solidMat);
        cone.position.copy(pts[1]);
        cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
        objs.push(cone);
      }
    } else if (item.kind === 'note') {
      const dot = new THREE.Mesh(new THREE.SphereGeometry(scale * 0.25, 12, 8), solidMat);
      dot.position.copy(pts[0]);
      objs.push(dot);
    }
    for (const o of objs) { o.renderOrder = 5; o.userData.item = item; group.add(o); }
    return objs;
  }

  function rebuild() {
    for (const o of [...group.children]) { group.remove(o); o.geometry?.dispose(); }
    for (const l of layer.querySelectorAll('.note-label')) l.remove();
    for (const item of items) {
      build(item);
      if (item.kind === 'note') {
        const el = document.createElement('div');
        el.className = 'note-label';
        el.textContent = item.text || '…';
        el.dataset.id = item.id;
        layer.appendChild(el);
      }
    }
    if (current) build(current);
  }

  /** Called every frame: keep note labels on their anchors. */
  function projectLabels() {
    for (const el of layer.querySelectorAll('.note-label')) {
      const item = items.find((i) => i.id === el.dataset.id);
      if (!item) continue;
      const s = toScreen(item.points[0]);
      el.style.left = `${s.x}px`; el.style.top = `${s.y}px`;
      el.hidden = s.behind;
    }
  }

  // ------------------------------------------------------------- pointer

  const uid = () => Math.random().toString(36).slice(2, 9);
  let last = null;

  canvas.addEventListener('pointerdown', (e) => {
    if (!tool || e.button !== 0) return;
    e.stopImmediatePropagation(); e.preventDefault();
    const p = pointAt(e);
    if (!p) return;
    canvas.setPointerCapture(e.pointerId);
    last = { x: e.clientX, y: e.clientY };
    if (tool === 'pen') current = { id: uid(), kind: 'pen', points: [p] };
    else if (tool === 'arrow') current = { id: uid(), kind: 'arrow', points: [p, p] };
    else if (tool === 'note') { startNote(p, e); }
    else if (tool === 'erase') { eraseAt(e); }
    rebuild();
  }, { capture: true });

  canvas.addEventListener('pointermove', (e) => {
    if (!tool) return;
    e.stopImmediatePropagation();
    if (!current) return;
    if (current.kind === 'pen') {
      if (Math.hypot(e.clientX - last.x, e.clientY - last.y) < 3) return;
      const p = pointAt(e); if (!p) return;
      current.points.push(p); last = { x: e.clientX, y: e.clientY };
    } else if (current.kind === 'arrow') {
      const p = pointAt(e); if (!p) return;
      current.points[1] = p;
    }
    rebuild();
  }, { capture: true });

  canvas.addEventListener('pointerup', (e) => {
    if (!tool) return;
    e.stopImmediatePropagation();
    if (!current) return;
    const ok = current.kind === 'pen' ? current.points.length > 1 : new THREE.Vector3(...current.points[0]).distanceTo(new THREE.Vector3(...current.points[1])) > 1e-6;
    if (ok) { items.push({ ...current, at: new Date().toISOString() }); changed(); }
    current = null;
    rebuild();
  }, { capture: true });

  function startNote(p, e) {
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
      if (commit && el.value.trim()) { items.push({ id: uid(), kind: 'note', points: [p], text: el.value.trim(), at: new Date().toISOString() }); changed(); }
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
        const s = toScreen(p);
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
  tools.addEventListener('click', (e) => {
    const b = e.target.closest('[data-tool]');
    if (b) { setTool(b.dataset.tool); return; }
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
      if (item.kind !== 'note') continue;
      const s = toScreen(item.points[0]);
      if (s.behind) continue;
      const text = item.text, w = ctx.measureText(text).width + 12 * k, h = 20 * k;
      ctx.fillStyle = '#ffffff'; ctx.fillRect(s.x * k - w / 2, s.y * k - 12 * k - h, w, h);
      ctx.strokeStyle = '#d11d1d'; ctx.lineWidth = k; ctx.strokeRect(s.x * k - w / 2, s.y * k - 12 * k - h, w, h);
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
