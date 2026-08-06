/**
 * Virus scanning for company uploads.
 *
 * ---------------------------------------------------------------------------
 * READ THIS BEFORE ASSUMING UPLOADS ARE SCANNED
 * ---------------------------------------------------------------------------
 * The backend shipped in Phase 1a is a STUB. It does not inspect a single byte.
 * It returns the verdict 'pending' and it says so at startup and on /health.
 *
 * THE UNSCANNED PATH IS AN ACCEPTED RISK, NOT AN OUTSTANDING DEFECT.
 * Mark confirmed option A on 2026-08-06 and accepted the exposure for the beta
 * cohort explicitly: a small number of clients have been told that uploads in
 * 1a are not scanned and are content to use the portal on that basis
 * (HANDOVER-C004 §3.1, ANSWERED). Reviewers can therefore open what companies
 * submit. The trigger to revisit is widening the cohort beyond clients who have
 * accepted the position, not a date.
 *
 * What that means for `isDownloadable` at the bottom of this file: with no
 * scanner configured, an unscanned file IS downloadable and the caller is told
 * it was never inspected. As soon as a real backend is configured the rule
 * tightens on its own, because then 'pending' means scanning has not finished
 * or has failed rather than that nobody is scanning. An 'infected' verdict is
 * quarantined under either backend.
 *
 * WHY A STUB RATHER THAN CLAMAV. HANDOVER-CW004 §3 item 2 recommended ClamAV
 * in the API container. HANDOVER-C004 §3.1 overrode it on sizing: the live ECS
 * task `taranis-dataroom:8` is 1024 CPU / 2048 MiB for the WHOLE task, shared
 * between the api and web containers, already running Node 20 and LibreOffice.
 * `clamd` holds its full signature database resident and commonly needs 2 to
 * 3 GB on its own. On a 2 GB task that is not slow, it is Fargate killing the
 * task on memory, and it would fail on deploy rather than in any test. The
 * one-shot `clamscan` alternative reloads the signature database on every
 * invocation, which is tens of seconds per file on a user-facing upload.
 *
 * So scanning is built behind this interface exactly as storage was in Phase 0.
 * The upload flow, the quarantine state, the audit actions and the tests are
 * all built and exercised now; enabling a real engine later changes only the
 * backend and the task sizing, not the call sites.
 *
 * The gap is recorded in MIGRATION-INVENTORY.md §12 and in the HANDOVER-CW004
 * completion log, as an accepted risk with a named trigger to revisit. It is
 * not a regression either: uploads on this platform have never been scanned.
 *
 * INTERFACE
 *   scan(key, { filename, size, stream }) -> Promise<{ state, backend, detail }>
 *     state   : 'pending' | 'clean' | 'infected' | 'error'
 *     backend : the value written to company_files.scan_backend
 *   kind      : 'stub' | 'clamav'
 *   describe(): string, for startup logging
 */

/** Verdict states, mirroring the CHECK constraint on company_files.scan_state. */
export const SCAN_STATES = ['pending', 'clean', 'infected', 'error'];

/**
 * The Phase 1a backend. Deliberately never returns 'clean'.
 *
 * Returning 'clean' would be the single most dangerous line in this file. It
 * would record, in the database and for ever, that a file had been inspected
 * and found safe when nothing had looked at it, and that claim would outlive
 * the beta and survive a real scanner being wired. 'pending' plus
 * `scan_backend = 'stub'` keeps the truth in the data, so exactly which files
 * were never examined can be found later and re-scanned.
 */
export class StubScanner {
  constructor({ warnOnUse = true } = {}) {
    this.kind = 'stub';
    this.warnOnUse = warnOnUse;
    this.scanned = 0;
  }

  describe() {
    return 'STUB — no scanning is performed, company uploads are not inspected '
         + '(accepted beta risk, see services/scanner.js)';
  }

  async scan(key, { filename } = {}) {
    this.scanned++;
    if (this.warnOnUse) {
      console.warn(`[scanner] STUB scanner: ${filename || key} was NOT scanned.`);
    }
    return {
      state: 'pending',
      backend: 'stub',
      detail: 'No scanner is configured. This file has not been inspected.',
    };
  }
}

