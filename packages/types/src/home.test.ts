// home.test.ts — guards the Home summary DTO contract (07 §2). homeSummarySchema is the single source of
// truth shared by apps/api and apps/web, so it must accept a well-formed payload and reject the two ways a
// caller most easily gets it wrong: a negative credit count (credits are min(0) ints) and a revealType that
// is not one of the closed reveal enum members. Pure unit test (no DB).

import { describe, expect, it } from "bun:test";
import { homeSummarySchema } from "./home.ts";

const valid = {
  creditBalance: 1200,
  burn: [{ day: "2026-06-14", credits: 40 }],
  recentReveals: [
    {
      id: "rev_1",
      contactId: "c_1",
      revealType: "email",
      creditsConsumed: 2,
      revealedAt: "2026-06-14T10:00:00.000Z",
    },
  ],
  hotLeads: [
    {
      id: "c_1",
      firstName: "Jane",
      lastName: null,
      jobTitle: "VP Sales",
      emailDomain: "acme.com",
      priorityScore: 88,
      outreachStatus: "queued",
      isRevealed: false,
    },
  ],
  recentImports: [
    {
      sourceName: "Q2 list",
      sourceFile: "q2.csv",
      contactCount: 500,
      importedAt: "2026-06-13T09:00:00.000Z",
    },
  ],
  enrichmentActivity: [
    { providerName: "apollo", status: "ok", cacheHit: true, calledAt: "2026-06-14T11:00:00.000Z" },
  ],
  sequenceSnapshot: { activeSequences: 3, enrolled: 120, sent: 90, replied: 12 },
  activityFeed: [
    {
      id: "a_1",
      action: "reveal",
      entityType: "contact",
      entityId: "c_1",
      actorUserId: "u_1",
      occurredAt: "2026-06-14T10:00:00.000Z",
    },
  ],
};

describe("homeSummarySchema", () => {
  it("accepts a well-formed summary payload", () => {
    const parsed = homeSummarySchema.parse(valid);
    expect(parsed.creditBalance).toBe(1200);
    expect(parsed.recentReveals[0]!.revealType).toBe("email");
  });

  it("rejects a negative credit balance", () => {
    expect(homeSummarySchema.safeParse({ ...valid, creditBalance: -1 }).success).toBe(false);
  });

  it("rejects a negative per-day burn credit count", () => {
    const result = homeSummarySchema.safeParse({
      ...valid,
      burn: [{ day: "2026-06-14", credits: -5 }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a recentReveal with a revealType outside the closed enum", () => {
    const result = homeSummarySchema.safeParse({
      ...valid,
      recentReveals: [{ ...valid.recentReveals[0], revealType: "sms" }],
    });
    expect(result.success).toBe(false);
  });
});
