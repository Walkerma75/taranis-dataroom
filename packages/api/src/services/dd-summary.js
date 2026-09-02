/**
 * Outstanding due diligence actions: which side owes the next move, and how
 * long they have owed it.
 *
 * ---------------------------------------------------------------------------
 * WHY EVERYTHING HERE IS A PURE FUNCTION
 * ---------------------------------------------------------------------------
 * Two reasons, and both of them decided the shape of this module.
 *
 * The first is testing. The API suite runs with no database: `fakePool()` in
 * `test/helpers/test-app.js` matches on fragments of SQL text and hands back
 * canned rows, so SQL is never executed. A bucket rule or an ageing threshold
 * expressed in a CASE statement could not be tested at all — the test would
 * assert against rows it had written itself. So the queries return raw
 * timestamps and counts, and every judgement about what those mean is made
 * here, over plain objects, against a clock the caller passes in.
 *
 * The second is CW016. The autonomous onboarding agent is to raise its own
 * threshold alerts, and CW020 §5 requires it to read the same rules rather than
 * restate them. A second implementation that drifted would have two answers to
 * "is this company late", which is worse than having none.
 *
 * ---------------------------------------------------------------------------
 * THE TWO BUCKETS
 * ---------------------------------------------------------------------------
 * Everything outstanding belongs to exactly one side:
 *
 *   awaitingTaranis   a submitted file at 'received' or 'in_review'. The
 *                     company has done its part and is waiting on us.
 *   awaitingCompany   a submitted file at 'attention_needed', plus checklist
 *                     items nobody has uploaded anything against.
 *
 * 'completed' and 'superseded' are in neither, and 'superseded' has to be
 * excluded deliberately rather than by omission: a version a newer one has
 * overtaken is not awaiting anything from anyone, which is the whole reason
 * CW010 introduced it. Staged files are in neither either — staging is not a
 * submission, and a company can still withdraw it.
 *
 * ---------------------------------------------------------------------------
 * AGEING, AND THE THING THAT IS DELIBERATELY NOT AGED
 * ---------------------------------------------------------------------------
 * Taranis-side ages in WORKING days (Mon-Fri), company-side in CALENDAR days,
 * per CW020 §3.2. Both measure from the moment the item entered the state it is
 * in now, which for a file is its most recent `file_status_history` row.
 *
 * Checklist items nobody has uploaded against are COUNTED in the company bucket
 * and NOT AGED. This is Mark's decision of 2 September 2026 (HANDOVER-C020 D2)
 * and it is the difference between an alert and a nuisance. An outstanding item
 * has no "asked on" date: its only timestamps are `created_at`, stamped when
 * activation seeded the whole checklist in one go, and `updated_at`. Ageing
 * from those would have put every one of AdrenoMed's ~140 untouched items past
 * the 7-day red threshold on the day this shipped, and left the tile red for
 * ever. So the red flag here means one thing only: we asked this company a
 * specific question, in writing, on a date, and have heard nothing back.
 *
 * ---------------------------------------------------------------------------
 * TIME ZONE
 * ---------------------------------------------------------------------------
 * Weekends are read in UTC, like every other timestamp this platform reasons
 * about (receipts, submission times, `formatUtc` on the web side). Dubai is
 * UTC+4, so a Friday evening in Dubai is still Friday in UTC and the boundary
 * moves by at most a few hours. Introducing a second time base for this one
 * calculation would buy less than it cost.
 *
 * ---------------------------------------------------------------------------
 * THE ONE FUNCTION THAT TOUCHES THE DATABASE
 * ---------------------------------------------------------------------------
 * `loadSummary()` at the foot of this file runs the three queries and hands
 * their rows to `buildSummary()`. It lives here rather than in the route
 * because the daily digest needs the same summary and a service importing a
 * route module would be backwards. It takes its client as a parameter, which is
 * the same arrangement `services/companies.js` uses for `recomputeItemState()`.
 */
import { pool } from '../db.js';

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

/**
 * CW020 §3.2. Taranis-side is tighter than company-side on purpose: the pilot
 * has few companies and moves fast, and the side that can always act within a
 * day is ours.
 */
