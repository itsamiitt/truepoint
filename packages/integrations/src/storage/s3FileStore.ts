// s3FileStore.ts — the PRODUCTION S3-compatible FileStore adapter (import-redesign 14 §The three infra gates,
// GATE B / G07; db-mgmt-research/05 §5.3 Gate B). Implements @leadwolf/core's `FileStore` port verbatim with a
// DEPENDENCY-FREE AWS Signature V4 signer over global fetch — no AWS SDK enters the repo (the lockfile stays
// untouched; core stays cloud-free, this package is the sanctioned vendor-adapter layer both app roots already
// depend on). Selected at the api/workers COMPOSITION ROOTS via `s3FileStoreFromEnv()`: with the
// `BULK_IMPORT_S3_*` env vars unset it returns null and the roots keep `diskFileStore` — today's behavior,
// byte-identical (the adapter is DARK until an operator provisions a bucket and sets the vars; flipping the env
// is ALL that is left — the user-owed half of Gate B).
//
// Gate-B requirements delivered here (14 §gates):
//   • streaming upload with bounded memory — `putObject` buffers at most ONE part (default 8 MiB) and switches
//     to S3 MULTIPART upload (initiate → UploadPart × N → complete, abort on failure) when the stream exceeds
//     it, so a multi-GB upload never lands in memory and every part carries a real Content-Length (plain
//     streamed PUTs are not accepted by S3 without aws-chunked encoding);
//   • SSE at rest — the `x-amz-server-side-encryption` header rides every object write when
//     BULK_IMPORT_S3_SSE is set (default "AES256"; explicit "none" omits it for stores like R2 that encrypt
//     unconditionally and reject the header) — 13 §4.1's encrypted-at-rest posture;
//   • signed, EXPIRING download URLs — `getSignedDownloadUrl` presigns a GET (query-string SigV4) with a
//     bounded TTL (default 300 s — 13 §4.3's ≤ 5 min bearer-capability bound);
//   • S3-COMPATIBLE endpoints — `endpoint` set (R2 / MinIO / …) uses path-style addressing; unset uses AWS
//     virtual-host style. Region defaults sanely; "auto" (R2's region) signs fine (SigV4 uses it verbatim);
//   • delete surface for the S-S7 artifact lifecycle — `deleteObject` + `deletePrefix` (ListObjectsV2 walk).
//
// SECURITY: the credentials are server-side secrets (env-only, never logged — no header/secret ever appears in
// an error message or log line here); object keys are opaque, non-PII paths (`imports/<uuid>/…`). Errors carry
// the HTTP status + the S3 <Code> only, never request headers.

import { createHash, createHmac } from "node:crypto";
import { env } from "@leadwolf/config";
import { type FileStore, diskFileStore } from "@leadwolf/core";

/** Injected fetch (tests capture requests; prod uses global fetch). */
export type S3Fetch = (url: string, init: RequestInit) => Promise<Response>;

export interface S3FileStoreOptions {
  bucket: string;
  region: string;
  /** S3-compatible endpoint origin (e.g. `https://<account>.r2.cloudflarestorage.com`). Set ⇒ path-style
   *  (`<endpoint>/<bucket>/<key>`); unset ⇒ AWS virtual-host style (`https://<bucket>.s3.<region>.amazonaws.com`). */
  endpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** `x-amz-server-side-encryption` value for writes ("AES256" | "aws:kms"). Undefined ⇒ header omitted. */
  sse?: string;
  /** Presigned-GET TTL in seconds (13 §4.3: bounded, ≤ 5 min). */
  presignTtlSeconds?: number;
  /** Multipart part size (bytes). Prod default 8 MiB; S3's minimum non-final part is 5 MiB — override only in tests. */
  partSizeBytes?: number;
  /** Test seams. */
  fetchFn?: S3Fetch;
  now?: () => Date;
}

/** Thrown on a non-2xx S3 response. Carries status + the S3 error <Code> only — never headers/credentials. */
export class S3StoreError extends Error {
  readonly status: number;
  readonly s3Code: string | null;
  constructor(op: string, key: string, status: number, s3Code: string | null) {
    super(`s3FileStore: ${op} failed for '${key}' (HTTP ${status}${s3Code ? `, ${s3Code}` : ""})`);
    this.name = "S3StoreError";
    this.status = status;
    this.s3Code = s3Code;
  }
}

const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const UNSIGNED = "UNSIGNED-PAYLOAD";
const DEFAULT_PART_SIZE = 8 * 1024 * 1024;

