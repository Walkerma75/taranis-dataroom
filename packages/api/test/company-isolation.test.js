/**
 * ISOLATION TESTS — the priority of this release (HANDOVER-CW004 §4, code brief
 * §11).
 *
 * The company DD portal puts counterparty material and fund material in one
 * database, one bucket and one application. Everything else in Phase 1a is
 * features; this file is the reason the feature is safe to ship. Each test
 * drives the real Express routers and the real middleware, with only the
 * database faked, so a passing test is evidence about shipping code rather than
 * about a mock.
 *
 * What is proved here:
 *   1. a company token reaches no fund, document, grant, notice, user or audit
 *      route, including the ?token= download path that re-implements auth
 *   2. an existing investor, advisor, viewer or admin token reaches no
 *      /company/* route
 *   3. no company user can read another company's items, files or receipts by
 *      guessing an id, and the SQL that runs is scoped by company_id
 *   4. pending, suspended and offboarded companies are blocked at the
 *      middleware, before any handler
 *   5. a deactivated or unapproved membership is blocked, immediately, without
 *      waiting for the access token to expire
 *   6. a company user who has not enrolled in TOTP reaches nothing
 *   7. shared documents published by Taranis are readable by the one company
 *      they were published to, by every role in it, and by nobody else; and the
 *      company side of that feature can only read
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import companyPortalRoutes from '../src/routes/company-portal.js';
import companyRoutes, {
  reviewQueueRouter,
  companyFilesRouter,
  irlTemplatesRouter,
} from '../src/routes/companies.js';
import fundRoutes from '../src/routes/funds.js';
import documentRoutes from '../src/routes/documents.js';
import grantRoutes from '../src/routes/grants.js';
import auditRoutes from '../src/routes/audit.js';
import noticeRoutes from '../src/routes/notices.js';
import userRoutes from '../src/routes/users.js';

import {
  fakePool,
  membershipRow,
  membershipHandler,
  reviewerHandler,
  tokenFor,
  startTestServer,
} from './helpers/test-app.js';

const COMPANY_A = '11111111-1111-4111-8111-111111111111';
const COMPANY_B = '22222222-2222-4222-8222-222222222222';
const ITEM_IN_B = '33333333-3333-4333-8333-333333333333';

/** The full set of fund-side mounts, exactly as index.js wires them. */
const FUND_MOUNTS = [
  ['/funds', fundRoutes],
  ['/documents', documentRoutes],
  ['/grants', grantRoutes],
  ['/notices', noticeRoutes],
  ['/users', userRoutes],
  ['/audit', auditRoutes],
  ['/irl-templates', irlTemplatesRouter],
];

const COMPANY_MOUNTS = [
  ['/company', companyPortalRoutes],
  ['/companies', companyRoutes],
  ['/company-files', companyFilesRouter],
  ['/review-queue', reviewQueueRouter],
];

// ---------------------------------------------------------------------------
// 1. A company token reaches nothing on the fund side
// ---------------------------------------------------------------------------

test('a company token is refused by every fund-side route', async (t) => {
  const pool = fakePool([membershipHandler(membershipRow({ companyId: COMPANY_A }))]);
  const server = await startTestServer(FUND_MOUNTS, pool);
  t.after(() => server.close());

  const token = tokenFor({ role: 'company', companyId: COMPANY_A });

  const paths = [
    '/funds',
    '/documents',
    '/grants',
    '/notices',
    '/users',
    '/audit',
    '/irl-templates',
  ];

  for (const path of paths) {
    const res = await server.request(path, { token });
    assert.equal(res.status, 403, `${path} should refuse a company token, got ${res.status}`);
    assert.equal(res.body.error, 'Insufficient permissions');
  }
});

test('a company token is refused on the ?token= document download path', async (t) => {
  // This route re-implements auth rather than using requireAuth, so it is the
  // one place a guard could be missed. It is tested separately for that reason.
  const pool = fakePool([]);
  const server = await startTestServer(FUND_MOUNTS, pool);
  t.after(() => server.close());

  const token = tokenFor({ role: 'company', companyId: COMPANY_A });

  const viaHeader = await server.request('/documents/some-doc-id/download', { token });
  assert.equal(viaHeader.status, 403);

  const viaQuery = await server.request(`/documents/some-doc-id/download?token=${token}`);
  assert.equal(viaQuery.status, 403);

  // And no query ever ran, so the handler was never reached.
  assert.equal(pool.calls.length, 0);
});

