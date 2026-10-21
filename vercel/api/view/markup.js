// Markups on a Vercel share: one JSON per link in the project's private Blob store, so everyone who
// opens the link sees the same marks. Deployed beside the viewer by src/server/vercel.js.
import { get, put } from '@vercel/blob';

const pathOf = (subject) => (/^share:[\w-]{1,64}$/.test(subject || '') ? `markups/${subject.slice(6)}.json` : null);
const json = (d, status = 200) => Response.json(d, { status });

export async function GET(req) {
  const p = pathOf(new URL(req.url).searchParams.get('subject'));
  if (!p) return json({ error: 'bad subject' }, 400);
  try {
    const r = await get(p, { access: 'private', useCache: false });
    return json({ markups: r?.stream ? JSON.parse(await new Response(r.stream).text()) : null });
  } catch (e) {
    if (e?.constructor?.name === 'BlobNotFoundError') return json({ markups: null });   // never marked up: the shared view's own marks stand
    throw e;
  }
}

export async function PUT(req) {
  const { subject, markups } = await req.json().catch(() => ({}));
  const p = pathOf(subject);
  if (!p || !Array.isArray(markups)) return json({ error: 'need subject and markups' }, 400);
  await put(p, JSON.stringify(markups), { access: 'private', allowOverwrite: true, addRandomSuffix: false, contentType: 'application/json' });
  return json({ ok: true });
}
