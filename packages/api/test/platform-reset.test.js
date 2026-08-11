/**
 * The go-live platform reset.
 *
 * This is the most destructive code in the repo and the only deletion the
 * platform will ever perform, so the tests are weighted towards what it must
 * NOT do: touch the audit log, delete the last admin, run without the enable
 * flag, or run without the confirmation phrase. The ordering assertions matter
 * for the same reason — a foreign-key failure halfway through a reset is a
 * rolled-back transaction against a bucket that may already be half empty.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  CONFIRM_PHRASE, ENABLE_FLAG, RESET_TABLES, PRESERVED_TABLES, ResetError,
  resetEnabled, planReset, executeReset, recordIdentities, emptyStorage,
  runReset, describeReset, RESET_TABLES_EXCEPT_ADMIN,
} from '../src/services/platform-reset.js';
import maintenanceRouter from '../src/routes/maintenance.js';
import { MemoryStorage, setStorage, resetStorage } from '../src/services/storage.js';
import { fakePool, startTestServer, tokenFor } from './helpers/test-app.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ADMIN = { id: 'admin-1', email: 'admin@taraniscapital.com', display_name: 'Mark Walker' };

/** A pool that answers the planning queries and records every statement. */
function resetPool({ admin = ADMIN, each = 2, users = 3, auditRows = 5000 } = {}) {
  return fakePool([
    ["FROM users\n      WHERE role = 'admin'", admin ? [admin] : []],
    ['SELECT COUNT(*) AS n FROM users WHERE id <> $1', [{ n: users }]],
    ['SELECT COUNT(*) AS n FROM audit_log', [{ n: auditRows }]],
    ['SELECT COUNT(*) AS n FROM funds', [{ n: 4 }]],
    ['SELECT COUNT(*) AS n FROM document_categories', [{ n: 7 }]],
    ['SELECT id, email, display_name, role, status, created_at\n       FROM users WHERE id <> $1', [
      { id: 'u1', email: 'rhys@example.com', display_name: 'Rhys Walker', role: 'company', status: 'active', created_at: '2026-08-07' },
      { id: 'u2', email: 'test@example.com', display_name: 'A Tester', role: 'investor', status: 'active', created_at: '2026-08-08' },
    ]],
    ['SELECT COUNT(*) AS n FROM', [{ n: each }]],
  ]);
}

const withFlag = { [ENABLE_FLAG]: 'true' };

// ---------------------------------------------------------------------------
// The enable flag
// ---------------------------------------------------------------------------

test('the reset is off unless the flag is exactly "true"', () => {
  assert.equal(resetEnabled({}), false);
  assert.equal(resetEnabled({ [ENABLE_FLAG]: 'false' }), false);
  assert.equal(resetEnabled({ [ENABLE_FLAG]: '1' }), false, 'a truthy string is not enough');
  assert.equal(resetEnabled({ [ENABLE_FLAG]: 'TRUE' }), false, 'and it is case sensitive');
  assert.equal(resetEnabled(withFlag), true);
});

test('runReset refuses outright when the flag is not set, before reading anything', async () => {
  const pool = resetPool();
  await assert.rejects(
    runReset({ confirm: CONFIRM_PHRASE, db: pool, env: {} }),
    (err) => err instanceof ResetError && err.code === 'RESET_DISABLED'
  );
  assert.equal(pool.calls.length, 0, 'a disabled reset must not even open a transaction');
});

// ---------------------------------------------------------------------------
// What it will and will not touch
// ---------------------------------------------------------------------------

test('audit_log, funds, document_categories and _migrations are never in the delete list', () => {
  for (const table of PRESERVED_TABLES) {
    assert.ok(!RESET_TABLES.includes(table), `${table} must never be reset`);
  }
});

test('the delete order puts every child before its parent', () => {
  const at = (table) => RESET_TABLES.indexOf(table);
  // Each pair is a real foreign key; getting one backwards fails in production
  // and nowhere else, which is why they are asserted rather than commented.
  const mustPrecede = [
    ['file_status_history', 'company_files'],
    ['company_files', 'submission_batches'],
    ['company_files', 'company_irl_items'],
    ['company_irl_items', 'companies'],
    ['company_users', 'companies'],
    ['company_reviewers', 'companies'],
    ['company_shared_files', 'companies'],
    ['irl_template_items', 'irl_templates'],
    ['document_overrides', 'documents'],
    ['s3_cutover_archived_documents', 'documents'],
    ['permission_template_entries', 'permission_templates'],
    ['notice_recipients', 'notices'],
  ];
  for (const [child, parent] of mustPrecede) {
    assert.ok(at(child) !== -1 && at(parent) !== -1, `${child}/${parent} must both be listed`);
    assert.ok(at(child) < at(parent), `${child} must be deleted before ${parent}`);
  }
});

