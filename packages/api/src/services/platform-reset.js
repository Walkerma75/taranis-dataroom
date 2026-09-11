/**
 * Reset the database to empty for go-live.
 *
 * Everything in the dataroom today is test data from the build, so nothing in
 * it needs preserving — including the audit log, whose entries are all records
 * of test activity. That is what makes this simple. An earlier version of this
 * module emptied the tables one by one in foreign-key order while keeping
 * `audit_log`, and needed a migration to drop the audit foreign key before a
 * user who had ever signed in could be deleted. None of that is necessary when
 * the answer is a new empty database, so none of it is here.
 *
 *   DROP SCHEMA public CASCADE; CREATE SCHEMA public;
 *
 * then the ordinary startup path rebuilds it: `autoMigrate()` runs all nineteen
 * migrations from 001, and the admin is restored. The result is byte for byte
 * the schema a brand new deployment would have, including the append-only
 * triggers and the `audit_log` foreign key to `users`, which is recreated
 * intact by migration 004 and stays that way for the live system.
 *
 * WHY THIS RUNS IN THE CONTAINER. RDS sits in a private subnet and the deploy
 * credential is ECR and ECS only, so nothing on a workstation can reach the
 * database to drop it. The API task can. That is the only reason this is an
 * endpoint at all.
 *
 * WHY THE ADMIN IS CARRIED ACROSS RATHER THAN RESEEDED. `autoSeed()` can create
 * the founding admin, but only from `SEED_ADMIN_PASSWORD`, which is deliberately
 * not referenced at runtime — so reseeding would mean putting a password secret
 * on the task definition and re-enrolling MFA afterwards. Copying the existing
 * row and its MFA enrolment out and back is smaller than that, and leaves the
 * operator signed in with the same credentials and the same authenticator on
 * the other side. `autoSeed()` is still called, and finds the admin already
 * there, so a reset with no admin to carry across still produces one.
 */
import { pool } from '../db.js';
import { autoMigrate, autoSeed } from '../db/bootstrap.js';

/** Destructive mode requires this string exactly. Nothing else unlocks it. */
export const CONFIRM_PHRASE = 'RESET PLATFORM TO ZERO';

/** The environment variable that has to be on the task definition. */
export const ENABLE_FLAG = 'ALLOW_PLATFORM_RESET';

export class ResetError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ResetError';
    this.code = code;
  }
}

/** Whether the running task will permit a reset at all. */
export function resetEnabled(env = process.env) {
  return env[ENABLE_FLAG] === 'true';
}

/**
 * The admin account and its MFA enrolment, read before the drop.
 *
 * The oldest active admin, matching how `importIrlTemplate` picks a template
 * owner, so both agree on which account is the founding one.
 */
export async function captureAdmin(db = pool) {
  const { rows: [admin] } = await db.query(
    `SELECT id, email, display_name, password_hash, role, status, capabilities
       FROM users
      WHERE role = 'admin' AND status = 'active'
      ORDER BY created_at
      LIMIT 1`
  );
  if (!admin) return null;

  const { rows: [mfa] } = await db.query(
    `SELECT m.totp_secret, m.totp_verified, m.recovery_codes, m.enabled_at
       FROM user_mfa m JOIN users u ON u.id = m.user_id
      WHERE u.email = $1`,
    [admin.email]
  );

  return { ...admin, mfa: mfa || null };
}

/**
 * Put the captured admin back into the rebuilt schema.
 *
 * The MFA row goes back too. Without it the one surviving account would be
 * reachable on a password alone, which is not a state to leave a live platform
 * in at the moment it goes live.
 *
 * THE ID IS CARRIED ACROSS, NOT REGENERATED. The operator is holding an access
 * token whose `sub` is that id, and every route resolves the caller by it. A
 * new id would invalidate the token they are running the go-live sequence with,
 * and would make the `platform.reset` audit entry reference a user that does
 * not exist — which the audit foreign key, recreated intact by migration 004,
 * would refuse outright.
 */
export async function restoreAdmin(admin, db = pool) {
  if (!admin) return { restored: false };

  const { rows: [user] } = await db.query(
    `INSERT INTO users (id, email, display_name, password_hash, role, status, capabilities)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (email) DO UPDATE SET display_name = EXCLUDED.display_name
     RETURNING id`,
    [
      admin.id, admin.email, admin.display_name, admin.password_hash,
      admin.role, admin.status, admin.capabilities,
    ]
  );

  if (admin.mfa) {
    await db.query(
      `INSERT INTO user_mfa (user_id, totp_secret, totp_verified, recovery_codes, enabled_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id) DO NOTHING`,
      [
        user.id, admin.mfa.totp_secret, admin.mfa.totp_verified,
        admin.mfa.recovery_codes, admin.mfa.enabled_at,
      ]
    );
  }

  return { restored: true, userId: user.id, mfaRestored: !!admin.mfa };
}

/**
 * Drop the schema, rebuild it, put the admin back.
 *
 * Not wrapped in one transaction, deliberately. `autoMigrate()` runs each
 * migration in its own, and several create types and extensions that do not
 * belong inside an outer transaction with a DROP SCHEMA. The operation is a
 * one-off run by hand against a database whose contents are being discarded, so
 * the failure mode is "run it again", not "recover a half-state".
 */
export async function runReset({
  confirm, actorId, audit, db = pool, env = process.env,
} = {}) {
  if (!resetEnabled(env)) {
    throw new ResetError(
      'RESET_DISABLED',
      `Platform reset is not enabled on this task. Set ${ENABLE_FLAG}=true on the task `
      + 'definition, deploy, and remove it again afterwards.'
    );
  }
  if (confirm !== CONFIRM_PHRASE) {
    throw new ResetError(
      'RESET_BAD_CONFIRMATION',
      `To reset, send the confirmation phrase exactly: "${CONFIRM_PHRASE}". Nothing was changed.`
    );
  }

  const admin = await captureAdmin(db);

  console.warn('[reset] Dropping the public schema. Everything in this database is going.');
  await db.query('DROP SCHEMA public CASCADE');
  await db.query('CREATE SCHEMA public');

  const migrations = await autoMigrate({ db });
  const restored = await restoreAdmin(admin, db);
  // Finds the carried-across admin and does nothing. It is called anyway so a
  // reset on a database that had no admin still produces one, from
  // SEED_ADMIN_PASSWORD, rather than leaving nobody able to sign in.
  const seeded = await autoSeed({ db, env });

  const result = {
    migrationsApplied: migrations.applied,
    adminRestored: restored.restored,
    adminEmail: admin?.email || null,
    mfaRestored: !!restored.mfaRestored,
    adminSeeded: seeded.seeded,
  };

  // After the rebuild, so it lands in the new audit_log rather than one that is
  // about to be dropped. This is the first entry the live platform will hold.
  if (audit) {
    await audit({
      action: 'platform.reset',
      userId: actorId,
      resource: 'platform',
      detail: {
        reason: 'Go-live reset to an empty database. HANDOVER-CW012 §3.1 as extended by '
              + 'Mark, 2026-08-11.',
        ...result,
      },
    });
  }

  return result;
}