test('a company token cannot write fund-side either', async (t) => {
  const pool = fakePool([]);
  const server = await startTestServer(FUND_MOUNTS, pool);
  t.after(() => server.close());

  const token = tokenFor({ role: 'company', companyId: COMPANY_A });

  const post = await server.request('/funds', {
    method: 'POST', token, body: { name: 'Sneaky Fund', slug: 'sneaky' },
  });
  assert.equal(post.status, 403);

  const grant = await server.request('/grants', {
    method: 'POST', token, body: { userId: 'x', fundId: 'y', categoryId: 'z' },
  });
  assert.equal(grant.status, 403);

  // The IRL seed endpoint writes the master checklist every company is measured
  // against, so a company token reaching it would be the worst of the set.
  const seed = await server.request('/irl-templates/seed', {
    method: 'POST', token, body: { fundSlug: 'biotech-ksa' },
  });
  assert.equal(seed.status, 403);

  assert.equal(pool.calls.length, 0, 'no fund-side query should have run');
});

// ---------------------------------------------------------------------------
// 2. Existing roles reach nothing on the company side
// ---------------------------------------------------------------------------

test('investor, advisor and viewer tokens are refused by every /company/* route', async (t) => {
  const pool = fakePool([]);
  const server = await startTestServer(COMPANY_MOUNTS, pool);
  t.after(() => server.close());

  for (const role of ['investor', 'advisor', 'viewer']) {
    const token = tokenFor({ role, sub: `user-${role}` });
    for (const path of [
      '/company/workspace', '/company/staged', '/company/receipts', '/company/team',
      '/company/shared-files', '/company/shared-files/any-id/download',
    ]) {
      const res = await server.request(path, { token });
      assert.equal(res.status, 403, `${role} should not reach ${path}`);
    }
    const submit = await server.request('/company/submit', {
      method: 'POST', token, body: { fileIds: ['x'] },
    });
    assert.equal(submit.status, 403, `${role} should not be able to submit`);
  }
});

test('an admin token is refused by /company/* too, because it is not a company user', async (t) => {
  // Admins reach company material through /companies/:id, which is audited and
  // scoped. There is no admin back door into a counterparty's own workspace.
  const pool = fakePool([]);
  const server = await startTestServer(COMPANY_MOUNTS, pool);
  t.after(() => server.close());

  const res = await server.request('/company/workspace', {
    token: tokenFor({ role: 'admin', sub: 'admin-1' }),
  });
  assert.equal(res.status, 403);
});

test('a company token cannot reach the Taranis-side company routes', async (t) => {
  const pool = fakePool([membershipHandler(membershipRow({ companyId: COMPANY_A }))]);
  const server = await startTestServer(COMPANY_MOUNTS, pool);
  t.after(() => server.close());

  const token = tokenFor({ role: 'company', companyId: COMPANY_A });

  // Not even for its own company: /companies/:id is the reviewer view and
  // carries internal notes.
  for (const path of [
    '/companies',
    `/companies/${COMPANY_A}`,
    `/companies/${COMPANY_A}/irl-items`,
    `/companies/${COMPANY_A}/users`,
    `/companies/${COMPANY_A}/export?format=gaps`,
    '/review-queue',
    '/company-files/any-id/history',
  ]) {
    const res = await server.request(path, { token });
    assert.equal(res.status, 403, `${path} should refuse a company token, got ${res.status}`);
  }
});

// ---------------------------------------------------------------------------
// 3. No cross-company access by id guessing
// ---------------------------------------------------------------------------

test('a company user guessing another company item id gets 404, and the query was scoped', async (t) => {
  const pool = fakePool([
    membershipHandler(membershipRow({ companyId: COMPANY_A })),
    // The item lookup is scoped, so this returns nothing for company A even
    // though the id is a real item in company B.
    ['FROM company_irl_items WHERE id = $1 AND company_id = $2', []],
  ]);
  const server = await startTestServer(COMPANY_MOUNTS, pool);
  t.after(() => server.close());

  const res = await server.request(`/company/items/${ITEM_IN_B}`, {
    token: tokenFor({ role: 'company', companyId: COMPANY_A }),
  });
  assert.equal(res.status, 404);

  const lookup = pool.calls.find((c) => c.text.includes('FROM company_irl_items WHERE id'));
  assert.ok(lookup, 'the item lookup should have run');
  // The scope came from the token, not from anything the caller supplied.
  assert.equal(lookup.params[1], COMPANY_A);
  assert.notEqual(lookup.params[1], COMPANY_B);
});

