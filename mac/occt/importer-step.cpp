#include "importer-step.hpp"
#include "importer-utils.hpp"

#include <TDocStd_Document.hxx>
#include <STEPCAFControl_Reader.hxx>

#include <algorithm>
#include <string>

ImporterStep::ImporterStep () :
    ImporterXcaf ()
{

}

// faces in the STEP text: ADVANCED_FACE (exact) plus FACE_SURFACE (faceted)
static size_t CountFaces (const std::vector<std::uint8_t>& c)
{
    size_t n = 0;
    for (const std::string key : { "ADVANCED_FACE", "FACE_SURFACE" }) {
        for (auto it = c.begin (); (it = std::search (it, c.end (), key.begin (), key.end ())) != c.end (); it += key.size ()) n++;
    }
    return n;
}

bool ImporterStep::TransferToDocument (const std::vector<std::uint8_t>& fileContent)
{
    STEPCAFControl_Reader stepCafReader;
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

    if (!stepCafReader.Transfer (document)) {
        return false;
    }

    return true;
}
