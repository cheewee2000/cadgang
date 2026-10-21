/**
 * Appearance of the solids in a STEP file, read from its text.
 *
 * occt-import-js reports colours only when OCCT pinned them to a shape label;
 * a STYLED_ITEM on a solid inside a part's compound (how Fusion, via ST-Developer,
 * writes every body) never reaches it, so the file's colours and material names
 * vanish. This follows STYLED_ITEM → presentation style → colour by hand.
 *
 * Solids come back two ways. `solids`: every solid in file order, which is
 * OCCT's mesh order when nothing is instanced. `parts`: product name → that
 * product's own solids in order, which still lines up when library parts are
 * placed many times (OCCT meshes each placement). The caller trusts a list only
 * when its length matches the meshes it is matched against.
 */

const SOLID = /^(MANIFOLD_SOLID_BREP|BREP_WITH_VOIDS|FACETED_BREP|SHELL_BASED_SURFACE_MODEL)$/;
const REP = /^(ADVANCED_BREP_SHAPE_REPRESENTATION|FACETED_BREP_SHAPE_REPRESENTATION|MANIFOLD_SURFACE_SHAPE_REPRESENTATION|SHAPE_REPRESENTATION)$/;
const PRODUCT = /^(PRODUCT|PRODUCT_DEFINITION_FORMATION|PRODUCT_DEFINITION_FORMATION_WITH_SPECIFIED_SOURCE|PRODUCT_DEFINITION|PRODUCT_DEFINITION_SHAPE|SHAPE_DEFINITION_REPRESENTATION|SHAPE_REPRESENTATION_RELATIONSHIP)$/;
const STYLE = /^(PRESENTATION_STYLE_ASSIGNMENT|PRESENTATION_STYLE_BY_CONTEXT|SURFACE_STYLE_USAGE|SURFACE_SIDE_STYLE|SURFACE_STYLE_FILL_AREA|FILL_AREA_STYLE|FILL_AREA_STYLE_COLOUR|COLOUR_RGB|DRAUGHTING_PRE_DEFINED_COLOUR|SURFACE_STYLE_RENDERING|SURFACE_STYLE_RENDERING_WITH_PROPERTIES|SURFACE_STYLE_TRANSPARENT)$/;
const KEEP = new RegExp(`${SOLID.source}|${REP.source}|${STYLE.source}|${PRODUCT.source}|^(OVER_RIDING_)?STYLED_ITEM$`);

const PREDEFINED = { red: [1, 0, 0], green: [0, 1, 0], blue: [0, 0, 1], yellow: [1, 1, 0], magenta: [1, 0, 1], cyan: [0, 1, 1], black: [0, 0, 0], white: [1, 1, 1] };
const refs = (s) => [...s.matchAll(/#(\d+)/g)].map((m) => +m[1]);
const firstString = (s) => s.match(/^\s*'((?:[^']|'')*)'/)?.[1].replace(/''/g, "'") ?? '';

/**
 * text: the STEP file as a string. Returns { solids, parts } where a solid is
 * { name, color:[r,g,b]|null, opacity, material } and parts maps a product name to its solids.
 */
