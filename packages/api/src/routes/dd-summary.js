/**
 * GET /dd-summary — every outstanding due diligence action, in one call.
 *
 * WHY ONE ENDPOINT. The dashboard needs per-company figures for every active
 * counterparty at once. Fanning out a request per company would put the page's
 * cost on the number of companies in the pipeline, which is the number that is
 * expected to grow. CW020 §5 asks for a single cheap query set and not N+1, so
 * this is three queries whatever the cohort size.
 *
 * ADMIN ONLY, DELIBERATELY NARROWER THAN THE REST OF THE DD SIDE. `AppLayout`
 * shows Companies and Review Queue to advisor and viewer, and `/review-queue`
 * serves any non-company role scoped to their named assignments. This endpoint
 * does not: CW020 §5 fixes visibility at admins for now, with a review
 * capability gate left for later. The web app must therefore not call it for a
 * non-admin, or every page load would 403 for those users. That is a decision,
 * not an oversight, and widening it is a decision too.
 *
 * WHAT THIS FILE DOES NOT DO. No SQL, no bucketing, no ageing, no sorting. All
 * of it is in `services/dd-summary.js`, which is where the daily digest and, in
 * time, CW016's agent read the same rules from.
 */
import { Router } from 'express';
import { requireAuth, requireRole, rejectCompanyRole } from '../middleware/auth.js';
import { loadSummary } from '../services/dd-summary.js';

const router = Router();
router.use(requireAuth, rejectCompanyRole, requireRole('admin'));

router.get('/', async (_req, res) => {
  try {
    res.json(await loadSummary());
  } catch (err) {
    console.error('[dd-summary] Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
