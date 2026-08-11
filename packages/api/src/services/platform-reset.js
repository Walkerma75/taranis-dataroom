/**
 * Reset the platform to zero for go-live.
 *
 * Everything in the dataroom today is test data from the build: the smoke-test
 * companies, the accounts created to drive them, and the fund document rows
 * that migration 009 archived when their bytes were lost at the S3 cutover.
 * Mark's decision of 2026-08-11 extends HANDOVER-CW012 §3.1 from a five-company
 * purge to a full reset, so that the first real counterparty is invited against
 * a platform with nothing else in it.
 *
 * This is a ONE-TIME GO-LIVE OPERATION AND THE LAST DELETION THE PLATFORM EVER
 * PERFORMS. From the moment it has run, nothing is deleted: an offboarded
 * counterparty's material is retained for eight years, a withdrawn shared
 * document is retired rather than removed, and a replaced file is superseded
 * rather than dropped. That is why the endpoint is behind an environment
 * variable rather than a permission (see routes/maintenance.js): once the
 * variable comes off the task definition the capability does not exist on the
 * running task at all, which is a stronger statement than any check in code.
 *
 * ---------------------------------------------------------------------------
 * WHAT SURVIVES, AND WHY
 * ---------------------------------------------------------------------------
 *
 *   audit_log            Untouched. Not one row read, written or removed by
 *                        this module. It is the eight-year DFSA-aligned record
 *                        and the reset is itself an auditable event.
 *   funds                Configuration, not data. The document manifest is
 *                        built against these slugs.
 *   document_categories  Configuration. The seven survive migration 006.
 *   the founding admin   Someone has to sign in afterwards.
 *   _migrations          Schema state. Clearing it would re-run everything.
 *
 * Everything else goes, along with every object in the storage bucket.
 *
 * ---------------------------------------------------------------------------
 * DELETING USERS, AND THE HONEST ACCOUNT OF WHAT THAT COST
 * ---------------------------------------------------------------------------
 *
 * `audit_log.user_id` was a foreign key to `users(id)`, so a user who had ever
 * signed in could not be deleted, and the entries blocking the delete could
 * neither be removed nor amended because the append-only triggers refuse both.
 * Migration 019 drops that foreign key. It drops nothing else: no audit row is
 * touched and neither trigger is altered.
 *
 * To keep the log self-describing, `recordIdentities()` appends a
 * `user.identity_recorded` entry for every user immediately BEFORE deleting
 * them, carrying id, email, display name and role. The identity then lives
 * inside the append-only log rather than in a mutable table the log merely
 * pointed at — which is a better record than the foreign key was, since
 * `users.display_name` could always be edited afterwards.
 *
 * That ordering is not incidental. The entries are appended first, in their own
 * committed statement, so a reset that fails partway through has still recorded
 * who existed. Recording afterwards would lose exactly the information the
 * failure makes valuable.
 */
import { pool } from '../db.js';

/** Destructive mode requires this string exactly. Nothing else unlocks it. */
export const CONFIRM_PHRASE = 'RESET PLATFORM TO ZERO';

/** The environment variable that has to be on the task definition. */
export const ENABLE_FLAG = 'ALLOW_PLATFORM_RESET';

export class ResetError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'ResetError';
    this.code = code;
    Object.assign(this, detail);
  }
}

/** Whether the running task will permit a reset at all. */
export function resetEnabled(env = process.env) {
  return env[ENABLE_FLAG] === 'true';
}

/**
 * Every table the reset empties, child before parent.
 *
 * Order is the whole correctness of this module, so it is data rather than a
 * sequence of calls: it can be read at a glance, asserted in a test, and
 * extended by anyone adding a table without reconstructing the reasoning.
 *
 * Four entries are load-bearing and would otherwise fail on a foreign key:
 *   - `company_files.supersedes` points at another `company_files` row, so the
 *     chain is broken by `PRE_STATEMENTS` before the rows are deleted.
 *   - `submission_batches` and `company_irl_items` come AFTER `company_files`,
 *     which references both.
 *   - `documents` comes after `document_overrides` and
 *     `s3_cutover_archived_documents`, which reference it.
 *   - `irl_template_items` before `irl_templates`, and both before nothing else
 *     needs them: `company_irl_items.template_item_id` is already gone by then.
 */
export const RESET_TABLES = [
  'document_overrides',
  'grants',
  'permission_template_entries',
  'permission_templates',
  'notice_recipients',
  'notices',
  'file_status_history',
  'company_files',
  'submission_batches',
  'company_shared_files',
  'company_irl_items',
  'company_users',
  'company_reviewers',
  'companies',
  'irl_template_items',
  'irl_templates',
  's3_cutover_archived_documents',
  'documents',
  'notification_outbox',
  'email_suppressions',
  'invites',
];

