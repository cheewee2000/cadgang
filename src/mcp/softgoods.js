import { z } from 'zod';
import { FABRICS } from '../core/softgoods-fabrics.js';
import { SEAM_KINDS, TRIM_KINDS } from '../core/softgoods-trims.js';

const ref = z.object({ pattern: z.string(), segment: z.string().optional(), segments: z.array(z.string()).min(1).optional(), from: z.number().min(0).max(1).optional(), to: z.number().min(0).max(1).optional() });
const point = z.object({ id: z.string(), x: z.number(), y: z.number() });
const segment = z.discriminatedUnion('type', [
  z.object({ id: z.string(), type: z.literal('line'), a: z.string(), b: z.string() }),
  z.object({ id: z.string(), type: z.literal('arc'), a: z.string(), b: z.string(), c: z.string() }),
  z.object({ id: z.string(), type: z.literal('bezier'), a: z.string(), b: z.string(), c1: z.string(), c2: z.string() }),
]);
const pattern = z.object({
  id: z.string(), name: z.string().optional(), material: z.string().optional(), cut: z.number().int().positive().optional(), mirror: z.boolean().optional(),
  points: z.array(point), segments: z.array(segment), contours: z.array(z.array(z.string()).min(3)),
  allowances: z.record(z.number().nonnegative()).optional(),
  notches: z.array(z.object({ segment: z.string(), at: z.number().min(0).max(1), depth: z.number().positive().optional(), kind: z.string().optional() })).optional(),
  grain: z.object({ angle: z.number() }).optional(), internalLines: z.array(z.any()).optional(),
  placement: z.object({ region: z.enum(['front', 'back', 'left', 'right']), anchor: z.enum(['centre', 'shoulder']).optional(), layer: z.number().optional(), offset: z.array(z.number()).length(3).optional() }).optional(),
  shrink: z.object({ warp: z.number().optional(), weft: z.number().optional() }).optional(), freeze: z.boolean().optional(), strengthen: z.number().positive().optional(),
});
const elastic = { ratio: z.number().positive().max(1), stiffness: z.number().positive().optional() };
const material = z.object({
  name: z.string().optional(), arealDensity: z.number().positive().optional(), weight: z.number().positive().optional(), thickness: z.number().positive().optional(),
  rigidity: z.union([z.number().positive(), z.object({ warp: z.number().positive(), weft: z.number().positive() })]).optional(),
  tensile: z.object({ warp: z.number().positive().optional(), weft: z.number().positive().optional() }).optional(), shearRigidity: z.number().positive().optional(),
  damping: z.number().min(0).max(1).optional(), friction: z.number().min(0).max(1).optional(), notes: z.string().optional(),
  weightGsm: z.number().positive().optional(), thicknessMm: z.number().positive().optional(),
  preset: z.string().optional(), source: z.string().optional(), rollWidth: z.number().positive().optional(), pricePerMeter: z.number().positive().optional(), pricePerSqm: z.number().positive().optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(), strainLimit: z.number().positive().optional(),
});
const pointRef = z.object({ pattern: z.string(), point: z.string() });
const constraint = z.object({ id: z.string(), name: z.string().optional(), type: z.enum(['distance', 'length']), target: z.number().nonnegative(), tolerance: z.number().nonnegative().optional(), a: pointRef.optional(), b: pointRef.optional(), pattern: z.string().optional(), segments: z.array(z.string()).optional(), contour: z.number().int().nonnegative().optional() });
const annotation = z.object({ id: z.string(), type: z.enum(['dart', 'pleat', 'fold_line']), pattern: z.string(), lines: z.array(z.array(z.string()).length(2)).min(1), label: z.string().optional(), angle: z.number().min(-180).max(180).optional() });
const grade = z.object({ size: z.string(), rules: z.array(z.object({ pattern: z.string(), point: z.string(), dx: z.number(), dy: z.number() })) });
const drapeOptions = z.object({ target: z.number().min(5).max(100).optional().describe('Mesh edge length, mm (25)'), steps: z.number().int().positive().optional().describe('Most solver steps to run (600)'), tolerance: z.number().positive().optional().describe('Settled when the cloth moves less than this, mm per step root mean square (0.02)') });
const drapePoint = z.object({ pattern: z.string(), point: z.string().optional(), at: z.array(z.number()).length(2).optional() });
const edge = ref.extend({ contour: z.number().int().nonnegative().optional() });
const spot = z.object({ pattern: z.string(), u: z.number().optional(), v: z.number().optional(), point: z.string().optional(), segment: z.string().optional(), t: z.number().min(0).max(1).optional(), inset: z.number().optional() });
const trimShape = {
  id: z.string(), kind: z.string(), name: z.string().optional(), spec: z.record(z.any()).optional(), notes: z.string().optional(),
  qty: z.number().int().positive().optional(), supplier: z.string().optional(), partNumber: z.string().optional(), unitPrice: z.number().nonnegative().optional(), pricePerMeter: z.number().nonnegative().optional(),
  at: spot.optional(), along: z.array(edge).min(1).optional(), path: z.object({ pattern: z.string(), points: z.array(z.union([z.string(), z.array(z.number()).length(2)])).min(2).optional(), line: z.string().optional(), closed: z.boolean().optional() }).optional(), elastic: z.string().optional(),
  mate: z.union([spot, z.array(edge).min(1)]).optional(), flip: z.boolean().optional(), closed: z.boolean().optional(),
  count: z.number().int().positive().optional(), pitch: z.number().positive().optional(), margin: z.union([z.number().nonnegative(), z.array(z.number().nonnegative()).length(2)]).optional(), inset: z.number().optional(), mateInset: z.number().optional(),
  length: z.number().positive().optional(), hardware: z.array(z.object({ kind: z.string(), id: z.string().optional(), name: z.string().optional(), qty: z.number().int().positive().optional(), unitPrice: z.number().nonnegative().optional(), supplier: z.string().optional(), partNumber: z.string().optional(), at: z.union([z.number(), z.string()]).optional(), spec: z.record(z.any()).optional() })).optional(),
};
const trim = z.object(trimShape);
// An update names only what changes; null takes a field (or a spec key) away.
const trimPatch = z.object(Object.fromEntries(Object.entries(trimShape).map(([k, v]) => [k, v.nullable()]))).partial();
const avatar = z.object({ height: z.number().positive(), chest: z.number().positive(), depth: z.number().positive().optional(), shoulders: z.number().positive().optional(), ease: z.number().nonnegative().optional() });

