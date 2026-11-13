/**
 * SET UP CLAUDE CODE, once per Mac: the app's first launch installs the cadgang-notes mod
 * (claude-mod/), which watches for new markups and hands them to the Claude session working in
 * that file's folder, so nobody types "check notes".
 *
 * Once: a marker in the data folder records that it was offered, so a person who removes the mod
 * in Claude Code (`/plugin`) keeps it removed. No Claude Code on this Mac: nothing is written, and
 * the next launch looks again. A mod of this name already installed (a developer's, from a
 * checkout) is left as it is.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

const MOD = 'cadgang-notes';
// An app opened from Finder has no shell PATH: the places the Claude Code installers put it.
const places = () => [path.join(os.homedir(), '.local/bin/claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude', path.join(os.homedir(), '.claude/local/claude')];
const exec = (bin, args) => new Promise((done) => execFile(bin, args, { timeout: 60000 }, (error, stdout) => done({ ok: !error, stdout: String(stdout || '') })));

export async function setupClaude({ dataDir, root, bin = places().find((p) => fs.existsSync(p)), run = exec, log = console.log }) {
  const marker = path.join(dataDir, 'claude-mod.json');
  if (fs.existsSync(marker)) return 'done before';
  if (!bin) return 'no claude';
  const mark = (how) => { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(marker, JSON.stringify({ mod: MOD, how, at: new Date().toISOString() })); return how; };
  const listed = await run(bin, ['plugin', 'list', '--json']);
  if (!listed.ok) return 'no claude';
  if (listed.stdout.includes(`"${MOD}@`)) return mark('already installed');
  const installed = await run(bin, ['plugin', 'install', MOD, '--marketplace', path.join(root, 'claude-mod'), '--yes']);
  if (!installed.ok) return 'failed';   // no marker: the next launch tries again
  log(`CADgang set up Claude Code: the ${MOD} mod hands your markups to Claude. Remove it with /plugin in Claude Code.`);
  return mark('installed');
}
