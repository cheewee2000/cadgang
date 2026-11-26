/**
 * 3D-to-2D flattening (src/core/softgoods-flatten.js): faces of a solid become pattern pieces with the seams that
 * sew them back. Surfaces with a known unrolling hold the numbers: a cylinder is a rectangle of circumference by
 * height, a cone an annular sector, a box six rectangles and twelve seams; a dome cannot lie flat and says so.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { z } from 'zod';
import { flattenMesh, flattenPatch, describeFaces, mergeFlattened, fitRun } from '../src/core/softgoods-flatten.js';
import { SoftgoodsDocument, validateSoftgoodsDocument } from '../src/core/softgoods-document.js';
import os from 'node:os';
import { meshPattern, meshPatternFine } from '../src/core/softgoods-mesh.js';
import { resolveSeamCorrespondence, seamSide } from '../src/core/softgoods-seams.js';
import { exportProduction } from '../src/core/softgoods-production.js';
import { drapeDocument, simulationInput } from '../src/core/softgoods-drape.js';
import { editSoftgoods } from '../src/core/softgoods-edit.js';
import { checkDesign } from '../src/core/softgoods-operations.js';
import { sampleSegment, segmentLength } from '../src/core/softgoods-export.js';
import { importCadFile } from '../src/core/step.js';
import { softgoodsRouter } from '../src/server/softgoods.js';
import { cellsRouter } from '../src/server/cells.js';
import { CellDocument } from '../src/core/cells.js';
import { registerSoftgoodsTools } from '../src/mcp/softgoods.js';
import { body, side, disc, box, quad, hemisphere, surface, washer } from './fixtures/flatten-meshes.mjs';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const near = (actual, expected, ratio, what) => assert.ok(Math.abs(actual - expected) <= ratio * Math.abs(expected), `${what}: ${actual} is not within ${ratio * 100}% of ${expected}`);
const piece = (r, id) => r.patterns.find((p) => p.id === id), point = (p, id) => p.points.find((q) => q.id === id);
const lengthOf = (r, ref) => { const p = piece(r, ref.pattern); return seamSide(ref).segments.reduce((sum, id) => sum + segmentLength(p, p.segments.find((s) => s.id === id)), 0); };
const count = (text, needle) => text.split(needle).length - 1;

/** The produced design is a valid document, every piece meshes for the cloth preview, and every seam resolves. */
function sewable(r) {
  const d = validateSoftgoodsDocument(mergeFlattened(new SoftgoodsDocument(null).toJSON(), r));
  const meshes = d.patterns.map((p) => meshPattern(p, { target: 20 })), resolved = resolveSeamCorrespondence(d.seams, meshes, { spacing: 10 });
  assert.equal(meshes.length, r.patterns.length); assert.ok(meshes.every((m) => m.triangles.length > 0));
  assert.equal(resolved.length, d.seams.length); assert.equal(checkDesign(d).ok, true, 'both sides of every seam agree within its ease');
  return { d, meshes, resolved };
}
/** How far the flattened boundary strays from the lines and Beziers fitted to it, mm. */
function fitMiss(r) {
  let worst = 0;
  r.patterns.forEach((p, i) => {
    const { uv, triangles } = r.meshes[i], n = uv.length / 2, edges = new Map(), drawn = p.segments.flatMap((s) => { const q = sampleSegment(p, s, 64); return q.slice(1).map((b, k) => [q[k], b]); });
    for (let t = 0; t < triangles.length; t += 3) for (let k = 0; k < 3; k++) { const a = triangles[t + k], b = triangles[t + (k + 1) % 3]; edges.set(a * n + b, a); }
    for (const [e, a] of edges) {
      if (edges.has((e % n) * n + a)) continue;   // an inner edge
      const x = uv[2 * a], y = uv[2 * a + 1];
      worst = Math.max(worst, Math.min(...drawn.map(([p0, p1]) => { const dx = p1[0] - p0[0], dy = p1[1] - p0[1], t = Math.max(0, Math.min(1, ((x - p0[0]) * dx + (y - p0[1]) * dy) / (dx * dx + dy * dy || 1))); return Math.hypot(p0[0] + dx * t - x, p0[1] + dy * t - y); })));
    }
  });
  return worst;
}
const transform = ([rx, ry, rz], position, [u, v]) => { const r = (d) => d * Math.PI / 180; let x = u, y = v * Math.cos(r(rx)), zz = v * Math.sin(r(rx)); [x, zz] = [x * Math.cos(r(ry)) + zz * Math.sin(r(ry)), -x * Math.sin(r(ry)) + zz * Math.cos(r(ry))]; [x, y] = [x * Math.cos(r(rz)) - y * Math.sin(r(rz)), x * Math.sin(r(rz)) + y * Math.cos(r(rz))]; return [x + position[0], y + position[1], zz + position[2]]; };

test('a cylinder side unrolls to a rectangle of circumference by height, cut once along its length', () => {
  const r = flattenMesh(body('sleeve', [side(30, 30, 80, 128)])), [p] = r.patterns, [report] = r.report.pieces;
  assert.equal(r.patterns.length, 1);
  near(report.size[0], 2 * Math.PI * 30, 0.001, 'width'); near(report.size[1], 80, 1e-6, 'height'); near(report.area, 2 * Math.PI * 30 * 80, 0.001, 'area');
  assert.ok(report.distortion.maxStrain < 1e-6 && report.distortion.flat, 'a developable surface comes out exact');
  assert.deepEqual(p.segments.map((s) => s.type), ['line', 'line', 'line', 'line']); assert.equal(p.points.length, 4);
  assert.equal(r.report.cuts.length, 1); assert.equal(r.report.cuts[0].kind, 'auto'); near(r.report.cuts[0].length, 80, 1e-6, 'the cut runs straight up the side');
  assert.ok(r.report.cuts[0].from[1] > 29.9, 'the cut is at the back (+y)');
  assert.equal(r.seams.length, 1); assert.equal(r.seams[0].a.pattern, r.seams[0].b.pattern, 'the seam closes the piece onto itself'); assert.equal(r.seams[0].flip, true);
  near(lengthOf(r, r.seams[0].a), 80, 1e-6, 'seam side a'); near(lengthOf(r, r.seams[0].b), 80, 1e-6, 'seam side b');
  assert.deepEqual(p.grain, { angle: 90 }); assert.deepEqual(p.source.faces, [0]); assert.equal(p.source.body, 'sleeve');
  sewable(r);
});

