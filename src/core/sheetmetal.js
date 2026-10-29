/**
 * Sheet metal for cell programs: parts bent from one flat sheet on a press brake.
 *
 * A part is a base rectangle with flanges bent off its edges, flanges off those
 * flanges, holes, and window bends (flaps folded in round an opening). It is
 * built to a shop's gauge table, so the bend radius and the flat pattern are the
 * shop's, and the corners get the reliefs the shop asks for. The same
 * description gives the folded solid (`solid`) and the flat pattern (`dxf`).
 *
 * Every panel (the base, each flange) is a rectangle in its own MOLD coordinates:
 * u along it, v across it, the outer face at w = 0 and the sheet from w 0 to t
 * toward its inside. Edges are named b (v = 0), t (v = V), l (u = 0), r (u = U);
 * a flange's b edge is its bend. Flanges fold 90° toward the inside, or the
 * other way with `reverse` (a Z bend).
 *
 * PEM hardware (`pem`) and countersinks (`countersink`) go in from the shop's
 * catalog, checked against its edge, bend and spacing distances; they are
 * fused into the folded part (SCS ships them pressed in) and counted per part.
 *
 * ponytail: 90° bends only, rectangular panels, closed corners and mitred
 * window flaps. Add angles, hems and joggles when a part needs them.
 */

import { brepKernel, brepDrawingSketch, brepExtrude } from './brep.js';
import * as ops from './ops.js';
import { GraphError } from './errors.js';

const IN = 25.4;

// SendCutSend 304 stainless, from their spec sheet (sendcutsend.com/materials/stainless-steel, read 2026-10-22), inches:
// [thickness, effective bend radius at 90°, bend deduction at 90°, min flange after bend, max bend length]
const SCS_304 = [
  [0.030, 0.080, 0.079, 0.294, 44], [0.048, 0.080, 0.105, 0.307, 44], [0.060, 0.070, 0.119, 0.314, 44],
  [0.074, 0.075, 0.137, 0.324, 44], [0.100, 0.187, 0.223, 0.732, 35], [0.125, 0.150, 0.240, 0.740, 40],
  [0.187, 0.130, 0.329, 0.784, 36], [0.250, 0.225, 0.462, 1.381, 36],
];
// SendCutSend's rules (sendcutsend.com/services/cnc-bending and their bend relief guide): flat parts up to 30 x 44 in at
// instant pricing; relief width at least t / 2; relief depth at least t + r + .02 in from the start of the bend; flanges that
// meet at a corner at least .015 in apart; flanges on boxes up to 5 in, 3 in with hardware. Reliefs here are a full t wide (twice their
// minimum) with round ends, as their guide prefers to square inside corners.
// SendCutSend 5052 H32 aluminium (sendcutsend.com/materials/5052-aluminum, each thickness's bending specs, read 2026-10-22), inches, as SCS_304;
// .313 in and up are cut flat only (no bending listed). Powder coat and anodizing from .063 in. Their relief depths are t + r + .020 in, .032 at .080, so .032 for all.
const SCS_5052 = [
  [0.040, 0.024, 0.062, 0.286, 44], [0.063, 0.035, 0.096, 0.303, 44], [0.080, 0.038, 0.116, 0.313, 44], [0.090, 0.032, 0.142, 0.326, 44],
  [0.100, 0.125, 0.191, 0.463, 44], [0.125, 0.125, 0.216, 0.476, 44], [0.187, 0.250, 0.356, 0.798, 44], [0.250, 0.250, 0.442, 1.371, 44],
  ...[0.313, 0.375, 0.500].map((t) => [t, NaN, NaN, NaN, NaN]),
];
// PEM hardware SendCutSend presses into aluminium (their hardware catalog, read 2026-10-22), as PEM_304. ponytail: the M5 flush stud only, add rows when used
const PEM_ALU = { 'FH-M5-10': ['stud', 5, 0.198, 0.283, 0.384, 0.393, [0.040, 0.268]],
  'CLA-M4-1': ['nut', 4, 0.234, 0.280, 0.5, 0.118, [0.040, 0.500]] };   // aluminium nut pressed in house (PEM catalog via Zygology, read 2026-10-29: hole 5.94, edge 7.10, sheet from 1.0 mm, T 3.0); ponytail: spacing and top of range guessed

// PEM hardware SendCutSend presses into 304 (their hardware catalog, sendcutsend.com/guidelines/hardware/catalog, read 2026-10-22), metric only.
// inches: [kind, thread mm, H hole in sheet, K = N least hole centre to a cut edge or to the bend allowance area, M least centre to centre
// for two of the same SKU, length (studs, standoffs) or height above the sheet (nuts), 304 sheet range]. SO4-M5 lists the same .281 hole as SO4-M4.
// Their rules: nuts take load pulling them into the sheet, standoffs and studs pulling away from it; no hardware on acute bends.
const PEM_304 = {
  'SP-M4-0': ['nut', 4, 0.213, 0.313, 0.584, 0.079, [0.048, 0.500]], 'SP-M5-0': ['nut', 5, 0.250, 0.313, 0.592, 0.079, [0.048, 0.375]],
  'SP-M6-1': ['nut', 6, 0.344, 0.375, 0.714, 0.161, [0.060, 0.500]],
  'SO4-M4-6': ['standoff', 4, 0.281, 0.331, 0.472, 0.236, [0.048, 0.100]], 'SO4-M4-10': ['standoff', 4, 0.281, 0.331, 0.472, 0.394, [0.048, 0.250]],
  'SO4-M5-6': ['standoff', 5, 0.281, 0.331, 0.472, 0.236, [0.048, 0.100]], 'SO4-M5-10': ['standoff', 5, 0.281, 0.331, 0.472, 0.394, [0.048, 0.250]],
  'FH4-M4-8': ['stud', 4, 0.157, 0.283, 0.362, 0.315, [0.048, 0.250]], 'FH4-M4-10': ['stud', 4, 0.157, 0.283, 0.362, 0.393, [0.048, 0.250]],
  'FH4-M5-10': ['stud', 5, 0.197, 0.283, 0.382, 0.394, [0.048, 0.250]],
};
// PEM's own drawings (pemnet.com product finder, read 2026-10-22), mm: [E collar diameter, T collar height, A shank length, C shank diameter].
const PEM_BODY = { 'SP-M5-0': [8.64, 2, 0.77, 6.33], 'CLA-M4-1': [7.80, 3.00, 0.77, 5.92] };   // CLA shank length as SP (same 1.0 mm sheet)
// SendCutSend countersinking (sendcutsend.com/services/countersinking, read 2026-10-22): aluminium and plastics .125 to .750 in only, parts
// 1 x 4 to 14 x 46 in, depth at most 60% of the sheet, 90° for metric; draw only the minor hole. Metric sizes mm: [major, minor, depth].
const CSK_METRIC = { M3: [6, 3.18, 1.35], M4: [8, 4.04, 1.93], M5: [10, 5.00, 2.44], M6: [12, 6.35, 2.77], M8: [16, 8.00, 3.94] };
const CSK_ALU = { range: [0.125, 0.750], part: [[1, 4], [14, 46]], depth: 0.6, sizes: CSK_METRIC };
const SHOPS = {
  'scs-304': { name: 'SendCutSend 304 stainless', table: SCS_304, flat: [30, 44], box: 5, boxHardware: 3, gap: 0.015, reliefExtra: 0.02, pem: PEM_304, hardwareFlat: [36, 46] },
  'scs-5052': { name: 'SendCutSend 5052 H32 aluminium', table: SCS_5052, flat: [30, 44], box: 5, boxHardware: 3, gap: 0.015, reliefExtra: 0.032, countersink: CSK_ALU, pem: PEM_ALU, hardwareFlat: [36, 46] },
};

