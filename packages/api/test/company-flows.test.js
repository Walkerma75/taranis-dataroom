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
import companyRoutes, { companyFilesRouter } from '../src/routes/companies.js';

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

test('a Taranis download is refused while the scanner has not cleared the file', async (t) => {
  // With the Phase 1a stub backend nothing is ever cleared, so this is the
  // behaviour every company upload gets until a real scanner is wired.
  const pool = fakePool([
    ['FROM company_files f\n     JOIN companies c', [{
      id: FILE_1, company_id: COMPANY_A, upload_state: 'submitted',
      scan_state: 'pending', s3_key: 'companies/a/i/f/x.pdf',
      filename: 'x.pdf', content_type: 'application/pdf', legal_name: 'Example Bio',
    }]],
  ]);
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  const res = await server.request(`/company-files/${FILE_1}/download`, { token: adminToken() });

  assert.equal(res.status, 409);
  assert.equal(res.body.scanState, 'pending');
  assert.equal(res.body.scanner, 'stub');
  assert.match(res.body.error, /not yet been cleared/);
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
    ['SELECT * FROM companies WHERE id = $1', [{ id: COMPANY_A, legal_name: 'Example Bio' }]],
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
    ['SELECT * FROM companies WHERE id = $1', [{ id: COMPANY_A, legal_name: 'Example Bio' }]],
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
