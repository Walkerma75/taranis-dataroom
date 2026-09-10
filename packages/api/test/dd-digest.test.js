/**
 * The daily outstanding-actions digest: when it fires, when it stays quiet, and
 * why it cannot send twice.
 *
 * The dates matter and are real days of the week. 2026-09-09 is a Wednesday,
 * 2026-09-05 a Saturday. Dubai is UTC+4, so 03:00 UTC is 07:00 local.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DIGEST_TEMPLATE,
  DIGEST_DEFAULTS,
  digestConfigFromEnv,
  localParts,
  localDateLabel,
  digestDedupeKey,
  isDigestWindow,
  companyLines,
  buildDigestPayload,
  runDigestOnce,
} from '../src/services/dd-digest.js';
import { buildSummary, AGE_DEFAULTS } from '../src/services/dd-summary.js';
import { fakePool } from './helpers/test-app.js';

const at = (iso) => new Date(iso);

/** 07:00 in Dubai on a Wednesday. */
const IN_WINDOW = at('2026-09-09T03:00:00Z');

const ENABLED = {
  DD_DIGEST_ENABLED: 'true',
  ADMIN_NOTIFICATION_EMAIL: 'admin@taraniscapital.com',
  PORTAL_URL: 'https://dataroom.taraniscapital.com',
};

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

test('the digest is off unless the flag says exactly true', () => {
  // The wording is a draft awaiting approval, so the flag is the thing standing
  // between it and somebody's inbox. A flag that could be switched on by a typo
  // would not be a gate.
  assert.equal(digestConfigFromEnv({}).enabled, false);
  assert.equal(digestConfigFromEnv({ DD_DIGEST_ENABLED: '' }).enabled, false);
  assert.equal(digestConfigFromEnv({ DD_DIGEST_ENABLED: '1' }).enabled, false);
  assert.equal(digestConfigFromEnv({ DD_DIGEST_ENABLED: 'yes' }).enabled, false);
  assert.equal(digestConfigFromEnv({ DD_DIGEST_ENABLED: 'TRUE' }).enabled, true);
  assert.equal(digestConfigFromEnv({ DD_DIGEST_ENABLED: 'true' }).enabled, true);
});

test('the defaults are 07:00 Dubai', () => {
  assert.equal(DIGEST_DEFAULTS.hourLocal, 7);
  assert.equal(DIGEST_DEFAULTS.utcOffsetHours, 4);
});

// ---------------------------------------------------------------------------
// Local time
// ---------------------------------------------------------------------------

test('local parts are the offset applied, not the container time zone', () => {
  const parts = localParts(IN_WINDOW, 4);
  assert.equal(parts.hour, 7);
  assert.equal(parts.day, 9);
  assert.equal(parts.weekday, 3); // Wednesday
});

test('the dedupe key is the LOCAL date, so a late evening in UTC is tomorrow', () => {
  assert.equal(digestDedupeKey(IN_WINDOW, 4), 'dd-digest:2026-09-09');
  // 21:00 UTC on the 8th is 01:00 on the 9th in Dubai.
  assert.equal(digestDedupeKey(at('2026-09-08T21:00:00Z'), 4), 'dd-digest:2026-09-09');
  assert.equal(digestDedupeKey(at('2026-09-08T19:59:00Z'), 4), 'dd-digest:2026-09-08');
});

test('the date in the message reads as a date and not a timestamp', () => {
  assert.equal(localDateLabel(IN_WINDOW, 4), '9 September 2026');
});

// ---------------------------------------------------------------------------
// The window
// ---------------------------------------------------------------------------

test('the window is the two hours from 07:00 local, on a weekday', () => {
  assert.equal(isDigestWindow(at('2026-09-09T02:59:00Z'), DIGEST_DEFAULTS), false); // 06:59
  assert.equal(isDigestWindow(at('2026-09-09T03:00:00Z'), DIGEST_DEFAULTS), true);  // 07:00
  assert.equal(isDigestWindow(at('2026-09-09T04:30:00Z'), DIGEST_DEFAULTS), true);  // 08:30
  assert.equal(isDigestWindow(at('2026-09-09T05:00:00Z'), DIGEST_DEFAULTS), false); // 09:00
});

