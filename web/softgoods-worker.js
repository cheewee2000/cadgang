// Incremental XPBD cloth preview. Pattern meshes and manufacturing data remain
// authoritative outside this worker. Current scope: gravity, anisotropic in-plane
// stretch, seam and fixed attachment constraints, with per-vertex strain diagnostics. Body pressure requires a collision body and is reported unavailable until one is supplied.

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
  // Server-resolved seam pairs are bilinear boundary attachments; expand each into
  // a four-point XPBD coincidence constraint so ease/gather correspondence is exact.
  for (const s of input.seams) { const A = pieces.find((p) => p.id === s.a.pattern), B = pieces.find((p) => p.id === s.b.pattern); if (!A || !B) continue; for (const pair of s.pairs || []) constraints.push({ av: pair.a.vertices.map(i => A.off + i), aw: pair.a.weights, bv: pair.b.vertices.map(i => B.off + i), bw: pair.b.weights, alpha: Number(s.seamCompliance ?? 1e-9), lambda: 0, kind: 'seam-pair' }); }
  state = { input, pieces, x, prev, inv, constraints, velocities: new Float64Array(total * 3), pressure: new Float32Array(total), running: false, step: 0, collision: input.collisionBody ? 'avatar' : 'none', pressureAvailable: !!input.collisionBody };
}

function project(c, dt) {
  const { x, inv } = state;
  if (c.kind === 'seam-pair') {
    const sample = (ids, weights) => ids.reduce((p, id, i) => { const q = V(x, id); return [p[0] + q[0] * weights[i], p[1] + q[1] * weights[i], p[2] + q[2] * weights[i]]; }, [0, 0, 0]);
    const pa = sample(c.av, c.aw), pb = sample(c.bv, c.bw), d = [pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]], len = Math.hypot(...d); if (len < 1e-12) return;
    const wa = c.av.reduce((n,id,i)=>n+c.aw[i]**2*inv[id],0), wb = c.bv.reduce((n,id,i)=>n+c.bw[i]**2*inv[id],0), alpha=c.alpha/(dt*dt), dl=(-len-alpha*c.lambda)/(wa+wb+alpha), q=dl/len; c.lambda+=dl;
    c.av.forEach((id,i)=>set(x,id,V(x,id).map((v,k)=>v+d[k]*q*c.aw[i]*inv[id]))); c.bv.forEach((id,i)=>set(x,id,V(x,id).map((v,k)=>v-d[k]*q*c.bw[i]*inv[id]))); return;
  }
  const pa = V(x, c.a);
  if (c.target) { const dx = pa[0] - c.target[0], dy = pa[1] - c.target[1], dz = pa[2] - c.target[2], len = Math.hypot(dx, dy, dz); if (len < 1e-12) return; const alpha = c.alpha / (dt * dt), dl = (-len - alpha * c.lambda) / (inv[c.a] + alpha); c.lambda += dl; set(x, c.a, [pa[0] + dx / len * dl * inv[c.a], pa[1] + dy / len * dl * inv[c.a], pa[2] + dz / len * dl * inv[c.a]]); return; }
  const pb = V(x, c.b), dx = pa[0] - pb[0], dy = pa[1] - pb[1], dz = pa[2] - pb[2], len = Math.hypot(dx, dy, dz); if (len < 1e-12) return; const alpha = c.alpha / (dt * dt), dl = (-(len - c.rest) - alpha * c.lambda) / (inv[c.a] + inv[c.b] + alpha); c.lambda += dl; const q = dl / len; set(x, c.a, [pa[0] + dx * q * inv[c.a], pa[1] + dy * q * inv[c.a], pa[2] + dz * q * inv[c.a]]); set(x, c.b, [pb[0] - dx * q * inv[c.b], pb[1] - dy * q * inv[c.b], pb[2] - dz * q * inv[c.b]]);
}
function collideAvatar(dt) {
  const b=state.input.collisionBody;if(!b)return;const rx=b.chest/(2*Math.PI),ry=b.depth/2,rz=b.height*.31,cz=b.centreZ;
  state.pressure.fill(0);
  for(let i=0;i<state.inv.length;i++){let px=state.x[i*3]/rx,py=state.x[i*3+1]/ry,pz=(state.x[i*3+2]-cz)/rz,q=Math.hypot(px,py,pz);if(q>=1||q<1e-9)continue;const penetration=(1-q)*Math.min(rx,ry,rz),scale=1/q;state.x[i*3]*=scale;state.x[i*3+1]*=scale;state.x[i*3+2]=cz+(state.x[i*3+2]-cz)*scale;state.pressure[i]=penetration/(dt*dt);}
}
function tick() {
  if (!state?.running) return; const dt = 1 / 120, { x, prev, velocities: v } = state; prev.set(x);
  for (let i = 0; i < state.inv.length; i++) { v[i * 3] *= .995; v[i * 3 + 1] *= .995; v[i * 3 + 2] = (v[i * 3 + 2] - 9810 * dt) * .995; x[i * 3] += v[i * 3] * dt; x[i * 3 + 1] += v[i * 3 + 1] * dt; x[i * 3 + 2] += v[i * 3 + 2] * dt; }
  for (const c of state.constraints) c.lambda = 0; for (let k = 0; k < 8; k++) { for (const c of state.constraints) project(c, dt); collideAvatar(dt); }
  for (let i = 0; i < state.inv.length; i++) { v[i * 3] = (x[i * 3] - prev[i * 3]) / dt; v[i * 3 + 1] = (x[i * 3 + 1] - prev[i * 3 + 1]) / dt; v[i * 3 + 2] = (x[i * 3 + 2] - prev[i * 3 + 2]) / dt; }
  state.step++; if (state.step % 2 === 0) send();
}
function send() {
  const positions = Float32Array.from(state.x), strain = new Float32Array(state.inv.length), pressure = Float32Array.from(state.pressure), count = new Uint16Array(state.inv.length);
  for (const c of state.constraints) {
    if (c.kind !== 'fabric' || c.target || !(c.rest > 0)) continue;
    const a = V(state.x, c.a), b = V(state.x, c.b), e = (Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) - c.rest) / c.rest;
    strain[c.a] += e; strain[c.b] += e; count[c.a]++; count[c.b]++;
  }
  let minStrain = Infinity, maxStrain = -Infinity, maxPressure = 0;
  for (let i = 0; i < strain.length; i++) { strain[i] = count[i] ? strain[i] / count[i] : 0; minStrain = Math.min(minStrain, strain[i]); maxStrain = Math.max(maxStrain, strain[i]); maxPressure=Math.max(maxPressure,pressure[i]); }
  postMessage({ type: 'frame', step: state.step, collision: state.collision, diagnostics: { strain: { unit: 'ratio', min: minStrain, max: maxStrain }, pressure: { available: state.pressureAvailable, unit: 'solver', min: 0, max: maxPressure, reason: state.pressureAvailable ? null : 'No collision body is present in this preview' } }, positions, strain, pressure, pieces: state.pieces.map((p) => ({ id: p.id, off: p.off, count: p.uv.length / 2, triangles: p.triangles })) }, [positions.buffer, strain.buffer, pressure.buffer]);
}
onmessage = (e) => { const m = e.data; if (m.type === 'init') { initialize(m.input); send(); } else if (m.type === 'run') { state.running = true; clearInterval(timer); timer = setInterval(tick, 1000 / 60); } else if (m.type === 'pause') state.running = false; else if (m.type === 'reset') { initialize(state.input); send(); } };
