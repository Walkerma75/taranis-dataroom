/**
 * One-off purge of the smoke-test companies created while building Phase 1a and
 * Phase 1b (HANDOVER-CW012 §3.1).
 *
 * This is not a general "delete a company" feature and must never become one.
 * There is deliberately no delete path for a company in this platform: an
 * offboarded counterparty's data is retained for eight years, which is the
 * position in `DD-Portal-Compliance-Positions-DRAFT-06Aug2026.md`. What follows
 * removes SYNTHETIC rows only, and it is constructed so that it cannot remove
 * anything else even if it is called wrongly, twice, or by mistake.
 *
 * THREE GUARDS, ALL OF WHICH MUST HOLD.
 *
 *   1. The target must be named in `PURGE_ALLOWLIST` below, which is compiled
 *      into the build. A company that is not on that list cannot be reached by
 *      this code at all; there is no parameter that widens it. AdrenoMed is not
 *      on the list, so no argument, typo or replayed request can touch it.
 *   2. The company must be `offboarded`. All five targets are. A live
 *      counterparty is refused even if someone adds its name to the list.
 *   3. Destructive mode requires the exact `CONFIRM_PHRASE`. Without it the
 *      caller gets a plan and nothing is written.
 *
 * THE AUDIT LOG IS NOT TOUCHED, AND COULD NOT BE.
 *
 * CW012 §3.1 asked the code side to propose one of three treatments for the
 * audit rows. Two of the three are not executable:
 *
 *   (a) deleting the audit rows      -> `audit_no_delete` (migration 004) raises
 *   (b) nulling their foreign keys   -> `audit_no_update` (migration 004) raises
 *
 * Both triggers fire unconditionally, so either option means dropping or
 * altering the append-only triggers on a live DFSA-aligned table, which the
 * repo CLAUDE.md forbids outright and which is not a thing to normalise inside
 * an operations script. So this takes (c): `audit_log` is left exactly as it is,
 * and one summarising entry (`test_data.purged`) is appended at the end
 * recording what was removed, by whom and when. That is the durable record
 * option (a) was reaching for, obtained by appending rather than by deleting.
 *
 * THE CONSEQUENCE FOR THE TEST USERS, WHICH IS NOT OPTIONAL EITHER.
 *
 * `audit_log.user_id` is a foreign key to `users(id)` with no ON DELETE clause.
 * A user who has ever signed in therefore CANNOT be deleted while their audit
 * rows exist, and their audit rows cannot be removed for the reason above. So a
 * user is deleted where the database permits it and RETIRED in place where it
 * does not: status 'disabled', every membership gone, every refresh token gone,
 * MFA enrolment gone. They cannot sign in, they appear in no company, and the
 * audit entries that name them still resolve to a real person, which is the
 * whole point of keeping the log.
 *
 * The distinction is decided by the database, not guessed here: the delete is
 * attempted inside a SAVEPOINT and a foreign-key violation demotes that user to
 * retirement. That way a reference added by some future migration cannot make
 * this silently wrong; it just moves one more user from deleted to retired.
 *
 * ORDER OF OPERATIONS. The database transaction commits BEFORE any S3 object is
 * removed. The reverse order can leave committed rows pointing at bytes that no
 * longer exist, which is unrecoverable; this order can at worst leave orphaned
 * objects, which are harmless and are reported.
 */
import { pool } from '../db.js';

/**
 * The only companies this code can ever act on.
 *
 * Two ids are known from the smoke test and are matched exactly. The other
 * three are matched on legal name because their ids were never recorded; the
 * name match is exact and case-insensitive, never a prefix or a pattern, so
 * "Pro-curo Software Limited (Holdings)" would not match.
 *
 * `Pro-curo Software Limited` exists as two rows, both offboarded. Both are
 * targets: the entry matches by name and every matching row is planned.
 */
export const PURGE_ALLOWLIST = [
  { legalName: 'Phase 1b Smoke Test Ltd', id: 'e0b49e64-6a14-49d1-89ce-944b03f71448' },
  { legalName: 'ZZZ Smoke Test Ltd', id: 'bfff4b9f-9474-49cc-95cc-729d03b116e7' },
  { legalName: 'WWW Smoke Test Ltd' },
  { legalName: 'Pro-curo Software Limited' },
];

