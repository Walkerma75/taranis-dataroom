/**
 * The Biotech KSA Information Request List seed.
 *
 * These are the numbers HANDOVER-CW004 §4 asks the seed to produce, asserted
 * against the committed artefact rather than against the spreadsheet: the
 * spreadsheet lives in the fund paperwork folder on a workstation, which
 * neither CI nor the API container can read. `tools/build-irl-seed.mjs`
 * converts one into the other and refuses to write a seed that fails these same
 * rules, so a bad spreadsheet is caught at conversion and a bad artefact is
 * caught here.
 *
 * The counts are deliberately hard-coded. If the master genuinely changes,
 * these numbers are meant to fail and be updated on purpose, because a silent
 * change to a due diligence request list is exactly what should not happen
 * quietly.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { loadIrlSeed, validateIrlSeed } from '../src/db/seed-irl.js';

const seed = loadIrlSeed('biotech-ksa-irl-v1');

test('the seed carries exactly 146 items', () => {
  assert.equal(seed.items.length, 146);
  assert.equal(seed.itemCount, 146);
});

test('all 146 refs are unique', () => {
  const refs = seed.items.map((i) => i.ref);
  assert.equal(new Set(refs).size, 146);
});

test('there are 14 sections', () => {
  assert.equal(new Set(seed.items.map((i) => i.section)).size, 14);
  assert.equal(seed.sectionCount, 14);
});

test('priorities are only high, medium and standard, in the expected counts', () => {
  const counts = seed.items.reduce((acc, i) => {
    acc[i.priority] = (acc[i.priority] || 0) + 1;
    return acc;
  }, {});

  assert.deepEqual(Object.keys(counts).sort(), ['high', 'medium', 'standard']);
  assert.equal(counts.high, 42);
  assert.equal(counts.medium, 43);
  assert.equal(counts.standard, 61);
  assert.equal(counts.high + counts.medium + counts.standard, 146);
});

test('every item carries the seven columns the working files use', () => {
  for (const item of seed.items) {
    for (const key of [
      'section', 'ref', 'description', 'priority',
      'sort_order', 'already_held', 'note_for_company',
    ]) {
      assert.ok(key in item, `ref ${item.ref} is missing ${key}`);
    }
  }
});

test('refs are the 1.1 style the company quotes back, and are not renumbered', () => {
  for (const item of seed.items) {
    assert.match(item.ref, /^\d+\.\d+$/, `unexpected ref format: ${item.ref}`);
  }
  // A spot check against the known first and last rows of the master. If these
  // move, the master has been renumbered, which must never happen silently.
  assert.equal(seed.items[0].ref, '1.1');
  assert.equal(seed.items[145].ref, '14.10');
});

test('sort_order runs 1 to 146 with no gaps or repeats', () => {
  const orders = seed.items.map((i) => i.sort_order).sort((a, b) => a - b);
  assert.deepEqual(orders, Array.from({ length: 146 }, (_, i) => i + 1));
});

test('every ref belongs to the section its number names', () => {
  // Ref '7.3' must sit in the section that starts '7.'. A mismatch would mean
  // the sheet's columns had drifted apart.
  for (const item of seed.items) {
    const refSection = item.ref.split('.')[0];
    assert.ok(
      item.section.startsWith(`${refSection}.`),
      `ref ${item.ref} sits in section "${item.section}"`
    );
  }
});

test('descriptions are all present and non-trivial', () => {
  for (const item of seed.items) {
    assert.ok(item.description.length > 5, `ref ${item.ref} has a suspiciously short description`);
  }
});

test('the seed records where it came from', () => {
  assert.equal(seed.source, 'Biotech_KSA_IRL_Master_Seed_v1_06Aug2026.xlsx');
  assert.equal(seed.sheet, 'IRL master');
});

test('the validator rejects a seed whose refs repeat', () => {
  const broken = {
    ...seed,
    items: [seed.items[0], { ...seed.items[1], ref: seed.items[0].ref }],
    itemCount: 2,
    sectionCount: new Set([seed.items[0].section, seed.items[1].section]).size,
  };
  const problems = validateIrlSeed(broken);
  assert.ok(problems.some((p) => p.includes('duplicate ref')));
});

test('the validator rejects an unexpected priority', () => {
  const broken = {
    ...seed,
    items: [{ ...seed.items[0], priority: 'urgent' }],
    itemCount: 1,
    sectionCount: 1,
  };
  assert.ok(validateIrlSeed(broken).some((p) => p.includes('unexpected priority')));
});

test('the validator rejects an artefact whose declared counts disagree with its contents', () => {
  const broken = { ...seed, itemCount: 999 };
  assert.ok(validateIrlSeed(broken).some((p) => p.includes('itemCount says 999')));
});
