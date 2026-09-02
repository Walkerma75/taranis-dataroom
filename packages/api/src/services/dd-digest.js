/**
 * The daily outstanding-actions digest.
 *
 * ---------------------------------------------------------------------------
 * OFF BY DEFAULT, AND THAT IS NOT A STOPGAP
 * ---------------------------------------------------------------------------
 * `DD_DIGEST_ENABLED` gates the send and is unset everywhere until Mark has
 * approved the wording. The ten Phase 1b templates are approved copy, asserted
 * character for character, and a wording change comes back through Cowork
 * rather than being written on the code side (HANDOVER-CW011 §1). An eleventh
 * template is the same rule seen from the other end: the draft below is a
 * proposal, so the machinery ships built, tested and dark, and the flag is what
 * turns a proposal into something a counterparty's inbox never sees but Mark's
 * does. See HANDOVER-C020 D6.
 *
 * ---------------------------------------------------------------------------
 * WHY A TIMER AT ALL, AND WHY IT NEEDS A DEDUPE KEY
 * ---------------------------------------------------------------------------
 * There is no scheduler in this platform and deliberately so: the code brief §4
 * rules out a queue service, a scheduler and a second container, and the deploy
 * credential is ECR and ECS only, which rules out EventBridge as well. So the
 * digest is a second `setInterval` alongside the outbox worker, in the same
 * process, checking whether the fire window has come round.
 *
 * A timer in a process is not a schedule. It restarts when the process does,
 * with no memory of what it already did, and a rolling deploy briefly runs two
 * of them. Both of those would send the digest twice. `queue()` therefore takes
 * a dedupe key of `dd-digest:{local date}` and the unique index from migration
 * 020 decides the race, rather than a check in this file that two tasks could
 * both pass.
 *
 * ---------------------------------------------------------------------------
 * THE WINDOW
 * ---------------------------------------------------------------------------
 * The digest fires in the hour beginning at `DD_DIGEST_HOUR_LOCAL` (07:00 Dubai
 * by default), Monday to Friday, and not at all outside it. Two consequences
 * worth being explicit about:
 *
 *   * If the task is down for that whole window, that day's digest is skipped
 *     rather than sent late. A summary of outstanding actions arriving at three
 *     in the afternoon reads as an alert about something that has just
 *     happened, which it is not.
 *   * No weekend digest. Taranis-side ageing is measured in working days, so a
 *     Saturday message would report the same figures as Friday's and describe
 *     them as nought working days older (Mark's decision, HANDOVER-C020 D5).
 *
 * Dubai is UTC+4 and observes no daylight saving, so the local hour is a fixed
 * offset from UTC and needs no zone database.
 */
import { pool } from '../db.js';
import { loadSummary, isClear, LEVEL_NONE } from './dd-summary.js';
import { queue, adminRecipient } from './notifications.js';
import { dashboardUrl } from './links.js';

/** The template id. Draft wording lives in `email-templates/templates.js`. */
export const DIGEST_TEMPLATE = 'dd-digest';

export const DIGEST_DEFAULTS = {
  hourLocal: 7,
  /** Asia/Dubai, UTC+4 all year. */
  utcOffsetHours: 4,
  windowHours: 2,
};

/** How often the timer looks. Well inside the window, cheap when it is closed. */
export const DIGEST_INTERVAL_MS = 5 * 60 * 1000;

