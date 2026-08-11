/**
 * Operator-only maintenance actions.
 *
 * WHY THIS IS AN ENDPOINT AND NOT A SCRIPT. A script would have to reach the
 * database and the bucket, and neither is reachable from anywhere a script
 * could be run: RDS sits in a private subnet, and the deploy credential is ECR
 * and ECS only, with no S3 and no Secrets Manager by design. The only process
 * that holds both is the API task itself. So the work runs where the
 * credentials already are, and the operator drives it over the authenticated
 * admin API, exactly as the IRL seed endpoint does for the same reason.
 *
 * Deliberately NOT a migration: `autoMigrate()` runs on every deploy, and a
 * destructive step must never be something a redeploy repeats by itself.
 *
 * ---------------------------------------------------------------------------
 * THE ENABLE FLAG IS THE REAL GUARD, AND ADMIN-ONLY IS NOT
 * ---------------------------------------------------------------------------
 *
 * The platform reset is a one-time go-live operation. After it, nothing on this
 * platform is ever deleted: that is the eight-year retention position, and an
 * endpoint that could empty the database would contradict it however well it
 * were permissioned. An administrator is exactly who would be able to call it,
 * so a role check is not the control here.
 *
 * So the route only exists when `ALLOW_PLATFORM_RESET=true` is on the task
 * definition. Mark adds it in a task-definition revision, runs the reset,
 * removes it and redeploys — after which the capability is not on the running
 * task at all, which is a stronger statement than any check in code.
 *
 * With the flag unset the route answers 404 rather than 403. There is nothing
 * to discover about a capability that is not there.
 */
import { Router } from 'express';
import { requireAuth, requireRole, rejectCompanyRole } from '../middleware/auth.js';
import { logAudit } from '../services/audit.js';
import { getStorage } from '../services/storage.js';
import {
  runReset, describeReset, resetEnabled, ResetError,
  CONFIRM_PHRASE, ENABLE_FLAG, RESET_TABLES, RESET_TABLES_EXCEPT_ADMIN, PRESERVED_TABLES,
} from '../services/platform-reset.js';

const router = Router();
router.use(requireAuth, rejectCompanyRole, requireRole('admin'));

/** With the flag unset there is no such endpoint, and it does not say why. */
function requireResetEnabled(_req, res, next) {
  if (!resetEnabled()) return res.status(404).json({ error: 'Not found' });
  next();
}

/**
 * POST /maintenance/reset-platform
 *
 *   {}                                     -> dry run, returns the plan, writes nothing
 *   { "confirm": "RESET PLATFORM TO ZERO" } -> executes
 *
 * Empties every table in `RESET_TABLES`, deletes every user but the founding
 * admin, empties the storage bucket, and restarts the receipt sequence.
 * `audit_log`, `funds` and `document_categories` are untouched.
 */
router.post('/reset-platform', requireResetEnabled, async (req, res) => {
  const { confirm } = req.body || {};

  try {
    const storage = await getStorage();
    const outcome = await runReset({
      confirm,
      storage,
      actorId: req.user.sub,
      audit: (entry) => logAudit({ ...entry, ip: req.ip }),
    });

    if (outcome.dryRun) {
      return res.json({
        dryRun: true,
        message: `Nothing was changed. Send {"confirm":"${CONFIRM_PHRASE}"} to carry this out.`,
        summary: describeReset(outcome.plan),
        plan: outcome.plan,
      });
    }

    res.json({
      dryRun: false,
      message: 'Platform reset to zero.',
      retainedAdmin: outcome.plan.retainedAdmin,
      deleted: outcome.result.deleted,
      usersDeleted: outcome.result.identities.length,
      storage: outcome.storage,
      auditLog: 'untouched. Each deleted user was recorded as a user.identity_recorded '
              + 'entry before deletion, and the reset itself as platform.reset.',
      next: `Remove ${ENABLE_FLAG} from the task definition and redeploy. Nothing on this `
          + 'platform is deleted after this point.',
    });
  } catch (err) {
    if (err instanceof ResetError) {
      return res.status(err.code === 'RESET_DISABLED' ? 409 : 400)
        .json({ error: err.message, code: err.code });
    }
    console.error('[maintenance] Reset failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/** What a reset would and would not touch, so it can be checked beforehand. */
router.get('/reset-platform', requireResetEnabled, (_req, res) => {
  res.json({
    confirmPhrase: CONFIRM_PHRASE,
    enableFlag: ENABLE_FLAG,
    emptied: RESET_TABLES
      .concat(RESET_TABLES_EXCEPT_ADMIN.map((t) => `${t} (except the admin's)`))
      .concat('users (all but the founding admin)', 'the storage bucket'),
    preserved: PRESERVED_TABLES.concat(
      "the founding admin account, with its MFA enrolment and session intact"
    ),
    note: 'A one-time go-live operation. Remove the enable flag from the task definition '
        + 'afterwards; nothing on this platform is deleted after that point.',
  });
});

export default router;