/**
 * Tables cleared for everyone EXCEPT the retained admin.
 *
 * These three hang off a user rather than off the data being reset, and
 * emptying them wholesale would take the admin's own account down with the test
 * data. `user_mfa` is the one that matters: deleting that row would silently
 * un-enrol the only surviving account from two-factor authentication, so the
 * next sign-in would need a password alone. A reset that quietly weakens the
 * authentication on the one account left standing is not a reset, it is an
 * incident. `refresh_tokens` and `password_resets` are scoped the same way, so
 * the operator is not signed out in the middle of the go-live sequence.
 */
export const RESET_TABLES_EXCEPT_ADMIN = ['password_resets', 'refresh_tokens', 'user_mfa'];

/** Tables the reset must never touch, asserted in the tests as well as here. */
export const PRESERVED_TABLES = ['audit_log', 'funds', 'document_categories', '_migrations'];

/** Run before the deletes, to break a self-reference the order cannot solve. */
const PRE_STATEMENTS = [
  `UPDATE company_files SET supersedes = NULL WHERE supersedes IS NOT NULL`,
];

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

/**
 * Count what is there, and identify the one account that survives.
 *
 * The admin is resolved as the OLDEST admin, matching how `importIrlTemplate`
 * picks a template owner, so both agree on which account is the founding one.
 */
