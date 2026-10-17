import * as THREE from 'three';

/**
 * A drawing sheet from the open model in the CW&T drawing template (templates/drawing/README.md; the
 * reference set is templates/drawing/Ultra Bench T Drawing v4.pdf, drawn with stepdraw): ISO frame with a
 * zone grid, a 180 × 45 mm title block bottom right with the CW&T wordmark, Space Mono in the title block,
 * Courier for dimensions, notes and captions. Views are line art rendered by the viewer itself (white bodies,
 * black silhouette and B-rep edges; front, top, right in third angle, an isometric at half scale); the user's
 * dimensions are drawn with extension lines and arrows, diameters and radii as leaders; notes are upper-case
 * and numbered; an optional parts list sits top right. Everything is laid out in millimetres in one SVG, so
 * the browser prints the sheet at the stated scale. Claude collects the spec over MCP; renderDrawing turns it
 * into one self-contained HTML page.
 */
export const SHEETS = { A4: [210, 297], A3: [297, 420], A2: [420, 594], Letter: [215.9, 279.4], Tabloid: [279.4, 431.8] };
export const SCALES = [20, 10, 5, 2, 1, 1 / 2, 1 / 5, 1 / 10, 1 / 20, 1 / 50, 1 / 100];
const MARGIN = 10, GAP = 24, TITLE_W = 180, TITLE_H = 45, PARTS_W = 120, NOTE_LINE = 4.2, DIM = 8;
const TB = "'Space Mono', monospace", MONO = "'Courier New', Courier, monospace";

/** Padding around a view, in model units: the viewer frames each view with 8% + 2 mm of air. */
const pad = (vw, vh) => Math.max(vw, vh) * 0.08 + 2;
/** Sheet layout at a scale: top view over front, isometric over right (below a parts list of partsH); sizes in mm. */
export function layout(w, h, d, s, withIso = true, partsH = 0) {
  // the isometric is not to scale: half the sheet scale, so it does not dictate the rest
  const si = s / 2, isoW = 0.707 * (w + d), isoH = 0.816 * h + 0.408 * (w + d);
  const pF = pad(w, h), pT = pad(w, d), pR = pad(d, h), pI = pad(isoW, isoH);
  const col1 = Math.max(w + 2 * pF, w + 2 * pT) * s, col2 = Math.max((d + 2 * pR) * s, withIso ? (isoW + 2 * pI) * si : 0);
  const row1 = Math.max((d + 2 * pT) * s, withIso ? (isoH + 2 * pI) * si + partsH : 0), row2 = (h + 2 * Math.max(pF, pR)) * s;
  return { col1, col2, row1, row2, totalW: col1 + GAP + col2, totalH: row1 + GAP + row2 };
}
/** The largest standard scale at which the whole layout fits the sheet above the title block and the notes (bottom left). */
export function fitScale(w, h, d, sheetW, sheetH, withIso = true, notesH = 0, partsH = 0) {
  const useW = sheetW - 2 * MARGIN, useH = sheetH - 2 * MARGIN - Math.max(TITLE_H, notesH);
  return SCALES.find((s) => { const L = layout(w, h, d, s, withIso, partsH); return L.totalW <= useW && L.totalH <= useH; }) ?? SCALES[SCALES.length - 1];
}
export const scaleText = (s) => (s >= 1 ? `${s}:1` : `1:${Math.round(1 / s)}`);
/** Break a note into lines of at most `width` characters at spaces. */
export function wrap(s, width = 60) {
  const out = []; let line = '';
  for (const w of String(s).trim().split(/\s+/)) {
    if (line && line.length + 1 + w.length > width) { out.push(line); line = w; } else line = line ? `${line} ${w}` : w;
  }
  if (line) out.push(line);
  return out;
}
/** The NOTES block: material, finish and tolerances first, then the spec's notes, then the standing last note. */
export function noteLines(spec, width = 60) {
  const items = [];
  if (spec.material) items.push(`MATERIAL: ${spec.material}`);
  if (spec.finish) items.push(`FINISH: ${spec.finish}`);
  if (spec.tolerances) items.push(`UNLESS NOTED: ${spec.tolerances}`);
  items.push(...(spec.notes ?? []).filter(Boolean));
  items.push(`DO NOT SCALE DRAWING. DIMENSIONS IN ${spec.units === 'in' ? 'INCHES' : 'MM'}.`);
  const lines = ['NOTES:'];
  items.forEach((it, i) => wrap(String(it).toUpperCase(), width).forEach((l, j) => lines.push((j ? '   ' : `${i + 1}. `) + l)));
  return lines;
}

