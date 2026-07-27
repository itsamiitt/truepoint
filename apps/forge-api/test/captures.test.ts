import { describe, expect, test } from "bun:test";
import type { CaptureAck, IngestionEnvelopeV2, RawRecordV2 } from "@leadwolf/types";
import { type CapturesDeps, createCapturesApp } from "../src/features/captures/routes.ts";

const TENANT = "00000000-0000-0000-0000-000000000001";
const OTHER = "00000000-0000-0000-0000-000000000002";

function baseDeps(over: Partial<CapturesDeps> = {}): CapturesDeps {
  return {
    land: async (): Promise<CaptureAck> => ({
      batchId: "b",
      accepted: 1,
      duplicate: 0,
      rejected: 0,
    }),
    rateLimit: { check: async () => ({ allowed: true }) },
    resolveCaller: (c) => {
      const tenantId = c.req.header("x-forge-tenant");
      if (!tenantId) return null;
      // Capture-scoped by default; `x-no-scope: 1` opts the token OUT to exercise the P-01.15 403.
      return { callerId: "caller", tenantId, captureScoped: c.req.header("x-no-scope") !== "1" };
    },
    gate: { captureEnabled: true, isTenantEnabled: () => true },
    caps: {
      maxEnvelopeBytes: 1000,
      maxRecordBytes: 500,
      endpointAllowlist: ["voyager/identity/profiles"],
    },
    ...over,
  };
}

function record(over: Partial<RawRecordV2> = {}): RawRecordV2 {
  return {
    rawPayload: "{}",
    endpoint: "voyager/identity/profiles",
    schemaVersion: "1-0-0",
    contentType: "application/json",
    contentHash: "a".repeat(64),
    capturedAt: "2026-07-06T00:00:00.000Z",
    byteSize: 2,
    ...over,
  };
}

function envelope(over: Partial<IngestionEnvelopeV2> = {}): IngestionEnvelopeV2 {
  return {
    envelopeVersion: "2",
    source: "chrome_extension",
    scope: { tenantId: TENANT },
    idempotencyKey: "k",
    collectedAt: "2026-07-06T00:00:00.000Z",
    gzip: false,
    size: 2,
    records: [record()],
    ...over,
  };
}

