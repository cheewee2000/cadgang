// Pattern-making operations on the softgoods document (src/core/softgoods-edit.js): each is checked for its geometry, for what
// it does to the seams and marks on the edges it changes, and, where it sews something, by draping it with the page's own solver.
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { z } from 'zod';
import { SoftgoodsDocument, validateSoftgoodsDocument, patternLoops } from '../src/core/softgoods-document.js';
import { editSoftgoods, editChanges, SOFTGOODS_EDITS, mirror, unfold, split, dart, pleat, slashSpread, internalLine, autoNotch } from '../src/core/softgoods-edit.js';
import { sampleSegment, segmentLength, patternDXF, cutContours, capDarts } from '../src/core/softgoods-export.js';
import { meshPattern } from '../src/core/softgoods-mesh.js';
import { resolveSeamCorrespondence, seamFraction } from '../src/core/softgoods-seams.js';
import { checkDesign } from '../src/core/softgoods-operations.js';
import { softgoodsRouter } from '../src/server/softgoods.js';
import { registerSoftgoodsTools } from '../src/mcp/softgoods.js';
import { simulate } from '../web/softgoods-worker.js';

const near = (a, b, eps = 1e-6, what = '') => assert.ok(Math.abs(a - b) <= eps, `${what} ${a} is not ${b}`);
const pattern = (d, id) => d.patterns.find((p) => p.id === id), segment = (p, id) => p.segments.find((s) => s.id === id), point = (p, id) => p.points.find((q) => q.id === id);
const length = (p, id) => segmentLength(p, segment(p, id));
const shoelace = (q) => q.reduce((n, a, i) => { const b = q[(i + 1) % q.length]; return n + a[0] * b[1] - b[0] * a[1]; }, 0) / 2;
const area = (p) => { const [outer, ...holes] = patternLoops(p).map((l) => Math.abs(shoelace(l))); return outer - holes.reduce((n, v) => n + v, 0); };
const seam = (d, id) => d.seams.find((s) => s.id === id);

// Two 300 x 400 panels sewn down one side. A rectangle's edges run bottom (left to right), right (up), top (right to left), left (down).
function panels() {
  const doc = new SoftgoodsDocument(null); doc.addRectangle({ id: 'front', width: 300, height: 400 }); doc.addRectangle({ id: 'back', width: 300, height: 400 });
  doc.addSeam({ id: 'side', a: { pattern: 'front', segment: 'front_right' }, b: { pattern: 'back', segment: 'back_left' } });
  return doc.toJSON();
}
// A piece with every kind of edge: straight hems, an arc at one corner, a Bezier neckline, and something of everything else a piece carries.
function yoke() {
  const pts = { bl: [0, 0], br: [200, 0], r: [200, 100], tr: [150, 150], corner: [150, 100], tl: [0, 150], n1: [100, 110], n2: [50, 110], s1: [20, 20], s2: [180, 60] }, id = (k) => `yoke_${k}`;
  return validateSoftgoodsDocument({ version: 1, patterns: [{ id: 'yoke', name: 'Yoke', material: 'canvas', cut: 1, points: Object.entries(pts).map(([k, [x, y]]) => ({ id: id(k), x, y })),
    segments: [{ id: id('bottom'), type: 'line', a: id('bl'), b: id('br') }, { id: id('right'), type: 'line', a: id('br'), b: id('r') }, { id: id('round'), type: 'arc', a: id('r'), b: id('tr'), c: id('corner') },
      { id: id('neck'), type: 'bezier', a: id('tr'), b: id('tl'), c1: id('n1'), c2: id('n2') }, { id: id('left'), type: 'line', a: id('tl'), b: id('bl') }],
    contours: [['bottom', 'right', 'round', 'neck', 'left'].map(id)], allowances: { yoke_bottom: 15, yoke_right: 10, yoke_round: 10, yoke_neck: 10, yoke_left: 10 },
    notches: [{ segment: 'yoke_neck', at: 0.25, depth: 4 }, { segment: 'yoke_bottom', at: 0.3, depth: 4 }], grain: { angle: 30 }, internalLines: [{ id: 'yoke_stitch', type: 'line', a: 'yoke_s1', b: 'yoke_s2' }] }],
    annotations: [{ id: 'yoke_crease', type: 'fold_line', pattern: 'yoke', lines: [['yoke_s1', 'yoke_s2']] }],
    grades: [{ size: 'L', rules: [{ pattern: 'yoke', point: 'yoke_br', dx: 10, dy: 0 }, { pattern: 'yoke', point: 'yoke_r', dx: 10, dy: 5 }] }] });
}
// Drape a design over a dome with the page's solver and report how far apart each seam's two sides are, before and after.
function drape(d, { target = 20, steps = 240, place = () => [0, 0, 505] } = {}) {
  const meshes = d.patterns.map((p) => meshPattern(p, { target })), seams = resolveSeamCorrespondence(d.seams, meshes, { spacing: target / 2 });
  const input = { meshes, seams, attachments: [], arrangement: d.patterns.map((p, i) => ({ pattern: p.id, position: place(p, i), rotation: [0, 0, 0] })), materials: { canvas: { arealDensity: 200, thickness: 0.4 } }, patterns: d.patterns, collisionBody: { shapes: [{ type: 'ellipsoid', c: [150, 200, 300], r: [260, 320, 200] }] } };
  const gap = (frame) => { const off = Object.fromEntries(frame.pieces.map((p) => [p.id, p.off])), at = (side, o) => side.vertices.reduce((q, v, k) => q.map((x, j) => x + frame.positions[(o + v) * 3 + j] * side.weights[k]), [0, 0, 0]);
    return Object.fromEntries(seams.map((s) => [s.id, Math.max(...s.pairs.map((pair) => { const a = at(pair.a, off[s.a.pattern]), b = at(pair.b, off[s.b.pattern]); return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); }))])); };
  const start = gap(simulate(input, 0)), frame = simulate(input, steps);
  assert.ok(frame.positions.every(Number.isFinite), 'the drape stays finite');
  return { start, end: gap(frame), strain: Math.max(...frame.strain.map(Math.abs)) };
}

