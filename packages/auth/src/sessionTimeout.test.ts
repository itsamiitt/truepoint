// sessionTimeout.test.ts — proves the P1-01 Gate D session-timeout cap MATH (ADR-0018), DB-free. The cap is
// the ABSOLUTE boundary: a session expires at the EARLIER of the platform default (REFRESH_TOKEN_TTL_SECONDS)
// and now + the tenant policy's sessionTimeoutSeconds. The IDLE boundary (lastSeenAt) is a deferred follow-up.
// Critically: with NO cap supplied (the AUTH_POLICY_ENFORCEMENT_ENABLED-off path, which never passes one),
// the expiry is exactly the platform default — the merge-safety property at the math layer.
import { describe, expect, it } from "bun:test";
import { env } from "@leadwolf/config";
import { cappedSessionExpiry } from "./session.ts";

const NOW = 1_000_000_000_000; // fixed clock for deterministic math
const DEFAULT_TTL_MS = env.REFRESH_TOKEN_TTL_SECONDS * 1000;

describe("cappedSessionExpiry", () => {
  it("no cap (flag-off path) → exactly the platform default expiry", () => {
    expect(cappedSessionExpiry(undefined, NOW).getTime()).toBe(NOW + DEFAULT_TTL_MS);
  });

  it("a cap SHORTER than the default wins (min)", () => {
    const capSeconds = 3600; // 1h, far below the 30-day default
    expect(cappedSessionExpiry(capSeconds, NOW).getTime()).toBe(NOW + capSeconds * 1000);
  });

  it("a cap LONGER than the default does not extend past the default (min)", () => {
    const capSeconds = env.REFRESH_TOKEN_TTL_SECONDS * 10;
    expect(cappedSessionExpiry(capSeconds, NOW).getTime()).toBe(NOW + DEFAULT_TTL_MS);
  });

  it("a cap equal to the default is unchanged", () => {
    expect(cappedSessionExpiry(env.REFRESH_TOKEN_TTL_SECONDS, NOW).getTime()).toBe(
      NOW + DEFAULT_TTL_MS,
    );
  });

  it("a zero or negative cap is treated as no cap (defends a mis-set policy)", () => {
    expect(cappedSessionExpiry(0, NOW).getTime()).toBe(NOW + DEFAULT_TTL_MS);
    expect(cappedSessionExpiry(-5, NOW).getTime()).toBe(NOW + DEFAULT_TTL_MS);
  });
});