const GUIDE = `Prompt-first softgoods design. Write the complete structured design, then the user reviews it draped in 3D and exports manufacturing patterns and a tech pack. The 2D pattern is authoritative; simulation never changes it. All lengths are mm.

Patterns. Every point, segment, pattern and seam has a stable descriptive id. A contour is an ordered closed loop of segment ids: each segment's b point must equal the next segment's a. Segment types: line(a,b), arc(a,b,c centre, counter-clockwise), bezier(a,b,c1,c2). allowances maps segment id to mm. notches identify a segment and normalized at 0..1. grain.angle is degrees from +x in the flat pattern. Design for manufacture: name materials, cut quantities, allowances, notches and seams, and use several simple panels with intentional seams rather than one ornamental contour.

Seams join {pattern,segment} to {pattern,segment}, never array positions. A side may also be part of an edge, {pattern, segment, from, to} with from and to fractions 0..1 of its length, or several edges that follow one another along the outline, {pattern, segments:[ids], from?, to?} (from on the first, to on the last): one long edge sewn to two shorter ones, a pocket sewn to the middle of a panel edge. flip:true pairs the start of one side with the end of the other, which is the usual case for two panels facing each other. A plain seam's two sides must be the same length within ease (a ratio, 0.03 = 3%); kind 'gather' or 'elastic' may differ on purpose.

Checks. constraints are named measurements the design must hold: {type:'distance', a:{pattern,point}, b:{pattern,point}, target, tolerance} or {type:'length', pattern, segments:[ids] | contour:index, target, tolerance}. annotations mark a dart, pleat or fold_line as point-pair lines on a pattern. grades are the other sizes: {size:'L', rules:[{pattern, point, dx, dy}]} moves named points of the base size. Every set and get returns check: each measurement against its target and both sides of every seam, at the base size and every graded size. Fix what it reports before exporting.

Materials are what the cloth preview uses: arealDensity g/m², thickness mm, tensile {warp, weft} N per mm of width at 100% strain, shearRigidity N/mm, rigidity N·mm (bending: one number or {warp, weft}; a cantilever of it droops what a beam does, and a fabric without one only hangs. Roughly 0.01-0.1 light woven, 0.1-1 canvas and coated cordura, 1-20 webbing and leather, 100+ foam panels), friction 0..1 against the body, damping 0..1. A material may start from the fabric library: {preset: '<id>', ...your own fields over it}. Presets: ${Object.keys(FABRICS).join(', ')}. Their values are typical, NOT measured (each says source: 'typical, not measured') and a number nobody could vouch for is simply absent: use them to start, and put the supplier's or your measured figures over them before trusting a weight or a drape.

Production. A material may carry rollWidth (usable mm, 1500 assumed without one) and pricePerMeter (per running metre of roll) or pricePerSqm. A pattern is cut its cut quantity of times; mirror:true flips every second copy (cut 2, mirror: a left and a right). The export can lay markers (the cut pieces nested on the roll, grain along it, with yield), write a bill of materials (cloth by net and consumed area, weight, cost, seam length by kind, a thread estimate), a 1:1 tiled print and SVGs.

Internal lines. internalLines on a pattern are lines drawn on the piece (a stitch line, a pocket placement): a point pair [a, b] or {id, type: line|arc|bezier, a, b, c | c1, c2} using the pattern's own points. They must stay on the material and are exported on the DXF layer INTERNAL.

Seam kinds. kind is free text; these are known, with the stitch rows the thread estimate counts and the least allowance the check warns below: ${Object.entries(SEAM_KINDS).map(([k, v]) => `${k} (${v.rows} row${v.rows > 1 ? 's' : ''}, usually ${v.allowance} mm, at least ${v.min})`).join(', ')}.

Trims and hardware are trims: [{id, kind, spec, ...placement}], kept on a set only if you send them back. Add, change and remove one at a time with cadgang_softgoods_trim, which explains placement and returns each trim's derived length and positions.

Edits. cadgang_softgoods_edit does one pattern-making operation on the stored design, so a mirror, split, dart or pleat does not mean rewriting every point: use it to change a design, and set to write a new one.

3D. z is up, the body stands on z = 0 facing -y. Give avatar {height, chest, ...} and each pattern placement {region: front|back|left|right, anchor: 'shoulder' to hang its top edge at the shoulder line (a garment hung from shoulder seams), layer, offset:[x,y,z]} and the pieces are stood around the body, centred on their region; arrangement rows are then not needed. Without placement, arrangement gives {pattern, position:[x,y,z], rotation:[rx,ry,rz] degrees about x then y then z, layer}; a piece with neither is laid flat beside the others. The preview is an XPBD cloth: its strain and pressure maps point at tight places, they are not a fit guarantee.

Physics, for the preview only: none of it changes a cutting pattern, and check.physics reports on each. Elastic: a seam's elastic {ratio, stiffness}, or an entry in elastics {id, pattern, segment | line, ratio, stiffness} (line is [pointId, pointId] or the id of a straight internal line), relaxes to ratio (0 to 1) of the cloth it is sewn to and gathers the cloth beside it; stiffness is newtons at twice its relaxed length (a waistband elastic is roughly 5 to 10). Tacks and pins: an attachment holds the pattern point at:[x,y] to a world point to:[x,y,z], or to a point of cloth with to:{pattern, at:[x,y]} (a tack); exact:true holds that very point and not the nearest mesh vertex, strength (N/mm) makes it a spring. Stuffing: stuffing [{id, patterns:[ids], pressure | volume}] pushes the sewn pieces that enclose a volume outward with a pressure in Pa (a pillow is about 50 to 300; the preview keeps cloth taut up to about 400), or fills them toward a volume in litres. Folds: angle (degrees) on a fold_line or pleat annotation creases the cloth along its lines, 0 flat and 90 a right angle, positive toward the face of the pattern (the outside of a piece placed on the body); a pleat's lines fold one way and then the other, so 90 stands a pleat made by the pleat edit square to the cloth; only a fabric with a rigidity carries the fold beyond the crease. Finishing, per pattern: shrink {warp, weft} in percent, freeze:true holds the piece where it is arranged, strengthen multiplies its stiffness. Layers: a piece on a higher layer starts farther from the body and stays outside the pieces on lower ones, a shell over its lining. The server's drape (the GLB, OBJ, measurements and fit report) simulates all of it, and the bill lists each elastic's cut length under trims.

The draped result. cadgang_softgoods_export with formats adds the settled drape to the patterns: 'glb' and 'obj' (one mesh per piece, named, with normals, the pattern coordinate as its texture coordinate at 1 unit per textureMm, a material per fabric in its color '#rrggbb'; metres, +Y up, front +Z; thickness: true makes each piece a shell of its fabric's thickness, avatar: true adds the body) and 'fit' (a fit report as JSON and in the tech pack). cadgang_softgoods_measure measures the drape. cadgang_softgoods_get with fit: true returns the fit report with the check: per piece and overall strain percentiles in % against the fabric's strainLimit (a ratio, 0.05 when it gives none), contact pressure percentiles in kPa, the share of cloth touching the body, and ease at the avatar's chest, waist and hip (garment circumference less body circumference, mm; positive is loose). Each of these drapes the design on the server first, which takes seconds; one drape is shared by all of them until the design changes.`;

