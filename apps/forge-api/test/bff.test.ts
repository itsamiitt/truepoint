import { describe, expect, test } from "bun:test";
import { type BffDeps, createBffApp } from "../src/features/dashboard-bff/routes.ts";
import type { Capability } from "../src/middleware/capability.ts";

function deps(caps: Capability[]): BffDeps {
  return {
    resolveStaff: (c) => {
      const userId = c.req.header("x-staff");
      return userId ? { userId, capabilities: caps } : null;
    },
    readers: {
      overview: async () => ({ ok: "overview" }),
      reviewTasks: async () => ({ ok: "review" }),
      parsers: async () => ({ ok: "parsers" }),
      syncStatus: async () => ({ ok: "sync" }),
    },
  };
}

const get = (d: BffDeps, path: string, headers: Record<string, string> = { "x-staff": "u1" }) =>
  createBffApp(d).request(path, { headers });

describe("dashboard BFF capability gate (13 §3)", () => {
  test("no auth → 401", async () => {
    expect((await get(deps(["data:read"]), "/bff/overview", {})).status).toBe(401);
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
