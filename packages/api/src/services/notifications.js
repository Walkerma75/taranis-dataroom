/**
 * The notification outbox: queueing, draining, retrying and suppression.
 *
 * ---------------------------------------------------------------------------
 * THE ONE RULE
 * ---------------------------------------------------------------------------
 * Routes queue. Only the worker sends. A route that awaited SES in the middle
 * of a request would couple a company's upload to a third party's availability,
 * and — worse — a send that succeeded inside a transaction which then rolled
 * back could not be taken back. So `queue()` takes the CALLER'S transaction
 * client and writes the row inside it: the notification commits with the thing
 * it is about, or not at all.
 *
 * That is why every call site passes `client`, not `pool`. Passing `pool` from
 * inside a transaction would write the row on a different connection, outside
 * the transaction, and a rollback would leave an email queued about something
 * that never happened. `queue()` defaults to `pool` for the handful of callers
 * with no transaction of their own, and those are the exception.
 *
 * ---------------------------------------------------------------------------
 * RETRY
 * ---------------------------------------------------------------------------
 * `attempts` is incremented when a row is CLAIMED, not when it fails. A row
 * that kills the process mid-send therefore still counts as tried, so a message
 * that reliably crashes the worker cannot spin for ever at the head of the
 * queue holding up everything behind it.
 *
 * Backoff is exponential in minutes and capped, written to `send_after`. After
 * MAX_ATTEMPTS the row goes to 'failed' and stays there with its `last_error`
 * for someone to read. Nothing deletes it.
 *
 * A permanent rejection from SES (see `PermanentSendError`) fails the row on
 * the first attempt instead of burning five. Retrying a message SES has said it
 * will never accept only delays the messages behind it.
 *
 * ---------------------------------------------------------------------------
 * SUPPRESSION
 * ---------------------------------------------------------------------------
 * Checked before every send, against `email_suppressions` (migration 018). A
 * suppressed row is marked 'suppressed', not deleted and not left pending:
 * HANDOVER-CW011 §3.6 requires that a withheld send is recorded. An
 * administrator asking "did that company ever get the invitation" gets a real
 * answer either way.
 */
import { pool as defaultPool } from '../db.js';
import { getMailer, PermanentSendError } from './email.js';
import { renderTemplate, UnknownTemplateError } from './email-templates/index.js';

/** Attempts before a row is abandoned as 'failed'. */
export const MAX_ATTEMPTS = 5;

/** How many rows one pass of the worker will take. */
export const DRAIN_BATCH = 10;

/** Default gap between passes. Nothing here is latency-critical. */
export const DEFAULT_INTERVAL_MS = 15_000;

/**
 * Backoff for the nth attempt, in minutes: 1, 2, 4, 8, capped at 30.
 *
 * The cap matters because the first attempt of a message often fails for a
 * reason that clears in minutes (a throttle, a redeploy mid-flight), and an
 * uncapped doubling would push the fifth attempt hours out for no benefit.
 */
export function backoffMinutes(attempts) {
  return Math.min(2 ** Math.max(0, attempts - 1), 30);
}

/** Addresses are compared case-insensitively. See migration 018. */
const normaliseEmail = (email) => String(email || '').trim().toLowerCase();

// ---------------------------------------------------------------------------
// Payload helpers
//
// Shared by the call sites so that a date or a name is formatted one way across
// all ten templates. A company receiving '2026-08-10T14:03:11.812Z' in one
// message and '10 August 2026' in another looks like two systems.
// ---------------------------------------------------------------------------

/**
 * Where admin notifications go. The approved templates name
 * admin@taraniscapital.com; the variable exists so the pilot can be pointed at
 * an internal address for the smoke test without editing approved wording.
 */
export function adminRecipient(env = process.env) {
  return env.ADMIN_NOTIFICATION_EMAIL || 'admin@taraniscapital.com';
}

/**
 * The name every 'Dear {{first_name}},' uses.
 *
 * Falls back to the whole display name rather than to 'there' or an empty
 * greeting: addressing a counterparty's finance director as 'Dear ,' in the
 * first message they receive is worse than being a little formal.
 */
export function firstNameOf(displayName) {
  const name = String(displayName || '').trim();
  if (!name) return 'colleague';
  return name.split(/\s+/)[0];
}

/** '17 August 2026'. UK English, no ordinal suffix, unambiguous to a US reader. */
export function formatDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  });
}

/**
 * '10 August 2026 at 14:03'. The template supplies the '(UTC)' suffix, so this
 * must be UTC and nothing else — a receipt is a formal record and a timestamp
 * silently rendered in the server's local zone would misdate it.
 */