test('mirror makes the other hand of a piece: curves, handles, notches, grain and marks all turn over, and the original is untouched', () => {
  const before = yoke(), kept = JSON.stringify(before), d = mirror(before, { pattern: 'yoke' }), a = pattern(d, 'yoke'), b = pattern(d, 'yoke_mirror');
  assert.equal(JSON.stringify(before), kept, 'the document passed in is not changed'); assert.deepEqual(d.patterns.map((p) => p.id), ['yoke', 'yoke_mirror']);
  near(area(b), area(a), 1e-6, 'area'); assert.equal(Math.sign(shoelace(patternLoops(b)[0])), Math.sign(shoelace(patternLoops(a)[0])), 'the copy winds the way the original does');
  // The default axis is the vertical through the middle of the piece: x becomes 200 - x.
  for (const q of a.points) { const m = point(b, q.id.replace('yoke_', 'yoke_mirror_')); near(m.x, 200 - q.x); near(m.y, q.y); }
  const neck = segment(b, 'yoke_mirror_neck'); assert.deepEqual([neck.a, neck.b, neck.c1, neck.c2], ['yoke_mirror_tl', 'yoke_mirror_tr', 'yoke_mirror_n2', 'yoke_mirror_n1'], 'a reversed Bezier swaps its handles');
  // Every edge of the copy is the mirror image of the original's, read from the other end: that holds for the arc only if it still runs counter-clockwise.
  for (const s of a.segments) { const own = sampleSegment(a, s, 16), twin = sampleSegment(b, segment(b, s.id.replace('yoke_', 'yoke_mirror_')), 16).reverse(); own.forEach((q, i) => { near(twin[i][0], 200 - q[0], 1e-9, s.id); near(twin[i][1], q[1], 1e-9, s.id); }); }
  assert.deepEqual(b.contours[0], ['left', 'neck', 'round', 'right', 'bottom'].map((k) => `yoke_mirror_${k}`));
  assert.equal(b.allowances.yoke_mirror_bottom, 15); assert.deepEqual(b.notches.map((n) => [n.segment, n.at]), [['yoke_mirror_neck', 0.75], ['yoke_mirror_bottom', 0.7]]);
  assert.equal(b.grain.angle, 150); assert.deepEqual(b.internalLines, [{ id: 'yoke_mirror_stitch', type: 'line', a: 'yoke_mirror_s2', b: 'yoke_mirror_s1' }]);
  assert.deepEqual(d.annotations[1], { id: 'yoke_mirror_crease', type: 'fold_line', pattern: 'yoke_mirror', lines: [['yoke_mirror_s1', 'yoke_mirror_s2']] });
  assert.deepEqual(d.grades[0].rules.filter((r) => r.pattern === 'yoke_mirror'), [{ pattern: 'yoke_mirror', point: 'yoke_mirror_br', dx: -10, dy: 0 }, { pattern: 'yoke_mirror', point: 'yoke_mirror_r', dx: -10, dy: 5 }], 'a graded size grows the copy the other way');
  assert.ok(meshPattern(b, { target: 20 }).triangles.length > 0); assert.match(patternDXF(b, d.annotations.filter((q) => q.pattern === b.id)), /\n8\nINTERNAL\n/);
});

test('mirror across a segment can sew the copy to the original there, and a left piece becomes a right one', () => {
  const base = panels(); base.patterns[0].placement = { region: 'left', offset: [5, 0, 0] };
  const d = mirror(base, { pattern: 'front', segment: 'front_left', id: 'front_right_half', seam: true }), b = pattern(d, 'front_right_half');
  assert.deepEqual([Math.min(...b.points.map((q) => q.x)), Math.max(...b.points.map((q) => q.x))], [-300, 0], 'it lies on the other side of the mirror edge');
  assert.deepEqual(b.placement, { region: 'right', offset: [-5, 0, 0] });
  assert.deepEqual(seam(d, 'front_left_seam'), { id: 'front_left_seam', a: { pattern: 'front', segment: 'front_left' }, b: { pattern: 'front_right_half', segment: 'front_right_half_left' }, flip: true, ease: 0, kind: 'plain', correspondence: [] });
  assert.ok(checkDesign(d).ok); assert.equal(d.seams.length, 2, 'the seam to the back is not copied: the copy sews to other edges');
  // The seam joins the same places on both pieces: its resolved pairs start coincident.
  const meshes = d.patterns.map((p) => meshPattern(p, { target: 40 })), [pairs] = resolveSeamCorrespondence([seam(d, 'front_left_seam')], meshes, { spacing: 40 }).map((s) => s.pairs);
  for (const pair of pairs) { const at = (side, m) => side.vertices.reduce((q, v, k) => [q[0] + m.uv[v * 2] * side.weights[k], q[1] + m.uv[v * 2 + 1] * side.weights[k]], [0, 0]), p = at(pair.a, meshes[0]), q = at(pair.b, meshes[1]); near(p[0], q[0]); near(p[1], q[1]); }
  assert.throws(() => mirror(base, { pattern: 'front', id: 'back' }), /already exists/); assert.throws(() => mirror(base, { pattern: 'front', seam: true }), /give segment/);
  // A dart belongs to its piece: the copy has it too, sewn.
  const darted = mirror(dart(base, { pattern: 'front', segment: 'front_top', width: 40, length: 100, id: 'bust' }), { pattern: 'front' });
  assert.deepEqual(seam(darted, 'front_mirror_bust').a, { pattern: 'front_mirror', segment: 'bust_leg_a' }, 'ids that do not carry the piece\'s name are only unique within a piece, and stay'); assert.ok(checkDesign(darted).ok);
  assert.equal(cutContours(capDarts(pattern(darted, 'front_mirror'), darted.annotations))[0].length, cutContours(capDarts(pattern(darted, 'front'), darted.annotations))[0].length, 'the copy is cut across its dart as the original is');
});

test('unfold turns a half cut on the fold into the whole piece: the fold goes, and everything on the half appears again mirrored', () => {
  const half = yoke(); half.constraints.push({ id: 'centre', name: 'Centre front', type: 'length', pattern: 'yoke', segments: ['yoke_left'], target: 150, tolerance: 1 });
  const d = unfold(half, { pattern: 'yoke', segment: 'yoke_left' }), p = pattern(d, 'yoke'), was = pattern(half, 'yoke');
  near(area(p), 2 * area(was), 1e-6, 'area'); assert.ok(!segment(p, 'yoke_left'), 'the fold is no longer an edge'); assert.ok(!('yoke_left' in p.allowances));
  assert.deepEqual(p.contours, [['yoke_bottom', 'yoke_right', 'yoke_round', 'yoke_neck', 'yoke_neck_m', 'yoke_round_m', 'yoke_right_m', 'yoke_bottom_m']]);
  // Symmetric about the fold (x = 0): every point has its twin, and the two fold ends are their own.
  for (const q of was.points) { const m = point(p, q.x ? `${q.id}_m` : q.id); near(m.x, -q.x); near(m.y, q.y); }
  assert.equal(p.points.length, 2 * was.points.length - 2);
  for (const id of ['yoke_bottom', 'yoke_round', 'yoke_neck']) near(length(p, `${id}_m`), length(p, id), 1e-9, id);
  assert.equal(p.allowances.yoke_bottom_m, 15); assert.deepEqual(p.notches.slice(2).map((n) => [n.segment, n.at]), [['yoke_neck_m', 0.75], ['yoke_bottom_m', 0.7]]);
  assert.deepEqual(p.internalLines[1], { id: 'yoke_stitch_m', type: 'line', a: 'yoke_s2_m', b: 'yoke_s1_m' }); assert.equal(d.annotations[1].id, 'yoke_crease_m'); assert.equal(p.grain.angle, 30);
  assert.deepEqual(d.grades[0].rules.find((r) => r.point === 'yoke_br_m'), { pattern: 'yoke', point: 'yoke_br_m', dx: -10, dy: 0 });
  const centre = checkDesign(d).constraints[0]; assert.equal(centre.type, 'distance'); assert.equal(centre.measured, 150); assert.ok(centre.withinTolerance, 'the fold length is still measured, between its two ends');
  const mesh = meshPattern(p, { target: 20 }); let meshed = 0; for (let i = 0; i < mesh.triangles.length; i += 3) meshed += Math.abs(shoelace([0, 1, 2].map((k) => [mesh.uv[mesh.triangles[i + k] * 2], mesh.uv[mesh.triangles[i + k] * 2 + 1]])));
  assert.ok(Math.abs(meshed - area(p)) < 0.01 * area(p), 'the whole piece meshes');
  assert.match(patternDXF(p, d.annotations), /\n8\nCUT\n/);
});

