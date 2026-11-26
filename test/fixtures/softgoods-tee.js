// A T-shirt with curved armholes, a neck scoop, a pair of sleeves and two graded sizes: the realistic document the production tests share.
const piece = (id, name, points, segments, extra = {}) => ({
  id, name, material: 'jersey', cut: 1, grain: { angle: 90 }, notches: [], internalLines: [],
  points: points.map(([pid, x, y]) => ({ id: `${id}_${pid}`, x, y })),
  segments: segments.map(([sid, type, ...refs]) => ({ id: `${id}_${sid}`, type, ...Object.fromEntries(refs.map((r, i) => [type === 'bezier' ? ['a', 'b', 'c1', 'c2'][i] : ['a', 'b'][i], `${id}_${r}`])) })),
  contours: [segments.map(([sid]) => `${id}_${sid}`)],
  allowances: Object.fromEntries(segments.map(([sid]) => [`${id}_${sid}`, 10])),
  ...extra,
});
const body = (id, name, neck) => piece(id, name,
  [['hl', 0, 0], ['hr', 520, 0], ['ur', 520, 450], ['sr', 455, 680], ['nr', 350, 720], ['nl', 170, 720], ['sl', 65, 680], ['ul', 0, 450], ['ar1', 470, 470], ['ar2', 450, 580], ['n1', 330, neck], ['n2', 190, neck], ['al1', 70, 580], ['al2', 50, 470]],
  [['hem', 'line', 'hl', 'hr'], ['side_r', 'line', 'hr', 'ur'], ['arm_r', 'bezier', 'ur', 'sr', 'ar1', 'ar2'], ['shoulder_r', 'line', 'sr', 'nr'], ['neck', 'bezier', 'nr', 'nl', 'n1', 'n2'], ['shoulder_l', 'line', 'nl', 'sl'], ['arm_l', 'bezier', 'sl', 'ul', 'al1', 'al2'], ['side_l', 'line', 'ul', 'hl']]);

export function tee() {
  const front = body('front', 'Front', 640), back = body('back', 'Back', 700);
  front.notches.push({ segment: 'front_arm_r', at: 0.5, depth: 4 });
  const sleeve = piece('sleeve', 'Sleeve',
    [['hl', 30, 0], ['hr', 390, 0], ['ur', 420, 200], ['top', 210, 330], ['ul', 0, 200], ['c1', 340, 210], ['c2', 290, 330], ['c3', 130, 330], ['c4', 80, 210]],
    [['hem', 'line', 'hl', 'hr'], ['under_r', 'line', 'hr', 'ur'], ['cap_r', 'bezier', 'ur', 'top', 'c1', 'c2'], ['cap_l', 'bezier', 'top', 'ul', 'c3', 'c4'], ['under_l', 'line', 'ul', 'hl']], { cut: 2, mirror: true });
  const band = piece('neckband', 'Neckband', [['a', 0, 0], ['b', 480, 0], ['c', 480, 40], ['d', 0, 40]], [['bottom', 'line', 'a', 'b'], ['right', 'line', 'b', 'c'], ['top', 'line', 'c', 'd'], ['left', 'line', 'd', 'a']], { grain: { angle: 0 } });
  const pocket = piece('pocket', 'Pocket', [['a', 0, 0], ['b', 110, 0], ['c', 110, 130], ['d', 0, 130]], [['bottom', 'line', 'a', 'b'], ['right', 'line', 'b', 'c'], ['top', 'line', 'c', 'd'], ['left', 'line', 'd', 'a']]);
  const wider = (id, dx) => ['hr', 'ur', 'ar1'].map((p) => ({ pattern: id, point: `${id}_${p}`, dx, dy: 0 }));
  return {
    version: 1, materials: { jersey: { preset: 'cotton-jersey', rollWidth: 1600, pricePerMeter: 9 } }, patterns: [front, back, sleeve, band, pocket],
    seams: [
      { id: 'side_right', a: { pattern: 'front', segment: 'front_side_r' }, b: { pattern: 'back', segment: 'back_side_l' }, flip: true, kind: 'overlock' },
      { id: 'side_left', a: { pattern: 'front', segment: 'front_side_l' }, b: { pattern: 'back', segment: 'back_side_r' }, flip: true, kind: 'overlock' },
      { id: 'shoulder_right', a: { pattern: 'front', segment: 'front_shoulder_r' }, b: { pattern: 'back', segment: 'back_shoulder_l' }, flip: true },
    ],
    grades: [{ size: 'L', rules: [...wider('front', 20), ...wider('back', 20)] }, { size: 'XL', rules: [...wider('front', 40), ...wider('back', 40)] }],
  };
}