test('a cone frustum unrolls to an annular sector with the right radii and angle', () => {
  const r0 = 50, r1 = 30, h = 60, slant = Math.hypot(h, r0 - r1), outer = r0 * slant / (r0 - r1), inner = outer - slant, angle = 2 * Math.PI * r0 / outer;
  const r = flattenMesh(body('cone', [side(r0, r1, h, 128)])), [p] = r.patterns, seam = r.seams[0];
  assert.equal(r.patterns.length, 1); assert.equal(r.report.cuts.length, 1); assert.ok(r.report.pieces[0].distortion.maxStrain < 1e-4);
  const ends = (ref) => { const s = p.segments.find((q) => q.id === ref.segment); assert.equal(s.type, 'line'); return [point(p, s.a), point(p, s.b)]; };
  const [a0, a1] = ends(seam.a), [b0, b1] = ends(seam.b);
  near(Math.hypot(a1.x - a0.x, a1.y - a0.y), slant, 1e-4, 'the cut edge is the slant height');
  // The apex is where the two cut edges meet when extended.
  const dax = a1.x - a0.x, day = a1.y - a0.y, dbx = b1.x - b0.x, dby = b1.y - b0.y, t = ((b0.x - a0.x) * dby - (b0.y - a0.y) * dbx) / (dax * dby - day * dbx), apex = [a0.x + dax * t, a0.y + day * t];
  const radius = (q) => Math.hypot(q.x - apex[0], q.y - apex[1]), radii = [a0, a1, b0, b1].map(radius).sort((x, y) => x - y);
  near(radii[0], inner, 0.001, 'inner radius'); near(radii[1], inner, 0.001, 'inner radius'); near(radii[2], outer, 0.001, 'outer radius'); near(radii[3], outer, 0.001, 'outer radius');
  const far = (pair) => pair.reduce((m, q) => (radius(q) > radius(m) ? q : m)), fa = far([a0, a1]), fb = far([b0, b1]);
  near(Math.acos(((fa.x - apex[0]) * (fb.x - apex[0]) + (fa.y - apex[1]) * (fb.y - apex[1])) / (radius(fa) * radius(fb))), angle, 0.001, 'sector angle');
  // The two arcs are a few Beziers, not hundreds of facets, and stay on their circles.
  const curves = p.segments.filter((s) => s.type === 'bezier'); assert.ok(curves.length >= 2 && curves.length <= 6, `${curves.length} Beziers`); assert.equal(p.segments.length, curves.length + 2);
  for (const s of curves) for (const q of sampleSegment(p, s, 16)) { const d = Math.hypot(q[0] - apex[0], q[1] - apex[1]); assert.ok(Math.min(Math.abs(d - outer), Math.abs(d - inner)) < 0.25, `a fitted arc strays to radius ${d}`); }
  assert.ok(fitMiss(r) <= 0.2 + 1e-3);
  sewable(r);
});

test('a box gives six rectangles and twelve seams whose two sides are the same length, each laid on its face', () => {
  const r = flattenMesh(body('case', box(100, 60, 40)));
  assert.deepEqual(r.patterns.map((p) => p.id), ['case_bottom', 'case_top', 'case_front', 'case_back', 'case_left', 'case_right']);
  assert.deepEqual(r.report.pieces.map((p) => p.size), [[100, 60], [100, 60], [100, 40], [100, 40], [60, 40], [60, 40]]);
  for (const p of r.patterns) { assert.equal(p.segments.length, 4); assert.ok(p.segments.every((s) => s.type === 'line')); assert.equal(p.points.length, 4); assert.equal(Object.values(p.allowances).every((mm) => mm === 10), true); }
  assert.equal(r.seams.length, 12); assert.equal(r.report.cuts.length, 0);
  for (const s of r.seams) { assert.notEqual(s.a.pattern, s.b.pattern); assert.equal(s.flip, true); near(lengthOf(r, s.a), lengthOf(r, s.b), 1e-9, s.id); }
  assert.deepEqual(r.seams.map((s) => +lengthOf(r, s.a).toFixed(6)).sort((a, b) => a - b), [40, 40, 40, 40, 60, 60, 60, 60, 100, 100, 100, 100]);
  // The arrangement lays every flat piece back on the face it came from.
  r.patterns.forEach((p, i) => {
    const row = r.arrangement[i], { uv, xyz } = r.meshes[i];
    assert.equal(row.pattern, p.id); assert.equal(row.source, 'flatten');
    for (let v = 0; v < uv.length / 2; v++) { const q = transform(row.rotation, row.position, [uv[2 * v], uv[2 * v + 1]]); assert.ok(Math.hypot(q[0] - xyz[3 * v], q[1] - xyz[3 * v + 1], q[2] - xyz[3 * v + 2]) < 1e-3, `${p.id} sits on its face`); }
  });
  const top = piece(r, 'case_top'), front = piece(r, 'case_front');
  assert.deepEqual(top.source.normal, [0, 0, 1]); assert.deepEqual(front.source.normal, [0, -1, 0]);
  sewable(r);
});

