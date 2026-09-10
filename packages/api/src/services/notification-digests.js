/**
 * Session digests: one email per sitting instead of one email per file.
 *
 * ---------------------------------------------------------------------------
 * WHY
 * ---------------------------------------------------------------------------
 * On 10 September 2026 one review sitting on Revelations Biotech set 76 files
 * to Accepted or Attention needed, and its administrator received 76 emails in
 * a few minutes. On 28 August the same company's upload of 78 files had sent
 * the admin address one email per file. Mark's rule (HANDOVER-CW025): a
 * reviewer who changes forty statuses, or a company that uploads forty files,
 * produces one email per recipient that lists everything done in that sitting.
 *
 * "Sitting" is a quiet-period debounce with a maximum hold, not a login
 * session: a reviewer and a company both act across several requests and
 * devices, and nothing ties those together except time.
 *
 * ---------------------------------------------------------------------------
 * HOW, AND WHY NOT INSIDE THE OUTBOX
 * ---------------------------------------------------------------------------
 * Routes call `queueDigestEvent()` in place of `queue()`. That writes one row to
 * `notification_digest_events` (migration 021), in the caller's transaction
 * where there is one, and touches nothing else.
 *
 * A timer here closes any group of open events, keyed by (family, recipient,
 * company), whose newest event is older than the quiet period or whose oldest
 * is older than the maximum hold. Closing a group is ONE transaction: lock its
 * open events, build the message from the rows they point at AS THEY STAND
 * NOW, insert one ordinary `notification_outbox` row, stamp the events with its
 * id. The outbox worker then sends it like any other message, with the same
 * suppression check, retry and failure rules. `notifications.js` keeps its one
 * rule and does not know digests exist.
 *
 * The outbox could not do this itself. Its worker claims a row by incrementing
 * `attempts` and nothing else, so a row being sent and a row waiting to retry
 * both still read 'pending': there is no moment at which a pending row stops
 * accepting new events. And the 020 dedupe key is unique across sent rows, so
 * it cannot key a second digest to the same person (HANDOVER-C025 §3.1).
 *
 * What that buys:
 *   * A restart loses nothing. Open events are rows, and the timer holds no
 *     state of its own.
 *   * Nothing is sent twice. Events are stamped in the transaction that queues
 *     the message.
 *   * An event arriving while its group is being closed is not in the locked
 *     set, so it opens the next group, which is the brief's rule.
 *   * Two tasks overlapping in a rolling deploy can at worst split one group
 *     into two messages. `FOR UPDATE SKIP LOCKED` means neither sees the
 *     other's events, so nothing is lost or repeated.
 *
 * ---------------------------------------------------------------------------
 * WHAT MUST NOT GET INTO THESE MESSAGES
 * ---------------------------------------------------------------------------
 * `company_irl_items.internal_note` is Taranis's private note and must never
 * reach a company. Every query below names its columns; none selects `*` from
 * a table that holds it. The reviewer note that DOES go out is the latest
 * `file_status_history` note, which is the company-facing one by design.
 *
 * ---------------------------------------------------------------------------
 * THE SWITCH
 * ---------------------------------------------------------------------------
 * On unless `NOTIFY_DIGEST_ENABLED` says otherwise (Mark, 10 September 2026:
 * the merge itself should deliver the fix). Switched off, the routes go back to
 * one message per event, exactly as before, but THIS TIMER KEEPS RUNNING so
 * events captured before the switch are still sent rather than stranded.
 */
import { pool as defaultPool } from '../db.js';
import {
  queue,
  normaliseEmail,
  firstNameOf,
  formatBytes,
  formatDateTimeUtc,
  shortDescription,
} from './notifications.js';
import { summariseProgress, companyVisibleItems } from './companies.js';
import { adminReviewUrl, itemUrl, workspaceUrl } from './links.js';

/** The three families CW025 names. Matches the CHECK in migration 021. */
export const FAMILIES = Object.freeze({
  STATUS: 'company-status',
  UPLOADS: 'admin-uploads',
  NEW_ITEMS: 'company-new-items',
});

export const SESSION_DIGEST_DEFAULTS = Object.freeze({
  quietMinutes: 10,
  maxHoldMinutes: 60,
});

