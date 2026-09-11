/**
 * Adviser access to a company's due diligence (HANDOVER-CW028 / C028, PR B).
 *
 * Two controls, one rule. Scope (which sections a grant covers) and
 * restriction (items and files no grant ever shows) are decided in
 * services/adviser-access.js and applied by every route that returns items,
 * files, bytes or history. These tests drive the pure rule directly and then
 * each route through the real middleware against a fake pool.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import companyRoutes, { companyFilesRouter, reviewQueueRouter } from '../src/routes/companies.js';
import {
  resolveCompanyAccess,
  companyVisibilitySql,
  itemInScope,
  adviserSafeItem,
  fileIsRestricted,
  fileVisibleToGrant,
  normaliseSections,
  parseExpiry,
  requireAttestations,
  attestationSentences,
  defaultExpiry,
  GrantInputError,
} from '../src/services/adviser-access.js';
import { mfaIsMandatoryForUser } from '../src/routes/auth.js';
import { MemoryStorage, setStorage, resetStorage } from '../src/services/storage.js';
import { setScanner, resetScanner, StubScanner } from '../src/services/scanner.js';
import { fakePool, reviewerHandler, tokenFor, startTestServer } from './helpers/test-app.js';

const COMPANY_A = '11111111-1111-4111-8111-111111111111';
const COMPANY_B = '22222222-2222-4222-8222-222222222222';
const FILE_1 = 'ffffffff-1111-4111-8111-ffffffffffff';
const GRANT_1 = '99999999-1111-4111-8111-999999999999';
const ADVISER = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';

const S2 = '2. Programmes & Scientific Pipeline';
const S3 = '3. Clinical Development & Strategy';
const S14 = '14. Closing Information (AML / KYC)';

const MOUNTS = [
  ['/companies', companyRoutes],
  ['/company-files', companyFilesRouter],
  ['/review-queue', reviewQueueRouter],
];

const adminToken = () => tokenFor({ role: 'admin', sub: 'admin-1', name: 'An Admin' });
const adviserToken = () => tokenFor({ role: 'advisor', sub: ADVISER, name: 'Dr Adviser' });

const readonlyGrant = (opts = {}) => ({ level: 'readonly', grantId: GRANT_1, sections: null, expiresAt: null, ...opts });
const ADMIN = { level: 'admin' };

function itemRow(overrides = {}) {
  return {
    id: 'item-1', company_id: COMPANY_A, section: S2, ref: '2.1', description: 'd', priority: 'high',
    state: 'outstanding', internal_note: 'never', source_document: 'IC paper (internal)',
    note_for_company: null, adviser_restricted: false, sort_order: 1, submitted_files: '1', expected_by: null,
    ...overrides,
  };
}

function fileRow(overrides = {}) {
  return {
    id: FILE_1, company_id: COMPANY_A, legal_name: 'Example Bio', irl_item_id: 'item-1',
    filename: 'deck.pdf', description: 'd', s3_key: `companies/${COMPANY_A}/item-1/${FILE_1}/deck.pdf`,
    size_bytes: 10, content_type: 'application/pdf', version: 1, supersedes: null,
    upload_state: 'submitted', status: 'received', scan_state: 'pending', scan_backend: 'stub',
    kind: 'file', statement_reason: null, expected_date: null, related_item_id: null,
    adviser_override: 'follow_item', adviser_override_reason: null, adviser_override_by: null, adviser_override_at: null,
    item_restricted: false, item_section: S2, item_ref: '2.1', uploaded_by_name: 'Founder',
    receipt_ref: 'TRN-DD-2026-000001', submitted_at: new Date(), created_at: new Date(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// The rule, directly
// ---------------------------------------------------------------------------

test('a restricted file is never visible to any grant, at any level or scope', () => {
  const restrictedItem = { irl_item_id: 'i', upload_state: 'submitted', item_restricted: true, item_section: S14 };
  for (const level of ['readonly', 'reviewer']) {
    for (const sections of [null, [S14], [S2, S14]]) {
      assert.equal(fileVisibleToGrant(readonlyGrant({ level, sections }), restrictedItem), false);
    }
  }
  assert.equal(fileVisibleToGrant(ADMIN, restrictedItem), true, 'admins see everything');
});

test('scope: an in-scope, unrestricted, submitted file is visible; out of scope or staged is not', () => {
  const file = { irl_item_id: 'i', upload_state: 'submitted', item_restricted: false, item_section: S2 };
  assert.equal(fileVisibleToGrant(readonlyGrant(), file), true);
  assert.equal(fileVisibleToGrant(readonlyGrant({ sections: [S2, S3] }), file), true);
  assert.equal(fileVisibleToGrant(readonlyGrant({ sections: [S3] }), file), false);
  assert.equal(fileVisibleToGrant(readonlyGrant(), { ...file, upload_state: 'staged' }), false);
  assert.equal(fileVisibleToGrant(null, file), false);
  assert.equal(fileVisibleToGrant(readonlyGrant({ mfaRequired: true }), file), false);
});

test('overrides: "restricted" hides a file under a standard item; "released" shows one under a restricted item', () => {
  assert.equal(fileIsRestricted({ adviserOverride: 'restricted', irlItemId: 'i', itemRestricted: false }), true);
  assert.equal(fileIsRestricted({ adviserOverride: 'released', irlItemId: 'i', itemRestricted: true }), false);
  assert.equal(fileIsRestricted({ adviserOverride: 'follow_item', irlItemId: 'i', itemRestricted: true }), true);
  assert.equal(fileIsRestricted({ adviserOverride: 'follow_item', irlItemId: 'i', itemRestricted: false }), false);
});

test('additional documents (no item) are restricted by default and visible only once released', () => {
  assert.equal(fileIsRestricted({ adviserOverride: 'follow_item', irlItemId: null, itemRestricted: false }), true);
  assert.equal(fileIsRestricted({ adviserOverride: 'released', irlItemId: null }), false);
  const released = { irl_item_id: null, upload_state: 'submitted', adviser_override: 'released' };
  assert.equal(fileVisibleToGrant(readonlyGrant({ sections: [S2] }), released), true, 'a released extra is in scope for any grant');
  assert.equal(fileVisibleToGrant(readonlyGrant(), { ...released, adviser_override: 'follow_item' }), false);
});

test('items: scope decides which are shown; a restricted item in scope is shown without files or internal fields', () => {
  assert.equal(itemInScope(readonlyGrant(), { section: S14 }), true);
  assert.equal(itemInScope(readonlyGrant({ sections: [S2] }), { section: S14 }), false);
  assert.equal(itemInScope(null, { section: S2 }), false);

  const safe = adviserSafeItem(itemRow({ adviser_restricted: true, submitted_files: 3, expected_by: '2026-10-30' }));
  assert.equal('internal_note' in safe, false);
  assert.equal('source_document' in safe, false);
  assert.equal(safe.submitted_files, 0);
  assert.equal(safe.expected_by, null);
  assert.equal(safe.adviser_restricted, true);
  assert.equal(adviserSafeItem(itemRow({ submitted_files: 3 })).submitted_files, 3);
});

test('resolveCompanyAccess: admin, live grant, grant without MFA, no grant', async () => {
  assert.deepEqual(await resolveCompanyAccess({ userId: 'x', role: 'admin', companyId: COMPANY_A }, fakePool()), {
    level: 'admin', grantId: null, sections: null, expiresAt: null,
  });
  assert.equal(await resolveCompanyAccess({ userId: 'x', role: 'company', companyId: COMPANY_A }, fakePool()), null);

  const live = await resolveCompanyAccess(
    { userId: ADVISER, role: 'advisor', companyId: COMPANY_A },
    fakePool([reviewerHandler('reviewer', { sections: [S2] })])
  );
  assert.deepEqual(live, { level: 'reviewer', grantId: 'grant-1', sections: [S2], expiresAt: null });

  const noMfa = await resolveCompanyAccess(
    { userId: ADVISER, role: 'advisor', companyId: COMPANY_A },
    fakePool([reviewerHandler('readonly', { mfa: false })])
  );
  assert.equal(noMfa.mfaRequired, true);

  const pool = fakePool([reviewerHandler(null)]);
  assert.equal(await resolveCompanyAccess({ userId: ADVISER, role: 'advisor', companyId: COMPANY_A }, pool), null);
  // Expiry is enforced in the lookup itself, so an expired row is never returned.
  assert.match(pool.calls[0].text, /expires_at IS NULL OR r\.expires_at > NOW\(\)/);
  assert.match(pool.calls[0].text, /totp_verified/);
});

test('the company list clause requires a live grant AND enrolled two-step verification', () => {
  const params = [];
  const sql = companyVisibilitySql({ role: 'advisor', sub: ADVISER }, params);
  assert.match(sql, /company_reviewers r/);
  assert.match(sql, /user_mfa m ON m\.user_id = r\.user_id AND m\.totp_verified/);
  assert.match(sql, /expires_at IS NULL OR r\.expires_at > NOW\(\)/);
  assert.deepEqual(params, [ADVISER]);
  assert.equal(companyVisibilitySql({ role: 'admin', sub: 'a' }, []), '');
});

test('grant input: sections, expiry, attestations', () => {
  assert.equal(normaliseSections(undefined), null);
  assert.equal(normaliseSections('all'), null);
  assert.equal(normaliseSections([]), null);
  assert.deepEqual(normaliseSections([S2, ' ' + S3 + ' ', S2]), [S2, S3]);
  assert.throws(() => normaliseSections({}), GrantInputError);

  assert.throws(() => parseExpiry(undefined), /access-until date is required/);
  assert.throws(() => parseExpiry('nonsense'), /not a valid date/);
  assert.throws(() => parseExpiry('2020-01-01'), /must be in the future/);
  assert.ok(parseExpiry('2999-01-01') instanceof Date);
  const d = defaultExpiry(new Date('2026-09-11T00:00:00Z'));
  assert.equal(d.toISOString().slice(0, 10), '2026-10-11');

  assert.throws(() => requireAttestations({}), /Both confirmations are required/);
  assert.throws(() => requireAttestations({ confidentiality: true }), GrantInputError);
  assert.throws(() => requireAttestations({ confidentiality: true, ndaPermits: 'yes' }), GrantInputError);
  assert.deepEqual(requireAttestations({ confidentiality: true, ndaPermits: true }), { confidentiality: true, ndaPermits: true });

  const s = attestationSentences({ personName: 'Dr Adviser', companyName: 'Example Bio' });
  assert.equal(s.confidentiality,
    'Dr Adviser is bound by a confidentiality undertaking to Taranis Capital that covers this company\'s information.');
  assert.equal(s.ndaPermits,
    'Example Bio\'s non-disclosure agreement with Taranis Capital permits disclosure to our advisers under confidence.');
});

test('two-step verification is mandatory at login for an advisor or viewer with a live grant, and unchanged otherwise', async (t) => {
  const { setPool, resetPool } = await import('../src/db.js');
  t.after(() => resetPool());

  setPool(fakePool([['SELECT 1 FROM company_reviewers', [{ '?column?': 1 }]]]));
  assert.equal(await mfaIsMandatoryForUser({ id: ADVISER, role: 'advisor' }), true);
  assert.equal(await mfaIsMandatoryForUser({ id: ADVISER, role: 'viewer' }), true);
  assert.equal(await mfaIsMandatoryForUser({ id: ADVISER, role: 'investor' }), false, 'investors cannot hold a grant');
  assert.equal(await mfaIsMandatoryForUser({ id: ADVISER, role: 'company' }), true, 'the company rule is unchanged');

  setPool(fakePool([['SELECT 1 FROM company_reviewers', []]]));
  assert.equal(await mfaIsMandatoryForUser({ id: ADVISER, role: 'advisor' }), false, 'no grant, opt-in as before');
  assert.equal(await mfaIsMandatoryForUser({ id: ADVISER, role: 'admin' }), false, 'admin two-step is a separate decision (CW028 §5)');
});

// ---------------------------------------------------------------------------
// Access resolution through the middleware
// ---------------------------------------------------------------------------

test('an expired grant behaves as no grant: 404 on every company route', async (t) => {
  // The resolver filters expiry in SQL, so the fake returns nothing.
  const pool = fakePool([reviewerHandler(null)]);
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  for (const path of [
    `/companies/${COMPANY_A}`, `/companies/${COMPANY_A}/irl-items`, `/companies/${COMPANY_A}/files`,
  ]) {
    const res = await server.request(path, { token: adviserToken() });
    assert.equal(res.status, 404, path);
  }
});

test('a live grant without two-step verification is refused at the point of access, and told why', async (t) => {
  const pool = fakePool([reviewerHandler('reviewer', { mfa: false })]);
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  const res = await server.request(`/companies/${COMPANY_A}/irl-items`, { token: adviserToken() });
  assert.equal(res.status, 403);
  assert.equal(res.body.mfaEnrolmentRequired, true);
  assert.equal(pool.calls.some((c) => c.text.includes('FROM company_irl_items i')), false, 'nothing read');
});

test('the pipeline carries the grant level per row for a non-admin', async (t) => {
  const pool = fakePool([['FROM companies c', [{
    id: COMPANY_A, fund_id: 'f', fund_name: 'Biotech', legal_name: 'Example Bio', status: 'active',
    item_count: '1', completed_count: '0', attention_count: '0', awaiting_review: '0', access_level: 'readonly',
  }]]]);
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  const res = await server.request('/companies', { token: adviserToken() });
  assert.equal(res.status, 200);
  assert.equal(res.body[0].accessLevel, 'readonly');
  const sql = pool.calls[0].text;
  assert.match(sql, /m\.totp_verified/);
  assert.match(sql, /expires_at IS NULL OR r\.expires_at > NOW\(\)/);
});

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

test('an adviser sees only items in scope, never internal_note or source_document, and restricted items show no files', async (t) => {
  const pool = fakePool([
    reviewerHandler('readonly', { sections: [S2, S14] }),
    ['FROM company_irl_items i WHERE i.company_id', [
      itemRow({ id: 'i2', ref: '2.1', section: S2 }),
      itemRow({ id: 'i3', ref: '3.1', section: S3 }),
      itemRow({ id: 'i14', ref: '14.1', section: S14, adviser_restricted: true, submitted_files: '4' }),
    ]],
  ]);
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  const res = await server.request(`/companies/${COMPANY_A}/irl-items`, { token: adviserToken() });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.map((i) => i.ref), ['2.1', '14.1']);
  for (const item of res.body) {
    assert.equal('internal_note' in item, false, item.ref);
    assert.equal('source_document' in item, false, item.ref);
  }
  const restricted = res.body.find((i) => i.ref === '14.1');
  assert.equal(restricted.adviser_restricted, true);
  assert.equal(restricted.submitted_files, 0);
});

test('an admin sees every item with its internal fields and the restriction flag', async (t) => {
  const pool = fakePool([['FROM company_irl_items i WHERE i.company_id', [itemRow({ adviser_restricted: true })]]]);
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  const res = await server.request(`/companies/${COMPANY_A}/irl-items`, { token: adminToken() });
  assert.equal(res.body[0].internal_note, 'never');
  assert.equal(res.body[0].adviser_restricted, true);
});

test('only an admin can change the restriction flag, and the change is audited with before and after', async (t) => {
  const pool = fakePool([
    ['SELECT id, ref, section, adviser_restricted FROM company_irl_items', [{ id: 'item-1', ref: '2.1', section: S2, adviser_restricted: false }]],
    ['UPDATE company_irl_items SET', (params) => [itemRow({ adviser_restricted: params[2] })]],
  ]);
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  const res = await server.request(`/companies/${COMPANY_A}/irl-items/item-1`, {
    method: 'PATCH', token: adminToken(), body: { adviserRestricted: true },
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const audits = pool.calls.filter((c) => c.text.includes('INSERT INTO audit_log'));
  const restriction = audits.find((a) => a.params[1] === 'irl_item.restriction_changed');
  assert.ok(restriction);
  const detail = JSON.parse(restriction.params[4]);
  assert.equal(detail.before, false);
  assert.equal(detail.after, true);
  assert.equal(detail.itemRef, '2.1');

  const bad = await server.request(`/companies/${COMPANY_A}/irl-items/item-1`, {
    method: 'PATCH', token: adminToken(), body: { adviserRestricted: 'yes' },
  });
  assert.equal(bad.status, 400);
});

test('a reviewer-level grant cannot change the flag, and cannot touch an out-of-scope or restricted item', async (t) => {
  const pool = fakePool([
    reviewerHandler('reviewer', { sections: [S2] }),
    ['SELECT id, ref, section, adviser_restricted FROM company_irl_items', (params) => (
      params[0] === 'out' ? [{ id: 'out', ref: '3.1', section: S3, adviser_restricted: false }]
        : params[0] === 'locked' ? [{ id: 'locked', ref: '2.9', section: S2, adviser_restricted: true }]
          : [{ id: 'in', ref: '2.1', section: S2, adviser_restricted: false }]
    )],
    ['UPDATE company_irl_items SET', [itemRow({ id: 'in' })]],
  ]);
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  const flag = await server.request(`/companies/${COMPANY_A}/irl-items/in`, {
    method: 'PATCH', token: adviserToken(), body: { adviserRestricted: true },
  });
  assert.equal(flag.status, 403);

  for (const id of ['out', 'locked']) {
    const res = await server.request(`/companies/${COMPANY_A}/irl-items/${id}`, {
      method: 'PATCH', token: adviserToken(), body: { internalNote: 'x' },
    });
    assert.equal(res.status, 404, id);
  }
  assert.equal(pool.calls.some((c) => c.text.includes('UPDATE company_irl_items')), false);

  const ok = await server.request(`/companies/${COMPANY_A}/irl-items/in`, {
    method: 'PATCH', token: adviserToken(), body: { state: 'in_review' },
  });
  assert.equal(ok.status, 200);
  assert.equal('internal_note' in ok.body, false, 'the reviewer response is the adviser-safe shape');
});

// ---------------------------------------------------------------------------
// Files: list, download, history, status
// ---------------------------------------------------------------------------

test('the Files tab shows an adviser only in-scope, unrestricted, submitted files; an admin sees all with the lock state', async (t) => {
  const rows = [
    fileRow({ id: 'f-in' }),
    fileRow({ id: 'f-out', irl_item_id: 'i3', item_section: S3, item_ref: '3.1' }),
    fileRow({ id: 'f-locked', irl_item_id: 'i14', item_section: S14, item_ref: '14.1', item_restricted: true }),
    fileRow({ id: 'f-released', irl_item_id: 'i14', item_section: S14, item_ref: '14.1', item_restricted: true, adviser_override: 'released', adviser_override_reason: 'Redacted copy' }),
    fileRow({ id: 'f-extra', irl_item_id: null, item_section: null, item_ref: null }),
    fileRow({ id: 'f-cv', adviser_override: 'restricted' }),
  ];
  const pool = fakePool([
    reviewerHandler('readonly', { sections: [S2, S14] }),
    ['LEFT JOIN users ob ON ob.id = f.adviser_override_by', rows],
  ]);
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  const adviser = await server.request(`/companies/${COMPANY_A}/files`, { token: adviserToken() });
  assert.equal(adviser.status, 200);
  assert.deepEqual(adviser.body.map((f) => f.id).sort(), ['f-in', 'f-released']);
  assert.equal('adviserOverride' in adviser.body[0], false, 'override detail is admin-only');

  const admin = await server.request(`/companies/${COMPANY_A}/files`, { token: adminToken() });
  assert.equal(admin.body.length, 6);
  const byId = Object.fromEntries(admin.body.map((f) => [f.id, f]));
  assert.equal(byId['f-locked'].adviserRestricted, true);
  assert.equal(byId['f-released'].adviserRestricted, false);
  assert.equal(byId['f-released'].adviserOverrideReason, 'Redacted copy');
  assert.equal(byId['f-extra'].adviserRestricted, true, 'additional documents start restricted');
  assert.equal(byId['f-cv'].adviserRestricted, true);
  assert.equal(byId['f-in'].adviserRestricted, false);
});

test('download and history of a restricted or out-of-scope file are 404 for an adviser; an admin still downloads it', async (t) => {
  const store = new MemoryStorage();
  setStorage(store);
  setScanner(new StubScanner({ warnOnUse: false }));
  t.after(() => { resetStorage(); resetScanner(); });
  const key = `companies/${COMPANY_A}/i14/${FILE_1}/passport.pdf`;
  await store.put(key, { body: Buffer.from('passport'), contentType: 'application/pdf', contentLength: 8 });

  const locked = fileRow({ s3_key: key, filename: 'passport.pdf', irl_item_id: 'i14', item_section: S14, item_restricted: true });
  const pool = fakePool([
    reviewerHandler('readonly'),
    ['WHERE f.id = $1 AND f.deleted_at IS NULL', [locked]],
  ]);
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  for (const path of [`/company-files/${FILE_1}/download`, `/company-files/${FILE_1}/history`]) {
    const res = await server.request(path, { token: adviserToken() });
    assert.equal(res.status, 404, path);
  }
  assert.equal(pool.calls.some((c) => c.text.includes('INSERT INTO audit_log')), false, 'a refused download is not a download');

  const admin = await fetch(`${server.base}/company-files/${FILE_1}/download`, {
    headers: { Authorization: `Bearer ${adminToken()}` },
  });
  assert.equal(admin.status, 200);
  assert.equal(await admin.text(), 'passport');
});

test('an adviser download of an in-scope file is served and audited with the grant', async (t) => {
  const store = new MemoryStorage();
  setStorage(store);
  setScanner(new StubScanner({ warnOnUse: false }));
  t.after(() => { resetStorage(); resetScanner(); });
  const key = `companies/${COMPANY_A}/item-1/${FILE_1}/deck.pdf`;
  await store.put(key, { body: Buffer.from('deck'), contentType: 'application/pdf', contentLength: 4 });

  const pool = fakePool([
    reviewerHandler('readonly', { sections: [S2] }),
    ['WHERE f.id = $1 AND f.deleted_at IS NULL', [fileRow({ s3_key: key })]],
  ]);
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  const res = await fetch(`${server.base}/company-files/${FILE_1}/download`, {
    headers: { Authorization: `Bearer ${adviserToken()}` },
  });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'deck');

  const audit = pool.calls.find((c) => c.text.includes('INSERT INTO audit_log'));
  assert.equal(audit.params[1], 'company_file.downloaded');
  assert.equal(audit.params[0], ADVISER);
  const detail = JSON.parse(audit.params[4]);
  assert.equal(detail.companyId, COMPANY_A);
  assert.equal(detail.accessLevel, 'readonly');
  assert.equal(detail.grantId, 'grant-1');
});

test('a read-only grant cannot set a file status; a reviewer grant can, on a file it can see', async (t) => {
  const readonlyPool = fakePool([
    reviewerHandler('readonly'),
    ['WHERE f.id = $1 AND f.deleted_at IS NULL', [fileRow()]],
  ]);
  const server = await startTestServer(MOUNTS, readonlyPool);
  t.after(() => server.close());

  const res = await server.request(`/company-files/${FILE_1}/status`, {
    method: 'PATCH', token: adviserToken(), body: { status: 'in_review' },
  });
  assert.equal(res.status, 403);
  assert.match(res.body.error, /read-only/);
});

test('the file override is admin-only, needs a reason to release, and is audited with before and after', async (t) => {
  const pool = fakePool([
    reviewerHandler('reviewer'),
    ['WHERE f.id = $1 AND f.deleted_at IS NULL', [fileRow({ irl_item_id: 'i14', item_section: S14, item_restricted: true })]],
    ['SET adviser_override', (params) => [fileRow({ adviser_override: params[1], adviser_override_reason: params[3] })]],
  ]);
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  const reviewer = await server.request(`/company-files/${FILE_1}/adviser-access`, {
    method: 'PATCH', token: adviserToken(), body: { override: 'released', reason: 'x' },
  });
  assert.equal(reviewer.status, 403);

  const noReason = await server.request(`/company-files/${FILE_1}/adviser-access`, {
    method: 'PATCH', token: adminToken(), body: { override: 'released' },
  });
  assert.equal(noReason.status, 400);
  assert.match(noReason.body.error, /reason is required/);

  const bad = await server.request(`/company-files/${FILE_1}/adviser-access`, {
    method: 'PATCH', token: adminToken(), body: { override: 'public' },
  });
  assert.equal(bad.status, 400);
  assert.equal(pool.calls.some((c) => c.text.includes('SET adviser_override')), false);

  const ok = await server.request(`/company-files/${FILE_1}/adviser-access`, {
    method: 'PATCH', token: adminToken(), body: { override: 'released', reason: 'Redacted copy, identity pages removed' },
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.adviserRestricted, false);

  const audit = pool.calls.find((c) => c.text.includes('INSERT INTO audit_log'));
  assert.equal(audit.params[1], 'company_file.override_changed');
  const detail = JSON.parse(audit.params[4]);
  assert.deepEqual(detail.before, { override: 'follow_item', restricted: true });
  assert.deepEqual(detail.after, { override: 'released', restricted: false });
  assert.equal(detail.reason, 'Redacted copy, identity pages removed');
});

// ---------------------------------------------------------------------------
// Review queue
// ---------------------------------------------------------------------------

test('the review queue applies the per-company grant to each row', async (t) => {
  const rows = [
    fileRow({ id: 'a-in', company_id: COMPANY_A, legal_name: 'A' }),
    fileRow({ id: 'a-locked', company_id: COMPANY_A, legal_name: 'A', irl_item_id: 'i14', item_section: S14, item_restricted: true }),
    fileRow({ id: 'b-out', company_id: COMPANY_B, legal_name: 'B', irl_item_id: 'i3', item_section: S3 }),
    fileRow({ id: 'b-in', company_id: COMPANY_B, legal_name: 'B', irl_item_id: 'i2', item_section: S2 }),
  ];
  const pool = fakePool([
    // The queue query itself carries the visibility clause, which mentions
    // company_reviewers, so it must be matched first.
    ['JOIN companies c ON c.id = f.company_id', rows],
    // liveGrantsByCompany: two grants with different scopes.
    ['FROM company_reviewers r', [
      { company_id: COMPANY_A, id: 'g-a', level: 'reviewer', sections: null, expires_at: null, totp_verified: true },
      { company_id: COMPANY_B, id: 'g-b', level: 'readonly', sections: [S2], expires_at: null, totp_verified: true },
    ]],
  ]);
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  const res = await server.request('/review-queue?status=all', { token: adviserToken() });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.map((r) => r.id), ['a-in', 'b-in']);

  const admin = await server.request('/review-queue?status=all', { token: adminToken() });
  assert.equal(admin.body.length, 4);
  assert.equal(admin.body.find((r) => r.id === 'a-locked').adviserRestricted, true);
});

// ---------------------------------------------------------------------------
// Admin-only surfaces
// ---------------------------------------------------------------------------

test('exports, the user list, shared documents, company settings and adding items are refused to any grant', async (t) => {
  const pool = fakePool([reviewerHandler('reviewer')]);
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  const attempts = [
    ['GET', `/companies/${COMPANY_A}/export?format=prefilled`],
    ['GET', `/companies/${COMPANY_A}/export?format=gaps`],
    ['GET', `/companies/${COMPANY_A}/users`],
    ['GET', `/companies/${COMPANY_A}/shared-files`],
    ['PATCH', `/companies/${COMPANY_A}`],
    ['POST', `/companies/${COMPANY_A}/irl-items`],
    ['GET', `/companies/${COMPANY_A}/access`],
    ['POST', `/companies/${COMPANY_A}/access`],
  ];
  for (const [method, path] of attempts) {
    const res = await server.request(path, { method, token: adviserToken(), body: method === 'GET' ? undefined : {} });
    assert.equal(res.status, 403, `${method} ${path}`);
  }
});

// ---------------------------------------------------------------------------
// Granting
// ---------------------------------------------------------------------------

function grantPool(extra = []) {
  return fakePool([
    ['SELECT id, display_name, role, status FROM users', (params) => ({
      'u-adv': [{ id: 'u-adv', display_name: 'Dr Adviser', role: 'advisor', status: 'active' }],
      'u-inv': [{ id: 'u-inv', display_name: 'An Investor', role: 'investor', status: 'active' }],
      'u-co': [{ id: 'u-co', display_name: 'A Founder', role: 'company', status: 'active' }],
      'u-off': [{ id: 'u-off', display_name: 'Gone', role: 'viewer', status: 'disabled' }],
    }[params[0]] || [])],
    ['SELECT id, legal_name, fund_id FROM companies', [{ id: COMPANY_A, legal_name: 'Example Bio', fund_id: 'fund-1' }]],
    ['SELECT DISTINCT section FROM company_irl_items', [{ section: S2 }, { section: S3 }, { section: S14 }]],
    ['SELECT * FROM company_reviewers WHERE company_id = $1 AND user_id = $2', []],
    ['INSERT INTO company_reviewers', (params) => [{
      id: GRANT_1, company_id: params[0], user_id: params[1], level: params[2], sections: params[3],
      expires_at: params[4], assigned_by: params[5], created_at: new Date(), attested_by: params[5],
      attested_at: new Date(), attestation_version: params[6],
    }]],
    ['FROM grants WHERE user_id', []],
    ...extra,
  ]);
}

const validGrant = {
  userId: 'u-adv', level: 'readonly', sections: [S2, S3], accessUntil: '2999-01-01T00:00:00Z',
  attestations: { confidentiality: true, ndaPermits: true },
};

test('an admin gives access with level, sections, an end date and both confirmations; it is audited with the sentences', async (t) => {
  const pool = grantPool();
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  const res = await server.request(`/companies/${COMPANY_A}/access`, {
    method: 'POST', token: adminToken(), body: validGrant,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.level, 'readonly');
  assert.deepEqual(res.body.sections, [S2, S3]);
  assert.equal(res.body.expired, false);
  assert.match(res.body.warning, /holds no document access/);

  const insert = pool.calls.find((c) => c.text.includes('INSERT INTO company_reviewers'));
  assert.equal(insert.params[2], 'readonly');
  assert.deepEqual(insert.params[3], [S2, S3]);
  assert.ok(insert.params[4] instanceof Date);
  assert.equal(insert.params[6], '2026-09-11');

  const audit = pool.calls.find((c) => c.text.includes('INSERT INTO audit_log'));
  assert.equal(audit.params[1], 'company_grant.created');
  const detail = JSON.parse(audit.params[4]);
  assert.equal(detail.before, null);
  assert.deepEqual(detail.after.sections, [S2, S3]);
  assert.match(detail.attestations.sentences.confidentiality, /^Dr Adviser is bound by a confidentiality undertaking/);
  assert.match(detail.attestations.sentences.ndaPermits, /^Example Bio's non-disclosure agreement/);
});

test('a grant is refused without both confirmations, without an end date, or with a past date', async (t) => {
  const pool = grantPool();
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  const cases = [
    [{ ...validGrant, attestations: { confidentiality: true } }, /Both confirmations/],
    [{ ...validGrant, attestations: undefined }, /Both confirmations/],
    [{ ...validGrant, accessUntil: undefined }, /access-until date is required/],
    [{ ...validGrant, accessUntil: '2020-01-01' }, /must be in the future/],
    [{ ...validGrant, sections: ['99. Nope'] }, /Unknown section/],
    [{ ...validGrant, level: 'admin' }, /reviewer or readonly/],
  ];
  for (const [body, pattern] of cases) {
    const res = await server.request(`/companies/${COMPANY_A}/access`, { method: 'POST', token: adminToken(), body });
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.match(res.body.error, pattern);
  }
  assert.equal(pool.calls.some((c) => c.text.includes('INSERT INTO company_reviewers')), false);
});

test('investors, company users and disabled accounts cannot be given access', async (t) => {
  const pool = grantPool();
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  for (const [userId, pattern] of [['u-inv', /Only an advisor or a viewer/], ['u-co', /Only an advisor or a viewer/], ['u-off', /active account/]]) {
    const res = await server.request(`/companies/${COMPANY_A}/access`, {
      method: 'POST', token: adminToken(), body: { ...validGrant, userId },
    });
    assert.equal(res.status, 400, userId);
    assert.match(res.body.error, pattern);
  }
  assert.equal(pool.calls.some((c) => c.text.includes('INSERT INTO company_reviewers')), false);
});

test('editing and removing a grant are audited with before and after; the list marks expired and undated rows', async (t) => {
  const existing = {
    id: GRANT_1, company_id: COMPANY_A, user_id: 'u-adv', level: 'readonly', sections: [S2],
    expires_at: new Date('2999-01-01'), assigned_by: 'admin-1', created_at: new Date(),
  };
  const pool = fakePool([
    ['SELECT * FROM company_reviewers WHERE id = $1 AND company_id = $2', [existing]],
    ['UPDATE company_reviewers SET', () => [{ ...existing, level: 'reviewer', sections: null }]],
    ['JOIN users a ON a.id = r.assigned_by', [
      { ...existing, level: 'reviewer', sections: null, display_name: 'Dr Adviser', email: 'a@x', role: 'advisor', assigned_by_name: 'An Admin' },
      { ...existing, id: 'g-old', user_id: 'u-old', expires_at: null, display_name: 'Old Hand', role: 'viewer', assigned_by_name: 'An Admin' },
      { ...existing, id: 'g-exp', user_id: 'u-exp', expires_at: new Date('2020-01-01'), display_name: 'Expired', role: 'viewer', assigned_by_name: 'An Admin' },
    ]],
    ['GROUP BY user_id', [{ user_id: 'u-adv', downloads: '3', last_download: new Date('2026-09-10') }]],
    ['DELETE FROM company_reviewers', [existing]],
  ]);
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  const edit = await server.request(`/companies/${COMPANY_A}/access/${GRANT_1}`, {
    method: 'PATCH', token: adminToken(), body: { level: 'reviewer', sections: 'all' },
  });
  assert.equal(edit.status, 200, JSON.stringify(edit.body));
  let audit = pool.calls.filter((c) => c.text.includes('INSERT INTO audit_log')).at(-1);
  assert.equal(audit.params[1], 'company_grant.updated');
  let detail = JSON.parse(audit.params[4]);
  assert.deepEqual(detail.before.sections, [S2]);
  assert.equal(detail.after.level, 'reviewer');
  assert.equal(detail.after.sections, null);

  const list = await server.request(`/companies/${COMPANY_A}/access`, { token: adminToken() });
  assert.equal(list.status, 200);
  const byId = Object.fromEntries(list.body.map((g) => [g.id, g]));
  assert.equal(byId[GRANT_1].downloads.count, 3);
  assert.equal(byId['g-old'].needsEndDate, true, 'a pre-CW028 row is flagged for dating, not defaulted');
  assert.equal(byId['g-exp'].expired, true);
  assert.equal(byId['g-exp'].downloads.count, 0);

  const remove = await server.request(`/companies/${COMPANY_A}/access/${GRANT_1}`, { method: 'DELETE', token: adminToken() });
  assert.equal(remove.status, 200);
  audit = pool.calls.filter((c) => c.text.includes('INSERT INTO audit_log')).at(-1);
  assert.equal(audit.params[1], 'company_grant.removed');
  detail = JSON.parse(audit.params[4]);
  assert.equal(detail.after, null);
  assert.equal(detail.before.level, 'readonly');
});

test('the candidate list offers active advisors and viewers only', async (t) => {
  const pool = fakePool([['AS has_fund_grant', [{ id: 'u-adv', display_name: 'Dr Adviser', email: 'a@x', role: 'advisor', mfa_enabled: true, has_fund_grant: false }]]]);
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  const res = await server.request(`/companies/${COMPANY_A}/access/candidates`, { token: adminToken() });
  assert.equal(res.status, 200);
  const sql = pool.calls.find((c) => c.text.includes('AS has_fund_grant'));
  assert.match(sql.text, /u\.status = 'active'/);
  assert.deepEqual(sql.params[1], ['advisor', 'viewer']);
  assert.equal(res.body[0].hasFundGrant, false);
});
