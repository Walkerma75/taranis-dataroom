import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool, testConnection } from './db.js';
import { autoMigrate, autoSeed } from './db/bootstrap.js';
import { getStorage } from './services/storage.js';
import { getScanner } from './services/scanner.js';
import { getMailer } from './services/email.js';
import { startOutboxWorker } from './services/notifications.js';
import { startDigestWorker, digestConfigFromEnv } from './services/dd-digest.js';
import { startSesEventConsumer } from './services/ses-events.js';
import { assertConfigured as assertPortalUrl } from './services/links.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Route modules
import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import fundRoutes from './routes/funds.js';
import documentRoutes from './routes/documents.js';
import grantRoutes from './routes/grants.js';
import auditRoutes from './routes/audit.js';
import noticeRoutes from './routes/notices.js';
import companyRoutes, {
  reviewQueueRouter,
  companyFilesRouter,
  irlTemplatesRouter,
} from './routes/companies.js';
import companyPortalRoutes from './routes/company-portal.js';
import ddSummaryRoutes from './routes/dd-summary.js';
import maintenanceRoutes from './routes/maintenance.js';

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
    const storage = await getStorage();
    const scanner = getScanner();
    const mailer = await getMailer();
    res.json({
      status: 'ok',
      service: 'taranis-dataroom-api',
      database: 'connected',
      // Backend kinds only — never the bucket name or a host, this endpoint is
      // public. `scanner: "stub"` means company uploads are NOT being scanned
      // and stay quarantined; it is reported here for the same reason storage
      // is, so a task running without protection is visible rather than assumed.
      storage: storage.kind,
      scanner: scanner.kind,
      // Same reasoning again: `email: "log"` on a production task means
      // invitations and receipts are being queued and then printed to the log
      // instead of sent, which otherwise looks identical to working.
      email: mailer.kind,
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

// Company DD portal. `/company/*` is the counterparty's own workspace and is
// the only mount that accepts role 'company'; everything else above and below
// rejects it explicitly.
app.use('/company', companyPortalRoutes);
app.use('/companies', companyRoutes);
app.use('/company-files', companyFilesRouter);
app.use('/review-queue', reviewQueueRouter);
app.use('/irl-templates', irlTemplatesRouter);

// The dashboard's due diligence panel and the nav badge. Admin-gated inside the
// router, and narrower than the two mounts above on purpose: see its header.
app.use('/dd-summary', ddSummaryRoutes);

// Operator-only actions that need the task's own credentials (see the module
// header for why these are not scripts). Admin-gated inside the router.
app.use('/maintenance', maintenanceRoutes);

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
(async () => {
  try {
    await testConnection();
    await autoMigrate();
    await autoSeed();

    // Say which store documents will be written to, so a misconfigured
    // deployment is obvious in the task logs rather than at first upload.
    const storage = await getStorage();
    console.log(`[storage] Documents backed by ${storage.describe()}`);

    // Same reasoning as the storage line: a task running an unscanned upload
    // path must be visible in the logs, never assumed. With the Phase 1a stub
    // this prints a warning on every boot, deliberately.
    const scanner = getScanner();
    if (scanner.kind === 'stub') {
      console.warn(`[scanner] ${scanner.describe()}`);
      console.warn(
        '[scanner] Company uploads will be accepted and served WITHOUT being ' +
        'scanned. This is an accepted beta risk, not a defect (HANDOVER-C004 ' +
        '§3.1), and the trigger to revisit it is widening the client cohort. ' +
        'See MIGRATION-INVENTORY.md §12.'
      );
    } else {
      console.log(`[scanner] Company uploads scanned by ${scanner.describe()}`);
    }

    // Before anything can be sent: every template links back to the portal, and
    // in production a missing PORTAL_URL would put a dead link in the first
    // message a counterparty ever receives from us. This throws rather than
    // warns, so the task fails to start instead of sending broken invitations.
    assertPortalUrl();

    const mailer = await getMailer();
    if (mailer.kind === 'log') {
      console.warn(`[email] ${mailer.describe()}`);
      console.warn(
        '[email] Notifications will be queued and then printed rather than '
        + 'sent. On a production task this means invitations and receipts are '
        + 'NOT reaching anyone.'
      );
    } else {
      console.log(`[email] ${mailer.describe()}`);
    }

    // The outbox drain. A plain interval in this process, per the code brief
    // §4: no queue service, no scheduler, no second container.
    startOutboxWorker();

    // The daily outstanding-actions digest. Same arrangement as the outbox for
    // the same reason, and off unless DD_DIGEST_ENABLED is set, which it is not
    // until the wording is approved. Say which, so a task that is silently not
    // sending it is visible in the logs rather than assumed to be working.
    const digest = digestConfigFromEnv();
    if (digest.enabled) {
      console.log(
        `[dd-digest] Enabled: one digest each weekday from ${digest.hourLocal}:00 `
        + `at UTC+${digest.utcOffsetHours}, when anything is outstanding.`
      );
    } else {
      console.log('[dd-digest] Disabled (DD_DIGEST_ENABLED is not "true"). No digest will be sent.');
    }
    startDigestWorker();

    // Bounce and complaint ingestion. Does nothing and says so until
    // SES_EVENTS_QUEUE_URL is set, which waits on the console work in
    // HANDOVER-C011 §3.3.
    await startSesEventConsumer();
  } catch (err) {
    console.error('[startup] Failed to initialise:', err.message);
    process.exit(1);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[api] Taranis Data Room API listening on port ${PORT}`);
  });
})();