test('unfolding two halves that are sewn to each other sews the new halves the same way; a sewn edge is not a fold', () => {
  const base = panels(), one = unfold(base, { pattern: 'front', segment: 'front_left' });
  assert.equal(one.seams.length, 1, 'the back has no mirrored edge yet');
  const both = unfold(one, { pattern: 'back', segment: 'back_right' });
  assert.deepEqual(seam(both, 'side_m'), { ...seam(both, 'side'), id: 'side_m', a: { pattern: 'front', segment: 'front_right_m' }, b: { pattern: 'back', segment: 'back_left_m' } });
  assert.ok(checkDesign(both).ok); assert.equal(unfold(both, { pattern: 'front', segment: 'front_top' }).seams.length, 2, 'nothing is sewn twice');
  assert.throws(() => unfold(base, { pattern: 'front', segment: 'front_right' }), /sewn by seam 'side'/); assert.throws(() => unfold(yoke(), { pattern: 'yoke', segment: 'yoke_neck' }), /straight segment/);
});

test('split cuts a piece in two along a line: the cut edges are sewn to each other and every seam, mark and measurement follows its edge', () => {
  const base = panels(), front = base.patterns[0];
  front.notches.push({ segment: 'front_right', at: 0.9, depth: 4 }); base.grades.push({ size: 'L', rules: [{ pattern: 'front', point: 'front_tr', dx: 0, dy: 20 }, { pattern: 'front', point: 'front_br', dx: 8, dy: 0 }] });
  base.constraints.push({ id: 'hem', type: 'length', pattern: 'front', segments: ['front_bottom'], target: 300, tolerance: 1 }, { id: 'rise', type: 'distance', a: { pattern: 'front', point: 'front_bl' }, b: { pattern: 'front', point: 'front_tl' }, target: 400, tolerance: 1 });
  base.annotations.push({ id: 'crease', type: 'fold_line', pattern: 'front', lines: [['front_tl', 'front_tr']] }); base.attachments.push({ id: 'tack', pattern: 'front', at: [150, 380], to: [0, 0, 500] });
  const kept = JSON.stringify(base), d = split(base, { pattern: 'front', from: { segment: 'front_left', at: 0.25 }, to: { segment: 'front_right', at: 0.75 }, allowance: 8 }), a = pattern(d, 'front_a'), b = pattern(d, 'front_b');
  assert.equal(JSON.stringify(base), kept); assert.deepEqual(d.patterns.map((p) => p.id), ['front_a', 'front_b', 'back']);
  near(area(a), 300 * 300); near(area(b), 300 * 100); assert.deepEqual(a.contours, [['front_left_2', 'front_bottom', 'front_right', 'front_cut']]); assert.deepEqual(b.contours, [['front_right_2', 'front_top', 'front_left', 'front_cut']]);
  assert.deepEqual(point(a, 'front_cut_b'), { id: 'front_cut_b', x: 300, y: 300 }); assert.deepEqual(point(b, 'front_cut_a'), { id: 'front_cut_a', x: 0, y: 300 }); assert.ok(point(a, 'front_bl') && !point(b, 'front_bl'), 'points keep their ids and go with their piece');
  assert.deepEqual(seam(d, 'front_cut'), { id: 'front_cut', a: { pattern: 'front_a', segment: 'front_cut' }, b: { pattern: 'front_b', segment: 'front_cut' }, flip: true, ease: 0, kind: 'plain', correspondence: [] });
  assert.equal(a.allowances.front_cut, 8); assert.equal(b.allowances.front_cut, 8); assert.equal(a.allowances.front_left_2, 10);
  // The side seam was sewn to the whole right edge: now each part of that edge is sewn to its own part of the back.
  assert.deepEqual([seam(d, 'side').a, seam(d, 'side').b], [{ pattern: 'front_a', segment: 'front_right' }, { pattern: 'back', segment: 'back_left_2' }]);
  assert.deepEqual([seam(d, 'side_2').a, seam(d, 'side_2').b], [{ pattern: 'front_b', segment: 'front_right_2' }, { pattern: 'back', segment: 'back_left' }]);
  const check = checkDesign(d); assert.deepEqual(check.seams.map((s) => [s.id, s.lengthA, s.lengthB, s.ok]), [['side', 300, 300, true], ['side_2', 100, 100, true], ['front_cut', 300, 300, true]]);
  near(point(pattern(d, 'back'), 'back_left_split').y, 300, 1e-9, 'the back is cut where the front is');
  assert.deepEqual(b.notches, [{ segment: 'front_right_2', at: 0.6, depth: 4 }], 'a notch stays where it was on the cloth');
  assert.equal(d.constraints[0].pattern, 'front_a'); assert.deepEqual([d.constraints[1].a.pattern, d.constraints[1].b.pattern], ['front_a', 'front_b']); assert.ok(check.constraints.every((c) => c.withinTolerance));
  assert.equal(d.annotations[0].pattern, 'front_b'); assert.equal(d.attachments[0].pattern, 'front_b');
  const rules = d.grades[0].rules; assert.deepEqual(rules.filter((r) => r.point === 'front_tr').map((r) => r.pattern), ['front_b']); assert.deepEqual(rules.filter((r) => r.point === 'front_br').map((r) => r.pattern), ['front_a']);
  assert.deepEqual(rules.find((r) => r.point === 'front_cut_b' && r.pattern === 'front_a'), { pattern: 'front_a', point: 'front_cut_b', dx: 2, dy: 15 }, 'a graded size moves the cut end as far as its place on the edge says, in both pieces');
  assert.ok(rules.some((r) => r.point === 'front_cut_b' && r.pattern === 'front_b')); assert.ok(check.sizes[0].seams.find((s) => s.id === 'front_cut').ok, 'so the cut still sews at size L');
  assert.deepEqual(d.arrangement.map((r) => r.pattern), ['front_a', 'front_b', 'back']); assert.deepEqual(d.arrangement[0].position, d.arrangement[1].position, 'both halves stay where the piece stood');
});

