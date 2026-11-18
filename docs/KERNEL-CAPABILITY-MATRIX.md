# Geometry-kernel capability matrix and CADgang roadmap

Clean-room study, 2026-11-18. “Observed” means public source or an authenticated artifact inspected locally. “Published” means vendor documentation only. No proprietary implementation was copied or inferred beyond those public contracts.

## Evidence classes

| system | evidence available | limits |
|---|---|---|
| CADgang / Replicad / OCCT WASM | source plus shipped JS declarations/WASM; REA authenticated packages and static JS graphs | full OCCT WAT exceeded the configured 64 MiB decode budget; declarations and public OCCT API are authoritative for exposed contracts |
| Manifold | public source, built native ELF, shipped npm/WASM; REA hashes, symbols and WASM validation | mesh kernel, not an exact B-rep replacement |
| Truck | public Rust source | still evolving; fixed global base tolerance in current source |
| Fornjot | public Rust source | archived; project states goals were not reached |
| Parasolid | Siemens public documentation | no licensed binary/SDK supplied; implementation unknown |
| ACIS | Spatial public documentation | no licensed binary/SDK supplied; implementation unknown |
| CGM / ShapeManager-facing applications | Spatial/Autodesk public documentation | no licensed binary/SDK supplied; implementation unknown |
| C3D | C3D Labs public documentation | no licensed binary/SDK supplied; implementation unknown |
| D-Cubed / CDS | Siemens/Spatial public documentation | solver contracts only; implementation unknown |

## Capability matrix

| capability | CADgang now | observed/published reference | next move |
|---|---|---|---|
| Exact B-rep and STEP | OCCT B-rep, exact STEP import/export | Parasolid/ACIS/CGM/C3D publish exact modelers; Truck is NURBS B-rep | Keep OCCT; do not replace with mesh CSG |
| Boolean conditioning | OCCT list Boolean; new rescue-only local numerical frame | Manifold source documents local frames, operation-scale epsilon and deterministic tie rules | Done first; add invariant fuzzing |
| Boolean diagnostics | translated exceptions, validity checks; now honors `HasErrors`, counts warning-bearing results | OCCT exposes reports/errors/warnings; Fornjot validates construction; ACIS publishes validity/healing | Expose bounded warning/error families, not raw proprietary strings |
| Tolerance policy | many operation-local constants; no central contract | Manifold tracks epsilon per result; Truck centralizes `TOLERANCE=1e-6`; CGM publishes tolerant modeling | Introduce named absolute/relative policies by operation and unit scale |
| Topology provenance | geometric query anchors and shape keys; no kernel history | Manifold carries originalID/meshID/faceID; OCCT exposes Modified/Generated/Deleted and history; ACIS/C3D publish topology/history/attributes | Design persistent provenance IDs before enabling OCCT history |
| Hybrid exact + facets | one-way exact B-rep → field/mesh; mesh cannot return | Parasolid convergent modeling, ACIS Polyhedra, CGM Polyhedra, C3D B-Shaper; Manifold robust mesh CSG | Use Manifold as validator/fallback export lane, never silently replace exact results |
| Validation/healing | targeted imports/rescues, `BRepCheck_Analyzer` | OCCT ShapeFix; Truck healing; Fornjot structured validation; ACIS/CGM publish healing | Add structured `validate()` report and opt-in bounded healing policy |
| Direct editing/defeaturing | push/pull, draft, offset, query-driven features | Parasolid/ACIS/CGM publish direct editing; CGM publishes feature recognition/defeaturing | Build feature recognition from CADgang topology descriptors first |
| Constraint solver diagnostics | sketch solving exists; joints are direct transforms | D-Cubed/CDS publish DOF, redundancy/conflict, chirality, multiple solve modes and soft constraints | Add DOF/conflict explanation before adding more constraint types |
| Collision/clearance | exact common volume plus broadphase caches; mesh/BVH distances | D-Cubed CDM publishes incremental exact/facet collision, path prediction, depth/repositioning; C3D exact/mesh collision | Add incremental scene cache and time-of-impact/path queries |
| Parallelism/isolation | single OCCT WASM process with measured residual heap growth | commercial kernels publish thread safety; Truck is modular; Manifold supports parallel native execution | Recyclable worker pool before attempting WASM threading |
| Large assemblies | instancing/caches/progressive import work; exact checks memoized | CGM publishes delayed B-rep loading; D-Cubed publishes demand loading/instancing | Separate assembly graph from loaded geometry and schedule exact work lazily |
| Failure semantics | actionable `GraphError` translations and operation telemetry | Fornjot principle: work or actionable error; CDS publishes per-entity/per-constraint diagnostics | Standardize operation result diagnostics and recovery provenance |

