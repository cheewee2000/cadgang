#!/usr/bin/env python3
"""stepdraw — fabrication drawings (PDF, A3 ISO sheet) from a STEP file + a JSON spec.

    python3 stepdraw.py spec.json out.pdf

Projection = OpenCascade hidden-line removal (OCP). Every number on the sheet is
measured from the STEP: linear dims from projected 3D points, diameters from the
cylindrical face nearest a probe point. See README.md for the spec format.
"""
import sys, json, math, hashlib, pickle, os, re, datetime, subprocess
from OCP.STEPCAFControl import STEPCAFControl_Reader
from OCP.TDocStd import TDocStd_Document
from OCP.TCollection import TCollection_ExtendedString
from OCP.XCAFDoc import XCAFDoc_DocumentTool
from OCP.TDF import TDF_Label
from OCP.collections import Sequence_TDF_Label
from OCP.TDataStd import TDataStd_Name
from OCP.IFSelect import IFSelect_RetDone
from OCP.TopExp import TopExp_Explorer
from OCP.TopAbs import TopAbs_SOLID, TopAbs_FACE, TopAbs_EDGE
from OCP.TopoDS import TopoDS, TopoDS_Compound, TopoDS_Shape
from OCP.BRep import BRep_Builder, BRep_Tool
from OCP.GProp import GProp_GProps
from OCP.BRepGProp import BRepGProp
from OCP.Bnd import Bnd_Box
from OCP.BRepBndLib import BRepBndLib
from OCP.BRepAdaptor import BRepAdaptor_Surface, BRepAdaptor_Curve
from OCP.GeomAbs import GeomAbs_Plane, GeomAbs_Cylinder
from OCP.TopLoc import TopLoc_Location
from OCP.gp import gp_Pnt, gp_Dir, gp_Ax1, gp_Ax2, gp_Trsf, gp_Vec, gp_Pln
from OCP.HLRBRep import HLRBRep_Algo, HLRBRep_HLRToShape
from OCP.HLRAlgo import HLRAlgo_Projector
from OCP.GCPnts import GCPnts_QuasiUniformDeflection
from OCP.BRepBuilderAPI import BRepBuilderAPI_Transform
from OCP.BRepPrimAPI import BRepPrimAPI_MakeHalfSpace, BRepPrimAPI_MakeBox
from OCP.BRepAlgoAPI import BRepAlgoAPI_Cut, BRepAlgoAPI_Common
from OCP.BRepMesh import BRepMesh_IncrementalMesh
from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeFace
from OCP.BRepClass3d import BRepClass3d_SolidClassifier
from OCP.TopAbs import TopAbs_IN
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A3, landscape

MM = 72 / 25.4

def identity():
    """Whose drawing this is: {"company", "author"} from ~/.config/cadgang/identity.json (or $CADGANG_IDENTITY).
    The author falls back to git's user.name; the company to nothing — never to somebody else's name."""
    f = os.environ.get("CADGANG_IDENTITY") or os.path.expanduser("~/.config/cadgang/identity.json")
    try: d = json.load(open(f))
    except Exception: d = {}
    if not d.get("author"):
        try: d["author"] = subprocess.run(["git", "config", "--global", "user.name"], capture_output=True, text=True).stdout.strip()
        except Exception: pass
    return {"company": str(d.get("company") or ""), "author": str(d.get("author") or "")}
CACHE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".cache")

# ---------------------------------------------------------------- STEP loading
def load_step(path):
    """-> list of (name, TopoDS_Solid) in assembly coordinates, names from the STEP tree."""
    doc = TDocStd_Document(TCollection_ExtendedString("d"))
    r = STEPCAFControl_Reader(); r.SetNameMode(True)
    assert r.ReadFile(path) == IFSelect_RetDone, path
    r.Transfer(doc)
    st = XCAFDoc_DocumentTool.ShapeTool_s(doc.Main())
    out = []
    def name(lbl):
        n = TDataStd_Name()
        return n.Get().ToExtString() if lbl.FindAttribute(TDataStd_Name.GetID_s(), n) else ""
    def walk(lbl, loc, path):
        nm = name(lbl)
        if st.IsReference_s(lbl):
            ref = TDF_Label(); st.GetReferredShape_s(lbl, ref)
            walk(ref, loc.Multiplied(st.GetLocation_s(lbl)), path + [nm]); return
        if st.IsAssembly_s(lbl):
            comps = Sequence_TDF_Label(); st.GetComponents_s(lbl, comps)
            for i in range(1, comps.Length() + 1): walk(comps.Value(i), loc, path + [nm])
        else:
            sh = st.GetShape_s(lbl).Moved(loc)
            ex = TopExp_Explorer(sh, TopAbs_SOLID)
            while ex.More():
                out.append(("/".join(path + [nm]), TopoDS.Solid(ex.Current()))); ex.Next()
    free = Sequence_TDF_Label(); st.GetFreeShapes(free)
    for i in range(1, free.Length() + 1): walk(free.Value(i), TopLoc_Location(), [])
    return out

