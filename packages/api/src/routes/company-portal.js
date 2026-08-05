/**
 * Company portal routes — the counterparty's own view of its due diligence.
 *
 * EVERY query in this file is scoped by `req.company.id`, which
 * `requireCompany()` resolved from the JWT `companyId` claim. No handler here
 * reads a company id from a path, query or body parameter. That is what makes
 * cross-company access impossible rather than merely refused: there is no id
 * for a company user to guess at, because no id they could supply is ever used.
 *
 * Lookups by item or file id are still written `WHERE id = $1 AND company_id =
 * $2`, so a guessed id from another company returns 404 rather than leaking the
 * existence of the row.
 *
 * Nothing in this file sends email. Phase 1a issues invite links for an admin
 * to send by hand (HANDOVER-CW004 §3 item 3).
 */
import { Router } from 'express';
import multer from 'multer';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { pool } from '../db.js';
import { requireAuth, requireCompany, requireCompanyRole } from '../middleware/auth.js';
import { logAudit } from '../services/audit.js';
import { getStorage, STAGING_ROOT } from '../services/storage.js';
import { getScanner } from '../services/scanner.js';
import { storeCompanyUpload, cleanupCompanyStaging } from '../services/company-files.js';
import {
  COMPANY_ALLOWED_EXTENSIONS,
  COMPANY_MAX_FILE_BYTES,
  companyVisibleItems,
  companySafeItem,
  summariseProgress,
  recomputeItemState,
  nextReceiptRef,
} from '../services/companies.js';

const stagingStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    try {
      fs.mkdirSync(STAGING_ROOT, { recursive: true });
      cb(null, fs.mkdtempSync(path.join(STAGING_ROOT, 'company-upload-')));
    } catch (err) {
      cb(err);
    }
  },
  filename: (_req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
    cb(null, `${unique}${path.extname(file.originalname)}`);
  },
});

const upload = multer({
  storage: stagingStorage,
  limits: { fileSize: COMPANY_MAX_FILE_BYTES },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (COMPANY_ALLOWED_EXTENSIONS.includes(ext)) cb(null, true);
    else cb(new Error(`File type ${ext} is not accepted`));
  },
});

const router = Router();
router.use(requireAuth, requireCompany());

/** Shape a file row for a company-facing response. */
function companyFileView(f) {
  return {
    id: f.id,
    irlItemId: f.irl_item_id,
    filename: f.filename,
    description: f.description,
    sizeBytes: Number(f.size_bytes),
    contentType: f.content_type,
    version: f.version,
    supersedes: f.supersedes,
    uploadState: f.upload_state,
    status: f.status,
    uploadedAt: f.created_at,
    uploadedBy: f.uploaded_by_name,
    receiptRef: f.receipt_ref || null,
    submittedAt: f.submitted_at || null,
    // The note a reviewer left with the current status. A note is mandatory on
    // 'attention_needed' precisely so the company knows what to fix, so it has
    // to reach them: a flag with no explanation is a wasted round trip.
    // file_status_history holds only reviewer notes, never internal notes,
    // which live on company_irl_items.internal_note and are stripped elsewhere.
    statusNote: f.status_note || null,
    statusSetAt: f.status_set_at || null,
  };
}

