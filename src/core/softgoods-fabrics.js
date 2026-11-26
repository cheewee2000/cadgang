// A fabric library: named starting materials in the softgoods document's material schema.
// NOTHING HERE IS MEASURED. Every value is a typical figure for the class of cloth, good enough to start a preview
// and a bill of materials, and every entry says so in `source`. A number nobody could vouch for is left out rather
// than invented: a missing field falls back to the preview's own default. Replace them with the supplier's data sheet
// or your own measurement (weigh a cut square, a cantilever droop for rigidity) before trusting a weight or a drape.
// Units as everywhere in softgoods: arealDensity g/m², thickness mm, rigidity N·mm (bending).

import { GraphError } from './errors.js';

const SOURCE = 'typical, not measured';
const fabric = (name, values, notes) => Object.freeze({ name, ...values, source: SOURCE, notes });

export const FABRICS = Object.freeze({
  'ripstop-nylon-70d': fabric('Ripstop nylon 70D, coated', { arealDensity: 70, thickness: 0.1, rigidity: 0.03 }, 'About 2 oz/yd². Rigidity is the middle of the light-woven band (0.01-0.1 N·mm).'),
  'nylon-500d': fabric('Nylon packcloth 500D, coated', { arealDensity: 270, thickness: 0.5, rigidity: 0.3 }, 'About 8 oz/yd². Rigidity is inside the coated-cordura band (0.1-1 N·mm).'),
  'nylon-1000d': fabric('Nylon packcloth 1000D, coated', { arealDensity: 370, thickness: 0.6, rigidity: 0.6 }, 'About 11 oz/yd². Rigidity is inside the coated-cordura band (0.1-1 N·mm).'),
  'laminate-sailcloth': fabric('X-Pac style laminate (210D face, X-ply, film)', { arealDensity: 205 }, 'About 6 oz/yd² for a 210D-face laminate. Thickness and rigidity are left out: laminates crease rather than drape, measure a sample.'),
  'waxed-canvas': fabric('Waxed cotton canvas', { arealDensity: 400, thickness: 0.6, rigidity: 0.5 }, 'A 10 oz/yd² canvas plus wax, about 12 oz/yd² finished. Rigidity is inside the canvas band (0.1-1 N·mm) and rises in the cold.'),
  'denim-12oz': fabric('Cotton denim 12 oz', { arealDensity: 400, thickness: 0.7, rigidity: 0.3 }, '12 oz/yd² is about 407 g/m². Rigidity is inside the canvas band (0.1-1 N·mm); washed denim is softer.'),
  'cotton-jersey': fabric('Cotton single jersey', { arealDensity: 160, thickness: 0.5 }, 'T-shirt weight, commonly 140-180 g/m². A knit: stretch and rigidity are left out, measure them.'),
  'neoprene-3mm': fabric('Neoprene 3 mm, jersey both sides', { thickness: 3 }, 'Thickness is the nominal sheet. Weight varies with the foam grade and the facing: take it from the supplier.'),
  'closed-cell-foam-6mm': fabric('Closed-cell foam 6 mm (EVA or PE)', { thickness: 6, rigidity: 100 }, 'Thickness is the nominal sheet. Foam density runs from about 30 to 200 kg/m³ by grade, so no weight is given. Rigidity is the bottom of the foam-panel band (100+ N·mm).'),
  'spacer-mesh-3mm': fabric('Spacer mesh 3 mm', { arealDensity: 300, thickness: 3 }, 'Commonly 250-350 g/m². Rigidity is left out.'),
  'nylon-webbing-25mm': fabric('Nylon webbing 25 mm', { rigidity: 5 }, 'A narrow good, bought by length: draw it as a strip 25 mm wide. Weight and thickness depend on the weave (flat, tubular, seat-belt). Rigidity is inside the webbing band (1-20 N·mm).'),
  'elastic-25mm': fabric('Woven elastic 25 mm', {}, 'A narrow good, bought by length. Its stretch is the whole point and is not given here: pull-test a sample and set tensile.'),
});

/** A document material with its preset filled in underneath: `{ preset: 'nylon-500d', arealDensity: 255 }` keeps its own 255. */
export function resolveMaterial(material, id = '') {
  if (!material || material.preset == null) return material;
  const preset = FABRICS[material.preset];
  if (!preset) throw new GraphError(`Material '${id}' names preset '${material.preset}', which is not in the fabric library. Known: ${Object.keys(FABRICS).join(', ')}`);
  return { ...preset, ...material };
}
export const resolveMaterials = (materials = {}) => Object.fromEntries(Object.entries(materials).map(([id, m]) => [id, resolveMaterial(m, id)]));