/** How often the timer looks. Well inside a ten-minute quiet period. */
export const FLUSH_INTERVAL_MS = 30_000;

/** Groups closed per pass. A backlog clears over a few passes, not one. */
export const FLUSH_BATCH = 50;

const OFF_VALUES = new Set(['false', '0', 'off', 'no']);

function positiveInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * The switch and the two windows, from the environment.
 *
 * On unless explicitly off. The maximum hold is never shorter than the quiet
 * period: a hold of five minutes under a ten-minute quiet period would mean
 * every digest closed at the hold, which is a configuration mistake rather
 * than a setting anyone meant.
 */
export function sessionDigestConfig(env = process.env) {
  const raw = String(env.NOTIFY_DIGEST_ENABLED ?? '').trim().toLowerCase();
  const quietMinutes = positiveInt(env.NOTIFY_DIGEST_QUIET_MINUTES, SESSION_DIGEST_DEFAULTS.quietMinutes);
  const maxHoldMinutes = positiveInt(env.NOTIFY_DIGEST_MAX_HOLD_MINUTES, SESSION_DIGEST_DEFAULTS.maxHoldMinutes);
  return {
    enabled: !OFF_VALUES.has(raw),
    quietMinutes,
    maxHoldMinutes: Math.max(maxHoldMinutes, quietMinutes),
  };
}

/** Whether routes should write digest events rather than queue per event. */
export function sessionDigestsEnabled(env = process.env) {
  return sessionDigestConfig(env).enabled;
}

// ---------------------------------------------------------------------------
// Queueing
// ---------------------------------------------------------------------------

/**
 * Record one event for a digest.
 *
 * Takes the CALLER'S transaction client, for the same reason `queue()` does:
 * the event commits with the change it describes or not at all. Callers with
 * no transaction of their own (a single-INSERT upload) pass `pool`.
 *
 * A missing recipient is logged and skipped rather than thrown, matching
 * `queue()`: throwing here would roll back the status change or upload that the
 * message was only ever meant to announce.
 */
export async function queueDigestEvent(client, { family, recipient, companyId, event = {} }) {
  const db = client || defaultPool;
  const to = normaliseEmail(recipient);

  if (!to) {
    console.error(`[digests] Refusing to record a '${family}' event with no recipient.`);
    return null;
  }

  const { rows } = await db.query(
    `INSERT INTO notification_digest_events (family, recipient, company_id, event)
     VALUES ($1, $2, $3, $4::jsonb)
     RETURNING id`,
    [family, to, companyId, JSON.stringify(event)]
  );
  return rows[0]?.id ?? null;
}

