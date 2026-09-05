/**
 * Server-side raymarched preview of an SDF — no GPU, no browser.
 * Sphere-traces the compiled distance function and shades with a simple
 * two-light + rim model. Returns a PNG buffer (encoder built on node:zlib).
 */

import zlib from 'node:zlib';

export function renderPreview(fn, bounds, opts = {}) {
  const width = Math.max(64, Math.min(1600, opts.width ?? 640));
  const height = Math.max(64, Math.min(1200, opts.height ?? 480));
  const yawDeg = opts.yaw ?? -35;
  const pitchDeg = opts.pitch ?? 25;

  const center = [
    (bounds.min[0] + bounds.max[0]) / 2,
    (bounds.min[1] + bounds.max[1]) / 2,
    (bounds.min[2] + bounds.max[2]) / 2,
  ];
  const radius = Math.hypot(
    bounds.max[0] - bounds.min[0],
    bounds.max[1] - bounds.min[1],
    bounds.max[2] - bounds.min[2]
  ) / 2 || 10;

  const yaw = (yawDeg * Math.PI) / 180;
  const pitch = (pitchDeg * Math.PI) / 180;
  const dist = radius * 2.6;
  const eye = [
    center[0] + dist * Math.cos(pitch) * Math.sin(yaw),
    center[1] + dist * Math.cos(pitch) * Math.cos(yaw) * -1,
    center[2] + dist * Math.sin(pitch),
  ];

  // camera basis (Z-up)
  const fwd = norm3(sub3(center, eye));
  const right = norm3(cross3(fwd, [0, 0, 1]));
  const up = cross3(right, fwd);
  const fov = 0.9;
  const aspect = width / height;

  const maxDist = dist + radius * 3;
  const eps = radius * 1e-3;
  const safety = 0.75; // conservative stepping: SDFs here are only bounded, not exact

  const px = Buffer.alloc(width * height * 3);
  const bgTop = [24, 26, 33], bgBot = [10, 11, 15];

  for (let j = 0; j < height; j++) {
    const v = (1 - (2 * (j + 0.5)) / height) * Math.tan(fov / 2);
    for (let i = 0; i < width; i++) {
      const u = ((2 * (i + 0.5)) / width - 1) * Math.tan(fov / 2) * aspect;
      const dir = norm3([
        fwd[0] + u * right[0] + v * up[0],
        fwd[1] + u * right[1] + v * up[1],
        fwd[2] + u * right[2] + v * up[2],
      ]);

      let t = 0, hit = false;
      for (let s = 0; s < 160 && t < maxDist; s++) {
        const p = [eye[0] + dir[0] * t, eye[1] + dir[1] * t, eye[2] + dir[2] * t];
        const d = fn(p[0], p[1], p[2]);
        if (d < eps) { hit = true; break; }
        t += Math.max(d * safety, eps * 0.5);
      }

      const o = (j * width + i) * 3;
      if (!hit) {
        const g = j / height;
        px[o] = bgTop[0] + (bgBot[0] - bgTop[0]) * g;
        px[o + 1] = bgTop[1] + (bgBot[1] - bgTop[1]) * g;
        px[o + 2] = bgTop[2] + (bgBot[2] - bgTop[2]) * g;
        continue;
      }

      const p = [eye[0] + dir[0] * t, eye[1] + dir[1] * t, eye[2] + dir[2] * t];
      const e = eps * 2;
      const n = norm3([
        fn(p[0] + e, p[1], p[2]) - fn(p[0] - e, p[1], p[2]),
        fn(p[0], p[1] + e, p[2]) - fn(p[0], p[1] - e, p[2]),
        fn(p[0], p[1], p[2] + e) - fn(p[0], p[1], p[2] - e),
      ]);

      const l1 = norm3([0.5, -0.6, 0.65]);
      const l2 = norm3([-0.6, 0.3, -0.2]);
      const d1 = Math.max(dot3(n, l1), 0);
      const d2 = Math.max(dot3(n, l2), 0) * 0.35;
      const rim = Math.pow(1 - Math.max(-dot3(n, dir), 0), 3) * 0.35;
      const spec = Math.pow(Math.max(dot3(reflect(dir, n), l1), 0), 24) * 0.5;
      const amb = 0.16;

      const base = [96, 158, 255]; // cadgang blue
      const L = amb + d1 * 0.85 + d2;
      px[o] = clamp8(base[0] * L + 255 * (spec + rim * 0.6));
      px[o + 1] = clamp8(base[1] * L + 255 * (spec + rim * 0.6));
      px[o + 2] = clamp8(base[2] * L + 255 * (spec + rim));
    }
  }

  return encodePNG(px, width, height);
}

