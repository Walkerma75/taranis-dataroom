/**
 * The go-live reset (HANDOVER-C012 §2).
 *
 * The work itself is two SQL statements and the ordinary startup path, so what
 * is worth testing is everything around it: that it cannot run without the
 * enable flag or the exact phrase, that the admin comes back with the same id
 * and the same MFA enrolment, and that the schema is rebuilt rather than merely
 * dropped.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CONFIRM_PHRASE, ENABLE_FLAG, ResetError,
  resetEnabled, captureAdmin, restoreAdmin, runReset,
} from '../src/services/platform-reset.js';
import maintenanceRouter from '../src/routes/maintenance.js';
import { fakePool, startTestServer, tokenFor } from './helpers/test-app.js';

const ADMIN = {
  id: 'admin-1',
  email: 'admin@taraniscapital.com',
  display_name: 'Mark Walker',
  password_hash: '$argon2id$fake',
  role: 'admin',
  status: 'active',
  capabilities: { canManageUsers: true },
};

const MFA = {
  totp_secret: 'JBSWY3DPEHPK3PXP',
  totp_verified: true,
  recovery_codes: ['a', 'b'],
  enabled_at: '2026-04-08',
};

const withFlag = { [ENABLE_FLAG]: 'true' };

/** A pool that answers the capture queries and records every statement. */
function resetPool({ admin = ADMIN, mfa = MFA } = {}) {
  return fakePool([
    ["FROM users\n      WHERE role = 'admin'", admin ? [admin] : []],
    ['FROM user_mfa m JOIN users u', mfa ? [mfa] : []],
    ['SELECT name FROM _migrations', []],
    ['INSERT INTO users (id, email', [{ id: admin?.id }]],
    ["SELECT id FROM users WHERE email = 'admin@taraniscapital.com'", [{ id: admin?.id }]],
  ]);
}

// ---------------------------------------------------------------------------
// The two guards
// ---------------------------------------------------------------------------

test('the reset is off unless the flag is exactly "true"', () => {
  assert.equal(resetEnabled({}), false);
  assert.equal(resetEnabled({ [ENABLE_FLAG]: 'false' }), false);
  assert.equal(resetEnabled({ [ENABLE_FLAG]: '1' }), false, 'a truthy string is not enough');
  assert.equal(resetEnabled({ [ENABLE_FLAG]: 'TRUE' }), false, 'and it is case sensitive');
  assert.equal(resetEnabled(withFlag), true);
});

test('without the flag nothing is read, let alone dropped', async () => {
  const pool = resetPool();
  await assert.rejects(
    runReset({ confirm: CONFIRM_PHRASE, db: pool, env: {} }),
    (err) => err instanceof ResetError && err.code === 'RESET_DISABLED'
  );
  assert.equal(pool.calls.length, 0);
});

test('a wrong or missing confirmation phrase changes nothing', async () => {
  for (const confirm of [undefined, '', 'reset platform to zero', 'yes']) {
    const pool = resetPool();
    await assert.rejects(
      runReset({ confirm, db: pool, env: withFlag }),
      (err) => err instanceof ResetError && err.code === 'RESET_BAD_CONFIRMATION',
      `"${confirm}" must be refused`
    );
    assert.equal(pool.calls.length, 0, 'and must not read the database first');
  }
});

// ---------------------------------------------------------------------------
// The admin round trip
// ---------------------------------------------------------------------------

test('captureAdmin takes the oldest active admin and its MFA enrolment', async () => {
  const pool = resetPool();
  const admin = await captureAdmin(pool);

  assert.equal(admin.email, ADMIN.email);
  assert.equal(admin.mfa.totp_secret, MFA.totp_secret);

  const query = pool.calls[0].text;
  assert.match(query, /ORDER BY created_at/, 'the founding admin, not an arbitrary one');
  assert.match(query, /status = 'active'/);
});

test('captureAdmin copes with an admin who never enrolled in MFA', async () => {
  const admin = await captureAdmin(resetPool({ mfa: null }));
  assert.equal(admin.mfa, null);
});

test('captureAdmin returns null when there is no admin at all', async () => {
  assert.equal(await captureAdmin(resetPool({ admin: null })), null);
});

test('restoreAdmin puts the same id back, so the operator keeps their session', async () => {
  const pool = resetPool();
  const result = await restoreAdmin({ ...ADMIN, mfa: MFA }, pool);

  assert.equal(result.restored, true);
  assert.equal(result.mfaRestored, true);

  const insert = pool.calls.find((c) => c.text.includes('INSERT INTO users (id, email'));
  assert.equal(insert.params[0], ADMIN.id, 'the id is carried across, not regenerated');
  assert.equal(insert.params[3], ADMIN.password_hash, 'and so is the password');

  // Without this the one surviving account is reachable on a password alone.
  const mfa = pool.calls.find((c) => c.text.includes('INSERT INTO user_mfa'));
  assert.ok(mfa, 'the MFA enrolment must be restored');
  assert.equal(mfa.params[1], MFA.totp_secret);
  assert.equal(mfa.params[2], true);
});

test('restoreAdmin skips the MFA row when there was not one', async () => {
  const pool = resetPool();
  await restoreAdmin({ ...ADMIN, mfa: null }, pool);
  assert.ok(!pool.sql().some((s) => s.includes('INSERT INTO user_mfa')));
});

