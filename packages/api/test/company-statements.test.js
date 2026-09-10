/**
 * "Cannot provide" responses (HANDOVER-CW026, reply HANDOVER-C026).
 *
 * The rules are pure and tested directly. The routes are driven through the
 * real routers against the fake pool, which proves what each handler asks the
 * database and in what order; the migration's CHECK constraints and index are
 * verified against a real PostgreSQL separately and recorded in C026.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import companyPortalRoutes from '../src/routes/company-portal.js';
import companyRoutes, { companyFilesRouter, reviewQueueRouter } from '../src/routes/companies.js';
import {
  STATEMENT_REASONS,
  statementLabel,
  validateStatementInput,
  dateOnly,
  expectedByFrom,
  statementFields,
} from '../src/services/company-statements.js';
import { deriveItemState } from '../src/services/companies.js';
import { UNSTARTED_ITEM_STATES, bucketOf, BUCKET_TARANIS } from '../src/services/dd-summary.js';
import {
  buildPrefilledWorkbook, buildGapsWorkbook, exportableItem, companyResponses,
} from '../src/services/irl-exports.js';
import { renderTemplate } from '../src/services/email-templates/index.js';
import {
  fakePool, membershipRow, membershipHandler, tokenFor, startTestServer,
} from './helpers/test-app.js';

const COMPANY_A = '11111111-1111-4111-8111-111111111111';
const ITEM_1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const ITEM_2 = 'aaaaaaaa-0000-4000-8000-000000000002';
const FILE_1 = 'bbbbbbbb-0000-4000-8000-000000000001';
const STATEMENT_1 = 'cccccccc-0000-4000-8000-000000000001';

const MOUNTS = [
  ['/company', companyPortalRoutes],
  ['/companies', companyRoutes],
  ['/company-files', companyFilesRouter],
  ['/review-queue', reviewQueueRouter],
];

const NOW = new Date('2026-09-10T12:00:00Z');
const EXPLANATION = 'The company has no subsidiaries, so there are no subsidiary accounts.';

const companyToken = (companyRole = 'company_admin') =>
  tokenFor({ role: 'company', companyId: COMPANY_A, companyRole });
const adminToken = () => tokenFor({ role: 'admin', sub: 'admin-1' });

// ---------------------------------------------------------------------------
// The label, verbatim from CW026 §3.4
// ---------------------------------------------------------------------------

test('the five reasons and their display labels are exactly as briefed', () => {
  assert.deepEqual(STATEMENT_REASONS, [
    'not_applicable', 'does_not_exist', 'not_yet_available', 'provided_elsewhere', 'other',
  ]);
  assert.equal(statementLabel({ reason: 'not_applicable' }), 'No document (not applicable)');
  assert.equal(statementLabel({ reason: 'does_not_exist' }), 'No document (does not exist)');
  assert.equal(
    statementLabel({ reason: 'not_yet_available', expectedDate: '2026-10-30' }),
    'No document (expected 30 October 2026)'
  );
  assert.equal(
    statementLabel({ reason: 'provided_elsewhere', relatedItemRef: '3.4' }),
    'No document (provided under 3.4)'
  );
  assert.equal(statementLabel({ reason: 'other' }), 'No document (other reason)');
});

test('a DATE read back from the database keeps its day in any time zone', () => {
  // node-postgres builds a DATE as local midnight; reading its UTC parts would
  // move it a day east of Greenwich.
  assert.equal(dateOnly(new Date(2026, 9, 30)), '2026-10-30');
  assert.equal(dateOnly('2026-10-30'), '2026-10-30');
  assert.equal(dateOnly('2026-02-31'), null, 'an impossible date is refused, not rolled over');
  assert.equal(dateOnly('30/10/2026'), null);
  assert.equal(dateOnly(null), null);
});

// ---------------------------------------------------------------------------
// Validation, CW026 §3.1
// ---------------------------------------------------------------------------

test('the explanation must be at least 20 characters after trimming, and at most 1,000', () => {
  const short = validateStatementInput({ reason: 'other', explanation: '   Not available.   ' }, { now: NOW });
  assert.match(short.error, /at least 20 characters/);

  const exact = validateStatementInput({ reason: 'other', explanation: '12345678901234567890' }, { now: NOW });
  assert.equal(exact.error, undefined);

  const long = validateStatementInput({ reason: 'other', explanation: 'x'.repeat(1001) }, { now: NOW });
  assert.match(long.error, /1,000 characters/);
});

test('an unknown reason is refused', () => {
  assert.match(validateStatementInput({ reason: 'lost', explanation: EXPLANATION }).error, /Choose why/);
  assert.match(validateStatementInput({ explanation: EXPLANATION }).error, /Choose why/);
});

test('"not yet available" needs a date that is today or later', () => {
  const none = validateStatementInput({ reason: 'not_yet_available', explanation: EXPLANATION }, { now: NOW });
  assert.match(none.error, /date/);

  const past = validateStatementInput(
    { reason: 'not_yet_available', explanation: EXPLANATION, expectedDate: '2026-09-09' }, { now: NOW }
  );
  assert.match(past.error, /today or later/);

  const today = validateStatementInput(
    { reason: 'not_yet_available', explanation: EXPLANATION, expectedDate: '2026-09-10' }, { now: NOW }
  );
  assert.equal(today.value.expectedDate, '2026-09-10');
});

test('"provided elsewhere" needs an item; fields for other reasons are dropped, not refused', () => {
  const none = validateStatementInput({ reason: 'provided_elsewhere', explanation: EXPLANATION });
  assert.match(none.error, /Choose the item/);

  const leftover = validateStatementInput({
    reason: 'not_applicable', explanation: EXPLANATION, expectedDate: '2027-01-01', relatedItemId: ITEM_2,
  }, { now: NOW });
  assert.equal(leftover.value.expectedDate, null);
  assert.equal(leftover.value.relatedItemId, null);
});

// ---------------------------------------------------------------------------
// Item state, CW026 §3.7
// ---------------------------------------------------------------------------

const submittedFile = (status) => ({ kind: 'file', upload_state: 'submitted', status, deleted_at: null });
const response = (reason, status) => ({
  kind: 'statement', statement_reason: reason, upload_state: 'submitted', status, deleted_at: null,
});

test('outcome 1: a response at Received, In review or Attention needed counts exactly like a file', () => {
  for (const reason of STATEMENT_REASONS) {
    assert.equal(deriveItemState([response(reason, 'received')], 'outstanding'), 'received');
    assert.equal(deriveItemState([response(reason, 'in_review')], 'outstanding'), 'in_review');
    assert.equal(deriveItemState([response(reason, 'attention_needed')], 'outstanding'), 'attention_needed');
  }
});

test('outcome 2: an accepted response counts like a completed file, except "not yet available"', () => {
  for (const reason of ['not_applicable', 'does_not_exist', 'provided_elsewhere', 'other']) {
    assert.equal(deriveItemState([response(reason, 'completed')], 'outstanding'), 'completed', reason);
  }
});

test('outcome 3: an accepted "not yet available" accepts the timetable and never completes the item', () => {
  // Alone: back to the baseline, whatever it is.
  assert.equal(deriveItemState([response('not_yet_available', 'completed')], 'outstanding'), 'outstanding');
  assert.equal(deriveItemState([response('not_yet_available', 'completed')], 'partially_held'), 'partially_held');

  // The mixed case: a completed 2024 file plus an accepted "2025 expected
  // 31 March 2027" is not a completed item.
  assert.equal(
    deriveItemState([submittedFile('completed'), response('not_yet_available', 'completed')], 'outstanding'),
    'outstanding'
  );

  // Anything still open on the other files is still reported.
  assert.equal(
    deriveItemState([submittedFile('attention_needed'), response('not_yet_available', 'completed')], 'outstanding'),
    'attention_needed'
  );
  assert.equal(
    deriveItemState([submittedFile('in_review'), response('not_yet_available', 'completed')], 'outstanding'),
    'in_review'
  );

  // Not yet accepted, it counts like a file.
  assert.equal(
    deriveItemState([submittedFile('completed'), response('not_yet_available', 'received')], 'outstanding'),
    'received'
  );
});

test('dd-summary: a response at Received is awaiting Taranis; an accepted timetable puts the item back with the company, unaged', () => {
  assert.equal(bucketOf('received'), BUCKET_TARANIS);
  const afterAcceptance = deriveItemState([response('not_yet_available', 'completed')], 'outstanding');
  assert.ok(UNSTARTED_ITEM_STATES.includes(afterAcceptance));
});

test('the expected date comes from the current submitted "not yet available" response only', () => {
  const at = (m) => new Date(`2026-09-${m}T10:00:00Z`);
  const rows = [
    { ...response('not_yet_available', 'superseded'), expected_date: '2026-10-01', created_at: at(1) },
    { ...response('not_yet_available', 'completed'), expected_date: new Date(2026, 9, 30), created_at: at(5) },
    { kind: 'statement', statement_reason: 'not_yet_available', upload_state: 'staged', expected_date: '2027-01-01', created_at: at(9) },
  ];
  assert.equal(expectedByFrom(rows), '2026-10-30');
  assert.equal(expectedByFrom([submittedFile('completed')]), null);
});

test('API fields: a response reports null size, never 0, and a file keeps its size', () => {
  const fields = statementFields({
    kind: 'statement', statement_reason: 'provided_elsewhere', related_item_id: ITEM_2,
    related_item_ref: '3.4', size_bytes: null,
  });
  assert.equal(fields.sizeBytes, null);
  assert.equal(fields.relatedItemRef, '3.4');
  assert.equal(statementFields({ kind: 'file', size_bytes: '1234' }).sizeBytes, 1234);
  assert.equal(statementFields({ size_bytes: '10' }).kind, 'file', 'a row from before migration 022 reads as a file');
});

// ---------------------------------------------------------------------------
// Recording a response: POST /company/statements
// ---------------------------------------------------------------------------

/** A company-side world in which item 1 exists and nothing answers it yet. */
function statementPool({
  item = { id: ITEM_1, ref: '1.3', description: 'Group structure chart', state: 'outstanding' },
  related = { id: ITEM_2, ref: '3.4', state: 'outstanding' },
  current = [],
  previous = null,
  role = 'company_admin',
} = {}) {
  return fakePool([
    membershipHandler(membershipRow({ companyId: COMPANY_A, companyRole: role })),
    ['SELECT id, irl_item_id, version, status, upload_state, kind', previous ? [previous] : []],
    ['SELECT id, ref, description, state FROM company_irl_items', item ? [item] : []],
    ['SELECT id, ref, state FROM company_irl_items WHERE id = $1 AND company_id = $2', related ? [related] : []],
    ['SELECT id, upload_state FROM company_files', current],
    ['INSERT INTO company_files', (p) => [{
      id: STATEMENT_1, company_id: p[0], irl_item_id: p[1], uploaded_by: p[2],
      filename: p[3], description: p[4], kind: 'statement', statement_reason: p[5],
      expected_date: p[6], related_item_id: p[7], version: p[8], supersedes: p[9],
      upload_state: 'staged', status: null, size_bytes: null, content_type: null,
      created_at: new Date(),
    }]],
    ['INSERT INTO notification_digest_events', [{ id: 'e-1' }]],
  ]);
}

