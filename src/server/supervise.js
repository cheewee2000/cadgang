#!/usr/bin/env node
/**
 * Keep the server up. The OCCT kernel is a WASM heap and a cell program can
 * ask for more memory than exists; V8 then aborts the process, and there is
 * no catching that from inside. So the server runs as a child and comes back
 * on its own, with the autosaved documents intact. A clean exit stays down.
 */
import { fork } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const server = path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.js');
let stopping = false;

function start() {
  const child = fork(server, process.argv.slice(2), { stdio: 'inherit' });
  child.on('exit', (code, signal) => {
    if (stopping || code === 0) process.exit(code ?? 0);
    console.error(`cadgang server died (${signal || `code ${code}`}) — restarting in 1 s`);
    setTimeout(start, 1000);
  });
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.once(sig, () => { stopping = true; child.kill(sig); });
  }
}
start();
