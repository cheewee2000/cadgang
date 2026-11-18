import test from 'node:test';
import assert from 'node:assert/strict';
import { Sketch, solveSketch } from '../src/core/sketch.js';

test('sketch diagnostics identify the constraints that repeat existing intent', () => {
  const s = new Sketch();
  const a = s.anchor(0, 0), b = s.point(10, 0), line = s.line(a, b);
  const first = s.horizontal(line);
  const repeated = s.horizontal(line);
  const report = solveSketch(s);
  assert.ok(report.converged);
  assert.equal(report.redundant, 1);
  assert.deepEqual(report.redundantConstraints.map((x) => x.constraint), [first, repeated]);
  assert.match(report.redundantConstraints[0].label, /horizontal/);
});

test('independent sketch constraints are not blamed as redundant', () => {
  const s = new Sketch();
  const a = s.anchor(0, 0), b = s.point(10, 2), line = s.line(a, b);
  s.horizontal(line);
  s.distance(line, 10);
  const report = solveSketch(s);
  assert.ok(report.converged);
  assert.equal(report.redundant, 0);
  assert.deepEqual(report.redundantConstraints, []);
});
