// dataHealth.test.ts — the pure freshness/re-verify helpers. The scoring math is exercised via core's
// dataQualityScore.test.ts (re-export); this covers the re-verification cutoff used by the freshness loop.
import { describe, expect, test } from "bun:test";
import { FRESHNESS_SLA_DAYS, reverifyCutoff } from "./dataHealth.ts";

describe("reverifyCutoff", () => {
  test("defaults to exactly the email SLA before now", () => {
    const now = new Date("2026-06-27T00:00:00.000Z");
    const cutoff = reverifyCutoff(now);
    expect(now.getTime() - cutoff.getTime()).toBe(FRESHNESS_SLA_DAYS.email * 86_400_000);
  });

  test("honours an explicit slaDays", () => {
    const now = new Date("2026-06-27T00:00:00.000Z");
    expect(reverifyCutoff(now, 30).toISOString()).toBe("2026-05-28T00:00:00.000Z");
  });
});
