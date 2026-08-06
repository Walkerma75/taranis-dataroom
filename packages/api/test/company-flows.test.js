/**
 * Submission, status and activation flows, driven through the real routers.
 *
 * These are the acceptance tests HANDOVER-CW004 §4 names after the isolation
 * ones: batches atomic, staged versus submitted enforced, attention_needed
 * refused without a note, and activation impossible without both gates.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import companyPortalRoutes from '../src/routes/company-portal.js';
import companyRoutes, { companyFilesRouter, reviewQueueRouter } from '../src/routes/companies.js';

import {
  fakePool,
  membershipRow,
  membershipHandler,
  tokenFor,
  startTestServer,
} from './helpers/test-app.js';

const COMPANY_A = '11111111-1111-4111-8111-111111111111';
const FILE_1 = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const FILE_2 = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

const MOUNTS = [
  ['/company', companyPortalRoutes],
  ['/companies', companyRoutes],
  ['/company-files', companyFilesRouter],
  ['/review-queue', reviewQueueRouter],
];

const companyAdminToken = () => tokenFor({ role: 'company', companyId: COMPANY_A });
const adminToken = () => tokenFor({ role: 'admin', sub: 'admin-1' });

function stagedFile(id, itemId = null) {
  return {
    id,
    company_id: COMPANY_A,
    irl_item_id: itemId,
    filename: `${id}.pdf`,
    description: 'A described file',
    upload_state: 'staged',
    status: null,
    deleted_at: null,
  };
}

// ---------------------------------------------------------------------------
// Submission
// ---------------------------------------------------------------------------

test('a submission is refused outright if any named file is unavailable', async (t) => {
  // Two ids are named. Only one is still staged and belongs to this company.
  // The batch must fail rather than quietly produce a receipt listing one file
  // when the company believes it sent two.
  const pool = fakePool([
    membershipHandler(membershipRow({ companyId: COMPANY_A })),
    ['FROM company_files\n       WHERE id = ANY', [stagedFile(FILE_1)]],
  ]);
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  const res = await server.request('/company/submit', {
    method: 'POST',
    token: companyAdminToken(),
    body: { fileIds: [FILE_1, FILE_2] },
  });

  assert.equal(res.status, 409);
  assert.match(res.body.error, /no longer available/);

  // Nothing was created: no receipt reference was taken and no batch inserted.
  assert.equal(pool.sql().some((s) => s.includes('INSERT INTO submission_batches')), false);
  assert.equal(pool.sql().some((s) => s.includes("nextval('company_receipt_ref_seq')")), false);
  assert.ok(pool.sql().includes('ROLLBACK'));
});

test('a submission with no files is refused before anything is locked', async (t) => {
  const pool = fakePool([membershipHandler(membershipRow({ companyId: COMPANY_A }))]);
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  for (const body of [{}, { fileIds: [] }, { fileIds: 'not-an-array' }]) {
    const res = await server.request('/company/submit', {
      method: 'POST', token: companyAdminToken(), body,
    });
    assert.equal(res.status, 400);
  }
});

test('a successful submission takes a receipt reference, moves the files and returns the receipt', async (t) => {
  const pool = fakePool([
    membershipHandler(membershipRow({ companyId: COMPANY_A })),
    ['FROM company_files\n       WHERE id = ANY', [stagedFile(FILE_1), stagedFile(FILE_2)]],
    ["nextval('company_receipt_ref_seq')", [{ n: 42 }]],
    ['INSERT INTO submission_batches', [{
      id: 'batch-1',
      receipt_ref: 'TRN-DD-2026-000042',
      submitted_at: new Date('2026-08-06T10:00:00Z'),
    }]],
  ]);
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  const res = await server.request('/company/submit', {
    method: 'POST',
    token: companyAdminToken(),
    body: { fileIds: [FILE_1, FILE_2] },
  });

  assert.equal(res.status, 201);
  assert.equal(res.body.receiptRef, 'TRN-DD-2026-000042');
  assert.equal(res.body.files.length, 2);
  // The receipt names every file and its description, because that is what the
  // approved receipt email restates.
  for (const file of res.body.files) {
    assert.ok(file.filename);
    assert.ok(file.description);
  }

  const sql = pool.sql().join('\n');
  assert.match(sql, /UPDATE company_files\s+SET upload_state = 'submitted', status = 'received'/);
  assert.match(sql, /INSERT INTO file_status_history/);
  assert.ok(pool.sql().includes('COMMIT'));
});

test('the staged file lock is scoped to the caller\'s own company', async (t) => {
  const pool = fakePool([
    membershipHandler(membershipRow({ companyId: COMPANY_A })),
    ['FROM company_files\n       WHERE id = ANY', []],
  ]);
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  await server.request('/company/submit', {
    method: 'POST', token: companyAdminToken(), body: { fileIds: [FILE_1] },
  });

  const lock = pool.calls.find((c) => c.text.includes('WHERE id = ANY'));
  assert.ok(lock);
  assert.equal(lock.params[1], COMPANY_A);
  assert.match(lock.text, /upload_state = 'staged'/);
  assert.match(lock.text, /FOR UPDATE/);
});

// ---------------------------------------------------------------------------
// Staged versus submitted
// ---------------------------------------------------------------------------

test('a submitted file can no longer be edited or removed by the company', async (t) => {
  // The UPDATE carries `upload_state = 'staged'` in its WHERE clause, so a
  // submitted file matches nothing and the route answers 404.
  const pool = fakePool([
    membershipHandler(membershipRow({ companyId: COMPANY_A })),
    ['UPDATE company_files SET description', []],
    ['UPDATE company_files SET deleted_at', []],
  ]);
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  const token = companyAdminToken();

  const patch = await server.request(`/company/files/${FILE_1}`, {
    method: 'PATCH', token, body: { description: 'changed my mind' },
  });
  assert.equal(patch.status, 404);
  assert.match(patch.body.error, /already been submitted/);

  const del = await server.request(`/company/files/${FILE_1}`, { method: 'DELETE', token });
  assert.equal(del.status, 404);
  assert.match(del.body.error, /already been submitted/);

  for (const call of pool.calls.filter((c) => c.text.includes('UPDATE company_files'))) {
    assert.match(call.text, /upload_state = 'staged'/);
    assert.equal(call.params[1], COMPANY_A);
  }
});

test('a file cannot be uploaded without a description', async (t) => {
  const pool = fakePool([membershipHandler(membershipRow({ companyId: COMPANY_A }))]);
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  const res = await server.request(`/company/files/${FILE_1}`, {
    method: 'PATCH', token: companyAdminToken(), body: { description: '   ' },
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /description is required/);
});

// ---------------------------------------------------------------------------
// Status flow
// ---------------------------------------------------------------------------

test('attention_needed without a note is refused, before anything is written', async (t) => {
  const pool = fakePool([]);
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  for (const note of [undefined, '', '   ']) {
    const res = await server.request(`/company-files/${FILE_1}/status`, {
      method: 'PATCH',
      token: adminToken(),
      body: { status: 'attention_needed', ...(note === undefined ? {} : { note }) },
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /note is required/);
  }
  assert.equal(pool.calls.length, 0, 'the file should not even be looked up');
});

test('an unknown status is refused', async (t) => {
  const pool = fakePool([]);
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  const res = await server.request(`/company-files/${FILE_1}/status`, {
    method: 'PATCH', token: adminToken(), body: { status: 'approved' },
  });
  assert.equal(res.status, 400);
});

test('a status change writes history and recomputes the item state', async (t) => {
  const pool = fakePool([
    ['FROM company_files f\n     JOIN companies c', [{
      id: FILE_1, company_id: COMPANY_A, irl_item_id: 'item-1',
      upload_state: 'submitted', status: 'received', legal_name: 'Example Bio',
    }]],
    ['SELECT id, state, template_item_id', [{ id: 'item-1', state: 'received' }]],
    ['SELECT upload_state, status, deleted_at FROM company_files', [
      { upload_state: 'submitted', status: 'attention_needed', deleted_at: null },
    ]],
  ]);
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  const res = await server.request(`/company-files/${FILE_1}/status`, {
    method: 'PATCH',
    token: adminToken(),
    body: { status: 'attention_needed', note: 'This is the 2024 file, we need 2025.' },
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'attention_needed');

  const sql = pool.sql().join('\n');
  assert.match(sql, /INSERT INTO file_status_history/);
  // The item state was recomputed and moved to attention_needed.
  assert.match(sql, /UPDATE company_irl_items SET state = \$2/);
  const update = pool.calls.find((c) => c.text.includes('UPDATE company_irl_items SET state'));
  assert.equal(update.params[1], 'attention_needed');
});

test('a status cannot be set on a file that has never been submitted', async (t) => {
  const pool = fakePool([
    ['FROM company_files f\n     JOIN companies c', [{
      id: FILE_1, company_id: COMPANY_A, upload_state: 'staged', legal_name: 'Example Bio',
    }]],
  ]);
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  const res = await server.request(`/company-files/${FILE_1}/status`, {
    method: 'PATCH', token: adminToken(), body: { status: 'in_review' },
  });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /not been formally submitted/);
});

test('the company sees the reviewer note on a file, but never the internal note', async (t) => {
  // A note is mandatory on attention_needed precisely so the company knows what
  // to fix. A flag with no explanation is a wasted round trip, so the note has
  // to reach them. The item's internal_note must not travel with it.
  const pool = fakePool([
    membershipHandler(membershipRow({ companyId: COMPANY_A })),
    ['FROM company_irl_items WHERE id = $1 AND company_id = $2', [{
      id: 'item-1', company_id: COMPANY_A, section: '1. Corporate', ref: '1.1',
      description: 'Certificate of incorporation', priority: 'high',
      state: 'attention_needed', note_for_company: null,
      internal_note: 'INTERNAL: chase their counsel directly',
    }]],
    ['LEFT JOIN LATERAL', [{
      id: FILE_1, irl_item_id: 'item-1', filename: 'certificate.pdf',
      description: 'Certificate of incorporation', size_bytes: 100,
      upload_state: 'submitted', status: 'attention_needed',
      uploaded_by_name: 'A Contact', receipt_ref: 'TRN-DD-2026-000001',
      status_note: 'This is the 2024 certificate, we need the amended one.',
      status_set_at: new Date('2026-08-06T10:00:00Z'),
    }]],
  ]);
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  const res = await server.request('/company/items/item-1', { token: companyAdminToken() });

  assert.equal(res.status, 200);
  assert.equal(res.body.files[0].statusNote, 'This is the 2024 certificate, we need the amended one.');

  const raw = JSON.stringify(res.body);
  assert.equal(raw.includes('INTERNAL'), false);
  assert.equal(raw.includes('chase their counsel'), false);
  assert.equal('internal_note' in res.body.item, false);
});

// ---------------------------------------------------------------------------
// Downloads are gated on the scan verdict
// ---------------------------------------------------------------------------

test('an unscanned file is served under the stub, but the response says it was not scanned', async (t) => {
  // The accepted beta position (HANDOVER-C004 §3.1). Refusing here would make
  // the portal useless, because the stub never clears anything.
  const { setStorage, MemoryStorage } = await import('../src/services/storage.js');
  const store = new MemoryStorage();
  await store.put('companies/a/i/f/x.pdf', { body: Buffer.from('%PDF-1.4 bytes') });
  setStorage(store);
  t.after(async () => (await import('../src/services/storage.js')).resetStorage());

  const pool = fakePool([
    ['FROM company_files f\n     JOIN companies c', [{
      id: FILE_1, company_id: COMPANY_A, upload_state: 'submitted',
      scan_state: 'pending', s3_key: 'companies/a/i/f/x.pdf',
      filename: 'x.pdf', content_type: 'application/pdf', legal_name: 'Example Bio',
    }]],
  ]);
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  const res = await fetch(`${server.base}/company-files/${FILE_1}/download`, {
    headers: { Authorization: `Bearer ${adminToken()}` },
  });

  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-taranis-scan-state'), 'pending');
  assert.equal(await res.text(), '%PDF-1.4 bytes');

  // The audit row must record that this was served without ever being
  // inspected, so it is answerable later exactly which files those were.
  const audit = pool.calls.find((c) => c.text.includes('INSERT INTO audit_log'));
  assert.ok(audit, 'the download should have been audited');
  assert.equal(audit.params[1], 'company_file.downloaded');
  const detail = JSON.parse(audit.params[4]);
  assert.equal(detail.unscanned, true);
  assert.equal(detail.scanState, 'pending');
});

test('an infected file says so rather than pretending it is merely pending', async (t) => {
  const pool = fakePool([
    ['FROM company_files f\n     JOIN companies c', [{
      id: FILE_1, company_id: COMPANY_A, upload_state: 'submitted',
      scan_state: 'infected', s3_key: 'k', filename: 'x.pdf', legal_name: 'Example Bio',
    }]],
  ]);
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  const res = await server.request(`/company-files/${FILE_1}/download`, { token: adminToken() });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /quarantined/);
});

// ---------------------------------------------------------------------------
// The listings publish the server's own download decision (HANDOVER-CW006)
//
// The UI must not re-derive the rule, because the rule depends on which scanner
// backend is live and the browser cannot know that. These tests are what stops
// the two drifting: they assert that the answer on the row is the answer
// `downloadDecision` gives, for the same states the download route is tested at
// directly above.
// ---------------------------------------------------------------------------

/** The joined shape `GET /companies/:id/files` selects. */
function submittedFile(id, scanState) {
  return {
    id,
    company_id: COMPANY_A,
    filename: `${id}.pdf`,
    description: 'A document',
    size_bytes: 1024,
    content_type: 'application/pdf',
    version: 1,
    supersedes: null,
    status: 'received',
    scan_state: scanState,
    scan_backend: 'stub',
    upload_state: 'submitted',
    created_at: new Date(),
  };
}

