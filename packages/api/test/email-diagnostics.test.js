/**
 * "What happened to the email we sent this person?"
 *
 * Before this endpoint the answer lived in two tables on an instance in a
 * private subnet, and a send withheld for suppression was recorded as an outbox
 * row that nothing ever showed anyone. An administrator resending an invitation
 * was told it worked whether or not it could possibly have gone out, which is
 * how two AdrenoMed invitations went missing without anybody knowing
 * (HANDOVER-CW015 §2A, §3.4).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import maintenanceRoutes from '../src/routes/maintenance.js';
import { emailStatusFor } from '../src/services/notifications.js';
import { getSesSuppression } from '../src/services/email.js';
import { fakePool, startTestServer, tokenFor } from './helpers/test-app.js';

const ADDRESS = 'rjones@example.com';

const outboxRows = [
  {
    id: 'n-2',
    template: 'company-invite',
    recipient: ADDRESS,
    status: 'suppressed',
    attempts: 1,
    last_error: 'Recipient is on the suppression list; send withheld.',
    message_id: null,
    created_at: '2026-08-19T09:00:00.000Z',
    send_after: '2026-08-19T09:00:00.000Z',
    sent_at: '2026-08-19T09:00:05.000Z',
  },
];

const suppressionRows = [
  {
    id: 's-1',
    email: ADDRESS,
    reason: 'bounce',
    detail: { bounce: { bounceType: 'Permanent' } },
    suppressed_at: '2026-08-14T10:00:00.000Z',
    released_at: null,
    released_by: null,
    released_reason: null,
  },
];

function diagnosticsPool(extra = []) {
  return fakePool([
    ['FROM notification_outbox', outboxRows],
    ['FROM email_suppressions', suppressionRows],
    ['INSERT INTO audit_log', []],
    ...extra,
  ]);
}

async function withServer(pool, fn) {
  const server = await startTestServer([['/maintenance', maintenanceRoutes]], pool);
  try {
    return await fn(server);
  } finally {
    await server.close();
  }
}

test('emailStatusFor reports the outbox and the suppression, matched case-insensitively', async () => {
  const pool = diagnosticsPool();
  const status = await emailStatusFor('RJones@Example.com', { pool });

  assert.equal(status.email, ADDRESS);
  assert.equal(status.suppressed, true, 'a row with no released_at is a live suppression');
  assert.equal(status.outbox.length, 1);
  assert.equal(status.outbox[0].status, 'suppressed');
  assert.equal(status.suppressions.length, 1);

  // The lookup must be lower-cased on both sides; migration 018 stores lower.
  const [outboxCall] = pool.calls;
  assert.equal(outboxCall.params[0], ADDRESS);
});

test('a released suppression does not read as suppressed', async () => {
  const pool = fakePool([
    ['FROM notification_outbox', []],
    ['FROM email_suppressions', [{
      ...suppressionRows[0],
      released_at: '2026-08-20T08:00:00.000Z',
      released_by: 'admin-1',
    }]],
  ]);
  const status = await emailStatusFor(ADDRESS, { pool });
  assert.equal(status.suppressed, false);
  assert.equal(status.suppressions.length, 1, 'the history stays; only the effect is lifted');
});

test('an admin can retrieve outbox and suppression state for any address', async () => {
  await withServer(diagnosticsPool(), async ({ request }) => {
    const res = await request(`/maintenance/email-status?email=${encodeURIComponent(ADDRESS)}`, {
      token: tokenFor({ sub: 'admin-1', role: 'admin' }),
    });

    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.email, ADDRESS);
    assert.equal(res.body.suppressed, true);
    assert.equal(res.body.outbox[0].template, 'company-invite');
    // Outside production there is no SES to ask; the endpoint says so rather
    // than implying the address is clear.
    assert.equal(res.body.sesSuppression.available, false);
  });
});

test('email-status refuses to guess when no address is given', async () => {
  await withServer(diagnosticsPool(), async ({ request }) => {
    const res = await request('/maintenance/email-status', {
      token: tokenFor({ sub: 'admin-1', role: 'admin' }),
    });
    assert.equal(res.status, 400);
  });
});

test('a company user cannot read another party email history', async () => {
  // The router is admin-only and rejects the company role before that. An
  // outbox row names a counterparty and what was said to them.
  await withServer(diagnosticsPool(), async ({ request }) => {
    const res = await request(`/maintenance/email-status?email=${ADDRESS}`, {
      token: tokenFor({ role: 'company', companyId: 'company-1' }),
    });
    assert.equal(res.status, 403);
  });
});

test('releasing a suppression marks the row released rather than deleting it', async () => {
  const pool = diagnosticsPool([
    ['UPDATE email_suppressions', { rows: [], rowCount: 1 }],
  ]);

  await withServer(pool, async ({ request }) => {
    const res = await request('/maintenance/email-suppressions/release', {
      method: 'POST',
      token: tokenFor({ sub: 'admin-1', role: 'admin' }),
      body: { email: ADDRESS, reason: 'Gateway whitelisted; bounce was AdrenoMed-side.' },
    });

    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.released, 1);
  });

  const update = pool.calls.find((c) => c.text.includes('UPDATE email_suppressions'));
  assert.ok(update, 'the release must go through the service');
  assert.ok(update.text.includes('released_at = NOW()'));
  assert.ok(!pool.sql().some((text) => text.includes('DELETE FROM email_suppressions')));
  assert.equal(update.params[1], 'admin-1', 'a release is attributable');
});

test('releasing when nothing is suppressed says so instead of claiming a fix', async () => {
  const pool = diagnosticsPool([
    ['UPDATE email_suppressions', { rows: [], rowCount: 0 }],
  ]);

  await withServer(pool, async ({ request }) => {
    const res = await request('/maintenance/email-suppressions/release', {
      method: 'POST',
      token: tokenFor({ sub: 'admin-1', role: 'admin' }),
      body: { email: ADDRESS },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.released, 0);
    assert.match(res.body.message, /nothing to lift/);
  });
});

test('getSesSuppression reports NotFound as not suppressed, not as a failure', async () => {
  const notFound = Object.assign(new Error('not found'), { name: 'NotFoundException' });
  const result = await getSesSuppression(ADDRESS, {
    client: { send: async () => { throw notFound; } },
    commands: { GetSuppressedDestinationCommand: class { constructor(input) { this.input = input; } } },
  });
  assert.deepEqual(result, { available: true, suppressed: false });
});

test('getSesSuppression degrades to a reason when the task role cannot read the list', async () => {
  // The account-level list is the only record of a hard bounce until the SES
  // event queue is wired, so a missing permission must be reported, never
  // rendered as a clean bill of health.
  const denied = Object.assign(new Error('User is not authorized'), { name: 'AccessDeniedException' });
  const result = await getSesSuppression(ADDRESS, {
    client: { send: async () => { throw denied; } },
    commands: { GetSuppressedDestinationCommand: class {} },
  });
  assert.equal(result.available, false);
  assert.match(result.error, /AccessDeniedException/);
  assert.equal(result.suppressed, undefined);
});

test('getSesSuppression reports what SES is holding', async () => {
  const result = await getSesSuppression(ADDRESS, {
    client: {
      send: async () => ({
        SuppressedDestination: {
          EmailAddress: ADDRESS,
          Reason: 'BOUNCE',
          LastUpdateTime: new Date('2026-08-14T10:00:00.000Z'),
        },
      }),
    },
    commands: { GetSuppressedDestinationCommand: class {} },
  });
  assert.equal(result.available, true);
  assert.equal(result.suppressed, true);
  assert.equal(result.reason, 'BOUNCE');
  assert.equal(result.lastUpdate, '2026-08-14T10:00:00.000Z');
});
