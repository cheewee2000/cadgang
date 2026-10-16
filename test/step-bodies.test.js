/**
 * A STEP with several solids comes back as several BODIES: triangle ranges the
 * viewer turns into one mesh each (show/hide, explode, caps). The binary pack
 * carries the ranges and names after the faces.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { initBrep, beginBrepScope, exportStep } from '../src/core/brep.js';
import * as ops from '../src/core/ops.js';
import { importCadFile } from '../src/core/step.js';
import { pack } from '../src/server/view.js';

await initBrep();

test('two solids kept apart import as two bodies whose ranges tile the triangles', async () => {
  const scope = beginBrepScope();
  try {
    const asm = ops.compound(ops.box(10, 10, 10), ops.translate(ops.box(10, 10, 10), [0, 0, 10]));
    const step = await exportStep(asm);
    const m = await importCadFile(Buffer.from(step), { name: 'asm.step' });
    assert.equal(m.bodies.length, 2);
    assert.equal(m.bodies[0].first, 0);
    assert.equal(m.bodies[0].first + m.bodies[0].count, m.bodies[1].first);
    assert.equal(m.bodies[1].first + m.bodies[1].count, m.triangleCount);
    const buf = pack(m);
    const head = new Uint32Array(buf.buffer, buf.byteOffset, 5);
    assert.equal(head[3], 2, 'two bodies in the header');
    const names = JSON.parse(buf.subarray(buf.length - head[4]).toString('utf8'));
    assert.equal(names.length, 2);
  } finally { scope.dispose(); }
});
