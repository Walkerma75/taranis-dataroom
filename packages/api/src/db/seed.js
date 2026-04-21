/**
 * Seed script — creates the initial admin user only.
 * Run once after migrations: npm run seed
 *
 * Requires SEED_ADMIN_PASSWORD in the environment. No default.
 * If the admin user already exists, the seed is a no-op — this script
 * never resets an existing admin's password.
 *
 * Funds, document categories and other reference data are NOT seeded
 * here. Document categories are seeded by migration 002; funds are
 * created through the admin UI after first login.
 */
import argon2 from 'argon2';
import { pool } from '../db.js';

async function seed() {
  const password = process.env.SEED_ADMIN_PASSWORD;
  if (!password) {
    console.error('[seed] SEED_ADMIN_PASSWORD is not set. Aborting.');
    console.error('[seed] Provide an initial password for admin@taraniscapital.com and re-run.');
    process.exit(1);
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const passwordHash = await argon2.hash(password, {
      type: argon2.argon2id,
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 4,
    });

    const adminCaps = JSON.stringify({
      canManageUsers: true,
      canManageFunds: true,
      canUploadDocuments: true,
      canViewAudit: true,
      canDownloadDocuments: true,
      canViewDocuments: true,
    });

    const { rows } = await client.query(`
      INSERT INTO users (email, display_name, password_hash, role, status, capabilities)
      VALUES ('admin@taraniscapital.com', 'Mark Walker', $1, 'admin', 'active', $2::jsonb)
      ON CONFLICT (email) DO NOTHING
      RETURNING id
    `, [passwordHash, adminCaps]);

    if (rows.length > 0) {
      console.log(`[seed] Admin user created: admin@taraniscapital.com (${rows[0].id})`);
    } else {
      console.log('[seed] Admin user already exists — left untouched (password not reset).');
    }

    await client.query('COMMIT');
    console.log('[seed] Done.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[seed] Failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

seed();
