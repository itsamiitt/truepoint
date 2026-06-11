// computeScore.ts — the rule-based v1 lead scorer (ADR-0008, 23 §5): transparent weighted rules over
// ICP fit + intent signals (+ engagement once activities land at M8), APPENDING a versioned `scores` row
// whose score_breakdown explains every point. contacts.priority_score syncs via the DB trigger. Lead
// score is prospect QUALITY — never conflated with email_status (correctness).

import {
  type TenantScope,
  contactRepository,
  intentSignalRepository,
  scoreRepository,
  withTenantTx,
} from "@leadwolf/db";
import { NotFoundError, type ScoreBreakdown, type SignalType } from "@leadwolf/types";

// Default ICP weights — workspace-configurable ICP/scoring settings land with the M8 depth (12 §3).
const SENIORITY_POINTS: Record<string, number> = {
  c_suite: 100,
  vp: 90,
  director: 75,
  manager: 55,
  ic: 30,
  other: 20,
};
const COMPOSITE_WEIGHTS = { icpFit: 0.5, intent: 0.3, engagement: 0.2 } as const;

const clamp = (n: number): number => Math.max(0, Math.min(100, Math.round(n)));

export interface ComputeScoreInput {
  scope: TenantScope & { workspaceId: string };
  contactId: string;
}

export interface ComputeScoreResult {
  scoreId: string;
  icpFit: number;
  intentScore: number;
  engagementScore: number;
  compositeScore: number;
}

export async function computeScore(input: ComputeScoreInput): Promise<ComputeScoreResult> {
  return withTenantTx(input.scope, async (tx) => {
    const contact = await contactRepository.getScoringInputs(tx, input.contactId);
    if (!contact) throw new NotFoundError("Contact not found in this workspace.");

    // ICP fit: seniority is the dominant rule; title/email-presence add completeness signal.
    const seniorityPoints = contact.seniorityLevel
      ? (SENIORITY_POINTS[contact.seniorityLevel] ?? 20)
      : 25;
    const titlePoints = contact.jobTitle ? 10 : 0;
    const reachabilityPoints = contact.hasEmail ? 10 : 0;
    const icpFit = clamp(seniorityPoints * 0.8 + titlePoints + reachabilityPoints);

    // Intent: sum of recent signal weights ×10, capped at 100 (a weight-10 signal alone scores 100).
    const signals = await intentSignalRepository.recentForContact(tx, input.contactId);
    const intentScore = clamp(signals.reduce((sum, s) => sum + s.weight, 0) * 10);

    // Engagement: activities land at M8 — 0 until then, with the weight reserved in the composite.
    const engagementScore = 0;

    const compositeScore = clamp(
      icpFit * COMPOSITE_WEIGHTS.icpFit +
        intentScore * COMPOSITE_WEIGHTS.intent +
        engagementScore * COMPOSITE_WEIGHTS.engagement,
    );

    const breakdown: ScoreBreakdown = {
      icpFit: {
        seniority: seniorityPoints * 0.8,
        title: titlePoints,
        reachability: reachabilityPoints,
      },
      intent: signals.map((s) => ({ signalType: s.signalType as SignalType, weight: s.weight })),
      engagement: {},
      weights: COMPOSITE_WEIGHTS,
    };

    const scoreId = await scoreRepository.append(tx, {
      tenantId: input.scope.tenantId,
      workspaceId: input.scope.workspaceId,
      contactId: input.contactId,
      icpFit,
      intentScore,
      engagementScore,
      compositeScore,
      scoreBreakdown: breakdown,
    });

    return { scoreId, icpFit, intentScore, engagementScore, compositeScore };
  });
}
