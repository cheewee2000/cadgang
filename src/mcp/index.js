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
import { registerCellTools } from './cells.js';

const BASE = (process.env.CADGANG_URL || 'http://localhost:4477').replace(/\/$/, '');
const VERSION = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../package.json'), 'utf8')).version;

async function call(p, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(`${BASE}/api${p}`, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  } catch (e) {
    throw new Error(`Cannot reach CADgang at ${BASE} (${e.cause?.code || e.message}). Open the CADgang app, or run 'npm start' in the repo, or set CADGANG_URL.`);
  }
  const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : { error: await res.text() };
  if (!res.ok) throw new Error(data.error || `CADgang API error (HTTP ${res.status})`);
  return data;
}
const ok = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }], structuredContent: obj });
const fail = (e) => ({ content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true });

const server = new McpServer({ name: 'cadgang-mcp-server', version: VERSION });

server.registerTool(
  'cadgang_screen',
  {
    title: 'See what the user sees',
    description: `The live CADgang viewport as the user sees it, with their markups drawn on, plus the markups as data.

The user never has to take a screenshot: the open CADgang window renders itself and posts the PNG here. Call this whenever they point at something — "this", "here", "the edge I circled", "the hole I noted" — or to check what is on their screen.

Markups are anchored on the model in 3D (points are world coordinates in mm), so a stroke or an arrow tells you WHERE on the part; notes carry text. Kinds: 'pen' (points: a polyline), 'arrow' (points: [tail, head]), 'note' (points: [anchor], text). The subject is the file path (or dropped file name) on screen; the camera is yaw/pitch/dist/target.

If no window is open you get the last snapshot (if any) and fresh:false — say so.

Args:
  - fresh: ask the open window for a new frame first (default true); false returns whatever was last posted, instantly.`,
    inputSchema: { fresh: z.boolean().default(true) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ fresh }) => {
    try {
      const { screen, markups, fresh: got, pendingFeedback } = await call(`/view/screen${fresh ? '?fresh=1&wait=4' : ''}`);
      const text = { fresh: got, at: screen?.at ?? null, subject: screen?.subject ?? null, camera: screen?.camera ?? null, markups, pendingFeedback: pendingFeedback || 0 };
      const content = [{ type: 'text', text: JSON.stringify(text, null, 2) }];
      if (screen?.png) content.push({ type: 'image', data: screen.png, mimeType: 'image/png' });
      else content[0].text += '\n\nNo window has posted a frame yet — open the CADgang app (or /view in a browser) with a file.';
      return { content };
    } catch (e) { return fail(e); }
  }
);

