import * as THREE from 'three';

/**
 * A drawing sheet from the open model: orthographic views rendered by the viewer itself (front,
 * top, right in third angle, plus an isometric), the user's dimensions drawn on them, a title
 * block. Everything is laid out in millimetres with CSS physical units, so the browser prints
 * the sheet at the stated scale. Claude collects the spec (sheet, units, front face, views,
 * scale, title block) over MCP; renderDrawing turns it into one self-contained HTML page.
 */
export const SHEETS = { A4: [210, 297], A3: [297, 420], A2: [420, 594], Letter: [215.9, 279.4], Tabloid: [279.4, 431.8] };
export const SCALES = [20, 10, 5, 2, 1, 1 / 2, 1 / 5, 1 / 10, 1 / 20, 1 / 50, 1 / 100];
const MARGIN = 10, GAP = 15, TITLE_H = 38;

/** Padding around a view, in model units: the viewer frames each view with 8% + 2 mm of air. */
const pad = (vw, vh) => Math.max(vw, vh) * 0.08 + 2;
/** Sheet layout at a scale: top view over front, isometric over right; sizes in mm. */
export function layout(w, h, d, s, withIso = true, notesH = 0) {
  // the isometric is not to scale: half the sheet scale, so it does not dictate the rest
  const si = s / 2, isoW = 0.707 * (w + d), isoH = 0.816 * h + 0.408 * (w + d);
  const pF = pad(w, h), pT = pad(w, d), pR = pad(d, h), pI = pad(isoW, isoH);
  const col1 = Math.max(w + 2 * pF, w + 2 * pT) * s, col2 = Math.max((d + 2 * pR) * s, withIso ? (isoW + 2 * pI) * si : 0);
  const row1 = Math.max((d + 2 * pT) * s, withIso ? (isoH + 2 * pI) * si : 0), row2 = (h + 2 * Math.max(pF, pR)) * s;
  return { col1, col2, row1, row2, totalW: col1 + GAP + col2, totalH: row1 + GAP + row2 + notesH };
}
/** The largest standard scale at which the whole layout fits the sheet. */
export function fitScale(w, h, d, sheetW, sheetH, withIso = true, notesH = 0) {
  const useW = sheetW - 2 * MARGIN, useH = sheetH - 2 * MARGIN - TITLE_H;
  return SCALES.find((s) => { const L = layout(w, h, d, s, withIso, notesH); return L.totalW <= useW && L.totalH <= useH; }) ?? SCALES[SCALES.length - 1];
}
export const scaleText = (s) => (s >= 1 ? `${s}:1` : `1:${Math.round(1 / s)}`);

const AXES = { '+x': [1, 0, 0], '-x': [-1, 0, 0], '+y': [0, 1, 0], '-y': [0, -1, 0], '+z': [0, 0, 1], '-z': [0, 0, -1] };

