// Drafting by hand (web/softgoods-draft.js): every edit gives a document the server accepts, and keeps what depends on it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SoftgoodsDocument, validateSoftgoodsDocument } from '../src/core/softgoods-document.js';
import { addPiece, movePoint, insertPoint, toCurve, toLine, removePoint, removePiece, sewEdges, segLength, sample, boardLayout } from '../web/softgoods-draft.js';

const two = () => { const d = new SoftgoodsDocument(null); d.addRectangle({ id: 'front', width: 200, height: 100 }); d.addRectangle({ id: 'back', width: 200, height: 100 }); return d.toJSON(); };
const ok = (d) => validateSoftgoodsDocument(d);
const piece = (d, id) => d.patterns.find((p) => p.id === id);

test('drafting: a piece drawn either way round is a counter-clockwise outline the server takes', () => {
  const d = ok(addPiece(two(), [{ x: 0, y: 0 }, { x: 0, y: 80 }, { x: 60, y: 80 }, { x: 60, y: 0 }]));   // clicked clockwise
  const p = piece(d, 'piece_1'), ring = p.contours[0].map((sid) => p.segments.find((s) => s.id === sid)).map((s) => p.points.find((q) => q.id === s.a));
  let area = 0; ring.forEach((u, i) => { const v = ring[(i + 1) % ring.length]; area += u.x * v.y - v.x * u.y; });
  assert.ok(area > 0, 'counter-clockwise'); assert.equal(p.segments.length, 4); assert.ok(d.arrangement.some((a) => a.pattern === 'piece_1'));
  assert.throws(() => addPiece(two(), [{ x: 0, y: 0 }, { x: 1, y: 1 }]), /three or more/);
});

test('drafting: a point on a sewn edge splits it, the seam runs over both halves, and the edge keeps its length', () => {
  let d = sewEdges(two(), { pattern: 'front', segment: 'front_top' }, { pattern: 'back', segment: 'back_top' });
  d = ok(insertPoint(d, 'front', 'front_top', 0.25));
  const p = piece(d, 'front'), halves = p.contours[0].filter((sid) => sid.startsWith('front_top'));
  assert.equal(halves.length, 2); assert.deepEqual(d.seams[0].a.segments, halves);
  assert.ok(Math.abs(halves.reduce((n, sid) => n + segLength(p, p.segments.find((s) => s.id === sid)), 0) - 200) < 1e-6);
  assert.equal(p.allowances[halves[1]], p.allowances.front_top);
});

test('drafting: a bent edge is a Bezier on the line until its handles move; split, it is the same curve; straightened, its handles go', () => {
  let d = ok(toCurve(two(), 'front', 'front_right')); const s = () => piece(d, 'front').segments.find((v) => v.id === 'front_right');
  assert.equal(s().type, 'bezier'); assert.ok(Math.abs(segLength(piece(d, 'front'), s()) - 100) < 1e-6, 'still straight');
  d = ok(movePoint(d, 'front', s().c1, 240, 30)); d = ok(movePoint(d, 'front', s().c2, 240, 70));
  const before = sample(piece(d, 'front'), s(), 8), mid = before[4];
  d = ok(insertPoint(d, 'front', 'front_right', 0.5)); const p = piece(d, 'front'), at = p.points.find((q) => q.id === s().b);
  assert.ok(Math.hypot(at.x - mid.x, at.y - mid.y) < 0.02, 'the new point is on the old curve');
  d = ok(toLine(d, 'front', 'front_right')); assert.equal(s().type, 'line'); assert.ok(!piece(d, 'front').points.some((q) => q.id === 'front_right_c_1'));
});

test('drafting: deleting a corner joins its edges, a handle straightens its edge, and what a seam or the shape needs is kept', () => {
  let d = ok(insertPoint(two(), 'front', 'front_bottom', 0.5)); const added = piece(d, 'front').segments.find((s) => s.id === 'front_bottom').b;
  d = ok(removePoint(d, 'front', added)); assert.equal(piece(d, 'front').segments.length, 4); assert.ok(Math.abs(segLength(piece(d, 'front'), piece(d, 'front').segments[0]) - 200) < 1e-6);
  const tri = addPiece(two(), [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 0, y: 50 }]); assert.throws(() => removePoint(tri, 'piece_1', 'piece_1_p2'), /three edges/);
  const sewn = sewEdges(two(), { pattern: 'front', segment: 'front_right' }, { pattern: 'back', segment: 'back_left' });
  assert.throws(() => removePoint(sewn, 'front', 'front_br'), /sewn/);
  const curved = toCurve(two(), 'front', 'front_top'), h = piece(curved, 'front').segments.find((s) => s.id === 'front_top').c1;
  assert.equal(piece(ok(removePoint(curved, 'front', h)), 'front').segments.find((s) => s.id === 'front_top').type, 'line');
});

test('drafting: a piece goes with its seams, and one a trim still names stays', () => {
  const d = sewEdges(two(), { pattern: 'front', segment: 'front_right' }, { pattern: 'back', segment: 'back_left' }), gone = ok(removePiece(d, 'back'));
  assert.deepEqual(gone.patterns.map((p) => p.id), ['front']); assert.equal(gone.seams.length, 0); assert.ok(!gone.arrangement.some((a) => a.pattern === 'back'));
  const doc = new SoftgoodsDocument(null); doc.replace(two()); doc.addTrim({ id: 'snap', kind: 'snap', at: { pattern: 'back', u: 50, v: 50 } });
  assert.throws(() => removePiece(doc.toJSON(), 'back'), /still names 'back'/);
  assert.throws(() => sewEdges(d, { pattern: 'front', segment: 'front_top' }, { pattern: 'front', segment: 'front_top' }), /itself/);
});

test('drafting: the board lays the pieces side by side without overlapping', () => {
  const lay = boardLayout(two()), f = lay.get('front'), b = lay.get('back');
  assert.ok(f.hi[0] + f.dx < b.lo[0] + b.dx, JSON.stringify([...lay]));
});