async function record(t, body, pool = statementPool(), token = companyToken()) {
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());
  const res = await server.request('/company/statements', { method: 'POST', token, body });
  return { res, pool };
}

test('recording "it does not apply" stages a response row with no bytes, labelled, and tells the admin', async (t) => {
  const { res, pool } = await record(t, { irlItemId: ITEM_1, reason: 'not_applicable', explanation: EXPLANATION });

  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.kind, 'statement');
  assert.equal(res.body.filename, 'No document (not applicable)');
  assert.equal(res.body.sizeBytes, null);
  assert.equal(res.body.uploadState, 'staged');

  const insert = pool.calls.find((c) => c.text.includes('INSERT INTO company_files'));
  assert.match(insert.text, /'statement'/);
  assert.match(insert.text, /NULL, NULL, NULL, NULL/, 's3_key, size, type and scan state are NULL');
  assert.equal(insert.params[3], 'No document (not applicable)');
  assert.equal(insert.params[4], EXPLANATION, 'the explanation lives in description');

  // The item is locked for the one-current-response check.
  const lock = pool.calls.find((c) => c.text.includes('SELECT id, ref, description, state FROM company_irl_items'));
  assert.match(lock.text, /FOR UPDATE/);

  // Distinguishable from an upload in the audit trail.
  const audit = pool.calls.find((c) => c.text.includes('INSERT INTO audit_log'));
  assert.equal(audit.params[1], 'company_statement.recorded');

  // It reaches the admin like an upload does, through the session digest.
  const event = pool.calls.find((c) => c.text.includes('INSERT INTO notification_digest_events'));
  assert.equal(event.params[0], 'admin-uploads');
  assert.deepEqual(JSON.parse(event.params[3]), { fileId: STATEMENT_1 });
});

