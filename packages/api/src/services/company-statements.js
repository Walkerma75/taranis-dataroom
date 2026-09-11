/**
 * "Cannot provide" responses: the rules, as plain functions.
 *
 * A company can now say formally that a checklist document cannot be provided,
 * with a reason and an explanation, instead of uploading a blank PDF or an
 * image called NA.png to carry the answer in its description (HANDOVER-CW026).
 * A response is a row in `company_files` with `kind = 'statement'` (migration
 * 022), so it travels the same staging, submission, receipt, review and
 * supersede path as a file. What is different about it lives here.
 *
 * Nothing in this module touches the database, so every rule can be tested
 * without one. The routes do the scoping, the locking and the writing.
 */
import { formatDate } from './notifications.js';

/** Stored values, in the order the company is offered them. CW026 §3.1. */
export const STATEMENT_REASONS = Object.freeze([
  'not_applicable',
  'does_not_exist',
  'not_yet_available',
  'provided_elsewhere',
  'other',
]);

export const EXPLANATION_MIN = 20;
export const EXPLANATION_MAX = 1000;

/** True for a response row, in either database or API shape. */
export function isStatement(row) {
  return row?.kind === 'statement';
}

/**
 * 'YYYY-MM-DD' from whatever the database or a client handed over.
 *
 * node-postgres turns a DATE column into a JavaScript Date at LOCAL midnight,
 * so reading its UTC parts would move it a day in any zone east of Greenwich.
 * A Date is therefore read by its local parts, which is how it was built; a
 * string is taken as written. Anything else is null.
 */
export function dateOnly(value) {
  if (!value) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    const pad = (n) => String(n).padStart(2, '0');
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value));
  if (!match) return null;
  const [, y, m, d] = match.map(Number);
  const check = new Date(Date.UTC(y, m - 1, d));
  // Reject 2026-02-31 and friends rather than let Date roll them over.
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) {
    return null;
  }
  return `${match[1]}-${match[2]}-${match[3]}`;
}

/** Today's date in UTC, 'YYYY-MM-DD'. */
export function todayUtc(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

/** '30 October 2026', the §3.4 date format, from 'YYYY-MM-DD'. */
export function formatExpectedDate(value) {
  const day = dateOnly(value);
  return day ? formatDate(new Date(`${day}T00:00:00Z`)) : '';
}

/**
 * The display label, verbatim from CW026 §3.4. Stored in `filename`, so it is
 * what every list, receipt, export and email shows for a response.
 */
export function statementLabel({ reason, expectedDate, relatedItemRef }) {
  switch (reason) {
    case 'not_applicable': return 'No document (not applicable)';
    case 'does_not_exist': return 'No document (does not exist)';
    case 'not_yet_available': return `No document (expected ${formatExpectedDate(expectedDate)})`;
    case 'provided_elsewhere': return `No document (provided under ${relatedItemRef})`;
    case 'other': return 'No document (other reason)';
    default: return 'No document';
  }
}

/**
 * Validate the parts of a response a client sends, before anything is looked up.
 *
 * Returns `{ value }` with the fields normalised, or `{ error }` with a message
 * a company user can act on. A field that belongs to another reason is dropped
 * rather than refused, so a form that changed reason half way does not fail on
 * a leftover date. Whether a related item exists and belongs to this company is
 * the route's check, because it needs the database.
 */
export function validateStatementInput(body = {}, { now = new Date() } = {}) {
  const reason = String(body.reason || '').trim();
  if (!STATEMENT_REASONS.includes(reason)) {
    return { error: 'Choose why this document cannot be provided.' };
  }

  const explanation = String(body.explanation ?? '').trim();
  if (explanation.length < EXPLANATION_MIN) {
    return {
      error: `Please explain in at least ${EXPLANATION_MIN} characters. This is the company's `
        + 'formal answer to the request, so it needs to say why.',
    };
  }
  if (explanation.length > EXPLANATION_MAX) {
    return { error: 'The explanation can be at most 1,000 characters.' };
  }

  let expectedDate = null;
  if (reason === 'not_yet_available') {
    expectedDate = dateOnly(body.expectedDate);
    if (!expectedDate) return { error: 'Give the date by which you expect to provide it.' };
    if (expectedDate < todayUtc(now)) return { error: 'The expected date must be today or later.' };
  }

  let relatedItemId = null;
  if (reason === 'provided_elsewhere') {
    relatedItemId = String(body.relatedItemId || '').trim() || null;
    if (!relatedItemId) return { error: 'Choose the item you have already provided it under.' };
  }

  return { value: { reason, explanation, expectedDate, relatedItemId } };
}

/**
 * An accepted "not yet available" response.
 *
 * Accepting one means "we accept your timetable", not "request satisfied", so
 * it must never make an item Completed (CW026 §3.7 outcome 3). `deriveItemState`
 * leaves it out of the reckoning.
 */
export function isAcceptedTimetable(row) {
  return isStatement(row)
    && row.statement_reason === 'not_yet_available'
    && row.status === 'completed';
}

/**
 * The date an item is "Expected by the company", or null (CW026 §3.7 item 4).
 *
 * From the current submitted 'not_yet_available' response on the item. A staged
 * one has not been sent to Taranis yet, so it does not set the date either side
 * sees; a superseded one has been answered.
 */
export function expectedByFrom(rows = []) {
  const current = rows
    .filter((r) => isStatement(r)
      && r.statement_reason === 'not_yet_available'
      && r.upload_state === 'submitted'
      && !r.deleted_at
      && r.status !== 'superseded')
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  return current.length ? dateOnly(current[0].expected_date) : null;
}

/**
 * The response fields every API view adds to a file row. `sizeBytes` is null,
 * never 0, for a response, so no client infers "no document" from a missing
 * value (CW026 §3.3).
 */
export function statementFields(row) {
  const statement = isStatement(row);
  return {
    kind: row.kind || 'file',
    statementReason: statement ? row.statement_reason : null,
    expectedDate: statement ? dateOnly(row.expected_date) : null,
    relatedItemId: statement ? (row.related_item_id || null) : null,
    relatedItemRef: statement ? (row.related_item_ref || null) : null,
    sizeBytes: row.size_bytes === null || row.size_bytes === undefined ? null : Number(row.size_bytes),
  };
}
