/**
 * Storage service tests.
 *
 * S3 is exercised through a fake client injected into `S3Storage`, and the
 * upload/download path is exercised against `MemoryStorage`. There is no AWS
 * call anywhere in this suite: the deploy credential for this project is
 * deliberately ECR and ECS only, and it should stay that way.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Readable } from 'stream';

import {
  MemoryStorage,
  LocalStorage,
  S3Storage,
  StorageNotFoundError,
  createStorageFromEnv,
  getStorage,
  setStorage,
  resetStorage,
  toBuffer,
} from '../src/services/storage.js';

// A buffer with nulls, high bytes and a UTF-8 sequence, so any re-encoding,
// base64 round-trip or newline translation shows up as a mismatch.
const TRICKY = Buffer.concat([
  Buffer.from([0x00, 0x0d, 0x0a, 0x1a, 0xff, 0xfe, 0x80]),
  Buffer.from('Taranis — DFSA £ 8-year', 'utf8'),
  Buffer.from(Array.from({ length: 512 }, (_, i) => i % 256)),
]);

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Minimal stand-in for @aws-sdk/client-s3: records every command sent. */
function fakeS3() {
  const sent = [];
  const objects = new Map();

  const command = (type) =>
    class {
      constructor(input) {
        this.type = type;
        this.input = input;
      }
    };

  const commands = {
    PutObjectCommand: command('Put'),
    GetObjectCommand: command('Get'),
    DeleteObjectCommand: command('Delete'),
    HeadObjectCommand: command('Head'),
  };

  const notFound = () => {
    const err = new Error('The specified key does not exist.');
    err.name = 'NoSuchKey';
    err.$metadata = { httpStatusCode: 404 };
    return err;
  };

  const client = {
    async send(cmd) {
      sent.push(cmd);
      const { Key, Body, ContentType, ContentLength } = cmd.input;
      if (cmd.type === 'Put') {
        objects.set(Key, { buffer: await toBuffer(Body), ContentType, ContentLength });
        return {};
      }
      if (cmd.type === 'Get') {
        const stored = objects.get(Key);
        if (!stored) throw notFound();
        return {
          Body: Readable.from([stored.buffer]),
          ContentType: stored.ContentType,
          ContentLength: stored.buffer.length,
        };
      }
      if (cmd.type === 'Head') {
        if (!objects.has(Key)) throw notFound();
        return {};
      }
      if (cmd.type === 'Delete') {
        objects.delete(Key);
        return {};
      }
      throw new Error(`Unexpected command ${cmd.type}`);
    },
  };

  return { client, commands, sent, objects };
}

// ---------------------------------------------------------------------------
// The interface contract, applied to every backend
// ---------------------------------------------------------------------------

const backends = [
  ['MemoryStorage', () => new MemoryStorage()],
  ['LocalStorage', () => new LocalStorage({ root: tmpDir('taranis-local-') })],
  [
    'S3Storage',
    () => {
      const { client, commands } = fakeS3();
      return new S3Storage({ bucket: 'taranis-dataroom-documents-prod', region: 'eu-west-2', client, commands });
    },
  ],
];

for (const [name, make] of backends) {
  test(`${name}: round-trips bytes unchanged`, async () => {
    const store = make();
    const key = 'documents/fund-1/1700000000000-123456.pdf';

    await store.put(key, { body: TRICKY, contentType: 'application/pdf', contentLength: TRICKY.length });
    const out = await store.get(key);
    const bytes = await toBuffer(out.body);

    assert.equal(bytes.length, TRICKY.length);
    assert.ok(bytes.equals(TRICKY), 'bytes must come back byte-for-byte identical');
  });

  test(`${name}: streams in as well as buffers`, async () => {
    const store = make();
    const key = 'documents/fund-1/streamed.bin';

    await store.put(key, { body: Readable.from([TRICKY.subarray(0, 100), TRICKY.subarray(100)]) });
    const bytes = await toBuffer((await store.get(key)).body);

    assert.ok(bytes.equals(TRICKY));
  });

  test(`${name}: get on a missing key throws StorageNotFoundError`, async () => {
    const store = make();
    await assert.rejects(() => store.get('documents/nope/missing.pdf'), StorageNotFoundError);
  });

  test(`${name}: exists and remove`, async () => {
    const store = make();
    const key = 'documents/fund-1/removable.pdf';

    assert.equal(await store.exists(key), false);
    await store.put(key, { body: Buffer.from('hello') });
    assert.equal(await store.exists(key), true);

    await store.remove(key);
    assert.equal(await store.exists(key), false);
  });

  test(`${name}: reports a kind and a description`, async () => {
    const store = make();
    assert.ok(['s3', 'local', 'memory'].includes(store.kind));
    assert.equal(typeof store.describe(), 'string');
  });
}

