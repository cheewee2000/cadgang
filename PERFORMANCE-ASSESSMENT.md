# CADgang performance and complex-assembly assessment

Assessment of `main` at `8e9d7ee` (`v0.14.130`).

## What the project actually contains

CADgang currently has two performance domains:

1. **Prompt-authored exact geometry** — JavaScript cells call a curated Replicad/OpenCascade-WASM B-rep API. Cell results are incrementally cached and later tessellated/exported.
2. **CAD viewer and assembly interaction** — STEP/IGES/BREP import, tessellation, body hierarchy, picking, explode solving, joints, sectioning, measurement, and Three.js rendering.

These need separate benchmarks. A change that improves import or rendering does not necessarily improve Boolean/rebuild speed.

## Baseline observed in this workspace

- `npm ci`: successful.
- `npm test`: **185/185 passed**.
- Test run: **53.766 s elapsed**, 58.281 s user CPU, 3.029 s system CPU.
- Slow test examples:
  - loft with corners plus shell fallback: ~11.3 s
  - guided sweep: ~6.1 s
  - helical thread: ~2.1 s
- The optional native macOS importer was absent here, so import tests used OpenCascade WASM.

This is a correctness baseline, not yet a representative product benchmark.

## Existing strengths

- `src/core/cells.js` already caches compiled programs and B-rep results using content/dependency keys. Editing one cell re-runs only that cell and its dependants.
- Shape allocation scopes and delayed OCCT collection in `src/core/brep.js` address otherwise unbounded WASM heap growth.
- STEP import runs in a worker so a large import does not block the server event loop.
- A native macOS OCCT importer already supports parallel, per-solid meshing and avoids the WASM 32-bit heap ceiling.
- Picking uses per-body `three-mesh-bvh` acceleration.
- STEP tessellation is sent to the browser in a typed binary format rather than JSON.
- Assembly paths and repeated bodies are visible in the UI.

## Highest-leverage work

### P0 — Build a real benchmark and telemetry layer

Before kernel changes, add a benchmark runner that writes machine-readable JSON for:

- cold/warm cell evaluation
- Boolean, fillet, shell, loft, sweep, thread and pattern operations
- tessellation and STEP export
- STEP read, XCAF transfer, meshing, welding, packing and browser construction
- peak RSS/WASM heap, bodies, faces, vertices and triangles
- viewer time-to-first-frame and interaction frame time
- explode solve and BVH-build time

Use generated fixtures plus several representative real assemblies. Store medians and p95 over repeated runs and enforce regression budgets in CI.

### P1 — Preserve assembly instancing instead of flattening every occurrence

The native importer and `step.js` currently produce a separate triangle range/body for each imported mesh occurrence. STEP product structure is recovered mostly as names/paths; repeated components are not represented as one shared geometry plus transforms.

For assemblies containing many repeated fasteners, electronic components, or patterned parts, preserving XCAF definitions and occurrence transforms should reduce:

- import and meshing work
- transferred bytes
- browser memory
- WebGL geometry and BVH duplication
- body construction time

Target representation:

- geometry definitions keyed by stable definition ID
- instances with transform, occurrence ID, path, color/material override
- `THREE.InstancedMesh` or batched rendering where compatible
- picking that returns the occurrence, not only the shared definition

This is likely the largest structural improvement for genuinely complex assemblies.

### P1 — Stop converting large typed arrays to ordinary JavaScript arrays

`src/core/step.js` allocates typed arrays, welds them, and then returns `Array.from(...)` for positions, normals and indices. `src/server/view.js::pack` converts those values back with `Float32Array.from` and `Uint32Array.from`.

For large models this creates redundant full-size copies, increases GC pressure, and temporarily multiplies memory use. Keep typed arrays end-to-end through worker transfer and binary packing. Transfer their `ArrayBuffer`s rather than structured-cloning ordinary arrays.

This is a contained optimization with a clear benchmark and relatively low semantic risk.

### P1 — Make import streaming/progressive

The native helper currently buffers all data for a mesh before writing it, while Node waits for the complete child-process `stdout`; the viewer receives the packed result only after every body is complete.

A progressive protocol could send:

1. assembly/product metadata,
2. body definitions or instances as they are ready,
3. coarse tessellation first,
4. refined tessellation afterward.

That improves time-to-first-frame even when total import time changes little. It also allows cancellation and progress based on completed bodies rather than a time estimate.

### P1 — Redesign the explode solver broad phase

`web/explode.js` contains several whole-assembly scans and pairwise body comparisons. BVHs accelerate triangle intersection, but body candidate selection remains approximately quadratic in many phases. The source already disables automatic solving above 300k triangles; body count can be equally important.

Add a top-level body AABB BVH or spatial hash and query only bodies intersecting a swept AABB/capsule. Precompute:

- body index maps instead of repeated `bodies.indexOf(...)`
- parent/descendant sets
- candidate larger/touching bodies
- transformed bounds

Move solving to a Web Worker so interaction remains responsive. This should be benchmarked by both body count and triangle count.

### P2 — Add explicit assembly LOD and interaction budgets

Current large-model behavior has cutoffs (for example edge and explode work), but not a coherent LOD system. Add:

- coarse tessellation while orbiting; refine when idle
- screen-space triangle/edge budgets
- frustum and optional occlusion culling
- edge generation only for visible/significant bodies
- deferred BVH construction only for bodies likely to be picked
- lightweight tree virtualization for thousands of body rows

Measure p95 frame time during orbit, selection, section movement and explode movement.

### P2 — Put byte limits on B-rep caches

`src/core/cells.js` limits result cache entries by count (`48`), not estimated memory. A single complex shape can dwarf dozens of primitives. Track approximate triangulation/shape cost where possible and evict by a configurable byte budget plus LRU. Report hit rate, evictions and rebuild cost.

### P2 — Profile exact-kernel fallbacks before rewriting operations

The current suite shows shell/loft fallback and guided sweep dominating several tests. Instrument every high-level B-rep operation with:

- primary path vs fallback path
- OCCT call duration
- input/output topology counts
- validity result
- exception category

Then optimize the operations that dominate real models. Potential work includes avoiding repeated topology enumeration, batching compatible transforms/patterns, and reducing unnecessary clones. Do not trade robustness for benchmark speed without differential geometry checks.

## Suggested implementation sequence

1. Add `bench/` runner and JSON schema.
2. Add generated fixtures varying bodies, repeated instances, faces and triangles.
3. Preserve typed arrays through STEP worker → packer; measure time and peak RSS.
4. Instrument import phases and cell B-rep operations.
5. Preserve XCAF definitions/instances in the native importer and wire one repeated-part fixture through rendering and picking.
6. Add assembly broad-phase index and move explode solving to a worker.
7. Introduce progressive import/LOD.
8. Use measured profiles to choose exact-kernel algorithm changes.

## Inputs needed for a useful optimization target

- Three assemblies: typical, difficult, and aspirational maximum.
- Expected upper bounds for bodies, unique parts, faces, triangles and file size.
- The top three slow user actions: opening, first frame, orbiting, selecting, explode, Boolean rebuild, STEP export, etc.
- Minimum supported Mac hardware and acceptable memory ceiling.
- Whether repeated-part-heavy assemblies (fasteners/PCB components) are representative.
- Whether the priority is the current viewer, the cell authoring kernel, or both.

## Immediate candidate PR

The safest first optimization PR is: **retain typed arrays across the STEP worker and packer, add import phase timings, and add a generated repeated-assembly benchmark**. It produces actionable measurements and should reduce copies and peak memory without changing CAD semantics.
