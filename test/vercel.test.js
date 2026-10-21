// Share to web: missing files go up by hash, the project goes public, and the link waits for READY.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deployShare } from '../src/server/vercel.js';

test('deployShare uploads only missing files and returns the ready link', async () => {
  const calls = [];
  let creates = 0, polls = 0;
  const fetch = async (url, init = {}) => {
    calls.push([init.method || 'GET', url.replace('https://api.vercel.com', '')]);
    const json = (status, d) => ({ ok: status < 300, status, json: async () => d });
    if (url.endsWith('/v13/deployments')) {
      const body = JSON.parse(init.body);
      assert.ok(body.files.some((f) => f.file === 'share.0.bin') && body.files.some((f) => f.file === 'share.json') && body.files.some((f) => f.file === 'view.html') && body.files.some((f) => f.file === 'vercel.json') && body.files.some((f) => f.file === 'api/view/markup.js'));
      if (creates++ === 0) return json(400, { error: { code: 'missing_files', missing: [body.files.find((f) => f.file === 'share.0.bin').sha] } });
      return json(200, { id: 'dpl_1', url: 'cadgang-shares-abc.vercel.app', readyState: 'BUILDING' });
    }
    if (url.endsWith('/v9/projects/cadgang-shares') && !init.method) return json(200, { id: 'prj' });
    if (url.endsWith('/v9/projects/prj/env')) return json(200, { envs: [{ key: 'BLOB_STORE_ID' }] });   // the markup store is already there
    if (url.includes('/v2/files')) { assert.equal(init.headers['x-vercel-digest'].length, 40); return json(200, {}); }
    if (url.includes('/v9/projects/')) { assert.deepEqual(JSON.parse(init.body), { ssoProtection: null }); return json(200, {}); }
    if (url.endsWith('/v13/deployments/dpl_1')) return json(200, { id: 'dpl_1', url: 'cadgang-shares-abc.vercel.app', readyState: ++polls > 1 ? 'READY' : 'BUILDING' });
    throw new Error('unexpected ' + url);
  };
  const link = await deployShare(Buffer.from('bundle'), 't', { fetch, wait: async () => {} });
  assert.equal(link, 'https://cadgang-shares-abc.vercel.app/view?share=dpl_1');
  assert.equal(calls.filter(([, u]) => u === '/v2/files').length, 1);   // only the share's part, the viewer was already there
});

test('a rejected token is a 401', async () => {
  const fetch = async () => ({ ok: false, status: 403, json: async () => ({ error: { message: 'Not authorized' } }) });
  await assert.rejects(deployShare(Buffer.from('x'), 'bad', { fetch }), (e) => e.status === 401 && /Not authorized/.test(e.message));
});