/** The gauge: thickness, radius, bend deduction and allowance, limits, all in mm. */
export function gauge(shop = 'scs-304', thicknessIn = 0.060) {
  const s = SHOPS[shop];
  if (!s) throw new GraphError(`sm.gauge: no shop '${shop}'. Known: ${Object.keys(SHOPS).join(', ')}`);
  const row = s.table.find(([t]) => Math.abs(t - thicknessIn) < 1e-4);
  if (!row) throw new GraphError(`sm.gauge: ${s.name} has no ${thicknessIn} in sheet. Thicknesses: ${s.table.map(([t]) => t).join(', ')} in`);
  const [t, r, bd, minFlange, maxBend] = row.map((v) => v * IN);
  return Object.freeze({
    shop, name: `${s.name}, ${thicknessIn} in`, t, r, bd, ba: 2 * (r + t) - bd, minFlange, maxBend,
    reliefWidth: t, reliefDepth: t + r + (s.reliefExtra ?? 0) * IN, gap: s.gap * IN,
    flat: s.flat.map((v) => v * IN), box: (s.box ?? 0) * IN, boxHardware: (s.boxHardware ?? 0) * IN,
    pem: s.pem ?? null, hardwareFlat: s.hardwareFlat?.map((v) => v * IN) ?? null, countersink: s.countersink ?? null,
  });
}

// ---------- 2D helpers: shapes as data, so one description draws both the folded panel and its place in the flat

const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const mul = (a, k) => [a[0] * k, a[1] * k];
const v3 = { add: (a, b) => a.map((x, i) => x + b[i]), mul: (a, k) => a.map((x) => x * k), neg: (a) => a.map((x) => -x),
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2] };

const segDist = (q, a, b) => { const ab = [b[0] - a[0], b[1] - a[1]], l2 = ab[0] ** 2 + ab[1] ** 2 || 1e-12;
  const s = Math.max(0, Math.min(1, ((q[0] - a[0]) * ab[0] + (q[1] - a[1]) * ab[1]) / l2)); return Math.hypot(q[0] - a[0] - s * ab[0], q[1] - a[1] - s * ab[1]); };
const inside = (q, pts) => { let c = false; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
  const [a, b] = [pts[i], pts[j]]; if ((a[1] > q[1]) !== (b[1] > q[1]) && q[0] < ((b[0] - a[0]) * (q[1] - a[1])) / (b[1] - a[1]) + a[0]) c = !c; } return c; };
const ring = (pts) => Math.min(...pts.map((a, i) => segDist([0, 0], a, pts[(i + 1) % pts.length])));
/** Signed distance from q to a shape's edge: + outside it, - inside. ponytail: a rounded rectangle counts as square cornered (its edge is never nearer) */
function edgeDist(q, s) {
  if (s.kind === 'circle') return Math.hypot(q[0] - s.c[0], q[1] - s.c[1]) - s.r;
  if (s.kind === 'slot') return segDist(q, s.a, s.b) - s.r;
  const d = ring(s.pts.map((p) => [p[0] - q[0], p[1] - q[1]]));
  return inside(q, s.pts) ? -d : d;
}

/** A rectangle; r rounds its corners (one radius, or [bottom left, bottom right, top right, top left]). */
export const rect = (u0, v0, u1, v1, r = 0) => {
  const radii = Array.isArray(r) ? r : [r, r, r, r], pts = [[u0, v0], [u1, v0], [u1, v1], [u0, v1]];
  return radii.some((x) => x > 0) ? { kind: 'rrect', pts, r: radii } : { kind: 'poly', pts };
};
export const circle = (u, v, r) => ({ kind: 'circle', c: [u, v], r });
export const slot = (u0, v0, u1, v1, r) => ({ kind: 'slot', a: [u0, v0], b: [u1, v1], r });  // round ended, centres a and b
export const poly = (pts) => ({ kind: 'poly', pts });

function drawShape(s, map) {
  const k = brepKernel();
  if (s.kind === 'circle') { const c = map(s.c); return k.drawCircle(s.r).translate(c[0], c[1]); }
  if (s.kind === 'poly') {
    const p = s.pts.map(map);
    let d = k.draw(p[0]);
    for (const q of p.slice(1)) d = d.lineTo(q);
    return d.close();
  }
  if (s.kind === 'rrect') {  // start mid way along the first side, round each corner with a three point arc
    const p = s.pts.map(map), n = p.length, unit = (a, b) => { const d = [b[0] - a[0], b[1] - a[1]], l = Math.hypot(...d); return [d[0] / l, d[1] / l]; };
    const corner = (i) => {
      const P = p[i], r = s.r[i], dp = unit(P, p[(i + n - 1) % n]), dn = unit(P, p[(i + 1) % n]), sum = add(dp, dn);
      return { r, A: add(P, mul(dp, r)), B: add(P, mul(dn, r)), M: add(add(P, mul(sum, r)), mul(sum, -r / Math.SQRT2)), P };
    };
    let d = k.draw(mul(add(p[0], p[1]), 0.5));
    for (const i of [1, 2, 3, 0]) { const c = corner(i); d = c.r > 0 ? d.lineTo(c.A).threePointsArcTo(c.B, c.M) : d.lineTo(c.P); }
    return d.close();
  }
  const a = map(s.a), b = map(s.b), len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (len < 1e-9) return k.drawCircle(s.r).translate(a[0], a[1]);
  const d = [(b[0] - a[0]) / len, (b[1] - a[1]) / len], n = [-d[1] * s.r, d[0] * s.r];
  return k.draw(add(a, n)).lineTo(add(b, n)).threePointsArcTo(add(b, mul(n, -1)), add(b, mul(d, s.r)))
    .lineTo(add(a, mul(n, -1))).threePointsArcTo(add(a, n), add(a, mul(d, -s.r))).close();
}

function region(shapes, map) {  // shapes[0] the outline, the rest cut out of it
  let d = drawShape(shapes[0], map);
  for (const s of shapes.slice(1)) d = d.cut(drawShape(s, map));
  return d;
}

/**
 * Round every corner of a flat outline (Che-Wei, Oct 22: fillets wherever possible) except those on a bend line and the
 * tangent joins of arcs. Each gets the largest of R, R/2, R/4 ... (down to a quarter mm) that fits 45% of its shorter side.
 * ponytail: a pass the kernel refuses is skipped, leaving those corners sharp; the flat check still runs on what came out
 */