test('the company Files listing says which files can be downloaded, and why not when they cannot', async (t) => {
  const pool = fakePool([
    ['FROM company_files f\n       JOIN users u', [
      submittedFile(FILE_1, 'pending'),
      submittedFile(FILE_2, 'infected'),
    ]],
  ]);
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  const res = await server.request(`/companies/${COMPANY_A}/files`, { token: adminToken() });
  assert.equal(res.status, 200);

  const [unscanned, infected] = res.body;

  // Under the stub, an unscanned file is downloadable and is flagged as never
  // having been inspected. That is the ratified beta position.
  assert.equal(unscanned.downloadable, true);
  assert.equal(unscanned.downloadUnscanned, true);
  assert.equal(unscanned.downloadBlockedReason, null);

  // A verdict is a verdict, under any backend.
  assert.equal(infected.downloadable, false);
  assert.equal(infected.downloadUnscanned, false);
  assert.match(infected.downloadBlockedReason, /quarantined/);
});

test('the review queue publishes the same decision as the Files tab', async (t) => {
  // Two screens, one rule. A reviewer who can open a file from the company page
  // must be able to open it from the queue, and the reverse.
  const pool = fakePool([
    ['FROM company_files f\n       JOIN companies c', [
      { ...submittedFile(FILE_1, 'pending'), legal_name: 'Example Bio' },
      { ...submittedFile(FILE_2, 'infected'), legal_name: 'Example Bio' },
    ]],
  ]);
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  const res = await server.request('/review-queue', { token: adminToken() });
  assert.equal(res.status, 200);

  const [unscanned, infected] = res.body;
  assert.equal(unscanned.downloadable, true);
  assert.equal(unscanned.downloadUnscanned, true);
  assert.equal(infected.downloadable, false);
  assert.match(infected.downloadBlockedReason, /quarantined/);
});

