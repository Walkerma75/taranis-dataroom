/**
 * Standard DD forms (HANDOVER-CW027 / C027): published once, downloadable by
 * every company, optionally tied to the checklist items they answer.
 *
 * Covers: keys that cannot collide with the other three prefixes; admin-only
 * management; publish, replace (version chain and automatic withdrawal), edit
 * and withdraw; the company list and download scoped by one visibility clause;
 * item links filtered to what the company can see; the audit row that carries
 * the version; and the company side being strictly read-only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import companyPortalRoutes from '../src/routes/company-portal.js';
import ddFormsRoutes from '../src/routes/dd-forms.js';

import {
  buildFormKey,
  parseLinks,
  normaliseFundId,
  replacedReason,
  companyFormView,
  adminFormView,
  companyVisibleFormsClause,
  FormInputError,
} from '../src/services/dd-forms.js';
import { buildSharedFileKey } from '../src/services/company-shared.js';
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
const FUND_BIOTECH = 'aaaaaaaa-0000-4000-8000-00000000000a';
const FORM_1 = 'ffffffff-1111-4111-8111-ffffffffffff';
const FORM_2 = 'ffffffff-2222-4222-8222-ffffffffffff';
const ITEM_147 = '22222222-1470-4111-8111-222222222222';
const ITEM_HELD = '22222222-0880-4111-8111-222222222222';

const MOUNTS = [
  ['/company', companyPortalRoutes],
  ['/forms', ddFormsRoutes],
];

const adminToken = () => tokenFor({ role: 'admin', sub: 'admin-1', name: 'An Admin' });
const companyToken = (companyRole = 'company_admin') =>
  tokenFor({ role: 'company', companyId: COMPANY_A, companyRole });
const companyMembership = () =>
  membershipHandler(membershipRow({ companyId: COMPANY_A, fundId: FUND_BIOTECH }));

function scannerAndStore(t) {
  const store = new MemoryStorage();
  setStorage(store);
  setScanner(new StubScanner({ warnOnUse: false }));
  t.after(() => { resetStorage(); resetScanner(); });
  return store;
}

function multipart({ title, description, fundId, links, filename = 'Form.docx', bytes = 'form bytes' } = {}) {
  const form = new FormData();
  if (title !== undefined) form.append('title', title);
  if (description !== undefined) form.append('description', description);
  if (fundId !== undefined) form.append('fundId', fundId);
  if (links !== undefined) form.append('links', typeof links === 'string' ? links : JSON.stringify(links));
  form.append('file', new Blob([bytes]), filename);
  return form;
}

async function postForm(server, path, form, token = adminToken()) {
  const res = await fetch(`${server.base}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  let body = null;
  try { body = await res.json(); } catch { /* empty */ }
  return { status: res.status, body };
}

function formRow(overrides = {}) {
  return {
    id: FORM_1, title: 'Beneficial Owner Declaration', description: 'One per company',
    filename: 'BOD.docx', s3_key: `forms/${FORM_1}/BOD.docx`, size_bytes: 1234,
    content_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    fund_id: null, version: 1, supersedes: null,
    published_by: 'admin-1', published_at: new Date('2026-09-11T09:00:00Z'),
    withdrawn_at: null, withdrawn_by: null, withdrawn_reason: null,
    scan_state: 'pending', scan_backend: 'stub', scanned_at: new Date('2026-09-11T09:00:00Z'),
    published_by_name: 'An Admin', withdrawn_by_name: null, fund_name: null,
    ...overrides,
  };
}

/** The INSERT INTO dd_forms handler, echoing params back as the row. */
const insertedForm = () => ['INSERT INTO dd_forms', (params) => [formRow({
  id: params[0], title: params[1], description: params[2], filename: params[3],
  s3_key: params[4], size_bytes: params[5], content_type: params[6], fund_id: params[7],
  version: params[8], supersedes: params[9], published_by: params[10],
  scan_state: params[11], scan_backend: params[12],
})]];
const refExists = () => ['FROM irl_template_items i', [{ '?column?': 1 }]];
const fundExists = () => ['SELECT id FROM funds', [{ id: FUND_BIOTECH }]];

// ---------------------------------------------------------------------------
// Pure pieces
// ---------------------------------------------------------------------------

