// A pattern DXF → piece outlines: an ASTM D6673 / AAMA-style file from CLO, Gerber, Optitex or cadgang's own export, or any
// drawing of closed outlines. The stitch line (layer 14) is taken where there is one, else the cut boundary (layer 1), else
// every layer; segments are chained into closed loops, a loop inside another (a hole, a mark) is dropped, and points on a
// straight run are merged. A cut boundary comes in with no allowance, since it already is the cut line.
// Each piece also takes the grain line (layer 7) and the notches (layer 4) that fall on it.
// ponytail: curves stay as short straight edges (a spline is 8 points per control point); fit Béziers if that ever matters.
import { parseDxf } from './dxf.js';
import { addPiece, origin, addNotch, setPiece, sample } from './softgoods-draft.js';

const UNITS = { 1: 25.4, 2: 304.8, 4: 1, 5: 10, 6: 1000 };   // $INSUNITS → mm; unset is taken as mm

export function outlinesFromDxf(text, deps) {
  const { parts } = parseDxf(text, deps), scale = UNITS[/\$INSUNITS\s*\r?\n\s*70\s*\r?\n\s*(\d+)/.exec(text)?.[1]] ?? 1;
  const layer = parts.find((p) => p.name === '14') || parts.find((p) => p.name === '1'), use = layer ? [layer] : parts;
  const key = (x, y) => `${Math.round(x * 100)},${Math.round(y * 100)}`, segs = [], at = new Map();
  for (const { lines } of use) for (let i = 0; i < lines.length; i += 6) {
    const a = [lines[i] * scale, lines[i + 1] * scale], b = [lines[i + 3] * scale, lines[i + 4] * scale], ka = key(...a), kb = key(...b);
    if (ka === kb) continue; const s = { a, b, ka, kb, used: false }; segs.push(s);
    for (const k of [ka, kb]) (at.get(k) || at.set(k, []).get(k)).push(s);
  }
  const loops = [];
  for (const s0 of segs) {
    if (s0.used) continue; s0.used = true; const ring = [s0.a]; let k = s0.kb, end = s0.b;
    while (k !== s0.ka) { const s = (at.get(k) || []).find((v) => !v.used); if (!s) break; s.used = true; ring.push(end); [k, end] = s.ka === k ? [s.kb, s.b] : [s.ka, s.a]; }
    if (k === s0.ka && ring.length >= 3) loops.push(ring);
  }
  const area = (q) => Math.abs(q.reduce((n, u, i) => { const v = q[(i + 1) % q.length]; return n + u[0] * v[1] - v[0] * u[1]; }, 0)) / 2;
  const inside = ([x, y], q) => { let o = false; for (let i = 0, j = q.length - 1; i < q.length; j = i++) if ((q[i][1] > y) !== (q[j][1] > y) && x < (q[j][0] - q[i][0]) * (y - q[i][1]) / (q[j][1] - q[i][1]) + q[i][0]) o = !o; return o; };
  const outer = loops.filter((q) => area(q) > 1 && !loops.some((r) => r !== q && area(r) > area(q) && inside(q[0], r)));
  // A point within 0.05 mm of the line through its neighbours is on a straight run: dropped.
  const merged = outer.map((q) => { let r = q, again = true; while (again && r.length > 3) { again = false; r = r.filter((p, i) => { const u = r[(i + r.length - 1) % r.length], v = r[(i + 1) % r.length], L = Math.hypot(v[0] - u[0], v[1] - u[1]); const off = L ? Math.abs((v[0] - u[0]) * (u[1] - p[1]) - (u[0] - p[0]) * (v[1] - u[1])) / L : 0; if (off < 0.05 && !again) { again = true; return false; } return true; }); } return r; });
  // A grain line inside a piece gives its angle; a notch is the end of a layer-4 line nearest the piece's outline (within 15 mm).
  const lines = (name) => { const p = parts.find((v) => v.name === name), out = []; if (p) for (let i = 0; i < p.lines.length; i += 6) out.push([[p.lines[i] * scale, p.lines[i + 1] * scale], [p.lines[i + 3] * scale, p.lines[i + 4] * scale]]); return out; };
  const grains = lines('7'), notches = lines('4');
  const pieces = merged.map((q) => {
    const g = grains.find(([a, b]) => inside([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], q)), angle = g ? ((Math.atan2(g[1][1] - g[0][1], g[1][0] - g[0][0]) * 180 / Math.PI) % 180 + 180) % 180 : null;
    const near = (p) => Math.min(...q.map((u, i) => { const v = q[(i + 1) % q.length], dx = v[0] - u[0], dy = v[1] - u[1], t = Math.max(0, Math.min(1, ((p[0] - u[0]) * dx + (p[1] - u[1]) * dy) / (dx * dx + dy * dy || 1))); return Math.hypot(u[0] + t * dx - p[0], u[1] + t * dy - p[1]); }));
    const marks = notches.map(([a, b]) => (near(a) <= near(b) ? a : b)).filter((p) => near(p) < 15);
    return { points: q.map(([x, y]) => ({ x, y })), grain: angle == null ? null : +angle.toFixed(2), notches: marks.map(([x, y]) => ({ x, y })) };
  });
  return { outlines: pieces.map((p) => p.points), pieces, layer: layer?.name ?? null };
}

/** One imported piece added to the document: its outline as addPiece takes it, its grain, a match notch where each notch meets an edge. */
export function importPiece(d, { points, grain, notches = [] }, options = {}) {
  const x0 = Math.min(...points.map((q) => q.x)), y0 = Math.min(...points.map((q) => q.y));
  d = addPiece(d, origin(points), options); const p = d.patterns.at(-1);
  if (grain != null) d = setPiece(d, p.id, { grain });
  for (const n of notches) {
    const at = { x: n.x - x0, y: n.y - y0 }; let best = null;
    for (const s of p.segments) { const [u, v] = sample(p, s), dx = v.x - u.x, dy = v.y - u.y, t = Math.max(0, Math.min(1, ((at.x - u.x) * dx + (at.y - u.y) * dy) / (dx * dx + dy * dy || 1))), e = Math.hypot(u.x + t * dx - at.x, u.y + t * dy - at.y); if (!best || e < best.e) best = { s, t, e }; }
    if (best) d = addNotch(d, p.id, best.s.id, best.t);
  }
  return d;
}
