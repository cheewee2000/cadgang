#include "importer-step.hpp"
#include "importer-utils.hpp"

#include <TDocStd_Document.hxx>
#include <STEPCAFControl_Reader.hxx>
#include <Interface_Static.hxx>

#include <cstring>
#include <string>

ImporterStep::ImporterStep () :
    ImporterXcaf ()
{

}

// faces in the STEP text: ADVANCED_FACE (exact) plus FACE_SURFACE (faceted)
// cadgang: one memmem pass (ADVANCED_FACE and FACE_SURFACE share "FACE"), not a std::search per key over the whole file
static size_t CountFaces (const std::vector<std::uint8_t>& c)
{
    size_t n = 0;
    const char* p = (const char*) c.data ();
    const char* end = p + c.size ();
    while (const char* f = (const char*) memmem (p, end - p, "FACE", 4)) {
        if (f - (const char*) c.data () >= 9 && !memcmp (f - 9, "ADVANCED_", 9)) n++;
        else if (end - f >= 12 && !memcmp (f, "FACE_SURFACE", 12)) n++;
        p = f + 4;
    }
    return n;
}

bool ImporterStep::TransferToDocument (const std::vector<std::uint8_t>& fileContent)
{
    // cadgang: the reader is never freed. Its destructor takes 0.58 s on SGV3_hd, single-threaded, and the CLI _exits after one
    // import. Keeping its model resident through meshing adds ~0.4 GB to that file's peak (5.2 GB, against 8.4 GB before the sized read).
    STEPCAFControl_Reader& stepCafReader = *new STEPCAFControl_Reader;
    stepCafReader.SetColorMode (true);
    stepCafReader.SetNameMode (true);

    STEPControl_Reader& stepReader = stepCafReader.ChangeReader ();
    std::string dummyFileName = "stp";
    VectorBuffer inputBuffer (fileContent);
    std::istream inputStream (&inputBuffer);
    IFSelect_ReturnStatus readStatus = stepReader.ReadStream (dummyFileName.c_str (), inputStream);
    if (readStatus != IFSelect_RetDone) {
        return false;
    }
    // cadgang: no shape healing on files of more than 100k faces. It is single-threaded ShapeFix, scaling with faces, ~90% of
    // the read of a big export (300 s of Super_Pager's 330: 150 MB, 499k faces). Counted in faces, not bytes: a 68 MB file
    // of 12k faces lost it to a 50 MB cut and its PEM studs' and nuts' cylinder walls (closed faces whose 2D wire the
    // healing fixes) came in unmeshed. Only DirectFaces (cheap) is kept. Must follow ReadStream: the reader has no actor to hold the flags before it.
    if (CountFaces (fileContent) > 100000) { ShapeProcess::OperationsFlags f; f.set (ShapeProcess::DirectFaces); stepReader.SetShapeProcessFlags (f); }
    // cadgang: an angle of 0 makes the transfer skip BRepLib::EncodeRegularity, a single-threaded pass over every edge that
    // only sets edge continuity flags. Nothing here reads them (BRepMesh doesn't), so the mesh is the same. Process-wide static: one import per run.
    Interface_Static::SetRVal ("read.encoderegularity.angle", 0.0);

    if (!stepCafReader.Transfer (document)) {
        return false;
    }

    return true;
}