def compound(shapes):
    c = TopoDS_Compound(); b = BRep_Builder(); b.MakeCompound(c)
    for s in shapes: b.Add(c, s)
    return c

def bbox(shape):
    b = Bnd_Box(); BRepBndLib.Add_s(shape, b, False)
    mn, mx = b.CornerMin(), b.CornerMax()
    return (mn.X(), mn.Y(), mn.Z(), mx.X(), mx.Y(), mx.Z())

def volume(shape):
    g = GProp_GProps(); BRepGProp.VolumeProperties_s(shape, g); return g.Mass()

def transform(shape, spec):
    """spec: {"rotate": [[ax,ay,az], deg], "translate": [x,y,z]} (rotate first, about origin)."""
    t = gp_Trsf()
    if spec and "rotate" in spec:
        ax, deg = spec["rotate"]
        t.SetRotation(gp_Ax1(gp_Pnt(0, 0, 0), gp_Dir(*ax)), math.radians(deg))
    if spec and "translate" in spec:
        t2 = gp_Trsf(); t2.SetTranslation(gp_Vec(*spec["translate"])); t = t2.Multiplied(t)
    return BRepBuilderAPI_Transform(shape, t, True).Shape(), t

def xform_pt(t, p):
    q = gp_Pnt(*p).Transformed(t); return (q.X(), q.Y(), q.Z())

# ---------------------------------------------------------------- views
VIEWS = {  # eye direction (toward viewer), x direction on paper
    "front":  ((0, -1, 0), (1, 0, 0)),
    "back":   ((0, 1, 0), (-1, 0, 0)),
    "top":    ((0, 0, 1), (1, 0, 0)),
    "bottom": ((0, 0, -1), (1, 0, 0)),
    "right":  ((1, 0, 0), (0, 1, 0)),
    "left":   ((-1, 0, 0), (0, -1, 0)),
    "iso":    ((1, -1, 1), (1, 1, 0)),
    "iso2":   ((-1, -1, 1), (1, -1, 0)),
}

def norm(v):
    l = math.sqrt(sum(x * x for x in v)); return tuple(x / l for x in v)

def cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])

def dot(a, b): return sum(x * y for x, y in zip(a, b))

class View:
    """One projection of a shape. Coordinates: model mm -> view mm (2D) -> paper mm."""
    def __init__(self, shape, name, scale, at, hidden=True, section=None, label=None, key="", clip=None):
        if clip:  # detail view: keep only what lies inside the box {"min": [x,y,z], "max": [x,y,z]}; `at` is its centre
            com = BRepAlgoAPI_Common(shape, BRepPrimAPI_MakeBox(gp_Pnt(*clip["min"]), gp_Pnt(*clip["max"])).Shape()); com.Build(); shape = com.Shape()
        self.shape, self.scale, self.at, self.hidden, self.label = shape, scale, at, hidden, label
        eye, xd = VIEWS[name] if isinstance(name, str) else name
        self.eye, self.x = norm(eye), norm(xd); self.y = cross(self.eye, self.x)
        self.section = section
        if section:  # keep the half of the model behind the plane (toward -eye), cut face hatched
            self.shape, self.cut_faces = cut_with_plane(shape, section)
        else:
            self.cut_faces = []
        self.key = key
        bb = bbox(shape); self.center3 = ((bb[0] + bb[3]) / 2, (bb[1] + bb[4]) / 2, (bb[2] + bb[5]) / 2)
        self.lines = cached(self.key + "|" + json.dumps([name, hidden, section] + ([clip] if clip else [])), lambda: hlr(self.shape, self.eye, self.x, hidden))

    def p2(self, p):  # 3D model point -> paper mm
        d = (p[0] - self.center3[0], p[1] - self.center3[1], p[2] - self.center3[2])
        return (self.at[0] + dot(d, self.x) * self.scale, self.at[1] + dot(d, self.y) * self.scale)

    def v2(self, p):  # view-plane (HLR) coords -> paper mm
        c = (dot(self.center3, self.x), dot(self.center3, self.y))
        return (self.at[0] + (p[0] - c[0]) * self.scale, self.at[1] + (p[1] - c[1]) * self.scale)

def cached(key, fn):
    os.makedirs(CACHE, exist_ok=True)
    f = os.path.join(CACHE, hashlib.md5(key.encode()).hexdigest() + ".pkl")
    if os.path.exists(f): return pickle.load(open(f, "rb"))
    v = fn(); pickle.dump(v, open(f, "wb")); return v

