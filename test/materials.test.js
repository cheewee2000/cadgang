/**
 * MATERIALS guesses from the body's own name first: material words beat part words, and a
 * group named "PCB" does not turn the parts on the board into board.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guessMaterial } from '../web/materials.js';

test('material words in the name win', () => {
  for (const [name, path, want] of [
    ['exposure slider knob (clear anodised aluminium)', [], 'anodized'],
    ['lens barrel M8, black anodised aluminium', [], 'black_al'],
    ['cover glass, sapphire disk', [], 'glass'],
    ['screw M1.6x4 cheese head, stainless steel, sub-board upper', ['hardware'], 'steel'],
    ['J3 microSD socket | tin-plated steel', ['carrier PCB v19', 'microSD'], 'tin'],
    ['J8 FFC connector (sensor board side) | black LCP plastic', [], 'plastic'],
    ['C12 cap 100nF | ceramic', ['carrier PCB v19', 'power rails'], 'ceramic'],
    ['U7 MCU STM32H743', ['carrier PCB v19', 'MCU'], 'plastic'],
    ['PCB carrier v19', ['carrier PCB v19'], 'pcb'],
    ['M3 nut', [], 'steel'],
    ['PCB carrier v19 (1.0 mm, black soldermask)', ['carrier PCB v19'], 'pcb_black'],
    ['PCB sensor sub-board (white soldermask)', [], 'pcb_white'],
    ['blue PCB', [], 'pcb_blue'],
  ]) assert.equal(guessMaterial(name, path), want, name);
});