// ---------------------------------------------------------------------------
// S3 specifics
// ---------------------------------------------------------------------------

test('S3Storage: sends the bucket, key, content type and length, and nothing else', async () => {
  const { client, commands, sent } = fakeS3();
  const store = new S3Storage({ bucket: 'taranis-dataroom-documents-prod', client, commands });

  await store.put('documents/fund-1/doc.pdf', {
    body: TRICKY,
    contentType: 'application/pdf',
    contentLength: TRICKY.length,
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'Put');
  assert.deepEqual(Object.keys(sent[0].input).sort(), ['Body', 'Bucket', 'ContentLength', 'ContentType', 'Key']);
  assert.equal(sent[0].input.Bucket, 'taranis-dataroom-documents-prod');
  assert.equal(sent[0].input.Key, 'documents/fund-1/doc.pdf');
  assert.equal(sent[0].input.ContentLength, TRICKY.length);
  // The body is handed over untouched — no encryption, no base64, no re-encoding.
  assert.equal(sent[0].input.Body, TRICKY);
});

test('S3Storage: omits ContentType and ContentLength when not supplied', async () => {
  const { client, commands, sent } = fakeS3();
  const store = new S3Storage({ bucket: 'b', client, commands });

  await store.put('k', { body: Buffer.from('x') });

  assert.deepEqual(Object.keys(sent[0].input).sort(), ['Body', 'Bucket', 'Key']);
});

test('S3Storage: a 404 from S3 becomes StorageNotFoundError, other errors propagate', async () => {
  const { commands } = fakeS3();
  const boom = Object.assign(new Error('denied'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } });
  const store = new S3Storage({ bucket: 'b', commands, client: { async send() { throw boom; } } });

  await assert.rejects(() => store.get('k'), (err) => err === boom);
});

test('S3Storage: refuses to construct without a bucket', () => {
  assert.throws(() => new S3Storage({ bucket: undefined, client: {}, commands: {} }), /requires a bucket/);
});

// ---------------------------------------------------------------------------
// Local disk specifics
// ---------------------------------------------------------------------------

test('LocalStorage: creates nested key directories', async () => {
  const root = tmpDir('taranis-local-');
  const store = new LocalStorage({ root });

  await store.put('documents/fund-a/sub/doc.pdf', { body: Buffer.from('x') });

  assert.ok(fs.existsSync(path.join(root, 'documents', 'fund-a', 'sub', 'doc.pdf')));
});

test('LocalStorage: refuses keys that escape the root', async () => {
  const store = new LocalStorage({ root: tmpDir('taranis-local-') });
  await assert.rejects(() => store.put('../escaped.pdf', { body: Buffer.from('x') }), /Invalid storage key/);
});

// ---------------------------------------------------------------------------
// Selection from the environment, and injection
// ---------------------------------------------------------------------------

test('createStorageFromEnv: falls back to local disk when S3_BUCKET is unset', async () => {
  const store = await createStorageFromEnv({ LOCAL_STORAGE_DIR: tmpDir('taranis-local-') });
  assert.equal(store.kind, 'local');
});

test('createStorageFromEnv: picks S3 when S3_BUCKET is set', async () => {
  // Loads the real SDK and constructs a real S3Client. That is a local object
  // graph only — no credential is resolved and no request is made until a
  // command is sent, which this test deliberately never does.
  const store = await createStorageFromEnv({
    S3_BUCKET: 'taranis-dataroom-documents-prod',
    AWS_REGION: 'eu-west-2',
  });

  assert.equal(store.kind, 's3');
  assert.equal(store.bucket, 'taranis-dataroom-documents-prod');
  assert.match(store.describe(), /taranis-dataroom-documents-prod \(eu-west-2\)/);
});

test('setStorage / resetStorage swap the singleton', async () => {
  const double = new MemoryStorage();
  setStorage(double);
  assert.equal(await getStorage(), double);

  resetStorage();
  process.env.LOCAL_STORAGE_DIR = tmpDir('taranis-local-');
  const rebuilt = await getStorage();
  assert.notEqual(rebuilt, double);
  assert.equal(rebuilt.kind, 'local');

  resetStorage();
  delete process.env.LOCAL_STORAGE_DIR;
});
