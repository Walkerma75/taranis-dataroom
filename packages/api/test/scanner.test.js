/**
 * The virus-scanning interface.
 *
 * The single most important assertion in this file is that the stub NEVER
 * returns 'clean'. Every downstream decision keys off that value, so a stub
 * that lied would silently open Taranis-side download of unscanned counterparty
 * files while every other test still passed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  StubScanner,
  ClamAvScanner,
  createScannerFromEnv,
  getScanner,
  setScanner,
  resetScanner,
  isDownloadable,
  downloadDecision,
  SCAN_STATES,
} from '../src/services/scanner.js';

test('the stub never reports a file clean, whatever it is given', async () => {
  const scanner = new StubScanner({ warnOnUse: false });

  for (const filename of ['a.pdf', 'harmless.txt', 'eicar.com', '']) {
    const verdict = await scanner.scan(`companies/c/i/f/${filename}`, { filename, size: 1 });
    assert.notEqual(verdict.state, 'clean');
    assert.equal(verdict.state, 'pending');
    assert.equal(verdict.backend, 'stub');
    assert.ok(SCAN_STATES.includes(verdict.state));
  }
});

test('the stub says plainly that it did not scan anything', async () => {
  const scanner = new StubScanner({ warnOnUse: false });
  const verdict = await scanner.scan('k', { filename: 'a.pdf' });

  assert.match(verdict.detail, /not been inspected/);
  assert.match(scanner.describe(), /STUB/);
  assert.equal(scanner.kind, 'stub');
});

test('an infected file is never downloadable, under either backend', () => {
  // A verdict is a verdict. This is the one rule the configured backend cannot
  // relax, because it means something actually looked and found something.
  assert.equal(isDownloadable('infected', { scannerKind: 'stub' }), false);
  assert.equal(isDownloadable('infected', { scannerKind: 'clamav' }), false);
  assert.equal(downloadDecision('infected', { scannerKind: 'stub' }).reason,
    'This file was quarantined by the security scan and cannot be downloaded.');
});

test('a clean file is downloadable and is not flagged as unscanned', () => {
  const decision = downloadDecision('clean', { scannerKind: 'clamav' });
  assert.equal(decision.allowed, true);
  assert.equal(decision.unscanned, false);
});

test('while no scanner is configured, an unscanned file IS downloadable and says so', () => {
  // Mark accepted this for the beta cohort (HANDOVER-C004 §3.1). Blocking it
  // would make the portal useless: no reviewer could open anything a company
  // submitted, because the stub never clears a file.
  for (const state of ['pending', 'error']) {
    const decision = downloadDecision(state, { scannerKind: 'stub' });
    assert.equal(decision.allowed, true, `${state} should be served under the stub`);
    assert.equal(decision.unscanned, true, `${state} must be flagged as unscanned`);
  }
});

test('the rule tightens by itself once a real scanner is configured', () => {
  // With a real backend, 'pending' stops meaning "nobody is scanning" and starts
  // meaning "scanning has not finished or has failed", which is a reason to
  // wait. No second change, and nothing to remember.
  for (const state of ['pending', 'error']) {
    const decision = downloadDecision(state, { scannerKind: 'clamav' });
    assert.equal(decision.allowed, false, `${state} should be refused under a real scanner`);
    assert.match(decision.reason, /not yet been cleared/);
  }
});

test('what the stub produces is downloadable but always marked unscanned', async () => {
  const scanner = new StubScanner({ warnOnUse: false });
  const verdict = await scanner.scan('k', { filename: 'a.pdf' });
  const decision = downloadDecision(verdict.state, { scannerKind: 'stub' });

  assert.equal(decision.allowed, true);
  assert.equal(decision.unscanned, true);
});

test('the environment selects the backend, and defaults to the stub', () => {
  assert.equal(createScannerFromEnv({}).kind, 'stub');
  assert.equal(createScannerFromEnv({ SCANNER_BACKEND: 'stub' }).kind, 'stub');
  assert.equal(createScannerFromEnv({ SCANNER_BACKEND: 'nonsense' }).kind, 'stub');
  assert.equal(
    createScannerFromEnv({ SCANNER_BACKEND: 'clamav', CLAMAV_HOST: 'clamd' }).kind,
    'clamav'
  );
});

test('the ClamAV backend refuses to pretend it works', async () => {
  const scanner = new ClamAvScanner({ host: 'clamd' });
  await assert.rejects(() => scanner.scan('k', {}), /not implemented/);
  // And the reason is in the message, so whoever hits it knows what to do.
  await assert.rejects(() => scanner.scan('k', {}), /task resize/);
});

test('the scanner singleton can be injected and reset, like storage', async (t) => {
  t.after(() => resetScanner());

  resetScanner();
  assert.equal(getScanner().kind, 'stub');

  const fake = {
    kind: 'fake',
    describe: () => 'fake',
    async scan() { return { state: 'clean', backend: 'fake' }; },
  };
  setScanner(fake);
  assert.equal(getScanner().kind, 'fake');

  resetScanner();
  assert.equal(getScanner().kind, 'stub');
});
