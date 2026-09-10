/**
 * Session digests (HANDOVER-CW025, design in HANDOVER-C025 §3).
 *
 * The builders are pure and tested directly. The flush is tested against the
 * fake pool, which proves the order of statements and what each carries but
 * cannot execute them; the grouping, locking and stamping SQL is verified
 * against a real PostgreSQL 16 separately and recorded in C025.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FAMILIES,
  SESSION_DIGEST_DEFAULTS,
  sessionDigestConfig,
  sessionDigestsEnabled,
  isGroupDue,
  joinNames,
  buildStatusMessage,
  buildUploadMessage,
  buildNewItemsMessage,
  queueDigestEvent,
  queueDigestEvents,
  flushDueDigests,
  pendingDigestsFor,
} from '../src/services/notification-digests.js';
import { fakePool } from './helpers/test-app.js';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const ENV = { PORTAL_URL: 'https://dataroom.taraniscapital.com' };
const PROGRESS = { percentComplete: 28, countable: 146, completed: 41 };

// ---------------------------------------------------------------------------
// The switch and the windows
// ---------------------------------------------------------------------------

test('digests are on unless explicitly switched off', () => {
  // Mark, 10 September 2026: the merge itself delivers the fix.
  assert.equal(sessionDigestConfig({}).enabled, true);
  for (const on of ['true', '1', 'yes', '', 'anything']) {
    assert.equal(sessionDigestsEnabled({ NOTIFY_DIGEST_ENABLED: on }), true, `'${on}' should leave digests on`);
  }
  for (const off of ['false', 'FALSE', ' 0 ', 'off', 'No']) {
    assert.equal(sessionDigestsEnabled({ NOTIFY_DIGEST_ENABLED: off }), false, `'${off}' should switch digests off`);
  }
});

test('the windows default to 10 and 60 minutes and can be set', () => {
  assert.deepEqual(
    { quiet: sessionDigestConfig({}).quietMinutes, hold: sessionDigestConfig({}).maxHoldMinutes },
    { quiet: SESSION_DIGEST_DEFAULTS.quietMinutes, hold: SESSION_DIGEST_DEFAULTS.maxHoldMinutes }
  );
  const custom = sessionDigestConfig({ NOTIFY_DIGEST_QUIET_MINUTES: '5', NOTIFY_DIGEST_MAX_HOLD_MINUTES: '30' });
  assert.equal(custom.quietMinutes, 5);
  assert.equal(custom.maxHoldMinutes, 30);
});

test('a nonsense window falls back to the default, and the hold is never shorter than the quiet period', () => {
  const junk = sessionDigestConfig({ NOTIFY_DIGEST_QUIET_MINUTES: 'ten', NOTIFY_DIGEST_MAX_HOLD_MINUTES: '-4' });
  assert.equal(junk.quietMinutes, 10);
  assert.equal(junk.maxHoldMinutes, 60);

  const inverted = sessionDigestConfig({ NOTIFY_DIGEST_QUIET_MINUTES: '20', NOTIFY_DIGEST_MAX_HOLD_MINUTES: '5' });
  assert.equal(inverted.maxHoldMinutes, 20);
});

test('a group is due after the quiet period, or at the maximum hold however busy it is', () => {
  const cfg = { quietMinutes: 10, maxHoldMinutes: 60 };
  const now = new Date('2026-09-10T12:00:00Z');
  const minsAgo = (m) => new Date(now.getTime() - m * 60_000);

  // Quiet for ten minutes: due.
  assert.equal(isGroupDue({ firstAt: minsAgo(15), lastAt: minsAgo(10) }, now, cfg), true);
  // Still active: not due.
  assert.equal(isGroupDue({ firstAt: minsAgo(15), lastAt: minsAgo(2) }, now, cfg), false);
  // Still active, but the first event has waited an hour: due, so a long
  // sitting still sends.
  assert.equal(isGroupDue({ firstAt: minsAgo(60), lastAt: minsAgo(1) }, now, cfg), true);
});

test('names join the way a sentence does', () => {
  assert.equal(joinNames([]), '');
  assert.equal(joinNames(['Madan Mohan']), 'Madan Mohan');
  assert.equal(joinNames(['Madan Mohan', 'Priya Rao']), 'Madan Mohan and Priya Rao');
  assert.equal(joinNames(['A', 'B', 'A', 'C']), 'A, B and C');
});

// ---------------------------------------------------------------------------
// The company status digest
// ---------------------------------------------------------------------------

function fileRow(n, status, extra = {}) {
  return {
    id: `f-${n}`,
    filename: `file-${String(n).padStart(2, '0')}.pdf`,
    status,
    irl_item_id: `item-${n}`,
    item_ref: `${Math.ceil(n / 5)}.${n}`,
    item_description: `Item ${n} description`,
    sort_order: n,
    receipt_ref: 'TRN-DD-2026-000028',
    submitted_at: new Date('2026-08-28T09:15:00Z'),
    status_note: status === 'attention_needed' ? `Note for file ${n}` : null,
    ...extra,
  };
}

test('thirty changes in a sitting become one digest, attention first, with every note', () => {
  // Interleaved on purpose: the digest must re-order, not rely on arrival.
  const rows = Array.from({ length: 30 }, (_, i) => fileRow(30 - i, i % 3 === 0 ? 'attention_needed' : 'completed'));
  const message = buildStatusMessage({
    rows, companyName: 'Revelations Biotech', firstName: 'Madan', progress: PROGRESS, env: ENV,
  });

  assert.equal(message.template, 'status-digest');
  const p = message.payload;
  assert.equal(p.reviewed_count, 30);
  assert.equal(p.attention_count, 10);
  assert.equal(p.accepted_count, 20);
  assert.equal(p.attention_files.length + p.accepted_files.length, 30);

  // Every reviewer note reaches the company.
  for (const f of p.attention_files) assert.match(f.reviewer_note, /^Note for file \d+$/);

  // Checklist order within each section.
  const order = (files) => files.map((f) => Number(f.filename.match(/\d+/)[0]));
  assert.deepEqual(order(p.attention_files), [...order(p.attention_files)].sort((a, b) => a - b));
  assert.deepEqual(order(p.accepted_files), [...order(p.accepted_files)].sort((a, b) => a - b));

  // Progress is the figure at the end of the sitting.
  assert.equal(p.progress_percent, '28%');
  assert.equal(p.outstanding_count, 105);
  assert.equal(p.first_name, 'Madan');
});

test('a lone attention_needed change is sent with the approved one-file template, as before', () => {
  const message = buildStatusMessage({
    rows: [fileRow(3, 'attention_needed')],
    companyName: 'Example Bio', firstName: 'Sam', progress: PROGRESS, env: ENV,
  });
  assert.equal(message.template, 'status-attention');
  assert.deepEqual(Object.keys(message.payload).sort(), [
    'company_name', 'filename', 'first_name', 'item_description_short', 'item_ref',
    'item_url', 'receipt_ref', 'reviewer_note', 'submitted_at',
  ]);
  assert.equal(message.payload.reviewer_note, 'Note for file 3');
  assert.equal(message.payload.submitted_at, '28 August 2026 at 09:15');
  assert.ok(message.payload.item_url.endsWith('/company/items/item-3'));
});

test('a lone acceptance is sent with the approved status-completed, quoting progress', () => {
  const message = buildStatusMessage({
    rows: [fileRow(4, 'completed')],
    companyName: 'Example Bio', firstName: 'Sam', progress: PROGRESS, env: ENV,
  });
  assert.equal(message.template, 'status-completed');
  assert.equal(message.payload.progress_percent, '28%');
  assert.equal(message.payload.outstanding_count, 105);
});

test('only the status a file ends the sitting on counts', () => {
  // A file flagged and then accepted in one sitting is read once, as it stands:
  // accepted. One moved on to in_review, back to received or superseded has
  // nothing to announce.
  const message = buildStatusMessage({
    rows: [
      fileRow(1, 'completed'),
      fileRow(2, 'in_review'),
      fileRow(3, 'received'),
      fileRow(4, 'superseded'),
      fileRow(5, 'attention_needed'),
    ],
    companyName: 'Example Bio', firstName: 'Sam', progress: PROGRESS, env: ENV,
  });
  assert.equal(message.template, 'status-digest');
  assert.equal(message.payload.reviewed_count, 2);

  assert.equal(buildStatusMessage({
    rows: [fileRow(2, 'in_review'), fileRow(4, 'superseded')],
    companyName: 'Example Bio', firstName: 'Sam', progress: PROGRESS, env: ENV,
  }), null, 'nothing left to say means no message');
});

test('an acceptance that carries a note keeps it', () => {
  const message = buildStatusMessage({
    rows: [
      fileRow(1, 'completed', { status_note: '  Expires 12 September; please upload the renewal.  ' }),
      fileRow(2, 'completed'),
    ],
    companyName: 'Example Bio', firstName: 'Sam', progress: PROGRESS, env: ENV,
  });
  assert.equal(message.payload.accepted_files[0].reviewer_note, 'Expires 12 September; please upload the renewal.');
  assert.equal(message.payload.accepted_files[1].reviewer_note, null);
});

test('no internal note reaches the status digest, whatever the row carries', () => {
  const message = buildStatusMessage({
    rows: [
      fileRow(1, 'attention_needed', { internal_note: 'INTERNAL: chase their counsel' }),
      fileRow(2, 'completed', { internal_note: 'INTERNAL: weak cap table' }),
    ],
    companyName: 'Example Bio', firstName: 'Sam', progress: PROGRESS, env: ENV,
  });
  assert.equal(JSON.stringify(message.payload).includes('INTERNAL'), false);
});

// ---------------------------------------------------------------------------
// The admin upload digest
// ---------------------------------------------------------------------------

function uploadRow(n, extra = {}) {
  return {
    id: `u-${n}`,
    filename: `upload-${n}.pdf`,
    description: `Upload ${n}`,
    size_bytes: '2516582',
    version: 1,
    upload_state: 'staged',
    deleted_at: null,
    irl_item_id: `item-${n}`,
    created_at: new Date(`2026-08-28T09:${String(10 + n).padStart(2, '0')}:00Z`),
    item_ref: `7.${n}`,
    item_description: `Financial item ${n}`,
    sort_order: n,
    receipt_ref: null,
    uploader_name: 'Madan Mohan',
    uploader_email: 'madan@revelations.bio',
    ...extra,
  };
}

test('forty uploads become one admin digest listing all forty', () => {
  const rows = Array.from({ length: 40 }, (_, i) => uploadRow(i + 1));
  const message = buildUploadMessage({ rows, companyName: 'Revelations Biotech', env: ENV });

  assert.equal(message.template, 'upload-digest');
  assert.equal(message.payload.file_count, 40);
  assert.equal(message.payload.files.length, 40);
  assert.equal(message.payload.uploader_names, 'Madan Mohan');
  assert.equal(message.payload.files[0].size, '2.4 MB');
  assert.ok(message.payload.admin_review_url.endsWith('/admin/review-queue'));
});

test('every upload is listed with where it stands when the digest closes', () => {
  // Mark's decision, 10 September 2026: list every upload, even those the
  // company has submitted or removed since.
  const message = buildUploadMessage({
    rows: [
      uploadRow(1, { upload_state: 'submitted', receipt_ref: 'TRN-DD-2026-000031' }),
      uploadRow(2),
      uploadRow(3, { deleted_at: new Date() }),
    ],
    companyName: 'Revelations Biotech', env: ENV,
  });
  const states = message.payload.files.map((f) => f.state);
  assert.deepEqual(states, ['submitted', 'staged', 'removed']);
  assert.equal(message.payload.files[0].receipt_ref, 'TRN-DD-2026-000031');
  assert.equal(message.payload.submitted_count, 1);
  assert.equal(message.payload.staged_count, 1);
  assert.equal(message.payload.removed_count, 1);
});

test('the upload digest orders by checklist, names every uploader and marks new versions', () => {
  const message = buildUploadMessage({
    rows: [
      uploadRow(9, { uploader_name: 'Priya Rao', created_at: new Date('2026-08-28T10:00:00Z') }),
      uploadRow(2, { version: 2 }),
      uploadRow(5, { irl_item_id: null, item_ref: null, sort_order: null, item_description: null }),
    ],
    companyName: 'Revelations Biotech', env: ENV,
  });
  const f = message.payload.files;
  assert.deepEqual(f.map((x) => x.filename), ['upload-2.pdf', 'upload-9.pdf', 'upload-5.pdf']);
  assert.equal(f[0].description, 'Upload 2 (version 2)');
  // Additional material has no item, and the template says so.
  assert.equal(f[2].item_ref, '');
  assert.equal(f[2].item_description_short, '');
  assert.equal(message.payload.uploader_names, 'Madan Mohan and Priya Rao');
});

test('an upload digest with no rows sends nothing', () => {
  assert.equal(buildUploadMessage({ rows: [], companyName: 'X', env: ENV }), null);
});

// ---------------------------------------------------------------------------
// The new-items digest, on the approved template
// ---------------------------------------------------------------------------

function itemRow(ref, extra = {}) {
  return {
    id: `i-${ref}`, ref, description: `Item ${ref}`, priority: 'high',
    note_for_company: null, state: 'outstanding', sort_order: Number(ref.split('.')[1]), ...extra,
  };
}

test('items added one at a time arrive as one approved new-items message', () => {
  const message = buildNewItemsMessage({
    rows: [itemRow('15.3'), itemRow('15.1'), itemRow('15.2')],
    companyName: 'Example Bio', firstName: 'Alex', env: ENV,
  });
  assert.equal(message.template, 'new-items');
  assert.equal(message.payload.new_item_count, 3);
  assert.deepEqual(message.payload.items.map((i) => i.ref), ['15.1', '15.2', '15.3']);
  assert.deepEqual(Object.keys(message.payload.items[0]).sort(), ['description_short', 'priority', 'ref']);
});

test('the one note line is used only when every item carries the same note', () => {
  const same = buildNewItemsMessage({
    rows: [itemRow('15.1', { note_for_company: 'From the 6 August call.' }), itemRow('15.2', { note_for_company: 'From the 6 August call.' })],
    companyName: 'Example Bio', firstName: 'Alex', env: ENV,
  });
  assert.equal(same.payload.note_for_company, 'From the 6 August call.');

  const mixed = buildNewItemsMessage({
    rows: [itemRow('15.1', { note_for_company: 'About 15.1 only.' }), itemRow('15.2')],
    companyName: 'Example Bio', firstName: 'Alex', env: ENV,
  });
  assert.equal(mixed.payload.note_for_company, null, 'a note that belongs to one item must not read as covering all');

  const single = buildNewItemsMessage({
    rows: [itemRow('15.1', { note_for_company: 'Today\'s case, unchanged.' })],
    companyName: 'Example Bio', firstName: 'Alex', env: ENV,
  });
  assert.equal(single.payload.note_for_company, "Today's case, unchanged.");
});

test('an item since marked held is not announced, and neither is its internal note', () => {
  const message = buildNewItemsMessage({
    rows: [itemRow('15.1', { state: 'held' }), itemRow('15.2', { internal_note: 'INTERNAL' })],
    companyName: 'Example Bio', firstName: 'Alex', env: ENV,
  });
  assert.deepEqual(message.payload.items.map((i) => i.ref), ['15.2']);
  assert.equal(JSON.stringify(message.payload).includes('INTERNAL'), false);

  assert.equal(buildNewItemsMessage({
    rows: [itemRow('15.1', { state: 'held' })], companyName: 'X', firstName: 'Y', env: ENV,
  }), null);
});

// ---------------------------------------------------------------------------
// Queueing an event
// ---------------------------------------------------------------------------

test('an event is one lower-cased row carrying ids only', async () => {
  const db = fakePool([['INSERT INTO notification_digest_events', [{ id: 'e-1' }]]]);
  const id = await queueDigestEvent(db, {
    family: FAMILIES.STATUS, recipient: ' Madan@Revelations.BIO ', companyId: COMPANY, event: { fileId: 'f-1' },
  });
  assert.equal(id, 'e-1');
  const [call] = db.calls;
  assert.deepEqual(call.params, ['company-status', 'madan@revelations.bio', COMPANY, '{"fileId":"f-1"}']);
});

test('an event with no recipient is logged and skipped, not thrown into the caller', async () => {
  const db = fakePool();
  assert.equal(await queueDigestEvent(db, { family: FAMILIES.STATUS, recipient: '', companyId: COMPANY }), null);
  assert.equal(db.calls.length, 0);
});

test('one event per person, however many times they are named', async () => {
  const db = fakePool([['INSERT INTO notification_digest_events', () => [{ id: 'e' }]]]);
  await queueDigestEvents(db, {
    family: FAMILIES.STATUS,
    recipients: [{ email: 'a@x.com' }, 'A@X.com', { email: 'b@x.com' }, null],
    companyId: COMPANY,
    event: { fileId: 'f-1' },
  });
  assert.deepEqual(db.calls.map((c) => c.params[1]), ['a@x.com', 'b@x.com']);
});

// ---------------------------------------------------------------------------
// Closing a group
// ---------------------------------------------------------------------------

const NOW = new Date('2026-09-10T12:00:00Z');
const minsAgo = (m) => new Date(NOW.getTime() - m * 60_000);

function statusGroupPool({ events, member = { display_name: 'Madan Mohan' }, files, failOn } = {}) {
  return fakePool([
    ['GROUP BY family, recipient, company_id', [{
      family: 'company-status', recipient: 'madan@revelations.bio', company_id: COMPANY,
      first_at: events[0].created_at, last_at: events[events.length - 1].created_at,
    }]],
    ['FOR UPDATE SKIP LOCKED', events],
    ['SELECT u.display_name', member ? [member] : []],
    ['FROM company_files f\n       LEFT JOIN company_irl_items i', () => {
      if (failOn === 'files') throw new Error('connection reset');
      return files;
    }],
    ['SELECT state FROM company_irl_items WHERE company_id', [
      { state: 'completed' }, { state: 'outstanding' }, { state: 'outstanding' }, { state: 'held' },
    ]],
    ['SELECT legal_name FROM companies', [{ legal_name: 'Revelations Biotech' }]],
    ['INSERT INTO notification_outbox', [{ id: 'n-1' }]],
    ['UPDATE notification_digest_events', []],
  ]);
}

const twoEvents = [
  { id: 'e-1', event: { fileId: 'f-1' }, created_at: minsAgo(14) },
  { id: 'e-2', event: { fileId: 'f-1' }, created_at: minsAgo(12) },
  { id: 'e-3', event: { fileId: 'f-2' }, created_at: minsAgo(11) },
];

test('a due group closes into ONE ordinary outbox row, and its events are stamped in the same transaction', async () => {
  const db = statusGroupPool({
    events: twoEvents,
    files: [fileRow(1, 'completed'), fileRow(2, 'attention_needed')],
  });

  const tally = await flushDueDigests({ pool: db, now: NOW, env: ENV });
  assert.deepEqual(tally, { groups: 1, queued: 1, empty: 0, skipped: 0, failed: 0 });

  // The due query was given the two cutoffs: ten minutes and an hour ago.
  const due = db.calls.find((c) => c.text.includes('GROUP BY family, recipient, company_id'));
  assert.equal(due.params[0].toISOString(), minsAgo(10).toISOString());
  assert.equal(due.params[1].toISOString(), minsAgo(60).toISOString());

  // The file flagged and re-flagged in the sitting is read once.
  const read = db.calls.find((c) => c.text.includes('FROM company_files f\n       LEFT JOIN company_irl_items i'));
  assert.deepEqual(read.params[0], ['f-1', 'f-2']);

  const outbox = db.calls.filter((c) => c.text.includes('INSERT INTO notification_outbox'));
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].params[0], 'status-digest');
  assert.equal(outbox[0].params[1], 'madan@revelations.bio');
  const payload = JSON.parse(outbox[0].params[2]);
  assert.equal(payload.first_name, 'Madan');
  assert.equal(payload.company_name, 'Revelations Biotech');
  // 1 completed of 3 countable (held excluded): the figure now, not per event.
  assert.equal(payload.progress_percent, '33%');

  const stamp = db.calls.find((c) => c.text.includes('UPDATE notification_digest_events'));
  assert.deepEqual(stamp.params, [['e-1', 'e-2', 'e-3'], 'n-1']);

  const order = db.sql();
  const begin = order.indexOf('BEGIN');
  const commit = order.indexOf('COMMIT');
  const lockAt = order.findIndex((s) => s.includes('FOR UPDATE SKIP LOCKED'));
  const outboxAt = order.findIndex((s) => s.includes('INSERT INTO notification_outbox'));
  const stampAt = order.findIndex((s) => s.includes('UPDATE notification_digest_events'));
  assert.ok(begin < lockAt && lockAt < outboxAt && outboxAt < stampAt && stampAt < commit,
    'lock, queue and stamp must all sit inside one transaction');
});

test('the status digest reads named columns only, never the internal note', async () => {
  const db = statusGroupPool({ events: twoEvents, files: [fileRow(1, 'completed'), fileRow(2, 'completed')] });
  await flushDueDigests({ pool: db, now: NOW, env: ENV });

  const reads = db.sql().filter((s) => /company_files|company_irl_items/.test(s) && s.trim().startsWith('SELECT'));
  assert.ok(reads.length >= 2);
  for (const sql of reads) {
    assert.equal(sql.includes('internal_note'), false, `internal_note selected in: ${sql}`);
    assert.equal(/SELECT\s+\*|\bf\.\*|\bi\.\*/.test(sql), false, `a star select in: ${sql}`);
  }
});

