// computeAccountScore.ts — the rule-based v1 ACCOUNT scorer (market-intelligence MI-7/MI-S4; the
// computeScore sibling at the account grain). Two transparent components, every point explained in the
// breakdown:
//   icpFit   — firmographic completeness/quality: known industry node, size, stage, tech, reachability.
//              A tenant-configurable ICP definition is the M8-depth follow-on; these are the defaults.
//   momentum — recency-weighted sum over the account's DELIVERED signals (tenant_signals), per-family
//              weights × exponential decay. COMPANY FACTS ONLY — momentum is what the company did,
//              never who is researching what (X-04 stays out; adding any topic/keyword/visit input is a
//              decisions.md-level change, not a tweak).
// composite = 0.6·fit + 0.4·momentum. Appends a versioned account_scores row; the DB trigger caches the
// FIT onto accounts.icp_fit_score (name-honest).

import {
  type TenantScope,
  accountScoreRepository,
  accountSearchRepository,
  tenantSignalsRepository,
  withTenantTx,
} from "@leadwolf/db";
import { NotFoundError } from "@leadwolf/types";

export const ACCOUNT_SCORE_MODEL_VERSION = "v1";

// Per-family momentum weights (the master_signal_types default_weight scale): what a single fresh signal
// of that family is worth before decay. Funding/leadership dominate — they change WHO to call and WHEN.
const FAMILY_WEIGHTS: Record<string, number> = {
  funding: 45,
  leadership: 40,
  hiring: 30,
  tech_change: 25,
  filing: 15,
  other: 10,
};
/** Momentum half-life: a signal is worth half its weight after this many days. */
const MOMENTUM_HALF_LIFE_DAYS = 90;

const clamp = (n: number): number => Math.max(0, Math.min(100, Math.round(n)));

export interface AccountFitInputs {
  hasIndustryNode: boolean;
  employeeCount: number | null;
  fundingStage: string | null;
  technologiesCount: number;
  hasDomain: boolean;
  contactCount: number;
}

/** Pure fit rule — exported for direct unit testing. */
export function accountIcpFit(f: AccountFitInputs): {
  score: number;
  parts: Record<string, number>;
} {
  const parts: Record<string, number> = {
    industry: f.hasIndustryNode ? 20 : 0,
    size: f.employeeCount !== null ? 15 : 0,
    stage: f.fundingStage ? 15 : 0,
    technology: f.technologiesCount > 0 ? 15 : 0,
    domain: f.hasDomain ? 10 : 0,
    reachability: f.contactCount > 0 ? 25 : 0,
  };
  return { score: clamp(Object.values(parts).reduce((a, b) => a + b, 0)), parts };
}

/** Pure momentum rule — exported for direct unit testing. `signals` = (family, ageDays) pairs. */
export function accountMomentum(signals: ReadonlyArray<{ family: string; ageDays: number }>): {
  score: number;
  parts: Record<string, number>;
} {
  const parts: Record<string, number> = {};
  let sum = 0;
  for (const s of signals) {
    const weight = FAMILY_WEIGHTS[s.family] ?? FAMILY_WEIGHTS.other ?? 10;
    const decayed = weight * 2 ** (-Math.max(0, s.ageDays) / MOMENTUM_HALF_LIFE_DAYS);
    parts[s.family] = Math.round((parts[s.family] ?? 0) + decayed);
    sum += decayed;
  }
  return { score: clamp(sum), parts };
}

export interface ComputeAccountScoreResult {
  scoreId: string;
  icpFit: number;
  momentum: number;
  composite: number;
}

export async function computeAccountScore(input: {
  scope: TenantScope & { workspaceId: string };
  accountId: string;
  now?: Date;
}): Promise<ComputeAccountScoreResult> {
  const now = input.now ?? new Date();
  return withTenantTx(input.scope, async (tx) => {
    const account = await accountSearchRepository.getMaskedById(tx, input.accountId);
    if (!account) throw new NotFoundError("Account not found in this workspace.");

    // industry_id is not on the masked DTO (a display shape) — a dedicated repo read supplies the bit.
    const hasIndustryNode = await accountScoreRepository.hasIndustryNode(tx, input.accountId);

    const fit = accountIcpFit({
      hasIndustryNode,
      employeeCount: account.employeeCount,
      fundingStage: account.fundingStage,
      technologiesCount: account.technologies.length,
      hasDomain: account.domain !== null,
      contactCount: account.contactCount,
    });

    const recent = await tenantSignalsRepository.listRecent(tx, {
      accountId: input.accountId,
      limit: 100,
    });
    const momentum = accountMomentum(
      recent.map((s) => ({
        family: s.family,
        ageDays: Math.floor((now.getTime() - s.observedAt.getTime()) / 86_400_000),
      })),
    );

    const composite = clamp(fit.score * 0.6 + momentum.score * 0.4);
    const scoreId = await accountScoreRepository.append(tx, {
      tenantId: input.scope.tenantId,
      workspaceId: input.scope.workspaceId,
      accountId: input.accountId,
      modelVersion: ACCOUNT_SCORE_MODEL_VERSION,
      icpFit: fit.score,
      momentum: momentum.score,
      composite,
      breakdown: { fit: fit.parts, momentum: momentum.parts, weights: { fit: 0.6, momentum: 0.4 } },
    });
    return { scoreId, icpFit: fit.score, momentum: momentum.score, composite };
  });
}
