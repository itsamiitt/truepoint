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
      return tenantId ? { callerId: "caller", tenantId } : null;
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

  test("oversize record → 413", async () => {
    const res = await post(baseDeps(), envelope({ records: [record({ byteSize: 999 })] }));
    expect(res.status).toBe(413);
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
