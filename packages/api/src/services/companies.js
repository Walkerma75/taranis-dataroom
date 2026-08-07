/**
 * Company DD portal domain logic.
 *
 * The rules that decide whether a company can be activated, what a company is
 * allowed to see, what state a checklist item is in and what a receipt is
 * called all live here rather than in the route handlers, so they can be tested
 * as plain functions with no database, no HTTP and no Express.
 *
 * The few functions that do need the database take the pool through the
 * imported facade, which tests swap out (see `setPool` in db.js).
 */
import path from 'path';
import { pool } from '../db.js';

// ---------------------------------------------------------------------------
// Activation gates
// ---------------------------------------------------------------------------

/**
 * A company may only be activated once BOTH gates are recorded: the executed
 * NDA and the IEMS counterparty screen. This is the rule the first real cohort
 * exercises — one company holds an NDA but has no IEMS screen, and must be
 * impossible to activate.
 *
 * Returns the list of missing gates. Empty means the company may be activated.
 */
export function missingActivationGates(company) {
  const missing = [];
  if (!company?.nda_executed_at) missing.push('nda_executed_at');
  if (!company?.iems_screened_at) missing.push('iems_screened_at');
  return missing;
}

export function canActivate(company) {
  return missingActivationGates(company).length === 0;
}

/** Human-readable refusal, for the admin UI. UK English, no em dashes. */
export function activationRefusalMessage(company) {
  const missing = missingActivationGates(company);
  if (missing.length === 0) return null;
  const names = {
    nda_executed_at: 'the executed NDA date',
    iems_screened_at: 'the IEMS screening date',
  };
  const list = missing.map((m) => names[m]).join(' and ');
  return `This company cannot be activated until ${list} has been recorded.`;
}

// ---------------------------------------------------------------------------
// Invitation gate
// ---------------------------------------------------------------------------

/**
 * A company user may only be invited once the company is ACTIVE.
 *
 * Before activation the workspace does not exist: a checklist is only seeded at
 * activation, and `requireCompany` refuses a pending company outright. So an
 * invitation issued early buys the invitee nothing but a sign-in, an MFA
 * enrolment and an empty screen, which is the opposite of the onboarding the
 * concept brief §4.1 describes, where the invitation is the moment the company
 * is brought in. Suspended and offboarded are refused for the mirror reason:
 * their access has been taken away, and issuing an invitation would hand out a
 * link that cannot be used.
 *
 * Deliberately not a queue. There is no "invite now, send on activation"
 * behaviour to get wrong; the rule is simply that activation comes first
 * (HANDOVER-CW005 §5).
 */
export function canInviteUsers(company) {
  return company?.status === 'active';
}

/** Human-readable refusal naming the status and what would fix it. */
export function inviteRefusalMessage(company) {
  if (canInviteUsers(company)) return null;
  switch (company?.status) {
    case 'suspended':
      return 'This company is suspended, so its access is closed and nobody can be '
           + 'invited. Reinstate it first.';
    case 'offboarded':
      return 'This company has been offboarded. Its access is closed permanently and '
           + 'nobody can be invited.';
    default:
      return 'This company is pending. Record both activation gates and activate it '
           + 'before inviting users, because until then they would see nothing.';
  }
}

// ---------------------------------------------------------------------------
// Company-side visibility
// ---------------------------------------------------------------------------

/**
 * States a company never sees on its own checklist.
 *
 * 'held' means Taranis already has the item in full, so asking for it again
 * wastes the company's time. 'partially_held' IS shown, because the company
 * still has something to supply. This matches the GAPS working-file convention:
 * a company sees what is outstanding or partial, and nothing else.
 */
export const STATES_HIDDEN_FROM_COMPANY = ['held'];

export function isVisibleToCompany(item) {
  return !STATES_HIDDEN_FROM_COMPANY.includes(item?.state);
}

export function companyVisibleItems(items = []) {
  return items.filter(isVisibleToCompany);
}

/**
 * Strip everything a company must never receive, whatever the caller asked for.
 * Applied on the way out of every company-side response that carries an item.
 */
export function companySafeItem(item) {
  if (!item) return item;
  const { internal_note: _internalNote, ...safe } = item;
  return safe;
}

// ---------------------------------------------------------------------------
// Item state derivation
// ---------------------------------------------------------------------------

/**
 * The states that describe what Taranis holds independently of any submission,
 * and so the only ones an item may fall back to. The rest are a projection of
 * the files and are derived, never stored as a baseline.
 */
export const BASELINE_STATES = ['outstanding', 'partially_held', 'held'];

export function isBaselineState(state) {
  return BASELINE_STATES.includes(state);
}

