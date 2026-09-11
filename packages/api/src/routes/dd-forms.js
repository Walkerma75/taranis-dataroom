/**
 * Taranis-side routes for standard DD forms (HANDOVER-CW027 / C027).
 *
 * Mounted at /forms. Admins only: the nav entry, the page and every route here.
 * A form is seen by every company (or every company in one fund), which is a
 * wider audience than any single company page, so the reviewer levels that
 * can publish INTO one company's "From Taranis" do not apply.
 *
 * The company side (list, download, and the per-item box) is in
 * routes/company-portal.js, scoped by the company's own token.
 */
import { Router } from 'express';
import multer from 'multer';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { pool } from '../db.js';
import { requireAuth, requireRole, rejectCompanyRole } from '../middleware/auth.js';
import { logAudit } from '../services/audit.js';
import { getStorage, StorageNotFoundError, STAGING_ROOT } from '../services/storage.js';
import { getScanner, downloadDecision } from '../services/scanner.js';
import { contentDispositionFilename } from '../services/document-files.js';
import {
  FORM_ALLOWED_EXTENSIONS,
  FORM_MAX_FILE_BYTES,
  storeFormFile,
  cleanupFormStaging,
  adminFormView,
  parseLinks,
  assertLinksExist,
  writeLinks,
  normaliseFundId,
  replacedReason,
  FormInputError,
} from '../services/dd-forms.js';

const router = Router();
router.use(requireAuth, rejectCompanyRole, requireRole('admin'));

const formStaging = multer.diskStorage({
  destination: (_req, _file, cb) => {
    try {
      fs.mkdirSync(STAGING_ROOT, { recursive: true });
      cb(null, fs.mkdtempSync(path.join(STAGING_ROOT, 'form-publish-')));
    } catch (err) {
      cb(err);
    }
  },
  filename: (_req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
    cb(null, `${unique}${path.extname(file.originalname)}`);
  },
});

const formUpload = multer({
  storage: formStaging,
  limits: { fileSize: FORM_MAX_FILE_BYTES },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (FORM_ALLOWED_EXTENSIONS.includes(ext)) cb(null, true);
    else cb(new Error(`File type ${ext} is not accepted`));
  },
});

const FORM_SELECT = `
  SELECT f.*, fu.name AS fund_name,
         p.display_name AS published_by_name,
         w.display_name AS withdrawn_by_name
  FROM dd_forms f
  LEFT JOIN funds fu ON fu.id = f.fund_id
  JOIN users p ON p.id = f.published_by
  LEFT JOIN users w ON w.id = f.withdrawn_by`;

async function loadLinks(client, formIds) {
  if (!formIds.length) return new Map();
  const { rows } = await client.query(
    `SELECT l.form_id, l.fund_id, l.item_ref, fu.name AS fund_name,
            (SELECT i.description FROM irl_template_items i
              JOIN irl_templates t ON t.id = i.template_id
              WHERE t.fund_id = l.fund_id AND i.ref = l.item_ref
              ORDER BY t.version DESC LIMIT 1) AS description
     FROM dd_form_items l
     JOIN funds fu ON fu.id = l.fund_id
     WHERE l.form_id = ANY($1::uuid[])
     ORDER BY fu.name, l.item_ref`,
    [formIds]
  );
  const byForm = new Map();
  for (const row of rows) {
    if (!byForm.has(row.form_id)) byForm.set(row.form_id, []);
    byForm.get(row.form_id).push(row);
  }
  return byForm;
}

/** Company downloads per form id, from the audit log (one row per download). */
async function loadDownloadCounts(client, formIds) {
  if (!formIds.length) return new Map();
  const { rows } = await client.query(
    `SELECT resource_id, COUNT(*) AS downloads
     FROM audit_log
     WHERE action = 'company_form.downloaded' AND resource_id = ANY($1::text[])
     GROUP BY resource_id`,
    [formIds]
  );
  return new Map(rows.map((r) => [r.resource_id, Number(r.downloads)]));
}

async function viewsFor(client, rows, { withDownloads = true } = {}) {
  const ids = rows.map((r) => r.id);
  const [links, downloads] = await Promise.all([
    loadLinks(client, ids),
    withDownloads ? loadDownloadCounts(client, ids) : new Map(),
  ]);
  return rows.map((r) => adminFormView(r, {
    links: links.get(r.id) || [],
    downloads: withDownloads ? (downloads.get(r.id) || 0) : null,
  }));
}

