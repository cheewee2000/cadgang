/**
 * Softgoods for cell programs: pieces cut flat from fabric, sewn edge to edge, and
 * draped onto a body under gravity — the way CLO works a garment, pattern in 2D and
 * the result in 3D, except that here the result is exact B-rep like everything else
 * a cell returns, so it measures, exports and sits in an assembly like a solid does.
 *
 * A piece is a closed outline in its own flat mm coordinates (u right, v up), cut
 * from a fabric. It is placed in 3D (`place`) where it starts, flat, before the
 * drape; seams (`garment.seam`) pull two outline edges together, pins (`pin`) tack a
 * pattern point to a world point (a bar tack to a frame slot), and `make` relaxes
 * the whole garment: gravity, the fabric's stretch, shear and bend, seams, pins,
 * and the body it must not pass through. Each relaxed piece comes back as one
 * B-spline face trimmed to its outline, the compound of them named per piece;
 * each piece's cutting pattern (outline on STITCH, outline plus seam allowance on
 * CUT) joins the DXF export next to the sheet metal flats.
 *
 * The solver is position based dynamics on a grid of `grid` mm over each piece:
 * structural springs along the grid, shear across its diagonals, bend over two
 * cells, a seam or pin as a distance constraint on bilinear attachments, and the
 * body as a signed distance field of its tessellation. It settles, it does not
 * simulate time: the answer is the rest shape, like CLO's "simulate" left running.
 *
 * ponytail: fabric stiffnesses are solver factors (0..1), not measured moduli —
 * move to XPBD compliance from tensile tests when a drape has to match a sample.
 * No self collision, no thickness in the result (faces), no darts or pleats.
 */

import {
  brepKernel, brepAttempt as attempt, trackBrepShape as track, tessellate, brepCompound, setParts, requireSolid,
} from './brep.js';
import { buildMeshDistance } from './mesh.js';
import { GraphError } from './errors.js';
import { toDXF } from './sheetmetal.js';

// weight g/m², thickness mm, stretch/shear/bend solver stiffness 0..1, friction against the body 0..1,
// maxStretch % elongation the fabric takes before it reads as overstrained in the checks
const FABRICS = {
  'cordura-500d': { weight: 250, thickness: 0.6, stretch: 1.0, shear: 0.6, bend: 0.05, friction: 0.5, maxStretch: 3 },
  'nylon-210d': { weight: 90, thickness: 0.25, stretch: 0.95, shear: 0.4, bend: 0.01, friction: 0.35, maxStretch: 5 },
  'spacer-mesh': { weight: 350, thickness: 4, stretch: 0.6, shear: 0.3, bend: 0.2, friction: 0.6, maxStretch: 20 },
  'eva-10mm': { weight: 1200, thickness: 10, stretch: 0.9, shear: 0.8, bend: 0.9, friction: 0.7, maxStretch: 10 },
};

/** A fabric by preset name, or a spec object ({weight, thickness, stretch, shear, bend, friction, maxStretch}) over the cordura defaults. */
export function fabric(spec = 'cordura-500d') {
  if (typeof spec === 'string') {
    if (!FABRICS[spec]) throw new GraphError(`soft.fabric: no fabric '${spec}'. Known: ${Object.keys(FABRICS).join(', ')}`);
    return Object.freeze({ name: spec, ...FABRICS[spec] });
  }
  return Object.freeze({ name: spec.name || 'custom', ...FABRICS['cordura-500d'], ...spec });
}

// the most a pin or tether moves a node per solver iteration, mm: the collision step (once per substep) must get to see every position the cloth passes through
const RAMP = 2;
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(...a) || 1; return mul(a, 1 / l); };

/** Even-odd point in polygon, 2D. */
function inside(poly, x, y) {
  let on = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) on = !on;
  }
  return on;
}
/** Distance from a 2D point to the polygon's outline. */
function outlineDistance(poly, x, y) {
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ax, ay] = poly[j], [bx, by] = poly[i], dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2));
    best = Math.min(best, Math.hypot(x - ax - t * dx, y - ay - t * dy));
  }
  return best;
}