test('a form key lives under its own prefix, disjoint from the other three', () => {
  const form = buildFormKey({ formId: FORM_1, filename: 'BOD.docx' });
  const shared = buildSharedFileKey({ companyId: COMPANY_A, sharedFileId: FORM_1, filename: 'BOD.docx' });
  const upload = buildCompanyFileKey({ companyId: COMPANY_A, irlItemId: 'i', fileId: FORM_1, filename: 'BOD.docx' });
  const document = buildStorageKey({ fundId: 'f', fileName: 'BOD.docx' });

  assert.equal(form, `forms/${FORM_1}/BOD.docx`);
  for (const other of [shared, upload, document]) {
    assert.equal(other.startsWith('forms/'), false);
    assert.equal(form.startsWith(other.split('/')[0] + '/'), false);
  }
});

test('a form key sanitises a filename that would escape it', () => {
  const key = buildFormKey({ formId: FORM_1, filename: '../../etc/passwd\r\n' });
  assert.equal(key.split('/').length, 3);
  assert.equal(/[\r\n]/.test(key), false);
});

test('parseLinks accepts JSON or an array, de-duplicates, and refuses malformed input', () => {
  assert.deepEqual(parseLinks(undefined), []);
  assert.deepEqual(parseLinks(''), []);
  assert.deepEqual(
    parseLinks(JSON.stringify([{ fundId: FUND_BIOTECH, ref: '14.7' }, { fundId: FUND_BIOTECH, ref: '14.7' }])),
    [{ fundId: FUND_BIOTECH, ref: '14.7' }]
  );
  assert.deepEqual(parseLinks([{ fundId: FUND_BIOTECH, ref: ' 8.8 ' }]), [{ fundId: FUND_BIOTECH, ref: '8.8' }]);
  assert.throws(() => parseLinks('not json'), FormInputError);
  assert.throws(() => parseLinks('{"fundId":"x"}'), FormInputError);
  assert.throws(() => parseLinks([{ ref: '14.7' }]), FormInputError);
});

test('normaliseFundId treats blank and "all" as every company', () => {
  assert.equal(normaliseFundId(undefined), null);
  assert.equal(normaliseFundId(''), null);
  assert.equal(normaliseFundId('all'), null);
  assert.equal(normaliseFundId('ALL'), null);
  assert.equal(normaliseFundId(` ${FUND_BIOTECH} `), FUND_BIOTECH);
});

test('the company view carries no storage key, scan state or withdrawal record', () => {
  const view = companyFormView(formRow(), [{ id: ITEM_147, ref: '14.7' }]);
  assert.deepEqual(Object.keys(view).sort(), [
    'contentType', 'description', 'filename', 'id', 'items', 'publishedAt', 'sizeBytes', 'title', 'version',
  ]);
  assert.equal(view.version, 1);
  assert.deepEqual(view.items, [{ id: ITEM_147, ref: '14.7' }]);

  const admin = adminFormView(formRow({ withdrawn_at: new Date(), withdrawn_reason: 'x' }), { downloads: 3 });
  assert.equal(admin.withdrawnReason, 'x');
  assert.equal(admin.downloads, 3);
  assert.equal(admin.scanState, 'pending');
});

test('one visibility clause: not withdrawn, and for all companies or my fund', () => {
  assert.equal(
    companyVisibleFormsClause('f', 1),
    'f.withdrawn_at IS NULL AND (f.fund_id IS NULL OR f.fund_id = $1)'
  );
  assert.equal(replacedReason(2), 'Replaced by version 2');
});

// ---------------------------------------------------------------------------
// Admin only
// ---------------------------------------------------------------------------

