/**
 * Repeatable STEP import benchmark. Usage:
 *   npm run bench:import -- test/fixtures/nested.step [more.step ...]
 * Writes one JSON object per file, suitable for appending to benchmark history.
 */
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { importCadFileInWorker } from '../src/core/step.js';
import { pack } from '../src/server/view.js';

const files = process.argv.slice(2);
if (!files.length) files.push('test/fixtures/asm.step', 'test/fixtures/nested.step');
for (const file of files) {
  const input = fs.readFileSync(file);
  const rss0 = process.memoryUsage().rss;
  const t0 = performance.now();
  const m = await importCadFileInWorker(input, { name: path.basename(file) });
  const importedMs = performance.now() - t0;
  const p0 = performance.now();
  const packed = pack(m);
  const packMs = performance.now() - p0;
  const rss1 = process.memoryUsage().rss;
  console.log(JSON.stringify({
    file, inputBytes: input.byteLength, packedBytes: packed.byteLength,
    bodies: m.bodies.length, faces: m.faceCount, vertices: m.vertexCount,
    triangles: m.triangleCount, importedMs: +importedMs.toFixed(2),
    packMs: +packMs.toFixed(2), rssDeltaBytes: rss1 - rss0, phases: m.timings,
  }));
}