test('a forged companyId claim is refused, because the claim is checked against the database', async (t) => {
  // The token says company B. The membership record says company A. The
  // mismatch is what makes a stolen or hand-edited claim useless.
  const pool = fakePool([membershipHandler(membershipRow({ companyId: COMPANY_A }))]);
  const server = await startTestServer(COMPANY_MOUNTS, pool);
  t.after(() => server.close());

  const res = await server.request('/company/workspace', {
    token: tokenFor({ role: 'company', companyId: COMPANY_B }),
  });
  assert.equal(res.status, 403);
  assert.match(res.body.error, /withdrawn/);
});

test('a company token with no companyId claim reaches nothing', async (t) => {
  const pool = fakePool([membershipHandler(membershipRow({ companyId: COMPANY_A }))]);
  const server = await startTestServer(COMPANY_MOUNTS, pool);
  t.after(() => server.close());

  const res = await server.request('/company/workspace', {
    token: tokenFor({ role: 'company' }),
  });
  assert.equal(res.status, 403);
  assert.equal(pool.calls.length, 0, 'it should be refused before any query runs');
});

test('every company-portal read is scoped by the company id from the token', async (t) => {
  const pool = fakePool([membershipHandler(membershipRow({ companyId: COMPANY_A }))]);
  const server = await startTestServer(COMPANY_MOUNTS, pool);
  t.after(() => server.close());

  const token = tokenFor({ role: 'company', companyId: COMPANY_A });

  for (const path of [
    '/company/workspace', '/company/staged', '/company/receipts', '/company/team',
    '/company/shared-files',
  ]) {
    pool.calls.length = 0;
    const res = await server.request(path, { token });
    assert.equal(res.status, 200, `${path} should succeed for its own company`);

    // The first call is always the membership lookup done by requireCompany,
    // keyed on the user id. Everything after it is the handler's own reads.
    assert.ok(pool.calls[0].text.includes('FROM company_users cu'));
    const dataQueries = pool.calls.slice(1);
    assert.ok(dataQueries.length > 0, `${path} should have queried something`);
    for (const call of dataQueries) {
      assert.ok(
        call.params?.includes(COMPANY_A),
        `${path}: every query must carry the company id from the token\n${call.text}`
      );
    }
  }
});

// ---------------------------------------------------------------------------
// 4. Company status is enforced at the middleware
// ---------------------------------------------------------------------------

test('pending, suspended and offboarded companies are blocked before any handler', async (t) => {
  for (const status of ['pending', 'suspended', 'offboarded']) {
    const pool = fakePool([
      membershipHandler(membershipRow({ companyId: COMPANY_A, companyStatus: status })),
    ]);
    const server = await startTestServer(COMPANY_MOUNTS, pool);

    const res = await server.request('/company/workspace', {
      token: tokenFor({ role: 'company', companyId: COMPANY_A }),
    });
    assert.equal(res.status, 403, `a ${status} company should be blocked`);

    // Exactly one query ran: the membership lookup. The workspace handler was
    // never reached.
    assert.equal(pool.calls.length, 1, `a ${status} company should not reach the handler`);
    assert.ok(pool.calls[0].text.includes('FROM company_users cu'));

    await server.close();
  }
});

test('a submission is blocked for a suspended company, not merely hidden', async (t) => {
  const pool = fakePool([
    membershipHandler(membershipRow({ companyId: COMPANY_A, companyStatus: 'suspended' })),
  ]);
  const server = await startTestServer(COMPANY_MOUNTS, pool);
  t.after(() => server.close());

  const res = await server.request('/company/submit', {
    method: 'POST',
    token: tokenFor({ role: 'company', companyId: COMPANY_A }),
    body: { fileIds: ['a', 'b'] },
  });
  assert.equal(res.status, 403);
});

// ---------------------------------------------------------------------------
// 5. Membership changes take effect immediately
// ---------------------------------------------------------------------------

