/**
 * The fund document manifest and its import plan (HANDOVER-CW012 §3.2).
 *
 * The importer itself is a client that posts to `POST /documents`, which is
 * already covered. What is worth testing is everything that decides whether a
 * byte is sent at all: the manifest rules, the fund and category resolution,
 * and the skip that makes a re-run a no-op.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  DOCUMENT_CATEGORIES, IMPORTABLE_EXTENSIONS, ManifestError,
  validateManifest, assertValidManifest, documentKey, planImport,
  describeImportPlan, summariseByFund,
} from '../src/services/fund-doc-import.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '../../..');

const FUNDS = [
  { id: 'fund-bio', slug: 'biotech-ksa', name: 'Biotech KSA' },
  { id: 'fund-dc', slug: 'datacentre-ksa', name: 'Datacentre KSA' },
];
const CATEGORIES = [
  { id: 'cat-ppm', name: 'Private Placement Memorandum' },
  { id: 'cat-fin', name: 'Financials' },
];

const row = (over = {}) => ({
  path: 'BioTech_KSA_PPM_S01_Executive_Summary.pdf',
  fund: 'biotech-ksa',
  category: 'Private Placement Memorandum',
  title: 'PPM Section 1: Executive Summary',
  ...over,
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

test('a well-formed manifest validates', () => {
  assert.deepEqual(validateManifest({ files: [row()] }), []);
});

test('every required field is required', () => {
  for (const field of ['path', 'fund', 'category', 'title']) {
    const problems = validateManifest({ files: [row({ [field]: '' })] });
    assert.ok(
      problems.some((p) => p.includes(`"${field}" is required`)),
      `a missing ${field} must be reported`
    );
  }
});

test('a path may not be absolute or climb out of the root', () => {
  assert.ok(validateManifest({ files: [row({ path: '/etc/passwd' })] })
    .some((p) => p.includes('must be relative')));
  assert.ok(validateManifest({ files: [row({ path: '../../secrets/x.pdf' })] })
    .some((p) => p.includes('must not contain')));
  assert.ok(validateManifest({ files: [row({ path: 'a\\..\\..\\x.pdf' })] })
    .some((p) => p.includes('must not contain')));
});

test('only file types the upload route accepts are allowed', () => {
  assert.ok(validateManifest({ files: [row({ path: 'notes.txt' })] })
    .some((p) => p.includes('not an accepted file type')));
  for (const ext of IMPORTABLE_EXTENSIONS) {
    assert.deepEqual(validateManifest({ files: [row({ path: `doc${ext}` })] }), [],
      `${ext} must be accepted`);
  }
});

test('a category outside the seven is refused, and the message lists them', () => {
  const problems = validateManifest({ files: [row({ category: 'LPA' })] });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /"LPA" is not one of the seven categories/);
  for (const name of DOCUMENT_CATEGORIES) assert.ok(problems[0].includes(name));
});

test('two rows that would land as the same document are refused', () => {
  const problems = validateManifest({
    files: [row(), row({ path: 'other.pdf', title: 'PPM Section 1:  Executive   Summary' })],
  });
  assert.ok(problems.some((p) => /same fund, category and title as row 1/.test(p)));
});

test('a manifest with no files array is rejected outright', () => {
  assert.deepEqual(validateManifest({}), ['the manifest has no "files" array']);
  assert.deepEqual(validateManifest(null), ['the manifest is not an object']);
});

test('assertValidManifest throws a ManifestError carrying every problem', () => {
  assert.throws(
    () => assertValidManifest({ files: [row({ fund: '' }), row({ category: 'Nope', path: 'b.pdf' })] }),
    (err) => err instanceof ManifestError && err.problems.length >= 2
  );
});

test('the committed example manifest is valid', () => {
  const example = JSON.parse(fs.readFileSync(
    path.join(REPO_ROOT, 'tools/fund-documents-manifest.example.json'), 'utf8'
  ));
  assert.deepEqual(validateManifest(example), []);
});

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

test('documentKey ignores case and collapses whitespace', () => {
  assert.equal(
    documentKey({ fund: 'Biotech-KSA', category: 'Financials', title: 'Model  v3 ' }),
    documentKey({ fund: 'biotech-ksa', category: 'financials', title: 'Model v3' })
  );
});

test('documentKey reads the shape GET /documents returns as well as a manifest row', () => {
  assert.equal(
    documentKey({ fund: 'biotech-ksa', category: 'Financials', title: 'Model v3' }),
    documentKey({ fundSlug: 'biotech-ksa', categoryName: 'Financials', title: 'Model v3' })
  );
});

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

test('planImport resolves funds and categories to ids', () => {
  const plan = planImport({ manifest: { files: [row()] }, funds: FUNDS, categories: CATEGORIES });
  assert.equal(plan.upload.length, 1);
  assert.equal(plan.upload[0].fundId, 'fund-bio');
  assert.equal(plan.upload[0].categoryId, 'cat-ppm');
  assert.equal(plan.upload[0].fundName, 'Biotech KSA');
  assert.deepEqual(plan.errors, []);
});

test('an unknown fund slug is an error that names the ones that exist', () => {
  const plan = planImport({
    manifest: { files: [row({ fund: 'biotech' })] }, funds: FUNDS, categories: CATEGORIES,
  });
  assert.equal(plan.upload.length, 0);
  assert.equal(plan.errors.length, 1);
  assert.match(plan.errors[0], /no fund with slug "biotech"/);
  assert.match(plan.errors[0], /biotech-ksa, datacentre-ksa/);
});

test('a category the platform does not hold is an error, even if the seven allow it', () => {
  const plan = planImport({
    manifest: { files: [row({ category: 'Technical' })] },
    funds: FUNDS,
    categories: CATEGORIES,
  });
  assert.equal(plan.errors.length, 1);
  assert.match(plan.errors[0], /no category named "Technical"/);
});

test('a document already on the platform is skipped, not uploaded again', () => {
  const existing = [{
    fundSlug: 'biotech-ksa',
    categoryName: 'Private Placement Memorandum',
    title: 'PPM Section 1: Executive Summary',
  }];
  const plan = planImport({ manifest: { files: [row()] }, funds: FUNDS, categories: CATEGORIES, existing });
  assert.equal(plan.upload.length, 0);
  assert.equal(plan.skip.length, 1);
});

test('re-running the same manifest after a successful import uploads nothing', () => {
  const manifest = {
    files: [row(), row({ path: 'model.xlsx', category: 'Financials', title: 'Model v3' })],
  };
  const first = planImport({ manifest, funds: FUNDS, categories: CATEGORIES, existing: [] });
  assert.equal(first.upload.length, 2);

  // What the platform holds after that run.
  const existing = first.upload.map((e) => ({
    fundSlug: e.fund, categoryName: e.category, title: e.title,
  }));
  const second = planImport({ manifest, funds: FUNDS, categories: CATEGORIES, existing });
  assert.equal(second.upload.length, 0);
  assert.equal(second.skip.length, 2);
});

test('a partial run is safe to repeat: only what failed is planned again', () => {
  const manifest = {
    files: [row(), row({ path: 'model.xlsx', category: 'Financials', title: 'Model v3' })],
  };
  // The first row uploaded, the second failed.
  const existing = [{
    fundSlug: 'biotech-ksa',
    categoryName: 'Private Placement Memorandum',
    title: 'PPM Section 1: Executive Summary',
  }];
  const plan = planImport({ manifest, funds: FUNDS, categories: CATEGORIES, existing });
  assert.deepEqual(plan.upload.map((e) => e.title), ['Model v3']);
  assert.equal(plan.skip.length, 1);
});

test('titles are trimmed on the way to the upload', () => {
  const plan = planImport({
    manifest: { files: [row({ title: '  Padded Title  ' })] },
    funds: FUNDS, categories: CATEGORIES,
  });
  assert.equal(plan.upload[0].title, 'Padded Title');
});

test('describeImportPlan and summariseByFund report what an operator needs', () => {
  const plan = planImport({
    manifest: {
      files: [row(), row({ path: 'model.xlsx', category: 'Financials', title: 'Model v3' })],
    },
    funds: FUNDS, categories: CATEGORIES,
  });
  assert.match(describeImportPlan(plan), /2 to upload, 0 already present, 0 error/);
  assert.deepEqual(summariseByFund(plan.upload), [['Biotech KSA', 2]]);

  const broken = planImport({
    manifest: { files: [row({ fund: 'nope' })] }, funds: FUNDS, categories: CATEGORIES,
  });
  assert.match(describeImportPlan(broken), /Errors:/);
});
