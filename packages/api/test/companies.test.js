/**
 * Company DD portal domain rules.
 *
 * The activation gates, the item-state derivation, the receipt-reference format
 * and the company-side visibility filter are all plain functions, so they are
 * tested as plain functions rather than through HTTP. The route-level guards
 * are covered in company-isolation.test.js.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  missingActivationGates,
  canActivate,
  activationRefusalMessage,
  canInviteUsers,
  inviteRefusalMessage,
  isVisibleToCompany,
  companyVisibleItems,
  companySafeItem,
  deriveItemState,
  formatReceiptRef,
  isAllowedCompanyUpload,
  buildCompanyFileKey,
  summariseProgress,
  seedStateFor,
  canWriteAtLevel,
  COMPANY_MAX_FILE_BYTES,
} from '../src/services/companies.js';

// ---------------------------------------------------------------------------
// Activation gates
// ---------------------------------------------------------------------------

test('activation needs both the NDA and the IEMS screen', () => {
  assert.equal(canActivate({}), false);
  assert.equal(canActivate({ nda_executed_at: new Date() }), false);
  assert.equal(canActivate({ iems_screened_at: new Date() }), false);
  assert.equal(canActivate({ nda_executed_at: new Date(), iems_screened_at: new Date() }), true);
});

test('the IMALIA case: an NDA with no IEMS screen cannot be activated', () => {
  // One company in the first real cohort holds an executed NDA but has no IEMS
  // screen on record, so this path is exercised for real rather than in theory.
  const company = { legal_name: 'IMALIA', nda_executed_at: new Date('2026-07-01T00:00:00Z') };

  assert.equal(canActivate(company), false);
  assert.deepEqual(missingActivationGates(company), ['iems_screened_at']);
  assert.match(activationRefusalMessage(company), /IEMS screening date/);
  // And the message must not claim the NDA is missing.
  assert.doesNotMatch(activationRefusalMessage(company), /NDA/);
});

test('the refusal message names both gates when neither is recorded', () => {
  const message = activationRefusalMessage({});
  assert.match(message, /executed NDA date and the IEMS screening date/);
  // UK English, no em dashes anywhere in user-facing copy.
  assert.equal(message.includes('—'), false);
});

test('there is no refusal message once both gates are recorded', () => {
  assert.equal(
    activationRefusalMessage({ nda_executed_at: new Date(), iems_screened_at: new Date() }),
    null
  );
});

// ---------------------------------------------------------------------------
// The invitation gate (HANDOVER-CW005)
// ---------------------------------------------------------------------------

test('only an active company can have users invited', () => {
  assert.equal(canInviteUsers({ status: 'active' }), true);
  for (const status of ['pending', 'suspended', 'offboarded']) {
    assert.equal(canInviteUsers({ status }), false, `${status} must not be invitable`);
  }
  // A company row with no status at all is not active, so it is not invitable.
  assert.equal(canInviteUsers({}), false);
  assert.equal(canInviteUsers(null), false);
});

test('recording both gates is not enough on its own: the company must be activated', () => {
  // The trap CW005 closes. Both gates recorded, still pending, still no
  // workspace for an invitee to arrive in.
  const company = {
    status: 'pending',
    nda_executed_at: new Date(),
    iems_screened_at: new Date(),
  };
  assert.equal(canActivate(company), true);
  assert.equal(canInviteUsers(company), false);
});

test('the invitation refusal names the status and what would fix it', () => {
  assert.match(inviteRefusalMessage({ status: 'pending' }), /pending/);
  assert.match(inviteRefusalMessage({ status: 'pending' }), /activate/i);
  assert.match(inviteRefusalMessage({ status: 'suspended' }), /Reinstate/);
  assert.match(inviteRefusalMessage({ status: 'offboarded' }), /offboarded/);

  // UK English, no em dashes anywhere in user-facing copy.
  for (const status of ['pending', 'suspended', 'offboarded']) {
    assert.equal(inviteRefusalMessage({ status }).includes('—'), false);
  }
});

test('there is no invitation refusal for an active company', () => {
  assert.equal(inviteRefusalMessage({ status: 'active' }), null);
});

// ---------------------------------------------------------------------------
// Company-side visibility
// ---------------------------------------------------------------------------

test('companies see outstanding and partially held items, never fully held ones', () => {
  const items = [
    { ref: '1.1', state: 'outstanding' },
    { ref: '1.2', state: 'held' },
    { ref: '1.3', state: 'partially_held' },
    { ref: '1.4', state: 'received' },
    { ref: '1.5', state: 'completed' },
    { ref: '1.6', state: 'not_applicable' },
  ];

  assert.deepEqual(companyVisibleItems(items).map((i) => i.ref), ['1.1', '1.3', '1.4', '1.5', '1.6']);
  assert.equal(isVisibleToCompany({ state: 'held' }), false);
  assert.equal(isVisibleToCompany({ state: 'partially_held' }), true);
});

test('an internal note never survives the company-facing shape', () => {
  const safe = companySafeItem({
    ref: '4.2',
    description: 'Audited accounts',
    note_for_company: 'Latest two years please',
    internal_note: 'Their auditor resigned in March, press them on this',
  });

  assert.equal(safe.note_for_company, 'Latest two years please');
  assert.equal('internal_note' in safe, false);
  assert.equal(JSON.stringify(safe).includes('auditor resigned'), false);
});

// ---------------------------------------------------------------------------
// Item state derivation
// ---------------------------------------------------------------------------

test('an item with no files keeps its seeded state', () => {
  assert.equal(deriveItemState([], 'outstanding'), 'outstanding');
  assert.equal(deriveItemState([], 'held'), 'held');
  assert.equal(deriveItemState([], 'partially_held'), 'partially_held');
});

test('staged files do not move an item off outstanding', () => {
  // A staged file is not a submission. Deriving 'received' from one would tell
  // a reviewer that something has arrived when nothing has.
  const staged = [{ upload_state: 'staged', status: null }];
  assert.equal(deriveItemState(staged, 'outstanding'), 'outstanding');
});

test('attention_needed wins over everything else', () => {
  const files = [
    { upload_state: 'submitted', status: 'completed' },
    { upload_state: 'submitted', status: 'attention_needed' },
    { upload_state: 'submitted', status: 'in_review' },
  ];
  assert.equal(deriveItemState(files), 'attention_needed');
});

test('completed requires every submitted file to be completed', () => {
  assert.equal(deriveItemState([
    { upload_state: 'submitted', status: 'completed' },
    { upload_state: 'submitted', status: 'completed' },
  ]), 'completed');

  assert.equal(deriveItemState([
    { upload_state: 'submitted', status: 'completed' },
    { upload_state: 'submitted', status: 'received' },
  ]), 'received');
});

test('in_review outranks received', () => {
  assert.equal(deriveItemState([
    { upload_state: 'submitted', status: 'received' },
    { upload_state: 'submitted', status: 'in_review' },
  ]), 'in_review');
});

test('a deleted file does not count towards a state', () => {
  const files = [
    { upload_state: 'submitted', status: 'received', deleted_at: new Date() },
  ];
  assert.equal(deriveItemState(files, 'outstanding'), 'outstanding');
});

// ---------------------------------------------------------------------------
// Receipt references
// ---------------------------------------------------------------------------

test('receipt references are formatted and zero-padded', () => {
  const when = new Date('2026-08-06T12:00:00Z');
  assert.equal(formatReceiptRef(1, when), 'TRN-DD-2026-000001');
  assert.equal(formatReceiptRef(123, when), 'TRN-DD-2026-000123');
  assert.equal(formatReceiptRef(999999, when), 'TRN-DD-2026-999999');
});

test('receipt references sort in issue order for the first million', () => {
  const when = new Date('2026-08-06T12:00:00Z');
  const refs = [1, 2, 10, 99, 100, 1000].map((n) => formatReceiptRef(n, when));
  assert.deepEqual([...refs].sort(), refs, 'padding must keep string order equal to issue order');
});

test('the year comes from the submission time, in UTC', () => {
  // A submission at 23:30 UTC on 31 December belongs to that year, whatever the
  // local time of whoever reads the receipt.
  assert.match(formatReceiptRef(5, new Date('2026-12-31T23:30:00Z')), /^TRN-DD-2026-/);
  assert.match(formatReceiptRef(5, new Date('2027-01-01T00:30:00Z')), /^TRN-DD-2027-/);
});

// ---------------------------------------------------------------------------
// Upload rules
// ---------------------------------------------------------------------------

test('the company upload allow-list matches the code brief', () => {
  for (const name of ['a.pdf', 'a.docx', 'a.xlsx', 'a.pptx', 'a.csv', 'a.txt', 'a.png', 'a.jpg', 'a.zip']) {
    assert.equal(isAllowedCompanyUpload(name), true, `${name} should be accepted`);
  }
  for (const name of ['a.exe', 'a.js', 'a.sh', 'a.doc', 'a.html', 'a', 'a.PDF.exe']) {
    assert.equal(isAllowedCompanyUpload(name), false, `${name} should be refused`);
  }
});

test('the allow-list is case-insensitive', () => {
  assert.equal(isAllowedCompanyUpload('Report.PDF'), true);
  assert.equal(isAllowedCompanyUpload('Sheet.XLSX'), true);
});

test('the company size cap is 200 MB', () => {
  assert.equal(COMPANY_MAX_FILE_BYTES, 200 * 1024 * 1024);
});

// ---------------------------------------------------------------------------
// Storage keys
// ---------------------------------------------------------------------------

test('company file keys never collide with the fund document prefix', () => {
  const key = buildCompanyFileKey({
    companyId: 'company-1', irlItemId: 'item-1', fileId: 'file-1', filename: 'accounts.pdf',
  });
  assert.equal(key, 'companies/company-1/item-1/file-1/accounts.pdf');
  assert.ok(key.startsWith('companies/'));
  assert.equal(key.startsWith('documents/'), false);
});

test('a file with no item lands under an "additional" slot', () => {
  const key = buildCompanyFileKey({ companyId: 'c', fileId: 'f', filename: 'extra.pdf' });
  assert.equal(key, 'companies/c/additional/f/extra.pdf');
});

test('a filename cannot climb out of its own key prefix', () => {
  const key = buildCompanyFileKey({
    companyId: 'company-1', irlItemId: 'item-1', fileId: 'file-1',
    filename: '../../documents/fund-1/stolen.pdf',
  });
  assert.equal(key, 'companies/company-1/item-1/file-1/.._.._documents_fund-1_stolen.pdf');
  assert.equal(key.includes('/documents/'), false);
});

// ---------------------------------------------------------------------------
// Seeding and progress
// ---------------------------------------------------------------------------

test('the seeded state follows what Taranis already holds', () => {
  assert.equal(seedStateFor(null), 'outstanding');
  assert.equal(seedStateFor(''), 'outstanding');
  assert.equal(seedStateFor('   '), 'outstanding');
  assert.equal(seedStateFor('partial'), 'partially_held');
  assert.equal(seedStateFor('Partially held from the AdrenoMed pack'), 'partially_held');
  assert.equal(seedStateFor('Signed M&A on file'), 'held');
});

test('progress ignores held and not applicable items', () => {
  const summary = summariseProgress([
    { state: 'completed' },
    { state: 'completed' },
    { state: 'outstanding' },
    { state: 'outstanding' },
    { state: 'held' },
    { state: 'not_applicable' },
  ]);

  assert.equal(summary.total, 6);
  assert.equal(summary.countable, 4);
  assert.equal(summary.completed, 2);
  assert.equal(summary.percentComplete, 50);
  assert.equal(summary.counts.held, 1);
});

test('progress on an empty checklist is zero, not a division by zero', () => {
  assert.equal(summariseProgress([]).percentComplete, 0);
  assert.equal(summariseProgress([{ state: 'held' }]).percentComplete, 0);
});

// ---------------------------------------------------------------------------
// Reviewer levels
// ---------------------------------------------------------------------------

test('only admin and reviewer levels may write', () => {
  assert.equal(canWriteAtLevel('admin'), true);
  assert.equal(canWriteAtLevel('reviewer'), true);
  assert.equal(canWriteAtLevel('readonly'), false);
  assert.equal(canWriteAtLevel(null), false);
});
