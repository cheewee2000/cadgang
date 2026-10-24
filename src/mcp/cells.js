/**
 * MCP tools for the v2 cell document.
 *
 * The tool descriptions here are load-bearing. In v1 the modeling vocabulary was
 * discoverable at runtime — `cadgang_list_node_types` enumerated every block —
 * because the vocabulary WAS the ceiling. A cell writes JavaScript, so there is
 * no list to enumerate; the API reference below is how the vocabulary gets
 * taught, and it is the closest thing v2 has to a block palette.
 */

import { z } from 'zod';

const CELL_API = `A cell program is ES-module source with exactly two exports:

  export const params = { w: 60, d: 40, h: 24, r: 3 };
  export default ({ p, brep, q, sk, assert, input, inputs, topology }) => {
    let s = brep.box(p.w, p.d, p.h);
    s = brep.fillet(s, q.edges(s).linear().along('z').expect(4), p.r);
    return brep.shell(s, q.faces(s).planar().facing('+z').expect(1), 2);
  };

A cell runs under a 20 s wall clock; one that genuinely needs longer (a big assembly) adds \`export const budget = 60\` (seconds, up to 120).

Hoist every number a human might want to turn into 'params'. Changing a param re-runs the program; it never re-prompts. The program MUST return a solid.

ARGUMENTS
  p        the current parameter values (numbers, strings, booleans only)
  input    the previous cell's solid — the running "that" ("subtract that from the body"). It is the cell just
           above whenever the program mentions input, so a side branch (a spring built beside the part) becomes the
           next cell's input unless that cell declares refs — name what you mean whenever the stack forks. A broken
           cell above only breaks the cells that read what it made: a program that never touches input still builds.
  inputs   results keyed by cell id, when the cell declares explicit refs
  sel      the user's picks, as ready-made queries — sel.lip goes straight into brep.chamfer(input, sel.lip, 2).
           Declare what you need with selections: {"lip": "edge"} and the cell parks until someone clicks
           (cadgang_cells_await_pick). Use this only when the reference genuinely needs a human; a written
           query is better whenever the geometry can describe itself.
  brep, q, sk, sm, assert, topology  as below

brep — every operation is a pure function: shape in, new shape out. Nothing is mutated, so a cell is math all the way down.
  primitives: box(sx,sy,sz,{center}) — by DEFAULT centred in X and Y and sitting on z=0 (center:'xy'); center:'xyz' centres
    it fully; center:'' puts a corner at the origin. cylinder(r,h,{center}) likewise sits on z=0 about the z axis; sphere(r);
    torus(majorR, minorR) about z; cone(r1, r2, h, {center}) — r2 = 0 for a point, r1 ≠ r2 for a frustum;
    coil(r, pitch, height, sectionR, {section:'circle'|'square'|'triangle', lefthand}) — a spring
  booleans: union/subtract/intersect(base, ...tools); interference(a, b) -> shared volume (0 = no clash).
    compound(...shapes) keeps parts as SEPARATE bodies — an assembly, nothing fused: a lid seated on its body, a cap on a
    bottle. Measures report bodies = N and STEP writes N solids (union would fuse anything that touches).
    A union of bodies that do not touch is a MULTI-BODY result (a gap under 0.01 mm is a gap): measures report
    \`bodies\`, and assert.singleBody(shape) refuses it — write that assertion for any part meant to be one piece.
  sketch → solid: extrude(sketch, distance, {symmetric, offset, twist:deg, endScale}) — endScale 0.5 tapers to half size;
    revolve(sketch, axis=[0,0,1], {offset, origin, angle:360}); loft([sketchA, sketchB, ...], {ruled}) — put each
    section on its own plane/offset with s.on('XY', 30); a loft's side edges are splines even when straight, so query
    its corners with .ofLength(v, tol) or .near(...) rather than .linear(); sweep(sketch, path, {frenet, xDir, guide, transition}) — the
    profile is placed at the path's start, normal along the path, its own plane ignored; \`guide\` is a second path
    the profile keeps touching as it goes (a rail), so it tilts and slides to follow it; pipe(path, r, {wall});
    emboss(shape, sketch, depth, {cut}) — raise or sink a profile from its plane into the body;
    rib(shape, [[x,y,z],...]|path, thickness, height, {direction=[0,0,1]}) — a thin wall fused on: the path is the wall's
    FOOT line (put its points on the body), \`direction\` is the axis the wall stands up along, and the wall is a plain
    height×thickness rectangle swept along the path, not clipped to the body — size it to end inside the body
  paths (for sweep/pipe/pathPattern): polyline([[x,y,z],...]); spline([[x,y,z],...]) smooth through the points;
    helix(r, pitch, height, {center, axis, lefthand})
  hole(shape, [x,y,z], diameter, {depth (omit = through all), direction=[0,0,-1], counterbore:{diameter,depth},
    countersink:{diameter, angle:90}}) — Fusion's Hole: drill from a point on a face
  thread(shape, cylindricalFaceQuery, pitch, {length: AXIAL extent (default: the face's), depth: RADIAL groove depth
    (default ISO for the pitch — rarely set), lefthand}) — a modelled thread with a rounded profile; boss or hole is read
    from the face, and a hollow boss keeps its bore. Fast on solid geometry (~0.1 s); on a SHELLED part every boolean
    is slow (5–15 s), and any boolean AFTER the thread that touches it is slow too — so thread LAST, after patterns and
    decorations, and shell before threading or use length to keep the thread clear of curved inner surfaces.
  modifiers: fillet(shape, edgeQuery, radius|fn(edge)); chamfer(shape, edgeQuery, distance | {distances:[a,b], face:faceQuery}
    | {distance, angle, face}); shell(shape, faceQuery|null, thickness) — POSITIVE hollows INWARD, negative grows outward,
    null query seals a void; shell BEFORE filleting whenever a fillet radius is under the wall thickness (the inward offset
    collapses such a fillet and the shell fails); lofts and other cornered curved bodies shell by whole-body offset, which can only OPEN planar faces; offset(shape, distance) grows every face (negative shrinks);
    pushPull(shape, planarFaceQuery, distance) — Press Pull: move faces out (+) or in (−);
    draft(shape, faceQuery, deg, {pull=[0,0,1], neutralAt}) tapers faces for mould release, faces staying put on the
    neutral plane (default: the bottom along pull); split(shape, origin, normal) | split(shape, toolShape) -> {above, below};
    simplify(shape) merges coplanar faces and collinear edges a pattern or pushPull left behind
  patterns: linearPattern(shape, [dx,dy,dz], count); circularPattern(shape, count, {axis, origin, angle:360});
    pathPattern(shape, path, count, {orient:true}) — all return the copies FUSED: pattern a tool then subtract, a boss then union.
    mirror(shape, 'XY'|'XZ'|'YZ', origin, {keep:true}) — keep fuses the image onto the original, as Fusion's Mirror does
  placement: translate(shape,[x,y,z]); rotate(shape, deg, axis=[0,0,1], origin); scale(shape, factor, origin) (uniform only)
  construct: planeOf(shape, planarFaceQuery) -> {origin, normal, xDir} with origin at the face's CENTRE, so a sketch about
    (0,0) lands mid-face; plane(origin, normal, xDir?); planeThrough(a, b, c);
    pivotPlane(plane, deg, axis?) — plane at an angle; midplane(shape, faceQueryA, faceQueryB);
    axisOf(shape, cylindricalFaceQuery) -> {origin, direction, radius} for revolve / circularPattern / thread.
    A plane object goes straight into a sketch: sk.sketch().on(brep.planeOf(input, q.faces(input).planar().facing('+z').expect(1)))
  measures: volume(shape); area(shape); bbox(shape) -> {min,max,size}; bodies(shape) -> count of separate solids;
    centroid(shape) -> [x,y,z]; mass(shape, g/cm³) -> grams;
    distance(a, b) closest approach; length(shape, edgeQuery) total edge length
  importStep(file, {body}) — an exact solid from a STEP file in the project folder (path relative to it): body i in file
    order, or every body as one compound. Parsed once per file; then edit it like anything built here (pushPull, split, subtract).
  NOT available (kernel build lacks the binding): delete/replace face, non-uniform scale, surface tools, text.

q — q.faces(shape) / q.edges(shape), then chain filters. A revolved line reads as cylindrical/conical and a shelled
  cylinder's inner wall as cylindrical, whatever OCCT calls the surface underneath.
  kinds: planar() cylindrical() conical() spherical() toroidal() | linear() circular() elliptical() | ofKind('PLANE',...)
  direction: along('z'|'+x'|[0,0,1]) for edges; facing('+z', toleranceDeg=5) for faces (sign matters: '+z' is the top,
    'z' is both) — a drafted wall is a few degrees off its axis, so pass a wider tolerance or use .atExtreme()
  measure: ofLength(v,tol) ofArea(v,tol) ofRadius(v,tol) ofDiameter(v,tol) largerThan(v) smallerThan(v)
  place: near([x,y,z], dist) inBox([x,y,z],[x,y,z]) atExtreme('+z')
  combine: either(s => s.linear(), s => s.circular()) exclude(s => s.facing('-z')) where(d => d.area > 10)
  finish: expect(n) — ASSERT the count and carry on; count(); one(); all(); explain()
  Kinds in topology and descriptors: PLANE CYLINDER CONE SPHERE TORUS, then BSPLINE_SURFACE / OFFSET_SURFACE for the rest.

Always end a query with .expect(n). A query that matches an unexpected number of entities then fails the cell loudly instead of quietly building a different part. A query that matches nothing is always an error.

sk — 2D sketches under constraint, for profiles a primitive cannot express. sk.sketch() starts an empty one;
  sk.saved() returns the sketch stored on THIS cell — the one the user DRAWS AND DRAGS in the canvas. Constraints and
  s.on(plane) the CODE adds to it apply when the cell builds and are NOT written back to the stored sketch (the canvas
  stays the human's); a drawn sketch is on XY unless the draw or the code says otherwise;
  sk.hasSaved() tests for it. A cell whose code calls sk.saved() gets a drawing canvas in the transcript,
  whether or not a sketch is stored yet, and the user draws lines, rectangles, circles and arcs into it there.
  So when the profile is a shape someone should draw rather than describe — an outline, a bracket, a cam —
  write the cell around sk.saved() with NO sketch and say so in the prompt, instead of inventing coordinates.
  Their gestures are stored as constrained geometry (a snapped corner becomes one shared point, a near-level
  line becomes horizontal), so the profile they draw survives the parameter changes you write.
  They can also DIMENSION on that canvas, and a dimension's value may be the NAME OF ONE OF THIS CELL'S PARAMS —
  so declare the params you want them to drive (\`export const params = { width: 40 }\`) even when the program
  never reads them itself. A dimension typed as 'width' binds the drawn geometry to that slider forever after.
  geometry: point(x,y,{fixed}) -> index; anchor(x,y) a pinned point (every sketch wants at least one);
    line(a,b) / circle(c, r) / arc(c, a, b) counter-clockwise from a to b — a, b, c are POINT INDICES from point()/anchor(),
    never coordinates; each returns an entity index;
    rectangle(x1,y1,x2,y2) -> four already-squared lines; polygon(cx,cy,sides,r) -> lines, equal-sided;
    slot(x1,y1,x2,y2,r) -> [line, arc, line, arc], tangent and parallel; on(plane, offset=0) sets the plane — a name
    ('XY'|'XZ'|'YZ'|'YX'|'ZX'|'ZY') or a brep.planeOf(...) object — and slides it along the normal
  constraints: coincident(p,p) horizontal(line) vertical(line) distance(line,v) distance(p,p,v)
    distanceX(p,p,v) distanceY(p,p,v) — SIGNED, b minus a; radius(e,v) diameter(e,v) equal(e,f)
    parallel(e,f) perpendicular(e,f) angle(e,f,degrees) tangent(line|curve, curve) pointOn(p,e) concentric(e,f)
  Any dimension value may be a NUMBER or the NAME OF A PARAM as a string: s.distance(l, 'width') follows the slider.
    That is the whole point of a sketch over a point list — write the intent, not the coordinates.
  solve({params}) returns {converged, dof, redundant, iterations}; brep.extrude/revolve solve it for you if you did not.
    Starting coordinates only need to be roughly right — the solver pulls them onto the dimensions, and a rough
    pose is what picks between the two answers a tangency or a mirror has. So for TANGENT ARCS start close: put the
    arc's centre and ends near where they belong, or the solver keeps a wrong branch (a huge arc, a crossed loop).
    Solved positions are persisted, so a parameter round-trip can settle on a different valid branch; write queries
    that survive that (.atExtreme, .near, .largerThan) rather than exact lengths.
  Sketch geometry must form CLOSED loops. Nesting is read from containment: a loop inside the boundary is a hole,
    a loop inside a hole is an island, and so on.
  dof > 0 means the sketch is under-constrained: it built, but the solver chose the free part of the shape for you —
  possibly on the FIRST solve, not only after a parameter change — so an under-constrained hook can come out a wedge
  that satisfies every constraint you wrote. Aim for dof 0, and look at the preview whenever dof is not. 'redundant' means you said something twice; harmless but noise.

assert — machine-checkable intent. Each one MEASURES, records the number in the transcript, and throws if it misses.
  ok(cond, msg); volumeUnder(shape, mm³); volumeOver(shape, mm³); fitsIn(shape, [x,y,z])
  minWall(shape, mm) — thinnest wall anywhere, by casting rays into the solid from all over its surface. SAMPLED:
    biased low by tessellation (safe direction), and a thin spot smaller than the sample spacing can hide.
  clearance(shape, queryA, queryB, mm) — exact closest approach between two sets of faces or edges; both queries are
    resolved on \`shape\`, so union the parts first and write queries that pick each part's faces on the combined body.
  watertight(shape) — the mesh that would be exported is closed. Judged on the tessellation, which is what ships.
  singleBody(shape) — the result is ONE connected solid, not a compound of parts that never met.

sm — sheet metal bent from one flat sheet, built to a shop's gauge table so the bends, reliefs and flat pattern are the
  shop's own. sm.gauge('scs-304', 0.060) is SendCutSend 304 stainless at .060 in (radius, bend deduction, min flange,
  max bend length, 30 x 44 in flat). sm.part(name, gauge, {hardware, round: 3}) then, in mm, outside sizes:
    .base(U, V)  the base rectangle, u along x, v along y of its own frame
    .flange('base.r', 25, {from, to, reverse})  a 90° flange that high off edge b (v 0), t (v V), l (u 0) or r (u U), folded to the
      inside; flanges stack: 'base.r.t' is the tip of that flange, 'base.r.l' / '.r' its sides (a flange's b is its bend);
      reverse: true folds it the other way (Z bends), its height from the parent's inside face, and it may not meet another at a corner
    .cut('base', sm.rect(u0, v0, u1, v1, r), sm.circle(u, v, r), sm.slot(u0, v0, u1, v1, r), sm.poly(pts))  holes, in that panel's coordinates
    .window('base', [u0, v0, u1, v1], depth)  an opening whose four edges fold in as mitred flaps
    .at('base.b', [x, y, z], frame)  -> [u, v]: a point in the frame make() will get, in that panel's coordinates
    .pem('base.b', 'SP-M5-0', [u, v], {face: 'in'|'out'})  PEM hardware the shop presses in (sm.hardware lists the SKUs:
      SP nuts, SO4 standoffs, FH4 flush studs, metric); face: the side its body stands out of. Checked against the catalog's
      sheet range, K / N (hole centre to any cut edge or bend allowance area) and M (same SKU spacing); fused into the solid
    .countersink('base', 'M4', [u, v], {face})  a 90° metric countersink (draws the minor hole); SCS does these only in
      aluminium and plastics .125 to .750 in, depth under 60% of the sheet, parts 1 x 4 to 14 x 46 in
  sm.gauge('scs-5052', 0.187) is SendCutSend 5052 aluminium, flat parts only (no bend table yet).
    .make({origin, u, v, n})  folds it into a solid placed on that right handed frame (n the inside), checks the shop's
      rules (recorded like assert.*, a miss fails the cell) and keeps its flat for cadgang_cells_export format 'dxf'
  Where two flanges meet at a corner they close to the shop's gap (.015 in) with a round relief; a flange that stops
  mid edge gets a round ended relief slot; free outline corners are rounded by 'round'. A part made twice under one
  name counts as qty 2 in the export; the export lists each part's hardware by SKU. 90° bends only.

soft — softgoods the way CLO works a garment: pieces cut flat from fabric, sewn edge to edge, pinned to hardware and
  draped onto a body under gravity; each relaxed piece comes back as an exact B-spline face trimmed to its outline,
  the compound named per piece, and each piece's cutting pattern joins the DXF export (outline on STITCH, outline plus
  seam allowance on CUT). It settles to the rest shape; it is not an animation. mm throughout.
  soft.fabric('cordura-500d' | 'nylon-210d' | 'spacer-mesh' | 'eva-10mm' | {weight g/m², thickness, stretch, shear, bend 0..1, friction, maxStretch %})
  soft.avatar({chest: 1000, waist: 860, hip: 980, torso: 480})  a torso solid to drape on: circumferences, standing up z,
    hip at z 0, front toward -y, centred on x; translate it to where the wearer stands against the frame
  const g = soft.garment('harness') then
    g.piece(name, [[u, v], ...], fabric, {grid: 10, allowance: 10})  a closed outline in its own flat mm (u right, v up); grid
      is the solver's node spacing (finer is slower; 10 for straps, 15 to 20 for panels), allowance the seam allowance in the pattern
      .place(origin, u, v)  where the flat piece starts in 3D before it drapes: its (0, 0) at origin, u and v along those directions
      .pin([u, v], [x, y, z])  tack a pattern point to a world point (a bar tack, a rivet, a strap end on its frame anchor);
        pins hold the piece inextensible from there, so a strap between two pins hangs as it would
      .edge(i, j = i + 1)  the outline from point i to point j, for seams
    g.seam(a.edge(1), b.edge(3), {flip: false, ease: 0.03})  sew two edges start to start (flip runs the second backwards);
      their lengths must match within ease, recorded like assert.*
    g.make({body, gravity: [0, 0, -1], g: 9810, steps, dt, iterations, clearance: 0.5})  -> the garment as faces; body is the
      shape it must not pass through (the frame unioned with the avatar, or null to hang free). Records, like assert.* but
      without failing the cell: each seam's length match and the gap it left, each piece's worst stretch against its fabric's
      maxStretch (the solver itself leaves 1 to 4%, so read anything under 5% as flat), how far it settled, and the deepest
      pass into the body (ok under clearance). g.timing then has {total ms, steps, nodes}.
  Pieces are faces, not solids: bbox, distance, area and STEP/STL export work; volume, mass and booleans do not. Start pieces
  near where they end up (a shoulder strap laid over the shoulder, not on the floor) — the drape is a relaxation, so a
  piece started far away or inside the body ends up somewhere strange. No self collision, darts or pleats yet.

ASSERTION CELLS — add a cell with kind: 'assert' and its program states claims instead of building geometry.
  export default ({ assert, input }) => { assert.minWall(input, 1.5); assert.watertight(input); };
  It passes 'input' straight through, so it can sit anywhere in the stack without becoming a link in the chain.
  A failed assertion fails the DOCUMENT, not the stack: the geometry still builds and still renders (looking at the
  part is how you fix it), but STEP export REFUSES until it passes or the assertion cell is deleted.
  Claims run as ordinary statements, so the first failure stops the ones after it in the SAME cell — put
  independent claims in separate cells if you want to see all of them at once.
  Write assertions for the things the prompt implied but the code cannot show: a wall that must survive a
  parameter change, a clearance a part is built to, a volume budget. That is the loop closing.

The program runs in an isolated realm: no filesystem, network, timers, or process, and a wall-clock budget. Standard JS (Math, Array, loops, functions) is available, so arrays of holes, patterns and derived dimensions are ordinary code. console.log(...) works: each line lands in the cell's \`logs\` in cadgang_cells_evaluate — the way to inspect a plane object, a bbox, or a count while authoring.

THE AUTHORING LOOP — you cannot see the model, so introspection replaces looking:
  1. cadgang_cells_add with the prompt and a first draft of the code
  2. cadgang_cells_topology — read the real faces and edges of what you built
  3. cadgang_cells_query — confirm a query catches what you meant BEFORE applying it
  4. cadgang_cells_add / _compile the operation that uses it
  5. cadgang_cells_render — look at it
  6. cadgang_cells_evaluate — confirm every cell is 'ok' AND 'assertionsPass' is true
  7. add an assertion cell for what the prompt promised, so the next parameter change re-checks it`;