test('a hemisphere cannot lie flat: it reports its strain and says what to do, and darts bring the strain down', () => {
  const dome = body('dome', [hemisphere(50)]), r = flattenMesh(dome), [report] = r.report.pieces;
  assert.equal(r.patterns.length, 1); assert.equal(report.distortion.flat, false);
  assert.ok(report.distortion.maxStrain > 0.1 && report.distortion.meanStrain > 0.02 && Math.abs(report.distortion.areaError) > 0.005, JSON.stringify(report.distortion));
  assert.equal(report.distortion.flips, 0); assert.match(report.advice, /darts|split/); assert.equal(r.patterns[0].source.distortion.flat, false);
  assert.ok(r.patterns[0].segments.length <= 6, 'the rim is a few Beziers'); assert.ok(fitMiss(r) <= 0.2 + 1e-3);
  sewable(r);
  // Four darts from the rim to near the pole: each cut is a seam closing the piece onto itself.
  const dart = (a) => ({ path: [[50 * Math.cos(a), 50 * Math.sin(a), 0], [50 * Math.cos(1.3) * Math.cos(a), 50 * Math.cos(1.3) * Math.sin(a), 50 * Math.sin(1.3)]] });
  const darted = flattenMesh(dome, { cuts: [0, 1, 2, 3].map((k) => dart(k * Math.PI / 2)) });
  assert.equal(darted.patterns.length, 1); assert.equal(darted.report.cuts.filter((c) => c.kind === 'given').length, 4);
  assert.ok(darted.report.pieces[0].distortion.maxStrain < 0.6 * report.distortion.maxStrain, `darted ${darted.report.pieces[0].distortion.maxStrain} against ${report.distortion.maxStrain}`);
  assert.ok(darted.seams.length >= 4 && darted.seams.every((s) => s.a.pattern === s.b.pattern));
  sewable(darted);
});

test('a closed can: the side is cut once, each round end is one seam of a few Beziers to one straight edge, and matched notches mark the quarters', () => {
  const r = flattenMesh(body('can', [side(30, 30, 80), disc(30, 80, 1), disc(30, 0, -1)]));
  assert.deepEqual(r.patterns.map((p) => p.id), ['can_wrap', 'can_top', 'can_bottom']); assert.equal(r.report.cuts.length, 1);
  const wrap = piece(r, 'can_wrap'), top = piece(r, 'can_top');
  assert.ok(top.segments.every((s) => s.type === 'bezier') && top.segments.length >= 3 && top.segments.length <= 6, `${top.segments.length} segments for a circle`);
  assert.deepEqual(wrap.segments.map((s) => s.type), ['line', 'line', 'line', 'line'], 'the side stays a plain rectangle: it does not break where the ends do');
  assert.ok(fitMiss(r) <= 0.2 + 1e-3, `fitted within tolerance (${fitMiss(r)})`);
  // One seam per border: the side's whole edge to the span of arcs round the end.
  assert.equal(r.seams.length, 3);
  const end = r.seams.find((s) => s.b.pattern === 'can_top'); assert.equal(end.a.pattern, 'can_wrap'); assert.ok(end.a.segment); assert.equal(end.b.segments.length, top.segments.length); assert.equal(end.flip, true);
  near(lengthOf(r, end.b), 2 * Math.PI * 30, 0.002, 'the end is as long round as the side is wide'); near(lengthOf(r, end.a), lengthOf(r, end.b), 0.002, 'both sides of the seam');
  for (const s of r.report.seams) assert.ok(s.mismatch < 0.002 && s.ease >= s.mismatch, `${s.id}: ${s.mismatch}`);
  // Where the end starts a new arc, both pieces carry a match notch: at the arc's start on the end, part way along the side's straight edge.
  const joints = top.segments.length - 1, onSide = wrap.notches.filter((n) => n.segment === end.a.segment);
  assert.equal(top.notches.length, joints); assert.ok(top.notches.every((n) => n.kind === 'match' && n.at === 0)); assert.equal(onSide.length, joints);
  assert.deepEqual(onSide.map((n) => n.at).sort(), Array.from({ length: joints }, (_, i) => (i + 1) / (joints + 1)), 'evenly round');
  sewable(r);
});

test('faces that meet smoothly grow into one piece; two half tubes become one rectangle with one seam', () => {
  const halves = flattenMesh(body('tube', [side(30, 30, 80, 64, 0, 0.5), side(30, 30, 80, 64, 0.5, 1)]));
  assert.equal(halves.patterns.length, 1); assert.deepEqual(halves.patterns[0].source.faces, [0, 1]); assert.equal(halves.seams.length, 1);
  near(halves.report.pieces[0].size[0], 2 * Math.PI * 30, 0.001, 'width'); assert.equal(halves.report.cuts.length, 0, 'it opens along a face border, not a new cut');
  assert.equal(flattenMesh(body('tube', [side(30, 30, 80, 64, 0, 0.5), side(30, 30, 80, 64, 0.5, 1)]), { merge: false }).patterns.length, 2);
  // A flat panel, a quarter-round fillet and a second panel: one strip, exact. Named groups split it where the caller says.
  const bend = [quad([-40, 0, 0], [40, 0, 0], [0, 0, 50]), surface(16, 2, (u, v) => { const a = Math.PI / 2 * u; return [10 * Math.sin(a), 10 - 10 * Math.cos(a), 50 * v]; }), quad([10, 10, 0], [0, 40, 0], [0, 0, 50])];
  const strip = flattenMesh(body('bend', bend));
  assert.equal(strip.patterns.length, 1); near(strip.report.pieces[0].size[0], 40 + Math.PI * 5 + 40, 0.001, 'strip length'); near(strip.report.pieces[0].size[1], 50, 1e-6, 'strip height');
  assert.ok(strip.report.pieces[0].distortion.maxStrain < 1e-6); assert.equal(strip.patterns[0].segments.length, 4);
  const split = flattenMesh(body('bend', bend), { faces: [[0, 1], [2]] });
  assert.deepEqual(split.patterns.map((p) => p.source.faces), [[0, 1], [2]]); assert.equal(split.seams.length, 1); near(lengthOf(split, split.seams[0].a), 50, 1e-6, 'the seam between the groups');
  const kept = flattenMesh(body('bend', bend), { cuts: [[1, 2]] });
  assert.equal(kept.patterns.length, 2); assert.equal(kept.report.cuts[0].kind, 'given');
  sewable(strip); sewable(split);
});

