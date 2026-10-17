# Drawing spec for Ultra Bench T — run with stepdraw:
#   python3 ../../stepdraw/stepdraw.py ultra_bench_t_spec.py "Ultra Bench T Drawing v1.pdf"
# Every dimension value is measured from the STEP at draw time (see stepdraw README).
import math, sys, os
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "stepdraw"))
from stepdraw import bbox, planes, cylinders, nearest_cylinder, bore_depth, view_bbox, dot, norm

HERE = os.path.dirname(os.path.abspath(__file__))
STEP = os.path.join(HERE, "..", "export", "Ultra Bench T.step")
TILT = 15.0
DECK = {"rotate": [[0, 1, 0], TILT]}          # top part drawn in its own deck frame (deck normal = +z)
N_WORLD = (-math.sin(math.radians(TILT)), 0, math.cos(math.radians(TILT)))
def deck2world(p):  # inverse of DECK: rotate -TILT about Y
    c, s = math.cos(math.radians(-TILT)), math.sin(math.radians(-TILT))
    return (c * p[0] + s * p[2], p[1], -s * p[0] + c * p[2])

PARTS = [  # item, qty, part number, material
    (1, 1, "ULTRA TOP", "6061-T6 AL"),
    (2, 1, "ULTRA LEG", "6061-T6 AL"),
    (3, 1, "BUMPON (3M, TPR)", "TPR"),
    (4, 2, "MAGNET D6 x 6", "NdFeB N52, Ni-Cu-Ni"),
    (5, 2, "MAGNET D6 x 3", "NdFeB N52, Ni-Cu-Ni"),
    (6, 2, "MAGNET D6 x 1", "NdFeB N52, Ni-Cu-Ni"),
    (7, 4, "MAGNET D6 x 1.5", "NdFeB N52, Ni-Cu-Ni"),
]
# Magnet schedule: id, size, thickness, item, host, (model point near the bore, in the host's drawing frame), outward pole
MAGNETS = [
    ("M1", "D6 x 6", 6.0, 4, "TOP", (-11.73, 0, 163), "N"),
    ("M2", "D6 x 6", 6.0, 4, "TOP", (68.07, 0, 163), "N"),
    ("M3", "D6 x 1", 1.0, 6, "TOP", (-25.16, 0, 181), "N"),
    ("M4", "D6 x 1", 1.0, 6, "TOP", (81.5, 0, 181), "N"),
    ("M5", "D6 x 3", 3.0, 5, "LEG", (-53.11, 0, 150.5), "S"),
    ("M6", "D6 x 3", 3.0, 5, "LEG", (23.97, 0, 171), "S"),
    ("M7", "D6 x 1.5", 1.5, 7, "LEG", (44.78, -8.7, 94.81), "S"),
    ("M8", "D6 x 1.5", 1.5, 7, "LEG", (-61.48, -8.7, 85.51), "S"),
    ("M9", "D6 x 1.5", 1.5, 7, "LEG", (-60.91, 8.7, 85.56), "S"),
    ("M10", "D6 x 1.5", 1.5, 7, "LEG", (45.35, 8.7, 94.86), "S"),
]
NOTES = [
    "NOTES:",
    "1. MATERIAL: 6061-T6 ALUMINUM. MACHINE FROM SOLID.",
    "2. FINISH: AS MACHINED, DEBURR AND BREAK ALL EDGES 0.2 MAX.",
    "3. UNLESS NOTED: LINEAR +/-0.1, ANGLES +/-0.5 DEG.",
    "4. STEP FILE 'Ultra Bench T.step' IS THE MASTER; THIS",
    "   DRAWING CALLS OUT OVERALL AND CRITICAL DIMENSIONS ONLY.",
    "5. MAGNET BORES: D6.40 +0.05/-0, DEPTH AS NOTED. MAGNETS",
    "   SEAT ON BORE FLOOR; BOND IN WITH TWO-PART EPOXY.",
    "6. MAGNET POLARITY: TOP MAGNETS M1-M4 N POLE FACES OUT",
    "   (TOWARD LEG). LEG MAGNETS M5-M10 S POLE FACES OUT.",
    "   SEE SHEET 8. VERIFY ATTRACTION BEFORE BONDING.",
    "7. TENON (TOP) / SOCKET (LEG) IS A SLIDING FIT: 10.90 / 11.00.",
    "8. DO NOT SCALE DRAWING. DIMENSIONS IN MM.",
]
DEPTHS = {}   # filled at draw time: magnet id -> measured bore depth

def mag(shape, p):
    c = nearest_cylinder(shape, p, rmax=3.3, rmin=3.1)
    d, floor, n = bore_depth(shape, c)
    return c, d
def caption(S, v, name, dy=8):
    vb = view_bbox(v); S.text((vb[0] + vb[2]) / 2, vb[1] - dy, name, 3.5, align="center")

