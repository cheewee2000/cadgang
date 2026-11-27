// An arrangement row's `start` ({ uv, xyz, triangles }): the piece's own flatten mesh, flat (u, v) and where each vertex came
// from on the part. A flat point starts where the triangle it falls in maps it; one just outside every triangle (a sample on
// the outline, rounding) where the nearest triangle's own affine map takes it. Used by the solver, the server and the page.

/** Where the flat point (u, v) starts by its row's `start` mesh. */
export function startOn(s, u, v) {
  const { uv, xyz, triangles: t } = s;
  // ponytail: a scan of every triangle per point; a grid over uv if pieces ever get big enough for it to show.
  let best = -Infinity, at = null;
  for (let k = 0; k < t.length; k += 3) {
    const i = t[k], j = t[k + 1], l = t[k + 2], x1 = uv[2 * j] - uv[2 * i], y1 = uv[2 * j + 1] - uv[2 * i + 1], x2 = uv[2 * l] - uv[2 * i], y2 = uv[2 * l + 1] - uv[2 * i + 1], det = x1 * y2 - x2 * y1;
    if (!(Math.abs(det) > 1e-12)) continue;
    const du = u - uv[2 * i], dv = v - uv[2 * i + 1], b = (du * y2 - x2 * dv) / det, c = (x1 * dv - du * y1) / det, a = 1 - b - c, worst = Math.min(a, b, c);
    if (worst > best) { best = worst; at = [i, j, l, a, b, c]; if (worst >= 0) break; }
  }
  if (!at) return [u, v, 0];
  const [i, j, l, a, b, c] = at;
  return [0, 1, 2].map((q) => a * xyz[3 * i + q] + b * xyz[3 * j + q] + c * xyz[3 * l + q]);
}

/** Why a row's `start` is malformed, or null when it is usable. */
export function startProblem(s) {
  if (!s || !Array.isArray(s.uv) || !Array.isArray(s.xyz) || !Array.isArray(s.triangles)) return 'start must be { uv, xyz, triangles }';
  const n = s.uv.length / 2;
  if (!Number.isInteger(n) || !n || s.xyz.length !== 3 * n || ![...s.uv, ...s.xyz].every(Number.isFinite)) return 'start needs uv as u, v pairs and xyz as x, y, z for each of the same vertices';
  if (!s.triangles.length || s.triangles.length % 3 || !s.triangles.every((i) => Number.isInteger(i) && i >= 0 && i < n)) return 'start triangles must be vertex index triples';
  return null;
}
