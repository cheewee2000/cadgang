// The fabric library: typical starting values that say they are not measured, and a document material that stands on one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FABRICS, resolveMaterial, resolveMaterials } from '../src/core/softgoods-fabrics.js';
import { SoftgoodsDocument, validateSoftgoodsDocument } from '../src/core/softgoods-document.js';

test('every library fabric says it is not measured and stays inside the material schema', () => {
  const known = new Set(['name', 'arealDensity', 'thickness', 'rigidity', 'tensile', 'shearRigidity', 'damping', 'friction', 'notes', 'source']);
  assert.ok(Object.keys(FABRICS).length >= 12);
  for (const [id, f] of Object.entries(FABRICS)) {
    assert.match(id, /^[a-z0-9-]+$/); assert.equal(f.source, 'typical, not measured', id); assert.ok(f.name && f.notes, id);
    for (const [key, v] of Object.entries(f)) { assert.ok(known.has(key), `${id}.${key}`); if (typeof v === 'number') assert.ok(v > 0, `${id}.${key}`); }
  }
  // A number nobody could vouch for is absent, not guessed: foam has no weight, a knit has no rigidity.
  assert.equal(FABRICS['closed-cell-foam-6mm'].arealDensity, undefined); assert.equal(FABRICS['cotton-jersey'].rigidity, undefined);
});

test('a document material stands on its preset and keeps its own fields over it', () => {
  const m = resolveMaterial({ preset: 'nylon-500d', arealDensity: 255, rollWidth: 1470 }, 'shell');
  assert.equal(m.arealDensity, 255); assert.equal(m.thickness, FABRICS['nylon-500d'].thickness); assert.equal(m.rollWidth, 1470); assert.equal(m.preset, 'nylon-500d'); assert.equal(m.source, 'typical, not measured');
  assert.deepEqual(resolveMaterial({ arealDensity: 300 }), { arealDensity: 300 }, 'a material without a preset is left as it is');
  assert.deepEqual(Object.keys(resolveMaterials({ a: { preset: 'denim-12oz' }, b: { thickness: 1 } })), ['a', 'b']);
  assert.throws(() => resolveMaterial({ preset: 'unobtainium' }, 'shell'), /Material 'shell' names preset 'unobtainium'.*Known: ripstop-nylon-70d/);
});

test('the validator refuses an unknown preset and the document keeps the preset as written', () => {
  assert.throws(() => validateSoftgoodsDocument({ version: 1, materials: { shell: { preset: 'nope' } } }), /not in the fabric library/);
  const doc = new SoftgoodsDocument(null); doc.addRectangle({ id: 'panel', material: 'shell' }); doc.replace({ ...doc.toJSON(), materials: { shell: { preset: 'waxed-canvas', friction: 0.4 } } });
  assert.deepEqual(doc.toJSON().materials.shell, { preset: 'waxed-canvas', friction: 0.4 }, 'the library can improve under a saved design');
});
