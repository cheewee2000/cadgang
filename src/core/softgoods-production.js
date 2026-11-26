// The production outputs beside the pattern DXFs and the tech pack: markers, a bill of materials, a 1:1 tiled print
// and plain SVGs. exportProduction is the export route: the standard export, plus whichever of these were asked for.

import fs from 'node:fs';
import path from 'node:path';
import { GraphError } from './errors.js';
import { exportSoftgoods } from './softgoods-export.js';
import { gradePattern } from './softgoods-operations.js';
import { makeMarkers, markerDXF, markerSVG, markerSummary } from './softgoods-marker.js';
import { billOfMaterials, bomPage } from './softgoods-bom.js';
import { patternSVG, printHTML } from './softgoods-print.js';

export const PRODUCTION_FORMATS = ['marker', 'bom', 'print', 'svg'];

/**
 * options.formats: any of 'marker' (a DXF and an SVG marker per material), 'bom' (JSON and HTML), 'print' (tiled 1:1 HTML),
 * 'svg' (one SVG per pattern and graded size). The rest are passed on: width, gap, turns, sizes, resolution to the marker
 * and the bill; threadMultiplier to the bill; paper, margin, overlap, orientation and sizes to the print.
 */
export function exportProduction(document, dir, name, { formats = [], width, gap, turns, sizes, resolution, threadMultiplier, paper, margin, overlap, orientation } = {}) {
  const unknown = formats.filter((f) => !PRODUCTION_FORMATS.includes(f));
  if (unknown.length) throw new GraphError(`Unknown export format '${unknown[0]}'. Known: ${PRODUCTION_FORMATS.join(', ')}`);
  const defined = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v != null)), lay = defined({ width, gap, turns, sizes, resolution });
  // Everything is made before anything is written: a piece wider than its roll stops the export with nothing half done.
  const out = [], want = (f) => formats.includes(f), file = (suffix, text) => out.push([path.join(dir, `${name}_${suffix}`), text]), report = {};
  if (want('marker')) {
    const made = makeMarkers(document, lay);
    for (const m of made.markers) { const id = (m.material || 'unnamed').replace(/[^\w.-]+/g, '_'); file(`marker_${id}.dxf`, markerDXF(m)); file(`marker_${id}.svg`, markerSVG(m)); }
    report.markers = made.markers.map(markerSummary);
  }
  if (want('bom')) { const bom = billOfMaterials(document, defined({ ...lay, threadMultiplier })); file('bom.json', JSON.stringify(bom, null, 2)); file('bom.html', bomPage(bom, name)); report.bom = bom; }
  if (want('print')) { const options = defined({ paper, margin, overlap, orientation, sizes }); file(`print_${String(paper || 'a4').toLowerCase()}.html`, printHTML(document, { name, ...options })); }
  if (want('svg')) {
    const notes = (p) => (document.annotations || []).filter((a) => a.pattern === p.id);
    for (const p of document.patterns) file(`${p.id}.svg`, patternSVG(p, notes(p)));
    for (const g of document.grades || []) for (const p of document.patterns) { const graded = gradePattern(p, { size: g.size, rules: g.rules.filter((r) => r.pattern === p.id).map(({ point, dx, dy }) => ({ point, dx, dy })) }); file(`${graded.id}.svg`, patternSVG({ ...graded, name: `${p.name || p.id} ${g.size}` }, notes(p))); }
  }
  const result = exportSoftgoods(document, dir, name);
  for (const [f, text] of out) { fs.writeFileSync(f, text); result.files.push(f); }
  return { ...result, ...report };
}