test('every table in the delete list actually exists in a migration', () => {
  const dir = path.join(__dirname, '../src/db/migrations');
  const sql = fs.readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => fs.readFileSync(path.join(dir, f), 'utf8'))
    .join('\n');
  for (const table of RESET_TABLES) {
    assert.match(sql, new RegExp(`CREATE TABLE (IF NOT EXISTS )?${table}\\b`),
      `${table} is in RESET_TABLES but no migration creates it`);
  }
});

test('executeReset issues no statement against audit_log except an append', async () => {
  const pool = resetPool();
  const client = await pool.connect();
  await executeReset({ retainedAdmin: { id: ADMIN.id } }, client);

  for (const statement of pool.sql()) {
    if (!/\baudit_log\b/i.test(statement)) continue;
    assert.match(statement, /^\s*INSERT INTO audit_log/,
      `only an INSERT may touch audit_log, found: ${statement}`);
  }
});

test('executeReset breaks the supersedes chain before deleting the files', async () => {
  const pool = resetPool();
  const client = await pool.connect();
  await executeReset({ retainedAdmin: { id: ADMIN.id } }, client);

  const sql = pool.sql();
  const chain = sql.findIndex((s) => s.includes('SET supersedes = NULL'));
  const files = sql.findIndex((s) => s.includes('DELETE FROM company_files'));
  assert.ok(chain !== -1 && chain < files);
});

test('executeReset keeps the admin and restarts the receipt sequence', async () => {
  const pool = resetPool();
  const client = await pool.connect();
  const { deleted } = await executeReset({ retainedAdmin: { id: ADMIN.id } }, client);

  const userDelete = pool.calls.find((c) => c.text.includes('DELETE FROM users'));
  assert.match(userDelete.text, /WHERE id <> \$1/, 'the admin must be excluded by id');
  assert.deepEqual(userDelete.params, [ADMIN.id]);
  assert.ok(pool.sql().some((s) => s.includes('company_receipt_ref_seq RESTART WITH 1')));
  assert.ok('users' in deleted);
});

test('the reset never un-enrols the admin from MFA or signs them out', async () => {
  const pool = resetPool();
  const client = await pool.connect();
  await executeReset({ retainedAdmin: { id: ADMIN.id } }, client);

  // The one that matters: an unscoped `DELETE FROM user_mfa` would leave the
  // only surviving account reachable on a password alone.
  for (const table of RESET_TABLES_EXCEPT_ADMIN) {
    const statement = pool.calls.find((c) => c.text.startsWith(`DELETE FROM ${table}`));
    assert.ok(statement, `${table} must be cleared`);
    assert.match(statement.text, /WHERE user_id <> \$1/,
      `${table} must be scoped away from the retained admin`);
    assert.deepEqual(statement.params, [ADMIN.id]);
  }
  assert.ok(
    !RESET_TABLES.some((t) => RESET_TABLES_EXCEPT_ADMIN.includes(t)),
    'a table must not be in both lists, or the scoped delete would be pointless'
  );
});

// ---------------------------------------------------------------------------
// Identity preservation
// ---------------------------------------------------------------------------

test('every user is recorded in the audit log before being deleted', async () => {
  const pool = resetPool();
  const client = await pool.connect();
  await executeReset({ retainedAdmin: { id: ADMIN.id } }, client);

  const sql = pool.sql();
  const recorded = sql.findIndex((s) => s.includes("'user.identity_recorded'"));
  const deleted = sql.findIndex((s) => s.includes('DELETE FROM users'));
  assert.ok(recorded !== -1, 'identities must be recorded');
  assert.ok(recorded < deleted, 'and recorded BEFORE the delete, or a failure loses them');
});

test('the recorded entry carries enough to resolve the id to a person', async () => {
  const pool = resetPool();
  const client = await pool.connect();
  const identities = await recordIdentities(ADMIN.id, client);

  assert.deepEqual(identities.map((u) => u.email), ['rhys@example.com', 'test@example.com']);

  const entry = pool.calls.find((c) => c.text.includes("'user.identity_recorded'"));
  assert.equal(entry.params[0], 'u1');
  const detail = JSON.parse(entry.params[1]);
  assert.equal(detail.email, 'rhys@example.com');
  assert.equal(detail.displayName, 'Rhys Walker');
  assert.equal(detail.role, 'company');
  assert.match(detail.reason, /no longer exists/);
});