class Piece {
  constructor(name, outline, fab, { grid = 10, allowance = 10 } = {}) {
    if (!Array.isArray(outline) || outline.length < 3) throw new GraphError(`soft.piece('${name}'): the outline needs at least 3 [u, v] points`);
    let area = 0;
    for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) area += outline[j][0] * outline[i][1] - outline[i][0] * outline[j][1];
    if (Math.abs(area) < 1e-6) throw new GraphError(`soft.piece('${name}'): the outline has no area`);
    this.name = name;
    this.outline = (area < 0 ? [...outline].reverse() : outline).map(([u, v]) => [Number(u), Number(v)]);  // counter clockwise
    this.fabric = fab;
    this.grid = grid;
    this.allowance = allowance;
    this.pins = [];
    this.frame = { origin: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0] };
  }

  /** Where the flat piece starts before the drape: its (0, 0) at origin, u and v along those directions. */
  place(origin, u = [1, 0, 0], v = [0, 1, 0]) {
    const U = norm(u), n = norm(cross(U, v)), V = cross(n, U);
    if (!Number.isFinite(V[0]) || Math.hypot(...cross(U, v)) < 1e-9) throw new GraphError(`soft.piece('${this.name}').place: u and v must not be parallel`);
    this.frame = { origin: [...origin], u: U, v: V };
    return this;
  }

  /**
   * Start the piece bent along a 3D polyline instead of flat: flat v runs along the path's length (past its end, on in a
   * straight line), flat u = `at` lies ON the path and u runs across it along `u`. A strap laid over the shoulder starts
   * where it ends up, and the drape only settles it.
   */
  along(path, { u = [1, 0, 0], at = null } = {}) {
    if (!Array.isArray(path) || path.length < 2) throw new GraphError(`soft.piece('${this.name}').along: the path needs at least 2 points`);
    const us = this.outline.map((p) => p[0]), mid = at ?? (Math.min(...us) + Math.max(...us)) / 2, across = norm(u);
    const cum = [0];
    for (let i = 1; i < path.length; i++) cum.push(cum[i - 1] + Math.hypot(...sub(path[i], path[i - 1])));
    this.frame = {
      map: ([fu, fv]) => {
        let i = 1;
        while (i < path.length - 1 && cum[i] < fv) i++;
        const t = norm(sub(path[i], path[i - 1])), base = add(path[i - 1], mul(t, fv - cum[i - 1]));
        const a = norm(sub(across, mul(t, dot(across, t))));
        return add(base, mul(a, fu - mid));
      },
    };
    return this;
  }

  /** Tack pattern point [u, v] to a world point: a bar tack, a rivet, a strap end on its slot. */
  pin([u, v], world) {
    this.pins.push({ at: [u, v], to: [...world] });
    return this;
  }

  /** Outline edge from point i to point j the long way round the outline (j defaults to the next point). */
  edge(i, j = i + 1) {
    const n = this.outline.length;
    const pts = [];
    for (let k = ((i % n) + n) % n; ; k = (k + 1) % n) { pts.push(this.outline[k]); if (k === ((j % n) + n) % n) break; if (pts.length > n) break; }
    return { piece: this, points: pts };
  }

  /** Length of the whole outline in mm. */
  perimeter() {
    let l = 0;
    for (let i = 0; i < this.outline.length; i++) { const a = this.outline[i], b = this.outline[(i + 1) % this.outline.length]; l += Math.hypot(b[0] - a[0], b[1] - a[1]); }
    return l;
  }
}

const polyLength = (pts) => pts.slice(1).reduce((l, p, i) => l + Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]), 0);
/** The point a fraction t along a 2D polyline. */
function along(pts, t) {
  const total = polyLength(pts);
  let want = t * total;
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    if (want <= d || i === pts.length - 1) { const s = d ? Math.max(0, Math.min(1, want / d)) : 0; return [pts[i - 1][0] + s * (pts[i][0] - pts[i - 1][0]), pts[i - 1][1] + s * (pts[i][1] - pts[i - 1][1])]; }
    want -= d;
  }
  return pts[pts.length - 1];
}

/** One piece's grid: node layout in the flat, which nodes carry cloth, and bilinear attachment of a flat point. */
function layoutGrid(piece, base) {
  const us = piece.outline.map((p) => p[0]), vs = piece.outline.map((p) => p[1]), h = piece.grid;
  const u0 = Math.min(...us) - h, u1 = Math.max(...us) + h, v0 = Math.min(...vs) - h, v1 = Math.max(...vs) + h;
  const nu = Math.max(4, Math.ceil((u1 - u0) / h) + 1), nv = Math.max(4, Math.ceil((v1 - v0) / h) + 1);
  const hu = (u1 - u0) / (nu - 1), hv = (v1 - v0) / (nv - 1);
  // a node inside the outline carries cloth; one within a grid step outside is the rim that bilinear attachments and
  // the trim need, carrying only the sliver of cloth between it and the outline (cover 0..1)
  const active = new Uint8Array(nu * nv), cover = new Float64Array(nu * nv);
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nv; j++) {
      const u = u0 + i * hu, v = v0 + j * hv, d = outlineDistance(piece.outline, u, v);
      if (inside(piece.outline, u, v)) { active[i * nv + j] = 1; cover[i * nv + j] = 1; } else if (d <= Math.max(hu, hv) * 1.01) { active[i * nv + j] = 1; cover[i * nv + j] = Math.max(0.05, 1 - d / Math.max(hu, hv)); }
    }
  }
  const at = (i, j) => base + i * nv + j;
  const attach = ([u, v]) => {
    const fi = Math.max(0, Math.min(nu - 1.000001, (u - u0) / hu)), fj = Math.max(0, Math.min(nv - 1.000001, (v - v0) / hv));
    const i = Math.floor(fi), j = Math.floor(fj), s = fi - i, t = fj - j;
    return { nodes: [at(i, j), at(i + 1, j), at(i, j + 1), at(i + 1, j + 1)], w: [(1 - s) * (1 - t), s * (1 - t), (1 - s) * t, s * t] };
  };
  return { piece, base, nu, nv, hu, hv, u0, v0, active, cover, at, attach, flat: (i, j) => [u0 + i * hu, v0 + j * hv] };
}