test('no digest at the weekend, judged on the local day', () => {
  // Taranis-side ageing is in working days, so a Saturday message would report
  // Friday's figures and describe them as nought working days older.
  assert.equal(isDigestWindow(at('2026-09-05T03:00:00Z'), DIGEST_DEFAULTS), false); // Saturday
  assert.equal(isDigestWindow(at('2026-09-06T03:00:00Z'), DIGEST_DEFAULTS), false); // Sunday
  assert.equal(isDigestWindow(at('2026-09-07T03:00:00Z'), DIGEST_DEFAULTS), true);  // Monday
});

// ---------------------------------------------------------------------------
// The message
// ---------------------------------------------------------------------------

const NOW = IN_WINDOW;

function summaryWith(fileGroups, companyOverrides = {}) {
  return buildSummary(
    {
      companies: [{
        id: 'c-1',
        legalName: 'Example Bio Ltd',
        fundId: 'f-1',
        fundName: 'Biotech KSA',
        itemCount: 146,
        countableCount: 143,
        completedCount: 3,
        unstartedCount: 140,
        lastActivity: '2026-09-02T09:00:00Z',
        ...companyOverrides,
      }],
      fileGroups,
      activity: [],
    },
    { now: NOW, thresholds: AGE_DEFAULTS }
  );
}

test('a company line names both sides, what they are made of, and the age', () => {
  const summary = summaryWith([
    { companyId: 'c-1', status: 'received', fileCount: 2, oldestSince: '2026-09-02T09:00:00Z' },
    { companyId: 'c-1', status: 'in_review', fileCount: 1, oldestSince: '2026-09-08T09:00:00Z' },
    { companyId: 'c-1', status: 'attention_needed', fileCount: 1, oldestSince: '2026-09-01T09:00:00Z' },
  ]);

  const [line] = companyLines(summary);

  // The clock is 07:00 Dubai, which is 03:00 UTC, so a file first seen at 09:00
  // on Wednesday the 2nd is four whole working days old and not five.
  assert.match(line, /^Example Bio Ltd, Biotech KSA: /);
  assert.match(line, /3 awaiting Taranis \(2 to open, 1 in review\), oldest 4 working days, red/);
  assert.match(line, /141 awaiting the company \(1 needing attention, 140 not started\)/);
  assert.match(line, /oldest 7 calendar days, red/);
  assert.match(line, /3 of 143 items completed/);
  // UK English and no em dashes in anything that reaches a person.
  assert.equal(line.includes('—'), false);
});

test('a company with nothing outstanding is left out of the message entirely', () => {
  const summary = summaryWith([], { unstartedCount: 0, completedCount: 143 });
  assert.deepEqual(companyLines(summary), []);
});

test('the payload carries the counts, the lines, the thresholds and the link', () => {
  const summary = summaryWith([
    { companyId: 'c-1', status: 'received', fileCount: 2, oldestSince: '2026-09-08T09:00:00Z' },
  ]);
  const payload = buildDigestPayload(summary, { now: NOW, env: ENABLED });

  assert.equal(payload.awaiting_taranis_count, 2);
  assert.equal(payload.awaiting_company_count, 140);
  assert.equal(payload.digest_date, '9 September 2026');
  assert.equal(payload.taranis_red_days, 3);
  assert.equal(payload.company_red_days, 7);
  assert.equal(payload.dashboard_url, 'https://dataroom.taraniscapital.com/dashboard');
  assert.equal(payload.company_lines.length, 1);
});

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/**
 * A pool answering the three summary queries, plus the outbox insert.
 *
 * `outbox` is either the row a successful insert returns, or an empty result,
 * which is what `ON CONFLICT DO NOTHING` produces when today's digest is
 * already queued.
 */
