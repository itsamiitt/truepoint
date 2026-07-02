// workerSurface.test.ts — proves the Phase-2 boot isolation (worker-platform plan 15 §4): under
// LEADWOLF_SURFACE=worker a missing web/auth-only key no longer blocks worker boot but throws loudly on
// ACCESS; worker-required keys still crash boot on every surface; the app surface is byte-identical to
// today's strict behaviour. Mirrors originConsistency.test.ts: constructed sources via resolveAppEnv — the
// test never mutates process.env (the global preload seeds a valid NODE_ENV=test env at import time).
import { describe, expect, it } from "bun:test";
import { WORKER_SURFACE, resolveAppEnv } from "./env.ts";

/** A minimal fully-valid source (all seven no-default required keys present). */
const fullBase = {
  NODE_ENV: "test",
  AUTH_ORIGIN: "https://auth.example.com",
  APP_ORIGINS: "https://app.example.com",
  AUTH_COOKIE_DOMAIN: "auth.example.com",
  JWT_SIGNING_KID: "kid-1",
  DATABASE_URL: "postgres://u:p@host:5432/db",
  REDIS_URL: "redis://localhost:6379",
  BLIND_INDEX_KEY: "0123456789abcdef",
};

/** The same source with the three web/auth-only keys absent — the worker-boot false-positive scenario. */
const workerOnlyBase = {
  NODE_ENV: "test",
  APP_ORIGINS: "https://app.example.com",
  DATABASE_URL: "postgres://u:p@host:5432/db",
  REDIS_URL: "redis://localhost:6379",
  BLIND_INDEX_KEY: "0123456789abcdef",
};

describe("resolveAppEnv surface-aware boot (Phase 2)", () => {
  it("app surface (unset): a missing web/auth key still crashes boot — strict behaviour unchanged", () => {
    expect(() => resolveAppEnv(workerOnlyBase, undefined)).toThrow(
      /Invalid environment configuration/,
    );
    expect(() => resolveAppEnv(workerOnlyBase, "api")).toThrow(/AUTH_ORIGIN/);
  });

  it("worker surface: boots without the web/auth-only keys and reports them relaxed", () => {
    const { env, report } = resolveAppEnv(workerOnlyBase, WORKER_SURFACE);
    expect(report.surface).toBe(WORKER_SURFACE);
    expect([...report.relaxedMissing].sort()).toEqual([
      "AUTH_COOKIE_DOMAIN",
      "AUTH_ORIGIN",
      "JWT_SIGNING_KID",
    ]);
    // Worker-required keys read normally.
    expect(env.REDIS_URL).toBe("redis://localhost:6379");
    expect(env.APP_ORIGINS).toEqual(["https://app.example.com"]);
    expect(env.BLIND_INDEX_KEY).toBe("0123456789abcdef");
  });

  it("worker surface: ACCESSING a relaxed-missing key throws loudly at the call site (fail-closed per key)", () => {
    const { env } = resolveAppEnv(workerOnlyBase, WORKER_SURFACE);
    expect(() => env.AUTH_ORIGIN).toThrow(/AUTH_ORIGIN.*worker surface/);
    expect(() => env.JWT_SIGNING_KID).toThrow(/web\/auth-only/);
  });

  it("worker surface: a missing WORKER-required key still crashes boot loudly", () => {
    const { REDIS_URL: _dropped, ...noRedis } = workerOnlyBase;
    expect(() => resolveAppEnv(noRedis, WORKER_SURFACE)).toThrow(/REDIS_URL/);
  });

  it("worker surface with ALL keys present: nothing is relaxed, every key reads normally", () => {
    const { env, report } = resolveAppEnv(fullBase, WORKER_SURFACE);
    expect(report.relaxedMissing).toEqual([]);
    expect(env.AUTH_ORIGIN).toBe("https://auth.example.com"); // no proxy, no throw
  });

  it("production + worker surface: the sentinels satisfy the prod cookie-domain superRefine", () => {
    const { env, report } = resolveAppEnv(
      { ...workerOnlyBase, NODE_ENV: "production" },
      WORKER_SURFACE,
    );
    expect(report.relaxedMissing).toContain("AUTH_COOKIE_DOMAIN");
    expect(env.NODE_ENV).toBe("production");
    expect(env.DATABASE_URL).toBe("postgres://u:p@host:5432/db");
  });

  it("empty-string values are treated as missing and relaxed (env_file blank-line hygiene)", () => {
    const { report } = resolveAppEnv({ ...workerOnlyBase, AUTH_ORIGIN: "" }, WORKER_SURFACE);
    expect(report.relaxedMissing).toContain("AUTH_ORIGIN");
  });
});