/** The body as a signed distance (positive outside) of its tessellation. */
function bodyField(body) {
  // 0.5 mm facets: the cloth keeps `clearance` off the body anyway, and a MOLLE frame at 0.2 is a million triangles
  const t = tessellate(requireSolid(body, 'body'), { tolerance: 0.5 });
  const { distance, closest } = buildMeshDistance(t.positions, t.indices);
  return { distance, closest };
}

class Garment {
  constructor(name) { this.name = name; this.pieces = []; this.seams = []; }

  /** A new piece: soft.garment('harness').piece('strap', [[0,0],[60,0],[60,500],[0,500]], soft.fabric('cordura-500d'), {grid: 10, allowance: 10}) */
  piece(name, outline, fab = fabric(), opts) {
    if (this.pieces.some((p) => p.name === name)) throw new GraphError(`soft: two pieces named '${name}'`);
    const p = new Piece(name, outline, fab, opts);
    this.pieces.push(p);
    return p;
  }

  /** Sew edge a to edge b, start to start (flip: true runs b the other way). ease: the length mismatch allowed, a fraction. */
  seam(a, b, { flip = false, ease = 0.03 } = {}) {
    if (!a?.piece || !b?.piece) throw new GraphError('soft.seam needs two edges from piece.edge(i, j)');
    this.seams.push({ a, b, flip, ease });
    return this;
  }

