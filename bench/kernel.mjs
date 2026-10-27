/** Exact-kernel microbenchmarks with the same operation telemetry the server exposes. */
import { performance } from 'node:perf_hooks';
import {
  initBrep, beginBrepScope, brepOperationStats, resetBrepOperationStats,
} from '../src/core/brep.js';
import { box, cylinder, subtract, fillet } from '../src/core/ops.js';
import { q } from '../src/core/query.js';

await initBrep();
resetBrepOperationStats();
const rounds = Math.max(1, Number(process.argv[2] ?? 10));
const started = performance.now();
for (let i = 0; i < rounds; i++) {
  const scope = beginBrepScope();
  try {
    const body = subtract(box(60, 40, 24), cylinder(5, 30, { center: 'z' }));
    fillet(body, q.edges(body).linear().along('z'), 2);
  } finally { scope.dispose(); }
}
console.log(JSON.stringify({ rounds, elapsedMs: +(performance.now() - started).toFixed(2), operations: brepOperationStats() }));
