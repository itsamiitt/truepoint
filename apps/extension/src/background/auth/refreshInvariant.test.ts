// refreshInvariant.test.ts — a refresh token whose rotation outcome is UNKNOWN must never be kept.
//
// WHY THIS IS THE MOST IMPORTANT TEST IN THIS DIRECTORY. Rotation commits server-side the moment the request
// is handled, but the response carrying the replacement can be lost — a dropped connection, the 10s timeout,
// or MV3 terminating the service worker mid-flight, which it does after ~30s idle. If the stale token stays in
// storage.session, the next wake presents a token the server has already revoked. Inside session.ts's 30s
// grace that is forgiven; past it — and an alarm-driven wake is minutes later, not seconds — the server cannot
// distinguish it from a stolen token being replayed, and its answer to a replay is `revokeAllSessionsForUser`.
// Not this session: EVERY session belonging to that user. One lost HTTP response signed the person out of the
// web app, the admin console, and every other device they had open.
//
// So these tests assert a DISCARD, not a retry. Retrying would mean re-presenting the exact token that is
// dangerous to present twice, and "never reached the server" is indistinguishable from "server rotated, reply
// lost" from in here. The cost of discarding — re-establishing through the companion tab, which is silent
// while the web session is alive — is the small side of a very lopsided trade.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { AuthModule } from "./index.ts";

/** A minimal in-memory chrome.storage double — only the surfaces shared/storage.ts actually touches. */
function installChromeStorage(): Map<string, unknown> {
  const session = new Map<string, unknown>();
  const local = new Map<string, unknown>();
  const area = (m: Map<string, unknown>) => ({
    get: async (key: string) => (m.has(key) ? { [key]: m.get(key) } : {}),
    set: async (entries: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(entries)) m.set(k, v);
    },
    remove: async (key: string) => {
      m.delete(key);
    },
  });
  (globalThis as { chrome?: unknown }).chrome = {
    storage: { session: area(session), local: area(local) },
    tabs: { remove: () => {}, update: async () => {} },
  };
  return session;
}

const REFRESH_KEY = "ext_refresh";
const realFetch = globalThis.fetch;
let session: Map<string, unknown>;

/** Install a fetch double. Cast through `unknown` because the DOM `fetch` type carries `preconnect`, which a
 *  test stub has no reason to implement and TS will not let a plain function be asserted into. */
function stubFetch(impl: (input: string) => Promise<Response>): void {
  globalThis.fetch = impl as unknown as typeof fetch;
}

beforeEach(() => {
  session = installChromeStorage();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  (globalThis as { chrome?: unknown }).chrome = undefined;
});

/** An AuthModule with the deps stubbed, plus a record of the expiries it reported. */
function moduleUnderTest() {
  const tokenChanges: Array<number | null> = [];
  const auth = new AuthModule({ onTokenChanged: (e) => tokenChanges.push(e) });
  return { auth, tokenChanges };
}

describe("doRefresh — the stored token is discarded whenever rotation is unproven", () => {
  it("drops the token when the network fails (the rotation may well have committed)", async () => {
    session.set(REFRESH_KEY, "rt-original");
    stubFetch(async () => {
      throw new TypeError("Failed to fetch");
    });

    const { auth, tokenChanges } = moduleUnderTest();
    expect(await auth.refreshNow()).toBe(false);

    // The whole point: nothing is left behind for the next service-worker wake to replay.
    expect(session.has(REFRESH_KEY)).toBe(false);
    expect(auth.getState().status).toBe("signed_out");
    expect(tokenChanges.at(-1)).toBeNull();
  });

  it("drops the token on a 401 — it is provably dead", async () => {
    session.set(REFRESH_KEY, "rt-original");
    stubFetch(async () => new Response(JSON.stringify({ code: "invalid_token" }), { status: 401 }));

    const { auth } = moduleUnderTest();
    expect(await auth.refreshNow()).toBe(false);
    expect(session.has(REFRESH_KEY)).toBe(false);
  });

  it("drops the token on a 503 too — a mint failure can land AFTER the rotation committed", async () => {
    // /extension/refresh rotates and THEN mints, so a 503 does not mean "nothing happened". Treating it as
    // recoverable is what would leave a revoked token in storage.
    session.set(REFRESH_KEY, "rt-original");
    stubFetch(
      async () => new Response(JSON.stringify({ code: "auth_unavailable" }), { status: 503 }),
    );

    const { auth } = moduleUnderTest();
    expect(await auth.refreshNow()).toBe(false);
    expect(session.has(REFRESH_KEY)).toBe(false);
  });

  it("stores the ROTATED token on success, replacing the presented one", async () => {
    session.set(REFRESH_KEY, "rt-original");
    stubFetch(async (input: string) => {
      if (String(input).includes("/me")) return new Response("{}", { status: 200 });
      return new Response(
        JSON.stringify({
          accessToken:
            "header.eyJzdWIiOiJ1IiwidGlkIjoidCIsInNpZCI6InMiLCJleHAiOjk5OTk5OTk5OTl9.sig",
          expiresIn: 900,
          refreshToken: "rt-rotated",
        }),
        { status: 200 },
      );
    });

    const { auth } = moduleUnderTest();
    expect(await auth.refreshNow()).toBe(true);
    expect(session.get(REFRESH_KEY)).toBe("rt-rotated");
  });

  it("a failed workspace switch also discards — 'keep the current session' must not keep the token", async () => {
    // switchWorkspace swallows the error to preserve the user's current scope. That is the right UX and it is
    // exactly where an unproven token could quietly survive, so the discard happens below the catch.
    session.set(REFRESH_KEY, "rt-original");
    stubFetch(async () => {
      throw new TypeError("Failed to fetch");
    });

    const { auth } = moduleUnderTest();
    const state = await auth.switchWorkspace("ws-123");

    expect(state.status).toBe("signed_out");
    expect(session.has(REFRESH_KEY)).toBe(false);
  });
});