def hlr(shape, eye, xd, hidden):
    """-> {"v": [polyline...], "h": [polyline...]} in view-plane mm."""
    algo = HLRBRep_Algo(); algo.Add(shape)
    algo.Projector(HLRAlgo_Projector(gp_Ax2(gp_Pnt(0, 0, 0), gp_Dir(*eye), gp_Dir(*xd))))
    algo.Update(); algo.Hide()
    hs = HLRBRep_HLRToShape(algo)
    out = {"v": [], "h": []}
    for comp in (hs.VCompound(), hs.OutLineVCompound()):
        out["v"] += polylines(comp)
    if hidden:
        for comp in (hs.HCompound(), hs.OutLineHCompound()):
            out["h"] += polylines(comp)
    # HLR sometimes returns a garbage edge metres long (seen on filleted box corners): drop any
    # polyline that leaves the shape's own extent
    bb = bbox(shape); cen = ((bb[0] + bb[3]) / 2, (bb[1] + bb[4]) / 2, (bb[2] + bb[5]) / 2)
    r = math.dist(bb[:3], bb[3:]) / 2 + 1
    ex, ey = norm(xd), cross(norm(eye), norm(xd)); c2 = (dot(cen, ex), dot(cen, ey))
    for k in out:
        out[k] = [pl for pl in out[k] if all(math.dist(p, c2) <= r for p in pl)]
    return out

def polylines(comp, defl=0.02):
    res = []
    if comp.IsNull(): return res
    ex = TopExp_Explorer(comp, TopAbs_EDGE)
    while ex.More():
        e = TopoDS.Edge(ex.Current()); ex.Next()
        try:
            c = BRepAdaptor_Curve(e)
            d = GCPnts_QuasiUniformDeflection(c, defl)
            if d.IsDone() and d.NbPoints() >= 2:
                res.append([(d.Value(i).X(), d.Value(i).Y()) for i in range(1, d.NbPoints() + 1)])
        except Exception:
            pass
    return res

def cut_with_plane(shape, section):
    """section: {"point": [x,y,z], "normal": [nx,ny,nz]} -> remove the half on +normal side.
    Returns (cut shape, [triangles on the plane] as 3D point triples) for hatching."""
    p, n = section["point"], norm(section["normal"])
    big = 2000
    box = BRepPrimAPI_MakeBox(gp_Pnt(-big, -big, -big), gp_Pnt(big, big, big)).Shape()
    half = BRepPrimAPI_MakeHalfSpace(BRepBuilderAPI_MakeFace(gp_Pln(gp_Pnt(*p), gp_Dir(*n))).Face(),
                                     gp_Pnt(p[0] + n[0] * 10, p[1] + n[1] * 10, p[2] + n[2] * 10)).Solid()
    # cut solid by solid: one boolean over a many-body compound can silently leave a body uncut
    solids = []; ex = TopExp_Explorer(shape, TopAbs_SOLID)
    while ex.More(): solids.append(ex.Current()); ex.Next()
    pieces = []
    for sol in (solids or [shape]):
        cut = BRepAlgoAPI_Cut(sol, half); cut.Build(); pieces.append(cut.Shape())
    res = compound(pieces) if len(pieces) > 1 else pieces[0]
    tris = []
    ex = TopExp_Explorer(res, TopAbs_FACE)
    while ex.More():
        f = TopoDS.Face(ex.Current()); ex.Next()
        ad = BRepAdaptor_Surface(f)
        if ad.GetType() != GeomAbs_Plane: continue
        pl = ad.Plane(); fn = pl.Axis().Direction(); fn = (fn.X(), fn.Y(), fn.Z())
        if abs(abs(dot(fn, n)) - 1) > 1e-3: continue
        q = pl.Location(); q = (q.X(), q.Y(), q.Z())
        if abs(dot((q[0] - p[0], q[1] - p[1], q[2] - p[2]), n)) > 1e-3: continue
        BRepMesh_IncrementalMesh(f, 0.5)
        loc = TopLoc_Location(); tri = BRep_Tool.Triangulation_s(f, loc)
        if tri is None: continue
        tr = loc.Transformation()
        for i in range(1, tri.NbTriangles() + 1):
            a, b, c = tri.Triangle(i).Get()
            pts = []
            for k in (a, b, c):
                v = tri.Node(k).Transformed(tr); pts.append((v.X(), v.Y(), v.Z()))
            tris.append(pts)
    return res, tris

# ---------------------------------------------------------------- geometry queries (numbers come from the model)
def cylinders(shape):
    out = []
    ex = TopExp_Explorer(shape, TopAbs_FACE)
    while ex.More():
        f = TopoDS.Face(ex.Current()); ex.Next()
        ad = BRepAdaptor_Surface(f)
        if ad.GetType() == GeomAbs_Cylinder:
            cy = ad.Cylinder(); ax = cy.Axis()
            g = GProp_GProps(); BRepGProp.SurfaceProperties_s(f, g); c = g.CentreOfMass()
            out.append(dict(r=cy.Radius(), c=(c.X(), c.Y(), c.Z()),
                            axis=(ax.Direction().X(), ax.Direction().Y(), ax.Direction().Z()),
                            loc=(ax.Location().X(), ax.Location().Y(), ax.Location().Z()), bb=bbox(f)))
    return out

