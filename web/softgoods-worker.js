// Incremental XPBD cloth preview. Pattern meshes and manufacturing data remain
// authoritative outside this worker. Current scope: gravity, anisotropic in-plane
// stretch, seam and fixed attachment constraints, with per-vertex strain diagnostics. Body pressure requires a collision body and is reported unavailable until one is supplied.
// Units: mm, g, s. A force is g·mm/s² (1e-6 N), so a pressure is g/(mm·s²), which is the pascal.

let state = null, timer = null;
const V = (a, i) => [a[i * 3], a[i * 3 + 1], a[i * 3 + 2]];
const set = (a, i, p) => { a[i * 3] = p[0]; a[i * 3 + 1] = p[1]; a[i * 3 + 2] = p[2]; };
// An arrangement turns a flat piece about x, then y, then z (degrees) and moves it: [90,0,0] stands it up facing -y.
// src/core/softgoods-arrange.js centres pieces with the same convention.
const transform = (u, v, a = {}) => { const [rx, ry, rz] = (a.rotation || [0, 0, 0]).map((x) => x * Math.PI / 180), p = a.position || [0, 0, 0]; let x = u, y = v * Math.cos(rx), z = v * Math.sin(rx); [x, z] = [x * Math.cos(ry) + z * Math.sin(ry), -x * Math.sin(ry) + z * Math.cos(ry)]; [x, y] = [x * Math.cos(rz) - y * Math.sin(rz), x * Math.sin(rz) + y * Math.cos(rz)]; return [p[0] + x, p[1] + y, p[2] + z]; };

