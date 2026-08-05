/**
 * Upload staging tests — the path an uploaded document actually takes.
 *
 * Driven end to end against `MemoryStorage` with an injected converter, so no
 * S3, no LibreOffice and no database are involved.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

import { MemoryStorage, STAGING_ROOT, toBuffer } from '../src/services/storage.js';
import {
  ALLOWED_EXTENSIONS,
  CONVERTIBLE_EXTENSIONS,
  buildStorageKey,
  storeUpload,
  cleanupStaging,
  contentDispositionFilename,
} from '../src/services/document-files.js';

const FUND_ID = '11111111-2222-3333-4444-555555555555';

const TRICKY = Buffer.concat([
  Buffer.from([0x00, 0x0d, 0x0a, 0x1a, 0xff, 0xfe]),
  Buffer.from('%PDF-1.7 Taranis — £ test', 'utf8'),
  Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 7) % 256)),
]);

/** Stage a file the way multer's diskStorage does, and return a multer-shaped object. */
function stage(originalname, contents) {
  fs.mkdirSync(STAGING_ROOT, { recursive: true });
  const destination = fs.mkdtempSync(path.join(STAGING_ROOT, 'upload-'));
  const filename = `9999-1${path.extname(originalname)}`;
  const filePath = path.join(destination, filename);
  fs.writeFileSync(filePath, contents);

  return {
    destination,
    filename,
    path: filePath,
    originalname,
    size: contents.length,
    mimetype: 'application/octet-stream',
  };
}

// ---------------------------------------------------------------------------

test('buildStorageKey: namespaces by fund and keeps the extension', () => {
  const key = buildStorageKey({
    fundId: FUND_ID,
    fileName: 'Taranis Biotech PPM.PDF',
    now: 1700000000000,
    random: () => 0.5,
  });

  assert.equal(key, `documents/${FUND_ID}/1700000000000-500000.pdf`);
});

test('buildStorageKey: is unique across calls', () => {
  const keys = new Set(
    Array.from({ length: 200 }, () => buildStorageKey({ fundId: FUND_ID, fileName: 'a.pdf' }))
  );
  assert.equal(keys.size, 200);
});

test('the allowed and convertible extension lists are the ones the route relies on', () => {
  assert.deepEqual(ALLOWED_EXTENSIONS, [
    '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.png', '.jpg', '.jpeg',
  ]);
  assert.deepEqual(CONVERTIBLE_EXTENSIONS, ['.doc', '.docx']);
});

test('storeUpload: puts the bytes in the store byte-for-byte and clears staging', async () => {
  const storage = new MemoryStorage();
  const file = stage('Fund Overview.pdf', TRICKY);

  const result = await storeUpload({
    file,
    fundId: FUND_ID,
    storage,
    convert: () => assert.fail('a PDF must not be converted'),
  });

  assert.equal(result.converted, false);
  assert.equal(result.fileName, 'Fund Overview.pdf');
  assert.equal(result.size, TRICKY.length);
  assert.match(result.key, new RegExp(`^documents/${FUND_ID}/\\d+-\\d+\\.pdf$`));

  const stored = await toBuffer((await storage.get(result.key)).body);
  assert.ok(stored.equals(TRICKY), 'stored bytes must be identical to the uploaded bytes');

  assert.equal(fs.existsSync(file.destination), false, 'staging directory must be removed');
});

test('storeUpload: converts Word to PDF, stores the PDF and renames the document', async () => {
  const storage = new MemoryStorage();
  const file = stage('Subscription Agreement.docx', Buffer.from('a fake docx'));
  const pdfBytes = Buffer.from('%PDF-1.7 converted');

  const result = await storeUpload({
    file,
    fundId: FUND_ID,
    storage,
    convert: (inputPath, outDir) => {
      assert.equal(path.dirname(inputPath), file.destination);
      const pdfPath = path.join(outDir, `${path.basename(inputPath, path.extname(inputPath))}.pdf`);
      fs.writeFileSync(pdfPath, pdfBytes);
      return pdfPath;
    },
  });

  assert.equal(result.converted, true);
  assert.equal(result.originalFormat, '.docx');
  assert.equal(result.fileName, 'Subscription Agreement.pdf');
  assert.equal(result.mimeType, 'application/pdf');
  assert.equal(result.size, pdfBytes.length);
  assert.ok(result.key.endsWith('.pdf'));

  const stored = await toBuffer((await storage.get(result.key)).body);
  assert.ok(stored.equals(pdfBytes));
  assert.equal(fs.existsSync(file.destination), false);
});

test('storeUpload: keeps the original when conversion fails', async () => {
  const storage = new MemoryStorage();
  const original = Buffer.from('a fake doc that LibreOffice chokes on');
  const file = stage('Legacy Notice.doc', original);

  const result = await storeUpload({
    file,
    fundId: FUND_ID,
    storage,
    convert: () => { throw new Error('libreoffice: exit 1'); },
  });

  assert.equal(result.converted, false);
  assert.equal(result.fileName, 'Legacy Notice.doc');
  assert.equal(result.size, original.length);

  const stored = await toBuffer((await storage.get(result.key)).body);
  assert.ok(stored.equals(original));
  assert.equal(fs.existsSync(file.destination), false);
});

test('storeUpload: keeps the original when conversion produces nothing', async () => {
  const storage = new MemoryStorage();
  const file = stage('Empty.docx', Buffer.from('nothing to convert'));

  const result = await storeUpload({ file, fundId: FUND_ID, storage, convert: () => null });

  assert.equal(result.converted, false);
  assert.equal(result.fileName, 'Empty.docx');
});

test('storeUpload: clears staging even when the store rejects', async () => {
  const file = stage('Broken.pdf', TRICKY);
  const failing = {
    kind: 'memory',
    async put() { throw new Error('S3 unavailable'); },
  };

  await assert.rejects(() => storeUpload({ file, fundId: FUND_ID, storage: failing }), /S3 unavailable/);
  assert.equal(fs.existsSync(file.destination), false, 'a failed upload must not leak a temp directory');
});

test('cleanupStaging: refuses to remove anything outside the staging root', () => {
  const outside = fs.mkdtempSync(path.join(path.dirname(STAGING_ROOT), 'not-staging-'));
  try {
    cleanupStaging(outside);
    assert.equal(fs.existsSync(outside), true);
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('contentDispositionFilename: neutralises characters that would break the header', () => {
  assert.equal(contentDispositionFilename('Fund "PPM".pdf'), 'Fund _PPM_.pdf');
  assert.equal(contentDispositionFilename('line\r\nbreak.pdf'), 'line__break.pdf');
  assert.equal(contentDispositionFilename(null), 'document');
  assert.equal(contentDispositionFilename('Ordinary Name.pdf'), 'Ordinary Name.pdf');
});
