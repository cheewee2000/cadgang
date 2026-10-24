/**
 * Reference planes, as SolidWorks has them: Front, Top and Right through the model's centre, each
 * on or off, and planes of your own: offset from one of those by a distance, or lying on a face you
 * click. A plane draws as a see-through square a little larger than the model, outlined, its name at
 * the corner. Front, Top, Right and the planes offset from them follow the model's centre, so they
 * move when its parts are dragged or exploded; a plane made on a face stays where the face was.
 * Kept per file in this browser.
 *
 * Model frame: Z up. Front is the XZ plane (seen from the front, normal −Y), Top the XY plane (+Z),
 * Right the YZ plane (+X).
 */
const BASE = {
  front: { name: 'Front', normal: [0, -1, 0], up: [0, 0, 1] },
  top: { name: 'Top', normal: [0, 0, 1], up: [0, 1, 0] },
  right: { name: 'Right', normal: [1, 0, 0], up: [0, 0, 1] },
};
const COLOR = 0x5b7fd6;

export function createPlanes({ THREE, scene, getBox, getSubject, onChange = () => {}, pickFace }) {
  const group = new THREE.Group();
  group.renderOrder = 2;
  scene.add(group);
  let state = { on: {}, custom: [] };
  const key = () => `cadgang-planes:${getSubject()}`;
  const save = () => { try { localStorage.setItem(key(), JSON.stringify(state)); } catch {} onChange(); };
  function load() {
    state = { on: {}, custom: [] };
    try { const s = JSON.parse(localStorage.getItem(key())); if (s) state = { on: s.on ?? {}, custom: Array.isArray(s.custom) ? s.custom : [] }; } catch {}
    render(); paint();
  }

  // ----------------------------------------------------------------- drawing
  const V3 = (a) => new THREE.Vector3(...a);
  /** An up direction in the plane: the plane's own, else world Z (or Y for a level plane), laid into it. */
  const upIn = (n, up) => { const u = (up ? V3(up) : Math.abs(n.z) > 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1)); u.addScaledVector(n, -u.dot(n)); return u.lengthSq() > 1e-9 ? u.normalize() : new THREE.Vector3(1, 0, 0).addScaledVector(n, -n.x).normalize(); };
  function labelSprite(text) {
    const c = document.createElement('canvas'), g = c.getContext('2d'), px = 40;
    g.font = `600 ${px}px -apple-system, Helvetica, Arial, sans-serif`;
    c.width = Math.ceil(g.measureText(text).width + 16); c.height = px + 16;
    g.font = `600 ${px}px -apple-system, Helvetica, Arial, sans-serif`; g.fillStyle = '#3d5fb0'; g.textBaseline = 'middle'; g.fillText(text, 8, c.height / 2);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, depthTest: false, transparent: true }));
    s.userData.aspect = c.width / c.height;
    return s;
  }
  function planeMesh(name, point, n, up, box, id, pinned = false) {   // pinned: the square sits on `point` itself (a plane placed by hand), not on the model's middle
    const sel = id === selectedId, color = sel ? 0x1d6bff : COLOR;   // selected: the blue a selected part wears
    const size = box.getSize(new THREE.Vector3()), centre = box.getCenter(new THREE.Vector3());
    const half = Math.max(size.x, size.y, size.z) * 0.6 + 2;
    const u = upIn(n, up), r = u.clone().cross(n);
    const at = pinned ? V3(point) : centre.clone().addScaledVector(n, V3(point).sub(centre).dot(n));   // the model's middle, moved onto the plane
    centres.set(id, at.clone());
    const g = new THREE.Group();
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(half * 2, half * 2), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: sel ? 0.25 : 0.1, depthWrite: false, side: THREE.DoubleSide }));
    quad.userData.planeId = id;
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1]].map(([a, b]) => new THREE.Vector3(a * half, b * half, 0));
    const outline = new THREE.Line(new THREE.BufferGeometry().setFromPoints(corners), new THREE.LineBasicMaterial({ color, transparent: true, opacity: sel ? 1 : 0.7 }));
    const frame = new THREE.Group(); frame.add(quad, outline);
    frame.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(r, u, n));
    frame.position.copy(at);
    const label = labelSprite(name);
    const h = half * 0.09; label.scale.set(h * label.userData.aspect, h, 1);
    label.position.copy(at).addScaledVector(r, -half + h * label.userData.aspect / 2 + half * 0.03).addScaledVector(u, half - h * 0.8);
    g.add(frame, label);
    g.traverse((x) => { x.raycast = () => {}; x.renderOrder = 2; });   // never a pick, measure or snap target…
    quad.raycast = THREE.Mesh.prototype.raycast;                          // …but markups draw on it (hit() below)
    quads.push(quad);
    return g;
  }
  const quads = [];   // the visible planes' squares: what hit() and pick() test
  const centres = new Map();   // plane id -> where its square is drawn (the triad sits there)
  let selectedId = null;   // the plane selected in the view or the tree, if any
  let lastCentre = '';
  function render() {
    quads.length = 0; centres.clear();
    for (const o of [...group.children]) { group.remove(o); o.traverse((x) => { x.geometry?.dispose(); x.material?.map?.dispose(); x.material?.dispose(); }); }
    const box = getBox();
    if (!box) return;
    const c = box.getCenter(new THREE.Vector3());
    lastCentre = c.toArray().map((v) => +v.toFixed(4)).join();
    for (const [k, b] of Object.entries(BASE)) if (state.on[k]) group.add(planeMesh(b.name, c.toArray(), V3(b.normal), b.up, box, k));
    for (const p of state.custom) {
      if (p.on === false) continue;
      const n = V3(p.normal).normalize();
      const at = p.base ? c.clone().addScaledVector(n, p.offset).toArray() : p.point;   // offset planes ride the centre too
      group.add(planeMesh(p.name, at, n, p.up, box, p.id, !!p.placed));
    }
  }

  // ----------------------------------------------------------------- making planes
  function add(name, point, normal, up = null) {
    const n = state.custom.length + 1;
    state.custom.push({ id: Math.random().toString(36).slice(2, 9), name: name || `Plane ${n}`, point: point.map((v) => +v.toFixed(4)), normal: normal.map((v) => +v.toFixed(6)), ...(up && { up }), on: true });
    save(); render(); paint();
  }
  const autoName = (p) => `${BASE[p.base].name} ${p.offset >= 0 ? '+' : '−'}${Math.abs(p.offset)} mm`;
  /** A plane parallel to Front, Top or Right, `d` mm along its normal from the model's centre. */
  function offset(base, d) {
    const b = BASE[base];
    state.custom.push({ id: Math.random().toString(36).slice(2, 9), name: autoName({ base, offset: d }), base, offset: d, normal: b.normal, up: b.up, on: true });
    save(); render(); paint();
  }

  // ----------------------------------------------------------------- the menu
  const wrap = Object.assign(document.createElement('span'), { className: 'sect planes', title: 'Reference planes: Front, Top and Right on or off; + makes your own' });
  wrap.append('Planes ');
  const btns = {};
  for (const [k, b] of Object.entries(BASE)) {
    const btn = Object.assign(document.createElement('button'), { className: 'ghost', textContent: b.name });
    btn.addEventListener('click', () => { state.on[k] = !state.on[k]; save(); render(); paint(); });
    btns[k] = btn; wrap.append(btn);
  }
  const plus = Object.assign(document.createElement('button'), { className: 'ghost', textContent: '+', title: 'New plane, and your planes' });
  const menu = Object.assign(document.createElement('div'), { className: 'planes-menu', hidden: true });
  plus.addEventListener('click', (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; if (!menu.hidden) paint(); });
  document.addEventListener('pointerdown', (e) => { if (!menu.contains(e.target) && e.target !== plus) menu.hidden = true; });
  wrap.append(plus, menu);
  function paint() {
    for (const [k, b] of Object.entries(btns)) b.classList.toggle('on', !!state.on[k]);
    menu.replaceChildren();
    const row = () => { const d = document.createElement('div'); d.className = 'row'; menu.append(d); return d; };
    // offset from a base plane
    const r1 = row();
    const base = document.createElement('select'); base.className = 'ghost';
    for (const [k, b] of Object.entries(BASE)) base.append(new Option(b.name, k));
    const dist = Object.assign(document.createElement('input'), { type: 'number', value: '10', step: 'any', title: 'Offset in mm (negative: the other way)' });
    const go = Object.assign(document.createElement('button'), { className: 'ghost', textContent: 'Add' });
    go.addEventListener('click', () => { const d = parseFloat(dist.value); if (Number.isFinite(d)) offset(base.value, d); });
    dist.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') go.click(); });
    r1.append('Offset from ', base, ' by ', dist, ' mm ', go);
    // on a face
    const r2 = row();
    const face = Object.assign(document.createElement('button'), { className: 'ghost', textContent: 'On a face… (click it)' });
    face.addEventListener('click', () => { menu.hidden = true; pickFace((point, normal) => add(null, point.toArray(), normal.toArray())); });
    r2.append(face);
    // your planes
    if (state.custom.length) menu.append(Object.assign(document.createElement('hr')));
    for (const p of state.custom) {
      const r = row();
      const cb = Object.assign(document.createElement('input'), { type: 'checkbox', checked: p.on !== false });
      cb.addEventListener('change', () => { p.on = cb.checked; save(); render(); });
      const nm = Object.assign(document.createElement('input'), { type: 'text', value: p.name, className: 'name', title: 'Rename' });
      nm.addEventListener('keydown', (e) => e.stopPropagation());
      nm.addEventListener('change', () => { p.name = nm.value.trim() || p.name; save(); render(); });
      const del = Object.assign(document.createElement('button'), { className: 'ghost', textContent: '×', title: 'Delete this plane' });
      del.addEventListener('click', () => { state.custom = state.custom.filter((x) => x !== p); save(); render(); paint(); });
      r.append(cb, nm, del);
    }
  }
  paint();

  return {
    el: wrap, load, render,
    /** Each frame: when the model's centre has moved (a part dragged, the explode slider), redraw. */
    follow() {
      if (!group.children.length && !state.custom.length && !Object.values(state.on).some(Boolean)) return;
      const box = getBox(); if (!box) return;
      const k = box.getCenter(new THREE.Vector3()).toArray().map((v) => +v.toFixed(4)).join();
      if (k !== lastCentre) render();
    },
    /** The nearest visible plane along a ray: { point, normal, distance }, or null. Markups draw on planes. */
    hit(raycaster) {
      const h = raycaster.intersectObjects(quads, false)[0];
      return h ? { point: h.point, normal: h.face.normal.clone().transformDirection(h.object.matrixWorld).normalize(), distance: h.distance } : null;
    },
    get state() { return state; },
    // ------------------------------------------------------------- selecting and moving, like a part
    /** The plane whose square the ray hits first: { id, distance }, or null. */
    pick(raycaster) { const h = raycaster.intersectObjects(quads, false)[0]; return h ? { id: h.object.userData.planeId, distance: h.distance } : null; },
    get selected() { return selectedId; },
    select(id) { selectedId = id ?? null; render(); onChange(); },   // (onChange repaints the tree; a selection is no document change, so commit() finds nothing new)
    /** Where one of your own planes is drawn, for the triad: { point, normal, up }, or null (Front, Top, Right stay through the centre). */
    pose(id) {
      const c = id && centres.get(id), p = c && state.custom.find((x) => x.id === id);
      return p ? { point: c.clone(), normal: V3(p.normal).normalize(), up: p.up ? V3(p.up) : null } : null;
    },
    /**
     * Put one of your own planes at `point` facing `normal` (world). An offset plane slid along its own normal is
     * still one, that far out (and keeps an automatic name in step); turned or slid any other way it becomes a plane
     * of its own, placed by hand: its square then stays where it was put instead of riding the model's middle.
     * Drawn at once; `keep` saves it (the triad drags with keep off, then keeps on release).
     */
    place(id, { point, normal, up }, keep = false) {
      const p = state.custom.find((x) => x.id === id), box = getBox();
      if (!p || !box) return;
      const n = normal.clone().normalize(), bn = p.base && V3(BASE[p.base].normal);
      const slide = point.clone().sub(centres.get(id) ?? point), alongNormal = slide.clone().addScaledVector(n, -slide.dot(n)).lengthSq() < 1e-9;
      if (bn && alongNormal && Math.abs(n.dot(bn)) > 1 - 1e-6) {
        const auto = p.name === autoName(p);
        p.offset = +point.clone().sub(box.getCenter(new THREE.Vector3())).dot(bn).toFixed(2);
        if (auto) p.name = autoName(p);
      } else {
        if (p.base && p.name === autoName(p)) p.name = `Plane ${state.custom.indexOf(p) + 1}`;   // 'Front +12 mm' no longer says where it is
        delete p.base; delete p.offset; p.placed = true;
        p.point = point.toArray().map((v) => +v.toFixed(4)); p.normal = n.toArray().map((v) => +v.toFixed(6));
        if (up) p.up = up.clone().normalize().toArray().map((v) => +v.toFixed(6));
      }
      render();   // ponytail: rebuilds every plane's mesh per drag frame; move just this one's group if a model has dozens
      if (keep) { save(); paint(); }
    },
    keep() { save(); paint(); },
    /** Every plane, for the feature tree: Front, Top, Right, then your own. kind: 'base' | 'offset' | 'face'. */
    list() {
      return [
        ...Object.entries(BASE).map(([k, b]) => ({ id: k, name: b.name, on: !!state.on[k], kind: 'base' })),
        ...state.custom.map((p) => ({ id: p.id, name: p.name, on: p.on !== false, kind: p.base ? 'offset' : p.placed ? 'placed' : 'face', base: p.base && BASE[p.base].name, offset: p.offset })),
      ];
    },
    /** Change one plane: { on, name, offset, flip: true }. Front, Top and Right only show and hide. */
    set(id, { on, name, offset, flip } = {}) {
      if (BASE[id]) { if (on != null) state.on[id] = !!on; }
      else {
        const p = state.custom.find((x) => x.id === id);
        if (!p) return;
        if (on != null) p.on = !!on;
        if (name != null && String(name).trim()) p.name = String(name).trim();
        const auto = p.base && p.name === autoName(p);   // a name it was given, not one typed: it follows the offset
        if (offset != null && p.base && Number.isFinite(+offset)) p.offset = +offset;
        if (flip && p.base) p.offset = -p.offset;   // the other side of its base plane
        if (auto) p.name = autoName(p);
        if (flip && !p.base) p.normal = p.normal.map((v) => -v);
      }
      save(); render(); paint();
    },
    remove(id) { state.custom = state.custom.filter((x) => x.id !== id); save(); render(); paint(); },
    restore(s) { state = JSON.parse(JSON.stringify(s)); try { localStorage.setItem(key(), JSON.stringify(state)); } catch {} render(); paint(); },
  };
}