test('a group that is no longer due once locked is left alone', async () => {
  // Another task closed the due group between the query and the lock, and new
  // events have opened its successor, which is not due yet.
  const db = statusGroupPool({
    events: [{ id: 'e-9', event: { fileId: 'f-1' }, created_at: minsAgo(1) }],
    files: [fileRow(1, 'completed')],
  });
  const tally = await flushDueDigests({ pool: db, now: NOW, env: ENV });
  assert.equal(tally.skipped, 1);
  assert.ok(db.sql().includes('ROLLBACK'));
  assert.equal(db.sql().some((s) => s.includes('INSERT INTO notification_outbox')), false);
  assert.equal(db.sql().some((s) => s.includes('UPDATE notification_digest_events')), false);
});

test('a group already taken by another task is skipped', async () => {
  const db = fakePool([
    ['GROUP BY family, recipient, company_id', [{
      family: 'company-status', recipient: 'a@x.com', company_id: COMPANY,
      first_at: minsAgo(20), last_at: minsAgo(15),
    }]],
    ['FOR UPDATE SKIP LOCKED', []],
  ]);
  const tally = await flushDueDigests({ pool: db, now: NOW, env: ENV });
  assert.equal(tally.skipped, 1);
  assert.equal(db.sql().some((s) => s.includes('INSERT INTO notification_outbox')), false);
});

