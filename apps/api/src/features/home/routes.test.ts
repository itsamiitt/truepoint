// routes.test.ts — proves the Home summary route's transport caching: every response carries a body-derived
// weak ETag + a short `private` Cache-Control, and a conditional request whose If-None-Match matches gets a
// 304 with no body (a different/absent token re-sends the full body). authn/tenancy + buildHomeSummary are
// mocked (bun module mocks are process-global) so the test drives the REAL route through app.request().

import { describe, expect, it, mock } from "bun:test";
import type {
  DataQualityTrendPoint,
  HomeSummary,
  ReverificationRun,
  WorkspaceDataQuality,
} from "@leadwolf/types";

// A minimal but schema-valid summary (the route parses it against homeSummarySchema before sending).
const summary: HomeSummary = {
  creditBalance: 0,
  burn: [],
  recentReveals: [],
  hotLeads: [],
  recentImports: [],
  enrichmentActivity: [],
  sequenceSnapshot: { activeSequences: 0, enrolled: 0, sent: 0, replied: 0 },
  activityFeed: [],
  todaysTasks: [],
  recentReplies: [],
};

const dataQuality: WorkspaceDataQuality = {
  total: 3,
  withName: 3,
  withEmail: 2,
  withPhone: 1,
  withTitle: 2,
  withCompany: 2,
  withLinkedin: 1,
  withLocation: 1,
  emailValid: 1,
  emailRisky: 0,
  emailInvalid: 1,
  emailCatchAll: 0,
  emailUnverified: 0,
  emailUnknown: 0,
  phoneValid: 1,
  phoneInvalid: 0,
  phoneMobile: 1,
  phoneLandline: 0,
  phoneVoip: 0,
  fresh: 1,
  stale: 1,
  neverVerified: 1,
};

const trend: DataQualityTrendPoint[] = [
  { capturedAt: "2026-06-01T00:00:00.000Z", metrics: dataQuality },
];

const reverificationRuns: ReverificationRun[] = [
  {
    id: "00000000-0000-4000-8000-000000000001",
    startedAt: "2026-06-01T00:00:00.000Z",
    finishedAt: "2026-06-01T00:00:01.000Z",
    scanned: 10,
    reverified: 7,
    errored: 1,
    createdAt: "2026-06-01T00:00:01.000Z",
  },
];

// authn/tenancy: pass through and stash a tenant + workspace so requireRole + the handler proceed.
mock.module("../../middleware/authn.ts", () => ({
  authn: async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
    c.set("claims", { sub: "u1", tid: "t1", wid: "w1" });
    await next();
  },
}));
mock.module("../../middleware/tenancy.ts", () => ({
  tenancy: async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
    c.set("tenantId", "t1");
    c.set("workspaceId", "w1");
    await next();
  },
}));
// requireRole: allow through and stash the role under the real key ("role") — the /summary handler now
// reads it via getWorkspaceRole to build the JobViewer (import-redesign S-V2), so the mock must export
// getWorkspaceRole too (mock.module replaces the whole module).
mock.module("../../middleware/requireRole.ts", () => ({
  requireRole:
    () => async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set("role", "owner");
      await next();
    },
  getWorkspaceRole: (c: { get: (k: string) => unknown }) => c.get("role"),
}));

mock.module("@leadwolf/core", () => ({
  buildHomeSummary: async () => summary,
  buildDataQualitySummary: async () => dataQuality,
  recentDataQualityTrend: async () => trend,
  recentReverificationRuns: async () => reverificationRuns,
  // buildJobViewer (middleware/jobViewer.ts) imports this; with JOB_VISIBILITY_SCOPED unset it is never
  // CALLED, but the mocked module must still export it so the import binding resolves.
  isFlagEnabledForTenant: async () => false,
}));

const { homeRoutes } = await import("./routes.ts");

describe("GET /home/data-quality", () => {
  it("returns the workspace data-quality rollup with a private Cache-Control", async () => {
    const res = await homeRoutes.request("/data-quality");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, max-age=30");
    expect((await res.json()) as WorkspaceDataQuality).toEqual(dataQuality);
  });
});

describe("GET /home/data-quality/history", () => {
  it("returns the workspace data-quality trend series", async () => {
    const res = await homeRoutes.request("/data-quality/history");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, max-age=300");
    expect((await res.json()) as DataQualityTrendPoint[]).toEqual(trend);
  });
});

describe("GET /home/data-quality/reverification-runs", () => {
  it("returns the workspace re-verification run history", async () => {
    const res = await homeRoutes.request("/data-quality/reverification-runs");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, max-age=60");
    expect((await res.json()) as ReverificationRun[]).toEqual(reverificationRuns);
  });
});

describe("GET /home/summary caching headers", () => {
  it("returns the summary with a weak ETag and a private Cache-Control", async () => {
    const res = await homeRoutes.request("/summary");
    expect(res.status).toBe(200);
    const etag = res.headers.get("etag");
    expect(etag).toMatch(/^W\/".+"$/);
    expect(res.headers.get("cache-control")).toBe("private, max-age=30");
    const body = (await res.json()) as HomeSummary;
    expect(body).toEqual(summary);
  });

  it("returns the same ETag for an unchanged summary across requests", async () => {
    const a = await homeRoutes.request("/summary");
    const b = await homeRoutes.request("/summary");
    expect(a.headers.get("etag")).toBe(b.headers.get("etag"));
  });

  it("returns 304 with no body when If-None-Match matches", async () => {
    const first = await homeRoutes.request("/summary");
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();

    const second = await homeRoutes.request("/summary", {
      headers: { "if-none-match": etag as string },
    });
    expect(second.status).toBe(304);
    expect(second.headers.get("etag")).toBe(etag);
    expect(second.headers.get("cache-control")).toBe("private, max-age=30");
    expect(await second.text()).toBe("");
  });

  it("returns 200 with the full body when If-None-Match does not match", async () => {
    const res = await homeRoutes.request("/summary", {
      headers: { "if-none-match": 'W/"stale"' },
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as HomeSummary).toEqual(summary);
  });

  it("returns 304 when If-None-Match is a comma-list containing the current ETag", async () => {
    const etag = (await homeRoutes.request("/summary")).headers.get("etag") as string;
    const res = await homeRoutes.request("/summary", {
      headers: { "if-none-match": `W/"stale", ${etag}` },
    });
    expect(res.status).toBe(304);
  });

  it("returns 304 when If-None-Match is the wildcard *", async () => {
    const res = await homeRoutes.request("/summary", { headers: { "if-none-match": "*" } });
    expect(res.status).toBe(304);
  });
});