const AXES = { '+x': [1, 0, 0], '-x': [-1, 0, 0], '+y': [0, 1, 0], '-y': [0, -1, 0], '+z': [0, 0, 1], '-z': [0, 0, -1] };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
const f2 = (v) => (+v).toFixed(2);
const tw = (s, size, em = 0.6) => String(s).length * size * em;      // Courier 0.6 em, Space Mono 0.61 em
const text = (x, y, s, size, { font = MONO, anchor = 'start', angle = 0, track = 0 } = {}) =>
  `<text x="${f2(x)}" y="${f2(y)}" font-family="${font}" font-size="${size}" text-anchor="${anchor}"${track ? ` letter-spacing="${f2(track * size)}"` : ''}${angle ? ` transform="rotate(${angle} ${f2(x)} ${f2(y)})"` : ''}>${esc(s)}</text>`;
const line = (a, b, w = 0.35, dash = '') => `<line x1="${f2(a[0])}" y1="${f2(a[1])}" x2="${f2(b[0])}" y2="${f2(b[1])}" stroke="#000" stroke-width="${w}"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`;
const rect = (x, y, w, h, sw = 0.35) => `<rect x="${f2(x)}" y="${f2(y)}" width="${f2(w)}" height="${f2(h)}" fill="none" stroke="#000" stroke-width="${sw}"/>`;
/** Filled arrowhead with its point at tip, coming from `from` (stepdraw: 2.5 long, 0.45 half-width). */
function arrow(tip, from, size = 2.5) {
  const dx = tip[0] - from[0], dy = tip[1] - from[1], l = Math.hypot(dx, dy) || 1, d = [dx / l, dy / l], n = [-d[1], d[0]];
  const p = (s) => `${f2(tip[0] - d[0] * size + n[0] * size * 0.18 * s)},${f2(tip[1] - d[1] * size + n[1] * size * 0.18 * s)}`;
  return `<polygon points="${f2(tip[0])},${f2(tip[1])} ${p(1)} ${p(-1)}" fill="#000"/>`;
}