test('every /forms route is admin only: advisor, viewer, investor and company tokens are refused', async (t) => {
  const pool = fakePool([]);
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  const attempts = [
    ['GET', '/forms'], ['GET', '/forms/history'], ['GET', `/forms/refs?fundId=${FUND_BIOTECH}`],
    ['POST', '/forms'], ['POST', `/forms/${FORM_1}/replace`], ['PATCH', `/forms/${FORM_1}`],
    ['POST', `/forms/${FORM_1}/withdraw`], ['GET', `/forms/${FORM_1}/download`],
  ];
  for (const role of ['advisor', 'viewer', 'investor']) {
    const token = tokenFor({ role, sub: `user-${role}` });
    for (const [method, path] of attempts) {
      const res = await server.request(path, { method, token, body: method === 'GET' ? undefined : {} });
      assert.equal(res.status, 403, `${role} ${method} ${path}`);
    }
  }
  for (const [method, path] of attempts) {
    const res = await server.request(path, { method, token: companyToken(), body: method === 'GET' ? undefined : {} });
    assert.equal(res.status, 403, `company ${method} ${path}`);
  }
  assert.equal(pool.calls.some((c) => /dd_forms/.test(c.text)), false, 'nothing should have been queried');
});

// ---------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------

test('publishing stores the bytes under forms/, writes the row and its links, and audits it', async (t) => {
  const store = scannerAndStore(t);
  const pool = fakePool([fundExists(), refExists(), insertedForm()]);
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  const res = await postForm(server, '/forms', multipart({
    title: 'Beneficial Owner Declaration',
    description: 'One per company, signed by an authorised signatory',
    fundId: 'all',
    links: [{ fundId: FUND_BIOTECH, ref: '14.7' }],
  }));

  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.title, 'Beneficial Owner Declaration');
  assert.equal(res.body.version, 1);
  assert.equal(res.body.fundId, null);

  const insert = pool.calls.find((c) => c.text.includes('INSERT INTO dd_forms'));
  assert.ok(insert);
  assert.equal(insert.params[7], null, 'all companies means fund_id NULL');
  assert.equal(insert.params[8], 1);
  assert.equal(insert.params[9], null);
  assert.equal(insert.params[11], 'pending');
  assert.equal(insert.params[12], 'stub');

  const key = insert.params[4];
  assert.ok(key.startsWith('forms/'));
  assert.equal(store.bytes(key).toString(), 'form bytes');

  const link = pool.calls.find((c) => c.text.includes('INSERT INTO dd_form_items'));
  assert.ok(link, 'the link should have been written');
  assert.deepEqual(link.params.slice(1), [FUND_BIOTECH, '14.7']);

  const audit = pool.calls.find((c) => c.text.includes('INSERT INTO audit_log'));
  assert.equal(audit.params[1], 'dd_form.published');
  assert.equal(audit.params[2], 'dd_form');
  assert.equal(JSON.parse(audit.params[4]).version, 1);
});

test('publishing without a title is refused and nothing is written', async (t) => {
  scannerAndStore(t);
  const pool = fakePool([]);
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  for (const title of [undefined, '', '  ']) {
    const res = await postForm(server, '/forms', multipart({ title }));
    assert.equal(res.status, 400);
    assert.match(res.body.error, /title is required/);
  }
  assert.equal(pool.calls.some((c) => c.text.includes('INSERT INTO dd_forms')), false);
});

test('a link to a ref that is not on the fund master is refused before anything is stored', async (t) => {
  const store = scannerAndStore(t);
  const pool = fakePool([['FROM irl_template_items i', []]]);
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  const res = await postForm(server, '/forms', multipart({
    title: 'X', links: [{ fundId: FUND_BIOTECH, ref: '99.9' }],
  }));
  assert.equal(res.status, 400);
  assert.match(res.body.error, /99\.9 does not exist/);
  assert.equal(pool.calls.some((c) => c.text.includes('INSERT INTO dd_forms')), false);
  assert.equal(store.objects.size, 0, 'nothing may reach the bucket');
});

test('malformed links are refused with a readable message', async (t) => {
  scannerAndStore(t);
  const pool = fakePool([]);
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  const res = await postForm(server, '/forms', multipart({ title: 'X', links: 'nope' }));
  assert.equal(res.status, 400);
  assert.match(res.body.error, /links must be/);
});

test('an infected form is refused at publication with nothing written to the bucket or the table', async (t) => {
  const store = new MemoryStorage();
  setStorage(store);
  setScanner({
    kind: 'test',
    describe: () => 'test',
    async scan() { return { state: 'infected', backend: 'test', detail: 'Eicar' }; },
  });
  t.after(() => { resetStorage(); resetScanner(); });

  const pool = fakePool([insertedForm()]);
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  const res = await postForm(server, '/forms', multipart({ title: 'Consent' }));
  assert.equal(res.status, 422);
  assert.equal(store.objects.size, 0);
  assert.equal(pool.calls.some((c) => c.text.includes('INSERT INTO dd_forms')), false);
  const audit = pool.calls.find((c) => c.text.includes('INSERT INTO audit_log'));
  assert.equal(JSON.parse(audit.params[4]).rejected, true);
});

