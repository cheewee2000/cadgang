/**
 * Fillets that used to fail on ordinary parts: a radius of exactly half a thickness (a full round), and
 * shelling a box whose fillets meet at its corners (the kernel's offset came back as a bare shell).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { initBrep, beginBrepScope } from '../src/core/brep.js';
import * as ops from '../src/core/ops.js';
import { q } from '../src/core/query.js';

await initBrep();

const inScope = (fn) => { const s = beginBrepScope(); try { return fn(); } finally { s.dispose(); } };

test('fillet: a radius of exactly half the thickness is a full round', () => inScope(() => {
  const plate = ops.box(40, 20, 3);
  const round = ops.fillet(plate, q.edges(plate).along('x'), 1.5);
  const removed = 40 * 4 * 1.5 * 1.5 * (1 - Math.PI / 4);
  assert.ok(Math.abs(ops.volume(plate) - ops.volume(round) - removed) < 0.05);
  const box = ops.box(30, 20, 10);
  assert.equal(ops.bodies(ops.fillet(box, q.edges(box), 5)), 1);
}));

test('fillet: a radius that is too big is fitted, and the result says what each edge got; strict makes it an error', () => inScope(() => {
  const box = ops.box(30, 20, 10);
  const fit = ops.fillet(box, q.edges(box), 6);
  assert.equal(ops.bodies(fit), 1);
  assert.ok(ops.volume(fit) < ops.volume(box) && ops.volume(fit) > 0.7 * ops.volume(box));
  assert.match(fit.__note, /R6 built R4\.9/);
  assert.equal(ops.fillet(box, q.edges(box), 2).__note, undefined, 'a fillet that fits says nothing');
  assert.throws(() => ops.fillet(box, q.edges(box), 6, { strict: true }), /10 mm apart.*use a radius under 5/);
}));

test('fillet: two bosses too close for both fillets keep their radius and narrow only between them', () => inScope(() => {
  const s = ops.union(ops.box(60, 40, 6), ops.translate(ops.cylinder(6, 15), [-8, 0, 5]), ops.translate(ops.cylinder(6, 15), [8, 0, 5]));
  const rims = () => q.edges(s).circular().where((d) => Math.abs(d.center[2] - 6) < 0.01);
  const fit = ops.fillet(s, rims(), 3), small = ops.fillet(s, rims(), 1.96);
  assert.match(fit.__note, /\[8,0,6\] R3 narrows to R1\.8 where.*\[-8,0,6\] R3 narrows to R1\.8 where/);
  assert.ok(ops.volume(fit) > ops.volume(small) + 20, `pinched ${ops.volume(fit)} keeps more than the one small radius ${ops.volume(small)}`);
}));

test('fillet: a wall beside a boss keeps its radius and narrows past the boss', () => inScope(() => {
  const s = ops.union(ops.box(60, 40, 6), ops.translate(ops.cylinder(6, 15), [0, 0, 5]), ops.translate(ops.box(60, 4, 15), [0, 10, 5]));
  const fit = ops.fillet(s, q.edges(s).where((d) => Math.abs(d.center[2] - 6) < 0.01 && (d.kind === 'CIRCLE' || Math.abs(d.center[1] - 8) < 0.01)), 3);
  assert.match(fit.__note, /\[0,8,6\] R3 narrows to R0\.9 where/);
  // the wall's foot, 1 mm of it, `deep` out from the wall (beside the boss: short of the boss's own fillet)
  const slice = (sh, x, deep) => ops.volume(ops.intersect(sh, ops.translate(ops.box(1, deep, 6), [x, 8 - deep / 2, 5])));
  const added = (x, deep) => slice(fit, x, deep) - slice(s, x, deep), area = (r) => r * r * (1 - Math.PI / 4);
  assert.ok(Math.abs(added(25, 5) - area(3)) < 0.05, `full R3 away from the boss: ${added(25, 5)}`);
  assert.ok(added(0, 0.95) < area(1.2) && added(0, 0.95) > area(0.7), `narrow beside it: ${added(0, 0.95)}`);
}));

test('fillet: stops set the radius at places along the seam, on a closed loop too', () => inScope(() => {
  const box = ops.box(20, 20, 60), edge = q.edges(box).linear().along('z').near([10, 10, 30], 1).expect(1);
  const out = ops.fillet(box, edge, [[0, 1], [0.5, 5], [1, 1]]);
  const slab = (sh, z) => ops.volume(ops.intersect(sh, ops.translate(ops.box(100, 100, 1), [0, 0, z - 0.5])));
  const r = (z) => Math.sqrt((slab(box, z) - slab(out, z)) / (1 - Math.PI / 4));
  assert.ok(Math.abs(r(30) - 5) < 0.1 && Math.abs(r(15) - 3) < 0.15 && Math.abs(r(45) - 3) < 0.15 && r(1) < 1.3 && r(59) < 1.3, `R ${[1, 15, 30, 45, 59].map((z) => r(z).toFixed(2))}`);
  const puck = ops.cylinder(15, 10), rim = q.edges(puck).circular().where((d) => d.center[2] > 9);
  const wavy = ops.volume(puck) - ops.volume(ops.fillet(puck, rim, [[0, 3], [0.5, 1], [1, 3]]));
  const one = (R) => ops.volume(puck) - ops.volume(ops.fillet(puck, rim, R));
  assert.ok(wavy > one(1) && wavy < one(3), `between R1 and R3 all round: ${wavy}`);
  assert.throws(() => ops.fillet(box, edge, [[0, 1], [0.5, 2], [0.4, 3]]), /in order/);
}));

test('fillet: a seam the kernel cannot build at its radius is built smaller, on its own', () => inScope(() => {
  const s = ops.union(ops.box(60, 60, 5), ops.translate(ops.torus(15, 4), [0, 0, 6]));
  const fit = ops.fillet(s, q.edges(s).circular().where((d) => Math.abs(d.center[2] - 5) < 0.01 && d.radius > 15), 1, { local: false });
  assert.ok(ops.volume(fit) > ops.volume(s));
  assert.match(fit.__note, /R1 built R0\.5/);
}));

test('fillet: [start, end] is a radius that varies along the seam, from the end nearer `from`', () => inScope(() => {
  const box = ops.box(20, 20, 60), edge = () => q.edges(box).linear().along('z').near([10, 10, 30], 1).expect(1);
  const slab = (s, z0, z1) => ops.volume(ops.intersect(s, ops.translate(ops.box(100, 100, z1 - z0), [0, 0, z0])));
  const removed = (s, a, b) => (slab(box, a, b) - slab(s, a, b)) / (b - a), area = (r) => r * r * (1 - Math.PI / 4);
  const up = ops.fillet(box, edge(), [1, 6]), down = ops.fillet(box, edge(), [1, 6], { from: [10, 10, 60] });
  assert.ok(Math.abs(removed(up, 29, 31) - area(3.5)) < 0.05, `mid ${removed(up, 29, 31)}`);
  assert.ok(removed(up, 0, 2) < area(1.5) && removed(up, 58, 60) > area(5.5), 'R1 at the bottom, R6 at the top');
  assert.ok(removed(down, 0, 2) > area(5.5) && removed(down, 58, 60) < area(1.5), 'and the other way round from the top');
  const puck = ops.cylinder(10, 20);
  assert.throws(() => ops.fillet(puck, q.edges(puck).circular(), [1, 3]), /closed loop/);
}));

test('shell: a box rounded on its sides and bottom shells', () => inScope(() => {
  let s = ops.box(40, 30, 20);
  s = ops.fillet(s, q.edges(s).exclude((e) => e.atExtreme('z')), 4);
  const cup = ops.shell(s, q.faces(s).facing([0, 0, 1]), 2);
  assert.equal(ops.bodies(cup), 1);
  assert.ok(ops.volume(cup) > 0.2 * ops.volume(s) && ops.volume(cup) < 0.5 * ops.volume(s), `cup ${ops.volume(cup)} of ${ops.volume(s)}`);
  assert.equal(ops.bodies(ops.offset(s, -2)), 1);   // and the offset on its own is a solid, not a shell
}));

test('fillet: two edges too close together are named with the radius that fits', () => inScope(() => {
  // a slot ending 0.5 mm short of the plate's edge: the two R0.5 fillets on that wall cannot both fit
  let s = ops.box(40, 30, 5);
  s = ops.subtract(s, ops.translate(ops.box(4, 15, 10), [0, 7, -2]));
  assert.throws(() => ops.fillet(s, q.edges(s), 0.5, { strict: true }), /0\.5 mm apart.*use a radius under 0\.25/);
  assert.match(ops.fillet(s, q.edges(s), 0.5).__note, /R0\.5 built R0\.24/);
  assert.equal(ops.bodies(ops.fillet(s, q.edges(s), 0.2)), 1);
}));

test('a fitted fillet warns in the cell\'s log, and again when the shape comes back remembered', async () => {
  const { cellApi } = await import('../src/core/cellapi.js');
  inScope(() => {
    for (const round of [1, 2]) {
      const logs = [], { brep, q: cq } = cellApi({ logs });
      const box = brep.box(30, 20, 10);
      brep.fillet(box, cq.edges(box), 6);
      assert.equal(logs.length, 1, `round ${round}`);
      assert.equal(logs[0].level, 'warn');
      assert.match(logs[0].text, /R6 built R4\.9/);
    }
  });
});