test('restoreAdmin on a null admin is a no-op rather than a crash', async () => {
  const pool = resetPool();
  assert.deepEqual(await restoreAdmin(null, pool), { restored: false });
  assert.equal(pool.calls.length, 0);
});

// ---------------------------------------------------------------------------
// The reset itself
// ---------------------------------------------------------------------------

test('a reset drops the schema, recreates it, and re-runs the migrations', async () => {
  const pool = resetPool();
  const result = await runReset({
    confirm: CONFIRM_PHRASE, actorId: ADMIN.id, db: pool, env: withFlag,
  });

  const sql = pool.sql();
  const at = (fragment) => sql.findIndex((s) => s.includes(fragment));

  assert.ok(at("FROM users\n      WHERE role = 'admin'") < at('DROP SCHEMA public CASCADE'),
    'the admin is captured BEFORE the drop, or there is nothing to put back');
  assert.ok(at('DROP SCHEMA public CASCADE') < at('CREATE SCHEMA public'));
  assert.ok(at('CREATE SCHEMA public') < at('CREATE TABLE IF NOT EXISTS _migrations'),
    'the migration bookkeeping is rebuilt after the drop, not before');
  assert.ok(at('CREATE TABLE IF NOT EXISTS _migrations') < at('INSERT INTO users (id, email'),
    'the schema exists before the admin goes back into it');

  assert.equal(result.adminRestored, true);
  assert.equal(result.mfaRestored, true);
  assert.equal(result.adminEmail, ADMIN.email);
  assert.ok(result.migrationsApplied > 0, 'every migration re-runs against an empty schema');
});

test('the reset applies every migration on disk, not a subset', async () => {
  const pool = resetPool();
  const result = await runReset({
    confirm: CONFIRM_PHRASE, db: pool, env: withFlag,
  });

  // _migrations comes back empty from the fake, so the count is the full set.
  const applied = pool.sql().filter((s) => s.includes('INSERT INTO _migrations')).length;
  assert.equal(applied, result.migrationsApplied);
  assert.ok(applied >= 18, `expected the whole migration set, got ${applied}`);
});

test('the audit entry is written after the rebuild, into the new audit_log', async () => {
  const pool = resetPool();
  const entries = [];
  await runReset({
    confirm: CONFIRM_PHRASE,
    actorId: ADMIN.id,
    audit: (e) => entries.push(e),
    db: pool,
    env: withFlag,
  });

  assert.equal(entries.length, 1);
  assert.equal(entries[0].action, 'platform.reset');
  // The actor id survived the reset, so this entry resolves to a real user row
  // and does not violate the audit foreign key that migration 004 recreated.
  assert.equal(entries[0].userId, ADMIN.id);
  assert.equal(entries[0].detail.adminEmail, ADMIN.email);
});

test('a reset with no admin to carry across still seeds one', async () => {
  const pool = fakePool([
    ["FROM users\n      WHERE role = 'admin'", []],
    ['SELECT name FROM _migrations', []],
    ["SELECT id FROM users WHERE email = 'admin@taraniscapital.com'", []],
  ]);

  const result = await runReset({
    confirm: CONFIRM_PHRASE,
    db: pool,
    env: { ...withFlag, SEED_ADMIN_PASSWORD: 'not-a-real-password' },
  });

  assert.equal(result.adminRestored, false);
  assert.equal(result.adminSeeded, true, 'autoSeed is the fallback, so nobody is locked out');
});

// ---------------------------------------------------------------------------
// The route
// ---------------------------------------------------------------------------

test('with the flag unset the endpoint does not exist, for anyone', async (t) => {
  delete process.env[ENABLE_FLAG];
  const s = await startTestServer([['/maintenance', maintenanceRouter]], resetPool());
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
  const s = await startTestServer([['/maintenance', maintenanceRouter]], resetPool());
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

test('an admin POST with no confirmation is a 400 and drops nothing', async (t) => {
  process.env[ENABLE_FLAG] = 'true';
  const pool = resetPool();
  const s = await startTestServer([['/maintenance', maintenanceRouter]], pool);
  t.after(async () => { await s.close(); delete process.env[ENABLE_FLAG]; });

  const res = await s.request('/maintenance/reset-platform', {
    method: 'POST', token: tokenFor({ role: 'admin', sub: ADMIN.id }), body: {},
  });

  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'RESET_BAD_CONFIRMATION');
  assert.ok(!pool.sql().some((s) => s.includes('DROP SCHEMA')));
});

test('GET says plainly what it does and what it does not cover', async (t) => {
  process.env[ENABLE_FLAG] = 'true';
  const s = await startTestServer([['/maintenance', maintenanceRouter]], resetPool());
  t.after(async () => { await s.close(); delete process.env[ENABLE_FLAG]; });

  const res = await s.request('/maintenance/reset-platform', {
    token: tokenFor({ role: 'admin', sub: ADMIN.id }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.confirmPhrase, CONFIRM_PHRASE);
  assert.match(res.body.effect, /DROP SCHEMA public CASCADE/);
  assert.match(res.body.effect, /including audit_log/);
  assert.match(res.body.notCovered, /S3 bucket/);
});
