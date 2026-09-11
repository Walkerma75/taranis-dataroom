#!/usr/bin/env node
/**
 * Restore the investor-side fund documents from a manifest (HANDOVER-CW012 §3.2).
 *
 *   npm run import:fund-docs -- --list
 *   npm run import:fund-docs -- --manifest ../manifest.json --dry-run
 *   npm run import:fund-docs -- --manifest ../manifest.json
 *
 * Runs on the workstation that holds the files, against the live API over
 * HTTPS. It uploads through the ordinary `POST /documents` route, one file at a
 * time, so the S3 key scheme, the storage service and the `document.uploaded`
 * audit entry are the shipping ones. See `services/fund-doc-import.js` for why
 * this is a client rather than a new bulk-import endpoint, and why idempotence
 * is a skip rather than an upsert.
 *
 * Nothing is uploaded until the whole manifest resolves. A row naming a fund or
 * a category that does not exist stops the run before the first request, so a
 * half-right manifest is fixed rather than part-run.
 *
 * Credentials are never read from a file and never written anywhere. The
 * password and the TOTP code are prompted for, or taken from the environment
 * for an unattended run, and only the resulting tokens are held, in memory.
 */
import fs from 'fs';
import path from 'path';
import readline from 'readline';

import {
  assertValidManifest, planImport, describeImportPlan, summariseByFund,
  ManifestError, DOCUMENT_CATEGORIES, MAX_FILE_BYTES,
} from '../packages/api/src/services/fund-doc-import.js';

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------
function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? fallback : process.argv[i + 1];
}
const has = (flag) => process.argv.includes(flag);

const API = (arg('--api', process.env.TARANIS_API || 'https://dataroom.taraniscapital.com/api'))
  .replace(/\/+$/, '');
const DRY_RUN = has('--dry-run');
const LIST_ONLY = has('--list');
const MANIFEST = arg('--manifest');
const ROOT = arg('--root');

function usage(message) {
  if (message) console.error(`\n${message}\n`);
  console.error(`Usage:
  --list                    print the fund slugs and category names to use in a manifest
  --manifest <path>         the manifest to import
  --root <dir>              resolve manifest paths against this directory
                            (default: the manifest's own directory)
  --api <url>               API base URL (default ${API})
  --dry-run                 resolve and report, upload nothing

Credentials, prompted for if not set:
  TARANIS_EMAIL  TARANIS_PASSWORD  TARANIS_TOTP
`);
  process.exit(message ? 1 : 0);
}

// ---------------------------------------------------------------------------
// A small authenticated client
// ---------------------------------------------------------------------------
function prompt(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden && process.stdin.isTTY) {
      // Suppress the echo for the password. `_writeToOutput` is the documented
      // seam for this in readline and needs no dependency.
      rl._writeToOutput = (s) => { if (!s.includes(question)) return; rl.output.write(question); };
    }
    rl.question(question, (answer) => {
      if (hidden) rl.output.write('\n');
      rl.close();
      resolve(answer.trim());
    });
  });
}

class ApiClient {
  constructor(base) {
    this.base = base;
    this.accessToken = null;
    this.refreshToken = null;
    this.refreshes = 0;
  }

  async signIn() {
    const email = process.env.TARANIS_EMAIL || await prompt('Email: ');
    const password = process.env.TARANIS_PASSWORD || await prompt('Password: ', { hidden: true });

    let body = await this.post('/auth/login', { email, password });
    if (body.mfaRequired) {
      const totpCode = process.env.TARANIS_TOTP || await prompt('Authenticator code: ');
      body = await this.post('/auth/login', { email, password, totpCode });
    }
    if (!body.accessToken) throw new Error(body.error || 'Sign-in failed');
    if (body.mfaEnrolmentRequired) throw new Error('This account must complete MFA enrolment first');
    if (body.user?.role !== 'admin') {
      throw new Error(`This import needs an administrator; ${email} is "${body.user?.role}"`);
    }

    this.accessToken = body.accessToken;
    this.refreshToken = body.refreshToken;
    return body.user;
  }

