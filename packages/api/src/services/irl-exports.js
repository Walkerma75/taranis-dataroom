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
 * PRE-FILLED is the whole list, Taranis-side. GAPS is what the company still
 * owes, and it is the one that can be sent out, so it must never carry an
 * internal note. That is enforced by never selecting the column into the row
 * shape these builders accept, and asserted in the tests.
 *
 * `ref` is a permanent identifier the company quotes back in correspondence.
 * Both sheets carry it verbatim and neither ever renumbers.
 */
import ExcelJS from 'exceljs';

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
 * The GAPS export. Company-facing, so no internal note reaches it.
 */
export async function buildGapsWorkbook({ companyName, items = [] }) {
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

  for (const item of gapsRows(items)) {
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