function roundCorners(d, protect, R) {
  const seg = (q, [a, b]) => { const ab = [b[0] - a[0], b[1] - a[1]], l2 = ab[0] ** 2 + ab[1] ** 2 || 1e-12;
    const s = Math.max(0, Math.min(1, ((q[0] - a[0]) * ab[0] + (q[1] - a[1]) * ab[1]) / l2)); return Math.hypot(q[0] - a[0] - s * ab[0], q[1] - a[1] - s * ab[1]); };
  const len = (c) => Math.hypot(c.lastPoint[0] - c.firstPoint[0], c.lastPoint[1] - c.firstPoint[1]);
  const smooth = (e) => { try { const a = e.firstCurve.tangentAt(e.point), b = e.secondCurve.tangentAt(e.point);
    return Math.abs(a[0] * b[1] - a[1] * b[0]) < 1e-3 * Math.hypot(...a) * Math.hypot(...b); } catch { return false; } };
  const want = (e) => (protect.some((p) => seg(e.point, p) < 1e-3) || smooth(e) ? 0 : Math.min(R, 0.45 * Math.min(len(e.firstCurve), len(e.secondCurve))));
  for (let r = R; r >= 0.25; r /= 2) {
    const top = r === R;
    try {
      d = d.fillet(r, (c) => { c.filters.push(({ element: e }) => { const w = want(e); return w >= r && (top || w < 2 * r); }); return c; });
    } catch { /* this size would not go; smaller passes still try their own corners */ }
  }
  return d;
}

/** A mold drawing placed in the flat by a panel's map (a rotation, maybe a mirror, and a shift). */
function place(d, map) {
  const O = map([0, 0]), ex = map([1, 0]), ey = map([0, 1]), x = [ex[0] - O[0], ex[1] - O[1]], y = [ey[0] - O[0], ey[1] - O[1]];
  if (x[0] * y[1] - x[1] * y[0] < 0) d = d.mirror([1, 0], [0, 0], 'plane');
  return d.rotate((Math.atan2(x[1], x[0]) * 180) / Math.PI, [0, 0]).translate(O[0], O[1]);
}

// ---------- the part

/** A bend of `angle` degrees in gauge g: sb, the setback from the mold corner (where the outer faces would meet) to the start of the
 * bend zone; ba, the bend allowance; bd, the deduction. 90° is the shop's table; other angles scale its allowance by the angle (one K factor). */
const bendOf = (g, angle = 90) => { const sb = (g.r + g.t) * Math.tan((angle * Math.PI) / 360), ba = (g.ba * angle) / 90; return { sb, ba, bd: 2 * sb - ba }; };
const EDGES = {  // mold point at param s, outward direction, length
  b: (P) => ({ p: (s) => [s, 0], o: [0, -1], len: P.U }), t: (P) => ({ p: (s) => [s, P.V], o: [0, 1], len: P.U }),
  l: (P) => ({ p: (s) => [0, s], o: [-1, 0], len: P.V }), r: (P) => ({ p: (s) => [P.U, s], o: [1, 0], len: P.V }),
};
// the corner at each end of an edge: [edge, end] of the neighbour that shares it (end 0 = param 0)
const NEIGHBOUR = { b: [['l', 0], ['r', 0]], t: [['l', 1], ['r', 1]], l: [['b', 0], ['t', 0]], r: [['b', 1], ['t', 1]] };

class Part {
  /** hardware: PEM parts go in (SCS caps box flanges lower); round: radius on every free corner of the outline (Che-Wei, Oct 22: fillets
   * wherever possible); gap: space between flange ends that meet at a corner, never under the shop's. */
  constructor(g, name, { hardware = false, round = 3, gap = g.gap } = {}) {
    this.g = g; this.name = name; this.hardware = hardware; this.round = round; this.gap = Math.max(gap, g.gap);
    this.panels = new Map(); this.windows = []; this.pems = []; this.sinks = [];
  }

  /** The base: a U x V rectangle (outside sizes). */
  base(U, V) {
    if (this.panels.size) throw new GraphError(`sm part '${this.name}': base() is called once, first`);
    this.panels.set('base', { id: 'base', U, V, cuts: [], kids: [] });
    return this;
  }