test('a tube triangulated off its rulings still unrolls true, and a cut path puts the seam where the caller wants it', () => {
  // Vertices scattered over the cylinder, as a mesher leaves them: no edge is a ruling, the facets do not unfold exactly, and the solver has to work.
  const jitter = (i, j, k) => { const x = Math.sin(i * 127.1 + j * 311.7 + k * 74.7) * 43758.5453; return x - Math.floor(x) - 0.5; };
  const rough = surface(96, 12, (u, v) => { const i = Math.round(u * 96) % 96, j = Math.round(v * 12), a = 2 * Math.PI * (i + 0.6 * jitter(i, j, 0)) / 96, z = 80 * (j + (j > 0 && j < 12 ? 0.6 * jitter(i, j, 1) : 0)) / 12; return [30 * Math.cos(a), 30 * Math.sin(a), z]; });
  const r = flattenMesh(body('rough', [rough])), d = r.report.pieces[0].distortion;
  assert.equal(r.patterns.length, 1); near(r.report.pieces[0].area, 2 * Math.PI * 30 * 80, 0.001, 'area'); near(r.report.pieces[0].size[0], 2 * Math.PI * 30, 0.005, 'width'); near(r.report.pieces[0].size[1], 80, 0.001, 'height');
  assert.ok(d.maxStrain > 1e-4 && d.maxStrain < 0.005 && d.meanStrain < 1e-4 && d.flat && Math.abs(d.areaError) < 1e-4, JSON.stringify(d));
  const front = flattenMesh(body('sleeve', [side(30, 30, 80)]), { cuts: [{ path: [[0, -30, 0], [0, -30, 80]] }] });
  assert.equal(front.report.cuts.length, 1); assert.equal(front.report.cuts[0].kind, 'given'); assert.deepEqual(front.report.cuts[0].from, [0, -30, 0]);
  near(front.report.pieces[0].size[0], 2 * Math.PI * 30, 0.001, 'width');
});

test('a plate keeps its hole, a closed ball is slit open, and an offset grows the pieces by the thickness', () => {
  const plate = flattenMesh(body('gasket', [side(40, 15, 0, 64)]));
  assert.equal(plate.report.cuts.length, 0); assert.equal(plate.patterns[0].contours.length, 2); assert.equal(plate.report.pieces[0].holes, 1); assert.ok(plate.report.pieces[0].distortion.flat);
  near(plate.report.pieces[0].size[0], 80, 0.001, 'outer diameter'); sewable(plate);
  const ball = flattenMesh(body('ball', [surface(24, 12, (u, v) => { const a = 2 * Math.PI * u, t = Math.PI * (v - 0.5); return [20 * Math.cos(t) * Math.cos(a), 20 * Math.cos(t) * Math.sin(a), 20 * Math.sin(t)]; })]));
  assert.equal(ball.report.cuts.length, 1); assert.match(ball.report.cuts[0].why, /closed surface/); assert.equal(ball.report.pieces[0].distortion.flat, false);
  validateSoftgoodsDocument(mergeFlattened(new SoftgoodsDocument(null).toJSON(), ball));
  // A cover of 5 mm foam over the box: every face moves out by 5, so every piece is 10 longer each way and the seams still agree.
  const cover = flattenMesh(body('case', box(100, 60, 40)), { offset: 5, allowance: 6, material: 'foam' });
  assert.deepEqual(cover.report.pieces.map((p) => p.size), [[110, 70], [110, 70], [110, 50], [110, 50], [70, 50], [70, 50]]);
  assert.equal(cover.patterns[0].source.offset, 5); assert.equal(cover.patterns[0].material, 'foam'); assert.equal(Object.values(cover.patterns[0].allowances)[0], 6);
  sewable(cover);
  // A 3 mm plate: its four edge faces are too narrow to sew and are left out, with the reason.
  const thin = flattenMesh(body('plate', box(80, 50, 3)));
  assert.deepEqual(thin.patterns.map((p) => p.id), ['plate_bottom', 'plate_top']); assert.equal(thin.seams.length, 0); assert.equal(thin.report.skipped.length, 4); assert.match(thin.report.skipped[0].why, /minWidth/);
  assert.equal(flattenMesh(body('plate', box(80, 50, 3)), { minWidth: 0 }).patterns.length, 6);
});

test('two flaps that fold onto the same place are not one piece: a group that laps over itself says so', () => {
  // A plate with a square hole, and the two opposite walls of the hole, each longer than half the hole is wide:
  // unfolded into the hole they lie on each other, sharing their outline and crossing nowhere.
  const plate = { positions: [], indices: [] };
  for (let i = 0; i <= 4; i++) for (let j = 0; j <= 4; j++) plate.positions.push(10 * i, 10 * j, 0);
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) if (i < 1 || i > 2 || j < 1 || j > 2) plate.indices.push(i * 5 + j, (i + 1) * 5 + j, (i + 1) * 5 + j + 1, i * 5 + j, (i + 1) * 5 + j + 1, i * 5 + j + 1);
  const slot = body('slot', [plate, quad([10, 10, 0], [0, 0, -12], [0, 20, 0]), quad([30, 10, 0], [0, 20, 0], [0, 0, -12])]);
  const forced = flattenMesh(slot, { faces: [[0, 1, 2]] }), [report] = forced.report.pieces;
  assert.equal(forced.patterns.length, 1); assert.equal(report.distortion.maxStrain, 0); assert.equal(report.distortion.overlaps, true); assert.equal(report.distortion.flat, false); assert.match(report.advice, /laps over itself/);
  const grown = flattenMesh(slot, { smoothAngle: 100 });
  assert.deepEqual(grown.patterns.map((p) => p.source.faces), [[0, 1], [2]], 'the second wall stays its own piece'); assert.ok(grown.report.pieces.every((p) => p.distortion.flat)); assert.equal(grown.seams.length, 1);
  assert.equal(flattenMesh(slot).patterns.length, 3, 'and at the default angle a square fold is a seam');
});

