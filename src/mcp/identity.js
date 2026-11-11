/**
 * Whose drawing this is: the company and author a title block is filled with.
 * Read from ~/.config/cadgang/identity.json ({"company", "author"}), or the file $CADGANG_IDENTITY names;
 * stepdraw/stepdraw.py reads the same file. The author falls back to git's user.name, the company to nothing:
 * a sheet never carries somebody else's name because the user has not set theirs.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const identityFile = () => process.env.CADGANG_IDENTITY || path.join(os.homedir(), '.config', 'cadgang', 'identity.json');

export function identity(file = identityFile(), gitName = () => execFileSync('git', ['config', '--global', 'user.name'], { encoding: 'utf8' }).trim()) {
  let d = {};
  try { d = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch {}
  let author = String(d.author || '');
  if (!author) { try { author = gitName(); } catch {} }
  return { company: String(d.company || ''), author, set: !!(d.company || d.author) };
}
