import { describe, expect, test } from "bun:test";
import { type BffDeps, createBffApp } from "../src/features/dashboard-bff/routes.ts";
import type { Capability } from "../src/middleware/capability.ts";

function deps(caps: Capability[]): BffDeps {
  return {
    resolveStaff: (c) => {
      const userId = c.req.header("x-staff");
      return userId ? { userId, capabilities: caps, staffRole: "data_ops" } : null;
    },
    readers: {
      overview: async () => ({ ok: "overview" }),
      reviewTasks: async () => ({ ok: "review" }),
      parsers: async () => ({ ok: "parsers" }),
      syncStatus: async () => ({ ok: "sync" }),
      captures: async () => ({
        captures: [
          {
            id: "c1",
            source: "chrome_extension",
            sourceUrl: "voyager/identity/profiles",
            parser: null,
            status: "captured",
            capturedAt: "2026-07-06T00:00:00.000Z",
          },
        ],
      }),
      identity: async (userId) => ({ email: `${userId}@truepoint.in` }),
    },
  };
}

const get = (d: BffDeps, path: string, headers: Record<string, string> = { "x-staff": "u1" }) =>
  createBffApp(d).request(path, { headers });

describe("dashboard BFF capability gate (13 §3)", () => {
  test("no auth → 401", async () => {
    expect((await get(deps(["data:read"]), "/bff/overview", {})).status).toBe(401);
  });

  test("the gated 401 is RFC 9457 problem+json (the DEPLOY.md stale-edge probe relies on it)", async () => {
    const res = await get(deps(["data:read"]), "/bff/overview", {});
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    expect(await res.json()).toMatchObject({ status: 401, code: "unauthorized" });
  });

  test("data:read → overview 200", async () => {
    expect((await get(deps(["data:read"]), "/bff/overview")).status).toBe(200);
  });

  test("the review queue needs data:review → 403 with only data:read", async () => {
    expect((await get(deps(["data:read"]), "/bff/review-tasks")).status).toBe(403);
  });

  test("data:review → review-tasks 200", async () => {
    expect((await get(deps(["data:review"]), "/bff/review-tasks")).status).toBe(200);
  });
});

describe("GET /bff/captures", () => {
  test("no auth → 401", async () => {
    expect((await get(deps(["data:read"]), "/bff/captures", {})).status).toBe(401);
  });

  test("needs data:read → 403 with only data:review", async () => {
    expect((await get(deps(["data:review"]), "/bff/captures")).status).toBe(403);
  });

  test("data:read → 200 with the console's Capture shape", async () => {
    const res = await get(deps(["data:read"]), "/bff/captures");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { captures: Record<string, unknown>[] };
    expect(body.captures).toHaveLength(1);
    expect(body.captures[0]).toMatchObject({
      id: "c1",
      source: "chrome_extension",
      status: "captured",
      capturedAt: "2026-07-06T00:00:00.000Z",
    });
  });
});

describe("GET /bff/me", () => {
  test("no auth → 401", async () => {
    expect((await get(deps(["data:read"]), "/bff/me", {})).status).toBe(401);
  });

  test("authn-only: a zero-capability staff account still reads its own (empty) matrix", async () => {
    const res = await get(deps([]), "/bff/me");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      staffRole: "data_ops",
      capabilities: [],
      email: "u1@truepoint.in",
    });
  });
});
