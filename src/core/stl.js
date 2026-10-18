/** Binary STL export from an indexed triangle mesh. */

export function toBinarySTL(positions, indices, name = 'cadgang') {
  const triCount = indices.length / 3;
  const buf = Buffer.alloc(84 + triCount * 50);
  buf.write(`cadgang: ${name}`.slice(0, 79), 0, 'ascii');
  buf.writeUInt32LE(triCount, 80);
  let o = 84;
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
    const ax = positions[a], ay = positions[a + 1], az = positions[a + 2];
    const bx = positions[b], by = positions[b + 1], bz = positions[b + 2];
    const cx = positions[c], cy = positions[c + 1], cz = positions[c + 2];
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    buf.writeFloatLE(nx, o); buf.writeFloatLE(ny, o + 4); buf.writeFloatLE(nz, o + 8);
    buf.writeFloatLE(ax, o + 12); buf.writeFloatLE(ay, o + 16); buf.writeFloatLE(az, o + 20);
    buf.writeFloatLE(bx, o + 24); buf.writeFloatLE(by, o + 28); buf.writeFloatLE(bz, o + 32);
    buf.writeFloatLE(cx, o + 36); buf.writeFloatLE(cy, o + 40); buf.writeFloatLE(cz, o + 44);
    buf.writeUInt16LE(0, o + 48);
    o += 50;
  }
  return buf;
}