/**
 * Rasterise a tessellated solid: the exact surfaces' own triangles, flat-shaded
 * with a depth buffer, and the B-rep edges drawn over them so a shallow boss
 * or a groove reads as a shape rather than a shade. Replaces raymarching a
 * distance field built from the same mesh, which cost a minute on a thread
 * and scattered marching artefacts around anything curved.
 */
export function renderMesh(mesh, edges, bounds, opts = {}) {
  const width = Math.max(64, Math.min(1600, opts.width ?? 640));
  const height = Math.max(64, Math.min(1200, opts.height ?? 480));
  const cam = camera(bounds, opts, width, height);
  const px = Buffer.alloc(width * height * 3);
  const depth = new Float32Array(width * height).fill(Infinity);
  const bgTop = [24, 26, 33], bgBot = [10, 11, 15];
  for (let j = 0; j < height; j++) {
    const g = j / height;
    for (let i = 0; i < width; i++) {
      const o = (j * width + i) * 3;
      px[o] = bgTop[0] + (bgBot[0] - bgTop[0]) * g;
      px[o + 1] = bgTop[1] + (bgBot[1] - bgTop[1]) * g;
      px[o + 2] = bgTop[2] + (bgBot[2] - bgTop[2]) * g;
    }
  }

  const P = mesh.positions; const I = mesh.indices;
  const nVerts = P.length / 3;
  const sx = new Float32Array(nVerts), sy = new Float32Array(nVerts), sz = new Float32Array(nVerts);
  for (let v = 0; v < nVerts; v++) {
    const [x, y, z] = cam.project([P[3 * v], P[3 * v + 1], P[3 * v + 2]]);
    sx[v] = x; sy[v] = y; sz[v] = z;
  }
  const l1 = norm3([0.5, -0.6, 0.65]);
  const l2 = norm3([-0.6, 0.3, -0.2]);
  const base = [96, 158, 255];
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t], b = I[t + 1], c = I[t + 2];
    if (sz[a] <= 0 || sz[b] <= 0 || sz[c] <= 0) continue;
    const pa = [P[3 * a], P[3 * a + 1], P[3 * a + 2]];
    const pb = [P[3 * b], P[3 * b + 1], P[3 * b + 2]];
    const pc = [P[3 * c], P[3 * c + 1], P[3 * c + 2]];
    let n = norm3(cross3(sub3(pb, pa), sub3(pc, pa)));
    // Shade both sides the same: a face seen from behind is still that face.
    if (dot3(n, cam.fwd) > 0) n = [-n[0], -n[1], -n[2]];
    const d1 = Math.max(dot3(n, l1), 0);
    const d2 = Math.max(dot3(n, l2), 0) * 0.35;
    const rim = Math.pow(1 - Math.max(-dot3(n, cam.fwd), 0), 3) * 0.35;
    const spec = Math.pow(Math.max(dot3(reflect(cam.fwd, n), l1), 0), 24) * 0.5;
    const L = 0.16 + d1 * 0.85 + d2;
    const col = [
      clamp8(base[0] * L + 255 * (spec + rim * 0.6)),
      clamp8(base[1] * L + 255 * (spec + rim * 0.6)),
      clamp8(base[2] * L + 255 * (spec + rim)),
    ];
    rasterTriangle(px, depth, width, height, [sx[a], sy[a], sz[a]], [sx[b], sy[b], sz[b]], [sx[c], sy[c], sz[c]], col);
  }

  // Edges: the B-rep's own curves, drawn where they are not behind a surface.
  const lines = edges?.lines || [];
  const dark = [10, 12, 18];
  for (let k = 0; k + 5 < lines.length; k += 6) {
    const p = cam.project([lines[k], lines[k + 1], lines[k + 2]]);
    const q = cam.project([lines[k + 3], lines[k + 4], lines[k + 5]]);
    if (p[2] <= 0 || q[2] <= 0) continue;
    rasterLine(px, depth, width, height, p, q, dark, cam.radius * 4e-3);
  }
  return encodePNG(px, width, height);
}