function intOr(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

export function digestConfigFromEnv(env = process.env) {
  return {
    // Anything other than an explicit 'true' leaves it off. A flag that could be
    // switched on by a typo is not a gate.
    enabled: String(env.DD_DIGEST_ENABLED || '').trim().toLowerCase() === 'true',
    hourLocal: intOr(env.DD_DIGEST_HOUR_LOCAL, DIGEST_DEFAULTS.hourLocal),
    utcOffsetHours: intOr(env.DD_DIGEST_UTC_OFFSET_HOURS, DIGEST_DEFAULTS.utcOffsetHours),
    windowHours: intOr(env.DD_DIGEST_WINDOW_HOURS, DIGEST_DEFAULTS.windowHours),
  };
}

/**
 * The local wall-clock parts of an instant, at a fixed offset.
 *
 * Shifting the instant and then reading its UTC parts is the whole trick, and
 * it is exact for a zone with no daylight saving. Reading LOCAL parts of the
 * shifted date would depend on the container's own zone, which is the mistake
 * that makes a 07:00 job fire at 03:00.
 */
export function localParts(now, utcOffsetHours) {
  const shifted = new Date(now.getTime() + utcOffsetHours * 60 * 60 * 1000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    weekday: shifted.getUTCDay(), // 0 Sunday .. 6 Saturday
  };
}

/** 'dd-digest:2026-09-02' on the local date, so there is one per local day. */
export function digestDedupeKey(now, utcOffsetHours = DIGEST_DEFAULTS.utcOffsetHours) {
  const { year, month, day } = localParts(now, utcOffsetHours);
  const pad = (n) => String(n).padStart(2, '0');
  return `${DIGEST_TEMPLATE}:${year}-${pad(month)}-${pad(day)}`;
}

/** Inside the fire window, on a weekday, in local time. */
export function isDigestWindow(now, config = DIGEST_DEFAULTS) {
  const { hour, weekday } = localParts(now, config.utcOffsetHours);
  if (weekday === 0 || weekday === 6) return false;
  return hour >= config.hourLocal && hour < config.hourLocal + config.windowHours;
}

// ---------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** '2 September 2026', on the local date the digest is about. */
export function localDateLabel(now, utcOffsetHours) {
  const { year, month, day } = localParts(now, utcOffsetHours);
  return `${day} ${MONTHS[month - 1]} ${year}`;
}

/** 'oldest 3 working days, red', or '' when nothing is old enough to say. */
function ageClause(bucket, unitLabel) {
  if (!bucket.since || bucket.level === LEVEL_NONE) return '';
  const plural = bucket.days === 1 ? '' : 's';
  return `, oldest ${bucket.days} ${unitLabel} day${plural}, ${bucket.level}`;
}

/**
 * One line per company, skipping a bucket that is empty.
 *
 * Exported so the test can assert the line rather than the whole rendered
 * message: the digest's value is entirely in whether these read correctly.
 */
export function companyLines(summary) {
  return summary.companies
    .filter((c) => c.awaitingTaranis.total > 0 || c.awaitingCompany.total > 0)
    .map((c) => {
      const parts = [];

      if (c.awaitingTaranis.total > 0) {
        parts.push(
          `${c.awaitingTaranis.total} awaiting Taranis`
          + ` (${c.awaitingTaranis.received} to open, ${c.awaitingTaranis.inReview} in review)`
          + ageClause(c.awaitingTaranis, 'working')
        );
      }

      if (c.awaitingCompany.total > 0) {
        const detail = [];
        if (c.awaitingCompany.attentionFiles > 0) {
          detail.push(`${c.awaitingCompany.attentionFiles} needing attention`);
        }
        if (c.awaitingCompany.unstartedItems > 0) {
          detail.push(`${c.awaitingCompany.unstartedItems} not started`);
        }
        parts.push(
          `${c.awaitingCompany.total} awaiting the company`
          + ` (${detail.join(', ')})`
          + ageClause(c.awaitingCompany, 'calendar')
        );
      }

      parts.push(`${c.irl.completed} of ${c.irl.countable} items completed`);

      return `${c.name}, ${c.fundName}: ${parts.join('. ')}.`;
    });
}

export function buildDigestPayload(summary, { now = new Date(), env = process.env, config } = {}) {
  const cfg = config || digestConfigFromEnv(env);
  return {
    digest_date: localDateLabel(now, cfg.utcOffsetHours),
    awaiting_taranis_count: summary.awaitingTaranis.total,
    awaiting_company_count: summary.awaitingCompany.total,
    company_lines: companyLines(summary),
    taranis_amber_days: summary.thresholds.taranisAmberDays,
    taranis_red_days: summary.thresholds.taranisRedDays,
    company_amber_days: summary.thresholds.companyAmberDays,
    company_red_days: summary.thresholds.companyRedDays,
    dashboard_url: dashboardUrl(env),
  };
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/**
 * One evaluation of the digest. Returns why it did or did not queue, which is
 * what the tests assert on and what the log line says.
 *
 * Order matters: the flag and the window are checked before the summary is
 * loaded, so a disabled deployment runs three queries never rather than every
 * five minutes for ever.
 */
export async function runDigestOnce({ db = pool, now = new Date(), env = process.env } = {}) {
  const config = digestConfigFromEnv(env);

  if (!config.enabled) return { queued: false, reason: 'disabled' };
  if (!isDigestWindow(now, config)) return { queued: false, reason: 'outside-window' };

  const summary = await loadSummary({ db, now, env });

  // CW020 §3.5: no email when both buckets are zero. A daily message saying
  // there is nothing to do trains the reader to ignore the one that says there
  // is.
  if (isClear(summary)) return { queued: false, reason: 'clear' };

  const id = await queue(db, {
    template: DIGEST_TEMPLATE,
    recipient: adminRecipient(env),
    payload: buildDigestPayload(summary, { now, env, config }),
    dedupeKey: digestDedupeKey(now, config.utcOffsetHours),
  });

  // A null id here is the dedupe key doing its job, not a failure: this process
  // or another one already queued today's.
  return id
    ? { queued: true, reason: 'queued', id }
    : { queued: false, reason: 'already-queued' };
}

let timer = null;
let running = false;

/**
 * Start the digest timer.
 *
 * Mirrors `startOutboxWorker` deliberately, down to the `running` guard and the
 * `unref()`: a test that starts it and forgets it must not hang the suite, and
 * a slow pass must not overlap the next tick.
 */
export function startDigestWorker({ intervalMs = DIGEST_INTERVAL_MS, ...opts } = {}) {
  if (timer) return timer;

  timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const result = await runDigestOnce(opts);
      if (result.queued) {
        console.log(`[dd-digest] Queued today's digest (${result.id}).`);
      }
    } catch (err) {
      // The loop failing is not a message failing. Most likely the database is
      // briefly unreachable; the next tick tries again, and the dedupe key
      // means a success after a failure is still only one message.
      console.error('[dd-digest] Pass failed:', err.message);
    } finally {
      running = false;
    }
  }, intervalMs);

  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

export function stopDigestWorker() {
  if (timer) clearInterval(timer);
  timer = null;
  running = false;
}
