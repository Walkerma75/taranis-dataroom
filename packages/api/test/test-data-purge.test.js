/**
 * The smoke-test purge (HANDOVER-CW012 §3.1).
 *
 * The tests that matter here are the refusals. A purge that works is easy; a
 * purge that cannot be talked into touching a real counterparty is the point,
 * so most of what follows drives it at things it must not delete.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PURGE_ALLOWLIST, CONFIRM_PHRASE, PurgeError,
  isPurgeable, refusalFor, planPurge, planUsers, executePurge, removeObjects,
  runPurge, describePlan,
} from '../src/services/test-data-purge.js';
import maintenanceRouter from '../src/routes/maintenance.js';
import { MemoryStorage } from '../src/services/storage.js';
import { setStorage, resetStorage } from '../src/services/storage.js';
import { fakePool, startTestServer, tokenFor } from './helpers/test-app.js';

const SMOKE_ID = 'e0b49e64-6a14-49d1-89ce-944b03f71448';

// ---------------------------------------------------------------------------
// The guard
// ---------------------------------------------------------------------------

test('isPurgeable accepts an allowlisted, offboarded company', () => {
  assert.equal(isPurgeable({
    id: SMOKE_ID, legal_name: 'Phase 1b Smoke Test Ltd', status: 'offboarded',
  }), true);
});

test('isPurgeable refuses a company that is not on the allowlist', () => {
  const adrenomed = { id: 'adr-1', legal_name: 'AdrenoMed AG', status: 'offboarded' };
  assert.equal(isPurgeable(adrenomed), false);
  assert.match(refusalFor(adrenomed), /not on the purge allowlist/);
});

test('isPurgeable refuses an allowlisted company that is not offboarded', () => {
  for (const status of ['pending', 'active', 'suspended']) {
    const row = { id: SMOKE_ID, legal_name: 'Phase 1b Smoke Test Ltd', status };
    assert.equal(isPurgeable(row), false, `status ${status} must be refused`);
    assert.match(refusalFor(row), new RegExp(`status is '${status}'`));
  }
});

test('a pinned id must match: the same legal name on another row is refused', () => {
  const impostor = {
    id: '00000000-0000-0000-0000-000000000000',
    legal_name: 'Phase 1b Smoke Test Ltd',
    status: 'offboarded',
  };
  assert.equal(isPurgeable(impostor), false);
  assert.match(refusalFor(impostor), /allowlist pins id/);
});

test('the name match is exact, not a prefix', () => {
  assert.equal(isPurgeable({
    id: 'x', legal_name: 'Pro-curo Software Limited (Holdings)', status: 'offboarded',
  }), false);
  // Case and surrounding whitespace do not matter; the name itself does.
  assert.equal(isPurgeable({
    id: 'x', legal_name: '  pro-curo software limited ', status: 'offboarded',
  }), true);
});

test('the allowlist names exactly the five rows CW012 lists', () => {
  assert.deepEqual(PURGE_ALLOWLIST.map((t) => t.legalName), [
    'Phase 1b Smoke Test Ltd',
    'ZZZ Smoke Test Ltd',
    'WWW Smoke Test Ltd',
    'Pro-curo Software Limited',
  ]);
});

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

/** A pool that answers the planning queries with a small, controllable world. */
function planningPool({
  companies = [],
  users = [],
  keys = [],
  counts = {},
} = {}) {
  return fakePool([
    ['FROM companies\n      WHERE lower(trim(legal_name))', companies],
    ["FROM users u\n      WHERE u.role = 'company'", users],
    ['FROM company_files WHERE company_id = ANY($1::uuid[])\n      UNION',
      keys.map((s3_key) => ({ s3_key }))],
    ['FROM notification_outbox WHERE lower(recipient)', [{ n: counts.outbox ?? 0 }]],
    ['FROM invites WHERE lower(email)', [{ n: counts.invites ?? 0 }]],
    ['COUNT(*) AS n', [{ n: counts.each ?? 0 }]],
  ]);
}

test('planPurge plans only the allowlisted rows and explains every refusal', async () => {
  const pool = planningPool({
    companies: [
      { id: SMOKE_ID, legal_name: 'Phase 1b Smoke Test Ltd', status: 'offboarded', fund_id: 'f1' },
      { id: 'live-1', legal_name: 'Pro-curo Software Limited', status: 'active', fund_id: 'f1' },
    ],
    counts: { each: 3 },
  });

  const plan = await planPurge(pool);

  assert.deepEqual(plan.companies.map((c) => c.id), [SMOKE_ID]);
  assert.equal(plan.refused.length, 1);
  assert.equal(plan.refused[0].id, 'live-1');
  assert.match(plan.refused[0].reason, /status is 'active'/);
  // Two allowlist entries matched nothing at all and are reported as such.
  assert.deepEqual(plan.notFound, ['ZZZ Smoke Test Ltd', 'WWW Smoke Test Ltd']);
});