test('a clean file is downloadable and is not flagged unscanned', async (t) => {
  const pool = fakePool([
    ['FROM company_files f\n       JOIN users u', [submittedFile(FILE_1, 'clean')]],
  ]);
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  const res = await server.request(`/companies/${COMPANY_A}/files`, { token: adminToken() });
  assert.equal(res.body[0].downloadable, true);
  assert.equal(res.body[0].downloadUnscanned, false);
  assert.equal(res.body[0].downloadBlockedReason, null);
});

test('the published decision follows the scanner backend, it is not hard-coded to infected', async (t) => {
  // The regression this guards. With a real backend configured, 'pending' means
  // scanning has not finished, and the API refuses it. If the listing kept
  // saying downloadable the UI would offer a button the server rejects, which is
  // exactly the client-side rule CW006 §3 item 3 forbids.
  const { setScanner, resetScanner } = await import('../src/services/scanner.js');
  setScanner({ kind: 'clamav', describe: () => 'ClamAV', async scan() { return { state: 'clean' }; } });
  t.after(() => resetScanner());

  const pool = fakePool([
    ['FROM company_files f\n       JOIN users u', [submittedFile(FILE_1, 'pending')]],
  ]);
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  const res = await server.request(`/companies/${COMPANY_A}/files`, { token: adminToken() });
  assert.equal(res.body[0].downloadable, false);
  assert.match(res.body[0].downloadBlockedReason, /not yet been cleared/);
});

