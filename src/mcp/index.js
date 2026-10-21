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

// Which project this session works in: the server keeps a cell document per folder (exports and history land there).
const HEADERS = { 'X-Cadgang-Project': process.cwd() };
async function call(p, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(`${BASE}/api${p}`, { method, headers: body ? { ...HEADERS, 'Content-Type': 'application/json' } : HEADERS, body: body ? JSON.stringify(body) : undefined });
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

Markups are anchored on the model in 3D (points are world coordinates in mm), so a stroke or an arrow tells you WHERE on the part; notes carry text. Kinds: 'pen' (points: a polyline), 'arrow' (points: [tail, head]; the head is what it points at, the tail holds its text; the head is drawn as a dot, tail == head is a dot alone; with 'normal', the text lies on that face's plane). A mark with 'body' ("name#n") rides that part: its points are in the part's rest position (unexploded), 'note' (points: [anchor], text). The subject is the file path (or dropped file name) on screen; the camera is yaw/pitch/dist/target.

If no window is open you get the last snapshot (if any) and fresh:false — say so.

Args:
  - fresh: ask the open window for a new frame first (default true); false returns whatever was last posted, instantly.`,
    inputSchema: { fresh: z.boolean().default(true) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ fresh }) => {
    try {
      const { screen, markups, fresh: got, pendingFeedback } = await call(`/view/screen?dir=${encodeURIComponent(process.cwd())}${fresh ? '&fresh=1&wait=4' : ''}`);
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

// ---- joints: bodies that move on an axis (a screw that turns and advances, a hinge, a drawer)
const JOINT_TYPES = ['revolute', 'slider', 'screw', 'cylindrical', 'planar', 'ball', 'fixed'];
const ISO_PITCH = [[2, 0.4], [2.5, 0.45], [3, 0.5], [4, 0.7], [5, 0.8], [6, 1], [8, 1.25], [10, 1.5], [12, 1.75], [16, 2], [20, 2.5], [24, 3]];   // metric coarse, by nominal diameter
const isoPitch = (d) => ISO_PITCH.reduce((b, p) => (Math.abs(p[0] - d) < Math.abs(b[0] - d) ? p : b))[1];
const unit3 = (v) => { const n = Math.hypot(...v); if (!n) throw new Error('axis must not be zero'); return v.map((x) => +(x / n).toFixed(6)); };

const sub3 = (a, b) => a.map((v, i) => v - b[i]);
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const lineDist = (p, o, axis) => { const d = sub3(p, o), t = dot3(d, axis); return { dist: Math.hypot(...sub3(d, axis.map((v) => v * t))), along: t }; };

/** What the user's notes and arrows point at: for each, the body it sits on and the round face nearest its anchor. */
function readAnnotations(markups, bodies) {
  return (markups || []).filter((m) => m.text && (m.kind === 'note' || m.kind === 'arrow')).map((m) => {
    const at = m.kind === 'arrow' ? m.points[1] : m.points[0];   // an arrow's head is what it points at, its tail holds the text
    const pool = m.body ? bodies.filter((b) => b.key === m.body) : bodies;
    let best = null;
    for (const b of pool) (b.cylinders || []).forEach((c, i) => {
      const { dist, along } = lineDist(at, c.origin, c.axis);
      const score = Math.min(Math.abs(dist - c.radius), dist);
      if (!best || score < best.score) best = { score, body: b.key, cylinder: i, axis: c.axis, origin: c.origin, radius: c.radius, distanceToAxis: +dist.toFixed(3), alongAxis: +along.toFixed(3) };
    });
    if (best) { delete best.score; }
    return { id: m.id, kind: m.kind, text: m.text, body: m.body ?? null, point: at.map((v) => +v.toFixed(3)), nearestRoundFace: best, ...(m.normal ? { faceNormal: m.normal } : {}) };   // a flat part has no round face: the face it was marked on gives a slide axis
  });
}
/** Pairs of bodies with round faces on one axis (a screw in a bore, a pin in a hole): the smaller radius is the pin, the other likely carries it. */
function coaxialPairs(bodies) {
  const out = [];
  for (let i = 0; i < bodies.length; i++) for (let j = i + 1; j < bodies.length; j++)
    for (const [ci, a] of (bodies[i].cylinders || []).entries()) for (const [cj, b] of (bodies[j].cylinders || []).entries()) {
      if (Math.hypot(...cross3(a.axis, b.axis)) > 0.01) continue;
      if (lineDist(b.origin, a.origin, a.axis).dist > 0.05 + 0.02 * Math.max(a.radius, b.radius)) continue;
      out.push({ a: bodies[i].key, aCylinder: ci, aRadius: a.radius, b: bodies[j].key, bCylinder: cj, bRadius: b.radius, axis: a.axis, origin: a.origin });
    }
  return out;
}

server.registerTool(
  'cadgang_joints',
  {
    title: 'Bodies, joints and the notes that ask for them',
    description: `The bodies of the file on screen, the joints between them, and the user's notes and arrows read as requests for joints.

A joint lets a body move on an axis, as in Fusion 360: 'revolute' turns about an axis, 'slider' slides along it, 'screw' turns AND advances (pitch mm per turn, right-handed: a positive turn goes along +axis), 'cylindrical' turns and slides independently (value = degrees, value2 = mm), 'planar' slides on a plane (origin, axis = its normal) and turns about the normal (value = degrees, value2 / value3 = mm along the plane's x / y; the plane's x is world x laid into it, or world y when the normal is near x), 'ball' turns freely about a point (origin) by Euler angles rot = [x, y, z] degrees (a sphere you can spin to any orientation), 'fixed' rides with its parent. Every type but ball has 'offset': mm along its axis (or normal), as Fusion's joint offset (a gap under a part, a pin pushed further in), not limited by min/max. Angles are degrees, lengths mm. 'parent' is the body the joint is carried by (null = ground): a nut on a bolt on a plate follows the plate; a chain works (a lens fixed to a cell that screws into a housing that hinges).

Each body has a 'key' ("name#n", what joints refer to; it never changes), a 'label' when the user renamed it (use the label in what you say to them: it is the name they see), its box [minx,miny,minz,maxx,maxy,maxz] and its round faces ('cylinders': origin on the axis, axis, radius, length; the longest first): a screw's shank, a pin, a bore. Origins and axes are in the file's frame, the one the box is in.

'annotations': each note or arrow of the user with text, the body it sits on and the round face nearest to where it points (axis, origin, radius, distanceToAxis). The user marks parts this way — "screw", "hinge", "slides", "M3", "on the lid" — and asks you to make them move. Read the words: screw/bolt/thread → 'screw' (a size like M3 gives the pitch; the default is the ISO coarse pitch for the shank), hinge/pivot/rotates/knob/wheel → 'revolute', turns to ANY orientation/on any axis (a ball, an orb, a joystick) → 'ball' (origin = its centre), slides/drawer/rail/plunger → 'slider', both turns and slides → 'cylindrical', glued/fixed to X → 'fixed' with parent X. "On X", "in X" or "to X" names the parent. A note placed with no body (point in empty space) has no body: use cadgang_screen to see what it points at.
'coaxial': pairs of bodies with round faces on one axis (a pin in a bore): the smaller radius is the pin that moves; the other is its natural parent.

To make the joints work: add each with cadgang_joint, then check it — drive it through its range (cadgang_joint update value, then cadgang_screen) and confirm the part moves the way the note meant, and run cadgang_interference to find where it passes through a neighbour (then set min/max to stop short of it); fix the axis, parent or limits if not. Then tell the user what you made and clear the notes you acted on (cadgang_markup_clear).`,
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async () => {
    try {
      const d = await call('/view/joints');
      const { markups } = await call(`/view/markup?subject=${encodeURIComponent(d.subject || '')}`);
      return ok({ ...d, annotations: readAnnotations(markups, d.bodies || []), coaxial: coaxialPairs(d.bodies || []) });
    } catch (e) { return fail(e); }
  }
);

server.registerTool(
  'cadgang_joint',
  {
    title: 'Add, change, drive or remove a joint',
    description: `Change the joints of the file on screen (see cadgang_joints for what they are and the body keys).

  - action 'add': type + body (a key, or a unique body name). For revolute/slider/screw/cylindrical with no axis and origin, the body's longest round face gives them (a screw's shank, a pin); otherwise pass both. A screw with no pitch gets the ISO metric coarse pitch for its diameter. A body can have several joints: they stack in the order added, each riding on the ones before it (a pin in a slot: a slider along the slot, then a revolute about the pin), all on the first one's parent; to replace a joint, remove it first. With several, update and remove by id.
  - action 'update': id (or body) + any of value, value2, value3, offset, rotation, pitch, min, max, parent, name, origin, axis. This is also how you DRIVE a joint: set value (degrees, or mm for a slider; for a screw, 360 is one turn) and the part moves on the user's screen. min/max limit value (null = free).
  - action 'remove': id (or body). action 'clear': every joint.

To unscrew a screw: update its joint to a large value (say 2160 = six turns at 1.5 mm pitch). Take cadgang_screen after to see it.`,
    inputSchema: {
      action: z.enum(['add', 'update', 'remove', 'clear']),
      id: z.string().optional(), name: z.string().optional(),
      type: z.enum(JOINT_TYPES).optional(),
      body: z.string().optional().describe('body key "name#n", or a unique body name or label'),
      parent: z.string().nullable().optional().describe('body that carries this one; null = ground'),
      origin: z.array(z.number()).length(3).optional().describe('a point on the axis, file frame, mm'),
      axis: z.array(z.number()).length(3).optional().describe('axis direction (any length)'),
      value: z.number().optional(), value2: z.number().optional().describe('cylindrical: the slide, mm; planar: mm along the plane x'),
      value3: z.number().optional().describe('planar: mm along the plane y'), offset: z.number().optional().describe('mm along the joint axis / normal (every type but ball)'),
      rotation: z.array(z.number()).length(3).optional().describe('ball: Euler angles [x, y, z] in degrees (the turn about origin)'),
      pitch: z.number().optional().describe('screw: mm per turn; negative = left-hand'),
      min: z.number().nullable().optional(), max: z.number().nullable().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async (a) => {
    try {
      const cur = await call('/view/joints');
      const bodies = cur.bodies || [];
      if (!bodies.length && a.action !== 'clear') throw new Error('The window has not reported its bodies yet: is a file open in CADgang? Try again in a second.');
      const body = (name) => {
        if (name == null) return null;
        const only = (f) => (bodies.filter(f).length === 1 ? bodies.find(f) : null);   // a name or label that is unique
        const hit = bodies.find((b) => b.key === name) ?? only((b) => b.name === name) ?? only((b) => b.label === name);
        if (!hit) throw new Error(`No body "${name}" (or its name is not unique — use the key). Bodies: ${bodies.map((b) => b.key).join(', ')}`);
        return hit;
      };
      const num = (v) => v.map((x) => +x.toFixed(6));
      let joints = cur.joints || [];
      if (a.action === 'clear') joints = [];
      else if (a.action === 'add') {
        if (!a.type || !a.body) throw new Error("add needs 'type' and 'body'");
        const b = body(a.body);
        let { origin, axis } = a, radius = null;
        if (a.type === 'ball') { origin ??= [0, 1, 2].map((i) => +((b.box[i] + b.box[i + 3]) / 2).toFixed(4)); axis ??= [0, 0, 1]; }   // spinning about the body's centre
        if (a.type !== 'fixed' && (!origin || !axis)) {
          const c = b.cylinders?.[0];
          if (!c) throw new Error(`${b.key} has no round face to take an axis from: pass 'origin' and 'axis'`);
          origin ??= c.origin; axis ??= c.axis; radius = c.radius;
        }
        const j = {
          id: 'j' + Math.random().toString(36).slice(2, 8), name: a.name || `${a.type} · ${b.name}`, type: a.type, body: b.key, parent: body(a.parent)?.key ?? null,
          origin: num(origin || [0, 0, 0]), axis: unit3(axis || [0, 0, 1]), rot: a.rotation ?? [0, 0, 0], value: a.value ?? 0, value2: a.value2 ?? 0, value3: a.value3 ?? 0, offset: a.offset ?? 0,
          pitch: a.type === 'screw' ? a.pitch ?? (radius ? isoPitch(radius * 2) : 1.5) : 0, min: a.min ?? null, max: a.max ?? null,
        };
        const first = joints.find((x) => x.body === b.key);
        if (first) { j.parent = first.parent; j.align = null; }   // stacked on the body's first joint
        joints = [...joints, j];
      } else {
        const j = joints.find((x) => (a.id ? x.id === a.id : a.body ? x.body === body(a.body)?.key : false));
        if (!j) throw new Error(`No such joint. Joints: ${joints.map((x) => `${x.id} (${x.type} ${x.body})`).join(', ') || 'none'}`);
        if (a.action === 'remove') joints = joints.filter((x) => x !== j);
        else {
          for (const k of ['name', 'value', 'value2', 'value3', 'offset', 'pitch', 'min', 'max']) if (a[k] !== undefined) j[k] = a[k];
          if (a.parent !== undefined) j.parent = body(a.parent)?.key ?? null;
          if (a.origin) j.origin = num(a.origin);
          if (a.axis) j.axis = unit3(a.axis);
          if (a.rotation) j.rot = a.rotation;
        }
      }
      const res = await call('/view/joints', { method: 'PUT', body: { joints, from: 'mcp' } });
      return ok({ joints: res.joints });
    } catch (e) { return fail(e); }
  }
);

server.registerTool(
  'cadgang_interference',
  {
    title: 'What each joint runs into',
    description: `Drive each joint of the file on screen through its range (its min..max, else the slider's span; a free revolute -180..180) in 'steps' and report, per joint, which bodies the parts it moves run into (or come within 'gap' mm of), as value spans: "lid hits base at 10..90°". The assembly is together (no explode); other joints stay where they are; the user's screen does not change.
'always: true' means touching at every step: a pin in its bore, a part on the face it slides on — a fit, not a crash (a pin modelled at its hole's exact size does this). 'first' is the value nearest the current one where they meet. Ball and fixed joints are skipped. Use it after making joints, and set min/max to stop short of a crash; tell the user about crashes that look like design errors.`,
    inputSchema: {
      joint: z.string().optional().describe('a joint id: only that one (default: every joint)'),
      steps: z.number().int().min(2).max(360).optional().describe('samples across the range (default 36)'),
      gap: z.number().min(0).optional().describe('also report parts closer than this, mm (default 0: only overlaps)'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async (a) => {
    try {
      const { subject } = await call('/view/joints');
      return ok(await call('/view/ask?wait=60', { method: 'POST', body: { what: 'sweep', subject, args: a } }));
    } catch (e) { return fail(e); }
  }
);

server.registerTool(
  'cadgang_rename',
  {
    title: 'Rename bodies',
    description: `Give bodies of the file on screen new names, which the user sees at once in their Bodies list, menus and Joints panel (and that you see as 'label' in cadgang_joints). Joints, marks and explode edits keep working: the body's key never changes. Pass body as a key, or a unique name or label; label '' puts the file's own name back. Use it when the user asks you to name parts ("call those microdots 1 to 7").`,
    inputSchema: { renames: z.array(z.object({ body: z.string(), label: z.string() })).min(1) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ renames }) => {
    try {
      const { subject, bodies } = await call('/view/joints');
      if (!bodies?.length) throw new Error('The window has not reported its bodies yet: is a file open in CADgang? Try again in a second.');
      const only = (f) => (bodies.filter(f).length === 1 ? bodies.find(f) : null);
      const { parts } = await call(`/view/parts?subject=${encodeURIComponent(subject)}`);
      const names = { ...(parts['@names'] || {}) };
      for (const { body, label } of renames) {
        const b = bodies.find((x) => x.key === body) ?? only((x) => x.name === body) ?? only((x) => x.label === body);
        if (!b) throw new Error(`No body "${body}" (or its name is not unique — use the key). Bodies: ${bodies.map((x) => x.key).join(', ')}`);
        if (label.trim()) names[b.key] = label.trim(); else delete names[b.key];
      }
      const next = { ...parts, ...(Object.keys(names).length ? { '@names': names } : {}) };
      if (!Object.keys(names).length) delete next['@names'];
      await call('/view/parts', { method: 'PUT', body: { subject, parts: next, from: 'mcp' } });
      return ok({ subject, names });
    } catch (e) { return fail(e); }
  }
);

registerCellTools(server, { call, ok, fail, base: BASE, headers: HEADERS });
// Claude Code starts this server in the project folder: make it cadgang's project (unless a document is already open elsewhere).
fetch(`${BASE}/api/project`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dir: process.cwd(), ifUnset: true }) })
  .then((r) => (r.ok ? r.json() : null)).then((p) => p && console.error(p.kept ? `cadgang project folder stays ${p.dir} (a document is open there)` : `cadgang project folder: ${p.dir}`)).catch(() => {});
// Which terminal tab this Claude session lives in (Knife Terminal sets KNIFE_TAB): SEND TO CLAUDE types its
// prompt there. Said again every 30 s, so a server the Mac app restarted learns the live sessions back.
if (process.env.KNIFE_TAB) {
  const register = () => fetch(`${BASE}/api/view/claude`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tab: process.env.KNIFE_TAB, cwd: process.cwd() }) }).catch(() => {});
  register();
  setInterval(register, 30_000).unref();
}
const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`cadgang-mcp-server ${VERSION} connected (target: ${BASE})`);
