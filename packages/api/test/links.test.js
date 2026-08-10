/**
 * Email links.
 *
 * The paths asserted here are the real client routes in
 * `packages/web/src/App.jsx`. If one moves and this file is not updated, the
 * portal keeps working and only the emails break, silently, for the
 * counterparty rather than for us. That asymmetry is why these are tested.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertConfigured,
  portalBase,
  inviteUrl,
  workspaceUrl,
  itemUrl,
  companyReceiptsUrl,
  adminReviewUrl,
  adminNominationUrl,
} from '../src/services/links.js';

const PROD = { PORTAL_URL: 'https://dataroom.taraniscapital.com' };

test('every email link is absolute and points at a real client route', () => {
  assert.equal(
    inviteUrl('abc123', PROD),
    'https://dataroom.taraniscapital.com/invite/accept?token=abc123'
  );
  assert.equal(workspaceUrl(PROD), 'https://dataroom.taraniscapital.com/company');
  assert.equal(itemUrl('i-1', PROD), 'https://dataroom.taraniscapital.com/company/items/i-1');
  assert.equal(companyReceiptsUrl(PROD), 'https://dataroom.taraniscapital.com/company/receipts');
  assert.equal(adminReviewUrl(PROD), 'https://dataroom.taraniscapital.com/admin/review-queue');
  // A nomination is approved from inside the company it belongs to, never from
  // a shared list with a company picker (HANDOVER-C006 §3.2).
  assert.equal(
    adminNominationUrl('c-1', PROD),
    'https://dataroom.taraniscapital.com/admin/companies/c-1'
  );
});

test('a trailing slash on PORTAL_URL does not produce a double slash', () => {
  assert.equal(
    workspaceUrl({ PORTAL_URL: 'https://dataroom.taraniscapital.com/' }),
    'https://dataroom.taraniscapital.com/company'
  );
  assert.equal(portalBase({ PORTAL_URL: 'https://x.test///' }), 'https://x.test');
});

test('tokens and ids are URL-encoded', () => {
  assert.ok(inviteUrl('a b&c=d', PROD).endsWith('token=a%20b%26c%3Dd'));
  assert.ok(itemUrl('a/b', PROD).endsWith('/company/items/a%2Fb'));
});

test('a missing PORTAL_URL fails startup in production', () => {
  // The alternative is invitations whose only button points at
  // 'undefined/invite/accept', discovered by a counterparty in the first
  // message they ever receive from the platform.
  assert.throws(
    () => assertConfigured({ NODE_ENV: 'production' }),
    /PORTAL_URL is not set/
  );
});

test('a missing PORTAL_URL falls back loudly in development', () => {
  const base = assertConfigured({ NODE_ENV: 'development' });
  assert.equal(base, 'http://localhost:5173');
});

test('a PORTAL_URL that is not absolute fails startup anywhere', () => {
  assert.throws(
    () => assertConfigured({ PORTAL_URL: 'dataroom.taraniscapital.com' }),
    /must be an absolute http\(s\) URL/
  );
});