// ---------------------------------------------------------------------------
// Activation gates, through the route
// ---------------------------------------------------------------------------

test('activation is refused when the IEMS screen is missing, and nothing is seeded', async (t) => {
  const pool = fakePool([
    ['SELECT * FROM companies WHERE id = $1 FOR UPDATE', [{
      id: COMPANY_A, legal_name: 'IMALIA', fund_id: 'fund-1', status: 'pending',
      nda_executed_at: new Date('2026-07-01T00:00:00Z'), iems_screened_at: null,
    }]],
  ]);
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  const res = await server.request(`/companies/${COMPANY_A}/activate`, {
    method: 'POST', token: adminToken(), body: {},
  });

  assert.equal(res.status, 409);
  assert.match(res.body.error, /IEMS screening date/);
  assert.deepEqual(res.body.missingGates, ['iems_screened_at']);

  const sql = pool.sql().join('\n');
  assert.equal(sql.includes("SET status = 'active'"), false);
  assert.equal(sql.includes('INSERT INTO company_irl_items'), false);
  assert.ok(pool.sql().includes('ROLLBACK'));
});

test('activation is refused when the NDA is missing', async (t) => {
  const pool = fakePool([
    ['SELECT * FROM companies WHERE id = $1 FOR UPDATE', [{
      id: COMPANY_A, legal_name: 'Example Bio', fund_id: 'fund-1', status: 'pending',
      nda_executed_at: null, iems_screened_at: new Date(),
    }]],
  ]);
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  const res = await server.request(`/companies/${COMPANY_A}/activate`, {
    method: 'POST', token: adminToken(), body: {},
  });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /executed NDA date/);
});

