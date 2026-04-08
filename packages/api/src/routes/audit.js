/**
 * Audit log viewer — admin only.
 */
import { Router } from 'express';
import { pool } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth, requireRole('admin'));

// GET /audit?action=...&userId=...&resource=...&page=1&limit=50
router.get('/', async (req, res) => {
  const { action, userId, resource, page = 1, limit = 50 } = req.query;
  const offset = (Math.max(1, parseInt(page)) - 1) * parseInt(limit);

  let where = '1=1';
  const params = [];
  let idx = 1;

  if (action) { where += ` AND a.action = $${idx++}`; params.push(action); }
  if (userId) { where += ` AND a.user_id = $${idx++}`; params.push(userId); }
  if (resource) { where += ` AND a.resource = $${idx++}`; params.push(resource); }

  try {
    const countResult = await pool.query(
      `SELECT COUNT(*) FROM audit_log a WHERE ${where}`,
      params
    );
    const total = parseInt(countResult.rows[0].count, 10);

    const { rows } = await pool.query(`
      SELECT a.*, u.email AS user_email, u.display_name AS user_name
      FROM audit_log a
      LEFT JOIN users u ON u.id = a.user_id
      WHERE ${where}
      ORDER BY a.created_at DESC
      LIMIT $${idx++} OFFSET $${idx++}
    `, [...params, parseInt(limit), offset]);

    res.json({
      data: rows.map((r) => ({
        id: r.id,
        action: r.action,
        userId: r.user_id,
        userEmail: r.user_email,
        userName: r.user_name,
        resource: r.resource,
        resourceId: r.resource_id,
        detail: r.detail,
        ipAddress: r.ip_address,
        createdAt: r.created_at,
      })),
      total,
      page: parseInt(page),
      limit: parseInt(limit),
      pages: Math.ceil(total / parseInt(limit)),
    });
  } catch (err) {
    console.error('[audit] Query error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /audit/actions — list distinct action types (for filter dropdowns)
router.get('/actions', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT action FROM audit_log ORDER BY action`
    );
    res.json(rows.map((r) => r.action));
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
