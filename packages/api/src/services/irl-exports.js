/**
 * The two Excel exports of a company's Information Request List.
 *
 * These are not decorative. They are the working files the deal team already
 * exchanges by hand, so their columns are fixed by what people are used to
 * reading rather than by what is convenient to emit. The column sets come from
 * HANDOVER-C002 §3.3 and code brief §6.1:
 *
 *   PRE-FILLED  Section | Ref | Information requested | Status |
 *               What Taranis already holds | Source document on file
 *
 *   GAPS        Section | Ref | Information still required | We already hold |
 *               Priority | Notes for company
 *
 * PRE-FILLED is the whole list, Taranis-side, and it may name internal sources
 * because it is never sent anywhere. GAPS is what the company still owes and is
 * the one that goes out, so two separate things have to hold of it: the
 * `internal_note` column is excluded structurally, by never being selected into
 * the row shape these builders accept, AND the free text in the columns that
 * ARE company-visible is checked for CASS scores and internal sources before a
 * row is written (services/company-visible-text.js, HANDOVER-CW019). Both are
 * asserted in the tests.
 *
 * `ref` is a permanent identifier the company quotes back in correspondence.
 * Both sheets carry it verbatim and neither ever renumbers.
 */
import ExcelJS from 'exceljs';
import { findUnsafeRowText, describeUnsafe } from './company-visible-text.js';

/**
 * A GAPS export refused because a row carries a CASS score or an internal
 * source. Mapped to 409 by the export route: the request is well formed, the
 * stored data is not fit to send.
 */
export class GapsContentError extends Error {
  constructor(companyName, problems) {
    super(`The GAPS export for ${companyName} carries text the company must not see`);
    this.name = 'GapsContentError';
    this.code = 'GAPS_UNSAFE_CONTENT';
    this.problems = problems;
  }
}

const TARANIS_GREEN = 'FF2C3E35';

/** Item states that mean the company still owes something. */
const OUTSTANDING_STATES = [
  'outstanding', 'partially_held', 'attention_needed', 'received', 'in_review',
];

/** Human-readable status for the PRE-FILLED Status column. UK English. */
export function statusLabel(state) {
  return {
    outstanding: 'Outstanding',
    partially_held: 'Partially held',
    held: 'Held',
    received: 'Received',
    in_review: 'In review',
    attention_needed: 'Attention needed',
    completed: 'Completed',
    not_applicable: 'Not applicable',
  }[state] || state;
}

export function priorityLabel(priority) {
  return { high: 'High', medium: 'Medium', standard: 'Standard' }[priority] || priority;
}

/** The rows that belong on the GAPS sheet. */
export function gapsRows(items = []) {
  return items.filter((i) => OUTSTANDING_STATES.includes(i.state));
}

function styleHeader(sheet) {
  const header = sheet.getRow(1);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: TARANIS_GREEN } };
  header.alignment = { vertical: 'middle' };
  header.height = 22;
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
}

/**
 * @param {object} opts
 * @param {string} opts.companyName
 * @param {Array}  opts.items  rows from company_irl_items
 * @returns {Promise<Buffer>}
 */
export async function buildPrefilledWorkbook({ companyName, items = [] }) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Taranis Capital Data Room';
  const sheet = workbook.addWorksheet('PRE-FILLED');

  sheet.columns = [
    { header: 'Section', key: 'section', width: 34 },
    { header: 'Ref', key: 'ref', width: 10 },
    { header: 'Information requested', key: 'description', width: 72 },
    { header: 'Status', key: 'status', width: 18 },
    { header: 'What Taranis already holds', key: 'alreadyHeld', width: 44 },
    { header: 'Source document on file', key: 'source', width: 40 },
  ];
  styleHeader(sheet);

  for (const item of items) {
    sheet.addRow({
      section: item.section,
      ref: item.ref,
      description: item.description,
      status: statusLabel(item.state),
      alreadyHeld: item.already_held || '',
      source: item.source_document || '',
    });
  }

  sheet.getColumn('description').alignment = { wrapText: true, vertical: 'top' };
  sheet.getColumn('alreadyHeld').alignment = { wrapText: true, vertical: 'top' };

  const meta = workbook.addWorksheet('About');
  meta.columns = [{ width: 26 }, { width: 80 }];
  meta.addRow(['Company', companyName]);
  meta.addRow(['Export', 'PRE-FILLED']);
  meta.addRow(['Generated', new Date().toISOString()]);
  meta.addRow(['Note', 'Refs are permanent identifiers. Do not renumber them.']);

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

