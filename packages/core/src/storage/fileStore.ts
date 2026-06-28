// fileStore.ts — the object-store PORT (interface) the bulk-import pipeline writes uploads + artifacts through,
// plus a dependency-free LOCAL-DISK adapter for dev/test (15-bulk-import-design §3/§4, backlog #2). The pipeline
// never imports a concrete store: the API composition root injects an adapter, so a unit/integration test can run
// the whole drive/stage path against a temp dir with no network. The PRODUCTION S3 adapter (presigned multipart,
// AV-scan-before-promote) is NET-NEW at the app composition root and is deliberately kept OUT of @leadwolf/core —
// core stays free of the AWS SDK (no cloud dependency leaks into the domain layer; 15 §3/§7). This adapter is for
// DEV ONLY: it has no signing, no expiry, and no isolation beyond the filesystem — never wire it in production.

import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";

/**
 * The object-store seam. Keys are opaque, "/"-delimited paths (e.g. `imports/<jobId>/source.csv`); the adapter
 * maps them to whatever its backend uses (an S3 key, a path under a root dir). PII-bearing uploads flow through
 * `putObject` (streamed, constant memory); small derived artifacts (the rejected-rows CSV) through `putArtifact`.
 * `getObjectStream` is the constant-memory read the stream parser consumes; `getSignedDownloadUrl` returns a
 * time-boxed URL in prod (a bare `file://` path in the dev adapter — no signing).
 */
export interface FileStore {
  /** Write an object from a stream/iterable/buffer (the upload path — never fully buffered in memory). */
  putObject(
    key: string,
    body: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array> | Uint8Array,
  ): Promise<void>;
  /** Open an object for constant-memory streaming reads (the stream-parse source). */
  getObjectStream(key: string): Promise<AsyncIterable<Uint8Array>>;
  /** Write a small, fully-materialized derived artifact (e.g. the rejected-rows CSV). */
  putArtifact(key: string, bytes: Uint8Array): Promise<void>;
  /** A download URL for an object (signed + expiring in prod; a bare `file://` URL in the dev adapter). */
  getSignedDownloadUrl(key: string): Promise<string>;
}

/** Map an opaque key to an absolute path UNDER `root`, rejecting any key that would escape it (path traversal /
 *  absolute keys). Leading slashes are stripped so a key is always treated as relative to the root. */
function resolveKey(root: string, key: string): string {
  const target = resolve(root, key.replace(/^[/\\]+/, ""));
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error(`diskFileStore: object key escapes the root directory: ${key}`);
  }
  return target;
}

/** Adapt a web ReadableStream to an async-iterable of byte chunks (Node's `fs` accepts the iterable directly). */
async function* readableStreamToBytes(
  stream: ReadableStream<Uint8Array>,
): AsyncIterable<Uint8Array> {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * A LOCAL-DISK FileStore adapter for dev/test, backed by `node:fs/promises` under `rootDir`. Pure Node, no AWS
 * SDK. `getSignedDownloadUrl` returns a `file://` URL (no signing/expiry — dev only). Every key is confined to
 * `rootDir` (traversal-guarded). Parent directories are created on write.
 */
export function diskFileStore(rootDir: string): FileStore {
  const root = resolve(rootDir);
  return {
    async putObject(key, body) {
      const filePath = resolveKey(root, key);
      await mkdir(dirname(filePath), { recursive: true });
      if (body instanceof Uint8Array) {
        await writeFile(filePath, body);
        return;
      }
      // A web ReadableStream becomes an async-iterable; an AsyncIterable passes straight through. Streamed to
      // disk so a large upload never lands fully in memory (the constant-memory mandate, 15 §2).
      const iterable =
        typeof (body as ReadableStream<Uint8Array>).getReader === "function"
          ? readableStreamToBytes(body as ReadableStream<Uint8Array>)
          : (body as AsyncIterable<Uint8Array>);
      await pipeline(Readable.from(iterable), createWriteStream(filePath));
    },

    async getObjectStream(key) {
      // fs.ReadStream is an AsyncIterable<Buffer>; Buffer is a Uint8Array, so it satisfies the port. A missing
      // object surfaces as an ENOENT 'error' when the consumer iterates (the dev adapter does no pre-stat).
      return createReadStream(resolveKey(root, key));
    },

    async putArtifact(key, bytes) {
      const filePath = resolveKey(root, key);
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, bytes);
    },

    async getSignedDownloadUrl(key) {
      // Dev only: a bare file:// URL, NOT a signed/expiring link. The prod S3 adapter returns a presigned URL.
      return pathToFileURL(resolveKey(root, key)).href;
    },
  };
}
