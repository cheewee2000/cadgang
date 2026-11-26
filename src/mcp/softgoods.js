import { z } from 'zod';
import { FABRICS } from '../core/softgoods-fabrics.js';

const ref = z.object({ pattern: z.string(), segment: z.string() });
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
});
const material = z.object({
  name: z.string().optional(), arealDensity: z.number().positive().optional(), weight: z.number().positive().optional(), thickness: z.number().positive().optional(),
  rigidity: z.union([z.number().positive(), z.object({ warp: z.number().positive(), weft: z.number().positive() })]).optional(),
  tensile: z.object({ warp: z.number().positive().optional(), weft: z.number().positive().optional() }).optional(), shearRigidity: z.number().positive().optional(),
  damping: z.number().min(0).max(1).optional(), friction: z.number().min(0).max(1).optional(), notes: z.string().optional(),
  weightGsm: z.number().positive().optional(), thicknessMm: z.number().positive().optional(),
  preset: z.string().optional(), source: z.string().optional(), rollWidth: z.number().positive().optional(), pricePerMeter: z.number().positive().optional(), pricePerSqm: z.number().positive().optional(),
});
const pointRef = z.object({ pattern: z.string(), point: z.string() });
const constraint = z.object({ id: z.string(), name: z.string().optional(), type: z.enum(['distance', 'length']), target: z.number().nonnegative(), tolerance: z.number().nonnegative().optional(), a: pointRef.optional(), b: pointRef.optional(), pattern: z.string().optional(), segments: z.array(z.string()).optional(), contour: z.number().int().nonnegative().optional() });
const annotation = z.object({ id: z.string(), type: z.enum(['dart', 'pleat', 'fold_line']), pattern: z.string(), lines: z.array(z.array(z.string()).length(2)).min(1), label: z.string().optional() });
const grade = z.object({ size: z.string(), rules: z.array(z.object({ pattern: z.string(), point: z.string(), dx: z.number(), dy: z.number() })) });
const avatar = z.object({ height: z.number().positive(), chest: z.number().positive(), depth: z.number().positive().optional(), shoulders: z.number().positive().optional(), ease: z.number().nonnegative().optional() });

const GUIDE = `Prompt-first softgoods design. Write the complete structured design, then the user reviews it draped in 3D and exports manufacturing patterns and a tech pack. The 2D pattern is authoritative; simulation never changes it. All lengths are mm.

Patterns. Every point, segment, pattern and seam has a stable descriptive id. A contour is an ordered closed loop of segment ids: each segment's b point must equal the next segment's a. Segment types: line(a,b), arc(a,b,c centre, counter-clockwise), bezier(a,b,c1,c2). allowances maps segment id to mm. notches identify a segment and normalized at 0..1. grain.angle is degrees from +x in the flat pattern. Design for manufacture: name materials, cut quantities, allowances, notches and seams, and use several simple panels with intentional seams rather than one ornamental contour.

Seams join {pattern,segment} to {pattern,segment}, never array positions. flip:true pairs the start of one side with the end of the other, which is the usual case for two panels facing each other. A plain seam's two sides must be the same length within ease (a ratio, 0.03 = 3%); kind 'gather' or 'elastic' may differ on purpose.

Checks. constraints are named measurements the design must hold: {type:'distance', a:{pattern,point}, b:{pattern,point}, target, tolerance} or {type:'length', pattern, segments:[ids] | contour:index, target, tolerance}. annotations mark a dart, pleat or fold_line as point-pair lines on a pattern. grades are the other sizes: {size:'L', rules:[{pattern, point, dx, dy}]} moves named points of the base size. Every set and get returns check: each measurement against its target and both sides of every seam, at the base size and every graded size. Fix what it reports before exporting.

Materials are what the cloth preview uses: arealDensity g/m², thickness mm, tensile {warp, weft} N per mm of width at 100% strain, shearRigidity N/mm, rigidity N·mm (bending: one number or {warp, weft}; a cantilever of it droops what a beam does, and a fabric without one only hangs. Roughly 0.01-0.1 light woven, 0.1-1 canvas and coated cordura, 1-20 webbing and leather, 100+ foam panels), friction 0..1 against the body, damping 0..1. A material may start from the fabric library: {preset: '<id>', ...your own fields over it}. Presets: ${Object.keys(FABRICS).join(', ')}. Their values are typical, NOT measured (each says source: 'typical, not measured') and a number nobody could vouch for is simply absent: use them to start, and put the supplier's or your measured figures over them before trusting a weight or a drape.

Production. A material may carry rollWidth (usable mm, 1500 assumed without one) and pricePerMeter (per running metre of roll) or pricePerSqm. A pattern is cut its cut quantity of times; mirror:true flips every second copy (cut 2, mirror: a left and a right). The export can lay markers (the cut pieces nested on the roll, grain along it, with yield), write a bill of materials (cloth by net and consumed area, weight, cost, seam length by kind, a thread estimate), a 1:1 tiled print and SVGs.

3D. z is up, the body stands on z = 0 facing -y. Give avatar {height, chest, ...} and each pattern placement {region: front|back|left|right, anchor: 'shoulder' to hang its top edge at the shoulder line (a garment hung from shoulder seams), layer, offset:[x,y,z]} and the pieces are stood around the body, centred on their region; arrangement rows are then not needed. Without placement, arrangement gives {pattern, position:[x,y,z], rotation:[rx,ry,rz] degrees about x then y then z, layer}; a piece with neither is laid flat beside the others. The preview is an XPBD cloth: its strain and pressure maps point at tight places, they are not a fit guarantee.`;

