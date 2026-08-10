/**
 * Bounce and complaint ingestion.
 *
 * The queue this consumes does not exist yet — it is console work waiting on
 * HANDOVER-C011 §3.3 — so these tests are what stands behind the claim that the
 * code is ready for it. The rule they protect is the one that costs a
 * counterparty their access if it is got wrong: a TRANSIENT bounce must not
 * suppress an address.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakePool } from './helpers/test-app.js';
import {
  suppressionsFromEvent,
  parseQueueMessage,
  applySesEvent,
  pollOnce,
} from '../src/services/ses-events.js';

const hardBounce = {
  eventType: 'Bounce',
  bounce: {
    bounceType: 'Permanent',
    bounceSubType: 'General',
    bouncedRecipients: [{ emailAddress: 'gone@examplebio.com' }],
  },
  mail: { source: 'notifications@mail.taraniscapital.com' },
};

const softBounce = {
  eventType: 'Bounce',
  bounce: {
    bounceType: 'Transient',
    bounceSubType: 'MailboxFull',
    bouncedRecipients: [{ emailAddress: 'busy@examplebio.com' }],
  },
};

const complaint = {
  eventType: 'Complaint',
  complaint: { complainedRecipients: [{ emailAddress: 'annoyed@examplebio.com' }] },
};

test('a hard bounce suppresses the address', () => {
  assert.deepEqual(suppressionsFromEvent(hardBounce), [
    { email: 'gone@examplebio.com', reason: 'bounce' },
  ]);
});

test('a transient bounce suppresses nothing', () => {
  // A full mailbox or a greylist is exactly what the retry is for. Suppressing
  // on one would lock a company out of its own diligence over a condition that
  // clears itself.
  assert.deepEqual(suppressionsFromEvent(softBounce), []);
});

test('a complaint suppresses the address', () => {
  assert.deepEqual(suppressionsFromEvent(complaint), [
    { email: 'annoyed@examplebio.com', reason: 'complaint' },
  ]);
});

test('the older notificationType shape is understood too', () => {
  // Which shape arrives depends on how the topic was wired in the console,
  // which this code cannot pin down.
  assert.deepEqual(
    suppressionsFromEvent({ ...hardBounce, eventType: undefined, notificationType: 'Bounce' }),
    [{ email: 'gone@examplebio.com', reason: 'bounce' }]
  );
});

test('deliveries, opens and rubbish are ignored', () => {
  assert.deepEqual(suppressionsFromEvent({ eventType: 'Delivery' }), []);
  assert.deepEqual(suppressionsFromEvent({ eventType: 'Open' }), []);
  assert.deepEqual(suppressionsFromEvent(null), []);
  assert.deepEqual(suppressionsFromEvent('not an object'), []);
});

test('applying an event writes the suppression with the provider record attached', async () => {
  const pool = fakePool([['INSERT INTO email_suppressions', [{ id: 's-1' }]]]);

  const count = await applySesEvent(hardBounce, { pool });

  assert.equal(count, 1);
  const [call] = pool.calls;
  assert.equal(call.params[0], 'gone@examplebio.com');
  assert.equal(call.params[1], 'bounce');
  // The whole event, so a disputed suppression is answered with SES's own words.
  assert.deepEqual(JSON.parse(call.params[2]), hardBounce);
});

test('an SNS envelope is unwrapped, and a bare event is passed through', () => {
  const enveloped = JSON.stringify({ Type: 'Notification', Message: JSON.stringify(hardBounce) });
  assert.deepEqual(parseQueueMessage(enveloped), hardBounce);

  assert.deepEqual(parseQueueMessage(JSON.stringify(hardBounce)), hardBounce);
  assert.equal(parseQueueMessage('{ not json'), null);
});

test('polling applies each message and then deletes it', async () => {
  const deleted = [];
  const commands = {
    ReceiveMessageCommand: class { constructor(input) { this.input = input; this.kind = 'receive'; } },
    DeleteMessageCommand: class { constructor(input) { this.input = input; this.kind = 'delete'; } },
  };
  const sqs = {
    async send(command) {
      if (command.kind === 'delete') {
        deleted.push(command.input.ReceiptHandle);
        return {};
      }
      return {
        Messages: [
          { Body: JSON.stringify({ Message: JSON.stringify(hardBounce) }), ReceiptHandle: 'r-1' },
          { Body: JSON.stringify(softBounce), ReceiptHandle: 'r-2' },
        ],
      };
    },
  };
  const pool = fakePool([['INSERT INTO email_suppressions', [{ id: 's-1' }]]]);

  const result = await pollOnce({ sqs, commands, queueUrl: 'q', pool });

  assert.equal(result.received, 2);
  assert.equal(result.applied, 1, 'the transient bounce should not have suppressed anything');
  // Deleted only after the suppression is committed. A crash in between means
  // the message returns and is applied again, which is harmless.
  assert.deepEqual(deleted, ['r-1', 'r-2']);
});

test('an unparseable message is deleted rather than blocking the queue behind it', async () => {
  const deleted = [];
  const commands = {
    ReceiveMessageCommand: class { constructor(i) { this.input = i; this.kind = 'receive'; } },
    DeleteMessageCommand: class { constructor(i) { this.input = i; this.kind = 'delete'; } },
  };
  const sqs = {
    async send(command) {
      if (command.kind === 'delete') { deleted.push(command.input.ReceiptHandle); return {}; }
      return { Messages: [{ Body: '{ not json', ReceiptHandle: 'r-9' }] };
    },
  };

  const result = await pollOnce({ sqs, commands, queueUrl: 'q', pool: fakePool([]) });

  assert.equal(result.applied, 0);
  assert.deepEqual(deleted, ['r-9']);
});