def planes(shape):
    """Planar faces: outward normal n, centroid c, area, bbox."""
    out = []
    ex = TopExp_Explorer(shape, TopAbs_FACE)
    while ex.More():
        f = TopoDS.Face(ex.Current()); ex.Next()
        ad = BRepAdaptor_Surface(f)
        if ad.GetType() == GeomAbs_Plane:
            pl = ad.Plane(); n = pl.Axis().Direction()
            if f.Orientation() == 1: n = n.Reversed()
            g = GProp_GProps(); BRepGProp.SurfaceProperties_s(f, g); c = g.CentreOfMass()
            out.append(dict(n=(n.X(), n.Y(), n.Z()), c=(c.X(), c.Y(), c.Z()), area=g.Mass(), bb=bbox(f)))
    return out

def nearest_cylinder(shape, p, rmax=None, rmin=None):
    """Cylindrical face whose centroid is nearest model point p (optionally filtered by radius)."""
    best = None
    for c in cylinders(shape):
        if rmax and c["r"] > rmax: continue
        if rmin and c["r"] < rmin: continue
        d = math.dist(c["c"], p)
        if best is None or d < best[0]: best = (d, c)
    return best[1]

def bore_depth(host, cyl):
    """Depth of a blind bore from its mouth face to its floor, measured in the host solid next to the
    bore wall (so a mouth chamfer does not shorten it). Returns (depth, floor_centre, mouth_dir)."""
    a = norm(cyl["axis"]); pl = planes(host)
    def axdist(c):
        d = (c[0] - cyl["loc"][0], c[1] - cyl["loc"][1], c[2] - cyl["loc"][2]); t = dot(d, a)
        return math.sqrt(max(dot(d, d) - t * t, 0))
    floors = [p for p in pl if abs(abs(dot(p["n"], a)) - 1) < 1e-3 and axdist(p["c"]) < cyl["r"]]
    floor = min(floors, key=lambda p: math.dist(p["c"], cyl["c"]))
    n = floor["n"]; depth = 0
    u = norm(cross(a, (1, 0, 0) if abs(a[0]) < 0.9 else (0, 1, 0))); v = cross(a, u)
    for k in range(8):
        ang = k * math.pi / 4; rr = cyl["r"] + 0.6
        off = (u[0] * math.cos(ang) * rr + v[0] * math.sin(ang) * rr, u[1] * math.cos(ang) * rr + v[1] * math.sin(ang) * rr, u[2] * math.cos(ang) * rr + v[2] * math.sin(ang) * rr)
        def inside(t):
            q = gp_Pnt(floor["c"][0] + off[0] + n[0] * t, floor["c"][1] + off[1] + n[1] * t, floor["c"][2] + off[2] + n[2] * t)
            return BRepClass3d_SolidClassifier(host, q, 1e-4).State() == TopAbs_IN
        if not inside(0.05): continue
        lo, hi, t = 0.05, 0.05, 0.05
        while t < 60 and inside(t): lo = t; t += 0.5
        hi = t
        for _ in range(12):  # bisect to ~0.0001
            m = (lo + hi) / 2
            if inside(m): lo = m
            else: hi = m
        depth = max(depth, (lo + hi) / 2)
    return round(depth, 3), floor["c"], n

# ---------------------------------------------------------------- sheet drawing (Fusion-style A3 ISO)
W, H = 420.0, 297.0
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
try:
    pdfmetrics.registerFont(TTFont("SpaceMono", os.path.join(os.path.dirname(os.path.abspath(__file__)), "fonts", "SpaceMono-Regular.ttf")))
    TB = "SpaceMono"   # title block font per CW&T style guide
except Exception:
    TB = "Courier"

