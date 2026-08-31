/**
 * The guard on text that reaches a company (HANDOVER-CW019).
 *
 * The tests that matter most are the ones that assert the guard does NOT fire.
 * A guard that flags "our CASS pre-screen" is a guard somebody switches off,
 * and then the next founder reads a sub-score. So the permitted list below is
 * as load bearing as the blocked list, and both come from CW019 §4.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  findCompanyUnsafeText,
  isCompanySafeText,
  assertCompanySafeText,
  CompanyVisibleTextError,
  findUnsafeRowText,
} from '../src/services/company-visible-text.js';
import {
  buildGapsWorkbook,
  buildPrefilledWorkbook,
  GapsContentError,
} from '../src/services/irl-exports.js';
import { validateIrlSeed, loadIrlSeed } from '../src/db/seed-irl.js';
import companiesRouter from '../src/routes/companies.js';
import { fakePool, startTestServer, tokenFor } from './helpers/test-app.js';

const tiersFor = (text) => findCompanyUnsafeText(text).map((h) => h.tier);

// ---------------------------------------------------------------------------
// Tier 1 — scores
// ---------------------------------------------------------------------------

test('tier 1 catches the wording that actually reached a founder', () => {
  // The KardiaNova row 13.10, verbatim.
  assert.ok(tiersFor('scored 5/5 in CASS').includes('score'));
});

test('tier 1 catches a rating, a sub-score and a threshold verdict', () => {
  for (const text of [
    'achieved a STRONG rating of 77/100',
    'Investment Fundamentals 20/30',
    'exceeding all category thresholds',
    'exceeds all thresholds',
    'passed all thresholds',
    'rated Strong on Saudi Localisation',
    'a GOOD rating overall',
    'PASS on Investment Fundamentals',
    'Go/No-Go result recorded',
    'sub-score of 4 on Market & Execution',
  ]) {
    assert.ok(tiersFor(text).includes('score'), `expected a score hit: ${text}`);
  }
});

// ---------------------------------------------------------------------------
// Tier 2 — internal sources
// ---------------------------------------------------------------------------

test('tier 2 catches an internal document cited as a source', () => {
  for (const text of [
    'CASS records that the company completed Phase 2a work',
    'Summarised in CASS/HELIX8',
    'CASS Assessment Report (internal)',
    'noted in the deal sourcing note',
    'per the IC paper',
    'see the meeting note of 3 June',
  ]) {
    assert.ok(
      tiersFor(text).includes('internal-source'),
      `expected an internal-source hit: ${text}`
    );
  }
});

// ---------------------------------------------------------------------------
// The permitted list. CASS stays visible as a named process step.
// ---------------------------------------------------------------------------

test('the bare acronym and the process description are never flagged', () => {
  for (const text of [
    'CASS',
    'our CASS pre-screen',
    'Completed at our CASS pre-screen stage',
    'assessed under our Companies Assessment & Scoring System',
    'our CASS framework',
    'named in your HELIX8 submission',
    'HELIX8 questionnaire returned January 2026',
  ]) {
    assert.deepEqual(findCompanyUnsafeText(text), [], `should be permitted: ${text}`);
  }
});

test('ordinary diligence prose is not flagged', () => {
  for (const text of [
    'our file notes 12+ patent families',
    'Phase 2a completed',
    'at least 200 assays per month by Q3-Q4 2026',
    'Audited accounts for FY2024/25 held',
    'Phase 1/2 trial protocol held',
    'We will pass on the auditor contact details',
    'The facility is rated for BSL-2 work',
    'Equipment rated to 10,000 rpm',
    'Certification is rated by BSI',
  ]) {
    assert.deepEqual(findCompanyUnsafeText(text), [], `should be permitted: ${text}`);
  }
});

test('a UK date is not a score', () => {
  // The denominator list covers 5, 6, 8 and 10, which are four months of the
  // year. Without the date exclusion the guard fires on the single most likely
  // content of a "what we already hold" note, which is what would get it
  // switched off.
  for (const text of [
    'SPA dated 14/8/2026 held on file',
    'Board minutes of 12/10/2025 received',
    'Signed 1/5/2026',
  ]) {
    assert.deepEqual(findCompanyUnsafeText(text), [], `should be permitted: ${text}`);
  }
});

test('a category name is only a leak when it carries a score', () => {
  // Narrowed on Mark's instruction, 31 August 2026. The rule as briefed was
  // "within 40 characters of a digit", which blocked ordinary things to write
  // to a company about: a quarter, a financial year, a launch date.
  for (const text of [
    'Strategic Alignment with your Q3 roadmap is still to be documented',
    'Please confirm Market & Execution plans for the 2027 launch',
    'Market & Execution plans for Q3-Q4 2026',
    'Saudi Localisation evidence for FY2024/25',
    'Investment Fundamentals section of your FY26 plan',
    'Strategic Alignment narrative, updated 14/8/2026',
    'Saudi Localisation evidence dated 12/10/2025',
  ]) {
    assert.deepEqual(findCompanyUnsafeText(text), [], `should be permitted: ${text}`);
  }

  // A real sub-score still fires, including one whose denominator is not on the
  // CASS list and so is not caught by the fraction rule.
  for (const text of [
    'Investment Fundamentals 20/30',
    'Investment Fundamentals 20/25',
    'Saudi Localisation 18/20',
    'sub-score of 4 on Market & Execution',
    'Strategic Alignment: 15',
  ]) {
    assert.ok(tiersFor(text).includes('score'), `expected a score hit: ${text}`);
  }
});

test('empty, null and undefined are safe', () => {
  for (const value of [null, undefined, '', '   ']) {
    assert.equal(isCompanySafeText(value), true);
  }
});

// ---------------------------------------------------------------------------
// assertCompanySafeText
// ---------------------------------------------------------------------------

test('assertCompanySafeText names the field, the term and the fragment', () => {
  assert.throws(
    () => assertCompanySafeText('alreadyHeld', 'CASS records completed Phase 2a work'),
    (err) => {
      assert.ok(err instanceof CompanyVisibleTextError);
      assert.equal(err.code, 'COMPANY_VISIBLE_TEXT');
      assert.equal(err.field, 'alreadyHeld');
      assert.equal(err.tier, 'internal-source');
      assert.match(err.match, /CASS records/i);
      assert.match(err.message, /visible to the company/);
      assert.match(err.message, /our file notes/);
      return true;
    }
  );

  // A safe value passes through unchanged, so the assert can be used inline.
  assert.equal(assertCompanySafeText('alreadyHeld', 'Certificate held'), 'Certificate held');
});

test('findUnsafeRowText reads the two company-visible columns and no others', () => {
  const problems = findUnsafeRowText({
    ref: '13.10',
    already_held: 'scored 5/5 in CASS',
    note_for_company: 'Summarised in CASS/HELIX8',
    // Both exempt: internal_note is stripped from every company response, and
    // source_document feeds the internal PRE-FILLED sheet only.
    internal_note: 'CASS Assessment Report (internal), STRONG 77/100',
    source_document: 'CASS Assessment Report (internal)',
  });

  assert.deepEqual(
    [...new Set(problems.map((p) => p.field))].sort(),
    ['already_held', 'note_for_company']
  );
  assert.ok(problems.every((p) => p.ref === '13.10'));
});

// ---------------------------------------------------------------------------
// The exports
// ---------------------------------------------------------------------------

const ROW = (over = {}) => ({
  section: '13. Scientific', ref: '13.10', description: 'Assay validation pack',
  priority: 'high', state: 'outstanding', already_held: null,
  source_document: null, note_for_company: null, ...over,
});

test('GAPS refuses to build when a row carries a CASS reference', async () => {
  await assert.rejects(
    () => buildGapsWorkbook({
      companyName: 'KardiaNova',
      items: [ROW({ already_held: 'scored 5/5 in CASS' })],
    }),
    (err) => {
      assert.ok(err instanceof GapsContentError);
      assert.equal(err.problems[0].ref, '13.10');
      assert.equal(err.problems[0].field, 'already_held');
      assert.equal(err.problems[0].tier, 'score');
      return true;
    }
  );
});

test('GAPS fails whole rather than writing a partially redacted sheet', async () => {
  // A half-redacted GAPS file looks finished and would be sent. Nothing is
  // written at all, so the operator has to fix the data (CW019 §3.4).
  await assert.rejects(
    () => buildGapsWorkbook({
      companyName: 'KardiaNova',
      items: [
        ROW({ ref: '1.1', already_held: 'Certificate held' }),
        ROW({ ref: '13.10', note_for_company: 'CASS Assessment Report (internal)' }),
      ],
    }),
    GapsContentError
  );
});

test('GAPS only inspects the rows it would actually write', async () => {
  // A 'held' row is not on the GAPS sheet, so its text cannot leak through it
  // and must not block the export of everything else.
  const buffer = await buildGapsWorkbook({
    companyName: 'KardiaNova',
    items: [
      ROW({ state: 'held', already_held: 'scored 5/5 in CASS' }),
      ROW({ ref: '1.1', already_held: 'Certificate held' }),
    ],
  });
  assert.ok(Buffer.isBuffer(buffer));
});

test('PRE-FILLED is internal and keeps naming its sources', async () => {
  // CW019 §3.4: the internal sheet is deliberately not guarded. Naming the CASS
  // report as the source on file is what its Source column is for.
  const buffer = await buildPrefilledWorkbook({
    companyName: 'KardiaNova',
    items: [ROW({
      already_held: 'scored 5/5 in CASS',
      source_document: 'CASS Assessment Report (internal)',
    })],
  });
  assert.ok(Buffer.isBuffer(buffer));
});

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

test('a template row carrying a CASS reference fails seed validation', () => {
  const problems = validateIrlSeed({
    itemCount: 1, sectionCount: 1,
    items: [{
      section: '13. Scientific', ref: '13.10', description: 'Assay validation pack',
      priority: 'high', sort_order: 1,
      already_held: 'CASS records completed Phase 2a work',
      note_for_company: null,
    }],
  });

  assert.equal(problems.length, 1);
  assert.match(problems[0], /ref 13\.10/);
  assert.match(problems[0], /already_held/);
});

test('the committed Biotech KSA seed still validates cleanly', () => {
  // Not a formality: this is the assertion that the guard has not become an
  // obstacle to the master list that actually ships.
  assert.deepEqual(validateIrlSeed(loadIrlSeed('biotech-ksa-irl-v1')), []);
});

// ---------------------------------------------------------------------------
// The write routes
// ---------------------------------------------------------------------------

const adminToken = tokenFor({ sub: 'admin-1', role: 'admin', name: 'Admin' });

async function withCompaniesApp(run) {
  const pool = fakePool([
    ['UPDATE company_irl_items', [{ id: 'item-1', ref: '13.10', already_held: null }]],
    ['SELECT COALESCE(MAX(sort_order)', [{ n: 5 }]],
    ['INSERT INTO company_irl_items', [{ id: 'item-2', ref: '99.1', note_for_company: null }]],
  ]);
  const server = await startTestServer([['/companies', companiesRouter]], pool);
  try {
    await run(server, pool);
  } finally {
    await server.close();
  }
}

test('PATCH refuses a CASS reference in alreadyHeld and names the field', async () => {
  await withCompaniesApp(async (server, pool) => {
    const res = await server.request('/companies/co-1/irl-items/item-1', {
      method: 'PATCH',
      token: adminToken,
      body: { alreadyHeld: 'CASS records completed Phase 2a work' },
    });

    assert.equal(res.status, 400);
    assert.equal(res.body.field, 'alreadyHeld');
    assert.match(res.body.term, /internal Taranis document|citation of CASS/);
    assert.match(res.body.error, /visible to the company/);

    // Refused before anything was written.
    assert.ok(!pool.sql().some((s) => s.includes('UPDATE company_irl_items')));
  });
});

test('PATCH refuses a score in noteForCompany', async () => {
  await withCompaniesApp(async (server) => {
    const res = await server.request('/companies/co-1/irl-items/item-1', {
      method: 'PATCH',
      token: adminToken,
      body: { noteForCompany: 'You achieved a STRONG rating of 77/100' },
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.field, 'noteForCompany');
  });
});

test('PATCH accepts the same text in internalNote, which is where it belongs', async () => {
  await withCompaniesApp(async (server, pool) => {
    const res = await server.request('/companies/co-1/irl-items/item-1', {
      method: 'PATCH',
      token: adminToken,
      body: { internalNote: 'CASS records completed Phase 2a work, scored 5/5' },
    });

    assert.equal(res.status, 200);
    assert.ok(pool.sql().some((s) => s.includes('internal_note =')));
  });
});

test('PATCH accepts an internal source in sourceDocument, which is not company-visible', async () => {
  // The exemption Mark confirmed on 31 August 2026: this column feeds the
  // internal PRE-FILLED sheet's "Source document on file" and appears in no
  // company-facing response, export or email.
  await withCompaniesApp(async (server, pool) => {
    const res = await server.request('/companies/co-1/irl-items/item-1', {
      method: 'PATCH',
      token: adminToken,
      body: { sourceDocument: 'CASS Assessment Report (internal)' },
    });

    assert.equal(res.status, 200);
    assert.ok(pool.sql().some((s) => s.includes('source_document =')));
  });
});

test('PATCH still accepts ordinary prose', async () => {
  await withCompaniesApp(async (server) => {
    const res = await server.request('/companies/co-1/irl-items/item-1', {
      method: 'PATCH',
      token: adminToken,
      body: {
        alreadyHeld: 'Certificate of incorporation dated 14/8/2026',
        noteForCompany: 'Completed at our CASS pre-screen stage; please send the audited FY2024/25 accounts',
      },
    });
    assert.equal(res.status, 200);
  });
});

test('the ad hoc item route refuses a CASS reference in noteForCompany', async () => {
  await withCompaniesApp(async (server, pool) => {
    const res = await server.request('/companies/co-1/irl-items', {
      method: 'POST',
      token: adminToken,
      body: {
        section: '13. Scientific',
        ref: '99.1',
        description: 'Assay validation pack',
        noteForCompany: 'Summarised in CASS/HELIX8',
      },
    });

    assert.equal(res.status, 400);
    assert.equal(res.body.field, 'noteForCompany');
    assert.ok(!pool.sql().some((s) => s.includes('INSERT INTO company_irl_items')));
  });
});

// ---------------------------------------------------------------------------
// The export route
// ---------------------------------------------------------------------------

async function withExportApp(itemRows, run) {
  const pool = fakePool([
    ['SELECT legal_name FROM companies', [{ legal_name: 'KardiaNova' }]],
    ['FROM company_irl_items WHERE company_id', itemRows],
  ]);
  const server = await startTestServer([['/companies', companiesRouter]], pool);
  try {
    await run(server, pool);
  } finally {
    await server.close();
  }
}

test('GET /export?format=gaps answers 409 and names the refs', async () => {
  await withExportApp([ROW({ already_held: 'scored 5/5 in CASS' })], async (server) => {
    const res = await server.request('/companies/co-1/export?format=gaps', { token: adminToken });

    // 409, not 500: nothing is broken, the stored data is not fit to send.
    assert.equal(res.status, 409);
    assert.equal(res.body.problems[0].ref, '13.10');
    assert.equal(res.body.problems[0].field, 'already_held');
    assert.match(res.body.error, /internal note/);
  });
});

test('GET /export?format=prefilled succeeds over the same row', async () => {
  await withExportApp([ROW({ already_held: 'scored 5/5 in CASS' })], async (server) => {
    const res = await server.request('/companies/co-1/export?format=prefilled', { token: adminToken });
    assert.equal(res.status, 200);
  });
});

test('GET /export?format=gaps succeeds when the text is clean', async () => {
  await withExportApp([ROW({ already_held: 'Certificate held' })], async (server) => {
    const res = await server.request('/companies/co-1/export?format=gaps', { token: adminToken });
    assert.equal(res.status, 200);
  });
});
