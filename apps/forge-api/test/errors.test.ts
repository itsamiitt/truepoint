import { describe, expect, test } from "bun:test";
import { createForgeApi } from "../src/app.ts";
import type { CapturesDeps } from "../src/features/captures/routes.ts";
import type { BffDeps } from "../src/features/dashboard-bff/routes.ts";
import type { ReviewDeps } from "../src/features/review/routes.ts";

/** Compose the FULL app (createForgeApi registers notFound/onError) with inert fakes. */
function app(over: { overview?: () => Promise<unknown> } = {}) {
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
      overview: over.overview ?? (async () => ({ ok: true })),
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
  return createForgeApi({ captures, bff, review });
}

describe("forge-api error surface (RFC 9457)", () => {
  test("unknown route → 404 problem+json (distinguishable from the Next console's HTML 404)", async () => {
    const res = await app().request("/nope");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    expect(await res.json()).toMatchObject({ status: 404, code: "not_found" });
  });

  test("a thrown reader → 500 problem+json with no message/stack leak", async () => {
    const res = await app({
      overview: async () => {
        throw new Error("boom");
      },
    }).request("/bff/overview", { headers: { "x-staff": "u1" } });
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    const text = await res.text();
    expect(text).not.toContain("boom");
    expect(text).not.toContain("stack");
    expect(JSON.parse(text)).toMatchObject({ status: 500, code: "internal" });
  });
});
