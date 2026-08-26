// fetchWithAuth.test.ts — the refresh-and-retry on a server 401.
//
// WHY THIS EXISTS. The client-side expiry check only knows what THIS tab believes. The server can reject a
// token the tab still considers fresh, and two causes are routine rather than exotic: another tab or another
// APP rotated the shared refresh cookie (it is host-scoped to the auth origin, so app./admin./forge share one,
// while the rotation election is localStorage-backed and therefore per-origin), and clock skew against the
// ≤30s tolerance in verifyAccessToken. fetchWithAuth had no retry, so that 401 flowed out to AppShell — which
// reads a 401 on the session probe as a revocation, discards the token and re-gates to login. An ordinary race
// was presented to the user as being signed out.
//
// The bound matters as much as the retry: exactly ONE replay. If a freshly-minted token is also rejected the
// session really is gone, and looping would turn one dead session into a request storm against an auth origin
// that may already be the thing struggling.

import { afterEach, describe, expect, it } from "bun:test";
import { createAuthClient } from "./createAuthClient.ts";

const AUTH_ORIGIN = "https://auth.truepoint.in";
const APP_ORIGIN = "https://app.truepoint.in";
const RESOURCE = `${APP_ORIGIN}/api/v1/auth/session`;

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** A JWT-shaped string is not needed — the client treats the access token as opaque. */
const tokenNamed = (n: string): string => `access-token-${n}`;

interface Call {
  url: string;
  authorization: string | null;
  method: string;
}

/**
 * Install a fake fetch. `resourceStatuses` is consumed one per resource request, so the first call can 401 and
 * the second succeed. Every `/token/refresh` hit mints the next token in `mintedTokens`.
 */
function installFetch(opts: {
  resourceStatuses: number[];
  mintedTokens: string[];
  refreshStatus?: number;
}): { calls: Call[]; refreshCount: () => number } {
  const calls: Call[] = [];
  let refreshes = 0;
  const statuses = [...opts.resourceStatuses];
  const minted = [...opts.mintedTokens];

  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({
      url,
      authorization: headers.get("authorization"),
      method: init?.method ?? "GET",
    });

    if (url.endsWith("/token/refresh")) {
      refreshes += 1;
      if (opts.refreshStatus && opts.refreshStatus !== 200) {
        return new Response(JSON.stringify({ code: "invalid_token" }), {
          status: opts.refreshStatus,
        });
      }
      const next = minted.shift() ?? tokenNamed("exhausted");
      return new Response(JSON.stringify({ accessToken: next, expiresIn: 900 }), { status: 200 });
    }

    return new Response("{}", { status: statuses.shift() ?? 200 });
  }) as typeof fetch;

  return { calls, refreshCount: () => refreshes };
}

function client() {
  return createAuthClient({
    appOrigin: APP_ORIGIN,
    authOrigin: AUTH_ORIGIN,
    storagePrefix: "tp_test_",
  });
}

describe("fetchWithAuth — refresh-and-retry on 401", () => {
  it("replays the request once with a freshly-minted token when the server 401s", async () => {
    const { calls, refreshCount } = installFetch({
      resourceStatuses: [401, 200],
      mintedTokens: [tokenNamed("rotated")],
    });
    const c = client();
    c.installToken(tokenNamed("stale"), 900);

    const res = await c.fetchWithAuth(RESOURCE);

    expect(res.status).toBe(200);
    expect(refreshCount()).toBe(1);
    const resourceCalls = calls.filter((k) => k.url === RESOURCE);
    expect(resourceCalls).toHaveLength(2);
    // The whole point: the replay carries the NEW token, not the rejected one.
    expect(resourceCalls[0]?.authorization).toBe(`Bearer ${tokenNamed("stale")}`);
    expect(resourceCalls[1]?.authorization).toBe(`Bearer ${tokenNamed("rotated")}`);
  });

  it("does NOT retry a 2xx, and does not refresh when the first attempt succeeds", async () => {
    const { calls, refreshCount } = installFetch({
      resourceStatuses: [200],
      mintedTokens: [],
    });
    const c = client();
    c.installToken(tokenNamed("good"), 900);

    const res = await c.fetchWithAuth(RESOURCE);

    expect(res.status).toBe(200);
    expect(refreshCount()).toBe(0);
    expect(calls.filter((k) => k.url === RESOURCE)).toHaveLength(1);
  });

  it("does NOT retry a 403 — that is an authorization answer, and a new token cannot change it", async () => {
    const { calls, refreshCount } = installFetch({
      resourceStatuses: [403],
      mintedTokens: [tokenNamed("rotated")],
    });
    const c = client();
    c.installToken(tokenNamed("good"), 900);

    const res = await c.fetchWithAuth(RESOURCE);

    expect(res.status).toBe(403);
    expect(refreshCount()).toBe(0);
    expect(calls.filter((k) => k.url === RESOURCE)).toHaveLength(1);
  });

  it("stops after ONE replay when the fresh token is rejected too — a dead session must not loop", async () => {
    const { calls, refreshCount } = installFetch({
      resourceStatuses: [401, 401],
      mintedTokens: [tokenNamed("rotated")],
    });
    const c = client();
    c.installToken(tokenNamed("stale"), 900);

    const res = await c.fetchWithAuth(RESOURCE);

    expect(res.status).toBe(401);
    expect(refreshCount()).toBe(1); // one rotation, not a storm
    expect(calls.filter((k) => k.url === RESOURCE)).toHaveLength(2);
  });

  it("returns the 401 unretried when the refresh itself fails", async () => {
    const { calls, refreshCount } = installFetch({
      resourceStatuses: [401],
      mintedTokens: [],
      refreshStatus: 401,
    });
    const c = client();
    c.installToken(tokenNamed("stale"), 900);

    const res = await c.fetchWithAuth(RESOURCE);

    expect(res.status).toBe(401);
    expect(refreshCount()).toBe(1);
    expect(calls.filter((k) => k.url === RESOURCE)).toHaveLength(1);
  });

  it("preserves method and caller headers across the replay", async () => {
    const { calls } = installFetch({
      resourceStatuses: [401, 200],
      mintedTokens: [tokenNamed("rotated")],
    });
    const c = client();
    c.installToken(tokenNamed("stale"), 900);

    await c.fetchWithAuth(RESOURCE, {
      method: "POST",
      body: JSON.stringify({ a: 1 }),
      headers: { "content-type": "application/json", "idempotency-key": "abc" },
    });

    const resourceCalls = calls.filter((k) => k.url === RESOURCE);
    expect(resourceCalls).toHaveLength(2);
    for (const k of resourceCalls) expect(k.method).toBe("POST");
  });
});