test('a recipient deactivated during the quiet period is not written to, and the events are closed', async () => {
  const db = statusGroupPool({ events: twoEvents, member: null, files: [fileRow(1, 'completed')] });
  const tally = await flushDueDigests({ pool: db, now: NOW, env: ENV });

  assert.equal(tally.empty, 1);
  assert.equal(db.sql().some((s) => s.includes('INSERT INTO notification_outbox')), false);
  const stamp = db.calls.find((c) => c.text.includes('UPDATE notification_digest_events'));
  assert.deepEqual(stamp.params, [['e-1', 'e-2', 'e-3'], null], 'closed with no outbox row, not left open for ever');
});

test('a group that fails is rolled back and left open for the next pass', async () => {
  const db = statusGroupPool({ events: twoEvents, files: [], failOn: 'files' });
  const tally = await flushDueDigests({ pool: db, now: NOW, env: ENV });

  assert.equal(tally.failed, 1);
  assert.ok(db.sql().includes('ROLLBACK'));
  assert.equal(db.sql().some((s) => s.includes('UPDATE notification_digest_events')), false);
});

test('the flush runs even with digests switched off, so nothing recorded earlier is stranded', async () => {
  const db = statusGroupPool({ events: twoEvents, files: [fileRow(1, 'completed')] });
  const tally = await flushDueDigests({ pool: db, now: NOW, env: { ...ENV, NOTIFY_DIGEST_ENABLED: 'false' } });
  assert.equal(tally.queued, 1);
});