test('split takes point ids and names, refuses a cut that leaves the cloth or orphans a measurement, and its seam closes in the drape', () => {
  const base = panels(), d = split(base, { pattern: 'front', from: 'front_bl', to: 'front_tr', ids: ['front', 'front_corner'], names: ['Front', 'Front corner'] });
  assert.deepEqual(d.patterns.map((p) => [p.id, p.name, p.segments.length]), [['front', 'Front', 3], ['front_corner', 'Front corner', 3], ['back', 'back', 4]]);
  near(area(pattern(d, 'front')), 60000); near(area(pattern(d, 'front_corner')), 60000); assert.equal(seam(d, 'side').a.pattern, 'front', 'bottom and right are the run from bl round to tr');
  assert.throws(() => split(base, { pattern: 'front', from: 'front_bl', to: 'front_br' }), /runs along the edge|leaves the material/);
  assert.throws(() => split(base, { pattern: 'front', from: 'front_bl', to: 'front_bl' }), /two different points/);
  const measured = { ...base, constraints: [{ id: 'around', type: 'length', pattern: 'front', contour: 0, target: 1400 }] };
  assert.throws(() => split(measured, { pattern: 'front', from: 'front_bl', to: 'front_tr' }), /Constraint 'around' measures edges on both sides/);
  // An L-shaped piece: the straight line between its two far corners runs outside it.
  const ell = validateSoftgoodsDocument({ version: 1, patterns: [{ id: 'ell', points: [[0, 0], [300, 0], [300, 100], [100, 100], [100, 300], [0, 300]].map(([x, y], i) => ({ id: `p${i}`, x, y })), segments: [0, 1, 2, 3, 4, 5].map((i) => ({ id: `s${i}`, type: 'line', a: `p${i}`, b: `p${(i + 1) % 6}` })), contours: [[0, 1, 2, 3, 4, 5].map((i) => `s${i}`)] }] });
  assert.throws(() => split(ell, { pattern: 'ell', from: 'p2', to: 'p4' }), /leaves the material/); assert.equal(split(ell, { pattern: 'ell', from: 'p3', to: 'p0' }).patterns.length, 2);
  // Two halves of a panel laid 40 mm apart over a dome are drawn together along the cut.
  const halves = split({ ...base, patterns: [base.patterns[0]], seams: [], arrangement: [] }, { pattern: 'front', from: { segment: 'front_left', at: 0.5 }, to: { segment: 'front_right', at: 0.5 } });
  const { start, end } = drape(halves, { target: 30, steps: 200, place: (_p, i) => [0, i * 40, 505] });
  near(start.front_cut, 40, 1e-6); assert.ok(end.front_cut < 2, `the cut seam is ${end.front_cut.toFixed(2)} mm open after the drape`);
});

test('a seam with ease stops and no flip is split at the matching place, and both parts keep pairing the places they paired', () => {
  const base = panels(), s = base.seams[0]; Object.assign(s, { flip: false, kind: 'gather', correspondence: [{ a: 0.5, b: 0.4 }] });
  const d = split(base, { pattern: 'front', from: { segment: 'front_left', at: 0.75 }, to: { segment: 'front_right', at: 0.25 } }), back = pattern(d, 'back');
  // A quarter of the way up the front is a fifth of the way along the back: 80 mm down from its top.
  near(point(back, 'back_left_split').y, 320); assert.deepEqual([seam(d, 'side').b.segment, seam(d, 'side_2').b.segment], ['back_left', 'back_left_2']);
  assert.deepEqual(seam(d, 'side').correspondence, []); near(seam(d, 'side_2').correspondence[0].a, 1 / 3, 1e-9); near(seam(d, 'side_2').correspondence[0].b, 0.25, 1e-9);
  for (const t of [0.3, 0.5, 0.9]) near(0.2 + 0.8 * seamFraction(seam(d, 'side_2'), (t - 0.25) / 0.75), seamFraction(s, t), 1e-9, `the place ${t} along the front`);
});

test('a dart takes a wedge out of the outline and sews its legs: sizes, ids, the seam and the mark', () => {
  const base = panels(), kept = JSON.stringify(base), d = dart(base, { pattern: 'front', segment: 'front_top', at: 0.5, width: 40, length: 120, id: 'waist_dart' }), p = pattern(d, 'front');
  assert.equal(JSON.stringify(base), kept); near(area(p), 300 * 400 - 40 * 120 / 2);
  assert.deepEqual(p.contours, [['front_bottom', 'front_right', 'front_top', 'waist_dart_leg_a', 'waist_dart_leg_b', 'front_top_2', 'front_left']]);
  assert.deepEqual(['a', 'apex', 'b'].map((k) => { const q = point(p, `waist_dart_${k}`); return [q.x, q.y]; }), [[170, 400], [150, 280], [130, 400]], 'the top edge runs right to left; the apex is 120 mm into the cloth');
  near(length(p, 'waist_dart_leg_a'), Math.hypot(20, 120)); near(length(p, 'waist_dart_leg_b'), Math.hypot(20, 120)); near(length(p, 'front_top') + length(p, 'front_top_2'), 260);
  assert.deepEqual(seam(d, 'waist_dart'), { id: 'waist_dart', a: { pattern: 'front', segment: 'waist_dart_leg_a' }, b: { pattern: 'front', segment: 'waist_dart_leg_b' }, flip: true, ease: 0, kind: 'dart', correspondence: [] });
  assert.deepEqual(d.annotations, [{ id: 'waist_dart', type: 'dart', pattern: 'front', lines: [['waist_dart_a', 'waist_dart_apex'], ['waist_dart_apex', 'waist_dart_b']] }]);
  assert.ok(checkDesign(d).ok); assert.equal(p.allowances.front_top_2, 10);
  // The cloth of a sewn dart is not cut away: the cut runs straight across its mouth, and the legs are drawn for stitching.
  const cut = cutContours(capDarts(p, d.annotations))[0]; near(Math.abs(shoelace(cut)), 320 * 420); assert.ok(cut.every(([x, y]) => x >= -10 - 1e-9 && x <= 310 + 1e-9 && y >= -10 - 1e-9 && y <= 410 + 1e-9));
  const dxf = patternDXF(p, d.annotations); assert.equal(dxf.split('\n0\nLINE\n').filter((e) => e.startsWith('8\nDART\n')).length, 2);
  const cutLines = dxf.split('\n0\nLINE\n').filter((e) => e.startsWith('8\nCUT\n')); assert.ok(cutLines.every((e) => !/\n2[01]\n280\n/.test(e)), 'no cut line reaches the apex');
  assert.throws(() => dart(base, { pattern: 'front', segment: 'front_top', at: 0.05, width: 40, length: 50 }), /does not fit/); assert.throws(() => dart(base, { pattern: 'front', segment: 'front_top', width: 40, length: 500 }), /apex .* falls outside/);
  assert.throws(() => dart(base, { pattern: 'front', segment: 'front_top', width: 40, apex: [100, 300] }), /move the apex/);
  near(seam(dart(base, { pattern: 'front', segment: 'front_top', width: 40, apex: [152, 280] }), 'front_top_dart').ease, 0.0054, 1e-9, 'a slightly skewed dart sews with that much ease');
  // A size that lengthens the piece carries the dart up with the edge it is on, and it still sews.
  const taller = dart({ ...base, grades: [{ size: 'L', rules: ['front_tl', 'front_tr'].map((q) => ({ pattern: 'front', point: q, dx: 0, dy: 20 })) }] }, { pattern: 'front', segment: 'front_top', width: 40, length: 120 });
  assert.deepEqual(taller.grades[0].rules.filter((r) => r.point.startsWith('front_top_dart')).map((r) => [r.point, r.dx, r.dy]), [['front_top_dart_b', 0, 20], ['front_top_dart_a', 0, 20], ['front_top_dart_apex', 0, 20]]); assert.ok(checkDesign(taller).sizes[0].seams.find((q) => q.id === 'front_top_dart').ok);
});

