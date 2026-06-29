// providerConfigs.test.ts — pins deriveProviderHealth, the PASSIVE provider-health rule derived from
// provider_calls call-STATUS counts only (no live probe, no secrets). liveCalls = miss + rateLimited + error
// (cache `hit`s are EXCLUDED — a cache hit never contacts the provider). Covers the honest no-live-activity →
// "unknown" path so the console never fabricates a green check.

import { describe, expect, it } from "bun:test";
import { deriveProviderHealth } from "./providerConfigs.ts";

describe("deriveProviderHealth", () => {
  it("returns unknown with no data at all (no live calls to judge)", () => {
    expect(deriveProviderHealth({ hit: 0, miss: 0, rateLimited: 0, error: 0 })).toBe("unknown");
  });

  it("returns healthy when every live call succeeded (all miss)", () => {
    expect(deriveProviderHealth({ hit: 0, miss: 20, rateLimited: 0, error: 0 })).toBe("healthy");
  });

  it("returns down when errors are the majority of live calls", () => {
    expect(deriveProviderHealth({ hit: 0, miss: 3, rateLimited: 0, error: 7 })).toBe("down");
  });

  it("returns degraded when some calls are rate_limited (>=20% bad, <50% error)", () => {
    expect(deriveProviderHealth({ hit: 0, miss: 8, rateLimited: 2, error: 0 })).toBe("degraded");
  });

  it("returns unknown when only cache hits exist (liveCalls === 0)", () => {
    expect(deriveProviderHealth({ hit: 50, miss: 0, rateLimited: 0, error: 0 })).toBe("unknown");
  });
});
