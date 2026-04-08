/**
 * Broadcast notice routes — DFSA investor communications.
 */
import { Router } from 'express';
import { pool } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { logAudit } from '../services/audit.js';

const router = Router();
router.use(requireAuth);

// GET /notices — admins see all; others see only notices sent to them
router.get('/', async (req, res) => {
  try {
    let rows;
    if (req.user.role === 'admin') {
      ({ rows } = await pool.query(`
        SELECT n.*, u.display_name AS sent_by_name,
               (SELECT COUNT(*) FROM notice_recipients nr WHERE nr.notice_id = n.id) AS recipient_count,
               (SELECT COUNT(*) FROM notice_recipients nr WHERE nr.notice_id = n.id AND nr.read_at IS NOT NULL) AS read_count,
               (SELECT COUNT(*) FROM notice_recipients nr WHERE nr.notice_id = n.id AND nr.acknowledged_at IS NOT NULL) AS ack_count
        FROM notices n
        LEFT JOIN users u ON u.id = n.sent_by
        ORDER BY n.created_at DESC
      `));
    } else {
      ({ rows } = await pool.query(`
        SELECT n.*, nr.read_at, nr.acknowledged_at, u.display_name AS sent_by_name
        FROM notices n
        JOIN notice_recipients nr ON nr.notice_id = n.id
        LEFT JOIN users u ON u.id = n.sent_by
        WHERE nr.user_id = $1 AND n.status = 'sent'
        ORDER BY n.sent_at DESC
      `, [req.user.sub]));
    }

    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /notices — create a draft notice (admin)
router.post('/', requireRole('admin'), async (req, res) => {
  const { fundId, type, subject, body } = req.body;
  if (!subject || !body) return res.status(400).json({ error: 'Subject and body required' });

  try {
    const { rows: [notice] } = await pool.query(
      `INSERT INTO notices (fund_id, type, subject, body) VALUES ($1, $2, $3, $4) RETURNING *`,
      [fundId || null, type || 'general', subject, body]
    );
    res.status(201).json(notice);
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /notices/:id/send — send a draft notice to all eligible recipients
router.post('/:id/send', requireRole('admin'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: [notice] } = await client.query(
      `SELECT * FROM notices WHERE id = $1 AND status = 'draft'`,
      [req.params.id]
    );
    if (!notice) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Draft notice not found' });
    }

    // Find recipients: users with grants on the relevant fund (or all active users if no fund)
    let recipientQuery;
    let recipientParams;
    if (notice.fund_id) {
      recipientQuery = `
        SELECT DISTINCT u.id FROM users u
        JOIN grants g ON g.user_id = u.id AND g.fund_id = $1
        WHERE u.status = 'active' AND g.revoked_at IS NULL
      `;
      recipientParams = [notice.fund_id];
    } else {
      recipientQuery = `SELECT id FROM users WHERE status = 'active'`;
      recipientParams = [];
    }

    const { rows: recipients } = await client.query(recipientQuery, recipientParams);

    for (const r of recipients) {
      await client.query(
        `INSERT INTO notice_recipients (notice_id, user_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [notice.id, r.id]
      );
    }

    await client.query(
      `UPDATE notices SET status = 'sent', sent_by = $1, sent_at = NOW(), updated_at = NOW() WHERE id = $2`,
      [req.user.sub, notice.id]
    );

    await client.query('COMMIT');

    await logAudit({
      action: 'notice.sent',
      userId: req.user.sub,
      resource: 'notice',
      resourceId: notice.id,
      detail: { recipientCount: recipients.length, subject: notice.subject },
      ip: req.ip,
    });

    res.json({ message: `Notice sent to ${recipients.length} recipients` });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[notices] Send error:', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// POST /notices/:id/read — mark a notice as read (any authenticated user)
router.post('/:id/read', async (req, res) => {
  try {
    await pool.query(
      `UPDATE notice_recipients SET read_at = NOW()
       WHERE notice_id = $1 AND user_id = $2 AND read_at IS NULL`,
      [req.params.id, req.user.sub]
    );
    res.json({ message: 'Marked as read' });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /notices/:id/acknowledge — user explicitly confirms they have read the notice
router.post('/:id/acknowledge', async (req, res) => {
  try {
    const { rows: [recipient] } = await pool.query(
      `UPDATE notice_recipients SET read_at = COALESCE(read_at, NOW()), acknowledged_at = NOW()
       WHERE notice_id = $1 AND user_id = $2 AND acknowledged_at IS NULL
       RETURNING *`,
      [req.params.id, req.user.sub]
    );

    if (!recipient) {
      return res.status(400).json({ error: 'Already acknowledged or not a recipient' });
    }

    await logAudit({
      action: 'notice.acknowledged',
      userId: req.user.sub,
      resource: 'notice',
      resourceId: req.params.id,
      detail: { acknowledgedAt: recipient.acknowledged_at },
      ip: req.ip,
    });

    res.json({ message: 'Notice acknowledged', acknowledgedAt: recipient.acknowledged_at });
  } catch (err) {
    console.error('[notices] Acknowledge error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
