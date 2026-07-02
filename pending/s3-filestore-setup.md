# Setup + Code — Production S3 `FileStore` adapter

> **Status:** READY — the adapter is written below; it can't land as a live `.ts` until the AWS SDK is installed
> (importing an uninstalled dep breaks `tsc`/`next build`). **Do the "needful" in §1, then I commit §2–§4 as live
> files** (a 2-minute follow-up). Architectural rule: the S3 adapter lives at the **app composition root**
> (`apps/api`, `apps/workers`), NEVER in `@leadwolf/core` — core stays AWS-SDK-free (`fileStore.ts:4-7`).

---

## 1. The needful (you do this)

```bash
# add the SDK to BOTH composition roots (apps never import apps → each composes its own store)
bun add @aws-sdk/client-s3 @aws-sdk/lib-storage @aws-sdk/s3-request-presigner --cwd apps/api
bun add @aws-sdk/client-s3 @aws-sdk/lib-storage @aws-sdk/s3-request-presigner --cwd apps/workers
# this updates bun.lock — COMMIT it (the deploy uses --frozen-lockfile, which fails on an out-of-date lock)
```

Then set the bucket in `.env.production` (creds via the SDK's default chain — IAM role in prod, or keys):
```bash
BULK_IMPORT_S3_BUCKET=your-bucket-name
BULK_IMPORT_S3_REGION=ap-south-1
# credentials: prefer an IAM role; or AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_REGION (SDK default chain)
BULK_IMPORT_SIGNED_URL_TTL_SECONDS=900
```

Tell me when `bun.lock` is committed + the bucket exists, and I land §2–§4.

---

## 2. The adapter — `apps/api/src/features/import/s3FileStore.ts` (I commit this)

```ts
// s3FileStore.ts — the PRODUCTION FileStore adapter (15 §3/§7): presigned downloads + constant-memory multipart
// uploads via @aws-sdk/lib-storage. Lives at the app composition root, NOT @leadwolf/core (core stays cloud-free).
// Implements the same port the dev diskFileStore does, so the whole pipeline is unchanged behind it.
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { FileStore } from "@leadwolf/core";
import { Readable } from "node:stream";

export interface S3FileStoreConfig {
  bucket: string;
  region: string;
  signedUrlTtlSeconds: number;
  endpoint?: string; // for S3-compatible stores (MinIO/R2); omit for AWS S3
}

/** Adapt the port's three body shapes to a Node Readable for the multipart Upload (constant memory). */
function toReadable(body: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array> | Uint8Array): Readable {
  if (body instanceof Uint8Array) return Readable.from(Buffer.from(body));
  if (typeof (body as ReadableStream<Uint8Array>).getReader === "function") {
    return Readable.fromWeb(body as unknown as import("node:stream/web").ReadableStream);
  }
  return Readable.from(body as AsyncIterable<Uint8Array>);
}

export function s3FileStore(cfg: S3FileStoreConfig): FileStore {
  const client = new S3Client({ region: cfg.region, ...(cfg.endpoint ? { endpoint: cfg.endpoint, forcePathStyle: true } : {}) });
  return {
    async putObject(key, body) {
      // lib-storage streams the body in 5MB parts → a huge upload never fully buffers (the constant-memory mandate).
      const upload = new Upload({ client, params: { Bucket: cfg.bucket, Key: key, Body: toReadable(body) } });
      await upload.done();
    },
    async getObjectStream(key) {
      const res = await client.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: key }));
      // Body is a Node Readable (an AsyncIterable<Uint8Array>) in the Node/Bun runtime — satisfies the port.
      return res.Body as AsyncIterable<Uint8Array>;
    },
    async putArtifact(key, bytes) {
      const upload = new Upload({ client, params: { Bucket: cfg.bucket, Key: key, Body: Buffer.from(bytes) } });
      await upload.done();
    },
    async getSignedDownloadUrl(key) {
      return getSignedUrl(client, new GetObjectCommand({ Bucket: cfg.bucket, Key: key }), {
        expiresIn: cfg.signedUrlTtlSeconds,
      });
    },
  };
}
```

## 3. The env schema — `packages/config/src/env.ts` (I commit this)

```ts
// Prod bulk-import object store (absent → dev diskFileStore is used). Bucket present = S3 path.
BULK_IMPORT_S3_BUCKET: z.string().optional(),
BULK_IMPORT_S3_REGION: z.string().optional(),
BULK_IMPORT_S3_ENDPOINT: z.string().url().optional(), // S3-compatible only
BULK_IMPORT_SIGNED_URL_TTL_SECONDS: z.coerce.number().int().positive().default(900),
```

## 4. The wiring — `apps/api/src/features/import/bulkStore.ts` (+ the mirror in `apps/workers`)

```ts
export function bulkFileStore(): FileStore {
  if (!store) {
    store = env.BULK_IMPORT_S3_BUCKET
      ? s3FileStore({
          bucket: env.BULK_IMPORT_S3_BUCKET,
          region: env.BULK_IMPORT_S3_REGION ?? "us-east-1",
          endpoint: env.BULK_IMPORT_S3_ENDPOINT,
          signedUrlTtlSeconds: env.BULK_IMPORT_SIGNED_URL_TTL_SECONDS,
        })
      : diskFileStore(env.BULK_IMPORT_STORAGE_DIR);
  }
  return store;
}
```
> **Note:** `apps/workers` composes its OWN store at its composition root (apps never import apps). Mirror the same
> selection there so the worker reads from S3 in prod. Both must point at the same bucket.

## 5. Verify (after it lands + creds set)
- `bun run typecheck` passes (SDK resolved).
- Upload a small file through bulk import → object appears in the bucket under `imports/<jobId>/source.csv`.
- The rejected-rows artifact downloads via a **presigned, expiring** URL (not a `file://`).
- With `BULK_IMPORT_S3_BUCKET` unset, dev still uses local disk (byte-identical to today).

## 6. Then flip it on
`BULK_IMPORT_ENABLED=true` (env) + `bulk_import_enabled` per-tenant flag (admin console) → bulk import is live.
