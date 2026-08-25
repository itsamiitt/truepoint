import { describe, expect, test } from "bun:test";
import { type BffDeps, createBffApp } from "../src/features/dashboard-bff/routes.ts";
import type { Capability } from "../src/middleware/capability.ts";

function deps(caps: Capability[]): BffDeps {
  return {
    audit: async () => {},
    resolveStaff: (c) => {
      const userId = c.req.header("x-staff");
      return userId ? { userId, capabilities: caps, staffRole: "data_ops" } : null;
    },
    readers: {
      overview: async () => ({ ok: "overview" }),
      reviewTasks: async () => ({ ok: "review" }),
      parsers: async () => ({ ok: "parsers" }),
      syncStatus: async () => ({ ok: "sync" }),
      sourceFetches: async () => ({ fetches: [] }),
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

describe("cross-tenant read audit (ADR-0032, F-0.9)", () => {
  /** deps() plus a capturing audit sink. */
  function audited(caps: Capability[], audit?: BffDeps["audit"]) {
    const rows: Array<Parameters<BffDeps["audit"]>[0]> = [];
    const d = deps(caps);
    d.audit =
      audit ??
      (async (entry) => {
        rows.push(entry);
      });
    return { d, rows };
  }

  test("every gated read writes exactly one audit row naming the action", async () => {
    // The Forge data plane is shared, so each of these reads spans tenants by construction — which is what the
    // console's standing "Cross-tenant view" badge is telling the operator. None of them recorded anything.
    for (const [path, action] of [
      ["/bff/overview", "forge.read_overview"],
      ["/bff/parsers", "forge.read_parsers"],
      ["/bff/sync-status", "forge.read_sync_status"],
      ["/bff/captures", "forge.read_captures"],
    ] as const) {
      const { d, rows } = audited(["data:read"]);
      expect((await get(d, path)).status).toBe(200);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actorUserId: "u1", action });
      expect(rows[0]?.metadata).toMatchObject({ capability: "data:read", path });
    }
  });

  test("the review queue audits under its own action", async () => {
    const { d, rows } = audited(["data:review"]);
    expect((await get(d, "/bff/review-tasks")).status).toBe(200);
    expect(rows[0]).toMatchObject({ action: "forge.read_review_tasks" });
  });

  test("an UNAUTHENTICATED request writes no audit row", async () => {
    // Nothing was read, so there is nothing to attribute — and an actor-less row would be noise in a log whose
    // value is that every row names someone.
    const { d, rows } = audited(["data:read"]);
    expect((await get(d, "/bff/overview", {})).status).toBe(401);
    expect(rows).toHaveLength(0);
  });

  test("a FORBIDDEN request writes no audit row", async () => {
    const { d, rows } = audited(["data:read"]);
    expect((await get(d, "/bff/review-tasks")).status).toBe(403);
    expect(rows).toHaveLength(0);
  });

  test("the audit is written BEFORE the read — a failed audit means no read happens", async () => {
    // This is the property that survives not being able to share a transaction with the reader (the readers
    // run as leadwolf_forge, which has no grant on the public-schema audit table). Audit-first still
    // guarantees no read occurs without its trail.
    let read = false;
    const { d } = audited(["data:read"], async () => {
      throw new Error("audit sink unavailable");
    });
    d.readers.overview = async () => {
      read = true;
      return {};
    };
    // Hono types request() as `Response | Promise<Response>`, so .catch is not on it. The intent is
    // unchanged: swallow a rejection and assert on `read` instead.
    await Promise.resolve(
      createBffApp(d).request("/bff/overview", { headers: { "x-staff": "u1" } }),
    ).catch(() => undefined);
    expect(read).toBe(false);
  });

  test("/bff/me is NOT audited — it reads only the caller's own identity", async () => {
    // Not a cross-tenant read, so it is not the auditable event; logging it would bury the reads that matter.
    const { d, rows } = audited([]);
    expect((await get(d, "/bff/me")).status).toBe(200);
    expect(rows).toHaveLength(0);
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
