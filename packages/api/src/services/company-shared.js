/**
 * Taranis-to-company shared documents.
 *
 * Phase 1a moved files company to Taranis only. This is the other direction: a
 * document Taranis publishes into one company's workspace, read-only. The first
 * one is the AdrenoMed PRE-FILLED information request pack (HANDOVER-C005 §3.5).
 *
 * ---------------------------------------------------------------------------
 * WHY SHARED FILES ARE SCANNED, EVEN THOUGH THEY COME FROM TARANIS
 * ---------------------------------------------------------------------------
 * The obvious argument for skipping the scan is that these files originate
 * inside the firm rather than from a counterparty, so the threat model that
 * justifies scanning company uploads does not apply. That argument is weaker
 * than it looks, for three reasons.
 *
 * 1. "From Taranis" is not the same as "authored by Taranis". The pack an
 *    admin publishes is assembled from material counterparties sent us, and it
 *    is uploaded from an ordinary workstation over an ordinary browser session.
 *    The trust boundary is the bucket, not the org chart.
 *
 * 2. This is the only path on the platform where bytes leave Taranis for a
 *    counterparty. Receiving something infected is an internal problem;
 *    serving something infected to a company under diligence, from a portal
 *    carrying our name, is a different and worse conversation.
 *
 * 3. One rule beats two. `downloadDecision` in services/scanner.js already
 *    encodes the whole policy: infected is never served under any backend,
 *    clean is always served, and pending or error is served only while the stub
 *    is active and "not scanned" means nobody is scanning. Routing shared files
 *    through the same function means the rule tightens for BOTH directions the
 *    moment a real backend is configured, with nothing to remember and no
 *    second policy to keep in step.
 *
 * What this costs today: nothing. The Phase 1a scanner is a stub that inspects
 * no bytes and returns 'pending', which `downloadDecision` allows, so publishing
 * and downloading work exactly as they would with no scan at all. That the
 * uploads path is unscanned is a knowingly accepted beta risk, not a defect
 * (HANDOVER-C004 §3.1, MIGRATION-INVENTORY.md §12) and is not re-raised here.
 * What it buys is that the call site exists, `scan_backend = 'stub'` records in
 * the data exactly which published documents were never inspected, and enabling
 * a real engine later changes the backend and nothing else.
 *
 * The one place shared files are STRICTER than company uploads: an 'infected'
 * verdict refuses the publication outright and the bytes never reach the
 * bucket, so a quarantined shared document cannot exist. There is no reason to
 * keep one. A company upload is evidence and is kept even when quarantined; a
 * shared document is ours and can simply be published again.
 */
import fs from 'fs';
import path from 'path';
import { STAGING_ROOT } from './storage.js';

/**
 * What Taranis may publish. The same list as company uploads
 * (`COMPANY_ALLOWED_EXTENSIONS`), deliberately: a company that can send us a
 * format should be able to receive it back, and two divergent allow-lists is
 * one more thing to keep in step for no benefit.
 */
export { COMPANY_ALLOWED_EXTENSIONS as SHARED_ALLOWED_EXTENSIONS } from './companies.js';
export { COMPANY_MAX_FILE_BYTES as SHARED_MAX_FILE_BYTES } from './companies.js';

/**
 * Build the S3 key for a shared document.
 *
 *   taranis-shared/{companyId}/{sharedFileId}/{filename}
 *
 * A distinct top-level prefix from 'companies/' (company uploads) and
 * 'documents/' (fund documents), so a shared document is not reachable through
 * a company-upload key or a fund-document key, and neither is reachable through
 * this one. The filename is sanitised because it reaches an S3 key and a
 * Content-Disposition header.
 */
export function buildSharedFileKey({ companyId, sharedFileId, filename }) {
  const safe = String(filename || 'file')
    .replace(/[\\/]/g, '_')
    .replace(/[\r\n]/g, '')
    .trim() || 'file';
  return `taranis-shared/${companyId}/${sharedFileId}/${safe}`;
}