  /**
   * A flange `length` high (outside size, from the parent's outer face) off edge `at`, a path like 'base.r' or 'base.r.t'.
   * from / to: where along the edge it runs (default the whole edge). reverse: fold it away from the inside (a Z bend), its
   * length then measured from the parent's inside face. angle: the bend in degrees (default 90; 45 leans the flange in at a
   * chamfer), lengths still measured from the mold corner where the outer faces would meet. Returns the part; the new panel is `${at}`.
   * Several flanges on one edge (tabs): tag each but the first, 'base.l#2', and hold them apart and off the corners with from / to.
   */
  flange(at, length, { from = null, to = null, reverse = false, angle = 90 } = {}) {
    if (!Number.isFinite(this.g.r)) throw new GraphError(`sm part '${this.name}': ${this.g.name} has no bend table here, so it is cut flat only`);
    const i = at.lastIndexOf('.'), pid = at.slice(0, i), tag = at.slice(i + 1), edge = tag[0], P = this.panels.get(pid);
    if (!P) throw new GraphError(`sm part '${this.name}': no panel '${pid}' for flange '${at}'`);
    if (!EDGES[edge] || !/^[bltr](#\w+)?$/.test(tag)) throw new GraphError(`sm part '${this.name}': edge '${tag}' is not one of b, t, l, r (a #tag after one makes a second flange on that edge)`);
    if (pid !== 'base' && edge === 'b') throw new GraphError(`sm part '${this.name}': '${at}' is the bend of '${pid}', not a free edge`);
    if (this.panels.has(at)) throw new GraphError(`sm part '${this.name}': '${at}' already has a flange`);
    if (!(angle > 0 && angle < 180)) throw new GraphError(`sm part '${this.name}': flange '${at}' bend angle ${angle}° must be between 0 and 180`);
    const k = { id: at, parent: pid, edge, L: length, from, to, reverse, angle, cuts: [], kids: [] };  // null ends: to the corner, settled in _layout
    if (from != null && to != null && !(to > from)) throw new GraphError(`sm part '${this.name}': flange '${at}' runs from ${k.from} to ${k.to}`);
    P.kids.push(k); this.panels.set(at, k);
    return this;
  }

  /** Cut a hole (sm.rect / sm.circle / sm.slot / sm.poly, in that panel's mold coordinates) through a panel. */
  cut(panel, ...shapes) {
    const P = this.panels.get(panel);
    if (!P) throw new GraphError(`sm part '${this.name}': no panel '${panel}' to cut`);
    P.cuts.push(...shapes);
    return this;
  }

  /** A window bend: an opening [u0, v0, u1, v1] in a panel whose four edges fold in as flaps `depth` deep. */
  window(panel, [u0, v0, u1, v1], depth) {
    if (!this.panels.has(panel)) throw new GraphError(`sm part '${this.name}': no panel '${panel}' for a window`);
    this.windows.push({ panel, u0, v0, u1, v1, depth });
    return this;
  }

  /** A point given in the frame `make` will get, as [u, v] in that panel's mold coordinates (it must lie on the panel's sheet). */
  at(panel, point, frame) {
    this._frame = frameOf(this.name, frame);
    const e = this._layout().panels.find((x) => x.P.id === panel);
    if (!e) throw new GraphError(`sm part '${this.name}': no panel '${panel}'`);
    const d = v3.add(point, v3.neg(e.frame.o)), w = v3.dot(d, e.frame.n);
    if (w < -0.5 || w > this.g.t + 0.5) throw new GraphError(`sm part '${this.name}': [${point.map((c) => c.toFixed(1))}] is ${w.toFixed(1)} mm off panel '${panel}'`);
    return [v3.dot(d, e.frame.u), v3.dot(d, e.frame.v)];
  }

  /**
   * A PEM part from the shop's catalog at [u, v] (mold coordinates) in a panel. face: the side its body stands out of ('in', the
   * panel's inside, or 'out'). A flush stud's head sits in the other face. The hole is drawn at the catalog's size (the shop resizes it anyway).
   */
  pem(panel, sku, [u, v], { face = 'in' } = {}) {
    if (!this.panels.has(panel)) throw new GraphError(`sm part '${this.name}': no panel '${panel}' for ${sku}`);
    const spec = this.g.pem?.[sku];
    if (!spec) throw new GraphError(`sm part '${this.name}': ${this.g.name} has no hardware '${sku}'. Known: ${Object.keys(this.g.pem ?? {}).join(', ') || 'none'}`);
    this.pems.push({ panel, sku, spec, at: [u, v], face });
    this.hardware = true;
    return this;
  }

  /** A countersunk hole for a metric flat head screw (size 'M4' ...) at [u, v] in a panel; face: the side the head goes in. */
  countersink(panel, size, [u, v], { face = 'out' } = {}) {
    if (!this.panels.has(panel)) throw new GraphError(`sm part '${this.name}': no panel '${panel}' for a countersink`);
    if (!CSK_METRIC[size]) throw new GraphError(`sm part '${this.name}': countersink '${size}' is not one of ${Object.keys(CSK_METRIC).join(', ')}`);
    this.sinks.push({ panel, size, at: [u, v], face });
    return this;
  }

  // ----- layout: sizes, extents, reliefs and both maps for every panel

  _layout() {
    const { g } = this, rt = g.r + g.t, cl = rt + g.t, ext = 2 * g.t;  // cl: corner relief, deep enough that its t round clears the bends
    const base = this.panels.get('base');
    if (!base) throw new GraphError(`sm part '${this.name}': call base(U, V) first`);
    const out = [], bends = [];
    const visit = (P, frame, map) => {
      const sbP = P.id === 'base' ? 0 : bendOf(g, P.angle ?? 90).sb;  // a flange's flat starts this far up its mold
      const cuts = [...P.cuts, ...(P.mitre ?? [])], kids = [], protect = P.rootBend ? [[[P.rootBend[0], sbP], [P.rootBend[1], sbP]]] : [];
      protect.push(...(P.mitreEdges ?? []));   // the mitre's root corner stays sharp (its apex is rounded like any free corner)
      for (const h of this.pems) if (h.panel === P.id) cuts.push(h.hole = circle(...h.at, (h.spec[2] * IN) / 2));
      for (const h of this.sinks) if (h.panel === P.id) cuts.push(circle(...h.at, CSK_METRIC[h.size][1] / 2));
      const ends = (k) => [k.from ?? 0, k.to ?? EDGES[k.edge](P).len], reach = (k, end) => end ? ends(k)[1] >= EDGES[k.edge](P).len - 1e-6 : ends(k)[0] <= 1e-6;
      const on = (edge, end) => P.kids.find((k) => k.edge === edge && reach(k, end));
      for (const k of P.kids) {
        const E = EDGES[k.edge](P), { sb: sbK } = bendOf(g, k.angle ?? 90);
        let [f0, f1] = ends(k), [b0, b1] = [f0, f1];
        k._mitre = [0, 0];  // per end: slope of the mitre line (u per v) where it meets a leaning neighbour
        for (const end of [0, 1]) {
          const s = ends(k)[end], [nEdge, nEnd] = NEIGHBOUR[k.edge][end];
          const atCorner = reach(k, end), closed = atCorner && on(nEdge, nEnd) && !(P.id !== 'base' && nEdge === 'b');
          if (closed && (k.reverse || on(nEdge, nEnd).reverse)) throw new GraphError(`sm part '${this.name}': reverse flange ${k.reverse ? k.id : on(nEdge, nEnd).id} meets another at a corner; stop it short with from / to`);
          const sg = end ? -1 : 1;
          if (closed) {  // flanges meet: flats stop t + gap short of the corner, bends r + t + relief, the corner square goes
            // the neighbour leans too (a chamfer): the two flare out, so the line where they meet leaves the mold corner OUTWARD
            // at m per unit up the flange. This flange's flat runs m·L past the corner and is mitred back to that line (half a
            // thickness and the shop's gap short, so the skins don't cross): the two short edges meet all the way up.
            const nb = on(nEdge, nEnd), m = Math.sin(((k.angle ?? 90) * Math.PI) / 180) / Math.tan(((nb.angle ?? 90) * Math.PI) / 180);
            const past = m > 1e-9 ? m * k.L - this.gap - m * g.t / 2 : -(g.t + this.gap);   // how far the flat's end runs past the corner
            if (end) { f1 = s + past; b1 = s - cl; } else { f0 = s - past; b0 = s + cl; }
            if (m > 1e-9) k._mitre[end] = m;
            const c = E.p(s), inU = E.o[0] ? -E.o[0] : 0, inV = E.o[1] ? -E.o[1] : 0;
            const along = [E.o[1] !== 0 ? sg : 0, E.o[0] !== 0 ? sg : 0];  // edge direction, pointing in from the corner
            const a = add(c, add(mul([inU, inV], cl), mul(along, cl))), z = add(c, add(mul([inU, inV], -ext), mul(along, -ext)));  // past the corner, so only its inside corner shows round
            cuts.push(rect(Math.min(z[0], a[0]), Math.min(z[1], a[1]), Math.max(z[0], a[0]), Math.max(z[1], a[1])));
          } else if (!atCorner || (P.id !== 'base' && nEdge === 'b')) {  // ends mid edge (or next to this panel's own bend): a relief slot past it
            const w = g.reliefWidth, at = E.p(s + (end ? w / 2 : -w / 2)), d = sbK + g.reliefDepth;  // round ended, from past the edge to its depth
            cuts.push(slot(...add(at, mul(E.o, ext)), ...add(at, mul(E.o, -(d - w / 2))), w / 2));
          }
        }
        // a flange run past its parent's edge (from < 0, to > len) bends only where the parent has material
        b0 = Math.max(b0, 0); b1 = Math.min(b1, E.len);
        // the bend's own strip; its line stays sharp (a round there would eat into the bend)
        const s0 = E.p(b0), s1 = add(E.p(b1), mul(E.o, -sbK));
        protect.push([add(E.p(b0), mul(E.o, -sbK)), s1]);
        cuts.push(rect(Math.min(s0[0], s1[0]), Math.min(s0[1], s1[1]), Math.max(s0[0], s1[0]), Math.max(s0[1], s1[1])));
        kids.push({ k, E, f0, f1, b0, b1 });
      }
      // windows in this panel: the opening, the four strips the flaps bend from, and a relief square outside each corner
      const wins = this.windows.filter((w) => w.panel === P.id).map((w) => {
        const { u0, v0, u1, v1, depth } = w;
        cuts.push(rect(u0, v0, u1, v1), rect(u0 - rt, v0, u0, v1), rect(u1, v0, u1 + rt, v1), rect(u0, v0 - rt, u1, v0), rect(u0, v1, u1, v1 + rt),
          rect(u0 - cl, v0 - cl, u0 + ext, v0 + ext), rect(u1 - ext, v0 - cl, u1 + cl, v0 + ext), rect(u0 - cl, v1 - ext, u0 + ext, v1 + cl), rect(u1 - ext, v1 - ext, u1 + cl, v1 + cl));
        // flap edges, outward into the opening
        return [
          { p: (s) => [u0, v0 + s], o: [1, 0], len: v1 - v0 }, { p: (s) => [u1, v0 + s], o: [-1, 0], len: v1 - v0 },
          { p: (s) => [u0 + s, v0], o: [0, 1], len: u1 - u0 }, { p: (s) => [u0 + s, v1], o: [0, -1], len: u1 - u0 },
        ].map((E, i) => ({ k: { id: `${P.id}.window${this.windows.indexOf(w)}.${'lrbt'[i]}`, L: depth, cuts: [], kids: [], window: true }, E, f0: 0, f1: E.len, b0: cl, b1: E.len - cl }));
      }).flat();
      for (const { E, b0, b1 } of wins) protect.push([add(E.p(b0), mul(E.o, -rt)), add(E.p(b1), mul(E.o, -rt))]);
      const outline = rect(0, sbP, P.U, P.V);
      out.push({ P, frame, map, cuts, outline, protect });
      for (const { k, E, f0, f1, b0, b1 } of [...kids, ...wins]) {
        // the flange's frame: v up the parent's inside normal, its inside back over the parent, u from the right hand rule
        const o3 = v3.add(v3.mul(frame.u, E.o[0]), v3.mul(frame.v, E.o[1]));
        const ed = E.p(1), e0 = E.p(0), e2 = [ed[0] - e0[0], ed[1] - e0[1]], e3 = v3.add(v3.mul(frame.u, e2[0]), v3.mul(frame.v, e2[1]));
        // v leans from the parent's inside normal toward the edge by (90° - angle); the mold corner (where the outer faces would meet) is the parent's mold edge
        const th = ((k.angle ?? 90) * Math.PI) / 180, { bd: bdK } = bendOf(g, k.angle ?? 90), nn = k.reverse ? v3.neg(frame.n) : frame.n;
        const kv = v3.add(v3.mul(o3, Math.cos(th)), v3.mul(nn, Math.sin(th))), kn = v3.add(v3.mul(o3, -Math.sin(th)), v3.mul(nn, Math.cos(th)));
        const ku = v3.cross(kv, kn), fwd = v3.dot(ku, e3) > 0;
        const at = (s) => v3.add(frame.o, v3.add(v3.mul(frame.u, E.p(s)[0]), v3.mul(frame.v, E.p(s)[1])));
        const param = (u) => fwd ? f0 + u : f1 - u;
        const root = k.reverse ? v3.add(at(fwd ? f0 : f1), v3.mul(frame.n, g.t)) : at(fwd ? f0 : f1);  // a reverse flange starts on the parent's inside face
        const kframe = { o: root, u: ku, v: kv, n: kn };
        const kmap = (pt) => map(add(E.p(param(pt[0])), mul(E.o, pt[1] - bdK)));
        const K = this.panels.get(k.id) ?? k;
        K.U = f1 - f0; K.V = k.L; K.window = k.window; K.reverse = k.reverse; K.rootBend = fwd ? [b0 - f0, b1 - f0] : [f1 - b1, f1 - b0];
        K.mitre = []; K.mitreEdges = [];
        for (const end of [0, 1]) {  // a mitred end: everything beyond the corner by more than m per unit up the flange goes
          const m = k._mitre?.[end]; if (!m) continue;
          // a: the corner in the flat's u, less the gap and half thickness the flat's end was held back (the line stays that far off the meeting line)
          const e = (end === 0) === fwd ? 0 : K.U, sg = e === 0 ? 1 : -1, a = e + sg * m * k.L, big = 10 * (k.L + K.U);
          K.mitre.push(poly([[a, 0], [a - sg * m * big, big], [a - sg * 2 * big, big], [a - sg * 2 * big, 0]]));
          K.mitreEdges.push([[a, 0], [a - sg * m * cl, cl]]);   // protect the root end only: the apex takes the usual round (Che-Wei, Oct 24)
        }
        // the bend: section in the plane across the edge, swept along it
        const nrm = v3.dot(v3.cross(e3, o3), frame.n) > 0 ? e3 : v3.neg(e3);
        bends.push({ id: k.id, P, len: b1 - b0, plane: { origin: at(nrm === e3 ? b0 : b1), xDir: o3, normal: nrm },
          zone: [E.p(b0), E.p(b1), E.o], map, L: k.L, reverse: !!k.reverse, angle: k.angle ?? 90 });
        // a window flap's flat is mitred where it meets its neighbour, so the four lie flat in the opening without overlapping
        if (k.window) {
          // keep only points further along the edge from a corner than they are deep in the flat: a 45° cone off each corner goes
          const big = 10 * (k.L + K.U), m = g.bd - g.gap;
          K.cuts = [fwd ? -f0 : f1, fwd ? E.len - f0 : f1 - E.len].map((c) => poly([[c, m], [c + big, m + big], [c - big, m + big]]));
        }
        visit(K, kframe, kmap);
      }
    };
    visit(base, this._frame, (pt) => pt);
    return { panels: out, bends };
  }

  /** A panel's shape in its own mold coordinates: outline less cuts, every corner rounded but those on a bend line. */
  _mold({ cuts, outline, protect }) {
    return roundCorners(region([outline, ...cuts], (p) => p), protect, this.round, this.g.t);
  }

  // ----- the folded solid

  /** The folded part, one body. frame: {origin, u, v, n} puts the base's mold corner at origin, u and v along it, n its inside. */
  solid(frame) {
    this._frame = frameOf(this.name, frame);
    const { g } = this, { panels, bends } = this._layout(), k = brepKernel(), rt = g.r + g.t;
    const pieces = panels.map((e) => ({ id: e.P.id, solid: brepExtrude(brepDrawingSketch(this._mold(e), { origin: e.frame.o, xDir: e.frame.u, normal: e.frame.n }), g.t, false) }));
    for (const b of bends) {
      if (b.len <= 1e-6) continue;
      // section across the edge (x out of it, y the parent's inside normal): a ring sector of the bend's angle, tangent to the parent's
      // outside face sb short of the mold corner and to the flange's outside face sb past it; mirrored through the sheet's mid plane for a reverse bend
      const th = (b.angle * Math.PI) / 180, c = [-bendOf(g, b.angle).sb, rt], on = (rho, a) => [c[0] + rho * Math.sin(a), c[1] - rho * Math.cos(a)];
      const q = [on(rt, 0), on(rt, th / 2), on(rt, th), on(g.r, th), on(g.r, th / 2), on(g.r, 0)].map(([x, y]) => (b.reverse ? [x, g.t - y] : [x, y]));
      const sec = k.draw(q[0]).threePointsArcTo(q[2], q[1]).lineTo(q[3]).threePointsArcTo(q[5], q[4]).close();
      pieces.push({ id: `${b.id} bend`, solid: brepExtrude(brepDrawingSketch(sec, b.plane), b.len, false) });
    }
    this._pieces = pieces;
    let s = pieces.length > 1 ? ops.union(...pieces.map((p) => p.solid)) : pieces[0].solid;
    // hardware, fused in: a body stands out of its face, nuts and standoffs bored through (plain, no threads) with the sheet; a nut in PEM_BODY gets
    // its collar and shank, the rest are plain cylinders (ponytail: diameters estimated, the shop's catalog gives the hole, not the body; add PEM's drawing to PEM_BODY)
    const frameOfPanel = Object.fromEntries(panels.map((e) => [e.P.id, e.frame]));
    const place3 = (h) => { const f = frameOfPanel[h.panel]; return { p: v3.add(f.o, v3.add(v3.mul(f.u, h.at[0]), v3.mul(f.v, h.at[1]))), n: f.n }; };
    const bores = [];
    const hw = this.pems.map((h) => {
      const { p, n } = place3(h), [kind, thread, H, , , len] = h.spec, up = h.face === 'in' ? n : v3.neg(n);
      const faceAt = h.face === 'in' ? v3.add(p, v3.mul(n, g.t)) : p, farAt = h.face === 'in' ? p : v3.add(p, v3.mul(n, g.t));
      if (kind === 'stud') return along(ops.cylinder(Math.max(thread, H * IN) / 2 + 0.05, len * IN), up, farAt);  // head flush in the far face; a hair over the hole so it fuses
      bores.push(along(ops.cylinder(thread / 2, g.t + len * IN + 1), up, v3.add(farAt, v3.mul(up, -0.5))));
      const body = PEM_BODY[h.sku];
      if (!body) return along(ops.cylinder((H * IN) / 2 + (kind === 'nut' ? 1.5 : 1), len * IN + 0.05), up, v3.add(faceAt, v3.mul(up, -0.05)));
      const [E, T, A] = body;  // the shank fills the sheet's hole (C is a hair under it) for A in from the face; the sheet cold flows round the rest
      return ops.union(along(ops.cylinder(E / 2, T + 0.05), up, v3.add(faceAt, v3.mul(up, -0.05))),
        along(ops.cylinder((H * IN) / 2 + 0.05, A + 0.05), v3.neg(up), v3.add(faceAt, v3.mul(up, 0.05))));
    });
    if (hw.length) s = ops.union(s, ...hw);
    if (bores.length) s = ops.subtract(s, ...bores);
    const cones = this.sinks.map((h) => {
      const { p, n } = place3(h), [major, minor] = CSK_METRIC[h.size], down = h.face === 'out' ? n : v3.neg(n), e = 0.05;
      const top = h.face === 'out' ? p : v3.add(p, v3.mul(n, g.t));
      return along(ops.cone(major / 2 + e, minor / 2, (major - minor) / 2 + e), down, v3.add(top, v3.mul(down, -e)));
    });
    if (cones.length) s = ops.subtract(s, ...cones);
    return s;
  }

  // ----- the flat pattern

  /** The flat: {drawing, bendLines: [[a, b]], size: [w, h]} in mm, the base's mold corner at the origin. */
  flat() {
    if (!this._frame) this._frame = { o: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] };
    const { g } = this, rt = g.r + g.t, { panels, bends } = this._layout();
    const parts = panels.map((e) => ({ id: e.P.id, d: place(this._mold(e), e.map) }));
    const bendLines = [];
    for (const b of bends) {
      const [a, z, o] = b.zone, off = (x) => [add(a, mul(o, x)), add(z, mul(o, x))], { sb, ba } = bendOf(g, b.angle);
      const [p0, p1] = off(-sb), [q0, q1] = off(-sb + ba);
      if (b.len > 1e-6) parts.push({ id: `${b.id} bend`, d: region([poly([p0, p1, q1, q0])], b.map) });
      bendLines.push(Object.assign(off(-sb + ba / 2).map(b.map), { reverse: b.reverse, angle: b.angle }));
    }
    let d = parts[0].d;
    for (const p of parts.slice(1)) d = d.fuse(p.d);
    const bb = d.boundingBox;
    return { drawing: d, parts, bendLines, size: [bb.width, bb.height], min: [bb.bounds[0][0], bb.bounds[0][1]] };
  }

  /** The flat pattern as DXF (mm): the outline and holes on CUT, bend centre lines on BEND (dashed), reverse bends on BEND_REVERSE. */
  dxf(f = this.flat()) {
    return toDXF(f.drawing.toSVGPaths(), f.bendLines);
  }

  /**
   * The shop's rules, measured: flat size, flange heights, bend lengths, box flanges, nothing overlapping folded or flat.
   * Returns [{label, ok, value, limit, unit}] rows; `sm.part(...).check()` is what the cell API records.
   */
  rules(f = this.flat()) {
    const { g } = this, rows = [], IN1 = (x) => (x / IN).toFixed(2);
    const [w, h] = [...f.size].sort((a, b) => a - b), [fw, fh] = [...g.flat].sort((a, b) => a - b);
    rows.push({ label: `${this.name}: flat ${IN1(w)} x ${IN1(h)} in within ${fw / IN} x ${fh / IN} in`, ok: w <= fw + 1e-6 && h <= fh + 1e-6, value: [w, h], limit: [fw, fh] });
    for (const P of this.panels.values()) {
      if (P.id === 'base') continue;
      if (P.L < g.minFlange - 1e-6) rows.push({ label: `${this.name}: flange ${P.id} ${P.L.toFixed(2)} mm under the ${g.minFlange.toFixed(2)} mm minimum`, ok: false, value: P.L, limit: g.minFlange });
      const len = P.U;
      if (len > g.maxBend + 1e-6) rows.push({ label: `${this.name}: bend ${P.id} ${IN1(len)} in over the ${IN1(g.maxBend)} in brake`, ok: false, value: len, limit: g.maxBend });
    }
    // flanges on two adjacent edges of a panel make a box: SCS caps their height
    const cap = this.hardware ? g.boxHardware : g.box;
    for (const P of this.panels.values()) {
      const edges = new Set(P.kids.map((k) => k.edge));
      const boxy = ['l', 'r'].some((a) => edges.has(a)) && ['b', 't'].some((b) => edges.has(b));
      for (const k of boxy ? P.kids : []) if (k.L > cap + 1e-6) rows.push({ label: `${this.name}: box flange ${k.id} ${IN1(k.L)} in over ${cap / IN} in`, ok: false, value: k.L, limit: cap });
    }
    // flat: no two pieces overlap (a flange unfolding onto another)
    const overlaps = [];
    for (let i = 0; i < f.parts.length; i++) for (let j = i + 1; j < f.parts.length; j++) {
      const a = f.parts[i].d.boundingBox, b = f.parts[j].d.boundingBox, [A, B] = [a.bounds, b.bounds];
      if (A[1][0] <= B[0][0] + 0.01 || B[1][0] <= A[0][0] + 0.01 || A[1][1] <= B[0][1] + 0.01 || B[1][1] <= A[0][1] + 0.01) continue;
      let hit = false;
      try { const x = f.parts[i].d.clone().intersect(f.parts[j].d.clone()); const xb = x.boundingBox; hit = xb.width > 0.01 && xb.height > 0.01; } catch { hit = false; }
      if (hit) overlaps.push(`${f.parts[i].id} / ${f.parts[j].id}`);
    }
    rows.push({ label: `${this.name}: flat pieces clear of each other${overlaps.length ? ': ' + overlaps.join(', ') : ''}`, ok: !overlaps.length, value: overlaps.length, limit: 0 });
    // folded: no two pieces in the same space (interference check where their boxes meet)
    if (this._pieces) {
      const clash = [], P = this._pieces, bb = P.map((p) => ops.bbox(p.solid));
      for (let i = 0; i < P.length; i++) for (let j = i + 1; j < P.length; j++) {
        const [a, b] = [bb[i], bb[j]];
        if ([0, 1, 2].some((x) => a.max[x] <= b.min[x] + 0.01 || b.max[x] <= a.min[x] + 0.01)) continue;
        let v = 0; try { v = ops.volume(ops.interference(P[i].solid, P[j].solid)); } catch { v = 0; }
        if (v > 0.01) clash.push(`${P[i].id} / ${P[j].id}`);
      }
      rows.push({ label: `${this.name}: folded pieces clear of each other${clash.length ? ': ' + clash.join(', ') : ''}`, ok: !clash.length, value: clash.length, limit: 0 });
    }
    // hardware: in the catalog's sheet range, its K / N clear of every cut edge and bend allowance area, same SKUs M apart
    if (this.pems.length) {
      const tIn = g.t / IN, bad = [], panels = this._layout().panels;
      for (const e of panels) {
        const mine = this.pems.filter((h) => h.panel === e.P.id);
        for (const h of mine) {
          const [, , , K, M, , [lo, hi]] = h.spec;
          if (tIn < lo - 1e-4 || tIn > hi + 1e-4) bad.push(`${h.sku} wants ${lo} to ${hi} in sheet`);
          const near = Math.min(-edgeDist(h.at, e.outline), ...e.cuts.filter((c) => c !== h.hole).map((c) => edgeDist(h.at, c)),
            ...e.protect.map(([a, b]) => segDist(h.at, a, b)));
          if (near < K * IN - 1e-3) bad.push(`${h.sku} on ${e.P.id} at [${h.at.map((x) => x.toFixed(1))}] is ${near.toFixed(1)} mm from an edge or bend, under its ${(K * IN).toFixed(1)}`);
          for (const o of mine) if (o !== h && o.sku === h.sku && Math.hypot(o.at[0] - h.at[0], o.at[1] - h.at[1]) < M * IN - 1e-3 && mine.indexOf(o) > mine.indexOf(h)) bad.push(`two ${h.sku} on ${e.P.id} closer than ${(M * IN).toFixed(1)}`);
        }
      }
      const [w, h] = [...f.size].sort((a, b) => a - b), lim = g.hardwareFlat ? [...g.hardwareFlat].sort((a, b) => a - b) : null;
      if (lim && (w > lim[0] + 1e-6 || h > lim[1] + 1e-6)) bad.push(`flat over ${lim.map(IN1).join(' x ')} in for hardware`);
      const n = {}; for (const x of this.pems) n[x.sku] = (n[x.sku] ?? 0) + 1;
      rows.push({ label: `${this.name}: hardware ${Object.entries(n).map(([k, v]) => `${v} ${k}`).join(', ')} within the catalog's edge, bend and spacing distances${bad.length ? ': ' + bad.join('; ') : ''}`, ok: !bad.length, value: bad.length, limit: 0 });
    }
    if (this.sinks.length) {
      const c = g.countersink, tIn = g.t / IN, bad = [];
      if (!c) bad.push(`${g.name} is not countersunk by the shop (aluminium and plastics .125 to .750 in only)`);
      else {
        if (tIn < c.range[0] - 1e-4 || tIn > c.range[1] + 1e-4) bad.push(`sheet outside ${c.range.join(' to ')} in`);
        for (const s of new Set(this.sinks.map((x) => x.size))) if (CSK_METRIC[s][2] > c.depth * g.t + 1e-6) bad.push(`${s} is ${CSK_METRIC[s][2]} mm deep, over ${(c.depth * 100).toFixed(0)}% of ${g.t.toFixed(2)} mm`);
        const [w, h] = [...f.size].sort((a, b) => a - b).map((x) => x / IN), [[a0, b0], [a1, b1]] = c.part;
        if (w < a0 - 1e-6 || h < b0 - 1e-6 || w > a1 + 1e-6 || h > b1 + 1e-6) bad.push(`part ${w.toFixed(2)} x ${h.toFixed(2)} in outside ${a0} x ${b0} to ${a1} x ${b1} in`);
      }
      rows.push({ label: `${this.name}: ${this.sinks.length} countersinks${bad.length ? ': ' + bad.join('; ') : ' within the shop\'s sizes'}`, ok: !bad.length, value: bad.length, limit: 0 });
    }
    return rows.map((r) => ({ unit: 'mm', ...r }));
  }

  /** Hardware and countersinks by SKU, for the order. */
  bom() {
    const n = {}; for (const x of this.pems) n[x.sku] = (n[x.sku] ?? 0) + 1;
    for (const x of this.sinks) n[`countersink ${x.size}`] = (n[`countersink ${x.size}`] ?? 0) + 1;
    return n;
  }
}

/** A solid built along +z, turned so z runs along `axis` and moved to `at`. */
function along(s, axis, at) {
  const c = v3.cross([0, 0, 1], axis), sn = Math.hypot(...c), cs = axis[2];
  if (sn > 1e-9) s = ops.rotate(s, (Math.atan2(sn, cs) * 180) / Math.PI, c.map((x) => x / sn));
  else if (cs < 0) s = ops.rotate(s, 180, [1, 0, 0]);
  return ops.translate(s, at);
}

function frameOf(name, { origin = [0, 0, 0], u = [1, 0, 0], v = [0, 1, 0], n = [0, 0, 1] } = {}) {
  if (v3.dot(v3.cross(u, v), n) < 0.999) throw new GraphError(`sm part '${name}': frame u, v, n must be right handed unit vectors`);
  return { o: origin, u, v, n };
}

// ---------- DXF out: replicad's SVG paths (lines and true arcs) to R12 entities; extra lines on BEND, BEND_REVERSE or their own `layer` (softgoods' STITCH, NOTCH, GRAIN); texts {at, text, height, rotation, layer} on TEXT

export function toDXF(svgPaths, bendLines, texts = []) {
  const ents = [];
  const line = (a, b, layer) => ents.push(`0\nLINE\n8\n${layer}\n10\n${a[0]}\n20\n${a[1]}\n30\n0\n11\n${b[0]}\n21\n${b[1]}\n31\n0`);
  for (const path of svgPaths.flat()) {
    const tok = path.match(/[MLAZC]|-?[\d.]+(?:e-?\d+)?/gi);
    let i = 0, cur = null, start = null;
    const num = () => Number(tok[i++]), pt = () => { const x = num(), y = -num(); return [x, y]; };  // SVG y runs down
    while (i < tok.length) {
      const c = tok[i++];
      if (c === 'M') { cur = start = pt(); } else if (c === 'L') { const p = pt(); line(cur, p, 'CUT'); cur = p; } else if (c === 'Z' || c === 'z') {
        if (Math.hypot(cur[0] - start[0], cur[1] - start[1]) > 1e-9) line(cur, start, 'CUT'); cur = start;
      } else if (c === 'A') {
        const r = num(); num(); num(); const large = num(), sweep = 1 - num(), p = pt();  // y flipped, so the sweep turns over
        const m = [(cur[0] + p[0]) / 2, (cur[1] + p[1]) / 2], d = [p[0] - cur[0], p[1] - cur[1]], half = Math.hypot(...d) / 2;
        const h = Math.sqrt(Math.max(0, r * r - half * half)), nrm = [-d[1] / (2 * half), d[0] / (2 * half)];
        const sgn = large === sweep ? -1 : 1, ctr = [m[0] + sgn * h * nrm[0], m[1] + sgn * h * nrm[1]];
        const ang = (q) => (Math.atan2(q[1] - ctr[1], q[0] - ctr[0]) * 180) / Math.PI;
        const [a0, a1] = sweep ? [ang(cur), ang(p)] : [ang(p), ang(cur)];
        ents.push(`0\nARC\n8\nCUT\n10\n${ctr[0]}\n20\n${ctr[1]}\n30\n0\n40\n${r}\n50\n${a0}\n51\n${a1}`);
        cur = p;
      } else if (c === 'C') {
        throw new GraphError('sm dxf: a spline in the flat outline; only lines and arcs are written');
      }
    }
  }
  for (const bl of bendLines) line(bl[0], bl[1], bl.layer ?? (bl.reverse ? 'BEND_REVERSE' : 'BEND'));
  for (const t of texts) ents.push(`0\nTEXT\n8\n${t.layer ?? 'TEXT'}\n10\n${t.at[0]}\n20\n${t.at[1]}\n30\n0\n40\n${t.height ?? 5}\n50\n${t.rotation ?? 0}\n1\n${t.text}`);
  const tables = '0\nSECTION\n2\nTABLES\n0\nTABLE\n2\nLTYPE\n70\n2\n0\nLTYPE\n2\nCONTINUOUS\n70\n0\n3\nSolid line\n72\n65\n73\n0\n40\n0.0\n'
    + '0\nLTYPE\n2\nDASHED\n70\n0\n3\nDashed\n72\n65\n73\n2\n40\n9.0\n49\n6.0\n49\n-3.0\n0\nENDTAB\n'
    + '0\nTABLE\n2\nLAYER\n70\n7\n0\nLAYER\n2\nCUT\n70\n0\n62\n7\n6\nCONTINUOUS\n0\nLAYER\n2\nBEND\n70\n0\n62\n1\n6\nDASHED\n0\nLAYER\n2\nBEND_REVERSE\n70\n0\n62\n5\n6\nDASHED\n0\nLAYER\n2\nSTITCH\n70\n0\n62\n3\n6\nCONTINUOUS\n0\nLAYER\n2\nNOTCH\n70\n0\n62\n6\n6\nCONTINUOUS\n0\nLAYER\n2\nGRAIN\n70\n0\n62\n4\n6\nCONTINUOUS\n0\nLAYER\n2\nTEXT\n70\n0\n62\n7\n6\nCONTINUOUS\n0\nENDTAB\n0\nENDSEC\n';
  return `0\nSECTION\n2\nHEADER\n9\n$INSUNITS\n70\n4\n0\nENDSEC\n${tables}0\nSECTION\n2\nENTITIES\n${ents.join('\n')}\n0\nENDSEC\n0\nEOF\n`;
}

/**
 * The `sm` namespace a cell sees. `checked` is the cell's assertion sink (the shop's rules land there like assert.*),
 * `flats` collects each named part's DXF for export (identical parts by name count up).
 */
export function sheetMetalNamespace(checked = [], flats = []) {
  return Object.freeze({
    gauge, rect, circle, slot, poly, hardware: PEM_304, countersinks: CSK_METRIC,
    /** A new part: sm.part('front tray', sm.gauge('scs-304', 0.060), {hardware}) */
    part: (name, g = gauge(), opts) => {
      const p = new Part(g, name, opts);
      const solid = p.solid.bind(p);
      /** Fold it, check the shop's rules (recorded like assert.*; a miss throws), and keep its flat for DXF export. */
      p.make = (frame, { qty = 1 } = {}) => {
        const t0 = Date.now(), s = solid(frame), t1 = Date.now(), f = p.flat(), t2 = Date.now(), rows = p.rules(f);
        p.timing = { solid: t1 - t0, flat: t2 - t1, rules: Date.now() - t2 };
        p.size = f.size;  // flat w, h in mm, for the cell's own logs
        for (const r of rows) {
          checked.push({ label: r.label, ok: r.ok, value: r.value, limit: r.limit, unit: r.unit, detail: null });
          if (!r.ok) throw new GraphError(`sheet metal ${r.label}`);
        }
        const dxf = p.dxf(f), seen = flats.find((x) => x.name === name);
        if (seen && seen.dxf !== dxf) throw new GraphError(`sheet metal: two different parts are named '${name}'`);
        if (seen) seen.qty += qty; else flats.push({ name, dxf, qty, size: f.size, gauge: g.name, hardware: p.bom() });
        return s;
      };
      return p;
    },
  });
}