class Sheet:
    def __init__(self, c, meta, n, total):
        self.c, self.meta, self.n, self.total = c, meta, n, total
        self._segs, self._texts = [], []   # for collisions(): every drawn segment, every annotation text box
    def mm(self, x, y): return (x * MM, y * MM)
    def line(self, a, b, w=0.35, dash=None):
        c = self.c; c.setLineWidth(w * MM); c.setDash(dash or []); self._segs.append((a, b))
        c.line(*self.mm(*a), *self.mm(*b)); c.setDash([])
    def poly(self, pts, w=0.35, dash=None):
        c = self.c; c.setLineWidth(w * MM); c.setDash(dash or [])
        p = c.beginPath(); p.moveTo(*self.mm(*pts[0])); self._segs += list(zip(pts, pts[1:]))
        for q in pts[1:]: p.lineTo(*self.mm(*q))
        c.drawPath(p, stroke=1, fill=0); c.setDash([])
    def text(self, x, y, s, size=3.5, font="Courier", align="left", angle=0, track=0):
        c = self.c; c.saveState(); c.setFont(font, size * MM); c.translate(*self.mm(x, y)); c.rotate(angle)
        {"left": c.drawString, "center": c.drawCentredString, "right": c.drawRightString}[align](0, 0, s, charSpace=track * size * MM)
        c.restoreState()
        w = self.tw(s, size, font); x0 = {"left": 0, "center": -w / 2, "right": -w}[align]
        ca, sa = math.cos(math.radians(angle)), math.sin(math.radians(angle))
        box = [(x + u * ca - v * sa, y + u * sa + v * ca) for u, v in ((x0, -0.3), (x0 + w, -0.3), (x0 + w, size * 0.75), (x0, size * 0.75))]
        self._texts.append((s, box))
    def collisions(self):
        """Annotation texts crossed by any drawn line (geometry, hatch, other dims). Returns [(text, n_segments)]."""
        def side(a, b, p): return (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])
        def inside(q, box): return all(side(box[i], box[(i + 1) % 4], q) >= 0 for i in range(4))
        def x(a, b, c, d): return side(a, b, c) * side(a, b, d) < 0 and side(c, d, a) * side(c, d, b) < 0
        out = []
        for s, box in self._texts:
            xs = [p[0] for p in box]; ys = [p[1] for p in box]
            n = 0
            for a, b in self._segs:
                if max(a[0], b[0]) < min(xs) or min(a[0], b[0]) > max(xs) or max(a[1], b[1]) < min(ys) or min(a[1], b[1]) > max(ys): continue
                if inside(a, box) or inside(b, box) or any(x(a, b, box[i], box[(i + 1) % 4]) for i in range(4)): n += 1; first = (a, b)
            if n: out.append((s, n, first))
        return out
    def tw(self, s, size=3.5, font="Courier"):
        return self.c.stringWidth(s, font, size * MM) / MM
    def frame(self):
        m = self.meta; who = identity()
        # zone border like Fusion's ISO A3 template
        self.c.setLineWidth(0.5 * MM); self.c.rect(*self.mm(10, 10), 400 * MM, 277 * MM)
        self.c.setLineWidth(0.25 * MM); self.c.rect(*self.mm(5, 5), 410 * MM, 287 * MM)
        for i in range(8):
            x = 10 + i * 50
            for y0, y1 in ((5, 10), (287, 292)):
                if i: self.line((x, y0), (x, y1), 0.25)
            self.text(x + 25, 6.5, str(i + 1), 2.5, align="center"); self.text(x + 25, 288.5, str(i + 1), 2.5, align="center")
        for i in range(6):
            y = 287 - i * 46.17
            for x0, x1 in ((5, 10), (410, 415)):
                if i: self.line((x0, y), (x1, y), 0.25)
            self.text(7.5, y - 24, "ABCDEF"[i], 2.5, align="center"); self.text(412.5, y - 24, "ABCDEF"[i], 2.5, align="center")
        # title block (180 x 45 mm) bottom right
        x0, y0 = 230, 10
        self.c.setLineWidth(0.35 * MM); self.c.rect(*self.mm(x0, y0), 180 * MM, 45 * MM)
        self.line((x0, y0 + 33), (x0 + 180, y0 + 33)); self.line((x0, y0 + 22), (x0 + 60, y0 + 22))
        self.line((x0 + 60, y0), (x0 + 60, y0 + 45)); self.line((x0 + 30, y0 + 33), (x0 + 30, y0 + 45))
        self.line((x0 + 125, y0), (x0 + 125, y0 + 45)); self.line((x0 + 60, y0 + 11), (x0 + 180, y0 + 11))
        self.line((x0 + 160, y0), (x0 + 160, y0 + 11))
        small = lambda x, y, s: self.text(x + 1.5, y - 3, s.upper(), 1.8, TB, track=0.06)
        val = lambda x, y, s, size=3, align="left": self.text(x + (1.5 if align == "left" else -1.5), y, s, size, TB, align)
        small(x0, y0 + 45, "Dept."); small(x0 + 30, y0 + 45, "Technical reference")
        small(x0 + 60, y0 + 45, "Created by"); small(x0 + 125, y0 + 45, "Approved by")
        small(x0 + 60, y0 + 33, "Document type"); small(x0 + 125, y0 + 33, "Document status")
        small(x0 + 60, y0 + 22, "Title"); small(x0 + 125, y0 + 22, "DWG No.")
        small(x0 + 60, y0 + 11, "Rev."); small(x0 + 125, y0 + 11, "Date of issue"); small(x0 + 160, y0 + 11, "Sheet")
        val(x0, y0 + 36, m.get("dept", who["company"])); val(x0 + 30, y0 + 36, m.get("ref", ""))
        mark = m.get("company", who["company"])   # wordmark, bottom-left cell, shrunk to fit 56 mm
        self.text(x0 + 30, y0 + 8, mark, min(9, 9 * 56 / max(self.tw(mark, 9, TB), 1)), TB, "center")
        val(x0 + 60, y0 + 36, m.get("author") or who["author"]); val(x0 + 125, y0 + 36, m.get("date", ""))
        dt = m.get("doctype", "") + (" - " + m["sheet_title"] if m.get("sheet_title") else "")
        val(x0 + 60, y0 + 25, dt, min(2.6, 2.6 * 62 / max(self.tw(dt, 2.6, TB), 1))); val(x0 + 125, y0 + 25, m.get("status", ""), 2.6)
        val(x0 + 60, y0 + 13.5, m.get("title", ""), 4.5); val(x0 + 125, y0 + 13.5, m.get("dwg", ""))
        val(x0 + 60, y0 + 3, m.get("rev", "")); val(x0 + 125, y0 + 3, m.get("issue", ""))
        self.text(x0 + 170, y0 + 3, f"{self.n}/{self.total}", 3, TB, "center")
    def view(self, v):
        for pl in v.lines["h"]: self.poly([v.v2(p) for p in pl], 0.18, [1.2 * MM, 0.8 * MM])
        for pl in v.lines["v"]: self.poly([v.v2(p) for p in pl], 0.35)
        # hatch section faces at 45 deg, 2 mm spacing (paper)
        for tri in v.cut_faces:
            pts = [v.p2(p) for p in tri]
            for seg in hatch_triangle(pts, 2.0): self.line(*seg, 0.18)
        if v.label:
            bb = view_bbox(v)
            self.text((bb[0] + bb[2]) / 2, bb[1] - 7, v.label, 3.5, align="center")
    # --- annotations (paper mm). Values are computed, never typed.
    def arrow(self, tip, frm, size=2.5):
        d = norm((tip[0] - frm[0], tip[1] - frm[1], 0)); n = (-d[1], d[0])
        p = self.c.beginPath(); p.moveTo(*self.mm(*tip))
        p.lineTo(*self.mm(tip[0] - d[0] * size + n[0] * size * 0.18, tip[1] - d[1] * size + n[1] * size * 0.18))
        p.lineTo(*self.mm(tip[0] - d[0] * size - n[0] * size * 0.18, tip[1] - d[1] * size - n[1] * size * 0.18))
        p.close(); self.c.drawPath(p, stroke=0, fill=1)
    def dim(self, a, b, offset, direction="auto", text=None, fmt="{:.1f}", prefix="", suffix="", ext=True, value=None, tside=1):
        """Linear dimension between paper points a, b. direction: 'h', 'v' or 'aligned'.
        offset: signed distance of the dimension line from the measured points. value: model mm.
        tside: when the text does not fit between the extension lines it goes past the +x/+y end (1) or the other end (-1)."""
        if direction == "auto": direction = "h" if abs(b[0] - a[0]) >= abs(b[1] - a[1]) else "v"
        if math.dist(a, b) < 0.05 or (direction == "h" and abs(b[0] - a[0]) < 0.05) or (direction == "v" and abs(b[1] - a[1]) < 0.05):
            import traceback; print(f"WARN zero-length dim {a} {b} {direction} value={value}", file=sys.stderr); traceback.print_stack(limit=3, file=sys.stderr); return
        if direction == "h":
            y = a[1] + offset; p, q = (a[0], y), (b[0], y)
            if ext: self.line(a, (a[0], y + (2 if offset > 0 else -2)), 0.18); self.line(b, (b[0], y + (2 if offset > 0 else -2)), 0.18)
        elif direction == "v":
            x = a[0] + offset; p, q = (x, a[1]), (x, b[1])
            if ext: self.line(a, (x + (2 if offset > 0 else -2), a[1]), 0.18); self.line(b, (x + (2 if offset > 0 else -2), b[1]), 0.18)
        else:
            d = norm((b[0] - a[0], b[1] - a[1], 0)); n = (-d[1] * offset, d[0] * offset)
            p, q = (a[0] + n[0], a[1] + n[1]), (b[0] + n[0], b[1] + n[1])
            if ext:
                e = norm((n[0], n[1], 0)); self.line(a, (p[0] + e[0] * 2, p[1] + e[1] * 2), 0.18); self.line(b, (q[0] + e[0] * 2, q[1] + e[1] * 2), 0.18)
        self.line(p, q, 0.18); self.arrow(p, q); self.arrow(q, p)
        if text is None: text = prefix + fmt.format(value) + suffix
        mid = ((p[0] + q[0]) / 2, (p[1] + q[1]) / 2)
        ang = math.degrees(math.atan2(q[1] - p[1], q[0] - p[0]))
        if ang > 90 or ang <= -90: ang += 180
        up = (-math.sin(math.radians(ang)), math.cos(math.radians(ang)))
        w = self.tw(text, 3.5)
        if w + 2 > math.dist(p, q):   # too short: put the text past the far end, beyond the extension line
            d = (math.cos(math.radians(ang)), math.sin(math.radians(ang))); far = q if ((q[0] - p[0]) * d[0] + (q[1] - p[1]) * d[1] > 0) == (tside > 0) else p
            mid = (far[0] + d[0] * tside * (w / 2 + 3), far[1] + d[1] * tside * (w / 2 + 3))
        self.text(mid[0] + up[0] * 1.2, mid[1] + up[1] * 1.2, text, 3.5, align="center", angle=ang)
    def dim3(self, v, p, q, offset, direction="auto", fmt="{:.1f}", prefix="", suffix="", text=None, tside=1):
        """Dimension between two MODEL points p, q seen in view v. Value = projected distance (model mm)."""
        a, b = v.p2(p), v.p2(q)
        if direction == "auto": direction = "h" if abs(b[0] - a[0]) >= abs(b[1] - a[1]) else "v"
        val = {"h": abs(b[0] - a[0]), "v": abs(b[1] - a[1])}.get(direction, math.dist(a, b)) / v.scale
        self.dim(a, b, offset, direction, text, fmt, prefix, suffix, value=val, tside=tside)
        return val
    def dia3(self, v, p, pos, extra="", fmt="{:.2f}", rmax=None, qty=None):
        """Diameter callout: nearest cylindrical face to model point p; leader from the circle's edge."""
        c = nearest_cylinder(v.shape, p, rmax)
        d = 2 * c["r"]
        tip = v.p2(c["c"]) if abs(dot(c["axis"], v.eye)) < 0.9 else v.p2((c["loc"][0] + v.x[0] * c["r"] * 0.7071 + v.y[0] * c["r"] * 0.7071,
                                                                           c["loc"][1] + v.x[1] * c["r"] * 0.7071 + v.y[1] * c["r"] * 0.7071,
                                                                           c["loc"][2] + v.x[2] * c["r"] * 0.7071 + v.y[2] * c["r"] * 0.7071))
        if abs(dot(c["axis"], v.eye)) >= 0.9:  # circle seen face-on: aim at the circle centre projected, tip on rim
            cc = v.p2(c["loc"]); r = c["r"] * v.scale
            dd = norm((pos[0] - cc[0], pos[1] - cc[1], 0)); tip = (cc[0] + dd[0] * r, cc[1] + dd[1] * r)
        txt = (f"{qty}x " if qty else "") + "\u00d8" + fmt.format(d) + extra
        self.leader(tip, txt, pos)
        return d
    def angle(self, vertex, a, b, r, value, fmt="{:.0f}\u00b0"):
        """Angular dimension at paper vertex between directions to a and b, arc radius r (paper mm)."""
        t0 = math.atan2(a[1] - vertex[1], a[0] - vertex[0]); t1 = math.atan2(b[1] - vertex[1], b[0] - vertex[0])
        if t1 < t0: t0, t1 = t1, t0
        if t1 - t0 > math.pi: t0, t1 = t1, t0 + 2 * math.pi
        pts = [(vertex[0] + r * math.cos(t0 + (t1 - t0) * i / 24), vertex[1] + r * math.sin(t0 + (t1 - t0) * i / 24)) for i in range(25)]
        self.poly(pts, 0.18); self.arrow(pts[0], pts[1]); self.arrow(pts[-1], pts[-2])
        self.line(vertex, (vertex[0] + (r + 3) * math.cos(t0), vertex[1] + (r + 3) * math.sin(t0)), 0.18)
        self.line(vertex, (vertex[0] + (r + 3) * math.cos(t1), vertex[1] + (r + 3) * math.sin(t1)), 0.18)
        tm = (t0 + t1) / 2
        self.text(vertex[0] + (r + 4) * math.cos(tm), vertex[1] + (r + 4) * math.sin(tm) - 1.2, fmt.format(value), 3.5, align="center")
    def cutline(self, a, b, label, side=1, arrows=True):
        """Section cutting-plane line on paper from a to b; arrows point to the viewing side (perpendicular, sign side)."""
        self.line(a, b, 0.5, [4 * MM, 1.5 * MM, 1 * MM, 1.5 * MM])
        d = norm((b[0] - a[0], b[1] - a[1], 0)); n = (-d[1] * side, d[0] * side)
        for p in (a, b):
            q = (p[0] + n[0] * 6, p[1] + n[1] * 6)
            self.line(p, q, 0.5); self.arrow(q, p)
            self.text(q[0] + n[0] * 3 - 1.2, q[1] + n[1] * 3 - 1.2, label, 3.5)
    def leader(self, tip, txt, pos, size=3.5, arrow=True, dot=False):
        """Leader from paper point tip to text at pos (text starts after a short shoulder)."""
        side = 1 if pos[0] >= tip[0] else -1
        elbow = (pos[0] - side * 1.5, pos[1] - 1.2)
        self.line(tip, elbow, 0.18)
        if arrow: self.arrow(tip, elbow)
        if dot: self.c.circle(*self.mm(*tip), 0.6 * MM, stroke=0, fill=1)
        lines = txt.split("\n")
        for i, s in enumerate(lines):
            y = pos[1] - i * (size + 1)
            if side > 0: self.text(pos[0], y, s, size)
            else: self.text(pos[0], y, s, size, align="right")
        wmax = max(self.tw(s, size) for s in lines)
        self.line(elbow, (elbow[0] + side * (wmax + 3), elbow[1]), 0.18)
    def balloon(self, tip, num, pos, r=4):
        d = norm((pos[0] - tip[0], pos[1] - tip[1], 0))
        edge = (pos[0] - d[0] * r, pos[1] - d[1] * r)
        self.line(tip, edge, 0.18); self.arrow(tip, edge)
        self.c.setLineWidth(0.35 * MM); self.c.circle(*self.mm(*pos), r * MM, stroke=1, fill=0)
        self.text(pos[0], pos[1] - 1.25, str(num), 3.5, align="center")
    def table(self, x, y, cols, rows, title=None, rowh=5):
        """x,y = top-left. cols = [(header, width)]."""
        wsum = sum(w for _, w in cols); cy = y
        if title:
            self.c.setLineWidth(0.35 * MM); self.c.rect(*self.mm(x, cy - rowh), wsum * MM, rowh * MM)
            self.text(x + wsum / 2, cy - rowh + 1.5, title, 3.5, align="center"); cy -= rowh
        def row(vals, cy, bold=False):
            h = rowh * max(len(str(v).split("\n")) for v in vals)
            self.c.rect(*self.mm(x, cy - h), wsum * MM, h * MM)
            cx = x
            for (hd, w), v in zip(cols, vals):
                self.line((cx, cy), (cx, cy - h), 0.35)
                for i, s in enumerate(str(v).split("\n")):
                    self.text(cx + 1.5, cy - rowh * (i + 1) + 1.5, s, 3)
                cx += w
            return cy - h
        cy = row([h for h, _ in cols], cy)
        for r in rows: cy = row(r, cy)
        return cy
    def note(self, x, y, lines, size=3):
        for i, s in enumerate(lines): self.text(x, y - i * (size + 1.5), s, size)
    def bullets(self, x, y, items, size=3, width=170, gap=2):
        """Wrapped bullet list with hanging indent. Returns y below the last line."""
        import textwrap
        cw = self.tw("M", size); n = int((width - 2 * size) / cw)
        for it in items:
            for i, ln in enumerate(textwrap.wrap(it, n)):
                self.text(x + (0 if i == 0 else 2 * size), y, ("- " if i == 0 else "") + ln, size)
                y -= size + 1.5
            y -= gap
        return y