test('activation with both gates seeds the checklist from the fund template', async (t) => {
  const pool = fakePool([
    ['SELECT * FROM companies WHERE id = $1 FOR UPDATE', [{
      id: COMPANY_A, legal_name: 'Example Bio', fund_id: 'fund-1', status: 'pending',
      nda_executed_at: new Date(), iems_screened_at: new Date(),
    }]],
    ['SELECT id, name FROM irl_templates WHERE fund_id', [{ id: 'template-1', name: 'Biotech IRL' }]],
    ['FROM irl_template_items WHERE template_id', [
      { id: 't1', section: '1. Corporate', ref: '1.1', description: 'Certificate', priority: 'medium', sort_order: 1, already_held: null, note_for_company: null },
      { id: 't2', section: '1. Corporate', ref: '1.2', description: 'Cap table', priority: 'high', sort_order: 2, already_held: 'On file', note_for_company: null },
    ]],
    ['INSERT INTO company_irl_items', { rows: [{}], rowCount: 1 }],
    ["SET status = 'active'", [{ id: COMPANY_A, status: 'active' }]],
  ]);
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  const res = await server.request(`/companies/${COMPANY_A}/activate`, {
    method: 'POST', token: adminToken(), body: {},
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.seeded.templateItems, 2);
  assert.equal(res.body.seeded.inserted, 2);

  // An item Taranis already holds is seeded 'held', not 'outstanding'.
  const seedInserts = pool.calls.filter((c) => c.text.includes('INSERT INTO company_irl_items'));
  assert.equal(seedInserts.length, 2);
  assert.equal(seedInserts[0].params[6], 'outstanding');
  assert.equal(seedInserts[1].params[6], 'held');
  // The insert skips conflicts, so re-activating a seeded company is safe.
  assert.match(seedInserts[0].text, /ON CONFLICT \(company_id, ref\) DO NOTHING/);
});

test('an offboarded company cannot be reactivated through activate', async (t) => {
  const pool = fakePool([
    ['SELECT * FROM companies WHERE id = $1 FOR UPDATE', [{
      id: COMPANY_A, legal_name: 'Example Bio', fund_id: 'fund-1', status: 'offboarded',
      nda_executed_at: new Date(), iems_screened_at: new Date(),
    }]],
  ]);
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  const res = await server.request(`/companies/${COMPANY_A}/activate`, {
    method: 'POST', token: adminToken(), body: {},
  });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /cannot be reactivated/);
});

