/**
 * TOTP enrolment and verification.
 *
 * Covers the three code changes HANDOVER-CW015 §3 asks for and the three unit
 * tests its §4 names. Both failures they guard against were reported as
 * "invalid code" and neither had anything to do with the code being wrong: one
 * was a phone clock a few seconds out, the other was a second press of "Begin
 * Setup" silently replacing the secret the user had already scanned.
 *
 * Same harness as the rest of the suite — the fake pool, no container, no
 * network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authenticator } from 'otplib';
import authRoutes, { normaliseTotpCode } from '../src/routes/auth.js';
import { fakePool, startTestServer, tokenFor } from './helpers/test-app.js';

const SECRET = authenticator.generateSecret();

/** The code for the step `steps` away from now. */
function codeAtOffset(secret, steps) {
  const stepSeconds = 30;
  const at = new Date(Date.now() + steps * stepSeconds * 1000);
  // otplib reads the clock; move the clock rather than reach into its internals.
  const realNow = Date.now;
  Date.now = () => at.getTime();
  try {
    return authenticator.generate(secret);
  } finally {
    Date.now = realNow;
  }
}

async function withServer(pool, fn) {
  const server = await startTestServer([['/auth', authRoutes]], pool);
  try {
    return await fn(server);
  } finally {
    await server.close();
  }
}

// ---------------------------------------------------------------------------
// Change 1 — one step of drift either side
// ---------------------------------------------------------------------------

test('a code from the previous or next 30-second step validates', () => {
  // The whole of the AdrenoMed enrolment failure: every app on a phone reads
  // that phone's clock, so a device half a minute out produces codes that a
  // zero-tolerance window rejects without ever saying why.
  assert.equal(authenticator.check(codeAtOffset(SECRET, -1), SECRET), true, 'previous step');
  assert.equal(authenticator.check(authenticator.generate(SECRET), SECRET), true, 'current step');
  assert.equal(authenticator.check(codeAtOffset(SECRET, 1), SECRET), true, 'next step');
});

test('a code two steps away is still rejected', () => {
  // Tolerance, not an open door. Ninety seconds is the whole of the widening.
  assert.equal(authenticator.check(codeAtOffset(SECRET, -2), SECRET), false, 'two steps back');
  assert.equal(authenticator.check(codeAtOffset(SECRET, 2), SECRET), false, 'two steps forward');
});

// ---------------------------------------------------------------------------
// Change 2 — /mfa/setup is idempotent while enrolment is unfinished
// ---------------------------------------------------------------------------

test('two calls to /mfa/setup without a verify return the same secret', async () => {
  // A refresh, a second tab or a second press of Begin Setup used to mint a new
  // secret and overwrite the stored one, invalidating whatever had already been
  // scanned. Codes from the scanned entry could then never validate.
  let stored = null;
  const pool = fakePool([
    ['SELECT totp_secret, totp_verified FROM user_mfa', () => (stored ? [stored] : [])],
    ['INSERT INTO user_mfa', (params) => {
      stored = { totp_secret: params[1], totp_verified: false };
      return [];
    }],
  ]);

  await withServer(pool, async ({ request }) => {
    const token = tokenFor({ role: 'company', mfaPending: true });
    const first = await request('/auth/mfa/setup', { method: 'POST', token });
    const second = await request('/auth/mfa/setup', { method: 'POST', token });

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(second.body.secret, first.body.secret);
    assert.ok(second.body.qrCode.startsWith('data:image/png;base64,'));
  });

  // And the second call wrote nothing: one insert, from the first call only.
  const inserts = pool.sql().filter((text) => text.includes('INSERT INTO user_mfa'));
  assert.equal(inserts.length, 1, 'the second call overwrote the stored secret');
});

test('/mfa/setup issues a fresh secret when the existing row is verified', async () => {
  // Re-enrolment is the one case that must overwrite: someone with a new phone
  // has no way back otherwise.
  const pool = fakePool([
    ['SELECT totp_secret, totp_verified FROM user_mfa', [{ totp_secret: SECRET, totp_verified: true }]],
    ['INSERT INTO user_mfa', []],
  ]);

  await withServer(pool, async ({ request }) => {
    const res = await request('/auth/mfa/setup', {
      method: 'POST',
      token: tokenFor({ role: 'company' }),
    });
    assert.equal(res.status, 200);
    assert.notEqual(res.body.secret, SECRET);
  });

  assert.equal(
    pool.sql().filter((text) => text.includes('INSERT INTO user_mfa')).length,
    1,
    're-enrolment must replace the old secret'
  );
});

// ---------------------------------------------------------------------------
// Change 3 — codes as people actually submit them
// ---------------------------------------------------------------------------

test('normaliseTotpCode keeps the digits and drops everything else', () => {
  assert.equal(normaliseTotpCode('123 456'), '123456');
  assert.equal(normaliseTotpCode(' 123-456\n'), '123456');
  assert.equal(normaliseTotpCode(undefined), '');
  assert.equal(normaliseTotpCode(null), '');
});

test('/mfa/verify accepts a code pasted as "123 456"', async () => {
  const code = authenticator.generate(SECRET);
  const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;

  const pool = fakePool([
    ['SELECT * FROM user_mfa', [{ user_id: 'user-1', totp_secret: SECRET, totp_verified: false }]],
    ['UPDATE user_mfa', []],
    ['INSERT INTO audit_log', []],
  ]);

  await withServer(pool, async ({ request }) => {
    const res = await request('/auth/mfa/verify', {
      method: 'POST',
      token: tokenFor({ role: 'company' }),
      body: { code: spaced },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.recoveryCodes.length, 8);
  });
});

test('/mfa/verify still rejects a wrong code', async () => {
  const pool = fakePool([
    ['SELECT * FROM user_mfa', [{ user_id: 'user-1', totp_secret: SECRET, totp_verified: false }]],
  ]);

  await withServer(pool, async ({ request }) => {
    const res = await request('/auth/mfa/verify', {
      method: 'POST',
      token: tokenFor({ role: 'company' }),
      body: { code: '000 000' },
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /Invalid code/);
  });
});
