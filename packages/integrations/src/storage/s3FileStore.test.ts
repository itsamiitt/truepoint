// s3FileStore.test.ts — CI-RUN unit tests for the Gate-B S3-compatible adapter (no network: fetch injected).
// Covers: the SigV4 signing-key derivation against AWS's PUBLISHED example vector; the signed-request shape
// (authorization header, payload hash, SSE header); path-style vs virtual-host addressing; the presigned-GET
// URL contract (query auth, bounded TTL); multipart engagement above the part size (initiate → parts →
// complete) vs plain PUT below it; idempotent delete; and the ListObjectsV2-walk deletePrefix. The
// put→signed-get→expiry round-trip against a REAL non-prod bucket is the sibling .itest.ts (env-gated).

import { describe, expect, test } from "bun:test";
import { S3StoreError, s3FileStore, sha256Hex, sigV4SigningKey } from "./s3FileStore.ts";

/** Capture every request the adapter makes; answer from a scripted queue (default 200 empty). */
function fetchRecorder(
  respond?: (url: string, init: RequestInit) => Response | undefined,
): {
  calls: Array<{ url: string; init: RequestInit }>;
  fetchFn: (url: string, init: RequestInit) => Promise<Response>;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  return {
    calls,
    fetchFn: async (url, init) => {
      calls.push({ url, init });
      return respond?.(url, init) ?? new Response("", { status: 200 });
    },
  };
}

const FIXED_NOW = () => new Date("2026-07-05T12:00:00.000Z");

function makeStore(overrides?: Partial<Parameters<typeof s3FileStore>[0]>) {
  const rec = fetchRecorder(overrides?.fetchFn ? undefined : undefined);
  const store = s3FileStore({
    bucket: "tp-test-bucket",
    region: "us-east-1",
    accessKeyId: "AKIDEXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
    sse: "AES256",
    now: FIXED_NOW,
    fetchFn: rec.fetchFn,
    ...overrides,
  });
  return { store, rec };
}

function header(init: RequestInit, name: string): string | undefined {
  return (init.headers as Record<string, string> | undefined)?.[name];
}

