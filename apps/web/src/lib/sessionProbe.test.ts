// sessionProbe.test.ts — pins the de-duplication. The whole point of this module is that N consumers produce
// ONE request; if that silently regresses the app goes back to 2-4 identical /auth/session calls per page load
// and nothing fails, so the request COUNT is the assertion.
//
// Also pins the failure policy, which is easy to get backwards: successes are cached for the page, failures are
// not — otherwise one unlucky probe would leave the sidebar empty for the rest of the page's life.

import { beforeEach, describe, expect, mock, test } from "bun:test";

let calls = 0;
let lastUrl = "";
let respond: () => Response = () =>
  new Response(
    JSON.stringify({
      userId: "u1",
      tenantId: "t1",
      workspaceId: "w1",
      role: "admin",
      scope: [],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

mock.module("@/lib/authClient", () => ({
  fetchWithAuth: async (url: string) => {
    calls++;
    lastUrl = url;
    return respond();
  },
}));
mock.module("@/lib/publicConfig", () => ({ API_BASE: "https://api.test" }));

const { getSessionProbe, invalidateSessionProbe } = await import("./sessionProbe.ts");

beforeEach(() => {
  calls = 0;
  invalidateSessionProbe();
  respond = () =>
    new Response(
      JSON.stringify({
        userId: "u1",
        tenantId: "t1",
        workspaceId: "w1",
        role: "admin",
        scope: [],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
});

describe("getSessionProbe de-duplication", () => {
  test("concurrent callers share ONE request (the shell + both switchers + both hooks)", async () => {
    const results = await Promise.all([
      getSessionProbe(),
      getSessionProbe(),
      getSessionProbe(),
      getSessionProbe(),
      getSessionProbe(),
    ]);
    expect(calls).toBe(1);
    for (const r of results) expect(r).toEqual({ ok: true, session: expect.anything() });
  });

  test("a later, sequential caller reuses the cached success (no second request)", async () => {
    await getSessionProbe();
    await getSessionProbe();
    expect(calls).toBe(1);
  });

  test("exposes the parsed profile", async () => {
    const r = await getSessionProbe();
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok");
    expect(r.session).toMatchObject({ userId: "u1", workspaceId: "w1", role: "admin" });
  });

  test("requests the workspace-directory fold and passes it through (P3.5b — boot is ONE request)", async () => {
    respond = () =>
      new Response(
        JSON.stringify({
          userId: "u1",
          tenantId: "t1",
          workspaceId: "w1",
          role: "admin",
          scope: [],
          workspaces: [{ id: "w1", name: "Acme", role: "admin" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const r = await getSessionProbe();
    expect(lastUrl).toContain("include=workspaces");
    if (!r.ok) throw new Error("expected ok");
    expect(r.session.workspaces).toEqual([{ id: "w1", name: "Acme", role: "admin" }]);
  });
});

describe("failure policy", () => {
  test("surfaces the status so AppShell can distinguish a revoked session from a cosmetic miss", async () => {
    respond = () => new Response("", { status: 401 });
    const r = await getSessionProbe();
    expect(r).toEqual({ ok: false, status: 401 });
  });

  test("a failure is NOT cached — the next caller retries", async () => {
    respond = () => new Response("", { status: 503 });
    expect(await getSessionProbe()).toEqual({ ok: false, status: 503 });
    expect(calls).toBe(1);
    // Server recovers; the next consumer must actually re-ask rather than replay the stale failure.
    respond = () =>
      new Response(
        JSON.stringify({
          userId: "u2",
          tenantId: "t1",
          workspaceId: null,
          role: null,
          scope: [],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const second = await getSessionProbe();
    expect(calls).toBe(2);
    expect(second.ok).toBe(true);
  });

  test("a thrown request becomes status 0 rather than an unhandled rejection", async () => {
    respond = () => {
      throw new Error("network down");
    };
    expect(await getSessionProbe()).toEqual({ ok: false, status: 0 });
  });

  test("invalidateSessionProbe forces a fresh read (used after a tenant/workspace switch)", async () => {
    await getSessionProbe();
    expect(calls).toBe(1);
    invalidateSessionProbe();
    await getSessionProbe();
    expect(calls).toBe(2);
  });
});
