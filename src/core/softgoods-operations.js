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
