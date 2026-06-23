// routes.test.ts — proves the Home summary route's transport caching: every response carries a body-derived
// weak ETag + a short `private` Cache-Control, and a conditional request whose If-None-Match matches gets a
// 304 with no body (a different/absent token re-sends the full body). authn/tenancy + buildHomeSummary are
// mocked (bun module mocks are process-global) so the test drives the REAL route through app.request().

import { describe, expect, it, mock } from "bun:test";
import type { HomeSummary } from "@leadwolf/types";

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
// requireRole: allow through and stash a role (the handler doesn't read it, but keep the surface honest).
mock.module("../../middleware/requireRole.ts", () => ({
  requireRole:
    () => async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set("workspaceRole", "owner");
      await next();
    },
}));

mock.module("@leadwolf/core", () => ({
  buildHomeSummary: async () => summary,
}));

const { homeRoutes } = await import("./routes.ts");

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
