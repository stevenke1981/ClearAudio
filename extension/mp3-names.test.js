import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mp3FileStem} from './mp3-names.js';

const D = new Date(2026, 0, 2, 3, 4, 5); // local time, so the stamp is timezone independent

test('stem is <title>-<local YYYYMMDD-HHMMSS> without extension', () => {
  assert.equal(mp3FileStem('Synthetic tone', D), 'Synthetic tone-20260102-030405');
});

test('invalid filename characters become underscores', () => {
  assert.equal(mp3FileStem('a<b>c:d"e/f\\g|h?i*j', D), 'a_b_c_d_e_f_g_h_i_j-20260102-030405');
  assert.equal(mp3FileStem('tab\u0001name', D), 'tab_name-20260102-030405');
});

test('trailing dots and spaces are removed', () => {
  assert.equal(mp3FileStem('Song... ', D), 'Song-20260102-030405');
  assert.equal(mp3FileStem('Song . . ', D), 'Song-20260102-030405');
});

test('short site suffix after " | " is removed', () => {
  assert.equal(mp3FileStem('My Track | Suno', D), 'My Track-20260102-030405');
  assert.equal(mp3FileStem('A | B | Suno', D), 'A _ B-20260102-030405');
});

test('suffix is kept when long or when there is no other content', () => {
  assert.equal(mp3FileStem('Track | a very long site name here', D), 'Track _ a very long site name here-20260102-030405');
  assert.equal(mp3FileStem('| Suno', D), '_ Suno-20260102-030405');
});

test('empty or missing title falls back to tab-audio', () => {
  assert.equal(mp3FileStem('', D), 'tab-audio-20260102-030405');
  assert.equal(mp3FileStem(undefined, D), 'tab-audio-20260102-030405');
  assert.equal(mp3FileStem('...', D), 'tab-audio-20260102-030405');
});

test('title is capped at 70 characters', () => {
  const stem = mp3FileStem('x'.repeat(200), D);
  assert.equal(stem, `${'x'.repeat(70)}-20260102-030405`);
});

test('default date is the current local time', () => {
  assert.match(mp3FileStem('t'), /^t-\d{8}-\d{6}$/);
});