// ---------------------------------------------------------------------------
// GET /company/workspace — the checklist dashboard
// ---------------------------------------------------------------------------
router.get('/workspace', async (req, res) => {
  try {
    const { rows: items } = await pool.query(
      `SELECT i.*,
              (SELECT COUNT(*) FROM company_files f
                WHERE f.irl_item_id = i.id AND f.deleted_at IS NULL
                  AND f.upload_state = 'submitted')                    AS submitted_files,
              (SELECT COUNT(*) FROM company_files f
                WHERE f.irl_item_id = i.id AND f.deleted_at IS NULL
                  AND f.upload_state = 'staged')                       AS staged_files
       FROM company_irl_items i
       WHERE i.company_id = $1
       ORDER BY i.sort_order`,
      [req.company.id]
    );

    const visible = companyVisibleItems(items);

    res.json({
      company: {
        id: req.company.id,
        legalName: req.company.legalName,
      },
      membership: {
        role: req.companyMembership.role,
        isPrimary: req.companyMembership.isPrimary,
      },
      progress: summariseProgress(visible),
      items: visible.map((i) => ({
        ...companySafeItem({
          id: i.id,
          section: i.section,
          ref: i.ref,
          description: i.description,
          priority: i.priority,
          state: i.state,
          note_for_company: i.note_for_company,
          sort_order: i.sort_order,
        }),
        submittedFiles: Number(i.submitted_files),
        stagedFiles: Number(i.staged_files),
      })),
    });
  } catch (err) {
    console.error('[company] Workspace error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// GET /company/items/:itemId
// ---------------------------------------------------------------------------
router.get('/items/:itemId', async (req, res) => {
  try {
    const { rows: [item] } = await pool.query(
      `SELECT * FROM company_irl_items WHERE id = $1 AND company_id = $2`,
      [req.params.itemId, req.company.id]
    );
    // Same 404 whether the item belongs to another company or does not exist.
    if (!item) return res.status(404).json({ error: 'Item not found' });
    if (item.state === 'held') return res.status(404).json({ error: 'Item not found' });

    const { rows: files } = await pool.query(
      `SELECT f.*, u.display_name AS uploaded_by_name,
              b.receipt_ref, b.submitted_at,
              h.note AS status_note, h.created_at AS status_set_at
       FROM company_files f
       JOIN users u ON u.id = f.uploaded_by
       LEFT JOIN submission_batches b ON b.id = f.batch_id
       -- The most recent status entry for this file. LATERAL rather than a
       -- correlated subquery so the note and its timestamp come from the same
       -- row: two subqueries could disagree if a status changed mid-query.
       LEFT JOIN LATERAL (
         SELECT note, created_at FROM file_status_history
          WHERE file_id = f.id ORDER BY created_at DESC LIMIT 1
       ) h ON TRUE
       WHERE f.irl_item_id = $1 AND f.company_id = $2 AND f.deleted_at IS NULL
       ORDER BY f.created_at DESC`,
      [item.id, req.company.id]
    );

    res.json({
      item: companySafeItem({
        id: item.id,
        section: item.section,
        ref: item.ref,
        description: item.description,
        priority: item.priority,
        state: item.state,
        note_for_company: item.note_for_company,
        internal_note: item.internal_note,   // stripped by companySafeItem
      }),
      files: files.map(companyFileView),
    });
  } catch (err) {
    console.error('[company] Item detail error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// POST /company/files — upload into staging
// ---------------------------------------------------------------------------
router.post(
  '/files',
  requireCompanyRole('company_admin', 'company_contributor'),
  upload.single('file'),
  async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'A file is required' });

    const { irlItemId, description } = req.body;

    if (!description || !description.trim()) {
      cleanupCompanyStaging(req.file.destination);
      return res.status(400).json({ error: 'A description is required for every file' });
    }

    try {
      // If an item was named, it must be this company's, and one the company
      // is allowed to see.
      if (irlItemId) {
        const { rows: [item] } = await pool.query(
          `SELECT id, state FROM company_irl_items WHERE id = $1 AND company_id = $2`,
          [irlItemId, req.company.id]
        );
        if (!item || item.state === 'held') {
          cleanupCompanyStaging(req.file.destination);
          return res.status(404).json({ error: 'Item not found' });
        }
      }

      const fileId = crypto.randomUUID();
      const storage = await getStorage();
      const scanner = getScanner();

      const stored = await storeCompanyUpload({
        file: req.file,
        companyId: req.company.id,
        fileId,
        irlItemId: irlItemId || null,
        storage,
        scanner,
      });

      if (!stored.stored) {
        await logAudit({
          action: 'company_file.uploaded',
          userId: req.user.sub,
          resource: 'company',
          resourceId: req.company.id,
          detail: {
            filename: req.file.originalname,
            rejected: true,
            scanState: stored.verdict.state,
          },
          ip: req.ip,
        });
        return res.status(422).json({
          error: 'This file did not pass the security scan and has not been accepted.',
        });
      }

      const { rows: [row] } = await pool.query(
        `INSERT INTO company_files
           (id, company_id, irl_item_id, uploaded_by, filename, description,
            s3_key, size_bytes, content_type, upload_state, scan_state,
            scan_backend, scanned_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'staged', $10, $11, NOW())
         RETURNING *`,
        [
          fileId, req.company.id, irlItemId || null, req.user.sub,
          stored.filename, description.trim(), stored.key, stored.size,
          stored.contentType || 'application/octet-stream',
          stored.verdict.state, stored.verdict.backend,
        ]
      );

      await logAudit({
        action: 'company_file.uploaded',
        userId: req.user.sub,
        resource: 'company_file',
        resourceId: row.id,
        detail: {
          companyId: req.company.id,
          filename: stored.filename,
          size: stored.size,
          irlItemId: irlItemId || null,
          scanState: stored.verdict.state,
          scanBackend: stored.verdict.backend,
        },
        ip: req.ip,
      });

      res.status(201).json(companyFileView(row));
    } catch (err) {
      console.error('[company] Upload error:', err);
      cleanupCompanyStaging(req.file.destination);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ---------------------------------------------------------------------------
// POST /company/files/:fileId/replace — a new version of an existing file
// ---------------------------------------------------------------------------
router.post(
  '/files/:fileId/replace',
  requireCompanyRole('company_admin', 'company_contributor'),
  upload.single('file'),
  async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'A file is required' });
    const { description } = req.body;

    if (!description || !description.trim()) {
      cleanupCompanyStaging(req.file.destination);
      return res.status(400).json({ error: 'A description is required for every file' });
    }

    try {
      const { rows: [previous] } = await pool.query(
        `SELECT * FROM company_files
         WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL`,
        [req.params.fileId, req.company.id]
      );
      if (!previous) {
        cleanupCompanyStaging(req.file.destination);
        return res.status(404).json({ error: 'File not found' });
      }

      const fileId = crypto.randomUUID();
      const storage = await getStorage();
      const scanner = getScanner();

      const stored = await storeCompanyUpload({
        file: req.file,
        companyId: req.company.id,
        fileId,
        irlItemId: previous.irl_item_id,
        storage,
        scanner,
      });

      if (!stored.stored) {
        return res.status(422).json({
          error: 'This file did not pass the security scan and has not been accepted.',
        });
      }

      const { rows: [row] } = await pool.query(
        `INSERT INTO company_files
           (id, company_id, irl_item_id, uploaded_by, filename, description,
            s3_key, size_bytes, content_type, version, supersedes,
            upload_state, scan_state, scan_backend, scanned_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'staged', $12, $13, NOW())
         RETURNING *`,
        [
          fileId, req.company.id, previous.irl_item_id, req.user.sub,
          stored.filename, description.trim(), stored.key, stored.size,
          stored.contentType || 'application/octet-stream',
          previous.version + 1, previous.id,
          stored.verdict.state, stored.verdict.backend,
        ]
      );

      await logAudit({
        action: 'company_file.replaced',
        userId: req.user.sub,
        resource: 'company_file',
        resourceId: row.id,
        detail: {
          companyId: req.company.id,
          supersedes: previous.id,
          version: row.version,
          filename: stored.filename,
        },
        ip: req.ip,
      });

      if (previous.irl_item_id) await recomputeItemState(previous.irl_item_id);

      res.status(201).json(companyFileView(row));
    } catch (err) {
      console.error('[company] Replace error:', err);
      cleanupCompanyStaging(req.file.destination);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ---------------------------------------------------------------------------
// PATCH /company/files/:fileId — edit the description, STAGED only
// ---------------------------------------------------------------------------
router.patch(
  '/files/:fileId',
  requireCompanyRole('company_admin', 'company_contributor'),
  async (req, res) => {
    const { description } = req.body;
    if (!description || !description.trim()) {
      return res.status(400).json({ error: 'A description is required for every file' });
    }

    try {
      const { rows: [row] } = await pool.query(
        `UPDATE company_files SET description = $3
         WHERE id = $1 AND company_id = $2
           AND upload_state = 'staged' AND deleted_at IS NULL
         RETURNING *`,
        [req.params.fileId, req.company.id, description.trim()]
      );
      if (!row) {
        return res.status(404).json({
          error: 'File not found, or it has already been submitted and can no longer be edited',
        });
      }

      await logAudit({
        action: 'company_file.description_edited',
        userId: req.user.sub,
        resource: 'company_file',
        resourceId: row.id,
        detail: { companyId: req.company.id },
        ip: req.ip,
      });

      res.json(companyFileView(row));
    } catch (err) {
      console.error('[company] Edit description error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ---------------------------------------------------------------------------
// DELETE /company/files/:fileId — STAGED only
// ---------------------------------------------------------------------------
router.delete(
  '/files/:fileId',
  requireCompanyRole('company_admin', 'company_contributor'),
  async (req, res) => {
    try {
      const { rows: [row] } = await pool.query(
        `UPDATE company_files SET deleted_at = NOW()
         WHERE id = $1 AND company_id = $2
           AND upload_state = 'staged' AND deleted_at IS NULL
         RETURNING *`,
        [req.params.fileId, req.company.id]
      );
      if (!row) {
        return res.status(404).json({
          error: 'File not found, or it has already been submitted and can no longer be removed',
        });
      }

      // Soft delete only. The object stays in the bucket and the row stays in
      // the table so the audit trail still resolves.
      await logAudit({
        action: 'company_file.deleted_staged',
        userId: req.user.sub,
        resource: 'company_file',
        resourceId: row.id,
        detail: { companyId: req.company.id, filename: row.filename },
        ip: req.ip,
      });

      res.json({ message: 'File removed' });
    } catch (err) {
      console.error('[company] Delete staged error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ---------------------------------------------------------------------------
// GET /company/staged
// ---------------------------------------------------------------------------
router.get('/staged', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT f.*, u.display_name AS uploaded_by_name,
              i.ref AS item_ref, i.section AS item_section, i.description AS item_description
       FROM company_files f
       JOIN users u ON u.id = f.uploaded_by
       LEFT JOIN company_irl_items i ON i.id = f.irl_item_id
       WHERE f.company_id = $1 AND f.upload_state = 'staged' AND f.deleted_at IS NULL
       ORDER BY i.sort_order NULLS LAST, f.created_at`,
      [req.company.id]
    );

    res.json(rows.map((f) => ({
      ...companyFileView(f),
      itemRef: f.item_ref,
      itemSection: f.item_section,
      itemDescription: f.item_description,
    })));
  } catch (err) {
    console.error('[company] Staged list error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// POST /company/submit — formal submission, company_admin only
//
// One accountable individual per submission. Atomic: every named file moves or
// none does, so a partial submission can never produce a receipt that lists
// files the reviewer cannot see.
// ---------------------------------------------------------------------------
router.post('/submit', requireCompanyRole('company_admin'), async (req, res) => {
  const { fileIds } = req.body;

  if (!Array.isArray(fileIds) || fileIds.length === 0) {
    return res.status(400).json({ error: 'Select at least one file to submit' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock exactly the rows named, scoped to this company and still staged.
    const { rows: files } = await client.query(
      `SELECT * FROM company_files
       WHERE id = ANY($1::uuid[]) AND company_id = $2
         AND upload_state = 'staged' AND deleted_at IS NULL
       FOR UPDATE`,
      [fileIds, req.company.id]
    );

    // All or nothing. A file that belongs to another company, is already
    // submitted or has been removed fails the whole batch rather than being
    // quietly dropped from a receipt the company is about to rely on.
    if (files.length !== fileIds.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'One or more of the selected files is no longer available to submit. '
             + 'Refresh the page and try again.',
      });
    }

    const receiptRef = await nextReceiptRef(client);

    const { rows: [batch] } = await client.query(
      `INSERT INTO submission_batches (company_id, submitted_by, receipt_ref)
       VALUES ($1, $2, $3) RETURNING *`,
      [req.company.id, req.user.sub, receiptRef]
    );

    await client.query(
      `UPDATE company_files
       SET upload_state = 'submitted', status = 'received', batch_id = $2
       WHERE id = ANY($1::uuid[])`,
      [files.map((f) => f.id), batch.id]
    );

    // Opening status history for each file, so 'received' has a timestamp and
    // an actor like every later change does.
    for (const f of files) {
      await client.query(
        `INSERT INTO file_status_history (file_id, status, set_by) VALUES ($1, 'received', $2)`,
        [f.id, req.user.sub]
      );
    }

    await client.query('COMMIT');

    // Item states are derived outside the transaction: they are a projection of
    // what was just committed, and a failure here must not undo a submission
    // the company has already been told about.
    const itemIds = [...new Set(files.map((f) => f.irl_item_id).filter(Boolean))];
    for (const itemId of itemIds) await recomputeItemState(itemId);

    await logAudit({
      action: 'company_batch.submitted',
      userId: req.user.sub,
      resource: 'submission_batch',
      resourceId: batch.id,
      detail: {
        companyId: req.company.id,
        receiptRef,
        fileCount: files.length,
        files: files.map((f) => ({ filename: f.filename, description: f.description })),
      },
      ip: req.ip,
    });

    // No email in Phase 1a. The receipt is returned here and is available again
    // from GET /company/receipts; Taranis sees the batch on the review queue.
    res.status(201).json({
      receiptRef: batch.receipt_ref,
      submittedAt: batch.submitted_at,
      submittedBy: req.user.name,
      files: files.map((f) => ({
        id: f.id,
        filename: f.filename,
        description: f.description,
      })),
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[company] Submit error:', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// GET /company/receipts
// ---------------------------------------------------------------------------
router.get('/receipts', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT b.*, u.display_name AS submitted_by_name,
              (SELECT COUNT(*) FROM company_files f WHERE f.batch_id = b.id) AS file_count
       FROM submission_batches b
       JOIN users u ON u.id = b.submitted_by
       WHERE b.company_id = $1
       ORDER BY b.submitted_at DESC`,
      [req.company.id]
    );

    res.json(rows.map((b) => ({
      id: b.id,
      receiptRef: b.receipt_ref,
      submittedAt: b.submitted_at,
      submittedBy: b.submitted_by_name,
      fileCount: Number(b.file_count),
    })));
  } catch (err) {
    console.error('[company] Receipts error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// GET /company/receipts/:id — the printable receipt
// ---------------------------------------------------------------------------
router.get('/receipts/:id', async (req, res) => {
  try {
    const { rows: [batch] } = await pool.query(
      `SELECT b.*, u.display_name AS submitted_by_name, u.email AS submitted_by_email
       FROM submission_batches b
       JOIN users u ON u.id = b.submitted_by
       WHERE b.id = $1 AND b.company_id = $2`,
      [req.params.id, req.company.id]
    );
    if (!batch) return res.status(404).json({ error: 'Receipt not found' });

    const { rows: files } = await pool.query(
      `SELECT f.id, f.filename, f.description, f.size_bytes, f.created_at,
              i.ref AS item_ref, i.section AS item_section
       FROM company_files f
       LEFT JOIN company_irl_items i ON i.id = f.irl_item_id
       WHERE f.batch_id = $1
       ORDER BY i.sort_order NULLS LAST, f.filename`,
      [batch.id]
    );

    res.json({
      id: batch.id,
      receiptRef: batch.receipt_ref,
      // UTC, because the receipt is a record both sides refer back to and the
      // two sides are not in the same time zone.
      submittedAt: batch.submitted_at,
      submittedBy: batch.submitted_by_name,
      submittedByEmail: batch.submitted_by_email,
      companyName: req.company.legalName,
      files: files.map((f) => ({
        id: f.id,
        filename: f.filename,
        description: f.description,
        sizeBytes: Number(f.size_bytes),
        uploadedAt: f.created_at,
        itemRef: f.item_ref,
        itemSection: f.item_section,
      })),
    });
  } catch (err) {
    console.error('[company] Receipt detail error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// GET /company/team — members of this company
// ---------------------------------------------------------------------------
router.get('/team', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT cu.id, cu.company_role, cu.is_primary, cu.approved_by, cu.deactivated_at,
              cu.created_at, cu.domain_matched,
              u.id AS user_id, u.display_name, u.email, u.status
       FROM company_users cu
       JOIN users u ON u.id = cu.user_id
       WHERE cu.company_id = $1
       ORDER BY cu.is_primary DESC, u.display_name`,
      [req.company.id]
    );

    res.json(rows.map((m) => ({
      membershipId: m.id,
      userId: m.user_id,
      displayName: m.display_name,
      email: m.email,
      companyRole: m.company_role,
      isPrimary: m.is_primary,
      accountStatus: m.status,
      approved: !!m.approved_by,
      deactivatedAt: m.deactivated_at,
      joinedAt: m.created_at,
    })));
  } catch (err) {
    console.error('[company] Team error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// POST /company/nominations — company_admin nominates a colleague
//
// The domain check FLAGS a mismatch for the Taranis approval screen. It does
// not block: a genuine adviser on another domain is common and refusing them
// outright would push the exchange back to email.
// ---------------------------------------------------------------------------
router.post('/nominations', requireCompanyRole('company_admin'), async (req, res) => {
  const { email, displayName, companyRole, note } = req.body;

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
      `SELECT email_domains FROM companies WHERE id = $1`,
      [req.company.id]
    );
    const domain = normalised.split('@')[1] || '';
    const domains = company.email_domains || [];
    const domainMatched = domains.length === 0
      ? null
      : domains.some((d) => d.toLowerCase() === domain);

    const { rows: [user] } = await client.query(
      `INSERT INTO users (email, display_name, role, status)
       VALUES ($1, $2, 'company', 'invited')
       ON CONFLICT (email) DO UPDATE SET display_name = EXCLUDED.display_name
       RETURNING id, role`,
      [normalised, displayName.trim()]
    );

    // A nomination for someone who already holds a fund-side role is refused
    // rather than silently converted: changing a live investor into a company
    // user would take away their fund access.
    if (user.role !== 'company') {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'That email address already belongs to a Taranis account. '
             + 'Please contact Taranis directly.',
      });
    }

    const { rows: [membership] } = await client.query(
      `INSERT INTO company_users
         (company_id, user_id, company_role, nominated_by, nomination_note, domain_matched)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (company_id, user_id) DO NOTHING
       RETURNING id`,
      [
        req.company.id, user.id, companyRole || 'company_contributor',
        req.user.sub, note || null, domainMatched,
      ]
    );

    if (!membership) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'That person is already on your team' });
    }

    await client.query('COMMIT');

    await logAudit({
      action: 'company_user.nominated',
      userId: req.user.sub,
      resource: 'company',
      resourceId: req.company.id,
      detail: { nominatedEmail: normalised, companyRole: companyRole || 'company_contributor', domainMatched },
      ip: req.ip,
    });

    res.status(201).json({
      message: 'Nomination submitted. Taranis will review it and issue an invitation.',
      domainMatched,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[company] Nomination error:', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// PATCH /company/users/:userId/deactivate — a company_admin removes a leaver
// ---------------------------------------------------------------------------
router.patch('/users/:userId/deactivate', requireCompanyRole('company_admin'), async (req, res) => {
  if (req.params.userId === req.user.sub) {
    return res.status(400).json({ error: 'You cannot remove your own access' });
  }

  try {
    const { rows: [row] } = await pool.query(
      `UPDATE company_users
       SET deactivated_at = NOW(), deactivated_by = $3
       WHERE user_id = $1 AND company_id = $2 AND deactivated_at IS NULL
       RETURNING id, user_id`,
      [req.params.userId, req.company.id, req.user.sub]
    );
    if (!row) return res.status(404).json({ error: 'Team member not found' });

    // Immediate lockout, not lockout at token expiry.
    const { revokeAllUserTokens } = await import('../services/auth.js');
    await revokeAllUserTokens(row.user_id);

    await logAudit({
      action: 'company_user.deactivated',
      userId: req.user.sub,
      resource: 'company',
      resourceId: req.company.id,
      detail: { targetUserId: row.user_id, by: 'company_admin' },
      ip: req.ip,
    });

    res.json({ message: 'Access removed' });
  } catch (err) {
    console.error('[company] Deactivate error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
