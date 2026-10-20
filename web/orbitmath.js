/**
 * The orbit camera's geometry, shared by the viewer and its tests. The orbit is a target, a
 * distance, a yaw about world Z and a pitch over the horizon: the camera sits at
 * target + dist · (cos p · sin y, −cos p · cos y, sin p), so yaw 0 looks along +Y (the front).
 */

/** The unit direction from the target to the camera. */
export const offsetOf = (THREE, yaw, pitch) => new THREE.Vector3(Math.cos(pitch) * Math.sin(yaw), -Math.cos(pitch) * Math.cos(yaw), Math.sin(pitch));

/**
 * Turn the orbit by dyaw, dpitch about a world point (null: the target itself), Bambu Studio's
 * way: camera and target swing round the point together, so the point keeps its place on screen.
 * Pitch turns about the orbit's horizontal axis at the current yaw, then yaw about world Z.
 */
export function turnAbout(THREE, orbit, pivot, dyaw, dpitch) {
  if (pivot) {
    const off = orbit.target.clone().sub(pivot);
    off.applyQuaternion(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(Math.cos(orbit.yaw), Math.sin(orbit.yaw), 0), -dpitch));
    off.applyQuaternion(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), dyaw));
    orbit.target.copy(pivot).add(off);
  }
  orbit.yaw += dyaw;
  orbit.pitch += dpitch;
}

/** Yaw and pitch that look from direction `dir` (target → camera); straight up or down keeps the front at the bottom. */
export function yawPitchOf(THREE, dir) {
  const d = dir.clone().normalize();
  const pitch = THREE.MathUtils.clamp(Math.asin(THREE.MathUtils.clamp(d.z, -1, 1)), -Math.PI / 2 + 1e-4, Math.PI / 2 - 1e-4);
  const yaw = Math.hypot(d.x, d.y) < 1e-6 ? 0 : Math.atan2(d.x, -d.y);
  return { yaw, pitch };
}