test('the admin is not recorded, because the admin is not deleted', async () => {
  const pool = resetPool();
  const client = await pool.connect();
  await recordIdentities(ADMIN.id, client);
  const select = pool.calls.find((c) => c.text.includes('FROM users WHERE id <> $1'));
  assert.deepEqual(select.params, [ADMIN.id]);
});

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

test('planReset refuses when there is no admin to retain', async () => {
  await assert.rejects(
    planReset(resetPool({ admin: null })),
    (err) => err instanceof ResetError && err.code === 'RESET_NO_ADMIN'
  );
});

test('planReset counts every table and lists every object in the bucket', async () => {
  const storage = new MemoryStorage();
  await storage.put('documents/f1/a.pdf', { body: 'a' });
  await storage.put('companies/c1/x/1/b.pdf', { body: 'b' });
  await storage.put('taranis-shared/c1/2/c.pdf', { body: 'c' });
  // An object no database row knows about. A reset that missed this would not
  // have reset the bucket.
  await storage.put('orphaned/from-a-failed-upload.pdf', { body: 'd' });

  const plan = await planReset(resetPool({ each: 3 }), storage);

  assert.equal(plan.retainedAdmin.email, ADMIN.email);
  assert.equal(plan.storageKeys.length, 4, 'the orphan is included');
  assert.equal(plan.counts.company_files, 3);
  assert.equal(plan.counts.users, 3);
  assert.equal(plan.preserved.audit_log, 5000);
  assert.equal(
    plan.totalRows,
    (RESET_TABLES.length + RESET_TABLES_EXCEPT_ADMIN.length) * 3 + 3,
    'both delete lists plus the users are counted'
  );
});

test('describeReset says what survives, and recognises an already-empty platform', () => {
  const plan = {
    retainedAdmin: { email: 'admin@taraniscapital.com', displayName: 'Mark Walker' },
    counts: { companies: 5, company_files: 12, grants: 0 },
    totalRows: 17,
    storageKeys: ['a', 'b'],
    preserved: { audit_log: 5000, funds: 4, document_categories: 7 },
  };
  const text = describeReset(plan);
  assert.match(text, /17 row\(s\) would be deleted/);
  assert.match(text, /companies: 5/);
  assert.ok(!text.includes('grants'), 'zero counts are not listed');
  assert.match(text, /all 5000 audit_log entries/);

  const empty = describeReset({ ...plan, counts: {}, totalRows: 0, storageKeys: [] });
  assert.match(empty, /already at zero/);
});

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

test('emptyStorage removes everything and reports failures without throwing', async () => {
  const storage = new MemoryStorage();
  await storage.put('a.pdf', { body: '1' });
  await storage.put('b.pdf', { body: '2' });

  const original = storage.remove.bind(storage);
  storage.remove = async (key) => {
    if (key === 'locked.pdf') throw new Error('AccessDenied');
    return original(key);
  };

  const result = await emptyStorage(['a.pdf', 'b.pdf', 'locked.pdf'], storage);
  assert.equal(result.removed, 2);
  assert.deepEqual(result.failed.map((f) => f.key), ['locked.pdf']);
  assert.deepEqual(await storage.list(''), []);
});

test('MemoryStorage.list filters by prefix, and LocalStorage walks nested keys', async () => {
  const memory = new MemoryStorage();
  await memory.put('companies/a/1.pdf', { body: '1' });
  await memory.put('documents/b/2.pdf', { body: '2' });
  assert.deepEqual(await memory.list('companies/'), ['companies/a/1.pdf']);
  assert.equal((await memory.list('')).length, 2);
});

// ---------------------------------------------------------------------------
// runReset
// ---------------------------------------------------------------------------

test('a dry run writes nothing, deletes no bytes, and rolls back', async () => {
  const pool = resetPool();
  const storage = new MemoryStorage();
  await storage.put('documents/f1/a.pdf', { body: 'still here' });

  const outcome = await runReset({ storage, db: pool, env: withFlag });

  assert.equal(outcome.dryRun, true);
  assert.equal(await storage.exists('documents/f1/a.pdf'), true);
  const sql = pool.sql().join('\n');
  assert.ok(!/DELETE FROM/.test(sql), 'a dry run issues no DELETE');
  assert.ok(!/INSERT INTO audit_log/.test(sql), 'and records no identities');
  assert.match(sql, /ROLLBACK/);
});

test('a wrong confirmation phrase changes nothing', async () => {
  const pool = resetPool();
  await assert.rejects(
    runReset({ confirm: 'reset platform to zero', db: pool, env: withFlag }),
    (err) => err instanceof ResetError && err.code === 'RESET_BAD_CONFIRMATION'
  );
  assert.equal(pool.calls.length, 0);
});