export const AGE_DEFAULTS = {
  taranisAmberDays: 1,
  taranisRedDays: 3,
  companyAmberDays: 3,
  companyRedDays: 7,
};

/** A positive integer from the environment, or the default. Never NaN. */
function positiveInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function thresholdsFromEnv(env = process.env) {
  return {
    taranisAmberDays: positiveInt(env.DD_AGE_TARANIS_AMBER_DAYS, AGE_DEFAULTS.taranisAmberDays),
    taranisRedDays: positiveInt(env.DD_AGE_TARANIS_RED_DAYS, AGE_DEFAULTS.taranisRedDays),
    companyAmberDays: positiveInt(env.DD_AGE_COMPANY_AMBER_DAYS, AGE_DEFAULTS.companyAmberDays),
    companyRedDays: positiveInt(env.DD_AGE_COMPANY_RED_DAYS, AGE_DEFAULTS.companyRedDays),
  };
}

// ---------------------------------------------------------------------------
// Levels
// ---------------------------------------------------------------------------

export const LEVEL_NONE = 'none';
export const LEVEL_AMBER = 'amber';
export const LEVEL_RED = 'red';

const LEVEL_RANK = { [LEVEL_NONE]: 0, [LEVEL_AMBER]: 1, [LEVEL_RED]: 2 };

/** The worst level in a list. Nothing at all is 'none', not an error. */
export function worstLevel(levels = []) {
  return levels.reduce(
    (worst, level) => (LEVEL_RANK[level] > LEVEL_RANK[worst] ? level : worst),
    LEVEL_NONE
  );
}

// ---------------------------------------------------------------------------
// Day arithmetic
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

/** Saturday or Sunday, in UTC. See the module header on the time base. */
export function isWeekend(date) {
  const day = date.getUTCDay();
  return day === 0 || day === 6;
}

/**
 * The instant `n` whole calendar days after `from`.
 */
export function addCalendarDays(from, n) {
  return new Date(from.getTime() + n * DAY_MS);
}

/**
 * The instant `n` whole WORKING days after `from`, preserving the time of day.
 *
 * Worked example, because this is the rule the acceptance test turns on:
 * a file submitted Friday at 16:00 is one working day old on MONDAY at 16:00,
 * not on Saturday. Three working days old on Wednesday at 16:00.
 *
 * A start that falls on a weekend is moved to the following Monday at the same
 * time first: a company that submits on a Sunday has not used up any of our
 * response time by doing so.
 */
export function addWorkingDays(from, n) {
  let cursor = new Date(from.getTime());

  // Move a weekend start onto Monday before counting anything.
  while (isWeekend(cursor)) {
    cursor = new Date(cursor.getTime() + DAY_MS);
  }

  let added = 0;
  while (added < n) {
    cursor = new Date(cursor.getTime() + DAY_MS);
    if (!isWeekend(cursor)) added += 1;
  }
  return cursor;
}

/**
 * Whole working days elapsed between two instants. Reported alongside the level
 * so a card can say "3 working days" without the browser doing date arithmetic,
 * which is CW020 §3.1's explicit requirement.
 */
export function workingDaysElapsed(from, to) {
  if (!from || !to || to <= from) return 0;
  let days = 0;
  // Cheap enough: nothing in this system is outstanding for thousands of days,
  // and the loop stops as soon as it overshoots.
  while (addWorkingDays(from, days + 1) <= to) days += 1;
  return days;
}

export function calendarDaysElapsed(from, to) {
  if (!from || !to || to <= from) return 0;
  return Math.floor((to.getTime() - from.getTime()) / DAY_MS);
}

/**
 * The ageing level of something that has been waiting since `since`.
 *
 * `unit` is 'working' or 'calendar'. Returns 'none' for anything with no
 * timestamp, which is the honest answer for an item that was never dated rather
 * than a silent zero.
 */
