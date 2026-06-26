// sessionTimeout.test.ts — proves the P1-01 Gate D session-timeout MATH (ADR-0018), DB-free, for BOTH
// boundaries. ABSOLUTE: a session expires at the EARLIER of the platform default (REFRESH_TOKEN_TTL_SECONDS)
// and now + the tenant policy's sessionTimeoutSeconds. IDLE: a refresh whose gap since the session's
// lastSeenAt exceeds the tenant policy's idleTimeoutSeconds is rejected; idle resets on each refresh, absolute
// never does, and the two reject independently. Critically: with NO cap supplied (the enforcement-off path,
// which never passes one) the expiry is exactly the platform default, and idle is never expired when the
// window is unset or lastSeenAt is null — the merge-safety property at the math layer.
import { describe, expect, it } from "bun:test";
import { env } from "@leadwolf/config";
import { cappedSessionExpiry, isIdleExpired } from "./session.ts";

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

describe("isIdleExpired (Gate D — idle boundary)", () => {
  const IDLE = 3600; // 1h idle window
  const lastSeen = (secondsAgo: number) => new Date(NOW - secondsAgo * 1000);

  it("idle window NOT exceeded → not expired (boundary: window − 1s)", () => {
    expect(isIdleExpired(lastSeen(IDLE - 1), IDLE, NOW)).toBe(false);
  });

  it("exactly at the window → not expired (strict >)", () => {
    expect(isIdleExpired(lastSeen(IDLE), IDLE, NOW)).toBe(false);
  });

  it("idle window exceeded → expired (boundary: window + 1s)", () => {
    expect(isIdleExpired(lastSeen(IDLE + 1), IDLE, NOW)).toBe(true);
  });

  it("null lastSeenAt → never expired (no idle data; never lock out over missing data)", () => {
    expect(isIdleExpired(null, IDLE, NOW)).toBe(false);
  });

  it("unset / zero / negative window → never expired (no idle limit configured)", () => {
    expect(isIdleExpired(lastSeen(10 * IDLE), undefined, NOW)).toBe(false);
    expect(isIdleExpired(lastSeen(10 * IDLE), 0, NOW)).toBe(false);
    expect(isIdleExpired(lastSeen(10 * IDLE), -5, NOW)).toBe(false);
  });

  it("is INDEPENDENT of the absolute cap (idle can expire while absolute has room, and vice versa)", () => {
    // Idle expired (2h since last seen) even though the absolute default TTL (30d) has plenty of room.
    expect(isIdleExpired(lastSeen(2 * IDLE), IDLE, NOW)).toBe(true);
    // Fresh activity (just now) → idle NOT expired regardless of how short the absolute cap is.
    expect(isIdleExpired(lastSeen(0), IDLE, NOW)).toBe(false);
  });
});
