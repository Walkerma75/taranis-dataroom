/**
 * User management routes — admin only.
 */
import { Router } from 'express';
import { pool } from '../db.js';
import { requireAuth, requireRole, rejectCompanyRole } from '../middleware/auth.js';
import { logAudit } from '../services/audit.js';

const router = Router();
router.use(requireAuth, rejectCompanyRole);

// GET /users — list all users (admin only)
//
// Company users are listed here alongside fund users, so the row has to say
// which company they belong to and link to it. The membership join is safe to
// make flat: a user with global role 'company' holds exactly one live
// membership (migration 011), and every other role holds none, so this cannot
// fan a user out into several rows.
//
// Membership is read here for display only. Nothing about company access is
// decided from this route: that stays with the company middleware, which
// re-reads membership on every request.
router.get('/', requireRole('admin'), async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT u.id, u.email, u.display_name, u.role, u.status, u.created_at, u.updated_at,
             COALESCE(m.totp_verified, false) AS mfa_enabled,
             COALESCE(u.capabilities, '{}') AS capabilities,
             cu.company_id, c.legal_name AS company_name,
             (SELECT COUNT(*) FROM grants g WHERE g.user_id = u.id AND g.revoked_at IS NULL) AS active_grants
      FROM users u
      LEFT JOIN user_mfa m ON m.user_id = u.id
      LEFT JOIN company_users cu ON cu.user_id = u.id AND cu.deactivated_at IS NULL
      LEFT JOIN companies c ON c.id = cu.company_id
      ORDER BY u.created_at DESC
    `);

    res.json(rows.map((r) => ({
      id: r.id,
      email: r.email,
      displayName: r.display_name,
      role: r.role,
      status: r.status,
      mfaEnabled: r.mfa_enabled,
      capabilities: r.capabilities || {},
      companyId: r.company_id || null,
      companyName: r.company_name || null,
      activeGrants: parseInt(r.active_grants, 10),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    })));
  } catch (err) {
    console.error('[users] List error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /users/:id
router.get('/:id', requireRole('admin'), async (req, res) => {
  try {
    const { rows: [user] } = await pool.query(
      `SELECT u.*, COALESCE(m.totp_verified, false) AS mfa_enabled
       FROM users u LEFT JOIN user_mfa m ON m.user_id = u.id
       WHERE u.id = $1`,
      [req.params.id]
    );
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Get user's grants
    const { rows: grants } = await pool.query(
      `SELECT g.*, f.name AS fund_name, c.name AS category_name
       FROM grants g
       JOIN funds f ON f.id = g.fund_id
       JOIN document_categories c ON c.id = g.category_id
       WHERE g.user_id = $1 AND g.revoked_at IS NULL
       ORDER BY f.name, c.sort_order`,
      [req.params.id]
    );

    res.json({
      id: user.id,
      email: user.email,
      displayName: user.display_name,
      role: user.role,
      status: user.status,
      mfaEnabled: user.mfa_enabled,
      createdAt: user.created_at,
      grants: grants.map((g) => ({
        id: g.id,
        fundId: g.fund_id,
        fundName: g.fund_name,
        categoryId: g.category_id,
        categoryName: g.category_name,
        downloadAllowed: g.download_allowed,
        expiresAt: g.expires_at,
      })),
    });
  } catch (err) {
    console.error('[users] Update error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /users/:id — update role/status
router.patch('/:id', requireRole('admin'), async (req, res) => {
  const { role, status, displayName, capabilities } = req.body;
  const sets = [];
  const vals = [];
  let idx = 1;

  if (role) { sets.push(`role = $${idx++}`); vals.push(role); }
  if (status) { sets.push(`status = $${idx++}`); vals.push(status); }
  if (displayName) { sets.push(`display_name = $${idx++}`); vals.push(displayName); }
  if (capabilities) { sets.push(`capabilities = $${idx++}`); vals.push(JSON.stringify(capabilities)); }

  if (sets.length === 0) return res.status(400).json({ error: 'Nothing to update' });

  sets.push(`updated_at = NOW()`);
  vals.push(req.params.id);

  try {
    const { rows: [user] } = await pool.query(
      `UPDATE users SET ${sets.join(', ')} WHERE id = $${idx} RETURNING id, email, display_name, role, status`,
      vals
    );
    if (!user) return res.status(404).json({ error: 'User not found' });

    await logAudit({
      action: 'user.updated',
      userId: req.user.sub,
      resource: 'user',
      resourceId: req.params.id,
      detail: req.body,
      ip: req.ip,
    });

    res.json(user);
  } catch (err) {
    console.error('[users] Delete error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
