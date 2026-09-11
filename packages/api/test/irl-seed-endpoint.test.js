/**
 * POST /irl-templates/seed — the admin-only IRL template importer.
 *
 * The endpoint exists so seeding a fund's master checklist does not need a shell
 * on a production container (HANDOVER-CW004 §6). That makes it a write path into
 * the one table every company's due diligence is measured against, reachable
 * over HTTP, so the guards and the transaction matter more than the feature.
 *
 * What is proved here:
 *   1. admin only — no token, a company token and every other fund-side role are
 *      all refused, and refused before any statement runs
 *   2. idempotent by upsert — a re-run rewrites nothing that already matches and
 *      says so, rather than duplicating items or renumbering refs
 *   3. one transaction — BEGIN before the first write, COMMIT after the last,
 *      ROLLBACK and no COMMIT on any failure
 *   4. validated before written — an invalid master reaches no INSERT at all
 *   5. audit-logged, with the counts
 *
 * The counts the endpoint reports are what Mark reads to confirm 146 items
 * without opening the database, so they are asserted rather than assumed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { fileURLToPath } from 'url';

import { irlTemplatesRouter } from '../src/routes/companies.js';
import {
  loadIrlSeed, availableSeeds, runIrlImport, describeImport, IrlSeedError,
} from '../src/db/seed-irl.js';
import { setPool, resetPool } from '../src/db.js';
import { fakePool, tokenFor, startTestServer } from './helpers/test-app.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_SEEDS = path.join(__dirname, 'fixtures', 'seeds');

const MOUNTS = [['/irl-templates', irlTemplatesRouter]];
const ADMIN = { sub: 'admin-1', role: 'admin', email: 'admin@taraniscapital.com' };

const FUND = { id: 'fund-biotech', slug: 'biotech-ksa', name: 'Biotech KSA Fund' };

/**
 * A pool that answers the importer's statements. `itemRows` decides, per call to
 * the item upsert, what the database gives back:
 *   [{ was_insert: true }]  the row was created
 *   [{ was_insert: false }] the row existed and was changed
 *   []                      the row existed and already matched, so was skipped
 */
function importerPool({ fund = FUND, itemRows = () => [{ was_insert: true }], funds = [FUND] } = {}) {
  let itemCall = 0;
  return fakePool([
    ['FROM funds WHERE slug', fund ? [fund] : []],
    ['SELECT slug FROM funds', funds.map((f) => ({ slug: f.slug }))],
    ['INSERT INTO irl_templates', [{ id: 'template-1' }]],
    ['INSERT INTO irl_template_items', () => itemRows(itemCall++)],
    ["FROM users WHERE role = 'admin'", [{ id: 'admin-1' }]],
    ['INSERT INTO audit_log', []],
  ]);
}

function seedBody(extra = {}) {
  return { fundSlug: 'biotech-ksa', seed: 'biotech-ksa-irl-v1', ...extra };
}

// ---------------------------------------------------------------------------
// 1. Admin only
// ---------------------------------------------------------------------------

test('the seed endpoint refuses an unauthenticated call', async (t) => {
  const pool = importerPool();
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  const res = await server.request('/irl-templates/seed', {
    method: 'POST', body: seedBody(),
  });
  assert.equal(res.status, 401);
  assert.equal(pool.calls.length, 0, 'nothing should have run');
});

test('the seed endpoint refuses a company token, and runs no statement', async (t) => {
  const pool = importerPool();
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  const token = tokenFor({ role: 'company', companyId: '11111111-1111-4111-8111-111111111111' });
  const res = await server.request('/irl-templates/seed', {
    method: 'POST', token, body: seedBody(),
  });

  // rejectCompanyRole sits ahead of requireRole('admin') on this router, exactly
  // as it does on every other fund-side mount.
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'Insufficient permissions');
  assert.equal(pool.calls.length, 0);
});

test('the seed endpoint refuses investor, advisor and viewer tokens', async (t) => {
  const pool = importerPool();
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  for (const role of ['investor', 'advisor', 'viewer']) {
    const res = await server.request('/irl-templates/seed', {
      method: 'POST', token: tokenFor({ role, sub: `user-${role}` }), body: seedBody(),
    });
    assert.equal(res.status, 403, `${role} should not be able to seed a template`);
  }
  assert.equal(pool.calls.length, 0);
});