# ------------------------------------------------------------------ sheet 1: assembly iso + parts list
def s1(S, V, ctx):
    iso = V["iso"]
    S.table(290, 287, [("Item", 12), ("Qty", 12), ("Part Number", 48), ("Material", 48)],
            [(i, q, p, m) for i, q, p, m in PARTS], title="Parts List")
    S.note(235, 140, NOTES)
    S.balloon(iso.p2(deck2world((100, -90, 182.4))), 1, (215, 262))
    S.balloon(iso.p2((40, -9.5, 60)), 2, (170, 75))
    S.balloon(iso.p2((0, -8, -9)), 3, (75, 75))
    S.balloon(iso.p2((-53.7, -3, 155)), 4, (40, 150))
    S.balloon(iso.p2((24.3, -3, 171)), 5, (215, 215))
    S.balloon(iso.p2((-71.1, -3, 168.2)), 6, (40, 200))
    S.balloon(iso.p2((44.78, -9.36, 94.81)), 7, (215, 120))
    S.text(130, 48, "ISOMETRIC VIEW, T (STANDING) CONFIGURATION, SCALE 1:2", 3, align="center")

# ------------------------------------------------------------------ sheet 2: assembly overall dims
def s2(S, V, ctx):
    f, r, t = V["front"], V["right"], V["top"]
    bb = bbox(f.shape)
    top = ctx["pick"]("Ultra Top"); deck = max(planes(top), key=lambda p: p["area"]); zb = deck["bb"]
    lo = (zb[0] if deck2world((0, 0, 182.4))[2] < 0 else None)  # unused guard
    # deck top face corners in world: low edge (min z) and high edge (max z)
    lo_x = zb[0] if abs(deck2world((-58.51, 0, 182.4))[2] - zb[2]) < 0.5 else zb[3]
    hi_x = zb[3] if lo_x == zb[0] else zb[0]
    S.dim3(f, (bb[0], 0, bb[2]), (bb[3], 0, bb[2]), -10, "h")                       # overall width
    S.dim3(f, (bb[3], 0, bb[2]), (bb[3], 0, bb[5]), 30, "v")                        # overall height
    S.dim3(f, (lo_x, 0, bb[2]), (lo_x, 0, zb[2]), -12 if lo_x < 0 else 12, "v")     # seat height, low edge
    ang = math.degrees(math.acos(abs(deck["n"][2])))
    v0 = f.p2((lo_x, 0, zb[2])); hi = f.p2((hi_x, 0, zb[5])); hz = (v0[0] + (40 if hi_x > lo_x else -40), v0[1])
    S.angle(v0, hz, hi, 35, ang)
    S.dim3(r, (0, bb[1], bb[2]), (0, bb[4], bb[2]), -18, "h")                       # depth
    leg = ctx["pick"]("Ultra Leg"); lb = bbox(leg)
    S.dim3(t, (bb[0], bb[1], 0), (bb[0], bb[4], 0), -12, "v")
    S.dim3(t, (lb[3], lb[1], 0), (lb[3], lb[4], 0), 12, "v", fmt="{:.1f}")           # leg thickness
    caption(S, f, "FRONT", 20); caption(S, r, "RIGHT", 26); caption(S, t, "TOP", 8)
    S.note(240, 135, ["ASSEMBLY, T CONFIGURATION. SCALE 2:5.", "LEG STANDS ON BUMPON; SEAT TILTS 15 DEG.",
                      "OVERALL DIMENSIONS FOR REFERENCE;", "PART DIMENSIONS ON SHEETS 3-7."])

