# cadgang v2 — prompt-first, AI-native

A rethink of the authoring model. The geometry kernel survives intact; the layer
above it is replaced.

## The change in one paragraph

Today a document is a DAG of typed blocks with numeric params, and the block
vocabulary is the ceiling — no `brep_loft` type means no loft. In v2 a document
is an ordered stack of **cells**. A cell holds a natural-language prompt, the
geometry program that prompt compiled to, the parameters that program exposes,
and any viewport selections or sketches it depends on. The prompt is the source;
the compiled program is a **lockfile**. Geometry never regenerates from the
prompt on its own — only when the prompt is edited or a recompile is explicitly
requested. That is what keeps a prompt-authored model from silently becoming a
different part between two openings of the same file.

## Cell

```jsonc
{
  "id": "body",
  "prompt": "60×40×24 enclosure, 3mm fillet on the vertical edges, 2mm wall open at top",
  "refs": [],                    // other cells this one consumes; default = previous
  "selections": {},              // user picks, stored as queries + anchors
  "sketch": null,                // constrained 2D profile, if this is a sketch cell
  "params": { "w": 60, "d": 40, "h": 24, "r": 3, "wall": 2 },
  "code": "…",                   // the committed program
  "compiledBy": "claude-opus-5", // provenance
  "compiledAt": "2026-08-03T…",
  "status": "ok"                 // ok | stale | diverged | awaiting_pick
}
```

`status` records where the cell stands relative to its own prompt: `stale` means
the prompt was edited past the code, `diverged` means the code was hand-edited
past the prompt. Evaluation failure is deliberately *not* a status — a cell that
throws is reported by the evaluator, not written back into the document, because
persisting it would turn every viewport render of a broken model into a document
write and fill undo with states the user never authored.

Cells are ordered, not a free DAG. Natural language leans on a running current
solid ("subtract that from the body"), so each cell's default input is the
previous cell's result, with explicit `@name` references available when the flow
branches. The dependency DAG still exists and is still drawn — it's derived from
`refs` rather than authored.

## Compiled programs

Cells compile to sandboxed JavaScript against a curated kernel API, with
parameters hoisted to the top so direct manipulation survives:

```js
export const params = { w: 60, d: 40, h: 24, r: 3, wall: 2 };

export default ({ p, brep, q }) => {
  let s = brep.box(p.w, p.d, p.h, { center: 'xy' });
  s = brep.fillet(s, q.edges(s).linear().along('z'), p.r);
  return brep.shell(s, q.faces(s).top(), p.wall);
};
```

`params` is the ergonomic core: the model writes structure once, the human drives
numbers forever. Changing `w` re-runs the program; it does not re-prompt.

Programs run in a fresh `vm` realm with no filesystem, network, or timer access
and a wall-clock budget. It is a guardrail against mistakes — an infinite loop, a
stray file write — not a security boundary: the kernel functions passed in come
from the host realm, and code written to escape through them will. That is the
right trade while the OCCT instance lives in the main process, since shapes are
not transferable and a worker would need a kernel of its own. If cell code ever
comes from somewhere other than the user's own Claude Code session, this has to
become a worker. The code is stored in the document in plain
text, shown in the UI, and hand-editable — a hand edit simply marks the cell as
diverged from its prompt.

## The query layer — the load-bearing subsystem

An LLM cannot see the model, so it can never say "edge 7." It says "the linear
edges running along Z," and that expression has to resolve against the actual
B-rep.

`q` filters faces and edges by intrinsic properties: surface/curve kind (plane,
cylinder, line, circle), orientation, area, length, centroid, bounding box,
adjacency, and lineage — which operation created the entity. Queries are
composable and chainable, and they re-resolve on every evaluation.

Two properties fall out of this:

- **Parameter changes don't break references.** `q.edges(s).linear().along('z')`
  still means the same four edges after `w` goes from 60 to 80. Index-based
  selection does not. This is the standard persistent-naming problem and a query
  layer is the standard answer.
- **The model can verify its own selection.** A query returns a count and a
  summary before it's used, so Claude confirms it caught 4 edges and not 12
  rather than filleting blind.

