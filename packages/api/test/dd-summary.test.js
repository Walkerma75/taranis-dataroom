/**
 * Outstanding due diligence actions: the buckets, the ageing, and who may ask.
 *
 * The rules are all pure functions with an injected clock, which is what makes
 * this file possible at all: the suite has no database, so a bucket rule or a
 * threshold expressed in SQL could only ever be tested against rows the test
 * had written itself. See the header of `services/dd-summary.js`.
 *
 * The dates below are real days of the week and the tests depend on that.
 * 2026-09-02 is a Wednesday; 2026-09-04 is a Friday; 2026-09-05 and 06 are the
 * weekend; 2026-09-07 is the Monday after.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AGE_DEFAULTS,
  thresholdsFromEnv,
  worstLevel,
  isWeekend,
  addWorkingDays,
  addCalendarDays,
  workingDaysElapsed,
  ageLevel,
  ageOf,
  bucketOf,
  progressOf,
  buildSummary,
  isClear,
  BUCKET_TARANIS,
  BUCKET_COMPANY,
  UNSTARTED_ITEM_STATES,
} from '../src/services/dd-summary.js';

import ddSummaryRouter from '../src/routes/dd-summary.js';
import { fakePool, startTestServer, tokenFor } from './helpers/test-app.js';

const at = (iso) => new Date(iso);

const TARANIS_AGE = { amberDays: 1, redDays: 3, unit: 'working' };
const COMPANY_AGE = { amberDays: 3, redDays: 7, unit: 'calendar' };

// ---------------------------------------------------------------------------
// Buckets
// ---------------------------------------------------------------------------

test('a submitted file lands in the bucket for the side that owes the next move', () => {
  assert.equal(bucketOf('received'), BUCKET_TARANIS);
  assert.equal(bucketOf('in_review'), BUCKET_TARANIS);
  assert.equal(bucketOf('attention_needed'), BUCKET_COMPANY);
});

test('completed and superseded are in neither bucket', () => {
  // 'superseded' has to be excluded deliberately: a version a newer one has
  // overtaken is not awaiting anything from anyone, which is the whole reason
  // CW010 introduced the status. Counting it would put a company back in the
  // amber column for a correction it had already sent.
  assert.equal(bucketOf('completed'), null);
  assert.equal(bucketOf('superseded'), null);
  assert.equal(bucketOf(undefined), null);
});

test('the states counted as unstarted are the two the company still owes', () => {
  // 'held' and 'not_applicable' are not work anyone has to do, and the derived
  // states mean a file exists, in which case it is the file that sits in a
  // bucket and not the item.
  assert.deepEqual(UNSTARTED_ITEM_STATES, ['outstanding', 'partially_held']);
});

// ---------------------------------------------------------------------------
// Working days
// ---------------------------------------------------------------------------

test('weekends are Saturday and Sunday', () => {
  assert.equal(isWeekend(at('2026-09-04T12:00:00Z')), false); // Friday
  assert.equal(isWeekend(at('2026-09-05T12:00:00Z')), true);  // Saturday
  assert.equal(isWeekend(at('2026-09-06T12:00:00Z')), true);  // Sunday
  assert.equal(isWeekend(at('2026-09-07T12:00:00Z')), false); // Monday
});

test('one working day after Friday afternoon is Monday afternoon', () => {
  // The case the whole rule exists for. Counted in calendar days a Friday
  // submission is three days old by Monday and would already be red.
  assert.deepEqual(
    addWorkingDays(at('2026-09-04T16:00:00Z'), 1),
    at('2026-09-07T16:00:00Z')
  );
  assert.deepEqual(
    addWorkingDays(at('2026-09-04T16:00:00Z'), 3),
    at('2026-09-09T16:00:00Z') // the Wednesday
  );
});

test('a weekend start is moved to the Monday before counting', () => {
  // A company that submits on a Sunday has not used up any of our response
  // time by doing so.
  assert.deepEqual(
    addWorkingDays(at('2026-09-06T09:00:00Z'), 1), // Sunday
    at('2026-09-08T09:00:00Z')                    // Tuesday, one day after Monday
  );
});

test('working days elapsed reads back what adding them produced', () => {
  assert.equal(workingDaysElapsed(at('2026-09-04T16:00:00Z'), at('2026-09-07T16:00:00Z')), 1);
  assert.equal(workingDaysElapsed(at('2026-09-04T16:00:00Z'), at('2026-09-07T15:59:00Z')), 0);
  assert.equal(workingDaysElapsed(at('2026-09-04T16:00:00Z'), at('2026-09-09T16:00:00Z')), 3);
  assert.equal(workingDaysElapsed(at('2026-09-09T16:00:00Z'), at('2026-09-04T16:00:00Z')), 0);
});

test('calendar days ignore the weekend entirely', () => {
  assert.deepEqual(
    addCalendarDays(at('2026-09-04T16:00:00Z'), 3),
    at('2026-09-07T16:00:00Z')
  );
});

// ---------------------------------------------------------------------------
// Ageing boundaries
// ---------------------------------------------------------------------------

test('Taranis-side: amber at one working day, red at three, exactly on the boundary', () => {
  const since = at('2026-09-02T09:00:00Z'); // Wednesday

  assert.equal(ageLevel(since, at('2026-09-03T08:59:00Z'), TARANIS_AGE), 'none');
  assert.equal(ageLevel(since, at('2026-09-03T09:00:00Z'), TARANIS_AGE), 'amber');
  assert.equal(ageLevel(since, at('2026-09-07T08:59:00Z'), TARANIS_AGE), 'amber');
  // Wednesday plus three working days is the following Monday, not Saturday.
  assert.equal(ageLevel(since, at('2026-09-07T09:00:00Z'), TARANIS_AGE), 'red');
});

test('Taranis-side: a Friday submission is still only amber on Monday', () => {
  const since = at('2026-09-04T10:00:00Z'); // Friday
  assert.equal(ageLevel(since, at('2026-09-07T10:00:00Z'), TARANIS_AGE), 'amber');
  assert.equal(ageLevel(since, at('2026-09-09T10:00:00Z'), TARANIS_AGE), 'red');
});

test('company-side: amber at three calendar days, red at seven', () => {
  const since = at('2026-09-01T09:00:00Z');

  assert.equal(ageLevel(since, at('2026-09-03T23:59:00Z'), COMPANY_AGE), 'none');
  assert.equal(ageLevel(since, at('2026-09-04T09:00:00Z'), COMPANY_AGE), 'amber');
  assert.equal(ageLevel(since, at('2026-09-08T08:59:00Z'), COMPANY_AGE), 'amber');
  assert.equal(ageLevel(since, at('2026-09-08T09:00:00Z'), COMPANY_AGE), 'red');
});

test('nothing with no timestamp is ever flagged', () => {
  assert.equal(ageLevel(null, at('2026-09-09T09:00:00Z'), TARANIS_AGE), 'none');
  assert.equal(ageLevel('not a date', at('2026-09-09T09:00:00Z'), TARANIS_AGE), 'none');
  assert.deepEqual(ageOf(null, at('2026-09-09T09:00:00Z'), TARANIS_AGE), {
    since: null, days: 0, level: 'none',
  });
});

test('the worst level in a set wins, and nothing at all is none', () => {
  assert.equal(worstLevel([]), 'none');
  assert.equal(worstLevel(['none', 'none']), 'none');
  assert.equal(worstLevel(['none', 'amber']), 'amber');
  assert.equal(worstLevel(['amber', 'red', 'none']), 'red');
});

test('thresholds come from the environment, and rubbish falls back to the default', () => {
  assert.deepEqual(thresholdsFromEnv({}), AGE_DEFAULTS);
  assert.equal(thresholdsFromEnv({ DD_AGE_TARANIS_RED_DAYS: '5' }).taranisRedDays, 5);
  assert.equal(thresholdsFromEnv({ DD_AGE_TARANIS_RED_DAYS: 'soon' }).taranisRedDays, 3);
  assert.equal(thresholdsFromEnv({ DD_AGE_TARANIS_RED_DAYS: '0' }).taranisRedDays, 3);
  assert.equal(thresholdsFromEnv({ DD_AGE_TARANIS_RED_DAYS: '-2' }).taranisRedDays, 3);
});

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

test('progress is on the countable denominator, not the raw item count', () => {
  // The same denominator the company's own workspace and the Excel exports use.
  // The alternative would have the dashboard say 3 of 146 while the GAPS sheet
  // issued to that company said 3 of 143.
  const progress = progressOf({ itemCount: 146, countableCount: 143, completedCount: 3 });
  assert.equal(progress.total, 146);
  assert.equal(progress.countable, 143);
  assert.equal(progress.completed, 3);
  assert.equal(progress.percentComplete, 2);
});

test('an unseeded company is nought per cent and not a division by zero', () => {
  assert.equal(progressOf({ itemCount: 0, countableCount: 0, completedCount: 0 }).percentComplete, 0);
});

// ---------------------------------------------------------------------------
// Shaping
// ---------------------------------------------------------------------------

const NOW = at('2026-09-09T09:00:00Z'); // a Wednesday

function summaryFixture(overrides = {}) {
  return buildSummary(
    {
      companies: [
        {
          id: 'c-quiet',
          legalName: 'Quiet Bio Ltd',
          fundId: 'f-1',
          fundName: 'Biotech KSA',
          itemCount: 146,
          countableCount: 143,
          completedCount: 10,
          unstartedCount: 133,
          lastActivity: '2026-09-08T12:00:00Z',
        },
        {
          id: 'c-late',
          legalName: 'Late Bio Ltd',
          fundId: 'f-1',
          fundName: 'Biotech KSA',
          itemCount: 146,
          countableCount: 143,
          completedCount: 3,
          unstartedCount: 140,
          lastActivity: '2026-09-01T12:00:00Z',
        },
      ],
      fileGroups: [
        // Late Bio has two unopened submissions from a week ago: red.
        {
          companyId: 'c-late',
          status: 'received',
          fileCount: 2,
          oldestSince: '2026-09-02T09:00:00Z',
        },
        {
          companyId: 'c-late',
          status: 'in_review',
          fileCount: 1,
          oldestSince: '2026-09-08T09:00:00Z',
        },
      ],
      activity: [{ kind: 'upload', at: '2026-09-08T12:00:00Z', companyName: 'Quiet Bio Ltd' }],
      ...overrides,
    },
    { now: NOW, thresholds: AGE_DEFAULTS }
  );
}

test('a checklist nobody has started is counted but never aged', () => {
  // The decision this build turns on (HANDOVER-C020 D2). Quiet Bio has 133
  // items outstanding and no file needing attention, so it owes a great deal
  // and none of it is late: an outstanding item has no date it was asked on,
  // only the date the whole checklist was seeded, and ageing from that would
  // have every company red on the day this shipped and for ever after.
  const summary = summaryFixture();
  const quiet = summary.companies.find((c) => c.id === 'c-quiet');

  assert.equal(quiet.awaitingCompany.total, 133);
  assert.equal(quiet.awaitingCompany.unstartedItems, 133);
  assert.equal(quiet.awaitingCompany.attentionFiles, 0);
  assert.equal(quiet.awaitingCompany.since, null);
  assert.equal(quiet.awaitingCompany.level, 'none');
  assert.equal(quiet.level, 'none');
});

test('a file left needing attention does age the company bucket', () => {
  const summary = buildSummary(
    {
      companies: [{
        id: 'c-1',
        legalName: 'Example Bio Ltd',
        fundName: 'Biotech KSA',
        itemCount: 10,
        countableCount: 10,
        completedCount: 1,
        unstartedCount: 4,
        lastActivity: '2026-09-01T09:00:00Z',
      }],
      fileGroups: [{
        companyId: 'c-1',
        status: 'attention_needed',
        fileCount: 1,
        oldestSince: '2026-09-01T09:00:00Z', // eight calendar days before NOW
      }],
      activity: [],
    },
    { now: NOW, thresholds: AGE_DEFAULTS }
  );

  const company = summary.companies[0];
  assert.equal(company.awaitingCompany.total, 5); // 1 file + 4 unstarted items
  assert.equal(company.awaitingCompany.attentionFiles, 1);
  assert.equal(company.awaitingCompany.days, 8);
  assert.equal(company.awaitingCompany.level, 'red');
  assert.equal(company.level, 'red');
});

test('the Taranis bucket reports its two statuses separately as well as summed', () => {
  // The tile links to the review queue, which is 'received' only unless asked
  // otherwise, so a single figure would send an admin to a screen showing fewer
  // rows than the number they clicked (HANDOVER-C020 D3).
  const late = summaryFixture().companies.find((c) => c.id === 'c-late');

  assert.equal(late.awaitingTaranis.total, 3);
  assert.equal(late.awaitingTaranis.received, 2);
  assert.equal(late.awaitingTaranis.inReview, 1);
  // Aged from the oldest of the two, which is the received pair.
  assert.equal(late.awaitingTaranis.level, 'red');
});

test('companies sort worst first, then by most recent activity', () => {
  const summary = summaryFixture();
  assert.deepEqual(summary.companies.map((c) => c.id), ['c-late', 'c-quiet']);
});

test('the headline totals are the sums of the rows underneath them', () => {
  const summary = summaryFixture();
  assert.equal(summary.awaitingTaranis.total, 3);
  assert.equal(summary.awaitingTaranis.received, 2);
  assert.equal(summary.awaitingTaranis.inReview, 1);
  assert.equal(summary.awaitingTaranis.level, 'red');
  // 133 + 140 unstarted, no attention-needed files anywhere.
  assert.equal(summary.awaitingCompany.total, 273);
  assert.equal(summary.awaitingCompany.level, 'none');
});

test('a platform with nothing outstanding is clear, and one with anything is not', () => {
  const empty = buildSummary({ companies: [], fileGroups: [], activity: [] }, { now: NOW });
  assert.equal(empty.companies.length, 0);
  assert.equal(isClear(empty), true);

  assert.equal(isClear(summaryFixture()), false);
});

test('a company with everything done sits in neither bucket', () => {
  const summary = buildSummary(
    {
      companies: [{
        id: 'c-done',
        legalName: 'Done Bio Ltd',
        fundName: 'Biotech KSA',
        itemCount: 10,
        countableCount: 8,
        completedCount: 8,
        unstartedCount: 0,
        lastActivity: '2026-09-08T09:00:00Z',
      }],
      // Completed and superseded files are excluded by the query, so nothing
      // reaches the shaping at all.
      fileGroups: [],
      activity: [],
    },
    { now: NOW, thresholds: AGE_DEFAULTS }
  );

  assert.equal(isClear(summary), true);
  assert.equal(summary.companies[0].irl.percentComplete, 100);
});

// ---------------------------------------------------------------------------
// The route
// ---------------------------------------------------------------------------

function summaryPool() {
  return fakePool([
    ['unstarted_count', [{
      id: 'c-1',
      legal_name: 'Example Bio Ltd',
      fund_id: 'f-1',
      fund_name: 'Biotech KSA',
      item_count: '146',
      countable_count: '143',
      completed_count: '3',
      unstarted_count: '140',
      last_activity: '2026-09-08T09:00:00Z',
    }]],
    ['GROUP BY f.company_id, f.status', [{
      company_id: 'c-1',
      status: 'received',
      file_count: 2,
      oldest_since: '2026-09-08T09:00:00Z',
    }]],
    ["'upload' AS kind", [{
      kind: 'upload',
      at: '2026-09-08T09:00:00Z',
      company_id: 'c-1',
      legal_name: 'Example Bio Ltd',
      subject: 'accounts.pdf',
      item_ref: '3.2',
      detail: null,
      actor_role: 'company',
      actor_name: 'Alex Fenn',
    }]],
  ]);
}

test('an admin gets the summary, and it is shaped', async () => {
  const server = await startTestServer([['/dd-summary', ddSummaryRouter]], summaryPool());
  try {
    const res = await server.request('/dd-summary', {
      token: tokenFor({ role: 'admin', sub: 'admin-1' }),
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.companies.length, 1);
    assert.equal(res.body.awaitingTaranis.total, 2);
    assert.equal(res.body.awaitingTaranis.received, 2);
    assert.equal(res.body.companies[0].irl.countable, 143);
    // The actor's side is derived from their role, not from which table the
    // event came from: the opening 'received' history row is written with the
    // company administrator's id.
    assert.equal(res.body.recentActivity[0].actorSide, 'company');
  } finally {
    await server.close();
  }
});

test('every role other than admin is refused, including the ones that see the DD nav', async () => {
  // Advisor and viewer DO see Companies and Review Queue in the nav and DO
  // reach /review-queue scoped to their assignments. This endpoint is narrower
  // by decision (CW020 §5), which is why they are named here one by one: a
  // future widening should have to delete a line of this test.
  const pool = summaryPool();
  const server = await startTestServer([['/dd-summary', ddSummaryRouter]], pool);
  try {
    for (const role of ['advisor', 'viewer', 'investor']) {
      const res = await server.request('/dd-summary', { token: tokenFor({ role, sub: 'u-1' }) });
      assert.equal(res.status, 403, `${role} was not refused`);
    }

    const company = await server.request('/dd-summary', {
      token: tokenFor({ role: 'company', sub: 'u-2', companyId: 'c-1' }),
    });
    assert.equal(company.status, 403);

    const anonymous = await server.request('/dd-summary');
    assert.equal(anonymous.status, 401);

    // And nothing was read on any of those requests.
    assert.equal(pool.calls.length, 0);
  } finally {
    await server.close();
  }
});

test('the queries only ever look at active companies', async () => {
  const pool = summaryPool();
  const server = await startTestServer([['/dd-summary', ddSummaryRouter]], pool);
  try {
    await server.request('/dd-summary', { token: tokenFor({ role: 'admin', sub: 'admin-1' }) });

    // Pending companies have no checklist, and suspended or offboarded ones
    // cannot be acted on by either side.
    for (const sql of pool.sql()) {
      assert.ok(
        sql.includes("status = 'active'"),
        `a dd-summary query was not scoped to active companies: ${sql.slice(0, 80)}`
      );
    }
  } finally {
    await server.close();
  }
});
