/**
 * Adviser access to a company's due diligence: the ONE place that decides.
 *
 * HANDOVER-CW028. An advisor or board member who already signs in for fund
 * information can be given read access to the relevant parts of one company
 * in diligence, for a set period, by an admin. Two controls:
 *
 *   SCOPE       which checklist sections the grant covers (NULL = all);
 *   RESTRICTION a per-item flag, overridable per file, for material no grant
 *               ever shows: identity documents, bank details, ownership, cap
 *               tables, personal data. No grant, at any level or scope, sees a
 *               restricted file. That is the hard line.
 *
 * Both are enforced in the API on every route that returns items, files, bytes
 * or history, from the functions below and nowhere else, the way
 * `downloadDecision` is one rule for downloads. The web shows only what the API
 * returns.
 *
 * TWO FORMS OF THE SAME RULE. Lists (the Files tab, the review queue) need a
 * SQL predicate; single-row paths (download, history, status) need a predicate
 * on a loaded row. `fileVisibilitySql` and `fileVisibleToGrant` are written
 * side by side here so they say the same thing, and the test suite drives both
 * over one fixture table (HANDOVER-C028 §2.4).
 *
 * TWO-STEP VERIFICATION. A non-admin with a live grant must have TOTP enrolled
 * before reaching company data. Enforced at login (the `mfaPending` token, as
 * for the company role) AND here at the point of access, so a session that
 * pre-dates the grant does not slip through on its token lifetime (C028 §2.2).
 */
import { pool } from '../db.js';

/** Roles that may hold a grant. Never 'investor', never 'company'. */
export const GRANTABLE_ROLES = ['advisor', 'viewer'];

export const GRANT_LEVELS = ['reviewer', 'readonly'];

export const OVERRIDES = ['follow_item', 'restricted', 'released'];

/**
 * The two confirmations, verbatim from HANDOVER-CW028 §3.4. A change to either
 * sentence is a new version; the version given is recorded on the grant.
 */
export const ATTESTATION_VERSION = '2026-09-11';

export function attestationSentences({ personName, companyName }) {
  return {
    confidentiality:
      `${personName} is bound by a confidentiality undertaking to Taranis Capital that covers this `
      + 'company\'s information.',
    ndaPermits:
      `${companyName}'s non-disclosure agreement with Taranis Capital permits disclosure to our `
      + 'advisers under confidence.',
  };
}

/** The default access period offered by the Access tab. */
export const DEFAULT_GRANT_DAYS = 30;

/** An admin's view of a company: everything, no scope, no expiry. */
const ADMIN_ACCESS = Object.freeze({ level: 'admin', grantId: null, sections: null, expiresAt: null });

/**
 * Resolve what a Taranis-side user may see of one company.
 *
 * Returns:
 *   { level: 'admin' }                                   admins
 *   { level, grantId, sections, expiresAt }             a live grant, MFA enrolled
 *   { level, grantId, ..., mfaRequired: true }          a live grant, MFA NOT enrolled
 *   null                                                no live grant, or role 'company'
 *
 * A grant past `expires_at` is not returned at all: it behaves as no grant.
 * `sections` is null for "all sections" or an array of section labels.
 */
export async function resolveCompanyAccess({ userId, role, companyId }, client = pool) {
  if (role === 'admin') return ADMIN_ACCESS;
  if (role === 'company') return null;

  const { rows: [row] } = await client.query(
    `SELECT r.id, r.level, r.sections, r.expires_at,
            COALESCE(m.totp_verified, FALSE) AS totp_verified
     FROM company_reviewers r
     LEFT JOIN user_mfa m ON m.user_id = r.user_id
     WHERE r.user_id = $1 AND r.company_id = $2
       AND (r.expires_at IS NULL OR r.expires_at > NOW())`,
    [userId, companyId]
  );
  if (!row) return null;

  const access = {
    level: row.level,
    grantId: row.id,
    sections: row.sections || null,
    expiresAt: row.expires_at || null,
  };
  if (!row.totp_verified) access.mfaRequired = true;
  return access;
}

/** Whether a user holds any live grant. Feeds the mandatory-MFA rule at login. */
export async function hasLiveCompanyGrant(userId, client = pool) {
  const { rows: [row] } = await client.query(
    `SELECT 1 FROM company_reviewers
     WHERE user_id = $1 AND (expires_at IS NULL OR expires_at > NOW())
     LIMIT 1`,
    [userId]
  );
  return !!row;
}

export function isAdminAccess(access) {
  return access?.level === 'admin';
}

/** Reviewer level and admin can change things; readonly cannot. */
export function canWriteAtLevel(level) {
  return level === 'admin' || level === 'reviewer';
}

/**
 * SQL that restricts a companies query (alias `c`) to companies the caller may
 * see: everything for an admin; otherwise a live grant AND enrolled MFA. The
 * MFA join is here too, so a list never shows a company the detail route would
 * then refuse.
 */
