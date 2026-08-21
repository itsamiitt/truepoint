// apiKeySecret.test.ts — the credential's security properties, asserted rather than assumed.
//
// Every one of these would pass code review if it were broken. A prefix that happened to be the whole secret,
// a hash that was the identity function, a "random" key that repeated — all of them look like working code
// and all of them are catastrophic. They are cheap to state and impossible to notice by reading.

import { describe, expect, test } from "bun:test";
import { API_KEY_DISPLAY_PREFIX_LENGTH, API_KEY_LIVE_PREFIX } from "@leadwolf/types";
import { mintKey, sha256Hex } from "./apiKeySecret.ts";

describe("mintKey", () => {
  test("the secret carries the live band and real entropy", () => {
    const { secret } = mintKey();
    expect(secret.startsWith(API_KEY_LIVE_PREFIX)).toBe(true);
    // 32 bytes base64url = 43 chars, plus the band.
    expect(secret.length).toBe(API_KEY_LIVE_PREFIX.length + 43);
    // base64url only — a `+`, `/` or `=` would break any caller that puts the key in a URL or a header.
    expect(secret.slice(API_KEY_LIVE_PREFIX.length)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test("keys do not repeat", () => {
    const seen = new Set(Array.from({ length: 500 }, () => mintKey().secret));
    expect(seen.size).toBe(500);
  });

  test("the stored hash is not the secret, and is the secret's SHA-256", () => {
    const { secret, keyHash } = mintKey();
    expect(keyHash).not.toBe(secret);
    expect(keyHash).not.toContain(secret);
    expect(keyHash).toBe(sha256Hex(secret));
    expect(keyHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("the hash is deterministic, so an authentication lookup can match on it", () => {
    const { secret, keyHash } = mintKey();
    expect(sha256Hex(secret)).toBe(keyHash);
  });

  test("the displayed prefix cannot be used to authenticate", () => {
    const { secret, keyPrefix, keyHash } = mintKey();
    expect(keyPrefix.length).toBe(API_KEY_DISPLAY_PREFIX_LENGTH);
    expect(secret.startsWith(keyPrefix)).toBe(true);
    // The whole point: the fragment we show is far too short to be the secret, and hashing it does not
    // produce the stored hash. A prefix that authenticated would make the management list a credential dump.
    expect(keyPrefix.length).toBeLessThan(secret.length);
    expect(sha256Hex(keyPrefix)).not.toBe(keyHash);
  });

  test("the prefix leaves at least 8 characters of randomness to tell keys apart", () => {
    // The band is 8 chars, so a 16-char prefix shows 8 random ones — enough that two keys created seconds
    // apart are distinguishable in a list and in the customer's own logs.
    const { keyPrefix } = mintKey();
    expect(keyPrefix.slice(API_KEY_LIVE_PREFIX.length).length).toBeGreaterThanOrEqual(8);
  });
});