test('a dart on a sewn edge re-sews the edge on either side of it, and the check says how much shorter the edge now is', () => {
  const d = dart(panels(), { pattern: 'front', segment: 'front_right', at: 0.5, width: 30, length: 90 });
  assert.deepEqual(d.seams.map((s) => [s.id, s.a.segment, s.b.segment]), [['side', 'front_right', 'back_left_2'], ['side_2', 'front_right_2', 'back_left'], ['front_right_dart', 'front_right_dart_leg_a', 'front_right_dart_leg_b']]);
  near(point(pattern(d, 'back'), 'back_left_split').y, 200); const check = checkDesign(d);
  assert.equal(check.ok, false); assert.deepEqual(check.seams.slice(0, 2).map((s) => [s.lengthA, s.lengthB, s.ok]), [[185, 200, false], [185, 200, false]]);
});

test('a dart on a curved edge keeps the curve on either side of it, and a dart sewn in the drape closes', () => {
  const d = dart(dart({ ...yoke(), grades: [] }, { pattern: 'yoke', segment: 'yoke_neck', at: 0.5, width: 20, length: 30, id: 'neck_dart' }), { pattern: 'yoke', segment: 'yoke_round', at: 0.5, width: 16, length: 25, id: 'corner_dart' }), p = pattern(d, 'yoke'), was = pattern(yoke(), 'yoke');
  near(length(p, 'yoke_neck') + length(p, 'yoke_neck_2'), length(was, 'yoke_neck') - 20, 0.05, 'the neckline is shorter by the dart'); near(length(p, 'yoke_round') + length(p, 'yoke_round_2'), length(was, 'yoke_round') - 16, 0.01);
  near(length(p, 'neck_dart_leg_a'), length(p, 'neck_dart_leg_b'), 1e-9); assert.deepEqual([segment(p, 'yoke_neck').c1, segment(p, 'yoke_neck_2').c1, p.points.filter((q) => q.id.includes('mouth'))], ['yoke_n1', 'yoke_neck_2_c1', []], 'the first part keeps the neckline\'s handles, the second has its own, and the mouth left nothing behind');
  // The parts of the neckline lie on the curve that was there.
  const curve = sampleSegment(was, segment(was, 'yoke_neck'), 512); for (const id of ['yoke_neck', 'yoke_neck_2']) for (const q of sampleSegment(p, segment(p, id), 8)) assert.ok(curve.some((c) => Math.hypot(c[0] - q[0], c[1] - q[1]) < 0.2), `${id} left the neckline`);
  assert.deepEqual(p.notches.map((n) => n.segment), ['yoke_neck', 'yoke_bottom'], 'the neck notch is still on the first part'); assert.ok(checkDesign(d).ok); assert.ok(meshPattern(p, { target: 15 }).triangles.length > 0);
  const sewn = dart({ ...panels(), patterns: [panels().patterns[0]], seams: [], arrangement: [] }, { pattern: 'front', segment: 'front_top', width: 40, length: 120 }), { start, end, strain } = drape(sewn);
  near(start.front_top_dart, 40, 1e-6); assert.ok(end.front_top_dart < 2, `the dart is ${end.front_top_dart.toFixed(2)} mm open after the drape`); assert.ok(strain < 0.1, `closing it strains the cloth ${(strain * 100).toFixed(1)}%`);
});

test('a knife pleat spreads the piece by its intake and sews the fold shut at the edge, which keeps its length', () => {
  const base = panels(); base.seams.push({ id: 'waist', a: { pattern: 'front', segment: 'front_top' }, b: { pattern: 'back', segment: 'back_top' }, flip: true });
  const d = pleat(base, { pattern: 'front', segment: 'front_top', at: 0.5, intake: 40, id: 'cf_pleat' }), p = pattern(d, 'front'), xs = p.points.map((q) => q.x);
  near(area(p), 340 * 400); assert.deepEqual([Math.min(...xs), Math.max(...xs)], [-40, 300], 'the half the top edge runs on into has moved over by the intake');
  assert.deepEqual(p.contours, [['front_top_2', 'front_left', 'front_bottom', 'cf_pleat_far_1', 'cf_pleat_far_2', 'front_bottom_2', 'front_right', 'front_top', 'cf_pleat_1', 'cf_pleat_2']]);
  assert.deepEqual(seam(d, 'cf_pleat'), { id: 'cf_pleat', a: { pattern: 'front', segment: 'cf_pleat_1' }, b: { pattern: 'front', segment: 'cf_pleat_2' }, flip: true, ease: 0, kind: 'pleat', correspondence: [] });
  near(length(p, 'cf_pleat_1'), 20); near(length(p, 'cf_pleat_2'), 20); near(length(p, 'front_top') + length(p, 'front_top_2'), 300); assert.equal(p.allowances.cf_pleat_1, 10); assert.equal(p.allowances.cf_pleat_far_2, 10);
  // Three fold lines run straight down the piece: the two edges of the pleat and the fold between them.
  const folds = d.annotations[0]; assert.equal(folds.type, 'pleat'); assert.deepEqual(folds.lines, [['cf_pleat_a', 'cf_pleat_far_a'], ['cf_pleat_fold_1', 'cf_pleat_far_fold_1'], ['cf_pleat_b', 'cf_pleat_far_b']]);
  assert.deepEqual(folds.lines.map(([a, b]) => [point(p, a).x, point(p, b).x, Math.abs(point(p, a).y - point(p, b).y)]), [[150, 150, 400], [130, 130, 400], [110, 110, 400]]);
  // What the top edge was sewn to is now sewn on either side of the pleat, and still fits.
  assert.deepEqual(['waist', 'waist_2'].map((id) => [seam(d, id).a.segment, seam(d, id).b.segment]), [['front_top', 'back_top_2'], ['front_top_2', 'back_top']]); assert.ok(checkDesign(d).ok);
  assert.match(patternDXF(p, d.annotations), /\n8\nPLEAT\n/); assert.throws(() => pleat(base, { pattern: 'front', segment: 'front_top', intake: 40, kind: 'accordion' }), /'knife' or 'box'/);
});