Queries that resolve to an unexpected count fail the cell loudly instead of
producing quietly wrong geometry.

## Topology introspection

Because the compiler is Claude Code over MCP and has no vision, introspection
replaces seeing. A new MCP call returns the full topology of any cell's result:

- **faces** — id, surface kind, area, centroid, normal, bbox, adjacent edge ids,
  creating operation
- **edges** — id, curve kind, length, midpoint, direction, adjacent face ids,
  creating operation

The authoring loop becomes: build → introspect → write a query → check the
count → apply the operation → render → assert. Existing `render_preview`,
`eval_sdf`, and `mesh_stats` stop being inspection conveniences and become steps
in that loop.

## Selections and the pick loop

Some references genuinely require a human: "fillet *that* edge." A cell declares
what it needs, and the flow is:

1. Cell declares `selections: { lip: 'edge' }` and enters `awaiting_pick`.
2. The web UI highlights the cell and drops into pick mode.
3. The user clicks geometry in the viewport.
4. The pick is stored as **a resolved query plus an anchor** — centroid, normal,
   length/area, adjacency hash — never as a raw index.
5. On every later evaluation the query re-resolves and the anchor is checked. If
   the match drifts past tolerance, the cell goes `awaiting_pick` and asks for a
   re-pick rather than operating on the wrong entity.

The anchor matches in **unit space** — the entity's centre as a fraction of the
shape's own bounding box — so the top rim of an 80mm box is still the top rim at
120mm, where an absolute centroid would be 20mm adrift. Kind must match exactly;
heading corroborates; size is weighted down to 0.15 because normalising a length
against the part diagonal still punishes an aspect-ratio change, and measurement
showed the full-weight term losing picks it should have held.

Two refusals, and they matter more than the matching: a best match beyond
tolerance means the pick describes nothing on this shape, and a best match within
0.015 of the runner-up means it is genuinely ambiguous. Both ask the human again.

Known limit: if a parameter slides an array of identical features along by
exactly one pitch, the neighbour lands on the anchor and is returned
confidently. No cost ranking can see that — the geometry does not record which
hole was meant — so the mitigation is the transcript showing what each pick
resolved to.

Claude issues the pick request over MCP and long-polls for the result, so a
modeling session can interleave machine authoring with human disambiguation
without either side blocking permanently.

## Sketch cells

