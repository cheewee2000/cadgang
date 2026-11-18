import test from 'node:test';
import assert from 'node:assert/strict';
import { clean, label } from '../compute/labels/export.mjs';

test('part label exporter recognises underscored hardware and electronics', () => {
  assert.equal(clean('NUT_92815A127'), 'nut 92815a127');
  assert.equal(label('NUT_92815A127'), 'nut');
  assert.equal(label('SKR v157 v2_Screw v8'), 'screw');
  assert.equal(label('SIM7000G_PCB_0415'), 'pcb');
  assert.equal(label('LED1'), 'component');
  assert.equal(label('USB1'), 'component');
  assert.equal(label('92511A060_ALUM UNTHRD SPACER_92511A060'), 'standoff');
});

test('part label exporter does not turn materials, covers and contacts into parts', () => {
  assert.equal(label('98335A094 Zinc-Plated 1050-1095 Spring Steel Cotter Pins'), 'other');
  assert.equal(label('1089_for step wo spring-1-solid1'), 'other');
  assert.equal(label('Bearing hub'), 'other');
  assert.equal(label('05 / Bearing envelope'), 'other');
  assert.equal(label('Magnet Cover'), 'other');
  assert.equal(label('MAGNET CLOSURE'), 'other');
  assert.equal(label('Negative Battery Contact'), 'other');
  assert.equal(label('GoPro_Mount_Female_3T+Nut'), 'other');
  assert.equal(label('balance board stop v4'), 'other');
  assert.equal(label('TPU_seal_1_installed_envelope'), 'other');
});

test('part label exporter retains genuine production classes', () => {
  assert.equal(label('AA Battery'), 'battery');
  assert.equal(label('battery v5'), 'battery');
  assert.equal(label('SPRING_Default'), 'spring');
  assert.equal(label('R-18 o-Ring (1)'), 'oring');
  assert.equal(label('Board~NLW7'), 'pcb');
  assert.equal(label('Circuit Board'), 'pcb');
});