/**
 * Derive a checklist item's state from the files submitted against it, per the
 * code brief §4 rules, in this precedence:
 *
 *   1. any file 'attention_needed'          -> attention_needed
 *   2. at least one file, all 'completed'   -> completed
 *   3. any file 'in_review'                 -> in_review
 *   4. any submitted file                   -> received
 *   5. otherwise                            -> the baseline state, unchanged
 *
 * Baseline states ('held', 'partially_held', 'outstanding') and an explicit
 * 'not_applicable' therefore survive until a file actually arrives.
 * Only SUBMITTED files count. Staged files are not a submission and must never
 * move an item off 'outstanding'.
 *
 * A 'superseded' file is excluded alongside a deleted one: a version that a
 * newer one has overtaken is not awaiting anything from anyone, and leaving it
 * in the reckoning is what kept an item flagged for ever after the company had
 * already sent the correction (HANDOVER-CW010). Note what this does NOT do: a
 * superseded file is excluded, not reinterpreted, so an item whose only
 * submitted file has been superseded falls back to its baseline rather than
 * inheriting anything from the retired version. That is honest — nothing
 * currently submitted answers the request — and it is why the baseline had to
 * become a stored fact (migration 016).
 */
export function deriveItemState(files = [], baselineState = 'outstanding') {
  const submitted = files.filter(
    (f) => f.upload_state === 'submitted' && !f.deleted_at && f.status !== 'superseded'
  );

  if (submitted.length === 0) return baselineState;
  if (submitted.some((f) => f.status === 'attention_needed')) return 'attention_needed';
  if (submitted.every((f) => f.status === 'completed')) return 'completed';
  if (submitted.some((f) => f.status === 'in_review')) return 'in_review';
  return 'received';
}

/** Recompute and persist one item's state. Returns the new state. */
export async function recomputeItemState(itemId, client = pool) {
  const { rows: [item] } = await client.query(
    `SELECT id, state, baseline_state FROM company_irl_items WHERE id = $1`,
    [itemId]
  );
  if (!item) return null;

  const { rows: files } = await client.query(
    `SELECT upload_state, status, deleted_at FROM company_files WHERE irl_item_id = $1`,
    [itemId]
  );

  // 'not_applicable' is a deliberate reviewer decision and is never derived
  // away by a file arriving.
  if (item.state === 'not_applicable') return item.state;

  // The state to fall back to when nothing submitted counts. Read from the
  // column rather than inferred from the current state: since a file can now be
  // superseded, an item can travel backwards, and inferring would have answered
  // 'outstanding' for anything that had ever moved. See migration 016.
  const next = deriveItemState(files, item.baseline_state || 'outstanding');

  if (next !== item.state) {
    await client.query(
      `UPDATE company_irl_items SET state = $2, updated_at = NOW() WHERE id = $1`,
      [itemId, next]
    );
  }
  return next;
}

// ---------------------------------------------------------------------------
// Receipt references
// ---------------------------------------------------------------------------

/**
 * Format a receipt reference. Unique and non-decreasing because the number
 * comes from a Postgres sequence, not from a row count: a count repeats itself
 * the moment two submissions race, and reuses a reference if a batch is ever
 * removed.
 */
export function formatReceiptRef(sequenceValue, when = new Date()) {
  const year = when.getUTCFullYear();
  return `TRN-DD-${year}-${String(sequenceValue).padStart(6, '0')}`;
}

/** Take the next reference. Sequences are non-transactional by design here. */
export async function nextReceiptRef(client = pool, when = new Date()) {
  const { rows: [row] } = await client.query(
    `SELECT nextval('company_receipt_ref_seq') AS n`
  );
  return formatReceiptRef(row.n, when);
}

// ---------------------------------------------------------------------------
// Upload rules
// ---------------------------------------------------------------------------

/** Code brief §8. Deliberately narrower than the fund-side document list. */
export const COMPANY_ALLOWED_EXTENSIONS = [
  '.pdf', '.docx', '.xlsx', '.pptx', '.csv', '.txt', '.png', '.jpg', '.jpeg', '.zip',
];

export const COMPANY_MAX_FILE_BYTES = 200 * 1024 * 1024; // 200 MB

export function isAllowedCompanyUpload(filename) {
  return COMPANY_ALLOWED_EXTENSIONS.includes(path.extname(filename || '').toLowerCase());
}

/**
 * Build the S3 key for a company file.
 *
 *   companies/{companyId}/{irlItemId|additional}/{fileId}/{filename}
 *
 * Company files and fund documents never share a key prefix, so no company
 * object is reachable through a fund document path or the reverse. The filename
 * is sanitised because it reaches an S3 key and a Content-Disposition header.
 */
