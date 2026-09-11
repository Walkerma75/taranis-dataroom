/**
 * Shared documents: Taranis publishing into one company's workspace.
 *
 * The isolation half of this feature lives in company-isolation.test.js, which
 * is where the cross-company and role questions are answered. This file covers
 * the behaviour those tests assume: keys that cannot collide with the inbound
 * path, bytes that arrive byte-for-byte, a withdrawal that is soft, and a
 * download decision that comes from the same rule as every other download.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import companyPortalRoutes from '../src/routes/company-portal.js';
import companyRoutes from '../src/routes/companies.js';

import {
  buildSharedFileKey,
  storeSharedFile,
  companySharedView,
  adminSharedView,
} from '../src/services/company-shared.js';
import { buildCompanyFileKey } from '../src/services/companies.js';
import { buildStorageKey } from '../src/services/document-files.js';
import { MemoryStorage, setStorage, resetStorage } from '../src/services/storage.js';
import { setScanner, resetScanner, StubScanner } from '../src/services/scanner.js';

import {
  fakePool,
  membershipRow,
  membershipHandler,
  tokenFor,
  startTestServer,
} from './helpers/test-app.js';

const COMPANY_A = '11111111-1111-4111-8111-111111111111';
const SHARED_1 = 'dddddddd-1111-4111-8111-dddddddddddd';

const MOUNTS = [
  ['/company', companyPortalRoutes],
  ['/companies', companyRoutes],
];

const adminToken = () => tokenFor({ role: 'admin', sub: 'admin-1', name: 'A Reviewer' });
const companyToken = (companyRole) => tokenFor({ role: 'company', companyId: COMPANY_A, companyRole });

/** A minimal staged multer file, written into a real temp directory. */
async function stagedFile(name, bytes) {
  const fs = await import('fs');
  const path = await import('path');
  const { STAGING_ROOT } = await import('../src/services/storage.js');
  fs.mkdirSync(STAGING_ROOT, { recursive: true });
  const dir = fs.mkdtempSync(path.join(STAGING_ROOT, 'shared-test-'));
  const full = path.join(dir, name);
  fs.writeFileSync(full, bytes);
  return {
    path: full,
    destination: dir,
    originalname: name,
    mimetype: 'application/pdf',
    size: bytes.length,
  };
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

test('a shared document key cannot collide with a company upload or a fund document', async () => {
  const shared = buildSharedFileKey({
    companyId: COMPANY_A, sharedFileId: SHARED_1, filename: 'PRE-FILLED.xlsx',
  });
  const upload = buildCompanyFileKey({
    companyId: COMPANY_A, irlItemId: 'item-1', fileId: SHARED_1, filename: 'PRE-FILLED.xlsx',
  });
  const document = buildStorageKey({ fundId: 'fund-1', fileName: 'PRE-FILLED.xlsx' });

  assert.equal(shared, `taranis-shared/${COMPANY_A}/${SHARED_1}/PRE-FILLED.xlsx`);
  assert.ok(shared.startsWith('taranis-shared/'));
  assert.ok(upload.startsWith('companies/'));
  assert.ok(document.startsWith('documents/'));

  // Three disjoint prefixes: no key from one namespace is reachable as a key in
  // another, whichever direction you come at it from.
  for (const [a, b] of [[shared, upload], [shared, document], [upload, document]]) {
    assert.notEqual(a, b);
    assert.equal(a.startsWith(b.split('/')[0] + '/'), false);
  }
});

test('a shared document key sanitises a filename that would escape it', async () => {
  const key = buildSharedFileKey({
    companyId: COMPANY_A,
    sharedFileId: SHARED_1,
    filename: '../../etc/passwd\r\n',
  });
  assert.equal(key.includes('..'), true, 'dots are harmless, slashes are not');
  assert.equal(key.split('/').length, 4, 'no extra path segments may be introduced');
  assert.equal(/[\r\n]/.test(key), false);
});

// ---------------------------------------------------------------------------
// Storing
// ---------------------------------------------------------------------------

test('a published document reaches the store byte-for-byte and carries the scan verdict', async (t) => {
  const store = new MemoryStorage();
  // A high byte and a NUL in the payload, so "byte-for-byte" is asserted
  // against something that would not survive being treated as text.
  const bytes = Buffer.concat([
    Buffer.from('%PDF-1.4 pre-filled pack'),
    Buffer.from([0x00, 0xff, 0x0a]),
    Buffer.from('%%EOF'),
  ]);
  const file = await stagedFile('PRE-FILLED.pdf', bytes);
  t.after(() => resetStorage());

  const result = await storeSharedFile({
    file,
    companyId: COMPANY_A,
    sharedFileId: SHARED_1,
    storage: store,
    scanner: new StubScanner({ warnOnUse: false }),
  });

  assert.equal(result.stored, true);
  assert.deepEqual(store.bytes(result.key), bytes);
  assert.equal(result.size, bytes.length);
  // The stub never says 'clean', and what it did say is recorded rather than
  // assumed, so a document that was never inspected is identifiable later.
  assert.equal(result.verdict.state, 'pending');
  assert.equal(result.verdict.backend, 'stub');

  // The staging directory is gone.
  const fs = await import('fs');
  assert.equal(fs.existsSync(file.destination), false);
});

test('an infected document is refused and never reaches the bucket', async () => {
  const store = new MemoryStorage();
  const file = await stagedFile('bad.pdf', Buffer.from('X5O!P%@AP'));

  const result = await storeSharedFile({
    file,
    companyId: COMPANY_A,
    sharedFileId: SHARED_1,
    storage: store,
    scanner: {
      kind: 'test',
      async scan() { return { state: 'infected', backend: 'test', detail: 'eicar' }; },
    },
  });

  assert.equal(result.stored, false);
  assert.equal(result.key, null);
  // Stricter than the company-upload path on purpose: there is no quarantined
  // shared document, because there is no reason to keep one.
  assert.equal(store.objects.size, 0);
});

// ---------------------------------------------------------------------------
// Response shaping
// ---------------------------------------------------------------------------

test('the company view of a shared document carries no storage key and no withdrawal record', async () => {
  const row = {
    id: SHARED_1, title: 'Information request pack', description: 'What we already hold',
    filename: 'PRE-FILLED.xlsx', size_bytes: '2048', content_type: 'application/xlsx',
    published_at: new Date('2026-08-06T09:00:00Z'), published_by_name: 'A Reviewer',
    s3_key: 'taranis-shared/x/y/PRE-FILLED.xlsx',
    withdrawn_at: null, withdrawn_by: 'admin-1', withdrawn_reason: 'internal reason',
    scan_state: 'pending', scan_backend: 'stub',
  };

  const view = companySharedView(row);
  const raw = JSON.stringify(view);

  assert.equal(view.title, 'Information request pack');
  // Who sent it and when, which is the point: a published pack should be as
  // attributable as an email would have been.
  assert.equal(view.publishedBy, 'A Reviewer');
  assert.ok(view.publishedAt);
  assert.equal(view.sizeBytes, 2048);

  assert.equal(raw.includes('taranis-shared/'), false);
  assert.equal(raw.includes('internal reason'), false);
  assert.equal('s3_key' in view, false);
  assert.equal('withdrawnReason' in view, false);
  assert.equal('scanState' in view, false);

  // The Taranis view keeps all of it.
  const admin = adminSharedView(row);
  assert.equal(admin.withdrawnReason, 'internal reason');
  assert.equal(admin.scanState, 'pending');
  assert.equal(admin.scanBackend, 'stub');
});

// ---------------------------------------------------------------------------
// Publishing, through the router
// ---------------------------------------------------------------------------

/** Build the multipart body the publish route expects. */
function publishForm({ title, description, filename = 'PRE-FILLED.xlsx', bytes = 'pack bytes' }) {
  const form = new FormData();
  if (title !== undefined) form.append('title', title);
  if (description !== undefined) form.append('description', description);
  form.append('file', new Blob([bytes]), filename);
  return form;
}

async function publish(server, form, token = adminToken()) {
  const res = await fetch(`${server.base}/companies/${COMPANY_A}/shared-files`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  let body = null;
  try { body = await res.json(); } catch { /* empty */ }
  return { status: res.status, body };
}

function activeCompany() {
  return ['SELECT id, legal_name, status FROM companies', [{
    id: COMPANY_A, legal_name: 'AdrenoMed AG', status: 'active',
  }]];
}

function insertedRow(overrides = {}) {
  return ['INSERT INTO company_shared_files', (params) => [{
    id: params[0], company_id: params[1], title: params[2], description: params[3],
    filename: params[4], s3_key: params[5], size_bytes: params[6], content_type: params[7],
    published_by: params[8], published_at: new Date('2026-08-06T09:00:00Z'),
    scan_state: params[9], scan_backend: params[10],
    withdrawn_at: null, withdrawn_by: null, withdrawn_reason: null,
    ...overrides,
  }]];
}

test('publishing stores the bytes, writes the row and audits it', async (t) => {
  const store = new MemoryStorage();
  setStorage(store);
  setScanner(new StubScanner({ warnOnUse: false }));
  t.after(() => { resetStorage(); resetScanner(); });

  const pool = fakePool([activeCompany(), insertedRow()]);
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  const res = await publish(server, publishForm({
    title: 'Information request pack',
    description: 'What Taranis already holds, for your review',
  }));

  assert.equal(res.status, 201);
  assert.equal(res.body.title, 'Information request pack');
  // No email in this phase, and the response says so rather than leaving an
  // admin to assume the company has been told.
  assert.match(res.body.message, /No email has been sent/);

  const insert = pool.calls.find((c) => c.text.includes('INSERT INTO company_shared_files'));
  assert.ok(insert, 'the row should have been written');
  assert.equal(insert.params[1], COMPANY_A);
  assert.equal(insert.params[9], 'pending');
  assert.equal(insert.params[10], 'stub');

  // The bytes are in the store under the shared prefix and nowhere else.
  const key = insert.params[5];
  assert.ok(key.startsWith(`taranis-shared/${COMPANY_A}/`));
  assert.equal(store.bytes(key).toString(), 'pack bytes');

  const audit = pool.calls.find((c) => c.text.includes('INSERT INTO audit_log'));
  assert.ok(audit, 'publication must be audited');
  assert.equal(audit.params[1], 'company_shared.published');
  assert.equal(audit.params[2], 'company_shared_file');
});

test('publishing without a title is refused, because the company sees the title', async (t) => {
  setStorage(new MemoryStorage());
  setScanner(new StubScanner({ warnOnUse: false }));
  t.after(() => { resetStorage(); resetScanner(); });

  const pool = fakePool([activeCompany()]);
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  for (const title of [undefined, '', '   ']) {
    const res = await publish(server, publishForm({ title }));
    assert.equal(res.status, 400);
    assert.match(res.body.error, /title is required/);
  }
  assert.equal(
    pool.calls.some((c) => c.text.includes('INSERT INTO company_shared_files')), false
  );
});

test('an infected document is refused at publication with nothing written', async (t) => {
  const store = new MemoryStorage();
  setStorage(store);
  setScanner({
    kind: 'test',
    describe: () => 'test',
    async scan() { return { state: 'infected', backend: 'test', detail: 'eicar' }; },
  });
  t.after(() => { resetStorage(); resetScanner(); });

  const pool = fakePool([activeCompany()]);
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  const res = await publish(server, publishForm({ title: 'Suspicious pack' }));

  assert.equal(res.status, 422);
  assert.match(res.body.error, /did not pass the security scan/);
  assert.equal(store.objects.size, 0);
  assert.equal(
    pool.calls.some((c) => c.text.includes('INSERT INTO company_shared_files')), false
  );

  // The refusal is still on the record: a rejected publication is a thing that
  // happened, and the log is where it is answerable from.
  const audit = pool.calls.find((c) => c.text.includes('INSERT INTO audit_log'));
  assert.equal(audit.params[1], 'company_shared.published');
  assert.match(audit.params[4], /"rejected":true/);
});

test('nothing can be published to an offboarded company', async (t) => {
  setStorage(new MemoryStorage());
  setScanner(new StubScanner({ warnOnUse: false }));
  t.after(() => { resetStorage(); resetScanner(); });

  const pool = fakePool([
    ['SELECT id, legal_name, status FROM companies', [{
      id: COMPANY_A, legal_name: 'AdrenoMed AG', status: 'offboarded',
    }]],
  ]);
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  const res = await publish(server, publishForm({ title: 'Too late' }));
  assert.equal(res.status, 409);
  assert.match(res.body.error, /offboarded/);
});

// ---------------------------------------------------------------------------
// Withdrawal is soft
// ---------------------------------------------------------------------------

test('withdrawing marks the row, never deletes it, and names who did it', async (t) => {
  const pool = fakePool([
    ['UPDATE company_shared_files', (params) => [{
      id: params[0], company_id: params[1], title: 'Information request pack',
      filename: 'PRE-FILLED.xlsx', size_bytes: '2048', content_type: 'application/xlsx',
      published_at: new Date('2026-08-06T09:00:00Z'),
      withdrawn_at: new Date('2026-08-07T09:00:00Z'), withdrawn_by: params[2],
      withdrawn_reason: params[3], scan_state: 'pending',
    }]],
  ]);
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  const res = await server.request(
    `/companies/${COMPANY_A}/shared-files/${SHARED_1}/withdraw`,
    { method: 'POST', token: adminToken(), body: { reason: 'Superseded by version 2' } }
  );

  assert.equal(res.status, 200);
  assert.equal(res.body.withdrawnReason, 'Superseded by version 2');
  assert.match(res.body.message, /record of the publication/);

  const sql = pool.sql().join('\n');
  // The whole point: an UPDATE, and no DELETE anywhere near this table.
  assert.match(sql, /UPDATE company_shared_files/);
  assert.equal(/DELETE FROM company_shared_files/.test(sql), false);

  const update = pool.calls.find((c) => c.text.includes('UPDATE company_shared_files'));
  assert.match(update.text, /withdrawn_by = \$3/);
  assert.equal(update.params[2], 'admin-1');
  // Scoped by company as well as by id, so a shared id from another company
  // cannot be withdrawn through this company's route.
  assert.match(update.text, /id = \$1 AND company_id = \$2/);

  const audit = pool.calls.find((c) => c.text.includes('INSERT INTO audit_log'));
  assert.equal(audit.params[1], 'company_shared.withdrawn');
});

test('withdrawing something already withdrawn is a 404, not a second withdrawal', async (t) => {
  // The UPDATE carries `AND withdrawn_at IS NULL`, so the second attempt
  // matches nothing rather than overwriting the first withdrawal's actor and
  // timestamp with a later one.
  const pool = fakePool([['UPDATE company_shared_files', []]]);
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  const res = await server.request(
    `/companies/${COMPANY_A}/shared-files/${SHARED_1}/withdraw`,
    { method: 'POST', token: adminToken(), body: {} }
  );
  assert.equal(res.status, 404);
  assert.match(res.body.error, /already been withdrawn/);

  const update = pool.calls.find((c) => c.text.includes('UPDATE company_shared_files'));
  assert.match(update.text, /withdrawn_at IS NULL/);
});

test('Taranis can still download a withdrawn document, so "what did they get" stays answerable', async (t) => {
  const store = new MemoryStorage();
  await store.put('taranis-shared/a/b/PRE-FILLED.xlsx', { body: Buffer.from('pack bytes') });
  setStorage(store);
  setScanner(new StubScanner({ warnOnUse: false }));
  t.after(() => { resetStorage(); resetScanner(); });

  const pool = fakePool([
    ['SELECT * FROM company_shared_files WHERE id = $1 AND company_id = $2', [{
      id: SHARED_1, company_id: COMPANY_A, title: 'Information request pack',
      filename: 'PRE-FILLED.xlsx', content_type: 'application/xlsx',
      s3_key: 'taranis-shared/a/b/PRE-FILLED.xlsx', scan_state: 'pending',
      withdrawn_at: new Date('2026-08-07T09:00:00Z'),
    }]],
  ]);
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  const res = await fetch(
    `${server.base}/companies/${COMPANY_A}/shared-files/${SHARED_1}/download`,
    { headers: { Authorization: `Bearer ${adminToken()}` } }
  );

  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'pack bytes');

  const audit = pool.calls.find((c) => c.text.includes('INSERT INTO audit_log'));
  assert.equal(audit.params[1], 'company_shared.downloaded');
  assert.match(audit.params[4], /"by":"taranis"/);
  assert.match(audit.params[4], /"withdrawn":true/);
});

// ---------------------------------------------------------------------------
// The company side
// ---------------------------------------------------------------------------

test('a company downloads a published document, and the download is on the record', async (t) => {
  const store = new MemoryStorage();
  await store.put('taranis-shared/a/b/PRE-FILLED.xlsx', { body: Buffer.from('pack bytes') });
  setStorage(store);
  setScanner(new StubScanner({ warnOnUse: false }));
  t.after(() => { resetStorage(); resetScanner(); });

  const pool = fakePool([
    membershipHandler(membershipRow({ companyId: COMPANY_A, companyRole: 'company_viewer' })),
    ['SELECT * FROM company_shared_files', [{
      id: SHARED_1, company_id: COMPANY_A, title: 'Information request pack',
      filename: 'PRE-FILLED.xlsx', content_type: 'application/xlsx',
      s3_key: 'taranis-shared/a/b/PRE-FILLED.xlsx', scan_state: 'pending',
      withdrawn_at: null,
    }]],
  ]);
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  const res = await fetch(
    `${server.base}/company/shared-files/${SHARED_1}/download`,
    { headers: { Authorization: `Bearer ${companyToken('company_viewer')}` } }
  );

  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'pack bytes');
  assert.equal(
    res.headers.get('content-disposition'),
    'attachment; filename="PRE-FILLED.xlsx"'
  );

  const audit = pool.calls.find((c) => c.text.includes('INSERT INTO audit_log'));
  assert.ok(audit, 'a company download must be audited');
  assert.equal(audit.params[1], 'company_shared.downloaded');
  assert.match(audit.params[4], /"by":"company"/);
});