/** The sheet frame, zone grid and title block of the template, generalised from A3 to the sheet size. */
function frame(W, H, spec) {
  const o = [rect(5, 5, W - 10, H - 10, 0.25), rect(10, 10, W - 20, H - 20, 0.5)];
  const ncol = Math.max(1, Math.round((W - 20) / 50)), cw = (W - 20) / ncol;
  for (let i = 0; i < ncol; i++) {
    const x = 10 + i * cw;
    if (i) o.push(line([x, 5], [x, 10], 0.25), line([x, H - 10], [x, H - 5], 0.25));
    o.push(text(x + cw / 2, 8.5, String(i + 1), 2.5, { anchor: 'middle' }), text(x + cw / 2, H - 6.5, String(i + 1), 2.5, { anchor: 'middle' }));
  }
  const nrow = Math.max(1, Math.round((H - 20) / 46.17)), rh = (H - 20) / nrow;
  for (let i = 0; i < nrow; i++) {
    const y = 10 + i * rh;
    if (i) o.push(line([5, y], [10, y], 0.25), line([W - 10, y], [W - 5, y], 0.25));
    o.push(text(7.5, y + rh / 2 + 1, 'ABCDEFGHIJ'[i], 2.5, { anchor: 'middle' }), text(W - 7.5, y + rh / 2 + 1, 'ABCDEFGHIJ'[i], 2.5, { anchor: 'middle' }));
  }
  // title block 180 × 45 bottom right; y measured up from its bottom edge like the template
  const x0 = W - MARGIN - TITLE_W, ty = (y) => H - MARGIN - y;
  o.push(rect(x0, ty(45), 180, 45),
    line([x0, ty(33)], [x0 + 180, ty(33)]), line([x0, ty(22)], [x0 + 60, ty(22)]), line([x0 + 60, ty(0)], [x0 + 60, ty(45)]),
    line([x0 + 30, ty(33)], [x0 + 30, ty(45)]), line([x0 + 125, ty(0)], [x0 + 125, ty(45)]), line([x0 + 60, ty(11)], [x0 + 180, ty(11)]),
    line([x0 + 160, ty(0)], [x0 + 160, ty(11)]));
  const small = (x, y, s) => text(x + 1.5, ty(y - 3), s.toUpperCase(), 1.8, { font: TB, track: 0.06 });
  const fit = (s, size, width) => Math.min(size, size * width / Math.max(tw(s, size, 0.61), 1));
  const val = (x, y, s, size = 3, width = 0) => text(x + 1.5, ty(y), s ?? '', width ? fit(s ?? '', size, width) : size, { font: TB });
  const today = new Date().toISOString().slice(0, 10);
  const doctype = (spec.doctype ?? 'Fabrication drawing') + (spec.sheetTitle ? ` - ${spec.sheetTitle}` : '');
  o.push(small(x0, 45, 'Dept.'), small(x0 + 30, 45, 'Technical reference'), small(x0 + 60, 45, 'Created by'), small(x0 + 125, 45, 'Approved by'),
    small(x0 + 60, 33, 'Document type'), small(x0 + 125, 33, 'Document status'), small(x0 + 60, 22, 'Title'), small(x0 + 125, 22, 'DWG No.'),
    small(x0 + 60, 11, 'Rev.'), small(x0 + 125, 11, 'Date of issue'), small(x0 + 160, 11, 'Sheet'),
    val(x0, 36, spec.dept ?? 'CW&T'), val(x0 + 30, 36, spec.technicalRef ?? ''),
    text(x0 + 30, ty(8), 'CW&T', 9, { font: TB, anchor: 'middle' }),
    val(x0 + 60, 36, spec.createdBy ?? spec.drawnBy ?? ''), val(x0 + 125, 36, spec.approvedBy ?? spec.date ?? today),
    val(x0 + 60, 25, doctype, 2.6, 62), val(x0 + 125, 25, spec.status ?? 'FOR FABRICATION', 2.6),
    val(x0 + 60, 13.5, spec.title ?? spec.part ?? '', 4.5, 62), val(x0 + 125, 13.5, spec.dwg ?? spec.part ?? '', 3, 52),
    val(x0 + 60, 3, spec.rev ?? 'A'), val(x0 + 125, 3, spec.date ?? today),
    text(x0 + 170, ty(3), `${spec.sheetNo ?? 1}/${spec.sheetCount ?? 1}`, 3, { font: TB, anchor: 'middle' }),
    text(W - MARGIN, H - 2.5, 'CWT_SW_CADGANG_VIEW', 1.8, { font: TB, anchor: 'end', track: 0.06 }));
  return o;
}

/** Parts list top right: Item / Qty / Part Number / Material, 5 mm rows. */
function partsTable(x, y, parts) {
  const cols = [['Item', 12], ['Qty', 12], ['Part Number', 48], ['Material', 48]], wsum = 120, rowh = 5, o = [];
  const row = (cells, yy) => {
    let cx = x;
    o.push(rect(x, yy, wsum, rowh));
    cells.forEach((c, i) => { if (i) o.push(line([cx, yy], [cx, yy + rowh])); o.push(text(cx + 1.5, yy + 3.7, c, 3)); cx += cols[i][1]; });
  };
  o.push(rect(x, y, wsum, rowh), text(x + wsum / 2, y + 3.7, 'Parts List', 3, { anchor: 'middle' })); y += rowh;
  row(cols.map((c) => c[0]), y); y += rowh;
  for (const p of parts) { row((Array.isArray(p) ? p : [p.item, p.qty, p.part, p.material]).map((c) => String(c ?? '')), y); y += rowh; }
  return o;
}

