/**
 * Fund CRUD routes.
 */
import { Router } from 'express';
import { pool } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { logAudit } from '../services/audit.js';

const router = Router();
router.use(requireAuth);

// GET /funds — all users can see funds they have grants for; admins see all
router.get('/', async (req, res) => {
  try {
    let rows;
    if (req.user.role === 'admin') {
      ({ rows } = await pool.query(`
        SELECT f.*,
               (SELECT COUNT(*) FROM documents d WHERE d.fund_id = f.id AND d.status = 'active') AS doc_count
        FROM funds f ORDER BY f.name
      `));
    } else {
      ({ rows } = await pool.query(`
        SELECT DISTINCT f.*,
               (SELECT COUNT(*) FROM documents d WHERE d.fund_id = f.id AND d.status = 'active') AS doc_count
        FROM funds f
        JOIN grants g ON g.fund_id = f.id
        WHERE g.user_id = $1 AND g.revoked_at IS NULL
          AND (g.expires_at IS NULL OR g.expires_at > NOW())
        ORDER BY f.name
      `, [req.user.sub]));
    }

    res.json(rows.map((f) => ({
      id: f.id,
      name: f.name,
      slug: f.slug,
      description: f.description,
      status: f.status,
      docCount: parseInt(f.doc_count, 10),
      createdAt: f.created_at,
    })));
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /funds — admin only
router.post('/', requireRole('admin'), async (req, res) => {
  const { name, slug, description } = req.body;
  if (!name || !slug) return res.status(400).json({ error: 'Name and slug required' });

  try {
    const { rows: [fund] } = await pool.query(
      `INSERT INTO funds (name, slug, description) VALUES ($1, $2, $3) RETURNING *`,
      [name, slug.toLowerCase().replace(/[^a-z0-9-]/g, ''), description || null]
    );

    await logAudit({ action: 'fund.created', userId: req.user.sub, resource: 'fund', resourceId: fund.id, ip: req.ip });
    res.status(201).json(fund);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Fund with that name or slug already exists' });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /funds/:id — admin only
router.patch('/:id', requireRole('admin'), async (req, res) => {
  const { name, description, status } = req.body;
  const sets = [];
  const vals = [];
  let idx = 1;

  if (name) { sets.push(`name = $${idx++}`); vals.push(name); }
  if (description !== undefined) { sets.push(`description = $${idx++}`); vals.push(description); }
  if (status) { sets.push(`status = $${idx++}`); vals.push(status); }

  if (sets.length === 0) return res.status(400).json({ error: 'Nothing to update' });
  sets.push(`updated_at = NOW()`);
  vals.push(req.params.id);

  try {
    const { rows: [fund] } = await pool.query(
      `UPDATE funds SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
      vals
    );
    if (!fund) return res.status(404).json({ error: 'Fund not found' });

    await logAudit({ action: 'fund.updated', userId: req.user.sub, resource: 'fund', resourceId: fund.id, detail: req.body, ip: req.ip });
    res.json(fund);
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /funds/categories — list document categories
router.get('/categories', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM document_categories ORDER BY sort_order`);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