A sketch cell holds a plane, a set of 2D entities, and a set of constraints.
Claude authors entities and constraints from a prompt ("60×40 rectangle, 20mm
hole centered 15mm from the left edge"); the user draws and drags in a canvas
and the solver holds the constraints. Dimension values may reference cell
`params`, so sketches are parametric like everything else.

Drawing is the one place the human authors geometry rather than describing it,
and what a gesture MEANS is inferred on the server, next to the solver, rather
than in the browser. Two rules decide everything about it. A click that lands
on an existing point reuses that point instead of adding a coincident pair, so
a corner two lines share is one corner and cannot be dragged apart. And every
constraint the gesture implies — a near-level line becoming horizontal, a point
landing on a circle becoming point-on — is provisional: if the sketch stops
solving with it in, the guess is dropped and the geometry is kept, because the
person asked for the line and we are the ones who asked for the horizontal. The
only failure a draw refuses outright is one it cannot back out of, which is an
entity's own definition failing on pinned points.

The solver is ours: Levenberg–Marquardt over constraint residuals, covering
coincident, horizontal, vertical, distance, radius, tangent, equal, parallel,
perpendicular, and point-on-entity. AI-authored sketches are small and
well-conditioned, and owning the solver means over-constrained and
under-constrained cases produce error messages we can hand straight back to the
model. Degrees of freedom are reported so the UI can show what's still floating.

Output is a closed profile consumable by extrude, revolve, and sweep.

Two properties of the solver as built are worth stating, because both are
choices and not accidents. Tangency has two answers — the curve on either side
of the line — and the one that is kept is the side the sketch was already on,
so a drag cannot turn the geometry inside out on its way to a technically valid
solution. And the reported degrees of freedom come from the rank of the
Jacobian at the answer, which is honest everywhere except at a tangency, where
the system is genuinely rank-deficient and the count reads one higher than a
person would say. That is a property of tangency, not a bug to tune away.

## Assertion cells

A model authored by a machine needs machine-checkable intent, or the user is
trusting generated code on faith. Assertion cells are first class:

- minimum wall thickness across the whole body
- clearance between two named faces
- volume, mass, or bounding-box limits
- watertightness and self-intersection

They evaluate on every recompile and on every parameter change, and they fail
the document, not just a cell. During authoring they close the loop: Claude
compiles, renders, checks assertions, and iterates until they pass.

As built, three decisions give "fails the document" its teeth.

An assertion cell is **transparent to the stack**: it passes its input through
and is skipped when the cell below it works out what "the previous result"
means. A check that redirected the model would not be a check.

It runs **even when nothing consumes it**. The ordinary rule is that a branch
the output does not use is not evaluated, and a check is by nature consumed by
nothing — so assertion cells at or before the target are always in the
evaluation order, dragging their own dependencies with them.

And the refusal lands **at export, not at render**. A document with a failing
assertion still builds, still measures, still answers topology questions,
because looking at the part is how anyone fixes a wall that is too thin. What it
does not do is leave the building: STEP export refuses. The escape hatch is
deleting the assertion cell — an edit the document records — rather than a flag
on a URL, which it would not.

Every claim MEASURES and records the number whether it passes or fails, so the
transcript reads "min wall 1.99 mm vs 2.5" rather than showing a red tick. A
passing assertion that left nothing behind would be indistinguishable from an
assertion nobody wrote.

Self-intersection is the one item on the list above that is NOT implemented. A
real check needs a boolean-operation validity pass; a cheap one would pass on
everything, and a check that cannot fail is worse than no check, because it
reads as coverage.

## What survives

The entire kernel. `brep.js`, `sdf.js`, `mesher.js`, `step.js`, `stl.js`,
`render.js`, `mesh.js`, `expr.js`, the two-lineage rule and its one-way bridge,
undo, autosave, and the save/load format all stay. What is removed is
`NODE_TYPES` as the ceiling on expressiveness and the node-graph editor as the
primary authoring surface — the graph remains as a derived, read-only view of
cell dependencies.

New modules:

```
src/core/query.js     topological queries over B-rep + persistent anchors
src/core/sketch.js    2D constraint solver
src/core/cellapi.js   the curated API handed to cell programs (brep, field, q, sk)
src/core/sandbox.js   worker execution with resource limits
src/core/cells.js     cell document model, dirty tracking, evaluation order
```

## Phases

1. **Cell model + sandbox + API façade.** Cells compile, run, and produce shapes.
   *Built* — `cells.js`, `sandbox.js`, `cellapi.js`.
2. **Query layer + topology introspection.** The MCP surface that replaces vision.
   *Built* — `query.js`, `ops.js`, `src/server/cells.js` (REST at `/api/cells`),
   `src/mcp/cells.js` (ten `cadgang_cells_*` tools). The cell document is a
   second, independent document served alongside the v1 node graph.
3. **Selections + pick loop.** UI pick mode, anchors, stale detection.
   *Built* — `nearestTo()` in `query.js`, pick mode in the transcript, a
   `/pending` long poll, and `cadgang_cells_await_pick` / `cadgang_cells_pick`.
4. **Sketch cells + solver + canvas.**
   *Built* — `src/core/sketch.js` (Levenberg–Marquardt over residuals, numerical
   Jacobian), `sk` in the cell API, `brep.extrude` / `brep.revolve`, and a canvas
   in the transcript. Two things landed differently than sketched above. The
   canvas is INLINE IN THE CELL CARD rather than a separate editing surface,
   because what is being edited is the cell's 2D input and it has to sit next to
   the parameters its dimensions read. And a drag re-solves on the SERVER
   (`POST /:id/sketch/solve`, which deliberately does not persist) rather than
   in a second copy of the solver in the browser — the round trip is cheap and
   one solver is one thing to keep true.
5. **Assertions + the verification loop.**
   *Built* — `src/core/checks.js` (ray-cast minimum wall thickness over a BVH,
   exact face-to-face clearance via OCCT, watertightness of the mesh that would
   ship), the `assert` namespace recording into the evaluation report, cell
   `kind: 'assert'`, and export refusal. Self-intersection deliberately left
   out; see above.
6. **UI.** Cell stack replaces the node editor; graph becomes a derived view.
   *Built* — the transcript, pick mode, sketch canvases, assertion readouts, and
   the derived graph behind a DEPS toggle in the stack header. The graph is
   computed SERVER-side (`GET /api/cells/graph`, `dependencyGraph()` in
   cells.js) rather than in the browser, because `dependenciesOf` is the only
   thing that knows what a cell's default input is — including that assertion
   cells are not links in the chain — and a second copy of that rule in the
   client would go stale the first time this one changed. It already has, twice.
   `web/cells.html` at `/cells`: prompts in order, status badges, scrubbable
   params, per-cell errors and logs, and the exact solid with its real edges. It
   is a second page rather than a mode inside the v1 editor.

Phases 1 and 2 are the ones that prove the thesis. If queries hold up under
parameter change, the rest is construction.

All six are now built, and the first thing the plan never covered has been too:

7. **Drawing and dimensioning on the canvas.** Line, rectangle, circle, arc,
   dimension, and erase, with the meaning of a gesture inferred server-side
   (`src/core/sketchdraw.js`, `POST /:id/sketch/draw`, `/dimension`, `/erase`) —
   see *Sketch cells* above for the two rules that govern it.

   Dimensioning takes the OPPOSITE policy from drawing's inference, and that is
   the point of separating them. An inferred horizontal is ours, so it gets
   dropped when it does not fit; a dimension is a statement the person made, so
   a conflict is reported with the constraints that fight rather than quietly
   not applied. A dimension's value may be a number or THE NAME OF ONE OF THE
   CELL'S PARAMS, which is what closes the loop the whole design is about: an
   outline drawn by hand becomes parametric, driven by the same slider the
   program declares, without anyone writing coordinates. Unlike a drag, a draw PERSISTS, because a drag is sixty
   events that mean one edit and a drawn line is one gesture that means one. A
   cell whose code calls `sk.saved()` gets a canvas whether or not a sketch is
   stored yet, so a program can be written for a profile that does not exist and
   the first line someone draws is how the sketch begins.

   The view is driven by hand as well: ⌘-scroll or pinch to zoom about the
   pointer, drag the background (or space-drag, or middle-drag) to pan, FIT to
   re-frame. A plain scroll deliberately does NOT zoom — the canvas sits inside
   a transcript that scrolls, and one that swallowed the wheel would trap the
   cursor on the way down the page. Once the view has been moved by hand it is
   PINNED: automatic framing and a person holding the view are the same two
   numbers with two owners, and the automatic one has to lose or it re-centres
   the sketch you just zoomed into. FIT hands it back.

   Two things about the canvas turned out to be load-bearing and neither is
   about geometry. The tool in force and the half-finished chain live on the
   PAGE, not in the canvas, because any document change re-renders the whole
   stack — including Claude editing a cell three rows up — and a re-mount must
   not cost the corner you were about to draw from. And the view re-fits only
   when the sketch has actually left the frame, never mid-gesture: re-fitting
   after every line moves the corner you are aiming at out from under the
   pointer, which is the difference between drawing a profile and chasing one.

What is still not covered: sweep alongside extrude and revolve, nested loops in
a profile (an island inside a hole is currently cut, not kept), and the in-app
prompt box that has always been described as "later".

## Consequence of the MCP-driven choice

There is no LLM inside cadgang. Authoring happens in Claude Code; the web UI is
a cell transcript where you read prompts, drag sliders, make picks, and watch
assertions. An in-app prompt box can be added later without disturbing any of
the above — it would simply be another client of the same MCP-shaped API.