  /**
   * Relax the garment and return the compound of its pieces as trimmed B-spline faces.
   * body: the shape the fabric drapes over (null to hang free). gravity: a direction; g in mm/s²; steps substeps of dt
   * seconds, stopped early once nothing moves faster than `settle` mm/s or after `wall` seconds; clearance mm kept off the body.
   * Records, like assert.*: each seam's length match and the gap it left, each piece's worst stretch, settling, and the
   * closest the cloth comes to the body. A miss is recorded, not thrown: the point of a drape is to look at it.
   */
  make({ body = null, gravity = [0, 0, -1], g = 9810, steps = 6000, iterations = 4, dt = 1 / 1000, clearance = 0.5, settle = 50, wall = 30 } = {}, checked = [], flats = []) {
    if (!this.pieces.length) throw new GraphError(`soft.garment('${this.name}').make: no pieces`);
    const t0 = Date.now();
    const grids = [];
    let count = 0;
    for (const p of this.pieces) { const gr = layoutGrid(p, count); grids.push(gr); count += gr.nu * gr.nv; }
    const x = new Float64Array(count * 3), x0 = new Float64Array(count * 3), vel = new Float64Array(count * 3), invm = new Float64Array(count);
    const fabricOf = new Array(count), thick = new Float64Array(count), cloth = new Uint8Array(count);   // cloth: inside the outline, not the rim
    const cons = [];  // [a, b, rest, k, kind]
    const bf = body ? bodyField(body) : null, field = bf?.distance ?? null;

    for (const gr of grids) {
      const { piece, nu, nv, hu, hv, at, active } = gr, f = piece.fabric, { origin, u: U, v: V } = piece.frame;
      const mass = f.weight * hu * hv * 1e-6 || 1e-3;
      const stiff = (k) => 1 - Math.pow(1 - Math.min(0.999, k), 1 / iterations);
      for (let i = 0; i < nu; i++) {
        for (let j = 0; j < nv; j++) {
          const n = at(i, j), [fu, fv] = gr.flat(i, j), w = piece.frame.map ? piece.frame.map([fu, fv]) : add(origin, add(mul(U, fu), mul(V, fv)));
          x[n * 3] = w[0]; x[n * 3 + 1] = w[1]; x[n * 3 + 2] = w[2];
          invm[n] = active[i * nv + j] ? 1 / (mass * gr.cover[i * nv + j]) : 0;   // a rim node weighs what little cloth it carries, and so follows its neighbours
          cloth[n] = gr.cover[i * nv + j] === 1 ? 1 : 0;
          fabricOf[n] = f; thick[n] = f.thickness / 2 + clearance;
          const link = (i2, j2, rest, k, kind) => {
            if (i2 >= nu || j2 >= nv || !active[i * nv + j] || !active[i2 * nv + j2]) return;
            cons.push([n, at(i2, j2), rest, stiff(k), kind]);
          };
          link(i + 1, j, hu, f.stretch, 's'); link(i, j + 1, hv, f.stretch, 's');
          link(i + 1, j + 1, Math.hypot(hu, hv), f.shear, 'h'); if (i > 0) link(i - 1, j + 1, Math.hypot(hu, hv), f.shear, 'h');
          link(i + 2, j, 2 * hu, f.bend, 'b'); link(i, j + 2, 2 * hv, f.bend, 'b');
        }
      }
    }
    x0.set(x);
    const gridOf = (piece) => grids.find((gr) => gr.piece === piece);

    // seams: paired bilinear attachments every half grid along the shorter edge; pins: an attachment to a fixed point
    const pairs = [];
    for (const s of this.seams) {
      const la = polyLength(s.a.points), lb = polyLength(s.b.points), n = Math.max(2, Math.ceil(Math.min(la, lb) / (Math.min(s.a.piece.grid, s.b.piece.grid) / 2)) + 1);
      const ga = gridOf(s.a.piece), gb = gridOf(s.b.piece);
      if (!ga || !gb) throw new GraphError('soft.seam: an edge belongs to a piece of another garment');
      for (let k = 0; k < n; k++) {
        const t = k / (n - 1);
        pairs.push({ A: ga.attach(along(s.a.points, t)), B: gb.attach(along(s.b.points, s.flip ? 1 - t : t)), seam: s });
      }
      const miss = Math.abs(la - lb) / Math.max(la, lb);
      checked.push({ label: `seam ${s.a.piece.name}/${s.b.piece.name} length match`, ok: miss <= s.ease, value: Number((miss * 100).toFixed(2)), limit: Number((s.ease * 100).toFixed(2)), unit: '%', detail: { a: Number(la.toFixed(2)), b: Number(lb.toFixed(2)) } });
    }
    // a pin also caps every node's distance from it at the flat distance (long range attachment, Kim 2012): springs alone
    // let a long strap creep under gravity however many iterations run; this holds it inextensible from its anchors
    const tethers = [];
    for (const gr of grids) {
      for (const pin of gr.piece.pins) {
        pairs.push({ A: gr.attach(pin.at), to: pin.to });
        for (let i = 0; i < gr.nu; i++) for (let j = 0; j < gr.nv; j++) if (gr.cover[i * gr.nv + j] === 1) { const [fu, fv] = gr.flat(i, j); tethers.push([gr.at(i, j), pin.to, Math.hypot(fu - pin.at[0], fv - pin.at[1])]); }
      }
    }

    const G = mul(norm(gravity), g);
    const project = (A, target, Bw) => {
      // move A's (and B's) corners so the interpolated points meet: a distance constraint on two virtual particles
      let px = 0, py = 0, pz = 0, sum = 0;
      for (let c = 0; c < 4; c++) { const n = A.nodes[c], w = A.w[c]; px += w * x[n * 3]; py += w * x[n * 3 + 1]; pz += w * x[n * 3 + 2]; sum += w * w * invm[n]; }
      let qx, qy, qz;
      if (Bw) { qx = qy = qz = 0; for (let c = 0; c < 4; c++) { const n = Bw.nodes[c], w = Bw.w[c]; qx += w * x[n * 3]; qy += w * x[n * 3 + 1]; qz += w * x[n * 3 + 2]; sum += w * w * invm[n]; } } else { [qx, qy, qz] = target; }
      if (sum === 0) return;
      let dx = px - qx, dy = py - qy, dz = pz - qz;
      const dl = Math.hypot(dx, dy, dz);
      if (dl > RAMP) { const f = RAMP / dl; dx *= f; dy *= f; dz *= f; }   // a far pin pulls the cloth in, it does not teleport it through the body
      dx /= sum; dy /= sum; dz /= sum;
      for (let c = 0; c < 4; c++) { const n = A.nodes[c], s = A.w[c] * invm[n]; x[n * 3] -= s * dx; x[n * 3 + 1] -= s * dy; x[n * 3 + 2] -= s * dz; }
      if (Bw) for (let c = 0; c < 4; c++) { const n = Bw.nodes[c], s = Bw.w[c] * invm[n]; x[n * 3] += s * dx; x[n * 3 + 1] += s * dy; x[n * 3 + 2] += s * dz; }
    };

    const prev = new Float64Array(count * 3);
    // the body distance is the expensive query, so each node keeps its last answer and asks again only once it has
    // moved far enough that it could have reached the body since (a strap mid air asks almost never)
    const known = new Float64Array(count), since = new Float64Array(count).fill(Infinity);   // every node asks on its first step
    let settled = 0, stepsRun = 0, lastSpeed = 0, fastest = -1;
    // 1 ms substeps with few iterations: the stretch a strap keeps under gravity falls with the substep squared, and barely
    // with more iterations (1/300 s and 8: 7%; 1/1000 s and 4: 1.5%, measured on a 400 mm cordura strap between two pins)
    // and never past `wall` seconds of real time: a drape that will not settle must still hand the viewer something
    const deadline = Date.now() + wall * 1000;
    for (let step = 0; step < steps && settled < 20 && (step % 50 || Date.now() < deadline); step++) {
      prev.set(x);
      for (let n = 0; n < count; n++) {
        if (!invm[n]) continue;
        vel[n * 3] = (vel[n * 3] + G[0] * dt) * 0.98; vel[n * 3 + 1] = (vel[n * 3 + 1] + G[1] * dt) * 0.98; vel[n * 3 + 2] = (vel[n * 3 + 2] + G[2] * dt) * 0.98;
        x[n * 3] += vel[n * 3] * dt; x[n * 3 + 1] += vel[n * 3 + 1] * dt; x[n * 3 + 2] += vel[n * 3 + 2] * dt;
      }
      for (let it = 0; it < iterations; it++) {
        for (const [a, b, rest, k] of cons) {
          const dx = x[b * 3] - x[a * 3], dy = x[b * 3 + 1] - x[a * 3 + 1], dz = x[b * 3 + 2] - x[a * 3 + 2];
          const d = Math.hypot(dx, dy, dz); if (d < 1e-12) continue;
          const w = invm[a] + invm[b]; if (!w) continue;
          const s = ((d - rest) / d) * k / w;
          x[a * 3] += dx * s * invm[a]; x[a * 3 + 1] += dy * s * invm[a]; x[a * 3 + 2] += dz * s * invm[a];
          x[b * 3] -= dx * s * invm[b]; x[b * 3 + 1] -= dy * s * invm[b]; x[b * 3 + 2] -= dz * s * invm[b];
        }
        for (const [n, to, max] of tethers) {
          const dx = x[n * 3] - to[0], dy = x[n * 3 + 1] - to[1], dz = x[n * 3 + 2] - to[2], d = Math.hypot(dx, dy, dz);
          if (d > max && d > 1e-9) { const s = (d - Math.min(d - max, RAMP)) / d; x[n * 3] = to[0] + dx * s; x[n * 3 + 1] = to[1] + dy * s; x[n * 3 + 2] = to[2] + dz * s; }
        }
        for (const p of pairs) project(p.A, p.to, p.B);
      }
      // the body: push a node that passed inside back out along the field's gradient, and let it drag (friction)
      let maxMove = 0;
      for (let n = 0; n < count; n++) {
        if (!invm[n]) continue;
        let friction = 0;
        if (field) {
          const px = x[n * 3], py = x[n * 3 + 1], pz = x[n * 3 + 2], want = thick[n];
          since[n] += Math.hypot(px - prev[n * 3], py - prev[n * 3 + 1], pz - prev[n * 3 + 2]);
          // a push only ever follows a fresh query; a resting node re-asks once it has drifted 0.02 mm
          let d = known[n] - since[n], fresh = false;
          if (d < want + 0.5 && since[n] > 0.02) { d = Math.abs(field(px, py, pz)); known[n] = d; since[n] = 0; fresh = true; }
          if (fresh && d < want) {
            // push straight away from the nearest surface point, to the side the node STARTED the step on, not the side
            // the field's sign says: an imported frame's tessellation has faces wound either way, and a flipped sign at
            // a slot's lip would push the cloth into the plate. The contact is dead: the push leaves no velocity to bounce with.
            const cx = bf.closest[0], cy = bf.closest[1], cz = bf.closest[2];
            let gx = px - cx, gy = py - cy, gz = pz - cz, gl = Math.hypot(gx, gy, gz);
            const ox = prev[n * 3] - cx, oy = prev[n * 3 + 1] - cy, oz = prev[n * 3 + 2] - cz;
            if (gl < 1e-6) { gx = ox; gy = oy; gz = oz; gl = Math.hypot(gx, gy, gz) || 1; }
            else if (gx * ox + gy * oy + gz * oz < 0) { gx = -gx; gy = -gy; gz = -gz; }   // crossed the surface this step: back out
            const push = want - d;
            x[n * 3] += (gx / gl) * push; x[n * 3 + 1] += (gy / gl) * push; x[n * 3 + 2] += (gz / gl) * push;
            prev[n * 3] = x[n * 3]; prev[n * 3 + 1] = x[n * 3 + 1]; prev[n * 3 + 2] = x[n * 3 + 2];
            friction = fabricOf[n].friction;
          }
        }
        const mx = x[n * 3] - prev[n * 3], my = x[n * 3 + 1] - prev[n * 3 + 1], mz = x[n * 3 + 2] - prev[n * 3 + 2];
        // the rim is light and flails at edges of the body (a slot's lip): damp it hard, and judge settling on the cloth alone
        const keep = (1 - friction) * (cloth[n] ? 1 : 0.5);
        vel[n * 3] = (mx / dt) * keep; vel[n * 3 + 1] = (my / dt) * keep; vel[n * 3 + 2] = (mz / dt) * keep;
        const mv = cloth[n] ? Math.max(Math.abs(mx), Math.abs(my), Math.abs(mz)) : 0;
        if (mv > maxMove) { maxMove = mv; fastest = n; }
      }
      lastSpeed = maxMove / dt;
      settled = lastSpeed < settle ? settled + 1 : 0;
      stepsRun = step + 1;
    }
    // closest the cloth's mid surface comes to the body at rest, less half its thickness: unsigned, because an imported
    // body's facets are wound either way and the field's sign cannot say inside from outside; the cloth started outside
    // and was kept there step by step, so the gap is what there is to report
    let gap = Infinity;
    if (field) for (let n = 0; n < count; n++) if (cloth[n]) gap = Math.min(gap, Math.abs(field(x[n * 3], x[n * 3 + 1], x[n * 3 + 2])) - fabricOf[n].thickness / 2);
    checked.push({ label: `${this.name} settled`, ok: settled >= 20, value: stepsRun, limit: steps, unit: 'steps', detail: { fastestNodeMmPerS: Number(lastSpeed.toFixed(1)), node: fastest, at: fastest < 0 ? null : [x[fastest * 3], x[fastest * 3 + 1], x[fastest * 3 + 2]].map((v) => Number(v.toFixed(1))), piece: grids.find((gr) => fastest >= gr.base && fastest < gr.base + gr.nu * gr.nv)?.piece.name ?? null } });
    // did each seam close: the widest gap left between its sewn points
    const where = (A) => [0, 1, 2].map((k) => A.nodes.reduce((acc, n, c) => acc + A.w[c] * x[n * 3 + k], 0));
    for (const s of this.seams) {
      const gap = Math.max(...pairs.filter((p) => p.seam === s).map((p) => Math.hypot(...sub(where(p.A), where(p.B)))));
      checked.push({ label: `seam ${s.a.piece.name}/${s.b.piece.name} gap`, ok: gap <= 1, value: Number(gap.toFixed(3)), limit: 1, unit: 'mm', detail: null });
    }
    if (field) checked.push({ label: `${this.name} body clearance`, ok: gap >= 0, value: Number(gap.toFixed(3)), limit: 0, unit: 'mm', detail: { asked: clearance } });   // the cloth's own surface is off the body; the solver aims for `clearance` and lands within a few tenths

    // strain per piece, from the structural springs
    for (const gr of grids) {
      let worst = 0;
      for (const [a, b, rest, , kind] of cons) {
        if (kind !== 's' || a < gr.base || a >= gr.base + gr.nu * gr.nv || gr.cover[a - gr.base] < 1 || gr.cover[b - gr.base] < 1) continue;   // cloth, not the rim
        worst = Math.max(worst, (Math.hypot(x[b * 3] - x[a * 3], x[b * 3 + 1] - x[a * 3 + 1], x[b * 3 + 2] - x[a * 3 + 2]) - rest) / rest);
      }
      checked.push({ label: `${gr.piece.name} stretch`, ok: worst * 100 <= gr.piece.fabric.maxStretch, value: Number((worst * 100).toFixed(2)), limit: gr.piece.fabric.maxStretch, unit: '%', detail: null });
    }

    const wild = checked.filter((c) => c.label.endsWith(' stretch') && c.value > 100).map((c) => c.label.replace(/ stretch$/, ''));
    if (wild.length) {
      throw new GraphError(`soft: '${this.name}' did not drape: ${wild.join(', ')} stretched past 100%. ` +
        'Start the pieces near where they end up (place or along), outside the body, with every pin within reach.');
    }
    // the rim and the ghost nodes beyond it (everything outside the outline) are re-laid as the cloth's straight continuation:
    // each is extrapolated along its row and column from the two nearest cloth nodes, so the surface fit sees a full, calm
    // grid. (Averaging them from their neighbours instead folded the rim back onto the cloth's edge, and the fit rang.)
    for (const gr of grids) {
      const { nu, nv, at, cover } = gr;
      const fixed = new Uint8Array(nu * nv);
      for (let k = 0; k < nu * nv; k++) fixed[k] = cover[k] === 1 ? 1 : 0;
      const laid = new Float64Array(x);
      const walk = (i, j, di, dj) => {
        let a = null, b = null;
        for (let k = 1, ii = i + di, jj = j + dj; ii >= 0 && jj >= 0 && ii < nu && jj < nv; k++, ii += di, jj += dj) {
          if (!fixed[ii * nv + jj]) continue;
          if (!a) a = [k, at(ii, jj)]; else { b = [k, at(ii, jj)]; break; }
        }
        if (!a) return null;
        const [ka, na] = a, nb = b ? b[1] : null, kb = b ? b[0] : null;
        return [0, 1, 2].map((c) => nb === null ? x[na * 3 + c] : x[na * 3 + c] + ((x[na * 3 + c] - x[nb * 3 + c]) * ka) / (kb - ka));
      };
      let left = 0;
      for (let i = 0; i < nu; i++) {
        for (let j = 0; j < nv; j++) {
          if (fixed[i * nv + j]) continue;
          const cands = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([di, dj]) => walk(i, j, di, dj)).filter(Boolean);
          const n = at(i, j);
          if (!cands.length) { left++; continue; }
          for (let c = 0; c < 3; c++) laid[n * 3 + c] = cands.reduce((acc, q) => acc + q[c], 0) / cands.length;
        }
      }
      x.set(laid);
      // corners no row or column of cloth reaches: average what is around them
      for (let pass = 0; pass < 40 && left; pass++) {
        for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
          if (fixed[i * nv + j]) continue;
          const cands = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([di, dj]) => walk(i, j, di, dj)).filter(Boolean);
          if (cands.length) continue;
          let sx = 0, sy = 0, sz = 0, c = 0;
          for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const ii = i + di, jj = j + dj; if (ii < 0 || jj < 0 || ii >= nu || jj >= nv) continue; const m = at(ii, jj); sx += x[m * 3]; sy += x[m * 3 + 1]; sz += x[m * 3 + 2]; c++; }
          const n = at(i, j); x[n * 3] = sx / c; x[n * 3 + 1] = sy / c; x[n * 3 + 2] = sz / c;
        }
      }
    }

    const tSim = Date.now();
    const fitted = grids.map((gr) => fitFace(gr, x));
    for (let k = 0; k < grids.length; k++) checked.push({ label: `${grids[k].piece.name} surface`, ok: fitted[k].fitErr <= grids[k].piece.grid / 2, value: Number(fitted[k].fitErr.toFixed(2)), limit: grids[k].piece.grid / 2, unit: 'mm', detail: { note: 'how far the smooth surface sits from the simulated cloth at its worst' } });
    const faces = fitted.map((f) => f.face);
    const shape = setParts(brepCompound(faces), this.pieces.map((p) => ({ name: p.name, count: 1 })));
    for (const p of this.pieces) {
      const seen = flats.find((f) => f.name === p.name);
      if (seen) seen.qty += 1; else flats.push({ name: p.name, dxf: patternDXF(p), qty: 1, size: patternSize(p), gauge: p.fabric.name, hardware: {} });
    }
    this.timing = { total: Date.now() - t0, sim: tSim - t0, fit: Date.now() - tSim, steps: stepsRun, nodes: count };
    return shape;
  }
}

