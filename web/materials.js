/**
 * The MATERIALS look: every body as what it is made of. A small library of physical materials
 * (base colour, metalness, roughness, transmission, IOR), a guess per body from its name and
 * assembly path (a STEP file carries names and colours, not materials), and the user's pick per
 * body, kept per file. Plastic keeps the file's own colour; everything else has its real one.
 */

// color: sRGB hex. metal 0/1, rough 0..1, trans 0/1 (clear: refracts), ior for the clear ones.
// density: g/cm³, for the weight estimate (plastic as PLA/ABS, tin plate as the steel under it, PCB as FR-4)
export const MATERIALS = {
  plastic: { label: 'Plastic', density: 1.2, color: 0xe8e4dc, metal: 0, rough: 0.7 },
  gloss: { label: 'Gloss plastic', density: 1.2, color: 0xe8e4dc, metal: 0, rough: 0.18 },
  gloss_black: { label: 'Black gloss', density: 1.2, color: 0x0b0b0d, metal: 0, rough: 0.05 },   // a screen off, piano black
  powder_white: { label: 'Powder coat (file colour, else white)', density: 2.7, color: 0xf0f0ec, metal: 0, rough: 0.55, fileColor: true },
  aluminum: { label: 'Aluminum', density: 2.7, color: 0xd2d4d7, metal: 1, rough: 0.32 },
  black_al: { label: 'Black anodized', density: 2.7, color: 0x2b2b2e, metal: 1, rough: 0.38 },
  anodized: { label: 'Anodized (file colour)', density: 2.7, color: 0xd2d4d7, metal: 1, rough: 0.38, fileColor: true },
  steel: { label: 'Steel', density: 7.85, color: 0xc6c7c8, metal: 1, rough: 0.22 },
  tin: { label: 'Tin plate', density: 7.85, color: 0xc9cbcd, metal: 1, rough: 0.35 },
  zinc: { label: 'Zinc plate', density: 7.85, color: 0xbcc0c2, metal: 1, rough: 0.42 },
  gold: { label: 'Gold plate', density: 8.9, color: 0xe8c36a, metal: 1, rough: 0.2 },
  nickel: { label: 'Nickel', density: 8.9, color: 0xd3cdc4, metal: 1, rough: 0.14 },
  brass: { label: 'Brass', density: 8.5, color: 0xdcb46a, metal: 1, rough: 0.25 },
  copper: { label: 'Copper', density: 8.96, color: 0xe3a17c, metal: 1, rough: 0.28 },
  glass: { label: 'Glass', density: 2.5, color: 0xffffff, metal: 0, rough: 0, trans: 1, ior: 1.52 },
  acrylic: { label: 'Acrylic', density: 1.18, color: 0xf7fbff, metal: 0, rough: 0.02, trans: 1, ior: 1.49 },
  rubber: { label: 'Rubber', density: 1.2, color: 0x2a2a2a, metal: 0, rough: 0.95 },
  wood: { label: 'Wood', density: 0.6, color: 0xb98a5a, metal: 0, rough: 0.75 },
  pcb: { label: 'PCB green', density: 1.85, color: 0x1f5a2e, metal: 0, rough: 0.45 },
  pcb_black: { label: 'PCB black', density: 1.85, color: 0x141516, metal: 0, rough: 0.4 },
  pcb_white: { label: 'PCB white', density: 1.85, color: 0xf1f1ec, metal: 0, rough: 0.45 },
  pcb_blue: { label: 'PCB blue', density: 1.85, color: 0x1c3f8c, metal: 0, rough: 0.45 },
  ceramic: { label: 'Ceramic', density: 3.9, color: 0xd9cfb4, metal: 0, rough: 0.55, fileColor: true },
  epoxy: { label: 'Epoxy (IC body)', density: 1.9, color: 0x1c1c1e, metal: 0, rough: 0.6, fileColor: true },
};

