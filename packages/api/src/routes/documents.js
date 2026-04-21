/**
 * Document routes — upload, list, download.
 * Uses S3 for file storage (bucket configured via S3_BUCKET env var).
 * Falls back to local filesystem if S3_BUCKET is not set (dev mode).
 */
import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { pool } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { logAudit } from '../services/audit.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = path.join(__dirname, '../../uploads');
const S3_BUCKET = process.env.S3_BUCKET || null;
const AWS_REGION = process.env.AWS_REGION || 'eu-west-2';

// S3 client (initialised only if bucket is configured)
const s3 = S3_BUCKET
  ? new S3Client({ region: AWS_REGION })
  : null;

// Ensure local upload directory exists (used as temp staging even with S3)
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
    cb(null, `${unique}${path.extname(file.originalname)}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB
  fileFilter: (_req, file, cb) => {
    const allowed = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.png', '.jpg', '.jpeg'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error(`File type ${ext} not allowed`));
  },
});

// Helper: upload a local file to S3 and clean up the local copy
async function uploadToS3(localPath, s3Key, mimeType) {
  const body = fs.readFileSync(localPath);
  await s3.send(new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: s3Key,
    Body: body,
    ContentType: mimeType,
  }));
  // Remove local temp file after successful S3 upload
  fs.unlinkSync(localPath);
  console.log(`[documents] Uploaded to S3: ${s3Key}`);
}

// Helper: stream a file from S3 to the HTTP response
async function streamFromS3(s3Key, res, contentType, disposition) {
  const command = new GetObjectCommand({
    Bucket: S3_BUCKET,
    Key: s3Key,
  });
  const s3Response = await s3.send(command);
  res.setHeader('Content-Type', contentType || 'application/octet-stream');
  res.setHeader('Content-Disposition', disposition);
  if (s3Response.ContentLength) {
    res.setHeader('Content-Length', s3Response.ContentLength);
  }
  s3Response.Body.pipe(res);
}

// Helper: load user capabilities from DB
async function getUserCapabilities(userId) {
  const { rows: [row] } = await pool.query(
    `SELECT COALESCE(capabilities, '{}') AS capabilities FROM users WHERE id = $1`,
    [userId]
  );
  return row?.capabilities || {};
}

const router = Router();
router.use(requireAuth);

// GET /documents?fundId=...&categoryId=...
router.get('/', async (req, res) => {
  const { fundId, categoryId } = req.query;

  try {
    let query, params;

    if (req.user.role === 'admin') {
      query = `
        SELECT d.*, f.name AS fund_name, f.slug AS fund_slug, c.name AS category_name,
               u.display_name AS uploaded_by_name
        FROM documents d
        JOIN funds f ON f.id = d.fund_id
        JOIN document_categories c ON c.id = d.category_id
        JOIN users u ON u.id = d.uploaded_by
        WHERE d.status = 'active'
        ${fundId ? 'AND d.fund_id = $1' : ''}
        ${categoryId ? `AND d.category_id = $${fundId ? 2 : 1}` : ''}
        ORDER BY f.name, c.sort_order, d.title
      `;
      params = [fundId, categoryId].filter(Boolean);
    } else {
      // Non-admins: only documents they have grants for
      let idx = 2;
      const extraWhere = [];
      params = [req.user.sub];
      if (fundId) { extraWhere.push(`AND d.fund_id = $${idx++}`); params.push(fundId); }
      if (categoryId) { extraWhere.push(`AND d.category_id = $${idx++}`); params.push(categoryId); }

      query = `
        SELECT d.*, f.name AS fund_name, f.slug AS fund_slug, c.name AS category_name,
               u.display_name AS uploaded_by_name,
               g.download_allowed AS grant_download
        FROM documents d
        JOIN funds f ON f.id = d.fund_id
        JOIN document_categories c ON c.id = d.category_id
        JOIN users u ON u.id = d.uploaded_by
        JOIN grants g ON g.fund_id = d.fund_id AND g.category_id = d.category_id AND g.user_id = $1
        WHERE d.status = 'active'
          AND g.revoked_at IS NULL
          AND (g.expires_at IS NULL OR g.expires_at > NOW())
          ${extraWhere.join(' ')}
        -- Check for per-document denials
        AND NOT EXISTS (
          SELECT 1 FROM document_overrides o
          WHERE o.document_id = d.id AND o.user_id = $1 AND o.action = 'deny'
        )
        ORDER BY f.name, c.sort_order, d.title
      `;
    }

    const { rows } = await pool.query(query, params);

    res.json(rows.map((d) => ({
      id: d.id,
      fundId: d.fund_id,
      fundName: d.fund_name,
      fundSlug: d.fund_slug,
      categoryId: d.category_id,
      categoryName: d.category_name,
      title: d.title,
      description: d.description,
      fileName: d.file_name,
      fileSize: d.file_size,
      mimeType: d.mime_type,
      version: d.version,
      downloadAllowed: d.download_allowed && (d.grant_download !== false),
      uploadedBy: d.uploaded_by_name,
      createdAt: d.created_at,
    })));
  } catch (err) {
    console.error('[documents] List error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /documents — upload (requires canUploadDocuments capability or admin role)
router.post('/', upload.single('file'), async (req, res) => {
  // Check capability
  const userCaps = await getUserCapabilities(req.user.sub);
  if (req.user.role !== 'admin' && !userCaps.canUploadDocuments) {
    return res.status(403).json({ error: 'You do not have permission to upload documents' });
  }
  if (!req.file) return res.status(400).json({ error: 'File required' });

  const { fundId, categoryId, title, description } = req.body;
  if (!fundId || !categoryId || !title) {
    return res.status(400).json({ error: 'fundId, categoryId and title are required' });
  }

  try {
    const finalFilename = req.file.filename;
    const finalOriginalName = req.file.originalname;
    const finalSize = req.file.size;
    const finalMimeType = req.file.mimetype;

    // Upload to S3 if configured, otherwise keep locally
    const s3Key = `documents/${fundId}/${finalFilename}`;
    const storagePath = s3 ? s3Key : finalFilename;

    if (s3) {
      const localPath = path.join(UPLOAD_DIR, finalFilename);
      await uploadToS3(localPath, s3Key, finalMimeType);
    }

    const { rows: [doc] } = await pool.query(
      `INSERT INTO documents (fund_id, category_id, title, description, file_name, file_path, file_size, mime_type, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        fundId, categoryId, title, description || null,
        finalOriginalName, storagePath, finalSize, finalMimeType,
        req.user.sub,
      ]
    );

    await logAudit({
      action: 'document.uploaded',
      userId: req.user.sub,
      resource: 'document',
      resourceId: doc.id,
      detail: {
        title, fundId, categoryId,
        fileName: req.file.originalname,
        size: req.file.size,
        storage: s3 ? 's3' : 'local',
      },
      ip: req.ip,
    });

    res.status(201).json(doc);
  } catch (err) {
    console.error('[documents] Upload error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /documents/:id/download — serve the file (checks permissions)
// Supports token in Authorization header OR ?token= query param (for iframes/new tabs)
router.get('/:id/download', async (req, res) => {
  // Allow token via query string for iframe/download links
  if (!req.headers.authorization && req.query.token) {
    req.headers.authorization = `Bearer ${req.query.token}`;
  }

  // Manual auth check (this route doesn't go through requireAuth middleware on its own)
  const { verifyAccessToken } = await import('../services/auth.js');
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  try {
    req.user = verifyAccessToken(header.slice(7));
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }

  try {
    const { rows: [doc] } = await pool.query(
      `SELECT * FROM documents WHERE id = $1 AND status = 'active'`,
      [req.params.id]
    );
    if (!doc) return res.status(404).json({ error: 'Document not found' });

    // Check permissions for non-admins
    if (req.user.role !== 'admin') {
      const { rows: [grant] } = await pool.query(
        `SELECT g.download_allowed FROM grants g
         WHERE g.user_id = $1 AND g.fund_id = $2 AND g.category_id = $3
           AND g.revoked_at IS NULL
           AND (g.expires_at IS NULL OR g.expires_at > NOW())`,
        [req.user.sub, doc.fund_id, doc.category_id]
      );

      if (!grant) return res.status(403).json({ error: 'Access denied' });

      // For download (not inline view), check download permission
      const isInlineCheck = req.query.inline === 'true';
      if (!isInlineCheck && (!grant.download_allowed || !doc.download_allowed)) {
        return res.status(403).json({ error: 'Download not permitted for this document' });
      }
    }

    const isInline = req.query.inline === 'true';

    await logAudit({
      action: isInline ? 'document.viewed' : 'document.downloaded',
      userId: req.user.sub,
      resource: 'document',
      resourceId: doc.id,
      detail: { title: doc.title },
      ip: req.ip,
    });

    const disposition = isInline
      ? `inline; filename="${doc.file_name}"`
      : `attachment; filename="${doc.file_name}"`;

    // Serve from S3 if configured, otherwise from local filesystem
    if (s3 && doc.file_path.startsWith('documents/')) {
      await streamFromS3(doc.file_path, res, doc.mime_type, disposition);
    } else {
      const filePath = path.join(UPLOAD_DIR, doc.file_path);
      res.setHeader('Content-Type', doc.mime_type || 'application/octet-stream');
      res.setHeader('Content-Disposition', disposition);
      res.sendFile(filePath);
    }
  } catch (err) {
    console.error('[documents] Download error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
});

// PATCH /documents/:id — update document metadata (admin or canUploadDocuments)
router.patch('/:id', async (req, res) => {
  const userCaps = await getUserCapabilities(req.user.sub);
  if (req.user.role !== 'admin' && !userCaps.canUploadDocuments) {
    return res.status(403).json({ error: 'You do not have permission to edit documents' });
  }

  const { title, description, categoryId } = req.body;
  if (!title && description === undefined && !categoryId) {
    return res.status(400).json({ error: 'No fields to update' });
  }

  try {
    // Build dynamic UPDATE query
    const sets = [];
    const params = [];
    let idx = 1;

    if (title) { sets.push(`title = $${idx++}`); params.push(title); }
    if (description !== undefined) { sets.push(`description = $${idx++}`); params.push(description || null); }
    if (categoryId) { sets.push(`category_id = $${idx++}`); params.push(categoryId); }
    sets.push(`updated_at = NOW()`);

    params.push(req.params.id);
    const query = `UPDATE documents SET ${sets.join(', ')} WHERE id = $${idx} AND status = 'active' RETURNING *`;

    const { rows: [doc] } = await pool.query(query, params);
    if (!doc) return res.status(404).json({ error: 'Document not found' });

    await logAudit({
      action: 'document.updated',
      userId: req.user.sub,
      resource: 'document',
      resourceId: doc.id,
      detail: { title, description, categoryId },
      ip: req.ip,
    });

    res.json(doc);
  } catch (err) {
    console.error('[documents] Update error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /documents/bulk — bulk upload (requires canUploadDocuments capability or admin role)
router.post('/bulk', upload.array('files', 50), async (req, res) => {
  const userCaps = await getUserCapabilities(req.user.sub);
  if (req.user.role !== 'admin' && !userCaps.canUploadDocuments) {
    return res.status(403).json({ error: 'You do not have permission to upload documents' });
  }

  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'At least one file is required' });
  }

  // metadata is a JSON array matching the order of the uploaded files
  let metadata;
  try {
    metadata = JSON.parse(req.body.metadata || '[]');
  } catch {
    return res.status(400).json({ error: 'Invalid metadata JSON' });
  }

  if (metadata.length !== req.files.length) {
    return res.status(400).json({ error: `Metadata count (${metadata.length}) does not match file count (${req.files.length})` });
  }

  // Validate each entry has required fields
  for (let i = 0; i < metadata.length; i++) {
    const m = metadata[i];
    if (!m.fundId || !m.categoryId || !m.title) {
      return res.status(400).json({ error: `File ${i + 1} is missing fundId, categoryId, or title` });
    }
  }

  const results = [];
  const errors = [];

  for (let i = 0; i < req.files.length; i++) {
    const file = req.files[i];
    const meta = metadata[i];

    try {
      const finalFilename = file.filename;
      const finalOriginalName = file.originalname;
      const finalSize = file.size;
      const finalMimeType = file.mimetype;

      // Upload to S3
      const s3Key = `documents/${meta.fundId}/${finalFilename}`;
      const storagePath = s3 ? s3Key : finalFilename;

      if (s3) {
        const localPath = path.join(UPLOAD_DIR, finalFilename);
        await uploadToS3(localPath, s3Key, finalMimeType);
      }

      const { rows: [doc] } = await pool.query(
        `INSERT INTO documents (fund_id, category_id, title, description, file_name, file_path, file_size, mime_type, download_allowed, uploaded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING *`,
        [
          meta.fundId, meta.categoryId, meta.title, meta.description || null,
          finalOriginalName, storagePath, finalSize, finalMimeType,
          meta.downloadAllowed !== false, req.user.sub,
        ]
      );

      await logAudit({
        action: 'document.uploaded',
        userId: req.user.sub,
        resource: 'document',
        resourceId: doc.id,
        detail: {
          title: meta.title, fundId: meta.fundId, categoryId: meta.categoryId,
          fileName: file.originalname, size: file.size,
          storage: s3 ? 's3' : 'local', bulk: true,
        },
        ip: req.ip,
      });

      results.push({ file: file.originalname, id: doc.id, success: true });
    } catch (err) {
      console.error(`[documents/bulk] Error uploading ${file.originalname}:`, err);
      errors.push({ file: file.originalname, error: err.message });
      // Clean up temp file on error
      try { fs.unlinkSync(path.join(UPLOAD_DIR, file.filename)); } catch {}
    }
  }

  const status = errors.length === 0 ? 201 : (results.length > 0 ? 207 : 500);
  res.status(status).json({ results, errors, total: req.files.length, succeeded: results.length, failed: errors.length });
});

// DELETE /documents/:id — admin soft-delete (archive)
router.delete('/:id', requireRole('admin'), async (req, res) => {
  try {
    const { rows: [doc] } = await pool.query(
      `UPDATE documents SET status = 'archived', updated_at = NOW() WHERE id = $1 RETURNING id`,
      [req.params.id]
    );
    if (!doc) return res.status(404).json({ error: 'Document not found' });

    await logAudit({ action: 'document.archived', userId: req.user.sub, resource: 'document', resourceId: doc.id, ip: req.ip });
    res.json({ message: 'Document archived' });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
