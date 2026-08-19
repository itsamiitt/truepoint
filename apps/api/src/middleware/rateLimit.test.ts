// rateLimit.test.ts — proves the app-root throttle is the UNAUTHENTICATED backstop and nothing more: a request
// carrying a bearer token is NOT charged here (its budget is the per-subject bucket authn consumes after the
// token verifies, and a failed verify is billed to the IP inside authn), while a tokenless request is charged
// to the per-IP bucket via the shared trusted-hop resolver. The old middleware read `c.get("claims")` — dead
// code at the app root, where authn has never run — so every authenticated caller fell through to a bucket
// shared by their whole office egress (perf-audit RC2). The skip-on-bearer branch below is what keeps that
// double-billing from creeping back.
//
// Why delegation is still under test: this middleware used to parse X-Forwarded-For itself and take the
// FIRST entry. Proxies APPEND to that header, so the leftmost value is whatever the client sent — a client
// rotating it got a fresh quota bucket per request, evading the throttle entirely. The fix was to stop having a
// second, weaker copy of that rule and call `clientIpFromHeaders` from @leadwolf/auth (the same resolver the auth
// origin already used, W10/#14). Asserting delegation is what keeps a hand-rolled parse from creeping back.
//
// Delegation is proved against the REAL resolver rather than a stub. That is deliberate, and it is the stronger
// test: the assertion becomes "the key is whatever the shared rule computes", which no reimplementation can
// satisfy by accident. It also avoids real damage — bun's module mocks are process-global, so stubbing
// `clientIpFromHeaders` here would replace it for every other test file in the run. A mock of a SHARED function
// is not a local decision; only the Redis-consuming seam is stubbed.
import { beforeEach, describe, expect, it, mock } from "bun:test";
import * as realAuth from "@leadwolf/auth";

const consumed: string[] = [];

// Mock ONLY the rate-limiter seam, and spread the real module so every other export — including
// clientIpFromHeaders, which this file uses for real — stays intact for this and every other test file.
mock.module("@leadwolf/auth", () => ({
  ...realAuth,
  checkRequestRate: async (key: string) => {
    consumed.push(key);
  },
}));

const { rateLimit } = await import("./rateLimit.ts");

/** The shared rule's own answer for a given header set — the expected key, computed the same way the
 *  middleware is supposed to compute it. */
const sharedResolverIp = (headers: Record<string, string>) =>
  realAuth.clientIpFromHeaders({ get: (name: string) => headers[name.toLowerCase()] ?? null });

// Minimal Hono-Context stand-in: header lookups + the get/set variables bag.
function fakeCtx(headers: Record<string, string>) {
  const store = new Map<string, unknown>();
  return {
    req: { header: (name: string) => headers[name.toLowerCase()] },
    get: (k: string) => store.get(k),
    set: (k: string, v: unknown) => store.set(k, v),
  } as never;
}

beforeEach(() => {
  consumed.length = 0;
});

describe("rateLimit (unauthenticated backstop)", () => {
  it("does NOT charge a bearer-carrying request — its budget is the per-subject bucket in authn", async () => {
    let reachedNext = false;
    await rateLimit(fakeCtx({ authorization: "Bearer some-token" }), async () => {
      reachedNext = true;
    });
    // Charging here too would double-bill every authenticated request against the small unauth backstop —
    // the exact shape of the shared-office 429 storm this split exists to end.
    expect(consumed).toEqual([]);
    expect(reachedNext).toBe(true);
  });

  it("charges a tokenless request to the per-IP bucket via the shared trusted-hop resolver", async () => {
    // Two entries where the FIRST is client-controlled and the LAST was appended by the trusted proxy. The
    // shared rule takes the trusted one; the old local parse took the forgeable one, so the two answers differ
    // and this assertion can tell them apart.
    const headers = { "x-forwarded-for": "203.0.113.7, 10.0.0.1" };
    await rateLimit(fakeCtx(headers), async () => {});
    expect(consumed).toEqual([`ip:${sharedResolverIp(headers)}`]);
    // Explicitly pin the regression: a reintroduced first-entry split would key on the spoofable value and hand
    // the caller a fresh quota bucket per rotation.
    expect(consumed[0]).not.toBe("ip:203.0.113.7");
  });

  it("still delegates when no proxy headers are present (no local 'unknown' sentinel)", async () => {
    await rateLimit(fakeCtx({}), async () => {});
    expect(consumed).toEqual([`ip:${sharedResolverIp({})}`]);
  });
});
