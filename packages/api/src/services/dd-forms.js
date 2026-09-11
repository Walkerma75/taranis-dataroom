/**
 * Standard DD forms: published once, downloadable by every company.
 *
 * The Taranis-to-company path for documents addressed to ONE company is
 * `company-shared.js`. This is the path for documents addressed to ALL of them:
 * the background-check consent, the sanctions/PEP declaration, the
 * beneficial-owner declaration, and whatever standard form comes next, each
 * published once, versioned, and optionally tied to the checklist items it
 * answers (HANDOVER-CW027, HANDOVER-C027).
 *
 * Why "forms" and not "templates": see migration 023. Everything that reads or
 * writes these rows lives here or in routes/dd-forms.js (Taranis side) and
 * routes/company-portal.js (company side). The scan reasoning is in
 * company-shared.js and applies unchanged: this is a path where bytes leave
 * Taranis for a counterparty, so it goes through the same scanner and the same
 * `downloadDecision` as everything else.
 */
import { storeScannedObject } from './company-shared.js';

export { SHARED_ALLOWED_EXTENSIONS as FORM_ALLOWED_EXTENSIONS } from './company-shared.js';
export { SHARED_MAX_FILE_BYTES as FORM_MAX_FILE_BYTES } from './company-shared.js';
export { cleanupSharedStaging as cleanupFormStaging } from './company-shared.js';

/** The reason written on version N when version N+1 replaces it. */
export function replacedReason(newVersion) {
  return `Replaced by version ${newVersion}`;
}

/**
 * Build the S3 key for a form.
 *
 *   forms/{formId}/{filename}
 *
 * A fourth top-level prefix, disjoint from 'companies/', 'taranis-shared/' and
 * 'documents/'. The filename is sanitised because it reaches an S3 key and a
 * Content-Disposition header.
 */
export function buildFormKey({ formId, filename }) {
  const safe = String(filename || 'file')
    .replace(/[\\/]/g, '_')
    .replace(/[\r\n]/g, '')
    .trim() || 'file';
  return `forms/${formId}/${safe}`;
}

/** Scan, then store. Returns `{ stored: false }` on an infected verdict. */
export async function storeFormFile({ file, formId, storage, scanner }) {
  return storeScannedObject({
    file,
    key: buildFormKey({ formId, filename: file.originalname }),
    storage,
    scanner,
    logPrefix: '[dd-forms]',
  });
}

/**
 * Parse and validate the `links` field of a publish/replace/PATCH request.
 *
 * Accepts a JSON string (multipart) or an array (JSON body) of
 * `{ fundId, ref }`. Returns a de-duplicated array or throws a FormInputError
 * with a readable message.
 */
export class FormInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FormInputError';
  }
}

export function parseLinks(raw) {
  if (raw === undefined || raw === null || raw === '') return [];
  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      throw new FormInputError('links must be a JSON array of { fundId, ref }');
    }
  }
  if (!Array.isArray(value)) throw new FormInputError('links must be an array of { fundId, ref }');

  const seen = new Set();
  const links = [];
  for (const entry of value) {
    const fundId = String(entry?.fundId || '').trim();
    const ref = String(entry?.ref || '').trim();
    if (!fundId || !ref) throw new FormInputError('Each link needs a fundId and a ref');
    const key = `${fundId}|${ref}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ fundId, ref });
  }
  return links;
}

/**
 * Check every link names a ref that exists in one of that fund's masters.
 *
 * Any version of any master for the fund counts: refs are permanent across
 * versions (migration 012), and a company seeded from an earlier version still
 * has the item.
 */
export async function assertLinksExist(client, links) {
  for (const { fundId, ref } of links) {
    const { rows: [hit] } = await client.query(
      `SELECT 1 FROM irl_template_items i
       JOIN irl_templates t ON t.id = i.template_id
       WHERE t.fund_id = $1 AND i.ref = $2
       LIMIT 1`,
      [fundId, ref]
    );
    if (!hit) {
      throw new FormInputError(
        `Item ${ref} does not exist on any checklist master for that fund. `
        + 'Links must name a ref from the fund’s IRL master.'
      );
    }
  }
}

/** Replace a form's links inside a transaction. */
export async function writeLinks(client, formId, links) {
  await client.query(`DELETE FROM dd_form_items WHERE form_id = $1`, [formId]);
  for (const { fundId, ref } of links) {
    await client.query(
      `INSERT INTO dd_form_items (form_id, fund_id, item_ref) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [formId, fundId, ref]
    );
  }
}

/** Normalise the `fundId` field: '' / 'all' / undefined → null (every company). */
export function normaliseFundId(raw) {
  if (raw === undefined || raw === null) return null;
  const value = String(raw).trim();
  if (!value || value.toLowerCase() === 'all') return null;
  return value;
}

/**
 * The company-facing shape.
 *
 * Deliberately narrow: what the form is, its version and date, how to get it,
 * and which of THIS company's items it is for. No storage key, no scan state,
 * no withdrawal record, no other fund's links.
 *
 * `items` is resolved per company by the route: only items that company can
 * see (never 'held'), each as `{ id, ref }` so the page can link to it.
 */
export function companyFormView(row, items = []) {
  return {
    id: row.id,
    title: row.title,
    description: row.description || null,
    filename: row.filename,
    sizeBytes: Number(row.size_bytes),
    contentType: row.content_type,
    version: Number(row.version),
    publishedAt: row.published_at,
    items,
  };
}

/** The Taranis-facing shape. */
export function adminFormView(row, { links = [], downloads = null } = {}) {
  return {
    id: row.id,
    title: row.title,
    description: row.description || null,
    filename: row.filename,
    sizeBytes: Number(row.size_bytes),
    contentType: row.content_type,
    fundId: row.fund_id || null,
    fundName: row.fund_name || null,
    version: Number(row.version),
    supersedes: row.supersedes || null,
    publishedAt: row.published_at,
    publishedBy: row.published_by_name || null,
    withdrawnAt: row.withdrawn_at || null,
    withdrawnBy: row.withdrawn_by_name || null,
    withdrawnReason: row.withdrawn_reason || null,
    scanState: row.scan_state,
    scanBackend: row.scan_backend || null,
    links: links.map((l) => ({
      fundId: l.fund_id || l.fundId,
      fundName: l.fund_name || l.fundName || null,
      ref: l.item_ref || l.ref,
      description: l.description || null,
    })),
    ...(downloads === null ? {} : { downloads: Number(downloads) }),
  };
}

/**
 * The SQL that says which live forms a company may see: not withdrawn, and
 * addressed to every company or to this company's fund. One definition, used
 * by the list, the download and the per-item lookup, so they cannot disagree.
 * `$fund` is the placeholder index of the fund id parameter.
 */
export function companyVisibleFormsClause(alias, fundParam) {
  return `${alias}.withdrawn_at IS NULL AND (${alias}.fund_id IS NULL OR ${alias}.fund_id = $${fundParam})`;
}