/**
 * The GAPS export. This is the sheet that is sent to the company.
 *
 * THREE OF ITS SIX COLUMNS ARE COMPANY-VISIBLE FREE TEXT: `description`,
 * `already_held` ("We already hold") and `note_for_company` ("Notes for
 * company"), alongside the fixed section, ref and priority. `internal_note` is
 * excluded structurally, by never being part of the shape `exportableItem`
 * produces, and that remains true.
 *
 * An earlier version of this comment said only that no internal note reaches
 * the sheet. That was true and beside the point: the KardiaNova wording of 14
 * August 2026 reached a founder through `already_held`, which is not an
 * internal note and was never filtered. Excluding one column is not the same as
 * the text being safe, so the text itself is now checked (HANDOVER-CW019 §3.4).
 *
 * On a hit this throws rather than writing a redacted sheet. A half-redacted
 * GAPS file looks finished and would be sent; a failed export makes somebody
 * fix the data, which is the only thing that actually removes the problem.
 *
 * @throws {GapsContentError}
 */
export async function buildGapsWorkbook({ companyName, items = [] }) {
  const rows = gapsRows(items);

  const unsafe = rows.flatMap(findUnsafeRowText);
  if (unsafe.length) {
    console.error(
      `[irl-exports] GAPS export blocked for ${companyName}: `
      + unsafe.map(describeUnsafe).join('; ')
    );
    throw new GapsContentError(companyName, unsafe);
  }

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Taranis Capital Data Room';
  const sheet = workbook.addWorksheet('GAPS');

  sheet.columns = [
    { header: 'Section', key: 'section', width: 34 },
    { header: 'Ref', key: 'ref', width: 10 },
    { header: 'Information still required', key: 'description', width: 72 },
    { header: 'We already hold', key: 'alreadyHeld', width: 44 },
    { header: 'Priority', key: 'priority', width: 12 },
    { header: 'Notes for company', key: 'note', width: 50 },
  ];
  styleHeader(sheet);

  for (const item of rows) {
    sheet.addRow({
      section: item.section,
      ref: item.ref,
      description: item.description,
      alreadyHeld: item.already_held || '',
      priority: priorityLabel(item.priority),
      note: item.note_for_company || '',
    });
  }

  sheet.getColumn('description').alignment = { wrapText: true, vertical: 'top' };
  sheet.getColumn('note').alignment = { wrapText: true, vertical: 'top' };

  const meta = workbook.addWorksheet('About');
  meta.columns = [{ width: 26 }, { width: 80 }];
  meta.addRow(['Company', companyName]);
  meta.addRow(['Export', 'GAPS']);
  meta.addRow(['Generated', new Date().toISOString()]);
  meta.addRow(['Note', 'Refs are permanent identifiers. Please quote them in correspondence.']);

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

/**
 * Reduce a database row to exactly the fields an export may see.
 *
 * This is the only shape the builders above accept, and `internal_note` is not
 * in it. An internal note therefore cannot reach a company-facing spreadsheet
 * by anyone forgetting to exclude it at the query.
 */
export function exportableItem(row) {
  return {
    section: row.section,
    ref: row.ref,
    description: row.description,
    priority: row.priority,
    state: row.state,
    already_held: row.already_held,
    note_for_company: row.note_for_company,
    source_document: row.source_document,
  };
}
