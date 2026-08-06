/**
 * What the admin Users page reads (HANDOVER-C006, code brief §7.3).
 *
 * Two additions, both read-only: the company a company user belongs to, so the
 * row can link through to it, and every pending nomination across all
 * companies, so an admin does not have to open each company in turn to find one
 * waiting.
 *
 * Approval itself is not tested here because none was added: approving is still
 * POST /companies/:id/users, inside the company, and the Users page navigates
 * to it rather than carrying a second copy.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import companyRoutes from '../src/routes/companies.js';
import userRoutes from '../src/routes/users.js';

import { fakePool, tokenFor, startTestServer } from './helpers/test-app.js';

const MOUNTS = [
  ['/users', userRoutes],
  ['/companies', companyRoutes],
];

const COMPANY_A = '11111111-1111-4111-8111-111111111111';

const adminToken = () => tokenFor({ sub: 'admin-1', role: 'admin', email: 'admin@taraniscapital.com' });

// ---------------------------------------------------------------------------
// The company column
// ---------------------------------------------------------------------------

test('GET /users carries the company a company user belongs to, and nothing for anyone else', async (t) => {
  const pool = fakePool([
    ['FROM users u', [
      {
        id: 'user-company', email: 'ceo@examplebio.com', display_name: 'Sara Aziz',
        role: 'company', status: 'active', mfa_enabled: true, capabilities: {},
        company_id: COMPANY_A, company_name: 'Example Bio Ltd', active_grants: '0',
      },
      {
        id: 'user-investor', email: 'lp@example.com', display_name: 'John Smith',
        role: 'investor', status: 'active', mfa_enabled: false, capabilities: {},
        company_id: null, company_name: null, active_grants: '4',
      },
    ]],
  ]);
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  const res = await server.request('/users', { token: adminToken() });
  assert.equal(res.status, 200);

  const [companyUser, investor] = res.body;
  assert.equal(companyUser.companyId, COMPANY_A);
  assert.equal(companyUser.companyName, 'Example Bio Ltd');

  // A fund-side user has no company, and gets null rather than undefined so the
  // column renders empty instead of blowing up.
  assert.equal(investor.companyId, null);
  assert.equal(investor.companyName, null);
});

test('the membership join used by GET /users cannot fan a user into several rows', async (t) => {
  const pool = fakePool([['FROM users u', []]]);
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  await server.request('/users', { token: adminToken() });

  const [sql] = pool.sql();
  // A user holds at most one LIVE membership (migration 011), so the join must
  // exclude deactivated rows. Without this a user removed from one company and
  // added to another would appear twice.
  assert.match(sql, /LEFT JOIN company_users cu ON cu\.user_id = u\.id AND cu\.deactivated_at IS NULL/);
  assert.match(sql, /LEFT JOIN companies c ON c\.id = cu\.company_id/);
});

// ---------------------------------------------------------------------------
// Pending nominations, across all companies
// ---------------------------------------------------------------------------

test('GET /companies/nominations lists nominations with the domain-check flag', async (t) => {
  const pool = fakePool([
    ['FROM company_users cu', [
      {
        membership_id: 'membership-1', user_id: 'user-2', company_id: COMPANY_A,
        company_role: 'company_contributor', domain_matched: false,
        nomination_note: 'Our CFO', created_at: new Date('2026-08-05T09:00:00Z'),
        display_name: 'Omar Haddad', email: 'omar@gmail.com',
        legal_name: 'Example Bio Ltd', company_status: 'active',
        fund_id: 'fund-1', fund_name: 'Biotech KSA',
        nominated_by_name: 'Sara Aziz',
      },
      {
        membership_id: 'membership-2', user_id: 'user-3', company_id: COMPANY_A,
        company_role: 'company_viewer', domain_matched: null,
        nomination_note: null, created_at: new Date('2026-08-06T09:00:00Z'),
        display_name: 'Lena Fischer', email: 'lena@examplebio.com',
        legal_name: 'Example Bio Ltd', company_status: 'active',
        fund_id: 'fund-1', fund_name: 'Biotech KSA',
        nominated_by_name: 'Sara Aziz',
      },
    ]],
  ]);
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  const res = await server.request('/companies/nominations', { token: adminToken() });
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 2);

  const [offDomain, noDomainsRecorded] = res.body;
  assert.equal(offDomain.domainMatched, false);
  assert.equal(offDomain.companyId, COMPANY_A);
  assert.equal(offDomain.companyName, 'Example Bio Ltd');
  assert.equal(offDomain.nominatedBy, 'Sara Aziz');

  // NULL means the company records no domains at all. That is not a mismatch
  // and must not be flattened into false, or every company without recorded
  // domains would flag every one of its nominations.
  assert.equal(noDomainsRecorded.domainMatched, null);
});

test('GET /companies/nominations returns only what is still waiting', async (t) => {
  const pool = fakePool([['FROM company_users cu', []]]);
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  await server.request('/companies/nominations', { token: adminToken() });

  const [sql] = pool.sql();
  assert.match(sql, /cu\.approved_by IS NULL/);
  // A nomination an admin has already refused by removing access must not keep
  // appearing as an outstanding action.
  assert.match(sql, /cu\.deactivated_at IS NULL/);
});

test('the nominations path is not swallowed by GET /companies/:id', async (t) => {
  // Both routes live on the same router and `nominations` is a legal :id value,
  // so the literal path only works while it is declared first.
  const pool = fakePool([['FROM company_users cu', []]]);
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  const res = await server.request('/companies/nominations', { token: adminToken() });

  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
  // The company detail query never ran, so the id route did not take it.
  assert.equal(pool.sql().some((s) => s.includes('created_by_name')), false);
});

test('only an admin can list nominations', async (t) => {
  const pool = fakePool([['FROM company_users cu', []]]);
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  for (const role of ['advisor', 'viewer', 'investor']) {
    const res = await server.request('/companies/nominations', {
      token: tokenFor({ sub: 'user-9', role, email: `${role}@example.com` }),
    });
    assert.equal(res.status, 403, `${role} should not list nominations, got ${res.status}`);
  }

  // Refused before any query ran.
  assert.equal(pool.calls.length, 0);
});

test('a company token reaches neither the user list nor the nominations list', async (t) => {
  const pool = fakePool([]);
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  const token = tokenFor({ role: 'company', companyId: COMPANY_A });

  for (const path of ['/users', '/companies/nominations']) {
    const res = await server.request(path, { token });
    assert.equal(res.status, 403, `${path} should refuse a company token, got ${res.status}`);
  }

  assert.equal(pool.calls.length, 0);
});