# ------------------------------------------------------------------ sheet 3: top, deck frame
def s3(S, V, ctx):
    t, f, r = V["top"], V["front"], V["right"]
    sh = t.shape; bb = bbox(sh); pl = planes(sh)
    deck = max(pl, key=lambda p: p["area"]); ceil = max([p for p in pl if p["n"][2] < -0.99], key=lambda p: p["area"])
    S.dim3(t, (bb[0], bb[4], 0), (bb[3], bb[4], 0), 12, "h")
    S.dim3(t, (bb[3], bb[1], 0), (bb[3], bb[4], 0), 14, "v")
    vb = view_bbox(t)
    c = nearest_cylinder(sh, (87.7, 89.1, 182), rmin=20, rmax=30)
    tip = t.p2((c["loc"][0] + c["r"] * 0.7071, c["loc"][1] + c["r"] * 0.7071, bb[5]))
    S.leader(tip, f"R{c['r']:.0f} (4x)", (vb[2] + 18, vb[3] + 4))
    cy = cylinders(sh)
    h3 = [c for c in cy if abs(c["r"] - 1.5) < 0.01]; h4 = [c for c in cy if abs(c["r"] - 2.0) < 0.01]
    p0 = nearest_cylinder(sh, (-31.8, 85, 182), rmax=1.6); p1 = nearest_cylinder(sh, (-21.8, 85, 182), rmax=1.6); p2 = nearest_cylinder(sh, (-31.8, 75, 182), rmax=1.6)
    p3 = nearest_cylinder(sh, (-31.8, 55, 182), rmax=1.6)   # mid-left hole, clear of the 39.2 dim
    S.dia3(t, p3["c"], (vb[0] - 10, t.p2(p3["loc"])[1] + 10), f" THRU ({len(h3)}x)", fmt="{:.1f}")
    q4 = nearest_cylinder(sh, (-38.3, 119.9, 182), rmin=1.9, rmax=2.1)
    S.dia3(t, q4["c"], (vb[0] - 8, vb[3] + 8), f" THRU ({len(h4)}x)", fmt="{:.1f}")
    xs = sorted(set(round(c["loc"][0], 1) for c in h3)); ys = sorted(set(round(c["loc"][1], 1) for c in h3))
    S.dim3(t, (xs[-2], ys[0], 0), (xs[-1], ys[0], 0), -8, "h")      # pitch x, text lands right of the grid
    S.dim3(t, (xs[-1], ys[-2], 0), (xs[-1], ys[-1], 0), 8, "v")     # pitch y, text lands above the grid
    S.dim3(t, (bb[0], ys[-1], 0), (xs[0], ys[-1], 0), 24, "h")
    S.dim3(t, (xs[0], bb[4], 0), (xs[0], ys[-1], 0), -32, "v")
    S.dim3(t, (xs[0], ys[0], 0), (xs[-1], ys[0], 0), -16, "h")
    S.dim3(t, (xs[-1], ys[0], 0), (xs[-1], ys[-1], 0), 20, "v")
    ncol, nrow = len(xs), len(ys)
    S.dim3(f, (bb[3], 0, bb[2]), (bb[3], 0, bb[5]), 12, "v")
    S.dim3(f, (bb[3], 0, ceil["c"][2]), (bb[3], 0, deck["c"][2]), 24, "v")
    ten = [p for p in pl if abs(p["n"][2] + 1) < 0.01 and abs(p["c"][2] - 160.4) < 0.1][0]
    S.dim3(f, (ten["bb"][0], 0, ten["bb"][2]), (ten["bb"][3], 0, ten["bb"][2]), -8, "h")
    S.dim3(f, (ten["bb"][0], 0, ten["c"][2]), (ten["bb"][0], 0, ceil["c"][2]), -34, "v")
    S.dim3(r, (0, bb[1], bb[2]), (0, bb[4], bb[2]), -10, "h")
    S.dim3(r, (0, bb[4], bb[2]), (0, bb[4], bb[5]), 12, "v")
    caption(S, t, "TOP (DECK UP)", 12); caption(S, f, "FRONT", 16); caption(S, r, "RIGHT", 16)
    S.note(240, 135, ["ULTRA TOP, SCALE 1:2. DRAWN IN DECK FRAME", "(DECK HORIZONTAL; TILT 15 DEG IS SET BY THE LEG).",
                      f"D3 PERFORATIONS ON 10 x 10 GRID, {ncol} COLUMNS x {nrow} ROWS", "(7 + 7 ROWS, 50 GAP ON CENTRE LINE).",
                      "UNDERSIDE AND SECTIONS: SHEET 4."])

# ------------------------------------------------------------------ sheet 4: top underside + sections
def s4(S, V, ctx):
    b, a, bsec = V["bottom"], V["secA"], V["secB"]
    sh = b.shape; bb = bbox(sh); pl = planes(sh)
    deck = max(pl, key=lambda p: p["area"])
    ceil = max([p for p in pl if p["n"][2] < -0.99], key=lambda p: p["area"]); cb = ceil["bb"]
    vb = view_bbox(b)
    S.dim3(b, (cb[0], cb[1], 0), (cb[3], cb[1], 0), 32, "h")       # pocket x (bottom view: y is mirrored, cb[1] is at top of paper)
    S.dim3(b, (bb[0], cb[4], 0), (cb[0], cb[4], 0), -20, "h")      # rim band (x)
    wall_out = [p for p in pl if abs(p["n"][0] + 1) < 0.01 and abs(p["c"][0] + 49.98) < 0.05][0]
    wt = b.p2(((wall_out["c"][0] + cb[0]) / 2, -60, 0)); S.leader(wt, f"{cb[0] - wall_out['c'][0]:.1f} WALL", (vb[0] - 8, wt[1] + 4))
    e1 = nearest_cylinder(sh, (-11.73, 0, 170), rmin=5.4, rmax=5.5); e2 = nearest_cylinder(sh, (68.07, 0, 170), rmin=5.4, rmax=5.5)
    S.dim3(b, e1["loc"], e2["loc"], -10, "h", fmt="{:.1f}")
    s1_ = nearest_cylinder(sh, (-3.08, 0, 170), rmin=2.4, rmax=2.5); s2_ = nearest_cylinder(sh, (59.42, 0, 170), rmin=2.4, rmax=2.5)
    S.dim3(a, (e1["loc"][0] - e1["r"], 0, 160.4), (e2["loc"][0] + e2["r"], 0, 160.4), -12, "h", fmt="{:.1f}")   # tenon length (A-A)
    S.dim3(a, (s1_["loc"][0], 0, 160.4), (s2_["loc"][0], 0, 160.4), -20, "h", fmt="{:.1f}")                 # slot end centres (A-A)
    S.dim3(a, (s1_["loc"][0] - 2.45, 0, 170), (s1_["loc"][0] - 2.45, 0, 178.4), 0, "v", fmt="{:.1f}") if False else None
    for mid, size, thk, item, host, p, pole in MAGNETS:
        if host != "TOP": continue
        c, d = mag(sh, p); DEPTHS[mid] = d
        pp = b.p2(c["loc"]); pos = (vb[0] - 6 if c["loc"][0] < 28 else vb[2] + 6, pp[1] + (16 if size == "D6 x 6" else -16))
        S.dia3(b, c["c"], pos, f" x {d:.2f} DEEP\n{mid} ({size}) {pole} OUT", fmt="{:.2f}")
    m3, _ = mag(sh, (-25.16, 0, 181)); m4, _ = mag(sh, (81.5, 0, 181))
    S.dim3(b, (cb[0], 0, 0), (m3["loc"][0], 0, 0), 68, "h", fmt="{:.2f}", tside=-1)
    S.dim3(b, (cb[3], 0, 0), (m4["loc"][0], 0, 0), 68, "h", fmt="{:.2f}")
    S.dim3(b, (cb[0], 0, 0), (e1["loc"][0], 0, 0), 76, "h", fmt="{:.2f}")
    S.cutline((vb[0] - 6, b.p2((0, 0, 0))[1]), (vb[2] + 6, b.p2((0, 0, 0))[1]), "A", side=-1)
    xb = 42.0   # through the slot, clear of the 79.8 and 23.32 texts
    S.cutline((b.p2((xb, 0, 0))[0], vb[1] - 6), (b.p2((xb, 0, 0))[0], vb[3] + 6), "B", side=-1)
    # section A-A
    S.dim3(a, (bb[3], 0, ceil["c"][2]), (bb[3], 0, bb[5]), 10, "v", fmt="{:.1f}")
    S.dim3(a, (e1["loc"][0] - 5.45, 0, 160.4), (e1["loc"][0] - 5.45, 0, ceil["c"][2]), -22, "v", fmt="{:.1f}")
    m1, d1 = mag(sh, (-11.73, 0, 163)); S.dim3(a, (m1["loc"][0] + 3.2, 0, 160.4), (m1["loc"][0] + 3.2, 0, 160.4 + d1), 16, "v", fmt="{:.2f}")
    # section B-B
    S.dim3(bsec, (0, -5.45, 170), (0, 5.45, 170), -20, "h", fmt="{:.2f}")
    S.dim3(bsec, (0, -2.45, 170), (0, 2.45, 170), 12, "h", fmt="{:.1f}")
    S.dim3(bsec, (0, cb[1], ceil["c"][2]), (0, cb[4], ceil["c"][2]), 12, "h", fmt="{:.2f}")
    S.dim3(bsec, (0, bb[4], bb[2]), (0, bb[4], bb[5]), 10, "v", fmt="{:.2f}")
    S.dim3(bsec, (0, bb[1], ceil["c"][2]), (0, bb[1], deck["c"][2]), -10, "v", fmt="{:.1f}", tside=-1)
    caption(S, b, "BOTTOM (POCKET SIDE)", 12); caption(S, a, "SECTION A-A, SCALE 1:1", 32); caption(S, bsec, "SECTION B-B, SCALE 3:4", 24)
    S.note(240, 100, ["ULTRA TOP UNDERSIDE, SCALE 1:2. DECK FRAME.", "RIB WALLS 1.5 THK (SEE STEP). MAGNET BORES",
                      "D6.40 +0.05/-0 AT DEPTHS NOTED; M1/M2 ARE IN", "THE TENON END FACES, M3/M4 IN THE POCKET CEILING."])

