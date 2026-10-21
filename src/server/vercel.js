/**
 * Share to web on the user's own Vercel account: each share is one static deployment of the viewer
 * (web/) plus the view's bundle, gzipped and cut into share.<n>.bin parts under Vercel's 100 MB file
 * limit, listed in share.json, in a project of theirs named cadgang-shares. The page there reads
 * share.json and puts the bundle back together (view.js openShare).
 * Visitors orbit, cut, explode and mark up; marks are kept per link in the project's private Blob
 * store by the one function deployed with it (vercel/api/view/markup.js), so every visitor sees them.
 * The link's preview card (chat unfurls): the page's name, part count and a picture of the view at share
 * time, as Open Graph tags. Scrapers want an absolute og:image and the deployment's host is not known
 * until it exists, so /view is served by a tiny function (api/page.js) that stamps the host in.
 * ponytail: personal-scope tokens only; pass ?teamId= on every call if team tokens are ever needed.
 */
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { promisify } from 'node:util';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB = path.join(ROOT, 'web'), FN = path.join(ROOT, 'vercel');
const API = 'https://api.vercel.com';
export const PROJECT = 'cadgang-shares';
const VERCEL_JSON = JSON.stringify({ rewrites: [{ source: '/view', destination: '/api/page' }] });
const PART = 64 << 20;   // Vercel refuses files over 100 MB

async function webFiles(dir = WEB, rel = '') {
  const out = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...await webFiles(path.join(dir, e.name), r));
    else out.push({ file: r, data: await fs.readFile(path.join(dir, e.name)) });
  }
  const page = out.find((f) => f.file === 'view.html');   // the page there has no app server: only its markups go anywhere
  if (page) page.data = Buffer.from(page.data.toString().replace('<head>', '<head><script>window.cadgangServerless = true</script>'));
  return out;
}

const esc = (t) => String(t).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
/** The bundle's header (name, parts, preview); {} when it is not one. */
function bundleHead(b) {
  try { const n = b.readUInt32LE(0); return n && n < b.length ? JSON.parse(b.subarray(4, 4 + n).toString()) : {}; } catch { return {}; }
}
/** view.html with the preview card's tags, `__ORIGIN__` left for api/page.js to fill. */
export function cardPage(html, head) {
  const name = head.name && head.name !== 'view' ? head.name : 'CAD model';
  const files = (head.files ?? []).map((f) => f.name).join(', ');
  const desc = [head.parts ? `${head.parts} part${head.parts === 1 ? '' : 's'}` : '', files && files !== name ? files : '',
    'orbit, cut, explode and mark up in the browser'].filter(Boolean).join(' · ');
  const tags = [`<title>${esc(name)} · CADgang</title>`, '<meta property="og:type" content="website" />', '<meta property="og:site_name" content="CADgang" />',
    `<meta property="og:title" content="${esc(name)}" />`, `<meta property="og:description" content="${esc(desc)}" />`, `<meta name="description" content="${esc(desc)}" />`,
    ...(head.preview ? ['<meta property="og:image" content="__ORIGIN__/preview.jpg" />', '<meta property="og:image:width" content="1200" />',
      '<meta property="og:image:height" content="630" />', '<meta name="twitter:card" content="summary_large_image" />'] : [])];
  return html.replace(/<title>.*?<\/title>/, tags.join('\n  '));
}

/** Deploys the bundle and resolves to the share link once Vercel says the deployment is ready. */
export async function deployShare(bundle, token, { fetch = globalThis.fetch, wait = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const call = async (url, init = {}) => {
    const res = await fetch(API + url, { ...init, headers: { Authorization: `Bearer ${token}`, ...init.headers } });
    const d = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, d };
  };
  const fail = (r, what) => Object.assign(new Error(`Vercel ${what}: ${r.d.error?.message || `HTTP ${r.status}`}`), { status: r.status === 401 || r.status === 403 ? 401 : 502 });
  const gz = await promisify(zlib.gzip)(bundle);
  const parts = Array.from({ length: Math.max(1, Math.ceil(gz.length / PART)) }, (_, i) => ({ file: `share.${i}.bin`, data: gz.subarray(i * PART, (i + 1) * PART) }));
  const head = bundleHead(bundle), web = await webFiles();
  const page = web.find((f) => f.file === 'view.html');
  if (page) {
    const html = cardPage(page.data.toString(), head);
    page.data = Buffer.from(html);
    web.push({ file: 'api/page.js', data: Buffer.from(`const HTML = ${JSON.stringify(html)};\nexport function GET(req) {\n  return new Response(HTML.replaceAll('__ORIGIN__', new URL(req.url).origin), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });\n}\n`) });
  }
  const jpg = /^data:image\/jpeg;base64,/.test(head.preview ?? '') && Buffer.from(head.preview.split(',')[1], 'base64');
  if (jpg) web.push({ file: 'preview.jpg', data: jpg });
  const files = [...web, ...parts, { file: 'share.json', data: Buffer.from(JSON.stringify({ parts: parts.length, gzip: true })) }, { file: 'vercel.json', data: Buffer.from(VERCEL_JSON) }]
    .map((f) => ({ ...f, sha: crypto.createHash('sha1').update(f.data).digest('hex') }));
  // The project and its Blob store come first: a store's credentials reach deployments made after it is connected.
  let proj = await call(`/v9/projects/${PROJECT}`);
  if (proj.status === 404) proj = await call('/v11/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: PROJECT, framework: null }) });
  if (!proj.ok) throw fail(proj, 'project');
  const env = await call(`/v9/projects/${proj.d.id}/env`);
  if (!env.ok) throw fail(env, 'project settings');
  if (!env.d.envs?.some((e) => /^BLOB_(READ_WRITE_TOKEN|STORE_ID)$/.test(e.key))) {
    const st = await call('/storage/stores/blob', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: `${PROJECT}-markups`, access: 'private', projectId: proj.d.id }) });
    if (!st.ok) throw fail(st, 'markup storage');
  }
  files.push(...(await webFiles(FN)).map((f) => ({ ...f, sha: crypto.createHash('sha1').update(f.data).digest('hex') })));
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
