// dataQualitySummary.ts — the per-workspace Data Health dashboard rollup (10 §5 / 22). A thin core orchestrator
// over contactRepository.dataQualitySummary: the live, RLS-scoped fill / verification / freshness count aggregate
// the dashboard reads. Kept in core so the api route depends on @leadwolf/core (not @leadwolf/db directly) — the
// same layering as buildHomeSummary. The heavy lifting (one aggregate scan + the freshness cutoff) is in the repo.

import { contactRepository } from "@leadwolf/db";
import type { WorkspaceDataQuality } from "@leadwolf/types";

export function buildDataQualitySummary(scope: {
  tenantId: string;
  workspaceId: string;
}): Promise<WorkspaceDataQuality> {
  return contactRepository.dataQualitySummary(scope);
}
