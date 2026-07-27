// opsSurface.test.ts — the throttle scope and the /metrics gate.
//
// Both were missing. apps/api throttles /api/* and gates /metrics behind METRICS_TOKEN; forge-api applied
// NEITHER, so every unbounded /bff/* cross-tenant read and the review/approve promotion write were unthrottled,
// and Prometheus exposition was served unauthenticated on the public forge-api.truepoint.in origin.
//
// The throttle is injected (not imported inside the app factory) precisely so this test can observe it without a
// Redis client — the same reason the rest of forge-api is composed through fakes.

import { describe, expect, test } from "bun:test";
import { RateLimitedError } from "@leadwolf/types";
import { createForgeApi } from "../src/app.ts";
import type { CapturesDeps } from "../src/features/captures/routes.ts";
import type { BffDeps } from "../src/features/dashboard-bff/routes.ts";
import type { ReviewDeps } from "../src/features/review/routes.ts";

function app(opts: { rateLimit?: (key: string) => Promise<void>; metricsToken?: string } = {}) {
  const captures: CapturesDeps = {
    land: async () => ({ batchId: "b", accepted: 0, duplicate: 0, rejected: 0 }),
    rateLimit: { check: async () => ({ allowed: true }) },
    resolveCaller: () => null,
    gate: { captureEnabled: false, isTenantEnabled: () => false },
    caps: { maxEnvelopeBytes: 1, maxRecordBytes: 1, endpointAllowlist: [] },
  };
  const bff: BffDeps = {
    audit: async () => {},
    resolveStaff: (c) => {
      const userId = c.req.header("x-staff");
      return userId ? { userId, capabilities: ["data:read"] } : null;
    },
    readers: {
      overview: async () => ({ ok: true }),
      reviewTasks: async () => ({}),
      parsers: async () => ({}),
      syncStatus: async () => ({}),
      captures: async () => ({ captures: [] }),
      identity: async () => ({ email: null }),
    },
  };
  const review: ReviewDeps = {
    resolveStaff: () => null,
    promote: async () => ({ verifiedId: "v1", written: true }),
    loadApprovalRequest: async () => null,
  };
  return createForgeApi({ captures, bff, review, ...opts });
}

describe("coarse throttle", () => {
  test("applies to API routes, keyed by the trusted-hop client IP", async () => {
    const keys: string[] = [];
    const res = await app({
      rateLimit: async (k) => {
        keys.push(k);
      },
    }).request("/bff/overview", {
      headers: { "x-staff": "u1", "x-forwarded-for": "203.0.113.9, 10.0.0.1" },
    });
    expect(res.status).toBe(200);
    // 10.0.0.1 is what the trusted edge appended; 203.0.113.9 is the forgeable part and must not be the key.
    expect(keys).toEqual(["forge:ip:10.0.0.1"]);
  });

  test("still applies to a route that 404s (the limit precedes routing)", async () => {
    const keys: string[] = [];
    await app({
      rateLimit: async (k) => {
        keys.push(k);
      },
    }).request("/nope");
    expect(keys).toHaveLength(1);
  });

  test("exempts the ops endpoints so health polling and scraping are never throttled", async () => {
    const keys: string[] = [];
    const a = app({
      rateLimit: async (k) => {
        keys.push(k);
      },
      metricsToken: "secret",
    });
    for (const path of ["/ready", "/live", "/metrics"]) {
      await a.request(path, { headers: { authorization: "Bearer secret" } });
    }
    expect(keys).toEqual([]);
  });

  test("exhaustion surfaces as a real 429 problem+json, not a 500", async () => {
    // The genuine error the limiter throws (RateLimitedError extends AppError), so this asserts the actual
    // mapping through onError rather than a look-alike shape.
    const res = await app({
      rateLimit: async () => {
        throw new RateLimitedError(30);
      },
    }).request("/bff/overview", { headers: { "x-staff": "u1" } });
    expect(res.status).toBe(429);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    expect(await res.json()).toMatchObject({ status: 429, code: "rate_limited" });
  });
});

describe("/metrics gate", () => {
  test("404s when no token is configured (invisible, not 401)", async () => {
    const res = await app().request("/metrics");
    expect(res.status).toBe(404);
  });

  test("404s on a wrong token — never confirms that the endpoint exists", async () => {
    const res = await app({ metricsToken: "secret" }).request("/metrics", {
      headers: { authorization: "Bearer wrong" },
    });
    expect(res.status).toBe(404);
  });

  test("serves exposition with the correct bearer token", async () => {
    const res = await app({ metricsToken: "secret" }).request("/metrics", {
      headers: { authorization: "Bearer secret" },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("forge_api_up");
  });

  test("/ready and /live stay open (the orchestrator has no secret)", async () => {
    expect((await app().request("/ready")).status).toBe(200);
    expect((await app().request("/live")).status).toBe(200);
  });
});
