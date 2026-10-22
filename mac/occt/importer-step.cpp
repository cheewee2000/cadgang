#include "importer-step.hpp"
#include "importer-utils.hpp"

#include <TDocStd_Document.hxx>
#include <STEPCAFControl_Reader.hxx>

ImporterStep::ImporterStep () :
    ImporterXcaf ()
{

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
    // cadgang: no shape healing on big files. It is single-threaded ShapeFix on every solid, ~90% of
    // the read of a PCB export (300 s of a 150 MB file's 330), and a viewer can do without it.
    // Only DirectFaces (cheap) is kept. Must follow ReadStream: the reader has no actor to hold the flags before it.
    if (fileContent.size () > 50 * 1024 * 1024) { ShapeProcess::OperationsFlags f; f.set (ShapeProcess::DirectFaces); stepReader.SetShapeProcessFlags (f); }

    if (!stepCafReader.Transfer (document)) {
        return false;
    }

    return true;
}