/**
 * spec: { sheet, landscape, units, decimals, front, up, views[], scale, title, part, rev, material, finish, drawnBy, date, tolerances, notes[] }
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
  const notesList = (spec.notes ?? []).filter(Boolean), notesH = notesList.length ? 6 + 4 * notesList.length : 0;
  const wantIso = !spec.views?.length || spec.views.includes('iso');
  const scale = spec.scale === 'fit' || !spec.scale ? fitScale(w, h, d, W, H, wantIso, notesH) : spec.scale;
  const toUnit = spec.units === 'in' ? 1 / 25.4 : 1, decimals = spec.decimals ?? (spec.units === 'in' ? 3 : 2);
  const unitSuffix = spec.units === 'in' ? '"' : '';
  const views = {
    front: { dir: F, up: U, w, h },
    top: { dir: U, up: F.clone().negate(), w, h: d },                     // third angle: the top view above the front, front edge at the bottom
    right: { dir: R, up: U, w: d, h },
    iso: { dir: F.clone().add(R).add(U).normalize(), up: U, scale: 0.5 },   // not to scale: half, see layout()
  };
  const wanted = (spec.views?.length ? spec.views : ['front', 'top', 'right', 'iso']).filter((v) => views[v]);
  const dist = bbox.getSize(new THREE.Vector3()).length() * 2;

  // render each view with an orthographic camera framing the box, dims drawn on top
  for (const o of ctx.hide) o.visible = false;
  const bg = scene.background; scene.background = new THREE.Color(0xffffff);
  const PX_PER_MM = 10, MAXPX = 2600;
  const images = {};
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
    renderer.render(scene, cam);
    const c = document.createElement('canvas'); c.width = pw; c.height = ph;
    const g = c.getContext('2d'); g.drawImage(renderer.domElement, 0, 0, pw, ph);   // the canvas is pixel-ratio sized: scale it down
    // dimension labels, like the viewer's but in the sheet's units
    g.font = `${Math.max(10, 2.6 * k)}px "Space Mono", monospace`; g.textBaseline = 'bottom';
    for (const dm of measure.dims) {
      const { pos, label } = dimLabel(dm, toUnit, decimals, unitSuffix);
      const p = pos.project(cam); if (p.z > 1) continue;
      const x = (p.x + 1) / 2 * pw, y = (1 - p.y) / 2 * ph, tw = g.measureText(label).width + 4 * k, th = 3.6 * k;
      g.fillStyle = '#ffffff'; g.fillRect(x - tw / 2, y - th - 1.5 * k, tw, th);
      g.strokeStyle = '#d11d1d'; g.lineWidth = Math.max(1, 0.2 * k); g.strokeRect(x - tw / 2, y - th - 1.5 * k, tw, th);
      g.fillStyle = '#000000'; g.fillText(label, x - tw / 2 + 2 * k, y - 2 * k);
    }
    images[name] = { src: c.toDataURL('image/png'), mmW, mmH };
  }
  scene.background = bg;
  for (const o of ctx.hide) o.visible = true;
  ctx.restore();

  // layout: top view over front, isometric over right; everything in mm
  const L = layout(w, h, d, scale, wantIso, notesH);
  const left = MARGIN, top = MARGIN;
  const mid = (slotW, vw) => (slotW - vw) / 2;
  const place = {
    top: { x: left + mid(L.col1, images.top?.mmW ?? 0), y: top + L.row1 - (images.top?.mmH ?? 0) },
    front: { x: left + mid(L.col1, images.front?.mmW ?? 0), y: top + L.row1 + GAP },
    right: { x: left + L.col1 + GAP + mid(L.col2, images.right?.mmW ?? 0), y: top + L.row1 + GAP },
    iso: { x: left + L.col1 + GAP + mid(L.col2, images.iso?.mmW ?? 0), y: top + L.row1 - (images.iso?.mmH ?? 0) },
  };
  const esc = (s) => String(s ?? '').replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));
  const field = (k, v) => `<div class="f"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`;
  const notes = notesList;
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${esc(spec.title || spec.part || 'Drawing')}</title>
<style>
@font-face { font-family: "Space Mono"; src: url("http://localhost:4477/fonts/SpaceMono-Regular.ttf") format("truetype"); font-weight: 400; }
@page { size: ${W}mm ${H}mm; margin: 0; }
html, body { margin: 0; background: #fff; color: #000; font: 2.6mm/1.3 "Space Mono", monospace; }
.sheet { position: relative; width: ${W}mm; height: ${H}mm; overflow: hidden; page-break-after: always; }
.frame { position: absolute; inset: ${MARGIN / 2}mm; border: 0.3mm solid #000; }
.view { position: absolute; }
.view img { display: block; width: 100%; height: 100%; }
.view .cap { position: absolute; left: 0; bottom: -4mm; font-size: 2.4mm; text-transform: uppercase; letter-spacing: 0.05em; }
.title { position: absolute; left: ${MARGIN}mm; right: ${MARGIN}mm; bottom: ${MARGIN}mm; height: ${TITLE_H - 4}mm; border: 0.3mm solid #000; display: grid; grid-template-columns: 2fr 1fr 1fr 1fr 1fr; grid-auto-rows: 1fr; }
.title .f { border-right: 0.2mm solid #000; border-bottom: 0.2mm solid #000; padding: 1mm 2mm; display: flex; flex-direction: column; justify-content: space-between; min-width: 0; overflow: hidden; }
.title .k { font-size: 2mm; text-transform: uppercase; letter-spacing: 0.06em; color: #000; }
.title .v { font-size: 2.8mm; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.title .big .v { font-size: 4.2mm; }
.notes { position: absolute; left: ${MARGIN}mm; bottom: ${MARGIN + TITLE_H - 2}mm; max-width: 120mm; font-size: 2.4mm; }
.notes ol { margin: 0; padding-left: 5mm; }
.id { position: absolute; right: ${MARGIN}mm; top: ${MARGIN - 6}mm; font-size: 2mm; letter-spacing: 0.06em; }
</style></head><body>
<div class="sheet">
  <div class="frame"></div>
  ${wanted.map((n) => `<div class="view" style="left:${place[n].x}mm;top:${place[n].y}mm;width:${images[n].mmW}mm;height:${images[n].mmH}mm"><img src="${images[n].src}" alt="${n}"><span class="cap">${n === 'iso' ? 'isometric · not to scale' : n + ' view'}</span></div>`).join('\n  ')}
  ${notes.length ? `<div class="notes">NOTES<ol>${notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ol></div>` : ''}
  <div class="title">
    ${field('Title', spec.title || spec.part || '').replace('class="f"', 'class="f big"')}
    ${field('Part no.', spec.part)}${field('Rev', spec.rev)}${field('Scale', scaleText(scale))}${field('Sheet', `${spec.sheet || 'A3'} ${spec.landscape === false ? 'portrait' : 'landscape'}`)}
    ${field('Material', spec.material)}${field('Finish', spec.finish)}${field('Units', spec.units === 'in' ? 'inch' : 'mm')}${field('Drawn by', spec.drawnBy)}${field('Date', spec.date || new Date().toISOString().slice(0, 10))}
    ${field('Tolerances', spec.tolerances || (spec.units === 'in' ? 'X.XX ±0.01  X.XXX ±0.005' : 'X ±0.5  X.X ±0.1  X.XX ±0.05'))}${field('Size', `${(w * toUnit).toFixed(decimals)} × ${(d * toUnit).toFixed(decimals)} × ${(h * toUnit).toFixed(decimals)}${unitSuffix}`)}${field('Projection', 'third angle')}${field('Source', spec.source || '')}${field('', 'CWT_SW_CADGANG_VIEW')}
  </div>
  <div class="id">CADgang</div>
</div>
</body></html>`;
}

function boxCorners(b) {
  const out = [];
  for (const x of [b.min.x, b.max.x]) for (const y of [b.min.y, b.max.y]) for (const z of [b.min.z, b.max.z]) out.push(new THREE.Vector3(x, y, z));
  return out;
}
function dimLabel(d, k, dec, suffix) {
  const V = (a) => new THREE.Vector3(...a);
  const f = (v) => (v * k).toFixed(dec) + suffix;
  if (d.kind === 'dia') return { pos: V(d.c).addScaledVector(V(d.u), d.r * 0.5), label: `⌀${f(d.r * 2)}` };
  if (d.kind === 'rad') return { pos: V(d.c).lerp(V(d.p), 0.5), label: `${d.sph ? 'SR' : 'R'}${f(d.r)}` };
  return { pos: V(d.a).lerp(V(d.b), 0.5), label: f(V(d.a).distanceTo(V(d.b))) };
}
