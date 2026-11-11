# Template spec for turned parts: axis sections, detail views (section + clip), toleranced diameters.
# It drew "Pocket Time Capsule Drawing v1.pdf" (beside this file). The STEP is not in the repo: copy this file
# next to your own STEP, change STEP, the model points and the notes, then run
#   python3 "<cadgang>/stepdraw/stepdraw.py" your_spec.py "Your Part Drawing v1.pdf"
# Every dimension value is measured from the STEP at draw time; only tolerances and notes are typed.
import os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "..", "stepdraw"))
from stepdraw import MM

STEP = os.path.join(HERE, "pocket_time_capsule_v7_split_ring.step")
PM, DIA, DEG = "±", "Ø", "°"
CUT = {"point": [0, 0, 0], "normal": [0, -1, 0]}     # section through the axis, seen from the front

def P(x, z): return (x, 0, z)                        # a model point on the section plane
def hd(S, v, x0, z0, x1, z1, off, tol="", dia=False, tside=1):
    return S.dim3(v, P(x0, z0), P(x1, z1), off, "h", fmt="{:.2f}", prefix=DIA if dia else "", suffix=tol, tside=tside)
def vd(S, v, x0, z0, x1, z1, off, tol="", tside=1):
    return S.dim3(v, P(x0, z0), P(x1, z1), off, "v", fmt="{:.2f}", suffix=tol, tside=tside)
def caption(S, x, y, *lines):
    S.text(x, y, lines[0], 3.5, align="center")
    for i, s in enumerate(lines[1:]): S.text(x, y - 5 - i * 4, s, 2.6, align="center")
def mark(S, v, x, z, r, letter, side=-1, up=0.75):                    # detail circle on the parent view
    c = v.p2(P(x, z)); S.c.setLineWidth(0.18 * MM); S.c.circle(*S.mm(*c), r * MM, stroke=1, fill=0)
    S.text(c[0] + side * (r + 3) - 1, c[1] + r * up, letter, 3.5)
def detail(id, part, x0, x1, z0, z1, scale, at):     # a clipped piece of the axis section
    return {"id": id, "part": part, "dir": "front", "scale": scale, "at": at, "hidden": False, "section": CUT,
            "clip": {"min": [x0, -0.5, z0], "max": [x1, 2, z1]}}

PARTS = [  # item, qty, part number, material
    (1, 1, "CAP  PTC-CAP-01", "TI-6AL-4V GRADE 5"),
    (2, 1, "PLUG  PTC-PLUG-01", "TI-6AL-4V GRADE 5"),
    (3, 1, "SMALLEY HHMU-38-S02", "302 STAINLESS"),
    (4, 1, "O-RING 1.0 CS, SIZE TBC", "TBC"),
]
NOTES = [
    "NOTES:",
    "1. MATERIAL (ITEMS 1, 2): TITANIUM TI-6AL-4V GRADE 5 BAR.",
    "2. FINISH: AS MACHINED, RA 1.6 MAX UNLESS NOTED.",
    "   FINAL FINISH TBD.",
    f"3. UNLESS NOTED: LINEAR {PM}0.10, ANGLES {PM}1 DEG.",
    "4. THE STEP FILES ARE THE MASTER FOR ALL GEOMETRY; THIS",
    "   DRAWING CALLS OUT OVERALL AND CRITICAL DIMENSIONS.",
    "5. DEBURR ALL EDGES. NO BURRS IN ANY GROOVE.",
    "6. QUANTITY: 60 SETS.",
    "7. ITEM 3 IS SEATED IN THE CAP GROOVE BEFORE CLOSING. THE",
    "   PLUG RIM RAMP SPREADS IT AND IT LOCKS INTO THE PLUG",
    "   GROOVE. THE CLOSED ASSEMBLY IS NOT MEANT TO REOPEN.",
    "8. ITEM 4 O-RING SIZE AND MATERIAL TO BE CONFIRMED.",
    "9. DO NOT SCALE DRAWING. DIMENSIONS IN MM.",
]

def s1(S, V, ctx):
    v = V["sec"]
    caption(S, 122, 36, "SECTION THROUGH AXIS, SCALE 4:1")
    caption(S, 85, 150, "ISOMETRIC VIEW, SCALE 2:1")
    hd(S, v, -21, 15.5, 21, 15.5, 12, dia=True)
    vd(S, v, 21, 0, 21, 16, 12)
    S.balloon(v.p2(P(-12, 15)), 1, (36, 146))
    S.balloon(v.p2(P(6, 1)), 2, (160, 50))
    S.balloon(v.p2(P(-19.5, 8)), 3, (22, 112))
    S.balloon(v.p2(P(-19.0, 4.5)), 4, (22, 76))
    S.table(288, 285, [("Item", 12), ("Qty", 12), ("Part Number", 48), ("Material", 48)], PARTS, title="Parts List")
    S.note(240, 240, NOTES)

