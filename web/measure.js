/**
 * Measure like a drawing dimension, not like a ruler.
 *
 *   hover   the nearest snap (endpoint, midpoint, centre, quadrant) or, failing
 *           that, the nearest edge or the face under the pointer is highlighted
 *   click   on a snap: a point; the second point makes a distance, snapped
 *           axis-aligned when it nearly is (shift: never)
 *           on a face: selects the face. A cylinder or fillet reads its ⌀ or R
 *           at once, a sphere its SR, a plane its area. A second face then
 *           gives the distance between them (parallel planes: the gap;
 *           otherwise the closest approach), a point gives point-to-face.
 *           ⌥-click: a free point.
 *           on a circle or arc: its diameter / radius, in one click
 *           on a straight edge: its length, in one click
 *   dims    stay on the page until clicked away or undone; they are plain data
 *           so the page's undo history can rebuild them
 *
 * Edges come from what the viewer already draws: B-rep face borders for STEP,
 * crease edges for meshes, the segments of a DXF. Chains of collinear segments
 * become straight edges; chains that turn evenly and fit a circle become arcs.
 * ponytail: every hover scans all snaps and segments in screen space — fine to
 * ~50k; a grid or BVH is the upgrade for huge assemblies.
 */
import * as THREE from 'three';

/** A cylinder through a face's triangles: axis, centre, radius, the frame (u, v), whether it closes
 *  (a full cylinder reads ⌀, a fillet R) and a point on it. Null when the triangles are not one. */
export function cylinderFit(tris, centroid, scaleHint = 0) {
  if (tris.length < 2) return null;
  // cylinder axis: the direction every normal is perpendicular to — the largest cross product, refined by averaging
  const normals = tris.map((t) => t.getNormal(new THREE.Vector3()));
  let axis = new THREE.Vector3(), best = 0;
  const step = Math.max(1, Math.floor(normals.length / 40));
  for (let i = 0; i < normals.length; i += step) for (let j = i + 1; j < normals.length; j += step) {
    const c = normals[i].clone().cross(normals[j]); if (c.lengthSq() > best) { best = c.lengthSq(); axis = c; }
  }
  if (best < 1e-6) return null;
  axis.normalize();
  const acc = new THREE.Vector3();
  for (let i = 1; i < normals.length; i++) { const c = normals[0].clone().cross(normals[i]); if (c.dot(axis) < 0) c.negate(); acc.add(c); }
  if (acc.lengthSq() > 0) axis = acc.normalize();
  const verts = []; for (const t of tris) verts.push(t.a, t.b, t.c);
  const u = Math.abs(axis.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  u.addScaledVector(axis, -u.dot(axis)).normalize(); const v = axis.clone().cross(u);
  const cyl = fitCircle2D(verts.map((p) => [p.dot(u), p.dot(v)]));
  if (!cyl || cyl.rms >= cyl.r * 0.01 + scaleHint * 1e-4) return null;
  const mid = centroid.dot(axis);
  const c = u.clone().multiplyScalar(cyl.cx).addScaledVector(v, cyl.cy).addScaledVector(axis, mid);
  // angular span of the face around the axis
  const angs = verts.map((p) => Math.atan2(p.dot(v) - cyl.cy, p.dot(u) - cyl.cx)).sort((a, b) => a - b);
  let gap = angs[0] + Math.PI * 2 - angs[angs.length - 1]; for (let i = 1; i < angs.length; i++) gap = Math.max(gap, angs[i] - angs[i - 1]);
  const span = Math.PI * 2 - gap;
  const toSurf = centroid.clone().sub(c); toSurf.addScaledVector(axis, -toSurf.dot(axis)).normalize();
  let t0 = Infinity, t1 = -Infinity; for (const p of verts) { const t = p.dot(axis); if (t < t0) t0 = t; if (t > t1) t1 = t; }   // extent along the axis
  return { axis, c, r: cyl.r, u, v, span, t0, t1, closed: span > THREE.MathUtils.degToRad(300), p: c.clone().addScaledVector(toSurf, cyl.r) };
}

/** Algebraic sphere fit through points: centre, radius, rms. Null when they are not on one. */
export function sphereFit(P) {
  const A = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], b = [0, 0, 0, 0];
  for (const p of P) { const row = [p.x, p.y, p.z, 1], rhs = -(p.lengthSq()); for (let i = 0; i < 4; i++) { b[i] += row[i] * rhs; for (let j = 0; j < 4; j++) A[i][j] += row[i] * row[j]; } }
  const s = solve(A, b); if (!s) return null;
  const c = new THREE.Vector3(-s[0] / 2, -s[1] / 2, -s[2] / 2), r2 = c.lengthSq() - s[3]; if (r2 <= 0) return null;
  const r = Math.sqrt(r2); let e = 0; for (const p of P) e += (p.distanceTo(c) - r) ** 2;
  return { c, r, rms: Math.sqrt(e / P.length) };
}