test('runs of boundary points become one line or one Bezier within tolerance, or say where to break', () => {
  assert.deepEqual(fitRun([[0, 0], [10, 0.05], [20, -0.05], [30, 0]], 0.2), { type: 'line' });
  const arc = Array.from({ length: 25 }, (_, i) => [50 * Math.cos(i / 24 * Math.PI / 2), 50 * Math.sin(i / 24 * Math.PI / 2)]), fit = fitRun(arc, 0.2);
  assert.equal(fit.type, 'bezier');
  for (let i = 0; i <= 32; i++) { const s = i / 32, u = 1 - s, x = u ** 3 * 50 + 3 * u * u * s * fit.c1[0] + 3 * u * s * s * fit.c2[0], y = 3 * u * u * s * fit.c1[1] + 3 * u * s * s * fit.c2[1] + s ** 3 * 50; assert.ok(Math.abs(Math.hypot(x, y) - 50) < 0.2); }
  const corner = [[0, 0], [10, 0], [20, 0], [30, 0], [30, 10], [30, 20], [30, 30]];
  assert.equal(fitRun(corner, 0.2).split, 3, 'an L breaks at its corner');
  assert.ok(fitRun(Array.from({ length: 49 }, (_, i) => [50 * Math.cos(i / 48 * Math.PI * 1.5), 50 * Math.sin(i / 48 * Math.PI * 1.5)]), 0.2).split > 0, 'three quarters of a circle is more than one Bezier');
});

test('flattenPatch returns the stretch of every triangle, and refuses what has no boundary', () => {
  const s = surface(24, 6, (u, v) => { const a = 1.5 * Math.PI * u, t = 0.5 + 0.8 * v; return [50 * Math.cos(t) * Math.cos(a), 50 * Math.cos(t) * Math.sin(a), 50 * Math.sin(t)]; }), cap = { positions: Float64Array.from(s.positions), triangles: Int32Array.from(s.indices) };
  const flat = flattenPatch(cap.positions, cap.triangles);
  assert.equal(flat.uv.length, cap.positions.length / 3 * 2); assert.equal(flat.stretch.length, cap.triangles.length / 3 * 2);
  assert.ok(flat.distortion.maxStrain > 0.01 && flat.distortion.flips === 0); assert.ok([...flat.stretch].every((x) => x > 0.5 && x < 1.6));
  const tetra = { positions: Float64Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]), triangles: Int32Array.from([0, 2, 1, 0, 1, 3, 1, 2, 3, 0, 3, 2]) };
  assert.throws(() => flattenPatch(tetra.positions, tetra.triangles), /closed surface/);
});

test('bodies and faces are named as the viewer names them, and a wrong name says what there is', () => {
  const one = body('case', box(100, 60, 40)), lid = body('lid', [quad([0, 0, 50], [100, 0, 0], [0, 60, 0])]);
  const two = { positions: Float32Array.from([...one.positions, ...lid.positions]), indices: Uint32Array.from([...one.indices, ...[...lid.indices].map((i) => i + one.positions.length / 3)]), faces: [...one.faces, { first: one.indices.length / 3, count: lid.indices.length / 3 }], bodies: [one.bodies[0], { first: one.indices.length / 3, count: lid.indices.length / 3, name: 'lid' }] };
  assert.deepEqual(describeFaces(two).bodies.map((b) => b.name), ['case', 'lid']); assert.equal(describeFaces(two).faces, undefined);
  const listed = describeFaces(two, { body: 'case' });
  assert.equal(listed.faces.length, 6); assert.deepEqual(listed.faces[1], { index: 1, triangles: 8, area: 6000, centre: [50, 30, 40], normal: [0, 0, 1], kind: 'flat' });
  assert.equal(describeFaces(body('sleeve', [side(30, 30, 80)])).faces[0].kind, 'curved');
  assert.throws(() => flattenMesh(two), /2 bodies\. Name one: 0 'case', 1 'lid'/);
  assert.throws(() => flattenMesh(two, { body: 'handle' }), /No body 'handle'/);
  assert.throws(() => flattenMesh(two, { body: 'case', faces: [9] }), /No face 9: body 'case' has faces 0 to 5/);
  assert.throws(() => flattenMesh(two, { body: 'case', cuts: [[0, 1]] }), /do not share a border/);
  const r = flattenMesh(two, { body: 1, name: 'flap', avoid: ['flap_top'] });
  assert.deepEqual(r.patterns.map((p) => p.id), ['flap_top_2']); assert.equal(r.seams.length, 0);
  const pair = flattenMesh(two, { body: 'case', faces: [1, 2] });
  assert.deepEqual(pair.patterns.map((p) => p.id), ['case_top', 'case_front']); assert.equal(pair.seams.length, 1, 'only the edge the two chosen faces share is a seam');
});