  /**
   * Renew the access token. Called only on a 401: `/auth/*` is rate limited to
   * 20 requests per 15 minutes in production, so refreshing on a timer would
   * lock the run out of the very endpoint it needs.
   */
  async renew() {
    if (!this.refreshToken) return false;
    const res = await fetch(`${this.base}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: this.refreshToken }),
    });
    if (!res.ok) return false;
    const body = await res.json();
    this.accessToken = body.accessToken;
    this.refreshToken = body.refreshToken;
    this.refreshes++;
    return true;
  }

  async post(pathname, json) {
    const res = await fetch(`${this.base}${pathname}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(json),
    });
    return res.json();
  }

  async send(pathname, { method = 'GET', body, retry = true } = {}) {
    const res = await fetch(`${this.base}${pathname}`, {
      method,
      headers: { Authorization: `Bearer ${this.accessToken}` },
      ...(body ? { body } : {}),
    });

    if (res.status === 401 && retry && await this.renew()) {
      return this.send(pathname, { method, body, retry: false });
    }

    let payload = null;
    try { payload = await res.json(); } catch { /* no body */ }
    if (!res.ok) {
      throw new Error(payload?.error || `${method} ${pathname} failed with ${res.status}`);
    }
    return payload;
  }

  get(pathname) {
    return this.send(pathname);
  }
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------
async function main() {
  if (has('--help') || has('-h')) usage();
  if (!LIST_ONLY && !MANIFEST) usage('A --manifest is required (or --list).');

  const api = new ApiClient(API);
  console.log(`[import] API ${API}`);
  const user = await api.signIn();
  console.log(`[import] Signed in as ${user.displayName} (${user.email})`);

  const funds = await api.get('/funds');
  const categories = await api.get('/funds/categories');

  if (LIST_ONLY) {
    console.log('\nFund slugs (use these as "fund" in the manifest):');
    for (const f of funds) console.log(`  ${f.slug.padEnd(20)} ${f.name}  [${f.docCount} active document(s)]`);
    console.log('\nCategory names (use these verbatim as "category"):');
    for (const c of categories) console.log(`  ${c.name}`);
    const unexpected = categories
      .map((c) => c.name)
      .filter((n) => !DOCUMENT_CATEGORIES.includes(n));
    if (unexpected.length) {
      console.warn(`\n[import] WARNING: the API reports categories this build does not know: ${unexpected.join(', ')}`);
    }
    return;
  }

  const manifestPath = path.resolve(MANIFEST);
  const root = ROOT ? path.resolve(ROOT) : path.dirname(manifestPath);
  const manifest = assertValidManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf8')));
  console.log(`[import] Manifest ${manifestPath}: ${manifest.files.length} row(s)`);
  console.log(`[import] Files resolved against ${root}`);

  // Everything already on the platform, so a re-run uploads nothing. Read per
  // fund because that is how the endpoint filters.
  const existing = [];
  for (const fund of funds) {
    existing.push(...await api.get(`/documents?fundId=${encodeURIComponent(fund.id)}`));
  }

  const plan = planImport({ manifest, funds, categories, existing });

  // Local checks the API would otherwise fail on one request at a time.
  for (const entry of plan.upload) {
    const file = path.resolve(root, entry.path);
    if (!file.startsWith(root + path.sep)) plan.errors.push(`${entry.title}: path escapes --root`);
    else if (!fs.existsSync(file)) plan.errors.push(`${entry.title}: no such file, ${entry.path}`);
    else if (fs.statSync(file).size > MAX_FILE_BYTES) {
      plan.errors.push(`${entry.title}: larger than the ${MAX_FILE_BYTES / 1024 / 1024} MB upload limit`);
    }
  }

  console.log(`\n[import] ${describeImportPlan(plan)}`);
  for (const [fund, n] of summariseByFund(plan.upload)) console.log(`  ${fund}: ${n} to upload`);

  if (plan.errors.length) {
    console.error('\n[import] Nothing was uploaded. Fix the manifest and run again.');
    process.exit(1);
  }
  if (DRY_RUN) {
    console.log('\n[import] Dry run. Nothing was uploaded.');
    return;
  }
  if (plan.upload.length === 0) {
    console.log('\n[import] Everything in the manifest is already present. Nothing to do.');
    return;
  }

  let uploaded = 0;
  const failed = [];
  for (const [i, entry] of plan.upload.entries()) {
    const file = path.resolve(root, entry.path);
    const position = `${String(i + 1).padStart(3)}/${plan.upload.length}`;
    try {
      const form = new FormData();
      form.append('fundId', entry.fundId);
      form.append('categoryId', entry.categoryId);
      form.append('title', entry.title);
      if (entry.description) form.append('description', entry.description);
      form.append('file', new Blob([fs.readFileSync(file)]), path.basename(entry.path));

      await api.send('/documents', { method: 'POST', body: form });
      uploaded++;
      console.log(`[import] ${position} uploaded  ${entry.fundName} / ${entry.category} / ${entry.title}`);
    } catch (err) {
      failed.push({ title: entry.title, error: err.message });
      console.error(`[import] ${position} FAILED    ${entry.title}: ${err.message}`);
    }
  }

  console.log(`\n[import] ${uploaded} uploaded, ${plan.skip.length} already present, ${failed.length} failed.`);
  if (failed.length) {
    // A partial run is safe to repeat: what succeeded is now "already present".
    console.error('[import] Re-run the same manifest to retry only what failed.');
    process.exit(1);
  }
}

main().catch((err) => {
  if (err instanceof ManifestError) console.error(`[import] ${err.message}`);
  else console.error(`[import] ${err.message}`);
  process.exit(1);
});
