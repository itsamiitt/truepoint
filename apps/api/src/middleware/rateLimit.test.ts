// rateLimit.test.ts — proves the resource-API throttle keys by the subject when claims are present (set by an
// authn that ran for this request, perf RC#11a) and falls back to the coarse IP key otherwise. The limiter
// does NOT verify the JWT itself — authn is the security boundary and verifies per-router — so there is no
// token-verification path to test here; we only assert key selection. No limit is weakened.
import { beforeEach, describe, expect, it, mock } from "bun:test";

const consumed: string[] = [];

// Mock the @leadwolf/auth seam so we can capture the rate-limit key the middleware derives.
mock.module("@leadwolf/auth", () => ({
  checkRequestRate: async (key: string) => {
    consumed.push(key);
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
});

describe("rateLimit keying", () => {
  it("keys by the subject when claims are present on the context (authn has run)", async () => {
    await rateLimit(fakeCtx({}, { sub: "user-123" }), async () => {});
    expect(consumed).toEqual(["sub:user-123"]);
  });

  it("falls back to the IP key (first x-forwarded-for hop) when no claims are present", async () => {
    await rateLimit(fakeCtx({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" }), async () => {});
    expect(consumed).toEqual(["ip:203.0.113.7"]);
  });

  it("uses x-real-ip when x-forwarded-for is absent", async () => {
    await rateLimit(fakeCtx({ "x-real-ip": "198.51.100.4" }), async () => {});
    expect(consumed).toEqual(["ip:198.51.100.4"]);
  });

  it("keys by a literal 'unknown' IP when no proxy headers are present", async () => {
    await rateLimit(fakeCtx({}), async () => {});
    expect(consumed).toEqual(["ip:unknown"]);
  });
});
