# CW&T drawing template

The sheet every CW&T fabrication drawing uses, whether CADgang renders it (**Drawing** button → `web/drawing.js`)
or [stepdraw](https://github.com/cheewee2000/stepdraw) draws it from a STEP file and a Python spec. The
reference set is **`Ultra Bench T Drawing v4.pdf`** (8 sheets, 2026-10-16, drawn with stepdraw from
`ultra_bench_t_spec.py`): look at it before changing anything here.

## Sheet

A3 landscape, 420 × 297 mm, in the Fusion ISO A3 drawing-template style. All positions in mm.

- Outer border 5 mm in from the paper edge (0.25 line), inner border 10 mm in (0.5 line).
- Zone grid in the 5 mm strip between them: 8 columns of 50 mm numbered 1–8 (top and bottom), 6 rows of
  46.17 mm lettered A–F (left and right), 2.5 mm text. Other sheet sizes keep the same strips and ~50 mm zones.
- Title block 180 × 45 mm in the bottom-right corner of the inner border (x 230–410, y 10–55 from the bottom).
  Cells, measured from the block's bottom-left corner:

  | Cell | x | y | Label | Value |
  |---|---|---|---|---|
  | Dept. | 0–30 | 33–45 | 1.8 mm | `CW&T` |
  | Technical reference | 30–60 | 33–45 | | optional |
  | Created by | 60–125 | 33–45 | | author |
  | Approved by | 125–180 | 33–45 | | date (or an approver) |
  | Wordmark | 0–60 | 0–33 | | `CW&T`, 9 mm, centred |
  | Document type | 60–125 | 22–33 | | `Fabrication drawing - <SHEET TITLE>` (shrinks to fit 62 mm) |
  | Document status | 125–180 | 22–33 | | `FOR FABRICATION` |
  | Title | 60–125 | 11–22 | | 4.5 mm |
  | DWG No. | 125–180 | 11–22 | | part / drawing number |
  | Rev. | 60–125 | 0–11 | | `A` |
  | Date of issue | 125–160 | 0–11 | | |
  | Sheet | 160–180 | 0–11 | | `n/N`, centred |

  Labels are 1.8 mm upper-case with 0.06 em tracking, 1.5 mm in from the cell's left edge and 3 mm below its
  top; values 3 mm, 1.5 mm in from the left edge.
- The `CWT_SW_CADGANG_VIEW` ID sits in the bottom margin, right-aligned, 1.8 mm.

## Type

- Title block: Space Mono 400 (`web/fonts/SpaceMono-Regular.ttf`; stepdraw bundles the same file).
- Dimensions, leaders, captions, notes, tables: Courier. Dimension and caption text 3.5 mm, notes and table
  text 3 mm, zone letters 2.5 mm.

## Views

Third-angle projection: top view above the front, right view to the right of the front, an isometric at half
the sheet scale top right. Line art only: visible edges 0.35 mm, hidden edges 0.18 mm dashed (stepdraw), no
shading. Captions centred under each view in upper case: `FRONT`, `TOP`, `RIGHT`, `SECTION A-A, SCALE 1:1`,
`ISOMETRIC VIEW, SCALE 1:2`; the scale is stated in the caption or the sheet note, not in the title block.

## Annotations

- Linear dimensions: 0.18 mm dimension and extension lines, extension lines run 2 mm past the dimension line,
  filled arrowheads 2.5 mm long and 0.45 mm half-wide, text 1.2 mm off the line, centred; vertical dimensions
  read from the right. Text that does not fit between the extension lines goes past the far end.
- Diameters and radii: a leader with an arrowhead at the feature, a 1.5 mm elbow, a shoulder under the text:
  `⌀6.40 x 5.00 DEEP`, `R25 (4x)`, `⌀3.0 THRU (182x)`.
- Section cutting lines 0.5 mm, dash 4–1.5–1–1.5, letters at both ends; the cut faces hatched at 45°, 2 mm.
- Balloons: 4 mm circles, item number inside, leader with an arrowhead.
- Notes: an upper-case numbered list headed `NOTES:`, lines of ≤ 62 characters, continuation lines indented
  3 spaces, 3 mm Courier. Order: material, finish, general tolerances, the STEP is the master, part-specific
  notes, then always `DO NOT SCALE DRAWING. DIMENSIONS IN MM.`
- Parts list: a titled table (`Parts List`), columns Item 12 / Qty 12 / Part Number 48 / Material 48 mm,
  5 mm rows, top right of sheet 1.
- Every number on the sheet is measured from the model (stepdraw: from the STEP at draw time; CADgang: from
  the dimensions placed with Measure). Nothing is typed in by hand.

## Set conventions

Sheet 1: isometric of the assembly, balloons, parts list, general notes. Sheet 2: assembly overall dimensions.
Then one or two sheets per fabricated part (orthographic views, then sections), and schedule sheets
(e.g. magnets: ID, size, host, bore depth, recess, pole facing out, with labelled maps). One PDF per set,
`<Name> Drawing v<n>.pdf`, `v` bumped on every revision; the title block carries Rev., date and sheet n/N.

## In CADgang

`web/drawing.js` renders one sheet per `cadgang_drawing_make` call in this template: the viewer draws the views
as line art, the user's Measure dimensions become dimension lines and leaders, the spec's material / finish /
tolerances become the first notes, `parts` draws the parts list, `sheetNo` / `sheetCount` number a set.
Print each sheet with ⌘P (Letter and A3 sheets print at the stated scale) and merge the PDFs for a set.
