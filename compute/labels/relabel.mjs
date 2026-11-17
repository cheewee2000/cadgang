#!/usr/bin/env node
// Re-apply the current, tested name rules to an existing Stage 3 JSONL without re-importing the CAD corpus.
// Plain JSONL and .gz are accepted. Changed rows retain `originalLabel` for review.
//   node compute/labels/relabel.mjs input.jsonl.gz output.jsonl.gz [changes.jsonl]
import fs from 'node:fs';
import readline from 'node:readline';
import { createGunzip, createGzip } from 'node:zlib';
import { label } from './export.mjs';

const [src, dst, audit] = process.argv.slice(2);
if (!src || !dst) {
  console.error('usage: node compute/labels/relabel.mjs input.jsonl[.gz] output.jsonl[.gz] [changes.jsonl]');
  process.exit(2);
}
const input = fs.createReadStream(src).pipe(src.endsWith('.gz') ? createGunzip() : new (await import('node:stream')).PassThrough());
const rawOut = fs.createWriteStream(dst);
const output = dst.endsWith('.gz') ? createGzip({ level: 9 }) : new (await import('node:stream')).PassThrough();
output.pipe(rawOut);
const changes = audit ? fs.createWriteStream(audit) : null;
let rows = 0, changed = 0, comments = 0;
for await (const line of readline.createInterface({ input, crlfDelay: Infinity })) {
  if (!line.trim()) continue;
  if (line.startsWith('#')) { output.write(line + '\n'); comments++; continue; }
  const row = JSON.parse(line), next = label(row.name || '');
  rows++;
  if (next !== row.label) {
    const before = row.label;
    row.originalLabel ??= before;
    row.label = next;
    changed++;
    changes?.write(JSON.stringify({ name: row.name, file: row.file, from: before, to: next }) + '\n');
  }
  output.write(JSON.stringify(row) + '\n');
}
output.end(); changes?.end();
await new Promise((resolve, reject) => rawOut.on('close', resolve).on('error', reject));
console.error(`${rows} rows, ${changed} labels changed, ${comments} source comments -> ${dst}`);
