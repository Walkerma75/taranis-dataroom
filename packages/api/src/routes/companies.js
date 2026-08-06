/**
 * Taranis-side company routes — the deal team's view of due diligence.
 *
 * Access is admin, or a named assignment in `company_reviewers` for one
 * company. `requireCompanyAccess()` resolves which, and answers 404 rather than
 * 403 for a company the caller has no assignment to, so the endpoint cannot be
 * used to enumerate company ids.
 *
 * Role 'company' is refused outright by `rejectCompanyRole` at the mount, and
 * again inside `requireCompanyAccess`.
 *
 * Nothing here sends email. Invitations produce a link for an admin to send by
 * hand, exactly as the existing fund-side invite flow does (HANDOVER-CW004 §3
 * item 3). Notifications to admin@ are Phase 1b.
 */
import { Router } from 'express';
import { pool } from '../db.js';
import {
  requireAuth,
  requireRole,
  rejectCompanyRole,
  requireCompanyAccess,
} from '../middleware/auth.js';
import { logAudit } from '../services/audit.js';
import { generateInviteToken, hashToken } from '../services/auth.js';
import {
  canActivate,
  activationRefusalMessage,
  seedCompanyChecklist,
  summariseProgress,
  recomputeItemState,
} from '../services/companies.js';
import {
  buildPrefilledWorkbook,
  buildGapsWorkbook,
  exportableItem,
} from '../services/irl-exports.js';

const router = Router();
router.use(requireAuth, rejectCompanyRole);

/** Companies the caller can see at all: everything for an admin, assignments otherwise. */
function visibilityClause(user, params) {
  if (user.role === 'admin') return '';
  params.push(user.sub);
  return `AND EXISTS (SELECT 1 FROM company_reviewers r
                       WHERE r.company_id = c.id AND r.user_id = $${params.length})`;
}

