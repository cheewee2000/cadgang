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
  titanium: { label: 'Titanium', density: 4.43, color: 0xa9a59f, metal: 1, rough: 0.38 },   // Ti-6Al-4V: darker and warmer than steel
  tin: { label: 'Tin plate', density: 7.85, color: 0xc9cbcd, metal: 1, rough: 0.35 },
  zinc: { label: 'Zinc plate', density: 7.85, color: 0xbcc0c2, metal: 1, rough: 0.42 },
  gold: { label: 'Gold plate', density: 8.9, color: 0xe8c36a, metal: 1, rough: 0.2 },
  nickel: { label: 'Nickel', density: 8.9, color: 0xd3cdc4, metal: 1, rough: 0.14 },
  brass: { label: 'Brass', density: 8.5, color: 0xdcb46a, metal: 1, rough: 0.25 },
  copper: { label: 'Copper', density: 8.96, color: 0xe3a17c, metal: 1, rough: 0.28 },
  glass: { label: 'Glass', density: 2.5, color: 0xdfe8ee, metal: 0, rough: 0, trans: 1, ior: 1.52 },   // a breath of blue-grey, as the Glass look
  acrylic: { label: 'Acrylic', density: 1.18, color: 0xf7fbff, metal: 0, rough: 0.02, trans: 1, ior: 1.49 },
  rubber: { label: 'Rubber', density: 1.2, color: 0x2a2a2a, metal: 0, rough: 0.95 },
  wood: { label: 'Wood', density: 0.6, color: 0xb98a5a, metal: 0, rough: 0.75, grain: 3 },   // grain: the Mac app's RENDER draws growth lines and fibres (render.swift)
  // Soft goods: the file's colour, with a weave at its true size. The live view shades the colour with it (weave, below); the Mac app's RENDER
  // puts it in the normal as well (render.swift grain 7 to 9). Densities are estimates, for a body drawn as a 1 mm sheet.
  cordura: { label: 'Cordura', density: 0.6, color: 0x2a2a2a, metal: 0, rough: 0.9, grain: 7, fileColor: true },
  webbing: { label: 'Webbing', density: 0.8, color: 0x1a1a1a, metal: 0, rough: 0.85, grain: 8, fileColor: true },
  velcro: { label: 'Velcro', density: 0.4, color: 0x8a8a8a, metal: 0, rough: 1, grain: 9, fileColor: true },
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
  [/titanium|6al.?4v/i, 'titanium'],
  [/steel|stainless/i, 'steel'],
  [/brass/i, 'brass'],
  [/copper/i, 'copper'],
  [/alu|6061|7075|5052|extrusion|\bal\b/i, 'aluminum'],
  [/ceramic|mlcc|ferrite|thick.?film/i, 'ceramic'],
  [/epoxy/i, 'epoxy'],
  [/velcro|hook.?and.?loop/i, 'velcro'],   // soft goods, before the nylon they are made of reads as plastic
  [/webbing|grosgrain/i, 'webbing'],
  [/cordura/i, 'cordura'],
  [/plastic|nylon|\babs\b|\blcp\b|\bpbt\b|delrin|\bpom\b|enamel|paint/i, 'plastic'],
  [/rubber|bumpon|silicone|gasket|o.?ring|\bfeet\b|\bfoot\b|tpu|grommet/i, 'rubber'],
  [/wood|plywood|oak|walnut|maple|birch|bamboo/i, 'wood'],
  [/magnet|neodym|ndfeb/i, 'nickel'],
  // else what it is
  [/screw|bolt|\bnut\b|washer|shcs|bhcs|fhcs|\bm\d+(x|\b)|dowel|\bpin\b|spring|bearing|standoff|insert/i, 'steel'],
  [/\bic\b|\bqfn\b|\blqfp\b|\bbga\b|\bsot-?\d|\bsod-?\d/i, 'epoxy'],
  [/pcb|\bboard\b|pcba/i, 'pcb'],
];
// A finish the body's own name states, the default until the user picks one: "wall plate, stainless, brushed y",
// "knob, 3D printed plastic", "plate, stainless, laser cut y" (a sheet as the laser shop sends it: deburred faces, cut edges). A trailing x, y or z is the grain's axis in the model (the brushing's direction, a print's
// build direction); without it the grain runs along the body's longest side and a print is built along its shortest.
const NAME_FINISH = [[/\blaser.?cut(?:\s+([xyz]))?\b/i, 'lasercut'], [/\bbrushed(?:\s+([xyz]))?\b/i, 'brushed'], [/\bbead.?blast/i, 'blasted'], [/\btumbled\b/i, 'tumbled'], [/\b(?:3d.?printed|fdm)(?:\s+([xyz]))?\b/i, 'printed']];
export function nameFinish(name = '') {
  for (const [re, key] of NAME_FINISH) { const m = re.exec(name); if (m) return { key, axis: m[1] ? 'xyz'.indexOf(m[1].toLowerCase()) : -1 }; }
  return null;
}

// The body's own name decides first; its groups only fill in, and a group named "PCB" holds the
// parts on the board, not more board.
const guess = (text, skip) => GUESS.find(([re, k]) => k !== skip && re.test(text))?.[1];
// The file's own material name ("Steel - Satin", a STEP's fill style) says it outright, before any name.
export const guessMaterial = (name, path = [], material = '') => (material ? guess(material) : undefined) ?? guess(name) ?? guess(path.join(' '), 'pcb') ?? 'plastic';

