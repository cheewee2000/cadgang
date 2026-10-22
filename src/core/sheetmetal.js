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
 * a flange's b edge is its bend. Flanges fold 90° toward the inside.
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
const SHOPS = { 'scs-304': { name: 'SendCutSend 304 stainless', table: SCS_304, flat: [30, 44], box: 5, boxHardware: 3, gap: 0.015, reliefExtra: 0.02 } };

/** The gauge: thickness, radius, bend deduction and allowance, limits, all in mm. */
export function gauge(shop = 'scs-304', thicknessIn = 0.060) {
  const s = SHOPS[shop];
  if (!s) throw new GraphError(`sm.gauge: no shop '${shop}'. Known: ${Object.keys(SHOPS).join(', ')}`);
  const row = s.table.find(([t]) => Math.abs(t - thicknessIn) < 1e-4);
  if (!row) throw new GraphError(`sm.gauge: ${s.name} has no ${thicknessIn} in sheet. Thicknesses: ${s.table.map(([t]) => t).join(', ')} in`);
  const [t, r, bd, minFlange, maxBend] = row.map((v) => v * IN);
  return Object.freeze({
    shop, name: `${s.name}, ${thicknessIn} in`, t, r, bd, ba: 2 * (r + t) - bd, minFlange, maxBend,
    reliefWidth: t, reliefDepth: t + r + s.reliefExtra * IN, gap: s.gap * IN,
    flat: s.flat.map((v) => v * IN), box: s.box * IN, boxHardware: s.boxHardware * IN,
  });
}

// ---------- 2D helpers: shapes as data, so one description draws both the folded panel and its place in the flat

const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const mul = (a, k) => [a[0] * k, a[1] * k];
const v3 = { add: (a, b) => a.map((x, i) => x + b[i]), mul: (a, k) => a.map((x) => x * k), neg: (a) => a.map((x) => -x),
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2] };

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

const EDGES = {  // mold point at param s, outward direction, length
  b: (P) => ({ p: (s) => [s, 0], o: [0, -1], len: P.U }), t: (P) => ({ p: (s) => [s, P.V], o: [0, 1], len: P.U }),
  l: (P) => ({ p: (s) => [0, s], o: [-1, 0], len: P.V }), r: (P) => ({ p: (s) => [P.U, s], o: [1, 0], len: P.V }),
};
// the corner at each end of an edge: [edge, end] of the neighbour that shares it (end 0 = param 0)
const NEIGHBOUR = { b: [['l', 0], ['r', 0]], t: [['l', 1], ['r', 1]], l: [['b', 0], ['t', 0]], r: [['b', 1], ['t', 1]] };

class Part {
  /** hardware: PEM parts go in (SCS caps box flanges lower); round: radius on every free corner of the outline (Che-Wei, Oct 22: fillets wherever possible). */
  constructor(g, name, { hardware = false, round = 3 } = {}) {
    this.g = g; this.name = name; this.hardware = hardware; this.round = round;
    this.panels = new Map(); this.windows = [];
  }

  /** The base: a U x V rectangle (outside sizes). */
  base(U, V) {
    if (this.panels.size) throw new GraphError(`sm part '${this.name}': base() is called once, first`);
    this.panels.set('base', { id: 'base', U, V, cuts: [], kids: [] });
    return this;
  }