// ---------------------------------------------------------------------------
// Replace, edit, withdraw
// ---------------------------------------------------------------------------

test('replacing publishes version N+1, withdraws N with the reason, and carries the links over', async (t) => {
  scannerAndStore(t);
  const pool = fakePool([
    ['FOR UPDATE', [formRow({ version: 1 })]],
    ['SELECT fund_id, item_ref FROM dd_form_items', [{ fund_id: FUND_BIOTECH, item_ref: '14.7' }]],
    refExists(),
    insertedForm(),
  ]);
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  const res = await postForm(server, `/forms/${FORM_1}/replace`, multipart({ filename: 'BOD-v2.docx' }));
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.version, 2);
  assert.equal(res.body.supersedes, FORM_1);
  assert.equal(res.body.title, 'Beneficial Owner Declaration', 'title carries over');
  assert.match(res.body.message, /Version 1 has been withdrawn/);

  const insert = pool.calls.find((c) => c.text.includes('INSERT INTO dd_forms'));
  assert.equal(insert.params[8], 2);
  assert.equal(insert.params[9], FORM_1);
  assert.notEqual(insert.params[0], FORM_1, 'a new row, not an overwrite');

  const link = pool.calls.find((c) => c.text.includes('INSERT INTO dd_form_items'));
  assert.equal(link.params[0], insert.params[0], 'links move to the new version');
  assert.deepEqual(link.params.slice(1), [FUND_BIOTECH, '14.7']);

  const withdraw = pool.calls.find((c) => c.text.includes('UPDATE dd_forms') && c.text.includes('withdrawn_at = NOW()'));
  assert.ok(withdraw);
  assert.equal(withdraw.params[0], FORM_1);
  assert.equal(withdraw.params[2], 'Replaced by version 2');

  const audit = pool.calls.find((c) => c.text.includes('INSERT INTO audit_log'));
  assert.equal(audit.params[1], 'dd_form.replaced');
  assert.equal(JSON.parse(audit.params[4]).previousVersion, 1);
});

test('replacing a withdrawn or superseded version is a 404', async (t) => {
  scannerAndStore(t);
  const pool = fakePool([['FOR UPDATE', []]]);
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  const res = await postForm(server, `/forms/${FORM_1}/replace`, multipart({}));
  assert.equal(res.status, 404);
  assert.equal(pool.calls.some((c) => c.text.includes('INSERT INTO dd_forms')), false);
});

