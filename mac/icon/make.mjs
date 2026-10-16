#!/usr/bin/env node
/**
 * The cadgang icon: an open isometric box — the enclosure body — drawn as the Silhouette Icon Bench draws it (black glyph on
 * pure white, hand-wobbled). The polygons here ARE the bench entry
 * (`--polys` prints it for api.php); roughD/normFor are ported from the bench
 * so this file renders the identical glyph offline.
 *
 * Writes: mac/AppIcon.icon/ (Icon Composer bundle), mac/AppIcon.iconset/*.png,
 *         web/favicon-16x16.png, web/favicon-32x32.png, web/apple-touch-icon.png,
 *         mac/icon/cadgang.svg. build.sh turns the iconset into AppIcon.icns.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const f1 = (v) => Math.round(v * 10) / 10;

// ── the glyph, in the bench's 100×100 space (y down) ─────────────────────
// An open box — the enclosure body every product here starts from — in
// isometric: the hexagonal outline, and the opening of the top face as a hole.
const ux = [0.866, -0.5], vx = [-0.866, -0.5]; // isometric right / left axes
const O = [50, 78], a = 28, b = 20, h = 26, wall = 3.5;
const P = (x, y, z) => [f1(O[0] + x * ux[0] + y * vx[0]), f1(O[1] + x * ux[1] + y * vx[1] - z)];
const outline = [P(0, 0, 0), P(a, 0, 0), P(a, 0, h), P(a, b, h), P(0, b, h), P(0, b, 0)];
const opening = [P(wall, wall, h), P(a - wall, wall, h), P(a - wall, b - wall, h), P(wall, b - wall, h)];
export const ICON = { id: 'cadgang', name: 'cadgang', by: 'claude', kind: 'rough', seed: 7, amp: 0.3, ts: Date.now(), polys: [outline, opening] };

// ── ported from the bench (index.html): rngFor, resampleClosed, smoothClosedD, roughD, normFor ──
function rngFor(seed) {
  let t = seed >>> 0;
  return () => { t += 0x6D2B79F5; let r = Math.imul(t ^ (t >>> 15), 1 | t); r ^= r + Math.imul(r ^ (r >>> 7), 61 | r); return ((r ^ (r >>> 14)) >>> 0) / 4294967296; };
}
function resampleClosed(pts, step) {
  let per = 0; const segs = [];
  for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; const len = Math.hypot(q[0] - p[0], q[1] - p[1]); segs.push(len); per += len; }
  if (per < 1) return pts.slice();
  const n = Math.max(16, Math.round(per / step)); const out = []; let acc = 0, si = 0;
  for (let k = 0; k < n; k++) {
    const target = (per * k) / n;
    while (si < segs.length - 1 && acc + segs[si] < target) { acc += segs[si]; si++; }
    const p = pts[si], q = pts[(si + 1) % pts.length]; const t = segs[si] > 0 ? (target - acc) / segs[si] : 0;
    out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
  }
  return out;
}
function smoothClosedD(pts) {
  const n = pts.length; const mid = (p, q) => `${f1((p[0] + q[0]) / 2)} ${f1((p[1] + q[1]) / 2)}`;
  let d = 'M' + mid(pts[0], pts[1]);
  for (let i = 1; i <= n; i++) { const cur = pts[i % n], nxt = pts[(i + 1) % n]; d += `Q${f1(cur[0])} ${f1(cur[1])} ${mid(cur, nxt)}`; }
  return d + 'Z';
}
function roughD(polys, seed, amp) {
  const rand = rngFor(seed || 1); const parts = [];
  for (const poly of polys) {
    const pts = resampleClosed(poly, 3);
    const j = pts.map((pt) => [pt[0] + (rand() - 0.5) * 2 * amp, pt[1] + (rand() - 0.5) * 2 * amp]);
    const n = j.length;
    parts.push(smoothClosedD(j.map((pt, i) => { const pr = j[(i - 1 + n) % n], nx = j[(i + 1) % n]; return [pr[0] * 0.25 + pt[0] * 0.5 + nx[0] * 0.25, pr[1] * 0.25 + pt[1] * 0.5 + nx[1] * 0.25]; })));
  }
  return parts.join(' ');
}
function normFor(icon, fit = 48) {
  let minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9;
  for (const poly of icon.polys) for (const p of poly) { minx = Math.min(minx, p[0]); maxx = Math.max(maxx, p[0]); miny = Math.min(miny, p[1]); maxy = Math.max(maxy, p[1]); }
  return { s: fit / Math.max(1, maxx - minx, maxy - miny), cx: (minx + maxx) / 2, cy: (miny + maxy) / 2 };
}

/** The bench's exportIcon() SVG: white square, black glyph. `fit` is the glyph's extent out of 100. */
export function svgFor(icon, { fit = 48, size = 512 } = {}) {
  const d = roughD(icon.polys, icon.seed, icon.amp);
  const t = normFor(icon, fit);
  const tf = `translate(50 50) scale(${t.s.toFixed(3)}) translate(${(-t.cx).toFixed(1)} ${(-t.cy).toFixed(1)})`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="${size}" height="${size}">` +
    `<rect x="0" y="0" width="100" height="100" fill="#ffffff"/>` +
    `<g transform="${tf}"><path d="${d}" fill="#111111" fill-rule="evenodd"/></g></svg>`;
}

if (process.argv.includes('--polys')) {
  process.stdout.write(JSON.stringify(ICON));
} else if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = (p) => path.join(ROOT, p);
  // Icon Composer bundle: the glyph larger (fit 62) since the squircle mask eats the margin.
  fs.mkdirSync(out('mac/AppIcon.icon/Assets'), { recursive: true });
  fs.writeFileSync(out('mac/AppIcon.icon/Assets/cadgang.svg'), svgFor(ICON, { fit: 62, size: 1024 }));
  const white = 'srgb:1.00000,1.00000,1.00000,1.00000';
  fs.writeFileSync(out('mac/AppIcon.icon/icon.json'), JSON.stringify({
    fill: { solid: white },
    'fill-specializations': [{ appearance: 'dark', value: { solid: white } }, { appearance: 'tinted', value: { solid: white } }],
    groups: [{
      lighting: 'individual', specular: false, shadow: { kind: 'none', opacity: 0 }, translucency: { enabled: false, value: 0 },
      layers: [{ 'image-name': 'cadgang.svg', name: 'cadgang', glass: false, position: { scale: 1, 'translation-in-points': [0, 0] } }],
    }],
    'supported-platforms': { squares: 'shared' },
  }, null, 2) + '\n');
  // The flat SVG (bench export) and PNG sets. qlmanage paints an opaque white background — exactly what this icon is.
  const svgPath = out('mac/icon/cadgang.svg');
  fs.writeFileSync(svgPath, svgFor(ICON, { fit: 56, size: 1024 }));
  const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'cadgang-icon-'));
  execFileSync('qlmanage', ['-t', '-s', '1024', '-o', tmp, svgPath], { stdio: 'ignore' });
  const master = path.join(tmp, 'cadgang.svg.png');
  const resize = (px, dest) => execFileSync('sips', ['-s', 'format', 'png', '-z', String(px), String(px), master, '--out', dest], { stdio: 'ignore' });
  fs.rmSync(out('mac/AppIcon.iconset'), { recursive: true, force: true }); fs.mkdirSync(out('mac/AppIcon.iconset'));
  for (const px of [16, 32, 128, 256, 512]) { resize(px, out(`mac/AppIcon.iconset/icon_${px}x${px}.png`)); resize(px * 2, out(`mac/AppIcon.iconset/icon_${px}x${px}@2x.png`)); }
  resize(16, out('web/favicon-16x16.png')); resize(32, out('web/favicon-32x32.png')); resize(180, out('web/apple-touch-icon.png'));
  resize(48, path.join(tmp, '48.png'));
  execFileSync('magick', [out('web/favicon-16x16.png'), out('web/favicon-32x32.png'), path.join(tmp, '48.png'), out('web/favicon.ico')]);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('wrote mac/AppIcon.icon, mac/AppIcon.iconset, mac/icon/cadgang.svg, web/favicon*');
}