function post(
  deps: CapturesDeps,
  body: unknown,
  headers: Record<string, string> = { "x-forge-tenant": TENANT, "x-forge-caller": "caller" },
) {
  return createCapturesApp(deps).request("/v1/captures", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("POST /v1/captures", () => {
  test("happy path → 202 with the ack", async () => {
    const res = await post(baseDeps(), envelope());
    expect(res.status).toBe(202);
    const body = (await res.json()) as CaptureAck;
    expect(body.accepted).toBe(1);
  });

  test("no auth → 401", async () => {
    const res = await post(baseDeps(), envelope(), {});
    expect(res.status).toBe(401);
  });

  test("authenticated but NOT capture-scoped → 403 insufficient_scope (P-01.15)", async () => {
    const res = await post(baseDeps(), envelope(), {
      "x-forge-tenant": TENANT,
      "x-no-scope": "1",
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "insufficient_scope" });
  });

  test("capture disabled (kill-switch off) → 403", async () => {
    const res = await post(
      baseDeps({ gate: { captureEnabled: false, isTenantEnabled: () => true } }),
      envelope(),
    );
    expect(res.status).toBe(403);
  });

  test("scope mismatch → 403", async () => {
    const res = await post(baseDeps(), envelope({ scope: { tenantId: OTHER } }));
    expect(res.status).toBe(403);
  });

  test("oversize record → 413, measured from the PAYLOAD", async () => {
    // maxRecordBytes is 500. This used to pass `byteSize: 999` with a 2-byte payload and assert a 413 — i.e.
    // it asserted that the server believed the client's number. It now measures, so the test has to send a
    // genuinely oversized payload. (The inverse — a huge payload declaring a small byteSize — is the actual
    // attack, and is covered below.)
    const big = `"${"x".repeat(600)}"`;
    const res = await post(baseDeps(), envelope({ records: [record({ rawPayload: big })] }));
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: "record_too_large" });
  });

  test("a LYING byteSize cannot smuggle an oversized record past the cap (F-0.1)", async () => {
    // The defect: byteSize was a plain z.number() and was what the per-record 413 read, so `byteSize: 0` on a
    // multi-megabyte payload cleared the cap outright — and then landed the whole thing inline in JSONB,
    // because the object-store threshold read the same field.
    const big = `"${"x".repeat(600)}"`;
    const res = await post(
      baseDeps(),
      envelope({ records: [record({ rawPayload: big, byteSize: 0 })] }),
    );
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: "record_too_large" });
  });

  test("a LYING envelope size cannot smuggle an oversized batch past the cap", async () => {
    // maxEnvelopeBytes is 1000. Three 400-byte payloads exceed it, while `size: 1` claims otherwise.
    const chunk = `"${"y".repeat(400)}"`;
    const res = await post(
      baseDeps(),
      envelope({
        size: 1,
        records: [
          record({ rawPayload: chunk }),
          record({ rawPayload: chunk }),
          record({ rawPayload: chunk }),
        ],
      }),
    );
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: "envelope_too_large" });
  });

  test("the byte throttle is charged the REAL size, not the declared one", async () => {
    // envelope.size also fed the 64MB/min byte throttle, so `size: 1` made a large batch nearly free against
    // it. The limiter must be told what actually arrived.
    const charged: Array<{ records: number; bytes: number }> = [];
    const payload = `"${"z".repeat(100)}"`;
    const deps = baseDeps({
      rateLimit: {
        check: async (_caller: string, records: number, bytes: number) => {
          charged.push({ records, bytes });
          return { allowed: true };
        },
      },
    });
    await post(deps, envelope({ size: 1, records: [record({ rawPayload: payload })] }));
    expect(charged).toHaveLength(1);
    expect(charged[0]?.bytes).toBe(Buffer.byteLength(payload, "utf8"));
  });

  test("an oversized Content-Length is refused before the body is parsed", async () => {
    // A fast path only — Content-Length is client-declared, so it is advisory. The real enforcement is the
    // derived-size check above plus Bun's maxRequestBodySize, both pinned to the same cap.
    let landed = 0;
    const deps = baseDeps({
      land: async () => {
        landed++;
        return { batchId: "b", accepted: 1, duplicate: 0, rejected: 0 };
      },
    });
    const res = await post(deps, envelope(), {
      "x-forge-tenant": TENANT,
      "content-length": "999999",
    });
    expect(res.status).toBe(413);
    expect(landed).toBe(0);
  });

  test("endpoint outside the allowlist → 400", async () => {
    const res = await post(baseDeps(), envelope({ records: [record({ endpoint: "evil/x" })] }));
    expect(res.status).toBe(400);
  });

  test("rate limited → 429 + Retry-After", async () => {
    const res = await post(
      baseDeps({ rateLimit: { check: async () => ({ allowed: false, retryAfter: 30 }) } }),
      envelope(),
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("30");
  });

  test("provenance is server-bound: landed capturedBy is the caller, not the client's claim (P-01.13)", async () => {
    let landed: IngestionEnvelopeV2 | undefined;
    const deps = baseDeps({
      land: async (env): Promise<CaptureAck> => {
        landed = env;
        return { batchId: "b", accepted: 1, duplicate: 0, rejected: 0 };
      },
    });
    // The client tries to attribute the capture to another user; the server must ignore it.
    const res = await post(deps, envelope({ capturedBy: "00000000-0000-0000-0000-0000000000ff" }));
    expect(res.status).toBe(202);
    expect(landed?.capturedBy).toBe("caller"); // overridden with the authenticated caller's id
  });
});
