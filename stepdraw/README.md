# stepdraw: how CADgang drawings are made

Fabrication drawings (a multi-sheet A3 PDF in the drawing template, `templates/drawing/README.md`) from a STEP
file plus a short Python spec. This is the process for every drawing set: overall and critical dimensions,
section views, detail views, parts list, notes. The viewer's own one-sheet drawing (`cadgang_drawing_make`) has
no sections, no details and only the dimensions someone placed by hand; use it for a quick look, not for a shop.

Every number on the sheet is measured from the STEP at draw time: linear dims from projected model points,
diameters from the cylindrical face nearest a probe point, bore depths probed through the solid, angles from
face normals. Only tolerances and notes are typed. The drawing cannot disagree with the file the shop cuts from.

## Whose name goes on the sheet

The title block's company (Dept. cell and wordmark) and author (Created by) come from the person making the
drawing, never from a default:

    ~/.config/cadgang/identity.json      {"company": "Acme Works", "author": "Sam Doe"}

`$CADGANG_IDENTITY` names another file. With no file the author is git's `user.name` and the company cells are
empty. A spec's `meta` may still set `author`, `dept` or `company` for one drawing. If the file is missing, ask
the user for their company and name once and write it; do not put anyone else's name in.

## Process

1. **Export the STEP**: one assembly STEP with every solid named (`brep.name(...)` in a cell, then
   `cadgang_cells_export`), so views pick parts by a regex on the solid name. Also export each machined part as
   its own STEP for the shop.
2. **Open it in CADgang** and look at it, including a section.
3. **Know the numbers**: the model points the dimensions hang on (a cell's params give them; otherwise measure
   with `load_step`, `planes`, `cylinders`, `nearest_cylinder`, `bore_depth`, `bbox`). Decide the sheets, the
   views, the sections and which features are critical.
4. **Write the spec** next to the model: `SPEC = {"step", "meta", "sheets": [{title, views: [...], python: fn}]}`.
   Templates: `templates/drawing/pocket_time_capsule_spec.py` (turned parts: axis sections, detail views,
   toleranced diameters) and `templates/drawing/ultra_bench_t_spec.py` (milled parts, magnet schedule).
   - Views: `{"id", "part": <regex on the solid name, "." = everything>, "dir": front|back|top|bottom|right|
     left|iso|iso2, "scale", "at": [x, y] paper mm, "hidden": bool, "section": {"point", "normal"},
     "clip": {"min": [x,y,z], "max": [x,y,z]}}`. A section keeps the half on the -normal side and hatches the
     cut; `normal` is the view's eye direction. `clip` keeps only what is inside the box: a section with a clip
     at a larger scale is a **detail view**, and `at` is then the centre of the clipped piece.
   - Each sheet's `python(S, V, ctx)` draws the annotations: `S.dim3` (give it a tolerance as `suffix`),
     `S.dia3`, `S.angle`, `S.leader`, `S.balloon`, `S.cutline`, `S.table`, `S.note`. Mark each detail on its
     parent view with a circle and a letter, and caption every view with its name and scale.
   - Leave `author`, `dept` and `company` out of `meta` so the identity file fills them.
5. **Render**: `python3 <cadgang>/stepdraw/stepdraw.py spec.py "Name Drawing v1.pdf"`.
6. **Look at every sheet**: `pdftoppm -png -r 70 "Name Drawing v1.pdf" sheet`, then read each PNG. The render
   prints `COLLISION` for text crossed by a line and `WARN` for a zero-length dimension: fix the offsets and
   render again until it prints neither and the sheets read cleanly.
7. **Cross-check** a few numbers against the model's parameters before sending.
8. Bump the `v` in the file name on every revision; the title block carries Rev., date and sheet n/N.

Sheet conventions: sheet 1 = isometric + section with balloons + parts list + general notes; then one sheet
per machined part (a section at the largest scale that fits, details of every groove and fit, reference views
with the cutting line); schedule sheets when there are many of one thing (magnets, holes).

## Install

```
python3 -m pip install cadquery-ocp reportlab pypdf   # OCP 7.8/8.x, Python 3.12 tested on macOS arm64
brew install poppler                                   # pdftoppm, for checking the output
```

## Gotchas

- OCP 8: `OCP.collections.Sequence_TDF_Label` (not `TDF_LabelSequence`), `TopoDS.Solid(...)` (no `_s`),
  `Bnd_Box.CornerMin()/CornerMax()` (`Get()` is unbound).
- HLR takes ~1 s per view for a 500-face part; results are cached in `.cache/` keyed on step path and mtime,
  part, transform, direction, section and clip.
- `nearest_cylinder` picks by face centroid; pass `rmin`/`rmax` when fillets or holes compete.
- Bottom/back/left views mirror an axis; place dims with model points, not paper guesses.
- A dimension shorter than its text puts the text past one end: `tside=-1` picks the other end.
- Dimension text is Courier, the title block Space Mono; the border, zone grid and title block are drawn in
  `Sheet.frame()`.
