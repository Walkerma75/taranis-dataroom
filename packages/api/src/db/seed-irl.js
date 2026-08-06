/**
 * Import an Information Request List master into an `irl_templates` row and its
 * items, from the committed JSON seed under `src/db/seeds/`.
 *
 *   npm -w packages/api run seed:irl -- --fund biotech-ksa
 *   npm -w packages/api run seed:irl -- --fund biotech-ksa --seed biotech-ksa-irl-v1
 *
 * Idempotent. Running it twice against the same fund updates the existing
 * template's rows in place rather than creating a second template or
 * duplicating items, because `(template_id, ref)` is unique and refs are
 * permanent. Nothing is ever renumbered and nothing is deleted: a ref that
 * disappears from the master stays on the template, because a company may
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SEEDS_DIR = path.join(__dirname, 'seeds');

/** Read and validate a committed seed artefact. */
export function loadIrlSeed(name = 'biotech-ksa-irl-v1') {
  const file = path.join(SEEDS_DIR, `${name}.json`);
  const seed = JSON.parse(fs.readFileSync(file, 'utf8'));
  const problems = validateIrlSeed(seed);
  if (problems.length) {
    throw new Error(`Seed ${name} is invalid:\n  ${problems.join('\n  ')}`);
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
 * @returns {Promise<{templateId, inserted, updated, total}>}
 */
export async function importIrlTemplate({ fundSlug, seedName, templateName, client = pool }) {
  const seed = loadIrlSeed(seedName);

  const { rows: [fund] } = await client.query(
    `SELECT id, name FROM funds WHERE slug = $1`, [fundSlug]
  );
  if (!fund) throw new Error(`No fund with slug "${fundSlug}"`);

  const { rows: [admin] } = await client.query(
    `SELECT id FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1`
  );
  if (!admin) throw new Error('No admin user exists to own the template');

  const name = templateName || `${fund.name} Information Request List`;

  const { rows: [template] } = await client.query(
    `INSERT INTO irl_templates (fund_id, name, version, source, created_by)
     VALUES ($1, $2, 1, $3, $4)
     ON CONFLICT (fund_id, name, version) DO UPDATE SET source = EXCLUDED.source
     RETURNING id`,
    [fund.id, name, seed.source, admin.id]
  );

  let inserted = 0;
  let updated = 0;
  for (const item of seed.items) {
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
       RETURNING (xmax = 0) AS was_insert`,
      [
        template.id, item.section, item.ref, item.description, item.priority,
        item.sort_order, item.already_held, item.note_for_company,
      ]
    );
    if (row.was_insert) inserted++; else updated++;
  }

  return { templateId: template.id, inserted, updated, total: seed.items.length };
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
    const result = await importIrlTemplate({
      fundSlug,
      seedName: arg('--seed', 'biotech-ksa-irl-v1'),
      templateName: arg('--name'),
    });
    console.log(`[seed:irl] Template ${result.templateId}`);
    console.log(`[seed:irl] ${result.total} items: ${result.inserted} inserted, ${result.updated} updated`);
    await pool.end();
  } catch (err) {
    console.error(`[seed:irl] Failed: ${err.message}`);
    process.exit(1);
  }
}
