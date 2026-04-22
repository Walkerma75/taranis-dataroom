import pg from 'pg';

const { Pool } = pg;

// Respect PGSSLMODE the way libpq does: any value other than `disable` means
// TLS is required. node-postgres does not verify the server cert by default
// when given `ssl: true`; it hands off to Node's global TLS validator, which
// does not trust the Amazon RDS root CAs. Until we bundle the RDS CA chain
// (see TASKS.md #13 / verify-full upgrade), we encrypt-without-verify — same
// posture the container had while NODE_TLS_REJECT_UNAUTHORIZED=0 was set, but
// scoped to this connection rather than disabling TLS validation globally.
const sslMode = process.env.PGSSLMODE;
const sslConfig = (sslMode && sslMode !== 'disable')
  ? { rejectUnauthorized: false }
  : false;

export const pool = new Pool({
  user: process.env.POSTGRES_USER || 'taranis',
  password: process.env.POSTGRES_PASSWORD || 'changeme_local_only',
  host: process.env.POSTGRES_HOST || 'localhost',
  port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
  database: process.env.POSTGRES_DB || 'dataroom',
  ssl: sslConfig,
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

/**
 * Quick connectivity check — called once at startup.
 */
export async function testConnection() {
  try {
    const res = await pool.query('SELECT current_database() AS db');
    console.log(`[db] Connected to PostgreSQL — database: ${res.rows[0].db}`);
  } catch (err) {
    console.error('[db] Failed to connect to PostgreSQL:', err.message);
  }
}
