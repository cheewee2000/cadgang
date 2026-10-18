/** Triangle/vertex counts, enclosed volume and surface area of a mesh. */
export function meshStats(positions, indices, bounds, dims) {
  const triangleCount = indices.length / 3;
  const vertexCount = positions.length / 3;
  // Signed volume + area via divergence theorem over triangles
  let volume = 0, area = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
    const ax = positions[a], ay = positions[a + 1], az = positions[a + 2];
    const bx = positions[b], by = positions[b + 1], bz = positions[b + 2];
    const cx = positions[c], cy = positions[c + 1], cz = positions[c + 2];
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    const nxv = uy * vz - uz * vy, nyv = uz * vx - ux * vz, nzv = ux * vy - uy * vx;
    area += Math.hypot(nxv, nyv, nzv) / 2;
    volume += (ax * nxv + ay * nyv + az * nzv) / 6;
  }
  return {
    vertexCount,
    triangleCount,
    volume: Math.abs(volume),
    surfaceArea: area,
    bounds,
    gridDims: dims,
  };
}
