// blindIndexKey.test.ts — proves the identity-critical HMAC secret (BLIND_INDEX_KEY) is a REQUIRED, no-default,
// min-length env var, so boot HARD-FAILS if it is missing or weak (P-01.14). The old forge dev-default
// (FORGE_BLIND_INDEX_KEY ?? "forge-dev-blind-index-key") is deleted — a silently-weak key would let anyone
// recompute every blind index and de-anonymize the whole dataset. Constructed sources via resolveAppEnv; never
// mutates process.env (the global preload seeds a valid env at import time).
import { describe, expect, it } from "bun:test";
import { WORKER_SURFACE, resolveAppEnv } from "./env.ts";

/** A fully-valid source EXCEPT the blind-index key, so each case controls only BLIND_INDEX_KEY. */
const base = {
  NODE_ENV: "test",
  AUTH_ORIGIN: "https://auth.example.com",
  APP_ORIGINS: "https://app.example.com",
  AUTH_COOKIE_DOMAIN: "auth.example.com",
  JWT_SIGNING_KID: "kid-1",
  DATABASE_URL: "postgres://u:p@host:5432/db",
  REDIS_URL: "redis://localhost:6379",
};

describe("BLIND_INDEX_KEY is required + no-default (P-01.14)", () => {
  it("boot crashes when BLIND_INDEX_KEY is absent — there is no dev fallback", () => {
    expect(() => resolveAppEnv(base, undefined)).toThrow(/Invalid environment configuration/);
    // Required even on the worker surface — it is worker-required, not one of the relaxed web/auth-only keys.
    expect(() => resolveAppEnv(base, WORKER_SURFACE)).toThrow(/BLIND_INDEX_KEY/);
  });

  it("a too-short key is rejected (min 8) so a trivially-weak secret cannot boot", () => {
    expect(() => resolveAppEnv({ ...base, BLIND_INDEX_KEY: "short" }, undefined)).toThrow(
      /BLIND_INDEX_KEY/,
    );
  });

  it("a valid key boots and reads back verbatim", () => {
    const { env } = resolveAppEnv({ ...base, BLIND_INDEX_KEY: "0123456789abcdef" }, undefined);
    expect(env.BLIND_INDEX_KEY).toBe("0123456789abcdef");
  });
});