  /**
   * A flange `length` high (outside size, from the parent's outer face) off edge `at`, a path like 'base.r' or 'base.r.t'.
   * from / to: where along the edge it runs (default the whole edge). Returns the part; the new panel is `${at}`.
   */
  flange(at, length, { from = null, to = null } = {}) {
    const i = at.lastIndexOf('.'), pid = at.slice(0, i), edge = at.slice(i + 1), P = this.panels.get(pid);
    if (!P) throw new GraphError(`sm part '${this.name}': no panel '${pid}' for flange '${at}'`);
    if (!EDGES[edge]) throw new GraphError(`sm part '${this.name}': edge '${edge}' is not one of b, t, l, r`);
    if (pid !== 'base' && edge === 'b') throw new GraphError(`sm part '${this.name}': '${at}' is the bend of '${pid}', not a free edge`);
    if (this.panels.has(at)) throw new GraphError(`sm part '${this.name}': '${at}' already has a flange`);
    const k = { id: at, parent: pid, edge, L: length, from, to, cuts: [], kids: [] };  // null ends: to the corner, settled in _layout
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

  // ----- layout: sizes, extents, reliefs and both maps for every panel

  _layout() {
    const { g } = this, rt = g.r + g.t, cl = rt + g.t, ext = 2 * g.t;  // cl: corner relief, deep enough that its t round clears the bends
    const base = this.panels.get('base');
    if (!base) throw new GraphError(`sm part '${this.name}': call base(U, V) first`);
    const out = [], bends = [];
    const visit = (P, frame, map) => {
      const cuts = [...P.cuts], kids = [], protect = P.rootBend ? [[[P.rootBend[0], rt], [P.rootBend[1], rt]]] : [];
      const ends = (k) => [k.from ?? 0, k.to ?? EDGES[k.edge](P).len], reach = (k, end) => end ? ends(k)[1] >= EDGES[k.edge](P).len - 1e-6 : ends(k)[0] <= 1e-6;
      const on = (edge, end) => P.kids.find((k) => k.edge === edge && reach(k, end));
      for (const k of P.kids) {
        const E = EDGES[k.edge](P);
        let [f0, f1] = ends(k), [b0, b1] = [f0, f1];
        for (const end of [0, 1]) {
          const s = ends(k)[end], [nEdge, nEnd] = NEIGHBOUR[k.edge][end];
          const atCorner = reach(k, end), closed = atCorner && on(nEdge, nEnd) && !(P.id !== 'base' && nEdge === 'b');
          const sg = end ? -1 : 1;
          if (closed) {  // flanges meet: flats stop t + gap short of the corner, bends r + t + relief, the corner square goes
            if (end) { f1 = s - g.t - g.gap; b1 = s - cl; } else { f0 = s + g.t + g.gap; b0 = s + cl; }
            const c = E.p(s), inU = E.o[0] ? -E.o[0] : 0, inV = E.o[1] ? -E.o[1] : 0;
            const along = [E.o[1] !== 0 ? sg : 0, E.o[0] !== 0 ? sg : 0];  // edge direction, pointing in from the corner
            const a = add(c, add(mul([inU, inV], cl), mul(along, cl))), z = add(c, add(mul([inU, inV], -ext), mul(along, -ext)));  // past the corner, so only its inside corner shows round
            cuts.push(rect(Math.min(z[0], a[0]), Math.min(z[1], a[1]), Math.max(z[0], a[0]), Math.max(z[1], a[1])));
          } else if (!atCorner || (P.id !== 'base' && nEdge === 'b')) {  // ends mid edge (or next to this panel's own bend): a relief slot past it
            const w = g.reliefWidth, at = E.p(s + (end ? w / 2 : -w / 2)), d = rt + g.reliefDepth;  // round ended, from past the edge to its depth
            cuts.push(slot(...add(at, mul(E.o, ext)), ...add(at, mul(E.o, -(d - w / 2))), w / 2));
          }
        }
        // the bend's own strip; its line stays sharp (a round there would eat into the bend)
        const s0 = E.p(b0), s1 = add(E.p(b1), mul(E.o, -rt));
        protect.push([add(E.p(b0), mul(E.o, -rt)), s1]);
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
      const outline = P.id === 'base' ? rect(0, 0, P.U, P.V) : rect(0, rt, P.U, P.V);
      out.push({ P, frame, map, cuts, outline, protect });
      for (const { k, E, f0, f1, b0, b1 } of [...kids, ...wins]) {
        // the flange's frame: v up the parent's inside normal, its inside back over the parent, u from the right hand rule
        const o3 = v3.add(v3.mul(frame.u, E.o[0]), v3.mul(frame.v, E.o[1]));
        const ed = E.p(1), e0 = E.p(0), e2 = [ed[0] - e0[0], ed[1] - e0[1]], e3 = v3.add(v3.mul(frame.u, e2[0]), v3.mul(frame.v, e2[1]));
        const kv = frame.n, kn = v3.neg(o3), ku = v3.cross(kv, kn), fwd = v3.dot(ku, e3) > 0;
        const at = (s) => v3.add(frame.o, v3.add(v3.mul(frame.u, E.p(s)[0]), v3.mul(frame.v, E.p(s)[1])));
        const param = (u) => fwd ? f0 + u : f1 - u;
        const kframe = { o: at(fwd ? f0 : f1), u: ku, v: kv, n: kn };
        const kmap = (pt) => map(add(E.p(param(pt[0])), mul(E.o, pt[1] - g.bd)));
        const K = this.panels.get(k.id) ?? k;
        K.U = f1 - f0; K.V = k.L; K.window = k.window; K.rootBend = fwd ? [b0 - f0, b1 - f0] : [f1 - b1, f1 - b0];
        // the bend: section in the plane across the edge, swept along it
        const nrm = v3.dot(v3.cross(e3, o3), frame.n) > 0 ? e3 : v3.neg(e3);
        bends.push({ id: k.id, P, len: b1 - b0, plane: { origin: at(nrm === e3 ? b0 : b1), xDir: o3, normal: nrm },
          zone: [E.p(b0), E.p(b1), E.o], map, L: k.L });
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
  solid({ origin = [0, 0, 0], u = [1, 0, 0], v = [0, 1, 0], n = [0, 0, 1] } = {}) {
    if (v3.dot(v3.cross(u, v), n) < 0.999) throw new GraphError(`sm part '${this.name}': frame u, v, n must be right handed unit vectors`);
    this._frame = { o: origin, u, v, n };
    const { g } = this, { panels, bends } = this._layout(), k = brepKernel(), rt = g.r + g.t;
    const pieces = panels.map((e) => ({ id: e.P.id, solid: brepExtrude(brepDrawingSketch(this._mold(e), { origin: e.frame.o, xDir: e.frame.u, normal: e.frame.n }), g.t, false) }));
    for (const b of bends) {
      if (b.len <= 1e-6) continue;
      const c = [-rt, rt], m = Math.SQRT1_2;
      const sec = k.draw([-rt, 0]).threePointsArcTo([0, rt], [c[0] + rt * m, c[1] - rt * m]).lineTo([-g.t, rt])
        .threePointsArcTo([-rt, g.t], [c[0] + g.r * m, c[1] - g.r * m]).close();
      pieces.push({ id: `${b.id} bend`, solid: brepExtrude(brepDrawingSketch(sec, b.plane), b.len, false) });
    }
    this._pieces = pieces;
    return pieces.length > 1 ? ops.union(...pieces.map((p) => p.solid)) : pieces[0].solid;
  }

  // ----- the flat pattern

  /** The flat: {drawing, bendLines: [[a, b]], size: [w, h]} in mm, the base's mold corner at the origin. */
  flat() {
    if (!this._frame) this._frame = { o: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] };
    const { g } = this, rt = g.r + g.t, { panels, bends } = this._layout();
    const parts = panels.map((e) => ({ id: e.P.id, d: place(this._mold(e), e.map) }));
    const bendLines = [];
    for (const b of bends) {
      const [a, z, o] = b.zone, off = (x) => [add(a, mul(o, x)), add(z, mul(o, x))];
      const [p0, p1] = off(-rt), [q0, q1] = off(-rt + g.ba);
      if (b.len > 1e-6) parts.push({ id: `${b.id} bend`, d: region([poly([p0, p1, q1, q0])], b.map) });
      bendLines.push(off(-rt + g.ba / 2).map(b.map));
    }
    let d = parts[0].d;
    for (const p of parts.slice(1)) d = d.fuse(p.d);
    const bb = d.boundingBox;
    return { drawing: d, parts, bendLines, size: [bb.width, bb.height], min: [bb.bounds[0][0], bb.bounds[0][1]] };
  }

  /** The flat pattern as DXF (mm): the outline and holes on CUT, bend centre lines on BEND (dashed). */
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
    return rows.map((r) => ({ unit: 'mm', ...r }));
  }
}

// ---------- DXF out: replicad's SVG paths (lines and true arcs) to R12 entities

function toDXF(svgPaths, bendLines) {
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
  for (const [a, b] of bendLines) line(a, b, 'BEND');
  const tables = '0\nSECTION\n2\nTABLES\n0\nTABLE\n2\nLTYPE\n70\n2\n0\nLTYPE\n2\nCONTINUOUS\n70\n0\n3\nSolid line\n72\n65\n73\n0\n40\n0.0\n'
    + '0\nLTYPE\n2\nDASHED\n70\n0\n3\nDashed\n72\n65\n73\n2\n40\n9.0\n49\n6.0\n49\n-3.0\n0\nENDTAB\n'
    + '0\nTABLE\n2\nLAYER\n70\n2\n0\nLAYER\n2\nCUT\n70\n0\n62\n7\n6\nCONTINUOUS\n0\nLAYER\n2\nBEND\n70\n0\n62\n1\n6\nDASHED\n0\nENDTAB\n0\nENDSEC\n';
  return `0\nSECTION\n2\nHEADER\n9\n$INSUNITS\n70\n4\n0\nENDSEC\n${tables}0\nSECTION\n2\nENTITIES\n${ents.join('\n')}\n0\nENDSEC\n0\nEOF\n`;
}

/**
 * The `sm` namespace a cell sees. `checked` is the cell's assertion sink (the shop's rules land there like assert.*),
 * `flats` collects each named part's DXF for export (identical parts by name count up).
 */
export function sheetMetalNamespace(checked = [], flats = []) {
  return Object.freeze({
    gauge, rect, circle, slot, poly,
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
        if (seen) seen.qty += qty; else flats.push({ name, dxf, qty, size: f.size, gauge: g.name });
        return s;
      };
      return p;
    },
  });
}
