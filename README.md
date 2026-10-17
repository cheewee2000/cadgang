# CADgang

A CAD viewer and markup tool. Open a STEP, IGES, BREP, STL, OBJ, PLY, 3MF, glTF, GLB, FBX or DXF file, cut it, measure it, draw on it. The markups are anchored on the model and Claude Code can see them over MCP, so "the edge I circled" means something. Runs as a web page or as a Mac app that updates itself.

Try it: [experiments.cwandt.com/cadgang](https://www.experiments.cwandt.com/cadgang/) — drop a file on the page or press ⌘O. The hosted copy cannot open paths on your disk; the Mac app and a local `npm start` can.

Earlier versions were a CAD authoring tool (a node graph of B-rep and distance-field blocks, then prompt-authored cells driving OpenCascade). That code is tagged `v0.8.0-alpha.28-full`; from 0.9 CADgang is the viewer.

## Mac app

Download the latest `cadgang-<version>.zip` from the [releases](https://github.com/cheewee2000/cadgang/releases), unzip, drag to Applications. The app checks for updates on its own (Sparkle; **CADgang → Check for Updates…** does it now). Press **Default** in the toolbar once and Finder opens every supported file type in CADgang. Files open by double-click, by drop anywhere on the window, or with ⌘O; a file opened while another is on screen gets its own window (⌘N for an empty one). If a dev server is already on port 4477, the app adopts it. From a shell, `/Applications/cadgang.app/Contents/MacOS/cadgang-open a.step b.dxf` opens files in the running app without a second Dock icon.

To build it yourself: `npm install && npm run build` → `dist/cadgang.app` (Swift WKWebView shell, bundled node, Sparkle). `npm run release` builds, signs the zip for Sparkle, publishes the zip and appcast to the VPS, and creates the GitHub release.

## Web

```bash
git clone https://github.com/cheewee2000/cadgang.git
cd cadgang && npm install
npm start          # → http://localhost:4477 (supervised; restarts if it dies)
npm run serve      # the bare server, for debugging
npm test
```

No build step; the page is plain ES modules. `CADGANG_PORT` picks the port, `CADGANG_DATA` where markups and the last screen are kept. Local-path opens are allowed from the Mac app or from this machine, never through a proxy.

## Tools

- **Bodies** panel: one row per STEP body or DXF layer. Tick to hide, click a name to solo, shift-click for all. **Explode** slides bodies apart. Parts mated on a plane separate perpendicular to it, a part between walls slides along the channel, a part in a pocket (a magnet, a pin) leaves by the open axis and rides with the body it sits in, and anything loose goes out from the centre. **Color** gives each a hue.
- **Section**: Off/X/Y/Z, drag the cut face or the slider, **Invert** the kept side. Cuts are capped, so hollow walls read as rings.
- **Measure** snaps to endpoints, midpoints, centres and quadrants, defaults to axis-aligned distances (shift: free), reads a circle's ⌀ or an edge's length in one click, reads a cylinder's ⌀, a fillet's R or a sphere's SR from one click on the face, and measures face to face (parallel planes give the gap, anything else the closest approach). Dimensions stay on the page until clicked away or undone.
- **Markup**: pen, arrow, note, erase. Anchored on the model, saved per file, and what `cadgang_screen` shows Claude.
- **Several files**: each browser tab or Mac window is one file with its own markups. **New** opens another; Claude's `cadgang_open` and `cadgang_screen` go to the tab or window you last touched.
- Looks (shaded, metal, plastic, glass, x-ray, normals), ortho, edges, wire, grid, dark theme. These persist across sessions.
- **Undo/redo** (⌘Z / ⇧⌘Z) covers every view change, dimension and stroke. **Right-click** opens the command menu; every button shows its hotkey on hover.
- Rotation has no limits. Scroll rotates, shift-scroll pans, pinch zooms, double-click re-centres.
- **DXF** drawings are paper: drag and scroll pan, two-finger spin turns in 90° steps (`[` `]` on a keyboard), **Flip** (B) turns the sheet over. Lines, polylines with bulges, circles, arcs, ellipses, splines and block inserts are drawn; text, dimensions and hatches are skipped and counted.
- A file opened by path reloads in place when it changes on disk (export again from your CAD; the camera stays).
- `?open=/abs/a.step|/abs/b.stl`, `?section=z:0.3`, `?explode=0.4` set the viewer from a URL.

| Key | Action | Key | Action |
|---|---|---|---|
| F | Fit | X Y Z | Section axis (again: off) |
| E W G O C | Edges, Wire, Grid, Ortho, Color | I / Esc | Invert section / cancel pick, section off |
| L | Next look | 1–7 | Front, back, top, bottom, right, left, iso |
| M | Measure | P A N R ⌫ | Pen, Arrow, Note, Erase, Clear markup |
| B | Flip drawing over | [ ] | Turn 90° |
| D | Dark / light | ⌘O ⌘Z ⇧⌘Z | Open, Undo, Redo |

## Claude Code (MCP)

The repo ships `.mcp.json` (and `.codex/config.toml`), so opening it in Claude Code registers the `cadgang` MCP server. Manually: `claude mcp add cadgang -- node /path/to/cadgang/src/mcp/index.js`. The app or `npm start` must be running; set `CADGANG_URL` if it is not on port 4477.

| Tool | What it does |
|---|---|
| `cadgang_screen` | The live viewport as the user sees it, with their markups drawn on, plus the markups as 3D data (mm), the file on screen and the camera |
| `cadgang_markup_clear` | Remove the markups of the file on screen once acted on |
| `cadgang_open` | Open one or more files in the window |

## REST

| Endpoint | Description |
|---|---|
| `POST /api/view/tessellate?name=…` (raw body) · `?path=/abs/…` | STEP/IGES/BREP → one binary buffer of triangles with B-rep face and body ranges |
| `GET /api/view/file?path=/abs/…` | Raw bytes of a local file (mesh formats parse in the browser) |
| `GET/PUT /api/view/markup?subject=…` | Markups of one file |
| `POST /api/view/snapshot` · `GET /api/view/screen?fresh=1` · `GET /api/view/screen.png` | The page posts what it shows; Claude reads it |
| `POST /api/view/open {paths}` | Tell open pages to open files |
| `GET /api/health` | Version and connected pages |

`ws://…/ws` says hello with the server version (pages reload when it changed) and broadcasts `markup_changed`, `snapshot_request`, `open` and `file_changed` (a local file opened by path was rewritten).

## Layout

```
src/server/index.js   Express + WebSocket; supervise.js restarts it if it dies
src/server/view.js    tessellate, local files, markups, screen, open
src/core/step.js      STEP/IGES/BREP → triangles with face and body ranges (occt-import-js, via stepworker.js)
src/core/mesh.js      vertex merge that keeps triangle order, so face ranges stay valid
src/mcp/index.js      the three MCP tools
web/view.js           the page: loaders, bodies, section, undo, commands
web/measure.js        snaps, edge/arc classification, face fits, dimensions
web/dxf.js            DXF entities → line segments per layer
web/markup.js         pen, arrow, note on the model; the screen snapshot
web/orbitinput.js     trackpad: scroll rotates, pinch zooms, spin turns paper
web/cwandt.css        CW&T design system; style.css is the page on top of it
web/explode.js        explode offsets: perpendicular to a mating plane, along a channel, out of a pocket, else radial
mac/main.swift        WKWebView shell, file associations, Sparkle; build.sh, release.sh, cadgang-open, the icon
test/                 node --test: local-path rules, STEP bodies, DXF entities, the icon
```

## Credits

[three.js](https://threejs.org) (MIT, vendored in `web/vendor/`) · [occt-import-js](https://github.com/kovacsv/occt-import-js) (OpenCascade WASM) · [Sparkle](https://sparkle-project.org) · [Space Mono](https://fonts.google.com/specimen/Space+Mono) (SIL OFL 1.1, license in `web/fonts/OFL.txt`)

Built by [CW&T](https://cwandt.com) with Claude Code.