describe("SigV4 signing key", () => {
  test("matches AWS's published derivation example", () => {
    // The canonical example from the AWS SigV4 docs ("Deriving the signing key"): secret
    // wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY, 20150830, us-east-1, iam.
    const key = sigV4SigningKey(
      "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
      "20150830",
      "us-east-1",
      "iam",
    );
    expect(key.toString("hex")).toBe(
      "c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9",
    );
  });

  test("sha256Hex of empty input is the SigV4 empty-payload constant", () => {
    expect(sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
});

describe("signed request shape", () => {
  test("putArtifact signs headers, hashes the payload, and carries the SSE header", async () => {
    const { store, rec } = makeStore();
    const bytes = new TextEncoder().encode("a,b\r\n1,2");
    await store.putArtifact("imports/job-1/errors.csv", bytes);

    expect(rec.calls).toHaveLength(1);
    const call = rec.calls[0]!;
    // Virtual-host addressing (no endpoint): bucket in the host, key as the path.
    expect(call.url).toBe(
      "https://tp-test-bucket.s3.us-east-1.amazonaws.com/imports/job-1/errors.csv",
    );
    expect(call.init.method).toBe("PUT");
    expect(header(call.init, "x-amz-content-sha256")).toBe(sha256Hex(bytes));
    expect(header(call.init, "x-amz-server-side-encryption")).toBe("AES256");
    expect(header(call.init, "x-amz-date")).toBe("20260705T120000Z");
    const auth = header(call.init, "authorization") ?? "";
    expect(auth).toStartWith(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20260705/us-east-1/s3/aws4_request, SignedHeaders=",
    );
    expect(auth).toMatch(/Signature=[0-9a-f]{64}$/);
    // host is signed but never sent as an explicit header (fetch derives it from the URL).
    expect(auth).toContain("host;");
    expect(header(call.init, "host")).toBeUndefined();
  });

  test("endpoint set ⇒ path-style addressing (R2/MinIO)", async () => {
    const { store, rec } = makeStore({ endpoint: "https://acc.r2.cloudflarestorage.com" });
    await store.putArtifact("imports/j/repair.csv", new Uint8Array([1]));
    expect(rec.calls[0]!.url).toBe(
      "https://acc.r2.cloudflarestorage.com/tp-test-bucket/imports/j/repair.csv",
    );
  });

  test("sse omitted ⇒ no SSE header on writes", async () => {
    const { store, rec } = makeStore({ sse: undefined });
    await store.putArtifact("k.csv", new Uint8Array([1]));
    expect(header(rec.calls[0]!.init, "x-amz-server-side-encryption")).toBeUndefined();
  });

  test("a non-2xx response throws S3StoreError with status + S3 code, never headers", async () => {
    const { store } = makeStore({
      fetchFn: async () =>
        new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403 }),
    });
    try {
      await store.putArtifact("k.csv", new Uint8Array([1]));
      throw new Error("expected S3StoreError");
    } catch (err) {
      expect(err).toBeInstanceOf(S3StoreError);
      const e = err as S3StoreError;
      expect(e.status).toBe(403);
      expect(e.s3Code).toBe("AccessDenied");
      expect(e.message).not.toContain("EXAMPLEKEY"); // never a credential in the message
    }
  });
});

describe("presigned download URL", () => {
  test("query-auth presign with the bounded TTL and a 64-hex signature", async () => {
    const { store } = makeStore({ presignTtlSeconds: 300 });
    const url = new URL(await store.getSignedDownloadUrl("imports/job-1/repair.csv"));
    expect(url.host).toBe("tp-test-bucket.s3.us-east-1.amazonaws.com");
    expect(url.pathname).toBe("/imports/job-1/repair.csv");
    expect(url.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(url.searchParams.get("X-Amz-Credential")).toBe(
      "AKIDEXAMPLE/20260705/us-east-1/s3/aws4_request",
    );
    expect(url.searchParams.get("X-Amz-Expires")).toBe("300");
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
  });

  test("the signature changes with the secret (it is a real MAC, not a template)", async () => {
    const { store: a } = makeStore();
    const { store: b } = makeStore({ secretAccessKey: "another-secret" });
    const [ua, ub] = [await a.getSignedDownloadUrl("k"), await b.getSignedDownloadUrl("k")];
    expect(new URL(ua).searchParams.get("X-Amz-Signature")).not.toBe(
      new URL(ub).searchParams.get("X-Amz-Signature"),
    );
  });
});

describe("putObject streaming", () => {
  async function* chunks(...parts: string[]): AsyncIterable<Uint8Array> {
    for (const p of parts) yield new TextEncoder().encode(p);
  }

  test("a stream under the part size lands as ONE plain PUT (no multipart)", async () => {
    const { store, rec } = makeStore({ partSizeBytes: 1024 });
    await store.putObject("imports/u/source.csv", chunks("a,b\r\n", "1,2\r\n"));
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0]!.init.method).toBe("PUT");
    expect(rec.calls[0]!.url).toContain("/imports/u/source.csv");
    // The buffered body was hashed for real (not UNSIGNED) — encrypted-at-rest header rides it too.
    expect(header(rec.calls[0]!.init, "x-amz-content-sha256")).toBe(
      sha256Hex(new TextEncoder().encode("a,b\r\n1,2\r\n")),
    );
  });

  test("a stream over the part size engages multipart: initiate → parts → complete", async () => {
    const { fetchFn, calls } = (() => {
      const rec = fetchRecorder((url, init) => {
        if (url.includes("uploads=") && init.method === "POST") {
          return new Response(
            "<InitiateMultipartUploadResult><UploadId>UP-1</UploadId></InitiateMultipartUploadResult>",
            { status: 200 },
          );
        }
        if (url.includes("partNumber=")) {
          return new Response("", { status: 200, headers: { etag: '"etag-x"' } });
        }
        if (url.includes("uploadId=") && init.method === "POST") {
          return new Response(
            "<CompleteMultipartUploadResult></CompleteMultipartUploadResult>",
            { status: 200 },
          );
        }
        return new Response("", { status: 200 });
      });
      return { fetchFn: rec.fetchFn, calls: rec.calls };
    })();
    const store = s3FileStore({
      bucket: "b",
      region: "us-east-1",
      accessKeyId: "AK",
      secretAccessKey: "SK",
      partSizeBytes: 4, // test-only tiny parts
      fetchFn,
      now: FIXED_NOW,
    });
    await store.putObject("k.csv", chunks("aaaa", "bbbb", "cc"));

    const methodsAndUrls = calls.map((c) => `${c.init.method} ${c.url.split("?")[1] ?? ""}`);
    expect(methodsAndUrls[0]).toBe("POST uploads=");
    expect(methodsAndUrls.filter((m) => m.includes("partNumber="))).toHaveLength(3); // 4+4+2 bytes
    expect(methodsAndUrls.at(-1)).toBe("POST uploadId=UP-1");
    const completeBody = calls.at(-1)!.init.body as Uint8Array;
    expect(new TextDecoder().decode(completeBody)).toContain("<PartNumber>3</PartNumber>");
  });

  test("a mid-upload failure aborts the multipart upload (no billable orphan parts)", async () => {
    let partCalls = 0;
    const rec = fetchRecorder((url, init) => {
      if (url.includes("uploads=") && init.method === "POST") {
        return new Response("<r><UploadId>UP-2</UploadId></r>", { status: 200 });
      }
      if (url.includes("partNumber=")) {
        partCalls += 1;
        return partCalls > 1
          ? new Response("<Error><Code>InternalError</Code></Error>", { status: 500 })
          : new Response("", { status: 200, headers: { etag: '"e1"' } });
      }
      return new Response("", { status: 204 });
    });
    const store = s3FileStore({
      bucket: "b",
      region: "r",
      accessKeyId: "AK",
      secretAccessKey: "SK",
      partSizeBytes: 2,
      fetchFn: rec.fetchFn,
      now: FIXED_NOW,
    });
    await expect(store.putObject("k", chunks("aa", "bb", "cc"))).rejects.toThrow(S3StoreError);
    const abort = rec.calls.find((c) => c.init.method === "DELETE" && c.url.includes("uploadId="));
    expect(abort).toBeDefined();
  });
});

