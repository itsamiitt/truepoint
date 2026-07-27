// rateLimit.test.ts — proves the resource-API throttle keys by the subject when claims are present (set by an
// authn that ran for this request, perf RC#11a) and otherwise DELEGATES to the shared trusted-hop client-IP
// resolver. The limiter does NOT verify the JWT itself — authn is the security boundary and verifies per-router
// — so there is no token-verification path to test here; we only assert key selection. No limit is weakened.
//
// Why delegation is the thing under test: this middleware used to parse X-Forwarded-For itself and take the
// FIRST entry. Proxies APPEND to that header, so the leftmost value is whatever the client sent — a client
// rotating it got a fresh quota bucket per request, evading the throttle entirely. The fix was to stop having a
// second, weaker copy of that rule and call `clientIpFromHeaders` from @leadwolf/auth (the same resolver the auth
// origin already used, W10/#14). Asserting delegation is what keeps a hand-rolled parse from creeping back.
//
// Delegation is proved against the REAL resolver rather than a stub. That is deliberate, and it is the stronger
// test: the assertion becomes "the key is whatever the shared rule computes", which no reimplementation can
// satisfy by accident. It also avoids real damage — bun's module mocks are process-global, so stubbing
// `clientIpFromHeaders` here replaced it for every other test file in the run and broke the 8 cases in
// apps/auth/src/lib/clientIp.test.ts that exist to verify the real implementation. A mock of a SHARED function
// is not a local decision.
//
// The trusted-hop selection itself is covered where it is implemented — see apps/auth/src/lib/clientIp.test.ts,
// which exercises the packages/auth implementation through its re-export.
import { beforeEach, describe, expect, it, mock } from "bun:test";
import * as realAuth from "@leadwolf/auth";

const consumed: string[] = [];

// Mock ONLY the rate-limiter seam, and spread the real module so every other export — including
// clientIpFromHeaders, which this file now uses for real — stays intact for this and every other test file.
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

// Minimal Hono-Context stand-in: header lookups + the get/set claims bag the middleware uses.
function fakeCtx(headers: Record<string, string>, claims?: { sub: string }) {
  const store = new Map<string, unknown>();
  if (claims) store.set("claims", claims);
  return {
    req: { header: (name: string) => headers[name.toLowerCase()] },
    get: (k: string) => store.get(k),
    set: (k: string, v: unknown) => store.set(k, v),
  } as never;
}

beforeEach(() => {
  consumed.length = 0;
});

describe("rateLimit keying", () => {
  it("keys by the subject when claims are present on the context (authn has run)", async () => {
    await rateLimit(fakeCtx({}, { sub: "user-123" }), async () => {});
    // A verified subject is strictly better than any IP — no IP must appear in the key.
    expect(consumed).toEqual(["sub:user-123"]);
  });

  it("delegates the IP fallback to the shared trusted-hop resolver (no local header parsing)", async () => {
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
