/**
 * Upload staging for documents.
 *
 * An upload lands in a per-request temp directory, is converted to PDF if it is
 * a Word file, is streamed into the storage service, and the temp directory is
 * then removed. Nothing is left on container-local disk.
 *
 * Everything here is pure enough to test: the storage service and the converter
 * are both injected, so `storeUpload()` can be driven end to end against
 * `MemoryStorage` with no S3, no LibreOffice and no database.
 */
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { STAGING_ROOT } from './storage.js';

/** Extensions accepted by the upload route. */
export const ALLOWED_EXTENSIONS = [
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.png', '.jpg', '.jpeg',
];

/** Word formats that get converted to PDF on the way in. */
export const CONVERTIBLE_EXTENSIONS = ['.doc', '.docx'];

/**
 * Build the S3 key for a new document.
 *
 * Keys are namespaced by fund so the bucket stays browsable, and carry the
 * original extension so a `Content-Type` sniffed from the key is still right.
 * The key is stored verbatim in `documents.file_path`.
 */
export function buildStorageKey({ fundId, fileName, now = Date.now(), random = Math.random }) {
  const unique = `${now}-${Math.round(random() * 1e6)}`;
  const ext = path.extname(fileName || '').toLowerCase();
  return `documents/${fundId}/${unique}${ext}`;
}

/**
 * Convert a Word file to PDF with LibreOffice, which is installed in the API
 * image. Returns the path of the produced PDF, or null if nothing was produced.
 *
 * `exec` is injectable so tests do not need LibreOffice.
 */
export function convertWordToPdf(inputPath, outDir, { exec = execSync, timeout = 60000 } = {}) {
  exec(`libreoffice --headless --convert-to pdf --outdir "${outDir}" "${inputPath}"`, { timeout });

  // LibreOffice writes the same base name with a .pdf extension.
  const pdfPath = path.join(outDir, `${path.basename(inputPath, path.extname(inputPath))}.pdf`);
  return fs.existsSync(pdfPath) ? pdfPath : null;
}

/**
 * Take a staged multer file, optionally convert it, put it in the store and
 * clean up the staging directory.
 *
 * @param {object}   opts
 * @param {object}   opts.file      - multer file: { path, destination, originalname, size, mimetype }
 * @param {string}   opts.fundId
 * @param {object}   opts.storage   - a storage service (see services/storage.js)
 * @param {Function} [opts.convert] - (inputPath, outDir) => pdfPath | null
 * @param {Function} [opts.keyFor]  - override key generation, for tests
 * @returns {Promise<{key, fileName, size, mimeType, converted, originalFormat}>}
 */
export async function storeUpload({ file, fundId, storage, convert = convertWordToPdf, keyFor = buildStorageKey }) {
  const stagingDir = file.destination || path.dirname(file.path);

  let sourcePath = file.path;
  let fileName = file.originalname;
  let mimeType = file.mimetype;
  let converted = false;

  const originalFormat = path.extname(file.originalname).toLowerCase();
  let body = null;

  try {
    if (CONVERTIBLE_EXTENSIONS.includes(originalFormat)) {
      try {
        const pdfPath = convert(sourcePath, stagingDir);
        if (pdfPath) {
          sourcePath = pdfPath;
          fileName = file.originalname.replace(/\.(doc|docx)$/i, '.pdf');
          mimeType = 'application/pdf';
          converted = true;
          console.log(`[documents] Converted ${file.originalname} to PDF`);
        }
      } catch (convErr) {
        // Fall through — store the original Word file, as before.
        console.warn('[documents] PDF conversion failed, keeping original:', convErr.message);
      }
    }

    const size = fs.statSync(sourcePath).size;
    const key = keyFor({ fundId, fileName });

    // Streamed, not buffered, and byte-for-byte: no encryption, no base64,
    // no re-encoding on the way to the store.
    body = fs.createReadStream(sourcePath);

    // If the put rejects, this stream is still pending against a file that the
    // cleanup below is about to remove. Without a listener its late 'error'
    // would surface as an uncaught exception and take the process down.
    body.on('error', (err) => console.warn('[documents] Upload stream error:', err.message));

    await storage.put(key, { body, contentType: mimeType, contentLength: size });

    return { key, fileName, size, mimeType, converted, originalFormat };
  } finally {
    if (body) body.destroy();
    cleanupStaging(stagingDir);
  }
}

/** Remove a staging directory, refusing anything outside the staging root. */
export function cleanupStaging(dir) {
  if (!dir) return;
  const resolved = path.resolve(dir);
  if (!resolved.startsWith(path.resolve(STAGING_ROOT) + path.sep)) return;
  try {
    fs.rmSync(resolved, { recursive: true, force: true });
  } catch (err) {
    console.warn('[documents] Failed to clean up staging directory:', err.message);
  }
}

/**
 * Sanitise a filename for a `Content-Disposition` header. `res.download()` used
 * to do this for us; now that we pipe the body ourselves it has to be explicit,
 * or a quote in a filename truncates the header.
 */
export function contentDispositionFilename(name) {
  return String(name || 'document').replace(/[\r\n"\\]/g, '_');
}
