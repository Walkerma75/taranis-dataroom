/**
 * Seed script — creates initial admin user and the three launch funds.
 * Run once after migrations: npm run seed
 *
 * Default admin: admin@taraniscapital.com / REDACTED-SEED-PASSWORD
 * (Change immediately in production.)
 */
import argon2 from 'argon2';
import { pool } from '../db.js';

async function seed() {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // -----------------------------------------------------------------------
    // Admin user
    // -----------------------------------------------------------------------
    const passwordHash = await argon2.hash('REDACTED-SEED-PASSWORD', {
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

    const { rows: [admin] } = await client.query(`
      INSERT INTO users (email, display_name, password_hash, role, status, capabilities)
      VALUES ('admin@taraniscapital.com', 'Mark Walker', $1, 'admin', 'active', $2::jsonb)
      ON CONFLICT (email) DO UPDATE SET password_hash = $1, status = 'active', capabilities = $2::jsonb
      RETURNING id
    `, [passwordHash, adminCaps]);

    console.log(`[seed] Admin user: admin@taraniscapital.com (${admin.id})`);

    // -----------------------------------------------------------------------
    // Three launch funds
    // -----------------------------------------------------------------------
    const funds = [
      { name: 'Taranis Biotech Fund', slug: 'biotech', description: 'Life sciences and biotechnology investment fund' },
      { name: 'Taranis Datacentre Fund', slug: 'datacentre', description: 'Digital infrastructure and datacentre investment fund' },
      { name: 'Taranis Property Fund', slug: 'property', description: 'Real estate and property investment fund' },
    ];

    for (const fund of funds) {
      const { rows: [f] } = await client.query(`
        INSERT INTO funds (name, slug, description, status)
        VALUES ($1, $2, $3, 'active')
        ON CONFLICT (slug) DO NOTHING
        RETURNING id
      `, [fund.name, fund.slug, fund.description]);

      if (f) {
        console.log(`[seed] Fund: ${fund.name} (${f.id})`);
      } else {
        console.log(`[seed] Fund: ${fund.name} (already exists)`);
      }
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