test('planPurge on an already-purged database plans nothing and says so', async () => {
  const plan = await planPurge(planningPool({ companies: [] }));
  assert.equal(plan.companies.length, 0);
  assert.equal(plan.storageKeys.length, 0);
  assert.equal(plan.counts.company_files, 0);
  assert.match(describePlan(plan), /Nothing to purge/);
});

test('planUsers leaves alone anyone who also belongs to a company not being purged', async () => {
  // The SQL is what enforces this, so the test asserts the SQL as well as the
  // shape: a NOT EXISTS over memberships outside the target set.
  const pool = fakePool([["FROM users u\n      WHERE u.role = 'company'", []]]);
  await planUsers([SMOKE_ID], pool);
  const sql = pool.sql().join('\n');
  assert.match(sql, /NOT EXISTS/);
  assert.match(sql, /NOT \(cu\.company_id = ANY/);
});

test('planUsers splits users by whether the audit log names them', async () => {
  const pool = fakePool([["FROM users u\n      WHERE u.role = 'company'", [
    { id: 'u1', email: 'Fresh@Example.com', display_name: 'Fresh', status: 'invited', has_audit_rows: false },
    { id: 'u2', email: 'rhys@example.com', display_name: 'Rhys Walker', status: 'active', has_audit_rows: true },
  ]]]);

  const { deletable, retained } = await planUsers([SMOKE_ID], pool);

  assert.deepEqual(deletable.map((u) => u.id), ['u1']);
  assert.equal(deletable[0].email, 'fresh@example.com', 'emails are normalised for matching');
  assert.deepEqual(retained.map((u) => u.id), ['u2']);
  assert.match(retained[0].reason, /append-only/);
});

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

test('executePurge breaks the version chain before deleting the files', async () => {
  const pool = fakePool([]);
  const client = await pool.connect();
  await executePurge({
    companies: [{ id: SMOKE_ID, legalName: 'Phase 1b Smoke Test Ltd' }],
    users: { deletable: [], retained: [] },
  }, client);

  const sql = pool.sql();
  const chainBroken = sql.findIndex((s) => s.includes('SET supersedes = NULL'));
  const filesDeleted = sql.findIndex((s) => s.includes('DELETE FROM company_files'));
  assert.ok(chainBroken !== -1, 'the supersedes chain must be broken');
  assert.ok(chainBroken < filesDeleted, 'and it must happen before the delete');
});

test('executePurge deletes children before their parents', async () => {
  const pool = fakePool([]);
  const client = await pool.connect();
  await executePurge({
    companies: [{ id: SMOKE_ID, legalName: 'Phase 1b Smoke Test Ltd' }],
    users: { deletable: [], retained: [] },
  }, client);

  const sql = pool.sql();
  const at = (fragment) => sql.findIndex((s) => s.includes(fragment));

  assert.ok(at('DELETE FROM file_status_history') < at('DELETE FROM company_files'));
  assert.ok(at('DELETE FROM company_files') < at('DELETE FROM submission_batches'));
  assert.ok(at('DELETE FROM company_files') < at('DELETE FROM company_irl_items'));
  assert.ok(at('DELETE FROM company_users') < at('DELETE FROM companies'));
  assert.equal(at('DELETE FROM companies'), sql.length - 1, 'companies go last');
});

test('executePurge never issues a statement against audit_log', async () => {
  const pool = fakePool([]);
  const client = await pool.connect();
  await executePurge({
    companies: [{ id: SMOKE_ID, legalName: 'Phase 1b Smoke Test Ltd' }],
    users: {
      deletable: [{ id: 'u1', email: 'fresh@example.com' }],
      retained: [{ id: 'u2', email: 'rhys@example.com' }],
    },
  }, client);

  for (const statement of pool.sql()) {
    assert.ok(
      !/\baudit_log\b/i.test(statement),
      `no statement may touch audit_log, found: ${statement}`
    );
  }
});

test('a user the database refuses to delete is retired in place, not skipped', async () => {
  // The first DELETE FROM users raises a foreign-key violation, as a real
  // audit_log reference would; the second succeeds.
  let attempt = 0;
  const pool = fakePool([
    ['DELETE FROM users', () => {
      attempt++;
      if (attempt === 1) {
        const err = new Error('violates foreign key constraint "audit_log_user_id_fkey"');
        err.code = '23503';
        throw err;
      }
      return { rows: [] };
    }],
  ]);
  const client = await pool.connect();

  const { deletedUserIds, retiredUserIds } = await executePurge({
    companies: [{ id: SMOKE_ID, legalName: 'Phase 1b Smoke Test Ltd' }],
    users: {
      deletable: [{ id: 'u-audited', email: 'rhys@example.com' }],
      retained: [{ id: 'u-clean', email: 'fresh@example.com' }],
    },
  }, client).then((r) => r);

  assert.deepEqual(retiredUserIds, ['u-audited']);
  assert.deepEqual(deletedUserIds, ['u-clean']);

  const sql = pool.sql().join('\n');
  assert.match(sql, /ROLLBACK TO SAVEPOINT purge_user/);
  assert.match(sql, /SET status = 'disabled'/);
  // A retired account must not keep a live session or a usable second factor.
  assert.match(sql, /DELETE FROM refresh_tokens/);
  assert.match(sql, /DELETE FROM user_mfa/);
});

test('an error that is not a foreign-key violation is not swallowed', async () => {
  const pool = fakePool([
    ['DELETE FROM users', () => {
      const err = new Error('connection lost');
      err.code = '08006';
      throw err;
    }],
  ]);
  const client = await pool.connect();

  await assert.rejects(
    executePurge({
      companies: [{ id: SMOKE_ID, legalName: 'x' }],
      users: { deletable: [{ id: 'u1', email: 'a@b.c' }], retained: [] },
    }, client),
    /connection lost/
  );
});

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

test('removeObjects removes every planned key and reports failures without throwing', async () => {
  const storage = new MemoryStorage();
  await storage.put('companies/a/1/file.pdf', { body: 'one' });
  await storage.put('companies/a/2/file.pdf', { body: 'two' });

  const original = storage.remove.bind(storage);
  storage.remove = async (key) => {
    if (key === 'companies/a/missing.pdf') throw new Error('AccessDenied');
    return original(key);
  };

  const result = await removeObjects(
    ['companies/a/1/file.pdf', 'companies/a/2/file.pdf', 'companies/a/missing.pdf'],
    storage
  );

  assert.equal(result.removed, 2);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].key, 'companies/a/missing.pdf');
  assert.equal(await storage.exists('companies/a/1/file.pdf'), false);
});