/** One B-spline surface over a piece's relaxed grid, trimmed to the outline; also how far it sits from the grid. */
function fitFace(gr, x) {
  const rc = brepKernel(), OC = rc.getOC(), { nu, nv, at, piece } = gr;
  return attempt('soft fit', () => {
    const arr = new OC.TColgp_Array2OfPnt_2(1, nu, 1, nv);
    for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) { const n = at(i, j), p = new OC.gp_Pnt_3(x[n * 3], x[n * 3 + 1], x[n * 3 + 2]); arr.SetValue(i + 1, j + 1, p); p.delete(); }
    // The relaxed grid IS the control net of a clamped uniform cubic B-spline surface: it stays inside the net's hull, so it
    // cannot ring however creased the cloth, and its parameters are known (node i sits near its Greville abscissa). The
    // surface smooths the net by less than a grid step; a crease is rounded over about one cell, which is what cloth does.
    // (Fitting a surface THROUGH the nodes instead, at 0.1 mm, rang metres wide on a strap folded over a shoulder.)
    const knots = (count) => {
      const m = count - 2, K = new OC.TColStd_Array1OfReal_2(1, m), M = new OC.TColStd_Array1OfInteger_2(1, m), full = [];
      for (let k = 1; k <= m; k++) { const t = (k - 1) / (m - 1); K.SetValue(k, t); M.SetValue(k, k === 1 || k === m ? 4 : 1); for (let r = 0; r < (k === 1 || k === m ? 4 : 1); r++) full.push(t); }
      const greville = Array.from({ length: count }, (_, i) => (full[i + 1] + full[i + 2] + full[i + 3]) / 3);
      return { K, M, greville };
    };
    const ku = knots(nu), kv = knots(nv);
    const surf = new OC.Geom_BSplineSurface_1(arr, ku.K, kv.K, ku.M, kv.M, 3, 3, false, false);
    arr.delete(); ku.K.delete(); ku.M.delete(); kv.K.delete(); kv.M.delete();
    const hs = new OC.Handle_Geom_Surface_2(surf);
    const h = Math.min(gr.hu, gr.hv);
    const P = new OC.gp_Pnt_1(), dU = new OC.gp_Vec_1(), dV = new OC.gp_Vec_1();
    const node = (i, j) => { const n = at(i, j); return [x[n * 3], x[n * 3 + 1], x[n * 3 + 2]]; };
    const U = ku.greville, V = kv.greville;
    let fitErr = 0;
    for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) { if (gr.cover[i * nv + j] !== 1) continue; const q = surf.Value(U[i], V[j]), m = node(i, j); fitErr = Math.max(fitErr, Math.hypot(q.X() - m[0], q.Y() - m[1], q.Z() - m[2])); }
    const lerp = (par, f) => { const i = Math.max(0, Math.min(par.length - 2, Math.floor(f))), t = f - i; return par[i] + (par[i + 1] - par[i]) * Math.max(0, Math.min(1, t)); };
    const invert = ([fu, fv]) => {
      const a = gr.attach([fu, fv]);
      const tgt = [0, 1, 2].map((k) => a.nodes.reduce((s, n, c) => s + a.w[c] * x[n * 3 + k], 0));
      const u0 = lerp(U, (fu - gr.u0) / gr.hu), v0 = lerp(V, (fv - gr.v0) / gr.hv);
      let u = u0, v = v0;
      for (let it = 0; it < 20; it++) {
        surf.D1(u, v, P, dU, dV);
        const r = [tgt[0] - P.X(), tgt[1] - P.Y(), tgt[2] - P.Z()], su = [dU.X(), dU.Y(), dU.Z()], sv = [dV.X(), dV.Y(), dV.Z()];
        const a11 = dot(su, su), a12 = dot(su, sv), a22 = dot(sv, sv), b1 = dot(su, r), b2 = dot(sv, r), det = a11 * a22 - a12 * a12 || 1e-12;
        const du = (b1 * a22 - b2 * a12) / det, dv = (a11 * b2 - a12 * b1) / det;
        u = Math.max(0, Math.min(1, u + du)); v = Math.max(0, Math.min(1, v + dv));
        if (Math.abs(du) < 1e-10 && Math.abs(dv) < 1e-10) break;
      }
      // Newton that ran off (a fold, a clamp at the border) is worse than the chord estimate: keep the estimate then
      const q = surf.Value(u, v);
      if (Math.hypot(tgt[0] - q.X(), tgt[1] - q.Y(), tgt[2] - q.Z()) > h / 4) return [u0, v0];
      return [u, v];
    };
    // Trim: each outline segment becomes an edge whose 3D curve is fitted through points SAMPLED ON THE SURFACE every
    // grid step; the wire healer then derives the parameter curves by projection. (Building the edges from 2D curves and
    // asking the kernel to rebuild the 3D ones from them gave curves 1e16 mm long on a strap over a shoulder.)
    const mw = new OC.BRepBuilderAPI_MakeWire_1();
    const n = piece.outline.length;
    for (let k = 0; k < n; k++) {
      const a = piece.outline[k], b = piece.outline[(k + 1) % n], len = Math.hypot(b[0] - a[0], b[1] - a[1]), m = Math.max(2, Math.ceil(len / h) + 1);
      const a1 = new OC.TColgp_Array1OfPnt_2(1, m);
      for (let s = 0; s < m; s++) {
        const [u, v] = invert([a[0] + ((b[0] - a[0]) * s) / (m - 1), a[1] + ((b[1] - a[1]) * s) / (m - 1)]);
        const q = surf.Value(u, v); a1.SetValue(s + 1, q);
      }
      // the samples are the CONTROL points of a clamped cubic (a curve fitted through them rang metres wide on a fold)
      const deg = Math.min(3, m - 1), kn = m - deg + 1, K = new OC.TColStd_Array1OfReal_2(1, kn), M = new OC.TColStd_Array1OfInteger_2(1, kn);
      for (let k = 1; k <= kn; k++) { K.SetValue(k, (k - 1) / (kn - 1)); M.SetValue(k, k === 1 || k === kn ? deg + 1 : 1); }
      const curve = new OC.Geom_BSplineCurve_1(a1, K, M, deg, false);
      mw.Add_1(new OC.BRepBuilderAPI_MakeEdge_24(new OC.Handle_Geom_Curve_2(curve)).Edge());
      a1.delete(); K.delete(); M.delete();
    }
    const wire = mw.Wire();
    const rough = new OC.BRepBuilderAPI_MakeFace_21(hs, wire, true);
    if (!rough.IsDone()) throw new GraphError(`soft: could not trim '${piece.name}' to its outline`);
    const sfw = new OC.ShapeFix_Wire_2(wire, rough.Face(), 0.02);
    sfw.Perform();   // adds the pcurves (projection onto the surface), orders and closes the wire
    const mf = new OC.BRepBuilderAPI_MakeFace_21(hs, sfw.Wire(), true);
    if (!mf.IsDone()) throw new GraphError(`soft: could not trim '${piece.name}' to its outline`);
    const face = mf.Face();
    P.delete(); dU.delete(); dV.delete();
    return { face: track(rc.cast(face)), fitErr };
  });
}

