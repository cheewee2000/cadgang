/**
 * STEP/IGES/BREP import via occt-import-js (WASM OpenCascade).
 *
 * importCadFile() tessellates a CAD file buffer into one merged, welded
 * triangle mesh plus per-B-rep-face triangle ranges — the exact shape that
 * ModelDocument.addAsset() stores and the imported_mesh / extrude_face
 * blocks consume.
 */

import { weldVertices, positionsBBox } from './mesh.js';

let occtPromise = null;

/** One-time async WASM init (~70ms); afterwards calls are synchronous. */
function getOcct() {
  occtPromise ??= import('occt-import-js').then((m) => m.default());
  return occtPromise;
}

function readerFor(occt, name = '') {
  const ext = String(name).toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  if (ext === 'igs' || ext === 'iges') return occt.ReadIgesFile.bind(occt);
  if (ext === 'brep') return occt.ReadBrepFile.bind(occt);
  return occt.ReadStepFile.bind(occt);
}

/**
 * buffer: Buffer|Uint8Array of the CAD file.
 * Options: name (filename, picks the reader by extension), linearDeflection
 * (bounding-box ratio, smaller = finer), angularDeflection (radians).
 * Returns { name, positions, indices, faces:[{first,count}], bbox,
 *           vertexCount, triangleCount, faceCount } with plain JSON arrays.
 */
export async function importCadFile(buffer, { name = 'import.step', linearDeflection = 0.001, angularDeflection = 0.5 } = {}) {
  const occt = await getOcct();
  const read = readerFor(occt, name);
  const result = read(new Uint8Array(buffer), {
    linearUnit: 'millimeter',
    linearDeflectionType: 'bounding_box_ratio',
    linearDeflection,
    angularDeflection,
  });
  if (!result?.success || !result.meshes?.length) {
    throw new Error(`Could not read '${name}' — not a valid STEP/IGES/BREP file?`);
  }

  // Merge sub-meshes, re-offsetting vertex indices and face triangle ranges.
  let vTotal = 0, iTotal = 0;
  for (const m of result.meshes) {
    vTotal += m.attributes.position.array.length / 3;
    iTotal += m.index.array.length;
  }
  const positions = new Float32Array(vTotal * 3);
  const indices = new Uint32Array(iTotal);
  const faces = [];
  const bodies = []; // one per imported solid: {first, count, name} in triangles
  let vOff = 0, iOff = 0;
  for (const m of result.meshes) {
    positions.set(m.attributes.position.array, vOff * 3);
    const idx = m.index.array;
    for (let i = 0; i < idx.length; i++) indices[iOff + i] = idx[i] + vOff;
    const triOff = iOff / 3, triCount = idx.length / 3;
    // OCCT's writer names unnamed solids after itself ("Open CASCADE STEP translator 7.6 1.2"); say "body 2".
    const raw = String(m.name || '').trim();
    bodies.push({ first: triOff, count: triCount, name: raw && !/^Open CASCADE/i.test(raw) ? raw : `body ${bodies.length + 1}` });
    const brep = Array.isArray(m.brep_faces) && m.brep_faces.length ? m.brep_faces : null;
    if (brep) {
      for (const f of brep) {
        const count = f.last - f.first + 1;
        if (count > 0) faces.push({ first: triOff + f.first, count });
      }
    } else {
      faces.push({ first: triOff, count: triCount });
    }
    vOff += m.attributes.position.array.length / 3;
    iOff += idx.length;
  }

  // Weld duplicated vertices along B-rep face borders (triangle order is
  // preserved, so the face ranges stay valid).
  const bbox = positionsBBox(positions);
  const diag = bbox ? Math.hypot(bbox.max[0] - bbox.min[0], bbox.max[1] - bbox.min[1], bbox.max[2] - bbox.min[2]) : 1;
  const welded = weldVertices(positions, indices, Math.max(diag * 1e-6, 1e-5));

  return {
    name,
    positions: Array.from(welded.positions),
    indices: Array.from(welded.indices),
    faces,
    bodies,
    bbox,
    vertexCount: welded.positions.length / 3,
    triangleCount: welded.indices.length / 3,
    faceCount: faces.length,
  };
}
