#include "importer-utils.hpp"

#include <TopExp_Explorer.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Face.hxx>
#include <BRepTools.hxx>
#include <BRep_Tool.hxx>

#include <Bnd_Box.hxx>
#include <BRepBndLib.hxx>
#include <BRepMesh_IncrementalMesh.hxx>
#include <UnitsMethods.hxx>

VectorBuffer::VectorBuffer (const std::vector<uint8_t>& v)
{
    setg ((char*) v.data (), (char*) v.data (), (char*) (v.data () + v.size ()));
}

OcctFace::OcctFace (const TopoDS_Face& face) :
    Face (),
    face (face),
    triangulation (),
    location ()
{
    triangulation = BRep_Tool::Triangulation (face, location);
    if (HasTriangulation ()) {
        triangulation->ComputeNormals ();
    }
}

bool OcctFace::HasNormals () const
{
    return HasTriangulation () && triangulation->HasNormals ();
}

bool OcctFace::GetColor (Color&) const
{
    return false;
}

void OcctFace::EnumerateVertices (const std::function<void (double, double, double)>& onVertex) const
{
    if (!HasTriangulation ()) {
        return;
    }

    gp_Trsf transformation = location.Transformation ();
    for (Standard_Integer nodeIndex = 1; nodeIndex <= triangulation->NbNodes (); nodeIndex++) {
        gp_Pnt vertex = triangulation->Node (nodeIndex);
        vertex.Transform (transformation);
        onVertex (vertex.X (), vertex.Y (), vertex.Z ());
    }
}

void OcctFace::EnumerateNormals (const std::function<void (double, double, double)>& onNormal) const
{
    if (!HasTriangulation () || !triangulation->HasNormals ()) {
        return;
    }

    bool isReversed = (face.Orientation () == TopAbs_REVERSED);
    gp_Trsf transformation = location.Transformation ();
    for (Standard_Integer nodeIndex = 1; nodeIndex <= triangulation->NbNodes (); nodeIndex++) {
        gp_Dir normal = triangulation->Normal (nodeIndex);
        normal.Transform (transformation);
        if (isReversed) {
            onNormal (-normal.X (), -normal.Y (), -normal.Z ());
        } else {
            onNormal (normal.X (), normal.Y (), normal.Z ());
        }
    }
}

void OcctFace::EnumerateTriangles (const std::function<void (int, int, int)>& onTriangle) const
{
    if (!HasTriangulation ()) {
        return;
    }

    bool isReversed = (face.Orientation () == TopAbs_REVERSED);
    for (Standard_Integer triangleIndex = 1; triangleIndex <= triangulation->NbTriangles (); triangleIndex++) {
        Poly_Triangle triangle = triangulation->Triangle (triangleIndex);
        if (isReversed) {
            onTriangle (triangle (1) - 1, triangle (3) - 1, triangle (2) - 1);
        } else {
            onTriangle (triangle (1) - 1, triangle (2) - 1, triangle (3) - 1);
        }
    }
}

bool OcctFace::HasTriangulation () const
{
    if (triangulation.IsNull () || triangulation->NbNodes () == 0 || triangulation->NbTriangles () == 0) {
        return false;
    }
    return true;
}

UnitsMethods_LengthUnit LinearUnitToLengthUnit (ImportParams::LinearUnit linearUnit)
{
    UnitsMethods_LengthUnit lengthUnit = UnitsMethods_LengthUnit_Millimeter;
    switch (linearUnit) {
        case ImportParams::LinearUnit::Millimeter:
            return UnitsMethods_LengthUnit_Millimeter;
        case ImportParams::LinearUnit::Centimeter:
            return  UnitsMethods_LengthUnit_Centimeter;
        case ImportParams::LinearUnit::Meter:
            return UnitsMethods_LengthUnit_Meter;
        case ImportParams::LinearUnit::Inch:
            return UnitsMethods_LengthUnit_Inch;
        case ImportParams::LinearUnit::Foot:
            return UnitsMethods_LengthUnit_Foot;
        default:
            return UnitsMethods_LengthUnit_Millimeter;
    }
}

bool TriangulateShape (TopoDS_Shape& shape, const ImportParams& params)
{
    Standard_Real linDeflection = params.linearDeflection;
    Standard_Real angDeflection = params.angularDeflection;

    if (params.linearDeflectionType == ImportParams::LinearDeflectionType::BoundingBoxRatio) {
        // cadgang: face by face, leaving out unbounded ones. One untrimmed face in a PCB export made
        // the box infinite and the deflection 1e97, which meshed every part at its coarsest.
        Bnd_Box boundingBox;
        for (TopExp_Explorer ex (shape, TopAbs_FACE); ex.More (); ex.Next ()) {
            Bnd_Box faceBox;
            BRepBndLib::Add (ex.Current (), faceBox, false);
            if (!faceBox.IsVoid () && !faceBox.IsOpen () && faceBox.SquareExtent () < 1e18) boundingBox.Add (faceBox);
        }
        if (boundingBox.IsVoid ()) {
            return false;
        }

        Standard_Real xMin, yMin, zMin, xMax, yMax, zMax;
        boundingBox.Get (xMin, yMin, zMin, xMax, yMax, zMax);
        Standard_Real avgSize = ((xMax - xMin) + (yMax - yMin) + (zMax - zMin)) / 3.0;
        linDeflection = avgSize * params.linearDeflection;
        if (linDeflection < Precision::Confusion ()) {
            // use 1mm in the current unit
            double mmToUnit = UnitsMethods::GetLengthUnitScale (
                UnitsMethods_LengthUnit_Millimeter,
                LinearUnitToLengthUnit (params.linearUnit)
            );
            linDeflection = 1.0 * mmToUnit;
        }
    }

    // cadgang: parallel, and a solid at a time, then shells outside solids, then loose faces. BRepMesh
    // keeps its working model of everything it is given until done: one call on a 21k-solid PCB
    // export peaked at 30 GB (even with every solid already meshed, it still built that model).
    for (TopExp_Explorer ex (shape, TopAbs_SOLID); ex.More (); ex.Next ()) {
        BRepMesh_IncrementalMesh (ex.Current (), linDeflection, Standard_False, angDeflection, Standard_True);
    }
    for (TopExp_Explorer ex (shape, TopAbs_SHELL, TopAbs_SOLID); ex.More (); ex.Next ()) {
        BRepMesh_IncrementalMesh (ex.Current (), linDeflection, Standard_False, angDeflection, Standard_True);
    }
    for (TopExp_Explorer ex (shape, TopAbs_FACE, TopAbs_SHELL); ex.More (); ex.Next ()) {
        BRepMesh_IncrementalMesh (ex.Current (), linDeflection, Standard_False, angDeflection, Standard_True);
    }
    return true;
}
