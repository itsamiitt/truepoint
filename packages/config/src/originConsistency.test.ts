// originConsistency.test.ts — proves the prod boot guard (ADR-0016): the public origins baked into the
// bundles at build time (NEXT_PUBLIC_*) must agree with the server-side origins read at runtime, or the
// cross-domain token exchange fails with an opaque 400. We parse constructed objects via appEnvSchema so the
// test never mutates process.env (the global preload seeds a valid NODE_ENV=test env at import time).
import { describe, expect, it } from "bun:test";
import { appEnvSchema } from "./env.ts";

const prodBase = {
  NODE_ENV: "production",
  AUTH_ORIGIN: "https://auth.example.com",
  APP_ORIGINS: "https://app.example.com",
  AUTH_COOKIE_DOMAIN: "auth.example.com", // prod: must equal the AUTH_ORIGIN host
  JWT_SIGNING_KID: "kid-1",
  DATABASE_URL: "postgres://u:p@host:5432/db",
  REDIS_URL: "redis://localhost:6379",
  BLIND_INDEX_KEY: "0123456789abcdef",
};

const hasIssue = (r: ReturnType<typeof appEnvSchema.safeParse>, path: string): boolean =>
  !r.success && r.error.issues.some((i) => i.path.join(".") === path);

describe("appEnvSchema origin self-consistency (production)", () => {
  it("passes when the NEXT_PUBLIC origins agree with the server origins", () => {
    const r = appEnvSchema.safeParse({
      ...prodBase,
      NEXT_PUBLIC_APP_ORIGIN: "https://app.example.com",
      NEXT_PUBLIC_AUTH_ORIGIN: "https://auth.example.com",
    });
    expect(r.success).toBe(true);
  });

  it("passes when the NEXT_PUBLIC origins are absent (no-op guard)", () => {
    expect(appEnvSchema.safeParse(prodBase).success).toBe(true);
  });

  it("fails when NEXT_PUBLIC_APP_ORIGIN is not an allow-listed APP_ORIGINS entry", () => {
    const r = appEnvSchema.safeParse({
      ...prodBase,
      NEXT_PUBLIC_APP_ORIGIN: "https://app.evil.example",
    });
    expect(hasIssue(r, "NEXT_PUBLIC_APP_ORIGIN")).toBe(true);
  });

  it("fails when NEXT_PUBLIC_AUTH_ORIGIN differs from AUTH_ORIGIN", () => {
    const r = appEnvSchema.safeParse({
      ...prodBase,
      NEXT_PUBLIC_AUTH_ORIGIN: "https://auth.evil.example",
    });
    expect(hasIssue(r, "NEXT_PUBLIC_AUTH_ORIGIN")).toBe(true);
  });

  it("does NOT enforce origin consistency outside production", () => {
    const r = appEnvSchema.safeParse({
      ...prodBase,
      NODE_ENV: "development",
      AUTH_COOKIE_DOMAIN: "anything", // the cookie-domain check is prod-only too
      NEXT_PUBLIC_APP_ORIGIN: "https://app.evil.example",
    });
    expect(r.success).toBe(true);
  });
});

describe("appEnvSchema AUTH_BIND_IP", () => {
  it("defaults to 'prefix'", () => {
    const r = appEnvSchema.safeParse(prodBase);
    expect(r.success && r.data.AUTH_BIND_IP).toBe("prefix");
  });

  it("rejects an unknown binding mode", () => {
    expect(appEnvSchema.safeParse({ ...prodBase, AUTH_BIND_IP: "loose" }).success).toBe(false);
  });
});
