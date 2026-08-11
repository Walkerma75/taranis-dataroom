/**
 * Document storage service.
 *
 * Documents used to be written to `packages/api/uploads/` inside the container
 * by `multer.diskStorage`. On Fargate there is no persistent volume, so every
 * deploy destroyed every uploaded document. This module moves the bytes to the
 * S3 bucket named by `S3_BUCKET` (`taranis-dataroom-documents-prod` in prod).
 *
 * Documents still stream through the API on the task-role credential chain, so
 * the existing grant checks and audit writes are unchanged and the web client
 * needs no change. No presigned URLs, no CloudFront OAC.
 *
 * The interface is deliberately small and injectable so the upload and download
 * paths can be exercised in tests against an in-memory double — no AWS
 * credential, no bucket, no container. See `packages/api/test/`.
 *
 *   put(key, { body, contentType, contentLength }) -> Promise<{ key }>
 *   get(key)    -> Promise<{ body: Readable, contentType, contentLength }>
 *   remove(key) -> Promise<void>
 *   exists(key) -> Promise<boolean>
 *   list(prefix)-> Promise<string[]>
 *   kind        -> 's3' | 'local' | 'memory'
 *   describe()  -> string, for startup logging
 *
 * Keys are opaque strings stored verbatim in `documents.file_path`.
 *
 * Bytes are stored byte-for-byte: no app-layer encryption, no base64, no
 * re-encoding. At-rest encryption is the bucket's default SSE-S3, which is why
 * no `ServerSideEncryption` parameter is sent — S3 applies it server-side and
 * sending the header would be the only part of this path that could fail
 * against a policy we cannot read from the build environment.
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { Readable } from 'stream';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Thrown by `get`/`remove` when a key is not present in the backing store. */
export class StorageNotFoundError extends Error {
  constructor(key) {
    super(`Storage object not found: ${key}`);
    this.name = 'StorageNotFoundError';
    this.code = 'STORAGE_NOT_FOUND';
    this.key = key;
  }
}

/**
 * Collect a Buffer, string or Readable into a single Buffer.
 * Used only by the in-memory double and by `exists` fallbacks — the S3 and
 * local backends stream, so a 100 MB upload is never held in memory in prod.
 */
export async function toBuffer(body) {
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === 'string') return Buffer.from(body);
  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// S3
// ---------------------------------------------------------------------------

function isS3NotFound(err) {
  return (
    err?.name === 'NoSuchKey' ||
    err?.name === 'NotFound' ||
    err?.Code === 'NoSuchKey' ||
    err?.$metadata?.httpStatusCode === 404
  );
}

export class S3Storage {
  /**
   * @param {object}  opts
   * @param {string}  opts.bucket
   * @param {object}  opts.client    - anything with `send(command)`; the SDK's S3Client in prod
   * @param {object}  opts.commands  - { PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand }
   * @param {string} [opts.region]   - recorded for logging only
   */
  constructor({ bucket, client, commands, region }) {
    if (!bucket) throw new Error('S3Storage requires a bucket');
    this.kind = 's3';
    this.bucket = bucket;
    this.region = region;
    this.client = client;
    this.commands = commands;
  }

  describe() {
    return `s3://${this.bucket}${this.region ? ` (${this.region})` : ''}`;
  }

  async put(key, { body, contentType, contentLength } = {}) {
    const { PutObjectCommand } = this.commands;
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ...(contentType ? { ContentType: contentType } : {}),
        ...(contentLength != null ? { ContentLength: contentLength } : {}),
      })
    );
    return { key };
  }

  async get(key) {
    const { GetObjectCommand } = this.commands;
    try {
      const out = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      return {
        body: out.Body,
        contentType: out.ContentType,
        contentLength: out.ContentLength,
      };
    } catch (err) {
      if (isS3NotFound(err)) throw new StorageNotFoundError(key);
      throw err;
    }
  }

  async exists(key) {
    const { HeadObjectCommand } = this.commands;
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch (err) {
      if (isS3NotFound(err)) return false;
      throw err;
    }
  }

  async remove(key) {
    const { DeleteObjectCommand } = this.commands;
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  /**
   * Every key under a prefix, following the continuation token to the end.
   *
   * Added for the go-live reset, which has to be able to say the bucket is
   * empty rather than that the objects it knew about are gone. A truncated
   * first page would have made it report success over whatever was left, which
   * is why this pages rather than taking the first thousand.
   *
   * The task role holds `ListBucket` on the bucket already.
   */
  async list(prefix = '') {
    const { ListObjectsV2Command } = this.commands;
    const keys = [];
    let continuationToken;
    do {
      const out = await this.client.send(new ListObjectsV2Command({
        Bucket: this.bucket,
        ...(prefix ? { Prefix: prefix } : {}),
        ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
      }));
      for (const object of out.Contents || []) keys.push(object.Key);
      continuationToken = out.IsTruncated ? out.NextContinuationToken : undefined;
    } while (continuationToken);
    return keys;
  }
}

/**
 * Build an S3-backed store. The SDK is imported lazily so that tests, the local
 * backend and the in-memory double never load it.
 *
 * Credentials come from the container credential chain (the ECS task role
 * `taranis-dataroom-task-role`). Never from Secrets Manager, never from env.
 */
