import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { pool, testConnection } from './db.js';

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
// Start
// ---------------------------------------------------------------------------
app.listen(PORT, '0.0.0.0', async () => {
  console.log(`[api] Taranis Data Room API listening on port ${PORT}`);
  await testConnection();
});