# ------------------------------------------------------------------ sheet 5: leg
def s5(S, V, ctx):
    f, r, t, bt = V["front"], V["right"], V["top"], V["bottom"]
    sh = f.shape; bb = bbox(sh); pl = planes(sh); fb = view_bbox(f)
    S.dim3(f, (bb[0], 0, bb[2]), (bb[3], 0, bb[2]), -12, "h")
    S.dim3(f, (bb[0], 0, bb[2]), (bb[0], 0, bb[5]), -44, "v")
    S.dim3(r, (0, bb[1], bb[2]), (0, bb[4], bb[2]), -12, "h", fmt="{:.2f}")
    tb = view_bbox(t); xr = tb[2] - t.p2((31, 0, 0))[0]
    S.dim3(t, (31, -5.5, 190), (31, 5.5, 190), xr + 16, "v", fmt="{:.2f}")      # socket width, dim line right of the strip
    S.dim3(t, (31, -2.45, 170), (31, 2.45, 170), xr + 8, "v", fmt="{:.1f}")    # through slot width
    e1 = nearest_cylinder(sh, (-53.11, 0, 165), rmin=5.4, rmax=5.6); e2 = nearest_cylinder(sh, (23.97, 0, 185), rmin=5.4, rmax=5.6)
    floor = max([p for p in pl if abs(p["n"][0] - N_WORLD[0]) < 0.01 and abs(p["c"][2] - 162.23) < 0.5], key=lambda p: p["area"])
    topf = max([p for p in pl if abs(p["n"][0] - N_WORLD[0]) < 0.01 and abs(p["c"][2] - 181.55) < 0.5], key=lambda p: p["area"])
    d = sum((topf["c"][i] - floor["c"][i]) * N_WORLD[i] for i in range(3))
    q0 = (e1["loc"][0] - 5.5 * N_WORLD[2], 0, e1["loc"][2] + 5.5 * N_WORLD[0])
    q1 = (q0[0] + N_WORLD[0] * d, 0, q0[2] + N_WORLD[2] * d)
    S.dim(f.p2(q0), f.p2(q1), 26, "aligned", value=d, fmt="{:.1f}")            # socket depth, outside the part
    v0 = f.p2((e2["loc"][0] + 5.5 * N_WORLD[2], 0, e2["loc"][2] - 5.5 * N_WORLD[0]))  # top-right corner of the slot
    S.angle(v0, (v0[0], v0[1] + 30), f.p2((e2["loc"][0] + 5.5 * N_WORLD[2] + 40 * N_WORLD[0], 0, e2["loc"][2] - 5.5 * N_WORLD[0] + 40 * N_WORLD[2])), 26, TILT)
    # outer-face magnet bores (pairs share x,z): one callout per pair
    pairs = [("M7", "M10", (44.78, -8.7, 94.81), (45.35, 8.7, 94.86)), ("M8", "M9", (-61.48, -8.7, 85.51), (-60.91, 8.7, 85.56))]
    for near, far, pn, pf in pairs:
        cn, dn = mag(sh, pn); cf, df = mag(sh, pf); DEPTHS[near] = dn; DEPTHS[far] = df
        pp = f.p2(cn["loc"]); pos = (fb[2] + 8 if cn["loc"][0] > 0 else fb[0] - 8, pp[1] + 24)
        S.dia3(f, cn["c"], pos, f" x {dn:.2f} DEEP\n{near} (-Y) / {far} (+Y)\nS OUT, BOTH FACES", fmt="{:.2f}")
        S.dim3(f, (bb[0], 0, bb[2]), (cn["loc"][0], 0, bb[2]), -22 if cn["loc"][0] < 0 else -30, "h", fmt="{:.2f}")
        S.dim3(f, (bb[0], 0, bb[2]), (bb[0], 0, cn["loc"][2]), -26 if cn["loc"][0] < 0 else -35, "v", fmt="{:.2f}")
    g = [p for p in pl if abs(p["n"][1] + 1) < 0.01 and abs(p["c"][1] - 8.06) < 0.01][0]
    btb = view_bbox(bt); S.dim3(bt, (90, -8.06, -5), (90, 8.06, -5), btb[2] + 8 - bt.p2((90, 0, 0))[0], "v", fmt="{:.2f}")   # groove width, off the strip's end
    big = [c for c in cylinders(sh) if c["r"] > 200 and c["bb"][5] < 1 and c["bb"][1] < -5 and c["bb"][4] > 5]  # full-width arcs under the foot
    sole = max(big, key=lambda c: c["r"]); grv = min(big, key=lambda c: c["r"])
    tip = f.p2((0, 0, bb[2])); S.leader(tip, f"R{sole['r']:.2f} SOLE", (fb[2] + 10, tip[1] + 2))
    tip2 = f.p2((0, 0, grv["bb"][5])); S.leader(tip2, f"R{grv['r']:.2f} GROOVE, {sole['r'] - grv['r']:.1f} DEEP", (fb[2] + 10, tip2[1] + 12))
    caption(S, f, "FRONT (-Y FACE)", 40); caption(S, r, "RIGHT", 20); caption(S, t, "TOP", 10); caption(S, bt, "BOTTOM", 10)
    S.note(285, 100, ["ULTRA LEG, SCALE 3:5. 19.00 PLATE, C-CHANNEL RAILS", "(2.0 FLANGES), 7.0 TRUSS WEB. SOCKET IS TILTED 15 DEG",
                      "TO MATCH THE SEAT. NEAR FACE = -Y (FACING VIEWER IN", "FRONT VIEW). SOCKET LENGTHS AND SECTIONS: SHEET 6."])

