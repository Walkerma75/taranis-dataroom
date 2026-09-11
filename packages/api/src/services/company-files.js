/**
 * Staging for company uploads.
 *
 * Deliberately simpler than the fund-side `document-files.js` in one important
 * way: there is NO Word-to-PDF conversion. A company file is evidence in a due
 * diligence exchange. The receipt names the filename the company submitted, and
 * silently turning their .docx into a .pdf would mean the receipt, the audit
 * log and the file the company believes it sent no longer agree.
 *
 * As with the fund-side path, everything here is injectable so the whole flow
 * can be driven against `MemoryStorage` and a fake scanner with no S3, no
 * database and no container.
 */
import fs from 'fs';
import path from 'path';
import { STAGING_ROOT } from './storage.js';
import { buildCompanyFileKey } from './companies.js';

/**
 * Put a staged upload into the store and run it past the scanner.
 *
 * The scan verdict is returned rather than acted on here — the caller writes it
 * to `company_files.scan_state` and `scan_backend`, and the download path is
 * what refuses anything that is not 'clean'. Keeping the decision in one place
 * means the stub backend cannot accidentally open a download by returning an
 * unexpected value.
 *
 * @param {object}   opts
 * @param {object}   opts.file      - multer file: { path, destination, originalname, size, mimetype }
 * @param {string}   opts.companyId
 * @param {string}   opts.fileId    - the UUID already allocated for the row
 * @param {string}  [opts.irlItemId]
 * @param {object}   opts.storage
 * @param {object}   opts.scanner
 */
export async function storeCompanyUpload({
  file, companyId, fileId, irlItemId, storage, scanner,
}) {
  const stagingDir = file.destination || path.dirname(file.path);
  let body = null;

  try {
    const size = fs.statSync(file.path).size;
    const key = buildCompanyFileKey({
      companyId,
      irlItemId,
      fileId,
      filename: file.originalname,
    });

    // Scan the staged file before the bytes leave for the store, so an
    // infected file never reaches the bucket at all under a real backend.
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
    // below has already removed surfaces as an uncaught exception and takes
    // the process down. This is the same defect the Phase 0 harness caught.
    body.on('error', (err) => console.warn('[company-files] Upload stream error:', err.message));

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
    cleanupCompanyStaging(stagingDir);
  }
}

/** Remove a staging directory, refusing anything outside the staging root. */
export function cleanupCompanyStaging(dir) {
  if (!dir) return;
  const resolved = path.resolve(dir);
  if (!resolved.startsWith(path.resolve(STAGING_ROOT) + path.sep)) return;
  try {
    fs.rmSync(resolved, { recursive: true, force: true });
  } catch (err) {
    console.warn('[company-files] Failed to clean up staging directory:', err.message);
  }
}