test('an admin can seed, and the response reports the counts', async (t) => {
  const pool = importerPool();
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  const res = await server.request('/irl-templates/seed', {
    method: 'POST', token: tokenFor(ADMIN), body: seedBody(),
  });

  assert.equal(res.status, 200);
  // The numbers HANDOVER-CW004 §4 asks the seed to produce, reported back so the
  // caller can confirm 146 items without opening the database.
  assert.equal(res.body.total, 146);
  assert.equal(res.body.created, 146);
  assert.equal(res.body.updated, 0);
  assert.equal(res.body.skipped, 0);
  assert.equal(res.body.templateId, 'template-1');
  assert.equal(res.body.fund.slug, 'biotech-ksa');
  assert.equal(res.body.source, 'Biotech_KSA_IRL_Master_Seed_v1_06Aug2026.xlsx');
  assert.match(res.body.message, /146 items/);
});

test('the template is owned by the admin who called it, not the founding admin', async (t) => {
  const pool = importerPool();
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  await server.request('/irl-templates/seed', {
    method: 'POST', token: tokenFor({ ...ADMIN, sub: 'admin-mark' }), body: seedBody(),
  });

  const insert = pool.calls.find((c) => c.text.includes('INSERT INTO irl_templates'));
  assert.equal(insert.params[3], 'admin-mark');
  // And the "first admin by created_at" fallback is only for the CLI, which has
  // no user, so it must not have been consulted.
  assert.ok(!pool.sql().some((s) => s.includes("FROM users WHERE role = 'admin'")));
});

// ---------------------------------------------------------------------------
// 2. Idempotency — upsert, and honest about it
// ---------------------------------------------------------------------------