function digestPool({ outstanding = true, outbox = [{ id: 'outbox-1' }] } = {}) {
  return fakePool([
    ['unstarted_count', [{
      id: 'c-1',
      legal_name: 'Example Bio Ltd',
      fund_id: 'f-1',
      fund_name: 'Biotech KSA',
      item_count: '146',
      countable_count: '143',
      completed_count: outstanding ? '3' : '143',
      unstarted_count: outstanding ? '140' : '0',
      last_activity: '2026-09-08T09:00:00Z',
    }]],
    ['GROUP BY f.company_id, f.status', outstanding
      ? [{
        company_id: 'c-1',
        status: 'received',
        file_count: 2,
        oldest_since: '2026-09-02T09:00:00Z',
      }]
      : []],
    ["'upload' AS kind", []],
    ['INSERT INTO notification_outbox', outbox],
  ]);
}

test('nothing is queued while the flag is off, and nothing is even read', async () => {
  const db = digestPool();
  const result = await runDigestOnce({ db, now: NOW, env: {} });

  assert.deepEqual(result, { queued: false, reason: 'disabled' });
  // The flag and the window are checked before the summary is loaded, so a
  // deployment with the digest off runs these queries never rather than every
  // five minutes for ever.
  assert.equal(db.calls.length, 0);
});

test('nothing is queued outside the window', async () => {
  const db = digestPool();
  const result = await runDigestOnce({ db, now: at('2026-09-09T09:00:00Z'), env: ENABLED });

  assert.deepEqual(result, { queued: false, reason: 'outside-window' });
  assert.equal(db.calls.length, 0);
});

test('nothing is queued when both buckets are clear', async () => {
  // CW020 §3.5. A daily message saying there is nothing to do trains the reader
  // to ignore the one that says there is.
  const db = digestPool({ outstanding: false });
  const result = await runDigestOnce({ db, now: NOW, env: ENABLED });

  assert.deepEqual(result, { queued: false, reason: 'clear' });
  assert.equal(db.sql().some((s) => s.includes('INSERT INTO notification_outbox')), false);
});

test('an outstanding morning queues one digest, to the admin address, with a dedupe key', async () => {
  const db = digestPool();
  const result = await runDigestOnce({ db, now: NOW, env: ENABLED });

  assert.equal(result.queued, true);
  assert.equal(result.reason, 'queued');

  const insert = db.calls.find((c) => c.text.includes('INSERT INTO notification_outbox'));
  assert.ok(insert, 'nothing was queued');

  const [template, recipient, payload, dedupeKey] = insert.params;
  assert.equal(template, DIGEST_TEMPLATE);
  assert.equal(recipient, 'admin@taraniscapital.com');
  assert.equal(dedupeKey, 'dd-digest:2026-09-09');
  assert.equal(JSON.parse(payload).awaiting_taranis_count, 2);

  // The conflict target has to name the partial index's predicate as well as
  // its column, or PostgreSQL cannot match a partial index at all.
  assert.match(insert.text, /ON CONFLICT \(dedupe_key\) WHERE dedupe_key IS NOT NULL DO NOTHING/);
});

test('a second run on the same local day queues nothing and does not call it a failure', async () => {
  // This is what a task restart after 07:00, or the overlap during a rolling
  // deploy, actually looks like: the insert runs and the unique index throws it
  // away. The caller must read that as the mechanism working.
  const db = digestPool({ outbox: [] });
  const result = await runDigestOnce({ db, now: NOW, env: ENABLED });

  assert.deepEqual(result, { queued: false, reason: 'already-queued' });
});

test('the digest is queued through the outbox and never sent inline', async () => {
  const db = digestPool();
  await runDigestOnce({ db, now: NOW, env: ENABLED });

  // Routes queue, only the worker sends. The digest is not a route, but it is
  // subject to the same rule: nothing here may reach SES.
  const inserts = db.sql().filter((s) => s.includes('INSERT INTO notification_outbox'));
  assert.equal(inserts.length, 1);
});