def s_cap(S, V, ctx):
    v, b, c, d = V["sec"], V["B"], V["C"], V["D"]
    caption(S, 122, 160, "SECTION A-A, SCALE 4:1")
    hd(S, v, -21, 15.5, 21, 15.5, 12, f" {PM}0.05", dia=True)
    hd(S, v, -19.4, 11.5, 19.4, 11.5, 0, " +0.03/0", dia=True)
    hd(S, v, -20.26, 8, 20.26, 8, 0, " +0.05/0", dia=True)
    hd(S, v, -20.2, 0.2, 20.2, 0.2, -9, " +0.05/0", dia=True)
    vd(S, v, -21, 0, -19.4, 14, -16)                         # bore depth
    vd(S, v, -21, 16, -19.4, 14, -16)                        # top thickness
    vd(S, v, 21, 0, 20.26, 6.025, 8, f" {PM}0.05")           # lock ring groove lower shoulder
    vd(S, v, 21, 0, 20.5, 12.9, 17)                          # cut groove
    vd(S, v, 21, 0, 21, 16, 26, f" {PM}0.05")
    mark(S, v, -20.3, 8, 12, "B"); mark(S, v, -20.4, 1.6, 8, "C"); mark(S, v, -20.6, 13.6, 6, "D")
    # detail B: lock ring groove
    caption(S, 262, 166, "DETAIL B, SCALE 10:1", "LOCK RING GROOVE", "SHOULDERS SQUARE, R0.1 MAX")
    vd(S, b, -20.26, 6.025, -20.26, 9.975, 27, " +0.10/0")
    hd(S, b, -20.26, 6.025, -19.4, 6.025, -16)               # groove depth
    hd(S, b, -21, 9.975, -20.26, 9.975, 16, " MIN")          # wall behind the groove
    # detail C: mouth
    caption(S, 322, 172, "DETAIL C, SCALE 10:1", "MOUTH. BORE LEAD-IN 0.5 x 45" + DEG, "OUTER EDGES 0.3 x 45" + DEG + " (2x)")
    vd(S, c, -20.2, 0, -20.2, 2.5, 26, f" {PM}0.03")
    hd(S, c, -21, 0, -20.2, 0, -9)                           # lip
    # detail D: cut groove
    caption(S, 385, 176, "DETAIL D, SCALE 10:1", "CUT GROOVE")
    vd(S, d, -20.5, 12.9, -20.5, 13.9, -16, tside=-1)
    hd(S, d, -21, 12.9, -20.5, 12.9, -15)
    # reference views
    S.cutline((22, 95), (102, 95), "A", side=-1)
    caption(S, 62, 50, "BOTTOM (OPEN END), SCALE 1.5:1"); caption(S, 160, 72, "FRONT, SCALE 1.5:1")
    S.note(240, 150, [
        "CAP  PTC-CAP-01. TURNED PART.",
        "HEIGHTS ARE FROM THE OPEN END.",
        "BORE: RA 0.8 FROM 3.0 TO 6.0 ABOVE THE OPEN END (O-RING",
        "SEAL ZONE). NO AXIAL SCRATCHES.",
        "BORE CONCENTRIC TO OUTSIDE DIAMETER WITHIN 0.05.",
        "LOCK RING GROOVE EDGES BROKEN 0.05 MAX.",
        "MATES WITH PTC-PLUG-01 AND SMALLEY HHMU-38 RING.",
        "GENERAL NOTES: SHEET 1.",
    ])

