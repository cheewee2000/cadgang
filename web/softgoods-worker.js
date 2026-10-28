// Incremental XPBD cloth preview. Pattern meshes and manufacturing data remain
// authoritative outside this worker. Current scope: gravity, anisotropic in-plane
// stretch, seam and fixed attachment constraints. No body/self collision yet.

let state = null, timer = null;
const V = (a, i) => [a[i * 3], a[i * 3 + 1], a[i * 3 + 2]];
const set = (a, i, p) => { a[i * 3] = p[0]; a[i * 3 + 1] = p[1]; a[i * 3 + 2] = p[2]; };
const transform = (u, v, a = {}) => { const r = (a.rotation || [0, 0, 0]).map((x) => x * Math.PI / 180), c = Math.cos(r[2]), s = Math.sin(r[2]), p = a.position || [0, 0, 0]; return [p[0] + u * c - v * s, p[1] + u * s + v * c, p[2]]; };

function initialize(input) {
  const arrangements = new Map(input.arrangement.map((a) => [a.pattern, a])), patterns = new Map(input.patterns.map((p) => [p.id, p]));
  let total = 0; const pieces = [];
  for (const m of input.meshes) { const off = total; total += m.uv.length / 2; pieces.push({ ...m, off }); }
  const x = new Float64Array(total * 3), prev = new Float64Array(total * 3), inv = new Float64Array(total).fill(1), constraints = [], pieceOf = new Map();
  for (const p of pieces) {
    const ar = arrangements.get(p.id) || {}, spec = patterns.get(p.id) || {}, grain = Number(spec.grain?.angle ?? 90) * Math.PI / 180, gx = Math.cos(grain), gy = Math.sin(grain), mat = input.materials?.[spec.material] || {};
    for (let i = 0; i < p.uv.length / 2; i++) { const q = transform(p.uv[i * 2], p.uv[i * 2 + 1], ar); set(x, p.off + i, q); pieceOf.set(p.off + i, p.id); }
    for (let i = 0; i < p.edges.length; i += 2) { const a = p.edges[i], b = p.edges[i + 1], du = p.uv[b * 2] - p.uv[a * 2], dv = p.uv[b * 2 + 1] - p.uv[a * 2 + 1], l = Math.hypot(du, dv), along = Math.abs((du * gx + dv * gy) / (l || 1)); const warp = Number(mat.warpCompliance ?? 2e-7), weft = Number(mat.weftCompliance ?? 5e-7), bias = Number(mat.biasCompliance ?? 2e-6), alpha = along ** 4 * warp + (1 - along) ** 4 * weft + 2 * along * (1 - along) * bias; constraints.push({ a: p.off + a, b: p.off + b, rest: l, alpha, lambda: 0, kind: 'fabric' }); }
  }
  prev.set(x);
  // Attachments are fixed world points, located by nearest UV vertex for this first worker slice.
  for (const a of input.attachments || []) { const p = pieces.find((q) => q.id === a.pattern); if (!p) continue; let best = 0, d = Infinity; for (let i = 0; i < p.uv.length / 2; i++) { const q = Math.hypot(p.uv[i * 2] - a.at[0], p.uv[i * 2 + 1] - a.at[1]); if (q < d) { d = q; best = i; } } constraints.push({ a: p.off + best, target: a.to, alpha: 0, lambda: 0, kind: 'attachment' }); }
  // Seam segments resolve to their sampled boundary vertex chains.
  for (const s of input.seams) { const A = pieces.find((p) => p.id === s.a.pattern), B = pieces.find((p) => p.id === s.b.pattern); if (!A || !B) continue; let aa = A.segmentVertices[s.a.segment] || [], bb = B.segmentVertices[s.b.segment] || []; if (s.flip !== false) bb = [...bb].reverse(); const n = Math.max(2, Math.min(aa.length, bb.length)); for (let i = 0; i < n; i++) constraints.push({ a: A.off + aa[Math.round(i * (aa.length - 1) / (n - 1))], b: B.off + bb[Math.round(i * (bb.length - 1) / (n - 1))], rest: 0, alpha: Number(s.seamCompliance ?? 1e-9), lambda: 0, kind: 'seam' }); }
  state = { input, pieces, x, prev, inv, constraints, velocities: new Float64Array(total * 3), running: false, step: 0, collision: 'none' };
}

function project(c, dt) {
  const { x, inv } = state, pa = V(x, c.a);
  if (c.target) { const dx = pa[0] - c.target[0], dy = pa[1] - c.target[1], dz = pa[2] - c.target[2], len = Math.hypot(dx, dy, dz); if (len < 1e-12) return; const alpha = c.alpha / (dt * dt), dl = (-len - alpha * c.lambda) / (inv[c.a] + alpha); c.lambda += dl; set(x, c.a, [pa[0] + dx / len * dl * inv[c.a], pa[1] + dy / len * dl * inv[c.a], pa[2] + dz / len * dl * inv[c.a]]); return; }
  const pb = V(x, c.b), dx = pa[0] - pb[0], dy = pa[1] - pb[1], dz = pa[2] - pb[2], len = Math.hypot(dx, dy, dz); if (len < 1e-12) return; const alpha = c.alpha / (dt * dt), dl = (-(len - c.rest) - alpha * c.lambda) / (inv[c.a] + inv[c.b] + alpha); c.lambda += dl; const q = dl / len; set(x, c.a, [pa[0] + dx * q * inv[c.a], pa[1] + dy * q * inv[c.a], pa[2] + dz * q * inv[c.a]]); set(x, c.b, [pb[0] - dx * q * inv[c.b], pb[1] - dy * q * inv[c.b], pb[2] - dz * q * inv[c.b]]);
}
function tick() {
  if (!state?.running) return; const dt = 1 / 120, { x, prev, velocities: v } = state; prev.set(x);
  for (let i = 0; i < state.inv.length; i++) { v[i * 3] *= .995; v[i * 3 + 1] *= .995; v[i * 3 + 2] = (v[i * 3 + 2] - 9810 * dt) * .995; x[i * 3] += v[i * 3] * dt; x[i * 3 + 1] += v[i * 3 + 1] * dt; x[i * 3 + 2] += v[i * 3 + 2] * dt; }
  for (const c of state.constraints) c.lambda = 0; for (let k = 0; k < 8; k++) for (const c of state.constraints) project(c, dt);
  for (let i = 0; i < state.inv.length; i++) { v[i * 3] = (x[i * 3] - prev[i * 3]) / dt; v[i * 3 + 1] = (x[i * 3 + 1] - prev[i * 3 + 1]) / dt; v[i * 3 + 2] = (x[i * 3 + 2] - prev[i * 3 + 2]) / dt; }
  state.step++; if (state.step % 2 === 0) send();
}
function send() { const positions = Float32Array.from(state.x); postMessage({ type: 'frame', step: state.step, collision: state.collision, positions, pieces: state.pieces.map((p) => ({ id: p.id, off: p.off, count: p.uv.length / 2, triangles: p.triangles })) }, [positions.buffer]); }
onmessage = (e) => { const m = e.data; if (m.type === 'init') { initialize(m.input); send(); } else if (m.type === 'run') { state.running = true; clearInterval(timer); timer = setInterval(tick, 1000 / 60); } else if (m.type === 'pause') state.running = false; else if (m.type === 'reset') { initialize(state.input); send(); } };
