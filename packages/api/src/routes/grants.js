/**
 * Permission grant routes — admin manages user × fund × category access.
 */
import { Router } from 'express';
import { pool } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { logAudit } from '../services/audit.js';

// Helper: load user capabilities from DB
async function getUserCapabilities(userId) {
  const { rows: [row] } = await pool.query(
    `SELECT COALESCE(capabilities, '{}') AS capabilities FROM users WHERE id = $1`,
    [userId]
  );
  return row?.capabilities || {};
}

const router = Router();
// Grants management requires admin role or canManageUsers capability
router.use(requireAuth, requireRole('admin'));

// GET /grants?userId=...
router.get('/', async (req, res) => {
  const { userId, fundId } = req.query;
  let where = 'g.revoked_at IS NULL';
  const params = [];
  let idx = 1;

  if (userId) { where += ` AND g.user_id = $${idx++}`; params.push(userId); }
  if (fundId) { where += ` AND g.fund_id = $${idx++}`; params.push(fundId); }

  try {
    const { rows } = await pool.query(`
      SELECT g.*, u.email, u.display_name, f.name AS fund_name, c.name AS category_name, c.sort_order
      FROM grants g
      JOIN users u ON u.id = g.user_id
      JOIN funds f ON f.id = g.fund_id
      JOIN document_categories c ON c.id = g.category_id
      WHERE ${where}
      ORDER BY u.display_name, f.name, c.sort_order
    `, params);

    res.json(rows.map((g) => ({
      id: g.id,
      userId: g.user_id,
      email: g.email,
      displayName: g.display_name,
      fundId: g.fund_id,
      fundName: g.fund_name,
      categoryId: g.category_id,
      categoryName: g.category_name,
      downloadAllowed: g.download_allowed,
      expiresAt: g.expires_at,
      createdAt: g.created_at,
    })));
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /grants — create or update a grant
router.post('/', async (req, res) => {
  const { userId, fundId, categoryId, downloadAllowed, expiresAt } = req.body;
  if (!userId || !fundId || !categoryId) {
    return res.status(400).json({ error: 'userId, fundId and categoryId required' });
  }

  try {
    // Default download to false unless explicitly set to true
    const dlAllowed = downloadAllowed === true;
    const { rows: [grant] } = await pool.query(`
      INSERT INTO grants (user_id, fund_id, category_id, download_allowed, expires_at, granted_by)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (user_id, fund_id, category_id)
      DO UPDATE SET download_allowed = $4, expires_at = $5, revoked_at = NULL, granted_by = $6
      RETURNING *
    `, [userId, fundId, categoryId, dlAllowed, expiresAt || null, req.user.sub]);

    await logAudit({
      action: 'grant.created',
      userId: req.user.sub,
      resource: 'grant',
      resourceId: grant.id,
      detail: { targetUser: userId, fundId, categoryId },
      ip: req.ip,
    });

    res.status(201).json(grant);
  } catch (err) {
    console.error('[grants] Create error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /grants/bulk — set grants for a user across multiple fund/category combos
router.post('/bulk', async (req, res) => {
  const { userId, grants: grantList } = req.body;
  if (!userId || !Array.isArray(grantList)) {
    return res.status(400).json({ error: 'userId and grants array required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Revoke all existing grants for this user
    await client.query(
      `UPDATE grants SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId]
    );

    // Insert new grants
    for (const g of grantList) {
      await client.query(`
        INSERT INTO grants (user_id, fund_id, category_id, download_allowed, expires_at, granted_by)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (user_id, fund_id, category_id)
        DO UPDATE SET download_allowed = $4, expires_at = $5, revoked_at = NULL, granted_by = $6
      `, [userId, g.fundId, g.categoryId, g.downloadAllowed === true, g.expiresAt || null, req.user.sub]);
    }

    await client.query('COMMIT');

    await logAudit({
      action: 'grant.bulk_update',
      userId: req.user.sub,
      resource: 'user',
      resourceId: userId,
      detail: { grantCount: grantList.length },
      ip: req.ip,
    });

    res.json({ message: `${grantList.length} grants applied` });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[grants] Bulk error:', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// DELETE /grants/:id — revoke a grant
router.delete('/:id', async (req, res) => {
  try {
    const { rows: [grant] } = await pool.query(
      `UPDATE grants SET revoked_at = NOW() WHERE id = $1 AND revoked_at IS NULL RETURNING *`,
      [req.params.id]
    );
    if (!grant) return res.status(404).json({ error: 'Grant not found' });

    await logAudit({ action: 'grant.revoked', userId: req.user.sub, resource: 'grant', resourceId: grant.id, ip: req.ip });
    res.json({ message: 'Grant revoked' });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
