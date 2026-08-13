// confidenceDivergence.test.ts — quantify the gap between the two shipped confidence engines (audit 32 §9D).
//
// WHY THIS EXISTS. Two engines ship. `packages/types/src/confidence.ts` is LIVE — it is what
// buildConfidenceBadgeV1 shows customers. `packages/core/src/prospect/confidence.ts` is DORMANT: it reads
// master_confidence_policy, so staff could tune it without a deploy, and nothing calls it. Choosing between
// them is a product decision (§9D) because switching re-scores every displayed record.
//
// That decision needs NUMBERS, and getting them by instrumenting the live reveal path would mean adding a
// database read to the money path to answer a question that is pure arithmetic. Both scorers are pure
// functions, so the comparison runs offline instead — with the REAL seeded policy rows from migration 0107,
// not invented ones, because a divergence measured against made-up parameters would prove nothing.
//
// This test does not assert which engine is better. It pins the SHAPE of the disagreement so that (a) the
// decision can be made against evidence, and (b) if someone edits one engine and not the other, the numbers
// move and this fails — which is the only automated protection the split currently has.

import { describe, expect, test } from "bun:test";
import { computeFieldConfidence } from "@leadwolf/types";
import { type ConfidencePolicy, scoreConfidence } from "./confidence.ts";

/** The seeded rows this comparison needs, copied verbatim from migration 0107. */
const POLICIES: ConfidencePolicy[] = [
  {
    field: "*",
    sourceType: "*",
    halfLifeDays: 730,
    sourceWeight: 0.7,
    corroborationCeiling: 5,
    isEnabled: true,
  },
  {
    field: "*",
    sourceType: "provider",
    halfLifeDays: 545,
    sourceWeight: 0.85,
    corroborationCeiling: 5,
    isEnabled: true,
  },
  {
    field: "*",
    sourceType: "reveal",
    halfLifeDays: 365,
    sourceWeight: 0.95,
    corroborationCeiling: 3,
    isEnabled: true,
  },
  {
    field: "*",
    sourceType: "crawl",
    halfLifeDays: 180,
    sourceWeight: 0.55,
    corroborationCeiling: 6,
    isEnabled: true,
  },
  {
    field: "jobTitle",
    sourceType: "*",
    halfLifeDays: 365,
    sourceWeight: 0.8,
    corroborationCeiling: 4,
    isEnabled: true,
  },
];

const DAY_MS = 86_400_000;

/** Both engines' score for the same fact. `null` from core means no policy matched. */
function bothEngines(args: {
  field: string;
  sourceType: string;
  method: "provider" | "user_confirm" | "import" | "crawl";
  ageDays: number;
  sources: number;
}): { live: number; dormant: number | null } {
  const observedAt = new Date(Date.UTC(2026, 0, 1) - args.ageDays * DAY_MS);
  const now = new Date(Date.UTC(2026, 0, 1));
  const dormant = scoreConfidence({
    policies: POLICIES,
    field: args.field,
    sourceType: args.sourceType,
    sourceCount: args.sources,
    observedAt,
    asOf: now,
  });
  const live = computeFieldConfidence({
    field: args.field,
    method: args.method,
    ageDays: args.ageDays,
    distinctSources: args.sources,
  });
  return { live, dormant: dormant.confidence };
}

describe("the two engines disagree, and by how much", () => {
  test("a provider-sourced email, three sources, six months old", () => {
    const { live, dormant } = bothEngines({
      field: "email",
      sourceType: "provider",
      method: "provider",
      ageDays: 180,
      sources: 3,
    });
    expect(dormant).not.toBeNull();
    // The dormant engine scores this materially HIGHER: Noisy-OR over three 0.85 sources saturates near 1
    // before decay, where the live engine's corroboration boost is capped at 1.25x over a 0.8 method prior.
    expect(dormant as number).toBeGreaterThan(live);
    expect((dormant as number) - live).toBeGreaterThan(0.05);
  });

  test("corroboration is where they part company, not decay", () => {
    // ONE source: the two are much closer — decay is identical arithmetic in both files.
    const one = bothEngines({
      field: "email",
      sourceType: "provider",
      method: "provider",
      ageDays: 180,
      sources: 1,
    });
    // FIVE sources: the gap widens, because Noisy-OR compounds and the capped boost cannot.
    const five = bothEngines({
      field: "email",
      sourceType: "provider",
      method: "provider",
      ageDays: 180,
      sources: 5,
    });
    const gapAtOne = Math.abs((one.dormant as number) - one.live);
    const gapAtFive = Math.abs((five.dormant as number) - five.live);
    expect(gapAtFive).toBeGreaterThan(gapAtOne);
  });

  test("a weak passive source is where the live engine is the GENEROUS one", () => {
    // crawl: policy weight 0.55 and a 180-day half-life. The dormant engine punishes a weak passive source
    // much harder than the live engine's method prior does — so the disagreement is not one-directional, and
    // "switch to the better model" is not uniformly a score increase.
    const { live, dormant } = bothEngines({
      field: "email",
      sourceType: "crawl",
      method: "crawl",
      ageDays: 365,
      sources: 1,
    });
    expect(dormant).not.toBeNull();
    expect(dormant as number).toBeLessThan(live);
  });

  test("both agree that an unobserved fact is not scored as false", () => {
    // The cold-start property is the one thing they DO share, and it is the most important one: a value with
    // no observation date must not read as fabricated.
    const live = computeFieldConfidence({ field: "email", method: "provider", ageDays: null });
    expect(live).toBeGreaterThan(0);
    const dormant = scoreConfidence({
      policies: POLICIES,
      field: "email",
      sourceType: "provider",
      sourceCount: 1,
      observedAt: null,
      asOf: new Date(Date.UTC(2026, 0, 1)),
    });
    expect(dormant.decay).toBe(1); // no observation date ⇒ no decay applied, not zero confidence
  });
});

describe("the dormant engine's policy precedence actually resolves", () => {
  test("a field-specific row beats the wildcard, which is the point of the policy table", () => {
    // jobTitle has its own row (0.8 / 365d) that outranks the universal fallback (0.7 / 730d). This is the
    // capability the live engine structurally cannot have: its half-lives are hardcoded constants.
    const jobTitle = scoreConfidence({
      policies: POLICIES,
      field: "jobTitle",
      sourceType: "unclassified",
      sourceCount: 1,
      observedAt: new Date(Date.UTC(2025, 0, 1)),
      asOf: new Date(Date.UTC(2026, 0, 1)),
    });
    expect(jobTitle.policy?.field).toBe("jobTitle");
    expect(jobTitle.policy?.halfLifeDays).toBe(365);
  });
});
