import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { NURBSCurve } from 'three/examples/jsm/curves/NURBSCurve.js';
import { parseDxf } from '../web/dxf.js';

const dxf = (pairs) => pairs.map(([c, v]) => `${c}\n${v}`).join('\n') + '\n';
const bounds = (parts) => {
  const b = new THREE.Box3();
  for (const p of parts) for (let i = 0; i < p.lines.length; i += 3) b.expandByPoint(new THREE.Vector3(p.lines[i], p.lines[i + 1], p.lines[i + 2]));
  return b;
};

test('dxf: lines, bulged polyline, circle, arc, block insert, text skipped', () => {
  const text = dxf([
    [0, 'SECTION'], [2, 'BLOCKS'],
    [0, 'BLOCK'], [2, 'B'], [10, 0], [20, 0], [30, 0],
    [0, 'LINE'], [8, '0'], [10, 0], [20, 0], [30, 0], [11, 1], [21, 0], [31, 0],
    [0, 'ENDBLK'], [0, 'ENDSEC'],
    [0, 'SECTION'], [2, 'ENTITIES'],
    [0, 'LINE'], [8, 'OUTLINE'], [10, 0], [20, 0], [30, 0], [11, 10], [21, 0], [31, 0],
    [0, 'LWPOLYLINE'], [8, 'OUTLINE'], [70, 1], [10, 0], [20, 0], [10, 10], [20, 0], [42, 1], [10, 10], [20, 10], // bulge 1 = semicircle
    [0, 'CIRCLE'], [8, 'HOLES'], [10, 5], [20, 5], [40, 2],
    [0, 'ARC'], [8, 'HOLES'], [10, 0], [20, 0], [40, 4], [50, 0], [51, 90],
    [0, 'INSERT'], [8, 'PARTS'], [2, 'B'], [10, 100], [20, 0], [30, 0], [41, 5], [50, 90],   // 5 long, rotated to +Y
    [0, 'TEXT'], [8, 'NOTES'], [10, 0], [20, 0], [1, 'hello'],
    [0, 'ENDSEC'], [0, 'EOF'],
  ]);
  const { parts, skipped } = parseDxf(text, { THREE, NURBSCurve });
  assert.deepEqual(parts.map((p) => p.name).sort(), ['HOLES', 'OUTLINE', 'PARTS']);
  assert.deepEqual(skipped, { TEXT: 1 });
  const holes = bounds(parts.filter((p) => p.name === 'HOLES'));
  assert.ok(Math.abs(holes.max.x - 7) < 1e-6 && Math.abs(holes.min.y - 0) < 1e-6, 'circle r2 at (5,5) and arc r4 bound HOLES');
  const outline = bounds(parts.filter((p) => p.name === 'OUTLINE'));
  assert.ok(outline.max.x > 14.9 && outline.max.x < 15.01, `semicircle bulge reaches x=15, got ${outline.max.x}`);
  const ins = bounds(parts.filter((p) => p.name === 'PARTS'));
  assert.ok(Math.abs(ins.min.x - 100) < 1e-6 && Math.abs(ins.max.y - 5) < 1e-6, 'block scaled 5 and rotated 90° stands up at x=100');
});

test('dxf: no drawable entities → empty parts', () => {
  const { parts } = parseDxf(dxf([[0, 'SECTION'], [2, 'ENTITIES'], [0, 'TEXT'], [1, 'x'], [0, 'ENDSEC'], [0, 'EOF']]), { THREE, NURBSCurve });
  assert.equal(parts.length, 0);
});