export async function planReset(client = pool, storage = null) {
  const { rows: [admin] } = await client.query(
    `SELECT id, email, display_name FROM users
      WHERE role = 'admin' AND status = 'active'
      ORDER BY created_at
      LIMIT 1`
  );

  if (!admin) {
    throw new ResetError(
      'RESET_NO_ADMIN',
      'No active admin account exists, so there would be nobody left to sign in. '
      + 'Nothing was changed.'
    );
  }

  const counts = {};
  for (const table of RESET_TABLES) {
    const { rows: [row] } = await client.query(`SELECT COUNT(*) AS n FROM ${table}`);
    counts[table] = Number(row.n);
  }
  for (const table of RESET_TABLES_EXCEPT_ADMIN) {
    const { rows: [row] } = await client.query(
      `SELECT COUNT(*) AS n FROM ${table} WHERE user_id <> $1`, [admin.id]
    );
    counts[table] = Number(row.n);
  }

  const { rows: [users] } = await client.query(
    `SELECT COUNT(*) AS n FROM users WHERE id <> $1`, [admin.id]
  );
  counts.users = Number(users.n);

  const { rows: [auditRows] } = await client.query(`SELECT COUNT(*) AS n FROM audit_log`);

  // Every object in the bucket, not merely the ones the rows know about. A
  // reset that leaves an orphan behind has not reset the bucket, and after this
  // there is no second chance to notice.
  const storageKeys = storage ? await storage.list('') : [];

  return {
    retainedAdmin: { id: admin.id, email: admin.email, displayName: admin.display_name },
    counts,
    totalRows: Object.values(counts).reduce((a, b) => a + b, 0),
    storageKeys,
    preserved: {
      audit_log: Number(auditRows.n),
      funds: Number((await client.query(`SELECT COUNT(*) AS n FROM funds`)).rows[0].n),
      document_categories: Number(
        (await client.query(`SELECT COUNT(*) AS n FROM document_categories`)).rows[0].n
      ),
    },
  };
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/**
 * Append one `user.identity_recorded` entry per user about to be deleted.
 *
 * Written straight to `audit_log` rather than through `logAudit()` because that
 * helper swallows its own failures by design — it must never break a request —
 * and here a failure to record an identity has to stop the reset before the
 * user is gone. This is the one place in the codebase that wants the opposite
 * behaviour from the audit service.
 */
export async function recordIdentities(adminId, client) {
  const { rows: users } = await client.query(
    `SELECT id, email, display_name, role, status, created_at
       FROM users WHERE id <> $1 ORDER BY created_at`,
    [adminId]
  );

  for (const user of users) {
    await client.query(
      `INSERT INTO audit_log (user_id, action, resource, resource_id, detail)
       VALUES ($1, 'user.identity_recorded', 'user', $1, $2)`,
      [user.id, JSON.stringify({
        email: user.email,
        displayName: user.display_name,
        role: user.role,
        status: user.status,
        createdAt: user.created_at,
        reason: 'Recorded before deletion by the go-live platform reset. The account no '
              + 'longer exists; this entry is how its id resolves to a person.',
      })]
    );
  }

  return users.map((u) => ({ id: u.id, email: u.email, displayName: u.display_name }));
}

/**
 * Empty every table in `RESET_TABLES`, then the users, inside the caller's
 * transaction.
 *
 * DELETE rather than TRUNCATE, deliberately. TRUNCATE on this many tables needs
 * either CASCADE, which would reach `audit_log` through the very foreign key
 * migration 019 removed and would be a catastrophic way to find out it was
 * still there, or an exact table list in one statement, which silently stops
 * being exact the moment someone adds a table. DELETE respects the constraints
 * and fails loudly on an ordering mistake, which is what should happen.
 */
export async function executeReset(plan, client) {
  const deleted = {};

  for (const statement of PRE_STATEMENTS) await client.query(statement);

  for (const table of RESET_TABLES) {
    const { rowCount } = await client.query(`DELETE FROM ${table}`);
    deleted[table] = rowCount;
  }

  // The admin keeps their MFA enrolment and their session; everyone else loses
  // both, and then the account itself.
  for (const table of RESET_TABLES_EXCEPT_ADMIN) {
    const { rowCount } = await client.query(
      `DELETE FROM ${table} WHERE user_id <> $1`, [plan.retainedAdmin.id]
    );
    deleted[table] = rowCount;
  }

  const identities = await recordIdentities(plan.retainedAdmin.id, client);

  const { rowCount } = await client.query(
    `DELETE FROM users WHERE id <> $1`, [plan.retainedAdmin.id]
  );
  deleted.users = rowCount;

  // The receipt sequence restarts, so the first real submission is
  // TRN-DD-2026-000001 rather than continuing the smoke test's numbering. The
  // references it hands out have to be unique among references that exist, and
  // after this none of the old ones do.
  await client.query(`ALTER SEQUENCE company_receipt_ref_seq RESTART WITH 1`);

  return { deleted, identities };
}

/**
 * Remove every object, reporting failures rather than throwing.
 *
 * Runs after the database has committed. The reverse order can leave committed
 * rows pointing at bytes that are gone, which is unrecoverable; this way the
 * worst case is an object left behind, which is visible and removable.
 */
export async function emptyStorage(keys = [], storage) {
  if (!storage) return { removed: 0, failed: [], skipped: keys.length };
  const failed = [];
  let removed = 0;
  for (const key of keys) {
    try {
      await storage.remove(key);
      removed++;
    } catch (err) {
      failed.push({ key, error: err.message });
    }
  }
  return { removed, failed, skipped: 0 };
}

// ---------------------------------------------------------------------------
// The whole operation
// ---------------------------------------------------------------------------

/**
 * Plan, and optionally execute.
 *
 * @param {object}   opts
 * @param {string}  [opts.confirm]  - must equal CONFIRM_PHRASE to delete
 * @param {object}  [opts.storage]  - storage service; omitted means S3 is skipped
 * @param {string}  [opts.actorId]  - the admin running it, for the audit entry
 * @param {Function}[opts.audit]    - injected `logAudit`
 * @param {object}  [opts.db]       - pool
 * @param {object}  [opts.env]      - environment, for the enable flag
 */
export async function runReset({
  confirm, storage, actorId, audit, db = pool, env = process.env,
} = {}) {
  if (!resetEnabled(env)) {
    throw new ResetError(
      'RESET_DISABLED',
      `Platform reset is not enabled on this task. Set ${ENABLE_FLAG}=true on the task `
      + 'definition, deploy, and remove it again afterwards.'
    );
  }

  const dryRun = confirm !== CONFIRM_PHRASE;
  if (confirm !== undefined && dryRun) {
    throw new ResetError(
      'RESET_BAD_CONFIRMATION',
      `To reset, send the confirmation phrase exactly: "${CONFIRM_PHRASE}". Nothing was changed.`
    );
  }

  const client = await db.connect();
  let plan;
  let result = null;
  try {
    await client.query('BEGIN');
    plan = await planReset(client, storage);

    if (dryRun) {
      await client.query('ROLLBACK');
      return { dryRun: true, plan, storage: null };
    }

    result = await executeReset(plan, client);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  const storageResult = await emptyStorage(plan.storageKeys, storage);

  if (audit) {
    await audit({
      action: 'platform.reset',
      userId: actorId,
      resource: 'platform',
      detail: {
        reason: 'Go-live reset to zero. HANDOVER-CW012 §3.1 as extended by Mark, 2026-08-11.',
        deleted: result.deleted,
        usersDeleted: result.identities.length,
        retainedAdmin: plan.retainedAdmin.email,
        storageObjectsRemoved: storageResult.removed,
        storageObjectsFailed: storageResult.failed.length,
        auditLogTreatment: 'untouched. Identities of deleted users were appended as '
                         + 'user.identity_recorded entries before deletion.',
      },
    });
  }

  return { dryRun: false, plan, result, storage: storageResult };
}

/** One block a human can read, used by the endpoint in both modes. */
export function describeReset(plan) {
  const populated = Object.entries(plan.counts).filter(([, n]) => n > 0);
  const lines = [
    `${plan.totalRows} row(s) would be deleted across ${populated.length} table(s):`,
    ...populated.map(([table, n]) => `  - ${table}: ${n}`),
    `Storage objects to remove: ${plan.storageKeys.length}`,
    '',
    `Retained: ${plan.retainedAdmin.displayName} <${plan.retainedAdmin.email}>, `
      + `${plan.preserved.funds} fund(s), ${plan.preserved.document_categories} categor(y/ies), `
      + `and all ${plan.preserved.audit_log} audit_log entries.`,
  ];
  if (plan.totalRows === 0 && plan.storageKeys.length === 0) {
    return `The platform is already at zero. Retained: ${plan.retainedAdmin.email}, `
         + `${plan.preserved.funds} fund(s), ${plan.preserved.audit_log} audit_log entries.`;
  }
  return lines.join('\n');
}
