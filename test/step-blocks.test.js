import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { ModelDocument } from '../src/core/document.js';
import { compileNode } from '../src/core/sdf.js';
import { importCadFile } from '../src/core/step.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const fixture = (f) => fs.readFileSync(path.join(__dirname, 'fixtures', f));

// 20mm cube asset (same topology as mesh-sdf.test.js), top face first.
const H = 10;
function cubeAssetData() {
  return {
    name: 'cube',
    positions: [
      -H, -H, -H, H, -H, -H, -H, H, -H, H, H, -H,
      -H, -H, H, H, -H, H, -H, H, H, H, H, H,
    ],
    indices: [
      4, 5, 7, 4, 7, 6, 0, 2, 3, 0, 3, 1, 1, 3, 7, 1, 7, 5,
      0, 4, 6, 0, 6, 2, 2, 6, 7, 2, 7, 3, 0, 1, 5, 0, 5, 4,
    ],
    faces: [
      { first: 0, count: 2 }, { first: 2, count: 2 }, { first: 4, count: 2 },
      { first: 6, count: 2 }, { first: 8, count: 2 }, { first: 10, count: 2 },
    ],
    bbox: { min: [-H, -H, -H], max: [H, H, H] },
  };
}

test('imported_mesh block compiles an asset into an SDF', () => {
  const doc = new ModelDocument(null);
  const asset = doc.addAsset(cubeAssetData());
  const node = doc.createNode({ type: 'imported_mesh', params: { asset: asset.id } });
  const { fn, bbox } = compileNode(doc, node.id);
  assert.ok(fn(0, 0, 0) < 0, 'inside');
  assert.ok(Math.abs(fn(0, 0, 15) - 5) < 1e-5, 'outside top');
  assert.deepEqual(bbox, { min: [-H, -H, -H], max: [H, H, H] });
});

test('imported_mesh with missing asset throws a helpful GraphError', () => {
  const doc = new ModelDocument(null);
  const node = doc.createNode({ type: 'imported_mesh', params: { asset: 'asset_nope' } });
  assert.throws(() => compileNode(doc, node.id), /asset_nope/);
});

test('extrude_face extrudes the selected face along its normal', () => {
  const doc = new ModelDocument(null);
  const asset = doc.addAsset(cubeAssetData());
  const node = doc.createNode({
    type: 'extrude_face',
    params: { asset: asset.id, face: 0, distance: 5 }, // top face (+z), outward
  });
  const { fn, bbox } = compileNode(doc, node.id);
  assert.ok(fn(0, 0, 12.5) < 0, 'inside the extrusion slab');
  assert.ok(fn(0, 0, 17) > 0, 'above the slab');
  assert.ok(fn(0, 0, 8) > 0, 'below the source face');
  assert.ok(fn(15, 0, 12.5) > 0, 'outside the face footprint');
  assert.ok(bbox.max[2] >= 15, 'bbox covers the swept region');

  // The prism must be bounded by the face outline: a point just PAST the
  // 20x20 footprint at mid-height is outside (the old offset-surface
  // formulation wrapped around the rim here and reported inside).
  assert.ok(fn(10.5, 0, 12.5) > 0, 'no lateral bulge past the face outline');
  assert.ok(Math.abs(fn(10.5, 0, 12.5) - 0.5) < 1e-6, 'lateral distance is exact');
  assert.ok(fn(9.5, 0, 12.5) < 0, 'just inside the outline is inside');
  // Corner region outside both cap and outline combines like a box corner.
  assert.ok(Math.abs(fn(13, 0, 19) - 5) < 1e-6, 'corner distance sqrt(3^2+4^2)');

  // Negative distance extrudes inward.
  doc.updateNode(node.id, { params: { distance: -5 } });
  const inward = compileNode(doc, node.id);
  assert.ok(inward.fn(0, 0, 7.5) < 0, 'inward slab is below the face');
  assert.ok(inward.fn(0, 0, 12.5) > 0);
});

test('asset delete is refused while referenced', () => {
  const doc = new ModelDocument(null);
  const asset = doc.addAsset(cubeAssetData());
  const node = doc.createNode({ type: 'imported_mesh', params: { asset: asset.id } });
  assert.throws(() => doc.deleteAsset(asset.id), /used by node/);
  doc.deleteNode(node.id);
  doc.deleteAsset(asset.id);
  assert.equal(Object.keys(doc.assets).length, 0);
});

test('assets round-trip through toJSON', () => {
  const doc = new ModelDocument(null);
  const asset = doc.addAsset(cubeAssetData());
  const json = JSON.parse(JSON.stringify(doc.toJSON()));
  assert.ok(json.assets[asset.id]);
  assert.equal(json.assets[asset.id].indices.length, 36);
});

test('importCadFile tessellates a real STEP cube', async () => {
  const imported = await importCadFile(fixture('cube.stp'), { name: 'cube.stp' });
  assert.ok(imported.triangleCount >= 12, 'has triangles');
  assert.ok(imported.faceCount >= 6, 'has B-rep faces');
  // Known geometry of the fixture: bbox [-160,-140,0] .. [140,160,300].
  const { min, max } = imported.bbox;
  assert.ok(Math.abs(min[0] - -160) < 1 && Math.abs(min[2] - 0) < 1);
  assert.ok(Math.abs(max[1] - 160) < 1 && Math.abs(max[2] - 300) < 1);

  // Full pipeline: asset -> imported_mesh block -> SDF.
  const doc = new ModelDocument(null);
  const asset = doc.addAsset(imported);
  const node = doc.createNode({ type: 'imported_mesh', params: { asset: asset.id } });
  const { fn } = compileNode(doc, node.id);
  assert.ok(fn(-10, 10, 150) < 0, 'center of the STEP cube is inside');
  assert.ok(fn(500, 500, 500) > 0, 'far point is outside');

  // Every face range must be a valid triangle range.
  for (const f of imported.faces) {
    assert.ok(f.first >= 0 && f.count > 0 && f.first + f.count <= imported.triangleCount);
  }
});

test('export_stl block is a pass-through sink', () => {
  const doc = new ModelDocument(null);
  const s = doc.createNode({ type: 'sphere', params: { radius: 7 } });
  const e = doc.createNode({
    type: 'export_stl',
    params: { filename: 'part', resolution: 100 },
    inputs: { shape: s.id },
  });
  const sphere = compileNode(doc, s.id);
  const sink = compileNode(doc, e.id);
  assert.equal(sink.fn(1, 2, 3), sphere.fn(1, 2, 3));
  assert.deepEqual(sink.bbox, sphere.bbox);
});

test('importCadFileInWorker runs the import off-thread and reports garbage the same way', async () => {
  const { importCadFileInWorker } = await import('../src/core/step.js');
  const m = await importCadFileInWorker(fixture('cube.stp'), { name: 'cube.stp' });
  assert.equal(m.triangleCount, 12);
  await assert.rejects(importCadFileInWorker(Buffer.from('nope'), { name: 'x.step' }), /not a valid STEP/);
});

test('importCadFile rejects garbage input', async () => {
  await assert.rejects(() => importCadFile(Buffer.from('not a step file'), { name: 'junk.step' }));
});