/**
 * The real backend, deliberately unimplemented.
 *
 * It is a class rather than a comment so the shape of the eventual change is
 * fixed now and visible to whoever picks it up: construct it with a clamd
 * host and port, implement `scan`, select it with SCANNER_BACKEND=clamav.
 * Nothing else in the codebase moves.
 *
 * Before switching this on, the ECS task must be resized. See the header.
 */
export class ClamAvScanner {
  constructor({ host, port = 3310 } = {}) {
    this.kind = 'clamav';
    this.host = host;
    this.port = port;
  }

  describe() {
    return `clamav (${this.host}:${this.port})`;
  }

  async scan() {
    throw new Error(
      'ClamAvScanner is not implemented. Phase 1a ships the stub backend by ' +
      'decision (HANDOVER-C004 §3.1). Enabling ClamAV requires an ECS task ' +
      'resize first: clamd needs 2 to 3 GB and the task is 2048 MiB in total.'
    );
  }
}

// ---------------------------------------------------------------------------
// Selection and injection
// ---------------------------------------------------------------------------

/**
 * `SCANNER_BACKEND` is unset everywhere today, so this returns the stub. It is
 * read from the environment rather than hard-coded so turning on a real engine
 * is a task-definition change and not a code change.
 */
export function createScannerFromEnv(env = process.env) {
  const backend = (env.SCANNER_BACKEND || 'stub').toLowerCase();

  if (backend === 'clamav') {
    return new ClamAvScanner({
      host: env.CLAMAV_HOST || 'localhost',
      port: parseInt(env.CLAMAV_PORT || '3310', 10),
    });
  }

  return new StubScanner();
}

let scannerInstance = null;

/** Lazily built singleton. Awaited by the upload path. */
export function getScanner() {
  if (!scannerInstance) scannerInstance = createScannerFromEnv();
  return scannerInstance;
}

/** Inject a scanner. Tests only. */
export function setScanner(scanner) {
  scannerInstance = scanner;
}

/** Drop the singleton so the next `getScanner()` rebuilds it from the environment. */
export function resetScanner() {
  scannerInstance = null;
}

/**
 * Whether Taranis may download a company file, given its recorded scan state
 * and the scanner that is actually configured now.
 *
 * The second argument is the point of this function. Blocking everything that
 * is not 'clean' would be the obvious rule, and it would make the portal
 * useless under the stub: nothing would ever be downloadable, so no reviewer
 * could open anything a company submitted. Mark accepted the unscanned path for
 * the beta cohort precisely so that the portal works (HANDOVER-C004 §3.1), so
 * the rule is:
 *
 *   infected            -> never, under any backend. A verdict is a verdict.
 *   clean               -> always.
 *   pending / error     -> allowed ONLY while no scanner is configured, i.e.
 *                          the stub is active and "not scanned" means nobody is
 *                          scanning. With a real backend the same state means
 *                          scanning has not finished or has failed, which is a
 *                          reason to wait, so it is refused.
 *
 * The rule therefore tightens by itself the moment a real backend is
 * configured, with no second change and nothing to remember.
 *
 * @param {string} scanState
 * @param {object} [opts]
 * @param {string} [opts.scannerKind] - active backend; defaults to the live one
 * @returns {{allowed: boolean, unscanned: boolean, reason: string|null}}
 */
export function downloadDecision(scanState, { scannerKind = getScanner().kind } = {}) {
  if (scanState === 'infected') {
    return {
      allowed: false,
      unscanned: false,
      reason: 'This file was quarantined by the security scan and cannot be downloaded.',
    };
  }
  if (scanState === 'clean') {
    return { allowed: true, unscanned: false, reason: null };
  }
  if (scannerKind === 'stub') {
    return { allowed: true, unscanned: true, reason: null };
  }
  return {
    allowed: false,
    unscanned: false,
    reason: 'This file has not yet been cleared by the security scan and cannot be downloaded.',
  };
}

/** Convenience wrapper for callers that only need the yes or no. */
export function isDownloadable(scanState, opts) {
  return downloadDecision(scanState, opts).allowed;
}
