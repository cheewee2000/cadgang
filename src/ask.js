#!/usr/bin/env node
/**
 * cadgang-ask — ask Claude to model something and WATCH IT WRITE.
 *
 *   cd <project folder> && cadgang-ask "a 60 x 40 x 8 plate with four M4 holes"
 *   cadgang-ask -c "make it 10 thick"          (any further arguments go to claude: -c continues the last ask)
 *
 * An interactive Claude Code session hands cadgang a tool call only once it is fully written, so the pane
 * sits still for the seconds the code takes to type. A headless Claude streams its tool input as it is
 * generated: this runs one in the current folder with the cadgang tools, reads each cell's code off the
 * stream and posts it to the app (/api/cells/typing), so the Cells pane shows the code appearing, then
 * the build, then the part.
 */
import { spawn } from 'node:child_process';
import readline from 'node:readline';

const BASE = (process.env.CADGANG_URL || 'http://localhost:4477').replace(/\/$/, '');

/** The value of a string field in JSON that is still being written: what has arrived of it so far. */
export function partialString(json, key) {
  const all = [...json.matchAll(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`, 'g'))];
  if (!all.length) return null;
  let s = all[all.length - 1][1];
  for (let cut = 0; cut < 6; cut++) {   // an escape cut in half (\u00) parses once its tail is dropped
    try { return JSON.parse(`"${s}"`); } catch { s = s.slice(0, -1); }
  }
  return null;
}

/** Run Claude headless in `cwd` on `prompt`, posting what it writes to the pane as it writes it. Resolves to its last words. */
export async function ask(prompt, { cwd = process.cwd(), rest = [], out = () => {} } = {}) {
  const post = (body) => fetch(`${BASE}/api/cells/typing`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Cadgang-Project': cwd }, body: JSON.stringify(body),
  }).catch(() => {});   // the pane is cosmetic: Claude carries on without it

  // CADGANG_NO_ASK: the Claude in there gets the cell tools but not cadgang_cells_ask, so it cannot ask another.
  const child = spawn('claude', ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--allowedTools', 'mcp__cadgang', ...rest],
    { cwd, env: { ...process.env, CADGANG_NO_ASK: '1' }, stdio: ['ignore', 'pipe', 'ignore'] });
  const blocks = new Map();   // content block index → { json } for a cadgang cell call being written
  let sentAt = 0, result = null;
  for await (const line of readline.createInterface({ input: child.stdout })) {
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.type === 'result') { result = m; continue; }
    const ev = m.type === 'stream_event' ? m.event : null;
    if (!ev) continue;
    if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
      out(`\n· ${ev.content_block.name.replace(/^mcp__cadgang__cadgang_/, '')} `);
      if (/cadgang_cells_(add|update|compile)$/.test(ev.content_block.name)) blocks.set(ev.index, { json: '' });
    } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
      out(ev.delta.text);
    } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'input_json_delta' && blocks.has(ev.index)) {
      const b = blocks.get(ev.index); b.json += ev.delta.partial_json;
      if (Date.now() - sentAt < 60) continue;   // ~16 a second is typing; more is traffic
      const id = partialString(b.json, 'id'), code = partialString(b.json, 'code') ?? partialString(b.json, 'new');
      if (id && code) { sentAt = Date.now(); post({ id, code }); }
    } else if (ev.type === 'content_block_stop' && blocks.delete(ev.index)) {
      post({ done: true });
    }
  }
  if (!result) throw new Error('Claude ended without a result (is the claude command on PATH?)');
  if (result.is_error) throw new Error(result.result || 'Claude reported an error');
  return { result: result.result, seconds: Math.round(result.duration_ms / 100) / 10, turns: result.num_turns };
}

async function main() {
  const args = process.argv.slice(2);
  const prompt = args.find((a) => !a.startsWith('-'));
  if (!prompt) { console.error('usage: cadgang-ask "<what to model or change>" [-c to continue the last ask] [claude flags]'); process.exit(2); }
  try { await ask(prompt, { rest: args.filter((a) => a !== prompt), out: (t) => process.stdout.write(t) }); process.stdout.write('\n'); }
  catch (e) { console.error(`\n${e.message}`); process.exitCode = 1; }
}

if (process.argv[1] && import.meta.url.endsWith(encodeURI(process.argv[1].split('/').pop()))) main();
