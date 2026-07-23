// webauthnConfig.test.ts — passkeys (AUTH-024) require WEBAUTHN_RP_ID once WEBAUTHN_ENABLED is armed. The boot
// guard fails fast (in EVERY environment) instead of letting the first registration/assertion ceremony fail
// cryptically. Parses constructed objects via appEnvSchema so the test never mutates process.env.
import { describe, expect, it } from "bun:test";
import { appEnvSchema } from "./env.ts";

const base = {
  AUTH_ORIGIN: "https://auth.example.com",
  APP_ORIGINS: "https://app.example.com",
  AUTH_COOKIE_DOMAIN: "auth.example.com",
  JWT_SIGNING_KID: "kid-1",
  DATABASE_URL: "postgres://u:p@host:5432/db",
  REDIS_URL: "redis://localhost:6379",
  BLIND_INDEX_KEY: "0123456789abcdef",
};

const hasIssue = (r: ReturnType<typeof appEnvSchema.safeParse>, path: string): boolean =>
  !r.success && r.error.issues.some((i) => i.path.join(".") === path);

describe("appEnvSchema WEBAUTHN_RP_ID requirement", () => {
  it("passes when passkeys are off (no RP-ID needed)", () => {
    expect(appEnvSchema.safeParse(base).success).toBe(true);
  });

  it("passes when enabled WITH a registrable-domain RP-ID", () => {
    const r = appEnvSchema.safeParse({
      ...base,
      WEBAUTHN_ENABLED: "true",
      WEBAUTHN_RP_ID: "example.com",
    });
    expect(r.success).toBe(true);
  });

  it("fails fast when enabled WITHOUT an RP-ID (in dev too, not just prod)", () => {
    const r = appEnvSchema.safeParse({ ...base, WEBAUTHN_ENABLED: "true" });
    expect(hasIssue(r, "WEBAUTHN_RP_ID")).toBe(true);
  });

  it("fails when enabled with a blank RP-ID", () => {
    const r = appEnvSchema.safeParse({
      ...base,
      WEBAUTHN_ENABLED: "true",
      WEBAUTHN_RP_ID: "   ",
    });
    expect(hasIssue(r, "WEBAUTHN_RP_ID")).toBe(true);
  });
});