// ---------------------------------------------------------------------------
// runPurge
// ---------------------------------------------------------------------------

test('runPurge without a confirmation writes nothing and rolls back', async () => {
  const pool = planningPool({
    companies: [{ id: SMOKE_ID, legal_name: 'Phase 1b Smoke Test Ltd', status: 'offboarded' }],
    keys: ['companies/x/1/a.pdf'],
    counts: { each: 2 },
  });
  const storage = new MemoryStorage();
  await storage.put('companies/x/1/a.pdf', { body: 'still here' });

  const outcome = await runPurge({ storage, db: pool });

  assert.equal(outcome.dryRun, true);
  assert.deepEqual(outcome.plan.companies.map((c) => c.id), [SMOKE_ID]);
  assert.equal(await storage.exists('companies/x/1/a.pdf'), true, 'a dry run deletes no bytes');

  const sql = pool.sql().join('\n');
  assert.ok(!/DELETE FROM/.test(sql), 'a dry run issues no DELETE');
  assert.match(sql, /ROLLBACK/);
});

test('runPurge refuses a wrong confirmation phrase and changes nothing', async () => {
  const pool = planningPool({ companies: [] });
  await assert.rejects(
    runPurge({ confirm: 'purge test data', db: pool }),
    (err) => err instanceof PurgeError && err.code === 'PURGE_BAD_CONFIRMATION'
  );
  assert.equal(pool.calls.length, 0, 'nothing may even be read on a bad confirmation');
});

test('runPurge commits before touching S3, and appends one audit entry', async () => {
  const pool = planningPool({
    companies: [{ id: SMOKE_ID, legal_name: 'Phase 1b Smoke Test Ltd', status: 'offboarded' }],
    keys: ['companies/x/1/a.pdf'],
    counts: { each: 1 },
  });
  const storage = new MemoryStorage();
  await storage.put('companies/x/1/a.pdf', { body: 'bytes' });

  const entries = [];
  const outcome = await runPurge({
    confirm: CONFIRM_PHRASE,
    storage,
    actorId: 'admin-1',
    audit: (e) => entries.push(e),
    db: pool,
  });

  assert.equal(outcome.dryRun, false);
  assert.equal(await storage.exists('companies/x/1/a.pdf'), false);

  const sql = pool.sql();
  const commit = sql.findIndex((s) => s.trim() === 'COMMIT');
  assert.ok(commit !== -1, 'it must commit');
  assert.ok(
    sql.slice(commit).every((s) => !s.includes('DELETE FROM')),
    'no delete may run after the commit'
  );

  assert.equal(entries.length, 1, 'exactly one summarising audit entry');
  assert.equal(entries[0].action, 'test_data.purged');
  assert.equal(entries[0].userId, 'admin-1');
  assert.equal(entries[0].detail.auditLogTreatment, 'untouched; append-only, see services/test-data-purge.js');
});

