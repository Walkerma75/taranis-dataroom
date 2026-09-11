/**
 * Test harness for the route-level tests.
 *
 * Builds a real Express app with the real routers and the real middleware, and
 * swaps a fake pool in underneath. Nothing here stubs the guards: an isolation
 * test that passed against a mocked `requireCompany` would prove nothing, so
 * the middleware under test is the shipping code and only the database is fake.
 *
 * No new dependency. `node:test`, `express` (already a dependency) and the
 * runtime's own `fetch` against an ephemeral port.
 */
import express from 'express';
import jwt from 'jsonwebtoken';
import { setPool, resetPool } from '../../src/db.js';

const JWT_SECRET = process.env.JWT_SECRET || 'local-dev-secret-do-not-use-in-production';

/**
 * A pool whose responses are matched on distinctive fragments of the SQL.
 *
 * Every query is recorded, so a test can assert not only that a request was
 * refused but that the SQL which ran was scoped the way it claims to be.
 */
export function fakePool(handlers = []) {
  const calls = [];

  async function query(text, params) {
    calls.push({ text, params });
    for (const [fragment, respond] of handlers) {
      if (text.includes(fragment)) {
        const result = typeof respond === 'function' ? await respond(params, text) : respond;
        return normalise(result);
      }
    }
    return normalise({ rows: [] });
  }

  function normalise(result) {
    if (Array.isArray(result)) return { rows: result, rowCount: result.length };
    return { rowCount: result.rows?.length ?? 0, ...result };
  }

  return {
    query,
    calls,
    /** Every statement issued so far, for scope assertions. */
    sql: () => calls.map((c) => c.text),
    async connect() {
      return { query, release() {} };
    },
    async end() {},
  };
}

/** The membership row shape `loadCompanyMembership` returns. */
export function membershipRow({
  companyId,
  userId = 'user-1',
  companyRole = 'company_admin',
  companyStatus = 'active',
  approvedBy = 'admin-1',
  isPrimary = true,
  legalName = 'Example Bio Ltd',
  fundId = 'fund-1',
} = {}) {
  return {
    membership_id: `membership-${userId}`,
    company_id: companyId,
    company_role: companyRole,
    is_primary: isPrimary,
    approved_by: approvedBy,
    deactivated_at: null,
    legal_name: legalName,
    company_status: companyStatus,
    fund_id: fundId,
  };
}

/** The handler `requireCompany` needs, wired to one membership (or none). */
export function membershipHandler(row) {
  return ['FROM company_users cu', row ? [row] : []];
}

export function reviewerHandler(level) {
  return ['SELECT level FROM company_reviewers', level ? [{ level }] : []];
}

export function tokenFor({
  sub = 'user-1',
  email = 'user@example.com',
  role = 'company',
  name = 'Test User',
  companyId,
  companyRole,
  mfaPending,
} = {}) {
  return jwt.sign(
    {
      sub, email, role, name,
      ...(companyId ? { companyId } : {}),
      ...(companyRole ? { companyRole } : {}),
      ...(mfaPending ? { mfaPending: true } : {}),
    },
    JWT_SECRET,
    { expiresIn: '15m' }
  );
}

/**
 * Mount a set of `[path, router]` pairs on a fresh app, start it on an
 * ephemeral port and return a `request()` helper plus a `close()`.
 */
export async function startTestServer(mounts, pool) {
  if (pool) setPool(pool);

  const app = express();
  app.use(express.json());
  for (const [path, router] of mounts) app.use(path, router);
  // Match the real app: any unhandled error becomes a 500, never a stack trace.
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  return {
    base,
    async request(path, { method = 'GET', token, body, headers = {} } = {}) {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...headers,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      let json = null;
      try { json = await res.json(); } catch { /* empty body */ }
      return { status: res.status, body: json };
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
      resetPool();
    },
  };
}