/** The cutting pattern: outline on STITCH, outline offset by the seam allowance on CUT. */
function patternDXF(piece) {
  const rc = brepKernel();
  const [p0, ...rest] = piece.outline;
  let d = rc.draw(p0);
  for (const p of rest) d = d.lineTo(p);
  const outline = d.close();
  const cut = piece.allowance > 0 ? outline.offset(piece.allowance) : outline;
  const stitch = piece.outline.map((p, i) => Object.assign([p, piece.outline[(i + 1) % piece.outline.length]], { layer: 'STITCH' }));
  return toDXF(cut.toSVGPaths(), stitch);
}
function patternSize(piece) {
  const us = piece.outline.map((p) => p[0]), vs = piece.outline.map((p) => p[1]), a = 2 * piece.allowance;
  return [Math.max(...us) - Math.min(...us) + a, Math.max(...vs) - Math.min(...vs) + a];
}

/** The ellipse with semi-axes a and 0.72 a whose perimeter is `circumference` (Ramanujan). */
function ellipseFor(circumference, ratio = 0.72) {
  const per = (a) => { const b = ratio * a; return Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b))); };
  const a = circumference / per(1);
  return [a, ratio * a];
}

/**
 * A torso to drape on: lofted ellipses at hip (z 0), waist, chest and shoulder, closed over the top,
 * standing up z, front toward -y, centred on x. Circumferences in mm (defaults near a men's M).
 */
