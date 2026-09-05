/** cadgang REST API. */

import path from 'node:path';
import fs from 'node:fs';
import url from 'node:url';
import express from 'express';
import { compileNode, meshingBounds, nodeTypeCatalog, NODE_TYPES, GraphError, needsBrepKernel } from '../core/sdf.js';
import { meshSDF, meshSDFAsync, meshStats } from '../core/mesher.js';
import { toBinarySTL } from '../core/stl.js';
import { renderPreview } from '../core/render.js';
import { importCadFile } from '../core/step.js';
import {
  initBrep, brepReady, beginBrepScope, tessellate, tessellateEdges,
  sketchOutline, exportStep, isSketch, brepStats,
} from '../core/brep.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const PKG_VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8')).version;
  } catch {
    return null;
  }
})();

export function apiRouter(doc, rootDir, broadcast = () => {}, cellsDoc = null) {
  const r = express.Router();

  const fail = (res, err, code = 400) =>
    res.status(err instanceof GraphError ? code : 500).json({ error: err.message });

  /** Build a mesh_progress reporter throttled to <=1 message / 50ms (pct=1 always sent). */
  function meshProgress(nodeId, resolution) {
    let last = 0;
    return (pct) => {
      const now = Date.now();
      if (pct >= 1 || now - last >= 50) {
        last = now;
        broadcast({ type: 'mesh_progress', node: nodeId, resolution, pct });
      }
    };
  }

  /**
   * Compile the requested node (or the document output) and run `body` against
   * the result.
   *
   * B-rep blocks allocate on the OCCT heap, so the compile and everything that
   * reads its shapes have to happen inside one scope that is disposed when the
   * request is done. Anything the body returns must therefore be plain JS —
   * tessellations, buffers, numbers — not a live shape.
   *
   * The kernel is loaded on demand: a document with no B-rep blocks never pays
   * the ~10 MB WASM startup.
   */
  async function withCompiled(req, body) {
    const nodeId = req.query.node || req.body?.node || doc.output;
    if (!nodeId) throw new GraphError('Document has no output node set and no node was specified');
    if (needsBrepKernel(doc, nodeId)) await initBrep();
    const scope = beginBrepScope();
    try {
      const { fn, bbox, brep } = compileNode(doc, nodeId);
      return await body({ nodeId, fn, brep, bbox, bounds: meshingBounds(bbox) });
    } finally {
      scope.dispose();
    }
  }

  /** Tessellation tolerance for exact solids, in mm of chord deviation. */
  const brepTolerance = (req) => {
    const t = parseFloat(req.query.tolerance ?? '');
    return Number.isFinite(t) && t > 0 ? Math.min(t, 5) : 0.01;
  };

  /**
   * Triangles for the viewport. An exact solid is tessellated by OCCT from its
   * real surfaces — flat faces stay flat, circles stay round, and the triangle
   * count is a fraction of what surface nets need. Only field geometry goes
   * through the mesher.
   */
  function meshOf(c, req, resolution) {
    if (!c.brep) return meshSDFAsync(c.fn, c.bounds, resolution, meshProgress(c.nodeId, resolution));
    if (isSketch(c.brep)) {
      throw new GraphError('A sketch has no surface to mesh — connect it to an extrude or revolve');
    }
    const t = tessellate(c.brep, { tolerance: brepTolerance(req) });
    return {
      positions: t.positions,
      normals: t.normals,
      indices: t.indices,
      faces: t.faces,
      stats: meshStats(t.positions, t.indices, c.bounds, null),
      exact: true,
    };
  }

  const savesDir = path.join(rootDir, 'saves');

  const assetMeta = (a) => ({
    id: a.id, name: a.name, bbox: a.bbox,
    vertexCount: a.positions.length / 3, triangleCount: a.indices.length / 3, faceCount: (a.faces || []).length,
  });

  /** Document JSON with asset geometry stripped to metadata (assets can be
   *  megabytes; the UI fetches /assets/:id only when it needs triangles). */
  const docJSON = () => ({
    ...doc.toJSON(),
    assets: Object.fromEntries(Object.entries(doc.assets).map(([id, a]) => [id, assetMeta(a)])),
  });

  r.get('/health', (req, res) => res.json({
    ok: true, revision: doc.revision, cellsRevision: cellsDoc?.revision ?? null, version: PKG_VERSION,
    brepKernel: brepReady(), brep: brepStats(),
  }));

  r.get('/files', (req, res) => {
    try { res.json({ files: doc.listSaves(savesDir) }); } catch (e) { fail(res, e); }
  });

  r.post('/files/save', (req, res) => {
    try {
      const { name } = doc.saveAs(savesDir, req.body?.name);
      res.json({ saved: name });
    } catch (e) { fail(res, e); }
  });

  r.post('/files/load', (req, res) => {
    try { doc.loadFrom(savesDir, req.body?.name); res.json(docJSON()); } catch (e) { fail(res, e); }
  });

  r.delete('/files/:name', (req, res) => {
    try { res.json({ deleted: doc.deleteSave(savesDir, req.params.name) }); } catch (e) { fail(res, e); }
  });

  r.get('/node-types', (req, res) => res.json(nodeTypeCatalog()));

  r.get('/document', (req, res) => res.json(docJSON()));

  r.post('/document/clear', (req, res) => {
    doc.clear();
    res.json(docJSON());
  });

  r.post('/document/output', (req, res) => {
    try {
      doc.setOutput(req.body.node ?? null);
      res.json(docJSON());
    } catch (e) { fail(res, e); }
  });

  r.post('/undo', (req, res) => {
    try { doc.undo(); res.json(docJSON()); } catch (e) { fail(res, e); }
  });

  r.post('/redo', (req, res) => {
    try { doc.redo(); res.json(docJSON()); } catch (e) { fail(res, e); }
  });

  r.post('/nodes', (req, res) => {
    try { res.json(doc.createNode(req.body)); } catch (e) { fail(res, e); }
  });

  r.patch('/nodes/:id', (req, res) => {
    try { res.json(doc.updateNode(req.params.id, req.body)); } catch (e) { fail(res, e); }
  });

  r.delete('/nodes/:id', (req, res) => {
    try { doc.deleteNode(req.params.id); res.json({ deleted: req.params.id }); } catch (e) { fail(res, e); }
  });

  /** Upload a STEP/IGES/BREP file (raw body) -> stores a mesh asset and
   *  creates an imported_mesh node referencing it.
   *  ?name=<filename> picks the reader; ?deflection= tunes tessellation. */
  r.post('/import/step', express.raw({ type: () => true, limit: '100mb' }), async (req, res) => {
    try {
      if (!req.body?.length) throw new GraphError('Empty upload — send the file as the raw request body');
      const name = String(req.query.name || 'import.step');
      const deflection = parseFloat(req.query.deflection || '0.001');
      const imported = await importCadFile(req.body, { name, linearDeflection: deflection });
      const asset = doc.addAsset(imported);
      const nodeName = name.replace(/\.[^.]+$/, '') || asset.id;
      // ?node=<id>: attach the asset to an existing block (palette-created
      // imported_mesh / extrude_face) instead of creating a new one.
      const node = req.query.node
        ? doc.updateNode(String(req.query.node), { name: nodeName, params: { asset: asset.id } })
        : doc.createNode({ type: 'imported_mesh', name: nodeName, params: { asset: asset.id } });
      res.json({
        node,
        asset: {
          id: asset.id, name: asset.name, bbox: asset.bbox,
          vertexCount: imported.vertexCount, triangleCount: imported.triangleCount, faceCount: imported.faceCount,
        },
      });
    } catch (e) { fail(res, e); }
  });

  /** Asset metadata list (no geometry payload). */
  r.get('/assets', (req, res) => {
    res.json({
      assets: Object.values(doc.assets).map((a) => ({
        id: a.id, name: a.name, bbox: a.bbox,
        vertexCount: a.positions.length / 3, triangleCount: a.indices.length / 3, faceCount: (a.faces || []).length,
      })),
    });
  });

  /** Full asset geometry (positions/indices/faces) — used for face picking in the UI. */
  r.get('/assets/:id', (req, res) => {
    const a = doc.assets[req.params.id];
    if (!a) return fail(res, new GraphError(`Asset '${req.params.id}' does not exist`), 404);
    res.json(a);
  });

  r.delete('/assets/:id', (req, res) => {
    try { doc.deleteAsset(req.params.id); res.json({ deleted: req.params.id }); } catch (e) { fail(res, e); }
  });

  /** Set a user variable {name, value}; value may be an expression -> stored as a number. */
  r.post('/vars', (req, res) => {
    try { res.json({ vars: doc.setVar(req.body?.name, req.body?.value) }); } catch (e) { fail(res, e); }
  });

  r.delete('/vars/:name', (req, res) => {
    try { res.json({ vars: doc.deleteVar(req.params.name) }); } catch (e) { fail(res, e); }
  });

  /** Evaluate the SDF at points: {points: [[x,y,z],...], node?} -> {distances} */
  r.post('/eval', async (req, res) => {
    try {
      await withCompiled(req, ({ fn, nodeId }) => {
        const pts = req.body.points;
        if (!Array.isArray(pts) || pts.some((p) => !Array.isArray(p) || p.length !== 3))
          throw new GraphError('Body must include points: [[x,y,z], ...]');
        res.json({ node: nodeId, distances: pts.map(([x, y, z]) => fn(x, y, z)) });
      });
    } catch (e) { fail(res, e); }
  });

  /** Direct-input node ids of a node, flattened across slots in slot order.
   *  Falls back to [the node itself] when it has no connected inputs. */
  function directParts(nodeId) {
    const node = doc.nodes[nodeId];
    const spec = node && NODE_TYPES[node.type];
    const parts = [];
    if (spec) {
      for (const slot of Object.keys(spec.inputs)) {
        const ref = (node.inputs || {})[slot];
        for (const id of Array.isArray(ref) ? ref : ref != null ? [ref] : []) parts.push(id);
      }
    }
    return parts.length ? parts : [nodeId];
  }

  /** Mesh as JSON (positions/normals/indices as arrays) — consumed by the web UI.
   *  ?colors=1 also attributes each vertex to the nearest direct-input part. */
  r.get('/mesh', async (req, res) => {
    let nodeId, resolution;
    try {
      await withCompiled(req, async (c) => {
        nodeId = c.nodeId;
        resolution = parseInt(req.query.resolution || '90', 10);

        // A sketch has no surface; send its outline so the viewport can draw
        // the profile instead of erroring out on an unextruded sketch.
        if (isSketch(c.brep)) {
          const outline = sketchOutline(c.brep);
          if (!outline) throw new GraphError('Could not build an outline for this sketch');
          return res.json({
            node: nodeId, revision: doc.revision, kind: 'sketch',
            positions: [], normals: [], indices: [], edges: outline, stats: null,
          });
        }

        const mesh = await meshOf(c, req, resolution);
        const out = {
          node: nodeId,
          revision: doc.revision,
          kind: c.brep ? 'brep' : 'field',
          exact: Boolean(c.brep),
          positions: Array.from(mesh.positions),
          normals: Array.from(mesh.normals),
          indices: Array.from(mesh.indices),
          stats: mesh.stats,
        };
        // Exact solids know their own topology: ship the B-rep face ranges for
        // face picking, and the true edge curves for a crisp wireframe.
        if (c.brep) {
          out.faces = mesh.faces;
          out.edges = tessellateEdges(c.brep, { tolerance: brepTolerance(req) });
        }
        // Sketch inputs are dropped: a sketch has no volume, so asking it for a
        // distance throws. An extrude or revolve therefore has no colourable
        // parts at all and simply ships no owners.
        const parts = req.query.colors === '1'
          ? directParts(nodeId)
              .map((id) => ({ id, res: compileNode(doc, id) }))
              .filter((p) => !isSketch(p.res.brep))
          : [];
        if (parts.length) {
          const partIds = parts.map((p) => p.id);
          const partFns = parts.map((p) => p.res.fn);
          const pos = mesh.positions;
          const owners = new Array(pos.length / 3);
          for (let v = 0; v < owners.length; v++) {
            const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
            let best = 0, bestDist = Infinity;
            for (let p = 0; p < partFns.length; p++) {
              const d = Math.abs(partFns[p](x, y, z));
              if (d < bestDist) { bestDist = d; best = p; }
            }
            owners[v] = best;
          }
          out.partIds = partIds;
          out.owners = owners;
        }
        res.json(out);
      });
    } catch (e) {
      if (nodeId != null) broadcast({ type: 'mesh_progress', node: nodeId, resolution, pct: 1 });
      fail(res, e);
    }
  });

  /** Mesh stats only (cheap payload for agents). */
  r.get('/mesh/stats', async (req, res) => {
    let nodeId, resolution;
    try {
      await withCompiled(req, async (c) => {
        nodeId = c.nodeId;
        resolution = parseInt(req.query.resolution || '90', 10);
        const mesh = await meshOf(c, req, resolution);
        res.json({
          node: nodeId, revision: doc.revision, stats: mesh.stats,
          exact: Boolean(c.brep), brepFaces: c.brep ? mesh.faces.length : null,
        });
      });
    } catch (e) {
      if (nodeId != null) broadcast({ type: 'mesh_progress', node: nodeId, resolution, pct: 1 });
      fail(res, e);
    }
  });

  /** Write an export to exports/<name>.<ext> when ?file= was given. */
  function saveExport(fileParam, ext, data) {
    if (!fileParam) return null;
    const safe = String(fileParam).replace(/[^\w.-]/g, '_').replace(new RegExp(`\\.${ext}$`, 'i'), '');
    const dir = path.join(rootDir, 'exports');
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, `${safe}.${ext}`);
    fs.writeFileSync(target, data);
    return target;
  }

  /** Binary STL download; ?file=name also writes exports/name.stl on disk. */
  r.get('/export/stl', async (req, res) => {
    let nodeId, resolution;
    try {
      await withCompiled(req, async (c) => {
        nodeId = c.nodeId;
        resolution = parseInt(req.query.resolution || '128', 10);
        // An exact solid is tessellated from its real surfaces, so the STL is
        // both smaller and more faithful than remeshing its derived field.
        const mesh = await meshOf(c, req, resolution);
        const stl = toBinarySTL(mesh.positions, mesh.indices, nodeId);
        const savedTo = saveExport(req.query.file, 'stl', stl);
        res.setHeader('Content-Type', 'model/stl');
        res.setHeader('Content-Disposition', `attachment; filename="${nodeId}.stl"`);
        if (savedTo) res.setHeader('X-Saved-To', savedTo);
        res.send(stl);
      });
    } catch (e) {
      if (nodeId != null) broadcast({ type: 'mesh_progress', node: nodeId, resolution, pct: 1 });
      fail(res, e);
    }
  });

  /**
   * STEP download — a real B-rep file, not a faceted mesh wearing a .step
   * extension. Only nodes whose whole subtree stayed exact can be exported;
   * anything downstream of a field block is refused with an explanation rather
   * than silently degraded. ?file=name also writes exports/name.step.
   */
  r.get('/export/step', async (req, res) => {
    try {
      await withCompiled(req, async (c) => {
        const step = await exportStep(c.brep);
        const savedTo = saveExport(req.query.file, 'step', step);
        res.setHeader('Content-Type', 'model/step');
        res.setHeader('Content-Disposition', `attachment; filename="${c.nodeId}.step"`);
        if (savedTo) res.setHeader('X-Saved-To', savedTo);
        res.send(step);
      });
    } catch (e) { fail(res, e); }
  });

  /** Raymarched PNG preview. ?width&height&yaw&pitch&node */
  r.get('/preview.png', async (req, res) => {
    try {
      await withCompiled(req, ({ fn, bounds }) => {
        // The raymarcher works off the distance field, which exact solids
        // supply through the bridge — so this path needs no special casing.
        const png = renderPreview(fn, bounds, {
          width: parseInt(req.query.width || '640', 10),
          height: parseInt(req.query.height || '480', 10),
          yaw: parseFloat(req.query.yaw ?? '-35'),
          pitch: parseFloat(req.query.pitch ?? '25'),
        });
        res.setHeader('Content-Type', 'image/png');
        res.send(png);
      });
    } catch (e) { fail(res, e); }
  });

  return r;
}