test('a second run reports every item as unchanged and creates nothing', async (t) => {
  // Every upsert conflicts and the DO UPDATE ... WHERE finds nothing to change,
  // so PostgreSQL returns no row: the shape of a genuine no-op re-run.
  const pool = importerPool({ itemRows: () => [] });
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  const res = await server.request('/irl-templates/seed', {
    method: 'POST', token: tokenFor(ADMIN), body: seedBody(),
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.created, 0);
  assert.equal(res.body.updated, 0);
  assert.equal(res.body.skipped, 146);
  assert.equal(res.body.total, 146);
  assert.match(res.body.message, /0 created, 0 updated, 146 unchanged/);
});

test('a changed master reports updates against unchanged rows, and renumbers nothing', async (t) => {
  // First row changed, the other 145 already match.
  const pool = importerPool({ itemRows: (n) => (n === 0 ? [{ was_insert: false }] : []) });
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  const res = await server.request('/irl-templates/seed', {
    method: 'POST', token: tokenFor(ADMIN), body: seedBody(),
  });

  assert.equal(res.body.created, 0);
  assert.equal(res.body.updated, 1);
  assert.equal(res.body.skipped, 145);

  // Refs are permanent identifiers a company quotes back. The upsert must key on
  // (template_id, ref) and must never delete, which is what makes that true.
  const itemSql = pool.sql().find((s) => s.includes('INSERT INTO irl_template_items'));
  assert.match(itemSql, /ON CONFLICT \(template_id, ref\) DO UPDATE/);
  assert.ok(!/\bref = EXCLUDED\.ref\b/.test(itemSql), 'ref must never be rewritten');
  assert.ok(!pool.sql().some((s) => /DELETE FROM irl_template_items/.test(s)));
});

test('the item upsert only writes rows that actually differ', async (t) => {
  const pool = importerPool();
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  await server.request('/irl-templates/seed', {
    method: 'POST', token: tokenFor(ADMIN), body: seedBody(),
  });

  const itemSql = pool.sql().find((s) => s.includes('INSERT INTO irl_template_items'));
  for (const column of [
    'section', 'description', 'priority', 'sort_order', 'already_held', 'note_for_company',
  ]) {
    assert.ok(
      itemSql.includes(`irl_template_items.${column}`),
      `the no-op guard should compare ${column}`
    );
  }
});

// ---------------------------------------------------------------------------
// 3. One transaction
// ---------------------------------------------------------------------------

test('the whole import runs in one transaction', async (t) => {
  const pool = importerPool();
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  await server.request('/irl-templates/seed', {
    method: 'POST', token: tokenFor(ADMIN), body: seedBody(),
  });

  const sql = pool.sql();
  const begins = sql.filter((s) => s === 'BEGIN');
  const commits = sql.filter((s) => s === 'COMMIT');
  assert.equal(begins.length, 1, 'exactly one transaction');
  assert.equal(commits.length, 1);
  assert.ok(!sql.includes('ROLLBACK'));

  const firstWrite = sql.findIndex((s) => s.includes('INSERT INTO irl_template'));
  const lastWrite = sql.map((s) => s.includes('INSERT INTO irl_template_items'))
    .lastIndexOf(true);
  assert.ok(sql.indexOf('BEGIN') < firstWrite, 'BEGIN must precede the first write');
  assert.ok(sql.indexOf('COMMIT') > lastWrite, 'COMMIT must follow the last write');
});

test('a failure part way through rolls back and never commits', async (t) => {
  let n = 0;
  const pool = fakePool([
    ['FROM funds WHERE slug', [FUND]],
    ['INSERT INTO irl_templates', [{ id: 'template-1' }]],
    ['INSERT INTO irl_template_items', () => {
      if (n++ === 40) throw new Error('connection reset');
      return [{ was_insert: true }];
    }],
    ['INSERT INTO audit_log', []],
  ]);
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  const res = await server.request('/irl-templates/seed', {
    method: 'POST', token: tokenFor(ADMIN), body: seedBody(),
  });

  assert.equal(res.status, 500);
  assert.equal(res.body.error, 'Internal server error');

  const sql = pool.sql();
  assert.ok(sql.includes('ROLLBACK'), 'a partial template must be rolled back');
  assert.ok(!sql.includes('COMMIT'), 'a partial template must never be committed');
  // A half-applied checklist is worse than none: nothing is audited as seeded.
  assert.ok(!sql.some((s) => s.includes('INSERT INTO audit_log')));
});

// ---------------------------------------------------------------------------
// 4. Validated before written
// ---------------------------------------------------------------------------

test('a seed name that tries to escape the seeds directory is refused', async (t) => {
  const pool = importerPool();
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  for (const name of ['../../../../etc/passwd', '..\\..\\secrets', '/etc/passwd', 'a/b']) {
    const res = await server.request('/irl-templates/seed', {
      method: 'POST', token: tokenFor(ADMIN), body: seedBody({ seed: name }),
    });
    assert.equal(res.status, 400, `${name} should be refused`);
    assert.match(res.body.error, /not a valid seed name/);
  }
  assert.equal(pool.calls.length, 0, 'a bad seed name must not open a transaction');
});

test('an unknown seed is refused and names the seeds that do ship', async (t) => {
  const pool = importerPool();
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  const res = await server.request('/irl-templates/seed', {
    method: 'POST', token: tokenFor(ADMIN), body: seedBody({ seed: 'no-such-master' }),
  });

  assert.equal(res.status, 400);
  assert.ok(res.body.available.includes('biotech-ksa-irl-v1'));
  assert.equal(pool.calls.length, 0);
});

test('a fundSlug is required', async (t) => {
  const pool = importerPool();
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  const res = await server.request('/irl-templates/seed', {
    method: 'POST', token: tokenFor(ADMIN), body: {},
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /fundSlug/);
  assert.equal(pool.calls.length, 0);
});

test('an unknown fund is a 404 that names the funds that exist', async (t) => {
  const pool = importerPool({
    fund: null,
    funds: [{ slug: 'biotech-ksa' }, { slug: 'datacentre' }],
  });
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  const res = await server.request('/irl-templates/seed', {
    method: 'POST', token: tokenFor(ADMIN), body: seedBody({ fundSlug: 'biotek-ksa' }),
  });

  assert.equal(res.status, 404);
  assert.deepEqual(res.body.availableFunds, ['biotech-ksa', 'datacentre']);
  assert.ok(!pool.sql().some((s) => s.includes('INSERT INTO irl_template')));
  assert.ok(pool.sql().includes('ROLLBACK'));
});

test('a master with repeated refs is refused before any row is written', async (t) => {
  const pool = importerPool();
  setPool(pool);
  t.after(() => resetPool());

  await assert.rejects(
    () => runIrlImport({
      fundSlug: 'biotech-ksa', seedName: 'duplicate-refs', seedsDir: FIXTURE_SEEDS,
    }),
    (err) => {
      assert.ok(err instanceof IrlSeedError);
      assert.equal(err.code, 'IRL_INVALID_SEED');
      assert.ok(err.problems.some((p) => p.includes('duplicate ref: 1.1')));
      return true;
    }
  );

  assert.ok(!pool.sql().some((s) => s.includes('INSERT INTO irl_template')));
  assert.ok(!pool.sql().includes('COMMIT'));
});

test('a master with a priority outside high, medium and standard is refused', async (t) => {
  const pool = importerPool();
  setPool(pool);
  t.after(() => resetPool());

  await assert.rejects(
    () => runIrlImport({
      fundSlug: 'biotech-ksa', seedName: 'bad-priority', seedsDir: FIXTURE_SEEDS,
    }),
    (err) => {
      assert.equal(err.code, 'IRL_INVALID_SEED');
      assert.ok(err.problems.some((p) => p.includes('unexpected priority "urgent"')));
      return true;
    }
  );

  assert.ok(!pool.sql().some((s) => s.includes('INSERT INTO irl_template')));
});

test('a valid master imports through runIrlImport and reports its counts', async (t) => {
  const pool = importerPool();
  setPool(pool);
  t.after(() => resetPool());

  const result = await runIrlImport({
    fundSlug: 'biotech-ksa', seedName: 'valid-tiny', seedsDir: FIXTURE_SEEDS,
  });

  assert.equal(result.total, 2);
  assert.equal(result.created, 2);
  assert.equal(result.templateName, 'Biotech KSA Fund Information Request List');
  assert.match(describeImport(result), /2 items: 2 created, 0 updated, 0 unchanged\./);
  assert.ok(pool.sql().includes('COMMIT'));
});

// ---------------------------------------------------------------------------
// 5. Audit
// ---------------------------------------------------------------------------

test('a successful seed writes one audit row carrying the counts', async (t) => {
  const pool = importerPool();
  const server = await startTestServer(MOUNTS, pool);
  t.after(() => server.close());

  await server.request('/irl-templates/seed', {
    method: 'POST', token: tokenFor({ ...ADMIN, sub: 'admin-mark' }), body: seedBody(),
  });

  const audits = pool.calls.filter((c) => c.text.includes('INSERT INTO audit_log'));
  assert.equal(audits.length, 1);

  const [userId, action, resource, resourceId, detail] = audits[0].params;
  assert.equal(userId, 'admin-mark');
  assert.equal(action, 'irl_template.seeded');
  assert.equal(resource, 'irl_template');
  assert.equal(resourceId, 'template-1');

  const parsed = JSON.parse(detail);
  assert.equal(parsed.fundSlug, 'biotech-ksa');
  assert.equal(parsed.total, 146);
  assert.equal(parsed.created, 146);
  assert.equal(parsed.seed, 'biotech-ksa-irl-v1');
  assert.equal(parsed.source, 'Biotech_KSA_IRL_Master_Seed_v1_06Aug2026.xlsx');

  // The audit table itself is untouched: one plain INSERT through logAudit and
  // nothing else. Its triggers and retention are a DFSA commitment.
  assert.ok(!pool.sql().some((s) => /(UPDATE|DELETE|ALTER|DROP)[^;]*audit_log/i.test(s)));
});

// ---------------------------------------------------------------------------
// The seed-name guard, directly
// ---------------------------------------------------------------------------

test('loadIrlSeed refuses a name that is not a plain seed name', () => {
  for (const name of ['../secrets', 'a/b', 'A-B', 'x.json', '', null, 123]) {
    assert.throws(() => loadIrlSeed(name), (err) => err.code === 'IRL_BAD_SEED_NAME');
  }
});

test('availableSeeds lists the committed Biotech master', () => {
  assert.ok(availableSeeds().includes('biotech-ksa-irl-v1'));
});