export async function createS3Storage({ bucket, region, client, commands } = {}) {
  let resolvedClient = client;
  let resolvedCommands = commands;

  if (!resolvedClient || !resolvedCommands) {
    const sdk = await import('@aws-sdk/client-s3');
    resolvedCommands = resolvedCommands || sdk;
    resolvedClient = resolvedClient || new sdk.S3Client({ ...(region ? { region } : {}) });
  }

  return new S3Storage({ bucket, region, client: resolvedClient, commands: resolvedCommands });
}

// ---------------------------------------------------------------------------
// Local disk — development only
// ---------------------------------------------------------------------------

export const DEFAULT_LOCAL_DIR = path.join(__dirname, '../../uploads');

export class LocalStorage {
  constructor({ root = DEFAULT_LOCAL_DIR } = {}) {
    this.kind = 'local';
    this.root = root;
    fs.mkdirSync(this.root, { recursive: true });
  }

  describe() {
    return `local disk (${this.root}) — NOT durable, documents are lost on container replacement`;
  }

  /** Resolve a key to an absolute path, refusing anything that escapes the root. */
  pathFor(key) {
    const resolved = path.resolve(this.root, key);
    const rootWithSep = path.resolve(this.root) + path.sep;
    if (!resolved.startsWith(rootWithSep)) throw new Error(`Invalid storage key: ${key}`);
    return resolved;
  }

  async put(key, { body } = {}) {
    const target = this.pathFor(key);
    fs.mkdirSync(path.dirname(target), { recursive: true });

    if (Buffer.isBuffer(body) || typeof body === 'string') {
      fs.writeFileSync(target, body);
    } else {
      await new Promise((resolve, reject) => {
        const out = fs.createWriteStream(target);
        body.on('error', reject);
        out.on('error', reject);
        out.on('finish', resolve);
        body.pipe(out);
      });
    }
    return { key };
  }

  async get(key) {
    const target = this.pathFor(key);
    if (!fs.existsSync(target)) throw new StorageNotFoundError(key);
    return {
      body: fs.createReadStream(target),
      contentType: undefined,
      contentLength: fs.statSync(target).size,
    };
  }

  async exists(key) {
    return fs.existsSync(this.pathFor(key));
  }

  async remove(key) {
    const target = this.pathFor(key);
    if (fs.existsSync(target)) fs.unlinkSync(target);
  }

  /** Keys under a prefix, as forward-slash paths relative to the root. */
  async list(prefix = '') {
    const keys = [];
    const walk = (dir, base) => {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const key = base ? `${base}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(path.join(dir, entry.name), key);
        else if (key.startsWith(prefix)) keys.push(key);
      }
    };
    walk(this.root, '');
    return keys;
  }
}

// ---------------------------------------------------------------------------
// In-memory — the test double
// ---------------------------------------------------------------------------

export class MemoryStorage {
  constructor() {
    this.kind = 'memory';
    this.objects = new Map();
  }

  describe() {
    return `in-memory (${this.objects.size} object(s)) — test double only`;
  }

  async put(key, { body, contentType, contentLength } = {}) {
    const buffer = await toBuffer(body);
    this.objects.set(key, { buffer, contentType, contentLength: contentLength ?? buffer.length });
    return { key };
  }

  async get(key) {
    const stored = this.objects.get(key);
    if (!stored) throw new StorageNotFoundError(key);
    return {
      body: Readable.from([stored.buffer]),
      contentType: stored.contentType,
      contentLength: stored.buffer.length,
    };
  }

  async exists(key) {
    return this.objects.has(key);
  }

  async remove(key) {
    this.objects.delete(key);
  }

  async list(prefix = '') {
    return [...this.objects.keys()].filter((key) => key.startsWith(prefix)).sort();
  }

  /** Test helper — the raw bytes, for byte-for-byte assertions. */
  bytes(key) {
    return this.objects.get(key)?.buffer;
  }
}

// ---------------------------------------------------------------------------
// Selection and injection
// ---------------------------------------------------------------------------

/**
 * `S3_BUCKET` and `AWS_REGION` are set on the ECS task definition, not in the
 * repo. With no bucket configured (local `docker compose up`, a bare `npm run
 * dev`) this falls back to local disk so development still works, and says so
 * loudly at startup.
 */
export async function createStorageFromEnv(env = process.env) {
  const bucket = env.S3_BUCKET;

  if (bucket) {
    return createS3Storage({ bucket, region: env.AWS_REGION });
  }

  if (env.NODE_ENV === 'production') {
    console.warn(
      '[storage] S3_BUCKET is not set in a production environment — falling back to ' +
      'local disk. Uploaded documents will NOT survive a container replacement.'
    );
  } else {
    console.log('[storage] S3_BUCKET is not set — using local disk for development.');
  }

  return new LocalStorage({
    root: env.LOCAL_STORAGE_DIR || DEFAULT_LOCAL_DIR,
  });
}

let storagePromise = null;

/** Lazily built singleton. Awaited by the routes. */
export function getStorage() {
  if (!storagePromise) storagePromise = createStorageFromEnv();
  return storagePromise;
}

/** Inject a store — used by tests to swap in `MemoryStorage`. */
export function setStorage(storage) {
  storagePromise = Promise.resolve(storage);
}

/** Drop the singleton so the next `getStorage()` rebuilds it from the environment. */
export function resetStorage() {
  storagePromise = null;
}

/** Staging root for in-flight uploads before they reach the store. */
export const STAGING_ROOT = path.join(os.tmpdir(), 'taranis-dataroom-staging');
