#!/usr/bin/env node
/**
 * cadgang-mcp-server — the viewer's three doors for Claude Code: see the
 * screen the user marked up, clear those markups once acted on, and open a
 * file in the window.
 *
 *   CADGANG_URL=http://localhost:4477 node src/mcp/index.js
 *   claude mcp add cadgang -- node /path/to/cadgang/src/mcp/index.js
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const BASE = (process.env.CADGANG_URL || 'http://localhost:4477').replace(/\/$/, '');
const VERSION = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../package.json'), 'utf8')).version;

async function call(p, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(`${BASE}/api${p}`, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  } catch (e) {
    throw new Error(`Cannot reach cadgang at ${BASE} (${e.cause?.code || e.message}). Open the cadgang app, or run 'npm start' in the repo, or set CADGANG_URL.`);
  }
  const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : { error: await res.text() };
  if (!res.ok) throw new Error(data.error || `cadgang API error (HTTP ${res.status})`);
  return data;
}
const ok = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }], structuredContent: obj });
const fail = (e) => ({ content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true });

const server = new McpServer({ name: 'cadgang-mcp-server', version: VERSION });

server.registerTool(
  'cadgang_screen',
  {
    title: 'See what the user sees',
    description: `The live cadgang viewport as the user sees it, with their markups drawn on, plus the markups as data.

The user never has to take a screenshot: the open cadgang window renders itself and posts the PNG here. Call this whenever they point at something — "this", "here", "the edge I circled", "the hole I noted" — or to check what is on their screen.

Markups are anchored on the model in 3D (points are world coordinates in mm), so a stroke or an arrow tells you WHERE on the part; notes carry text. Kinds: 'pen' (points: a polyline), 'arrow' (points: [tail, head]), 'note' (points: [anchor], text). The subject is the file path (or dropped file name) on screen; the camera is yaw/pitch/dist/target.

If no window is open you get the last snapshot (if any) and fresh:false — say so.

Args:
  - fresh: ask the open window for a new frame first (default true); false returns whatever was last posted, instantly.`,
    inputSchema: { fresh: z.boolean().default(true) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ fresh }) => {
    try {
      const { screen, markups, fresh: got } = await call(`/view/screen${fresh ? '?fresh=1&wait=4' : ''}`);
      const text = { fresh: got, at: screen?.at ?? null, subject: screen?.subject ?? null, camera: screen?.camera ?? null, markups };
      const content = [{ type: 'text', text: JSON.stringify(text, null, 2) }];
      if (screen?.png) content.push({ type: 'image', data: screen.png, mimeType: 'image/png' });
      else content[0].text += '\n\nNo window has posted a frame yet — open the cadgang app (or /view in a browser) with a file.';
      return { content };
    } catch (e) { return fail(e); }
  }
);

server.registerTool(
  'cadgang_markup_clear',
  {
    title: 'Clear the user\'s markups',
    description: 'Remove every markup from the file on screen once you have acted on them, so the next round starts clean. Tell the user you did.',
    inputSchema: {},
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  async () => { try { return ok(await call('/view/markup', { method: 'PUT', body: { markups: [] } })); } catch (e) { return fail(e); } }
);

server.registerTool(
  'cadgang_open',
  {
    title: 'Open files in the viewer',
    description: `Open one or more CAD files in the cadgang window: STEP, IGES, BREP, STL, OBJ, PLY, 3MF, glTF, GLB, FBX or DXF. Several files stack into one scene. Paths must be absolute and on the machine running cadgang.`,
    inputSchema: { paths: z.array(z.string()).min(1) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ paths }) => { try { return ok(await call('/view/open', { method: 'POST', body: { paths } })); } catch (e) { return fail(e); } }
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`cadgang-mcp-server ${VERSION} connected (target: ${BASE})`);