export function ageLevel(since, now, { amberDays, redDays, unit = 'working' } = {}) {
  if (!since) return LEVEL_NONE;

  const from = since instanceof Date ? since : new Date(since);
  if (Number.isNaN(from.getTime())) return LEVEL_NONE;

  const add = unit === 'calendar' ? addCalendarDays : addWorkingDays;

  if (now >= add(from, redDays)) return LEVEL_RED;
  if (now >= add(from, amberDays)) return LEVEL_AMBER;
  return LEVEL_NONE;
}

/** Both halves of what the UI shows about an age, computed once. */
export function ageOf(since, now, { amberDays, redDays, unit }) {
  if (!since) return { since: null, days: 0, level: LEVEL_NONE };

  const from = since instanceof Date ? since : new Date(since);
  if (Number.isNaN(from.getTime())) return { since: null, days: 0, level: LEVEL_NONE };

  const elapsed = unit === 'calendar'
    ? calendarDaysElapsed(from, now)
    : workingDaysElapsed(from, now);

  return {
    since: from.toISOString(),
    days: elapsed,
    level: ageLevel(from, now, { amberDays, redDays, unit }),
  };
}

// ---------------------------------------------------------------------------
// Buckets
// ---------------------------------------------------------------------------

export const AWAITING_TARANIS_STATUSES = ['received', 'in_review'];
export const AWAITING_COMPANY_STATUSES = ['attention_needed'];

/**
 * Checklist item states that mean the company still owes something and nothing
 * submitted counts towards it yet.
 *
 * 'held' and 'not_applicable' are excluded because neither is work anyone has
 * to do, which is the same rule `summariseProgress()` applies to the progress
 * denominator. The derived states are excluded because a file exists for them
 * and it is that file, not the item, that sits in a bucket.
 */
export const UNSTARTED_ITEM_STATES = ['outstanding', 'partially_held'];

export const BUCKET_TARANIS = 'awaitingTaranis';
export const BUCKET_COMPANY = 'awaitingCompany';

/**
 * Which bucket a submitted file's status puts it in, or null for neither.
 *
 * Takes the status rather than the row so the answer cannot depend on anything
 * that is not the status. The caller has already excluded staged and deleted
 * rows; this decides only the four outcomes that survive that.
 */