/** Only an offboarded company may be purged, whatever the allowlist says. */
export const PURGEABLE_STATUSES = ['offboarded'];

/** Destructive mode requires this string exactly. Nothing else unlocks it. */
export const CONFIRM_PHRASE = 'PURGE TEST DATA';

/** Raised for anything the caller could have got right. */
export class PurgeError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'PurgeError';
    this.code = code;
    Object.assign(this, detail);
  }
}

const allowedNames = () => PURGE_ALLOWLIST.map((t) => t.legalName.toLowerCase());

/**
 * Whether a company row is a legitimate target. Exported so the test suite
 * asserts the guard itself rather than a caller's use of it.
 */
export function isPurgeable(company) {
  if (!company) return false;
  if (!PURGEABLE_STATUSES.includes(company.status)) return false;

  const name = String(company.legal_name || '').trim().toLowerCase();
  const entry = PURGE_ALLOWLIST.find((t) => t.legalName.toLowerCase() === name);
  if (!entry) return false;

  // When the allowlist pins an id, the name alone is not enough. A second row
  // that happened to carry the same legal name would not be the row we mean.
  if (entry.id && entry.id !== company.id) return false;
  return true;
}

/** Human-readable reason a row was refused, for the plan's `refused` list. */
export function refusalFor(company) {
  const name = String(company?.legal_name || '').trim().toLowerCase();
  const entry = PURGE_ALLOWLIST.find((t) => t.legalName.toLowerCase() === name);
  if (!entry) return 'not on the purge allowlist';
  if (entry.id && entry.id !== company.id) {
    return `on the allowlist by name but the allowlist pins id ${entry.id}`;
  }
  if (!PURGEABLE_STATUSES.includes(company.status)) {
    return `status is '${company.status}', and only ${PURGEABLE_STATUSES.join('/')} may be purged`;
  }
  return 'refused';
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

/**
 * Work out exactly what a purge would remove, touching nothing.
 *
 * The same function produces the dry run and the plan the destructive path
 * executes, so what an operator reviews is what runs. There is no second query
 * set that could disagree with the first.
 */
export async function planPurge(client = pool) {
  const { rows: candidates } = await client.query(
    `SELECT id, legal_name, status, fund_id
       FROM companies
      WHERE lower(trim(legal_name)) = ANY($1::text[])
      ORDER BY legal_name, id`,
    [allowedNames()]
  );

  const companies = candidates.filter(isPurgeable);
  const refused = candidates
    .filter((c) => !isPurgeable(c))
    .map((c) => ({ id: c.id, legalName: c.legal_name, status: c.status, reason: refusalFor(c) }));

  // Every allowlist entry with no row in the database at all. Reported so a
  // re-run reads as "already gone" rather than as a silent success on an empty
  // set. Measured against the candidates rather than the purgeable ones, so a
  // name that IS present but was refused appears under `refused` only, and is
  // never also reported as missing.
  const found = new Set(candidates.map((c) => c.legal_name.trim().toLowerCase()));
  const notFound = PURGE_ALLOWLIST
    .filter((t) => !found.has(t.legalName.toLowerCase()))
    .map((t) => t.legalName);

  const companyIds = companies.map((c) => c.id);

  if (companyIds.length === 0) {
    return {
      companies: [], refused, notFound,
      counts: emptyCounts(), storageKeys: [], users: { deletable: [], retained: [] },
    };
  }

  const counts = {};
  for (const [key, sql] of Object.entries(COUNT_QUERIES)) {
    const { rows: [row] } = await client.query(sql, [companyIds]);
    counts[key] = Number(row?.n || 0);
  }

  // Every S3 object hanging off these companies: their uploads and anything
  // Taranis published into their workspace. Read from the rows rather than from
  // a bucket listing, because the rows are what the platform believes it owns.
  const { rows: keyRows } = await client.query(
    `SELECT s3_key FROM company_files WHERE company_id = ANY($1::uuid[])
      UNION
     SELECT s3_key FROM company_shared_files WHERE company_id = ANY($1::uuid[])`,
    [companyIds]
  );
  const storageKeys = keyRows.map((r) => r.s3_key).filter(Boolean);

  const users = await planUsers(companyIds, client);
  counts.users_deletable = users.deletable.length;
  counts.users_retained = users.retained.length;

  // Outbox rows are matched on recipient, because `notification_outbox` carries
  // no company column: it is keyed by who a message was addressed to. Only the
  // addresses of users this purge is removing are matched, so a message sent to
  // a Taranis admin about a test company is left alone rather than guessed at.
  const emails = [...users.deletable, ...users.retained].map((u) => u.email);
  counts.notification_outbox = emails.length
    ? Number((await client.query(
        `SELECT COUNT(*) AS n FROM notification_outbox WHERE lower(recipient) = ANY($1::text[])`,
        [emails]
      )).rows[0].n)
    : 0;
  counts.invites = emails.length
    ? Number((await client.query(
        `SELECT COUNT(*) AS n FROM invites WHERE lower(email) = ANY($1::text[])`,
        [emails]
      )).rows[0].n)
    : 0;

  return {
    companies: companies.map((c) => ({ id: c.id, legalName: c.legal_name, status: c.status })),
    refused,
    notFound,
    counts,
    storageKeys,
    users,
  };
}

function emptyCounts() {
  const zeroed = {};
  for (const key of Object.keys(COUNT_QUERIES)) zeroed[key] = 0;
  return {
    ...zeroed,
    users_deletable: 0, users_retained: 0, notification_outbox: 0, invites: 0,
  };
}

/** One count per dependent table, all keyed on the company ids. */
const COUNT_QUERIES = {
  company_users: `SELECT COUNT(*) AS n FROM company_users WHERE company_id = ANY($1::uuid[])`,
  company_reviewers: `SELECT COUNT(*) AS n FROM company_reviewers WHERE company_id = ANY($1::uuid[])`,
  company_irl_items: `SELECT COUNT(*) AS n FROM company_irl_items WHERE company_id = ANY($1::uuid[])`,
  company_files: `SELECT COUNT(*) AS n FROM company_files WHERE company_id = ANY($1::uuid[])`,
  company_shared_files: `SELECT COUNT(*) AS n FROM company_shared_files WHERE company_id = ANY($1::uuid[])`,
  submission_batches: `SELECT COUNT(*) AS n FROM submission_batches WHERE company_id = ANY($1::uuid[])`,
  file_status_history: `SELECT COUNT(*) AS n FROM file_status_history h
                          JOIN company_files f ON f.id = h.file_id
                         WHERE f.company_id = ANY($1::uuid[])`,
};

/**
 * The users this purge is responsible for: role 'company', and members of the
 * targeted companies ONLY.
 *
 * The `NOT EXISTS` is the important half. A person who also belongs to a real
 * counterparty is left completely alone: not deleted, not disabled, not touched.
 * Belonging to a test company is not grounds for removing someone's access to a
 * live workspace.
 *
 * `hasAuditRows` is reported so the dry run can explain, per user, why one is
 * deleted and another retired.
 */
export async function planUsers(companyIds, client = pool) {
  const { rows } = await client.query(
    `SELECT u.id, u.email, u.display_name, u.status,
            EXISTS (SELECT 1 FROM audit_log al WHERE al.user_id = u.id) AS has_audit_rows
       FROM users u
      WHERE u.role = 'company'
        AND EXISTS (
              SELECT 1 FROM company_users cu
               WHERE cu.user_id = u.id AND cu.company_id = ANY($1::uuid[])
            )
        AND NOT EXISTS (
              SELECT 1 FROM company_users cu
               WHERE cu.user_id = u.id AND NOT (cu.company_id = ANY($1::uuid[]))
            )
      ORDER BY u.email`,
    [companyIds]
  );

  const deletable = [];
  const retained = [];
  for (const u of rows) {
    const entry = {
      id: u.id,
      email: String(u.email).toLowerCase(),
      displayName: u.display_name,
      status: u.status,
      hasAuditRows: u.has_audit_rows,
    };
    // The plan's expectation only. The database has the final say at execution
    // time, inside a savepoint, because other references may exist.
    if (u.has_audit_rows) {
      retained.push({ ...entry, reason: 'named by audit_log entries, which are append-only' });
    } else {
      deletable.push(entry);
    }
  }
  return { deletable, retained };
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/**
 * Delete the planned rows. Runs inside the caller's transaction; `runPurge`
 * supplies one.
 *
 * Order is child-before-parent throughout. Two orderings are load-bearing and
 * would otherwise fail on a foreign key:
 *
 *   - `company_files.supersedes` points at another `company_files` row, so the
 *     chain is broken with an UPDATE before the DELETE. Deleting a version and
 *     its successor in one statement is order-dependent and would fail roughly
 *     half the time, which is the worst kind of bug to ship in a purge.
 *   - `company_files.batch_id` points at `submission_batches`, and
 *     `company_files.irl_item_id` at `company_irl_items`, so both parents go
 *     after the files rather than before.
 */
export async function executePurge(plan, client) {
  const companyIds = plan.companies.map((c) => c.id);
  if (companyIds.length === 0) return { deleted: emptyCounts(), retiredUserIds: [], deletedUserIds: [] };

  const deleted = emptyCounts();
  const del = async (key, sql, params = [companyIds]) => {
    const { rowCount } = await client.query(sql, params);
    deleted[key] = rowCount;
    return rowCount;
  };

  await del('file_status_history',
    `DELETE FROM file_status_history h
      USING company_files f
      WHERE h.file_id = f.id AND f.company_id = ANY($1::uuid[])`);

  // Break the version chain before removing the rows it links.
  await client.query(
    `UPDATE company_files SET supersedes = NULL WHERE company_id = ANY($1::uuid[])`,
    [companyIds]
  );

  await del('company_files', `DELETE FROM company_files WHERE company_id = ANY($1::uuid[])`);
  await del('submission_batches', `DELETE FROM submission_batches WHERE company_id = ANY($1::uuid[])`);
  await del('company_shared_files', `DELETE FROM company_shared_files WHERE company_id = ANY($1::uuid[])`);
  await del('company_irl_items', `DELETE FROM company_irl_items WHERE company_id = ANY($1::uuid[])`);
  await del('company_users', `DELETE FROM company_users WHERE company_id = ANY($1::uuid[])`);
  await del('company_reviewers', `DELETE FROM company_reviewers WHERE company_id = ANY($1::uuid[])`);

  const emails = [...plan.users.deletable, ...plan.users.retained].map((u) => u.email);
  if (emails.length) {
    await del('notification_outbox',
      `DELETE FROM notification_outbox WHERE lower(recipient) = ANY($1::text[])`, [emails]);
    await del('invites',
      `DELETE FROM invites WHERE lower(email) = ANY($1::text[])`, [emails]);
  }

  const { deletedUserIds, retiredUserIds } = await removeUsers(plan.users, client);
  deleted.users_deletable = deletedUserIds.length;
  deleted.users_retained = retiredUserIds.length;

  // Last, now that nothing references them.
  await del('companies', `DELETE FROM companies WHERE id = ANY($1::uuid[])`);

  return { deleted, deletedUserIds, retiredUserIds };
}

/**
 * Remove the test users, falling back to retirement in place.
 *
 * Every user is attempted as a DELETE inside a savepoint. A foreign-key
 * violation means something append-only still names them (in practice
 * `audit_log`), so the savepoint is rolled back and the account is disabled
 * instead. Letting the database decide means a reference introduced by a later
 * migration cannot make this quietly incorrect.
 */
export async function removeUsers(users, client) {
  const deletedUserIds = [];
  const retiredUserIds = [];

  for (const user of [...users.deletable, ...users.retained]) {
    // These two cascade on user delete but not on retirement, and a retired
    // account must not keep a live session or a usable second factor.
    await client.query(`DELETE FROM refresh_tokens WHERE user_id = $1`, [user.id]);
    await client.query(`DELETE FROM user_mfa WHERE user_id = $1`, [user.id]);
    await client.query(`DELETE FROM password_resets WHERE user_id = $1`, [user.id]);

    await client.query('SAVEPOINT purge_user');
    try {
      await client.query(`DELETE FROM users WHERE id = $1`, [user.id]);
      await client.query('RELEASE SAVEPOINT purge_user');
      deletedUserIds.push(user.id);
    } catch (err) {
      await client.query('ROLLBACK TO SAVEPOINT purge_user');
      await client.query('RELEASE SAVEPOINT purge_user');
      if (err.code && err.code !== '23503') throw err; // anything but a FK violation is real
      await client.query(
        `UPDATE users SET status = 'disabled', updated_at = NOW() WHERE id = $1`,
        [user.id]
      );
      retiredUserIds.push(user.id);
    }
  }

  return { deletedUserIds, retiredUserIds };
}

// ---------------------------------------------------------------------------
// The whole operation
// ---------------------------------------------------------------------------

/**
 * Plan, and optionally execute.
 *
 * Without `confirm` this is read-only and returns the plan. With the exact
 * confirmation phrase it opens one transaction, deletes, commits, and only then
 * removes the S3 objects.
 *
 * @param {object}   opts
 * @param {string}  [opts.confirm]   - must equal CONFIRM_PHRASE to delete
 * @param {object}  [opts.storage]   - storage service; omitted means S3 is skipped
 * @param {string}  [opts.actorId]   - the admin running it, for the audit entry
 * @param {Function}[opts.audit]     - injected `logAudit`
 * @param {object}  [opts.db]        - pool
 */
export async function runPurge({ confirm, storage, actorId, audit, db = pool } = {}) {
  const dryRun = confirm !== CONFIRM_PHRASE;

  if (confirm !== undefined && dryRun) {
    throw new PurgeError(
      'PURGE_BAD_CONFIRMATION',
      `To purge, send the confirmation phrase exactly: "${CONFIRM_PHRASE}". Nothing was changed.`
    );
  }

  const client = await db.connect();
  let plan;
  let result = null;
  try {
    await client.query('BEGIN');
    plan = await planPurge(client);

    if (dryRun) {
      // A read-only plan still ran inside a transaction; end it explicitly
      // rather than leaving an idle one holding a pool connection.
      await client.query('ROLLBACK');
      return { dryRun: true, plan, storage: null };
    }

    result = await executePurge(plan, client);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // After the commit, never before: rows pointing at bytes that are already
  // gone cannot be undone, whereas an object left behind can be removed later.
  const storageResult = await removeObjects(plan.storageKeys, storage);

  if (audit) {
    await audit({
      action: 'test_data.purged',
      userId: actorId,
      resource: 'company',
      // No single resource id: this covers several companies, which the detail
      // names in full.
      detail: {
        reason: 'HANDOVER-CW012 §3.1 smoke-test data purge',
        companies: plan.companies,
        deleted: result.deleted,
        usersDeleted: result.deletedUserIds.length,
        usersRetiredInPlace: result.retiredUserIds.length,
        storageObjectsRemoved: storageResult.removed,
        storageObjectsFailed: storageResult.failed.length,
        auditLogTreatment: 'untouched; append-only, see services/test-data-purge.js',
      },
    });
  }

  return { dryRun: false, plan, result, storage: storageResult };
}

/**
 * Remove the objects, reporting rather than throwing.
 *
 * A failed object delete must not look like a failed purge: the rows are
 * already gone and committed, and re-running would find nothing to do. The
 * failures are returned so an operator can see exactly which keys are orphaned.
 */
export async function removeObjects(keys = [], storage) {
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

/** One block a human can read, used by the CLI and the endpoint alike. */
export function describePlan(plan) {
  if (plan.companies.length === 0) {
    return 'Nothing to purge: no allowlisted company is present in this database.';
  }
  const lines = [
    `${plan.companies.length} compan${plan.companies.length === 1 ? 'y' : 'ies'} to purge:`,
    ...plan.companies.map((c) => `  - ${c.legalName} (${c.id}, ${c.status})`),
    'Dependent rows:',
    ...Object.entries(plan.counts)
      .filter(([, n]) => n > 0)
      .map(([table, n]) => `  - ${table}: ${n}`),
    `Storage objects: ${plan.storageKeys.length}`,
  ];
  if (plan.users.deletable.length) {
    lines.push('Users to delete:',
      ...plan.users.deletable.map((u) => `  - ${u.email} (${u.displayName})`));
  }
  if (plan.users.retained.length) {
    lines.push('Users to retire in place, disabled and unable to sign in:',
      ...plan.users.retained.map((u) => `  - ${u.email} (${u.displayName}): ${u.reason}`));
  }
  if (plan.refused.length) {
    lines.push('Refused:',
      ...plan.refused.map((c) => `  - ${c.legalName} (${c.id}): ${c.reason}`));
  }
  if (plan.notFound.length) {
    lines.push(`Allowlisted but not present: ${plan.notFound.join(', ')}`);
  }
  return lines.join('\n');
}