// ---------------------------------------------------------------------------
// Invitations issue a link, and send no email
// ---------------------------------------------------------------------------

test('inviting a company user returns a link for an admin to send by hand', async (t) => {
  const pool = fakePool([
    // Active: an invitation to anything else is refused by the guard below.
    ['SELECT * FROM companies WHERE id = $1', [{ id: COMPANY_A, legal_name: 'Example Bio', status: 'active' }]],
    ['SELECT id, role FROM users WHERE email', []],
    ['INSERT INTO users (email, display_name, role, status)', [{ id: 'user-9' }]],
    ['INSERT INTO company_users', [{ id: 'm-9', company_role: 'company_admin', nominated_by: null }]],
    ['INSERT INTO invites', { rows: [] }],
  ]);
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  const res = await server.request(`/companies/${COMPANY_A}/users`, {
    method: 'POST',
    token: adminToken(),
    body: { email: 'Contact@ExampleBio.com', displayName: 'A Contact', companyRole: 'company_admin', isPrimary: true },
  });

  assert.equal(res.status, 201);
  assert.match(res.body.inviteUrl, /^\/invite\/accept\?token=/);
  assert.match(res.body.message, /No email has been sent/);

  // The email address is normalised before it reaches the users table.
  const insert = pool.calls.find((c) => c.text.includes('INSERT INTO users (email'));
  assert.equal(insert.params[0], 'contact@examplebio.com');
  // The invite is created with role 'company'.
  const invite = pool.calls.find((c) => c.text.includes('INSERT INTO invites'));
  assert.match(invite.text, /'company'/);
});

test('a fund-side account is never converted into a company account', async (t) => {
  const pool = fakePool([
    ['SELECT * FROM companies WHERE id = $1', [{ id: COMPANY_A, legal_name: 'Example Bio', status: 'active' }]],
    ['SELECT id, role FROM users WHERE email', [{ id: 'user-7', role: 'investor' }]],
  ]);
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  const res = await server.request(`/companies/${COMPANY_A}/users`, {
    method: 'POST',
    token: adminToken(),
    body: { email: 'investor@example.com', displayName: 'An Investor' },
  });

  assert.equal(res.status, 409);
  assert.match(res.body.error, /fund-side account/);
  assert.ok(pool.sql().includes('ROLLBACK'));
});