describe("delete surface (S-S7)", () => {
  test("deleteObject treats 404 as success (idempotent)", async () => {
    const { store } = makeStore({ fetchFn: async () => new Response("", { status: 404 }) });
    await expect(store.deleteObject("gone.csv")).resolves.toBeUndefined();
  });

  test("deletePrefix walks ListObjectsV2 and deletes every listed key", async () => {
    const deleted: string[] = [];
    const rec = fetchRecorder((url, init) => {
      if (init.method === "GET" && url.includes("list-type=2")) {
        return new Response(
          "<ListBucketResult><Contents><Key>imports/j1/repair.csv</Key></Contents>" +
            "<Contents><Key>imports/j1/errors.csv</Key></Contents>" +
            "<IsTruncated>false</IsTruncated></ListBucketResult>",
          { status: 200 },
        );
      }
      if (init.method === "DELETE") {
        deleted.push(url);
        return new Response("", { status: 204 });
      }
      return new Response("", { status: 200 });
    });
    const store = s3FileStore({
      bucket: "b",
      region: "r",
      accessKeyId: "AK",
      secretAccessKey: "SK",
      fetchFn: rec.fetchFn,
      now: FIXED_NOW,
    });
    await store.deletePrefix("imports/j1/");
    expect(deleted).toHaveLength(2);
    expect(deleted[0]).toContain("imports/j1/repair.csv");
    expect(deleted[1]).toContain("imports/j1/errors.csv");
  });
});
