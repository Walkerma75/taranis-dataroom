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

test('only a clean verdict makes a file downloadable', () => {
  assert.equal(isDownloadable('clean'), true);
  assert.equal(isDownloadable('pending'), false);
  assert.equal(isDownloadable('infected'), false);
  assert.equal(isDownloadable('error'), false);
  assert.equal(isDownloadable(undefined), false);
  assert.equal(isDownloadable(null), false);
});

test('nothing the stub produces is downloadable', async () => {
  const scanner = new StubScanner({ warnOnUse: false });
  const verdict = await scanner.scan('k', { filename: 'a.pdf' });
  assert.equal(isDownloadable(verdict.state), false);
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