test('a deactivated membership is refused immediately, without waiting for token expiry', async (t) => {
  // loadCompanyMembership filters on deactivated_at IS NULL, so a deactivated
  // user simply has no membership to find.
  const pool = fakePool([membershipHandler(null)]);
  const server = await startTestServer(COMPANY_MOUNTS, pool);
  t.after(() => server.close());

  const res = await server.request('/company/workspace', {
    token: tokenFor({ role: 'company', companyId: COMPANY_A }),
  });
  assert.equal(res.status, 403);
  assert.match(res.body.error, /withdrawn/);
});

test('a nominated but unapproved user cannot enter the workspace', async (t) => {
  const pool = fakePool([
    membershipHandler(membershipRow({ companyId: COMPANY_A, approvedBy: null })),
  ]);
  const server = await startTestServer(COMPANY_MOUNTS, pool);
  t.after(() => server.close());

  const res = await server.request('/company/workspace', {
    token: tokenFor({ role: 'company', companyId: COMPANY_A }),
  });
  assert.equal(res.status, 403);
  assert.match(res.body.error, /awaiting approval/);
});

// ---------------------------------------------------------------------------
// 6. Company-side roles
// ---------------------------------------------------------------------------

test('only a company_admin can formally submit', async (t) => {
  for (const role of ['company_contributor', 'company_viewer']) {
    const pool = fakePool([
      membershipHandler(membershipRow({ companyId: COMPANY_A, companyRole: role })),
    ]);
    const server = await startTestServer(COMPANY_MOUNTS, pool);

    const res = await server.request('/company/submit', {
      method: 'POST',
      token: tokenFor({ role: 'company', companyId: COMPANY_A }),
      body: { fileIds: ['a'] },
    });
    assert.equal(res.status, 403, `${role} must not be able to submit`);

    await server.close();
  }
});

test('a company_viewer cannot upload, edit or remove files', async (t) => {
  const pool = fakePool([
    membershipHandler(membershipRow({ companyId: COMPANY_A, companyRole: 'company_viewer' })),
  ]);
  const server = await startTestServer(COMPANY_MOUNTS, pool);
  t.after(() => server.close());

  const token = tokenFor({ role: 'company', companyId: COMPANY_A });

  const patch = await server.request('/company/files/some-id', {
    method: 'PATCH', token, body: { description: 'new' },
  });
  assert.equal(patch.status, 403);

  const del = await server.request('/company/files/some-id', { method: 'DELETE', token });
  assert.equal(del.status, 403);

  const nominate = await server.request('/company/nominations', {
    method: 'POST', token, body: { email: 'x@y.com', displayName: 'X' },
  });
  assert.equal(nominate.status, 403, 'only a company_admin nominates');
});

// ---------------------------------------------------------------------------
// 7. Taranis-side scoping: an assigned reviewer sees one company, not all
// ---------------------------------------------------------------------------

test('a non-admin Taranis user with no assignment gets 404, not 403', async (t) => {
  // 404 rather than 403 so the endpoint cannot be used to discover which
  // company ids exist.
  const pool = fakePool([reviewerHandler(null)]);
  const server = await startTestServer(COMPANY_MOUNTS, pool);
  t.after(() => server.close());

  const res = await server.request(`/companies/${COMPANY_A}`, {
    token: tokenFor({ role: 'advisor', sub: 'advisor-1' }),
  });
  assert.equal(res.status, 404);
});

test('a readonly reviewer can read a company but cannot change it', async (t) => {
  const pool = fakePool([
    reviewerHandler('readonly'),
    ['FROM companies c', [{
      id: COMPANY_A, fund_id: 'fund-1', legal_name: 'Example Bio Ltd',
      status: 'active', nda_executed_at: new Date(), iems_screened_at: new Date(),
      email_domains: [], fund_name: 'Biotech KSA', created_by_name: 'Admin',
    }]],
    ['FROM company_irl_items WHERE company_id', []],
  ]);
  const server = await startTestServer(COMPANY_MOUNTS, pool);
  t.after(() => server.close());

  const token = tokenFor({ role: 'advisor', sub: 'advisor-1' });

  const read = await server.request(`/companies/${COMPANY_A}`, { token });
  assert.equal(read.status, 200);
  assert.equal(read.body.accessLevel, 'readonly');

  const write = await server.request(`/companies/${COMPANY_A}`, {
    method: 'PATCH', token, body: { jurisdiction: 'DIFC' },
  });
  assert.equal(write.status, 403);
  assert.match(write.body.error, /read-only/);
});

