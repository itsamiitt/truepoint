// s3FileStore.itest.ts — the GATE-B CLEARANCE ITEST (import-redesign 14 §gates / 15 §T-P2 "Gate-B
// put→signed-get→expiry itest (08 §8)"): the round-trip against a REAL, NON-PROD S3-compatible bucket.
// ENV-GATED: it runs only when the BULK_IMPORT_S3_* surface is set in CI (a dedicated non-prod bucket —
// NEVER a production one); with the env absent every test SKIPS cleanly, so the suite is green either way.
// CI-RUN: this sandbox cannot execute bun — CI is the gate. Objects are written under a unique run prefix
// and deleted at the end (deletePrefix doubles as its own assertion).

import { afterAll, describe, expect, test } from "bun:test";
import { s3FileStore } from "./s3FileStore.ts";

const bucket = process.env.BULK_IMPORT_S3_BUCKET;
const accessKeyId = process.env.BULK_IMPORT_S3_ACCESS_KEY_ID;
const secretAccessKey = process.env.BULK_IMPORT_S3_SECRET_ACCESS_KEY;
const enabled = Boolean(bucket && accessKeyId && secretAccessKey);

const d = enabled ? describe : describe.skip;

const runPrefix = `itest/${crypto.randomUUID()}/`;

function makeStore(presignTtlSeconds = 300) {
  return s3FileStore({
    bucket: bucket ?? "unset",
    region: process.env.BULK_IMPORT_S3_REGION ?? "us-east-1",
    endpoint: process.env.BULK_IMPORT_S3_ENDPOINT,
    accessKeyId: accessKeyId ?? "unset",
    secretAccessKey: secretAccessKey ?? "unset",
    sse: process.env.BULK_IMPORT_S3_SSE === "none" ? undefined : (process.env.BULK_IMPORT_S3_SSE ?? undefined),
    presignTtlSeconds,
  });
}

async function drain(iter: AsyncIterable<Uint8Array>): Promise<string> {
  const parts: Uint8Array[] = [];
  for await (const c of iter) parts.push(c);
  return new TextDecoder().decode(Buffer.concat(parts));
}

d("Gate B — S3 FileStore round-trip (non-prod bucket)", () => {
  const store = makeStore();

  afterAll(async () => {
    await store.deletePrefix(runPrefix).catch(() => undefined);
  });

  test("putObject (stream) → getObjectStream returns the same bytes", async () => {
    const key = `${runPrefix}source.csv`;
    const content = "email,name\r\na@example.com,Ada\r\n";
    async function* body(): AsyncIterable<Uint8Array> {
      yield new TextEncoder().encode(content);
    }
    await store.putObject(key, body());
    expect(await drain(await store.getObjectStream(key))).toBe(content);
  }, 30_000);

  test("putArtifact → signed GET succeeds within the TTL", async () => {
    const key = `${runPrefix}errors.csv`;
    await store.putArtifact(key, new TextEncoder().encode("error_code,column\r\n"));
    const url = await store.getSignedDownloadUrl(key);
    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("error_code,column\r\n");
  }, 30_000);

  test("an EXPIRED presigned URL is refused (the expiry half of the Gate-B itest)", async () => {
    const shortStore = makeStore(1); // 1-second TTL
    const key = `${runPrefix}expiry.csv`;
    await shortStore.putArtifact(key, new TextEncoder().encode("x\r\n"));
    const url = await shortStore.getSignedDownloadUrl(key);
    await new Promise((r) => setTimeout(r, 3_000));
    const res = await fetch(url);
    expect(res.status).toBeGreaterThanOrEqual(400); // 403 AccessDenied (expired) on AWS/R2/MinIO
  }, 30_000);

  test("deleteObject is idempotent and deletePrefix clears the run prefix", async () => {
    const key = `${runPrefix}gone.csv`;
    await store.putArtifact(key, new Uint8Array([1]));
    await store.deleteObject(key);
    await store.deleteObject(key); // second delete = no-op, never an error
    await store.putArtifact(`${runPrefix}a.csv`, new Uint8Array([1]));
    await store.putArtifact(`${runPrefix}b.csv`, new Uint8Array([2]));
    await store.deletePrefix(runPrefix);
    // A GET on a deleted key must fail — the prefix is really gone.
    await expect(
      (async () => {
        await drain(await store.getObjectStream(`${runPrefix}a.csv`));
      })(),
    ).rejects.toThrow();
  }, 60_000);
});
