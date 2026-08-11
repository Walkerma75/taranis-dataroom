/**
 * Operator-only maintenance actions.
 *
 * WHY THIS IS AN ENDPOINT AND NOT A SCRIPT. CW012 §3.1 asked for "a guarded
 * script or admin-only endpoint". A script would have to reach the database and
 * the bucket, and neither is reachable from anywhere a script could be run: RDS
 * sits in a private subnet, and the deploy credential is ECR and ECS only, with
 * no S3 and no Secrets Manager by design. The only process that holds both is
 * the API task itself. So the work runs where the credentials already are, and
 * the operator drives it over the authenticated admin API, exactly as the IRL
 * seed endpoint does for the same reason.
 *
 * Deliberately NOT a migration: `autoMigrate()` runs on every deploy, and a
 * destructive step must never be something a redeploy repeats by itself.
 */
import { Router } from 'express';
import { requireAuth, requireRole, rejectCompanyRole } from '../middleware/auth.js';
import { logAudit } from '../services/audit.js';
import { getStorage } from '../services/storage.js';
import {
  runPurge, describePlan, PurgeError, CONFIRM_PHRASE, PURGE_ALLOWLIST,
} from '../services/test-data-purge.js';

const router = Router();
router.use(requireAuth, rejectCompanyRole, requireRole('admin'));

/**
 * POST /maintenance/purge-test-data
 *
 *   {}                              -> dry run, returns the plan, writes nothing
 *   { "confirm": "PURGE TEST DATA" } -> executes
 *
 * The endpoint can only ever affect the companies compiled into
 * `PURGE_ALLOWLIST`, and only while they are offboarded. It takes no company id
 * and no filter: there is no argument that widens what it touches, which is why
 * it is safe to leave deployed after it has been run. Once the rows are gone it
 * is a no-op for ever.
 */
router.post('/purge-test-data', async (req, res) => {
  const { confirm } = req.body || {};

  try {
    const storage = await getStorage();
    const outcome = await runPurge({
      confirm,
      storage,
      actorId: req.user.sub,
      audit: (entry) => logAudit({ ...entry, ip: req.ip }),
    });

    if (outcome.dryRun) {
      return res.json({
        dryRun: true,
        message: `Nothing was changed. Send {"confirm":"${CONFIRM_PHRASE}"} to carry this out.`,
        summary: describePlan(outcome.plan),
        plan: outcome.plan,
      });
    }

    res.json({
      dryRun: false,
      message: 'Test data purged.',
      companies: outcome.plan.companies,
      deleted: outcome.result.deleted,
      usersDeleted: outcome.result.deletedUserIds.length,
      usersRetiredInPlace: outcome.result.retiredUserIds.length,
      storage: outcome.storage,
      // Said in the response as well as in the code, because it is the question
      // anyone reviewing this will ask first.
      auditLog: 'untouched. One summarising test_data.purged entry was appended.',
    });
  } catch (err) {
    if (err instanceof PurgeError) {
      return res.status(400).json({ error: err.message, code: err.code });
    }
    console.error('[maintenance] Purge failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/** What the purge is permitted to touch, so an operator can check before running. */
router.get('/purge-test-data', (_req, res) => {
  res.json({
    confirmPhrase: CONFIRM_PHRASE,
    allowlist: PURGE_ALLOWLIST,
    note: 'Only these companies, and only while offboarded. The list is compiled in '
        + 'and cannot be widened by a request.',
  });
});

export default router;
