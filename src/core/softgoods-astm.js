// An ASTM D6673 flavoured DXF: one file per size, one BLOCK per pattern piece, information on numbered layers.
// It is called "astm-style", not "ASTM" (and says nothing about the older AAMA-292, which the source read does not cover): the layer numbers below were checked against a published summary of
// ASTM D6673-10 (the Patro documentation's "DXF ASTM File Format" table; the standard itself is paywalled and was
// withdrawn in 2019), but the wording of the system text ("Piece Name:", "Size:", ...), drawing a notch as a line and
// the absence of turn/curve points (layers 2, 3), the quality-validation curves (84-87, which the standard marks mandatory)
// and a grade rule table are NOT
// verified against the standard. Try it in the receiving CAD before relying on it.

import { cutContours, capDarts, patternDXF, dxfFile } from './softgoods-export.js';
import { dxfEntities } from './softgoods-marker.js';
import { trimMarks } from './softgoods-trims.js';

/** What goes where, returned with the export so nobody has to guess. */
export const ASTM_STYLE = Object.freeze({
  layers: { 1: 'piece boundary (the closed CUT contour) and piece system text', 4: 'notches (a line from the cut edge inward)', 7: 'grain line', 8: 'internal lines: the piece\'s own internal lines, darts, pleats, folds and any other mark', 11: 'internal cutouts (CUT contours of holes)', 14: 'sew lines (STITCH)', 15: 'annotation text' },
  from: { CUT: '1 / 11', NOTCH: '4', GRAIN: '7', INTERNAL: '8', DART: '8', PLEAT: '8', FOLD: '8', STITCH: '14', TEXT: '15', ALLOWANCE: 'not written' },
  verified: 'Layer numbers against a published summary of ASTM D6673-10. Text labels, notch entities and units and closure rules are not verified; layers 2, 3, 5 and the mandatory validation curves 84-87 are not written; the file is DXF R12 where the standard says R13.',
});
/** The mapping for a design with trims: drill holes get layer 13, as a POINT each; trim extents and topstitch rows are internal lines. A design without trims keeps ASTM_STYLE and the file it always had. */
export const astmStyleOf = (document) => (document.trims?.length ? { ...ASTM_STYLE, layers: { ...ASTM_STYLE.layers, 13: 'drill holes: a POINT at every button, snap, rivet and eyelet' }, from: { ...ASTM_STYLE.from, DRILL: '13 (a POINT; the cross is not written)', TRIM: '8', TOPSTITCH: '8' } } : ASTM_STYLE);
const LAYER = { NOTCH: 4, GRAIN: 7, STITCH: 14 };
const area = (q) => Math.abs(q.reduce((sum, p, i) => sum + p[0] * q[(i + 1) % q.length][1] - q[(i + 1) % q.length][0] * p[1], 0));
const polyline = (q, layer, closed) => `0\nPOLYLINE\n8\n${layer}\n66\n1\n70\n${closed ? 1 : 0}\n${q.map((p) => `0\nVERTEX\n8\n${layer}\n10\n${p[0]}\n20\n${p[1]}\n30\n0`).join('\n')}\n0\nSEQEND\n8\n${layer}`;
const line = (a, b, layer) => `0\nLINE\n8\n${layer}\n10\n${a[0]}\n20\n${a[1]}\n30\n0\n11\n${b[0]}\n21\n${b[1]}\n31\n0`;
const text = (at, value, layer, height = 5) => `0\nTEXT\n8\n${layer}\n10\n${at[0]}\n20\n${at[1]}\n30\n0\n40\n${height}\n1\n${value}`;

/** Every pattern of the document (already at the wanted size) as a block, inserted side by side. */
export function astmStyleDXF(document, { name = 'softgoods', size = 'base', annotations = document.annotations || [] } = {}) {
  const blocks = [], entities = [text([0, -20], `Style Name: ${name}`, 1), text([0, -30], 'Units: METRIC', 1)]; let x = 0, drilled = false;
  for (const p of document.patterns) {
    const marks = annotations.filter((a) => a.pattern === p.id), contours = cutContours(capDarts(p, marks)), outer = contours.reduce((best, q) => (area(q) > area(best) ? q : best)), trims = trimMarks(document, p.id), { lines, texts } = dxfEntities(patternDXF(p, marks, trims));
    const xs = outer.map((q) => q[0]), ys = outer.map((q) => q[1]), minX = Math.min(...xs), minY = Math.min(...ys), body = [polyline(outer, 1, true), ...contours.filter((q) => q !== outer).map((q) => polyline(q, 11, true))];
    // Stitch lines end to end are one sew line; everything else stays the line it was, on its numbered layer.
    let chain = [];
    const flush = () => { if (chain.length) body.push(polyline(chain, 14, Math.hypot(chain[0][0] - chain.at(-1)[0], chain[0][1] - chain.at(-1)[1]) < 1e-6)); chain = []; };
    for (const l of lines) {
      if (l.layer === 'CUT' || l.layer === 'ALLOWANCE' || l.layer === 'DRILL') continue;
      if (l.layer !== 'STITCH') { body.push(line(l.a, l.b, LAYER[l.layer] || 8)); continue; }
      if (chain.length && Math.hypot(chain.at(-1)[0] - l.a[0], chain.at(-1)[1] - l.a[1]) > 1e-6) flush();
      if (!chain.length) chain.push(l.a); chain.push(l.b);
    }
    flush();
    for (const d of trims?.drills || []) { body.push(`0\nPOINT\n8\n13\n10\n${d.at[0]}\n20\n${d.at[1]}\n30\n0`); drilled = true; }
    const at = [(minX + Math.max(...xs)) / 2, (minY + Math.max(...ys)) / 2], system = [`Piece Name: ${p.name || p.id}`, `Size: ${size}`, `Quantity: ${p.cut || 1}`, `Material: ${p.material || ''}`];
    system.forEach((t, i) => body.push(text([at[0], at[1] - i * 8], t, 1)));
    // The pattern's own centre label says the same as the system text; the labels of darts, pleats and folds are annotation.
    for (const t of texts) if (!t.value.startsWith(`${p.name || p.id}  CUT `)) body.push(text(t.at, t.value, 15, t.height));
    blocks.push(`0\nBLOCK\n8\n1\n2\n${p.id}\n70\n0\n10\n0\n20\n0\n30\n0\n3\n${p.id}\n${body.join('\n')}\n0\nENDBLK\n8\n1`);
    entities.push(`0\nINSERT\n8\n1\n2\n${p.id}\n10\n${x - minX}\n20\n${-minY}\n30\n0`); x += Math.max(...xs) - minX + 50;
  }
  return dxfFile(entities, [...Object.keys(ASTM_STYLE.layers), ...(drilled ? ['13'] : [])].map((n) => [n, 7]), blocks);
}