test('an assigned reviewer cannot activate, suspend or invite: those stay admin-only', async (t) => {
  const pool = fakePool([reviewerHandler('reviewer')]);
  const server = await startTestServer(COMPANY_MOUNTS, pool);
  t.after(() => server.close());

  const token = tokenFor({ role: 'advisor', sub: 'advisor-1' });

  for (const path of [
    `/companies/${COMPANY_A}/activate`,
    `/companies/${COMPANY_A}/suspend`,
    `/companies/${COMPANY_A}/offboard`,
    `/companies/${COMPANY_A}/users`,
    `/companies/${COMPANY_A}/reviewers`,
  ]) {
    const res = await server.request(path, { method: 'POST', token, body: {} });
    assert.equal(res.status, 403, `${path} should be admin-only`);
  }
});

// ---------------------------------------------------------------------------
// 8. Mandatory MFA for the company role
// ---------------------------------------------------------------------------

test('an mfaPending token reaches no route at all', async (t) => {
  const pool = fakePool([membershipHandler(membershipRow({ companyId: COMPANY_A }))]);
  const server = await startTestServer([...COMPANY_MOUNTS, ...FUND_MOUNTS], pool);
  t.after(() => server.close());

  const token = tokenFor({ role: 'company', companyId: COMPANY_A, mfaPending: true });

  for (const path of ['/company/workspace', '/company/staged', '/funds', '/documents', '/notices']) {
    const res = await server.request(path, { token });
    assert.equal(res.status, 403, `${path} should refuse an mfaPending token`);
  }

  const workspace = await server.request('/company/workspace', { token });
  assert.equal(workspace.body.mfaEnrolmentRequired, true);
  assert.equal(pool.calls.length, 0, 'nothing should have been queried');
});

test('an mfaPending token is refused on the ?token= download path', async (t) => {
  const pool = fakePool([]);
  const server = await startTestServer(FUND_MOUNTS, pool);
  t.after(() => server.close());

  const token = tokenFor({ role: 'investor', sub: 'investor-1', mfaPending: true });
  const res = await server.request(`/documents/some-doc/download?token=${token}`);
  assert.equal(res.status, 403);
  assert.equal(res.body.mfaEnrolmentRequired, true);
});

// ---------------------------------------------------------------------------
// 9. Shared documents, Taranis to company
//
// This is the only feature on the platform that sends bytes OUT to a
// counterparty, so its isolation is tested with the same weight as the inbound
// path rather than as a footnote to it.
// ---------------------------------------------------------------------------

const SHARED_IN_B = '44444444-4444-4444-8444-444444444444';

test('a company user cannot download another company shared document by guessing its id', async (t) => {
  const pool = fakePool([
    membershipHandler(membershipRow({ companyId: COMPANY_A })),
    // Scoped lookup, so a real row in company B returns nothing for company A.
    ['FROM company_shared_files', []],
  ]);
  const server = await startTestServer(COMPANY_MOUNTS, pool);
  t.after(() => server.close());

  const res = await server.request(`/company/shared-files/${SHARED_IN_B}/download`, {
    token: tokenFor({ role: 'company', companyId: COMPANY_A }),
  });
  assert.equal(res.status, 404);

  const lookup = pool.calls.find((c) => c.text.includes('FROM company_shared_files'));
  assert.ok(lookup, 'the shared document lookup should have run');
  // The scope came from the token, never from the path.
  assert.equal(lookup.params[1], COMPANY_A);
  assert.notEqual(lookup.params[1], COMPANY_B);
  // And a withdrawn row is excluded in the SQL, not in the response shaping.
  assert.match(lookup.text, /withdrawn_at IS NULL/);
});

test('the company shared-documents list is filtered to live rows for one company', async (t) => {
  const pool = fakePool([membershipHandler(membershipRow({ companyId: COMPANY_A }))]);
  const server = await startTestServer(COMPANY_MOUNTS, pool);
  t.after(() => server.close());

  const res = await server.request('/company/shared-files', {
    token: tokenFor({ role: 'company', companyId: COMPANY_A }),
  });
  assert.equal(res.status, 200);

  const list = pool.calls.find((c) => c.text.includes('FROM company_shared_files'));
  assert.ok(list.params.includes(COMPANY_A));
  assert.match(list.text, /withdrawn_at IS NULL/);
});

