import pg from 'pg';

const { Pool } = pg;

export const pool = new Pool({
  user: process.env.POSTGRES_USER || 'taranis',
  password: process.env.POSTGRES_PASSWORD || 'changeme_local_only',
  host: process.env.POSTGRES_HOST || 'localhost',
  port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
  database: process.env.POSTGRES_DB || 'dataroom',
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
