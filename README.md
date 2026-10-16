# cadgang

Prompt-first CAD. A model is an ordered stack of **cells**: each holds a natural-language prompt, the geometry program it compiled to, and the parameters that program exposes. Claude Code writes the cells over MCP against an exact B-rep kernel (OpenCascade); you read the prompts, turn the knobs, pick edges, draw sketches, and watch the assertions. The result exports as real **STEP**.

The same server also ships a **viewer** for any CAD file and a **Mac app** around it, with sectioning, snapping measurement, markup Claude can see, and DXF drawings treated as paper.

![cadgang UI](docs/screenshot-ui.png)

Three pages, one server, one document:

| Page | What it is |
|---|---|
| `/cells` | The cell transcript. Prompts, params, assertions, picks, sketches, versions. Authored by Claude Code over MCP. |
| `/view` | The viewer and the Mac app's window. Opens STEP, IGES, BREP, STL, OBJ, PLY, 3MF, glTF, GLB, FBX and DXF. |
| `/` | The original block editor (v1): a node graph of B-rep and signed-distance-field blocks. Still works, still has STL and gyroids. |

## Install

Requires [Node.js](https://nodejs.org) ≥ 18 and a modern browser. No build step — the web app is plain ES modules.

```bash
git clone https://github.com/cheewee2000/cadgang.git
cd cadgang
npm install
npm start          # → http://localhost:4477
npm test           # 273 kernel / API / viewer tests
```

`npm start` runs a supervisor that restarts the server if the OpenCascade heap grows past `CADGANG_HEAP_LIMIT` (1.5 GB). `CADGANG_PORT`, `CADGANG_DOC` and `CADGANG_CELLS` select an alternate port and documents. The document autosaves, and every page live-updates over WebSocket whenever anything changes it, whether the UI, the REST API, or Claude.

## Cells

A cell is a prompt and the program it compiled to. The prompt is the source; the program is a lockfile. Geometry never regenerates from the prompt on its own, only when the prompt is edited or a recompile is requested, so a prompt-authored model cannot quietly become a different part between two openings of the same file.

```js
export const params = { w: 60, d: 40, h: 24, r: 3, wall: 2 };

export default ({ p, brep, q, input }) => {
  let s = brep.box(p.w, p.d, p.h);
  s = brep.fillet(s, q.edges(s).linear().along('z').expect(4), p.r);
  return brep.shell(s, q.faces(s).planar().facing('+z').expect(1), p.wall);
};
```

- **Params** are hoisted so a human can turn the numbers forever. Changing `w` re-runs the program; it never re-prompts.
- **Cells are ordered.** Each cell's default `input` is the previous result, the running "that" in "subtract that from the body". Explicit `refs` branch the flow.
- **Queries, not indices.** `q.edges(s).linear().along('z').expect(4)` names geometry by what it is, and `.expect(n)` fails loudly when the model stops matching the sentence.
- **Picks.** A cell can declare `selections: {"lip": "edge"}` and park until someone clicks in the viewport; `sel.lip` then arrives as a ready-made query.
- **Sketch cells** draw a constrained 2D profile on a canvas in the transcript and extrude, revolve or sweep it.
- **Assertion cells** measure (volume, wall thickness, clearance, bounds) and throw when a later parameter change breaks what the prompt promised.
- **Versions.** Every change is a version with a rendered look; revert is itself a version, so nothing is lost.
- **Propose.** Claude can show 2–8 alternatives of one cell side by side, rendered and measured, and wait for you to choose.

The `brep` vocabulary is the Fusion Solid tab as pure functions: box cylinder sphere torus cone coil · union subtract intersect interference · extrude (twist, end scale) revolve loft sweep pipe emboss rib · polyline spline helix · hole (counterbore, countersink) thread · fillet chamfer shell offset pushPull draft split simplify · linear, circular and path patterns, mirror · planes and axes · volume area bbox centroid mass distance. Programs run in a sandboxed `vm` realm with a wall-clock budget. The full API text Claude reads is `CELL_API` in `src/mcp/cells.js`; the design is `docs/DESIGN-v2.md`.

## Claude Code integration (MCP)

The repo ships `.mcp.json` (and `.codex/config.toml`), so opening it in Claude Code registers the `cadgang` MCP server. Manually:

```bash
claude mcp add cadgang -- node /path/to/cadgang/src/mcp/index.js
```

The server must be running (`npm start`); set `CADGANG_URL` if it is not on `http://localhost:4477`. Claude cannot see the model, so introspection replaces looking:

1. `cadgang_cells_add` — the prompt and a first draft of the code
2. `cadgang_cells_topology` — read the real faces and edges of what was built
3. `cadgang_cells_query` — confirm a query catches what was meant before applying it
4. `cadgang_cells_compile` / `_update` — the operation that uses it
5. `cadgang_cells_render` — look at it
6. `cadgang_cells_evaluate` — every cell `ok`, every assertion passing
7. an assertion cell for what the prompt promised

| Tool | What it does |
|---|---|
| `cadgang_cells_add` · `_update` · `_compile` · `_delete` | Author the stack: prompt, code, params, refs |
| `cadgang_cells_get` · `_evaluate` · `_topology` · `_query` · `_render` | Read it back: document, status and measures, faces and edges, query dry-runs, a shaded PNG |
| `cadgang_cells_pick` · `_await_pick` | Resolve a declared selection by name, or wait for the human to click |
| `cadgang_cells_propose` · `_await_choice` | Offer alternatives side by side and wait for the choice |
| `cadgang_cells_history` · `_save_version` · `_revert` | Versions with notes and rendered looks |
| `cadgang_cells_export` | Write the stack's solid to STEP (or STL) in the project folder |
| `cadgang_screen` · `cadgang_markup_clear` | The live viewport as the user sees it with their pen, arrow and note markups drawn on, and the markups as data; clear them once acted on |
| `cadgang_*` (v1) | `list_node_types`, `get_document`, `create/update/delete_node`, `set_output`, `undo`, `import_step`, `export_step`, `export_stl`, `eval_sdf`, `mesh_stats`, `render_preview` drive the block editor |

Ask Claude Code things like: *"A 60×40×24 enclosure with a 2 mm wall and a lip for a snap lid, M3 bosses in the corners, 1.5 mm fillets everywhere a hand touches. Assert the wall never drops under 1.8 mm. Export STEP."*

## Viewer & Mac app

`/view` opens any STEP, IGES, BREP, STL, OBJ, PLY, 3MF, glTF, GLB, FBX or **DXF** file: drop it on the page, press ⌘O, or on a Mac double-click it in Finder. `mac/build.sh` builds `dist/cadgang.app`, a WKWebView shell around the same server (it adopts a dev server already on :4477); its **Default** button makes cadgang the Finder's app for every type above. STEP import runs in a worker thread; a file too big for the importer says so instead of hanging.

- **Bodies** panel: one row per STEP body (or DXF layer); tick to hide, click a name to solo, shift-click for all. **Explode** slides bodies apart. **Color** gives each a hue.
- **Section**: Off/X/Y/Z, drag the cut face or the slider, **Invert** the kept side. Cuts are capped, so hollow walls read as rings.
- **Measure** snaps to endpoints, midpoints, centres and quadrants, defaults to axis-aligned distances, reads a circle's ⌀ or an edge's length in one click, reads a cylinder's ⌀, a fillet's R or a sphere's SR from one click on the face, and measures face to face (parallel planes give the gap, anything else the closest approach). Dimensions stay on the page until clicked away or undone.
- **Markup**: pen, arrow, note, erase; anchored on the model, saved with the document, and visible to Claude through `cadgang_screen`.
- Looks (shaded, metal, plastic, glass, x-ray, normals), ortho, edges, wire, grid, dark theme. Look, edges, wire, grid, color and ortho persist across sessions.
- **Undo/redo** (⌘Z / ⇧⌘Z) covers every view change, dimension and stroke. **Right-click** opens the command menu; every button shows its hotkey on hover.
- Rotation has no limits. Scroll rotates, shift-scroll pans, pinch zooms, double-click re-centres.
- **DXF** drawings are paper: drag and scroll pan, two-finger spin turns in 90° steps (`[` `]` on a keyboard), **Flip** (B) turns the sheet over. Lines, polylines with bulges, circles, arcs, ellipses, splines and block inserts are drawn; text, dimensions and hatches are skipped and counted.
- `?open=/abs/a.step|/abs/b.stl`, `?section=z:0.3`, `?explode=0.4` set the viewer from a URL (the shell and the tests use this).

| Key | Action | Key | Action |
|---|---|---|---|
| F | Fit | X Y Z | Section axis (again: off) |
| E W G O C | Edges, Wire, Grid, Ortho, Color | I / Esc | Invert section / cancel pick, section off |
| L | Next look | 1–7 | Front, back, top, bottom, right, left, iso |
| M | Measure | P A N R ⌫ | Pen, Arrow, Note, Erase, Clear markup |
| B | Flip drawing over | [ ] | Turn 90° |
| D | Dark / light | ⌘O ⌘Z ⇧⌘Z | Open, Undo, Redo |

## The block editor (v1)

The original cadgang: models are **graphs of blocks**, and a block belongs to one of two representations. Exact **B-rep** blocks (sketches, box, cylinder, extrude, revolve, boolean, fillet, chamfer, shell, transform) tessellate OpenCascade surfaces and export STEP. **Field** blocks (sphere, box, cylinder, torus, capsule, gyroid, schwarz_p, polyhedron, imported_mesh, smooth booleans, shell, offset, drape, arrays) evaluate signed distance fields and export STL. A B-rep solid can feed any field block; a field can never go back to B-rep, and `export_step` refuses rather than write a faceted mesh into a `.step` file. It sits in the lineage of [kokopelli](https://github.com/mkeeter/kokopelli), [Antimony](https://github.com/mkeeter/antimony), [libfive](https://libfive.com) and [nTopology](https://www.ntop.com/).

| Raymarched preview | Gyroid lattice infill |
|---|---|
| ![part](docs/preview-part.png) | ![gyroid](docs/preview-gyroid.png) |

Double-click the graph to add a block, drag between ports to wire, **VARS** for named variables usable in any param expression, **Save / Open** for named models, and the footer shows the whole model as one functional formula. `npm run demo` builds a gyroid-filled part through the REST API.

## REST API

| Endpoint | Description |
|---|---|
| `GET/POST/PATCH/DELETE /api/cells…` | The cell stack: add, update, compile, evaluate, render, export; `/api/cells/history` for versions, `/api/cells/options` for proposals |
| `GET/POST /api/project` | The project folder exports land in (set when a file is opened, unless a cell document is already open) |
| `POST /api/view/tessellate?path=…` · `GET /api/view/file?path=…` · `GET/PUT /api/view/markup` · `POST /api/view/snapshot` | Viewer: read local CAD files (desktop or loopback only), markups, the screen Claude sees |
| `GET /api/node-types` · `GET /api/document` · `/api/nodes` · `/api/vars` · `/api/eval` · `/api/undo` · `/api/files` · `/api/import/step` · `/api/assets` · `/api/mesh` · `/api/export/stl` · `/api/export/step` · `/api/preview.png` | The v1 block editor |
| `GET /api/health` | Version, revisions, OpenCascade heap |

`ws://…/ws` says hello with the server version and broadcasts `document_changed`, `cells_changed` and `markup_changed`; pages reload themselves when the server comes back newer.

## Architecture

```
src/core/     geometry kernel — pure JS, no server dependency
  brep.js       exact B-rep kernel: OCCT/replicad lifecycle, tessellation, STEP I/O, shape scopes
  ops.js        the Fusion Solid tab as pure functions (shape in, new shape out)
  cellapi.js    the vocabulary a cell program sees: brep, q, sk, assert, topology
  cells.js      the cell document: stack, params, refs, status, evaluation
  query.js      edge/face queries (.linear().along('z').expect(4)) and topology introspection
  sketch.js     constrained 2D sketches; sketchdraw.js draws them
  checks.js     assertions that measure and throw
  sandbox.js    vm realm with a wall-clock budget
  history.js    versions with notes and looks
  stepworker.js STEP/IGES/BREP import in a worker thread
  sdf.js brepnodes.js mesher.js mesh.js render.js document.js   the v1 block editor's kernel
src/server/   Express REST API + WebSocket + static hosting; supervise.js restarts on heap growth
src/mcp/      the MCP server (stdio); cells.js holds CELL_API, the only vocabulary Claude sees
web/          cells.js (transcript), view.js (viewer: measure.js, dxf.js, markup.js, orbitinput.js), app.js (v1 editor)
mac/          main.swift (WKWebView shell), Info.plist, build.sh, the Icon Composer icon
```

## Prior art & credits

- [kokopelli](https://github.com/mkeeter/kokopelli) → [Antimony](https://github.com/mkeeter/antimony) → [libfive](https://libfive.com) — Matt Keeter's f-rep CAD tools
- [nTopology](https://www.ntop.com/) — implicit modeling at industrial scale
- [three.js](https://threejs.org) (MIT, vendored in `web/vendor/`) · [occt-import-js](https://github.com/kovacsv/occt-import-js) (OpenCascade WASM) · [replicad](https://replicad.xyz) + [opencascade.js](https://github.com/donalffons/opencascade.js) (the B-rep kernel, MIT/LGPL) · [Space Mono](https://fonts.google.com/specimen/Space+Mono) (SIL OFL 1.1, license in `web/fonts/OFL.txt`)

Built by [CW&T](https://cwandt.com) with Claude Code.