const EDIT_GUIDE = `One pattern-making operation on the stored softgoods design (read it first with cadgang_softgoods_get). Existing ids keep their meaning; the result lists the ids the edit added and removed, the new revision and the check. Lengths are mm. A place on an outline is a point id, or {segment, at} with at a fraction 0..1 of that segment's length; cutting a segment keeps its id on the first part and names the second <id>_2, and a seam on a cut segment becomes two seams (<seam> and <seam>_2) with the edge it sews to cut at the matching place. A seam that sews a span (part of an edge, or several edges) stays one seam, its span running over both parts; an edit that would open or cut the outline in the middle of a sewn span is refused, so re-sew that seam first.

action:
- mirror {pattern, segment | axis: 'x'|'y'|{a:[x,y], b:[x,y]}, id?, name?, seam?}: a mirrored copy, the other hand of a left or right piece. Across one of its segments, or an axis ('y', the default, flips left-right in place). Its ids swap the pattern's name for the copy's (front_top becomes front_mirror_top). seam:true with segment sews the copy to the original along that segment. Darts, pleats, notches, allowances, grain, internal lines and graded sizes are copied; seams to other pieces are not.
- unfold {pattern, segment}: a half pattern cut on the fold becomes the whole piece. segment is the straight fold edge: it disappears and the outline continues as its mirror image (<id>_m). When two pieces sewn to each other have both been unfolded, the mirrored halves are sewn the same way (<seam>_m).
- split {pattern, from, to, ids?: [a, b], names?, allowance?}: cut a piece in two along a straight line between two places on its outer edge. The pieces are <pattern>_a (the outline from 'from' round to 'to') and <pattern>_b, their cut edges <pattern>_cut are sewn to each other, and seams, measurements, graded sizes, notches and marks follow their edges. Points and segments keep their ids.
- dart {pattern, segment, at, width, length | apex:[x,y], id?}: a sewn dart. width is its mouth along the edge, centred on 'at'; length is its depth, square to the edge. The mouth leaves the outline, the two legs (<id>_leg_a, <id>_leg_b, meeting at <id>_apex) join it and are sewn to each other by seam <id>, so the preview closes it. The edge is shorter by the width once sewn: an edge that was already sewn to another is re-sewn on either side of the dart, and the check then reports that seam's two lengths so you can true them. The DXF cuts straight across the mouth and marks the legs on DART.
- pleat {pattern, segment, at, intake, kind: 'knife'|'box', to?, bothEnds?, id?}: slash the piece straight across from 'at' on the edge (to the place opposite, or to 'to') and spread it by intake mm. The extra cloth is folded and sewn shut at the edge by seam <id> (a box pleat: <id>_1 and <id>_2), so the sewn edge keeps its length; bothEnds:true sews the far edge too. The fold lines are a pleat annotation.
- slashSpread {pattern, from, pivot, angle | distance, id?}: add flare. Slash from 'from' to 'pivot' on the far edge and open it by an angle in degrees, or by a distance in mm at 'from'. The pivot edge keeps its length; the opened edge gains segment <id> (default <pattern>_spread).
- internalLine {pattern, a, b, c? | c1?, c2?, id?} or {pattern, id, remove:true}: draw a line on a piece. a, b and the arc centre c or bezier handles c1, c2 are point ids, or [x, y] to make a point.
- autoNotch {seams?: [ids], fractions?: [0..1], every?: mm, ends?, depth?}: matched notches on both sides of every seam (or the named ones): at its ends, and at fractions (default the middle) or every so many mm of side a. The other side's notch is where the seam's flip, ease and correspondence put it. Running it again adds nothing.`;
const xy = z.array(z.number()).length(2), place = z.union([z.string(), z.object({ segment: z.string(), at: z.number().min(0).max(1) })]), pointOrXY = z.union([z.string(), xy]);

