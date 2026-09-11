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

const realPool = new Pool({
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

let activePool = realPool;

/**
 * The pool every module imports. It is a thin facade rather than the `pg.Pool`
 * itself so a test can swap the implementation underneath without touching a
 * single call site — the same injection pattern the storage service uses.
 *
 * `pg.Pool` does not open a socket until the first query, so importing this
 * module in a test costs nothing and connects to nothing.
 */
export const pool = {
  query: (...args) => activePool.query(...args),
  connect: (...args) => activePool.connect(...args),
  end: (...args) => activePool.end(...args),
};

/** Swap in a fake pool. Tests only. */
export function setPool(replacement) {
  activePool = replacement;
}

/** Restore the real pool. */
export function resetPool() {
  activePool = realPool;
}

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
