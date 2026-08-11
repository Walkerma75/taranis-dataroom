/**
 * Bringing an empty database up to a working one: run the migrations, then
 * create the founding admin if there is not one.
 *
 * Both functions used to live in `index.js` and ran only at startup. They were
 * moved here unchanged so the go-live reset can call them too — a reset that
 * drops the schema has to rebuild it in the same request, or it would leave the
 * running task serving a database with no tables in it.
 */
import fs from 'fs';
import path from 'path';
import argon2 from 'argon2';
import { fileURLToPath } from 'url';
import { pool } from '../db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

/**
 * Apply every migration that has not run yet, each in its own transaction.
 *
 * A failure throws rather than warns, so a bad migration fails the rollout
 * instead of half-applying: `index.js` awaits this before `listen()`.
 */
export async function autoMigrate({ dir = MIGRATIONS_DIR, db = pool } = {}) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      run_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  const { rows } = await db.query('SELECT name FROM _migrations ORDER BY name');
  const completed = new Set(rows.map((r) => r.name));

  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

  let ran = 0;
  for (const file of files) {
    if (completed.has(file)) continue;
    const sql = fs.readFileSync(path.join(dir, file), 'utf-8');
    console.log(`[migrate] Running ${file}...`);
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO _migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      ran++;
      console.log(`[migrate] ✓ ${file}`);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`[migrate] ✗ ${file}:`, err.message);
      throw err;
    } finally {
      client.release();
    }
  }

  if (ran === 0) console.log('[migrate] All migrations already applied.');
  else console.log(`[migrate] Applied ${ran} migration(s).`);

  return { applied: ran, total: files.length };
}

export const ADMIN_CAPABILITIES = {
  canManageUsers: true,
  canManageFunds: true,
  canUploadDocuments: true,
  canViewAudit: true,
  canDownloadDocuments: true,
  canViewDocuments: true,
};

/**
 * Create the founding admin, if there is not one already.
 *
 * Never updates an existing admin's password from here, even if
 * SEED_ADMIN_PASSWORD happens to be set.
 */
export async function autoSeed({ db = pool, env = process.env } = {}) {
  const { rows } = await db.query("SELECT id FROM users WHERE email = 'admin@taraniscapital.com'");
  if (rows.length > 0) {
    console.log('[seed] Admin user already exists — skipping seed.');
    return { seeded: false };
  }

  const password = env.SEED_ADMIN_PASSWORD;
  if (!password) {
    console.error('[seed] No admin user found and SEED_ADMIN_PASSWORD is not set.');
    console.error('[seed] Set SEED_ADMIN_PASSWORD (e.g. via AWS Secrets Manager) and restart,');
    console.error('[seed] or create the admin user directly in the database, then restart.');
    throw new Error('SEED_ADMIN_PASSWORD required for first-boot admin creation');
  }

  console.log('[seed] No admin user found — creating initial admin account.');
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const passwordHash = await argon2.hash(password, {
      type: argon2.argon2id,
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 4,
    });

    await client.query(`
      INSERT INTO users (email, display_name, password_hash, role, status, capabilities)
      VALUES ('admin@taraniscapital.com', 'Mark Walker', $1, 'admin', 'active', $2::jsonb)
      ON CONFLICT (email) DO NOTHING
    `, [passwordHash, JSON.stringify(ADMIN_CAPABILITIES)]);

    await client.query('COMMIT');
    console.log('[seed] Admin user created.');
    return { seeded: true };
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[seed] Failed:', err.message);
    throw err;
  } finally {
    client.release();
  }
}
