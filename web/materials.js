/**
 * The MATERIALS look: every body as what it is made of. A small library of physical materials
 * (base colour, metalness, roughness, transmission, IOR), a guess per body from its name and
 * assembly path (a STEP file carries names and colours, not materials), and the user's pick per
 * body, kept per file. Plastic keeps the file's own colour; everything else has its real one.
 */

// color: sRGB hex. metal 0/1, rough 0..1, trans 0/1 (clear: refracts), ior for the clear ones.
export const MATERIALS = {
  plastic: { label: 'Plastic', color: 0xe8e4dc, metal: 0, rough: 0.7 },
  gloss: { label: 'Gloss plastic', color: 0xe8e4dc, metal: 0, rough: 0.18 },
  aluminum: { label: 'Aluminum', color: 0xd2d4d7, metal: 1, rough: 0.32 },
  black_al: { label: 'Black anodized', color: 0x2b2b2e, metal: 1, rough: 0.38 },
  steel: { label: 'Steel', color: 0xc6c7c8, metal: 1, rough: 0.22 },
  nickel: { label: 'Nickel', color: 0xd3cdc4, metal: 1, rough: 0.14 },
  brass: { label: 'Brass', color: 0xdcb46a, metal: 1, rough: 0.25 },
  copper: { label: 'Copper', color: 0xe3a17c, metal: 1, rough: 0.28 },
  glass: { label: 'Glass', color: 0xffffff, metal: 0, rough: 0, trans: 1, ior: 1.52 },
  acrylic: { label: 'Acrylic', color: 0xf7fbff, metal: 0, rough: 0.02, trans: 1, ior: 1.49 },
  rubber: { label: 'Rubber', color: 0x2a2a2a, metal: 0, rough: 0.95 },
  wood: { label: 'Wood', color: 0xb98a5a, metal: 0, rough: 0.75 },
  pcb: { label: 'PCB', color: 0x1f5a2e, metal: 0, rough: 0.45 },
};

// First match wins, so the specific names sit above the general ones.
const GUESS = [
  [/glass|lens|window|mirror/i, 'glass'],
  [/acryl|pmma|perspex|plexi|polycarb|lexan|\bclear\b|transparent/i, 'acrylic'],
  [/black.?anod|anod.*black/i, 'black_al'],
  [/alu|6061|7075|5052|extrusion|\bal\b/i, 'aluminum'],
  [/magnet|neodym|ndfeb/i, 'nickel'],
  [/brass/i, 'brass'],
  [/copper/i, 'copper'],
  [/rubber|bumpon|silicone|gasket|o.?ring|\bfeet\b|\bfoot\b|tpu|grommet/i, 'rubber'],
  [/wood|plywood|oak|walnut|maple|birch|bamboo/i, 'wood'],
  [/pcb|\bboard\b|pcba/i, 'pcb'],
  [/steel|stainless|screw|bolt|\bnut\b|washer|shcs|bhcs|fhcs|\bm\d+(x|\b)|dowel|\bpin\b|spring|bearing|standoff|insert/i, 'steel'],
];
export const guessMaterial = (name, path = []) => GUESS.find(([re]) => re.test([name, ...path].join(' ')))?.[1] ?? 'plastic';

const KEY = 'cadgang-materials';
let picks = {};
try { picks = JSON.parse(localStorage.getItem(KEY)) || {}; } catch {}
/** The material key for a body: the user's pick for it in this file, else the guess. */
export const materialOf = (m) => picks[m.userData.file]?.[m.userData.name] ?? guessMaterial(m.userData.name, m.userData.path);
export function pickMaterial(m, key) {
  (picks[m.userData.file] ??= {})[m.userData.name] = key;
  try { localStorage.setItem(KEY, JSON.stringify(picks)); } catch {}
}

/** A three.js material for a body under the MATERIALS look. */
export function materialFor(THREE, m) {
  const d = MATERIALS[materialOf(m)];
  const mat = new THREE.MeshPhysicalMaterial({ color: d.color, metalness: d.metal, roughness: d.rough });
  if (d.trans) Object.assign(mat, { transmission: 1, ior: d.ior, thickness: 2 });
  // Plastic is whatever colour the file says.
  if ((d === MATERIALS.plastic || d === MATERIALS.gloss) && m.userData.color) mat.color.setRGB(...m.userData.color, THREE.SRGBColorSpace);
  return mat;
}
