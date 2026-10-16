/**
 * Worker entry for importCadFile: one fresh WASM heap per import, off the
 * server's event loop. A 465 MB STEP froze the server for a minute and then
 * died of heap exhaustion inside the importer; here it fails in its own
 * thread, and the server keeps answering.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { importCadFile } from './step.js';

try {
  const m = await importCadFile(workerData.buffer, workerData.opts);
  parentPort.postMessage({ ok: true, m });
} catch (e) {
  parentPort.postMessage({ ok: false, error: String(e?.message || e) });
}
