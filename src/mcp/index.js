#!/usr/bin/env node
/**
 * cadgang-mcp-server — MCP (stdio) server that gives Claude Code full control
 * of a running cadgang instance: create/edit the implicit model graph,
 * evaluate SDFs, mesh, export STL, and see rendered previews.
 *
 * Point it at a running cadgang server (default http://localhost:4477):
 *   CADGANG_URL=http://localhost:4477 node src/mcp/index.js
 *
 * Claude Code registration:
 *   claude mcp add cadgang -- node /path/to/cadgang/src/mcp/index.js
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { registerCellTools } from './cells.js';

const BASE = (process.env.CADGANG_URL || 'http://localhost:4477').replace(/\/$/, '');

async function call(path, { method = 'GET', body, raw = false } = {}) {
  let res;
  try {
    res = await fetch(`${BASE}/api${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new Error(
      `Cannot reach cadgang server at ${BASE} (${e.cause?.code || e.message}). ` +
      `Start it with 'npm start' in the cadgang repo, or set CADGANG_URL.`
    );
  }
  if (raw && res.ok) return Buffer.from(await res.arrayBuffer());
  const isJson = (res.headers.get('content-type') || '').includes('json');
  const data = isJson ? await res.json() : { error: await res.text() };
  if (!res.ok) throw new Error(data.error || `cadgang API error (HTTP ${res.status})`);
  return data;
}

const ok = (obj) => ({
  content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }],
  structuredContent: obj,
});
const fail = (e) => ({ content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true });

const server = new McpServer({ name: 'cadgang-mcp-server', version: '0.1.0' });

const vec3 = z.array(z.number()).length(3);
const paramValue = z.union([z.number(), vec3]);
const inputRef = z.union([z.string(), z.array(z.string())]);

// --------------------------------------------------------------- discovery

server.registerTool(
  'cadgang_list_node_types',
  {
    title: 'List cadgang block types',
    description: `List every available cadgang block (node) type with its category, parameters (name, type, default, description) and input slots. Call this first to learn the modeling vocabulary.

cadgang has TWO geometry lineages in one graph, and each block's 'kind' field says which it belongs to:

FIELD blocks (kind 'field') — implicit/SDF geometry, meshed by surface nets, exported as STL.
  'primitive' (sphere, box, cylinder, torus, capsule, plane, gyroid, schwarz_p, spiky_sphere, polyhedron, imported_mesh, extrude_face), 'boolean' (union, intersect, subtract, smooth_*), 'modify' (shell, offset, transform, drape, linear_array, polar_array).

B-REP blocks (kind 'brep'/'sketch', flagged exact:true) — exact OpenCascade solids, exported as real STEP.
  'sketch' (sketch_rect, sketch_circle, sketch_polygon, sketch_profile) produce 2D profiles; extrude or revolve them before use.
  'brep' (brep_box, brep_cylinder, brep_sphere, brep_extrude, brep_revolve, brep_boolean, brep_fillet, brep_chamfer, brep_shell, brep_transform).

THE BRIDGE IS ONE-WAY. A B-rep solid can feed any field block (its distance field is derived automatically), but a field can never go back to B-rep. As soon as a field block touches a shape, that branch is STL-only and export_step will refuse it. So: for precision parts that must ship as STEP, keep the whole chain in B-rep blocks and use brep_fillet/brep_boolean rather than their field namesakes. Use field blocks for lattices, TPMS infill, smooth blends and drape — things B-rep cannot express.

Note: plane/gyroid/schwarz_p are unbounded fields — intersect them with a bounded body. All dimensions are millimeters; the world is Z-up.`,
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async () => {
    try { return ok(await call('/node-types')); } catch (e) { return fail(e); }
  }
);

server.registerTool(
  'cadgang_get_document',
  {
    title: 'Get the cadgang model document',
    description: `Return the full model document: every node (id, type, name, params, inputs), the current output node id, and the revision number. The output node is what gets meshed/exported/rendered.`,
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async () => {
    try { return ok(await call('/document')); } catch (e) { return fail(e); }
  }
);

// ----------------------------------------------------------------- editing

server.registerTool(
  'cadgang_create_node',
  {
    title: 'Create a cadgang block',
    description: `Add a block (node) to the model graph.

Args:
  - type: one of the types from cadgang_list_node_types (e.g. 'sphere', 'subtract', 'gyroid')
  - name: optional human-readable label
  - params: type-specific parameters; omitted params use defaults (e.g. {"radius": 12} for sphere, {"size": [30,20,10], "round": 2} for box)
  - inputs: connections to existing node ids (e.g. {"a": "box_1", "b": "sphere_2"} for subtract; {"shapes": ["a","b","c"]} for union/intersect)
  - id: optional explicit id (auto-generated as '<type>_<n>' otherwise)

Returns the created node. The first node created in an empty document automatically becomes the output. Example — a cube with a hole:
  1. create {type:'box', params:{size:[30,30,30]}}          -> box_1
  2. create {type:'cylinder', params:{radius:6, height:40}} -> cylinder_2
  3. create {type:'subtract', inputs:{a:'box_1', b:'cylinder_2'}} -> subtract_3
  4. cadgang_set_output {node:'subtract_3'}`,
    inputSchema: {
      type: z.string().describe("Node type, e.g. 'sphere', 'union', 'shell'"),
      name: z.string().optional().describe('Human-readable label'),
      params: z.record(paramValue).optional().describe('Type-specific parameters (numbers or [x,y,z] arrays)'),
      inputs: z.record(inputRef).optional().describe('Input slot -> node id (or array of ids for many-slots)'),
      id: z.string().optional().describe('Explicit node id'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async (args) => {
    try { return ok(await call('/nodes', { method: 'POST', body: args })); } catch (e) { return fail(e); }
  }
);

server.registerTool(
  'cadgang_update_node',
  {
    title: 'Update a cadgang block',
    description: `Change a block's params, inputs, or name. Provided params/inputs are merged into the existing ones; other fields are untouched. To disconnect a single-input slot pass null; to rewire a many-slot pass the full new array.

Example: cadgang_update_node {id:'sphere_1', params:{radius: 15}}`,
    inputSchema: {
      id: z.string().describe('Node id to update'),
      name: z.string().optional(),
      params: z.record(paramValue).optional(),
      inputs: z.record(z.union([inputRef, z.null()])).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ id, ...rest }) => {
    try { return ok(await call(`/nodes/${encodeURIComponent(id)}`, { method: 'PATCH', body: rest })); } catch (e) { return fail(e); }
  }
);

server.registerTool(
  'cadgang_delete_node',
  {
    title: 'Delete a cadgang block',
    description: `Delete a block by id. Fails with a clear message if another block still uses it as an input (rewire or delete the dependent first).`,
    inputSchema: { id: z.string().describe('Node id to delete') },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  async ({ id }) => {
    try { return ok(await call(`/nodes/${encodeURIComponent(id)}`, { method: 'DELETE' })); } catch (e) { return fail(e); }
  }
);

server.registerTool(
  'cadgang_set_output',
  {
    title: 'Set the model output block',
    description: `Set which block is the model's output — the shape that gets meshed, exported and rendered. Pass null to unset.`,
    inputSchema: { node: z.string().nullable().describe('Node id, or null to unset') },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ node }) => {
    try { return ok(await call('/document/output', { method: 'POST', body: { node } })); } catch (e) { return fail(e); }
  }
);

server.registerTool(
  'cadgang_clear_document',
  {
    title: 'Clear the cadgang model',
    description: `Delete ALL blocks and reset the document to empty. Destructive and irreversible — confirm with the user before calling unless they explicitly asked for a fresh start.`,
    inputSchema: {},
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  async () => {
    try { return ok(await call('/document/clear', { method: 'POST', body: {} })); } catch (e) { return fail(e); }
  }
);

server.registerTool(
  'cadgang_undo',
  {
    title: 'Undo / redo the last model edit',
    description: `Step the document history: undo reverts the most recent edit (create/update/delete/var/asset/clear/load), redo re-applies an undone one. History holds the last 100 steps; bursts of rapid same-param edits count as one step.`,
    inputSchema: { redo: z.boolean().default(false).describe('true = redo instead of undo') },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ redo }) => {
    try { return ok(await call(redo ? '/redo' : '/undo', { method: 'POST', body: {} })); } catch (e) { return fail(e); }
  }
);

// ---------------------------------------------------------------- import

server.registerTool(
  'cadgang_import_step',
  {
    title: 'Import a STEP/IGES/BREP file',
    description: `Import a CAD file from disk into the model: tessellates it, stores the mesh as a document asset, and creates an 'imported_mesh' block referencing it. Returns the new node and asset metadata (including faceCount — the number of selectable B-rep faces).

Follow-ups: use the 'extrude_face' block {asset, face, distance} to extrude one of the imported surfaces, or wire the imported_mesh into booleans/drape/arrays like any other shape.

Args:
  - path: absolute path to a .step/.stp/.iges/.igs/.brep file
  - deflection: tessellation quality as a bounding-box ratio (default 0.001; smaller = finer)`,
    inputSchema: {
      path: z.string().describe('Absolute path to the CAD file'),
      deflection: z.number().min(0.00001).max(0.1).default(0.001).describe('Linear deflection (bbox ratio)'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ path: filePath, deflection }) => {
    try {
      const fs = await import('node:fs');
      const buf = fs.readFileSync(filePath);
      const name = filePath.split('/').pop();
      const q = new URLSearchParams({ name, deflection: String(deflection) });
      const res = await fetch(`${BASE}/api/import/step?${q}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: buf,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `cadgang API error (HTTP ${res.status})`);
      return ok(data);
    } catch (e) { return fail(e); }
  }
);

// --------------------------------------------------------------- geometry

server.registerTool(
  'cadgang_eval_sdf',
  {
    title: 'Evaluate the signed distance field',
    description: `Evaluate the model's signed distance at up to 1000 points. Negative = inside the solid, positive = outside, ~0 = on the surface. Useful for checking wall thickness, clearances, or whether features intersect.

Args:
  - points: [[x,y,z], ...] in mm
  - node: optional node id (defaults to the document output)

Returns {node, distances: [d0, d1, ...]} in the same order.`,
    inputSchema: {
      points: z.array(vec3).min(1).max(1000).describe('Sample points [[x,y,z],...] in mm'),
      node: z.string().optional().describe('Node id (defaults to output)'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async (args) => {
    try { return ok(await call('/eval', { method: 'POST', body: args })); } catch (e) { return fail(e); }
  }
);

server.registerTool(
  'cadgang_mesh_stats',
  {
    title: 'Mesh the model and report stats',
    description: `Mesh the model (surface nets) and return statistics without the heavy vertex data: triangle/vertex counts, enclosed volume (mm³), surface area (mm²), bounding box, and meshing grid dims. Cheap way to sanity-check a model (volume 0 means empty/degenerate geometry).

Args:
  - resolution: grid cells along the longest axis, 24..200 (default 90; higher = finer + slower)
  - node: optional node id (defaults to output)`,
    inputSchema: {
      resolution: z.number().int().min(24).max(200).default(90).describe('Meshing resolution'),
      node: z.string().optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ resolution, node }) => {
    try {
      const q = new URLSearchParams({ resolution: String(resolution) });
      if (node) q.set('node', node);
      return ok(await call(`/mesh/stats?${q}`));
    } catch (e) { return fail(e); }
  }
);

server.registerTool(
  'cadgang_export_stl',
  {
    title: 'Export the model as binary STL',
    description: `Mesh the model and write a binary STL file into the cadgang repo's exports/ directory (server-side). Returns the absolute file path and mesh stats.

Args:
  - filename: base name without extension (e.g. 'bracket_v2')
  - resolution: meshing resolution 24..220 (default 128 for export quality)
  - node: optional node id (defaults to output)`,
    inputSchema: {
      filename: z.string().regex(/^[\w.-]+$/, 'Use letters, digits, dot, dash, underscore only').describe('Output file base name'),
      resolution: z.number().int().min(24).max(220).default(128),
      node: z.string().optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ filename, resolution, node }) => {
    try {
      const q = new URLSearchParams({ resolution: String(resolution), file: filename });
      if (node) q.set('node', node);
      const res = await fetch(`${BASE}/api/export/stl?${q}`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `cadgang API error (HTTP ${res.status})`);
      }
      const savedTo = res.headers.get('x-saved-to');
      const bytes = (await res.arrayBuffer()).byteLength;
      const out = { savedTo, bytes, triangles: (bytes - 84) / 50 };
      return ok(out);
    } catch (e) { return fail(e); }
  }
);

server.registerTool(
  'cadgang_export_step',
  {
    title: 'Export the model as a STEP B-rep file',
    description: `Write the model to a real STEP (ISO 10303) file in the cadgang repo's exports/ directory (server-side). Returns the absolute file path and byte count.

This is exact B-rep output — analytic surfaces and trimmed curves — so the result reopens in Fusion, SolidWorks or OnShape as editable, fillet-able geometry, not as a faceted import.

It only works when the WHOLE chain feeding this node stayed in B-rep blocks. If any field/implicit block took part, the export is refused with an explanation; export that branch as STL instead (cadgang_export_stl).

Args:
  - filename: base name without extension (e.g. 'bracket_v2')
  - node: optional node id (defaults to output)`,
    inputSchema: {
      filename: z.string().regex(/^[\w.-]+$/, 'Use letters, digits, dot, dash, underscore only').describe('Output file base name'),
      node: z.string().optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ filename, node }) => {
    try {
      const q = new URLSearchParams({ file: filename });
      if (node) q.set('node', node);
      const res = await fetch(`${BASE}/api/export/step?${q}`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `cadgang API error (HTTP ${res.status})`);
      }
      const savedTo = res.headers.get('x-saved-to');
      const bytes = (await res.arrayBuffer()).byteLength;
      return ok({ savedTo, bytes, format: 'STEP AP214 (exact B-rep)' });
    } catch (e) { return fail(e); }
  }
);

server.registerTool(
  'cadgang_render_preview',
  {
    title: 'Render a preview image of the model',
    description: `Raymarch the model server-side and return a shaded PNG image so you can SEE the current geometry. Use after edits to visually verify your work.

Args:
  - yaw: camera orbit angle in degrees around Z (default -35)
  - pitch: camera elevation in degrees (default 25; 90 = top view)
  - width/height: image size in px (default 640x480)
  - node: optional node id (defaults to output)`,
    inputSchema: {
      yaw: z.number().min(-360).max(360).default(-35),
      pitch: z.number().min(-89).max(89).default(25),
      width: z.number().int().min(64).max(1280).default(640),
      height: z.number().int().min(64).max(960).default(480),
      node: z.string().optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ yaw, pitch, width, height, node }) => {
    try {
      const q = new URLSearchParams({ yaw: String(yaw), pitch: String(pitch), width: String(width), height: String(height) });
      if (node) q.set('node', node);
      const png = await call(`/preview.png?${q}`, { raw: true });
      return {
        content: [
          { type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
          { type: 'text', text: `Rendered ${width}x${height} preview (yaw ${yaw}°, pitch ${pitch}°).` },
        ],
      };
    } catch (e) { return fail(e); }
  }
);

// ------------------------------------------------------------------- v2 cells

registerCellTools(server, { call, ok, fail, base: BASE });

// ------------------------------------------------------------------- main

const transport = new StdioServerTransport();
await server.connect(transport);
// Claude Code starts this server in the project folder: make it cadgang's project
// folder too, so exports and the cell document live next to the user's work.
fetch(`${BASE}/api/project`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dir: process.cwd(), ifUnset: true }) })
  .then((r) => r.ok && r.json())
  .then((p) => p && console.error(p.kept ? `cadgang project folder stays ${p.dir} (a document is open there)` : `cadgang project folder: ${p.dir}`))
  .catch(() => {});
console.error(`cadgang-mcp-server connected (target: ${BASE})`);
