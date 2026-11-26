// The bill of materials against numbers worked out by hand.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SoftgoodsDocument, validateSoftgoodsDocument } from '../src/core/softgoods-document.js';
import { techPack, techPackHTML } from '../src/core/softgoods-export.js';
import { billOfMaterials, bomPage } from '../src/core/softgoods-bom.js';
import { tee } from './fixtures/softgoods-tee.js';

// Two 200 × 150 panels with a 10 mm allowance all round: each is cut 220 × 170. Grain runs up the 150, so on the roll a
// piece is 170 long and 220 across. A 500 mm roll takes both side by side: the marker is 170 mm long.
function pouch(material = { arealDensity: 400, rollWidth: 500, pricePerMeter: 12 }) {
  const d = new SoftgoodsDocument(null); d.addRectangle({ id: 'front', width: 200, height: 150, allowance: 10 }); d.addRectangle({ id: 'back', width: 200, height: 150, allowance: 10 });
  d.addSeam({ id: 'side', a: { pattern: 'front', segment: 'front_right' }, b: { pattern: 'back', segment: 'back_left' } }); d.addSeam({ id: 'base', a: { pattern: 'front', segment: 'front_bottom' }, b: { pattern: 'back', segment: 'back_bottom' }, kind: 'overlock' });
  return { ...d.toJSON(), materials: { canvas: material } };
}

test('cloth: net and consumed area, weight and cost, by hand', () => {
  const bom = billOfMaterials(pouch(), { gap: 0 }), m = bom.materials[0];
  assert.equal(bom.materials.length, 1); assert.equal(bom.units, 1); assert.deepEqual(bom.sizes, [{ size: 'base', units: 1 }]);
  assert.equal(m.id, 'canvas'); assert.equal(m.cutPieces, 2);
  assert.equal(m.netAreaM2, 0.0748);            // 2 × 220 × 170 mm²
  assert.equal(m.rollWidthMm, 500); assert.equal(m.rollWidthSource, 'material'); assert.equal(m.markerLengthMm, 170); assert.equal(m.lengthPerUnitMm, 170);
  assert.equal(m.consumedAreaM2, 0.085);        // 500 × 170 mm²
  assert.equal(m.efficiency, 0.88);             // 74800 / 85000
  assert.equal(m.netWeightG, 29.9);             // 0.0748 m² × 400 g/m² = 29.92
  assert.equal(m.consumedWeightG, 34);          // 0.085 m² × 400 g/m²
  assert.equal(m.cost, 2.04);                   // 0.17 m × 12 per running metre
  assert.deepEqual(bom.cost.total, 2.04); assert.equal(bom.cost.complete, true);
});

test('a price per square metre is charged on the roll the marker takes; no price, no cost', () => {
  assert.equal(billOfMaterials(pouch({ arealDensity: 400, rollWidth: 500, pricePerSqm: 20 }), { gap: 0 }).materials[0].cost, 1.7);   // 0.085 m² × 20
  const none = billOfMaterials(pouch({ rollWidth: 500 }), { gap: 0 }); assert.equal(none.materials[0].cost, null); assert.equal(none.materials[0].netWeightG, null); assert.equal(none.cost.total, null); assert.equal(none.cost.complete, false);
});

test('seams by kind, and a thread estimate that states its multiplier', () => {
  const bom = billOfMaterials(pouch());
  assert.deepEqual(bom.seams.byKind, [{ kind: 'plain', count: 1, lengthMm: 150, threadMultiplier: 2.5, threadMm: 375 }, { kind: 'overlock', count: 1, lengthMm: 200, threadMultiplier: 2.5, threadMm: 500 }]);
  assert.equal(bom.seams.totalMm, 350); assert.equal(bom.thread.lengthMm, 875); assert.equal(bom.thread.multiplier, 2.5); assert.match(bom.thread.basis, /2\.5.*lockstitch.*estimate/);
  const tuned = billOfMaterials(pouch(), { threadMultiplier: { overlock: 14, default: 3 } });
  assert.equal(tuned.thread.lengthMm, 150 * 3 + 200 * 14); assert.equal(billOfMaterials(pouch(), { threadMultiplier: 4 }).thread.lengthMm, 1400);
});

test('trims have a named, empty place in the bill', () => {
  const bom = billOfMaterials(pouch()); assert.deepEqual(bom.trims, []); assert.match(bomPage(bom, 'pouch'), /<h2>TRIMS<\/h2><p>Not modelled yet\.<\/p>/);
});

test('units and graded sizes multiply the bill, and a preset supplies the weight', () => {
  const d = validateSoftgoodsDocument(tee()), one = billOfMaterials(d), six = billOfMaterials(d, { sizes: { base: 2, L: 2, XL: 2 } });
  assert.equal(one.materials[0].arealDensity, 160); assert.equal(one.materials[0].preset, 'cotton-jersey'); assert.equal(one.materials[0].source, 'typical, not measured');
  assert.equal(one.materials[0].cutPieces, 6); assert.equal(six.materials[0].cutPieces, 36); assert.equal(six.units, 6);
  assert.ok(Math.abs(six.materials[0].lengthPerUnitMm - six.materials[0].markerLengthMm / 6) < 0.1);
  assert.equal(six.seams.byKind.find((k) => k.kind === 'overlock').count, 12); assert.equal(six.seams.byKind.find((k) => k.kind === 'overlock').lengthMm, 12 * 450);
  assert.equal(one.materials[0].cost, +(9 * one.materials[0].markerLengthMm / 1000).toFixed(2));
});

test('a piece too wide for its roll is reported on its row and the rest of the bill stands', () => {
  const bom = billOfMaterials(pouch(), { width: 100 }), m = bom.materials[0];
  assert.match(m.markerError, /across the roll/); assert.equal(m.markerLengthMm, null); assert.equal(m.cost, null); assert.equal(bom.seams.totalMm, 350);
});

test('the tech pack carries the bill, as JSON and in its HTML', () => {
  const pack = techPack(pouch(), 'pouch'), html = techPackHTML(pack);
  assert.equal(pack.bom.materials[0].cutPieces, 2); assert.deepEqual(pack.bom.trims, []);
  assert.match(html, /<h2>BILL OF MATERIALS<\/h2>/); assert.match(html, /<h2>SEAMS AND THREAD<\/h2>/); assert.match(html, /SEAM SCHEDULE/);
  const page = bomPage(pack.bom, 'pouch'); assert.match(page, /"Space Mono"/); assert.ok(!/font-weight:\s*(bold|[5-9]00)|italic|border-radius:\s*[1-9]/.test(page));
});
