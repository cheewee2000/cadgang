/**
 * DXF → line segments, one bundle per layer, so a drawing opens in the viewer
 * like any other file and markup, measure and section work on it unchanged.
 *
 * Covers what 2D CAD exports: LINE, LWPOLYLINE (with bulges), POLYLINE/VERTEX,
 * CIRCLE, ARC, ELLIPSE, SPLINE, INSERT (blocks, nested). Model space only.
 * ponytail: TEXT, MTEXT, DIMENSION and HATCH are skipped and counted — text
 * needs a font and a label layer; add when drawings arrive with notes that matter.
 *
 * parseDxf(text, { THREE, NURBSCurve }) → { parts: [{ lines: Float32Array, name }], skipped: { TEXT: n, … } }
 */
export function parseDxf(text, { THREE, NURBSCurve }) {
  const rows = text.split(/\r\n|\r|\n/);
  const tags = [];
  for (let i = 0; i + 1 < rows.length; i += 2) tags.push([parseInt(rows[i], 10), rows[i + 1].trim()]);

  // ---- split into block definitions and model-space entities
  const readEntity = (start) => {
    const t = [];
    let j = start + 1;
    while (j < tags.length && tags[j][0] !== 0) t.push(tags[j++]);
    return { type: tags[start][1], tags: t, next: j };
  };
  const blocks = new Map();
  const entities = [];
  let section = '';
  for (let i = 0; i < tags.length;) {
    const [code, value] = tags[i];
    if (code !== 0) { i++; continue; }
    if (value === 'SECTION') { section = tags[i + 1]?.[1] ?? ''; i += 2; continue; }
    if (value === 'ENDSEC') { section = ''; i++; continue; }
    if (section === 'BLOCKS' && value === 'BLOCK') {
      const b = readEntity(i);
      const ents = [];
      i = b.next;
      while (i < tags.length && !(tags[i][0] === 0 && tags[i][1] === 'ENDBLK')) { const e = readEntity(i); ents.push(e); i = e.next; }
      blocks.set(str(b.tags, 2), { base: [num(b.tags, 10), num(b.tags, 20), num(b.tags, 30)], ents });
      continue;
    }
    if (section === 'ENTITIES') { const e = readEntity(i); entities.push(e); i = e.next; continue; }
    i++;
  }

  // ---- emit
  const layers = new Map();
  const skipped = {};
  const v = new THREE.Vector3();
  function push(layer, pts, matrix, closed = false) {
    if (pts.length < 2) return;
    let arr = layers.get(layer);
    if (!arr) layers.set(layer, (arr = []));
    const n = closed ? pts.length : pts.length - 1;
    for (let k = 0; k < n; k++) {
      for (const p of [pts[k], pts[(k + 1) % pts.length]]) { v.set(p[0], p[1], p[2] ?? 0).applyMatrix4(matrix); arr.push(v.x, v.y, v.z); }
    }
  }
  const arcPts = (cx, cy, z, r, a0, sweep, flip = 1) => {
    const n = Math.max(4, Math.ceil(Math.abs(sweep) / (Math.PI * 2) * 72));
    const out = [];
    for (let k = 0; k <= n; k++) { const a = a0 + sweep * k / n; out.push([flip * (cx + r * Math.cos(a)), cy + r * Math.sin(a), z]); }
    return out;
  };
  /** A polyline with bulges: each bulge turns its segment into an arc. */
  function polyPts(verts, closed, flip) {
    const out = [];
    const n = closed ? verts.length : verts.length - 1;
    for (let k = 0; k < Math.max(n, 0); k++) {
      const a = verts[k], b = verts[(k + 1) % verts.length];
      out.push([flip * a.x, a.y, a.z]);
      if (!a.bulge) continue;
      const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy);
      if (!d) continue;
      const theta = 4 * Math.atan(a.bulge);
      const h = (d / 2) * (1 / a.bulge - a.bulge) / 2;                // chord midpoint → centre
      const cx = (a.x + b.x) / 2 - dy / d * h, cy = (a.y + b.y) / 2 + dx / d * h;
      const r = Math.hypot(a.x - cx, a.y - cy);
      const pts = arcPts(cx, cy, a.z, r, Math.atan2(a.y - cy, a.x - cx), theta, flip);
      out.push(...pts.slice(1, -1));
    }
    if (!closed) { const l = verts[verts.length - 1]; out.push([flip * l.x, l.y, l.z]); }
    return out;
  }
  function emit(ents, matrix, inheritLayer, depth) {
    for (let i = 0; i < ents.length; i++) {
      const e = ents[i], t = e.tags;
      if (num(t, 67) === 1) continue;                                   // paper space
      let layer = str(t, 8) || '0';
      if (inheritLayer && layer === '0') layer = inheritLayer;
      const flip = num(t, 230, 1) < 0 ? -1 : 1;                           // OCS with Z pointing down mirrors X
      const z = num(t, 38) || num(t, 30);
      switch (e.type) {
        case 'LINE': push(layer, [[num(t, 10), num(t, 20), num(t, 30)], [num(t, 11), num(t, 21), num(t, 31)]], matrix); break;
        case 'LWPOLYLINE': {
          const verts = [];
          for (const [c, val] of t) {
            if (c === 10) verts.push({ x: +val, y: 0, z, bulge: 0 });
            else if (c === 20 && verts.length) verts[verts.length - 1].y = +val;
            else if (c === 42 && verts.length) verts[verts.length - 1].bulge = +val;
          }
          push(layer, polyPts(verts, !!(num(t, 70) & 1), flip), matrix, !!(num(t, 70) & 1));
          break;
        }
        case 'POLYLINE': {
          const verts = [];
          while (ents[i + 1]?.type === 'VERTEX') { const vt = ents[++i].tags; verts.push({ x: num(vt, 10), y: num(vt, 20), z: num(vt, 30), bulge: num(vt, 42) }); }
          if (ents[i + 1]?.type === 'SEQEND') i++;
          if (!(num(t, 70) & 112)) push(layer, polyPts(verts, !!(num(t, 70) & 1), flip), matrix, !!(num(t, 70) & 1)); // not a mesh
          break;
        }
        case 'CIRCLE': push(layer, arcPts(num(t, 10), num(t, 20), z, num(t, 40), 0, Math.PI * 2, flip), matrix); break;
        case 'ARC': {
          const a0 = num(t, 50) * Math.PI / 180; let a1 = num(t, 51) * Math.PI / 180;
          if (a1 <= a0) a1 += Math.PI * 2;
          push(layer, arcPts(num(t, 10), num(t, 20), z, num(t, 40), a0, a1 - a0, flip), matrix);
          break;
        }
        case 'ELLIPSE': {
          const cx = num(t, 10), cy = num(t, 20), mx = num(t, 11), my = num(t, 21), ratio = num(t, 40, 1);
          const p0 = num(t, 41); let p1 = num(t, 42, Math.PI * 2);
          if (p1 <= p0) p1 += Math.PI * 2;
          const n = Math.max(8, Math.ceil((p1 - p0) / (Math.PI * 2) * 96)), pts = [];
          for (let k = 0; k <= n; k++) {
            const p = p0 + (p1 - p0) * k / n, c = Math.cos(p), s = Math.sin(p);
            pts.push([flip * (cx + mx * c - my * ratio * s), cy + my * c + mx * ratio * s, z]);
          }
          push(layer, pts, matrix);
          break;
        }
        case 'SPLINE': {
          const ctrl = zip(t, 10, 20, 30), fit = zip(t, 11, 21, 31), knots = nums(t, 40), w = nums(t, 41), degree = num(t, 71, 3);
          let curve = null;
          if (ctrl.length > degree && knots.length >= ctrl.length + degree + 1) {
            curve = new NURBSCurve(degree, knots, ctrl.map((p, k) => new THREE.Vector4(p[0], p[1], p[2], w[k] ?? 1)));
          } else if (fit.length > 1) {
            curve = new THREE.CatmullRomCurve3(fit.map((p) => new THREE.Vector3(...p)), !!(num(t, 70) & 1));
          }
          if (curve) push(layer, curve.getPoints(Math.max(16, (ctrl.length || fit.length) * 8)).map((p) => [flip * p.x, p.y, p.z]), matrix);
          break;
        }
        case 'INSERT': {
          const b = blocks.get(str(t, 2));
          if (!b || depth > 8) break;
          const m = new THREE.Matrix4()
            .makeTranslation(num(t, 10), num(t, 20), num(t, 30))
            .multiply(new THREE.Matrix4().makeRotationZ(num(t, 50) * Math.PI / 180))
            .multiply(new THREE.Matrix4().makeScale(num(t, 41, 1), num(t, 42, 1), num(t, 43, 1)))
            .multiply(new THREE.Matrix4().makeTranslation(-b.base[0], -b.base[1], -b.base[2]));
          emit(b.ents, matrix.clone().multiply(m), layer, depth + 1);
          break;
        }
        case 'POINT': case 'VERTEX': case 'SEQEND': case 'ATTRIB': case 'ATTDEF': case 'VIEWPORT': break;
        default: skipped[e.type] = (skipped[e.type] ?? 0) + 1;
      }
    }
  }
  emit(entities, new THREE.Matrix4(), '', 0);

  const parts = [...layers].filter(([, a]) => a.length).map(([name, a]) => ({ lines: new Float32Array(a), name }));
  return { parts, skipped };
}

const num = (tags, code, dflt = 0) => { const t = tags.find((x) => x[0] === code); return t ? +t[1] : dflt; };
const str = (tags, code) => tags.find((x) => x[0] === code)?.[1] ?? '';
const nums = (tags, code) => tags.filter((x) => x[0] === code).map((x) => +x[1]);
const zip = (tags, cx, cy, cz) => { const xs = nums(tags, cx), ys = nums(tags, cy), zs = nums(tags, cz); return xs.map((x, k) => [x, ys[k] ?? 0, zs[k] ?? 0]); };