function initialize(input) {
  const arrangements = new Map(input.arrangement.map((a) => [a.pattern, a])), patterns = new Map(input.patterns.map((p) => [p.id, p]));
  let total = 0; const pieces = [];
  for (const m of input.meshes) { const off = total; total += m.uv.length / 2; pieces.push({ ...m, off }); }
  const x = new Float64Array(total * 3), prev = new Float64Array(total * 3), inv = new Float64Array(total).fill(1), radius = new Float64Array(total), area = new Float64Array(total), density = new Float64Array(total), friction = new Float64Array(total), constraints = [], excluded = new Set(), pieceOf = new Map(), materialAt = new Array(total);
  for (const p of pieces) {
    const ar = arrangements.get(p.id) || {}, spec = patterns.get(p.id) || {}, grain = Number(spec.grain?.angle ?? 90) * Math.PI / 180, gx = Math.cos(grain), gy = Math.sin(grain), mat = input.materials?.[spec.material] || {};
    // A vertex carries a third of every triangle on it: its mass is the fabric's areal density (g/m²) over that area.
    for (let i = 0; i < p.triangles.length; i += 3) { const [a, b, c] = [0, 1, 2].map((k) => p.triangles[i + k]), third = Math.abs((p.uv[b * 2] - p.uv[a * 2]) * (p.uv[c * 2 + 1] - p.uv[a * 2 + 1]) - (p.uv[b * 2 + 1] - p.uv[a * 2 + 1]) * (p.uv[c * 2] - p.uv[a * 2])) / 6; area[p.off + a] += third; area[p.off + b] += third; area[p.off + c] += third; }
    for (let i = 0; i < p.uv.length / 2; i++) { materialAt[p.off+i]=mat; radius[p.off+i]=Number(mat.thickness||mat.thicknessMm||0.6)/2; density[p.off+i]=Number(mat.arealDensity??mat.weight??mat.weightGsm??250); friction[p.off+i]=Math.max(0,Math.min(1,Number(mat.friction??0.5))); inv[p.off+i]=1/Math.max(1e-9,density[p.off+i]*Math.max(area[p.off+i],1)*1e-6); const q = transform(p.uv[i * 2], p.uv[i * 2 + 1], ar); set(x, p.off + i, q); pieceOf.set(p.off + i, p.id); }
    for (let i = 0; i < p.edges.length; i += 2) { const a = p.edges[i], b = p.edges[i + 1], du = p.uv[b * 2] - p.uv[a * 2], dv = p.uv[b * 2 + 1] - p.uv[a * 2 + 1], l = Math.hypot(du, dv), along = Math.abs((du * gx + dv * gy) / (l || 1)); const measuredWarp=Number(mat.tensile?.warp),measuredWeft=Number(mat.tensile?.weft),measuredShear=Number(mat.shearRigidity); const warp = Number(mat.warpCompliance ?? (measuredWarp>0?1/(measuredWarp*1e6):2e-7)), weft = Number(mat.weftCompliance ?? (measuredWeft>0?1/(measuredWeft*1e6):5e-7)), bias = Number(mat.biasCompliance ?? (measuredShear>0?1/(measuredShear*1e6):2e-6)), alpha = along ** 4 * warp + (1 - along) ** 4 * weft + 2 * along * (1 - along) * bias; constraints.push({ a: p.off + a, b: p.off + b, rest: l, alpha, lambda: 0, kind: 'fabric' }); excluded.add(`${Math.min(p.off+a,p.off+b)}:${Math.max(p.off+a,p.off+b)}`); }
  }
  prev.set(x);
  // Attachments are fixed world points, located by nearest UV vertex for this first worker slice.
  for (const a of input.attachments || []) { const p = pieces.find((q) => q.id === a.pattern); if (!p) continue; let best = 0, d = Infinity; for (let i = 0; i < p.uv.length / 2; i++) { const q = Math.hypot(p.uv[i * 2] - a.at[0], p.uv[i * 2 + 1] - a.at[1]); if (q < d) { d = q; best = i; } } constraints.push({ a: p.off + best, target: a.to, alpha: 0, lambda: 0, kind: 'attachment' }); }
  // Server-resolved seam pairs are bilinear boundary attachments; expand each into
  // a four-point XPBD coincidence constraint so ease/gather correspondence is exact.
  for (const s of input.seams) { const A = pieces.find((p) => p.id === s.a.pattern), B = pieces.find((p) => p.id === s.b.pattern); if (!A || !B) continue; for (const pair of s.pairs || []) constraints.push({ av: pair.a.vertices.map(i => A.off + i), aw: pair.a.weights, bv: pair.b.vertices.map(i => B.off + i), bw: pair.b.weights, alpha: Number(s.seamCompliance ?? 1e-9), lambda: 0, kind: 'seam-pair' }); }
  state = { input, pieces, x, prev, inv, radius, area, density, friction, push: new Float64Array(total), contact: new Float64Array(total), materialAt, constraints, excluded, velocities: new Float64Array(total * 3), pressure: new Float32Array(total), running: false, step: 0, collision: input.collisionBody ? 'avatar+self' : 'self', pressureAvailable: !!input.collisionBody };
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
function collideSelf(){const {x,inv,radius,excluded}=state,cell=Math.max(...radius)*2;if(!(cell>0))return;const bins=new Map(),key=(a,b,c)=>`${a},${b},${c}`;for(let i=0;i<inv.length;i++){const k=key(Math.floor(x[i*3]/cell),Math.floor(x[i*3+1]/cell),Math.floor(x[i*3+2]/cell)),b=bins.get(k)||[];b.push(i);bins.set(k,b)}for(const [k,aa] of bins){const q=k.split(',').map(Number);for(let ox=-1;ox<=1;ox++)for(let oy=-1;oy<=1;oy++)for(let oz=-1;oz<=1;oz++){const kk=key(q[0]+ox,q[1]+oy,q[2]+oz);if(kk<k||!bins.has(kk))continue;for(const a of aa)for(const b of bins.get(kk)){if(k===kk&&a>=b)continue;if(excluded.has(`${Math.min(a,b)}:${Math.max(a,b)}`))continue;let dx=x[b*3]-x[a*3],dy=x[b*3+1]-x[a*3+1],dz=x[b*3+2]-x[a*3+2],d=Math.hypot(dx,dy,dz),want=radius[a]+radius[b];if(d>=want)continue;if(d<1e-9){dx=1;dy=0;dz=0;d=1}const c=(want-(d===1?0:d))/(d*(inv[a]+inv[b]));x[a*3]-=dx*c*inv[a];x[a*3+1]-=dy*c*inv[a];x[a*3+2]-=dz*c*inv[a];x[b*3]+=dx*c*inv[b];x[b*3+1]+=dy*c*inv[b];x[b*3+2]+=dz*c*inv[b]}}}}
// The body is a few ellipsoids and capsules (src/core/softgoods-arrange.js avatarBody) standing on a floor at z = 0.
// A vertex inside one is put back on its surface; how far it was pushed is the contact force, and cloth in contact drags.
function collideAvatar() {
  const b = state.input.collisionBody; if (!b) return; const { x, prev, radius, push, friction } = state;
  for (let i = 0; i < state.inv.length; i++) {
    const p = [x[i * 3], x[i * 3 + 1], x[i * 3 + 2]]; let n = null, depth = 0;
    for (const s of b.shapes || []) {
      if (s.type === 'ellipsoid') {
        const r = s.r.map((v) => v + radius[i]), d = [0, 1, 2].map((k) => (p[k] - s.c[k]) / r[k]), q = Math.hypot(...d); if (q >= 1 || q < 1e-9) continue;
        // Out along the surface normal at the point the centre ray meets: the gradient of the ellipsoid's own equation.
        const g = [0, 1, 2].map((k) => d[k] / r[k]), gl = Math.hypot(...g), dist = (1 - q) / gl * q; if (dist > depth) { depth = dist; n = g.map((v) => v / gl); }
      } else {
        const ab = [0, 1, 2].map((k) => s.b[k] - s.a[k]), t = Math.max(0, Math.min(1, [0, 1, 2].reduce((m, k) => m + (p[k] - s.a[k]) * ab[k], 0) / (ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2 || 1))), d = [0, 1, 2].map((k) => p[k] - s.a[k] - ab[k] * t), q = Math.hypot(...d), dist = s.r + radius[i] - q;
        if (dist > depth && q > 1e-9) { depth = dist; n = d.map((v) => v / q); }
      }
    }
    if (p[2] < radius[i]) { x[i * 3 + 2] = radius[i]; p[2] = radius[i]; }
    if (!n) continue;
    for (let k = 0; k < 3; k++) x[i * 3 + k] = p[k] + n[k] * depth;
    push[i] += depth;
    // Friction: of this step's slide along the surface, the contact holds back up to friction × the push.
    const d = [0, 1, 2].map((k) => x[i * 3 + k] - prev[i * 3 + k]), dn = d[0] * n[0] + d[1] * n[1] + d[2] * n[2], slide = d.map((v, k) => v - dn * n[k]), sl = Math.hypot(...slide);
    if (sl > 1e-9) { const hold = Math.min(1, friction[i] * depth / sl); for (let k = 0; k < 3; k++) x[i * 3 + k] -= slide[k] * hold; }
  }
}
// Seams close from wherever the pieces were arranged: without a speed limit the first steps would fling the cloth.
const MAX_SPEED = 2500;
// One step is SUBSTEPS small steps of one constraint pass each: at the same cost as eight passes over one long step,
// hanging cloth stops stretching under its own weight, so the strain map shows fit and not solver error.
const SUBSTEPS = 8;
function tick() {
  if (!state?.running) return; const dt = 1 / 120 / SUBSTEPS, { x, prev, velocities: v, push, contact } = state; contact.fill(0);
  for (let sub = 0; sub < SUBSTEPS; sub++) {
    prev.set(x); push.fill(0);
    for (let i = 0; i < state.inv.length; i++) { const damp=1-Math.max(0,Math.min(1,Number(state.materialAt?.[i]?.damping??.005)))/SUBSTEPS;v[i * 3] *= damp; v[i * 3 + 1] *= damp; v[i * 3 + 2] = (v[i * 3 + 2] - 9810 * dt) * damp; const speed = Math.hypot(v[i * 3], v[i * 3 + 1], v[i * 3 + 2]), cap = speed > MAX_SPEED ? MAX_SPEED / speed : 1; v[i * 3] *= cap; v[i * 3 + 1] *= cap; v[i * 3 + 2] *= cap; x[i * 3] += v[i * 3] * dt; x[i * 3 + 1] += v[i * 3 + 1] * dt; x[i * 3 + 2] += v[i * 3 + 2] * dt; }
    for (const c of state.constraints) { c.lambda = 0; project(c, dt); }
    collideAvatar(); if (sub === SUBSTEPS - 1) { collideSelf(); collideAvatar(); }
    // Contact force per area in Pa: what pushed the vertex out (mass × push / dt²) over the vertex's own area.
    for (let i = 0; i < state.inv.length; i++) { v[i * 3] = (x[i * 3] - prev[i * 3]) / dt; v[i * 3 + 1] = (x[i * 3 + 1] - prev[i * 3 + 1]) / dt; v[i * 3 + 2] = (x[i * 3 + 2] - prev[i * 3 + 2]) / dt; contact[i] += state.density[i] * 1e-6 * push[i] / (dt * dt) / SUBSTEPS; }
  }
  for (let i = 0; i < state.inv.length; i++) state.pressure[i] += 0.1 * (contact[i] - state.pressure[i]);
  state.step++; if (state.step % 2 === 0 && typeof postMessage === 'function') send();
}
/** The solver without a page: initialise, advance, return the frame. Tests and scripts call this. */
export function simulate(input, steps = 0) { initialize(input); state.running = true; for (let i = 0; i < steps; i++) tick(); state.running = false; return snapshot(); }
function send() { const m = snapshot(); postMessage(m, [m.positions.buffer, m.strain.buffer, m.pressure.buffer]); }
function snapshot() {
  const positions = Float32Array.from(state.x), strain = new Float32Array(state.inv.length), pressure = Float32Array.from(state.pressure), count = new Uint16Array(state.inv.length);
  for (const c of state.constraints) {
    if (c.kind !== 'fabric' || c.target || !(c.rest > 0)) continue;
    const a = V(state.x, c.a), b = V(state.x, c.b), e = (Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) - c.rest) / c.rest;
    strain[c.a] += e; strain[c.b] += e; count[c.a]++; count[c.b]++;
  }
  let minStrain = Infinity, maxStrain = -Infinity, maxPressure = 0;
  for (let i = 0; i < strain.length; i++) { strain[i] = count[i] ? strain[i] / count[i] : 0; minStrain = Math.min(minStrain, strain[i]); maxStrain = Math.max(maxStrain, strain[i]); maxPressure=Math.max(maxPressure,pressure[i]); }
  return { type: 'frame', step: state.step, body: state.input.collisionBody?.shapes || [], collision: state.collision, diagnostics: { strain: { unit: 'ratio', min: minStrain, max: maxStrain }, pressure: { available: state.pressureAvailable, unit: 'Pa', min: 0, max: maxPressure, reason: state.pressureAvailable ? null : 'No collision body is present in this preview' } }, positions, strain, pressure, pieces: state.pieces.map((p) => ({ id: p.id, off: p.off, count: p.uv.length / 2, triangles: p.triangles })) };
}
globalThis.onmessage = (e) => { const m = e.data; if (m.type === 'init') { initialize(m.input); send(); } else if (m.type === 'run') { state.running = true; clearInterval(timer); timer = setInterval(tick, 1000 / 60); } else if (m.type === 'pause') state.running = false; else if (m.type === 'reset') { initialize(state.input); send(); } };
