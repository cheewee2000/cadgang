// cadgang-occt: occt-import-js's importer (importer-*.cpp, unchanged but for parallel meshing)
// built natively. Replaces its js-interface.cpp: writes every mesh to stdout as little-endian
// binary that src/core/step.js reads back into the same shape ReadStepFile returns.
//   cadgang-occt <step|iges|brep> <file> <linearDeflection bbox ratio> <angularDeflection>
// Per mesh: u32 nameLen, name, u8 hasColor [f32 r g b], u32 nVerts, f32 pos[3n], u8 hasNormals
// [f32 nrm[3n]], u32 nTris, u32 idx[3t], u32 nFaces, (u32 first, i32 last)[nFaces]. Meshes end with u32 0xFFFFFFFF.
// Then the node tree js-interface.cpp returns as result.root (part names, which mesh sits in which part), depth first
// from the root: u32 nameLen, name, u32 nMeshes, u32 meshIndex[nMeshes], u32 nChildren, then each child the same way.
#include "importer-step.hpp"
#include "importer-iges.hpp"
#include "importer-brep.hpp"
#include <Message.hxx>
#include <Message_Messenger.hxx>
#include <Message_PrinterOStream.hxx>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>

template <typename T> static void put (std::vector<char>& b, T v) { b.insert (b.end (), (char*) &v, (char*) &v + sizeof v); }

// Meshes go to onMesh in js-interface's order (a node's own, then its children's); the tree goes into `tree`.
static void walk (const NodePtr& node, const std::function<void (const Mesh&)>& onMesh, std::vector<char>& tree, uint32_t& meshCount)
{
    std::string name = node->GetName ();
    put<uint32_t> (tree, name.size ()); tree.insert (tree.end (), name.begin (), name.end ());
    std::vector<uint32_t> own;
    if (node->IsMeshNode ()) node->EnumerateMeshes ([&](const Mesh& mesh) { onMesh (mesh); own.push_back (meshCount++); });
    put<uint32_t> (tree, own.size ()); for (uint32_t i : own) put<uint32_t> (tree, i);
    std::vector<NodePtr> children = node->GetChildren ();
    put<uint32_t> (tree, children.size ());
    for (const NodePtr& child : children) walk (child, onMesh, tree, meshCount);
}

int main (int argc, char** argv)
{
    if (argc < 5) { fprintf (stderr, "usage: cadgang-occt <step|iges|brep> <file> <linDefl> <angDefl>\n"); return 2; }
    // OCCT reports to stdout ("Total number of loaded entities 668." from the IGES reader, in colour); stdout is the
    // mesh stream, so every IGES import came back unreadable. Send the messenger to stderr.
    Message::DefaultMessenger ()->RemovePrinters (STANDARD_TYPE (Message_PrinterOStream));
    Message::DefaultMessenger ()->AddPrinter (new Message_PrinterOStream ("cerr", false));
    ImporterPtr importer;
    if (!strcmp (argv[1], "iges")) importer = std::make_shared<ImporterIges> ();
    else if (!strcmp (argv[1], "brep")) importer = std::make_shared<ImporterBrep> ();
    else importer = std::make_shared<ImporterStep> ();
    ImportParams params;
    params.linearDeflection = atof (argv[3]);
    params.angularDeflection = atof (argv[4]);
    Importer::Result r = importer->LoadFile (std::string (argv[2]), params);
    if (r != Importer::Result::Success) { fprintf (stderr, r == Importer::Result::FileNotFound ? "file not found\n" : "import failed\n"); return 1; }

    std::vector<char> b, tree;
    uint32_t meshCount = 0;
    std::vector<float> pos, nrm;
    std::vector<uint32_t> idx;
    std::vector<int32_t> faces;
    walk (importer->GetRootNode (), [&](const Mesh& mesh) {
        pos.clear (); nrm.clear (); idx.clear (); faces.clear ();
        mesh.EnumerateFaces ([&](const Face& face) {
            uint32_t vOff = pos.size () / 3;
            int32_t tFirst = idx.size () / 3;
            face.EnumerateVertices ([&](double x, double y, double z) { pos.push_back (x); pos.push_back (y); pos.push_back (z); });
            face.EnumerateNormals ([&](double x, double y, double z) { nrm.push_back (x); nrm.push_back (y); nrm.push_back (z); });
            face.EnumerateTriangles ([&](int a, int c, int d) { idx.push_back (vOff + a); idx.push_back (vOff + c); idx.push_back (vOff + d); });
            faces.push_back (tFirst); faces.push_back ((int32_t) (idx.size () / 3) - 1);
        });
        std::string name = mesh.GetName ();
        put<uint32_t> (b, name.size ()); b.insert (b.end (), name.begin (), name.end ());
        Color c;
        bool hasColor = mesh.GetColor (c);
        put<uint8_t> (b, hasColor);
        if (hasColor) { put<float> (b, c.r); put<float> (b, c.g); put<float> (b, c.b); }
        put<uint32_t> (b, pos.size () / 3); b.insert (b.end (), (char*) pos.data (), (char*) (pos.data () + pos.size ()));
        bool hasNormals = nrm.size () == pos.size ();
        put<uint8_t> (b, hasNormals);
        if (hasNormals) b.insert (b.end (), (char*) nrm.data (), (char*) (nrm.data () + nrm.size ()));
        put<uint32_t> (b, idx.size () / 3); b.insert (b.end (), (char*) idx.data (), (char*) (idx.data () + idx.size ()));
        put<uint32_t> (b, faces.size () / 2); b.insert (b.end (), (char*) faces.data (), (char*) (faces.data () + faces.size ()));
        fwrite (b.data (), 1, b.size (), stdout);
        b.clear ();
    }, tree, meshCount);
    put<uint32_t> (b, 0xFFFFFFFF);
    b.insert (b.end (), tree.begin (), tree.end ());
    fwrite (b.data (), 1, b.size (), stdout);
    return 0;
}