/** One event per distinct address, the digest twin of `queueEach()`. */
export async function queueDigestEvents(client, { family, recipients, companyId, event = {} }) {
  const seen = new Set();
  const ids = [];
  for (const recipient of recipients || []) {
    const address = normaliseEmail(recipient?.email ?? recipient);
    if (!address || seen.has(address)) continue;
    seen.add(address);
    const id = await queueDigestEvent(client, { family, recipient: address, companyId, event });
    if (id) ids.push(id);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// When a group is due
// ---------------------------------------------------------------------------

/**
 * Due once nothing has happened for the quiet period, or once the first event
 * has waited the maximum hold, whichever comes first. The hold is what makes a
 * long sitting still send: a reviewer working steadily for two hours gets a
 * digest each hour rather than one at the end.
 */
export function isGroupDue({ firstAt, lastAt }, now, config) {
  const at = now instanceof Date ? now.getTime() : Number(now);
  const quietMs = config.quietMinutes * 60_000;
  const holdMs = config.maxHoldMinutes * 60_000;
  return at - new Date(lastAt).getTime() >= quietMs
      || at - new Date(firstAt).getTime() >= holdMs;
}

// ---------------------------------------------------------------------------
// Building the message: pure functions over rows
//
// Exported so the tests can assert the choice of template and the payload
// without a database. Each returns `{ template, payload }`, or null when there
// is nothing left to say.
// ---------------------------------------------------------------------------

function bySortOrder(a, b) {
  const ao = a.sort_order ?? Number.MAX_SAFE_INTEGER;
  const bo = b.sort_order ?? Number.MAX_SAFE_INTEGER;
  if (ao !== bo) return ao - bo;
  return String(a.filename ?? a.ref ?? '').localeCompare(String(b.filename ?? b.ref ?? ''));
}

/** 'A', 'A and B', 'A, B and C'. */
export function joinNames(names) {
  const list = [...new Set((names || []).filter(Boolean))];
  if (list.length <= 1) return list[0] || '';
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

function trimmedOrNull(text) {
  const value = String(text ?? '').trim();
  return value || null;
}

/**
 * The company status digest.
 *
 * Only files that END the sitting at Attention needed or Completed are listed.
 * One flagged and then accepted appears once, as accepted; one moved on to In
 * review or back to Received has nothing to announce and drops out. Attention
 * first, because that is the part that asks the company to do something.
 *
 * A single file keeps today's approved one-file message. The approved wording
 * is true of it, and a counterparty's lone acceptance should read the way
 * every one before it has (HANDOVER-C025 §3.3).
 */
export function buildStatusMessage({ rows, companyName, firstName, progress, env }) {
  const attention = rows.filter((r) => r.status === 'attention_needed').sort(bySortOrder);
  const accepted = rows.filter((r) => r.status === 'completed').sort(bySortOrder);
  const total = attention.length + accepted.length;
  if (total === 0) return null;

  const progressFields = {
    progress_percent: `${progress.percentComplete}%`,
    outstanding_count: progress.countable - progress.completed,
    workspace_url: workspaceUrl(env),
  };

  if (total === 1) {
    const r = attention[0] || accepted[0];
    const common = {
      first_name: firstName,
      company_name: companyName,
      filename: r.filename,
      item_ref: r.item_ref || '',
      item_description_short: shortDescription(r.item_description),
    };

    if (attention.length === 1) {
      return {
        template: 'status-attention',
        payload: {
          ...common,
          submitted_at: r.submitted_at ? formatDateTimeUtc(r.submitted_at) : 'an earlier date',
          receipt_ref: r.receipt_ref || '',
          reviewer_note: trimmedOrNull(r.status_note) || '',
          item_url: itemUrl(r.irl_item_id, env),
        },
      };
    }
    return { template: 'status-completed', payload: { ...common, ...progressFields } };
  }

  return {
    template: 'status-digest',
    payload: {
      first_name: firstName,
      company_name: companyName,
      reviewed_count: total,
      attention_count: attention.length,
      accepted_count: accepted.length,
      attention_files: attention.map((r) => ({
        filename: r.filename,
        item_ref: r.item_ref || '',
        item_description_short: shortDescription(r.item_description),
        submitted_at: r.submitted_at ? formatDateTimeUtc(r.submitted_at) : 'an earlier date',
        receipt_ref: r.receipt_ref || '',
        reviewer_note: trimmedOrNull(r.status_note) || '',
      })),
      accepted_files: accepted.map((r) => ({
        filename: r.filename,
        item_ref: r.item_ref || '',
        item_description_short: shortDescription(r.item_description),
        // An acceptance can carry a note ("accepted; it expires on 12
        // September, please upload the renewal"). The company sees it in the
        // portal, so it goes in the digest as well.
        reviewer_note: trimmedOrNull(r.status_note),
      })),
      ...progressFields,
    },
  };
}

/** Where an uploaded file stands when the digest closes. */
function uploadState(row) {
  if (row.deleted_at) return 'removed';
  if (row.upload_state === 'submitted') return 'submitted';
  return 'staged';
}

/**
 * The admin upload digest.
 *
 * Every file uploaded in the sitting is listed, whatever has happened to it
 * since: Mark's decision, 10 September 2026. Each line says where the file
 * stands when the digest closes, because a company often submits inside the
 * quiet period and the approved one-file wording ("staged, not yet formally
 * submitted") would then be untrue. That is why this family always uses its
 * own template.
 */
export function buildUploadMessage({ rows, companyName, env }) {
  if (!rows || rows.length === 0) return null;

  // Checklist order, additional material last, then the order they arrived.
  const ordered = [...rows].sort((a, b) => {
    const ao = a.sort_order ?? Number.MAX_SAFE_INTEGER;
    const bo = b.sort_order ?? Number.MAX_SAFE_INTEGER;
    if (ao !== bo) return ao - bo;
    return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
  });

  const files = ordered.map((r) => {
    const description = String(r.description || '').trim();
    return {
      filename: r.filename,
      size: r.size_bytes === null || r.size_bytes === undefined ? '' : formatBytes(r.size_bytes),
      item_ref: r.item_ref || '',
      item_description_short: r.irl_item_id ? shortDescription(r.item_description) : '',
      // The replace path has always said which version this is, so the line
      // does not read as a duplicate of the one announcing version 1.
      description: Number(r.version) > 1 ? `${description} (version ${r.version})` : description,
      state: uploadState(r),
      receipt_ref: r.receipt_ref || '',
    };
  });

  const uploaders = [...ordered]
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
    .map((r) => r.uploader_name || r.uploader_email);

  return {
    template: 'upload-digest',
    payload: {
      company_name: companyName,
      uploader_names: joinNames(uploaders),
      file_count: files.length,
      files,
      submitted_count: files.filter((f) => f.state === 'submitted').length,
      staged_count: files.filter((f) => f.state === 'staged').length,
      removed_count: files.filter((f) => f.state === 'removed').length,
      admin_review_url: adminReviewUrl(env),
    },
  };
}

/**
 * The new-items digest, sent with the approved `new-items` template, which is
 * already a list.
 *
 * Its one limitation: a single "Note from the team" line. The note is shown
 * when every item in the group carries the same note (always true of one item,
 * which is the case that existed before) and left out otherwise. Each note is
 * still on its item in the portal (HANDOVER-C025 §3.3).
 *
 * An item that has since been marked 'held' is hidden from the company and is
 * not announced.
 */
export function buildNewItemsMessage({ rows, companyName, firstName, env }) {
  const items = (rows || []).filter((r) => r.state !== 'held').sort(bySortOrder);
  if (items.length === 0) return null;

  const notes = new Set(items.map((i) => trimmedOrNull(i.note_for_company) || ''));
  const [onlyNote] = notes;
  const noteForCompany = notes.size === 1 && onlyNote ? onlyNote : null;

  return {
    template: 'new-items',
    payload: {
      first_name: firstName,
      company_name: companyName,
      new_item_count: items.length,
      items: items.map((i) => ({
        ref: i.ref,
        description_short: shortDescription(i.description),
        priority: i.priority,
      })),
      note_for_company: noteForCompany,
      workspace_url: workspaceUrl(env),
    },
  };
}

// ---------------------------------------------------------------------------
// Reading the rows a group points at
// ---------------------------------------------------------------------------

/**
 * The recipient's name, if they are still an active, approved member of the
 * company. The same rule `statusRecipients()` applies when the event is
 * recorded, applied again when it is sent: someone deactivated during the
 * quiet period must not receive diligence correspondence about a company they
 * can no longer see.
 */
async function activeMemberName(db, companyId, email) {
  const { rows: [row] } = await db.query(
    `SELECT u.display_name
       FROM company_users cu
       JOIN users u ON u.id = cu.user_id
      WHERE cu.company_id = $1
        AND lower(u.email) = $2
        AND cu.deactivated_at IS NULL
        AND cu.approved_by IS NOT NULL
      LIMIT 1`,
    [companyId, email]
  );
  return row ? { displayName: row.display_name } : null;
}

async function companyName(db, companyId) {
  const { rows: [row] } = await db.query(
    `SELECT legal_name FROM companies WHERE id = $1`,
    [companyId]
  );
  return row?.legal_name || '';
}

function idsFrom(events, key) {
  return [...new Set(events.map((e) => e.event?.[key]).filter(Boolean))];
}

async function buildStatusFor(db, group, events, env) {
  const member = await activeMemberName(db, group.company_id, group.recipient);
  if (!member) return null;

  const fileIds = idsFrom(events, 'fileId');
  if (fileIds.length === 0) return null;

  // Columns named, never `*`: this is a message to the counterparty.
  const { rows } = await db.query(
    `SELECT f.id, f.filename, f.status, f.irl_item_id,
            i.ref AS item_ref, i.description AS item_description, i.sort_order,
            b.receipt_ref, b.submitted_at,
            h.note AS status_note
       FROM company_files f
       LEFT JOIN company_irl_items i ON i.id = f.irl_item_id
       LEFT JOIN submission_batches b ON b.id = f.batch_id
       LEFT JOIN LATERAL (
         SELECT note FROM file_status_history
          WHERE file_id = f.id ORDER BY created_at DESC LIMIT 1
       ) h ON TRUE
      WHERE f.id = ANY($1::uuid[]) AND f.company_id = $2 AND f.deleted_at IS NULL`,
    [fileIds, group.company_id]
  );

  // Visible items only, the locked rule for what a company's progress means
  // (HANDOVER-C002 §5.1), read now so it reflects the whole sitting.
  const { rows: items } = await db.query(
    `SELECT state FROM company_irl_items WHERE company_id = $1`,
    [group.company_id]
  );

  return buildStatusMessage({
    rows,
    companyName: await companyName(db, group.company_id),
    firstName: firstNameOf(member.displayName),
    progress: summariseProgress(companyVisibleItems(items)),
    env,
  });
}

async function buildUploadsFor(db, group, events, env) {
  const fileIds = idsFrom(events, 'fileId');
  if (fileIds.length === 0) return null;

  // Removed files are read too, so the digest can say what became of them.
  const { rows } = await db.query(
    `SELECT f.id, f.filename, f.description, f.size_bytes, f.version,
            f.upload_state, f.deleted_at, f.irl_item_id, f.created_at,
            i.ref AS item_ref, i.description AS item_description, i.sort_order,
            b.receipt_ref,
            u.display_name AS uploader_name, u.email AS uploader_email
       FROM company_files f
       JOIN users u ON u.id = f.uploaded_by
       LEFT JOIN company_irl_items i ON i.id = f.irl_item_id
       LEFT JOIN submission_batches b ON b.id = f.batch_id
      WHERE f.id = ANY($1::uuid[]) AND f.company_id = $2`,
    [fileIds, group.company_id]
  );

  return buildUploadMessage({
    rows,
    companyName: await companyName(db, group.company_id),
    env,
  });
}

async function buildNewItemsFor(db, group, events, env) {
  const member = await activeMemberName(db, group.company_id, group.recipient);
  if (!member) return null;

  const itemIds = idsFrom(events, 'itemId');
  if (itemIds.length === 0) return null;

  // Named columns: `internal_note` lives on this table.
  const { rows } = await db.query(
    `SELECT id, ref, description, priority, note_for_company, state, sort_order
       FROM company_irl_items
      WHERE id = ANY($1::uuid[]) AND company_id = $2`,
    [itemIds, group.company_id]
  );

  return buildNewItemsMessage({
    rows,
    companyName: await companyName(db, group.company_id),
    firstName: firstNameOf(member.displayName),
    env,
  });
}

const BUILDERS = {
  [FAMILIES.STATUS]: buildStatusFor,
  [FAMILIES.UPLOADS]: buildUploadsFor,
  [FAMILIES.NEW_ITEMS]: buildNewItemsFor,
};

// ---------------------------------------------------------------------------
// Closing groups
// ---------------------------------------------------------------------------

const DUE_GROUPS_SQL = `
  SELECT family, recipient, company_id,
         MIN(created_at) AS first_at, MAX(created_at) AS last_at
    FROM notification_digest_events
   WHERE flushed_at IS NULL
   GROUP BY family, recipient, company_id
  HAVING MAX(created_at) <= $1 OR MIN(created_at) <= $2
   ORDER BY MIN(created_at)
   LIMIT $3`;

/**
 * Close one group: lock, re-check, build, queue, stamp. One transaction.
 *
 * The re-check matters. The group was found due by a query that ran before the
 * lock; by the time the lock is held another task may have closed it and new
 * events may have opened its successor, which is not due yet. `SKIP LOCKED`
 * plus this check means such a successor is left alone rather than sent early.
 */
async function flushGroup(pool, group, { now, config, env }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: events } = await client.query(
      `SELECT id, event, created_at
         FROM notification_digest_events
        WHERE family = $1 AND recipient = $2 AND company_id = $3
          AND flushed_at IS NULL
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED`,
      [group.family, group.recipient, group.company_id]
    );

    if (events.length === 0) {
      await client.query('ROLLBACK');
      return { outcome: 'taken' };
    }

    const window = { firstAt: events[0].created_at, lastAt: events[events.length - 1].created_at };
    if (!isGroupDue(window, now, config)) {
      await client.query('ROLLBACK');
      return { outcome: 'not-due' };
    }

    const parsed = events.map((e) => ({
      ...e,
      event: typeof e.event === 'string' ? JSON.parse(e.event) : (e.event || {}),
    }));

    const build = BUILDERS[group.family];
    const message = build ? await build(client, group, parsed, env) : null;

    const outboxId = message
      ? await queue(client, {
        template: message.template,
        recipient: group.recipient,
        payload: message.payload,
      })
      : null;

    await client.query(
      `UPDATE notification_digest_events
          SET flushed_at = NOW(), outbox_id = $2
        WHERE id = ANY($1::uuid[])`,
      [events.map((e) => e.id), outboxId]
    );

    await client.query('COMMIT');
    return {
      outcome: message ? 'queued' : 'empty',
      template: message?.template || null,
      outboxId,
      events: events.length,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * One pass of the timer. Returns a tally, which is what the tests assert on.
 *
 * Runs whether or not digests are switched on, so events recorded before a
 * switch-off still go out. A group that fails is logged and left open for the
 * next pass; it does not stop the groups behind it.
 */
export async function flushDueDigests({
  pool = defaultPool,
  now = new Date(),
  env = process.env,
  limit = FLUSH_BATCH,
} = {}) {
  const config = sessionDigestConfig(env);
  const at = now.getTime();
  const quietCutoff = new Date(at - config.quietMinutes * 60_000);
  const holdCutoff = new Date(at - config.maxHoldMinutes * 60_000);

  const { rows: groups } = await pool.query(DUE_GROUPS_SQL, [quietCutoff, holdCutoff, limit]);
  const tally = { groups: groups.length, queued: 0, empty: 0, skipped: 0, failed: 0 };

  for (const group of groups) {
    try {
      const result = await flushGroup(pool, group, { now, config, env });
      if (result.outcome === 'queued') tally.queued++;
      else if (result.outcome === 'empty') tally.empty++;
      else tally.skipped++;
    } catch (err) {
      tally.failed++;
      console.error(
        `[digests] Could not close the ${group.family} digest for ${group.recipient}: ${err.message}`
      );
    }
  }

  return tally;
}

/**
 * Open digest groups for one address, for `GET /maintenance/email-status`.
 *
 * During a quiet period the outbox has nothing for the address yet, which
 * without this would read as "nothing was ever going to be sent" — the
 * confusion that endpoint exists to end (HANDOVER-CW015 §2A).
 */
export async function pendingDigestsFor(email, { pool = defaultPool } = {}) {
  const { rows } = await pool.query(
    `SELECT family, company_id,
            COUNT(*)::int   AS event_count,
            MIN(created_at) AS first_event_at,
            MAX(created_at) AS last_event_at
       FROM notification_digest_events
      WHERE recipient = $1 AND flushed_at IS NULL
      GROUP BY family, company_id
      ORDER BY MIN(created_at)`,
    [normaliseEmail(email)]
  );
  return rows;
}

// ---------------------------------------------------------------------------
// The timer
// ---------------------------------------------------------------------------

let timer = null;
let running = false;

/**
 * Start the flush timer. Mirrors `startOutboxWorker` and `startDigestWorker`:
 * a `running` guard so a slow pass cannot overlap the next, and `unref()` so a
 * test that starts it and forgets it does not hang the suite.
 */
export function startDigestFlushWorker({ intervalMs = FLUSH_INTERVAL_MS, ...opts } = {}) {
  if (timer) return timer;

  timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const tally = await flushDueDigests(opts);
      if (tally.queued || tally.failed) {
        console.log(
          `[digests] Closed ${tally.queued} digest(s)`
          + (tally.empty ? `, ${tally.empty} with nothing left to send` : '')
          + (tally.failed ? `, ${tally.failed} failed and left open` : '')
          + '.'
        );
      }
    } catch (err) {
      // The pass failing is not a digest failing: most likely the database is
      // briefly unreachable. The events are still there for the next tick.
      console.error('[digests] Flush pass failed:', err.message);
    } finally {
      running = false;
    }
  }, intervalMs);

  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

export function stopDigestFlushWorker() {
  if (timer) clearInterval(timer);
  timer = null;
  running = false;
}