export function formatDateTimeUtc(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const day = formatDate(date);
  const time = date.toISOString().slice(11, 16);
  return `${day} at ${time}`;
}

/** '2.4 MB'. Only the upload notification shows sizes. */
export function formatBytes(bytes) {
  const size = Number(bytes);
  if (!Number.isFinite(size) || size < 0) return '';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(0)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Shorten a checklist item description for a subject line or a one-line list.
 *
 * The approved templates call this `{{item_description_short}}`. IRL
 * descriptions run to a couple of sentences, and an untruncated one in a
 * subject line is unreadable in every mail client.
 */
export function shortDescription(text, limit = 80) {
  const value = String(text || '').trim();
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 1).trimEnd()}…`;
}

/**
 * Queue one message.
 *
 * @param {object} client   the caller's transaction client; `pool` only when
 *                          the caller genuinely has no transaction
 * @param {object} message  { template, recipient, payload }
 */
export async function queue(client, { template, recipient, payload = {} }) {
  const db = client || defaultPool;
  const to = String(recipient || '').trim();

  // A missing recipient is a bug at the call site, and the call site is inside
  // someone's transaction. Refusing here would roll back the upload or the
  // status change that the message was only ever meant to announce, so this
  // records the problem and lets the real work commit.
  if (!to) {
    console.error(`[notifications] Refusing to queue '${template}' with no recipient.`);
    return null;
  }

  const { rows } = await db.query(
    `INSERT INTO notification_outbox (template, recipient, payload)
     VALUES ($1, $2, $3::jsonb)
     RETURNING id`,
    [template, to, JSON.stringify(payload)]
  );

  return rows[0]?.id ?? null;
}

/**
 * Queue the same template to several recipients, de-duplicated.
 *
 * `status-attention` and `status-completed` both go to the uploader AND the
 * company administrator, who are frequently the same person in a small company.
 * One row per address keeps suppression and the audit trail per-address, and
 * de-duplication stops that person receiving the message twice.
 */
export async function queueEach(client, { template, recipients, payload = {} }) {
  const seen = new Set();
  const ids = [];

  for (const recipient of recipients || []) {
    const key = normaliseEmail(recipient?.email ?? recipient);
    if (!key || seen.has(key)) continue;
    seen.add(key);

    const id = await queue(client, {
      template,
      recipient: recipient?.email ?? recipient,
      // Per-recipient overrides (first_name, most obviously) ride on the
      // recipient object so one call can address several people by name.
      payload: { ...payload, ...(recipient?.payload || {}) },
    });
    if (id) ids.push(id);
  }

  return ids;
}

// ---------------------------------------------------------------------------
// Suppression
// ---------------------------------------------------------------------------

/** Is this address currently suppressed? */
export async function isSuppressed(email, client) {
  const db = client || defaultPool;
  const { rows } = await db.query(
    `SELECT 1 FROM email_suppressions
      WHERE email = $1 AND released_at IS NULL
      LIMIT 1`,
    [normaliseEmail(email)]
  );
  return rows.length > 0;
}

/**
 * Add an address to the suppression list, or refresh an existing entry.
 *
 * Hard bounces and complaints only — a soft bounce is what the retry is for.
 * The caller decides; `ses-events.js` is the one that reads SES's verdict.
 */
export async function suppress({ email, reason, detail = null }, client) {
  const db = client || defaultPool;
  const address = normaliseEmail(email);
  if (!address) return null;

  const { rows } = await db.query(
    `INSERT INTO email_suppressions (email, reason, detail)
     VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (email) WHERE released_at IS NULL
       DO UPDATE SET reason = EXCLUDED.reason,
                     detail = EXCLUDED.detail,
                     suppressed_at = NOW()
     RETURNING id`,
    [address, reason, detail ? JSON.stringify(detail) : null]
  );

  console.warn(`[notifications] Suppressing ${address} (${reason}).`);
  return rows[0]?.id ?? null;
}

/** Lift a suppression. The row stays, with who released it and why. */
export async function release({ email, releasedBy, reason = null }, client) {
  const db = client || defaultPool;
  const { rowCount } = await db.query(
    `UPDATE email_suppressions
        SET released_at = NOW(), released_by = $2, released_reason = $3
      WHERE email = $1 AND released_at IS NULL`,
    [normaliseEmail(email), releasedBy, reason]
  );
  return rowCount;
}

// ---------------------------------------------------------------------------
// The worker
// ---------------------------------------------------------------------------

/**
 * Claim up to `limit` due rows, incrementing `attempts` as they are taken.
 *
 * `FOR UPDATE SKIP LOCKED` is what makes this safe if the service is ever
 * scaled past one task: two workers claim disjoint sets rather than both
 * sending the same message. There is one task today. Writing it the other way
 * would be a duplicate-email bug that appears only on the day someone scales
 * the service for an unrelated reason.
 */
async function claimDue(db, limit) {
  const { rows } = await db.query(
    `UPDATE notification_outbox
        SET attempts = attempts + 1
      WHERE id IN (
        SELECT id FROM notification_outbox
         WHERE status = 'pending' AND send_after <= NOW()
         ORDER BY send_after, created_at
         LIMIT $1
         FOR UPDATE SKIP LOCKED
      )
      RETURNING id, template, recipient, payload, attempts`,
    [limit]
  );
  return rows;
}

async function markSent(db, id, messageId) {
  await db.query(
    `UPDATE notification_outbox
        SET status = 'sent', sent_at = NOW(), last_error = NULL, message_id = $2
      WHERE id = $1`,
    [id, messageId]
  );
}

async function markSuppressed(db, id) {
  await db.query(
    `UPDATE notification_outbox
        SET status = 'suppressed', sent_at = NOW(),
            last_error = 'Recipient is on the suppression list; send withheld.'
      WHERE id = $1`,
    [id]
  );
}

/**
 * Record a failed attempt: back off and retry, or give up.
 *
 * `permanent` short circuits the attempt count. `last_error` is always written,
 * because a row that failed silently is indistinguishable from one nobody ever
 * queued.
 */
async function markFailure(db, { id, attempts, error, permanent }) {
  const giveUp = permanent || attempts >= MAX_ATTEMPTS;

  if (giveUp) {
    await db.query(
      `UPDATE notification_outbox SET status = 'failed', last_error = $2 WHERE id = $1`,
      [id, String(error).slice(0, 2000)]
    );
    return 'failed';
  }

  await db.query(
    `UPDATE notification_outbox
        SET last_error = $2,
            send_after = NOW() + ($3 || ' minutes')::interval
      WHERE id = $1`,
    [id, String(error).slice(0, 2000), String(backoffMinutes(attempts))]
  );
  return 'retry';
}

/**
 * One pass of the worker. Returns a tally, which is what the tests assert on.
 *
 * Exported separately from the loop so a test can drain deterministically
 * rather than waiting on a timer.
 */
export async function drainOnce({ pool = defaultPool, mailer, limit = DRAIN_BATCH, env } = {}) {
  const send = mailer || (await getMailer());
  const tally = { claimed: 0, sent: 0, suppressed: 0, retried: 0, failed: 0 };

  const rows = await claimDue(pool, limit);
  tally.claimed = rows.length;

  for (const row of rows) {
    try {
      if (await isSuppressed(row.recipient, pool)) {
        await markSuppressed(pool, row.id);
        tally.suppressed++;
        continue;
      }

      const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : (row.payload || {});
      const { subject, html, text } = renderTemplate(row.template, payload, { env });

      const { messageId } = await send.send({ to: row.recipient, subject, html, text });
      await markSent(pool, row.id, messageId);
      tally.sent++;
    } catch (err) {
      // An unknown template will never render, however many times it is tried:
      // the row names something this build does not have, which is a rename
      // that missed its data. Fail it now, with the reason on the row.
      const permanent = err instanceof PermanentSendError || err instanceof UnknownTemplateError;

      const outcome = await markFailure(pool, {
        id: row.id,
        attempts: row.attempts,
        error: err.message,
        permanent,
      });
      if (outcome === 'failed') tally.failed++;
      else tally.retried++;

      console.error(
        `[notifications] ${row.template} to ${row.recipient} failed `
        + `(attempt ${row.attempts}/${MAX_ATTEMPTS}, ${outcome}): ${err.message}`
      );
    }
  }

  return tally;
}

let timer = null;
let running = false;

/**
 * Start the drain loop.
 *
 * A plain `setInterval` in the API process, as the code brief §4 specifies: no
 * queue service, no scheduler, no second container. `running` guards against a
 * slow pass overlapping the next tick, which would double-send nothing (the
 * claim is atomic) but would pile up connections for no reason.
 *
 * `unref()` keeps the timer from holding the process open, so a test that
 * starts the worker and forgets it does not hang the suite.
 */
export function startOutboxWorker({ intervalMs = DEFAULT_INTERVAL_MS, ...opts } = {}) {
  if (timer) return timer;

  timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await drainOnce(opts);
    } catch (err) {
      // A failure here is the loop itself failing, not a message: most likely
      // the database is briefly unreachable. Log and let the next tick try.
      console.error('[notifications] Outbox pass failed:', err.message);
    } finally {
      running = false;
    }
  }, intervalMs);

  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

export function stopOutboxWorker() {
  if (timer) clearInterval(timer);
  timer = null;
  running = false;
}