export function companyVisibilitySql(user, params, alias = 'c') {
  if (user.role === 'admin') return '';
  params.push(user.sub);
  return `AND EXISTS (SELECT 1 FROM company_reviewers r
                       JOIN user_mfa m ON m.user_id = r.user_id AND m.totp_verified
                       WHERE r.company_id = ${alias}.id AND r.user_id = $${params.length}
                         AND (r.expires_at IS NULL OR r.expires_at > NOW()))`;
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

/** Whether a checklist item is in the grant's scope. Restricted items in scope ARE shown. */
export function itemInScope(access, item) {
  if (isAdminAccess(access)) return true;
  if (!access) return false;
  if (!access.sections) return true;
  return access.sections.includes(item.section);
}

/**
 * The shape of an item a non-admin may see. `internal_note` and
 * `source_document` are Taranis-side fields that can cite internal material,
 * and never leave for an adviser. A restricted item keeps its row (so its
 * absence is not mistaken for a gap) but reports no files.
 */
export function adviserSafeItem(item) {
  const {
    internal_note: _internalNote,
    source_document: _sourceDocument,
    ...safe
  } = item;
  if (safe.adviser_restricted) {
    if ('submitted_files' in safe) safe.submitted_files = 0;
    if ('expected_by' in safe) safe.expected_by = null;
  }
  return safe;
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/**
 * Whether a file is restricted from advisers, given its own override and its
 * item's flag. A file under no item (an Additional Document) is restricted
 * unless released. This is the one definition; the SQL below restates it.
 */
export function fileIsRestricted({ adviserOverride = 'follow_item', irlItemId, itemRestricted }) {
  if (adviserOverride === 'restricted') return true;
  if (adviserOverride === 'released') return false;
  if (irlItemId === null || irlItemId === undefined) return true;
  return !!itemRestricted;
}

/**
 * Whether a person with `access` may see this file at all: in lists, by id,
 * on download and on history. Admins: always. Otherwise the file must be
 * submitted (never staged), not restricted, and under an item in scope. A
 * released file under no item is in scope for any grant on the company.
 *
 * @param {object} access  from resolveCompanyAccess
 * @param {object} file    { uploadState|upload_state, irlItemId|irl_item_id,
 *                           adviserOverride|adviser_override,
 *                           itemRestricted|item_restricted, itemSection|item_section }
 */
export function fileVisibleToGrant(access, file) {
  if (isAdminAccess(access)) return true;
  if (!access || access.mfaRequired) return false;

  const uploadState = file.uploadState ?? file.upload_state;
  const irlItemId = file.irlItemId ?? file.irl_item_id ?? null;
  const adviserOverride = file.adviserOverride ?? file.adviser_override ?? 'follow_item';
  const itemRestricted = file.itemRestricted ?? file.item_restricted ?? false;
  const itemSection = file.itemSection ?? file.item_section ?? null;

  if (uploadState !== 'submitted') return false;
  if (fileIsRestricted({ adviserOverride, irlItemId, itemRestricted })) return false;
  if (access.sections && irlItemId !== null && !access.sections.includes(itemSection)) return false;
  return true;
}

/**
 * The same rule as `fileVisibleToGrant`, as a SQL fragment for a query over
 * `company_files f LEFT JOIN company_irl_items i ON i.id = f.irl_item_id`.
 * Returns '' for an admin. Pushes the sections array onto `params` when the
 * grant is scoped.
 */
export function fileVisibilitySql(access, params, { fileAlias = 'f', itemAlias = 'i' } = {}) {
  if (isAdminAccess(access)) return '';
  const f = fileAlias;
  const i = itemAlias;
  let sql = ` AND ${f}.upload_state = 'submitted'`
          + ` AND ${f}.adviser_override <> 'restricted'`
          + ` AND (${f}.adviser_override = 'released'`
          + `      OR (${f}.irl_item_id IS NOT NULL AND ${i}.adviser_restricted = FALSE))`;
  if (access?.sections) {
    params.push(access.sections);
    sql += ` AND (${f}.irl_item_id IS NULL OR ${i}.section = ANY($${params.length}::text[]))`;
  }
  return sql;
}

// ---------------------------------------------------------------------------
// Grants: input validation shared by create and edit
// ---------------------------------------------------------------------------

export class GrantInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GrantInputError';
  }
}

/** `sections`: null / 'all' / [] for every section, else a non-empty array of labels. */
export function normaliseSections(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'string') return raw.trim().toLowerCase() === 'all' || !raw.trim() ? null : [raw.trim()];
  if (!Array.isArray(raw)) throw new GrantInputError('sections must be "all" or a list of section labels');
  const cleaned = [...new Set(raw.map((s) => String(s || '').trim()).filter(Boolean))];
  return cleaned.length ? cleaned : null;
}

/** `expiresAt`: required, a valid date, in the future. */
export function parseExpiry(raw, { required = true, now = new Date() } = {}) {
  if (raw === undefined || raw === null || raw === '') {
    if (required) throw new GrantInputError('An access-until date is required');
    return null;
  }
  const when = new Date(raw);
  if (Number.isNaN(when.getTime())) throw new GrantInputError('accessUntil is not a valid date');
  if (when <= now) throw new GrantInputError('The access-until date must be in the future');
  return when;
}

export function defaultExpiry(now = new Date()) {
  const when = new Date(now);
  when.setUTCDate(when.getUTCDate() + DEFAULT_GRANT_DAYS);
  return when;
}

/** Both confirmations must be true, explicitly. */
export function requireAttestations(raw) {
  const a = raw || {};
  if (a.confidentiality !== true || a.ndaPermits !== true) {
    throw new GrantInputError(
      'Both confirmations are required: that the person is bound by a confidentiality undertaking, '
      + 'and that the company\'s NDA permits disclosure to our advisers.'
    );
  }
  return { confidentiality: true, ndaPermits: true };
}

export function isExpired(grant, now = new Date()) {
  return !!grant.expiresAt && new Date(grant.expiresAt) <= now;
}