const CELL_STATUS = `Cell status: 'ok' (code matches prompt) | 'stale' (prompt edited past the code) | 'diverged' (code hand-edited past the prompt) | 'awaiting_pick' (needs a user selection). Evaluation failure is reported by cadgang_cells_evaluate, not stored on the cell — as is 'failed', which is an assertion cell whose claim missed.`;

/**
 * Register the cell tools.
 *
 * `call`, `ok` and `fail` are the same HTTP and result helpers the v1 tools use,
 * passed in rather than duplicated.
 */
export function registerCellTools(server, { call, ok, fail, base, headers }) {
  const paramValue = z.union([z.number(), z.string(), z.boolean()]);

  const sketchSchema = z.object({
    plane: z.union([
      z.enum(['XY', 'XZ', 'YZ', 'YX', 'ZX', 'ZY']),
      z.object({ origin: z.array(z.number()).length(3), normal: z.array(z.number()).length(3), xDir: z.array(z.number()).length(3).optional() }),
    ]).optional().describe("A named plane, or a {origin, normal, xDir?} object such as brep.planeOf returns"),
    offset: z.number().optional().describe('Distance along the plane normal'),
    points: z.array(z.object({ x: z.number(), y: z.number(), fixed: z.boolean().optional() })),
    entities: z.array(z.object({
      type: z.enum(['line', 'circle', 'arc']),
      a: z.number().int().optional(),
      b: z.number().int().optional(),
      c: z.number().int().optional(),
      r: z.number().optional(),
    })),
    constraints: z.array(z.object({ type: z.string() }).passthrough()),
  }).describe('A stored sketch the user can drag: points, entities and constraints. Read it back with sk.saved().');

  server.registerTool(
    'cadgang_cells_get',
    {
      title: 'Get the cadgang cell document',
      description: `Return the v2 cell document: the ordered stack of cells with each one's prompt, code, params, refs, selections and status, plus the output cell and revision.

A document is an ordered stack, not a free graph. A cell with no 'refs' consumes the previous cell's result. Explicit refs may only point BACKWARDS, which is what makes cycles impossible.

${CELL_STATUS}`,
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      try { return ok(await call('/cells/document')); } catch (e) { return fail(e); }
    }
  );

  server.registerTool(
    'cadgang_cells_add',
    {
      title: 'Add a cell to the cadgang cell stack',
      description: `Append a cell: a natural-language prompt plus the geometry program it compiles to.

The prompt is the source of record and the code is a LOCKFILE. Geometry never regenerates from a prompt on its own — that is what stops the same file becoming a different part between two openings.

Args:
  - id: the part's name, which the user sees and later cells refer to (letters, digits, underscore). Name what it IS, never what it is in general:
    'battery_lid', 'm3_boss_array', 'usb_c_cutout', 'hinge_knuckle' — not 'cell_3', 'part', 'body', 'box', 'new_cell', 'shape2'
  - prompt: what this cell is meant to do, in words
  - code: the program (see below). May be omitted and compiled later.
  - refs: cell ids this one consumes. Omit for the common case — the previous cell.
  - params: overrides for the program's declared defaults
  - selections: picks this cell needs from the user, e.g. {"lip": "edge"}; the cell parks in 'awaiting_pick' until resolved
  - sketch: a stored 2D sketch for the user to draw on and drag, which the program reads with sk.saved(). Omit it and the canvas starts empty for them to draw into — which is the right move when the profile is theirs to shape. Omit both this and sk.saved() when the program builds its own sketch inline with sk.sketch(); that is the usual case.
  - kind: 'model' (default, builds geometry) or 'assert' (states claims about the geometry and passes it through)
  - at: insert position (default: end of the stack)

${CELL_API}`,
      inputSchema: {
        id: z.string().describe("The part's descriptive name, e.g. 'battery_lid' (never generic like 'cell_3' or 'part')"),
        prompt: z.string().optional().describe('What this cell does, in words'),
        code: z.string().optional().describe('The cell program'),
        refs: z.array(z.string()).optional().describe('Cell ids consumed (default: the previous cell)'),
        params: z.record(paramValue).optional(),
        selections: z.record(z.enum(['face', 'edge'])).optional().describe('Picks the user must make'),
        sketch: sketchSchema.optional(),
        kind: z.enum(['model', 'assert']).optional()
          .describe("'assert' makes this a check that fails the document rather than a step that builds geometry"),
        at: z.number().int().optional().describe('Insert position'),
        compiledBy: z.string().optional().describe('Model that authored the code'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => {
      try { return ok(await call('/cells', { method: 'POST', body: args })); } catch (e) { return fail(e); }
    }
  );

  server.registerTool(
    'cadgang_cells_update',
    {
      title: 'Edit a cell',
      description: `Change a cell's params, prompt, refs, or code.

Use this for PARAMETERS — that is the whole point of hoisting them. Changing a param re-runs the committed program and leaves the cell 'ok'; turning a knob is not a change of intent.

Editing 'prompt' here marks the cell 'stale' and does NOT touch the geometry. Editing 'code' here marks it 'diverged'. To change what the part IS, edit the prompt and then call cadgang_cells_compile with the new code — that is the only route back to 'ok', and it records the provenance.

${CELL_STATUS}`,
      inputSchema: {
        id: z.string().describe('Cell id'),
        params: z.record(paramValue).optional().describe('Parameter values to change'),
        prompt: z.string().optional().describe('New prompt (marks the cell stale)'),
        code: z.string().optional().describe('New code (marks the cell diverged)'),
        refs: z.array(z.string()).optional().describe('Cells consumed; must point backwards'),
        selections: z.record(z.enum(['face', 'edge'])).optional(),
        sketch: sketchSchema.optional(),
        kind: z.enum(['model', 'assert']).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ id, ...body }) => {
      try {
        return ok(await call(`/cells/${encodeURIComponent(id)}`, { method: 'PATCH', body }));
      } catch (e) { return fail(e); }
    }
  );

  server.registerTool(
    'cadgang_cells_compile',
    {
      title: 'Commit a recompiled cell',
      description: `Replace a cell's program with code you generated from its prompt, and record that the two now agree.

This is the only path back to status 'ok'. It is deliberately separate from cadgang_cells_update because the difference between "regenerated from the prompt" and "someone edited the code by hand" is exactly the provenance the lockfile exists to record.

Params the new program still declares keep whatever value the user had dialled in; params it dropped are removed.

${CELL_API}`,
      inputSchema: {
        id: z.string().describe('Cell id'),
        code: z.string().describe('The recompiled program'),
        prompt: z.string().optional().describe('Prompt this code was compiled from'),
        params: z.record(paramValue).optional().describe('Values to carry over'),
        compiledBy: z.string().optional().describe("Model that authored it, e.g. 'claude-opus-5'"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ id, ...body }) => {
      try {
        return ok(await call(`/cells/${encodeURIComponent(id)}/compile`, { method: 'POST', body }));
      } catch (e) { return fail(e); }
    }
  );

  server.registerTool(
    'cadgang_cells_delete',
    {
      title: 'Delete a cell',
      description: 'Remove a cell from the stack. Refused while a later cell references it — rewire that cell first.',
      inputSchema: { id: z.string().describe('Cell id') },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ id }) => {
      try {
        return ok(await call(`/cells/${encodeURIComponent(id)}`, { method: 'DELETE' }));
      } catch (e) { return fail(e); }
    }
  );

  server.registerTool(
    'cadgang_cells_topology',
    {
      title: 'Read the topology of a cell result',
      description: `Return every face and edge of a cell's solid with the properties a query filters on — this is how you SEE the model.

  faces: id, surface kind, area, centroid, normal, bbox, adjacent edges
  edges: id, curve kind, length, midpoint, direction, adjacent faces
  measures: volume, surface area, bounding box

Read this before writing a query, and again after an operation to confirm it did what you meant. Note the ids are positional and change as the model changes — never reference geometry by id. Turn what you learn here into a QUERY (cadgang_cells_query), which survives a parameter change.

Args:
  - cell: cell id (defaults to the output/last cell)`,
      inputSchema: { cell: z.string().optional() },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ cell }) => {
      try {
        const qs = cell ? `?cell=${encodeURIComponent(cell)}` : '';
        return ok(await call(`/cells/topology${qs}`));
      } catch (e) { return fail(e); }
    }
  );

  server.registerTool(
    'cadgang_cells_query',
    {
      title: 'Test a geometry query against a cell result',
      description: `Resolve a query expression against a cell's solid and report what it catches, WITHOUT changing the document.

Use this before every fillet, chamfer, or shell. Confirming an expression selects the four vertical edges and not twelve is the difference between generated geometry you can trust and generated geometry you are hoping about.

The expression is ordinary cell-language JavaScript with 'q' and 'shape' in scope, so what you test here is exactly what you paste into the cell:

  q.edges(shape).linear().along('z')
  q.faces(shape).planar().facing('+z')
  q.edges(shape).circular().ofRadius(3).near([0, 0, 24], 5)

Returns the resolved expression, the match count, and a descriptor for each match.

Args:
  - expression: the query
  - cell: cell id to resolve against (defaults to the output/last cell)`,
      inputSchema: {
        expression: z.string().describe("e.g. q.edges(shape).linear().along('z')"),
        cell: z.string().optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      try { return ok(await call('/cells/query', { method: 'POST', body: args })); } catch (e) { return fail(e); }
    }
  );

  server.registerTool(
    'cadgang_cells_evaluate',
    {
      title: 'Run the cell stack and report',
      description: `Evaluate the stack and report per-cell status, console output and timing, plus the final volume, area and bounding box. No geometry payload — this is the cheap "did my edit work" call.

Also returns 'assertions' (every claim any cell made, with the number it measured) and 'assertionsPass'. A cell whose status is 'failed' is an assertion cell whose claim missed: the geometry still built, but exports refuse until it passes.

Only the cells the target actually consumes are run, so an abandoned branch costs nothing.

Args:
  - cell: evaluate up to this cell (defaults to the output/last cell)
  - stopOnError: false walks the whole stack and reports every broken cell in one pass instead of one round trip per failure (default true)`,
      inputSchema: {
        cell: z.string().optional(),
        stopOnError: z.boolean().default(true),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ cell, stopOnError }) => {
      try {
        const qs = new URLSearchParams();
        if (cell) qs.set('cell', cell);
        if (stopOnError === false) qs.set('stopOnError', '0');
        return ok(await call(`/cells/evaluate${qs.size ? `?${qs}` : ''}`));
      } catch (e) { return fail(e); }
    }
  );

  server.registerTool(
    'cadgang_cells_render',
    {
      title: 'Render a preview of the cell stack',
      description: `Raymarch the cell stack server-side and return a shaded PNG so you can SEE the geometry. Use after edits to verify visually — topology tells you what is there, this tells you whether it looks right.

Args:
  - cell: cell to render (defaults to the output/last cell)
  - yaw: orbit angle in degrees around Z (default -35)
  - pitch: elevation in degrees (default 25; 90 = top view)
  - width/height: image size in px`,
      inputSchema: {
        cell: z.string().optional(),
        yaw: z.number().min(-360).max(360).default(-35),
        pitch: z.number().min(-89).max(89).default(25),
        width: z.number().int().min(64).max(1280).default(640),
        height: z.number().int().min(64).max(960).default(480),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ cell, yaw, pitch, width, height }) => {
      try {
        const qs = new URLSearchParams({
          yaw: String(yaw), pitch: String(pitch), width: String(width), height: String(height),
        });
        if (cell) qs.set('cell', cell);
        const png = await call(`/cells/preview.png?${qs}`, { raw: true });
        return {
          content: [
            { type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
            { type: 'text', text: `Rendered ${width}x${height} preview (yaw ${yaw}°, pitch ${pitch}°).` },
          ],
        };
      } catch (e) { return fail(e); }
    }
  );

  server.registerTool(
    'cadgang_cells_await_pick',
    {
      title: 'Wait for the user to pick geometry',
      description: `List the picks still waiting on a human, optionally blocking until one is made.

Some references genuinely need a person: "fillet THAT edge." Declare the need when you author the cell — cadgang_cells_add with selections: {"lip": "edge"} — and the cell parks in 'awaiting_pick'. The web UI at /cells then prompts the user to click, and this tool is how you find out they have.

Each pending entry names the cell, the selection, the type wanted, and 'source' — the cell whose geometry the user will be clicking on, which is the picking cell's input.

What gets stored is a query plus an anchor (kind, position as a fraction of the part's bounding box, measure, heading) — never an index. So the pick survives a later parameter change, and when it genuinely cannot be re-found the cell asks to be picked again rather than operating on the wrong entity.

In the cell program the pick arrives as 'sel.<name>', an ordinary query:
  export default ({ brep, sel, input }) => brep.chamfer(input, sel.lip, 2);

Args:
  - waitSeconds: block up to this long (max 60) and return the moment a pick is made. 0 returns immediately. Returns timedOut: true if nobody picked — tell the user what you are waiting for rather than looping.`,
      inputSchema: {
        waitSeconds: z.number().min(0).max(60).default(0),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ waitSeconds }) => {
      try {
        const qs = waitSeconds ? `?wait=${waitSeconds}` : '';
        return ok(await call(`/cells/pending${qs}`));
      } catch (e) { return fail(e); }
    }
  );

  server.registerTool(
    'cadgang_cells_pick',
    {
      title: 'Make a pick on the user\'s behalf',
      description: `Resolve a declared selection yourself, by naming the face or edge from cadgang_cells_topology.

Prefer letting the user click — a selection exists because the reference needed a human. Use this when the topology makes the answer unambiguous, or when the user has described the entity clearly enough in words that you can identify it in the topology listing.

The index is the 'i' field from cadgang_cells_topology on the SOURCE cell (the picking cell's input — cadgang_cells_await_pick reports which that is). It is resolved immediately and never stored; what gets stored is the anchor.

Args:
  - cell: the cell with the declared selection
  - name: the selection name
  - index: the face/edge index from topology of the source cell
  - type: 'face' or 'edge' (defaults to what the selection declared)`,
      inputSchema: {
        cell: z.string(),
        name: z.string(),
        index: z.number().int().min(0),
        type: z.enum(['face', 'edge']).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ cell, name, index, type }) => {
      try {
        return ok(await call(
          `/cells/${encodeURIComponent(cell)}/selections/${encodeURIComponent(name)}`,
          { method: 'POST', body: { index, type } }
        ));
      } catch (e) { return fail(e); }
    }
  );

  server.registerTool(
    'cadgang_cells_history',
    {
      title: 'Version history of the cell stack',
      description: `List the versions of the cell document, or fetch one version with its rendered look.

Versions are made automatically: a structural edit (cell added/removed/moved, code, prompt, sketch, selections, output) becomes a version ~1.5 s after the burst settles; parameter scrubs become one version once the knobs have been idle 20 s; a revert or an explicit save is a version at once. Each carries an AUTO annotation written from the diff ("changed params (h 10 → 20) on 'body'; volume +100%, size z +10") plus any note you or the user added, the measures, and a PNG. They live in <project>/cadgang/history/.

Use it to tell the user what changed between two states, to find the version they liked ("the one before the lid got taller"), and before a revert.

Args:
  - n: a version number — returns that version in full with its image. Omit to list.
  - limit: with no n, how many of the newest versions to list (default 20).`,
      inputSchema: { n: z.number().int().positive().optional(), limit: z.number().int().min(1).max(200).default(20) },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ n, limit }) => {
      try {
        if (n === undefined) {
          const { dir, versions } = await call('/cells/history');
          return ok({ dir, total: versions.length, versions: versions.slice(-limit) });
        }
        const { snapshot, ...v } = await call(`/cells/history/${n}`);
        const content = [{ type: 'text', text: JSON.stringify({ ...v, cells: snapshot.cells.map((c) => ({ id: c.id, kind: c.kind, prompt: c.prompt, params: c.params })) }, null, 2) }];
        const img = await fetch(`${base}/api/cells/history/${n}.png`, { headers });
        if (img.ok) content.push({ type: 'image', data: Buffer.from(await img.arrayBuffer()).toString('base64'), mimeType: 'image/png' });
        return { content };
      } catch (e) { return fail(e); }
    }
  );

  server.registerTool(
    'cadgang_cells_save_version',
    {
      title: 'Save a version now, or annotate one',
      description: `Make a version of the current stack right now with a note, or add/replace the note on an existing version.

Do this at milestones the autosave policy cannot know about — "the bracket the user approved", "before trying the thinner wall" — and to write down WHY a change was made next to the automatic WHAT. Returns the version.

Args:
  - note: the annotation
  - n: an existing version to annotate instead of saving a new one`,
      inputSchema: { note: z.string().max(2000), n: z.number().int().positive().optional() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ note, n }) => {
      try {
        if (n !== undefined) return ok(await call(`/cells/history/${n}/note`, { method: 'POST', body: { note } }));
        return ok(await call('/cells/history', { method: 'POST', body: { note } }));
      } catch (e) { return fail(e); }
    }
  );

  server.registerTool(
    'cadgang_cells_revert',
    {
      title: 'Revert the stack to a version',
      description: `Restore the whole cell stack to version n. One undo step; also recorded as a new version ("reverted to #n"), so nothing is ever lost — reverting is itself revertible.

Look at the version first (cadgang_cells_history with n) unless the user named it.`,
      inputSchema: { n: z.number().int().positive() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ n }) => {
      try { return ok(await call(`/cells/history/${n}/revert`, { method: 'POST', body: {} })); } catch (e) { return fail(e); }
    }
  );

  // cadgang_screen lives in index.js (the viewer version, with feedback counts); the cell copy was a duplicate registration that crashed the server.

  // cadgang_markup_clear lives in index.js as well; one registration or the SDK throws at start.

  server.registerTool(
    'cadgang_cells_propose',
    {
      title: 'Propose options for the user to pick from',
      description: `Show the user 2–8 alternative versions of one cell side by side — each rendered, measured, viewable in 3D — and let THEM choose. Nothing changes in the stack until they pick.

Use it when a prompt has real design latitude ("a handle", "some way to mount this", "rounder"): write each option as a complete cell program (same shape as cadgang_cells_add: export default ({ brep, p, input, ... }) => ...), give each a short label that says what is different, and propose. Then call cadgang_cells_await_choice to learn which one they took. An option that fails to build comes back with its error so you can fix it and propose again; the user cannot pick a broken one.

Args:
  - cell: the cell to replace (its code/prompt/params become the chosen option). Omit to add a NEW cell with the chosen option (give it the id in 'cell' if you want one — if that id does not exist yet, it is created).
  - options: [{label, prompt?, code, params?}]`,
      inputSchema: {
        cell: z.string().optional(),
        options: z.array(z.object({
          label: z.string().max(80), prompt: z.string().optional(), code: z.string().optional().describe('Omit to keep the cell\'s code and change only params'), params: z.record(z.any()).optional(),
        })).min(2).max(8),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ cell, options }) => {
      try { return ok(await call('/cells/options', { method: 'POST', body: { cell, options } })); } catch (e) { return fail(e); }
    }
  );

  server.registerTool(
    'cadgang_cells_await_choice',
    {
      title: 'Wait for the user to choose an option',
      description: `Block up to waitSeconds (max 60) until the user chooses one of the proposed options or dismisses the set. Returns the set with 'chosen' (the index) once picked, set: null if dismissed, timedOut: true if neither happened — then tell the user what you are waiting for rather than looping.`,
      inputSchema: { waitSeconds: z.number().min(0).max(60).default(30) },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ waitSeconds }) => {
      try { return ok(await call(`/cells/options${waitSeconds ? `?wait=${waitSeconds}` : ''}`)); } catch (e) { return fail(e); }
    }
  );

  server.registerTool(
    'cadgang_cells_export',
    {
      title: 'Export the cell stack',
      description: `Write the cell stack's solid to <filename>.step (or .stl) in the project folder and return the path. format 'dxf' instead writes the flat pattern of every sheet metal part (sm.part(...).make()) and every softgoods piece (soft.garment(...).make()) the stack makes, one <filename>_<part>.dxf each: outline and holes on layer CUT, bend lines dashed on BEND, stitch lines on STITCH, mm.

STEP is the default: cells are exact B-rep the whole way through, so the file reopens in Fusion, SolidWorks or OnShape as editable geometry rather than a faceted import. STL is for printing: the same solid tessellated (fine, scaled to the part).

Args:
  - filename: base name, no extension. Name the part: 'wink_battery_lid', not 'part', 'export' or 'model'
  - cell: cell to export (defaults to the output/last cell)
  - format: 'step' (default) | 'stl' | 'dxf' (sheet metal flats and softgoods patterns)`,
      inputSchema: {
        filename: z.string().regex(/^[\w.-]+$/, 'Use letters, digits, dot, dash, underscore only'),
        cell: z.string().optional(),
        format: z.enum(['step', 'stl', 'dxf']).optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ filename, cell, format = 'step' }) => {
      try {
        const qs = new URLSearchParams({ file: filename });
        if (cell) qs.set('cell', cell);
        const res = await fetch(`${base}/api/cells/export/${format}?${qs}`, { headers });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || `cadgang API error (HTTP ${res.status})`);
        }
        if (format === 'dxf') return ok(await res.json());
        const bytes = (await res.arrayBuffer()).byteLength;
        return ok({
          savedTo: res.headers.get('x-saved-to'),
          bytes,
          format: format === 'stl' ? 'binary STL (tessellated)' : 'STEP AP214 (exact B-rep)',
        });
      } catch (e) { return fail(e); }
    }
  );
}