// First match wins: material words beat part words ("clear anodized" is aluminium, a screw
// "for the sub-board" is steel), and anodizing beats "clear".
const GUESS = [
  // what it is made of, when the name says so
  [/black (solder ?mask|pcb)/i, 'pcb_black'],
  [/white (solder ?mask|pcb)/i, 'pcb_white'],
  [/blue (solder ?mask|pcb)/i, 'pcb_blue'],
  [/green (solder ?mask|pcb)|solder ?mask/i, 'pcb'],
  [/black.?anod|anod.*black/i, 'black_al'],
  [/(black|piano).?gloss|gloss(y)?.?black/i, 'gloss_black'],   // before glass: a screen named for its glass shows black
  [/powder.?coat/i, 'powder_white'],   // a finish beats the steel or aluminium under it
  [/anodi[sz]/i, 'anodized'],
  [/glass|sapphire|lens|window|mirror/i, 'glass'],
  [/acryl|pmma|perspex|plexi|polycarb|lexan|\bclear\b|transparent/i, 'acrylic'],
  [/gold|\benig\b/i, 'gold'],
  [/\btin\b|tin.?plat/i, 'tin'],
  [/zinc|galvani/i, 'zinc'],
  [/steel|stainless/i, 'steel'],
  [/brass/i, 'brass'],
  [/copper/i, 'copper'],
  [/alu|6061|7075|5052|extrusion|\bal\b/i, 'aluminum'],
  [/ceramic|mlcc|ferrite|thick.?film/i, 'ceramic'],
  [/epoxy/i, 'epoxy'],
  [/plastic|nylon|\babs\b|\blcp\b|\bpbt\b|delrin|\bpom\b|enamel|paint/i, 'plastic'],
  [/rubber|bumpon|silicone|gasket|o.?ring|\bfeet\b|\bfoot\b|tpu|grommet/i, 'rubber'],
  [/wood|plywood|oak|walnut|maple|birch|bamboo/i, 'wood'],
  [/magnet|neodym|ndfeb/i, 'nickel'],
  // else what it is
  [/screw|bolt|\bnut\b|washer|shcs|bhcs|fhcs|\bm\d+(x|\b)|dowel|\bpin\b|spring|bearing|standoff|insert/i, 'steel'],
  [/\bic\b|\bqfn\b|\blqfp\b|\bbga\b|\bsot-?\d|\bsod-?\d/i, 'epoxy'],
  [/pcb|\bboard\b|pcba/i, 'pcb'],
];
// The body's own name decides first; its groups only fill in, and a group named "PCB" holds the
// parts on the board, not more board.
const guess = (text, skip) => GUESS.find(([re, k]) => k !== skip && re.test(text))?.[1];
// The file's own material name ("Steel - Satin", a STEP's fill style) says it outright, before any name.
export const guessMaterial = (name, path = [], material = '') => (material ? guess(material) : undefined) ?? guess(name) ?? guess(path.join(' '), 'pcb') ?? 'plastic';

const KEY = 'cadgang-materials';
let picks = {};
try { picks = JSON.parse(localStorage.getItem(KEY)) || {}; } catch {}
/** The user's pick for a body in this file, or undefined (then materialOf is a guess). */
export const pickedMaterial = (m) => picks[m.userData.file]?.[m.userData.name];
/** The material key for a body: the user's pick for it in this file, else the guess. */
export const materialOf = (m) => picks[m.userData.file]?.[m.userData.name] ?? guessMaterial(m.userData.name, m.userData.path, m.userData.material);
export function pickMaterial(m, key) {
  if (key) (picks[m.userData.file] ??= {})[m.userData.name] = key;
  else delete picks[m.userData.file]?.[m.userData.name];   // back to the guess
  try { localStorage.setItem(KEY, JSON.stringify(picks)); } catch {}
}

/** A three.js material for a body under the MATERIALS look. */
export function materialFor(THREE, m, src = m.userData) {
  // a file with real materials (glTF: colour + roughness/metalness, per group on a multi-finish body) beats the name guess; a pick beats both
  if (src.pbr && src.color && !picks[m.userData.file]?.[m.userData.name])
    return new THREE.MeshPhysicalMaterial({ ...src.pbr, color: new THREE.Color().setRGB(...src.color, THREE.SRGBColorSpace) });
  const d = MATERIALS[materialOf(m)];
  const mat = new THREE.MeshPhysicalMaterial({ color: d.color, metalness: d.metal, roughness: d.rough });
  if (d.trans) Object.assign(mat, { transmission: 1, ior: d.ior, thickness: 0 });   // thin-walled in the live view: a thickness bent what is behind it per triangle (shattered look); the Metal render refracts for real
  // Plastic, anodizing, ceramic and epoxy are whatever colour the file says.
  if ((d.fileColor || d === MATERIALS.plastic || d === MATERIALS.gloss) && src.color) mat.color.setRGB(...src.color, THREE.SRGBColorSpace);
  return mat;
}