test('a box pleat folds each half of the intake towards the middle; sewn at both ends, and draped, every fold closes', () => {
  const one = { ...panels(), patterns: [panels().patterns[0]], seams: [], arrangement: [] }, d = pleat(one, { pattern: 'front', segment: 'front_bottom', at: 0.4, intake: 60, kind: 'box', bothEnds: true }), p = pattern(d, 'front');
  near(area(p), 360 * 400); assert.deepEqual(d.seams.map((s) => [s.id, s.a.segment, s.b.segment]), [['front_bottom_pleat_1', 'front_bottom_pleat_1', 'front_bottom_pleat_2'], ['front_bottom_pleat_2', 'front_bottom_pleat_3', 'front_bottom_pleat_4'], ['front_bottom_pleat_far_1', 'front_bottom_pleat_far_1', 'front_bottom_pleat_far_2'], ['front_bottom_pleat_far_2', 'front_bottom_pleat_far_3', 'front_bottom_pleat_far_4']]);
  assert.equal(d.annotations[0].lines.length, 5); assert.deepEqual(d.annotations[0].lines.map(([a]) => point(p, a).x), [120, 135, 150, 165, 180]); assert.ok(checkDesign(d).ok);
  const { start, end } = drape(d, { place: () => [-30, 0, 505] });
  for (const s of d.seams) { near(start[s.id], 30, 1e-6); assert.ok(end[s.id] < 2, `fold ${s.id} is ${end[s.id].toFixed(2)} mm open after the drape`); }
  // A pleat to a named place slants across the piece and spreads square to its own line.
  const slant = pleat(one, { pattern: 'front', segment: 'front_bottom', at: 0.5, intake: 30, to: { segment: 'front_top', at: 0.25 } }), q = pattern(slant, 'front');
  near(Math.hypot(point(q, 'front_bottom_pleat_b').x - 150, point(q, 'front_bottom_pleat_b').y), 30); near(area(q), 300 * 400 + 30 * Math.hypot(75, 400), 1e-6);
});

test('slash and spread adds flare: the pivot edge keeps its length, the moved half keeps its shape, and the open edge gains an arc', () => {
  const base = panels(), d = slashSpread(base, { pattern: 'front', from: { segment: 'front_bottom', at: 0.5 }, pivot: { segment: 'front_top', at: 0.5 }, angle: 20, id: 'hem_flare' }), p = pattern(d, 'front'), theta = 20 * Math.PI / 180;
  assert.deepEqual(p.contours, [['front_bottom_2', 'front_right', 'front_top', 'front_top_2', 'front_left', 'front_bottom', 'hem_flare']]);
  near(length(p, 'front_top') + length(p, 'front_top_2'), 300, 1e-9, 'the pivot edge'); for (const id of ['front_bottom', 'front_bottom_2', 'front_top', 'front_right']) near(length(p, id), id === 'front_right' ? 400 : 150, 1e-9, id);
  assert.deepEqual(segment(p, 'hem_flare'), { id: 'hem_flare', type: 'arc', a: 'hem_flare_a', b: 'hem_flare_b', c: 'hem_flare_pivot' }); near(length(p, 'hem_flare'), 400 * theta, 1e-3); assert.equal(p.allowances.hem_flare, 10);
  near(area(p), 300 * 400 + 400 * 400 * theta / 2, 1, 'the piece gains the sector that opened');
  // The right half turned as one piece about the pivot: its corner is still square.
  const at = (id) => point(p, id), u = [at('front_br').x - at('hem_flare_b').x, at('front_br').y - at('hem_flare_b').y], v = [at('front_tr').x - at('front_br').x, at('front_tr').y - at('front_br').y]; near(u[0] * v[0] + u[1] * v[1], 0, 1e-6);
  assert.ok(checkDesign(d).ok, 'the side seam is untouched'); assert.ok(meshPattern(p, { target: 25 }).triangles.length > 0); assert.match(patternDXF(p), /\n8\nCUT\n/);
  const byDistance = pattern(slashSpread(base, { pattern: 'front', from: { segment: 'front_bottom', at: 0.5 }, pivot: 'front_tr', distance: 50 }), 'front');
  near(Math.hypot(point(byDistance, 'front_spread_b').x - 150, point(byDistance, 'front_spread_b').y), 50, 1e-9, 'opened by a distance, measured straight across the gap'); near(length(byDistance, 'front_top'), 300);
  assert.throws(() => slashSpread(base, { pattern: 'front', from: 'front_bl', pivot: 'front_tr', angle: 10, distance: 5 }), /one of the two/);
  // A slash from a sewn edge leaves the edge sewn on either side of the gap.
  const sewn = slashSpread(base, { pattern: 'front', from: { segment: 'front_right', at: 0.5 }, pivot: { segment: 'front_left', at: 0.5 }, angle: 10 });
  assert.deepEqual(sewn.seams.map((s) => [s.id, s.a.segment, s.b.segment]), [['side', 'front_right', 'back_left_2'], ['side_2', 'front_right_2', 'back_left']]); assert.ok(checkDesign(sewn).ok);
});

