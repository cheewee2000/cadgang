/** Settled choices (see CLAUDE.md "Decided"): a failure here means a change undid one. Change it only by agreement, and update CLAUDE.md with it. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as THREE from 'three';
import { attachOrbitInput } from '../web/orbitinput.js';

globalThis.window ??= {};   // orbitinput hangs the Mac app's pinch hook on window
const view = fs.readFileSync(new URL('../web/view.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../web/view.html', import.meta.url), 'utf8');

/** Two-finger scroll with the given scheme and shift: did it turn the view or pan it? */
function scroll(scheme, shiftKey) {
  let onWheel;
  const el = { addEventListener: (t, f) => { if (t === 'wheel') onWheel = f; }, getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) };
  const orbit = { yaw: 0, pitch: 0, dist: 100, target: new THREE.Vector3() };
  const camera = new THREE.PerspectiveCamera();
  attachOrbitInput(el, { orbit, camera, THREE, hitAt: () => null, scheme: () => scheme });
  onWheel({ preventDefault() {}, timeStamp: 1000, deltaMode: 0, deltaX: 3, deltaY: 4, wheelDeltaY: -12, shiftKey, ctrlKey: false, altKey: false });
  return orbit.yaw || orbit.pitch ? 'turn' : orbit.target.length() ? 'pan' : 'none';
}

test('Trackpad scheme: two fingers turn, ⇧ pans; Mouse: the other way round', () => {
  assert.equal(scroll('trackpad', false), 'turn');
  assert.equal(scroll('trackpad', true), 'pan');
  assert.equal(scroll('mouse', false), 'pan');
  assert.equal(scroll('mouse', true), 'turn');
});

test('the Trackpad / Mouse selector is in the footer, Trackpad by default, and every tab follows it', () => {
  assert.match(html, /<select id="scrollSel"[^>]*><option value="trackpad">Trackpad<\/option><option value="mouse">Mouse<\/option>/);
  assert.match(view, /ui\.scroll = 'trackpad';/);
  assert.match(view, /addEventListener\('storage'/);
});

test('Trackpad scheme: a plain drag on a part slides it along its explode axis (⌥ places it)', () => {
  assert.match(view, /const slide = ui\.scroll === 'trackpad' \? !e\.altKey : e\.altKey;/);
});

test('the Figma-style pen is BEZIER', () => {
  assert.match(html, /data-tool="path"[^>]*>BEZIER</);
});

test('hotkeys: B Bezier, P pencil, J new joint, E joint/explode, Q triad, V explode direction, F fit', () => {
  assert.match(view, /\['b', 'path', 'Bezier'\], \['p', 'pen', 'Pencil'\]/);
  for (const [k, label] of [['j', 'New joint'], ['e', 'Joint / explode mode'], ['q', 'Move triad'], ['v', 'Explode direction'], ['f', 'Fit']])
    assert.match(view, new RegExp(`key: '${k}', label: '${label}`), `${k} → ${label}`);
});