def view_bbox(v):
    xs, ys = [], []
    for pl in v.lines["v"] + v.lines["h"]:
        for p in pl:
            q = v.v2(p); xs.append(q[0]); ys.append(q[1])
    return (min(xs), min(ys), max(xs), max(ys))

def hatch_triangle(pts, spacing):
    """45° hatch segments clipped to a 2D triangle (paper mm)."""
    segs = []
    k = [p[1] - p[0] for p in pts]  # line family y - x = const
    k0, k1 = min(k), max(k)
    c = math.floor(k0 / spacing) * spacing
    while c <= k1:
        xs = []
        for i in range(3):
            a, b = pts[i], pts[(i + 1) % 3]
            ka, kb = a[1] - a[0], b[1] - b[0]
            if (ka - c) * (kb - c) <= 0 and ka != kb:
                t = (c - ka) / (kb - ka); xs.append(a[0] + t * (b[0] - a[0]))
        if len(xs) >= 2:
            x0, x1 = min(xs), max(xs)
            if x1 - x0 > 0.05: segs.append(((x0, x0 + c), (x1, x1 + c)))
        c += spacing
    return segs

# ---------------------------------------------------------------- driver
def build(spec, out):
    parts = load_step(spec["step"])
    def pick(pattern):
        sel = [s for n, s in parts if re.search(pattern, n)]
        assert sel, f"no solid matches {pattern!r}; have {[n for n,_ in parts]}"
        return compound(sel) if len(sel) > 1 else sel[0]
    c = canvas.Canvas(out, pagesize=landscape(A3)); c.setTitle(spec["meta"]["title"])
    sheets = spec["sheets"]; ctx = {"parts": parts, "pick": pick, "spec": spec}
    for i, sh in enumerate(sheets):
        meta = dict(spec["meta"]); meta["sheet_title"] = sh.get("title", "")
        S = Sheet(c, meta, i + 1, len(sheets)); S.frame(); S._texts.clear(); S._segs.clear()
        views = {}
        for vs in sh.get("views", []):
            shape = pick(vs["part"])
            t = None
            if vs.get("transform"): shape, t = transform(shape, vs["transform"])
            v = View(shape, vs["dir"], vs.get("scale", 1), vs["at"], vs.get("hidden", True), vs.get("section"), vs.get("label"),
                     key=spec["step"] + str(os.path.getmtime(spec["step"])) + vs["part"] + json.dumps(vs.get("transform")), clip=vs.get("clip"))
            v.t = t; views[vs["id"]] = v; S.view(v)
        sh.get("draw", lambda S, V, ctx: None)(S, views, ctx) if callable(sh.get("draw")) else None
        if "python" in sh:  # per-sheet annotation code (spec is a .py that returns the spec dict)
            sh["python"](S, views, ctx)
        for txt, n, (a, b) in S.collisions():
            print(f"COLLISION sheet {i + 1}: {txt!r} crossed by {n} line(s), e.g. ({a[0]:.1f},{a[1]:.1f})-({b[0]:.1f},{b[1]:.1f})", file=sys.stderr)
        c.showPage()
    c.save()
    return out

if __name__ == "__main__":
    specf, out = sys.argv[1], sys.argv[2]
    ns = {"__file__": os.path.abspath(specf)}
    exec(open(specf).read(), ns)
    build(ns["SPEC"], out)
    print("wrote", out)
