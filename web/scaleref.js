/**
 * A thing of known size beside the model, to read its scale at a glance: a US quarter, a tennis ball,
 * a sheet of looseleaf, a basketball. Each is made here at its real size in mm, sitting on the grid
 * beside the model on its left. Never part of the model: no pick, measure, weight or explode.
 *
 * Or a printer's build volume round the model: a see-through box of the printable width × depth ×
 * height, standing on the grid and centred on the model, its outline red when the model does not fit.
 *
 * The button above Fit turns it on and off; its ▾ picks which. Kept in this browser.
 */
const KEY = 'cadgang.scaleref';

// Real sizes, mm. Quarter: US Mint spec. Tennis ball: ITF 6.54–6.86 cm. Basketball: size 7, 29.5" round.
// Looseleaf: US letter, college ruled (9/32"), a red margin at 1¼", three 9/32" holes 4¼" apart.
export const REFS = {
  quarter: { label: 'Quarter', size: '24.26 mm across' },
  tennis: { label: 'Tennis ball', size: '67 mm across' },
  paper: { label: 'Looseleaf paper', size: '8½ × 11 in' },
  basketball: { label: 'Basketball', size: '239 mm across' },
};
// Printable width × depth × height, mm, from the makers' spec pages. The H2D's is one nozzle's (both
// nozzles reach 300 × 320 × 325).
export const VOLUMES = {
  a1mini: { label: 'Bambu Lab A1 mini', vol: [180, 180, 180] },
  a1: { label: 'Bambu Lab A1', vol: [256, 256, 256] },
  p1s: { label: 'Bambu Lab P1S / P1P', vol: [256, 256, 256] },
  p2s: { label: 'Bambu Lab P2S', vol: [256, 256, 256] },
  x1c: { label: 'Bambu Lab X1C / X1E', vol: [256, 256, 256] },
  h2s: { label: 'Bambu Lab H2S', vol: [340, 320, 340] },
  h2d: { label: 'Bambu Lab H2D', vol: [325, 320, 325] },
  prusaxl: { label: 'Prusa XL', vol: [360, 360, 360] },
};
for (const v of Object.values(VOLUMES)) v.size = `${v.vol.join(' × ')} mm`;
const IN = 25.4;

function canvasTexture(THREE, w, h, draw) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}

function quarter(THREE) {
  const R = 24.26 / 2, T = 1.75, rim = 0.75, relief = 0.2;
  // the coin's section, turned: a raised rim round a field a little lower, both faces
  const pts = [[0, relief], [R - rim, relief], [R - rim + 0.2, 0], [R, 0], [R, T], [R - rim + 0.2, T], [R - rim, T - relief], [0, T - relief]]
    .map(([r, z]) => new THREE.Vector2(r, z));
  // half metal: the plain looks have no room to reflect, and a full metal there renders black
  const metal = new THREE.MeshStandardMaterial({ color: 0xc4c6c8, metalness: 0.45, roughness: 0.38 });
  metal.side = THREE.DoubleSide;
  const body = new THREE.Mesh(new THREE.LatheGeometry(pts, 96), metal);
  body.rotation.x = Math.PI / 2;   // the lathe turns about Y; the coin lies flat on Z
  // the face: lettering round the edge and a profile, as relief (a bump map) on the field
  const face = canvasTexture(THREE, 512, 512, (g, w) => {
    g.fillStyle = '#808080'; g.fillRect(0, 0, w, w);
    g.translate(w / 2, w / 2);
    g.fillStyle = '#d8d8d8'; g.font = '600 34px Georgia, serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    const ring = (text, r, from) => { const step = 0.115; [...text].forEach((ch, i) => { g.save(); g.rotate(from + i * step); g.fillText(ch, 0, -r); g.restore(); }); };
    ring('UNITED STATES OF AMERICA', 205, -1.38);
    g.font = '600 30px Georgia, serif'; ring('LIBERTY', 160, -0.36);
    g.beginPath(); g.ellipse(0, 20, 95, 120, 0, 0, Math.PI * 2); g.fill();   // the profile, simply
    g.font = '600 26px Georgia, serif'; g.fillStyle = '#9a9a9a'; g.fillText('QUARTER DOLLAR', 0, 200);
  });
  const faceMat = new THREE.MeshStandardMaterial({ color: 0xc4c6c8, metalness: 0.45, roughness: 0.4, bumpMap: face, bumpScale: 0.6 });
  const top = new THREE.Mesh(new THREE.CircleGeometry(R - rim, 96), faceMat);
  top.position.z = T - relief + 0.01;
  const g = new THREE.Group(); g.add(body, top);
  return { obj: g, w: R * 2, d: R * 2 };
}