test('editing changes metadata and links without a new file, and audits before and after', async (t) => {
  const pool = fakePool([
    ['FOR UPDATE', [formRow()]],
    fundExists(),
    refExists(),
    ['SELECT fund_id, item_ref FROM dd_form_items', [{ fund_id: FUND_BIOTECH, item_ref: '14.7' }]],
    ['FROM dd_forms f', [formRow({ title: 'BOD form', fund_id: FUND_BIOTECH, fund_name: 'Biotech KSA' })]],
  ]);
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  const res = await server.request(`/forms/${FORM_1}`, {
    method: 'PATCH', token: adminToken(),
    body: { title: 'BOD form', fundId: FUND_BIOTECH, links: [{ fundId: FUND_BIOTECH, ref: '8.8' }] },
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.title, 'BOD form');

  const update = pool.calls.find((c) => c.text.startsWith('UPDATE dd_forms SET'));
  assert.ok(update);
  assert.match(update.text, /title = \$2/);
  assert.match(update.text, /fund_id = \$3/);
  assert.equal(pool.calls.some((c) => c.text.includes('INSERT INTO dd_forms')), false, 'no new version');

  const audit = pool.calls.find((c) => c.text.includes('INSERT INTO audit_log'));
  assert.equal(audit.params[1], 'dd_form.edited');
  const detail = JSON.parse(audit.params[4]);
  assert.equal(detail.before.title, 'Beneficial Owner Declaration');
  assert.equal(detail.after.title, 'BOD form');
  assert.deepEqual(detail.before.links, [{ fundId: FUND_BIOTECH, ref: '14.7' }]);
  assert.deepEqual(detail.after.links, [{ fundId: FUND_BIOTECH, ref: '8.8' }]);
});

test('withdrawing requires a reason, is soft, and names who did it', async (t) => {
  const pool = fakePool([
    ['UPDATE dd_forms', (params) => [formRow({
      withdrawn_at: new Date(), withdrawn_by: params[1], withdrawn_reason: params[2],
    })]],
  ]);
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  for (const body of [{}, { reason: '' }, { reason: '   ' }]) {
    const refused = await server.request(`/forms/${FORM_1}/withdraw`, { method: 'POST', token: adminToken(), body });
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /reason is required/);
  }
  assert.equal(pool.calls.some((c) => c.text.includes('UPDATE dd_forms')), false);

  const res = await server.request(`/forms/${FORM_1}/withdraw`, {
    method: 'POST', token: adminToken(), body: { reason: 'Superseded by the regulator’s own form' },
  });
  assert.equal(res.status, 200);
  const update = pool.calls.find((c) => c.text.includes('UPDATE dd_forms'));
  assert.match(update.text, /withdrawn_at = NOW\(\)/);
  assert.match(update.text, /WHERE id = \$1 AND withdrawn_at IS NULL/);
  assert.equal(update.params[1], 'admin-1');
  assert.equal(pool.calls.some((c) => /DELETE FROM dd_forms/.test(c.text)), false, 'never deleted');

  const audit = pool.calls.find((c) => c.text.includes('INSERT INTO audit_log'));
  assert.equal(audit.params[1], 'dd_form.withdrawn');
});

test('the admin list counts company downloads from the audit log and the history shows withdrawn rows', async (t) => {
  const pool = fakePool([
    ['FROM dd_forms f', [formRow(), formRow({ id: FORM_2, version: 2, withdrawn_at: new Date(), withdrawn_reason: 'Replaced by version 3' })]],
    ['FROM dd_form_items l', [{ form_id: FORM_1, fund_id: FUND_BIOTECH, item_ref: '14.7', fund_name: 'Biotech KSA', description: 'Beneficial-owner declaration form' }]],
    ['FROM audit_log', [{ resource_id: FORM_1, downloads: '4' }]],
  ]);
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  const list = await server.request('/forms', { token: adminToken() });
  assert.equal(list.status, 200);
  const listSql = pool.calls.find((c) => c.text.includes('FROM dd_forms f')).text;
  assert.match(listSql, /WHERE f\.withdrawn_at IS NULL/, 'the current list hides withdrawn rows');
  assert.equal(list.body[0].downloads, 4);
  assert.deepEqual(list.body[0].links[0], {
    fundId: FUND_BIOTECH, fundName: 'Biotech KSA', ref: '14.7', description: 'Beneficial-owner declaration form',
  });
  const countSql = pool.calls.find((c) => c.text.includes('FROM audit_log')).text;
  assert.match(countSql, /company_form\.downloaded/);

  pool.calls.length = 0;
  const history = await server.request('/forms/history', { token: adminToken() });
  assert.equal(history.status, 200);
  const historySql = pool.calls.find((c) => c.text.includes('FROM dd_forms f')).text;
  assert.equal(/withdrawn_at IS NULL/.test(historySql), false, 'history shows everything');
  assert.equal(history.body[1].withdrawnReason, 'Replaced by version 3');
});

test('an admin can download any version, withdrawn included, and it is audited as a Taranis download', async (t) => {
  const store = scannerAndStore(t);
  const key = `forms/${FORM_1}/BOD.docx`;
  await store.put(key, { body: Buffer.from('v1 bytes'), contentType: 'application/octet-stream', contentLength: 8 });
  const pool = fakePool([['SELECT * FROM dd_forms WHERE id = $1', [formRow({ s3_key: key, withdrawn_at: new Date(), withdrawn_by: 'admin-1', withdrawn_reason: 'x' })]]]);
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  const res = await fetch(`${server.base}/forms/${FORM_1}/download`, {
    headers: { Authorization: `Bearer ${adminToken()}` },
  });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'v1 bytes');
  const audit = pool.calls.find((c) => c.text.includes('INSERT INTO audit_log'));
  assert.equal(audit.params[1], 'dd_form.downloaded');
  assert.equal(JSON.parse(audit.params[4]).withdrawn, true);
});

