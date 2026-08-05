/**
 * Virus scanning for company uploads.
 *
 * ---------------------------------------------------------------------------
 * READ THIS BEFORE ASSUMING UPLOADS ARE SCANNED
 * ---------------------------------------------------------------------------
 * The backend shipped in Phase 1a is a STUB. It does not inspect a single byte.
 * It returns the verdict 'pending' and it says so at startup and on /health.
 * Company uploads are quarantined from Taranis-side download while a file is
 * anything other than 'clean', so a stubbed scanner means nothing a company
 * uploads becomes downloadable until a real scanner is wired.
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
 * THIS IS A RECORDED GO-LIVE BLOCKER for real company uploads. See
 * MIGRATION-INVENTORY.md §12 and the HANDOVER-CW004 completion log. It is not
 * a regression — uploads have never been scanned — but it must not reach a real
 * counterparty as it stands.
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
 * Returning 'clean' would be the single most dangerous line in this file: every
 * downstream check keys off that value, and a stub that lies would silently
 * open Taranis-side download of unscanned counterparty files. 'pending' keeps
 * the file quarantined and keeps the gap visible in the data.
 */
export class StubScanner {
  constructor({ warnOnUse = true } = {}) {
    this.kind = 'stub';
    this.warnOnUse = warnOnUse;
    this.scanned = 0;
  }

  describe() {
    return 'STUB — no scanning is performed, uploads stay quarantined (see services/scanner.js)';
  }

  async scan(key, { filename } = {}) {
    this.scanned++;
    if (this.warnOnUse) {
      console.warn(
        `[scanner] STUB scanner: ${filename || key} was NOT scanned. ` +
        'The file stays quarantined from Taranis-side download.'
      );
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
 * A file is downloadable by Taranis only once a scanner has cleared it.
 * Anything else — pending, infected, error — is quarantined.
 */
export function isDownloadable(scanState) {
  return scanState === 'clean';
}