# ------------------------------------------------------------------ sheet 6: leg sections
def s6(S, V, ctx):
    c, d, e, ref, reft = V["secC"], V["secD"], V["secE"], V["ref"], V["reftop"]
    sh = ref.shape; bb = bbox(sh); pl = planes(sh)
    fb = view_bbox(ref); tb = view_bbox(reft)
    yD = ref.p2((0, 0, 94.81))[1]; S.cutline((fb[0] - 6, yD), (fb[2] + 6, yD), "D", side=1)
    xE = ref.p2((23.97, 0, 0))[0]; S.cutline((xE, fb[1] - 6), (xE, fb[3] + 6), "E", side=-1)
    yC = reft.p2((0, 0, 0))[1]; S.cutline((tb[0] - 6, yC), (tb[2] + 6, yC), "C", side=-1)
    cbv = view_bbox(c)
    for mid, p in (("M5", (-53.11, 0, 150.5)), ("M6", (23.97, 0, 171))):
        m, dep = mag(sh, p); DEPTHS[mid] = dep
        pp = c.p2(m["loc"]); pos = (cbv[2] + 8, pp[1] + (16 if mid == "M6" else -4))
        S.dia3(c, m["c"], pos, f" x {dep:.2f} DEEP\n{mid} (D6 x 3) S OUT", fmt="{:.2f}")
    e1 = nearest_cylinder(sh, (-53.11, 0, 165), rmin=5.4, rmax=5.6); e2 = nearest_cylinder(sh, (23.97, 0, 185), rmin=5.4, rmax=5.6)
    s1_ = nearest_cylinder(sh, (-44.75, 0, 155), rmin=2.4, rmax=2.5); s2_ = nearest_cylinder(sh, (15.62, 0, 171), rmin=2.4, rmax=2.5)
    S.dim(c.p2(e1["loc"]), c.p2(e2["loc"]), 22, "aligned", value=math.dist(e1["loc"], e2["loc"]), fmt="{:.1f}")
    S.dim(c.p2(s1_["loc"]), c.p2(s2_["loc"]), -16, "aligned", value=math.dist(s1_["loc"], s2_["loc"]), fmt="{:.1f}")
    S.dim3(d, (bb[0], -9.5, 0), (bb[0], 9.5, 0), -10, "v", fmt="{:.2f}")
    S.dim3(d, (-66, -9.5, 0), (-66, -7.5, 0), -22, "v", fmt="{:.1f}")
    webp = [q for q in pl if abs(q["n"][1]) > 0.99 and abs(abs(q["c"][1]) - 3.5) < 0.01]
    web = max(q["c"][1] for q in webp) - min(q["c"][1] for q in webp)
    wp = d.p2((-30, 0, 94.81)); S.leader(wp, f"{web:.1f} TRUSS WEB", (wp[0] - 20, wp[1] - 16))
    m7, d7 = mag(sh, (44.78, -8.7, 94.81)); m10, d10 = mag(sh, (45.35, 8.7, 94.86))
    S.dia3(d, m7["c"], (d.p2(m7["c"])[0] + 10, d.p2(m7["c"])[1] - 14), f" x {d7:.2f} DEEP (M7)", fmt="{:.2f}")
    S.dia3(d, m10["c"], (d.p2(m10["c"])[0] + 10, d.p2(m10["c"])[1] + 12), f" x {d10:.2f} DEEP (M10)", fmt="{:.2f}")
    S.dim3(e, (0, -5.5, 185), (0, 5.5, 185), 14, "h", fmt="{:.2f}")
    S.dim3(e, (0, -9.5, bb[2]), (0, 9.5, bb[2]), -10, "h", fmt="{:.2f}")
    caption(S, c, "SECTION C-C (Y=0), SCALE 3:5", 12); caption(S, d, "SECTION D-D, SCALE 1:1", 10)
    caption(S, e, "SECTION E-E, SCALE 3:5", 18); caption(S, ref, "FRONT (REF)", 10); caption(S, reft, "TOP (REF)", 10)