function tennisBall(THREE) {
  const R = 67 / 2;
  const fuzz = canvasTexture(THREE, 256, 128, (g, w, h) => {
    g.fillStyle = '#cfe23a'; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 6000; i++) { g.fillStyle = Math.random() < 0.5 ? 'rgba(255,255,200,0.18)' : 'rgba(120,140,0,0.16)'; g.fillRect(Math.random() * w, Math.random() * h, 1.5, 1.5); }
  });
  const ball = new THREE.Mesh(new THREE.SphereGeometry(R, 64, 48), new THREE.MeshStandardMaterial({ map: fuzz, roughness: 1, metalness: 0 }));
  // the seam: a curve on the sphere, (a cos t + b cos 3t, a sin t − b sin 3t, 2√(ab) sin 2t) with a + b = 1
  const a = 0.7, b = 0.3, c = 2 * Math.sqrt(a * b);
  const curve = new (class extends THREE.Curve {
    getPoint(u, out = new THREE.Vector3()) { const t = u * Math.PI * 2; return out.set(a * Math.cos(t) + b * Math.cos(3 * t), a * Math.sin(t) - b * Math.sin(3 * t), c * Math.sin(2 * t)).multiplyScalar(R - 0.35); }
  })();
  const seam = new THREE.Mesh(new THREE.TubeGeometry(curve, 400, 0.8, 8, true), new THREE.MeshStandardMaterial({ color: 0xf4f4ee, roughness: 0.9 }));
  const g = new THREE.Group(); g.add(ball, seam);
  g.position.z = R;
  const o = new THREE.Group(); o.add(g);
  return { obj: o, w: R * 2, d: R * 2 };
}

function looseleaf(THREE) {
  const W = 8.5 * IN, H = 11 * IN, px = 4;   // 4 px a mm
  const tex = canvasTexture(THREE, Math.round(W * px), Math.round(H * px), (g, w, h) => {
    g.fillStyle = '#fbfbf6'; g.fillRect(0, 0, w, h);
    g.strokeStyle = '#9cc0e4'; g.lineWidth = 0.35 * px;
    for (let y = 1.25 * IN; y < H - 0.5 * IN; y += (9 / 32) * IN) { g.beginPath(); g.moveTo(0, y * px); g.lineTo(w, y * px); g.stroke(); }
    g.strokeStyle = '#e8908f'; g.lineWidth = 0.4 * px;
    g.beginPath(); g.moveTo(1.25 * IN * px, 0); g.lineTo(1.25 * IN * px, h); g.stroke();
    g.globalCompositeOperation = 'destination-out';   // the three holes, cut through
    for (const y of [H / 2 - 4.25 * IN, H / 2, H / 2 + 4.25 * IN]) { g.beginPath(); g.arc((3 / 8) * IN * px, y * px, (9 / 64) * IN * px, 0, Math.PI * 2); g.fill(); }
  });
  const sheet = new THREE.Mesh(new THREE.PlaneGeometry(W, H), new THREE.MeshStandardMaterial({ map: tex, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.95 }));
  sheet.position.z = 0.1;   // a sheet's thickness above the grid
  const edge = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints([[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, y]) => new THREE.Vector3((x * W) / 2, (y * H) / 2, 0.12))), new THREE.LineBasicMaterial({ color: 0xb9b8b2 }));
  const g = new THREE.Group(); g.add(sheet, edge);
  return { obj: g, w: W, d: H };
}

