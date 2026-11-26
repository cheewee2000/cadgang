// Deterministic measurement and grading operations for authoritative 2D patterns.
import { GraphError } from './errors.js';
import { segmentLength } from './softgoods-export.js';

const finite = (v) => Number.isFinite(Number(v));

/** Grade a pattern by applying explicit [dx, dy] rules to stable point IDs. */
export function gradePattern(pattern, { size, rules }) {
  if (!size || typeof size !== 'string') throw new GraphError('Grade size must be a non-empty name');
  const sizeId = size.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^[^a-z_]+/, '').slice(0, 40);
  if (!sizeId) throw new GraphError(`Grade size '${size}' cannot form a pattern id`);
  if (!Array.isArray(rules)) throw new GraphError(`Grade '${size}' rules must be an array`);
  const pointIds = new Set(pattern.points.map((p) => p.id));
  const seen = new Set();
  for (const rule of rules) {
    if (!pointIds.has(rule.point)) throw new GraphError(`Grade '${size}' refers to missing point '${rule.point}'`);
    if (seen.has(rule.point)) throw new GraphError(`Grade '${size}' has duplicate rule for point '${rule.point}'`);
    if (!finite(rule.dx) || !finite(rule.dy)) throw new GraphError(`Grade '${size}' rule for '${rule.point}' needs finite dx and dy`);
    seen.add(rule.point);
  }
  const offsets = new Map(rules.map((r) => [r.point, [Number(r.dx), Number(r.dy)]]));
  return { ...structuredClone(pattern), id: `${pattern.id}_${sizeId}`, size, points: pattern.points.map((p) => { const [dx, dy] = offsets.get(p.id) || [0, 0]; return { ...p, x: p.x + dx, y: p.y + dy }; }) };
}

/** Grade one base pattern into deterministically named sizes. */
export function gradePatterns(pattern, sizes) {
  if (!Array.isArray(sizes)) throw new GraphError('Grade sizes must be an array');
  const names = new Set();
  return sizes.map(({ name, rules }) => {
    if (names.has(name)) throw new GraphError(`Duplicate grade size '${name}'`);
    names.add(name);
    return gradePattern(pattern, { size: name, rules });
  });
}

/** Evaluate document measurement constraints without modifying it. */
export function evaluateMeasurementConstraints(document) {
  const patterns = new Map(document.patterns.map((p) => [p.id, p]));
  return (document.constraints || []).map((constraint) => {
    let measured;
    if (constraint.type === 'distance') {
      const a = patterns.get(constraint.a.pattern)?.points.find((p) => p.id === constraint.a.point);
      const b = patterns.get(constraint.b.pattern)?.points.find((p) => p.id === constraint.b.point);
      measured = Math.hypot(a.x - b.x, a.y - b.y);
    } else {
      const pattern = patterns.get(constraint.pattern);
      const ids = constraint.segments || pattern.contours[constraint.contour];
      measured = ids.reduce((sum, id) => sum + segmentLength(pattern, pattern.segments.find((s) => s.id === id)), 0);
    }
    const delta = measured - constraint.target;
    return { id: constraint.id, name: constraint.name, type: constraint.type, measured: +measured.toFixed(6), target: constraint.target, delta: +delta.toFixed(6), withinTolerance: Math.abs(delta) <= (constraint.tolerance ?? 0) };
  });
}

/** The document at one graded size: every pattern moved by that size's rules, ids unchanged so seams and constraints still resolve. */
export function gradeDocument(document, grade) {
  return { ...document, patterns: document.patterns.map((p) => ({ ...gradePattern(p, { size: grade.size, rules: grade.rules.filter((r) => r.pattern === p.id).map(({ point, dx, dy }) => ({ point, dx, dy })) }), id: p.id })) };
}

/** Lengths of the two sides of every seam. A plain seam sews only if they agree within its ease; a gather or elastic seam may differ on purpose. */
export function seamLengths(document) {
  const patterns = new Map(document.patterns.map((p) => [p.id, p])), length = (ref) => { const p = patterns.get(ref.pattern); return segmentLength(p, p.segments.find((s) => s.id === ref.segment)); };
  return document.seams.map((s) => { const a = length(s.a), b = length(s.b), mismatch = Math.abs(a - b) / Math.max(a, b, 1e-9); return { id: s.id, kind: s.kind || 'plain', lengthA: +a.toFixed(2), lengthB: +b.toFixed(2), mismatch: +mismatch.toFixed(5), ok: ['gather', 'elastic'].includes(s.kind) || mismatch <= Number(s.ease || 0) + 1e-9 }; });
}

/** What a pattern maker checks before cutting: named measurements against their targets and both sides of every seam, at the base size and at every graded size. */
export function checkDesign(document) {
  const one = (d) => { const constraints = evaluateMeasurementConstraints(d), seams = seamLengths(d); return { ok: constraints.every((c) => c.withinTolerance) && seams.every((s) => s.ok), constraints, seams }; };
  const base = one(document), sizes = (document.grades || []).map((g) => ({ size: g.size, ...one(gradeDocument(document, g)) }));
  return { ...base, ok: base.ok && sizes.every((s) => s.ok), sizes };
}
