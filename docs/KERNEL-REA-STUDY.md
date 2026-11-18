# Geometry-kernel study with REA

Evidence date: 2026-11-18. This study covers public/open-source artifacts and public vendor documentation. No commercial kernel binary or SDK was present, so no claim below comes from decompiling Parasolid, ACIS, CGM, ShapeManager, C3D, or D-Cubed.

## Targets and evidence

- **Manifold 3.5.1** (`elalish/manifold`, Apache-2.0): source at the acquired commit plus a locally built ELF and the published `manifold-3d` npm WASM.
  - REA authenticated `libmanifold.so.3.5.1` as SHA-256 `84ef8b2a78545f2678e33c8f814e50b91f819e4f61b1ce40c6f12299428f9640` and inventoried its symbols with caller-supplied GNU objdump.
  - REA authenticated `manifold.wasm` as SHA-256 `b172438703ef72dea983481a9a0328d43a9f09e224f6ab093e7bbc99f4372314`; caller-supplied WABT 1.0.42 validated it and recovered a complete import/export interface.
  - REA statically analyzed the shipped npm package: 52 files, 51 parsed JavaScript/TypeScript files, 2,227,895 text bytes. Inventory coverage was complete; semantic coverage was partial and is not treated as runtime proof.
- **Truck** (`ricosjp/truck`, Apache-2.0): public source. Its architecture separates geometry traits/NURBS, topology, meshing, modeling and shape operations into replaceable crates.
- **Fornjot** (`hannobraun/Fornjot`, 0BSD): public archived source. Useful principles—explicit tolerance values, validation at topology construction boundaries, actionable failures—but the project states its goals were not reached, so it is not a production-kernel reference.
- **Commercial public claims only**:
  - Parasolid advertises solid/facet/lattice/surface/sheet modeling, convergent modeling, tessellation, thread safety and topology-scale applications.
  - ACIS advertises validity testing, topology tracking/attributes, booleans/blends/direct editing/thickening/offsetting, thread safety and multi-threaded APIs.
  - C3D advertises an integrated modeler, solver, visualization, converter, mesh-to-B-rep and collision stack with thread-safe parallel operations.

## Patterns worth adopting

1. **Operation-local numerical frames.** Manifold's documented 2D Boolean translates inputs into a local frame, derives epsilon from operation scale and translates back. This separates model placement from numerical conditioning.
2. **Scale-aware tolerance, explicit at subsystem boundaries.** Manifold tracks an epsilon with each result; Truck and Fornjot centralize tolerance-aware comparisons/approximation rather than scattering unexplained constants.
3. **Validation before accepting rescue output.** Fornjot's stated contract is “work or return an actionable error.” ACIS publicly emphasizes model validity and healing. CADgang already follows this for fillet/shell rescues and should extend it consistently.
4. **Topology/provenance as first-class data.** Manifold preserves `originalID`, `meshID`, `faceID` and transforms through booleans. ACIS publicly advertises topology tracking and attached attributes. This supports stable material/face selection after edits.
5. **Hybrid exact/facet workflows.** Parasolid's convergent modeling and ACIS Polyhedra publicly describe B-rep/facet coexistence. Manifold is a strong mesh Boolean/repair oracle, but it cannot replace CADgang's exact STEP-preserving B-rep path.
6. **Modular kernel services.** Truck's small replaceable crates and C3D's distinct modeler/solver/collision/converter modules argue for narrow CADgang interfaces around exact modeling, meshing, constraints and collision rather than one monolith.

## Implemented first improvement

`brepBoolean` now keeps the existing OCCT result when it is spatially usable. If OCCT throws or returns a solid whose bounds cannot be evaluated, CADgang:

1. computes a shared operand frame from pre-operation bounds;
2. clones and translates all operands near the origin;
3. repeats the exact OCCT list Boolean;
4. requires finite bounds and a full OCCT geometry validity check;
5. translates the exact B-rep result back.

This is a rescue only, so normal booleans retain their old semantics and benchmark cost. It fixed observed failures at large placements:

- around `1e12`, a union could report valid topology but produce a void bounding box;
- around `1e14`, OCCT could throw `gp_Dir::SetX() - input vector has zero norm`;
- the local-frame result is one valid solid with the expected volume and finite bounds.

Legitimate subtract-all operations still return an empty result so the existing cell warning remains intact.

## Next experiments

- Add a differential mesh oracle using `manifold-3d` for booleans: compare watertightness, volume and connected components against OCCT, but never substitute a mesh result into exact STEP output.
- Attach operation provenance to CADgang faces/solids so query anchors can prefer inherited identities before geometric re-picking.
- Replace fixed tolerances with a documented policy: absolute floor + operation-scale relative term, with units and ownership named at every API boundary.
- Add invariant/property fuzzing: translation/rotation invariance, Boolean identities, result validity, deterministic topology signatures, STEP round-trip, and memory bounds.
- Isolate exact-kernel execution behind a recyclable worker; CADgang already measures residual OCCT WASM heap growth that garbage collection cannot recover.

## Commercial-target prerequisites

To extend this study to Parasolid, ACIS, CGM/ShapeManager, C3D or D-Cubed, place a lawfully obtained binary/SDK sample in the workspace and identify what you are authorized to analyze. REA 6.9.0 is installed at `~/.local/bin/rea`; deep native decompilation additionally needs a configured Ghidra 12.1+, Hopper, IDA, or Kuna provider. Inspection should focus on API boundaries, behavior and interoperability—not copying proprietary implementation code.