export function stepSolidStyles(text) {
  const ents = new Map();   // id -> { type, args }
  const order = [];         // representation ids in file order
  // ponytail: a regex over the DATA section; complex (parenthesised) entities are skipped, none of them carry style.
  for (const m of text.matchAll(/#(\d+)\s*=\s*([A-Z_0-9]+)\s*\(([\s\S]*?)\)\s*;(?=\s*(?:#\d+\s*=|ENDSEC))/g)) {
    if (!KEEP.test(m[2])) continue;
    ents.set(+m[1], { type: m[2], args: m[3] });
    if (REP.test(m[2])) order.push(+m[1]);
  }

  const styleOf = new Map();   // solid id -> style ids
  for (const e of ents.values()) {
    if (!/STYLED_ITEM$/.test(e.type)) continue;
    const r = refs(e.args);
    const target = e.type === 'OVER_RIDING_STYLED_ITEM' ? r[r.length - 2] : r[r.length - 1];
    if (SOLID.test(ents.get(target)?.type ?? '')) styleOf.set(target, r.slice(0, e.type === 'OVER_RIDING_STYLED_ITEM' ? -2 : -1));
  }

  const resolve = (ids) => {
    const out = { color: null, opacity: 1, material: '' };
    const seen = new Set();
    const walk = (id) => {
      const e = ents.get(id);
      if (!e || seen.has(id) || !STYLE.test(e.type)) return;
      seen.add(id);
      if (e.type === 'COLOUR_RGB') {
        const n = e.args.replace(/^\s*'(?:[^']|'')*'\s*,/, '').split(',').map(Number);
        if (!out.color && n.length === 3 && n.every(Number.isFinite)) out.color = n;
        return;
      }
      if (e.type === 'DRAUGHTING_PRE_DEFINED_COLOUR') { out.color ??= PREDEFINED[firstString(e.args).toLowerCase()] ?? null; return; }
      if (e.type === 'SURFACE_STYLE_TRANSPARENT') { const t = parseFloat(e.args); if (Number.isFinite(t)) out.opacity = 1 - t; return; }
      if (e.type === 'FILL_AREA_STYLE' && !out.material) out.material = firstString(e.args);
      for (const r of refs(e.args)) walk(r);
    };
    ids.forEach(walk);
    return out;
  };

  const styled = new Map();   // solid id -> its entry, built once
  const solidOf = (id) => {
    if (!styled.has(id)) styled.set(id, { name: firstString(ents.get(id).args), ...(styleOf.has(id) ? resolve(styleOf.get(id)) : { color: null, opacity: 1, material: '' }) });
    return styled.get(id);
  };
  const solidIds = (rid) => refs(ents.get(rid)?.args ?? '').filter((id) => SOLID.test(ents.get(id)?.type ?? ''));

  const solids = [], listed = new Set();
  for (const rid of order) for (const id of solidIds(rid)) if (!listed.has(id)) { listed.add(id); solids.push(solidOf(id)); }

  // product → formation → definition → definition shape → shape representation,
  // plus the B-rep representations a plain relationship ties to it.
  const by = (type) => [...ents.entries()].filter(([, e]) => e.type === type);
  const linked = new Map();
  for (const [, e] of by('SHAPE_REPRESENTATION_RELATIONSHIP')) {
    const [a, b] = refs(e.args).slice(-2);
    for (const [x, y] of [[a, b], [b, a]]) { if (!linked.has(x)) linked.set(x, []); linked.get(x).push(y); }
  }
  const repOfPds = new Map(by('SHAPE_DEFINITION_REPRESENTATION').map(([, e]) => refs(e.args)));
  const pdsOfPd = new Map(by('PRODUCT_DEFINITION_SHAPE').map(([id, e]) => [refs(e.args).at(-1), id]));
  const pdOfPdf = new Map(by('PRODUCT_DEFINITION').map(([id, e]) => [refs(e.args)[0], id]));
  const pdfOfProduct = new Map([...by('PRODUCT_DEFINITION_FORMATION'), ...by('PRODUCT_DEFINITION_FORMATION_WITH_SPECIFIED_SOURCE')].map(([id, e]) => [refs(e.args)[0], id]));
  const parts = new Map();
  for (const [pid, e] of by('PRODUCT')) {
    const rep = repOfPds.get(pdsOfPd.get(pdOfPdf.get(pdfOfProduct.get(pid))));
    if (!rep) continue;
    const ids = [...new Set([rep, ...(linked.get(rep) ?? [])].flatMap(solidIds))];
    const name = e.args.split(',')[1]?.trim().replace(/^'|'$/g, '').replace(/''/g, "'") ?? '';
    if (ids.length && !parts.has(name)) parts.set(name, ids.map(solidOf));
  }
  return { solids, parts };
}