def s_plug(S, V, ctx):
    v, b, c = V["sec"], V["B"], V["C"]
    caption(S, 122, 166, "SECTION A-A, SCALE 4:1")
    hd(S, v, -19.35, 10.5, 19.35, 10.5, 17, " 0/-0.03", dia=True)
    hd(S, v, -17.85, 7.5, 17.85, 7.5, 0, f" {PM}0.05", dia=True)
    hd(S, v, -20.15, 0.6, 20.15, 0.6, -12, " 0/-0.05", dia=True)
    vd(S, v, -20.15, 0, -17.85, 2, -7, tside=-1)             # floor
    vd(S, v, -20.15, 0, -18.6, 4.5, -15)                     # o-ring groove centre
    vd(S, v, -20.15, 0, -18.9, 9.975, -23, f" {PM}0.05")     # lock ring groove upper shoulder
    vd(S, v, 20.15, 0, 20.15, 2.5, 14, f" {PM}0.03")         # flange
    vd(S, v, 20.15, 0, 18.4, 12.3, 24, f" {PM}0.05")
    mark(S, v, 18.9, 4.5, 6, "B", side=-1); mark(S, v, 18.9, 9.4, 13, "C", side=-1, up=-0.1)
    # detail B: o-ring groove
    caption(S, 262, 178, "DETAIL B, SCALE 15:1", "O-RING GROOVE, FLOOR DIAMETER SHOWN", "BOTTOM CORNERS R0.6, RA 0.8")
    vd(S, b, 19.35, 3.85, 19.35, 5.15, 9, " +0.05/0")
    S.dia3(b, (18.6, 1, 4.5), (288, 192), extra=f" {PM}0.03", rmax=18.7)
    # detail C: lock ring groove and rim ramp
    caption(S, 345, 166, "DETAIL C, SCALE 10:1", "LOCK RING GROOVE (FLOOR DIAMETER SHOWN) AND RIM RAMP", "SHOULDERS SQUARE, R0.1 MAX")
    vd(S, c, 19.35, 6.025, 19.35, 9.975, 9, " +0.10/0")
    vd(S, c, 19.35, 10.8, 18.4, 12.3, 9)
    hd(S, c, 18.4, 12.3, 19.35, 10.8, 8)
    S.dia3(c, (18.9, 1, 8), (326, 238), extra=" 0/-0.05", rmax=19.0)
    # reference views
    S.cutline((22, 95), (102, 95), "A", side=1)
    caption(S, 62, 50, "TOP (OPEN END), SCALE 1.5:1"); caption(S, 160, 72, "FRONT, SCALE 1.5:1")
    S.note(240, 150, [
        "PLUG  PTC-PLUG-01. TURNED PART.",
        "HEIGHTS ARE FROM THE FLANGE BOTTOM FACE.",
        "FLANGE BOTTOM EDGE CHAMFER 0.2 x 45" + DEG + ".",
        "INNER RIM CHAMFER 0.2 x 45" + DEG + ".",
        "RIM RAMP SMOOTH, NO STEP.",
        "BODY CONCENTRIC TO FLANGE DIAMETER WITHIN 0.05.",
        "LOCK RING GROOVE EDGES BROKEN 0.05 MAX.",
        "MATES WITH PTC-CAP-01 AND SMALLEY HHMU-38 RING.",
        "GENERAL NOTES: SHEET 1.",
    ])

SPEC = {
    "step": STEP,
    "meta": {"title": "Pocket Time Capsule", "date": "11/11/26", "rev": "A",
             "status": "FOR QUOTE", "doctype": "Fabrication drawing", "dwg": "PTC-001", "issue": "11/11/26"},
    "sheets": [
        {"title": "ASSEMBLY", "views": [
            {"id": "iso", "part": ".", "dir": "iso", "scale": 2, "at": [85, 215], "hidden": False},
            {"id": "sec", "part": ".", "dir": "front", "scale": 4, "at": [122, 95], "hidden": False, "section": CUT}], "python": s1},
        {"title": "CAP", "views": [
            {"id": "sec", "part": "cap,", "dir": "front", "scale": 4, "at": [122, 212], "hidden": False, "section": CUT},
            detail("B", "cap,", -21.3, -18.4, 5.2, 10.8, 10, [262, 212]),
            detail("C", "cap,", -21.3, -18.4, -0.3, 4.3, 10, [322, 212]),
            detail("D", "cap,", -21.3, -18.4, 12.2, 16.2, 10, [385, 212]),
            {"id": "bottom", "part": "cap,", "dir": "bottom", "scale": 1.5, "at": [62, 95], "hidden": False},
            {"id": "front", "part": "cap,", "dir": "front", "scale": 1.5, "at": [160, 95]}], "python": s_cap},
        {"title": "PLUG", "views": [
            {"id": "sec", "part": "plug,", "dir": "front", "scale": 4, "at": [122, 212], "hidden": False, "section": CUT},
            detail("B", "plug,", 17.5, 19.7, 3.3, 5.7, 15, [262, 212]),
            detail("C", "plug,", 17.5, 19.7, 5.7, 12.5, 10, [345, 212]),
            {"id": "top", "part": "plug,", "dir": "top", "scale": 1.5, "at": [62, 95], "hidden": False},
            {"id": "front", "part": "plug,", "dir": "front", "scale": 1.5, "at": [160, 95]}], "python": s_plug},
    ],
}