# ------------------------------------------------------------------ sheet 7: bumpon (curved strip) + flat pattern
def s8(S, V, ctx):
    f, t = V["front"], V["top"]
    sh = f.shape; bb = bbox(sh); cy = cylinders(sh); pl = planes(sh)
    outer = max(cy, key=lambda c: c["r"]); inner = min(cy, key=lambda c: c["r"]); cx = outer["loc"][0]
    thk = outer["r"] - inner["r"]; width = bb[4] - bb[1]; rend = width / 2
    aR = math.asin((bb[3] - cx) / outer["r"]); aL = math.asin((cx - bb[0]) / outer["r"]); ang = aR + aL   # included angle
    rm = (outer["r"] + inner["r"]) / 2; Lmid, Lin, Lout = rm * ang, inner["r"] * ang, outer["r"] * ang
    # front: arc, chord, thickness, radii
    S.dim3(f, (bb[0], 0, bb[2]), (bb[3], 0, bb[2]), -12, "h", fmt="{:.2f}")
    end = (cx + outer["r"] * math.sin(aR), 0, outer["loc"][2] - outer["r"] * math.cos(aR))        # outer end point
    end_in = (cx + inner["r"] * math.sin(aR), 0, outer["loc"][2] - inner["r"] * math.cos(aR))
    S.dim(f.p2(end_in), f.p2(end), 20, "aligned", value=thk, fmt="{:.2f}")
    fb = view_bbox(f)
    S.leader(f.p2((cx - 20, 0, outer["loc"][2] - outer["r"] * math.cos(math.radians(4)))), f"R{outer['r']:.2f} OUTSIDE", (fb[0] - 8, fb[1] - 8))
    S.leader(f.p2((cx + 20, 0, outer["loc"][2] - inner["r"] * math.cos(math.radians(4)))), f"R{inner['r']:.2f} INSIDE", (fb[2] + 14, fb[3] + 12))
    # top: plan, width, full-round ends
    S.dim3(t, (bb[3], bb[1], 0), (bb[3], bb[4], 0), 12, "v", fmt="{:.2f}")
    tb = view_bbox(t)
    S.leader(t.p2((bb[0] + rend * 0.3, rend * 0.7, 0)), f"R{rend:.2f} FULL ROUND (2x)", (tb[0] + 12, tb[3] + 8))
    # flat pattern (stadium at mid-thickness) + edge view, scale 1:1, drawn from the measured numbers
    x0, y0 = 150, 150; L, W = Lmid, width; R = rend
    arc = lambda c, a0, a1: [(c[0] + R * math.cos(math.radians(a)), c[1] + R * math.sin(math.radians(a))) for a in range(a0, a1 + 1, 6)]
    stad = arc((x0 - L / 2 + R, y0), 90, 270) + arc((x0 + L / 2 - R, y0), -90, 90) + [(x0 - L / 2 + R, y0 + W / 2)]
    S.poly(stad, 0.35)
    S.line((x0 - L / 2 + R, y0 - W / 2 - 3), (x0 - L / 2 + R, y0 + W / 2 + 3), 0.18, [3 * 72 / 25.4, 1 * 72 / 25.4]); S.line((x0 + L / 2 - R, y0 - W / 2 - 3), (x0 + L / 2 - R, y0 + W / 2 + 3), 0.18, [3 * 72 / 25.4, 1 * 72 / 25.4])
    S.dim((x0 - L / 2, y0 - W / 2), (x0 + L / 2, y0 - W / 2), -14, "h", value=L, fmt="{:.2f}")
    S.dim((x0 - L / 2 + R, y0 - W / 2), (x0 + L / 2 - R, y0 - W / 2), -24, "h", value=L - 2 * R, fmt="{:.2f}")
    S.dim((x0 + L / 2, y0 - W / 2), (x0 + L / 2, y0 + W / 2), 12, "v", value=W, fmt="{:.2f}")
    S.leader((x0 - L / 2 + R * (1 - math.cos(math.radians(45))), y0 + R * math.sin(math.radians(45))), f"R{R:.2f} (2x)", (x0 - L / 2 + 12, y0 + W / 2 + 8))
    ye = y0 - W / 2 - 34
    S.poly([(x0 - L / 2, ye), (x0 + L / 2, ye), (x0 + L / 2, ye - thk), (x0 - L / 2, ye - thk), (x0 - L / 2, ye)], 0.35)
    S.dim((x0 + L / 2, ye - thk), (x0 + L / 2, ye), 12, "v", value=thk, fmt="{:.2f}")
    S.text(x0, ye - thk - 8, "FLAT PATTERN, SCALE 1:1 (EDGE VIEW BELOW)", 3.5, align="center")
    caption(S, f, "FRONT (AS INSTALLED), SCALE 1:1", 20); caption(S, t, "TOP (PLAN), SCALE 1:1", 16)
    S.bullets(245, 195, [
        f"BUMPON: ITEM 3, TPR STRIP {thk:.1f} THK. CUT FLAT TO THE PATTERN SHOWN, THEN BEND INTO THE LEG FOOT GROOVE (SHEET 5: R{inner['r']:.2f} CEILING, 16.12 WIDE, 2.0 DEEP).",
        f"FLAT LENGTH {Lmid:.2f} IS THE NEUTRAL-AXIS (MID-THICKNESS) ARC LENGTH OVER {math.degrees(ang):.2f} DEG. INSIDE FACE {Lin:.2f}, OUTSIDE FACE {Lout:.2f}.",
        f"INSTALLED, THE STRIP STANDS {outer['r'] - 277.27:.2f} PROUD OF THE LEG SOLE (R277.27) AND IS THE ONLY FLOOR CONTACT.",
        "ENDS ARE FULL ROUND. BOND INTO THE GROOVE WITH AN ADHESIVE RATED FOR TPR TO ALUMINUM; CLEAN THE GROOVE WITH IPA FIRST, SEAT THE STRIP FULLY AGAINST THE CEILING, WIPE SQUEEZE-OUT. CONFIRM FIT ON FIRST ARTICLE.",
    ], width=165)