test('internal lines are drawn on the piece with its own points, must stay on the cloth, and are exported on the INTERNAL layer', () => {
  const base = panels(), d = internalLine(base, { pattern: 'front', id: 'pocket_top', a: [60, 250], b: [240, 250] }), p = pattern(d, 'front');
  assert.deepEqual(p.internalLines, [{ id: 'pocket_top', type: 'line', a: 'pocket_top_a', b: 'pocket_top_b' }]); assert.deepEqual(point(p, 'pocket_top_b'), { id: 'pocket_top_b', x: 240, y: 250 });
  const curved = internalLine(d, { pattern: 'front', a: 'pocket_top_a', b: 'pocket_top_b', c1: [100, 150], c2: [200, 150] }), q = pattern(curved, 'front');
  assert.deepEqual(q.internalLines[1], { id: 'front_line', type: 'bezier', a: 'pocket_top_a', b: 'pocket_top_b', c1: 'front_line_c1', c2: 'front_line_c2' });
  const internal = patternDXF(q).split('\n0\nLINE\n').filter((e) => e.startsWith('8\nINTERNAL\n')); assert.equal(internal.length, 1 + 24); assert.match(internal[0], /\n10\n60\n20\n250\n/); assert.match(patternDXF(q), /\n2\nINTERNAL\n70\n0\n/);
  assert.equal(pattern(internalLine(curved, { pattern: 'front', id: 'front_line', remove: true }), 'front').internalLines.length, 1);
  assert.throws(() => internalLine(base, { pattern: 'front', a: [60, 250], b: [340, 250] }), /leaves the outline/); assert.throws(() => internalLine(d, { pattern: 'front', id: 'pocket_top', a: 'front_bl', b: 'front_tr' }), /already has/);
  assert.throws(() => internalLine(base, { pattern: 'front', a: 'nowhere', b: 'front_tr' }), /no point 'nowhere'/);
  // The document itself holds them to the same rules, however they were written; an edge-to-edge point pair is fine.
  const raw = panels(); raw.patterns[0].internalLines = [['front_bl', 'front_tr']]; assert.match(patternDXF(validateSoftgoodsDocument(raw).patterns[0]), /\n8\nINTERNAL\n/);
  raw.patterns[0].internalLines = [['front_bl', 'gone']]; assert.throws(() => validateSoftgoodsDocument(raw), /missing point 'gone'/);
  raw.patterns[0].internalLines = [{ type: 'spline', a: 'front_bl', b: 'front_tr' }]; assert.throws(() => validateSoftgoodsDocument(raw), /point pair or a line, arc or bezier/);
  // A line on the half that moves goes with it: cut the piece and each part keeps its own.
  const parts = split(d, { pattern: 'front', from: { segment: 'front_left', at: 0.5 }, to: { segment: 'front_right', at: 0.5 } });
  assert.deepEqual(parts.patterns.slice(0, 2).map((x) => x.internalLines.length), [0, 1]); assert.ok(point(pattern(parts, 'front_b'), 'pocket_top_a') && !point(pattern(parts, 'front_a'), 'pocket_top_a'));
});

test('auto notches are matched across every seam, through its flip, ease and correspondence, and asking again adds nothing', () => {
  const base = panels(); base.patterns[1].points.find((q) => q.id === 'back_tl').y = 412; Object.assign(base.seams[0], { ease: 0.03, correspondence: [{ a: 0.5, b: 0.6 }] });
  const d = autoNotch(base, { fractions: [0.25, 0.5, 0.75] }), front = pattern(d, 'front'), back = pattern(d, 'back');
  assert.deepEqual(front.notches.map((n) => [n.segment, n.at]), [['front_right', 0], ['front_right', 1], ['front_right', 0.25], ['front_right', 0.5], ['front_right', 0.75]]);
  assert.deepEqual(back.notches.map((n) => [n.segment, n.at, n.kind]), [['back_left', 1, 'seam'], ['back_left', 0, 'seam'], ['back_left', 0.7, 'seam'], ['back_left', 0.4, 'seam'], ['back_left', 0.2, 'seam']]);
  // Those are the places the solver sews together: each front notch's pair ends at the back notch.
  const meshes = d.patterns.map((p) => meshPattern(p, { target: 50 })), [resolved] = resolveSeamCorrespondence(d.seams, meshes, { spacing: 100 }); assert.equal(resolved.pairs.length, 6);
  const fine = resolveSeamCorrespondence(d.seams, meshes, { spacing: 412 / 4 })[0].pairs; assert.equal(fine.length, 5);
  fine.forEach((pair, i) => { const f = i / 4, mine = front.notches.findIndex((n) => Math.abs(n.at - f) < 1e-9); near(pair.a.t, f, 1e-9); near(back.notches[mine].at, pair.b.t, 1e-6, `the notch across from ${f}`); });
  assert.deepEqual(autoNotch(d, { fractions: [0.25, 0.5, 0.75] }), { ...d }, 'idempotent');
  assert.match(patternDXF(back), /\n8\nNOTCH\n/); assert.equal(patternDXF(back).split('\n0\nLINE\n').filter((e) => e.startsWith('8\nNOTCH\n')).length, 5);
  // Every 150 mm of a 400 mm seam, without the ends; only the seam asked for; a dart is left alone unless named.
  const spaced = autoNotch(panels(), { every: 150, ends: false, seams: ['side'] }); assert.deepEqual(pattern(spaced, 'front').notches.map((n) => n.at), [0.375, 0.75]); assert.deepEqual(pattern(spaced, 'back').notches.map((n) => n.at), [0.625, 0.25]);
  const darted = dart({ ...panels(), seams: [] }, { pattern: 'front', segment: 'front_top', width: 40, length: 100 }); assert.equal(pattern(autoNotch(darted, {}), 'front').notches.length, 0); assert.equal(pattern(autoNotch(darted, { seams: ['front_top_dart'] }), 'front').notches.length, 6);
  assert.throws(() => autoNotch(base, { seams: ['nowhere'] }), /No seam 'nowhere'/);
  // On a Bezier a notch sits at the curve's own parameter, which is not the fraction of its length: the place is still halfway along.
  const curved = yoke(); curved.patterns.push({ ...panels().patterns[1], id: 'collar', points: panels().patterns[1].points.map((q) => ({ ...q })) }); curved.seams.push({ id: 'neck', a: { pattern: 'collar', segment: 'back_top' }, b: { pattern: 'yoke', segment: 'yoke_neck' }, flip: true, kind: 'gather' });
  const y = pattern(autoNotch(curved, { ends: false }), 'yoke'), n = y.notches.at(-1), s = segment(y, 'yoke_neck'), whole = sampleSegment(y, s, 400), upTo = whole.slice(0, Math.round(n.at * 400) + 1), run = (q) => q.slice(1).reduce((sum, c, i) => sum + Math.hypot(c[0] - q[i][0], c[1] - q[i][1]), 0);
  near(run(upTo) / run(whole), 0.5, 0.005, 'half the neckline lies before its notch');
});

