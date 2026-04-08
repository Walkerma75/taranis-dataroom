/**
 * Document routes — upload, list, download.
 * Uses local filesystem in dev; will switch to S3 presigned URLs in production.
 */
import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { pool } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { logAudit } from '../services/audit.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = path.join(__dirname, '../../uploads');

// Ensure upload directory exists
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
    // Auto-convert Word documents to PDF
    let finalFilename = req.file.filename;
    let finalOriginalName = req.file.originalname;
    let finalSize = req.file.size;
    let finalMimeType = req.file.mimetype;
    let converted = false;

    const ext = path.extname(req.file.originalname).toLowerCase();
    if (['.doc', '.docx'].includes(ext)) {
      try {
        const inputPath = path.join(UPLOAD_DIR, req.file.filename);
        execSync(`libreoffice --headless --convert-to pdf --outdir "${UPLOAD_DIR}" "${inputPath}"`, {
          timeout: 60000, // 60 second timeout
        });

        // LibreOffice outputs with same base name but .pdf extension
        const baseName = path.basename(req.file.filename, path.extname(req.file.filename));
        const pdfFilename = `${baseName}.pdf`;
        const pdfPath = path.join(UPLOAD_DIR, pdfFilename);

        if (fs.existsSync(pdfPath)) {
          finalFilename = pdfFilename;
          finalOriginalName = req.file.originalname.replace(/\.(doc|docx)$/i, '.pdf');
          finalSize = fs.statSync(pdfPath).size;
          finalMimeType = 'application/pdf';
          converted = true;

          // Remove the original Word file
          fs.unlinkSync(inputPath);
          console.log(`[documents] Converted ${req.file.originalname} to PDF`);
        }
      } catch (convErr) {
        console.warn('[documents] PDF conversion failed, keeping original:', convErr.message);
        // Fall through — keep the original Word file
      }
    }

    const { rows: [doc] } = await pool.query(
      `INSERT INTO documents (fund_id, category_id, title, description, file_name, file_path, file_size, mime_type, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        fundId, categoryId, title, description || null,
        finalOriginalName, finalFilename, finalSize, finalMimeType,
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
        ...(converted ? { convertedToPdf: true, originalFormat: ext } : {}),
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

    const filePath = path.join(UPLOAD_DIR, doc.file_path);

    if (isInline) {
      // Serve inline for preview (PDF/images in iframe/img tags)
      res.setHeader('Content-Type', doc.mime_type || 'application/octet-stream');
      res.setHeader('Content-Disposition', `inline; filename="${doc.file_name}"`);
      res.sendFile(filePath);
    } else {
      res.download(filePath, doc.file_name);
    }
  } catch (err) {
    console.error('[documents] Download error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
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