# ------------------------------------------------------------------ sheet 8: magnets
def s7(S, V, ctx):
    rows = []
    for m, s, thk, it, h, pt, pole in MAGNETS:
        loc = ("TENON END FACE" if s == "D6 x 6" else "POCKET CEILING") if h == "TOP" else ("SOCKET FLOOR" if s == "D6 x 3" else ("-Y (NEAR) FACE" if pt[1] < 0 else "+Y (FAR) FACE"))
        dep = DEPTHS.get(m); rec = f"{dep - thk:.2f}" if dep else "-"
        rows.append((m, s, f"ITEM {it}", h, loc, f"{dep:.2f}" if dep else "-", rec, f"{pole} OUT"))
    S.table(230, 287, [("ID", 10), ("Size", 20), ("Item", 14), ("Part", 11), ("Location", 32), ("Bore dp", 16), ("Recess", 14), ("Pole", 14)], rows, title="Magnet Schedule (bores D6.40 +0.05/-0)")
    S.bullets(230, 200, [
        "ALL MAGNETS: NdFeB N52, Ni-Cu-Ni PLATED, AXIALLY MAGNETIZED, D6.00.",
        "'OUT' = THE FACE AT THE BORE MOUTH, TOWARD THE MATING PART.",
        "TOP MAGNETS M1-M4: N OUT. LEG MAGNETS M5-M10: S OUT.",
        "M1/M2 (TOP TENON) MATE WITH M5/M6 (LEG SOCKET) IN THE T CONFIGURATION.",
        "M3/M4 (TOP CEILING) MATE WITH M7-M10 (LEG FACES) WHEN THE LEG IS FOLDED INTO THE TOP'S POCKET, EITHER FACE UP.",
        "RECESS = BORE DEPTH - MAGNET THICKNESS. MAGNET SITS BELOW THE MOUTH.",
        "MARK EACH MAGNET'S OUT FACE BEFORE INSTALLING. VERIFY ATTRACTION WITH THE MATING PART BEFORE BONDING.",
        "EPOXY MAGNETS IN: SEAT ON BORE FLOOR, BOND WITH TWO-PART EPOXY, WIPE SQUEEZE-OUT FLUSH. NO EPOXY ON THE OUT FACE.",
    ], width=175)
    b, f = V["topmap"], V["legmap"]
    groups = {}
    for mid, size, thk, item, host, p, pole in MAGNETS:
        v = b if host == "TOP" else f
        c = nearest_cylinder(v.shape, p, rmax=3.3, rmin=3.1); pp = v.p2(c["loc"])
        key = (host, round(pp[0] / 3), round(pp[1] / 3))
        groups.setdefault(key, [v, pp, []])[2].append(f"{mid} {pole}" + ("" if host == "TOP" or size != "D6 x 1.5" else (" (NEAR)" if p[1] < 0 else " (FAR)")))
    slots = {}
    for (host, _, _), (v, pp, labels) in sorted(groups.items(), key=lambda kv: kv[1][1][0]):
        vb = view_bbox(v); right = pp[0] > (vb[0] + vb[2]) / 2
        k = slots.get((host, right), 0); slots[(host, right)] = k + 1
        pos = (vb[2] + 8 if right else vb[0] - 8, pp[1] + (10 if right else -10) + k * 12)
        S.leader(pp, "\n".join(labels), pos, 3)
    caption(S, b, "TOP, UNDERSIDE (M1-M4)", 10); caption(S, f, "LEG, FRONT (-Y FACE) (M5-M10)", 10)

