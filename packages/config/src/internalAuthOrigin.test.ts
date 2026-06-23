// internalAuthOrigin.test.ts — proves INTERNAL_AUTH_ORIGIN is an OPTIONAL, validated URL (perf: api fetches
// the auth JWKS over the internal docker network instead of hairpinning out through the public edge). It only
// moves WHERE the key set is fetched; token.ts still pins issuer/audience to the public AUTH_ORIGIN. We parse
// constructed objects via appEnvSchema so the test never mutates process.env (preload seeds a valid env).
import { describe, expect, it } from "bun:test";
import { appEnvSchema } from "./env.ts";

const base = {
  NODE_ENV: "production",
  AUTH_ORIGIN: "https://auth.example.com",
  APP_ORIGINS: "https://app.example.com",
  AUTH_COOKIE_DOMAIN: "auth.example.com",
  JWT_SIGNING_KID: "kid-1",
  DATABASE_URL: "postgres://u:p@host:5432/db",
  REDIS_URL: "redis://localhost:6379",
  BLIND_INDEX_KEY: "0123456789abcdef",
};

describe("appEnvSchema INTERNAL_AUTH_ORIGIN", () => {
  it("is undefined when absent (fall back to AUTH_ORIGIN in token.ts — dev/local unchanged)", () => {
    const r = appEnvSchema.safeParse(base);
    expect(r.success && r.data.INTERNAL_AUTH_ORIGIN).toBeUndefined();
  });

  it("accepts an in-cluster http origin (docker-network host:port)", () => {
    const r = appEnvSchema.safeParse({ ...base, INTERNAL_AUTH_ORIGIN: "http://auth:3000" });
    expect(r.success && r.data.INTERNAL_AUTH_ORIGIN).toBe("http://auth:3000");
  });

  it("rejects a scheme-less host (e.g. auth.internal) — must be a full URL", () => {
    const r = appEnvSchema.safeParse({ ...base, INTERNAL_AUTH_ORIGIN: "auth.internal" });
    expect(r.success).toBe(false);
  });

  it("rejects the operator typo `auth:3000` — bare host:port passes z.url() but fails the http(s) guard", () => {
    // z.string().url() alone accepts this ("auth" parses as a scheme); the .refine() http(s) guard rejects it
    // so a misconfig fails fast at boot instead of 401-ing every request via an unusable JWKS URL.
    const r = appEnvSchema.safeParse({ ...base, INTERNAL_AUTH_ORIGIN: "auth:3000" });
    expect(r.success).toBe(false);
  });

  it("accepts an https in-cluster origin too (scheme guard allows http OR https)", () => {
    const r = appEnvSchema.safeParse({ ...base, INTERNAL_AUTH_ORIGIN: "https://auth:3000" });
    expect(r.success && r.data.INTERNAL_AUTH_ORIGIN).toBe("https://auth:3000");
  });

  it("does NOT have to match AUTH_ORIGIN — it is a different network location, not the claim authority", () => {
    const r = appEnvSchema.safeParse({ ...base, INTERNAL_AUTH_ORIGIN: "http://auth:3000" });
    // No superRefine couples it to AUTH_ORIGIN: issuer/audience stay pinned to the public origin in token.ts.
    expect(r.success).toBe(true);
  });
});