server.registerTool(
  'cadgang_feedback',
  {
    title: 'Views the user sent for feedback',
    description: `The user pressed FEEDBACK in CADgang (or K): they want your eyes on what they were looking at. Returns each frame they sent since you last asked — the image, the file, the camera and their markups (same shapes as cadgang_screen) — oldest first, and clears the queue. Call it when they say they sent a view, when a hook says one is waiting, or when cadgang_screen reports pendingFeedback > 0. Then give design feedback on what you see, anchored to their markups.`,
    inputSchema: {},
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async () => {
    try {
      const { pending } = await call('/view/feedback');
      if (!pending.length) return ok({ pending: 0, note: 'Nothing waiting — the user has not pressed FEEDBACK since you last looked. cadgang_screen shows the live view.' });
      const content = [];
      for (const f of pending) {
        content.push({ type: 'text', text: JSON.stringify({ at: f.at, subject: f.subject, camera: f.camera, markups: f.markups }, null, 2) });
        content.push({ type: 'image', data: f.png, mimeType: 'image/png' });
      }
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
    description: `Open one or more CAD files in the CADgang window: STEP, IGES, BREP, STL, OBJ, PLY, 3MF, glTF, GLB, FBX or DXF. Several files stack into one scene. Paths must be absolute and on the machine running CADgang.`,
    inputSchema: { paths: z.array(z.string()).min(1) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ paths }) => { try { return ok(await call('/view/open', { method: 'POST', body: { paths } })); } catch (e) { return fail(e); } }
);

server.registerTool(
  'cadgang_drawing_request',
  {
    title: 'What drawing the user asked for, and what to ask them',
    description: `The user pressed DRAWING in CADgang. Returns what is open (file, size in mm, bodies, how many dimensions they placed) and the questions a drawing needs answered. Ask them ONE AT A TIME, with AskUserQuestion where there are options, accepting defaults when the user says "default" or "whatever"; then call cadgang_drawing_make with the answers. The viewer renders the views itself; you only collect the spec.`,
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async () => {
    try {
      const { request } = await call('/view/drawing/request');
      if (!request) return ok({ request: null, note: 'No drawing request yet — the user presses DRAWING in CADgang first (or just ask them what they want and call cadgang_drawing_make).' });
      return ok({
        request,
        questions: [
          'Sheet: A3 landscape is the template (templates/drawing/README.md; reference set templates/drawing/Ultra Bench T Drawing v4.pdf). A4, A2, Letter or Tabloid, portrait, only if they ask.',
          'Units: mm or inch, and how many decimals? (default mm; linear 1, diameters 2; the model is in mm)',
          'Which side is the FRONT (the face you look at in the front view): +x, -x, +y, -y, +z or -z? And which axis is up? (default front -y, up +z, the viewer\'s own front view)',
          'Views: front, top, right, iso — which? (default all four, third-angle projection, views as line art)',
          'Scale: fit, 1:1, 1:2, 2:1, 1:5… (default fit, the largest standard scale that fits the sheet)',
          'Dimensions: the sheet draws the dimensions placed in the viewer with Measure (M) with extension lines and arrows (diameters and radii as leaders), each in the first view that shows it fully. Ask them to place the ones the drawing needs now, then confirm "done". Use cadgang_screen to check what they placed.',
          'Title block (the template\'s cells): title, DWG no. (part number), rev (default A), created by, approved by (default the date), document type (default Fabrication drawing) and sheet title, document status (default FOR FABRICATION), date of issue (default today), sheet n of N for a set.',
          'Notes: material, finish and general tolerances become the first numbered notes; then their own notes (a list); "DO NOT SCALE DRAWING" is always last. A parts list (item, qty, part number, material) goes top right if they want one.',
        ],
      });
    } catch (e) { return fail(e); }
  }
);

server.registerTool(
  'cadgang_drawing_make',
  {
    title: 'Render the drawing sheet',
    description: 'Send the collected spec to the CADgang window: it renders the views with the dimensions drawn on, lays out the sheet, saves <model>.drawing.html next to the model and opens it in a new window (⌘P prints it to PDF at the stated scale). The sheet follows the CW&T drawing template (templates/drawing/README.md). Returns the file path.',
    inputSchema: {
      sheet: z.enum(['A4', 'A3', 'A2', 'Letter', 'Tabloid']).default('A3'),
      landscape: z.boolean().default(true),
      units: z.enum(['mm', 'in']).default('mm'),
      decimals: z.number().int().min(0).max(4).optional(),
      front: z.enum(['+x', '-x', '+y', '-y', '+z', '-z']).default('-y'),
      up: z.enum(['+x', '-x', '+y', '-y', '+z', '-z']).default('+z'),
      views: z.array(z.enum(['front', 'top', 'right', 'iso'])).default(['front', 'top', 'right', 'iso']),
      scale: z.union([z.literal('fit'), z.number().positive()]).default('fit'),
      title: z.string().optional(), dwg: z.string().optional().describe('DWG no. / part number'), part: z.string().optional().describe('alias of dwg'), rev: z.string().default('A'),
      material: z.string().optional(), finish: z.string().optional(), tolerances: z.string().optional(), notes: z.array(z.string()).optional(),
      parts: z.array(z.object({ item: z.union([z.string(), z.number()]), qty: z.union([z.string(), z.number()]), part: z.string(), material: z.string().optional() })).optional().describe('parts list, top right'),
      dept: z.string().default('CW&T'), technicalRef: z.string().optional(), createdBy: z.string().optional(), drawnBy: z.string().optional().describe('alias of createdBy'),
      approvedBy: z.string().optional(), doctype: z.string().default('Fabrication drawing'), sheetTitle: z.string().optional().describe('appended to the document type, e.g. ULTRA TOP'),
      status: z.string().default('FOR FABRICATION'), date: z.string().optional().describe('date of issue, default today'),
      sheetNo: z.number().int().positive().optional(), sheetCount: z.number().int().positive().optional(), source: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async (spec) => { try { return ok(await call('/view/drawing/make', { method: 'POST', body: { spec } })); } catch (e) { return fail(e); } }
);

registerCellTools(server, { call, ok, fail, base: BASE });
// Claude Code starts this server in the project folder: make it cadgang's project (unless a document is already open elsewhere).
fetch(`${BASE}/api/project`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dir: process.cwd(), ifUnset: true }) })
  .then((r) => (r.ok ? r.json() : null)).then((p) => p && console.error(p.kept ? `cadgang project folder stays ${p.dir} (a document is open there)` : `cadgang project folder: ${p.dir}`)).catch(() => {});
const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`cadgang-mcp-server ${VERSION} connected (target: ${BASE})`);
