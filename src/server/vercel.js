/**
 * Share to web on the user's own Vercel account: each share is one static deployment of the viewer
 * (web/) plus the view's bundle as share.bin, in a project of theirs named cadgang-shares. A rewrite
 * answers the page's own `api/view/share/:id` fetch with share.bin, so ?share= opens it unchanged.
 * Visitors orbit, cut, explode and mark up; their marks stay in their own browser (no server there).
 * ponytail: personal-scope tokens only; pass ?teamId= on every call if team tokens are ever needed.
 */
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');
const API = 'https://api.vercel.com';
export const PROJECT = 'cadgang-shares';
const VERCEL_JSON = JSON.stringify({ rewrites: [
  { source: '/api/view/share/:id', destination: '/share.bin' },
  { source: '/view', destination: '/view.html' },
] });

async function webFiles(dir = WEB, rel = '') {
  const out = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...await webFiles(path.join(dir, e.name), r));
    else out.push({ file: r, data: await fs.readFile(path.join(dir, e.name)) });
  }
  const page = out.find((f) => f.file === 'view.html');   // the page there has no server: it keeps its saves to itself
  if (page) page.data = Buffer.from(page.data.toString().replace('<head>', '<head><script>window.cadgangServerless = true</script>'));
  return out;
}

/** Deploys the bundle and resolves to the share link once Vercel says the deployment is ready. */
export async function deployShare(bundle, token, { fetch = globalThis.fetch, wait = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const call = async (url, init = {}) => {
    const res = await fetch(API + url, { ...init, headers: { Authorization: `Bearer ${token}`, ...init.headers } });
    const d = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, d };
  };
  const fail = (r, what) => Object.assign(new Error(`Vercel ${what}: ${r.d.error?.message || `HTTP ${r.status}`}`), { status: r.status === 401 || r.status === 403 ? 401 : 502 });
  const files = [...await webFiles(), { file: 'share.bin', data: bundle }, { file: 'vercel.json', data: Buffer.from(VERCEL_JSON) }]
    .map((f) => ({ ...f, sha: crypto.createHash('sha1').update(f.data).digest('hex') }));
  const create = () => call('/v13/deployments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    name: PROJECT, projectSettings: { framework: null }, files: files.map(({ file, sha, data }) => ({ file, sha, size: data.length })),
  }) });
  let r = await create();
  if (r.d.error?.code === 'missing_files') {   // Vercel keeps files by hash: only the new ones go up (the viewer, once per version)
    const missing = new Set(r.d.error.missing);
    for (const f of files.filter((f) => missing.has(f.sha))) {
      const up = await call('/v2/files', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'x-vercel-digest': f.sha }, body: f.data });
      if (!up.ok) throw fail(up, `upload of ${f.file}`);
    }
    r = await create();
  }
  if (!r.ok) throw fail(r, 'deploy');
  // A new project protects its deployment links behind a Vercel login; shares are for anyone with the link.
  const p = await call(`/v9/projects/${PROJECT}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ssoProtection: null }) });
  if (!p.ok) throw fail(p, 'making the link public');
  for (let i = 0; i < 120 && r.d.readyState !== 'READY'; i++) {
    if (r.d.readyState === 'ERROR' || r.d.readyState === 'CANCELED') throw Object.assign(new Error(`Vercel deploy ${r.d.readyState.toLowerCase()}`), { status: 502 });
    await wait(1000);
    r = await call(`/v13/deployments/${r.d.id}`);
  }
  if (r.d.readyState !== 'READY') throw Object.assign(new Error('Vercel deploy still building after 2 minutes'), { status: 504 });
  return `https://${r.d.url}/view?share=${r.d.id}`;
}
