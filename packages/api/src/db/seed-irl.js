/**
 * Import an Information Request List master into an `irl_templates` row and its
 * items, from the committed JSON seed under `src/db/seeds/`.
 *
 *   npm -w packages/api run seed:irl -- --fund biotech-ksa
 *   npm -w packages/api run seed:irl -- --fund biotech-ksa --seed biotech-ksa-irl-v1
 *
 * The same work is reachable without a shell on the container, over
 * `POST /api/irl-templates/seed` (admin only). Both callers go through
 * `runIrlImport()` below, so there is one importer and one set of rules, not a
 * CLI copy and an HTTP copy that drift apart.
 *
 * Idempotent, by UPSERT rather than by refusal. Running it twice against the
 * same fund updates the existing template's rows in place rather than creating a
 * second template or duplicating items, because `(template_id, ref)` is unique
 * and refs are permanent. A row whose values already match is left untouched and
 * counted as skipped. Nothing is ever renumbered and nothing is deleted: a ref
 * that disappears from the master stays on the template, because a company may
 * already have been asked for it.
 *
 * Seeding a COMPANY is a separate step and happens on activation
 * (`POST /companies/:id/activate`), which copies these rows into
 * `company_irl_items`.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool } from '../db.js';
import { findUnsafeRowText, describeUnsafe } from '../services/company-visible-text.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SEEDS_DIR = path.join(__dirname, 'seeds');

/**
 * Seed names are filenames. The endpoint takes one from a request body, so the
 * shape is constrained here rather than at the route: no separators, no dots, no
 * traversal, whoever the caller is.
 */
const SEED_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** An error the route layer can map to a status code instead of a blanket 500. */
export class IrlSeedError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'IrlSeedError';
    this.code = code;
    Object.assign(this, detail);
  }
}

/** The committed seed artefacts, by name, for error messages and callers. */
export function availableSeeds(dir = SEEDS_DIR) {
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -'.json'.length))
    .sort();
}

/** Read and validate a committed seed artefact. */
export function loadIrlSeed(name = 'biotech-ksa-irl-v1', dir = SEEDS_DIR) {
  if (typeof name !== 'string' || !SEED_NAME_PATTERN.test(name)) {
    throw new IrlSeedError(
      'IRL_BAD_SEED_NAME',
      `"${name}" is not a valid seed name`,
      { available: availableSeeds(dir) }
    );
  }

  const file = path.join(dir, `${name}.json`);
  if (!fs.existsSync(file)) {
    throw new IrlSeedError(
      'IRL_NO_SUCH_SEED',
      `No seed named "${name}" ships with this build`,
      { available: availableSeeds(dir) }
    );
  }

  const seed = JSON.parse(fs.readFileSync(file, 'utf8'));
  const problems = validateIrlSeed(seed);
  if (problems.length) {
    throw new IrlSeedError(
      'IRL_INVALID_SEED',
      `Seed ${name} is invalid:\n  ${problems.join('\n  ')}`,
      { problems }
    );
  }
  return seed;
}

/**
 * The checks that must hold before anything reaches the database. They are a
 * separate exported function so the test suite runs exactly the same rules
 * against the committed artefact.
 */
export function validateIrlSeed(seed) {
  const problems = [];
  if (!seed || !Array.isArray(seed.items)) return ['no items array'];

  const refs = new Set();
  for (const item of seed.items) {
    if (!item.ref) problems.push('an item has no ref');
    if (refs.has(item.ref)) problems.push(`duplicate ref: ${item.ref}`);
    refs.add(item.ref);
    if (!item.section) problems.push(`ref ${item.ref}: no section`);
    if (!item.description) problems.push(`ref ${item.ref}: no description`);
    if (!['high', 'medium', 'standard'].includes(item.priority)) {
      problems.push(`ref ${item.ref}: unexpected priority "${item.priority}"`);
    }
    if (!Number.isInteger(item.sort_order)) {
      problems.push(`ref ${item.ref}: sort_order is not an integer`);
    }

    // A master sheet carrying a CASS score or an internal source must not reach
    // the database, because everything downstream of the template treats its
    // text as sendable: activation copies these two columns into every
    // company's checklist, and from there they are the GAPS sheet's "We already
    // hold" and "Notes for company". Refusing here is the cheapest place to
    // catch it, and it refuses the whole import rather than the row
    // (HANDOVER-CW019 §3.3).
    for (const hit of findUnsafeRowText(item)) {
      problems.push(describeUnsafe(hit));
    }
  }

  // The declared counts in the artefact must agree with its own contents, so a
  // hand-edited file cannot pass silently.
  if (seed.itemCount !== seed.items.length) {
    problems.push(`itemCount says ${seed.itemCount} but there are ${seed.items.length} items`);
  }
  const sections = new Set(seed.items.map((i) => i.section));
  if (seed.sectionCount !== sections.size) {
    problems.push(`sectionCount says ${seed.sectionCount} but there are ${sections.size} sections`);
  }
  return problems;
}

/**
 * Create or update the template for a fund from a seed.
 *
 * Runs inside whatever transaction `client` belongs to; `runIrlImport()` is what
 * supplies one, and passes an already-validated `seed`.
 *
 * @returns {Promise<{templateId, templateName, fund, seedName, source,
 *                    created, updated, skipped, total}>}
 */