test('a real STEP import flattens: a cube to six squares, a filleted block with its fillet in one piece with the faces it joins', async () => {
  const cube = await importCadFile(fs.readFileSync(path.join(fixtures, 'cube.stp')), { name: 'cube.stp' }), r = flattenMesh(cube);
  assert.equal(r.patterns.length, 6); assert.equal(r.seams.length, 12); assert.ok(r.report.pieces.every((p) => p.size[0] === 300 && p.size[1] === 300 && p.distortion.maxStrain === 0));
  assert.deepEqual(r.patterns.map((p) => p.id).sort(), ['cube_back', 'cube_bottom', 'cube_front', 'cube_left', 'cube_right', 'cube_top']);
  sewable(r);
  const rounded = await importCadFile(fs.readFileSync(path.join(fixtures, 'rounded.step')), { name: 'rounded.step', linearDeflection: 0.0001, angularDeflection: 0.1 }), f = flattenMesh(rounded);
  const curved = describeFaces(rounded).faces.filter((x) => x.kind === 'curved').map((x) => x.index); assert.equal(curved.length, 1);
  const joined = f.patterns.find((p) => p.source.faces.includes(curved[0]));
  assert.equal(joined.source.faces.length, 3, 'the fillet and the two faces it is tangent to'); assert.ok(f.report.pieces.every((p) => p.distortion.flat && p.distortion.maxStrain < 1e-4));
  assert.ok(f.report.seams.every((s) => s.mismatch < 0.002), 'a fine tessellation leaves the two sides of every seam the same length');
  sewable(f);
});