const TRIMS = `Trims and hardware on the softgoods design: one trim per call, placed by pattern, segment and point ids. All lengths mm. Every answer is the whole list, each trim with its derived geometry (lengthMm measured on the pattern, cutLengthMm to buy or cut, positions and mate positions in pattern mm, count per unit) and the check.

Kinds. At a spot: ${Object.keys(TRIM_KINDS).filter((k) => TRIM_KINDS[k].place === 'point').join(', ')}; any other kind (cord-lock, toggle, hook...) is hardware at a spot. Along a length: ${Object.keys(TRIM_KINDS).filter((k) => TRIM_KINDS[k].place === 'length').join(', ')}.

Placement, exactly one of:
- at: one spot. {pattern, u, v} in pattern mm, {pattern, point}, or {pattern, segment, t 0..1, inset mm into the piece}.
- along: a run of edges measured as one length. Each entry is written like a seam side: {pattern, segment, from?, to?}, or {pattern, segments: [ids that follow one another], from?, to?} with from a fraction of the first and to of the last; or {pattern, contour: 0} for a whole outline (binding all round).
- path: a line on a piece, {pattern, points: [point id | [x, y], ...], closed?} or {pattern, line: '<id of one of its internalLines>'}. For webbing sewn across a panel or a topstitch row that follows no edge.
- elastic (kind elastic only): the id of the design's own elastic, an elastics[] entry or a seam with elastic. The cloth preview gathers by that entry's ratio and the trim adds what is bought: width, cut length, price. An elastic trim added along one whole segment, or on a path between two point ids, with spec.ratio makes that elastics[] entry itself (same id) and points at it; updating its spec.ratio changes the entry, removing the trim removes it.
A point trim along an edge is a row: give count or pitch (and margin, one number or [start, end], for the first and last; without it a count is spread with half a pitch at each end) and inset for how far in from the edge.
mate is the other half: for a row, the edge the buttonholes or sockets go on (they land at the same fractions; flip: true when the two edges are drawn in opposite directions, as with a seam); for one spot, another spot; for a zipper or hook-and-loop, the second edge. A zipper whose two sides differ in length fails the check.
closed: a zipper, hook-and-loop, button or snap with a mate is closed in the cloth preview (the zipper as a seam between its two edges, each button or snap as a tack to its mate); closed: false leaves it open, a jacket worn unzipped. Any other trim with a mate closes only with closed: true. A closure that fails its check (a zipper whose sides differ) is left open in the preview.
Trims follow cadgang_softgoods_edit: one on an edge that is cut (a dart, a pleat, a split) runs over both parts, and a piece cut in two takes its trims to the half they sit on. mirror and unfold do not copy trims: add the other hand's.

spec holds what the thing is; all of it shows in the tech pack. Keys that change the result:
- button: diameter (required), thickness (3), buttonholeLength (diameter + thickness), buttonhole 'parallel' (default) or 'perpendicular' to the edge.
- snap, rivet, eyelet, grommet: diameter. label: width, height.
- zipper: chain ('#5'), tapeWidth (whole closed tape; typical widths are assumed for #3 25, #5 32, #8 38, #10 40), separating, sliders, lengths ([150, 180, 200...]: cutLengthMm snaps to the nearest and the check says how far off it is), allowance (least seam allowance on its edges; default three quarters of one tape side).
- binding: finishedWidth, tapeWidth, overlap, cornerAllowance per corner (corners are counted). piping: flange.
- elastic: width, overlap, and ratio (relaxed length over the edge it is sewn to, 0.8 = 20% shorter) unless it points at the design's own elastic. drawcord: width (the channel), tailLengths [start, end].
- topstitch: rows, offset (from the edge: 6, or 0 on a path), spacing between rows (6), stitchLength. Counted in the thread estimate.
- webbing, hook-and-loop: width, offset, tailLengths [start, end] free beyond the sewn part, bartacks (false for none), bartackInset. hardware: [{kind: 'buckle' | 'ladder-lock' | 'd-ring' | ..., qty, unitPrice, partNumber, at}] is what is threaded on it.
- For the cloth preview: mass (g, a point trim), massPerMeter (g), rigidity (N·mm), strength (N/mm, how hard a button or snap holds).
Sizes go in spec, not beside it. length (beside spec) overrides the derived cut length. qty overrides the count per unit, which is otherwise the marks × the cut quantity of the piece. unitPrice (each) or pricePerMeter, supplier and partNumber fill the bill of materials.

Exports. The pattern DXFs gain layers DRILL (a cross and a POINT at each button, snap, rivet, eyelet), TRIM (zipper tape and binding extents, webbing outlines and centre lines, buttonholes, labels) and TOPSTITCH (rows, bartacks); the 1:1 print and the marker draw them; the astm-style DXF puts drill POINTs on layer 13 and the rest on 8. The tech pack gains a trims schedule and a placement drawing per piece, and the bill of materials counts, lengths and costs. A design without trims exports exactly as before.`;