test('describePlan names the companies, the counts and both user dispositions', () => {
  const text = describePlan({
    companies: [{ id: SMOKE_ID, legalName: 'Phase 1b Smoke Test Ltd', status: 'offboarded' }],
    counts: { company_files: 4, company_users: 1, company_reviewers: 0 },
    storageKeys: ['a', 'b'],
    users: {
      deletable: [{ email: 'fresh@example.com', displayName: 'Fresh' }],
      retained: [{ email: 'rhys@example.com', displayName: 'Rhys Walker', reason: 'named by audit_log entries, which are append-only' }],
    },
    refused: [],
    notFound: ['WWW Smoke Test Ltd'],
  });

  assert.match(text, /Phase 1b Smoke Test Ltd/);
  assert.match(text, /company_files: 4/);
  assert.ok(!text.includes('company_reviewers'), 'zero counts are not listed');
  assert.match(text, /Storage objects: 2/);
  assert.match(text, /Users to delete:/);
  assert.match(text, /retire in place/);
  assert.match(text, /Allowlisted but not present: WWW Smoke Test Ltd/);
});

// ---------------------------------------------------------------------------
// The route
// ---------------------------------------------------------------------------

async function maintenanceServer(pool) {
  setStorage(new MemoryStorage());
  const server = await startTestServer([['/maintenance', maintenanceRouter]], pool);
  const close = server.close;
  server.close = async () => { await close(); resetStorage(); };
  return server;
}

test('the purge endpoint is admin only', async () => {
  const server = await maintenanceServer(planningPool({ companies: [] }));
  try {
    for (const role of ['investor', 'advisor', 'viewer']) {
      const res = await server.request('/maintenance/purge-test-data', {
        method: 'POST', token: tokenFor({ role, sub: 'u1' }), body: {},
      });
      assert.equal(res.status, 403, `${role} must be refused`);
    }
    const anon = await server.request('/maintenance/purge-test-data', { method: 'POST', body: {} });
    assert.equal(anon.status, 401);
  } finally {
    await server.close();
  }
});

test('a company token cannot reach the purge endpoint', async () => {
  const server = await maintenanceServer(planningPool({ companies: [] }));
  try {
    const res = await server.request('/maintenance/purge-test-data', {
      method: 'POST',
      token: tokenFor({ role: 'company', companyId: SMOKE_ID }),
      body: {},
    });
    assert.equal(res.status, 403);
  } finally {
    await server.close();
  }
});

test('POST with no body is a dry run and returns a readable plan', async () => {
  const pool = planningPool({
    companies: [{ id: SMOKE_ID, legal_name: 'Phase 1b Smoke Test Ltd', status: 'offboarded' }],
    counts: { each: 2 },
  });
  const server = await maintenanceServer(pool);
  try {
    const res = await server.request('/maintenance/purge-test-data', {
      method: 'POST', token: tokenFor({ role: 'admin', sub: 'admin-1' }), body: {},
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.dryRun, true);
    assert.match(res.body.message, /Nothing was changed/);
    assert.match(res.body.summary, /Phase 1b Smoke Test Ltd/);
    assert.ok(!pool.sql().join('\n').includes('DELETE FROM'));
  } finally {
    await server.close();
  }
});

test('a wrong confirmation phrase is a 400, not a partial purge', async () => {
  const server = await maintenanceServer(planningPool({ companies: [] }));
  try {
    const res = await server.request('/maintenance/purge-test-data', {
      method: 'POST',
      token: tokenFor({ role: 'admin', sub: 'admin-1' }),
      body: { confirm: 'yes' },
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'PURGE_BAD_CONFIRMATION');
    assert.match(res.body.error, new RegExp(CONFIRM_PHRASE));
  } finally {
    await server.close();
  }
});

test('GET publishes the allowlist so an operator can check it before running', async () => {
  const server = await maintenanceServer(planningPool({ companies: [] }));
  try {
    const res = await server.request('/maintenance/purge-test-data', {
      token: tokenFor({ role: 'admin', sub: 'admin-1' }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.confirmPhrase, CONFIRM_PHRASE);
    assert.equal(res.body.allowlist.length, PURGE_ALLOWLIST.length);
  } finally {
    await server.close();
  }
});
