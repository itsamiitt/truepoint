// types.ts — the Data Health slice's view-model surface. The rollups are server contracts in @leadwolf/types
// (counts + timestamps only — PII-safe); we re-export them so the slice has one local import surface for them
// (mirrors features/home/types.ts). WorkspaceDataQuality has NO per-contact composite quality score — it is a
// counts-only rollup, so this destination derives coverage / deliverability / freshness rates from those counts.
export type {
  DataQualityTrendPoint,
  RetentionRun,
  ReverificationRun,
  WorkspaceDataQuality,
} from "@leadwolf/types";