/** The camera renderPreview uses, as a projector: world point -> [x, y, depth] in pixels. */
function camera(bounds, opts, width, height) {
  const yawDeg = opts.yaw ?? -35;
  const pitchDeg = opts.pitch ?? 25;
  const center = [0, 1, 2].map((k) => (bounds.min[k] + bounds.max[k]) / 2);
  const radius = Math.hypot(...[0, 1, 2].map((k) => bounds.max[k] - bounds.min[k])) / 2 || 10;
  const yaw = (yawDeg * Math.PI) / 180;
  const pitch = (pitchDeg * Math.PI) / 180;
  const dist = radius * 2.6;
  const eye = [
    center[0] + dist * Math.cos(pitch) * Math.sin(yaw),
    center[1] + dist * Math.cos(pitch) * Math.cos(yaw) * -1,
    center[2] + dist * Math.sin(pitch),
  ];
  const fwd = norm3(sub3(center, eye));
  const right = norm3(cross3(fwd, [0, 0, 1]));
  const up = cross3(right, fwd);
  const fov = 0.9;
  const aspect = width / height;
  const tanHalf = Math.tan(fov / 2);
  return {
    eye, fwd, radius,
    project(p) {
      const d = sub3(p, eye);
      const z = dot3(d, fwd);
      if (z <= 1e-9) return [0, 0, -1];
      const u = dot3(d, right) / z / (tanHalf * aspect);
      const v = dot3(d, up) / z / tanHalf;
      return [((u + 1) / 2) * width, ((1 - v) / 2) * height, z];
    },
  };
}

function rasterTriangle(px, depth, width, height, a, b, c, col) {
  const minX = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0])));
  const maxX = Math.min(width - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
  const minY = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1])));
  const maxY = Math.min(height - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
  if (minX > maxX || minY > maxY) return;
  const area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  if (Math.abs(area) < 1e-12) return;
  for (let y = minY; y <= maxY; y++) {
    const py = y + 0.5;
    for (let x = minX; x <= maxX; x++) {
      const pxx = x + 0.5;
      const w0 = ((b[0] - pxx) * (c[1] - py) - (b[1] - py) * (c[0] - pxx)) / area;
      const w1 = ((c[0] - pxx) * (a[1] - py) - (c[1] - py) * (a[0] - pxx)) / area;
      const w2 = 1 - w0 - w1;
      if (w0 < 0 || w1 < 0 || w2 < 0) continue;
      const z = w0 * a[2] + w1 * b[2] + w2 * c[2];
      const idx = y * width + x;
      if (z >= depth[idx]) continue;
      depth[idx] = z;
      const o = idx * 3;
      px[o] = col[0]; px[o + 1] = col[1]; px[o + 2] = col[2];
    }
  }
}

function rasterLine(px, depth, width, height, p, q, col, bias) {
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(q[0] - p[0]), Math.abs(q[1] - p[1]))));
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const x = Math.round(p[0] + (q[0] - p[0]) * t);
    const y = Math.round(p[1] + (q[1] - p[1]) * t);
    if (x < 0 || y < 0 || x >= width || y >= height) continue;
    const z = p[2] + (q[2] - p[2]) * t;
    const idx = y * width + x;
    if (z > depth[idx] + bias) continue;
    const o = idx * 3;
    px[o] = col[0]; px[o + 1] = col[1]; px[o + 2] = col[2];
  }
}

const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm3 = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const reflect = (d, n) => { const k = 2 * dot3(d, n); return [d[0] - k * n[0], d[1] - k * n[1], d[2] - k * n[2]]; };
const clamp8 = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

// ------------------------------------------------------------- PNG encoder

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

export function encodePNG(rgb, width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // color type: truecolor
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let j = 0; j < height; j++) {
    raw[j * (1 + width * 3)] = 0; // filter: none
    rgb.copy(raw, j * (1 + width * 3) + 1, j * width * 3, (j + 1) * width * 3);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