/**
 * Render the scene from cam as line art: white bodies, black silhouette (0.35 mm) and black B-rep edges.
 * Two passes — black bodies for the silhouette, white bodies with ink edges — composed on a 2D canvas.
 */
function lineArt(renderer, scene, model, cam, pw, ph, k) {
  const meshes = model.children.filter((m) => !m.isLine);
  const saved = meshes.map((m) => ({ m, mat: m.material, e: m.userData.edges, ev: m.userData.edges?.visible, em: m.userData.edges?.material }));
  const black = new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.DoubleSide });
  const white = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
  const ink = new THREE.LineBasicMaterial({ color: 0x000000 });
  const shot = () => { renderer.render(scene, cam); const c = document.createElement('canvas'); c.width = pw; c.height = ph; c.getContext('2d').drawImage(renderer.domElement, 0, 0, pw, ph); return c; };
  const keep = new Set([model, ...saved.map((s) => s.e?.parent).filter(Boolean)]);   // only bodies and their edges: no grid, markup, measure overlays
  const hidden = scene.children.filter((o) => o.visible && !keep.has(o));
  for (const o of hidden) o.visible = false;
  for (const s of saved) { s.m.material = black; if (s.e) s.e.visible = false; }
  const sil = shot();
  for (const s of saved) { s.m.material = white; if (s.e) { s.e.visible = true; s.e.material = ink; } }
  const edg = shot();
  for (const s of saved) { s.m.material = s.mat; if (s.e) { s.e.visible = s.ev; s.e.material = s.em; } }
  for (const o of hidden) o.visible = true;
  black.dispose(); white.dispose(); ink.dispose();
  const out = document.createElement('canvas'); out.width = pw; out.height = ph;
  const g = out.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, pw, ph);
  const r = Math.max(1, 0.35 * k / 2);                      // silhouette dilated by r px, then its inside cleared: an outline ring
  g.globalCompositeOperation = 'multiply';
  for (let i = 0; i < 8; i++) g.drawImage(sil, r * Math.cos(i * Math.PI / 4), r * Math.sin(i * Math.PI / 4));
  g.globalCompositeOperation = 'screen'; g.filter = 'invert(1)'; g.drawImage(sil, 0, 0); g.filter = 'none';
  g.globalCompositeOperation = 'multiply';
  for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) g.drawImage(edg, dx, dy);
  return out;
}

/**
 * spec: { sheet, landscape, units, decimals, front, up, views[], scale, title, dwg|part, rev, material, finish, tolerances,
 *         notes[], parts[], dept, technicalRef, createdBy|drawnBy, approvedBy, doctype, status, sheetTitle, sheetNo, sheetCount, date }
 * ctx:  { renderer, scene, model, bbox, measure, hide: [objects to hide while rendering], restore() }
 */