## Direct findings from CADgang's shipped OCCT binding

The generated declarations expose capabilities that CADgang had not used in its Boolean wrapper:

- `HasErrors`, `HasWarnings`, and a report object;
- `SetFuzzyValue`, `SetUseOBB`, and parallel flags;
- `SetNonDestructive` and glue modes;
- `SetToFillHistory`, `Modified`, `Generated`, `IsDeleted`, and full history;
- result simplification whose history can be merged into operation history.

Changes made on this branch:

- check `HasErrors()` after Build so a failed operation cannot be accepted merely because `Shape()` returns a wrapper;
- disable unused topology history collection—the operands are already private clones and history had no consumer;
- count warning-bearing kernel results in bounded operation telemetry;
- retain the rescue-only operation-local frame introduced in PR #24.

`SetNonDestructive(true)` was tested and removed: CADgang already passes clones, and the option caused a measurable slowdown. Fuzzy tolerance is deliberately not enabled globally; hidden fuzz would change modeling semantics and could close intended gaps.

## Prioritized roadmap

### 1. Structured kernel diagnostics

Return an internal diagnostic object with operation, rescue path, warning/error family, validation outcome, scale and elapsed time. Keep user messages stable and bounded. This makes failures reproducible without exposing raw implementation internals.

### 2. Persistent topology provenance

Define application-owned IDs for source faces/edges and relations: inherited, split, generated, deleted. Then consume OCCT history for booleans and modifiers. Never expose wrapper addresses or topology indices as stable IDs.

### 3. Differential kernel oracle

For fuzz-generated closed meshes, compare OCCT tessellated output with Manifold on volume, components, watertightness and Boolean identities. A disagreement is a regression candidate, not proof that either kernel is correct. Exact B-rep output remains OCCT.

### 4. Tolerance contract

Centralize:

- document units (mm);
- absolute floor for geometric identity;
- relative term from operation scale;
- separate angular, modeling, meshing and UI-picking tolerances;
- explicit “fuzzy Boolean” only as an opt-in rescue with a reported value.

### 5. Constraint diagnostics

Before expanding sketch or assembly constraints, add:

- remaining degrees of freedom per entity/body;
- redundant and conflicting constraint sets;
- preferred-solution/chirality hints;
- update versus interactive move-under-constraints modes;
- soft constraints for preferences.

These are public product contracts across D-Cubed and CDS and can be implemented independently.

### 6. Kernel isolation

Move exact modeling into recyclable workers with bounded request counts/heap thresholds. Preserve deterministic shape serialization/cache keys across restarts. This addresses measured OCCT WASM allocator growth more safely than enabling unproven shared-memory threading.

## What requires licensed artifacts

A deeper behavioral comparison against Parasolid, ACIS, CGM/ShapeManager, C3D or D-Cubed requires a lawfully obtained evaluation or SDK and explicit authorization. Suitable clean-room tests would compare only observable behavior:

- Boolean/tolerance matrices and failure classifications;
- topology history contracts;
- constraint DOF/conflict reports;
- STEP round-trip and attribute preservation;
- performance/memory under a common generated corpus.

No proprietary pseudocode or copied implementation is needed for those tests.