test('every company role can read shared documents, including a viewer', async (t) => {
  // Code brief §3.2: "Download Taranis Shared documents" is a capability of all
  // three company roles. A viewer who cannot upload can still need to read what
  // Taranis has sent them.
  for (const companyRole of ['company_admin', 'company_contributor', 'company_viewer']) {
    const pool = fakePool([
      membershipHandler(membershipRow({ companyId: COMPANY_A, companyRole })),
    ]);
    const server = await startTestServer(COMPANY_MOUNTS, pool);

    const res = await server.request('/company/shared-files', {
      token: tokenFor({ role: 'company', companyId: COMPANY_A }),
    });
    assert.equal(res.status, 200, `${companyRole} should be able to list shared documents`);

    await server.close();
  }
});

test('the company side of shared documents is read-only: there is no way in to publish or withdraw', async (t) => {
  const pool = fakePool([membershipHandler(membershipRow({ companyId: COMPANY_A }))]);
  const server = await startTestServer(COMPANY_MOUNTS, pool);
  t.after(() => server.close());

  // A company_admin, the most capable company role there is.
  const token = tokenFor({ role: 'company', companyId: COMPANY_A });

  const attempts = [
    ['POST', '/company/shared-files'],
    ['POST', `/company/shared-files/${SHARED_IN_B}/withdraw`],
    ['PATCH', `/company/shared-files/${SHARED_IN_B}`],
    ['DELETE', `/company/shared-files/${SHARED_IN_B}`],
  ];

  for (const [method, path] of attempts) {
    const res = await server.request(path, { method, token, body: { title: 'x' } });
    assert.equal(res.status, 404, `${method} ${path} should not exist on the company side`);
  }

  // Not one of those attempts wrote anything.
  const writes = pool.calls.filter((c) => /INSERT INTO company_shared_files|UPDATE company_shared_files|DELETE FROM company_shared_files/.test(c.text));
  assert.equal(writes.length, 0, 'no company request may write to company_shared_files');
});

test('a company token cannot reach the Taranis-side shared-document routes', async (t) => {
  const pool = fakePool([membershipHandler(membershipRow({ companyId: COMPANY_A }))]);
  const server = await startTestServer(COMPANY_MOUNTS, pool);
  t.after(() => server.close());

  const token = tokenFor({ role: 'company', companyId: COMPANY_A });

  // Not even for its own company. `/companies/*` carries the withdrawal record
  // and the full publication history, neither of which is the company's.
  const attempts = [
    ['GET', `/companies/${COMPANY_A}/shared-files`],
    ['POST', `/companies/${COMPANY_A}/shared-files`],
    ['POST', `/companies/${COMPANY_A}/shared-files/${SHARED_IN_B}/withdraw`],
    ['GET', `/companies/${COMPANY_A}/shared-files/${SHARED_IN_B}/download`],
    ['GET', `/companies/${COMPANY_B}/shared-files`],
  ];

  for (const [method, path] of attempts) {
    const res = await server.request(path, { method, token });
    assert.equal(res.status, 403, `${method} ${path} should refuse a company token`);
  }
  assert.equal(pool.calls.length, 0, 'refused at the mount, before any query ran');
});

test('a pending, suspended or offboarded company sees no shared documents', async (t) => {
  for (const status of ['pending', 'suspended', 'offboarded']) {
    const pool = fakePool([
      membershipHandler(membershipRow({ companyId: COMPANY_A, companyStatus: status })),
    ]);
    const server = await startTestServer(COMPANY_MOUNTS, pool);

    for (const path of ['/company/shared-files', `/company/shared-files/${SHARED_IN_B}/download`]) {
      const res = await server.request(path, {
        token: tokenFor({ role: 'company', companyId: COMPANY_A }),
      });
      assert.equal(res.status, 403, `a ${status} company should be blocked from ${path}`);
    }

    // Only the membership lookups ran. Neither handler was reached.
    assert.ok(pool.calls.every((c) => c.text.includes('FROM company_users cu')));

    await server.close();
  }
});