export function renderDrawing(spec, ctx) {
  const { renderer, scene, model, bbox, measure } = ctx;
  const [sw, sh] = SHEETS[spec.sheet] ?? SHEETS.A3;
  const [W, H] = spec.landscape === false ? [sw, sh] : [sh, sw];
  const F = new THREE.Vector3(...(AXES[spec.front] ?? AXES['-y']));       // where the front viewer stands
  const U = new THREE.Vector3(...(AXES[spec.up] ?? AXES['+z']));
  if (Math.abs(F.dot(U)) > 0.5) U.set(...(Math.abs(F.z) > 0.5 ? AXES['+y'] : AXES['+z']));
  const R = U.clone().cross(F).normalize();                                 // the part's right, seen from the front
  const centre = bbox.getCenter(new THREE.Vector3()), corners = boxCorners(bbox);
  const extent = (axis) => { const ts = corners.map((c) => c.clone().sub(centre).dot(axis)); return [Math.min(...ts), Math.max(...ts)]; };
  const [r0, r1] = extent(R), [u0, u1] = extent(U), [f0, f1] = extent(F);
  const w = r1 - r0, h = u1 - u0, d = f1 - f0;
  const notes = noteLines(spec, Math.min(100, Math.floor((W - 2 * MARGIN - TITLE_W - 4) / 1.8))), notesH = 6 + NOTE_LINE * notes.length;   // bottom left, beside the title block
  const parts = (spec.parts ?? []).filter(Boolean), partsH = parts.length ? (parts.length + 2) * 5 + 5 : 0;   // top right, above the isometric
  const wantIso = !spec.views?.length || spec.views.includes('iso');
  const scale = spec.scale === 'fit' || !spec.scale ? fitScale(w, h, d, W, H, wantIso, notesH, partsH) : spec.scale;
  const inch = spec.units === 'in', toUnit = inch ? 1 / 25.4 : 1, suffix = inch ? '"' : '';
  const decLin = spec.decimals ?? (inch ? 3 : 1), decDia = spec.decimals ?? (inch ? 3 : 2);
  const fmt = (v, dec) => (v * toUnit).toFixed(dec) + suffix;
  const views = {
    front: { dir: F, up: U, cap: `FRONT, SCALE ${scaleText(scale)}` },
    top: { dir: U, up: F.clone().negate(), cap: 'TOP' },                  // third angle: the top view above the front, front edge at the bottom
    right: { dir: R, up: U, cap: 'RIGHT' },
    iso: { dir: F.clone().add(R).add(U).normalize(), up: U, scale: 0.5, cap: `ISOMETRIC VIEW, SCALE ${scaleText(scale / 2)}` },
  };
  const wanted = (spec.views?.length ? spec.views : ['front', 'top', 'right', 'iso']).filter((v) => views[v]);
  const dist = bbox.getSize(new THREE.Vector3()).length() * 2;

  // render each view as line art with an orthographic camera framing the box
  for (const o of ctx.hide) o.visible = false;
  const bg = scene.background; scene.background = new THREE.Color(0xffffff);
  const PX_PER_MM = 10, MAXPX = 2600;
  for (const name of wanted) {
    const v = views[name];
    const cam = new THREE.OrthographicCamera();
    cam.position.copy(centre).addScaledVector(v.dir, dist); cam.up.copy(v.up); cam.lookAt(centre);
    cam.updateMatrixWorld();
    const inv = cam.matrixWorldInverse;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const c of corners) { const p = c.clone().applyMatrix4(inv); x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); }
    const p = pad(x1 - x0, y1 - y0);
    x0 -= p; x1 += p; y0 -= p; y1 += p;
    cam.left = x0; cam.right = x1; cam.bottom = y0; cam.top = y1; cam.near = 0.1; cam.far = dist * 4;
    cam.updateProjectionMatrix();
    const vs = scale * (v.scale ?? 1), mmW = (x1 - x0) * vs, mmH = (y1 - y0) * vs;
    const k = Math.min(PX_PER_MM, MAXPX / Math.max(mmW, mmH));
    const pw = Math.round(mmW * k), ph = Math.round(mmH * k);
    renderer.setSize(pw, ph, false);
    Object.assign(v, { cam, mmW, mmH, src: lineArt(renderer, scene, model, cam, pw, ph, k).toDataURL('image/png') });
  }
  scene.background = bg;
  for (const o of ctx.hide) o.visible = true;
  ctx.restore();

  // layout: top view over front, isometric over right; everything in mm
  const L = layout(w, h, d, scale, wantIso, partsH);
  const left = MARGIN, top = MARGIN;
  const mid = (slotW, vw) => (slotW - vw) / 2;
  const place = {
    top: { x: left + mid(L.col1, views.top.mmW ?? 0), y: top + L.row1 - (views.top.mmH ?? 0) },
    front: { x: left + mid(L.col1, views.front.mmW ?? 0), y: top + L.row1 + GAP },
    right: { x: left + L.col1 + GAP + mid(L.col2, views.right.mmW ?? 0), y: top + L.row1 + GAP },
    iso: { x: left + L.col1 + GAP + mid(L.col2, views.iso.mmW ?? 0), y: top + L.row1 - (views.iso.mmH ?? 0) },
  };
  const svg = frame(W, H, spec);
  for (const name of wanted) {
    const v = views[name], at = place[name];
    v.at = at;
    v.paper = (p) => { const q = new THREE.Vector3(...p).project(v.cam); return [at.x + (q.x + 1) / 2 * v.mmW, at.y + (1 - q.y) / 2 * v.mmH]; };
    const cs = corners.map((c) => v.paper(c.toArray()));
    v.box = { x0: Math.min(...cs.map((c) => c[0])), x1: Math.max(...cs.map((c) => c[0])), y0: Math.min(...cs.map((c) => c[1])), y1: Math.max(...cs.map((c) => c[1])) };
    v.stack = { below: 0, right: 0, lead: 0 };
    svg.push(`<image x="${f2(at.x)}" y="${f2(at.y)}" width="${f2(v.mmW)}" height="${f2(v.mmH)}" href="${v.src}"/>`);
  }

  // dimensions: each one goes in the first orthographic view that shows it fully (front, right, top; never the iso)
  const ortho = ['front', 'right', 'top'].filter((n) => wanted.includes(n)).map((n) => views[n]);
  const V3 = (a) => new THREE.Vector3(...a);
  const linear = (v, A, B, value) => {
    const horiz = Math.abs(B[0] - A[0]) >= Math.abs(B[1] - A[1]), label = fmt(value, decLin), lw = tw(label, 3.5) + 2;
    if (horiz) {   // dimension line below the part, stacked DIM apart
      const y = v.box.y1 + DIM * (1 + v.stack.below++), lo = Math.min(A[0], B[0]), hi = Math.max(A[0], B[0]);
      svg.push(line(A, [A[0], y + 2], 0.18), line(B, [B[0], y + 2], 0.18), line([lo, y], [hi, y], 0.18), arrow([lo, y], [hi, y]), arrow([hi, y], [lo, y]));
      svg.push(text(lw > hi - lo ? hi + lw / 2 + 3 : (lo + hi) / 2, y - 1.2, label, 3.5, { anchor: 'middle' }));
    } else {       // dimension line right of the part, text reading from the right
      const x = v.box.x1 + DIM * (1 + v.stack.right++), lo = Math.min(A[1], B[1]), hi = Math.max(A[1], B[1]);
      svg.push(line(A, [x + 2, A[1]], 0.18), line(B, [x + 2, B[1]], 0.18), line([x, lo], [x, hi], 0.18), arrow([x, lo], [x, hi]), arrow([x, hi], [x, lo]));
      svg.push(text(x - 1.2, lw > hi - lo ? lo - lw / 2 - 3 : (lo + hi) / 2, label, 3.5, { anchor: 'middle', angle: -90 }));
    }
  };
  const leader = (v, tip, label) => {   // text top left of the part, shoulder under it, arrow at the tip
    const pos = [v.box.x0 - 2, v.box.y0 - 4 - DIM * v.stack.lead++], elbow = [pos[0] + 1.5, pos[1] + 1.2];
    svg.push(line(tip, elbow, 0.18), arrow(tip, elbow), line(elbow, [elbow[0] - tw(label, 3.5) - 3, elbow[1]], 0.18), text(pos[0], pos[1], label, 3.5, { anchor: 'end' }));
  };
  for (const dm of measure.dims) {
    if (dm.kind === 'dist' || dm.kind === 'len') {
      const full = V3(dm.a).distanceTo(V3(dm.b)) * scale;
      for (const v of ortho) {
        const A = v.paper(dm.a), B = v.paper(dm.b);
        if (Math.hypot(B[0] - A[0], B[1] - A[1]) < Math.max(1, 0.9 * full)) continue;
        linear(v, A, B, (Math.abs(B[0] - A[0]) >= Math.abs(B[1] - A[1]) ? Math.abs(B[0] - A[0]) : Math.abs(B[1] - A[1])) / scale);
        break;
      }
    } else if (dm.kind === 'dia') {
      const axis = V3(dm.u).cross(V3(dm.v)).normalize(), label = `⌀${fmt(dm.r * 2, decDia)}`;
      const v = ortho.find((o) => Math.abs(axis.dot(o.dir)) > 0.9) ?? ortho[0];
      if (!v) continue;
      const C = v.paper(dm.c), rp = dm.r * scale;
      if (Math.abs(axis.dot(v.dir)) > 0.9) {           // seen face-on: leader to the rim, toward the text
        const pos = [v.box.x0 - 2, v.box.y0 - 4 - DIM * v.stack.lead], dx = pos[0] - C[0], dy = pos[1] - C[1], l = Math.hypot(dx, dy) || 1;
        leader(v, [C[0] + dx / l * rp, C[1] + dy / l * rp], label);
      } else {                                           // seen edge-on: tip at the rim point that projects farthest from the centre
        const tips = [dm.u, dm.v].map((e) => v.paper(V3(dm.c).addScaledVector(V3(e), dm.r).toArray()));
        leader(v, tips.sort((p, q) => Math.hypot(q[0] - C[0], q[1] - C[1]) - Math.hypot(p[0] - C[0], p[1] - C[1]))[0], label);
      }
    } else if (dm.kind === 'rad') {
      const label = `${dm.sph ? 'SR' : 'R'}${fmt(dm.r, decDia)}`;
      const v = ortho.find((o) => { const C = o.paper(dm.c), P = o.paper(dm.p); return Math.hypot(P[0] - C[0], P[1] - C[1]) >= 0.9 * dm.r * scale; }) ?? ortho[0];
      if (v) leader(v, v.paper(dm.p), label);
    }
  }
  for (const name of wanted) {   // captions under the views, below any stacked dimensions
    const v = views[name], y = name === 'iso' ? v.at.y + v.mmH + 4 : v.box.y1 + DIM * (1 + v.stack.below) + 2;
    svg.push(text(v.at.x + v.mmW / 2, y, v.cap, 3.5, { anchor: 'middle' }));
  }
  const nb = H - MARGIN - 3 - (notes.length - 1) * NOTE_LINE;
  notes.forEach((l, i) => svg.push(text(12, nb + i * NOTE_LINE, l, 3)));
  if (parts.length) svg.push(...partsTable(W - MARGIN - PARTS_W, MARGIN, parts));

  const origin = typeof location !== 'undefined' ? location.origin : 'http://localhost:4477';
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${esc(spec.title || spec.part || 'Drawing')}</title>
<style>
@font-face { font-family: "Space Mono"; src: url("${origin}/fonts/SpaceMono-Regular.ttf") format("truetype"); font-weight: 400; }
@page { size: ${W}mm ${H}mm; margin: 0; }
html, body { margin: 0; background: #fff; }
svg { display: block; width: ${W}mm; height: ${H}mm; page-break-after: always; }
</style></head><body>
<svg xmlns="http://www.w3.org/2000/svg" xml:space="preserve" viewBox="0 0 ${W} ${H}" width="${W}mm" height="${H}mm" fill="#000">
${svg.join('\n')}
</svg>
</body></html>`;
}

function boxCorners(b) {
  const out = [];
  for (const x of [b.min.x, b.max.x]) for (const y of [b.min.y, b.max.y]) for (const z of [b.min.z, b.max.z]) out.push(new THREE.Vector3(x, y, z));
  return out;
}
