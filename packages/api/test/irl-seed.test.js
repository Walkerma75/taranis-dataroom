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

test('every item carries the seven columns the working files use, and the adviser flag', () => {
  for (const item of seed.items) {
    for (const key of [
      'section', 'ref', 'description', 'priority',
      'sort_order', 'already_held', 'note_for_company', 'adviser_restricted',
    ]) {
      assert.ok(key in item, `ref ${item.ref} is missing ${key}`);
    }
    assert.equal(typeof item.adviser_restricted, 'boolean', `ref ${item.ref}`);
  }
});

// ---------------------------------------------------------------------------
// Adviser restriction (HANDOVER-CW028 §3.2) and neutral wording (§3.8)
// ---------------------------------------------------------------------------

/** Confirmed by Mark on 11 September 2026, as drafted in CW028 §3.2. */
const RESTRICTED_REFS = [
  '1.4', '1.5', '1.10', '1.11',
  '7.5', '7.7', '7.12',
  '8.5', '8.7', '8.8',
  '11.3',
  '14.1', '14.2', '14.3', '14.4', '14.5', '14.6', '14.7', '14.8', '14.9', '14.10',
];

test('exactly the twenty-one confirmed refs are adviser-restricted, and no others', () => {
  const restricted = seed.items.filter((i) => i.adviser_restricted).map((i) => i.ref);
  assert.deepEqual(restricted, RESTRICTED_REFS);
  assert.equal(seed.adviserRestrictedCount, 21);
});

test('the whole of section 14 (AML / KYC) is restricted', () => {
  const section14 = seed.items.filter((i) => i.ref.startsWith('14.'));
  assert.equal(section14.length, 10);
  assert.ok(section14.every((i) => i.adviser_restricted));
});

test('the master names no particular company or programme', () => {
  const banned = /adreno\s?med|bio-?adm|dpp3|boost\s+phase\s+3|adrecizumab/i;
  for (const item of seed.items) {
    for (const field of ['section', 'description', 'already_held']) {
      assert.equal(banned.test(item[field] || ''), false, `ref ${item.ref} ${field}: ${item[field]}`);
    }
  }
  assert.equal(seed.items.find((i) => i.ref === '2.7').description,
    'Biomarker strategy and any companion diagnostics');
  assert.equal(seed.items.find((i) => i.ref === '3.3').description,
    'Protocol synopses for ongoing and planned trials');
});

test('the validator refuses an item without the adviser flag, so a pre-CW028 artefact cannot import', () => {
  const broken = JSON.parse(JSON.stringify(seed));
  delete broken.items[0].adviser_restricted;
  const problems = validateIrlSeed(broken);
  assert.ok(problems.some((p) => p.includes('adviser_restricted must be true or false')), problems.join('\n'));
});

test('the validator refuses master text that names the company or its programme', () => {
  for (const description of [
    'Biomarker strategy — bio-ADM / DPP3 and any companion diagnostics',
    'Protocol synopses for ongoing and planned trials (BOOST Phase 3)',
    'AdrenoMed cap table',
    'Adrecizumab CMC dossier',
  ]) {
    const broken = JSON.parse(JSON.stringify(seed));
    broken.items[0].description = description;
    const problems = validateIrlSeed(broken);
    assert.ok(problems.some((p) => p.includes('ref 1.1, description')), `${description}: ${problems.join('; ')}`);
  }
});

test('a company name in note_for_company is not a master-text problem', () => {
  // The guard is for master and template text only (CW028 §3.8 item 3); a
  // per-company note legitimately names the company.
  const seedCopy = JSON.parse(JSON.stringify(seed));
  seedCopy.items[0].note_for_company = 'AdrenoMed: please confirm the current version';
  assert.deepEqual(validateIrlSeed(seedCopy), []);
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
  assert.equal(seed.source, 'Biotech_KSA_IRL_Master_Seed_v1.1_11Sep2026.xlsx');
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