const KEY = 'cadgang-materials';
let picks = {};
try { picks = JSON.parse(localStorage.getItem(KEY)) || {}; } catch {}
// A pick is kept by body name; one finish of a body (a glTF group, g) by name#index.
const keyFor = (m, g) => (g ? `${m.userData.name}#${m.userData.groups.indexOf(g)}` : m.userData.name);
/** The user's pick for a body (or one of its finishes) in this file, or undefined (then materialOf is a guess). */
export const pickedMaterial = (m, g = null) => picks[m.userData.file]?.[keyFor(m, g)];
/** The material key for a body: the user's pick for it in this file, else the guess. A finish without its own pick follows its body. */
export const materialOf = (m, g = null) => pickedMaterial(m, g) ?? (g ? materialOf(m) : guessMaterial(m.userData.name, m.userData.path, m.userData.material));
export function pickMaterial(m, key, g = null) {
  const f = (picks[m.userData.file] ??= {});
  if (key) f[keyFor(m, g)] = key; else delete f[keyFor(m, g)];   // back to the guess
  if (!g) for (const x of m.userData.groups ?? []) delete f[keyFor(m, x)];   // the whole body: its finishes follow
  try { localStorage.setItem(KEY, JSON.stringify(picks)); } catch {}
}

// The live view's weave for the soft goods, by grain: h is how light the cloth is at uv (millimetres on the face), 1 on average; q is what a
// pixel is measured against. A body has no texture coordinates, so uv is where the fragment is in the body's own millimetres, on the pair of
// axes its face lies in.
const WEAVE = {
  7: 'vec2 q = uv / 0.7, c = floor(q), f = fract(q) - 0.5; float h = 0.62 + 0.6 * (mod(c.x + c.y, 2.0) < 0.5 ? cos(3.1416 * f.y) : cos(3.1416 * f.x));',   // Cordura: a plain weave, yarns about 0.7 mm apart, over and under
  8: 'vec2 q = vec2(dot(vWeaveP, weaveA) / 1.2, 0.0); float h = 0.62 + 0.6 * cos(3.1416 * (fract(q.x) - 0.5));',   // webbing: ribs across the width, about 1.2 mm apart along the length
  9: 'vec2 q = uv / 0.35; float h = 0.7 + 0.6 * fract(sin(dot(floor(q), vec2(127.1, 311.7))) * 43758.5453);',   // velcro loop: a fuzz of 0.35 mm specks
};
// ponytail: the weave is in the geometry's own units, taken as millimetres (a STEP's, a cell's); a glTF in metres wants the world scale, as the RENDER's grain has
function weave(THREE, mat, kind, m) {
  if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
  const size = m.geometry.boundingBox.getSize(new THREE.Vector3()).toArray(), along = new THREE.Vector3().setComponent(size.indexOf(Math.max(...size)), 1);   // webbing runs along the body's longest side
  mat.customProgramCacheKey = () => `weave${kind}`;
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.weaveA = { value: along };
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vWeaveP, vWeaveN;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWeaveP = position; vWeaveN = normal;');
    // it fades to the plain colour once a yarn is under about two pixels: a moiré otherwise
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vWeaveP, vWeaveN; uniform vec3 weaveA;')
      .replace('#include <map_fragment>', `#include <map_fragment>
      { vec3 an = abs(normalize(vWeaveN)); vec2 uv = an.z > an.x && an.z > an.y ? vWeaveP.xy : an.y > an.x ? vWeaveP.zx : vWeaveP.yz;
        ${WEAVE[kind]}
        diffuseColor.rgb *= mix(1.0, h, 1.0 - smoothstep(0.25, 0.6, max(fwidth(q.x), fwidth(q.y)))); }`);
  };
}

/** A three.js material for a body under the MATERIALS look. */
export function materialFor(THREE, m, src = m.userData) {
  // a file with real materials (glTF: colour + roughness/metalness, per group on a multi-finish body) beats the name guess; a pick beats both
  const g = src !== m.userData ? src : null;
  if (src.pbr && src.color && !pickedMaterial(m, g) && !pickedMaterial(m))
    return new THREE.MeshPhysicalMaterial({ ...src.pbr, color: new THREE.Color().setRGB(...src.color, THREE.SRGBColorSpace) });
  const d = MATERIALS[materialOf(m, g)];
  const mat = new THREE.MeshPhysicalMaterial({ color: d.color, metalness: d.metal, roughness: d.rough });
  if (d.grain) mat.userData.grain = d.grain;
  if (WEAVE[d.grain]) weave(THREE, mat, d.grain, m);
  if (d.trans) Object.assign(mat, { transmission: 0.9, ior: d.ior, thickness: 0, transparent: true, opacity: 0.75 });   // thin-walled in the live view: a thickness bent what is behind it per triangle (shattered look); the Metal render refracts for real. A little opacity: pure transmission vanished against the background
  // Plastic, anodizing, ceramic and epoxy are whatever colour the file says.
  if ((d.fileColor || d === MATERIALS.plastic || d === MATERIALS.gloss) && src.color) mat.color.setRGB(...src.color, THREE.SRGBColorSpace);
  return mat;
}
