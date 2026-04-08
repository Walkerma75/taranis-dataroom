import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import argon2 from 'argon2';
import { pool, testConnection } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Route modules
import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import fundRoutes from './routes/funds.js';
import documentRoutes from './routes/documents.js';
import grantRoutes from './routes/grants.js';
import auditRoutes from './routes/audit.js';
import noticeRoutes from './routes/notices.js';

const app = express();
const PORT = process.env.API_PORT || 4000;

// ---------------------------------------------------------------------------
// Global middleware
// ---------------------------------------------------------------------------
app.use(helmet());
app.use(cors({ origin: process.env.CORS_ORIGIN || 'http://localhost:5173' }));
app.use(express.json({ limit: '10mb' }));

// Rate limiting on auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: process.env.NODE_ENV === 'production' ? 20 : 200,
  message: { error: 'Too many attempts. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// Health check — public
app.get('/health', async (_req, res) => {
  try {
    const result = await pool.query('SELECT NOW() AS server_time');
    res.json({
      status: 'ok',
      service: 'taranis-dataroom-api',
      database: 'connected',
      serverTime: result.rows[0].server_time,
    });
  } catch (err) {
    res.status(503).json({
      status: 'degraded',
      service: 'taranis-dataroom-api',
      database: 'disconnected',
      error: err.message,
    });
  }
});

app.get('/', (_req, res) => {
  res.json({ message: 'Taranis Data Room API' });
});

// Auth (rate-limited)
app.use('/auth', authLimiter, authRoutes);

// Protected API routes
app.use('/users', userRoutes);
app.use('/funds', fundRoutes);
app.use('/documents', documentRoutes);
app.use('/grants', grantRoutes);
app.use('/audit', auditRoutes);
app.use('/notices', noticeRoutes);

// ---------------------------------------------------------------------------
// Error handler
// ---------------------------------------------------------------------------
app.use((err, _req, res, _next) => {
  console.error('[api] Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ---------------------------------------------------------------------------
// Auto-migrate & seed on startup
// ---------------------------------------------------------------------------
async function autoMigrate() {
  const MIGRATIONS_DIR = path.join(__dirname, 'db', 'migrations');

  // Ensure _migrations table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      run_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  const { rows } = await pool.query('SELECT name FROM _migrations ORDER BY name');
  const completed = new Set(rows.map((r) => r.name));

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
      throw err;
    } finally {
      client.release();
    }
  }

  if (ran === 0) {
    console.log('[migrate] All migrations already applied.');
  } else {
    console.log(`[migrate] Applied ${ran} migration(s).`);
  }
}

async function autoSeed() {
  // Check if admin user already exists
  const { rows } = await pool.query("SELECT id FROM users WHERE email = 'admin@taraniscapital.com'");
  if (rows.length > 0) {
    console.log('[seed] Admin user already exists — skipping seed.');
    return;
  }

  console.log('[seed] Seeding initial data...');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

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

    await client.query(`
      INSERT INTO users (email, display_name, password_hash, role, status, capabilities)
      VALUES ('admin@taraniscapital.com', 'Mark Walker', $1, 'admin', 'active', $2::jsonb)
      ON CONFLICT (email) DO UPDATE SET password_hash = $1, status = 'active', capabilities = $2::jsonb
    `, [passwordHash, adminCaps]);

    const funds = [
      { name: 'Taranis Biotech Fund', slug: 'biotech', description: 'Life sciences and biotechnology investment fund' },
      { name: 'Taranis Datacentre Fund', slug: 'datacentre', description: 'Digital infrastructure and datacentre investment fund' },
      { name: 'Taranis Property Fund', slug: 'property', description: 'Real estate and property investment fund' },
    ];
    for (const fund of funds) {
      await client.query(`
        INSERT INTO funds (name, slug, description, status)
        VALUES ($1, $2, $3, 'active')
        ON CONFLICT (slug) DO NOTHING
      `, [fund.name, fund.slug, fund.description]);
    }

    await client.query('COMMIT');
    console.log('[seed] Done — admin user and funds created.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[seed] Failed:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
(async () => {
  try {
    await testConnection();
    await autoMigrate();
    await autoSeed();
  } catch (err) {
    console.error('[startup] Failed to initialise database:', err.message);
    process.exit(1);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[api] Taranis Data Room API listening on port ${PORT}`);
  });
})();
