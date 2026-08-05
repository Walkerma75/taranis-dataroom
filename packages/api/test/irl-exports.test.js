/**
 * The PRE-FILLED and GAPS Excel exports.
 *
 * The exports are read back with the same library that wrote them, so these
 * assert on real workbook contents rather than on the builders' intentions.
 *
 * The assertion that matters most: GAPS is the sheet that goes out to a
 * counterparty, and no internal note may reach it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';

import {
  buildPrefilledWorkbook,
  buildGapsWorkbook,
  gapsRows,
  exportableItem,
  statusLabel,
  priorityLabel,
} from '../src/services/irl-exports.js';

const ITEMS = [
  {
    section: '1. Corporate & Structure', ref: '1.1',
    description: 'Certificate of incorporation', priority: 'medium',
    state: 'outstanding', already_held: null, source_document: null,
    note_for_company: 'Certified copy please',
  },
  {
    section: '1. Corporate & Structure', ref: '1.2',
    description: 'Group structure chart', priority: 'high',
    state: 'held', already_held: 'Chart dated March 2026',
    source_document: 'AdrenoMed pack, tab 3', note_for_company: null,
  },
  {
    section: '4. Financial', ref: '4.1',
    description: 'Audited accounts', priority: 'high',
    state: 'partially_held', already_held: '2024 only',
    source_document: null, note_for_company: '2025 still needed',
  },
  {
    section: '4. Financial', ref: '4.2',
    description: 'Management accounts', priority: 'standard',
    state: 'completed', already_held: null, source_document: 'Submitted 6 Aug',
    note_for_company: null,
  },
];

async function read(buffer, sheetName) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.getWorksheet(sheetName);
  const rows = [];
  sheet.eachRow((row, n) => {
    if (n === 1) return;
    rows.push(row.values.slice(1).map((v) => (v == null ? '' : String(v))));
  });
  return {
    headers: sheet.getRow(1).values.slice(1).map(String),
    rows,
    text: JSON.stringify(rows),
  };
}

// ---------------------------------------------------------------------------
// PRE-FILLED
// ---------------------------------------------------------------------------

test('PRE-FILLED carries the established six columns, in order', async () => {
  const buffer = await buildPrefilledWorkbook({ companyName: 'Example Bio', items: ITEMS });
  const { headers } = await read(buffer, 'PRE-FILLED');

  assert.deepEqual(headers, [
    'Section', 'Ref', 'Information requested', 'Status',
    'What Taranis already holds', 'Source document on file',
  ]);
});

test('PRE-FILLED lists every item, including the ones the company never sees', async () => {
  const buffer = await buildPrefilledWorkbook({ companyName: 'Example Bio', items: ITEMS });
  const { rows } = await read(buffer, 'PRE-FILLED');

  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map((r) => r[1]), ['1.1', '1.2', '4.1', '4.2']);
  // '1.2' is 'held' and hidden from the company view, but this is the
  // Taranis-side sheet and it belongs here.
  assert.equal(rows[1][3], 'Held');
});

// ---------------------------------------------------------------------------
// GAPS
// ---------------------------------------------------------------------------

test('GAPS carries the established six columns, in order', async () => {
  const buffer = await buildGapsWorkbook({ companyName: 'Example Bio', items: ITEMS });
  const { headers } = await read(buffer, 'GAPS');

  assert.deepEqual(headers, [
    'Section', 'Ref', 'Information still required', 'We already hold',
    'Priority', 'Notes for company',
  ]);
});

test('GAPS lists only what the company still owes', async () => {
  const buffer = await buildGapsWorkbook({ companyName: 'Example Bio', items: ITEMS });
  const { rows } = await read(buffer, 'GAPS');

  // 1.1 outstanding and 4.1 partially held are owed. 1.2 is held and 4.2 is
  // completed, so neither belongs on a list of what is still required.
  assert.deepEqual(rows.map((r) => r[1]), ['1.1', '4.1']);
});

test('GAPS cannot carry an internal note, even when one is present on the row', async () => {
  const withInternal = ITEMS.map((i) => ({
    ...i,
    internal_note: 'INTERNAL: their auditor resigned, do not put this in writing',
  }));

  const buffer = await buildGapsWorkbook({ companyName: 'Example Bio', items: withInternal });
  const { text } = await read(buffer, 'GAPS');

  assert.equal(text.includes('INTERNAL'), false);
  assert.equal(text.includes('auditor resigned'), false);
});

test('exportableItem drops the internal note before a builder can see it', () => {
  const shaped = exportableItem({
    section: 'S', ref: '1.1', description: 'D', priority: 'high', state: 'outstanding',
    already_held: null, note_for_company: null, source_document: null,
    internal_note: 'never leaves the building',
  });

  assert.equal('internal_note' in shaped, false);
  assert.equal(JSON.stringify(shaped).includes('never leaves'), false);
});

test('refs reach both sheets verbatim and are not renumbered', async () => {
  const prefilled = await read(
    await buildPrefilledWorkbook({ companyName: 'X', items: ITEMS }), 'PRE-FILLED'
  );
  const gaps = await read(
    await buildGapsWorkbook({ companyName: 'X', items: ITEMS }), 'GAPS'
  );

  assert.equal(prefilled.rows[0][1], '1.1');
  assert.equal(gaps.rows[0][1], '1.1');
  assert.equal(gaps.rows[1][1], '4.1');
});

// ---------------------------------------------------------------------------
// Labels and selection
// ---------------------------------------------------------------------------

test('gapsRows selects the states that mean the company still owes something', () => {
  const refs = gapsRows([
    { ref: 'a', state: 'outstanding' },
    { ref: 'b', state: 'partially_held' },
    { ref: 'c', state: 'attention_needed' },
    { ref: 'd', state: 'received' },
    { ref: 'e', state: 'in_review' },
    { ref: 'f', state: 'held' },
    { ref: 'g', state: 'completed' },
    { ref: 'h', state: 'not_applicable' },
  ]).map((i) => i.ref);

  assert.deepEqual(refs, ['a', 'b', 'c', 'd', 'e']);
});

test('labels are UK English with no em dashes', () => {
  const labels = [
    statusLabel('attention_needed'), statusLabel('partially_held'),
    statusLabel('not_applicable'), statusLabel('in_review'),
    priorityLabel('high'), priorityLabel('standard'),
  ];

  assert.deepEqual(labels, [
    'Attention needed', 'Partially held', 'Not applicable', 'In review',
    'High', 'Standard',
  ]);
  for (const label of labels) assert.equal(label.includes('—'), false);
});