function basketball(THREE) {
  const R = (29.5 * IN) / Math.PI / 2;
  // A basketball's seams: two great circles at right angles (the planes x = 0 and y = 0 here, crossing at
  // the z poles), and one continuous curved seam, the tennis ball's kind of curve, that loops round the
  // ball and shows as the two C-shaped seams (Paul Bourke, "Geometry of sports balls"). Drawn into the
  // skin as brown-black channels about 4 mm wide, on orange-brown pebbled leather.
  const W = 2048, H = 1024, half = 0.017;   // a channel's half width, on the unit sphere (≈ 2 mm)
  const skin = document.createElement('canvas'); skin.width = W; skin.height = H;
  const bump = document.createElement('canvas'); bump.width = W; bump.height = H;
  const sg = skin.getContext('2d'), bg = bump.getContext('2d');
  const si = sg.createImageData(W, H), bi = bg.createImageData(W, H);
  const CH = [38, 24, 18];
  for (let j = 0; j < H; j++) {
    const theta = (j / H) * Math.PI, st = Math.sin(theta), ct = Math.cos(theta);
    for (let i = 0; i < W; i++) {
      const phi = (i / W) * Math.PI * 2;
      // three's sphere: x = −cos φ sin θ, y = cos θ, z = sin φ sin θ
      const x = -Math.cos(phi) * st, y = ct, o = 4 * (j * W + i);
      const grain = Math.random();
      if (Math.min(Math.abs(x), Math.abs(y)) < half) {   // the two great circles
        si.data[o] = CH[0]; si.data[o + 1] = CH[1]; si.data[o + 2] = CH[2];
        bi.data[o] = bi.data[o + 1] = bi.data[o + 2] = 40;   // the channel is sunk
      } else {
        const l = 0.9 + grain * 0.14;   // leather orange-brown, a pebble lighter or darker
        si.data[o] = Math.min(255, 196 * l); si.data[o + 1] = Math.min(255, 96 * l); si.data[o + 2] = Math.min(255, 52 * l);
        bi.data[o] = bi.data[o + 1] = bi.data[o + 2] = grain > 0.55 ? 235 : 170;   // pebbles
      }
      si.data[o + 3] = bi.data[o + 3] = 255;
    }
  }
  sg.putImageData(si, 0, 0); bg.putImageData(bi, 0, 0);
  // the curved seam: x = sin(π/2 − (π/2 − a) cos t) cos(t/2 + a sin 2t), y likewise with sin, z = cos(π/2 − (π/2 − a) cos t),
  // 0 ≤ t < 4π, its axis z. Stamped along its length into the skin and the bump, wrapping round the seam of the map.
  const a = 0.44;
  sg.fillStyle = `rgb(${CH.join(',')})`; bg.fillStyle = 'rgb(40,40,40)';
  for (let n = 0, N = 24000; n < N; n++) {
    const t = (n / N) * 4 * Math.PI, pol = Math.PI / 2 - (Math.PI / 2 - a) * Math.cos(t), lon = t / 2 + a * Math.sin(2 * t);
    const px = Math.sin(pol) * Math.cos(lon), py = Math.sin(pol) * Math.sin(lon), pz = Math.cos(pol);
    const theta = Math.acos(Math.max(-1, Math.min(1, py)));   // three's pole is y
    const phi = (Math.atan2(pz, -px) + Math.PI * 2) % (Math.PI * 2);
    const u = (phi / (Math.PI * 2)) * W, v = (theta / Math.PI) * H;
    const ry = (half / Math.PI) * H, rx = Math.min(W / 4, (half / (Math.PI * 2)) * W / Math.max(0.02, Math.sin(theta)));
    for (const g of [sg, bg]) for (const du of [-W, 0, W]) { g.beginPath(); g.ellipse(u + du, v, rx, ry, 0, 0, Math.PI * 2); g.fill(); }
  }
  const map = new THREE.CanvasTexture(skin); map.colorSpace = THREE.SRGBColorSpace; map.anisotropy = 8;
  const bumpMap = new THREE.CanvasTexture(bump);
  const ball = new THREE.Mesh(new THREE.SphereGeometry(R, 128, 96), new THREE.MeshStandardMaterial({ map, bumpMap, bumpScale: 1.2, roughness: 0.7, metalness: 0 }));
  // Turned as a ball is usually seen from the default view: the great circles crossing at the left, one up
  // the left side, one across the middle, the curved seam's two Cs above and below. Built in the default
  // camera's frame: toward it, its up, its right.
  const toward = new THREE.Vector3(-0.495, -0.724, 0.479), up = new THREE.Vector3(0.27, 0.395, 0.878);
  const right = new THREE.Vector3().crossVectors(up, toward).normalize();
  const zL = right.clone().multiplyScalar(-0.75).addScaledVector(toward, 0.65).normalize();   // where the great circles cross
  const yL = up.clone().projectOnPlane(zL).normalize();
  const xL = new THREE.Vector3().crossVectors(yL, zL);
  ball.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(xL, yL, zL));
  ball.position.z = R;
  const g = new THREE.Group(); g.add(ball);
  return { obj: g, w: R * 2, d: R * 2 };
}