// ---------------------------------------------------------------------------
// POST /companies — create
// ---------------------------------------------------------------------------
router.post('/', requireRole('admin'), async (req, res) => {
  const { fundId, legalName, jurisdiction, emailDomains } = req.body;
  if (!fundId || !legalName) {
    return res.status(400).json({ error: 'A fund and a legal name are required' });
  }

  try {
    const { rows: [company] } = await pool.query(
      `INSERT INTO companies (fund_id, legal_name, jurisdiction, email_domains, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [
        fundId, legalName.trim(), jurisdiction || null,
        Array.isArray(emailDomains) ? emailDomains.map((d) => d.toLowerCase().trim()) : [],
        req.user.sub,
      ]
    );

    await logAudit({
      action: 'company.created',
      userId: req.user.sub,
      resource: 'company',
      resourceId: company.id,
      detail: { legalName: company.legal_name, fundId },
      ip: req.ip,
    });

    res.status(201).json(company);
  } catch (err) {
    console.error('[companies] Create error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// GET /companies?fundId= — the pipeline
// ---------------------------------------------------------------------------
router.get('/', async (req, res) => {
  const params = [];
  let where = '1=1';

  if (req.query.fundId) {
    params.push(req.query.fundId);
    where += ` AND c.fund_id = $${params.length}`;
  }
  const visibility = visibilityClause(req.user, params);

  try {
    const { rows } = await pool.query(
      `SELECT c.*, f.name AS fund_name,
              (SELECT COUNT(*) FROM company_irl_items i WHERE i.company_id = c.id) AS item_count,
              (SELECT COUNT(*) FROM company_irl_items i
                WHERE i.company_id = c.id AND i.state = 'completed')          AS completed_count,
              (SELECT COUNT(*) FROM company_irl_items i
                WHERE i.company_id = c.id AND i.state = 'attention_needed')   AS attention_count,
              (SELECT COUNT(*) FROM company_files cf
                WHERE cf.company_id = c.id AND cf.upload_state = 'submitted'
                  AND cf.status = 'received' AND cf.deleted_at IS NULL)       AS awaiting_review,
              (SELECT MAX(cf.created_at) FROM company_files cf
                WHERE cf.company_id = c.id)                                   AS last_activity
       FROM companies c
       JOIN funds f ON f.id = c.fund_id
       WHERE ${where} ${visibility}
       ORDER BY f.name, c.legal_name`,
      params
    );

    res.json(rows.map((c) => ({
      id: c.id,
      fundId: c.fund_id,
      fundName: c.fund_name,
      legalName: c.legal_name,
      jurisdiction: c.jurisdiction,
      status: c.status,
      ndaExecutedAt: c.nda_executed_at,
      iemsScreenedAt: c.iems_screened_at,
      ndaCheckConfirmedAt: c.nda_check_confirmed_at,
      canActivate: canActivate(c),
      itemCount: Number(c.item_count),
      completedCount: Number(c.completed_count),
      attentionCount: Number(c.attention_count),
      awaitingReview: Number(c.awaiting_review),
      lastActivity: c.last_activity,
      activatedAt: c.activated_at,
    })));
  } catch (err) {
    console.error('[companies] List error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// GET /companies/:id — detail
// ---------------------------------------------------------------------------
router.get('/:id', requireCompanyAccess(), async (req, res) => {
  try {
    const { rows: [company] } = await pool.query(
      `SELECT c.*, f.name AS fund_name, u.display_name AS created_by_name
       FROM companies c
       JOIN funds f ON f.id = c.fund_id
       JOIN users u ON u.id = c.created_by
       WHERE c.id = $1`,
      [req.params.id]
    );
    if (!company) return res.status(404).json({ error: 'Company not found' });

    const { rows: items } = await pool.query(
      `SELECT * FROM company_irl_items WHERE company_id = $1 ORDER BY sort_order`,
      [req.params.id]
    );

    res.json({
      id: company.id,
      fundId: company.fund_id,
      fundName: company.fund_name,
      legalName: company.legal_name,
      jurisdiction: company.jurisdiction,
      emailDomains: company.email_domains,
      status: company.status,
      ndaExecutedAt: company.nda_executed_at,
      iemsScreenedAt: company.iems_screened_at,
      iemsReference: company.iems_reference,
      ndaCheckConfirmedAt: company.nda_check_confirmed_at,
      canActivate: canActivate(company),
      activationBlockedBecause: activationRefusalMessage(company),
      activatedAt: company.activated_at,
      suspendedAt: company.suspended_at,
      offboardedAt: company.offboarded_at,
      createdBy: company.created_by_name,
      createdAt: company.created_at,
      accessLevel: req.accessLevel,
      progress: summariseProgress(items),
    });
  } catch (err) {
    console.error('[companies] Detail error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// PATCH /companies/:id — metadata and the two gates
// ---------------------------------------------------------------------------
router.patch('/:id', requireCompanyAccess({ write: true }), async (req, res) => {
  const {
    legalName, jurisdiction, emailDomains,
    ndaExecutedAt, iemsScreenedAt, iemsReference, ndaCheckConfirmed,
  } = req.body;

  const sets = [];
  const params = [req.params.id];
  const gatesRecorded = [];

  const add = (column, value) => {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  };

  if (legalName !== undefined) add('legal_name', legalName.trim());
  if (jurisdiction !== undefined) add('jurisdiction', jurisdiction || null);
  if (emailDomains !== undefined) {
    add('email_domains', Array.isArray(emailDomains)
      ? emailDomains.map((d) => d.toLowerCase().trim()) : []);
  }
  if (ndaExecutedAt !== undefined) {
    add('nda_executed_at', ndaExecutedAt || null);
    gatesRecorded.push('nda_executed_at');
  }
  if (iemsScreenedAt !== undefined) {
    add('iems_screened_at', iemsScreenedAt || null);
    gatesRecorded.push('iems_screened_at');
  }
  if (iemsReference !== undefined) add('iems_reference', iemsReference || null);

  // The Q1 three-point NDA check. A tick with a recorded-by user and a
  // timestamp is sufficient; no document upload (HANDOVER-CW004 §5).
  if (ndaCheckConfirmed !== undefined) {
    if (ndaCheckConfirmed) {
      sets.push('nda_check_confirmed_at = NOW()');
      params.push(req.user.sub);
      sets.push(`nda_check_confirmed_by = $${params.length}`);
    } else {
      sets.push('nda_check_confirmed_at = NULL');
      sets.push('nda_check_confirmed_by = NULL');
    }
    gatesRecorded.push('nda_check_confirmed');
  }

  if (sets.length === 0) return res.status(400).json({ error: 'Nothing to update' });
  sets.push('updated_at = NOW()');

  try {
    const { rows: [company] } = await pool.query(
      `UPDATE companies SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
      params
    );
    if (!company) return res.status(404).json({ error: 'Company not found' });

    await logAudit({
      action: gatesRecorded.length ? 'company.gate_recorded' : 'company.updated',
      userId: req.user.sub,
      resource: 'company',
      resourceId: company.id,
      detail: {
        gatesRecorded,
        ndaExecutedAt: company.nda_executed_at,
        iemsScreenedAt: company.iems_screened_at,
      },
      ip: req.ip,
    });

    res.json({ ...company, canActivate: canActivate(company) });
  } catch (err) {
    console.error('[companies] Update error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// POST /companies/:id/activate
//
// THE TWO GATES. Refused unless both nda_executed_at and iems_screened_at are
// set. The first real cohort exercises this for real: one company holds an
// executed NDA but has no IEMS screen on record.
// ---------------------------------------------------------------------------
router.post('/:id/activate', requireRole('admin'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: [company] } = await client.query(
      `SELECT * FROM companies WHERE id = $1 FOR UPDATE`,
      [req.params.id]
    );
    if (!company) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Company not found' });
    }

    if (!canActivate(company)) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: activationRefusalMessage(company),
        missingGates: company.nda_executed_at ? ['iems_screened_at'] : undefined,
      });
    }

    if (company.status === 'offboarded') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'An offboarded company cannot be reactivated' });
    }

    // Seed the checklist from a template. Explicit templateId wins; otherwise
    // the newest template for the company's fund. Seeding is idempotent, so
    // re-activating a company adds nothing and loses nothing.
    let seeded = null;
    const templateId = req.body?.templateId;
    const { rows: [template] } = templateId
      ? await client.query(
          `SELECT id, name FROM irl_templates WHERE id = $1 AND fund_id = $2`,
          [templateId, company.fund_id]
        )
      : await client.query(
          `SELECT id, name FROM irl_templates WHERE fund_id = $1
           ORDER BY version DESC, created_at DESC LIMIT 1`,
          [company.fund_id]
        );

    if (template) {
      seeded = await seedCompanyChecklist(
        { companyId: company.id, templateId: template.id }, client
      );
    }

    const { rows: [updated] } = await client.query(
      `UPDATE companies
       SET status = 'active', activated_at = COALESCE(activated_at, NOW()),
           suspended_at = NULL, updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [company.id]
    );

    await client.query('COMMIT');

    await logAudit({
      action: 'company.activated',
      userId: req.user.sub,
      resource: 'company',
      resourceId: company.id,
      detail: {
        legalName: company.legal_name,
        ndaExecutedAt: company.nda_executed_at,
        iemsScreenedAt: company.iems_screened_at,
        templateId: template?.id || null,
        itemsSeeded: seeded?.inserted ?? 0,
      },
      ip: req.ip,
    });

    res.json({
      ...updated,
      seeded: seeded || { templateItems: 0, inserted: 0 },
      warning: template ? undefined
        : 'No Information Request List template exists for this fund, so the checklist is empty.',
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[companies] Activate error:', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// Suspend / reinstate / offboard
// ---------------------------------------------------------------------------
async function changeStatus(req, res, { status, column, action, message }) {
  try {
    const { rows: [company] } = await pool.query(
      `UPDATE companies SET status = $2, ${column} = NOW(), updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [req.params.id, status]
    );
    if (!company) return res.status(404).json({ error: 'Company not found' });

    // Immediate lockout: refresh tokens for every member are revoked, so a live
    // session dies at the next 15-minute refresh rather than surviving it. The
    // access token itself is refused by requireCompany, which re-reads company
    // status on every request.
    const { rows: members } = await pool.query(
      `SELECT user_id FROM company_users WHERE company_id = $1`,
      [company.id]
    );
    if (status !== 'active' && members.length) {
      await pool.query(
        `UPDATE refresh_tokens SET revoked_at = NOW()
         WHERE user_id = ANY($1::uuid[]) AND revoked_at IS NULL`,
        [members.map((m) => m.user_id)]
      );
    }

    await logAudit({
      action,
      userId: req.user.sub,
      resource: 'company',
      resourceId: company.id,
      detail: { legalName: company.legal_name, membersAffected: members.length },
      ip: req.ip,
    });

    res.json({ message, company });
  } catch (err) {
    console.error(`[companies] ${action} error:`, err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

router.post('/:id/suspend', requireRole('admin'), (req, res) =>
  changeStatus(req, res, {
    status: 'suspended', column: 'suspended_at', action: 'company.suspended',
    message: 'Company suspended. Its users can no longer sign in to the workspace.',
  }));

router.post('/:id/reinstate', requireRole('admin'), (req, res) =>
  changeStatus(req, res, {
    status: 'active', column: 'activated_at', action: 'company.reinstated',
    message: 'Company reinstated.',
  }));

// Data and audit history are left intact per the eight-year retention position
// (HANDOVER-C003 §5.5 decision 7). Only access is revoked.
router.post('/:id/offboard', requireRole('admin'), (req, res) =>
  changeStatus(req, res, {
    status: 'offboarded', column: 'offboarded_at', action: 'company.offboarded',
    message: 'Company offboarded. Access is revoked; documents and audit history are retained.',
  }));

// ---------------------------------------------------------------------------
// Company users
// ---------------------------------------------------------------------------

// GET /companies/:id/users — the access review listing
router.get('/:id/users', requireCompanyAccess(), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT cu.*, u.display_name, u.email, u.status AS account_status,
              n.display_name AS nominated_by_name,
              a.display_name AS approved_by_name,
              (SELECT MAX(al.created_at) FROM audit_log al
                WHERE al.user_id = u.id AND al.action = 'login.success') AS last_login
       FROM company_users cu
       JOIN users u ON u.id = cu.user_id
       LEFT JOIN users n ON n.id = cu.nominated_by
       LEFT JOIN users a ON a.id = cu.approved_by
       WHERE cu.company_id = $1
       ORDER BY cu.is_primary DESC, u.display_name`,
      [req.params.id]
    );

    res.json(rows.map((m) => ({
      membershipId: m.id,
      userId: m.user_id,
      displayName: m.display_name,
      email: m.email,
      companyRole: m.company_role,
      isPrimary: m.is_primary,
      accountStatus: m.account_status,
      approved: !!m.approved_by,
      approvedBy: m.approved_by_name,
      nominatedBy: m.nominated_by_name,
      nominationNote: m.nomination_note,
      // NULL when the company records no domains; false is a real mismatch and
      // is what the approval screen flags.
      domainMatched: m.domain_matched,
      deactivatedAt: m.deactivated_at,
      lastLogin: m.last_login,
      joinedAt: m.created_at,
    })));
  } catch (err) {
    console.error('[companies] Users error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /companies/:id/users
 *
 * Invites a Primary Contact, or approves a nomination the company made. Either
 * way it issues an invite link on the existing `invites` flow and returns it
 * for an admin to send by hand. NO EMAIL IS SENT: that is Phase 1b.
 */
router.post('/:id/users', requireRole('admin'), async (req, res) => {
  const { email, displayName, companyRole, isPrimary } = req.body;
  if (!email || !displayName) {
    return res.status(400).json({ error: 'An email address and a name are required' });
  }
  const validRoles = ['company_admin', 'company_contributor', 'company_viewer'];
  if (companyRole && !validRoles.includes(companyRole)) {
    return res.status(400).json({ error: 'Invalid role' });
  }

  const normalised = email.toLowerCase().trim();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const { rows: [company] } = await client.query(
      `SELECT * FROM companies WHERE id = $1`, [req.params.id]
    );
    if (!company) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Company not found' });
    }

    const { rows: [existing] } = await client.query(
      `SELECT id, role FROM users WHERE email = $1`, [normalised]
    );

    // Never convert a live fund-side account into a company account: it would
    // silently take away that person's investor or advisor access.
    if (existing && existing.role !== 'company') {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'That email address already belongs to a Taranis fund-side account.',
      });
    }

    const { rows: [user] } = await client.query(
      `INSERT INTO users (email, display_name, role, status)
       VALUES ($1, $2, 'company', 'invited')
       ON CONFLICT (email) DO UPDATE SET display_name = EXCLUDED.display_name
       RETURNING id`,
      [normalised, displayName.trim()]
    );

    // A user already nominated by the company has a membership row waiting for
    // approval; this both approves it and issues the invitation.
    const { rows: [membership] } = await client.query(
      `INSERT INTO company_users
         (company_id, user_id, company_role, is_primary, approved_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (company_id, user_id) DO UPDATE
         SET company_role = EXCLUDED.company_role,
             is_primary   = EXCLUDED.is_primary,
             approved_by  = EXCLUDED.approved_by,
             deactivated_at = NULL,
             deactivated_by = NULL
       RETURNING *`,
      [
        company.id, user.id, companyRole || 'company_contributor',
        !!isPrimary, req.user.sub,
      ]
    );

    const token = generateInviteToken();
    await client.query(
      `INSERT INTO invites (email, role, token_hash, invited_by, expires_at)
       VALUES ($1, 'company', $2, $3, $4)`,
      [normalised, hashToken(token), req.user.sub, new Date(Date.now() + 7 * 86400 * 1000)]
    );

    await client.query('COMMIT');

    await logAudit({
      action: membership.nominated_by ? 'company_user.approved' : 'company_user.invited',
      userId: req.user.sub,
      resource: 'company',
      resourceId: company.id,
      detail: { invitedEmail: normalised, companyRole: membership.company_role, isPrimary: !!isPrimary },
      ip: req.ip,
    });

    res.status(201).json({
      message: 'Invitation created. Send the link below to the invitee, together with '
             + 'the company guide. No email has been sent.',
      userId: user.id,
      inviteUrl: `/invite/accept?token=${token}`,
      expiresAt: new Date(Date.now() + 7 * 86400 * 1000),
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[companies] Invite error:', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// PATCH /companies/:id/users/:userId — change role, deactivate, reactivate
router.patch('/:id/users/:userId', requireRole('admin'), async (req, res) => {
  const { companyRole, isPrimary, active } = req.body;
  const sets = [];
  const params = [req.params.id, req.params.userId];

  if (companyRole !== undefined) {
    const validRoles = ['company_admin', 'company_contributor', 'company_viewer'];
    if (!validRoles.includes(companyRole)) {
      return res.status(400).json({ error: 'Invalid role' });
    }
    params.push(companyRole);
    sets.push(`company_role = $${params.length}`);
  }
  if (isPrimary !== undefined) {
    params.push(!!isPrimary);
    sets.push(`is_primary = $${params.length}`);
  }
  if (active !== undefined) {
    if (active) {
      sets.push('deactivated_at = NULL', 'deactivated_by = NULL');
    } else {
      params.push(req.user.sub);
      sets.push('deactivated_at = NOW()', `deactivated_by = $${params.length}`);
    }
  }
  if (sets.length === 0) return res.status(400).json({ error: 'Nothing to update' });

  try {
    const { rows: [membership] } = await pool.query(
      `UPDATE company_users SET ${sets.join(', ')}
       WHERE company_id = $1 AND user_id = $2 RETURNING *`,
      params
    );
    if (!membership) return res.status(404).json({ error: 'Team member not found' });

    if (active === false) {
      const { revokeAllUserTokens } = await import('../services/auth.js');
      await revokeAllUserTokens(membership.user_id);
    }

    await logAudit({
      action: active === false ? 'company_user.deactivated' : 'company_user.role_changed',
      userId: req.user.sub,
      resource: 'company',
      resourceId: req.params.id,
      detail: { targetUserId: membership.user_id, companyRole: membership.company_role },
      ip: req.ip,
    });

    res.json(membership);
  } catch (err) {
    console.error('[companies] Update membership error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// Reviewer assignment
// ---------------------------------------------------------------------------
router.post('/:id/reviewers', requireRole('admin'), async (req, res) => {
  const { userId, level } = req.body;
  if (!userId || !['reviewer', 'readonly'].includes(level)) {
    return res.status(400).json({ error: 'A user and a level of reviewer or readonly are required' });
  }

  try {
    const { rows: [target] } = await pool.query(`SELECT role FROM users WHERE id = $1`, [userId]);
    if (!target) return res.status(404).json({ error: 'User not found' });
    // A company user must never be assignable as a Taranis-side reviewer.
    if (target.role === 'company') {
      return res.status(400).json({ error: 'Company users cannot be assigned as reviewers' });
    }

    const { rows: [row] } = await pool.query(
      `INSERT INTO company_reviewers (company_id, user_id, level, assigned_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (company_id, user_id) DO UPDATE SET level = EXCLUDED.level
       RETURNING *`,
      [req.params.id, userId, level, req.user.sub]
    );

    await logAudit({
      action: 'company.updated',
      userId: req.user.sub,
      resource: 'company',
      resourceId: req.params.id,
      detail: { reviewerAssigned: userId, level },
      ip: req.ip,
    });

    res.status(201).json(row);
  } catch (err) {
    console.error('[companies] Assign reviewer error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/:id/reviewers/:userId', requireRole('admin'), async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM company_reviewers WHERE company_id = $1 AND user_id = $2`,
      [req.params.id, req.params.userId]
    );
    if (!rowCount) return res.status(404).json({ error: 'Assignment not found' });

    await logAudit({
      action: 'company.updated',
      userId: req.user.sub,
      resource: 'company',
      resourceId: req.params.id,
      detail: { reviewerRemoved: req.params.userId },
      ip: req.ip,
    });

    res.json({ message: 'Assignment removed' });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// Checklist items, Taranis side (internal notes included)
// ---------------------------------------------------------------------------
router.get('/:id/irl-items', requireCompanyAccess(), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT i.*,
              (SELECT COUNT(*) FROM company_files f
                WHERE f.irl_item_id = i.id AND f.deleted_at IS NULL
                  AND f.upload_state = 'submitted') AS submitted_files
       FROM company_irl_items i WHERE i.company_id = $1 ORDER BY i.sort_order`,
      [req.params.id]
    );
    res.json(rows.map((i) => ({ ...i, submitted_files: Number(i.submitted_files) })));
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Ad hoc item, or a template addition pushed to one company.
router.post('/:id/irl-items', requireCompanyAccess({ write: true }), async (req, res) => {
  const { section, ref, description, priority, noteForCompany } = req.body;
  if (!section || !ref || !description) {
    return res.status(400).json({ error: 'A section, a ref and a description are required' });
  }

  try {
    const { rows: [maxOrder] } = await pool.query(
      `SELECT COALESCE(MAX(sort_order), 0) AS n FROM company_irl_items WHERE company_id = $1`,
      [req.params.id]
    );

    const { rows: [item] } = await pool.query(
      `INSERT INTO company_irl_items
         (company_id, section, ref, description, priority, note_for_company, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (company_id, ref) DO NOTHING
       RETURNING *`,
      [
        req.params.id, section, ref.trim(), description, priority || 'standard',
        noteForCompany || null, Number(maxOrder.n) + 1,
      ]
    );
    if (!item) {
      return res.status(409).json({ error: `Reference ${ref} is already used for this company` });
    }

    await logAudit({
      action: 'company.updated',
      userId: req.user.sub,
      resource: 'company',
      resourceId: req.params.id,
      detail: { itemAdded: item.ref },
      ip: req.ip,
    });

    res.status(201).json(item);
  } catch (err) {
    console.error('[companies] Add item error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.patch('/:id/irl-items/:itemId', requireCompanyAccess({ write: true }), async (req, res) => {
  const { description, priority, state, noteForCompany, internalNote, alreadyHeld, sourceDocument } = req.body;
  const sets = [];
  const params = [req.params.itemId, req.params.id];
  const add = (column, value) => {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  };

  if (description !== undefined) add('description', description);
  if (priority !== undefined) add('priority', priority);
  if (state !== undefined) add('state', state);
  if (noteForCompany !== undefined) add('note_for_company', noteForCompany || null);
  if (internalNote !== undefined) add('internal_note', internalNote || null);
  if (alreadyHeld !== undefined) add('already_held', alreadyHeld || null);
  if (sourceDocument !== undefined) add('source_document', sourceDocument || null);

  if (sets.length === 0) return res.status(400).json({ error: 'Nothing to update' });
  sets.push('updated_at = NOW()');

  try {
    const { rows: [item] } = await pool.query(
      `UPDATE company_irl_items SET ${sets.join(', ')}
       WHERE id = $1 AND company_id = $2 RETURNING *`,
      params
    );
    if (!item) return res.status(404).json({ error: 'Item not found' });

    await logAudit({
      action: 'company.updated',
      userId: req.user.sub,
      resource: 'company',
      resourceId: req.params.id,
      detail: { itemRef: item.ref, fields: sets.length - 1 },
      ip: req.ip,
    });

    res.json(item);
  } catch (err) {
    console.error('[companies] Update item error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// Files, Taranis side
// ---------------------------------------------------------------------------
router.get('/:id/files', requireCompanyAccess(), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT f.*, u.display_name AS uploaded_by_name,
              i.ref AS item_ref, i.section AS item_section,
              b.receipt_ref, b.submitted_at
       FROM company_files f
       JOIN users u ON u.id = f.uploaded_by
       LEFT JOIN company_irl_items i ON i.id = f.irl_item_id
       LEFT JOIN submission_batches b ON b.id = f.batch_id
       WHERE f.company_id = $1 AND f.deleted_at IS NULL
         AND f.upload_state = 'submitted'
       ORDER BY b.submitted_at DESC NULLS LAST, f.created_at DESC`,
      [req.params.id]
    );

    res.json(rows.map((f) => ({
      id: f.id,
      filename: f.filename,
      description: f.description,
      sizeBytes: Number(f.size_bytes),
      contentType: f.content_type,
      version: f.version,
      supersedes: f.supersedes,
      status: f.status,
      scanState: f.scan_state,
      scanBackend: f.scan_backend,
      itemRef: f.item_ref,
      itemSection: f.item_section,
      irlItemId: f.irl_item_id,
      receiptRef: f.receipt_ref,
      submittedAt: f.submitted_at,
      uploadedBy: f.uploaded_by_name,
      uploadedAt: f.created_at,
    })));
  } catch (err) {
    console.error('[companies] Files error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
router.get('/:id/export', requireCompanyAccess(), async (req, res) => {
  const format = (req.query.format || 'prefilled').toLowerCase();
  if (!['prefilled', 'gaps'].includes(format)) {
    return res.status(400).json({ error: 'format must be prefilled or gaps' });
  }

  try {
    const { rows: [company] } = await pool.query(
      `SELECT legal_name FROM companies WHERE id = $1`, [req.params.id]
    );
    if (!company) return res.status(404).json({ error: 'Company not found' });

    const { rows } = await pool.query(
      `SELECT section, ref, description, priority, state, already_held,
              source_document, note_for_company
       FROM company_irl_items WHERE company_id = $1 ORDER BY sort_order`,
      [req.params.id]
    );
    // internal_note is not selected above and is not part of the exportable
    // shape, so it cannot reach either sheet.
    const items = rows.map(exportableItem);

    const buffer = format === 'gaps'
      ? await buildGapsWorkbook({ companyName: company.legal_name, items })
      : await buildPrefilledWorkbook({ companyName: company.legal_name, items });

    const safeName = company.legal_name.replace(/[^A-Za-z0-9 _-]/g, '').trim() || 'Company';
    const filename = `${safeName} ${format === 'gaps' ? 'GAPS' : 'PRE-FILLED'}.xlsx`;

    await logAudit({
      action: 'company.exported',
      userId: req.user.sub,
      resource: 'company',
      resourceId: req.params.id,
      detail: { format, rows: items.length },
      ip: req.ip,
    });

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  } catch (err) {
    console.error('[companies] Export error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;

// ---------------------------------------------------------------------------
// Cross-company routes, mounted separately in index.js
// ---------------------------------------------------------------------------

/**
 * GET /review-queue?fundId= — submitted files still at 'received', oldest
 * first, across every company the caller can see.
 *
 * In Phase 1a this page is the substitute for upload notification emails
 * (HANDOVER-CW004 §3 item 4): nothing tells a reviewer a submission has
 * arrived, so the queue has to be the thing they look at.
 */
export const reviewQueueRouter = Router();
reviewQueueRouter.use(requireAuth, rejectCompanyRole);

reviewQueueRouter.get('/', async (req, res) => {
  const params = [];
  let where = "f.upload_state = 'submitted' AND f.status = 'received' AND f.deleted_at IS NULL";

  if (req.query.fundId) {
    params.push(req.query.fundId);
    where += ` AND c.fund_id = $${params.length}`;
  }
  const visibility = visibilityClause(req.user, params);

  try {
    const { rows } = await pool.query(
      `SELECT f.id, f.filename, f.description, f.size_bytes, f.scan_state, f.created_at,
              c.id AS company_id, c.legal_name,
              i.ref AS item_ref, i.section AS item_section,
              b.receipt_ref, b.submitted_at
       FROM company_files f
       JOIN companies c ON c.id = f.company_id
       LEFT JOIN company_irl_items i ON i.id = f.irl_item_id
       LEFT JOIN submission_batches b ON b.id = f.batch_id
       WHERE ${where} ${visibility}
       ORDER BY b.submitted_at ASC NULLS LAST`,
      params
    );

    res.json(rows.map((f) => ({
      id: f.id,
      companyId: f.company_id,
      companyName: f.legal_name,
      filename: f.filename,
      description: f.description,
      sizeBytes: Number(f.size_bytes),
      scanState: f.scan_state,
      itemRef: f.item_ref,
      itemSection: f.item_section,
      receiptRef: f.receipt_ref,
      submittedAt: f.submitted_at,
    })));
  } catch (err) {
    console.error('[review-queue] Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /irl-templates?fundId= — which master lists exist, and how big they are.
 * POST /irl-templates/seed — import a committed master into a fund.
 *
 * Read from the UI, written only by the importer. The full IRLTemplatesPage with
 * item CRUD and an XLSX upload screen is Phase 2.
 */
export const irlTemplatesRouter = Router();
irlTemplatesRouter.use(requireAuth, rejectCompanyRole, requireRole('admin'));

irlTemplatesRouter.get('/', async (req, res) => {
  const params = [];
  let where = '1=1';
  if (req.query.fundId) {
    params.push(req.query.fundId);
    where += ` AND t.fund_id = $${params.length}`;
  }

  try {
    const { rows } = await pool.query(
      `SELECT t.*, f.name AS fund_name,
              (SELECT COUNT(*) FROM irl_template_items i WHERE i.template_id = t.id) AS item_count
       FROM irl_templates t JOIN funds f ON f.id = t.fund_id
       WHERE ${where}
       ORDER BY f.name, t.version DESC`,
      params
    );
    res.json(rows.map((t) => ({
      id: t.id,
      fundId: t.fund_id,
      fundName: t.fund_name,
      name: t.name,
      version: t.version,
      source: t.source,
      itemCount: Number(t.item_count),
      createdAt: t.created_at,
    })));
  } catch (err) {
    console.error('[irl-templates] List error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /irl-templates/seed — create or refresh a fund's master checklist.
 *
 *   POST /api/irl-templates/seed  { "fundSlug": "biotech-ksa" }
 *
 * WHY AN ENDPOINT. Seeding used to mean a shell on the running task
 * (`npm -w packages/api run seed:irl`). Every new fund needs a template, so that
 * is a recurring production ritual, and a recurring ritual done by hand
 * eventually gets done wrong. Decided by Mark, HANDOVER-CW004 §6.
 *
 * WHERE THE DATA COMES FROM. The committed artefact under `src/db/seeds/`, which
 * is baked into the image — not an upload and not a path on the container. The
 * spreadsheet lives in the fund paperwork folder on a workstation that the
 * container cannot read, the artefact is the thing the test suite asserts 146
 * items against, and so the rows that reach production are the exact rows CI
 * checked. Changing the master is `tools/build-irl-seed.mjs`, a commit and a
 * deploy, which is the review trail a due diligence request list deserves.
 *
 * Admin only, by the router-level guards above. Idempotent by upsert: a second
 * call rewrites nothing that already matches and reports it as unchanged. Refs
 * are never renumbered and nothing is ever deleted. The whole import is one
 * transaction, so the template is never half applied.
 */
irlTemplatesRouter.post('/seed', async (req, res) => {
  const { fundSlug, seed: seedName, name: templateName } = req.body || {};
  if (!fundSlug || typeof fundSlug !== 'string') {
    return res.status(400).json({
      error: 'A fundSlug is required, for example { "fundSlug": "biotech-ksa" }',
    });
  }

  try {
    const { runIrlImport, describeImport } = await import('../db/seed-irl.js');
    const result = await runIrlImport({
      fundSlug: fundSlug.trim(),
      seedName,
      templateName,
      createdBy: req.user.sub,
    });

    await logAudit({
      action: 'irl_template.seeded',
      userId: req.user.sub,
      resource: 'irl_template',
      resourceId: result.templateId,
      detail: {
        fundSlug: result.fund.slug,
        templateName: result.templateName,
        seed: result.seedName,
        source: result.source,
        created: result.created,
        updated: result.updated,
        skipped: result.skipped,
        total: result.total,
      },
      ip: req.ip,
    });

    res.json({ message: describeImport(result), ...result });
  } catch (err) {
    const status = {
      IRL_NO_FUND: 404,
      IRL_NO_SUCH_SEED: 400,
      IRL_BAD_SEED_NAME: 400,
      IRL_INVALID_SEED: 422,
      IRL_NO_ADMIN: 409,
    }[err.code];

    if (status) {
      // Nothing was written: the seed is validated before the first statement
      // and the transaction is rolled back on any failure.
      return res.status(status).json({
        error: err.message,
        available: err.available,
        availableFunds: err.availableFunds,
        problems: err.problems,
      });
    }

    console.error('[irl-templates] Seed error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Per-file routes, mounted at /company-files.
 */
export const companyFilesRouter = Router();
companyFilesRouter.use(requireAuth, rejectCompanyRole);

/** Resolve the file, then apply the same company access rule as everything else. */
async function loadFileForTaranis(req, res, { write }) {
  const { rows: [file] } = await pool.query(
    `SELECT f.*, c.legal_name FROM company_files f
     JOIN companies c ON c.id = f.company_id
     WHERE f.id = $1 AND f.deleted_at IS NULL`,
    [req.params.fileId]
  );
  if (!file) {
    res.status(404).json({ error: 'File not found' });
    return null;
  }

  const { taranisAccessLevel, canWriteAtLevel } = await import('../services/companies.js');
  const level = await taranisAccessLevel({
    userId: req.user.sub, role: req.user.role, companyId: file.company_id,
  });
  if (!level) {
    res.status(404).json({ error: 'File not found' });
    return null;
  }
  if (write && !canWriteAtLevel(level)) {
    res.status(403).json({ error: 'Your access to this company is read-only' });
    return null;
  }
  return file;
}

/**
 * PATCH /company-files/:fileId/status
 *
 * A note is mandatory for 'attention_needed' — the company is being asked to do
 * something and an unexplained flag wastes a round trip. Enforced here for the
 * readable message and again by a CHECK constraint on file_status_history.
 */
companyFilesRouter.patch('/:fileId/status', async (req, res) => {
  const { status, note } = req.body;
  const valid = ['received', 'in_review', 'attention_needed', 'completed'];
  if (!valid.includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  if (status === 'attention_needed' && (!note || !note.trim())) {
    return res.status(400).json({
      error: 'A note is required when a file is marked as needing attention. '
           + 'The company sees this note.',
    });
  }

  const file = await loadFileForTaranis(req, res, { write: true });
  if (!file) return;

  if (file.upload_state !== 'submitted') {
    return res.status(409).json({ error: 'This file has not been formally submitted yet' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`UPDATE company_files SET status = $2 WHERE id = $1`, [file.id, status]);
    await client.query(
      `INSERT INTO file_status_history (file_id, status, note, set_by) VALUES ($1, $2, $3, $4)`,
      [file.id, status, note?.trim() || null, req.user.sub]
    );

    await client.query('COMMIT');

    if (file.irl_item_id) await recomputeItemState(file.irl_item_id);

    await logAudit({
      action: 'company_file.status_changed',
      userId: req.user.sub,
      resource: 'company_file',
      resourceId: file.id,
      detail: {
        companyId: file.company_id,
        from: file.status,
        to: status,
        hasNote: !!note,
      },
      ip: req.ip,
    });

    // No email in Phase 1a. status-attention and status-completed are 1b.
    res.json({ id: file.id, status, note: note?.trim() || null });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[company-files] Status error:', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

/** GET /company-files/:fileId/history */
companyFilesRouter.get('/:fileId/history', async (req, res) => {
  const file = await loadFileForTaranis(req, res, { write: false });
  if (!file) return;

  const { rows } = await pool.query(
    `SELECT h.*, u.display_name AS set_by_name
     FROM file_status_history h JOIN users u ON u.id = h.set_by
     WHERE h.file_id = $1 ORDER BY h.created_at DESC`,
    [file.id]
  );
  res.json(rows.map((h) => ({
    id: h.id, status: h.status, note: h.note,
    setBy: h.set_by_name, at: h.created_at,
  })));
});

/**
 * GET /company-files/:fileId/download
 *
 * An infected file is never served. An unscanned one is served while no scanner
 * is configured, which is the accepted beta position (HANDOVER-C004 §3.1), and
 * the response carries `X-Taranis-Scan-State: pending` so the caller cannot
 * mistake it for a file that was checked. See `downloadDecision`.
 */
companyFilesRouter.get('/:fileId/download', async (req, res) => {
  const file = await loadFileForTaranis(req, res, { write: false });
  if (!file) return;

  const { downloadDecision, getScanner } = await import('../services/scanner.js');
  const decision = downloadDecision(file.scan_state);

  if (!decision.allowed) {
    return res.status(409).json({
      error: decision.reason,
      scanState: file.scan_state,
      scanner: getScanner().kind,
    });
  }

  try {
    const { getStorage, StorageNotFoundError } = await import('../services/storage.js');
    const { contentDispositionFilename } = await import('../services/document-files.js');
    const storage = await getStorage();

    let object;
    try {
      object = await storage.get(file.s3_key);
    } catch (err) {
      if (err instanceof StorageNotFoundError) {
        return res.status(404).json({ error: 'File is no longer available' });
      }
      throw err;
    }

    await logAudit({
      action: 'company_file.downloaded',
      userId: req.user.sub,
      resource: 'company_file',
      resourceId: file.id,
      detail: {
        companyId: file.company_id,
        filename: file.filename,
        // Recorded per download, so it is answerable later exactly which files
        // were served without ever having been inspected.
        scanState: file.scan_state,
        unscanned: decision.unscanned,
      },
      ip: req.ip,
    });

    // Never let an unscanned file look like a checked one to any client.
    res.setHeader('X-Taranis-Scan-State', file.scan_state);
    res.setHeader('Content-Type', file.content_type || 'application/octet-stream');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${contentDispositionFilename(file.filename)}"`
    );
    if (object.contentLength != null) res.setHeader('Content-Length', object.contentLength);

    object.body.on('error', (streamErr) => {
      console.error('[company-files] Stream error:', streamErr.message);
      res.destroy(streamErr);
    });
    object.body.pipe(res);
  } catch (err) {
    console.error('[company-files] Download error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});