test('edits compose, name what they changed, and an unknown one is refused', () => {
  const base = panels(); let d = base;
  for (const args of [{ op: 'dart', pattern: 'front', segment: 'front_top', at: 0.3, width: 30, length: 80 }, { op: 'pleat', pattern: 'front', segment: 'front_bottom', at: 0.6, intake: 40 }, { op: 'split', pattern: 'front', from: { segment: 'front_left', at: 0.3 }, to: { segment: 'front_right', at: 0.7 } }, { op: 'mirror', pattern: 'front_a' }, { op: 'autoNotch' }]) d = editSoftgoods(d, args);
  assert.deepEqual(d.patterns.map((p) => p.id), ['front_a', 'front_a_mirror', 'front_b', 'back']); assert.ok(checkDesign(d).ok); for (const p of d.patterns) { assert.ok(meshPattern(p, { target: 25 }).triangles.length > 0, p.id); patternDXF(p, d.annotations.filter((a) => a.pattern === p.id)); }
  assert.ok(resolveSeamCorrespondence(d.seams, d.patterns.map((p) => meshPattern(p, { target: 25 }))).length === d.seams.length, 'every seam still resolves to a sewn span');
  const changes = editChanges(base, dart(base, { pattern: 'front', segment: 'front_right', width: 30, length: 90 }));
  assert.deepEqual(changes, { added: { seams: ['side_2', 'front_right_dart'], annotations: ['front_right_dart'], segments: { front: ['front_right_2', 'front_right_dart_leg_a', 'front_right_dart_leg_b'], back: ['back_left_2'] }, points: { front: ['front_right_dart_b', 'front_right_dart_a', 'front_right_dart_apex'], back: ['back_left_split'] } }, removed: {} });
  assert.throws(() => editSoftgoods(base, { op: 'shred' }), /Unknown softgoods edit 'shred': use one of mirror, unfold, split, dart, pleat, slashSpread, internalLine, autoNotch/);
  assert.throws(() => editSoftgoods(base, { op: 'dart', pattern: 'gone', segment: 'x', width: 1, length: 1 }), /No pattern 'gone'/); assert.throws(() => editSoftgoods(base, { op: 'toString' }), /Unknown softgoods edit/);
});

test('POST /edit changes the stored design like a set: a new revision, a refresh for the page, and the check in the answer', async () => {
  const doc = new SoftgoodsDocument(null), sent = [], app = express(); app.use(express.json()); app.use('/s', softgoodsRouter(doc, { broadcast: (m) => sent.push(m) })); doc.replace(panels());
  const server = app.listen(0), call = async (p, method = 'GET', body) => { const r = await fetch(`http://127.0.0.1:${server.address().port}/s${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) }); return [r.status, await r.json()]; };
  try {
    const revision = doc.data.revision, [status, result] = await call('/edit', 'POST', { op: 'split', pattern: 'front', from: 'front_bl', to: 'front_tr' });
    assert.equal(status, 200); assert.equal(result.revision, revision + 1); assert.deepEqual(sent.at(-1), { type: 'softgoods_changed', revision: revision + 1 });
    assert.deepEqual(result.patterns, ['front_a', 'front_b', 'back']); assert.deepEqual(result.added.patterns, ['front_a', 'front_b']); assert.deepEqual(result.removed.patterns, ['front']); assert.equal(result.check.ok, true); assert.equal(result.check.seams.length, 2);
    const stored = (await call('/document'))[1]; assert.deepEqual(stored.arrangement.map((a) => a.pattern), ['front_a', 'front_b', 'back'], 'every piece has a place in the review');
    assert.equal((await call('/simulation-input?target=40'))[1].seams.length, 2, 'and the solver gets the cut as a seam');
    const [bad, error] = await call('/edit', 'POST', { op: 'dart', pattern: 'back', segment: 'back_top', width: 400, length: 10 }); assert.equal(bad, 400); assert.match(error.error, /does not fit/); assert.equal(doc.data.revision, revision + 1, 'a refused edit changes nothing');
    // A piece standing on the avatar is mirrored to the other side of it, and an edit keeps the avatar.
    doc.replace({ ...panels(), patterns: panels().patterns.map((p, i) => ({ ...p, placement: { region: i ? 'back' : 'left' } })), simulation: { avatar: { height: 1700, chest: 900 } } });
    await call('/arrange/avatar', 'POST', { height: 1700, chest: 900 }); const [, mirrored] = await call('/edit', 'POST', { op: 'mirror', pattern: 'front', id: 'front_r' });
    assert.deepEqual(mirrored.added.patterns, ['front_r']); const after = (await call('/document'))[1], row = (id) => after.arrangement.find((a) => a.pattern === id);
    assert.equal(after.simulation.avatar.chest, 900); assert.equal(row('front_r').source, 'avatar'); assert.equal(row('front_r').position[0], -row('front').position[0]);
  } finally { server.close(); }
});

test('the MCP edit tool takes every operation by name with typed arguments and posts it to the server', async () => {
  const tools = {}, sent = [];
  registerSoftgoodsTools({ registerTool: (name, spec, handler) => { tools[name] = { spec, handler }; } }, { call: async (p, opts) => { sent.push([p, opts]); return { revision: 7, check: { ok: true } }; }, ok: (v) => v, fail: (e) => { throw e; } });
  const tool = tools.cadgang_softgoods_edit, schema = z.object(tool.spec.inputSchema);
  assert.deepEqual(tool.spec.inputSchema.action.options, SOFTGOODS_EDITS); for (const op of SOFTGOODS_EDITS) assert.ok(tool.spec.description.includes(`- ${op} {`), `the guide explains ${op}`);
  const args = schema.parse({ action: 'pleat', pattern: 'front', segment: 'front_top', at: 0.5, intake: 40, kind: 'box', to: { segment: 'front_bottom', at: 0.5 } });
  assert.deepEqual(await tool.handler(args), { revision: 7, check: { ok: true } }); assert.deepEqual(sent[0], ['/softgoods/edit', { method: 'POST', body: { op: 'pleat', pattern: 'front', segment: 'front_top', at: 0.5, intake: 40, kind: 'box', to: { segment: 'front_bottom', at: 0.5 } } }]);
  assert.ok(schema.safeParse({ action: 'internalLine', pattern: 'front', a: [1, 2], b: 'front_tr' }).success); assert.ok(!schema.safeParse({ action: 'dart', width: -1 }).success); assert.ok(!schema.safeParse({ action: 'shred' }).success);
  // Every argument the tool accepts for a real edit reaches the operation: the schema drops nothing the operations read.
  const d = editSoftgoods(panels(), (({ action, ...rest }) => ({ op: action, ...rest }))(schema.parse({ action: 'split', pattern: 'front', from: 'front_bl', to: { segment: 'front_top', at: 0.5 }, ids: ['front_low', 'front_high'], names: ['Low', 'High'], allowance: 6 })));
  assert.deepEqual(d.patterns.slice(0, 2).map((p) => [p.id, p.name, p.allowances.front_cut]), [['front_low', 'Low', 6], ['front_high', 'High', 6]]);
});
