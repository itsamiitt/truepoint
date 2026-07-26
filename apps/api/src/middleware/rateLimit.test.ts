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
// The trusted-hop selection itself is covered where it is implemented — see apps/auth/src/lib/clientIp.test.ts,
// which now exercises the packages/auth implementation through its re-export.
import { beforeEach, describe, expect, it, mock } from "bun:test";

const consumed: string[] = [];
const resolverCalls: string[] = [];

// Mock the @leadwolf/auth seam: capture the key the middleware derives, and stand in for the resolver with a
// marker so we can prove the middleware asks it for the IP instead of reading headers itself.
mock.module("@leadwolf/auth", () => ({
  checkRequestRate: async (key: string) => {
    consumed.push(key);
  },
  clientIpFromHeaders: (h: { get(name: string): string | null | undefined }) => {
    // Record what the middleware handed us, to prove it passes a working header reader through.
    resolverCalls.push(h.get("x-forwarded-for") ?? "<none>");
    return "resolved-by-shared-helper";
  },
}));

const { rateLimit } = await import("./rateLimit.ts");

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
  resolverCalls.length = 0;
});

describe("rateLimit keying", () => {
  it("keys by the subject when claims are present on the context (authn has run)", async () => {
    await rateLimit(fakeCtx({}, { sub: "user-123" }), async () => {});
    expect(consumed).toEqual(["sub:user-123"]);
    // A verified subject is strictly better than any IP — the resolver must not even be consulted.
    expect(resolverCalls).toEqual([]);
  });

  it("delegates the IP fallback to the shared trusted-hop resolver (no local header parsing)", async () => {
    await rateLimit(fakeCtx({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" }), async () => {});
    expect(consumed).toEqual(["ip:resolved-by-shared-helper"]);
    // Proves the middleware handed the resolver a working reader over the real request headers rather than
    // pre-parsing (or ignoring) them. If someone reintroduces a local X-Forwarded-For split, the key would be
    // "ip:203.0.113.7" and this fails.
    expect(resolverCalls).toEqual(["203.0.113.7, 10.0.0.1"]);
  });

  it("still delegates when no proxy headers are present (no local 'unknown' sentinel)", async () => {
    await rateLimit(fakeCtx({}), async () => {});
    expect(consumed).toEqual(["ip:resolved-by-shared-helper"]);
    expect(resolverCalls).toEqual(["<none>"]);
  });
});