test('"not yet available" stores its date and says it in the label', async (t) => {
  const { res } = await record(t, {
    irlItemId: ITEM_1, reason: 'not_yet_available', explanation: EXPLANATION, expectedDate: '2099-10-30',
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.filename, 'No document (expected 30 October 2099)');
  assert.equal(res.body.expectedDate, '2099-10-30');
});

test('"provided elsewhere" points at another of the company\'s own items, by ref', async (t) => {
  const { res, pool } = await record(t, {
    irlItemId: ITEM_1, reason: 'provided_elsewhere', explanation: EXPLANATION, relatedItemId: ITEM_2,
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.filename, 'No document (provided under 3.4)');
  assert.equal(res.body.relatedItemRef, '3.4');
  const lookup = pool.calls.find((c) => c.text.includes('SELECT id, ref, state FROM company_irl_items'));
  assert.equal(lookup.params[1], COMPANY_A, 'scoped by the token, not by anything supplied');
});

test('"provided elsewhere" cannot point at the item itself, a hidden item or another company\'s item', async (t) => {
  const self = await record(t, {
    irlItemId: ITEM_1, reason: 'provided_elsewhere', explanation: EXPLANATION, relatedItemId: ITEM_1,
  });
  assert.equal(self.res.status, 400);

  const hidden = await record(t, {
    irlItemId: ITEM_1, reason: 'provided_elsewhere', explanation: EXPLANATION, relatedItemId: ITEM_2,
  }, statementPool({ related: { id: ITEM_2, ref: '3.4', state: 'held' } }));
  assert.equal(hidden.res.status, 400);

  const foreign = await record(t, {
    irlItemId: ITEM_1, reason: 'provided_elsewhere', explanation: EXPLANATION, relatedItemId: ITEM_2,
  }, statementPool({ related: null }));
  assert.equal(foreign.res.status, 400);
  assert.equal(foreign.pool.sql().some((s) => s.includes('INSERT INTO company_files')), false);
});

test('validation is enforced by the server, before anything is written', async (t) => {
  for (const body of [
    { irlItemId: ITEM_1, reason: 'not_applicable', explanation: 'Too short.' },
    { irlItemId: ITEM_1, reason: 'not_yet_available', explanation: EXPLANATION, expectedDate: '2001-01-01' },
    { irlItemId: ITEM_1, reason: 'invented', explanation: EXPLANATION },
  ]) {
    const { res, pool } = await record(t, body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(pool.sql().some((s) => s.includes('INSERT INTO company_files')), false);
  }
});

test('a held item answers 404, like an item that does not exist', async (t) => {
  const held = await record(t, { irlItemId: ITEM_1, reason: 'not_applicable', explanation: EXPLANATION },
    statementPool({ item: { id: ITEM_1, ref: '1.3', description: 'x', state: 'held' } }));
  assert.equal(held.res.status, 404);

  const missing = await record(t, { irlItemId: ITEM_1, reason: 'not_applicable', explanation: EXPLANATION },
    statementPool({ item: null }));
  assert.equal(missing.res.status, 404);
});

test('a second current response on an item is refused with 409', async (t) => {
  const submitted = await record(t, { irlItemId: ITEM_1, reason: 'not_applicable', explanation: EXPLANATION },
    statementPool({ current: [{ id: 'old', upload_state: 'submitted' }] }));
  assert.equal(submitted.res.status, 409);
  assert.match(submitted.res.body.error, /Replace this response/);

  const staged = await record(t, { irlItemId: ITEM_1, reason: 'not_applicable', explanation: EXPLANATION },
    statementPool({ current: [{ id: 'old', upload_state: 'staged' }] }));
  assert.equal(staged.res.status, 409);
  assert.match(staged.res.body.error, /Edit or remove/);
  assert.ok(staged.pool.sql().includes('ROLLBACK'));
});

test('a Viewer cannot record a response', async (t) => {
  const { res, pool } = await record(t, { irlItemId: ITEM_1, reason: 'not_applicable', explanation: EXPLANATION },
    statementPool({ role: 'company_viewer' }), companyToken('company_viewer'));
  assert.equal(res.status, 403);
  assert.equal(pool.sql().some((s) => s.includes('INSERT INTO company_files')), false);
});

test('a Contributor can record a response', async (t) => {
  const { res } = await record(t, { irlItemId: ITEM_1, reason: 'does_not_exist', explanation: EXPLANATION },
    statementPool({ role: 'company_contributor' }), companyToken('company_contributor'));
  assert.equal(res.status, 201);
});

// ---------------------------------------------------------------------------
// Replacement in both directions, CW026 §3.2
// ---------------------------------------------------------------------------

test('file to response: a response can replace a submitted file, as its next version', async (t) => {
  const previous = {
    id: FILE_1, irl_item_id: ITEM_1, version: 1, status: 'attention_needed', upload_state: 'submitted', kind: 'file',
  };
  const { res, pool } = await record(t, {
    replacesFileId: FILE_1, reason: 'does_not_exist', explanation: EXPLANATION,
  }, statementPool({ previous }));

  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.supersedes, FILE_1);
  assert.equal(res.body.version, 2);
  // Retired at submission, not now: nothing here touches the predecessor.
  assert.equal(pool.sql().some((s) => s.includes("SET status = 'superseded'")), false);
});

test('a response replacing a file that was never submitted removes that file rather than superseding it', async (t) => {
  const previous = {
    id: FILE_1, irl_item_id: ITEM_1, version: 1, status: null, upload_state: 'staged', kind: 'file',
  };
  const { res, pool } = await record(t, {
    replacesFileId: FILE_1, reason: 'does_not_exist', explanation: EXPLANATION,
  }, statementPool({ previous }));

  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.supersedes, null, 'nothing was sent, so nothing is superseded');
  assert.equal(res.body.version, 1);

  const order = pool.sql();
  const removeAt = order.findIndex((s) => s.includes('UPDATE company_files SET deleted_at = NOW()'));
  assert.ok(removeAt > order.indexOf('BEGIN') && removeAt < order.indexOf('COMMIT'), 'removed in the same transaction');
  const removedAudit = pool.calls.find((c) => c.text.includes('INSERT INTO audit_log') && c.params[1] === 'company_file.deleted_staged');
  assert.equal(JSON.parse(removedAudit.params[4]).replacedByStatement, STATEMENT_1);
});

test('a response can replace a submitted response (Replace this response)', async (t) => {
  const previous = {
    id: 'old-statement', irl_item_id: ITEM_1, version: 1, status: 'attention_needed', upload_state: 'submitted', kind: 'statement',
  };
  const { res } = await record(t, {
    replacesFileId: 'old-statement', reason: 'other', explanation: EXPLANATION,
  }, statementPool({ previous, current: [{ id: 'old-statement', upload_state: 'submitted' }] }));
  assert.equal(res.status, 201, 'the response being replaced does not count against the one-current rule');
});

test('a replacement is refused for a superseded version, a staged response, or additional material', async (t) => {
  const superseded = await record(t, { replacesFileId: FILE_1, reason: 'other', explanation: EXPLANATION },
    statementPool({ previous: { id: FILE_1, irl_item_id: ITEM_1, version: 1, status: 'superseded', upload_state: 'submitted', kind: 'file' } }));
  assert.equal(superseded.res.status, 409);

  const staged = await record(t, { replacesFileId: STATEMENT_1, reason: 'other', explanation: EXPLANATION },
    statementPool({ previous: { id: STATEMENT_1, irl_item_id: ITEM_1, version: 1, status: null, upload_state: 'staged', kind: 'statement' } }));
  assert.equal(staged.res.status, 409);

  const additional = await record(t, { replacesFileId: FILE_1, reason: 'other', explanation: EXPLANATION },
    statementPool({ previous: { id: FILE_1, irl_item_id: null, version: 1, status: 'received', upload_state: 'submitted', kind: 'file' } }));
  assert.equal(additional.res.status, 400);
});

test('response to file: a submitted response can be replaced by the document', async (t) => {
  const { setStorage, resetStorage, MemoryStorage } = await import('../src/services/storage.js');
  const { setScanner, resetScanner, StubScanner } = await import('../src/services/scanner.js');
  setStorage(new MemoryStorage());
  setScanner(new StubScanner({ warnOnUse: false }));
  t.after(() => { resetStorage(); resetScanner(); });

  const pool = fakePool([
    membershipHandler(membershipRow({ companyId: COMPANY_A })),
    ['SELECT * FROM company_files', [{
      id: STATEMENT_1, company_id: COMPANY_A, irl_item_id: ITEM_1, kind: 'statement',
      statement_reason: 'not_yet_available', upload_state: 'submitted', status: 'completed',
      version: 1, deleted_at: null,
    }]],
    ['INSERT INTO company_files', (p) => [{
      id: p[0], company_id: COMPANY_A, irl_item_id: ITEM_1, filename: p[4], description: p[5],
      size_bytes: p[7], version: p[9], supersedes: p[10], kind: 'file', upload_state: 'staged',
    }]],
  ]);
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  const form = new FormData();
  form.append('description', 'The 2025 audited accounts, now signed');
  form.append('file', new Blob(['%PDF-1.4 accounts'], { type: 'application/pdf' }), 'accounts-2025.pdf');
  const res = await fetch(`${server.base}/company/files/${STATEMENT_1}/replace`, {
    method: 'POST', headers: { Authorization: `Bearer ${companyToken()}` }, body: form,
  });
  const body = await res.json();

  assert.equal(res.status, 201, JSON.stringify(body));
  assert.equal(body.supersedes, STATEMENT_1);
  assert.equal(body.version, 2);
  assert.equal(body.kind, 'file');
});

test('a staged response cannot be replaced by a file: it is removed instead', async (t) => {
  const pool = fakePool([
    membershipHandler(membershipRow({ companyId: COMPANY_A })),
    ['SELECT * FROM company_files', [{
      id: STATEMENT_1, company_id: COMPANY_A, irl_item_id: ITEM_1, kind: 'statement',
      upload_state: 'staged', status: null, version: 1, deleted_at: null,
    }]],
  ]);
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  const form = new FormData();
  form.append('description', 'The real document');
  form.append('file', new Blob(['%PDF-1.4 x'], { type: 'application/pdf' }), 'doc.pdf');
  const res = await fetch(`${server.base}/company/files/${STATEMENT_1}/replace`, {
    method: 'POST', headers: { Authorization: `Bearer ${companyToken()}` }, body: form,
  });
  assert.equal(res.status, 409);
  assert.equal(pool.sql().some((s) => s.includes('INSERT INTO company_files')), false);
});

test('POST /company/files with no file still answers 400', async (t) => {
  const pool = fakePool([membershipHandler(membershipRow({ companyId: COMPANY_A }))]);
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  const form = new FormData();
  form.append('irlItemId', ITEM_1);
  form.append('description', 'We cannot provide this, see the note');
  const res = await fetch(`${server.base}/company/files`, {
    method: 'POST', headers: { Authorization: `Bearer ${companyToken()}` }, body: form,
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /A file is required/);
});

// ---------------------------------------------------------------------------
// Editing a staged response
// ---------------------------------------------------------------------------

test('a staged response is edited through its own route, and the label is rewritten with it', async (t) => {
  const pool = fakePool([
    membershipHandler(membershipRow({ companyId: COMPANY_A })),
    ['SELECT id, irl_item_id FROM company_files', [{ id: STATEMENT_1, irl_item_id: ITEM_1 }]],
    ['UPDATE company_files', (p) => [{
      id: p[0], company_id: COMPANY_A, irl_item_id: ITEM_1, kind: 'statement',
      statement_reason: p[2], expected_date: p[3], related_item_id: p[4],
      description: p[5], filename: p[6], upload_state: 'staged', size_bytes: null,
    }]],
  ]);
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  const res = await server.request(`/company/statements/${STATEMENT_1}`, {
    method: 'PATCH', token: companyToken(),
    body: { reason: 'not_yet_available', explanation: EXPLANATION, expectedDate: '2099-03-31' },
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.filename, 'No document (expected 31 March 2099)');

  const lock = pool.calls.find((c) => c.text.includes('SELECT id, irl_item_id FROM company_files'));
  assert.match(lock.text, /upload_state = 'staged'/, 'only a staged response can be edited');
  assert.equal(lock.params[1], COMPANY_A);
});

test('the plain description edit refuses a response', async (t) => {
  const pool = fakePool([
    membershipHandler(membershipRow({ companyId: COMPANY_A })),
    ['UPDATE company_files SET description', []],
    ['SELECT kind FROM company_files', [{ kind: 'statement' }]],
  ]);
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  const res = await server.request(`/company/files/${STATEMENT_1}`, {
    method: 'PATCH', token: companyToken(), body: { description: 'short' },
  });
  assert.equal(res.status, 409);
  const update = pool.calls.find((c) => c.text.includes('UPDATE company_files SET description'));
  assert.match(update.text, /kind = 'file'/);
});

// ---------------------------------------------------------------------------
// Submission: one batch, one receipt
// ---------------------------------------------------------------------------

test('a mixed batch, one response and one file, produces one receipt listing both at Received', async (t) => {
  const staged = (id, extra) => ({
    id, company_id: COMPANY_A, irl_item_id: ITEM_1, filename: `${id}.pdf`, description: 'A described file',
    upload_state: 'staged', status: null, deleted_at: null, kind: 'file', ...extra,
  });
  const pool = fakePool([
    membershipHandler(membershipRow({ companyId: COMPANY_A })),
    ['FROM company_files\n       WHERE id = ANY', [
      staged(STATEMENT_1, {
        kind: 'statement', filename: 'No document (not applicable)', description: EXPLANATION, irl_item_id: ITEM_2,
      }),
      staged(FILE_1),
    ]],
    ["nextval('company_receipt_ref_seq')", [{ n: 77 }]],
    ['INSERT INTO submission_batches', [{
      id: 'batch-1', receipt_ref: 'TRN-DD-2026-000077', submitted_at: new Date('2026-09-10T10:00:00Z'),
    }]],
    ['SELECT id, ref, description FROM company_irl_items', [
      { id: ITEM_1, ref: '1.3', description: 'Group structure chart' },
      { id: ITEM_2, ref: '1.7', description: 'Subsidiary accounts' },
    ]],
    ['INSERT INTO notification_outbox', [{ id: 'n-1' }]],
  ]);
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  const res = await server.request('/company/submit', {
    method: 'POST', token: companyToken(), body: { fileIds: [STATEMENT_1, FILE_1] },
  });
  assert.equal(res.status, 201);

  assert.equal(pool.sql().filter((s) => s.includes('INSERT INTO submission_batches')).length, 1);
  assert.equal(pool.sql().filter((s) => s.includes('INSERT INTO file_status_history')).length, 2);
  assert.match(pool.sql().join('\n'), /SET upload_state = 'submitted', status = 'received'/);

  const receipt = pool.calls.find((c) => c.text.includes('INSERT INTO notification_outbox') && c.params[0] === 'submission-receipt');
  const payload = JSON.parse(receipt.params[2]);
  assert.equal(payload.file_count, 2);
  assert.deepEqual(payload.files.map((f) => f.filename), ['No document (not applicable)', `${FILE_1}.pdf`]);
  assert.equal(payload.files[0].description, EXPLANATION);
});

// ---------------------------------------------------------------------------
// Taranis side: no bytes, ever
// ---------------------------------------------------------------------------

test('the download endpoint refuses a response without touching storage', async (t) => {
  const { setStorage, resetStorage } = await import('../src/services/storage.js');
  let touched = false;
  setStorage({ kind: 'memory', async get() { touched = true; throw new Error('should not be called'); } });
  t.after(() => resetStorage());

  const pool = fakePool([
    ['FROM company_files f\n     JOIN companies c', [{
      id: STATEMENT_1, company_id: COMPANY_A, upload_state: 'submitted', kind: 'statement',
      s3_key: null, scan_state: null, filename: 'No document (not applicable)', legal_name: 'Example Bio',
    }]],
  ]);
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  const res = await server.request(`/company-files/${STATEMENT_1}/download`, { token: adminToken() });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'no_file');
  assert.equal(touched, false);
  assert.equal(pool.sql().some((s) => s.includes('INSERT INTO audit_log')), false, 'nothing was downloaded, so nothing is logged as one');
});

const responseRow = {
  id: STATEMENT_1, company_id: COMPANY_A, legal_name: 'Example Bio', irl_item_id: ITEM_1,
  filename: 'No document (provided under 3.4)', description: EXPLANATION, kind: 'statement',
  statement_reason: 'provided_elsewhere', related_item_id: ITEM_2, related_item_ref: '3.4',
  size_bytes: null, content_type: null, scan_state: null, scan_backend: null, status: 'received',
  item_ref: '1.3', upload_state: 'submitted', version: 1,
};

test('the Files tab reports a response as not downloadable, for no_file, with no size', async (t) => {
  const pool = fakePool([['FROM company_files f\n       JOIN users u', [responseRow]]]);
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  const res = await server.request(`/companies/${COMPANY_A}/files`, { token: adminToken() });
  assert.equal(res.status, 200);
  const [row] = res.body;
  assert.equal(row.kind, 'statement');
  assert.equal(row.downloadable, false);
  assert.equal(row.downloadBlockedReason, 'no_file');
  assert.equal(row.sizeBytes, null);
  assert.equal(row.relatedItemRef, '3.4');
});

test('the review queue does the same, and carries the item id for the Not applicable tick', async (t) => {
  const pool = fakePool([['FROM company_files f\n       JOIN companies c', [responseRow]]]);
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  const res = await server.request('/review-queue', { token: adminToken() });
  assert.equal(res.status, 200);
  const [row] = res.body;
  assert.equal(row.downloadable, false);
  assert.equal(row.downloadBlockedReason, 'no_file');
  assert.equal(row.statementReason, 'provided_elsewhere');
  assert.equal(row.irlItemId, ITEM_1);
});

// ---------------------------------------------------------------------------
// Review: the Not applicable tick, CW026 §3.6
// ---------------------------------------------------------------------------

function reviewPool(file) {
  return fakePool([
    ['FROM company_files f\n     JOIN companies c', [{
      id: STATEMENT_1, company_id: COMPANY_A, irl_item_id: ITEM_1, uploaded_by: 'user-7',
      upload_state: 'submitted', status: 'received', legal_name: 'Example Bio', kind: 'statement',
      statement_reason: 'not_applicable', filename: 'No document (not applicable)', ...file,
    }]],
    ["UPDATE company_irl_items SET state = 'not_applicable'", [{ ref: '1.3' }]],
    ['SELECT id, state, baseline_state', [{ id: ITEM_1, state: 'not_applicable', baseline_state: 'outstanding' }]],
    ['FROM company_users cu\n       JOIN users u', []],
  ]);
}

test('accepting a "does not apply" response with the tick marks the item Not applicable in the same transaction', async (t) => {
  const pool = reviewPool();
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  const res = await server.request(`/company-files/${STATEMENT_1}/status`, {
    method: 'PATCH', token: adminToken(), body: { status: 'completed', alsoMarkItemNotApplicable: true },
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));

  const order = pool.sql();
  const markAt = order.findIndex((s) => s.includes("SET state = 'not_applicable'"));
  assert.ok(markAt > order.indexOf('BEGIN') && markAt < order.indexOf('COMMIT'), 'marked inside the status transaction');

  const audits = pool.calls.filter((c) => c.text.includes('INSERT INTO audit_log'));
  const marked = audits.find((c) => c.params[1] === 'company.updated');
  assert.ok(marked, 'the item change is audited');
  assert.equal(JSON.parse(marked.params[4]).via, 'statement_accepted');
});

test('without the tick the item is left alone; the tick is refused on anything else', async (t) => {
  const untouched = reviewPool();
  const server = await startTestServer(MOUNTS, untouched);
  t.after(() => server.close());
  await server.request(`/company-files/${STATEMENT_1}/status`, {
    method: 'PATCH', token: adminToken(), body: { status: 'completed' },
  });
  assert.equal(untouched.sql().some((s) => s.includes("SET state = 'not_applicable'")), false);

  for (const [file, status] of [
    [{ kind: 'file', statement_reason: null }, 'completed'],
    [{ statement_reason: 'does_not_exist' }, 'completed'],
    [{}, 'in_review'],
  ]) {
    const pool = reviewPool(file);
    const s2 = await startTestServer(MOUNTS, pool);
    const res = await s2.request(`/company-files/${STATEMENT_1}/status`, {
      method: 'PATCH', token: adminToken(), body: { status, alsoMarkItemNotApplicable: true },
    });
    await s2.close();
    assert.equal(res.status, 400, JSON.stringify(file));
    assert.equal(pool.sql().some((s) => s.includes('UPDATE company_files SET status')), false);
  }
});

test('a superseded response cannot be brought back while the item has a current one', async (t) => {
  const pool = fakePool([
    ['FROM company_files f\n     JOIN companies c', [{
      id: STATEMENT_1, company_id: COMPANY_A, irl_item_id: ITEM_1, upload_state: 'submitted',
      status: 'superseded', kind: 'statement', legal_name: 'Example Bio',
    }]],
    ["AND kind = 'statement' AND id <> $2", [{ id: 'the-current-one' }]],
  ]);
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  const res = await server.request(`/company-files/${STATEMENT_1}/status`, {
    method: 'PATCH', token: adminToken(), body: { status: 'received' },
  });
  assert.equal(res.status, 409);
  assert.equal(pool.sql().some((s) => s.includes('UPDATE company_files SET status')), false);
});

// ---------------------------------------------------------------------------
// Exports, CW026 §3.8
// ---------------------------------------------------------------------------

test('PRE-FILLED gets "{label}: {explanation}" from the current submitted response; GAPS does not', async () => {
  const responses = companyResponses([
    { irl_item_id: ITEM_1, kind: 'statement', upload_state: 'submitted', status: 'completed', filename: 'No document (not applicable)', description: EXPLANATION },
    { irl_item_id: ITEM_2, kind: 'statement', upload_state: 'submitted', status: 'superseded', filename: 'No document (other reason)', description: 'Old answer, replaced.' },
    { irl_item_id: ITEM_2, kind: 'statement', upload_state: 'staged', status: null, filename: 'No document (other reason)', description: 'Not sent yet.' },
  ]);
  assert.equal(responses.get(ITEM_1), `No document (not applicable): ${EXPLANATION}`);
  assert.equal(responses.has(ITEM_2), false);

  const ExcelJS = (await import('exceljs')).default;
  const items = [
    exportableItem({ section: 'Corporate', ref: '1.3', description: 'Subsidiary accounts', priority: 'high', state: 'received', note_for_company: null }, { companyResponse: responses.get(ITEM_1) }),
  ];

  const pre = new ExcelJS.Workbook();
  await pre.xlsx.load(await buildPrefilledWorkbook({ companyName: 'Example Bio', items }));
  assert.equal(pre.getWorksheet('PRE-FILLED').getRow(2).getCell(7).value, `No document (not applicable): ${EXPLANATION}`);

  const gaps = new ExcelJS.Workbook();
  await gaps.xlsx.load(await buildGapsWorkbook({ companyName: 'Example Bio', items }));
  const sheet = gaps.getWorksheet('GAPS');
  assert.equal(sheet.columnCount, 6);
  let text = '';
  sheet.eachRow((row) => { text += JSON.stringify(row.values); });
  assert.equal(text.includes(EXPLANATION), false);
});

// ---------------------------------------------------------------------------
// Emails: the five wired templates carry a response, unchanged, CW026 §3.5
// ---------------------------------------------------------------------------

test('the five wired templates render a response with its label and no size', () => {
  const env = { PORTAL_URL: 'https://dataroom.taraniscapital.com' };
  const label = 'No document (expected 31 March 2027)';
  const line = { filename: label, size: '', item_ref: '7.1', item_description_short: 'Audited accounts', description: 'The FY2025-26 audit completes in March.' };

  const rendered = {
    'upload-notification': renderTemplate('upload-notification', {
      uploader_name: 'Madan Mohan', company_name: 'Revelations Biotech', file_count: 1,
      item_ref_or_additional: '7.1', files: [line], admin_review_url: `${env.PORTAL_URL}/admin/review-queue`,
    }, { env }),
    'submission-receipt': renderTemplate('submission-receipt', {
      first_name: 'Madan', company_name: 'Revelations Biotech', submitted_at_utc: '10 September 2026 at 10:00',
      receipt_ref: 'TRN-DD-2026-000077', file_count: 1, files: [line], company_receipts_url: `${env.PORTAL_URL}/company/receipts`,
    }, { env }),
    'submission-notification': renderTemplate('submission-notification', {
      submitter_name: 'Madan Mohan', company_name: 'Revelations Biotech', receipt_ref: 'TRN-DD-2026-000077',
      file_count: 1, item_count: 1, admin_review_url: `${env.PORTAL_URL}/admin/review-queue`,
    }, { env }),
    'status-attention': renderTemplate('status-attention', {
      first_name: 'Madan', company_name: 'Revelations Biotech', filename: label, item_ref: '7.1',
      item_description_short: 'Audited accounts', submitted_at: '10 September 2026 at 10:00',
      receipt_ref: 'TRN-DD-2026-000077', reviewer_note: 'Please give a firmer date.', item_url: `${env.PORTAL_URL}/company/items/i-1`,
    }, { env }),
    'status-completed': renderTemplate('status-completed', {
      first_name: 'Madan', company_name: 'Revelations Biotech', filename: label, item_ref: '7.1',
      item_description_short: 'Audited accounts', progress_percent: '28%', outstanding_count: 105,
      workspace_url: `${env.PORTAL_URL}/company`,
    }, { env }),
  };

  for (const [id, { text }] of Object.entries(rendered)) {
    assert.equal(/\(0 B\)|\(\)|null|undefined/.test(text), false, `${id} rendered a missing value`);
    if (id !== 'submission-notification') assert.ok(text.includes(label), `${id} does not name the response`);
  }
  assert.ok(rendered['upload-notification'].text.includes(`${label}, 7.1 Audited accounts, description:`));
});
