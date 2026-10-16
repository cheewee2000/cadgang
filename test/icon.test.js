/**
 * The app icon ships both ways macOS wants it: an Icon Composer bundle (the
 * only format that fills the macOS 26 squircle) with the flat, white-pinned
 * settings the house style needs, and PNG sets for favicons and older macOS.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ICON, svgFor } from '../mac/icon/make.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const at = (p) => path.join(ROOT, p);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

test('the glyph is an open box: outline plus opening, black on pure white', () => {
  assert.equal(ICON.polys.length, 2, 'outline + opening');
  const svg = svgFor(ICON);
  assert.match(svg, /fill="#ffffff"/);
  assert.match(svg, /fill-rule="evenodd"/);
  assert.match(svg, /<path d="M[\d. ]+Q/, 'roughened quadratic outline');
});

test('the Icon Composer bundle is flat and pinned white in every appearance', () => {
  const json = JSON.parse(fs.readFileSync(at('mac/AppIcon.icon/icon.json'), 'utf8'));
  const white = 'srgb:1.00000,1.00000,1.00000,1.00000';
  assert.equal(json.fill.solid, white);
  for (const s of json['fill-specializations']) assert.equal(s.value.solid, white);
  const g = json.groups[0];
  assert.equal(g.shadow.kind, 'none'); assert.equal(g.shadow.opacity, 0, 'actool crashes without an explicit opacity');
  assert.equal(g.layers[0].glass, false);
  assert.ok(fs.existsSync(at('mac/AppIcon.icon/Assets/' + g.layers[0]['image-name'])), 'layer image lives in Assets/');
});

test('favicons and the iconset are real PNGs at the sizes the pages link', () => {
  for (const p of ['web/favicon-16x16.png', 'web/favicon-32x32.png', 'web/apple-touch-icon.png', 'mac/AppIcon.iconset/icon_512x512@2x.png']) {
    const head = fs.readFileSync(at(p)).subarray(0, 4);
    assert.ok(head.equals(PNG), `${p} is a PNG`);
  }
  assert.ok(fs.readFileSync(at('web/favicon.ico')).length > 1000);
  for (const page of ['web/view.html', 'web/cells.html']) assert.match(fs.readFileSync(at(page), 'utf8'), /apple-touch-icon\.png/);
});
