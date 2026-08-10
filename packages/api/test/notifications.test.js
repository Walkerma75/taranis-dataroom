/**
 * The outbox: queueing, draining, retrying and suppression.
 *
 * Covers the four unit tests HANDOVER-CW011 §4 asks for. The database is the
 * fake pool from the existing harness, so this runs with no container and no
 * network, like the rest of the suite.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakePool } from './helpers/test-app.js';
import { MemoryMailer, PermanentSendError } from '../src/services/email.js';
import {
  queue,
  queueEach,
  drainOnce,
  isSuppressed,
  suppress,
  backoffMinutes,
  firstNameOf,
  formatBytes,
  formatDate,
  formatDateTimeUtc,
  shortDescription,
  adminRecipient,
  MAX_ATTEMPTS,
} from '../src/services/notifications.js';

/** An outbox row as `claimDue` returns it. */
function outboxRow({
  id = 'row-1',
  template = 'company-invite',
  recipient = 'contact@examplebio.com',
  payload = {
    first_name: 'Alex',
    company_name: 'Example Bio Ltd',
    invite_url: 'https://dataroom.taraniscapital.com/invite/accept?token=abc',
    invite_expiry_date: '17 August 2026',
    inviter_name: 'Mark Walker',
  },
  attempts = 1,
} = {}) {
  return { id, template, recipient, payload, attempts };
}

/** A pool that hands the worker one batch and then nothing. */
function drainPool({ rows = [outboxRow()], suppressed = false } = {}) {
  let served = false;
  return fakePool([
    ['SET attempts = attempts + 1', () => {
      if (served) return [];
      served = true;
      return rows;
    }],
    ['FROM email_suppressions', suppressed ? [{ '?column?': 1 }] : []],
  ]);
}

// ---------------------------------------------------------------------------
// Queueing
// ---------------------------------------------------------------------------

test('queue writes the outbox row on the client it is given', async () => {
  // The whole point of the outbox: the row goes on the CALLER'S transaction, so
  // it commits with the event it announces or rolls back with it. A queue()
  // that wrote on the pool would escape the transaction.
  const client = fakePool([['INSERT INTO notification_outbox', [{ id: 'n-1' }]]]);
  const pool = fakePool([]);

  const id = await queue(client, {
    template: 'company-invite',
    recipient: 'Contact@ExampleBio.com',
    payload: { first_name: 'Alex' },
  });

  assert.equal(id, 'n-1');
  assert.equal(pool.calls.length, 0, 'the row was written outside the caller transaction');

  const [call] = client.calls;
  assert.ok(call.text.includes('INSERT INTO notification_outbox'));
  assert.equal(call.params[0], 'company-invite');
  assert.equal(call.params[1], 'Contact@ExampleBio.com');
  assert.deepEqual(JSON.parse(call.params[2]), { first_name: 'Alex' });
});

test('queue refuses a row with no recipient rather than failing the caller', async () => {
  // The call site is inside somebody's transaction. Throwing would roll back
  // the upload the message was only meant to announce.
  const client = fakePool([['INSERT INTO notification_outbox', [{ id: 'n-1' }]]]);
  const id = await queue(client, { template: 'company-invite', recipient: '  ' });

  assert.equal(id, null);
  assert.equal(client.calls.length, 0);
});

test('queueEach writes one row per recipient and de-duplicates', async () => {
  // status-attention goes to the uploader AND the company administrator, who in
  // a small company are frequently the same person.
  let n = 0;
  const client = fakePool([['INSERT INTO notification_outbox', () => [{ id: `n-${++n}` }]]]);

  const ids = await queueEach(client, {
    template: 'status-attention',
    recipients: [
      { email: 'alex@examplebio.com', payload: { first_name: 'Alex' } },
      { email: 'ALEX@examplebio.com', payload: { first_name: 'Alex' } },
      { email: 'sam@examplebio.com', payload: { first_name: 'Sam' } },
    ],
    payload: { company_name: 'Example Bio Ltd' },
  });

  assert.equal(ids.length, 2, 'the same address was queued twice');

  const payloads = client.calls.map((c) => JSON.parse(c.params[2]));
  // The shared payload is merged with the per-recipient one, so each person is
  // addressed by their own name.
  assert.deepEqual(payloads[0], { company_name: 'Example Bio Ltd', first_name: 'Alex' });
  assert.deepEqual(payloads[1], { company_name: 'Example Bio Ltd', first_name: 'Sam' });
});