const MAKERS = { quarter, tennis: tennisBall, paper: looseleaf, basketball };

/** A printer's build volume as a see-through box with its edges and its name at the top front corner; red when `size` does not fit. */
function buildVolume(THREE, { label, vol }, size) {
  const [W, D, H] = vol;
  const fits = size.z <= H + 1e-6 && ((size.x <= W + 1e-6 && size.y <= D + 1e-6) || (size.x <= D + 1e-6 && size.y <= W + 1e-6));   // turned a quarter on the plate counts
  const color = fits ? 0x1d6bff : 0xd0524c;
  const g = new THREE.Group();
  const geo = new THREE.BoxGeometry(W, D, H); geo.translate(0, 0, H / 2);
  const box = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.05, depthWrite: false, side: THREE.DoubleSide }));
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.8 }));
  box.renderOrder = edges.renderOrder = 4;
  const plate = new THREE.Mesh(new THREE.PlaneGeometry(W, D), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.08, depthWrite: false, side: THREE.DoubleSide }));
  plate.position.z = 0.05;   // the build plate, a shade darker
  const c = document.createElement('canvas'), ctx = c.getContext('2d'), px = 40, text = `${label} · ${vol.join(' × ')} mm${fits ? '' : ' · does not fit'}`;
  ctx.font = `${px}px "Space Mono", monospace`; c.width = Math.ceil(ctx.measureText(text).width + 16); c.height = px + 16;
  ctx.font = `${px}px "Space Mono", monospace`; ctx.fillStyle = fits ? '#1d4fc4' : '#c0392b'; ctx.textBaseline = 'middle'; ctx.fillText(text, 8, c.height / 2);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  const tag = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, depthTest: false, transparent: true }));
  const th = Math.max(W, D) * 0.035; tag.scale.set(th * c.width / c.height, th, 1);
  tag.position.set(-W / 2 + (th * c.width / c.height) / 2, -D / 2, H + th * 0.8);   // over the top front left edge
  g.add(plate, box, edges, tag);
  return { obj: g, fits };
}
const ICON = '<svg viewBox="0 0 24 16" width="22" height="15" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M1 15h22"/><circle cx="3.2" cy="12.5" r="2"/><rect x="7" y="7.5" width="6" height="7"/><circle cx="19.3" cy="10" r="4.3"/></svg>';

