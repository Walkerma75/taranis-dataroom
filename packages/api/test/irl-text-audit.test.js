/**
 * The audit of company-visible IRL text already in the database
 * (HANDOVER-CW019 §3.5).
 *
 * The database is the fake pool, as everywhere else in this suite, so these
 * assert on the statements the audit issues rather than on a live table. What
 * matters is which columns it blanks, what it appends to the internal note, and
 * that it never invents replacement wording.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { report, quarantine, describeFinding } from '../src/services/irl-text-audit.js';
import { fakePool } from './helpers/test-app.js';

const ITEM = (over = {}) => ({
  id: 'item-1', company_id: 'co-1', ref: '13.10',
  already_held: null, note_for_company: null, internal_note: null,
  company_name: 'KardiaNova', ...over,
});

const poolWith = (rows) => fakePool([['FROM company_irl_items i', rows]]);

test('report finds nothing in a clean checklist', async () => {
  const result = await report(poolWith([
    ITEM({ already_held: 'Certificate held' }),
    ITEM({ id: 'item-2', ref: '1.1', note_for_company: 'Completed at our CASS pre-screen stage' }),
  ]));

  assert.equal(result.scanned, 2);
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.companies, []);
});

test('report names the company, the ref, the field and the rule', async () => {
  const result = await report(poolWith([
    ITEM({ already_held: 'scored 5/5 in CASS' }),
  ]));

  assert.equal(result.scanned, 1);
  assert.deepEqual(result.companies, ['KardiaNova']);
  assert.ok(result.findings.length >= 1);
  const [first] = result.findings;
  assert.equal(first.ref, '13.10');
  assert.equal(first.field, 'already_held');
  assert.equal(first.companyName, 'KardiaNova');
  assert.match(describeFinding(first), /KardiaNova ref 13\.10, already_held/);
});

test('report reads only the company-visible columns', async () => {
  // source_document and internal_note are exempt by the decision recorded in
  // services/company-visible-text.js. An audit that flagged them would ask a
  // human to rewrite text that is doing its job.
  const result = await report(poolWith([
    ITEM({
      internal_note: 'CASS Assessment Report (internal), STRONG 77/100',
      source_document: 'CASS Assessment Report (internal)',
    }),
  ]));
  assert.deepEqual(result.findings, []);
});

test('quarantine blanks the offending column and carries the text to the internal note', async () => {
  const pool = poolWith([ITEM({ already_held: 'scored 5/5 in CASS' })]);
  const result = await quarantine({ actorId: 'admin-1' }, pool);

  assert.equal(result.items, 1);
  assert.deepEqual(result.companies, ['KardiaNova']);

  const update = pool.calls.find((c) => c.text.includes('UPDATE company_irl_items'));
  assert.ok(update, 'the item should have been updated');
  assert.match(update.text, /already_held = \$3/);
  assert.match(update.text, /internal_note = \$2/);
  // The visible column is blanked...
  assert.equal(update.params[2], null);
  // ...and the original survives verbatim, labelled with where it came from.
  assert.match(update.params[1], /already_held, withdrawn from company view/);
  assert.match(update.params[1], /scored 5\/5 in CASS/);
});

test('quarantine appends rather than overwriting an existing internal note', async () => {
  const pool = poolWith([ITEM({
    already_held: 'scored 5/5 in CASS',
    internal_note: 'Reviewer: chase the assay pack.',
  })]);
  await quarantine({}, pool);

  const update = pool.calls.find((c) => c.text.includes('UPDATE company_irl_items'));
  assert.match(update.params[1], /^Reviewer: chase the assay pack\./);
  assert.match(update.params[1], /scored 5\/5 in CASS/);
});

test('quarantine records every finding against the permanent ref', async () => {
  const pool = poolWith([ITEM({
    already_held: 'scored 5/5 in CASS',
    note_for_company: 'CASS Assessment Report (internal)',
  })]);
  const result = await quarantine({ actorId: 'admin-1' }, pool);

  const audits = pool.calls.filter((c) =>
    c.text.includes('INSERT INTO irl_internal_reference_audit'));
  assert.equal(audits.length, result.moved.length);
  assert.ok(audits.every((a) => a.params[2] === '13.10'));
  assert.ok(audits.every((a) => a.params[7] === 'admin-1'));

  // Both visible columns were blanked in one statement.
  const update = pool.calls.find((c) => c.text.includes('UPDATE company_irl_items'));
  assert.match(update.text, /already_held = \$3/);
  assert.match(update.text, /note_for_company = \$4/);
});

test('quarantine leaves a clean checklist entirely alone', async () => {
  const pool = poolWith([ITEM({ note_for_company: 'Please send the audited FY2024/25 accounts' })]);
  const result = await quarantine({}, pool);

  assert.equal(result.items, 0);
  assert.deepEqual(result.moved, []);
  assert.ok(!pool.sql().some((s) => s.includes('UPDATE company_irl_items')));
  assert.ok(!pool.sql().some((s) => s.includes('irl_internal_reference_audit')));
});

test('quarantine runs in one transaction', async () => {
  const pool = poolWith([ITEM({ already_held: 'scored 5/5 in CASS' })]);
  await quarantine({}, pool);

  const sql = pool.sql();
  assert.ok(sql.includes('BEGIN'));
  assert.ok(sql.includes('COMMIT'));
  assert.ok(sql.indexOf('BEGIN') < sql.findIndex((s) => s.includes('UPDATE company_irl_items')));
});

test('quarantine does not invent replacement wording', async () => {
  // The whole point of §3.5: the text is moved out of sight and the ref is
  // recorded, and a human redrafts it. Nothing here writes prose.
  const pool = poolWith([ITEM({ already_held: 'scored 5/5 in CASS' })]);
  await quarantine({}, pool);

  const update = pool.calls.find((c) => c.text.includes('UPDATE company_irl_items'));
  assert.equal(update.params[2], null);
});