// ---------------------------------------------------------------------------
// Draining
// ---------------------------------------------------------------------------

test('a due row is rendered, sent and marked sent with its SES message id', async () => {
  const pool = drainPool();
  const mailer = new MemoryMailer();

  const tally = await drainOnce({ pool, mailer });

  assert.deepEqual(tally, { claimed: 1, sent: 1, suppressed: 0, retried: 0, failed: 0 });

  const sent = mailer.last();
  assert.equal(sent.to, 'contact@examplebio.com');
  assert.equal(sent.subject, 'Your access to the Taranis Capital Dataroom');
  assert.ok(sent.html.includes('Example Bio Ltd'));
  assert.ok(sent.text.includes('Accept your invitation: https://dataroom.taraniscapital.com'));

  const update = pool.calls.find((c) => c.text.includes("status = 'sent'"));
  assert.ok(update, 'the row was not marked sent');
  assert.equal(update.params[1], 'memory-1');
});

test('a payload stored as a JSON string renders the same as one stored as JSONB', async () => {
  // node-postgres hands back JSONB already parsed, but a fake or a driver
  // change could hand back the string. Rendering must not depend on which.
  const row = outboxRow({ payload: JSON.stringify(outboxRow().payload) });
  const mailer = new MemoryMailer();

  await drainOnce({ pool: drainPool({ rows: [row] }), mailer });

  assert.equal(mailer.last().subject, 'Your access to the Taranis Capital Dataroom');
});

test('a failed send increments attempts, records last_error and backs off', async () => {
  const pool = drainPool({ rows: [outboxRow({ attempts: 2 })] });
  const mailer = new MemoryMailer({ failWith: new Error('SES is throttling') });

  const tally = await drainOnce({ pool, mailer });

  assert.deepEqual(tally, { claimed: 1, sent: 0, suppressed: 0, retried: 1, failed: 0 });

  // attempts is incremented at CLAIM time, so a row that kills the worker
  // mid-send still counts as tried and cannot spin for ever.
  const claim = pool.calls.find((c) => c.text.includes('SET attempts = attempts + 1'));
  assert.ok(claim);

  const retry = pool.calls.find((c) => c.text.includes('send_after = NOW()'));
  assert.ok(retry, 'the row was not backed off');
  assert.equal(retry.params[1], 'SES is throttling');
  assert.equal(retry.params[2], '2', 'the second attempt should back off two minutes');
});

test('a row gives up at MAX_ATTEMPTS and keeps its last error', async () => {
  const pool = drainPool({ rows: [outboxRow({ attempts: MAX_ATTEMPTS })] });
  const mailer = new MemoryMailer({ failWith: new Error('still failing') });

  const tally = await drainOnce({ pool, mailer });

  assert.equal(tally.failed, 1);
  const failed = pool.calls.find((c) => c.text.includes("status = 'failed'"));
  assert.ok(failed);
  assert.equal(failed.params[1], 'still failing');
});

test('a permanent rejection fails on the first attempt instead of burning five', async () => {
  const pool = drainPool({ rows: [outboxRow({ attempts: 1 })] });
  const mailer = new MemoryMailer({ failWith: new PermanentSendError('MessageRejected') });

  const tally = await drainOnce({ pool, mailer });

  assert.equal(tally.failed, 1);
  assert.equal(tally.retried, 0);
});

