import { z } from 'zod';

const ref = z.object({ pattern: z.string(), segment: z.string() });
const point = z.object({ id: z.string(), x: z.number(), y: z.number() });
const segment = z.discriminatedUnion('type', [
  z.object({ id: z.string(), type: z.literal('line'), a: z.string(), b: z.string() }),
  z.object({ id: z.string(), type: z.literal('arc'), a: z.string(), b: z.string(), c: z.string() }),
  z.object({ id: z.string(), type: z.literal('bezier'), a: z.string(), b: z.string(), c1: z.string(), c2: z.string() }),
]);
const pattern = z.object({
  id: z.string(), name: z.string().optional(), material: z.string().optional(), cut: z.number().int().positive().optional(),
  points: z.array(point), segments: z.array(segment), contours: z.array(z.array(z.string()).min(3)),
  allowances: z.record(z.number().nonnegative()).optional(),
  notches: z.array(z.object({ segment: z.string(), at: z.number().min(0).max(1), depth: z.number().positive().optional(), kind: z.string().optional() })).optional(),
  grain: z.object({ angle: z.number() }).optional(), internalLines: z.array(z.any()).optional(),
});

const GUIDE = `Prompt-first softgoods design. Write the complete structured design, then the user reviews its 3D arrangement and exports manufacturing patterns and a tech pack. The 2D pattern is authoritative; simulation must never change it.

Every point, segment, pattern and seam has a stable descriptive id. A contour is an ordered closed loop of segment ids: each segment's b point must equal the next segment's a. Segment types: line(a,b), arc(a,b,c centre, counter-clockwise), bezier(a,b,c1,c2). Seam references are {pattern,segment}, never array positions. allowances maps segment id to mm. notches identify a segment and normalized at 0..1. grain.angle is degrees from +x in the flat pattern. arrangement positions and rotations are [x,y,z] in mm/degrees and layer controls overlap order.

Design for manufacture: name materials, cut quantities, allowances, notches and seams. Use several simple panels with intentional seams rather than one ornamental contour. The current 3D view is arrangement geometry; cloth simulation follows in a separate worker phase and is not yet a fit guarantee.`;

export function registerSoftgoodsTools(server, { call, ok, fail }) {
  server.registerTool('cadgang_softgoods_get', {
    title: 'Get the softgoods design', description: `${GUIDE}\n\nReturns the complete persistent design.`, inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => { try { return ok(await call('/softgoods/document')); } catch (e) { return fail(e); } });

  server.registerTool('cadgang_softgoods_set', {
    title: 'Set the prompt-authored softgoods design', description: `${GUIDE}\n\nReplace the complete design after translating the user's description into manufacturing patterns, seams, attachments and a 3D arrangement. Read the current design first when editing it.`,
    inputSchema: {
      materials: z.record(z.object({ name: z.string().optional(), weightGsm: z.number().positive().optional(), thicknessMm: z.number().positive().optional(), notes: z.string().optional() })).optional(),
      patterns: z.array(pattern),
      seams: z.array(z.object({ id: z.string(), a: ref, b: ref, flip: z.boolean().optional(), ease: z.number().nonnegative().optional(), kind: z.string().optional(), correspondence: z.array(z.any()).optional() })),
      attachments: z.array(z.object({ id: z.string(), pattern: z.string(), at: z.array(z.number()).length(2), to: z.array(z.number()).length(3), kind: z.string().optional() })).optional(),
      arrangement: z.array(z.object({ pattern: z.string(), position: z.array(z.number()).length(3), rotation: z.array(z.number()).length(3), layer: z.number().optional() })),
    }, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async (body) => { try { return ok(await call('/softgoods/document', { method: 'PUT', body: { version: 1, simulation: { status: 'not_run' }, ...body } })); } catch (e) { return fail(e); } });

  server.registerTool('cadgang_softgoods_export', {
    title: 'Export softgoods patterns and tech pack', description: 'Write one DXF per authoritative pattern plus JSON and printable HTML tech packs. The current export includes exact stitch geometry and per-edge allowance schedules; curved allowance offset joins are explicitly noted as not generated yet.',
    inputSchema: { name: z.string().regex(/^[\w.-]+$/) }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ name }) => { try { return ok(await call('/softgoods/export', { method: 'POST', body: { name } })); } catch (e) { return fail(e); } });
}