test('POST /flatten lists, previews, appends and replaces through the document, and the cloth preview takes the result', async () => {
  const doc = new SoftgoodsDocument(null), app = express(); app.use(express.json()); app.use('/s', softgoodsRouter(doc));
  const server = app.listen(0), file = path.join(fixtures, 'cube.stp');
  const call = async (p, method = 'GET', data) => { const r = await fetch(`http://127.0.0.1:${server.address().port}/s${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: data && JSON.stringify(data) }); return { status: r.status, ...(await r.json()) }; };
  try {
    const changes = []; doc.onChange(() => changes.push(doc.data.revision));
    const list = await call('/flatten', 'POST', { path: file, mode: 'list' });
    assert.equal(list.body, 'cube'); assert.equal(list.faces.length, 6); assert.equal(list.source.file, file);
    const preview = await call('/flatten', 'POST', { path: file, mode: 'preview' });
    assert.equal(preview.pieces.length, 6); assert.equal(preview.patterns.length, 6); assert.equal(doc.data.patterns.length, 0); assert.deepEqual(changes, []);
    const top = list.faces.find((f) => f.normal[2] === 1).index, front = list.faces.find((f) => f.normal[1] === -1).index;
    const first = await call('/flatten', 'POST', { path: file, faces: [top, front], allowance: 8 });
    assert.equal(first.status, 200); assert.equal(first.revision, 1); assert.deepEqual(first.pieces.map((p) => p.id), ['cube_top', 'cube_front']); assert.equal(first.seams.length, 1); assert.equal(first.source.body, 'cube');
    const again = await call('/flatten', 'POST', { path: file, faces: [top] });
    assert.deepEqual(again.pieces.map((p) => p.id), ['cube_top_2'], 'appending never reuses an id'); assert.equal(doc.data.patterns.length, 3); assert.deepEqual(changes, [1, 2]);
    assert.equal(doc.data.patterns[0].source.file, file); assert.deepEqual(doc.data.arrangement.map((a) => a.source), ['flatten', 'flatten', 'flatten']);
    const input = await call('/simulation-input?target=60');
    assert.equal(input.status, 200); assert.equal(input.meshes.length, 3); assert.equal(input.seams.length, 1); assert.deepEqual(input.arrangement[0].position, doc.data.arrangement[0].position);
    doc.data.materials = { canvas: { arealDensity: 340 } };
    const all = await call('/flatten', 'POST', { path: file, mode: 'replace' });
    assert.equal(all.pieces.length, 6); assert.equal(all.seams.length, 12); assert.equal(doc.data.patterns.length, 6); assert.equal(doc.data.seams.length, 12); assert.deepEqual(doc.data.materials, { canvas: { arealDensity: 340 } });
    assert.equal((await call('/check')).ok, true);
    assert.equal((await call('/flatten', 'POST', { path: file, faces: [17] })).status, 400);
    assert.match((await call('/flatten', 'POST', { path: 'cube.stp' })).error, /absolute path/);
    assert.match((await call('/flatten', 'POST', { path: file, mode: 'sideways' })).error, /mode must be/);
  } finally { server.close(); }
});

test('with no path the cell document is the source: faces go by their topology numbers, and a filleted form wraps in one strip', async () => {
  const cells = new CellDocument(), doc = new SoftgoodsDocument(null), app = express(); app.use(express.json());
  app.use('/api/cells', cellsRouter(cells, fixtures)); app.use('/api/softgoods', softgoodsRouter(doc));
  const server = app.listen(0), call = async (p, method = 'GET', data) => { const r = await fetch(`http://127.0.0.1:${server.address().port}/api${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: data && JSON.stringify(data) }); return { status: r.status, ...(await r.json()) }; };
  try {
    assert.match((await call('/softgoods/flatten', 'POST', { mode: 'list' })).error, /empty|no model/i);
    await call('/cells', 'POST', { id: 'pouch_form', prompt: 'the hard form a pouch wraps', code: 'export const params = { w: 120, d: 60, h: 160, r: 12 };\nexport default ({ p, brep, q }) => { const s = brep.box(p.w, p.d, p.h); return brep.fillet(s, q.edges(s).linear().along("z").expect(4), p.r); };' });
    const list = await call('/softgoods/flatten', 'POST', { mode: 'list' }), topology = await call('/cells/topology');
    assert.deepEqual(list.source, { cell: 'output' }); assert.equal(list.faces.length, topology.faces.length);
    list.faces.forEach((f, i) => { const t = topology.faces[i]; assert.ok(Math.hypot(...f.centre.map((c, k) => c - t.center[k])) < 0.05 && Math.abs(f.area - t.area) < 0.002 * t.area, `face ${i} is topology face ${i}`); assert.equal(f.kind === 'flat', t.kind === 'PLANE'); });
    const r = await call('/softgoods/flatten', 'POST', { cell: 'pouch_form', name: 'pouch', offset: 2 });
    assert.equal(r.status, 200); assert.deepEqual(r.pieces.map((p) => p.id).sort(), ['pouch_bottom', 'pouch_top', 'pouch_wrap']);
    const wrap = r.pieces.find((p) => p.id === 'pouch_wrap'), round = 2 * (124 + 64) - 8 * 14 + 2 * Math.PI * 14;   // grown 2 mm: 124 by 64 with 14 mm corners
    assert.equal(wrap.faces.length, 8); near(wrap.size[0], round, 0.001, 'the strip is as long as the form is round'); near(wrap.size[1], 164, 1e-4, 'and as tall');
    assert.ok(r.pieces.every((p) => p.distortion.flat) && r.seams.every((s) => s.mismatch < 0.002), JSON.stringify(r.seams.map((s) => s.mismatch)));
    assert.equal(r.seams.filter((s) => s.closes).length, 1, 'one seam closes the strip'); assert.equal(doc.data.patterns.length, 3);
    assert.equal((await call('/softgoods/simulation-input')).status, 200); assert.equal((await call('/softgoods/check')).ok, true);
    const top = topology.faces.find((f) => f.kind === 'PLANE' && f.normal[2] > 0.99).i, lid = await call('/softgoods/flatten', 'POST', { faces: [top], mode: 'preview' });
    assert.deepEqual(lid.pieces.map((p) => [p.id, p.size]), [['pouch_form_top', [120, 60]]]);
  } finally { server.close(); }
});

test('a small round piece the preview mesher cannot take at its mesh size is meshed with finer curves, the same in the page input and the server drape', async () => {
  // A 30 mm washer with a 20 mm hole off centre: at a 25 mm mesh every arc is one chord and the hole's corners fall outside the rim's.
  const r = flattenMesh(body('washer', [washer(15, 10, 3, 0.4)])), d = validateSoftgoodsDocument(mergeFlattened(new SoftgoodsDocument(null).toJSON(), r)), [p] = d.patterns;
  assert.equal(p.contours.length, 2); assert.throws(() => meshPattern(p, { target: 25 }), /fell outside its pattern/);
  const fine = meshPatternFine(p, { target: 25 }); assert.ok(fine.triangles.length / 3 >= 20 && fine.holes === 1);
  assert.deepEqual(meshPatternFine(piece(flattenMesh(body('case', box(100, 60, 40))), 'case_top'), { target: 25 }), meshPattern(piece(flattenMesh(body('case', box(100, 60, 40))), 'case_top'), { target: 25 }), 'a piece that meshes at the first try is untouched');
  const doc = new SoftgoodsDocument(null), app = express(); app.use(express.json()); app.use('/s', softgoodsRouter(doc)); doc.replace(d);
  const server = app.listen(0);
  try {
    const page = await (await fetch(`http://127.0.0.1:${server.address().port}/s/simulation-input`)).json(), input = simulationInput(doc.toJSON(), 25);
    assert.deepEqual(page, JSON.parse(JSON.stringify(input)), 'the page and the server drape start from the same input');
    assert.equal(input.meshes[0].triangles.length, fine.triangles.length); assert.equal(input.arrangement[0].source, 'flatten'); assert.deepEqual(input.patterns[0].source.faces, [0]); assert.equal(input.patterns[0].source.kind, 'flatten');
    assert.equal(drapeDocument(doc.toJSON(), { steps: 20 }).pieces.length, 1);
  } finally { server.close(); }
});

test('a flattened can and box go through every production format, and drape sewn shut from where they sit on the part', () => {
  for (const [name, mesh, pieces] of [['can', body('can', [side(30, 30, 80), disc(30, 80, 1), disc(30, 0, -1)]), 3], ['case', body('case', box(100, 60, 40)), 6]]) {
    const r = flattenMesh(mesh, { material: 'canvas' }), d = validateSoftgoodsDocument(mergeFlattened(new SoftgoodsDocument(null).toJSON(), r)), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadgang-flatten-'));
    try {
      const out = exportProduction(d, dir, name, { formats: ['marker', 'bom', 'print', 'svg'], dxf: 'astm-style' }), read = (f) => fs.readFileSync(path.join(dir, f), 'utf8'), notches = d.patterns.reduce((n, p) => n + p.notches.length, 0);
      assert.equal(out.check.ok, true); assert.equal(out.files.length, 2 * pieces + 8, out.files.map((f) => path.basename(f)).join(' '));
      for (const f of ['tech-pack.json', 'tech-pack.html', 'marker_canvas.dxf', 'marker_canvas.svg', 'bom.json', 'bom.html', 'print_a4.html', 'astm-style.dxf']) assert.ok(fs.statSync(path.join(dir, `${name}_${f}`)).size > 200, f);
      assert.equal(out.markers[0].pieces, pieces); assert.equal(out.bom.materials[0].id, 'canvas'); assert.equal(out.bom.materials[0].cutPieces, pieces); assert.equal(out.bom.seams.byKind[0].count, d.seams.length);
      // Match notches are cut like any other: on every pattern DXF, on the marker and on the numbered ASTM layer.
      assert.equal(d.patterns.reduce((n, p) => n + count(read(`${name}_${p.id}.dxf`), '\nLINE\n8\nNOTCH\n'), 0), notches); assert.equal(count(read(`${name}_marker_canvas.dxf`), '\nLINE\n8\nNOTCH\n'), notches);
      assert.equal(count(read(`${name}_astm-style.dxf`), '\nLINE\n8\n4\n'), notches); for (const p of d.patterns) assert.equal(read(`${name}_${p.id}.svg`).includes('<g id="NOTCH"'), p.notches.length > 0, `${p.id}.svg`);
      assert.equal(read(`${name}_print_a4.html`).includes('class="ln NOTCH"'), notches > 0);
      // The tech pack says where each piece came from.
      const pack = JSON.parse(read(`${name}_tech-pack.json`)); assert.deepEqual(pack.patterns[0].source.faces, [0]); assert.equal(pack.seams.length, d.seams.length);
      assert.equal(count(read(`${name}_tech-pack.html`), `flattened from ${name}, face `), pieces); assert.match(read(`${name}_tech-pack.html`), /lies flat/);
    } finally { fs.rmSync(dir, { recursive: true }); }
    // Draped with nothing under it the cover falls, but it falls sewn: every seam stays shut and the cloth barely stretches.
    const drape = drapeDocument(d, { target: 30, steps: 60 }), by = new Map(drape.pieces.map((p) => [p.id, p])), at = (p, q) => [0, 1, 2].map((k) => q.vertices.reduce((n, v, i) => n + q.weights[i] * p.positions[3 * v + k], 0));
    let gap = 0; for (const s of drape.seams) for (const pair of s.pairs) { const a = at(by.get(s.a.pattern), pair.a), b = at(by.get(s.b.pattern), pair.b); gap = Math.max(gap, Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])); }
    const strain = Math.max(...drape.pieces.flatMap((p) => [...p.strain]));
    assert.equal(drape.pieces.length, pieces); assert.ok(drape.pieces.every((p) => p.positions.every(Number.isFinite)));
    assert.ok(gap < 5 && strain < 0.1, `${name}: widest seam gap ${gap.toFixed(2)} mm, most strain ${strain.toFixed(3)}`);
    if (name === 'case') {   // six flat panels laid on the six faces: sewn shut and unstretched from the first step, the size of the box
      assert.ok(gap < 0.01 && strain < 1e-3, `gap ${gap}, strain ${strain}`);
      const extent = [0, 1, 2].map((k) => { const c = drape.pieces.flatMap((p) => [...p.positions].filter((_, i) => i % 3 === k)); return Math.max(...c) - Math.min(...c); });
      extent.forEach((e, k) => near(e, [100, 60, 40][k], 0.002, 'the cover keeps the shape of the box'));
    }
  }
});