test('an outbox row naming a template this build does not have fails permanently', async () => {
  const pool = drainPool({ rows: [outboxRow({ template: 'renamed-away' })] });
  const mailer = new MemoryMailer();

  const tally = await drainOnce({ pool, mailer });

  assert.equal(tally.failed, 1);
  assert.equal(mailer.messages.length, 0);
  const failed = pool.calls.find((c) => c.text.includes("status = 'failed'"));
  assert.match(failed.params[1], /Unknown email template: renamed-away/);
});

test('backoff doubles and is capped', () => {
  assert.equal(backoffMinutes(1), 1);
  assert.equal(backoffMinutes(2), 2);
  assert.equal(backoffMinutes(3), 4);
  assert.equal(backoffMinutes(4), 8);
  assert.equal(backoffMinutes(9), 30, 'backoff should be capped at half an hour');
});

// ---------------------------------------------------------------------------
// Suppression
// ---------------------------------------------------------------------------

test('a suppressed recipient blocks the send and is recorded, not dropped', async () => {
  const pool = drainPool({ suppressed: true });
  const mailer = new MemoryMailer();

  const tally = await drainOnce({ pool, mailer });

  assert.deepEqual(tally, { claimed: 1, sent: 0, suppressed: 1, retried: 0, failed: 0 });
  assert.equal(mailer.messages.length, 0, 'a suppressed address was written to');

  const marked = pool.calls.find((c) => c.text.includes("status = 'suppressed'"));
  assert.ok(marked, 'the withheld send left no record');
  assert.ok(
    marked.text.includes('sent_at = NOW()'),
    'a withheld send must still be timestamped: every outcome is auditable'
  );
});

test('suppression matches case-insensitively', async () => {
  const pool = fakePool([['FROM email_suppressions', [{ '?column?': 1 }]]]);

  assert.equal(await isSuppressed('Contact@ExampleBio.com', pool), true);
  assert.equal(pool.calls[0].params[0], 'contact@examplebio.com');
});

test('suppress lower-cases the address and records the reason', async () => {
  const pool = fakePool([['INSERT INTO email_suppressions', [{ id: 's-1' }]]]);

  await suppress({ email: 'Bounced@Example.com', reason: 'bounce', detail: { eventType: 'Bounce' } }, pool);

  const [call] = pool.calls;
  assert.equal(call.params[0], 'bounced@example.com');
  assert.equal(call.params[1], 'bounce');
  assert.deepEqual(JSON.parse(call.params[2]), { eventType: 'Bounce' });
});

// ---------------------------------------------------------------------------
// Payload helpers
// ---------------------------------------------------------------------------

test('first names fall back to something addressable', () => {
  assert.equal(firstNameOf('Alex Fenn'), 'Alex');
  assert.equal(firstNameOf('  Sam  Patel '), 'Sam');
  assert.equal(firstNameOf(''), 'colleague');
  assert.equal(firstNameOf(null), 'colleague');
});

test('dates render in UK English and in UTC', () => {
  assert.equal(formatDate('2026-08-17T00:00:00Z'), '17 August 2026');
  // A receipt is a formal record: the template says '(UTC)', so this must be
  // UTC whatever the server's zone is.
  assert.equal(formatDateTimeUtc('2026-08-10T14:03:11Z'), '10 August 2026 at 14:03');
  assert.equal(formatDate('not a date'), '');
});

test('sizes and long descriptions render for a person', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2 KB');
  assert.equal(formatBytes(3 * 1024 * 1024), '3.0 MB');

  assert.equal(shortDescription('Audited accounts'), 'Audited accounts');
  const long = 'A'.repeat(200);
  assert.equal(shortDescription(long).length, 80);
  assert.ok(shortDescription(long).endsWith('…'));
});

test('admin notifications default to admin@taraniscapital.com and can be redirected', () => {
  assert.equal(adminRecipient({}), 'admin@taraniscapital.com');
  // So the [HUMAN] smoke test can run with every recipient internal.
  assert.equal(adminRecipient({ ADMIN_NOTIFICATION_EMAIL: 'mark@taraniscapital.com' }), 'mark@taraniscapital.com');
});