/** Algebraic (Kåsa) circle fit: x²+y²+Dx+Ey+F=0. */
function fitCircle2D(P) {
  const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], b = [0, 0, 0];
  for (const [x, y] of P) { const row = [x, y, 1], rhs = -(x * x + y * y); for (let i = 0; i < 3; i++) { b[i] += row[i] * rhs; for (let j = 0; j < 3; j++) A[i][j] += row[i] * row[j]; } }
  const s = solve(A, b); if (!s) return null;
  const cx = -s[0] / 2, cy = -s[1] / 2, r2 = cx * cx + cy * cy - s[2]; if (r2 <= 0) return null;
  const r = Math.sqrt(r2); let e = 0; for (const [x, y] of P) e += (Math.hypot(x - cx, y - cy) - r) ** 2;
  return { cx, cy, r, rms: Math.sqrt(e / P.length) };
}
function solve(A, b) {   // Gaussian elimination with partial pivoting, n ≤ 4
  const n = b.length, M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  return M.map((row, i) => row[n] / row[i]);
}

export function createMeasure({ THREE, scene, renderer, getCamera, model, layer, getOrbit, say, onChange, keyOf = () => null, bodyOf = () => null }) {
  const RED = 0xd11d1d;
  const SNAP_PX = 12, CURVE_PX = 8;
  const lineMat = new THREE.LineBasicMaterial({ color: RED, depthTest: false });
  const faceMat = new THREE.MeshBasicMaterial({ color: RED, transparent: true, opacity: 0.3, depthTest: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, side: THREE.DoubleSide });
  const dimGroup = new THREE.Group(); dimGroup.renderOrder = 4; scene.add(dimGroup);
  const hl = new THREE.Group(); hl.renderOrder = 4; scene.add(hl);     // what the pointer is over
  const sel = new THREE.Group(); sel.renderOrder = 4; scene.add(sel);   // the first pick, while waiting for the second
  const raycaster = new THREE.Raycaster();
  let on = false, dirty = true, features = [], snaps = [], pending = null, hover = null, dims = [], labels = [];
  const canvas = renderer.domElement;

  // ----------------------------------------------------------------- index
  function sources() {
    const out = [];
    for (const m of model.children) {
      if (!m.visible) continue;
      m.updateMatrixWorld(true);
      if (m.isLine) out.push({ pos: m.geometry.getAttribute('position').array, matrix: m.matrixWorld, mesh: m });
      else if (m.userData.edges) { m.userData.edges.updateMatrixWorld(true); out.push({ pos: m.userData.edges.geometry.getAttribute('position').array, matrix: m.userData.edges.matrixWorld, mesh: m }); }
    }
    return out;
  }
  function build() {
    features = []; snaps = []; dirty = false; scr = null;
    const box = new THREE.Box3().setFromObject(model);
    const scale = box.isEmpty() ? 1 : box.getSize(new THREE.Vector3()).length();
    scaleHint = scale;
    const q = scale * 1e-6, key = (p) => `${Math.round(p.x / q)},${Math.round(p.y / q)},${Math.round(p.z / q)}`;
    // nodes and segments, welded by position
    const nodes = new Map(); const segs = [];
    const node = (p) => { const k = key(p); let n = nodes.get(k); if (!n) { n = { p, segs: [] }; nodes.set(k, n); } return n; };
    for (const { pos, matrix, mesh } of sources()) {
      for (let i = 0; i + 5 < pos.length; i += 6) {
        const a = new THREE.Vector3(pos[i], pos[i + 1], pos[i + 2]).applyMatrix4(matrix);
        const b = new THREE.Vector3(pos[i + 3], pos[i + 4], pos[i + 5]).applyMatrix4(matrix);
        if (a.distanceTo(b) < q) continue;
        const s = { a: node(a), b: node(b), used: false, mesh }; s.a.segs.push(s); s.b.segs.push(s); segs.push(s);
      }
    }
    // chains: walk from every open end first, then whatever loops remain
    const chains = [];
    const walk = (start, seg) => {
      const pts = [start.p]; pts.mesh = seg.mesh; let n = start, s = seg;
      while (s && !s.used) { s.used = true; n = s.a === n ? s.b : s.a; pts.push(n.p); s = n.segs.length === 2 ? n.segs.find((x) => x !== s) : null; }
      return pts;
    };
    for (const n of nodes.values()) if (n.segs.length !== 2) for (const s of n.segs) if (!s.used) chains.push(walk(n, s));
    for (const s of segs) if (!s.used) chains.push(walk(s.a, s));
    for (const pts of chains) { const n0 = features.length; classify(pts, scale); for (let i = n0; i < features.length; i++) features[i].mesh = pts.mesh; }   // a feature knows its body: dims anchor to it
    for (const f of features) {
      if (f.kind === 'line') { addSnap('end', f.a, f); addSnap('end', f.b, f); addSnap('mid', f.a.clone().lerp(f.b, 0.5), f); }
      else {
        addSnap('centre', f.c, f);
        if (f.closed) for (const d of [f.u, f.v]) { addSnap('quad', f.c.clone().addScaledVector(d, f.r), f); addSnap('quad', f.c.clone().addScaledVector(d, -f.r), f); }
        else { addSnap('end', f.pts[0], f); addSnap('end', f.pts[f.pts.length - 1], f); addSnap('mid', f.pts[Math.floor(f.pts.length / 2)], f); }
      }
    }
  }
  function addSnap(kind, p, f) { snaps.push({ kind, p, f }); }
  /** Split a polyline into straight runs and arcs; emit features. Greedy: a run of
   *  collinear segments is one edge; otherwise a circle is grown over as many
   *  points as still fit it; what is left is single segments. */
  function classify(pts, scale) {
    const STRAIGHT = THREE.MathUtils.degToRad(1);
    let P = pts;
    const closed = P.length > 3 && P[0].distanceTo(P[P.length - 1]) < scale * 1e-6;
    if (closed) {
      P = P.slice(0, -1);
      const whole = fitArc(P, scale, true);
      if (whole) { features.push(whole); return; }
      // open the loop at its sharpest corner so no run straddles the seam
      const n = P.length, turnC = (i) => P[(i + 1) % n].clone().sub(P[i]).angleTo(P[i].clone().sub(P[(i - 1 + n) % n]));
      let k = 0; for (let i = 1; i < n; i++) if (turnC(i) > turnC(k)) k = i;
      P = [...P.slice(k), ...P.slice(0, k), P[k]];
    }
    const turn = (j) => P[j + 1].clone().sub(P[j]).angleTo(P[j].clone().sub(P[j - 1]));
    for (let i = 0; i + 1 < P.length;) {
      let j = i + 1;
      while (j + 1 < P.length && turn(j) < STRAIGHT) j++;
      if (j === i + 1) {
        const arc = growArc(P, i, scale);
        if (arc) { features.push(arc); i = arc.end; continue; }
      }
      features.push({ kind: 'line', a: P[i], b: P[j], pts: P.slice(i, j + 1) });
      i = j;
    }
  }
  function growArc(P, i, scale) {
    let j = i + 3;
    if (j >= P.length) return null;
    let fit = fitArc(P.slice(i, j + 1), scale, false);
    if (!fit) return null;
    while (j + 1 < P.length) { const f2 = fitArc(P.slice(i, j + 2), scale, false); if (!f2) break; fit = f2; j++; }
    fit.end = j;
    return fit;
  }
  function fitArc(P, scale, closed) {
    const a = P[0], b = P[Math.floor(P.length / 2)], c = P[P.length - 1];
    const ab = b.clone().sub(a), ac = c.clone().sub(a), nrm = ab.clone().cross(ac);
    if (nrm.lengthSq() < 1e-12 * scale ** 4) return null;
    // circumcentre of a, b, c
    const d = 2 * nrm.lengthSq();
    const centre = ac.clone().multiplyScalar(ab.lengthSq()).sub(ab.clone().multiplyScalar(ac.lengthSq())).cross(nrm).divideScalar(d).add(a);
    const r = centre.distanceTo(a);
    for (const p of P) if (Math.abs(centre.distanceTo(p) - r) > r * 0.005 + scale * 1e-4) return null;
    // a polygonised arc steps evenly; a long chord beside tiny ones is a straight edge that happens to fit a huge circle
    let lo = Infinity, hi = 0;
    for (let k = 0; k + 1 < P.length; k++) { const ang = 2 * Math.asin(Math.min(1, P[k].distanceTo(P[k + 1]) / (2 * r))); lo = Math.min(lo, ang); hi = Math.max(hi, ang); }
    if (hi > lo * 3 || lo < THREE.MathUtils.degToRad(0.2)) return null;
    nrm.normalize();
    // in-plane axes along the world axes least aligned with the normal, for quadrants
    const axes = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)].sort((x, y) => Math.abs(x.dot(nrm)) - Math.abs(y.dot(nrm)));
    const u = axes[0].clone().addScaledVector(nrm, -axes[0].dot(nrm)).normalize(), v = nrm.clone().cross(u);
    return { kind: 'arc', c: centre, r, n: nrm, u, v, pts: P, closed };
  }

  // ----------------------------------------------------------------- picking
  const toScreen = (p) => { const r = canvas.getBoundingClientRect(); const v = p.clone().project(getCamera()); return { x: (v.x + 1) / 2 * r.width, y: (1 - v.y) / 2 * r.height, z: v.z }; };
  const local = (e) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const solids = () => model.children.filter((o) => o.visible && !o.isLine);
  const kept = (h) => Number.isFinite(h.distance) && (![].concat(h.object.material)[0].clippingPlanes?.length || [].concat(h.object.material)[0].clippingPlanes.every((pl) => pl.distanceToPoint(h.point) >= 0));
  /** Is this world point in view, or behind a surface? (what the eye sees is what may be picked) */
  function unoccluded(p) {
    const r = canvas.getBoundingClientRect(), q = toScreen(p);
    raycaster.setFromCamera(new THREE.Vector2((q.x / r.width) * 2 - 1, -(q.y / r.height) * 2 + 1), getCamera());
    const hit = raycaster.intersectObjects(solids(), false).find(kept);
    return !hit || hit.distance >= raycaster.ray.origin.distanceTo(p) - scaleHint * 1e-3;
  }
  let scaleHint = 1;

  // Screen index: every snap and edge point projected once per view into flat arrays, and bucketed
  // in a CELL-pixel grid, so a pointer move looks only at the cells around it. (Projecting each of a
  // board's ~340k edge points on every move took ~200 ms a move.) Rebuilt when the view, the canvas
  // or the model changes; hovering never changes the view, so a move costs microseconds.
  const CELL = 24;
  let scr = null;
  function screenIndex() {
    const cam = getCamera(), r = canvas.getBoundingClientRect();
    cam.updateMatrixWorld();
    const key = `${cam.matrixWorld.elements.join()}|${cam.projectionMatrix.elements.join()}|${r.width}x${r.height}|${features.length}`;
    if (scr?.key === key) return scr;
    const M = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse).elements;
    const W = r.width, H = r.height, cols = Math.ceil(W / CELL) + 1, rows = Math.ceil(H / CELL) + 1;
    // screen x, y of a world point, or NaN when behind the eye or past the far plane
    const proj = (p, out, o) => {
      const w = M[3] * p.x + M[7] * p.y + M[11] * p.z + M[15];
      const z = (M[2] * p.x + M[6] * p.y + M[10] * p.z + M[14]) / w;
      if (w <= 0 || z > 1) { out[o] = out[o + 1] = NaN; return; }
      out[o] = ((M[0] * p.x + M[4] * p.y + M[8] * p.z + M[12]) / w + 1) / 2 * W;
      out[o + 1] = (1 - (M[1] * p.x + M[5] * p.y + M[9] * p.z + M[13]) / w) / 2 * H;
    };
    const grid = new Map();   // cell → [kind, index…]: 0 snap i, 1 segment (feature f, point k)
    const put = (cx, cy, ...v) => { if (cx < 0 || cy < 0 || cx >= cols || cy >= rows) return; const c = cy * cols + cx; let a = grid.get(c); if (!a) grid.set(c, a = []); a.push(...v); };
    const sp = new Float32Array(snaps.length * 2);
    snaps.forEach((s, i) => { proj(s.p, sp, 2 * i); if (sp[2 * i] === sp[2 * i]) put(Math.floor(sp[2 * i] / CELL), Math.floor(sp[2 * i + 1] / CELL), 0, i); });
    const fp = features.map((f) => { const a = new Float32Array(f.pts.length * 2); f.pts.forEach((p, k) => proj(p, a, 2 * k)); return a; });
    fp.forEach((a, fi) => {
      for (let k = 0; k + 1 < a.length / 2; k++) {
        const x0 = a[2 * k], y0 = a[2 * k + 1], x1 = a[2 * k + 2], y1 = a[2 * k + 3];
        if (x0 !== x0 || x1 !== x1) continue;
        const c0 = Math.max(0, Math.floor(Math.min(x0, x1) / CELL)), c1 = Math.min(cols - 1, Math.floor(Math.max(x0, x1) / CELL));
        const r0 = Math.max(0, Math.floor(Math.min(y0, y1) / CELL)), r1 = Math.min(rows - 1, Math.floor(Math.max(y0, y1) / CELL));
        if ((c1 - c0 + 1) * (r1 - r0 + 1) > 4096) continue;   // a segment across the whole screen: too close to the eye to pick
        for (let cy = r0; cy <= r1; cy++) for (let cx = c0; cx <= c1; cx++) put(cx, cy, 1, fi, k);
      }
    });
    return (scr = { key, sp, fp, grid, cols });
  }
  /** What is in the grid cells around a screen point: snap indices and [feature, point] segments. */
  function nearby(m) {
    const { grid, cols } = screenIndex(), cx = Math.floor(m.x / CELL), cy = Math.floor(m.y / CELL), snapIds = new Set(), segs = new Map();
    for (let y = cy - 1; y <= cy + 1; y++) for (let x = cx - 1; x <= cx + 1; x++) {
      if (x < 0 || y < 0 || x >= cols) continue;
      const a = grid.get(y * cols + x);
      if (!a) continue;
      for (let i = 0; i < a.length;) { if (a[i] === 0) { snapIds.add(a[i + 1]); i += 2; } else { segs.set(`${a[i + 1]}:${a[i + 2]}`, [a[i + 1], a[i + 2]]); i += 3; } }
    }
    return { snapIds, segs: [...segs.values()] };
  }
  /** The nearest visible snap (end, mid, centre, quad) within SNAP_PX of the pointer: { kind, p, f }, or null
   *  (a joint's origin lands on it). */
  function pointSnapAt(e) {
    if (dirty) build();
    const m = local(e), { sp } = screenIndex(), { snapIds } = nearby(m);
    const near = [];
    for (const i of snapIds) { const d = Math.hypot(sp[2 * i] - m.x, sp[2 * i + 1] - m.y); if (d < SNAP_PX) near.push([d, snaps[i]]); }
    for (const [, s] of near.sort((a, b) => a[0] - b[0]).slice(0, 6)) if (unoccluded(s.p)) return s;
    return null;
  }
  function pick(e) {
    if (dirty) build();
    const m = local(e);
    const { sp, fp } = screenIndex(), { snapIds, segs } = nearby(m);
    const near = [];
    for (const i of snapIds) { const d = Math.hypot(sp[2 * i] - m.x, sp[2 * i + 1] - m.y); if (d < SNAP_PX) near.push([d, snaps[i]]); }
    for (const [, s] of near.sort((a, b) => a[0] - b[0]).slice(0, 6)) if (unoccluded(s.p)) return { snap: s, f: s.f, p: s.p };
    const best = new Map();   // feature → its closest segment's distance
    for (const [fi, k] of segs) {
      const a = fp[fi], d = segDist(m, { x: a[2 * k], y: a[2 * k + 1] }, { x: a[2 * k + 2], y: a[2 * k + 3] });
      if (d < CURVE_PX && d < (best.get(fi) ?? Infinity)) best.set(fi, d);
    }
    const curves = [...best].map(([fi, d]) => [d, features[fi]]);
    for (const [, f] of curves.sort((a, b) => a[0] - b[0]).slice(0, 6)) { const p = nearestOn(f, e); if (unoccluded(p)) return { f, p }; }
    // a face, or any surface
    const r = canvas.getBoundingClientRect();
    raycaster.setFromCamera(new THREE.Vector2((m.x / r.width) * 2 - 1, -(m.y / r.height) * 2 + 1), getCamera());
    const hit = raycaster.intersectObjects(solids(), false).find(kept);
    if (!hit) return null;
    const faces = hit.object.userData.faces;
    const face = faces?.find((f) => hit.faceIndex >= f.first && hit.faceIndex < f.first + f.count);
    return { p: hit.point.clone(), face: face && { mesh: hit.object, ...face } };
  }
  const segDist = (m, a, b) => { const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy || 1; const t = Math.max(0, Math.min(1, ((m.x - a.x) * dx + (m.y - a.y) * dy) / l2)); return Math.hypot(m.x - a.x - t * dx, m.y - a.y - t * dy); };
  /** Closest point on a feature's polyline to the pointer's ray. */
  function nearestOn(f, e) {
    const r = canvas.getBoundingClientRect(), m = local(e);
    raycaster.setFromCamera(new THREE.Vector2((m.x / r.width) * 2 - 1, -(m.y / r.height) * 2 + 1), getCamera());
    let best = f.pts[0], bd = Infinity; const tmp = new THREE.Vector3();
    for (let k = 0; k + 1 < f.pts.length; k++) {
      const d = raycaster.ray.distanceSqToSegment(f.pts[k], f.pts[k + 1], null, tmp);
      if (d < bd) { bd = d; best = tmp.clone(); }
    }
    return best;
  }

  // ----------------------------------------------------------------- hover
  function clearHl() { for (const o of [...hl.children]) { hl.remove(o); o.geometry?.dispose(); } }
  function marker(p, group, k = 0.004) {
    const s = new THREE.Mesh(new THREE.SphereGeometry(getOrbit().dist * k, 10, 8), new THREE.MeshBasicMaterial({ color: RED, depthTest: false }));
    s.position.copy(p); s.renderOrder = 4; group.add(s);
  }
  function polyline(pts, group) { const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), lineMat); l.renderOrder = 4; group.add(l); }
  function faceMesh(face, group) {
    const { mesh, first, count } = face;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', mesh.geometry.getAttribute('position'));
    g.setIndex(new THREE.BufferAttribute(mesh.geometry.index.array.subarray(first * 3, (first + count) * 3), 1));
    const fm = new THREE.Mesh(g, faceMat); fm.applyMatrix4(mesh.matrixWorld); fm.renderOrder = 4; group.add(fm);
  }
  function onHover(e) {
    if (!on) return;
    clearHl();
    hover = pick(e);
    if (hover?.f) polyline(hover.f.closed ? [...hover.f.pts, hover.f.pts[0]] : hover.f.pts, hl);
    if (hover?.snap) marker(hover.snap.p, hl, 0.005);
    if (hover?.face) faceMesh(hover.face, hl);
    if (pending && hover && !(hover.f && !hover.snap)) {
      const r = between(pending, entity(hover, e), !!hover.snap, e.shiftKey, true);
      if (r) { polyline([r.a, r.b], hl); say(`${fmt(r.a.distanceTo(r.b))}  ${deltas(r.a, r.b)}`); }
    }
    canvas.style.cursor = hover ? 'crosshair' : 'not-allowed';
  }
  // Snapping for other tools (the markup arrow): the same points and edges, without measuring.
  // snapAt: the corner/midpoint/centre, or the point on the edge, under the pointer (null: none,
  // so the caller uses the surface); showSnap lights it up as measure's hover does, faces left out.
  function snapAt(e) {
    if (e.altKey) return null;   // ⌥: free, as in measure
    const h = pick(e);
    return h?.snap || h?.f ? h : null;
  }
  function showSnap(e) {
    clearHl();
    const h = e && snapAt(e);
    if (h?.f) polyline(h.f.closed ? [...h.f.pts, h.f.pts[0]] : h.f.pts, hl);
    if (h?.snap) marker(h.snap.p, hl, 0.005);
    else if (h?.f) marker(h.p, hl, 0.0035);   // where on the edge it lands
    return h;
  }
  // The face under the pointer, lit as measure lights one (the IMAGE tool: which surface the picture lands on).
  function showFace(e) {
    clearHl();
    if (!e) return null;
    const r = canvas.getBoundingClientRect(), m = local(e);
    raycaster.setFromCamera(new THREE.Vector2((m.x / r.width) * 2 - 1, -(m.y / r.height) * 2 + 1), getCamera());
    const hit = raycaster.intersectObjects(solids(), false).find(kept);
    const face = hit?.object.userData.faces?.find((f) => hit.faceIndex >= f.first && hit.faceIndex < f.first + f.count);
    if (face) faceMesh({ mesh: hit.object, ...face }, hl);
    return hit ?? null;
  }
  const meshOf = (h) => h.face?.mesh ?? h.f?.mesh ?? h.snap?.f?.mesh ?? null;
  const entity = (h, e) => ({ mesh: meshOf(h), ...(h.face && !h.snap && !h.f && !e.altKey ? { face: faceData(h.face), raw: h.face } : { p: h.p.clone() }) });

  // ----------------------------------------------------------------- faces
  const faceCache = new Map();
  /** Triangles of a face in world space, its centroid, and its normal when it is planar. */
  function faceData(face) {
    const k = `${face.mesh.id}:${face.first}`;
    if (faceCache.has(k)) return faceCache.get(k);
    const { mesh, first, count } = face;
    const pos = mesh.geometry.getAttribute('position'), idx = mesh.geometry.index.array, M = mesh.matrixWorld;
    const tris = [], nAvg = new THREE.Vector3(), centroid = new THREE.Vector3(), tmp = new THREE.Vector3();
    let area = 0;
    for (let t = first; t < first + count; t++) {
      const tri = new THREE.Triangle(
        new THREE.Vector3().fromBufferAttribute(pos, idx[3 * t]).applyMatrix4(M),
        new THREE.Vector3().fromBufferAttribute(pos, idx[3 * t + 1]).applyMatrix4(M),
        new THREE.Vector3().fromBufferAttribute(pos, idx[3 * t + 2]).applyMatrix4(M));
      const ar = tri.getArea(); if (!ar) continue;
      tris.push(tri); area += ar;
      nAvg.addScaledVector(tri.getNormal(tmp), ar); centroid.addScaledVector(tri.getMidpoint(tmp), ar);
    }
    centroid.divideScalar(area || 1); nAvg.normalize();
    const planar = tris.every((t) => t.getNormal(tmp).dot(nAvg) > 0.9998);
    const data = { tris, n: planar ? nAvg : null, p0: tris[0]?.a ?? centroid, centroid, area };
    faceCache.set(k, data);
    return data;
  }
  /** What kind of surface a curved face is: a cylinder (axis, radius, span) or a sphere. */
  function surfaceOf(F) {
    if (F.n || F.tris.length < 2) return null;
    const cyl = cylinderFit(F.tris, F.centroid, scaleHint);
    if (cyl) return { kind: 'cyl', ...cyl };
    const verts = []; for (const t of F.tris) verts.push(t.a, t.b, t.c);
    const sph = fitSphere(verts);
    if (sph && sph.rms < sph.r * 0.01 + scaleHint * 1e-4) return { kind: 'sphere', c: sph.c, r: sph.r, p: sph.c.clone().add(F.centroid.clone().sub(sph.c).normalize().multiplyScalar(sph.r)) };
    return null;
  }
  const fitSphere = sphereFit;
  /** The two ends of the dimension between A and B (points or faces); quick: skip the slow search. */
  function between(A, B, bIsSnap, free, quick = false) {
    if (A.face && B.face) {
      if (A.face.n && B.face.n && Math.abs(A.face.n.dot(B.face.n)) > 0.999) {   // parallel planes: the gap
        const a = A.face.centroid.clone(), d = B.face.p0.clone().sub(a).dot(A.face.n);
        return { a, b: a.clone().addScaledVector(A.face.n, d) };
      }
      return quick ? null : closest(A.face, B.face);
    }
    if (A.face || B.face) {
      const F = A.face ?? B.face, p = A.face ? B.p : A.p;
      if (F.n) { const d = p.clone().sub(F.p0).dot(F.n); return { a: p, b: p.clone().addScaledVector(F.n, -d) }; }
      if (quick) return null;
      let best = Infinity, foot = p; const tmp = new THREE.Vector3();
      for (const t of F.tris) { t.closestPointToPoint(p, tmp); const d = p.distanceToSquared(tmp); if (d < best) { best = d; foot = tmp.clone(); } }
      return { a: p, b: foot };
    }
    return { a: A.p, b: orthoSnap(A.p, B.p, bIsSnap, free) };
  }
  /** Closest approach of two triangle sets: vertices of each against triangles of the other. */
  function closest(A, B) {
    const verts = (F) => { const step = Math.max(1, Math.ceil(F.tris.length * 3 / 400)), out = []; for (let i = 0; i < F.tris.length * 3; i += step) { const t = F.tris[Math.floor(i / 3)]; out.push([t.a, t.b, t.c][i % 3]); } return out; };
    let best = Infinity, a = A.centroid, b = B.centroid; const tmp = new THREE.Vector3();
    for (const [P, Q, swap] of [[A, B, false], [B, A, true]]) {
      for (const v of verts(P)) for (const t of Q.tris) {
        t.closestPointToPoint(v, tmp); const d = v.distanceToSquared(tmp);
        if (d < best) { best = d; [a, b] = swap ? [tmp.clone(), v] : [v, tmp.clone()]; }
      }
    }
    return { a, b };
  }
  function orthoSnap(a, b, bIsSnap, free) {
    if (free) return b;
    const d = b.clone().sub(a), len = d.length();
    if (!len) return b;
    const i = [0, 1, 2].reduce((best, k) => (Math.abs(d.getComponent(k)) > Math.abs(d.getComponent(best)) ? k : best), 0);
    const cos = Math.abs(d.getComponent(i)) / len;
    if (cos < (bIsSnap ? 0.9995 : 0.96)) return b;       // a real snap only yields to an exact alignment
    const out = a.clone(); out.setComponent(i, b.getComponent(i)); return out;
  }

  // ----------------------------------------------------------------- click
  function onClick(e) {
    if (!on) return;
    const h = hover ?? pick(e);
    if (!h) return;
    if (!h.snap && h.f) {                                   // the edge itself: one-click dimension
      pending = null; clearSel();
      const m = h.f.mesh;
      if (h.f.kind === 'arc') add(h.f.closed
        ? { kind: 'dia', c: h.f.c.toArray(), r: h.f.r, u: h.f.u.toArray(), v: h.f.v.toArray() }
        : { kind: 'rad', c: h.f.c.toArray(), r: h.f.r, p: h.f.pts[Math.floor(h.f.pts.length / 2)].toArray() }, m);
      else add({ kind: 'len', a: h.f.a.toArray(), b: h.f.b.toArray() }, m);
      return;
    }
    const ent = entity(h, e);
    if (!pending) {
      pending = ent; clearHl();
      if (ent.face) faceMesh(ent.raw, sel); else marker(ent.p, sel);
      if (ent.face) {
        const surf = surfaceOf(ent.face);                     // a curved face reads itself at once
        if (surf?.kind === 'cyl') { add(surf.closed ? { kind: 'dia', c: surf.c.toArray(), r: surf.r, u: surf.u.toArray(), v: surf.v.toArray() } : { kind: 'rad', c: surf.c.toArray(), r: surf.r, p: surf.p.toArray() }, ent.mesh); say(`${text(dims[dims.length - 1])} — pick a second face or a point for a distance`); }
        else if (surf?.kind === 'sphere') { add({ kind: 'rad', sph: true, c: surf.c.toArray(), r: surf.r, p: surf.p.toArray() }, ent.mesh); say(`${text(dims[dims.length - 1])} — pick a second face or a point for a distance`); }
        else say(`${ent.face.n ? `planar face, area ${fmt(ent.face.area)}` : 'curved face'} — pick a second face or a point`);
      } else say('point set — pick a second point or a face');
      return;
    }
    const r = between(pending, ent, !!h.snap, e.shiftKey);
    const swap = pending.face && !ent.face;   // between() puts the point first and its foot on the face second
    add({ kind: 'dist', a: r.a.toArray(), b: r.b.toArray() }, swap ? ent.mesh : pending.mesh, swap ? pending.mesh : ent.mesh);
    pending = null; clearSel();
  }
  function clearSel() { for (const o of [...sel.children]) { sel.remove(o); o.geometry?.dispose(); } }
  // A dimension is anchored to the bodies it was read from: its coordinates are kept in each body's own
  // frame (d.on names the body per end) and put back into the world as the body stands now, so it rides the
  // explode, a joint or the triad. A missing body, or an old file without d.on, reads the coordinates as world.
  const ANCHORED = { len: ['a', 'b'], dist: ['a', 'b'], dia: ['c', 'u', 'v'], rad: ['c', 'p'] };
  function add(d, mA, mB = mA) {
    for (const [i, f] of ANCHORED[d.kind].entries()) {
      const m = i === 1 && d.kind !== 'dia' && d.kind !== 'rad' ? mB : mA, key = m && keyOf(m);
      if (!key) continue;
      const inv = m.matrixWorld.clone().invert(), v = new THREE.Vector3(...d[f]);
      d[f] = (f === 'u' || f === 'v' ? v.transformDirection(inv) : v.applyMatrix4(inv)).toArray();
      (d.on ??= {})[f] = key;
    }
    dims.push(d); render(); onChange?.(); say(text(d));
  }
  /** The dimension's coordinates in the world, as its bodies stand now. */
  function W(d) {
    const out = {};
    for (const f of ANCHORED[d.kind] ?? []) {
      const v = new THREE.Vector3(...d[f]), m = d.on?.[f] && bodyOf(d.on[f]);
      if (m) m.updateMatrixWorld(true);   // applyExplode has just set the position; the matrix is only refreshed at the next frame
      out[f] = m ? (f === 'u' || f === 'v' ? v.transformDirection(m.matrixWorld) : v.applyMatrix4(m.matrixWorld)) : v;
    }
    return out;
  }

  // ----------------------------------------------------------------- dims
  const fmt = (v) => v.toFixed(3);
  const deltas = (a, b) => `(Δx ${fmt(Math.abs(a.x - b.x))}  Δy ${fmt(Math.abs(a.y - b.y))}  Δz ${fmt(Math.abs(a.z - b.z))})`;
  function text(d) {
    if (d.kind === 'dia') return `⌀${fmt(d.r * 2)}`;
    if (d.kind === 'rad') return `${d.sph ? 'SR' : 'R'}${fmt(d.r)}`;
    const { a, b } = W(d); return fmt(a.distanceTo(b));
  }
  function label(t, pos, d) {
    const el = document.createElement('div');
    el.className = 'mlabel'; el.textContent = t; el.title = 'Click to remove';
    el.userData = { pos };
    el.addEventListener('click', (ev) => { ev.stopPropagation(); dims = dims.filter((x) => x !== d); render(); onChange?.(); });
    layer.appendChild(el); labels.push(el);
  }
  function render() {
    for (const o of [...dimGroup.children]) { dimGroup.remove(o); o.geometry?.dispose(); }
    for (const l of labels) l.remove();
    labels = [];
    for (const d of dims) {
      if (d.kind === 'dist' || d.kind === 'len') {
        const { a, b } = W(d);
        polyline([a, b], dimGroup); marker(a, dimGroup); marker(b, dimGroup);
        label(text(d), a.clone().lerp(b, 0.5), d);
      } else if (d.kind === 'dia') {
        const { c, u, v } = W(d);
        const ring = []; for (let k = 0; k <= 72; k++) { const t = k / 72 * Math.PI * 2; ring.push(c.clone().addScaledVector(u, Math.cos(t) * d.r).addScaledVector(v, Math.sin(t) * d.r)); }
        polyline(ring, dimGroup);
        const a = c.clone().addScaledVector(u, -d.r), b = c.clone().addScaledVector(u, d.r);
        polyline([a, b], dimGroup); marker(a, dimGroup); marker(b, dimGroup);
        label(text(d), c.clone().addScaledVector(u, d.r * 0.5), d);
      } else if (d.kind === 'rad') {
        const { c, p } = W(d);
        polyline([c, p], dimGroup); marker(c, dimGroup); marker(p, dimGroup);
        label(text(d), c.clone().lerp(p, 0.5), d);
      }
    }
    const footer = document.querySelector('#measures');
    if (footer && dims.length) footer.textContent = dims.map(text).join(' · ');
  }
  function projectLabels() {
    const r = canvas.getBoundingClientRect();
    for (const l of labels) {
      const v = l.userData.pos.clone().project(getCamera());
      l.style.left = `${(v.x + 1) / 2 * r.width}px`;
      l.style.top = `${(1 - v.y) / 2 * r.height}px`;
      l.hidden = v.z > 1;
    }
  }

  return {
    get on() { return on; },
    setOn(v) { on = v; pending = null; clearHl(); clearSel(); canvas.style.cursor = v ? 'crosshair' : ''; if (v) dirty = true; },
    invalidate() { dirty = true; faceCache.clear(); if (dims.some((d) => d.on)) render(); },   // the bodies moved: anchored dims move with them
    hover: onHover, click: onClick, projectLabels,
    snapAt: (e) => snapAt(e)?.p.clone() ?? null, showSnap: (e) => !!showSnap(e), showFace: (e) => !!showFace(e), clearSnap: () => { if (!on) clearHl(); },
    pointSnapAt,
    cancel() { const had = !!pending; pending = null; clearSel(); return had; },
    get dims() { return dims; },
    get features() { if (dirty) build(); return features; },   // for headless drives
    get pendingKind() { return pending ? (pending.face ? 'face' : 'point') : null; },
    debugPick(clientX, clientY) { const h = pick({ clientX, clientY }); if (!h) return null; const fd = h.face && faceData(h.face); return { snap: h.snap?.kind, f: h.f?.kind, p: h.p.toArray(), face: h.face && { mesh: h.face.mesh.userData.name, first: h.face.first, count: h.face.count, planar: !!fd.n, n: fd.n?.toArray(), p0: fd.p0.toArray(), centroid: fd.centroid.toArray() } }; },
    load(list) { dims = Array.isArray(list) ? list : []; render(); },
    clear() { dims = []; pending = null; clearHl(); clearSel(); faceCache.clear(); render(); },
  };
}
