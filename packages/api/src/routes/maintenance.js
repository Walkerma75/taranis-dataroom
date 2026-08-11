/**
 * Operator-only maintenance actions.
 *
 * WHY THIS IS AN ENDPOINT AND NOT A SCRIPT. RDS sits in a private subnet and
 * the deploy credential is ECR and ECS only, so nothing on a workstation can
 * reach the database to drop it. The API task can. That is the only reason the
 * go-live reset is reachable over HTTP at all — the work itself is two SQL
 * statements and the ordinary startup path.
 *
 * Deliberately NOT a migration: `autoMigrate()` runs on every deploy, and a
 * destructive step must never be something a redeploy repeats by itself.
 *
 * THE ENABLE FLAG IS THE GUARD, AND ADMIN-ONLY IS NOT. An administrator is
 * exactly who would call this, so a role check is not the control. The route
 * only exists when `ALLOW_PLATFORM_RESET=true` is on the task definition: Mark
 * adds it in a revision, runs the reset, removes it and redeploys, after which
 * the capability is not on the running task at all. With the flag unset the
 * route answers 404 rather than 403 — there is nothing to discover about a
 * capability that is not there.
 */
import { Router } from 'express';
import { requireAuth, requireRole, rejectCompanyRole } from '../middleware/auth.js';
import { logAudit } from '../services/audit.js';
import {
  runReset, resetEnabled, ResetError, CONFIRM_PHRASE, ENABLE_FLAG,
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
 *   { "confirm": "RESET PLATFORM TO ZERO" }
 *
 * Drops the public schema, re-runs every migration, and puts the admin account
 * back with its MFA enrolment and its id intact. The result is the schema a
 * brand new deployment would have.
 *
 * There is no dry run, because there is nothing to plan: it empties the
 * database. The confirmation phrase is the whole of the confirmation step.
 */
router.post('/reset-platform', requireResetEnabled, async (req, res) => {
  try {
    const result = await runReset({
      confirm: (req.body || {}).confirm,
      actorId: req.user.sub,
      audit: (entry) => logAudit({ ...entry, ip: req.ip }),
    });

    res.json({
      message: 'Database reset to empty and rebuilt.',
      ...result,
      storage: 'NOT touched. Empty the S3 bucket separately, in the console.',
      next: [
        'Empty the documents bucket if you have not already.',
        'Seed the IRL template for the fund, or no company can be activated.',
        `Remove ${ENABLE_FLAG} from the task definition and redeploy.`,
      ],
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

/** What a reset does, so it can be read before it is run. */
router.get('/reset-platform', requireResetEnabled, (_req, res) => {
  res.json({
    confirmPhrase: CONFIRM_PHRASE,
    enableFlag: ENABLE_FLAG,
    effect: 'DROP SCHEMA public CASCADE, then re-run every migration from 001. Every table, '
          + 'row and type in this database goes, including audit_log. The admin account is '
          + 'carried across with its id, password and MFA enrolment.',
    notCovered: 'The S3 bucket. Empty it separately.',
    note: 'A one-time go-live operation. Remove the enable flag from the task definition '
        + 'afterwards; nothing on this platform is deleted after that point.',
  });
});

export default router;
