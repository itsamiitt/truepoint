import { describe, expect, test } from "bun:test";
import { TokenStore } from "./tokenStore.ts";

/**
 * `isFresh` is what the LAZY refresh path turns on (X-0.5).
 *
 * The eager `auth.init()` refresh that ran on every service-worker wake is gone, so the only thing that
 * obtains a token now is `getAccessToken()` asking this store whether the one it holds is still usable. If
 * `isFresh` ever answered true when it should not — most obviously for an empty store — nothing would
 * refresh and requests would go out unauthenticated. These pin the three answers that matter.
 */

/** A minimal unsigned JWT with the given `exp` (seconds). Only the claims are read here, never verified. */
function tokenExpiringAt(epochSeconds: number): string {
  const body = Buffer.from(
    JSON.stringify({
      sub: "u",
      tid: "t",
      wid: "w",
      sid: "s",
      scope: [],
      pa: false,
      exp: epochSeconds,
    }),
  ).toString("base64url");
  return `e30.${body}.sig`;
}

const SKEW_MS = 60_000;

describe("TokenStore.isFresh", () => {
  test("an EMPTY store is never fresh — this is what makes the first request refresh", () => {
    // The wake path no longer pre-warms a token, so this is the state the service worker starts every life
    // in. Answering true here would mean never refreshing at all.
    expect(new TokenStore().isFresh(SKEW_MS)).toBe(false);
    expect(new TokenStore().raw).toBeNull();
  });

  test("a comfortably valid token is fresh — no refresh, no rotation", () => {
    const store = new TokenStore();
    store.set(tokenExpiringAt(Math.floor(Date.now() / 1000) + 900));
    expect(store.isFresh(SKEW_MS)).toBe(true);
  });

  test("a token inside the skew window is NOT fresh — refresh early, never mid-flight", () => {
    // 30s of life left against a 60s skew: still technically valid, but a request starting now could outlive
    // it. Refreshing early is what keeps a 401-retry from being the normal path.
    const store = new TokenStore();
    store.set(tokenExpiringAt(Math.floor(Date.now() / 1000) + 30));
    expect(store.isFresh(SKEW_MS)).toBe(false);
    // Still returned by `raw` on purpose: getAccessToken falls back to an unexpired token when the refresh
    // itself fails, so a transient auth-service blip does not sign the user out.
    expect(store.raw).not.toBeNull();
    expect(store.expiresAt).toBeGreaterThan(Date.now());
  });

  test("clear() returns it to the not-fresh state", () => {
    const store = new TokenStore();
    store.set(tokenExpiringAt(Math.floor(Date.now() / 1000) + 900));
    store.clear();
    expect(store.isFresh(SKEW_MS)).toBe(false);
    expect(store.raw).toBeNull();
  });
});