export function registerSoftgoodsTools(server, { call, ok, fail }) {
  server.registerTool('cadgang_softgoods_get', {
    title: 'Get the softgoods design', description: `${GUIDE}\n\nReturns the complete persistent design and its check.`, inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => { try { return ok({ ...(await call('/softgoods/document')), check: await call('/softgoods/check') }); } catch (e) { return fail(e); } });

  server.registerTool('cadgang_softgoods_set', {
    title: 'Set the prompt-authored softgoods design', description: `${GUIDE}\n\nReplace the complete design after translating the user's description into manufacturing patterns, seams, attachments and a 3D arrangement. Read the current design first when editing it.`,
    inputSchema: {
      materials: z.record(material).optional(),
      patterns: z.array(pattern),
      seams: z.array(z.object({ id: z.string(), a: ref, b: ref, flip: z.boolean().optional(), ease: z.number().nonnegative().optional(), kind: z.string().optional(), correspondence: z.array(z.any()).optional() })),
      attachments: z.array(z.object({ id: z.string(), pattern: z.string(), at: z.array(z.number()).length(2), to: z.array(z.number()).length(3), kind: z.string().optional() })).optional(),
      arrangement: z.array(z.object({ pattern: z.string(), position: z.array(z.number()).length(3), rotation: z.array(z.number()).length(3), layer: z.number().optional() })).optional(),
      constraints: z.array(constraint).optional(), annotations: z.array(annotation).optional(), grades: z.array(grade).optional(), avatar: avatar.optional(),
    }, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ avatar: body, ...design }) => { try { const d = await call('/softgoods/document', { method: 'PUT', body: { version: 1, ...design, simulation: { status: 'not_run', ...(body ? { avatar: body } : {}) } } }); return ok({ revision: d.revision, patterns: d.patterns.length, seams: d.seams.length, avatar: d.simulation?.avatar || null, arrangement: d.arrangement, check: await call('/softgoods/check') }); } catch (e) { return fail(e); } });

  server.registerTool('cadgang_softgoods_export', {
    title: 'Export softgoods patterns and tech pack', description: 'Write one DXF per authoritative pattern (STITCH geometry, the closed CUT contour at each edge\'s seam allowance, notches, grain, darts, pleats and folds), one more per pattern for every graded size, and JSON and printable HTML tech packs (the tech pack includes the bill of materials). Returns the files and what the check still reports.\n\nformats adds production outputs: "marker" nests every cut piece of each material on its roll (a DXF and an SVG per material; returns length, yield and length per unit; fails if a piece is wider than the roll), "bom" writes the bill of materials as JSON and HTML, "print" writes one HTML of 1:1 tiled pages (print at 100%; page 1 has 100 mm and 4 inch check squares), "svg" writes one 1:1 SVG per pattern and graded size.',
    inputSchema: {
      name: z.string().regex(/^[\w.-]+$/),
      formats: z.array(z.enum(['marker', 'bom', 'print', 'svg'])).optional(),
      dxf: z.literal('aama-style').optional().describe('Also write one DXF per size with every piece as a block on the numbered ASTM D6673 / AAMA layers (1 boundary, 4 notches, 7 grain, 8 internal lines, 11 cutouts, 14 sew lines, 15 annotation). The layer numbers follow a published summary of the standard; the text labels are not checked against it. The result lists the mapping.'),
      width: z.union([z.number().positive(), z.record(z.number().positive())]).optional().describe('Usable roll width mm, for every material or {material: mm}. Default: the material\'s rollWidth, else 1500.'),
      gap: z.number().nonnegative().optional().describe('Clear distance between pieces on the marker, mm. Default 3.'),
      turns: z.union([z.literal(180), z.literal(0), z.literal(90), z.literal('free')]).optional().describe('180 (default): grain along the roll, either way up. 0: napped cloth, one way only. 90: quarter turns too. free: any angle, for cloth with no direction.'),
      sizes: z.union([z.array(z.string()), z.record(z.number().int().positive())]).optional().describe('Sizes on the marker, bill and print: ["base", "L"] or units of each {base: 1, L: 2}. "base" is the pattern as drawn. Default: base only.'),
      threadMultiplier: z.union([z.number().positive(), z.record(z.number().positive())]).optional().describe('mm of thread per mm of seam: one number or by seam kind {plain: 2.5, overlock: 14, default: 2.5}. Default 2.5 (lockstitch rule of thumb).'),
      paper: z.enum(['a4', 'letter']).optional(), orientation: z.enum(['portrait', 'landscape']).optional(),
      margin: z.number().nonnegative().optional().describe('Unprinted border of each page, mm. Default 10.'), overlap: z.number().nonnegative().optional().describe('Strip shared by neighbouring pages, mm. Default 10.'),
    }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (body) => { try { return ok(await call('/softgoods/export', { method: 'POST', body })); } catch (e) { return fail(e); } });
}