export function avatar({ chest = 1000, waist = 860, hip = 980, torso = 480 } = {}) {
  const rc = brepKernel();
  return attempt('soft avatar', () => {
    const sec = (c, z, ratio) => { const [a, b] = ellipseFor(c, ratio); return rc.drawEllipse(a, b).sketchOnPlane('XY', z); };
    const [ca] = ellipseFor(chest);
    const solid = sec(hip, 0, 0.72).loftWith([
      sec(waist, torso * 0.35, 0.72), sec(chest, torso * 0.75, 0.72), sec(chest * 0.92, torso * 0.92, 0.5),
      rc.drawEllipse(ca * 0.45, ca * 0.3).sketchOnPlane('XY', torso * 1.08),
    ], { ruled: false });
    return track(solid);
  });
}

/** The `soft` namespace a cell sees. `checked` is the cell's assertion sink, `flats` collects each piece's pattern for the DXF export. */
export function softNamespace(checked = [], flats = []) {
  return Object.freeze({
    fabric, avatar, fabrics: Object.freeze(Object.keys(FABRICS)),
    /** A new garment: soft.garment('harness') then .piece(...), .seam(...), .make({body}) */
    garment: (name = 'garment') => {
      const gmt = new Garment(name);
      const make = gmt.make.bind(gmt);
      gmt.make = (opts) => make(opts, checked, flats);
      return gmt;
    },
  });
}
