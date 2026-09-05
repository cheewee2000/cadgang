/** The preview is the model's own triangles, drawn in bounded time. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { initBrep, beginBrepScope, tessellate, tessellateEdges, brepBBox } from '../src/core/brep.js';
import { renderMesh } from '../src/core/render.js';
import * as ops from '../src/core/ops.js';
import { q } from '../src/core/query.js';

await initBrep();

test('a threaded bolt previews in seconds, as a PNG, with something drawn', () => {
  const scope = beginBrepScope();
  try {
    const c = ops.cylinder(6, 20);
    const bolt = ops.thread(c, q.faces(c).cylindrical(), 1);
    const t0 = Date.now();
    const tol = 0.05;
    const png = renderMesh(tessellate(bolt, { tolerance: tol }), tessellateEdges(bolt, { tolerance: tol }), brepBBox(bolt), { width: 320, height: 240 });
    const ms = Date.now() - t0;
    assert.ok(ms < 8000, `rendered in ${ms} ms`);
    assert.deepEqual([...png.subarray(1, 4)], [0x50, 0x4e, 0x47]);
    assert.ok(png.length > 3000, 'not an empty frame');
  } finally { scope.dispose(); }
});
