// dataQualityScore.ts — the data-quality & freshness keystone (22 §2–§3, ADR-0025). The MATH now lives in the
// LEAF @leadwolf/types package (`dataHealth.ts`) so it is a single source every layer reuses without forking:
// @leadwolf/db (the masked list-member projection — list-plan/06 §3.3 Data Health column), @leadwolf/core
// (here), and @leadwolf/web (the column renderer). This module re-exports it verbatim so every existing core
// import path + the unit test keep working unchanged — the relocation is import-transparent.
//
// CORRECTNESS ≠ LEAD QUALITY (22 §1): this measures FIELD correctness/currency, never prospect quality (the
// lead score, ADR-0008). Never conflate.

export {
  FRESHNESS_SLA_DAYS,
  type FreshnessField,
  COLD_START_FRESHNESS,
  freshnessStatusFor,
  freshnessSubScore,
  verificationSubScore,
  verificationMean,
  type CompletenessField,
  completenessSubScore,
  COMPLETENESS_WEIGHTS,
  type QualitySubScores,
  dataQualityScore,
  type ContactQualityInput,
  type ContactQualityResult,
  computeContactDataQuality,
  ageDaysSince,
} from "@leadwolf/types";
