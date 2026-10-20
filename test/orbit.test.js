/** The orbit camera: turning about the point pressed on (Bambu Studio's way), and the view cube's look directions. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { offsetOf, turnAbout, yawPitchOf } from '../web/orbitmath.js';

/** Where a world point sits in front of the orbit's camera: its coordinates in camera space. */
function inCamera(orbit, p) {
  const cam = new THREE.PerspectiveCamera();
  const cp = Math.cos(orbit.pitch), sp = Math.sin(orbit.pitch);
  cam.position.copy(orbit.target).addScaledVector(offsetOf(THREE, orbit.yaw, orbit.pitch), orbit.dist);
  cam.up.set(-sp * Math.sin(orbit.yaw), sp * Math.cos(orbit.yaw), cp);   // as the viewer's applyCamera
  cam.lookAt(orbit.target);
  cam.updateMatrixWorld();
  return p.clone().applyMatrix4(cam.matrixWorldInverse);
}

test('turning about a pressed point leaves it where it was on screen', () => {
  const orbit = { yaw: -0.6, pitch: 0.5, dist: 160, target: new THREE.Vector3(3, -2, 5) };
  const pivot = new THREE.Vector3(40, 12, -8);   // a corner off to one side of the orbit's centre
  const before = inCamera(orbit, pivot);
  for (let i = 0; i < 30; i++) turnAbout(THREE, orbit, pivot, 0.07, -0.05);   // a long drag, in small steps
  const after = inCamera(orbit, pivot);
  assert.ok(before.distanceTo(after) < 1e-6, `${before.toArray()} → ${after.toArray()}`);
  assert.ok(orbit.target.distanceTo(new THREE.Vector3(3, -2, 5)) > 1, 'the centre swung round the point');
});

test('with no point, the turn is about the orbit centre', () => {
  const orbit = { yaw: 0, pitch: 0, dist: 10, target: new THREE.Vector3(1, 2, 3) };
  turnAbout(THREE, orbit, null, 0.5, 0.25);
  assert.deepEqual(orbit.target.toArray(), [1, 2, 3]);
  assert.equal(orbit.yaw, 0.5); assert.equal(orbit.pitch, 0.25);
});

test("the view cube's directions land on the viewer's named views", () => {
  const near = (a, b) => Math.abs(a - b) < 1e-3;
  const front = yawPitchOf(THREE, new THREE.Vector3(0, -1, 0)), right = yawPitchOf(THREE, new THREE.Vector3(1, 0, 0)), top = yawPitchOf(THREE, new THREE.Vector3(0, 0, 1));
  assert.ok(near(front.yaw, 0) && near(front.pitch, 0));
  assert.ok(near(right.yaw, Math.PI / 2) && near(right.pitch, 0));
  assert.ok(near(top.yaw, 0) && near(top.pitch, Math.PI / 2));
  const corner = yawPitchOf(THREE, new THREE.Vector3(1, -1, 1));   // front-right-top corner: an isometric
  assert.ok(near(corner.yaw, Math.PI / 4) && near(corner.pitch, Math.asin(1 / Math.sqrt(3))));
  // and round trip through the camera offset
  const o = offsetOf(THREE, corner.yaw, corner.pitch);
  assert.ok(o.distanceTo(new THREE.Vector3(1, -1, 1).normalize()) < 1e-6);
});