// ---------------------------------------------------------------------------
// No invitation before activation (HANDOVER-CW005)
//
// The trap this closes: an invitation issued to a pending company is accepted,
// the person enrols in MFA, signs in, and lands in nothing, because the
// workspace does not exist until activation seeds it and `requireCompany`
// refuses a pending company outright.
// ---------------------------------------------------------------------------

test('an invitation is refused for a company that is not active, and nothing is written', async (t) => {
  const expected = {
    pending: /pending/i,
    suspended: /suspended/i,
    offboarded: /offboarded/i,
  };

  for (const [status, pattern] of Object.entries(expected)) {
    const pool = fakePool([
      ['SELECT * FROM companies WHERE id = $1', [{
        id: COMPANY_A, legal_name: 'Example Bio', status,
      }]],
    ]);
    const server = await startTestServer(MOUNTS, pool);

    const res = await server.request(`/companies/${COMPANY_A}/users`, {
      method: 'POST',
      token: adminToken(),
      body: { email: 'contact@examplebio.com', displayName: 'A Contact', isPrimary: true },
    });

    assert.equal(res.status, 409, `a ${status} company should refuse an invitation`);
    assert.match(res.body.error, pattern);
    assert.equal(res.body.companyStatus, status);

    // No user, no membership, no invite, and the transaction was rolled back.
    // The refusal lands before the email is even looked up.
    const sql = pool.sql().join('\n');
    assert.equal(sql.includes('INSERT INTO users'), false, `${status}: no user may be created`);
    assert.equal(sql.includes('INSERT INTO company_users'), false, `${status}: no membership`);
    assert.equal(sql.includes('INSERT INTO invites'), false, `${status}: no invite row`);
    assert.equal(sql.includes('SELECT id, role FROM users WHERE email'), false);
    assert.ok(pool.sql().includes('ROLLBACK'), `${status}: the transaction should roll back`);

    await server.close();
  }
});

test('the pending refusal tells the admin what to do about it', async (t) => {
  const pool = fakePool([
    ['SELECT * FROM companies WHERE id = $1', [{
      id: COMPANY_A, legal_name: 'Example Bio', status: 'pending',
    }]],
  ]);
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  const res = await server.request(`/companies/${COMPANY_A}/users`, {
    method: 'POST',
    token: adminToken(),
    body: { email: 'contact@examplebio.com', displayName: 'A Contact' },
  });

  assert.equal(res.status, 409);
  assert.match(res.body.error, /activation gates/);
  assert.match(res.body.error, /activate/i);
});

test('approving a nomination is refused too, because it runs through the same endpoint', async (t) => {
  // A company admin can only nominate from inside an active workspace, so this
  // is belt and braces rather than a live path. It is asserted because the
  // approval and the direct invitation share one handler, and a future split
  // must not leave the approval unguarded.
  const pool = fakePool([
    ['SELECT * FROM companies WHERE id = $1', [{
      id: COMPANY_A, legal_name: 'Example Bio', status: 'suspended',
    }]],
    ['SELECT id, role FROM users WHERE email', [{ id: 'user-9', role: 'company' }]],
  ]);
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  const res = await server.request(`/companies/${COMPANY_A}/users`, {
    method: 'POST',
    token: adminToken(),
    body: {
      email: 'nominee@examplebio.com',
      displayName: 'A Nominee',
      companyRole: 'company_contributor',
    },
  });

  assert.equal(res.status, 409);
  assert.equal(res.body.companyStatus, 'suspended');
  // The existing membership row is untouched: this approves nothing.
  assert.equal(pool.sql().join('\n').includes('INSERT INTO company_users'), false);
});