export function buildCompanyFileKey({ companyId, irlItemId, fileId, filename }) {
  const slot = irlItemId || 'additional';
  const safe = String(filename || 'file')
    .replace(/[\\/]/g, '_')
    .replace(/[\r\n]/g, '')
    .trim() || 'file';
  return `companies/${companyId}/${slot}/${fileId}/${safe}`;
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

/**
 * Counts by state plus a completion percentage, for the workspace header and
 * the admin pipeline. 'not_applicable' and 'held' items are excluded from the
 * denominator: neither is work anyone still has to do.
 */
export function summariseProgress(items = []) {
  const counts = {};
  for (const item of items) {
    counts[item.state] = (counts[item.state] || 0) + 1;
  }
  const countable = items.filter((i) => !['not_applicable', 'held'].includes(i.state));
  const done = countable.filter((i) => i.state === 'completed').length;
  return {
    counts,
    total: items.length,
    countable: countable.length,
    completed: done,
    percentComplete: countable.length === 0 ? 0 : Math.round((done / countable.length) * 100),
  };
}

// ---------------------------------------------------------------------------
// Seeding a company checklist from a template
// ---------------------------------------------------------------------------

/**
 * Copy template items into a company's checklist. Copying rather than
 * referencing means a per-company edit never mutates the template and never
 * leaks to another company.
 *
 * Items Taranis already holds are seeded 'held' or 'partially_held' from the
 * template's `already_held` column; everything else starts 'outstanding'.
 *
 * Idempotent: a re-run inserts nothing, because (company_id, ref) is unique and
 * the insert skips conflicts. Activating an already-seeded company is therefore
 * safe.
 */
export function seedStateFor(alreadyHeld) {
  const value = (alreadyHeld || '').trim().toLowerCase();
  if (!value) return 'outstanding';
  if (value === 'partial' || value.startsWith('partial')) return 'partially_held';
  return 'held';
}

export async function seedCompanyChecklist({ companyId, templateId }, client = pool) {
  const { rows: templateItems } = await client.query(
    `SELECT id, section, ref, description, priority, sort_order, already_held, note_for_company
     FROM irl_template_items WHERE template_id = $1 ORDER BY sort_order`,
    [templateId]
  );

  let inserted = 0;
  for (const t of templateItems) {
    // `state` and `baseline_state` start equal and then diverge: the first
    // tracks the files, the second stays put so the item has somewhere honest
    // to fall back to once a file is superseded (migration 016).
    const seeded = seedStateFor(t.already_held);
    const { rowCount } = await client.query(
      `INSERT INTO company_irl_items
         (company_id, template_item_id, section, ref, description, priority, state,
          baseline_state, already_held, note_for_company, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (company_id, ref) DO NOTHING`,
      [
        companyId, t.id, t.section, t.ref, t.description, t.priority,
        seeded, seeded, t.already_held, t.note_for_company, t.sort_order,
      ]
    );
    inserted += rowCount;
  }
  return { templateItems: templateItems.length, inserted };
}

// ---------------------------------------------------------------------------
// Membership and access lookups
// ---------------------------------------------------------------------------

/**
 * The live company membership for a user, or null.
 *
 * Read fresh on every request rather than trusted from the token: an access
 * token lives 15 minutes, and a company user who is deactivated, or whose
 * company is suspended, must lose access immediately rather than at expiry.
 */
export async function loadCompanyMembership(userId, client = pool) {
  const { rows: [row] } = await client.query(
    `SELECT cu.id            AS membership_id,
            cu.company_id,
            cu.company_role,
            cu.is_primary,
            cu.approved_by,
            cu.deactivated_at,
            c.legal_name,
            c.status         AS company_status,
            c.fund_id
     FROM company_users cu
     JOIN companies c ON c.id = cu.company_id
     WHERE cu.user_id = $1 AND cu.deactivated_at IS NULL
     ORDER BY cu.created_at
     LIMIT 1`,
    [userId]
  );
  return row || null;
}

/**
 * Whether a Taranis-side user may see a company at all, and at what level.
 * Admins see everything. Everyone else needs an explicit `company_reviewers`
 * row, which is what lets a specialist consultant see exactly one company.
 * Returns 'admin' | 'reviewer' | 'readonly' | null.
 */
export async function taranisAccessLevel({ userId, role, companyId }, client = pool) {
  if (role === 'admin') return 'admin';
  if (role === 'company') return null;

  const { rows: [row] } = await client.query(
    `SELECT level FROM company_reviewers WHERE user_id = $1 AND company_id = $2`,
    [userId, companyId]
  );
  return row?.level || null;
}

/** Reviewer level and admin can change things; readonly cannot. */
export function canWriteAtLevel(level) {
  return level === 'admin' || level === 'reviewer';
}
