/** A drawing goes to ONE page: it used to go to every open window, each writing a sheet beside its own file. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickDrawingPage } from '../src/server/view.js';

const timer = { subject: '/work/Timer/timer.step', subjectAt: 1 };
const cap = { subject: '/work/Capsule/cap.step', subjectAt: 2 };
const plug = { subject: '/work/Capsule/plug.step', subjectAt: 3 };
const empty = { subject: '' };
const pages = [timer, cap, plug, empty];

test('drawing target: the named file wins, by path or by file name', () => {
  assert.equal(pickDrawingPage(pages, timer, { dir: '/work/Capsule', source: '/work/Capsule/cap.step' }), cap);
  assert.equal(pickDrawingPage(pages, timer, { dir: '/work/Capsule', source: 'cap.step' }), cap);
});
test('drawing target: without a name, a page in the asking project — the active one, else the newest', () => {
  assert.equal(pickDrawingPage(pages, cap, { dir: '/work/Capsule' }), cap);
  assert.equal(pickDrawingPage(pages, timer, { dir: '/work/Capsule' }), plug);   // another project's window is active: never it
  assert.equal(pickDrawingPage(pages, timer, { dir: '/work/Caps' }), timer);     // a folder name prefix is not the folder
});
test('drawing target: no project named → the active page; no page with a file → none', () => {
  assert.equal(pickDrawingPage(pages, timer, {}), timer);
  assert.equal(pickDrawingPage([empty], empty, { dir: '/work/Capsule' }), null);
});
