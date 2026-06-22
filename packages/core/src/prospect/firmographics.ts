// firmographics.ts — the firmographics rollup (24 Phase-0.5 populate path). Surfaces EXISTING intent_signals
// onto the account firmographic facets so the technographic/funding filters aren't empty: tech_install signal
// details → accounts.technologies (deduped slugs), and the latest funding_round detail → accounts.funding_stage.
// No provider calls, no billing, no new data — a pure rollup over data the workspace already has, run off the
// request thread (the firmographics queue). Per-workspace via withTenantTx → RLS isolation.
//
// SCOPE: company_stage and founded_year are NOT derivable from signals — they need a real firmographics vendor
// (the plan's open "which provider" policy), so they stay null until that lands. The provider-fed path can reuse
// accountRepository.updateFirmographics (it already accepts companyStage/foundedYear).

import {
  type FirmographicSignalRow,
  type TenantScope,
  accountRepository,
  intentSignalRepository,
  withTenantTx,
} from "@leadwolf/db";

/** The firmographic facets we can derive from signals. */
export interface AccountFirmographics {
  technologies: string[];
  fundingStage: string | null;
}

/** Normalize a tech_install detail to a stable technology slug (lowercased, trimmed, length-capped). `null` for
 *  empty details — those don't become a technology. */
export function normalizeTech(detail: string | null | undefined): string | null {
  const t = detail?.trim().toLowerCase();
  return t ? t.slice(0, 100) : null;
}

/** Pure: fold firmographic signals into per-account facets. technologies = the deduped, sorted tech_install
 *  slugs; fundingStage = the detail of the MOST RECENT funding_round (rows arrive newest-first). Only accounts
 *  with at least one derived value appear in the map. */
export function aggregateFirmographics(
  signals: FirmographicSignalRow[],
): Map<string, AccountFirmographics> {
  const techByAccount = new Map<string, Set<string>>();
  const fundingByAccount = new Map<string, { stage: string; at: number }>();

  for (const s of signals) {
    if (s.signalType === "tech_install") {
      const tech = normalizeTech(s.detail);
      if (!tech) continue;
      const set = techByAccount.get(s.accountId);
      if (set) set.add(tech);
      else techByAccount.set(s.accountId, new Set([tech]));
    } else if (s.signalType === "funding_round") {
      const stage = s.detail?.trim();
      if (!stage) continue;
      const at = s.detectedAt.getTime();
      const current = fundingByAccount.get(s.accountId);
      if (!current || at > current.at) {
        fundingByAccount.set(s.accountId, { stage: stage.slice(0, 50), at });
      }
    }
  }

  const out = new Map<string, AccountFirmographics>();
  for (const accountId of new Set([...techByAccount.keys(), ...fundingByAccount.keys()])) {
    out.set(accountId, {
      technologies: [...(techByAccount.get(accountId) ?? [])].sort().slice(0, 50),
      fundingStage: fundingByAccount.get(accountId)?.stage ?? null,
    });
  }
  return out;
}

export interface RunFirmographicRollupResult {
  signalsScanned: number;
  accountsUpdated: number;
}

/**
 * Roll the workspace's firmographic signals up onto its accounts, in ONE workspace-scoped tx (RLS isolation).
 * Idempotent — re-running converges to the same facet values. Intended to run off the request thread after a
 * bulk import (alongside the dedup pass).
 */
export async function runFirmographicRollup(
  scope: TenantScope & { workspaceId: string },
): Promise<RunFirmographicRollupResult> {
  return withTenantTx(scope, async (tx) => {
    const signals = await intentSignalRepository.firmographicSignals(tx);
    const byAccount = aggregateFirmographics(signals);
    let accountsUpdated = 0;
    for (const [accountId, firmo] of byAccount) {
      const patch: { technologies?: string[]; fundingStage?: string } = {};
      if (firmo.technologies.length > 0) patch.technologies = firmo.technologies;
      if (firmo.fundingStage) patch.fundingStage = firmo.fundingStage;
      if (Object.keys(patch).length === 0) continue;
      await accountRepository.updateFirmographics(tx, accountId, patch);
      accountsUpdated += 1;
    }
    return { signalsScanned: signals.length, accountsUpdated };
  });
}
