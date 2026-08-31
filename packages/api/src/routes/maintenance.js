/**
 * Operator-only maintenance actions: the go-live reset, and the email
 * diagnostics that answer "what happened to the message we sent this person".
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
import { emailStatusFor, release } from '../services/notifications.js';
import { getSesSuppression } from '../services/email.js';
import {
  runReset, resetEnabled, ResetError, CONFIRM_PHRASE, ENABLE_FLAG,
} from '../services/platform-reset.js';
import {
  report as irlTextReport, quarantine as irlTextQuarantine, describeFinding,
} from '../services/irl-text-audit.js';

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

// ---------------------------------------------------------------------------
// Email diagnostics
//
// NOT behind the reset flag. That flag guards a one-time destructive operation
// and is meant to be absent from the running task; these two are read-only and
// reversible and have to work on an ordinary day, which is the day someone asks
// why a counterparty never received their invitation.
// ---------------------------------------------------------------------------

/**
 * GET /maintenance/email-status?email=someone@example.com
 *
 * What happened to email for one address: every outbox row with its status,
 * attempts and last error, the app's suppression rows, and SES's own
 * account-level verdict.
 *
 * This is the minimum answer to "the invitation never arrived", and before it
 * existed the answer required psql against an instance in a private subnet.
 * A suppressed send is recorded and then shown to nobody, so an administrator
 * resending an invitation is told it worked either way (HANDOVER-CW015 §3.4).
 */
router.get('/email-status', async (req, res) => {
  const email = String(req.query.email || '').trim().toLowerCase();
  if (!email) return res.status(400).json({ error: 'An email address is required.' });

  try {
    const status = await emailStatusFor(email);
    const sesSuppression = await getSesSuppression(email);

    await logAudit({
      action: 'maintenance.email_status',
      userId: req.user.sub,
      detail: { email },
      ip: req.ip,
    });

    res.json({ ...status, sesSuppression });
  } catch (err) {
    console.error('[maintenance] Email status failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /maintenance/email-suppressions/release
 *   { "email": "...", "reason": "why" }
 *
 * Lift the APP-LEVEL suppression. The row is not deleted — `released_at`,
 * `released_by` and the reason are written and the original event stays on
 * record, which is what migration 018 asks for and what lets a counterparty
 * disputing a suppression be answered later.
 *
 * SES's account-level list is separate and is NOT touched here. Clearing that
 * one is `aws sesv2 delete-suppressed-destination`, deliberately left as a
 * console/CLI action: it is an account-wide change made with a credential this
 * task does not hold.
 */
router.post('/email-suppressions/release', async (req, res) => {
  const { email, reason } = req.body || {};
  const address = String(email || '').trim().toLowerCase();
  if (!address) return res.status(400).json({ error: 'An email address is required.' });

  try {
    const released = await release({ email: address, releasedBy: req.user.sub, reason: reason || null });

    await logAudit({
      action: 'maintenance.suppression_released',
      userId: req.user.sub,
      detail: { email: address, reason: reason || null, released },
      ip: req.ip,
    });

    res.json({
      email: address,
      released,
      message: released
        ? 'App-level suppression lifted. The row is kept, marked released.'
        : 'No live app-level suppression for that address; nothing to lift.',
      note: 'SES keeps its own account-level suppression list. Check it separately: '
          + 'aws sesv2 get-suppressed-destination --email-address <address> '
          + '(and delete-suppressed-destination to clear it).',
    });
  } catch (err) {
    console.error('[maintenance] Suppression release failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /maintenance/irl-text-audit
 *
 * Every stored `already_held` or `note_for_company` carrying a CASS score or an
 * internal source (HANDOVER-CW019 §3.5). Read-only, so it is safe to run at any
 * time and is the check to run after loading per-company pre-filled text.
 *
 * NOT behind `ALLOW_PLATFORM_RESET`. That flag guards a destructive one-off and
 * is meant to be absent; this has to work on an ordinary day, which is the same
 * reasoning as `email-status`.
 */
router.get('/irl-text-audit', async (req, res) => {
  try {
    const result = await irlTextReport();
    if (result.findings.length) {
      console.error(
        `[maintenance] IRL text audit found ${result.findings.length} finding(s): `
        + result.findings.map(describeFinding).join('; ')
      );
    }
    res.json({
      scanned: result.scanned,
      findingCount: result.findings.length,
      companies: result.companies,
      findings: result.findings,
    });
  } catch (err) {
    console.error('[maintenance] IRL text audit failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /maintenance/irl-text-audit/quarantine
 *   { "confirm": "QUARANTINE COMPANY VISIBLE TEXT" }
 *
 * Moves every offending value into `internal_note`, blanks the company-visible
 * column and records the refs. It does NOT redraft the wording: run the GET
 * first, then this, then rewrite each recorded ref by hand.
 *
 * The confirmation phrase is the whole of the confirmation step, as with the
 * platform reset. An administrator is exactly who would call this, so the role
 * check is not the control.
 */
const QUARANTINE_PHRASE = 'QUARANTINE COMPANY VISIBLE TEXT';

router.post('/irl-text-audit/quarantine', async (req, res) => {
  if ((req.body || {}).confirm !== QUARANTINE_PHRASE) {
    return res.status(400).json({
      error: `Send { "confirm": "${QUARANTINE_PHRASE}" } to proceed.`,
    });
  }

  try {
    const result = await irlTextQuarantine({ actorId: req.user.sub });

    await logAudit({
      action: 'maintenance.irl_text_quarantined',
      userId: req.user.sub,
      detail: { items: result.items, findings: result.moved.length },
      ip: req.ip,
    });

    res.json({
      message: result.moved.length
        ? 'Moved to the internal note. Each ref below still needs rewriting by hand.'
        : 'Nothing to move. No stored company-visible text carries an internal reference.',
      scanned: result.scanned,
      items: result.items,
      companies: result.companies,
      moved: result.moved,
    });
  } catch (err) {
    console.error('[maintenance] IRL text quarantine failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
