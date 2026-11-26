// Analytic test surfaces for softgoods-flatten: each surface is one B-rep face with its own vertices, the way a
// CAD tessellation arrives (faces meet at duplicated vertices, which the flattener welds).

/** A (nu × nv) grid over f(u, v) → [x, y, z], u and v in 0..1, wound so du × dv points out. */
export function surface(nu, nv, f) {
  const positions = [], indices = [], at = (i, j) => i * (nv + 1) + j;
  for (let i = 0; i <= nu; i++) for (let j = 0; j <= nv; j++) positions.push(...f(i / nu, j / nv));
  for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) indices.push(at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j), at(i + 1, j + 1), at(i, j + 1));
  return { positions, indices };
}

/** Several surfaces as one body: {positions, indices, faces:[{first,count}], bodies:[{first,count,name}]}. */
export function body(name, surfaces) {
  const positions = [], indices = [], faces = [];
  for (const s of surfaces) { const base = positions.length / 3; faces.push({ first: indices.length / 3, count: s.indices.length / 3 }); positions.push(...s.positions); indices.push(...s.indices.map((i) => i + base)); }
  return { name, positions: Float32Array.from(positions), indices: Uint32Array.from(indices), faces, bodies: [{ first: 0, count: indices.length / 3, name }] };
}

const TAU = 2 * Math.PI;
/** The side of a cylinder or cone about z, from angle a0 to a1 (turns), radius r0 at z = 0 and r1 at z = h. */
export const side = (r0, r1, h, n = 96, a0 = 0, a1 = 1, rows = 4) => surface(n, rows, (u, v) => { const a = TAU * (a0 + (a1 - a0) * u), r = r0 + (r1 - r0) * v; return [r * Math.cos(a), r * Math.sin(a), h * v]; });
/** A disc at height z facing up (+1) or down (-1), as a fan of rings so its rim matches a side of n steps. */
export const disc = (r, z, up = 1, n = 96, rings = 3) => surface(n, rings, (u, v) => { const a = TAU * u * up, q = r * (1 - v); return [q * Math.cos(a), q * Math.sin(a), z]; });
/** A parallelogram from corner o along a then b (normal a × b). */
export const quad = (o, a, b, n = 2) => surface(n, n, (u, v) => [0, 1, 2].map((k) => o[k] + a[k] * u + b[k] * v));
/** A box with one corner at the origin: faces in the order bottom, top, front (-y), back, left (-x), right. */
export const box = (w, d, h, n = 2) => [
  quad([0, 0, 0], [0, d, 0], [w, 0, 0], n), quad([0, 0, h], [w, 0, 0], [0, d, 0], n),
  quad([0, 0, 0], [w, 0, 0], [0, 0, h], n), quad([w, d, 0], [-w, 0, 0], [0, 0, h], n),
  quad([0, d, 0], [0, -d, 0], [0, 0, h], n), quad([w, 0, 0], [0, d, 0], [0, 0, h], n),
];
/** The upper half of a sphere, pole up: latitude rings from the rim to the pole. */
export const hemisphere = (r, n = 48, rings = 12) => surface(n, rings, (u, v) => { const a = TAU * u, t = Math.PI / 2 * v; return [r * Math.cos(t) * Math.cos(a), r * Math.cos(t) * Math.sin(a), r * Math.sin(t)]; });
