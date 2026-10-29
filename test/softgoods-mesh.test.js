import test from 'node:test';
import assert from 'node:assert/strict';
import { SoftgoodsDocument } from '../src/core/softgoods-document.js';
import { meshPattern } from '../src/core/softgoods-mesh.js';

const area = (m) => { let a = 0; for (let i = 0; i < m.triangles.length; i += 3) { const ids = m.triangles.slice(i, i + 3), p = ids.map((n) => [m.uv[n * 2], m.uv[n * 2 + 1]]); a += Math.abs((p[1][0] - p[0][0]) * (p[2][1] - p[0][1]) - (p[1][1] - p[0][1]) * (p[2][0] - p[0][0])) / 2; } return a; };

test('pattern mesh conforms to a rectangle boundary and preserves segment chains', () => {
  const d = new SoftgoodsDocument(null); d.addRectangle({ id: 'panel', width: 200, height: 100 });
  const m = meshPattern(d.toJSON().patterns[0], { target: 35 });
  assert.ok(m.uv.length / 2 >= 4); assert.ok(m.triangles.length >= 6);
  assert.ok(Math.abs(area(m) - 20000) < 1e-6, `area ${area(m)}`);
  for (const id of ['panel_bottom', 'panel_right', 'panel_top', 'panel_left']) assert.ok(m.segmentVertices[id].length >= 2, id);
});

test('seam chains cover every refined vertex along a straight edge, in order', () => {
  const d = new SoftgoodsDocument(null); d.addRectangle({ id: 'panel', width: 200, height: 150 });
  const m = meshPattern(d.toJSON().patterns[0], { target: 30 }), right = m.segmentVertices.panel_right.map((i) => [m.uv[i * 2], m.uv[i * 2 + 1]]);
  const onRight = [...Array(m.uv.length / 2).keys()].filter((i) => m.uv[i * 2] === 200);
  assert.equal(right.length, onRight.length, 'every vertex on the edge is in its chain'); assert.ok(right.length > 2);
  for (let i = 1; i < right.length; i++) assert.ok(right[i][1] > right[i - 1][1], 'ordered along the edge');
  assert.equal(right[0][1], 0); assert.equal(right.at(-1)[1], 150);
  const onBoundary = [...Array(m.uv.length / 2).keys()].filter((i) => [0, 200].includes(m.uv[i * 2]) || [0, 150].includes(m.uv[i * 2 + 1]));
  assert.equal(m.boundaryCount, onBoundary.length);
});

test('curved pattern boundaries are sampled before triangulation', () => {
  const p = { id: 'round', points: [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 100, y: 0 }, { id: 'c', x: 100, y: 100 }, { id: 'd', x: 0, y: 100 }, { id: 'bc', x: 100, y: 50 }], segments: [{ id: 'bottom', type: 'line', a: 'a', b: 'b' }, { id: 'roundEdge', type: 'arc', a: 'b', b: 'c', c: 'bc' }, { id: 'top', type: 'line', a: 'c', b: 'd' }, { id: 'left', type: 'line', a: 'd', b: 'a' }], contours: [['bottom', 'roundEdge', 'top', 'left']], allowances: {}, notches: [], grain: { angle: 90 }, internalLines: [] };
  const m = meshPattern(p, { target: 30, curveStep: 10 });
  assert.ok(m.segmentVertices.roundEdge.length > 3);
  assert.ok(m.triangles.length > 6);
});

test('simulation mesher refuses holes until constrained triangulation supports them', () => {
  const d = new SoftgoodsDocument(null); d.addRectangle({ id: 'panel' }); const p = d.toJSON().patterns[0]; p.contours.push([...p.contours[0]]);
  assert.throws(() => meshPattern(p), /one outer contour and no holes/);
});
