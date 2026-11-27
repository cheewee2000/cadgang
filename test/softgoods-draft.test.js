// Drafting by hand (web/softgoods-draft.js): every edit gives a document the server accepts, and keeps what depends on it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SoftgoodsDocument, validateSoftgoodsDocument } from '../src/core/softgoods-document.js';
import { addPiece, movePoint, insertPoint, toCurve, toLine, removePoint, removePiece, sewEdges, segLength, sample, boardLayout, addNotch, setAllowance, AMOUNTS, setPiece, addSize, removeSize, gradePoint, graded, setMaterial, TRIM_KINDS, addTrim, removeTrim } from '../web/softgoods-draft.js';
import { TRIM_KINDS as CORE_TRIMS } from '../src/core/softgoods-trims.js';
import { editSoftgoods } from '../src/core/softgoods-edit.js';

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

test('drafting: notches and allowances are set on the board; the server operations take what the board sends', () => {
  let d = ok(addNotch(two(), 'front', 'front_top', 0.3)); assert.deepEqual(piece(d, 'front').notches, [{ segment: 'front_top', at: 0.3, kind: 'match' }]);
  d = ok(setAllowance(d, 'front', 'front_top', 15)); assert.equal(piece(d, 'front').allowances.front_top, 15); assert.throws(() => setAllowance(d, 'front', 'front_top', -1), /0 mm or more/);
  // The arguments the board's DART, PLEAT, CUT, LINE and MIRROR send (web/softgoods-draft.js), at the fields' defaults.
  const [[, width], [, length]] = AMOUNTS.dart, [[, intake]] = AMOUNTS.pleat;
  const darted = editSoftgoods(two(), { op: 'dart', pattern: 'front', segment: 'front_top', at: 0.5, width, length });
  assert.ok(darted.seams.length >= 1, 'the dart legs are sewn');
  assert.ok(editSoftgoods(two(), { op: 'pleat', pattern: 'front', segment: 'front_top', at: 0.4, intake }).annotations.some((a) => a.type === 'pleat' || a.type === 'fold_line'));
  assert.deepEqual(editSoftgoods(two(), { op: 'split', pattern: 'front', from: { segment: 'front_top', at: 0.5 }, to: { segment: 'front_bottom', at: 0.5 } }).patterns.map((p) => p.id).sort(), ['back', 'front_a', 'front_b']);
  assert.equal(piece(editSoftgoods(two(), { op: 'internalLine', pattern: 'front', a: [20, 20], b: [120, 20] }), 'front').internalLines.length, 1);
  assert.equal(editSoftgoods(two(), { op: 'mirror', pattern: 'front', segment: 'front_right' }).patterns.length, 3);
});

test('drafting: a piece\'s name, material, cut count and grain are set in place, and nonsense is refused', () => {
  const d = ok(setPiece(two(), 'front', { name: 'Front panel', material: 'denim', cut: '2', grain: '45' })), p = piece(d, 'front');
  assert.deepEqual([p.name, p.material, p.cut, p.grain.angle], ['Front panel', 'denim', 2, 45]);
  assert.throws(() => setPiece(two(), 'front', { cut: 0 }), /whole number/); assert.throws(() => setPiece(two(), 'front', { name: ' ' }), /needs a name/);
});

test('drafting: a size is added, a point dragged in it is a rule the server takes, back to the base drops it, and the size goes', () => {
  let d = ok(addSize(two(), 'L')); assert.throws(() => addSize(d, 'L'), /already/); assert.throws(() => addSize(d, ' '), /needs a name/);
  d = ok(gradePoint(d, 'L', 'front', 'front_tr', 10, 5)); const L = () => d.grades.find((g) => g.size === 'L');
  const at = graded(piece(d, 'front'), L()).points.find((q) => q.id === 'front_tr'), base = piece(d, 'front').points.find((q) => q.id === 'front_tr');
  assert.deepEqual([at.x - base.x, at.y - base.y], [10, 5]);
  d = ok(gradePoint(d, 'L', 'front', 'front_tr', 0, 0)); assert.equal(L().rules.length, 0);
  assert.throws(() => gradePoint(d, 'XL', 'front', 'front_tr', 1, 1), /No size/);
  assert.deepEqual(ok(removeSize(d, 'L')).grades, []);
});

test('drafting: a fabric starts from a preset, its own numbers go over it, a blank one falls back, and nonsense is refused', () => {
  let d = ok(setMaterial(two(), 'shell', { preset: 'nylon-500d', color: '#336699', arealDensity: '255', 'tensile.warp': '40' }));
  assert.deepEqual(d.materials.shell, { preset: 'nylon-500d', color: '#336699', arealDensity: 255, tensile: { warp: 40 } });
  d = ok(setMaterial(d, 'shell', { arealDensity: '', 'tensile.warp': '' })); assert.deepEqual(d.materials.shell, { preset: 'nylon-500d', color: '#336699' });
  assert.throws(() => setMaterial(d, 'shell', { friction: 2 }), /between 0 and 1/); assert.throws(() => setMaterial(d, 'shell', { color: 'red' }), /#rrggbb/);
  assert.throws(() => validateSoftgoodsDocument(setMaterial(d, 'shell', { preset: 'silk' })), /not in the fabric library/);
  assert.equal(ok(setMaterial(d, 'shell', { rollWidth: '1400' })).materials.shell.rollWidth, 1400);
});

test('drafting: TRIM places the core\'s kinds, a spot on a piece or an edge and a length along one, and takes them away', () => {
  for (const [place, kinds] of Object.entries(TRIM_KINDS)) assert.deepEqual(kinds.sort(), Object.keys(CORE_TRIMS).filter((k) => CORE_TRIMS[k].place === place).sort());
  let d = ok(addTrim(two(), 'snap', { at: { pattern: 'front', u: 50, v: 50 } })); d = ok(addTrim(d, 'snap', { at: { pattern: 'front', segment: 'front_top', t: 0.5, inset: 10 } }));
  d = ok(addTrim(d, 'zipper', { along: [{ pattern: 'front', segment: 'front_right' }] }));
  assert.deepEqual(d.trims.map((t) => t.id), ['snap_1', 'snap_2', 'zipper_1']);
  assert.deepEqual(ok(removeTrim(d, 'snap_1')).trims.map((t) => t.id), ['snap_2', 'zipper_1']);
});