export function bucketOf(status) {
  if (AWAITING_TARANIS_STATUSES.includes(status)) return BUCKET_TARANIS;
  if (AWAITING_COMPANY_STATUSES.includes(status)) return BUCKET_COMPANY;
  return null;
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

/**
 * The progress fraction, on the same denominator the company's own workspace
 * and the Excel exports use: `not_applicable` and `held` are excluded, because
 * neither is work anyone still has to do (Mark's decision, HANDOVER-C020 D4).
 *
 * The alternative was the raw item count the pipeline table shows, which would
 * have made the dashboard say 3 of 146 while the GAPS sheet issued to the same
 * company said 3 of 143.
 */
export function progressOf({ countableCount, completedCount, itemCount }) {
  const countable = Number(countableCount) || 0;
  const completed = Number(completedCount) || 0;
  return {
    completed,
    countable,
    total: Number(itemCount) || 0,
    percentComplete: countable === 0 ? 0 : Math.round((completed / countable) * 100),
  };
}

// ---------------------------------------------------------------------------
// Shaping
// ---------------------------------------------------------------------------

/** Sort key: red first, then amber, then most recently active. */
function companyOrder(a, b) {
  const byLevel = LEVEL_RANK[b.level] - LEVEL_RANK[a.level];
  if (byLevel !== 0) return byLevel;

  const at = a.lastActivity ? new Date(a.lastActivity).getTime() : 0;
  const bt = b.lastActivity ? new Date(b.lastActivity).getTime() : 0;
  return bt - at;
}

/** The oldest of a set of timestamps, or null. */
function oldest(values) {
  const times = values
    .filter(Boolean)
    .map((v) => (v instanceof Date ? v : new Date(v)))
    .filter((d) => !Number.isNaN(d.getTime()));
  if (times.length === 0) return null;
  return new Date(Math.min(...times.map((d) => d.getTime())));
}

/**
 * Build the whole summary from raw rows.
 *
 * @param {object} rows
 *   `companies`  one row per ACTIVE company, with its checklist counts and last
 *                activity. Pending, suspended and offboarded companies are
 *                excluded by the query, not here: a pending company has no
 *                checklist at all, and a suspended or offboarded one cannot be
 *                acted on by either side (HANDOVER-C020 §5).
 *   `fileGroups` one row per (company, status) with a count and the oldest
 *                "entered this status" timestamp in the group.
 *   `activity`   the recent event rows, already ordered and limited.
 * @param {object} options `now` (a Date) and `thresholds`.
 */
export function buildSummary(
  { companies = [], fileGroups = [], activity = [] } = {},
  { now = new Date(), thresholds = AGE_DEFAULTS } = {}
) {
  const taranisAge = {
    amberDays: thresholds.taranisAmberDays,
    redDays: thresholds.taranisRedDays,
    unit: 'working',
  };
  const companyAge = {
    amberDays: thresholds.companyAmberDays,
    redDays: thresholds.companyRedDays,
    unit: 'calendar',
  };

  // Index the file groups by company, so the shaping below is one pass and not
  // a scan per company.
  const byCompany = new Map();
  for (const group of fileGroups) {
    const key = String(group.companyId);
    if (!byCompany.has(key)) byCompany.set(key, []);
    byCompany.get(key).push(group);
  }

  const shaped = companies.map((company) => {
    const groups = byCompany.get(String(company.id)) || [];

    // The two Taranis-side statuses are reported separately as well as summed.
    // The review queue is 'received' only, so a single figure would send an
    // admin to a screen showing fewer rows than the number they clicked
    // (Mark's decision, HANDOVER-C020 D3).
    const received = groups.find((g) => g.status === 'received');
    const inReview = groups.find((g) => g.status === 'in_review');
    const attention = groups.find((g) => g.status === 'attention_needed');

    const receivedCount = Number(received?.fileCount) || 0;
    const inReviewCount = Number(inReview?.fileCount) || 0;
    const attentionCount = Number(attention?.fileCount) || 0;
    const unstartedItems = Number(company.unstartedCount) || 0;

    const taranisSince = oldest([received?.oldestSince, inReview?.oldestSince]);
    const companySince = attention?.oldestSince ? new Date(attention.oldestSince) : null;

    const awaitingTaranis = {
      total: receivedCount + inReviewCount,
      received: receivedCount,
      inReview: inReviewCount,
      ...ageOf(taranisSince, now, taranisAge),
    };

    const awaitingCompany = {
      total: attentionCount + unstartedItems,
      attentionFiles: attentionCount,
      // Counted, never aged. See the module header.
      unstartedItems,
      ...ageOf(companySince, now, companyAge),
    };

    return {
      id: company.id,
      name: company.legalName,
      fundId: company.fundId,
      fundName: company.fundName,
      awaitingTaranis,
      awaitingCompany,
      irl: progressOf(company),
      level: worstLevel([awaitingTaranis.level, awaitingCompany.level]),
      lastActivity: company.lastActivity
        ? new Date(company.lastActivity).toISOString()
        : null,
    };
  });

  shaped.sort(companyOrder);

  const totals = (key, fields) => {
    const out = {};
    for (const field of fields) {
      out[field] = shaped.reduce((sum, c) => sum + c[key][field], 0);
    }
    return out;
  };

  const taranisTotals = totals('awaitingTaranis', ['total', 'received', 'inReview']);
  const companyTotals = totals('awaitingCompany', ['total', 'attentionFiles', 'unstartedItems']);

  return {
    generatedAt: now.toISOString(),
    thresholds,
    awaitingTaranis: {
      ...taranisTotals,
      ...ageOf(oldest(shaped.map((c) => c.awaitingTaranis.since)), now, taranisAge),
    },
    awaitingCompany: {
      ...companyTotals,
      ...ageOf(oldest(shaped.map((c) => c.awaitingCompany.since)), now, companyAge),
    },
    companies: shaped,
    recentActivity: activity,
  };
}

/** True when there is nothing for anyone to do. Used to suppress the digest. */
export function isClear(summary) {
  return (summary?.awaitingTaranis?.total || 0) === 0
      && (summary?.awaitingCompany?.total || 0) === 0;
}

// ---------------------------------------------------------------------------
// The queries
//
// Three of them, whatever the size of the cohort. CW020 §5 asks for a single
// cheap query set rather than N+1 per company, because the number of companies
// is the number expected to grow.
// ---------------------------------------------------------------------------

/** How many events the recent activity list carries. CW020 §3.1. */
export const ACTIVITY_LIMIT = 10;

/**
 * Every active company, with its checklist counts and its last activity.
 *
 * ONLY ACTIVE. A pending company has no checklist at all, because seeding
 * happens at activation, so it would contribute a row of zeroes and nothing
 * else. Suspended and offboarded companies have had their access closed, so
 * neither side can act on them and an outstanding action against one is not
 * outstanding in any useful sense (Mark's decision, 2 September 2026).
 *
 * `last_activity` is the max over company uploads and formal submissions, both
 * of which are company-side actions. The pipeline list computes uploads only,
 * which misses a submission that adds no new file; the two are allowed to
 * differ because they answer different questions, and this one is the one
 * CW020 §3.1 asked for ("last company activity"). GREATEST ignores NULLs in
 * PostgreSQL, so a company with uploads but no submissions still reports its
 * uploads rather than nothing.
 */
const COMPANIES_SQL = `
  SELECT c.id, c.legal_name, c.fund_id, f.name AS fund_name,
         (SELECT COUNT(*) FROM company_irl_items i
           WHERE i.company_id = c.id)                                 AS item_count,
         (SELECT COUNT(*) FROM company_irl_items i
           WHERE i.company_id = c.id
             AND i.state NOT IN ('not_applicable', 'held'))           AS countable_count,
         (SELECT COUNT(*) FROM company_irl_items i
           WHERE i.company_id = c.id AND i.state = 'completed')       AS completed_count,
         (SELECT COUNT(*) FROM company_irl_items i
           WHERE i.company_id = c.id
             AND i.state = ANY($1::irl_item_state[]))                 AS unstarted_count,
         GREATEST(
           (SELECT MAX(cf.created_at) FROM company_files cf
             WHERE cf.company_id = c.id AND cf.deleted_at IS NULL),
           (SELECT MAX(b.submitted_at) FROM submission_batches b
             WHERE b.company_id = c.id)
         )                                                            AS last_activity
    FROM companies c
    JOIN funds f ON f.id = c.fund_id
   WHERE c.status = 'active'
   ORDER BY f.name, c.legal_name`;

/**
 * Submitted files that are still owed by someone, counted per company and
 * status, with the oldest "entered this status" moment in each group.
 *
 * MEASURING FROM THE STATUS CHANGE, NOT THE UPLOAD. A file uploaded a month ago
 * and marked `attention_needed` yesterday has been owed by the company for one
 * day, not thirty. `file_status_history` is where that moment lives, and the
 * lateral takes the most recent entry for the status the file is actually in,
 * so a file that went received -> attention_needed -> received (a replacement
 * arriving) ages from the latest move and not the first.
 *
 * COALESCE to the upload timestamp covers the theoretical row with no history.
 * Every path that submits or changes a status writes history in the same
 * transaction, so this should never fire; a file silently ageing from nothing
 * would be worse than one ageing from slightly too early.
 *
 * 'completed' and 'superseded' are excluded by the status filter, staged files
 * by `upload_state`, and deleted ones by `deleted_at`.
 */
const FILE_GROUPS_SQL = `
  SELECT f.company_id, f.status::text AS status,
         COUNT(*)::int AS file_count,
         MIN(COALESCE(h.since, f.created_at)) AS oldest_since
    FROM company_files f
    JOIN companies c ON c.id = f.company_id AND c.status = 'active'
    LEFT JOIN LATERAL (
      SELECT MAX(sh.created_at) AS since
        FROM file_status_history sh
       WHERE sh.file_id = f.id AND sh.status = f.status
    ) h ON TRUE
   WHERE f.upload_state = 'submitted'
     AND f.deleted_at IS NULL
     AND f.status = ANY($1::file_status[])
   GROUP BY f.company_id, f.status`;

/**
 * The last few things that happened, across every active company.
 *
 * Three sources unioned: an upload, a formal submission, and a status change.
 * There is no fourth. CW020 §3.1 also asks for company comments, and comments
 * do not exist in this platform in any form (HANDOVER-C020 §3.3).
 *
 * `actorSide` is derived from the actor's own role rather than from which table
 * the event came out of, because the two do not line up: the opening 'received'
 * row in `file_status_history` is written with the submitting company
 * administrator's id, so reading it as a Taranis action would credit us with
 * the company's own submission.
 *
 * Each arm is limited before the union so the database never sorts the whole
 * history of the platform to return ten rows.
 */
const ACTIVITY_SQL = `
  (SELECT 'upload' AS kind, f.created_at AS at, f.company_id, c.legal_name,
          f.filename AS subject, i.ref AS item_ref, NULL::text AS detail,
          u.role::text AS actor_role, u.display_name AS actor_name
     FROM company_files f
     JOIN companies c ON c.id = f.company_id AND c.status = 'active'
     JOIN users u ON u.id = f.uploaded_by
     LEFT JOIN company_irl_items i ON i.id = f.irl_item_id
    WHERE f.deleted_at IS NULL
    ORDER BY f.created_at DESC
    LIMIT $1)
  UNION ALL
  (SELECT 'submission', b.submitted_at, b.company_id, c.legal_name,
          b.receipt_ref, NULL, NULL,
          u.role::text, u.display_name
     FROM submission_batches b
     JOIN companies c ON c.id = b.company_id AND c.status = 'active'
     JOIN users u ON u.id = b.submitted_by
    ORDER BY b.submitted_at DESC
    LIMIT $1)
  UNION ALL
  (SELECT 'status', sh.created_at, f.company_id, c.legal_name,
          f.filename, i.ref, sh.status::text,
          u.role::text, u.display_name
     FROM file_status_history sh
     JOIN company_files f ON f.id = sh.file_id AND f.deleted_at IS NULL
     JOIN companies c ON c.id = f.company_id AND c.status = 'active'
     JOIN users u ON u.id = sh.set_by
     LEFT JOIN company_irl_items i ON i.id = f.irl_item_id
    ORDER BY sh.created_at DESC
    LIMIT $1)
  ORDER BY at DESC
  LIMIT $1`;

/** Run the three queries and shape the result. */
export async function loadSummary({ db = pool, now = new Date(), env = process.env } = {}) {
  const trackedStatuses = [...AWAITING_TARANIS_STATUSES, ...AWAITING_COMPANY_STATUSES];

  const [companies, fileGroups, activity] = await Promise.all([
    db.query(COMPANIES_SQL, [UNSTARTED_ITEM_STATES]),
    db.query(FILE_GROUPS_SQL, [trackedStatuses]),
    db.query(ACTIVITY_SQL, [ACTIVITY_LIMIT]),
  ]);

  return buildSummary(
    {
      companies: companies.rows.map((c) => ({
        id: c.id,
        legalName: c.legal_name,
        fundId: c.fund_id,
        fundName: c.fund_name,
        itemCount: Number(c.item_count),
        countableCount: Number(c.countable_count),
        completedCount: Number(c.completed_count),
        unstartedCount: Number(c.unstarted_count),
        lastActivity: c.last_activity,
      })),
      fileGroups: fileGroups.rows.map((g) => ({
        companyId: g.company_id,
        status: g.status,
        fileCount: Number(g.file_count),
        oldestSince: g.oldest_since,
      })),
      activity: activity.rows.map((a) => ({
        kind: a.kind,
        at: a.at,
        companyId: a.company_id,
        companyName: a.legal_name,
        subject: a.subject,
        itemRef: a.item_ref,
        detail: a.detail,
        actorName: a.actor_name,
        // The one thing the dashboard actually renders about the actor: which
        // side of the exchange moved.
        actorSide: a.actor_role === 'company' ? 'company' : 'taranis',
      })),
    },
    { now, thresholds: thresholdsFromEnv(env) }
  );
}
