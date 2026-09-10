/**
 * Absolute URLs for the links that go in emails.
 *
 * WHY THIS EXISTS. Until Phase 1b nothing in the API needed to know its own
 * public address: every link it produced was relative and a browser resolved
 * it. `POST /companies/:id/users` returned `/invite/accept?token=...` for an
 * administrator to paste, and that was enough. An email has no browser to
 * resolve against, so every one of the ten templates needs a link that works
 * from a mail client on a phone, which means absolute, which means the API has
 * to be told what it is called from outside.
 *
 * `PORTAL_URL` is that. It is set on the ECS task definition, like `S3_BUCKET`
 * and `AWS_REGION`, and NOT in the repo.
 *
 * FAILING LOUDLY. With `PORTAL_URL` unset in production, `assertConfigured()`
 * throws at startup, before `listen()`, so the task never serves traffic. The
 * alternative — carrying on and sending invitations whose only button points at
 * `undefined/invite/accept` — would be discovered by a counterparty, in the
 * first message they ever receive from the platform. Local development falls
 * back to the Vite dev server so `docker compose up` still works, exactly as
 * storage falls back to local disk.
 *
 * The paths below are the real client routes in `packages/web/src/App.jsx`. If
 * a route moves, it moves here too, and `test/links.test.js` is the reminder.
 */

const DEV_FALLBACK = 'http://localhost:5173';

/** Strip trailing slashes so joining never produces '//'. */
function normaliseBase(url) {
  return String(url).replace(/\/+$/, '');
}

export function portalBase(env = process.env) {
  const configured = env.PORTAL_URL;
  if (configured) return normaliseBase(configured);
  return DEV_FALLBACK;
}

/**
 * Called once at startup. Throws in production when `PORTAL_URL` is missing or
 * is not an absolute http(s) URL.
 */
export function assertConfigured(env = process.env) {
  const configured = env.PORTAL_URL;

  if (!configured) {
    if (env.NODE_ENV === 'production') {
      throw new Error(
        'PORTAL_URL is not set. Platform email cannot be sent without an '
        + 'absolute base URL: every template links back to the portal, and a '
        + 'relative link in an email is a dead link. Set PORTAL_URL on the ECS '
        + 'task definition (https://dataroom.taraniscapital.com).'
      );
    }
    console.warn(
      `[links] PORTAL_URL is not set — email links will point at ${DEV_FALLBACK}. `
      + 'Development only.'
    );
    return DEV_FALLBACK;
  }

  if (!/^https?:\/\//i.test(configured)) {
    throw new Error(`PORTAL_URL must be an absolute http(s) URL, got: ${configured}`);
  }

  return normaliseBase(configured);
}

const path = (p, env) => `${portalBase(env)}${p}`;

// --- Company side ----------------------------------------------------------

/** The one-time invitation link. `token` is the raw token, never the hash. */
export const inviteUrl = (token, env) =>
  path(`/invite/accept?token=${encodeURIComponent(token)}`, env);

/** The company's own workspace: its checklist and progress. */
export const workspaceUrl = (env) => path('/company', env);

/** One checklist item, where a company uploads against a request. */
export const itemUrl = (itemId, env) => path(`/company/items/${encodeURIComponent(itemId)}`, env);

/** The company's submission receipts. */
export const companyReceiptsUrl = (env) => path('/company/receipts', env);

// --- Taranis side ----------------------------------------------------------

/** The review queue: everything companies have submitted, awaiting review. */
export const adminReviewUrl = (env) => path('/admin/review-queue', env);

/**
 * The admin dashboard, which is where the due diligence section lives.
 *
 * The daily digest links here rather than to the review queue: the digest
 * reports both sides of the exchange, and the review queue only shows one of
 * them.
 */
export const dashboardUrl = (env) => path('/dashboard', env);

/**
 * A nomination is approved from inside the company it belongs to, never from a
 * shared list with a company picker (HANDOVER-C006 §3.2), so the notification
 * links to the company rather than to a nominations screen.
 */
export const adminNominationUrl = (companyId, env) =>
  path(`/admin/companies/${encodeURIComponent(companyId)}`, env);

/** One company's detail page on the Taranis side. */
export const adminCompanyUrl = (companyId, env) =>
  path(`/admin/companies/${encodeURIComponent(companyId)}`, env);
