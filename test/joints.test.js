/** Joint math: what each joint type does to a point, and how a chain of parents carries it. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { normalizeJoint, jointMatrix, solvePoses, clampValue, pitchFor, sweepJoints } from '../web/joints.js';

const J = (o) => normalizeJoint({ id: 'j', body: 'b#0', origin: [0, 0, 0], axis: [0, 0, 1], ...o });
const at = (m, p) => new THREE.Vector3(...p).applyMatrix4(m).toArray().map((v) => Math.round(v * 1e6) / 1e6 + 0);

test('a revolute turns about the axis through its origin, not the world origin', () => {
  const m = jointMatrix(J({ type: 'revolute', origin: [10, 0, 0], value: 90 }));
  assert.deepEqual(at(m, [10, 0, 0]), [10, 0, 0]);   // on the axis: stays
  assert.deepEqual(at(m, [11, 0, 0]), [10, 1, 0]);   // a quarter turn, right-handed about +z
});

test('a slider moves along its axis', () => {
  assert.deepEqual(at(jointMatrix(J({ type: 'slider', axis: [1, 0, 0], value: 7 })), [0, 2, 3]), [7, 2, 3]);
});

test('a screw advances pitch per turn along the axis while it turns', () => {
  const m = jointMatrix(J({ type: 'screw', pitch: 1.5, value: 720 }));   // two turns
  assert.deepEqual(at(m, [1, 0, 0]), [1, 0, 3]);
  const q = jointMatrix(J({ type: 'screw', pitch: 2, value: 90 }));
  assert.deepEqual(at(q, [1, 0, 0]), [0, 1, 0.5]);
  assert.deepEqual(at(jointMatrix(J({ type: 'screw', pitch: -2, value: 90 })), [0, 0, 0]), [0, 0, -0.5]);   // left-hand
});

test('a cylindrical joint turns and slides independently', () => {
  assert.deepEqual(at(jointMatrix(J({ type: 'cylindrical', value: 90, value2: 4 })), [1, 0, 0]), [0, 1, 4]);
});

test('limits clamp the value, free ends do not', () => {
  const j = J({ type: 'slider', min: 0, max: 5 });
  assert.equal(clampValue(j, -3), 0);
  assert.equal(clampValue(j, 9), 5);
  assert.equal(clampValue(J({ type: 'slider' }), 1e6), 1e6);
  assert.equal(J({ type: 'slider', min: 0, max: 5, value: 12 }).value, 5);
});

test('a child follows its parent: a nut on a screw on a turning plate', () => {
  const plate = J({ id: 'p', body: 'plate#0', type: 'revolute', origin: [0, 0, 0], value: 90 });
  const screw = J({ id: 's', body: 'screw#0', parent: 'plate#0', type: 'slider', axis: [1, 0, 0], value: 2 });
  const poses = solvePoses([screw, plate]);   // child listed first on purpose
  // the screw slides 2 along its own x in the plate's frame, then the plate turns a quarter: x → y
  assert.deepEqual(at(poses.get('screw#0'), [0, 0, 0]), [0, 2, 0]);
  assert.deepEqual(at(poses.get('plate#0'), [1, 0, 0]), [0, 1, 0]);
});

test('a fixed joint rides with its parent and does nothing alone', () => {
  const a = J({ id: 'a', body: 'a#0', type: 'slider', axis: [0, 1, 0], value: 5 });
  const b = J({ id: 'b', body: 'b#0', parent: 'a#0', type: 'fixed' });
  assert.deepEqual(at(solvePoses([a, b]).get('b#0'), [0, 0, 0]), [0, 5, 0]);
});

test('a loop in the chain is cut, not followed forever', () => {
  const a = J({ id: 'a', body: 'a#0', parent: 'b#0', type: 'slider', value: 1 });
  const b = J({ id: 'b', body: 'b#0', parent: 'a#0', type: 'slider', value: 2 });
  assert.equal(solvePoses([a, b]).size, 2);
});

test('untrusted joints are made safe', () => {
  const j = normalizeJoint({ type: 'weird', axis: [0, 0, 0], origin: ['x'], value: 'nope', body: 7 });
  assert.equal(j.type, 'revolute');
  assert.deepEqual(j.axis, [0, 0, 1]);
  assert.deepEqual(j.origin, [0, 0, 0]);
  assert.equal(j.value, 0);
  assert.equal(j.body, '7');
  assert.deepEqual(normalizeJoint({ axis: [0, 3, 4] }).axis, [0, 0.6, 0.8]);
});

test('screw pitch guess follows ISO coarse', () => {
  assert.equal(pitchFor(3), 0.5);
  assert.equal(pitchFor(5.1), 0.8);
  assert.equal(pitchFor(8), 1.25);
});

test('a ball joint turns about its centre to any orientation', () => {
  const m = jointMatrix(J({ type: 'ball', origin: [5, 0, 0], rot: [0, 0, 90] }));
  assert.deepEqual(at(m, [5, 0, 0]), [5, 0, 0]);   // the centre stays
  assert.deepEqual(at(m, [6, 0, 0]), [5, 1, 0]);   // a quarter turn about z
  const both = jointMatrix(J({ type: 'ball', rot: [90, 0, 90] }));   // rot is Euler XYZ
  assert.deepEqual(at(both, [0, 1, 0]), [-1, 0, 0]);   // Euler XYZ: z first (y → −x), then x leaves it
  assert.deepEqual(at(both, [0, 0, 1]), [0, -1, 0]);
  assert.deepEqual(J({ type: 'ball', rot: ['x', 1, 2] }).rot, [0, 0, 0]);   // untrusted rot is ignored
});

test('a planar joint slides on its plane, turns about its normal and lifts by its offset', () => {
  const m = jointMatrix(J({ type: 'planar', origin: [0, 0, 0], axis: [0, 0, 1], value: 90, value2: 5, value3: -2, offset: 1 }));
  assert.deepEqual(at(m, [1, 0, 0]), [5, -1, 1]);   // turned a quarter about z (→ [0,1,0]), then +5 x, −2 y, +1 off the plane
  const tilted = jointMatrix(J({ type: 'planar', axis: [1, 0, 0], value2: 3 }));   // a normal along x: the plane's x is world y
  assert.deepEqual(at(tilted, [0, 0, 0]), [0, 3, 0]);
});

test('a joint carries its snap: the align matrix comes first, then the motion', () => {
  const align = new THREE.Matrix4().makeTranslation(0, 0, 10).toArray();
  const m = jointMatrix(J({ type: 'slider', axis: [1, 0, 0], value: 2, align }));
  assert.deepEqual(at(m, [0, 0, 0]), [2, 0, 10]);
  assert.equal(normalizeJoint({ align: [1, 2] }).align, null);   // anything but 16 numbers is no snap
});

test('an offset moves any joint along its axis, on top of its motion and past its limits', () => {
  assert.deepEqual(at(jointMatrix(J({ type: 'revolute', axis: [0, 0, 1], offset: 3, value: 90 })), [1, 0, 0]), [0, 1, 3]);
  assert.deepEqual(at(jointMatrix(J({ type: 'slider', axis: [1, 0, 0], value: 2, max: 2, offset: 5 })), [0, 0, 0]), [7, 0, 0]);
  assert.deepEqual(at(jointMatrix(J({ type: 'fixed', axis: [0, 1, 0], offset: -4 })), [0, 0, 0]), [0, -4, 0]);
});

test('a body with two joints stacks them: the second rides on the first', () => {
  const slide = J({ id: 'a', type: 'slider', axis: [1, 0, 0], value: 10 });
  const turn = J({ id: 'b', type: 'revolute', origin: [0, 0, 0], axis: [0, 0, 1], value: 90 });
  const poses = solvePoses([slide, turn]);
  assert.deepEqual(at(poses.get('b#0'), [1, 0, 0]), [10, 1, 0]);   // turned about the pin at rest, then slid with it
  assert.deepEqual(at(poses.frames.get('b'), [0, 0, 0]), [10, 0, 0]);   // the turn's frame has slid
});

test('a sweep finds where an arm swings into its base, and that the other way is clear', () => {
  const box = (w, h, d, x, y, z) => { const g = new THREE.BoxGeometry(w, h, d); g.translate(x, y, z); return new THREE.Mesh(g); };
  const meshes = new Map([['base#0', box(20, 10, 2, 0, 0, 0)], ['arm#0', box(8, 1, 1, 4, 0, 2)]]);
  const j = J({ type: 'revolute', body: 'arm#0', origin: [0, 0, 2], axis: [0, 1, 0], min: -90, max: 90 });
  const [r] = sweepJoints(meshes, [j], { steps: 18 });
  assert.equal(r.contacts.length, 1);
  const c = r.contacts[0];
  assert.equal(c.body, 'base#0');
  assert.equal(c.always, false);
  assert.deepEqual(c.spans, [[10, 90]]);   // +y turns +x down into the base; −90…0 swings up, clear
  assert.equal(c.first, 10);
});

test('a joint held at one value (min = max) is still checked where it sits', () => {
  const box = (w, h, d, x, y, z) => { const g = new THREE.BoxGeometry(w, h, d); g.translate(x, y, z); return new THREE.Mesh(g); };
  const meshes = new Map([['base#0', box(20, 10, 2, 0, 0, 0)], ['pin#0', box(1, 1, 4, 0, 0, 3)]]);
  const j = J({ type: 'slider', body: 'pin#0', axis: [0, 0, -1], min: 3, max: 3 });   // pushed 3 mm down: into the base
  const [r] = sweepJoints(meshes, [j], { steps: 4 });
  assert.deepEqual(r.contacts.map((c) => [c.body, c.always, c.spans]), [['base#0', false, [[3, 3]]]]);
});