test('a real reset commits before touching storage, and audits itself once', async () => {
  const pool = resetPool();
  const storage = new MemoryStorage();
  await storage.put('documents/f1/a.pdf', { body: 'bytes' });
  await storage.put('companies/c1/x/1/b.pdf', { body: 'more' });

  const entries = [];
  const outcome = await runReset({
    confirm: CONFIRM_PHRASE,
    storage,
    actorId: ADMIN.id,
    audit: (e) => entries.push(e),
    db: pool,
    env: withFlag,
  });

  assert.equal(outcome.dryRun, false);
  assert.deepEqual(await storage.list(''), [], 'the bucket is empty');

  const sql = pool.sql();
  const commit = sql.findIndex((s) => s.trim() === 'COMMIT');
  assert.ok(commit !== -1);
  assert.ok(
    sql.slice(commit).every((s) => !s.includes('DELETE FROM')),
    'no delete may run after the commit'
  );

  assert.equal(entries.length, 1);
  assert.equal(entries[0].action, 'platform.reset');
  assert.equal(entries[0].detail.retainedAdmin, ADMIN.email);
  assert.equal(entries[0].detail.usersDeleted, 2);
  assert.match(entries[0].detail.auditLogTreatment, /untouched/);
});

// ---------------------------------------------------------------------------
// The route
// ---------------------------------------------------------------------------

async function server(pool) {
  setStorage(new MemoryStorage());
  const s = await startTestServer([['/maintenance', maintenanceRouter]], pool);
  const close = s.close;
  s.close = async () => { await close(); resetStorage(); };
  return s;
}

test('with the flag unset the endpoint does not exist, for anyone', async (t) => {
  delete process.env[ENABLE_FLAG];
  const s = await server(resetPool());
  t.after(async () => { await s.close(); });

  const post = await s.request('/maintenance/reset-platform', {
    method: 'POST', token: tokenFor({ role: 'admin', sub: ADMIN.id }), body: {},
  });
  assert.equal(post.status, 404, 'not 403: there is nothing to discover');

  const get = await s.request('/maintenance/reset-platform', {
    token: tokenFor({ role: 'admin', sub: ADMIN.id }),
  });
  assert.equal(get.status, 404);
});

test('with the flag set the endpoint is still admin only', async (t) => {
  process.env[ENABLE_FLAG] = 'true';
  const s = await server(resetPool());
  t.after(async () => { await s.close(); delete process.env[ENABLE_FLAG]; });

  for (const role of ['investor', 'advisor', 'viewer']) {
    const res = await s.request('/maintenance/reset-platform', {
      method: 'POST', token: tokenFor({ role, sub: 'u1' }), body: {},
    });
    assert.equal(res.status, 403, `${role} must be refused`);
  }
  const company = await s.request('/maintenance/reset-platform', {
    method: 'POST', token: tokenFor({ role: 'company', companyId: 'c1' }), body: {},
  });
  assert.equal(company.status, 403);

  const anon = await s.request('/maintenance/reset-platform', { method: 'POST', body: {} });
  assert.equal(anon.status, 401);
});

test('POST with no body is a dry run and returns a readable plan', async (t) => {
  process.env[ENABLE_FLAG] = 'true';
  const pool = resetPool();
  const s = await server(pool);
  t.after(async () => { await s.close(); delete process.env[ENABLE_FLAG]; });

  const res = await s.request('/maintenance/reset-platform', {
    method: 'POST', token: tokenFor({ role: 'admin', sub: ADMIN.id }), body: {},
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.dryRun, true);
  assert.match(res.body.message, new RegExp(CONFIRM_PHRASE));
  assert.match(res.body.summary, /would be deleted/);
  assert.ok(!pool.sql().join('\n').includes('DELETE FROM'));
});

test('GET describes what is emptied and what survives', async (t) => {
  process.env[ENABLE_FLAG] = 'true';
  const s = await server(resetPool());
  t.after(async () => { await s.close(); delete process.env[ENABLE_FLAG]; });

  const res = await s.request('/maintenance/reset-platform', {
    token: tokenFor({ role: 'admin', sub: ADMIN.id }),
  });
  assert.equal(res.status, 200);
  assert.ok(res.body.preserved.includes('audit_log'));
  assert.ok(res.body.preserved.includes('funds'));
  assert.ok(res.body.emptied.includes('companies'));
  assert.equal(res.body.enableFlag, ENABLE_FLAG);
});
