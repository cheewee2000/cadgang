#include "importer.hpp"

#include <fstream>

Color::Color () :
    r (0),
    g (0),
    b (0)
{

}

Color::Color (double r, double g, double b) :
    r (r),
    g (g),
    b (b)
{

}

Face::Face ()
{

}

Face::~Face ()
{

}

Mesh::Mesh ()
{

}

Mesh::~Mesh ()
{

}

Node::Node ()
{

}

Node::~Node ()
{

}

ImportParams::ImportParams () :
    linearUnit (LinearUnit::Millimeter),
    linearDeflectionType (LinearDeflectionType::BoundingBoxRatio),
    linearDeflection (0.001),
    angularDeflection (0.5)
{

}

Importer::Importer ()
{

}

Importer::~Importer ()
{

}

Importer::Result Importer::LoadFile (const std::string& filePath, const ImportParams& params)
{
    std::ifstream inputStream (filePath, std::ios::binary);
    if (!inputStream.is_open ()) {
        return Importer::Result::FileNotFound;
    }

    // cadgang: sized once and read in one call, not grown a byte at a time through istreambuf_iterator
    inputStream.seekg (0, std::ios::end);
    std::vector<std::uint8_t> fileContent ((size_t) inputStream.tellg ());
    inputStream.seekg (0);
    inputStream.read ((char*) fileContent.data (), fileContent.size ());
    Importer::Result result = LoadFile (fileContent, params);
    inputStream.close ();
    return result;
}
