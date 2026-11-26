// What a softgoods export writes, as a hash per file: `node test/fixtures/softgoods-baseline.mjs` prints the JSON that
// softgoods-no-trims-baseline.json holds. That file was written at dba27ca (softgoods-physics), before trims existed, and must not be
// regenerated to make a test pass: a document without trims has to keep exporting exactly these bytes.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateSoftgoodsDocument } from '../../src/core/softgoods-document.js';
import { exportProduction } from '../../src/core/softgoods-production.js';
import { tee } from './softgoods-tee.js';

export function exportHashes(document = tee()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadgang-soft-baseline-')), out = {};
  try {
    const r = exportProduction(validateSoftgoodsDocument(document), dir, 'tee', { formats: ['marker', 'bom', 'print', 'svg'], dxf: 'astm-style', sizes: { base: 1, L: 1 } });
    // The tech pack carries the time it was made: the only bytes allowed to differ.
    for (const f of r.files.sort()) out[path.basename(f)] = crypto.createHash('sha256').update(fs.readFileSync(f, 'utf8').replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, 'TIME')).digest('hex');
  } finally { fs.rmSync(dir, { recursive: true }); }
  return out;
}
if (import.meta.url === `file://${process.argv[1]}`) console.log(JSON.stringify(exportHashes(), null, 2));
