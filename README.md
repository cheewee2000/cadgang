# CADgang

A CAD viewer and markup tool. Open a STEP, IGES, BREP, STL, OBJ, PLY, 3MF, glTF, GLB, FBX or DXF file, cut it, measure it, draw on it. The markups are anchored on the model and Claude Code can see them over MCP, so "the edge I circled" means something. Runs as a web page or as a Mac app that updates itself.

https://github.com/user-attachments/assets/f583641c-d38d-479c-90d7-e1cd38e5bf87

*The Mac app on the Wink camera enclosure: explode, section, markup, measure.*

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

- **Bodies** panel: one row per STEP body or DXF layer. Tick to hide, click a name to solo, shift-click names to add them to the selection (SHOW ALL brings everything back), **✎ (or right-click a part → Rename…) to rename it**. A rename is a label: it shows in the panel, the Joints panel and menus and is what Claude sees, but joints, marks and saved explode edits keep pointing at the part by its file name, so nothing breaks. It is saved with the file and in `.cadgang` projects. **Explode** slides bodies apart. A pin or bearing coaxial with a bore moves along the shared axis, parts mated on a plane separate perpendicular to it, a part between walls slides along the channel, a part in a pocket leaves by the open axis, anything loose goes out from the centre, and nothing travels through another body. The vectors solve on load up to 300k triangles; above that, press **Solve** next to the slider. **Color** gives each a hue.
- **Select several parts** and act on them together. **Shift-click** a part (or shift-click names in the Bodies list) to add it to the selection; **shift-drag** a window: left→right takes the parts fully inside it, right→left (dashed) every part it touches. A plain click selects one part, a click on nothing clears. The bar over the viewport then hides, shows, isolates (**Only**) or gives all of them one **Material**; `H` hides the selection, `⇧H` shows everything, `Esc` clears. Panning is right-drag or shift-scroll (shift-drag pans only while a markup or measure tool is on).
- **Bodies tree**: rows sit in folders by assembly (STEP products, glTF nodes); a crowded folder gathers like-named bodies (every copy of one capacitor), repeated names get `_1`, `_2`, and a row reads `name · material` when the file names the material; ◐ makes a row or a folder transparent.
- **Bodies rows** are one line each: a name too long for the panel ends in … and its tip has it whole. Material, finish and colour sit in columns as wide as their longest word, the same place on every row, and are never cut; as the panel narrows the space between them shrinks first, then the names give way.
- **Planes**: Front, Top and Right reference planes through the model's centre, each on or off; **+** adds your own, offset from one of them by a distance or lying on a face you click. Front, Top, Right and offset planes follow the centre when parts move. Kept per file.
- **Planes in the feature tree**: a **Planes** folder at the top of the Bodies list holds Front, Top, Right and your own, each ticked to show. Right-click one to show or hide it; your own also rename, change their offset (**Edit offset…**), flip to the other side, or delete. Double-click your own plane's name to rename it.
- **Weight**, beside the size at the bottom: an estimate for the shown bodies, each body's volume times its material's density (Plastic 1.2, Aluminum 2.7, Steel 7.85 g/cm³…), in grams up to 1 lb, then pounds (567 g reads 1.25 lbs); with a selection it reads the selection's share first. Hover it for the split by material.
- **Share** (the share icon in the header): **Copy screenshot** puts a picture of the view, markups and notes included, on the clipboard to paste anywhere; **Save screenshot** saves it as a PNG named after the file; **Share to web** deploys a frozen copy of the view to your Vercel account.
- **Ruler** (⇧G) beside Grid: the grid's scale along its front and left edges, counting + and − from 0 at the grid crossing on the model's lower left corner seen from the top (the grid sits centred on the model with a line through that corner), in **mm** or **in**. In inches the grid steps every ½" with a darker line every inch, and the ruler numbers every inch.
- **Move a part while exploded**: press on it and drag it anywhere in the screen's plane (up and down too; ⇧ snaps to grid steps; a part in the selection moves the whole selection). That becomes where it explodes to: slide to 0 and it goes home, explode again and it comes back out to that spot (Reset clears it). Parts on it ride along, as do its markups; saved per file, undone with ⌘Z. Assembled, a drag rotates.
- **Move triad** (**Triad** on the selection bar, or **Q**), as in SolidWorks: on the selected parts, arrows (x red, y green, z blue) slide them along that axis and rings turn them about it; ⇧ snaps to grid steps or 15°. It stays one size on screen and is drawn over the model. Each part keeps the move as its placement (under any explode or joint), saved per file and undone with ⌘Z; **Reset move** puts the selected parts back where the file had them.
- **Pictures**: double-click one to edit it: drag to move, drag a corner to size, drag just outside a corner to rotate (⇧ in 15° steps), ⌘-drag a corner or an edge to crop; ⌫ deletes, Esc is done.
- **Section**: Off/X/Y/Z, drag the cut face or the slider, **Invert** the kept side. Cuts are capped, so hollow walls read as rings.
- **Measure** snaps to endpoints, midpoints, centres and quadrants, defaults to axis-aligned distances (shift: free), reads a circle's ⌀ or an edge's length in one click, reads a cylinder's ⌀, a fillet's R or a sphere's SR from one click on the face, and measures face to face (parallel planes give the gap, anything else the closest approach). Dimensions stay on the page until clicked away or undone.
- **Markup**: pen (as in Figma: click for corners, drag for curves, click the first point to close, Enter to end, ⌫ takes a point back), pencil (freehand), arrow, note, text (lies on the face clicked), image (a PNG or JPEG projected onto the surface; drag to size it), erase. Marks start only on the model: a press off it orbits the view, with any tool. Anchored on the model, saved per file, and what `cadgang_screen` shows Claude. Marks Claude has acted on turn Infinite Machine green at 30% and stay as a record.
- **Several files**: each browser tab or Mac window is one file with its own markups. **New** opens another; Claude's `cadgang_open` and `cadgang_screen` go to the tab or window you last touched.
- **Modes** (**Explode** / **Joint** in the toolbar, `J` switches): what a drag and the right-click menu do to a part. Explode: exploded, a drag places a part and ⌥-drag slides it along its axis (assembled, a drag turns the view), the menu sets its explode axis. Joint: drag moves a jointed part on its joint (anything else orbits), the menu adds joints, and explode is off so the assembly sits together. Joints keep their pose in both.
- **The Joints panel folds**: its − folds the whole panel to its head (**Joints (n)**), and each joint's own − folds it to its title line (type, part, ×), as the Bodies folders do. What is folded is kept in this browser.
- **Joints**, as in Fusion: **New joint** (`N`, in Joint mode; or right-click → New joint…), click a face on the part that moves, then a face on the part it moves on (empty space: the ground), then pick the motion: **Revolute / Slider / Screw / Cylindrical / Planar / Ball / Rigid**. The first part snaps onto the second: flat faces meet face to face, round faces share an axis, centre on centre (**Flip** in its Joints row turns it over). The joint turns or slides about a round face of the two (a screw's shank, a bore, a pin), else the second face's normal, and the menu puts the type those faces suggest first. **Planar** slides the part about on the face and turns it on the normal: drag it, or set **x**, **y** and the angle in its Joints row. A part can have **several joints**: make another with New joint and it rides on the ones before it (a pin in a slot: Slider along the slot, then Revolute about the pin); a drag drives the one you last moved. Joints show what they join (dashed lines and an axis arrow) for a moment after one is made and while you point at the Joints panel. A sliding or turning joint also shows its range as a dashed track: **drag the dot at either end to set min or max**, double-click it to free it; in Joint mode the joint you last moved keeps its track up. Every joint but Ball has an **offset** along its axis (a gap under a part, a pin pushed further in): **⌘-drag** the part to set it, or type it in the row. Then **drag the part** and it turns or slides on the joint (a screw turns *and* advances by its pitch; ⌥-drag a cylindrical joint to slide it), or use its slider in the **Joints** panel. Set what a joint is carried by (**on**), a screw's pitch, and min/max limits there. A screw's pitch starts as the ISO metric coarse pitch for its diameter. A joint's parent carries it: a screw in a lid follows the lid. Joints are saved per file, in `.cadgang` projects, and Claude can read and drive them (`cadgang_joints`, `cadgang_joint`). **Annotate, then ask**: write notes or arrows (double-click a tag to edit its text; Shift+Enter starts a new line) on the parts ("screw M3", "hinge", "lid slides on the pin"), then ask Claude Code to make the joints from your notes: it reads them with the round face each points at, makes the joints, drives each through its range to check it, and tells you what it made.
- **Explode from the joints**: SOLVE (and opening a file) reads how the parts are assembled. A screw, slider or cylindrical joint explodes along its own axis, out of the end with more room; a ball joint leaves by the open side of its socket; a part with a fixed joint has no travel of its own and goes with its parent; any part with a parent rides it. Parts are also staged: what stands in a part's way at rest comes off first, so the slider takes the outer parts away and then the ones under them. Parts with a clear way out are all in the first stage. Add or change joints and the explode solves again by itself (files over 300k triangles wait for SOLVE).
- **Save / Open projects** (⌘S, ⇧⌘S): a `.cadgang` file holds the model, markups, dimensions, joints, section, explode, camera and look. Open it with Open, a drop, or a double-click.
- Looks (shaded, metal, plastic, glass, x-ray, normals), ortho, edges, wire, grid, dark theme. These persist across sessions.
- **Undo/redo** (⌘Z / ⇧⌘Z) covers every view change, dimension and stroke. **Right-click** opens the command menu; every button shows its hotkey on hover.
- **Select** a body by clicking it in the view or the list, a whole part by clicking its folder (shift adds). **H** hides, **T** (or **Transparent** on the selection bar) makes it transparent, **S** shows only the selection, **⇧H** shows everything, Esc deselects. Clicks pass through transparent bodies, so ghost the case and pick what is inside. The selection's menu sets its material (the MATERIALS look) and its colour (every solid look; a swatch, here or in a Bodies row, opens the colours the model already uses, then **Other…** for any colour), kept per file in the browser and undone with ⌘Z.
- **STEP colours and material names** the WASM importer misses (a style on a solid inside a part's compound, as Fusion writes them) are read from the file's text; the material name ("Steel - Satin") decides the MATERIALS guess first. An **STL** takes its body name from the file: an ASCII `solid <name>`, or the `cadgang: <name>` header cadgang writes.
- **Named STEP export**: a STEP that cadgang's cells write names every solid after the cell that made it (`tray`, `lid`), and a `compound()` of cells keeps each part's name, so the file opens with those names instead of `body 1`, `body 2`. A cell with several solids writes `name`, `name 2`, …
- Mouse like Bambu Studio: left-drag rotates about the point you pressed on (empty space: about the orbit's centre; exploded, a drag on a part moves it), right-drag or wheel-drag pans, the wheel zooms to the pointer; ⌥-drag on a part slides it along its explode axis. On a trackpad, two fingers turn the model, ⇧ with two fingers pans, pinch zooms to the pointer. A mouse wheel zooms to the pointer: a wheel notch is told from a trackpad's scroll by its size, so a trackpad's scroll is never taken for one (a wheel smoothed into a trackpad's stream, as Mac Mouse Fix's smooth scrolling does, reads as a trackpad). Rotation has no limits; double-click re-centres.
- **View cube**, lower right: turns with the model, x / y / z axes at its corner. Click a face for that view, an edge or a corner for the view between; the button beside it fits the model.
- **Scale reference**, the button beside Fit (small, medium and large shapes): shows a thing of known size at its real size, beside the model on its left (the sheet of paper lies centred under it): a **US quarter** (24.26 mm), a **tennis ball** (67 mm), a sheet of **looseleaf** (8½ × 11 in, college ruled, three holes) or a **basketball** (size 7, 239 mm). The button turns it on and off, its ▾ picks which; Fit takes it in. It is never part of the model: no pick, measure, weight or explode. Kept in this browser.
- **Printer build volumes**, in the same ▾ menu: a see-through box of the printable width × depth × height, standing on the grid round the model and named at its top: Bambu Lab A1 mini (180³); **X1C, P1S…** (256³: A1, P1S, P1P, P2S, X1C and X1E, listed in its tip); H2S (340 × 320 × 340); H2D (300 × 320 × 325, what both nozzles reach, as its tip says); Prusa XL (360³). **Add a printer…** at the bottom takes a name and width × depth × height in mm for one of your own; × removes it. Yours are kept in this browser. Its outline turns red, and the status line says so, when the model does not fit (turned a quarter on the plate counts).
- **DXF** drawings are paper: drag and scroll pan, two-finger spin turns in 90° steps (`[` `]` on a keyboard), **Flip** turns the sheet over. Lines, polylines with bulges, circles, arcs, ellipses, splines and block inserts are drawn; text, dimensions and hatches are skipped and counted.
- A file opened by path reloads in place when it changes on disk (export again from your CAD; the camera stays).
- `?open=/abs/a.step|/abs/b.stl`, `?section=z:0.3`, `?explode=0.4` set the viewer from a URL.

| Key | Action | Key | Action |
|---|---|---|---|
| F | Fit | X Y Z | Section axis (again: off) |
| W G O C | Wire, Grid, Ortho, Color | I / Esc | Invert section / cancel pick, section off |
| L | Next look | 1–7 | Front, back, top, bottom, right, left, iso |
| H T S Q | Hide, transparent, show only, move triad | ⇧H | Show all bodies |
| M | Measure | B P A N ⇧T ⇧I R ⌫ | Bezier, Pencil, Arrow, Note, Text, Image, Erase, Clear markup |
| E J V | Joint / explode mode, new joint, explode direction | [ ] | Turn 90° |
| D | Dark / light | ⌘O ⌘Z ⇧⌘Z | Open, Undo, Redo |

These are the defaults. To remap one, right-click, click its key in the menu, then press the new key (⌫ removes it, Esc keeps it). A key another command had swaps over to it. Remaps are yours, kept on your Mac; **Reset hotkeys** at the bottom of the menu restores the defaults.

## Drawing

Press **Drawing** with a file open. The viewer registers what is on screen and copies a prompt to the clipboard; paste it into Claude Code. Claude calls `cadgang_drawing_request`, asks the questions a sheet needs one at a time (sheet and orientation, units, which side is the front, which views, scale, the dimensions to place with Measure, title block, notes, parts list), then calls `cadgang_drawing_make`. The viewer renders the views itself as line art (front, top, right in third angle, an isometric at half scale), draws your dimensions with extension lines and arrows (diameters and radii as leaders), lays out the sheet in the **CW&T drawing template** — ISO frame with zone grid, 180 × 45 mm title block with the CW&T wordmark, upper-case numbered notes, optional parts list, sheet n/N — and saves `<model>.drawing.html` next to the model, opened in a new window. ⌘P prints it to PDF at the stated scale.

The template is documented in [`templates/drawing/README.md`](templates/drawing/README.md); the reference set is `templates/drawing/Ultra Bench T Drawing v4.pdf` (drawn from a STEP with [stepdraw](https://github.com/cheewee2000/stepdraw) and the spec next to it), which shows every element the template uses: balloons, parts list, sections, schedules.

## Claude Code (MCP)

The repo ships `.mcp.json` (and `.codex/config.toml`), so opening it in Claude Code registers the `cadgang` MCP server. Manually: `claude mcp add cadgang -- node /path/to/cadgang/src/mcp/index.js`. The app or `npm start` must be running; set `CADGANG_URL` if it is not on port 4477.

| Tool | What it does |
|---|---|
| `cadgang_screen` | The live viewport as the user sees it, with their markups drawn on, plus the markups as 3D data (mm), the file on screen and the camera |
| `cadgang_markup_done` | Mark markups done once acted on (by id, or all open ones): they stay as a record, in Infinite Machine green at 30% |
| `cadgang_markup_clear` | Remove every markup of the file on screen (only when asked; after acting on them, mark them done) |
| `cadgang_open` | Open one or more files in the window |
| `cadgang_joints` | The bodies on screen (key, box, round faces with axis and radius) and their joints |
| `cadgang_joint` | Add, change, drive (set `value`) or remove a joint; a body's longest round face gives the axis when none is passed |
| `cadgang_drawing_request` | What the user asked a drawing of, and the questions to ask them |
| `cadgang_drawing_make` | Send the answered spec; the viewer renders and saves the sheet |

## REST

| Endpoint | Description |
|---|---|
| `POST /api/view/tessellate?name=…` (raw body) · `?path=/abs/…` | STEP/IGES/BREP → one binary buffer of triangles with B-rep face and body ranges |
| `GET /api/view/file?path=/abs/…` | Raw bytes of a local file (mesh formats parse in the browser) |
| `GET/PUT /api/view/markup?subject=…` | Markups of one file |
| `POST /api/view/snapshot` · `GET /api/view/screen?fresh=1` · `GET /api/view/screen.png` | The page posts what it shows; Claude reads it |
| `POST /api/view/open {paths}` | Tell open pages to open files |
| `POST/GET /api/view/drawing/request` · `POST /api/view/drawing/make {spec}` · `GET /api/view/drawing` | The drawing round trip: request, spec in, the rendered sheet out |
| `GET /api/health` | Version and connected pages |

`ws://…/ws` says hello with the server version (pages reload when it changed) and broadcasts `markup_changed`, `snapshot_request`, `open`, `drawing` and `file_changed` (a local file opened by path was rewritten).

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
web/drawing.js        the drawing sheet in the CW&T template: line-art views, dimension lines, title block, notes, parts list
templates/drawing/    the drawing template (README) and its reference set, Ultra Bench T Drawing v4.pdf
web/explode.js        explode vectors: along a joint's axis, a shared bore axis, off a mating plane, along a channel, out of a pocket, else radial; no collisions; the order parts come off in
mac/main.swift        WKWebView shell, file associations, Sparkle; build.sh, release.sh, cadgang-open, the icon
test/                 node --test: local-path rules, STEP bodies, DXF entities, explode rules, the icon; explode.harness.mjs runs the solver on a real file
```

## Credits

[three.js](https://threejs.org) (MIT, vendored in `web/vendor/`) · [occt-import-js](https://github.com/kovacsv/occt-import-js) (OpenCascade WASM) · [Sparkle](https://sparkle-project.org) · [Space Mono](https://fonts.google.com/specimen/Space+Mono) (SIL OFL 1.1, license in `web/fonts/OFL.txt`)

Built by [CW&T](https://cwandt.com) with Claude Code.