export function createScaleRef({ THREE, scene, getBox, onChange = () => {} }) {
  let state = { on: false, which: 'quarter' };
  try { state = { ...state, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch {}
  if (!REFS[state.which] && !VOLUMES[state.which]) state.which = 'quarter';
  const entry = (k) => REFS[k] ?? VOLUMES[k];
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch {} };

  const group = new THREE.Group();
  group.name = 'scale reference';
  scene.add(group);
  const made = {};   // made once each, kept
  function place() {
    group.clear();
    const box = getBox();
    if (!state.on || !box) { onChange(); return; }
    const size = box.getSize(new THREE.Vector3());
    if (VOLUMES[state.which]) {   // a build volume: round the model, on the grid, red when it does not fit
      const v = buildVolume(THREE, VOLUMES[state.which], size);
      v.obj.position.set((box.min.x + box.max.x) / 2, (box.min.y + box.max.y) / 2, box.min.z);
      v.obj.traverse((o) => { o.raycast = () => {}; });
      group.add(v.obj);
      onChange(v.fits ? '' : `${VOLUMES[state.which].label}: the model (${[size.x, size.y, size.z].map((n) => n.toFixed(0)).join(' × ')} mm) does not fit`);
      return;
    }
    const ref = (made[state.which] ??= MAKERS[state.which](THREE));
    ref.obj.traverse((o) => { o.raycast = () => {}; });   // never a pick, measure or snap target
    const gap = Math.max(8, 0.08 * Math.max(size.x, size.y, ref.w));
    // a sheet of paper lies centred under the model, as it would on a desk; the rest stand beside it on
    // its left, centred front to back, on the grid
    if (state.which === 'paper') ref.obj.position.set((box.min.x + box.max.x) / 2, (box.min.y + box.max.y) / 2, box.min.z - 0.11);
    else ref.obj.position.set(box.min.x - gap - ref.w / 2, (box.min.y + box.max.y) / 2, box.min.z);
    group.add(ref.obj);
    onChange();
  }

  // the split button: the icon turns it on and off, ▾ picks which
  const wrap = Object.assign(document.createElement('div'), { className: 'scaleref' });
  const btn = Object.assign(document.createElement('button'), { className: 'ghost scaleref-btn', innerHTML: ICON });
  const more = Object.assign(document.createElement('button'), { className: 'ghost scaleref-more', textContent: '▾', title: 'Choose the reference object' });
  const menu = Object.assign(document.createElement('div'), { className: 'scaleref-menu', hidden: true });
  wrap.append(btn, more, menu);
  function paint() {
    btn.classList.toggle('on', state.on);
    const e = entry(state.which);
    btn.title = VOLUMES[state.which] ? `${state.on ? 'Hide' : 'Show'} the ${e.label} build volume round the model (${e.size})` : `${state.on ? 'Hide' : 'Show'} a ${e.label.toLowerCase()} beside the model, for scale (${e.size})`;
    const item = ([k, r]) => {
      const b = Object.assign(document.createElement('button'), { className: 'ghost' + (k === state.which ? ' on' : '') });
      b.append(r.label, Object.assign(document.createElement('span'), { className: 'scaleref-size', textContent: r.size }));
      b.addEventListener('click', () => { state.which = k; state.on = true; menu.hidden = true; save(); paint(); place(); });
      return b;
    };
    const head = (t) => Object.assign(document.createElement('div'), { className: 'scaleref-head', textContent: t });
    menu.replaceChildren(head('For scale'), ...Object.entries(REFS).map(item), head('Printer build volume'), ...Object.entries(VOLUMES).map(item));
  }
  btn.addEventListener('click', () => { state.on = !state.on; save(); paint(); place(); });
  more.addEventListener('click', (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; });
  document.addEventListener('pointerdown', (e) => { if (!wrap.contains(e.target)) menu.hidden = true; });
  paint();

  return {
    el: wrap, place, group,
    /** The reference's box when it shows (Fit takes it in), else null. */
    box() { return state.on && group.children.length ? new THREE.Box3().setFromObject(group) : null; },
  };
}