SPEC = {
    "step": STEP,
    "meta": {"title": "Ultra Bench T", "author": "Che-Wei Wang", "date": "10/16/26", "rev": "A",
             "status": "FOR FABRICATION", "doctype": "Fabrication drawing", "dwg": "UBT-001", "issue": "10/16/26"},
    "sheets": [
        {"title": "ASSEMBLY", "views": [
            {"id": "iso", "part": ".", "dir": "iso", "scale": 0.5, "at": [130, 165], "hidden": False}], "python": s1},
        {"title": "ASSEMBLY OVERALL", "views": [
            {"id": "front", "part": ".", "dir": "front", "scale": 0.4, "at": [85, 205], "hidden": False},
            {"id": "right", "part": ".", "dir": "right", "scale": 0.4, "at": [230, 205], "hidden": False},
            {"id": "top", "part": ".", "dir": "top", "scale": 0.4, "at": [85, 85], "hidden": False}], "python": s2},
        {"title": "ULTRA TOP", "views": [
            {"id": "top", "part": "Ultra Top", "transform": DECK, "dir": "top", "scale": 0.5, "at": [130, 200], "hidden": False},
            {"id": "front", "part": "Ultra Top", "transform": DECK, "dir": "front", "scale": 0.5, "at": [130, 95]},
            {"id": "right", "part": "Ultra Top", "transform": DECK, "dir": "right", "scale": 0.5, "at": [300, 95]}], "python": s3},
        {"title": "ULTRA TOP UNDERSIDE", "views": [
            {"id": "bottom", "part": "Ultra Top", "transform": DECK, "dir": "bottom", "scale": 0.5, "at": [120, 195], "hidden": False},
            {"id": "secA", "part": "Ultra Top", "transform": DECK, "dir": "front", "scale": 1.0, "at": [120, 75], "hidden": False,
             "section": {"point": [0, 0, 0], "normal": [0, -1, 0]}},
            {"id": "secB", "part": "Ultra Top", "transform": DECK, "dir": "right", "scale": 0.75, "at": [305, 160], "hidden": False,
             "section": {"point": [28.17, 0, 0], "normal": [1, 0, 0]}}], "python": s4},
        {"title": "ULTRA LEG", "views": [
            {"id": "front", "part": "Ultra Leg", "dir": "front", "scale": 0.6, "at": [125, 170]},
            {"id": "right", "part": "Ultra Leg", "dir": "right", "scale": 0.6, "at": [262, 170]},
            {"id": "top", "part": "Ultra Leg", "dir": "top", "scale": 0.6, "at": [125, 262]},
            {"id": "bottom", "part": "Ultra Leg", "dir": "bottom", "scale": 0.6, "at": [125, 58]}], "python": s5},
        {"title": "ULTRA LEG SECTIONS", "views": [
            {"id": "secC", "part": "Ultra Leg", "dir": "front", "scale": 0.6, "at": [75, 150], "hidden": False,
             "section": {"point": [0, 0, 0], "normal": [0, -1, 0]}},
            {"id": "secE", "part": "Ultra Leg", "dir": "right", "scale": 0.6, "at": [190, 150], "hidden": False,
             "section": {"point": [23.97, 0, 0], "normal": [1, 0, 0]}},
            {"id": "secD", "part": "Ultra Leg", "dir": "top", "scale": 1.0, "at": [300, 255], "hidden": False,
             "section": {"point": [0, 0, 94.81], "normal": [0, 0, 1]}},
            {"id": "ref", "part": "Ultra Leg", "dir": "front", "scale": 0.35, "at": [270, 130], "hidden": False},
            {"id": "reftop", "part": "Ultra Leg", "dir": "top", "scale": 0.35, "at": [270, 195], "hidden": False}], "python": s6},
        {"title": "BUMPON", "views": [
            {"id": "top", "part": "BUMPON", "dir": "top", "scale": 1.0, "at": [150, 255], "hidden": False},
            {"id": "front", "part": "BUMPON", "dir": "front", "scale": 1.0, "at": [150, 215], "hidden": False}], "python": s8},
        {"title": "MAGNETS", "views": [
            {"id": "topmap", "part": "Ultra Top", "transform": DECK, "dir": "bottom", "scale": 0.4, "at": [115, 205], "hidden": False},
            {"id": "legmap", "part": "Ultra Leg", "dir": "front", "scale": 0.4, "at": [115, 80], "hidden": False}], "python": s7},
    ],
}