export function registerSoftgoodsTools(server, { call, ok, fail }) {
  server.registerTool('cadgang_softgoods_trim', {
    title: 'Add, change, remove or list softgoods trims and hardware', description: TRIMS,
    inputSchema: {
      action: z.enum(['add', 'update', 'remove', 'list']),
      id: z.string().optional().describe('The trim to update or remove.'),
      trim: trimPatch.optional().describe('add: the whole trim (id, kind, spec and one placement). update: only the fields that change; spec is merged key by key and null removes a field.'),
    }, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async ({ action, id, trim: body }) => {
    try {
      if (action === 'list') return ok(await call('/softgoods/trims'));
      if (action === 'add') return ok(await call('/softgoods/trims', { method: 'POST', body: body || {} }));
      if (!id) throw new Error(`${action} needs the id of the trim`);
      return ok(await call(`/softgoods/trims/${encodeURIComponent(id)}`, action === 'remove' ? { method: 'DELETE' } : { method: 'PATCH', body: body || {} }));
    } catch (e) { return fail(e); }
  });

  server.registerTool('cadgang_softgoods_get', {
    title: 'Get the softgoods design', description: `${GUIDE}\n\nReturns the complete persistent design and its check.`, inputSchema: { fit: z.boolean().optional().describe('Also drape the design and return its fit report in check.fit (takes seconds)') },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ fit } = {}) => { try { return ok({ ...(await call('/softgoods/document')), check: await call(`/softgoods/check${fit ? '?fit=1' : ''}`) }); } catch (e) { return fail(e); } });

  server.registerTool('cadgang_softgoods_set', {
    title: 'Set the prompt-authored softgoods design', description: `${GUIDE}\n\nReplace the complete design after translating the user's description into manufacturing patterns, seams, attachments and a 3D arrangement. Read the current design first when editing it.`,
    inputSchema: {
      materials: z.record(material).optional(),
      patterns: z.array(pattern),
      seams: z.array(z.object({ id: z.string(), a: ref, b: ref, flip: z.boolean().optional(), ease: z.number().nonnegative().optional(), kind: z.string().optional(), correspondence: z.array(z.any()).optional(), elastic: z.object(elastic).optional() })),
      attachments: z.array(z.object({ id: z.string(), pattern: z.string(), at: z.array(z.number()).length(2), to: z.union([z.array(z.number()).length(3), z.object({ pattern: z.string(), at: z.array(z.number()).length(2) })]), kind: z.string().optional(), exact: z.boolean().optional(), strength: z.number().positive().optional() })).optional(),
      elastics: z.array(z.object({ id: z.string(), pattern: z.string(), segment: z.string().optional(), line: z.union([z.string(), z.array(z.string()).length(2)]).optional(), ...elastic })).optional(),
      stuffing: z.array(z.object({ id: z.string(), patterns: z.array(z.string()).min(1), pressure: z.number().nonnegative().optional(), volume: z.number().positive().optional() })).optional(),
      arrangement: z.array(z.object({ pattern: z.string(), position: z.array(z.number()).length(3), rotation: z.array(z.number()).length(3), layer: z.number().optional() })).optional(),
      constraints: z.array(constraint).optional(), annotations: z.array(annotation).optional(), grades: z.array(grade).optional(), trims: z.array(trim).optional(), avatar: avatar.optional(),
    }, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ avatar: body, ...design }) => { try { const d = await call('/softgoods/document', { method: 'PUT', body: { version: 1, ...design, simulation: { status: 'not_run', ...(body ? { avatar: body } : {}) } } }); return ok({ revision: d.revision, patterns: d.patterns.length, seams: d.seams.length, avatar: d.simulation?.avatar || null, arrangement: d.arrangement, check: await call('/softgoods/check') }); } catch (e) { return fail(e); } });

  server.registerTool('cadgang_softgoods_edit', {
    title: 'Edit the softgoods patterns: mirror, unfold, split, dart, pleat, slash and spread, internal lines, notches', description: EDIT_GUIDE,
    inputSchema: {
      action: z.enum(['mirror', 'unfold', 'split', 'dart', 'pleat', 'slashSpread', 'internalLine', 'autoNotch']),
      pattern: z.string().optional(), segment: z.string().optional(), at: z.number().min(0).max(1).optional(), id: z.string().optional(), name: z.string().optional(),
      axis: z.union([z.enum(['x', 'y']), z.object({ a: xy, b: xy })]).optional(), seam: z.boolean().optional(),
      from: place.optional(), to: place.optional(), pivot: place.optional(), ids: z.array(z.string()).length(2).optional(), names: z.array(z.string()).length(2).optional(), allowance: z.number().nonnegative().optional(),
      width: z.number().positive().optional(), length: z.number().positive().optional(), apex: xy.optional(),
      intake: z.number().positive().optional(), kind: z.enum(['knife', 'box']).optional(), bothEnds: z.boolean().optional(),
      angle: z.number().positive().optional(), distance: z.number().positive().optional(),
      a: pointOrXY.optional(), b: pointOrXY.optional(), c: pointOrXY.optional(), c1: pointOrXY.optional(), c2: pointOrXY.optional(), remove: z.boolean().optional(),
      seams: z.array(z.string()).optional(), fractions: z.array(z.number().min(0).max(1)).optional(), every: z.number().positive().optional(), ends: z.boolean().optional(), depth: z.number().positive().optional(),
    }, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async ({ action, ...args }) => { try { return ok(await call('/softgoods/edit', { method: 'POST', body: { op: action, ...args } })); } catch (e) { return fail(e); } });

  server.registerTool('cadgang_softgoods_export', {
    title: 'Export softgoods patterns and tech pack', description: 'Write one DXF per authoritative pattern (STITCH geometry, the closed CUT contour at each edge\'s seam allowance, notches, grain, internal lines, darts, pleats and folds), one more per pattern for every graded size, and JSON and printable HTML tech packs (the tech pack includes the bill of materials). Returns the files and what the check still reports.\n\nformats adds production outputs: "marker" nests every cut piece of each material on its roll (a DXF and an SVG per material; returns length, yield and length per unit; fails if a piece is wider than the roll), "bom" writes the bill of materials as JSON and HTML, "print" writes one HTML of 1:1 tiled pages (print at 100%; page 1 has 100 mm and 4 inch check squares), "svg" writes one 1:1 SVG per pattern and graded size.\n\nformats also takes the draped garment, in the same request: "glb" (<name>_drape.glb) and "obj" (<name>_drape.obj and .mtl), both in metres with +Y up and the pattern coordinate as texture coordinate, and "fit" (<name>_fit.json and a FIT section in the tech pack). The drape is run on the server until the cloth settles; the result says whether it did.',
    inputSchema: {
      name: z.string().regex(/^[\w.-]+$/),
      formats: z.array(z.enum(['marker', 'bom', 'print', 'svg', 'glb', 'obj', 'fit'])).optional(),
      dxf: z.enum(['astm-style', 'aama-style']).optional().describe('Also write one DXF per size with every piece as a block on the numbered ASTM D6673 layers (1 boundary, 4 notches, 7 grain, 8 internal lines, 11 cutouts, 14 sew lines, 15 annotation; with trims, 13 drill holes as POINTs and trim lines on 8). The layer numbers follow a published summary of the standard; the text labels, notch entities and units are not checked against it, and the mandatory validation layers 84-87 are not written. The result lists the mapping as astmStyle.'),
      width: z.union([z.number().positive(), z.record(z.number().positive())]).optional().describe('Usable roll width mm, for every material or {material: mm}. Default: the material\'s rollWidth, else 1500.'),
      gap: z.number().nonnegative().optional().describe('Clear distance between pieces on the marker, mm. Default 3.'),
      turns: z.union([z.literal(180), z.literal(0), z.literal(90), z.literal('free')]).optional().describe('180 (default): grain along the roll, either way up. 0: napped cloth, one way only. 90: quarter turns too. free: any angle, for cloth with no direction.'),
      sizes: z.union([z.array(z.string()), z.record(z.number().int().positive())]).optional().describe('Sizes on the marker, bill and print: ["base", "L"] or units of each {base: 1, L: 2}. "base" is the pattern as drawn. Default: base only.'),
      threadMultiplier: z.union([z.number().positive(), z.record(z.number().positive())]).optional().describe('mm of thread per mm of seam: one number or by seam kind {plain: 2.5, overlock: 14, default: 2.5}. Default 2.5 (lockstitch rule of thumb).'),
      paper: z.enum(['a4', 'letter']).optional(), orientation: z.enum(['portrait', 'landscape']).optional(),
      margin: z.number().nonnegative().optional().describe('Unprinted border of each page, mm. Default 10.'), overlap: z.number().nonnegative().optional().describe('Strip shared by neighbouring pages, mm. Default 10.'),
      thickness: z.boolean().optional().describe('glb and obj: each piece as a shell of its fabric\'s thickness, not a single surface'), avatar: z.boolean().optional().describe('glb and obj: add the avatar\'s body shapes as a separate node'),
      textureMm: z.number().positive().optional().describe('glb and obj: mm of cloth per texture coordinate unit, 1000 unless given'), drape: drapeOptions.optional(),
    }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (body) => { try { return ok(await call('/softgoods/export', { method: 'POST', body })); } catch (e) { return fail(e); } });

  server.registerTool('cadgang_softgoods_measure', {
    title: 'Measure the draped softgoods design', description: `Drape the design on the server (seconds; shared with export and fit until the design changes) and measure it, in mm. Each measure is one of:
{type:'distance', a, b}: the shortest way along the cloth between two pattern points, each {pattern, point: id} or {pattern, at:[x,y]}; it crosses seams where the pieces are sewn. Also the straight-line distance, and on one piece the flat pattern distance and the stretch between them.
{type:'circumference', height} or {type:'circumference', level:'chest'|'waist'|'hip'|'shoulder'}: the cloth cut by a horizontal plane (z up, the floor is 0): every loop with its length, whether it closes and whether it goes round the body.
{type:'edge', pattern, segment}: a pattern segment's length in the drape against its flat length. {type:'seam', seam}: both sides of a seam so measured, and the widest gap left between them.
{type:'bounds'}: the box round the draped cloth.
A measure that cannot be answered returns its error; the others still answer.`,
    inputSchema: { measures: z.array(z.object({ type: z.enum(['distance', 'circumference', 'edge', 'seam', 'bounds']), a: drapePoint.optional(), b: drapePoint.optional(), height: z.number().optional(), level: z.string().optional(), pattern: z.string().optional(), segment: z.string().optional(), seam: z.string().optional() })).min(1), drape: drapeOptions.optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (body) => { try { return ok(await call('/softgoods/measure', { method: 'POST', body })); } catch (e) { return fail(e); } });
}
