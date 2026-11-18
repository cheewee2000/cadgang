import test from 'node:test';
import assert from 'node:assert/strict';
import { initBrep, beginBrepScope, brepIsValid } from '../src/core/brep.js';
import * as ops from '../src/core/ops.js';

await initBrep();
const scoped = (fn) => { const s = beginBrepScope(); try { return fn(); } finally { s.dispose(); } };
let seed = 0xCADA11; const rnd = () => (seed = (1664525 * seed + 1013904223) >>> 0) / 2 ** 32;
const near = (a, b, scale) => assert.ok(Math.abs(a - b) <= 2e-6 * Math.max(1, scale), `${a} != ${b}`);

/** Deterministic metamorphic corpus: Boolean volumes obey set identities and common translations change nothing. */
test('exact booleans obey volume identities under placement and operand order', () => scoped(() => {
  for (let i = 0; i < 16; i++) {
    const dimsA = [8 + 20 * rnd(), 8 + 20 * rnd(), 8 + 20 * rnd()];
    const dimsB = [8 + 20 * rnd(), 8 + 20 * rnd(), 8 + 20 * rnd()];
    const d = [(rnd() - 0.5) * 12, (rnd() - 0.5) * 12, (rnd() - 0.5) * 12];
    const far = i % 4 === 0 ? 1e12 : i % 4 === 1 ? 1e6 : 0;
    const at = [far + (rnd() - 0.5) * 100, -far + (rnd() - 0.5) * 100, far + (rnd() - 0.5) * 100];
    const a = ops.translate(ops.box(...dimsA, { center: 'xyz' }), at);
    const b = ops.translate(ops.box(...dimsB, { center: 'xyz' }), at.map((x, k) => x + d[k]));
    const va = ops.volume(a), vb = ops.volume(b);
    const ab = ops.union(a, b), ba = ops.union(b, a), common = ops.intersect(a, b), cut = ops.subtract(a, b);
    for (const [name, shape] of [['ab',ab],['ba',ba],['common',common],['cut',cut]]) if (ops.bodies(shape)) assert.ok(brepIsValid(shape), `case ${i} ${name} far=${far} d=${d}`);
    const vu = ops.volume(ab), vc = ops.volume(common), vd = ops.volume(cut), scale = va + vb;
    near(vu, ops.volume(ba), scale);                  // union commutes
    near(vu + vc, va + vb, scale);                   // inclusion-exclusion
    near(vd + vc, va, scale);                        // partition of A by B
    assert.equal(ops.bodies(ab), ops.bodies(ba));
  }
}));
