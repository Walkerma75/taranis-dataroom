/**
 * Simple file-based migration runner.
 * Reads SQL files from ./migrations in alphabetical order,
 * tracks which have run in a `_migrations` table.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool } from '../db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

async function ensureMigrationsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      run_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function getCompletedMigrations() {
  const { rows } = await pool.query('SELECT name FROM _migrations ORDER BY name');
  return new Set(rows.map((r) => r.name));
}

async function runMigrations() {
  await ensureMigrationsTable();
  const completed = await getCompletedMigrations();

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  let ran = 0;
  for (const file of files) {
    if (completed.has(file)) continue;

    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
    console.log(`[migrate] Running ${file}...`);

    const client = await pool.connect();
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
      process.exit(1);
    } finally {
      client.release();
    }
  }

  if (ran === 0) {
    console.log('[migrate] All migrations already applied.');
  } else {
    console.log(`[migrate] Applied ${ran} migration(s).`);
  }

  await pool.end();
}

runMigrations();