// ---------------------------------------------------------------------------
// Company side
// ---------------------------------------------------------------------------

test('the company list is scoped to live forms for all companies or its own fund, and links only to items it can see', async (t) => {
  const pool = fakePool([
    companyMembership(),
    ['FROM dd_forms f', [formRow(), formRow({ id: FORM_2, title: 'Background Check Consent' })]],
    ['JOIN company_irl_items i ON i.company_id', [
      { form_id: FORM_1, item_id: ITEM_147, ref: '14.7', state: 'outstanding' },
      { form_id: FORM_2, item_id: ITEM_HELD, ref: '8.8', state: 'held' },
    ]],
  ]);
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  const res = await server.request('/company/forms', { token: companyToken('company_viewer') });
  assert.equal(res.status, 200, JSON.stringify(res.body));

  const listSql = pool.calls.find((c) => c.text.includes('FROM dd_forms f'));
  assert.match(listSql.text, /f\.withdrawn_at IS NULL AND \(f\.fund_id IS NULL OR f\.fund_id = \$1\)/);
  assert.equal(listSql.params[0], FUND_BIOTECH);

  const linkSql = pool.calls.find((c) => c.text.includes('JOIN company_irl_items i ON i.company_id'));
  assert.equal(linkSql.params[0], COMPANY_A, 'links resolve against this company only');
  assert.equal(linkSql.params[1], FUND_BIOTECH);

  const [bod, consent] = res.body;
  assert.deepEqual(bod.items, [{ id: ITEM_147, ref: '14.7' }]);
  assert.deepEqual(consent.items, [], 'a link to a held item never appears');
  assert.equal(bod.version, 1);
  assert.equal('s3Key' in bod || 's3_key' in bod || 'scanState' in bod, false);
});

test('every company role can list and download forms; fund-side roles cannot reach the company routes', async (t) => {
  const pool = fakePool([companyMembership(), ['FROM dd_forms f', []]]);
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  for (const companyRole of ['company_admin', 'company_contributor', 'company_viewer']) {
    const res = await server.request('/company/forms', { token: companyToken(companyRole) });
    assert.equal(res.status, 200, companyRole);
  }
  for (const role of ['admin', 'advisor', 'viewer', 'investor']) {
    const token = tokenFor({ role, sub: `user-${role}` });
    for (const path of ['/company/forms', `/company/forms/${FORM_1}/download`]) {
      const res = await server.request(path, { token });
      assert.equal(res.status, 403, `${role} ${path}`);
    }
  }
});

test('a company download is refused for a withdrawn, superseded or other-fund form by the same lookup, and audited with the version', async (t) => {
  const store = scannerAndStore(t);
  const key = `forms/${FORM_1}/BOD.docx`;
  await store.put(key, { body: Buffer.from('bod bytes'), contentType: 'application/octet-stream', contentLength: 9 });

  // Nothing visible: the lookup itself carries the visibility clause.
  const refusedPool = fakePool([companyMembership(), ['FROM dd_forms f', []]]);
  const refusedServer = await startTestServer(MOUNTS, refusedPool);
  const refused = await refusedServer.request(`/company/forms/${FORM_1}/download`, { token: companyToken() });
  assert.equal(refused.status, 404);
  const lookup = refusedPool.calls.find((c) => c.text.includes('FROM dd_forms f'));
  assert.match(lookup.text, /f\.withdrawn_at IS NULL AND \(f\.fund_id IS NULL OR f\.fund_id = \$1\)/);
  assert.deepEqual(lookup.params, [FUND_BIOTECH, FORM_1]);
  assert.equal(refusedPool.calls.some((c) => c.text.includes('INSERT INTO audit_log')), false);
  await refusedServer.close();

  const pool = fakePool([companyMembership(), ['FROM dd_forms f', [formRow({ s3_key: key, version: 2 })]]]);
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  const res = await fetch(`${server.base}/company/forms/${FORM_1}/download`, {
    headers: { Authorization: `Bearer ${companyToken('company_viewer')}` },
  });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'bod bytes');
  assert.match(res.headers.get('content-disposition'), /BOD\.docx/);

  const audit = pool.calls.find((c) => c.text.includes('INSERT INTO audit_log'));
  assert.equal(audit.params[1], 'company_form.downloaded');
  assert.equal(audit.params[2], 'dd_form');
  assert.equal(audit.params[3], FORM_1);
  const detail = JSON.parse(audit.params[4]);
  assert.equal(detail.companyId, COMPANY_A);
  assert.equal(detail.formId, FORM_1);
  assert.equal(detail.version, 2);
});