test('a flattened dome takes the dart its advice asks for, through the edit route', async () => {
  const doc = new SoftgoodsDocument(null), app = express(); app.use(express.json()); app.use('/s', softgoodsRouter(doc));
  const r = flattenMesh(body('dome', [hemisphere(50)])), rim = r.patterns[0].segments[0].id; doc.replace(mergeFlattened(doc.toJSON(), r));
  const server = app.listen(0), call = async (p, data) => { const res = await fetch(`http://127.0.0.1:${server.address().port}/s${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }); return { status: res.status, ...(await res.json()) }; };
  try {
    assert.match(r.report.pieces[0].advice, /darts/);
    const edited = await call('/edit', { op: 'dart', pattern: r.patterns[0].id, segment: rim, at: 0.5, width: 20, length: 45 });
    assert.equal(edited.status, 200, edited.error); assert.equal(edited.check.ok, true);
    const d = doc.toJSON(), [p] = d.patterns;
    assert.equal(p.segments.length, r.patterns[0].segments.length + 3, 'the rim split in two, and two legs'); assert.deepEqual(d.annotations.map((a) => a.type), ['dart']); assert.equal(d.seams.length, 1, 'the legs are sewn to each other');
    assert.deepEqual(p.source.faces, [0], 'it is still the piece flattened from that face'); assert.ok(meshPatternFine(p, { target: 20 }).triangles.length > 0);
    assert.deepEqual(editSoftgoods(mergeFlattened(new SoftgoodsDocument(null).toJSON(), r), { op: 'autoNotch' }).patterns[0].notches, [], 'no seams, no notches');
    // A dart across an edge that a span seam sews is refused by the edit, as for any span seam.
    const can = mergeFlattened(new SoftgoodsDocument(null).toJSON(), flattenMesh(body('can', [side(30, 30, 80), disc(30, 80, 1), disc(30, 0, -1)])));
    assert.throws(() => editSoftgoods(can, { op: 'dart', pattern: 'can_top', segment: can.patterns[1].segments[0].id, at: 0.5, width: 8, length: 12 }), /sews a span of edges/);
  } finally { server.close(); }
});

test('the flatten tool sends its options as given, and a flattened piece keeps its source when the design is set again', async () => {
  const tools = {}, sent = [];
  registerSoftgoodsTools({ registerTool: (name, spec, handler) => { tools[name] = { spec, handler }; } }, { call: async (p, opts) => { sent.push([p, opts]); return p.endsWith('/check') ? { ok: true } : { revision: 3, pieces: [] }; }, ok: (v) => v, fail: (e) => { throw e; } });
  const schema = z.object(tools.cadgang_softgoods_flatten.spec.inputSchema);
  const args = schema.parse({ path: '/tmp/case.step', body: 'case', faces: [[0, 1], [2]], cuts: [[1, 2], { path: [[0, 0, 0], [0, 0, 80]] }], offset: 3, mode: 'replace' });
  const result = await tools.cadgang_softgoods_flatten.handler(args);
  assert.deepEqual(sent[0], ['/softgoods/flatten', { method: 'POST', body: args }]); assert.deepEqual(result.check, { ok: true });
  sent.length = 0; assert.equal((await tools.cadgang_softgoods_flatten.handler(schema.parse({ mode: 'list' }))).check, undefined); assert.equal(sent.length, 1);
  assert.throws(() => schema.parse({ faces: [0.5] })); assert.throws(() => schema.parse({ mode: 'fold' }));
  assert.match(tools.cadgang_softgoods_get.spec.description, /cadgang_softgoods_flatten/); assert.ok(tools.cadgang_softgoods_edit && tools.cadgang_softgoods_measure && tools.cadgang_softgoods_export, 'registered alongside the other softgoods tools');
  const r = flattenMesh(body('case', box(100, 60, 40)), { faces: [1] }), parsed = z.object(tools.cadgang_softgoods_set.spec.inputSchema).parse({ patterns: r.patterns, seams: r.seams });
  assert.deepEqual(parsed.patterns[0].source, r.patterns[0].source);
});