export function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}
function hmac(key: Uint8Array | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

/** AWS SigV4 signing-key derivation (kSecret → kDate → kRegion → kService → kSigning). Exported for the
 *  published-vector unit test. */
export function sigV4SigningKey(
  secret: string,
  dateStamp: string,
  region: string,
  service = "s3",
): Buffer {
  const kDate = hmac(`AWS4${secret}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}

/** RFC-3986 encode per the SigV4 spec: everything but unreserved chars; '/' kept when `keepSlash`. */
function uriEncode(value: string, keepSlash: boolean): string {
  let out = "";
  for (const ch of value) {
    if (/[A-Za-z0-9\-._~]/.test(ch) || (keepSlash && ch === "/")) out += ch;
    else
      out += [...new TextEncoder().encode(ch)]
        .map((b) => `%${b.toString(16).toUpperCase().padStart(2, "0")}`)
        .join("");
  }
  return out;
}

function amzTimestamps(now: Date): { amzDate: string; dateStamp: string } {
  const iso = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  return { amzDate: iso, dateStamp: iso.slice(0, 8) };
}

/** Minimal XML entity decode for ListObjectsV2 <Key> values (our keys are sanitized, but be correct). */
function decodeXml(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

async function* webStreamToBytes(stream: ReadableStream<Uint8Array>): AsyncIterable<Uint8Array> {
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

function toBytesIterable(
  body: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
): AsyncIterable<Uint8Array> {
  return typeof (body as ReadableStream<Uint8Array>).getReader === "function"
    ? webStreamToBytes(body as ReadableStream<Uint8Array>)
    : (body as AsyncIterable<Uint8Array>);
}

/**
 * The S3-compatible adapter. All requests are SigV4-signed (header auth); the presigned GET uses query auth.
 * Keys are treated exactly like the disk adapter's: opaque, "/"-delimited, leading slashes stripped.
 */
export function s3FileStore(opts: S3FileStoreOptions): FileStore {
  const {
    bucket,
    region,
    endpoint,
    accessKeyId,
    secretAccessKey,
    sse,
    presignTtlSeconds = 300,
    partSizeBytes = DEFAULT_PART_SIZE,
    fetchFn = (url, init) => fetch(url, init),
    now = () => new Date(),
  } = opts;

  const endpointUrl = endpoint ? new URL(endpoint) : null;
  const host = endpointUrl ? endpointUrl.host : `${bucket}.s3.${region}.amazonaws.com`;
  const scheme = endpointUrl ? endpointUrl.protocol : "https:";
  /** The canonical URI path for a key (path-style prepends the bucket). */
  function pathFor(key: string): string {
    const clean = key.replace(/^\/+/, "");
    const encoded = uriEncode(clean, true);
    return endpointUrl ? `/${uriEncode(bucket, true)}/${encoded}` : `/${encoded}`;
  }
  function urlFor(path: string, query: string): string {
    return `${scheme}//${host}${path}${query ? `?${query}` : ""}`;
  }

  function canonicalQuery(params: Record<string, string>): string {
    return Object.keys(params)
      .sort()
      .map((k) => `${uriEncode(k, false)}=${uriEncode(params[k] ?? "", false)}`)
      .join("&");
  }

  /** Sign a request with header-based SigV4; returns the full header set for fetch. */
  function signedHeaders(args: {
    method: string;
    path: string;
    query: Record<string, string>;
    payloadHash: string;
    extraHeaders?: Record<string, string>;
  }): { headers: Record<string, string>; query: string } {
    const { amzDate, dateStamp } = amzTimestamps(now());
    const headers: Record<string, string> = {
      host,
      "x-amz-content-sha256": args.payloadHash,
      "x-amz-date": amzDate,
      ...Object.fromEntries(
        Object.entries(args.extraHeaders ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
      ),
    };
    const signedNames = Object.keys(headers).sort();
    const canonicalHeaders = signedNames.map((k) => `${k}:${headers[k]?.trim()}\n`).join("");
    const query = canonicalQuery(args.query);
    const canonicalRequest = [
      args.method,
      args.path,
      query,
      canonicalHeaders,
      signedNames.join(";"),
      args.payloadHash,
    ].join("\n");
    const scopeStr = `${dateStamp}/${region}/s3/aws4_request`;
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      scopeStr,
      sha256Hex(canonicalRequest),
    ].join("\n");
    const signature = createHmac("sha256", sigV4SigningKey(secretAccessKey, dateStamp, region))
      .update(stringToSign, "utf8")
      .digest("hex");
    headers.authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scopeStr}, SignedHeaders=${signedNames.join(";")}, Signature=${signature}`;
    // `host` is set by fetch itself from the URL; keep it out of the actual header bag (it was signed).
    const { host: _h, ...sendable } = headers;
    return { headers: sendable, query };
  }

  async function s3Request(args: {
    op: string;
    method: string;
    key: string;
    query?: Record<string, string>;
    body?: Uint8Array | string;
    extraHeaders?: Record<string, string>;
    okStatuses?: number[];
  }): Promise<Response> {
    const path = pathFor(args.key);
    const bodyBytes =
      typeof args.body === "string" ? new TextEncoder().encode(args.body) : args.body;
    const payloadHash = bodyBytes ? sha256Hex(bodyBytes) : EMPTY_SHA256;
    const { headers, query } = signedHeaders({
      method: args.method,
      path,
      query: args.query ?? {},
      payloadHash,
      extraHeaders: args.extraHeaders,
    });
    const res = await fetchFn(urlFor(path, query), {
      method: args.method,
      headers,
      body: bodyBytes as BodyInit | undefined,
    });
    const ok = args.okStatuses ? args.okStatuses.includes(res.status) : res.ok;
    if (!ok) {
      const text = await res.text().catch(() => "");
      const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1] ?? null;
      throw new S3StoreError(args.op, args.key, res.status, code);
    }
    return res;
  }

  const writeHeaders: Record<string, string> = sse
    ? { "x-amz-server-side-encryption": sse }
    : {};

  async function simplePut(key: string, bytes: Uint8Array): Promise<void> {
    await (
      await s3Request({
        op: "PUT",
        method: "PUT",
        key,
        body: bytes,
        extraHeaders: { ...writeHeaders, "content-type": "application/octet-stream" },
      })
    ).body?.cancel?.();
  }

  async function deleteOne(key: string): Promise<void> {
    const res = await s3Request({
      op: "DELETE",
      method: "DELETE",
      key,
      okStatuses: [200, 204, 404], // idempotent — absent is a successful delete
    });
    await res.body?.cancel?.();
  }

  return {
    async putObject(key, body) {
      if (body instanceof Uint8Array) {
        await simplePut(key, body);
        return;
      }
      // Stream: buffer at most one part. ≤ 1 part ⇒ plain PUT; else S3 multipart (each part has a real
      // Content-Length — constant memory bounded by the part size, 15 §2's mandate).
      const iterable = toBytesIterable(body);
      const pending: Uint8Array[] = [];
      let pendingBytes = 0;
      let uploadId: string | null = null;
      const etags: string[] = [];

      const flushPart = async (): Promise<void> => {
        const part = Buffer.concat(pending, pendingBytes);
        pending.length = 0;
        pendingBytes = 0;
        let uid = uploadId;
        if (uid === null) {
          // First flush: initiate the multipart upload (SSE rides the initiate, per S3 semantics).
          const initRes = await s3Request({
            op: "CreateMultipartUpload",
            method: "POST",
            key,
            query: { uploads: "" },
            extraHeaders: writeHeaders,
          });
          const xml = await initRes.text();
          const minted = /<UploadId>([^<]+)<\/UploadId>/.exec(xml)?.[1];
          if (!minted) throw new S3StoreError("CreateMultipartUpload", key, 200, "NoUploadId");
          uid = minted;
          uploadId = minted;
        }
        const partNumber = etags.length + 1;
        const res = await s3Request({
          op: "UploadPart",
          method: "PUT",
          key,
          query: { partNumber: String(partNumber), uploadId: uid },
          body: part,
        });
        await res.body?.cancel?.();
        etags.push(res.headers.get("etag") ?? "");
      };

      try {
        for await (const chunk of iterable) {
          pending.push(chunk);
          pendingBytes += chunk.byteLength;
          if (pendingBytes >= partSizeBytes) await flushPart();
        }
        if (uploadId === null) {
          // Whole object fit in one part — a plain PUT (cheaper, and S3 multipart forbids 0-part completes).
          await simplePut(key, Buffer.concat(pending, pendingBytes));
          return;
        }
        if (pendingBytes > 0 || etags.length === 0) await flushPart(); // final (possibly empty) part
        // Non-null by construction (the ≤-1-part case returned above, so flushPart initiated); the guard
        // keeps the compiler honest about the closure-assigned variable.
        const uid = uploadId as string;
        const completeXml = `<CompleteMultipartUpload>${etags
          .map((etag, i) => `<Part><PartNumber>${i + 1}</PartNumber><ETag>${etag}</ETag></Part>`)
          .join("")}</CompleteMultipartUpload>`;
        const done = await s3Request({
          op: "CompleteMultipartUpload",
          method: "POST",
          key,
          query: { uploadId: uid },
          body: completeXml,
          extraHeaders: { "content-type": "application/xml" },
        });
        // S3 can answer 200 with an <Error> body on complete — treat that as failure.
        const doneXml = await done.text();
        if (/<Error>/.test(doneXml)) {
          const code = /<Code>([^<]+)<\/Code>/.exec(doneXml)?.[1] ?? null;
          throw new S3StoreError("CompleteMultipartUpload", key, 200, code);
        }
      } catch (err) {
        if (uploadId !== null) {
          // Best-effort abort so failed uploads never accrue billable orphan parts.
          await s3Request({
            op: "AbortMultipartUpload",
            method: "DELETE",
            key,
            query: { uploadId },
            okStatuses: [200, 204, 404],
          }).catch(() => undefined);
        }
        throw err;
      }
    },

    async getObjectStream(key) {
      const res = await s3Request({ op: "GET", method: "GET", key });
      const body = res.body;
      if (!body) return (async function* empty(): AsyncGenerator<Uint8Array> {})();
      return webStreamToBytes(body);
    },

    async putArtifact(key, bytes) {
      await simplePut(key, bytes);
    },

    async getSignedDownloadUrl(key) {
      // Query-string presign (SigV4): host is the only signed header; payload is UNSIGNED (standard for
      // presigned GETs over TLS). TTL bounded (13 §4.3).
      const { amzDate, dateStamp } = amzTimestamps(now());
      const path = pathFor(key);
      const scopeStr = `${dateStamp}/${region}/s3/aws4_request`;
      const params: Record<string, string> = {
        "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
        "X-Amz-Credential": `${accessKeyId}/${scopeStr}`,
        "X-Amz-Date": amzDate,
        "X-Amz-Expires": String(presignTtlSeconds),
        "X-Amz-SignedHeaders": "host",
      };
      const query = canonicalQuery(params);
      const canonicalRequest = ["GET", path, query, `host:${host}\n`, "host", UNSIGNED].join("\n");
      const stringToSign = [
        "AWS4-HMAC-SHA256",
        amzDate,
        scopeStr,
        sha256Hex(canonicalRequest),
      ].join("\n");
      const signature = createHmac("sha256", sigV4SigningKey(secretAccessKey, dateStamp, region))
        .update(stringToSign, "utf8")
        .digest("hex");
      return urlFor(path, `${query}&X-Amz-Signature=${signature}`);
    },

    async deleteObject(key) {
      await deleteOne(key);
    },

    async deletePrefix(prefix) {
      // ListObjectsV2 walk + per-key DELETE (bounded pages; batch DeleteObjects needs Content-MD5 — not worth
      // it for the small per-job prefixes this port deletes). Idempotent: an empty listing is a no-op.
      const clean = prefix.replace(/^\/+/, "");
      let continuation: string | null = null;
      for (let page = 0; page < 100; page += 1) {
        const query: Record<string, string> = { "list-type": "2", prefix: clean };
        if (continuation) query["continuation-token"] = continuation;
        const res = await s3Request({ op: "ListObjectsV2", method: "GET", key: "", query });
        const xml = await res.text();
        const keys = [...xml.matchAll(/<Key>([^<]*)<\/Key>/g)].map((m) => decodeXml(m[1] ?? ""));
        for (const k of keys) {
          if (k) await deleteOne(k);
        }
        const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
        continuation = truncated
          ? decodeXml(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml)?.[1] ?? "")
          : null;
        if (!continuation) break;
      }
    },
  };
}

/**
 * The Gate-B SELECTION SEAM, called by BOTH composition roots (apps/api `bulkStore.ts` and the apps/workers
 * `register.ts` wiring — apps never import apps, so the shared chooser lives here): returns the S3 adapter when
 * the `BULK_IMPORT_S3_*` env surface is complete, else null (the roots then keep `diskFileStore` — today's
 * behavior, byte-identical). Flipping the env vars is the ENTIRE enable step once a bucket is provisioned.
 */
export function s3FileStoreFromEnv(): FileStore | null {
  const bucket = env.BULK_IMPORT_S3_BUCKET;
  const accessKeyId = env.BULK_IMPORT_S3_ACCESS_KEY_ID;
  const secretAccessKey = env.BULK_IMPORT_S3_SECRET_ACCESS_KEY;
  if (!bucket || !accessKeyId || !secretAccessKey) return null;
  const sse = env.BULK_IMPORT_S3_SSE === "none" ? undefined : env.BULK_IMPORT_S3_SSE;
  return s3FileStore({
    bucket,
    region: env.BULK_IMPORT_S3_REGION,
    endpoint: env.BULK_IMPORT_S3_ENDPOINT,
    accessKeyId,
    secretAccessKey,
    sse,
    presignTtlSeconds: env.BULK_IMPORT_S3_PRESIGN_TTL_SECONDS,
  });
}

/** Convenience for the roots: the env-selected store, falling back to the dev/test disk adapter. */
export function bulkObjectStoreFromEnv(): FileStore {
  return s3FileStoreFromEnv() ?? diskFileStore(env.BULK_IMPORT_STORAGE_DIR);
}