function inputError(res, err) {
  if (err instanceof FormInputError) {
    res.status(400).json({ error: err.message });
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// GET /forms — current forms (not withdrawn), with links and download counts
// ---------------------------------------------------------------------------
router.get('/', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `${FORM_SELECT} WHERE f.withdrawn_at IS NULL ORDER BY f.title, f.published_at DESC`
    );
    res.json(await viewsFor(pool, rows));
  } catch (err) {
    console.error('[dd-forms] List error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// GET /forms/history — every version and every withdrawn row
// ---------------------------------------------------------------------------
router.get('/history', async (_req, res) => {
  try {
    const { rows } = await pool.query(`${FORM_SELECT} ORDER BY f.published_at DESC`);
    res.json(await viewsFor(pool, rows));
  } catch (err) {
    console.error('[dd-forms] History error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// GET /forms/refs?fundId= — the refs an admin may link a form to
// ---------------------------------------------------------------------------
router.get('/refs', async (req, res) => {
  const fundId = String(req.query.fundId || '').trim();
  if (!fundId) return res.status(400).json({ error: 'fundId is required' });
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (i.ref) i.ref, i.section, i.description, i.sort_order
       FROM irl_template_items i
       JOIN irl_templates t ON t.id = i.template_id
       WHERE t.fund_id = $1
       ORDER BY i.ref, t.version DESC`,
      [fundId]
    );
    rows.sort((a, b) => a.sort_order - b.sort_order);
    res.json(rows.map((r) => ({ ref: r.ref, section: r.section, description: r.description })));
  } catch (err) {
    console.error('[dd-forms] Refs error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Shared body of publish and replace: scan, store, insert the row and its links.
 * Runs inside the caller's transaction. Returns the inserted row, or null after
 * having sent a 4xx.
 */
async function insertForm(client, req, res, {
  formId, title, description, fundId, links, version, supersedes,
}) {
  const storage = await getStorage();
  const scanner = getScanner();
  const stored = await storeFormFile({ file: req.file, formId, storage, scanner });

  if (!stored.stored) {
    await logAudit({
      action: version > 1 ? 'dd_form.replaced' : 'dd_form.published',
      userId: req.user.sub,
      resource: 'dd_form',
      resourceId: supersedes || formId,
      detail: { filename: req.file.originalname, rejected: true, scanState: stored.verdict.state },
      ip: req.ip,
    });
    res.status(422).json({
      error: 'This file did not pass the security scan and has not been published.',
    });
    return null;
  }

  const { rows: [row] } = await client.query(
    `INSERT INTO dd_forms
       (id, title, description, filename, s3_key, size_bytes, content_type, fund_id,
        version, supersedes, published_by, scan_state, scan_backend, scanned_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())
     RETURNING *`,
    [
      formId, title, description, stored.filename, stored.key, stored.size,
      stored.contentType || 'application/octet-stream', fundId,
      version, supersedes, req.user.sub, stored.verdict.state, stored.verdict.backend,
    ]
  );
  await writeLinks(client, formId, links);
  return row;
}

// ---------------------------------------------------------------------------
// POST /forms — publish version 1 of a new form (multipart)
// ---------------------------------------------------------------------------
router.post('/', formUpload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'A file is required' });
  const { title, description } = req.body;
  if (!title || !title.trim()) {
    cleanupFormStaging(req.file.destination);
    return res.status(400).json({
      error: 'A title is required. Companies see this, so name the form as they would.',
    });
  }

  let links;
  try {
    links = parseLinks(req.body.links);
  } catch (err) {
    cleanupFormStaging(req.file.destination);
    if (inputError(res, err)) return;
    throw err;
  }
  const fundId = normaliseFundId(req.body.fundId);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (fundId) {
      const { rows: [fund] } = await client.query(`SELECT id FROM funds WHERE id = $1`, [fundId]);
      if (!fund) {
        await client.query('ROLLBACK');
        cleanupFormStaging(req.file.destination);
        return res.status(400).json({ error: 'Unknown fund' });
      }
    }
    await assertLinksExist(client, links);

    const formId = crypto.randomUUID();
    const row = await insertForm(client, req, res, {
      formId, title: title.trim(), description: description?.trim() || null,
      fundId, links, version: 1, supersedes: null,
    });
    if (!row) {
      await client.query('ROLLBACK');
      return;
    }
    await client.query('COMMIT');

    await logAudit({
      action: 'dd_form.published',
      userId: req.user.sub,
      resource: 'dd_form',
      resourceId: row.id,
      detail: {
        title: row.title, filename: row.filename, size: Number(row.size_bytes),
        fundId: row.fund_id, version: 1, links,
        scanState: row.scan_state, scanBackend: row.scan_backend,
      },
      ip: req.ip,
    });

    const [view] = await viewsFor(pool, [{ ...row, published_by_name: req.user.name }]);
    res.status(201).json({ ...view, message: 'Form published. Companies can download it now.' });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    cleanupFormStaging(req.file.destination);
    if (inputError(res, err)) return;
    console.error('[dd-forms] Publish error:', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// POST /forms/:id/replace — publish version N+1; withdraw N (multipart)
//
// Title, description, visibility and links carry over unless supplied.
// ---------------------------------------------------------------------------
router.post('/:id/replace', formUpload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'A file is required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [current] } = await client.query(
      `SELECT * FROM dd_forms WHERE id = $1 AND withdrawn_at IS NULL FOR UPDATE`,
      [req.params.id]
    );
    if (!current) {
      await client.query('ROLLBACK');
      cleanupFormStaging(req.file.destination);
      return res.status(404).json({ error: 'Form not found, or it is not the current version' });
    }

    const { rows: currentLinks } = await client.query(
      `SELECT fund_id, item_ref FROM dd_form_items WHERE form_id = $1`, [current.id]
    );
    const links = req.body.links !== undefined
      ? parseLinks(req.body.links)
      : currentLinks.map((l) => ({ fundId: l.fund_id, ref: l.item_ref }));
    await assertLinksExist(client, links);

    const title = req.body.title !== undefined ? String(req.body.title).trim() : current.title;
    if (!title) {
      await client.query('ROLLBACK');
      cleanupFormStaging(req.file.destination);
      return res.status(400).json({ error: 'A title is required' });
    }
    const description = req.body.description !== undefined
      ? (String(req.body.description).trim() || null)
      : current.description;
    const fundId = req.body.fundId !== undefined ? normaliseFundId(req.body.fundId) : current.fund_id;

    const newVersion = Number(current.version) + 1;
    const formId = crypto.randomUUID();
    const row = await insertForm(client, req, res, {
      formId, title, description, fundId, links, version: newVersion, supersedes: current.id,
    });
    if (!row) {
      await client.query('ROLLBACK');
      return;
    }

    await client.query(
      `UPDATE dd_forms
       SET withdrawn_at = NOW(), withdrawn_by = $2, withdrawn_reason = $3, updated_at = NOW()
       WHERE id = $1`,
      [current.id, req.user.sub, replacedReason(newVersion)]
    );
    await client.query('COMMIT');

    await logAudit({
      action: 'dd_form.replaced',
      userId: req.user.sub,
      resource: 'dd_form',
      resourceId: row.id,
      detail: {
        title: row.title, filename: row.filename, size: Number(row.size_bytes),
        fundId: row.fund_id, version: newVersion, supersedes: current.id,
        previousVersion: Number(current.version), links,
        scanState: row.scan_state, scanBackend: row.scan_backend,
      },
      ip: req.ip,
    });

    const [view] = await viewsFor(pool, [{ ...row, published_by_name: req.user.name }]);
    res.status(201).json({
      ...view,
      message: `Version ${newVersion} published. Version ${current.version} has been withdrawn; `
             + 'companies now see only the new version.',
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    cleanupFormStaging(req.file.destination);
    if (inputError(res, err)) return;
    console.error('[dd-forms] Replace error:', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// PATCH /forms/:id — title, description, visibility, links; no new file
// ---------------------------------------------------------------------------
router.patch('/:id', async (req, res) => {
  const { title, description, fundId, links: rawLinks } = req.body || {};
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [current] } = await client.query(
      `SELECT * FROM dd_forms WHERE id = $1 AND withdrawn_at IS NULL FOR UPDATE`,
      [req.params.id]
    );
    if (!current) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Form not found, or it is not the current version' });
    }

    const sets = [];
    const params = [current.id];
    const before = {};
    const after = {};
    const add = (col, value) => {
      params.push(value);
      sets.push(`${col} = $${params.length}`);
      before[col] = current[col];
      after[col] = value;
    };

    if (title !== undefined) {
      const trimmed = String(title).trim();
      if (!trimmed) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'A title is required' });
      }
      add('title', trimmed);
    }
    if (description !== undefined) add('description', String(description).trim() || null);
    if (fundId !== undefined) {
      const normalised = normaliseFundId(fundId);
      if (normalised) {
        const { rows: [fund] } = await client.query(`SELECT id FROM funds WHERE id = $1`, [normalised]);
        if (!fund) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Unknown fund' });
        }
      }
      add('fund_id', normalised);
    }

    let links = null;
    if (rawLinks !== undefined) {
      links = parseLinks(rawLinks);
      await assertLinksExist(client, links);
      const { rows: currentLinks } = await client.query(
        `SELECT fund_id, item_ref FROM dd_form_items WHERE form_id = $1`, [current.id]
      );
      before.links = currentLinks.map((l) => ({ fundId: l.fund_id, ref: l.item_ref }));
      after.links = links;
      await writeLinks(client, current.id, links);
    }

    if (sets.length) {
      sets.push('updated_at = NOW()');
      await client.query(`UPDATE dd_forms SET ${sets.join(', ')} WHERE id = $1`, params);
    }
    await client.query('COMMIT');

    if (sets.length || links) {
      await logAudit({
        action: 'dd_form.edited',
        userId: req.user.sub,
        resource: 'dd_form',
        resourceId: current.id,
        detail: { version: Number(current.version), before, after },
        ip: req.ip,
      });
    }

    const { rows } = await pool.query(`${FORM_SELECT} WHERE f.id = $1`, [current.id]);
    const [view] = await viewsFor(pool, rows);
    res.json(view);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (inputError(res, err)) return;
    console.error('[dd-forms] Edit error:', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// POST /forms/:id/withdraw — soft, reason mandatory
// ---------------------------------------------------------------------------
router.post('/:id/withdraw', async (req, res) => {
  const reason = String(req.body?.reason || '').trim();
  if (!reason) {
    return res.status(400).json({
      error: 'A reason is required. Every company could see this form, so the record says why it went.',
    });
  }
  try {
    const { rows: [row] } = await pool.query(
      `UPDATE dd_forms
       SET withdrawn_at = NOW(), withdrawn_by = $2, withdrawn_reason = $3, updated_at = NOW()
       WHERE id = $1 AND withdrawn_at IS NULL
       RETURNING *`,
      [req.params.id, req.user.sub, reason]
    );
    if (!row) {
      return res.status(404).json({ error: 'Form not found, or it has already been withdrawn' });
    }

    await logAudit({
      action: 'dd_form.withdrawn',
      userId: req.user.sub,
      resource: 'dd_form',
      resourceId: row.id,
      detail: {
        title: row.title, filename: row.filename, version: Number(row.version),
        reason, publishedAt: row.published_at,
      },
      ip: req.ip,
    });

    res.json({
      message: 'Form withdrawn. Companies can no longer see it. '
             + 'The record of the publication and of every download is kept.',
      ...adminFormView(row),
    });
  } catch (err) {
    console.error('[dd-forms] Withdraw error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// GET /forms/:id/download — any version, withdrawn included
// ---------------------------------------------------------------------------
router.get('/:id/download', async (req, res) => {
  try {
    const { rows: [row] } = await pool.query(`SELECT * FROM dd_forms WHERE id = $1`, [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Form not found' });

    const decision = downloadDecision(row.scan_state);
    if (!decision.allowed) {
      return res.status(409).json({
        error: decision.reason, scanState: row.scan_state, scanner: getScanner().kind,
      });
    }

    const storage = await getStorage();
    let object;
    try {
      object = await storage.get(row.s3_key);
    } catch (err) {
      if (err instanceof StorageNotFoundError) {
        return res.status(404).json({ error: 'File is no longer available' });
      }
      throw err;
    }

    await logAudit({
      action: 'dd_form.downloaded',
      userId: req.user.sub,
      resource: 'dd_form',
      resourceId: row.id,
      detail: {
        title: row.title, filename: row.filename, version: Number(row.version),
        by: 'taranis', withdrawn: !!row.withdrawn_at,
      },
      ip: req.ip,
    });

    res.setHeader('X-Taranis-Scan-State', row.scan_state);
    res.setHeader('Content-Type', row.content_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${contentDispositionFilename(row.filename)}"`);
    if (object.contentLength != null) res.setHeader('Content-Length', object.contentLength);

    object.body.on('error', (streamErr) => {
      console.error('[dd-forms] Download stream error:', streamErr.message);
      res.destroy(streamErr);
    });
    object.body.pipe(res);
  } catch (err) {
    console.error('[dd-forms] Download error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
