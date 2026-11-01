#include "importer-iges.hpp"
#include "importer-utils.hpp"

#include <TDocStd_Document.hxx>
#include <IGESCAFControl_Reader.hxx>

#include <filesystem>
#include <fstream>
#include <unistd.h>

ImporterIges::ImporterIges () :
    ImporterXcaf ()
{

}

bool ImporterIges::TransferToDocument (const std::vector<std::uint8_t>& fileContent)
{
    // IGESCAFControl_Reader::ReadStream is not implemented, so the stream
    // should be written to a temporary file to import the content from.
    // cadgang: a unique path in the temp dir. "temp.igs" in the cwd failed wherever the cwd is not
    // writable (the app launched from Finder runs at /) and two IGES files opened at once clobbered each other.
    std::string dummyFileName = (std::filesystem::temp_directory_path () / ("cadgang-" + std::to_string (getpid ()) + ".igs")).string ();
    std::ofstream dummyFile;
    dummyFile.open (dummyFileName, std::ios::binary);
    dummyFile.write ((char*) fileContent.data (), fileContent.size ());
    dummyFile.close ();

    IGESCAFControl_Reader igesCafReader;
    igesCafReader.SetColorMode (true);
    igesCafReader.SetNameMode (true);

    IFSelect_ReturnStatus readStatus = igesCafReader.ReadFile (dummyFileName.c_str ());
    if (readStatus != IFSelect_RetDone) {
        std::remove (dummyFileName.c_str ());
        return false;
    }

    if (!igesCafReader.Transfer (document)) {
        std::remove (dummyFileName.c_str ());
        return false;
    }

    std::remove (dummyFileName.c_str ());
    return true;
}