test('a mfaPending company token reaches no shared document, by header or by ?token=', async (t) => {
  // The download is a link a browser may open in a new tab, so it is the one
  // place a route could be tempted to read the token itself and skip the
  // guards. It does not: `readBearer` folds ?token= into the Authorization
  // header before requireAuth runs, so the MFA check applies to both forms.
  const pool = fakePool([membershipHandler(membershipRow({ companyId: COMPANY_A }))]);
  const server = await startTestServer(COMPANY_MOUNTS, pool);
  t.after(() => server.close());

  const token = tokenFor({ role: 'company', companyId: COMPANY_A, mfaPending: true });

  const viaHeader = await server.request(`/company/shared-files/${SHARED_IN_B}/download`, { token });
  assert.equal(viaHeader.status, 403);
  assert.equal(viaHeader.body.mfaEnrolmentRequired, true);

  const viaQuery = await server.request(`/company/shared-files/${SHARED_IN_B}/download?token=${token}`);
  assert.equal(viaQuery.status, 403);
  assert.equal(viaQuery.body.mfaEnrolmentRequired, true);

  assert.equal(pool.calls.length, 0, 'nothing should have been queried');
});

test('the ?token= form of the shared download is scoped by the claim, not by the path', async (t) => {
  // A valid token opened in a new tab still resolves its company from the
  // claim. There is no query parameter that changes which company is read.
  const pool = fakePool([
    membershipHandler(membershipRow({ companyId: COMPANY_A })),
    ['FROM company_shared_files', []],
  ]);
  const server = await startTestServer(COMPANY_MOUNTS, pool);
  t.after(() => server.close());

  const token = tokenFor({ role: 'company', companyId: COMPANY_A });
  const res = await server.request(
    `/company/shared-files/${SHARED_IN_B}/download?token=${token}&companyId=${COMPANY_B}`
  );
  assert.equal(res.status, 404);

  const lookup = pool.calls.find((c) => c.text.includes('FROM company_shared_files'));
  assert.equal(lookup.params[1], COMPANY_A);
});

test('a readonly Taranis reviewer can read shared documents but cannot publish or withdraw', async (t) => {
  const pool = fakePool([
    reviewerHandler('readonly'),
    ['JOIN users p ON p.id = s.published_by', []],
  ]);
  const server = await startTestServer(COMPANY_MOUNTS, pool);
  t.after(() => server.close());

  const token = tokenFor({ role: 'advisor', sub: 'advisor-1' });

  const read = await server.request(`/companies/${COMPANY_A}/shared-files`, { token });
  assert.equal(read.status, 200);

  const withdraw = await server.request(
    `/companies/${COMPANY_A}/shared-files/${SHARED_IN_B}/withdraw`,
    { method: 'POST', token, body: {} }
  );
  assert.equal(withdraw.status, 403);
  assert.match(withdraw.body.error, /read-only/);
});

test('a Taranis user with no assignment to a company gets 404 on its shared documents', async (t) => {
  const pool = fakePool([reviewerHandler(null)]);
  const server = await startTestServer(COMPANY_MOUNTS, pool);
  t.after(() => server.close());

  const res = await server.request(`/companies/${COMPANY_A}/shared-files`, {
    token: tokenFor({ role: 'advisor', sub: 'advisor-1' }),
  });
  assert.equal(res.status, 404);
});

// ---------------------------------------------------------------------------
// 10. Unauthenticated and malformed
// ---------------------------------------------------------------------------

test('no token reaches nothing, on either side', async (t) => {
  const pool = fakePool([]);
  const server = await startTestServer([...COMPANY_MOUNTS, ...FUND_MOUNTS], pool);
  t.after(() => server.close());

  for (const path of ['/company/workspace', '/companies', '/funds', '/review-queue']) {
    const res = await server.request(path);
    assert.equal(res.status, 401, `${path} should require authentication`);
  }
});

test('a token signed with the wrong secret is refused', async (t) => {
  const jwt = (await import('jsonwebtoken')).default;
  const forged = jwt.sign(
    { sub: 'user-1', role: 'company', companyId: COMPANY_A },
    'not-the-signing-secret',
    { expiresIn: '15m' }
  );

  const pool = fakePool([membershipHandler(membershipRow({ companyId: COMPANY_A }))]);
  const server = await startTestServer(COMPANY_MOUNTS, pool);
  t.after(() => server.close());

  const res = await server.request('/company/workspace', { token: forged });
  assert.equal(res.status, 401);
  assert.equal(pool.calls.length, 0);
});