/**
 * Put a staged publication into the store, having scanned it first.
 *
 * Same shape as `storeCompanyUpload` in company-files.js, and injectable for
 * the same reason: the whole flow runs against `MemoryStorage` and a fake
 * scanner with no S3, no database and no container.
 *
 * Returns `{ stored: false }` on an infected verdict, having written nothing.
 *
 * @param {object}   opts
 * @param {object}   opts.file          - multer file: { path, destination, originalname, mimetype }
 * @param {string}   opts.companyId
 * @param {string}   opts.sharedFileId  - the UUID already allocated for the row
 * @param {object}   opts.storage
 * @param {object}   opts.scanner
 */
export async function storeSharedFile({ file, companyId, sharedFileId, storage, scanner }) {
  const stagingDir = file.destination || path.dirname(file.path);
  let body = null;

  try {
    const size = fs.statSync(file.path).size;
    const key = buildSharedFileKey({
      companyId,
      sharedFileId,
      filename: file.originalname,
    });

    // Scanned before the bytes leave for the store, so under a real backend an
    // infected file never reaches the bucket at all.
    const verdict = await scanner.scan(key, {
      filename: file.originalname,
      size,
      path: file.path,
    });

    if (verdict.state === 'infected') {
      return { key: null, size, verdict, stored: false };
    }

    // Streamed, not buffered, and byte-for-byte: no encryption, no base64, no
    // re-encoding on the way to the store.
    body = fs.createReadStream(file.path);
    // Without a listener, a late 'error' on a stream whose file the cleanup
    // below has already removed surfaces as an uncaught exception and takes the
    // process down. Same defect the Phase 0 harness caught.
    body.on('error', (err) => console.warn('[company-shared] Publish stream error:', err.message));

    await storage.put(key, {
      body,
      contentType: file.mimetype,
      contentLength: size,
    });

    return {
      key,
      size,
      filename: file.originalname,
      contentType: file.mimetype,
      verdict,
      stored: true,
    };
  } finally {
    if (body) body.destroy();
    cleanupSharedStaging(stagingDir);
  }
}

/** Remove a staging directory, refusing anything outside the staging root. */
export function cleanupSharedStaging(dir) {
  if (!dir) return;
  const resolved = path.resolve(dir);
  if (!resolved.startsWith(path.resolve(STAGING_ROOT) + path.sep)) return;
  try {
    fs.rmSync(resolved, { recursive: true, force: true });
  } catch (err) {
    console.warn('[company-shared] Failed to clean up staging directory:', err.message);
  }
}

/**
 * The company-facing shape of a shared document.
 *
 * Deliberately narrow. The company is told what the document is, who published
 * it and when, which is what HANDOVER-C005 §3.5 asks for and what makes a
 * published pack accountable rather than anonymous. It is NOT told the storage
 * key, the internal row of whoever withdrew something, or anything about other
 * companies.
 *
 * `publishedBy` is the display name of a named Taranis person. That is a
 * deliberate disclosure: the counterparty should be able to see who sent them a
 * document, exactly as they would with an email.
 */
export function companySharedView(row) {
  return {
    id: row.id,
    title: row.title,
    description: row.description || null,
    filename: row.filename,
    sizeBytes: Number(row.size_bytes),
    contentType: row.content_type,
    publishedAt: row.published_at,
    publishedBy: row.published_by_name || 'Taranis Capital',
  };
}

/**
 * The Taranis-facing shape. Carries the withdrawal record and the scan state,
 * neither of which the company side sees.
 */
export function adminSharedView(row) {
  return {
    id: row.id,
    title: row.title,
    description: row.description || null,
    filename: row.filename,
    sizeBytes: Number(row.size_bytes),
    contentType: row.content_type,
    publishedAt: row.published_at,
    publishedBy: row.published_by_name || null,
    withdrawnAt: row.withdrawn_at || null,
    withdrawnBy: row.withdrawn_by_name || null,
    withdrawnReason: row.withdrawn_reason || null,
    scanState: row.scan_state,
    scanBackend: row.scan_backend || null,
  };
}
