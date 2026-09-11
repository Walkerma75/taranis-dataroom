/**
 * Convert an IRL master spreadsheet into the committed JSON seed the API reads.
 *
 * WHY THE INDIRECTION. The master lives in the fund paperwork folder on a
 * workstation. The API container cannot read that path, and the deal team edits
 * the spreadsheet, not the repo. So the spreadsheet is converted here, once, by
 * hand, and the JSON artefact is committed: the import is then reproducible in
 * production and the tests can assert on it without a spreadsheet or a network.
 *
 * Re-run this, and commit the result, whenever the master changes.
 *
 *   node tools/build-irl-seed.mjs \
 *     "<path to the .xlsx>" \
 *     packages/api/src/db/seeds/biotech-ksa-irl-v1.json
 *
 * Refs are permanent identifiers companies quote back in correspondence. This
 * script copies them verbatim and refuses to run if any is duplicated. It never
 * renumbers anything, and `sort_order` comes from the sheet rather than from
 * row position, so an inserted row cannot shift the others.
 */
import fs from 'fs';
import path from 'path';
import ExcelJS from 'exceljs';
// The same guard the API uses, imported rather than restated: a term added to
// COMPANY_UNSAFE_PATTERNS has to take effect here too, or the spreadsheet
// becomes the way round it (HANDOVER-CW019 §3.3).
import {
  findUnsafeRowText, describeUnsafe,
} from '../packages/api/src/services/company-visible-text.js';

const COLUMNS = [
  'section', 'ref', 'description', 'priority',
  'sort_order', 'already_held', 'note_for_company',
];

const [, , inputPath, outputPath, sheetNameArg] = process.argv;

if (!inputPath || !outputPath) {
  console.error('Usage: node tools/build-irl-seed.mjs <input.xlsx> <output.json> [sheetName]');
  process.exit(1);
}

const sheetName = sheetNameArg || 'IRL master';

const workbook = new ExcelJS.Workbook();
await workbook.xlsx.readFile(inputPath);

const sheet = workbook.getWorksheet(sheetName);
if (!sheet) {
  console.error(`Sheet "${sheetName}" not found. Sheets present: ${workbook.worksheets.map((w) => w.name).join(', ')}`);
  process.exit(1);
}

const cell = (row, i) => {
  const value = row.getCell(i).value;
  if (value === null || value === undefined) return null;
  if (typeof value === 'object' && 'richText' in value) {
    return value.richText.map((r) => r.text).join('');
  }
  if (typeof value === 'object' && 'text' in value) return value.text;
  return value;
};

// Header row, checked rather than trusted: a reordered column would silently
// put priorities in the description field.
const header = COLUMNS.map((_, i) => String(cell(sheet.getRow(1), i + 1) || '').trim());
if (header.join('|') !== COLUMNS.join('|')) {
  console.error('Unexpected header row.');
  console.error(`  expected: ${COLUMNS.join(', ')}`);
  console.error(`  found:    ${header.join(', ')}`);
  process.exit(1);
}

const items = [];
sheet.eachRow((row, number) => {
  if (number === 1) return;
  const section = cell(row, 1);
  const ref = cell(row, 2);
  if (!section && !ref) return;   // trailing blank row

  items.push({
    section: String(section).trim(),
    ref: String(ref).trim(),
    description: String(cell(row, 3) ?? '').trim(),
    priority: String(cell(row, 4) ?? 'standard').trim().toLowerCase(),
    sort_order: Number(cell(row, 5)),
    already_held: cell(row, 6) ? String(cell(row, 6)).trim() : null,
    note_for_company: cell(row, 7) ? String(cell(row, 7)).trim() : null,
  });
});

// Validate before writing. A seed that is wrong is worse than one that failed.
const refs = new Set();
const problems = [];
for (const item of items) {
  if (refs.has(item.ref)) problems.push(`duplicate ref: ${item.ref}`);
  refs.add(item.ref);
  if (!['high', 'medium', 'standard'].includes(item.priority)) {
    problems.push(`ref ${item.ref}: unexpected priority "${item.priority}"`);
  }
  if (!item.description) problems.push(`ref ${item.ref}: empty description`);
  if (!Number.isInteger(item.sort_order)) {
    problems.push(`ref ${item.ref}: sort_order is not an integer`);
  }
  // A CASS score or an internal source in a company-visible column. The master
  // is the earliest point this can be caught, and catching it here means the
  // deal team fixes the spreadsheet rather than the committed artefact.
  for (const hit of findUnsafeRowText(item)) problems.push(describeUnsafe(hit));
}
if (problems.length) {
  console.error('Refusing to write the seed:');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

const sections = [...new Set(items.map((i) => i.section))];
const priorities = items.reduce((acc, i) => {
  acc[i.priority] = (acc[i.priority] || 0) + 1;
  return acc;
}, {});

const seed = {
  source: path.basename(inputPath),
  sheet: sheetName,
  itemCount: items.length,
  sectionCount: sections.length,
  priorityCounts: priorities,
  items,
};

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(seed, null, 2)}\n`, 'utf8');

console.log(`Wrote ${outputPath}`);
console.log(`  ${items.length} items, ${refs.size} unique refs, ${sections.length} sections`);
console.log(`  priorities: ${Object.entries(priorities).map(([k, v]) => `${k} ${v}`).join(', ')}`);