test('an upload group closes into one upload-digest to the admin address', async () => {
  const db = fakePool([
    ['GROUP BY family, recipient, company_id', [{
      family: 'admin-uploads', recipient: 'admin@taraniscapital.com', company_id: COMPANY,
      first_at: minsAgo(30), last_at: minsAgo(11),
    }]],
    ['FOR UPDATE SKIP LOCKED', [
      { id: 'e-1', event: '{"fileId":"u-1"}', created_at: minsAgo(30) },
      { id: 'e-2', event: '{"fileId":"u-2"}', created_at: minsAgo(11) },
    ]],
    ['JOIN users u ON u.id = f.uploaded_by', [
      uploadRow(1, { upload_state: 'submitted', receipt_ref: 'TRN-DD-2026-000031' }),
      uploadRow(2),
    ]],
    ['SELECT legal_name FROM companies', [{ legal_name: 'Revelations Biotech' }]],
    ['INSERT INTO notification_outbox', [{ id: 'n-7' }]],
  ]);

  const tally = await flushDueDigests({ pool: db, now: NOW, env: ENV });
  assert.equal(tally.queued, 1);

  const outbox = db.calls.find((c) => c.text.includes('INSERT INTO notification_outbox'));
  assert.equal(outbox.params[0], 'upload-digest');
  assert.equal(outbox.params[1], 'admin@taraniscapital.com');
  const payload = JSON.parse(outbox.params[2]);
  assert.equal(payload.file_count, 2);
  assert.deepEqual(payload.files.map((f) => f.state), ['submitted', 'staged']);
  // No membership check on the admin address: it is not a company user.
  assert.equal(db.sql().some((s) => s.includes('SELECT u.display_name')), false);
});

test('open digests for an address are reported, keyed on the lower-cased address', async () => {
  const db = fakePool([['FROM notification_digest_events', [
    { family: 'company-status', company_id: COMPANY, event_count: 76 },
  ]]]);
  const rows = await pendingDigestsFor('Madan@Revelations.bio', { pool: db });
  assert.equal(rows[0].event_count, 76);
  assert.deepEqual(db.calls[0].params, ['madan@revelations.bio']);
  assert.match(db.calls[0].text, /flushed_at IS NULL/);
});
