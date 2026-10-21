/**
 * Camera input from a trackpad or a mouse wheel, shared by every viewport.
 *   mouse wheel     zoom to the pointer, as Bambu Studio does
 *   scroll          rotate (two fingers on a trackpad turn the part)
 *   shift + scroll  pan
 * scheme() 'mouse' swaps those two: scroll pans, shift + scroll rotates.
 *   pinch / ⌥scroll zoom to the pointer (Chrome sends a pinch as a wheel event with ctrlKey;
 *                         WebKit sends gesturestart/gesturechange with a scale)
 *   two-finger spin turn a flat drawing in 90° steps (WebKit gesture rotation)
 *   double-click    centre the orbit on the point under the pointer
 * isFlat() true (a 2D drawing): scroll and drag pan instead of rotating.
 * Dragging keeps whatever the page already does (orbit / right-drag pan).
 */
export function attachOrbitInput(el, { orbit, camera, getCamera = () => camera, THREE, hitAt, yawSign = 1, isFlat = () => false, scheme = () => 'trackpad' }) {
  // A mouse wheel and a trackpad both send wheel events. A wheel notch is a big step: in lines
  // (Firefox), or its old wheelDelta a multiple of 120 (360, 480 with macOS acceleration) and 50 px or
  // more, straight up or down; a trackpad starts a burst with steps of a few px (both measured on a
  // MacBook). Classify the first event of a burst and keep that answer until the burst ends, so a
  // trackpad fling never flips into zoom. A wheel smoothed into a trackpad's stream (Mac Mouse Fix's
  // smooth scrolling) reads as a trackpad.
  let wheelMouse = false, lastWheel = 0;
  el.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (e.timeStamp - lastWheel > 250) wheelMouse = e.deltaMode !== 0 || (!e.deltaX && !!e.wheelDeltaY && e.wheelDeltaY % 120 === 0 && Math.abs(e.deltaY) >= 50);
    lastWheel = e.timeStamp;
    if (wheelMouse && !e.ctrlKey) { zoomAt(e, Math.exp(-Math.sign(e.deltaY) * 0.15)); return; }   // a wheel notch zooms
    if (e.ctrlKey || e.altKey) { zoomAt(e, Math.exp(Math.max(-0.5, Math.min(0.5, e.deltaY * 0.01)))); return; }   // pinch: spread comes closer
    if ((scheme() === 'mouse') !== e.shiftKey || isFlat()) {   // trackpad: two fingers turn the part, with ⇧ they pan; mouse: the other way round
      const k = orbit.dist * 0.0015;
      const cam = getCamera();
      const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
      const up = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1);
      orbit.target.addScaledVector(right, e.deltaX * k).addScaledVector(up, -e.deltaY * k);
      return;
    }
    orbit.yaw += yawSign * e.deltaX * 0.005;
    orbit.pitch -= e.deltaY * 0.005;
  }, { passive: false });

  // Zoom by factor k (<1 closer) keeping the point under the pointer where it is on screen.
  function zoomAt(e, k) {
    const cam = getCamera();
    const r = el.getBoundingClientRect();
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), cam);
    const facing = new THREE.Plane().setFromNormalAndCoplanarPoint(cam.getWorldDirection(new THREE.Vector3()), orbit.target);
    const p = hitAt(e) ?? ray.ray.intersectPlane(facing, new THREE.Vector3());
    if (p) orbit.target.lerp(p, 1 - k);
    orbit.dist *= k;
  }

  // WebKit (Safari, the Mac app's WKWebView) pinch: scale is cumulative since gesturestart.
  let gestureScale = 1, gestureSteps = 0;
  el.addEventListener('gesturestart', (e) => { e.preventDefault(); gestureScale = 1; gestureSteps = 0; });
  el.addEventListener('gesturechange', (e) => {
    e.preventDefault();
    if (e.scale) { zoomAt(e, gestureScale / e.scale); gestureScale = e.scale; }   // to the point between the fingers
    if (!isFlat()) return;
    const steps = Math.round((e.rotation || 0) / 90);     // snaps at 45°: a quarter turn per quarter spun
    if (steps !== gestureSteps) { orbit.yaw += (steps - gestureSteps) * Math.PI / 2; gestureSteps = steps; }
  });
  el.addEventListener('gestureend', (e) => { e.preventDefault(); gestureScale = 1; });

  // The Mac app hands its trackpad pinch over directly (mac/main.swift magnify): + spreads = closer.
  // It carries no position, so it zooms to where the pointer last was over the view.
  let lastAt = null;
  el.addEventListener('pointermove', (e) => { lastAt = { clientX: e.clientX, clientY: e.clientY }; }, { passive: true });
  window.cadgangPinch = (m) => {
    const r = el.getBoundingClientRect();
    zoomAt(lastAt ?? { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }, Math.exp(-m));
  };

  el.addEventListener('dblclick', (e) => {
    const p = hitAt(e);
    if (!p) return;
    orbit.dist = getCamera().position.distanceTo(p);   // the camera stays put; only the pivot moves
    orbit.target.copy(p);
  });
}