test('an infected shared document is never served, to either side', async (t) => {
  const store = new MemoryStorage();
  await store.put('taranis-shared/a/b/x.pdf', { body: Buffer.from('bytes') });
  setStorage(store);
  setScanner(new StubScanner({ warnOnUse: false }));
  t.after(() => { resetStorage(); resetScanner(); });

  const infected = {
    id: SHARED_1, company_id: COMPANY_A, title: 'Quarantined',
    filename: 'x.pdf', content_type: 'application/pdf',
    s3_key: 'taranis-shared/a/b/x.pdf', scan_state: 'infected', withdrawn_at: null,
  };

  const pool = fakePool([
    membershipHandler(membershipRow({ companyId: COMPANY_A })),
    ['FROM company_shared_files', [infected]],
  ]);
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  // Even under the stub, where everything unscanned is served, a verdict is a
  // verdict.
  const company = await server.request(`/company/shared-files/${SHARED_1}/download`, {
    token: companyToken('company_admin'),
  });
  assert.equal(company.status, 409);
  // The company is told it is unavailable and to contact us. It is not given a
  // description of our scanning posture.
  assert.equal(/scan|virus|infected/i.test(company.body.error), false);

  const taranis = await server.request(
    `/companies/${COMPANY_A}/shared-files/${SHARED_1}/download`,
    { token: adminToken() }
  );
  assert.equal(taranis.status, 409);
  assert.match(taranis.body.error, /quarantined/i);
});

