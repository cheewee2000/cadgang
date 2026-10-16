/**
 * Trackpad-first camera input, shared by every viewport.
 *   scroll          rotate (two fingers = turn the part)
 *   shift + scroll  pan
 *   pinch / ⌥scroll zoom (a pinch arrives as a wheel event with ctrlKey)
 *   double-click    centre the orbit on the point under the pointer
 * Dragging keeps whatever the page already does (orbit / right-drag pan).
 */
export function attachOrbitInput(el, { orbit, camera, getCamera = () => camera, THREE, hitAt, yawSign = 1 }) {
  el.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (e.ctrlKey || e.altKey) { orbit.dist *= Math.exp(e.deltaY * 0.01); return; }
    if (e.shiftKey) {
      const k = orbit.dist * 0.0015;
      const cam = getCamera();
      const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
      const up = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1);
      orbit.target.addScaledVector(right, e.deltaX * k).addScaledVector(up, -e.deltaY * k);
      return;
    }
    orbit.yaw += yawSign * e.deltaX * 0.005;
    orbit.pitch = Math.max(-1.45, Math.min(1.45, orbit.pitch - e.deltaY * 0.005));
  }, { passive: false });

  el.addEventListener('dblclick', (e) => {
    const p = hitAt(e);
    if (!p) return;
    orbit.dist = getCamera().position.distanceTo(p);   // the camera stays put; only the pivot moves
    orbit.target.copy(p);
  });
}
