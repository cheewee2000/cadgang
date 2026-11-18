/** A 3D mouse moves the view as if the model were in the hand (web/orbitinput.js cadgang3dMouse). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { attachOrbitInput } from '../web/orbitinput.js';

globalThis.window ??= {};

/** One report of the puck, (x, y, z, rx, ry, rz), on a fresh view looking along +Y; flat: a 2D drawing. */
function push(axes, flat = false) {
  const orbit = { yaw: 0, pitch: 0, dist: 100, target: new THREE.Vector3() };
  const camera = new THREE.PerspectiveCamera();   // unturned: right is +X, up is +Y
  attachOrbitInput({ addEventListener() {} }, { orbit, camera, THREE, hitAt: () => null, isFlat: () => flat });
  window.cadgang3dMouse(...axes);
  return orbit;
}

test('3D mouse: pushing right moves the model right, lifting moves it up, pulling brings it closer', () => {
  assert.ok(push([350, 0, 0, 0, 0, 0]).target.x < 0);    // the model goes right: what is looked at goes left
  assert.ok(push([0, 0, -350, 0, 0, 0]).target.y < 0);   // z is down, so a lift is negative
  assert.ok(push([0, 350, 0, 0, 0, 0]).dist < 100);
  assert.ok(push([0, -350, 0, 0, 0, 0]).dist > 100);
});

test('3D mouse: a twist turns the view, a tilt pitches it, a sideways tip does nothing; a drawing never turns', () => {
  const twist = push([0, 0, 0, 0, 0, 350]), tilt = push([0, 0, 0, 350, 0, 0]), tip = push([0, 0, 0, 0, 350, 0]);
  assert.ok(twist.yaw > 0 && twist.pitch === 0);
  assert.ok(tilt.pitch > 0 && tilt.yaw === 0);
  assert.deepEqual([tip.yaw, tip.pitch, tip.dist, tip.target.length()], [0, 0, 100, 0]);
  const flat = push([350, 0, 0, 350, 0, 350], true);
  assert.ok(flat.target.x < 0 && flat.yaw === 0 && flat.pitch === 0);
});