test('with a real scanner configured, an uninspected shared document is held back', async (t) => {
  // Nothing about this rule is written twice: it is `downloadDecision`, the
  // same function the inbound path uses, so turning a real backend on tightens
  // both directions at once.
  const store = new MemoryStorage();
  await store.put('taranis-shared/a/b/x.pdf', { body: Buffer.from('bytes') });
  setStorage(store);
  setScanner({ kind: 'clamav', describe: () => 'clamav', async scan() { return { state: 'clean', backend: 'clamav' }; } });
  t.after(() => { resetStorage(); resetScanner(); });

  const pool = fakePool([
    membershipHandler(membershipRow({ companyId: COMPANY_A })),
    ['FROM company_shared_files', [{
      id: SHARED_1, company_id: COMPANY_A, title: 'Still scanning',
      filename: 'x.pdf', content_type: 'application/pdf',
      s3_key: 'taranis-shared/a/b/x.pdf', scan_state: 'pending', withdrawn_at: null,
    }]],
  ]);
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  const res = await server.request(`/company/shared-files/${SHARED_1}/download`, {
    token: companyToken('company_admin'),
  });
  assert.equal(res.status, 409);
});

test('the company list shows the title, the publisher and the date, and nothing else', async (t) => {
  const pool = fakePool([
    membershipHandler(membershipRow({ companyId: COMPANY_A })),
    ['FROM company_shared_files', [{
      id: SHARED_1, title: 'Information request pack',
      description: 'What Taranis already holds', filename: 'PRE-FILLED.xlsx',
      size_bytes: '2048', content_type: 'application/xlsx',
      published_at: new Date('2026-08-06T09:00:00Z'), published_by_name: 'A Reviewer',
    }]],
  ]);
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  const res = await server.request('/company/shared-files', { token: companyToken('company_admin') });

  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1);
  assert.deepEqual(Object.keys(res.body[0]).sort(), [
    'contentType', 'description', 'filename', 'id', 'publishedAt', 'publishedBy',
    'sizeBytes', 'title',
  ]);
  assert.equal(res.body[0].publishedBy, 'A Reviewer');
});