test('an infected form is never served to a company', async (t) => {
  scannerAndStore(t);
  const pool = fakePool([companyMembership(), ['FROM dd_forms f', [formRow({ scan_state: 'infected' })]]]);
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  const res = await server.request(`/company/forms/${FORM_1}/download`, { token: companyToken() });
  assert.equal(res.status, 409);
  assert.equal(pool.calls.some((c) => c.text.includes('INSERT INTO audit_log')), false);
});

test('GET /company/items/:itemId returns the forms linked to that item', async (t) => {
  const pool = fakePool([
    companyMembership(),
    ['FROM company_irl_items WHERE id = $1 AND company_id = $2', [{
      id: ITEM_147, company_id: COMPANY_A, section: '14. Closing Information (AML / KYC)', ref: '14.7',
      description: 'Beneficial-owner declaration form', priority: 'high', state: 'outstanding',
      note_for_company: null, internal_note: 'never shown',
    }]],
    ['FROM company_files f', []],
    ['FROM dd_form_items l', [{ ...formRow(), item_ref: '14.7' }]],
  ]);
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  const res = await server.request(`/company/items/${ITEM_147}`, { token: companyToken() });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.forms.length, 1);
  assert.equal(res.body.forms[0].title, 'Beneficial Owner Declaration');
  assert.deepEqual(res.body.forms[0].items, [{ id: ITEM_147, ref: '14.7' }]);
  assert.equal('internal_note' in res.body.item, false);

  const formsSql = pool.calls.find((c) => c.text.includes('FROM dd_form_items l'));
  assert.equal(formsSql.params[0], FUND_BIOTECH);
  assert.deepEqual(formsSql.params[1], ['14.7']);
  assert.match(formsSql.text, /f\.withdrawn_at IS NULL AND \(f\.fund_id IS NULL OR f\.fund_id = \$1\)/);
});

test('the workspace flags items that have a form, from one query', async (t) => {
  const pool = fakePool([
    companyMembership(),
    ['FROM company_irl_items i', [
      { id: ITEM_147, section: 's', ref: '14.7', description: 'd', priority: 'high', state: 'outstanding', sort_order: 1, submitted_files: '0', staged_files: '0' },
      { id: 'other', section: 's', ref: '1.1', description: 'd', priority: 'high', state: 'outstanding', sort_order: 2, submitted_files: '0', staged_files: '0' },
    ]],
    ['FROM dd_form_items l', [{ ...formRow(), item_ref: '14.7' }]],
  ]);
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  const res = await server.request('/company/workspace', { token: companyToken() });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.items.find((i) => i.ref === '14.7').hasForm, true);
  assert.equal(res.body.items.find((i) => i.ref === '1.1').hasForm, false);
  assert.equal(pool.calls.filter((c) => c.text.includes('FROM dd_form_items l')).length, 1);
});

test('the company side of forms is read-only: there is no way in to publish, edit, withdraw or delete', async (t) => {
  const pool = fakePool([companyMembership()]);
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  for (const [method, path] of [
    ['POST', '/company/forms'],
    ['PATCH', `/company/forms/${FORM_1}`],
    ['DELETE', `/company/forms/${FORM_1}`],
    ['POST', `/company/forms/${FORM_1}/withdraw`],
    ['POST', `/company/forms/${FORM_1}/replace`],
  ]) {
    const res = await server.request(path, { method, token: companyToken(), body: {} });
    assert.equal(res.status, 404, `${method} ${path}`);
  }
  assert.equal(pool.calls.some((c) => /INSERT INTO dd_forms|UPDATE dd_forms|DELETE FROM dd_forms/.test(c.text)), false);
});