export async function importIrlTemplate({
  fundSlug, seedName, seed: preloaded, templateName, createdBy,
  seedsDir = SEEDS_DIR, client = pool,
}) {
  const seed = preloaded || loadIrlSeed(seedName, seedsDir);

  const { rows: [fund] } = await client.query(
    `SELECT id, name, slug FROM funds WHERE slug = $1`, [fundSlug]
  );
  if (!fund) {
    const { rows: funds } = await client.query(`SELECT slug FROM funds ORDER BY slug`);
    throw new IrlSeedError(
      'IRL_NO_FUND',
      `No fund with slug "${fundSlug}"`,
      { availableFunds: funds.map((f) => f.slug) }
    );
  }

  // The template is owned by whoever asked for it. The CLI has no user, so it
  // falls back to the founding admin, as it always did.
  let ownerId = createdBy;
  if (!ownerId) {
    const { rows: [admin] } = await client.query(
      `SELECT id FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1`
    );
    if (!admin) throw new IrlSeedError('IRL_NO_ADMIN', 'No admin user exists to own the template');
    ownerId = admin.id;
  }

  const name = templateName || `${fund.name} Information Request List`;

  const { rows: [template] } = await client.query(
    `INSERT INTO irl_templates (fund_id, name, version, source, created_by)
     VALUES ($1, $2, 1, $3, $4)
     ON CONFLICT (fund_id, name, version) DO UPDATE SET source = EXCLUDED.source
     RETURNING id`,
    [fund.id, name, seed.source, ownerId]
  );

  let created = 0;
  let updated = 0;
  let skipped = 0;
  for (const item of seed.items) {
    // The WHERE on DO UPDATE is what makes 'skipped' meaningful: a row that
    // already matches the master is not rewritten, so a re-run reports honestly
    // that it changed nothing rather than claiming 146 updates.
    const { rows: [row] } = await client.query(
      `INSERT INTO irl_template_items
         (template_id, section, ref, description, priority, sort_order,
          already_held, note_for_company)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (template_id, ref) DO UPDATE
         SET section = EXCLUDED.section,
             description = EXCLUDED.description,
             priority = EXCLUDED.priority,
             sort_order = EXCLUDED.sort_order,
             already_held = EXCLUDED.already_held,
             note_for_company = EXCLUDED.note_for_company
         WHERE irl_template_items.section          IS DISTINCT FROM EXCLUDED.section
            OR irl_template_items.description      IS DISTINCT FROM EXCLUDED.description
            OR irl_template_items.priority         IS DISTINCT FROM EXCLUDED.priority
            OR irl_template_items.sort_order       IS DISTINCT FROM EXCLUDED.sort_order
            OR irl_template_items.already_held     IS DISTINCT FROM EXCLUDED.already_held
            OR irl_template_items.note_for_company IS DISTINCT FROM EXCLUDED.note_for_company
       RETURNING (xmax = 0) AS was_insert`,
      [
        template.id, item.section, item.ref, item.description, item.priority,
        item.sort_order, item.already_held, item.note_for_company,
      ]
    );
    // No row back means the conflict target matched and the WHERE was false:
    // the item is already exactly as the master has it.
    if (!row) skipped++;
    else if (row.was_insert) created++;
    else updated++;
  }

  return {
    templateId: template.id,
    templateName: name,
    fund: { id: fund.id, slug: fund.slug, name: fund.name },
    seedName: seedName || 'biotech-ksa-irl-v1',
    source: seed.source,
    created, updated, skipped,
    total: seed.items.length,
  };
}

/**
 * `importIrlTemplate` in one transaction, from the pool.
 *
 * A partially applied template is worse than a failed import: a company would be
 * activated against a checklist missing rows nobody knew were missing. All or
 * nothing, every time.
 *
 * The seed is read and validated BEFORE a connection is taken, so a bad request
 * does not open a transaction, does not hold a pool connection and cannot write
 * a row under any failure mode.
 */
export async function runIrlImport({ seedName, seedsDir = SEEDS_DIR, ...opts } = {}) {
  const seed = loadIrlSeed(seedName, seedsDir);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await importIrlTemplate({ ...opts, seedName, seed, client });
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** One line a human can read, used by both the CLI and the endpoint response. */
export function describeImport(r) {
  return `${r.templateName}. ${r.total} items: `
       + `${r.created} created, ${r.updated} updated, ${r.skipped} unchanged.`;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? fallback : process.argv[i + 1];
}

if (process.argv[1] && process.argv[1].endsWith('seed-irl.js')) {
  const fundSlug = arg('--fund');
  if (!fundSlug) {
    console.error('Usage: npm -w packages/api run seed:irl -- --fund <fund-slug> [--seed <seed-name>]');
    process.exit(1);
  }

  try {
    const result = await runIrlImport({
      fundSlug,
      seedName: arg('--seed', 'biotech-ksa-irl-v1'),
      templateName: arg('--name'),
    });
    console.log(`[seed:irl] Template ${result.templateId}`);
    console.log(`[seed:irl] ${describeImport(result)}`);
    await pool.end();
  } catch (err) {
    console.error(`[seed:irl] Failed: ${err.message}`);
    process.exit(1);
  }
}
