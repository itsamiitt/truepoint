// @forge/core DSAR — P8 (15/14). The cross-layer erasure orchestrator: a GDPR Art 17 erasure must be
// verifiable, irreversible, and reach the RAW layer, answered within one month [S117]. The plan fans out
// across all four layers keyed by the subject's blind index (never clear PII); production is a suppression
// event (the sync's narrow duty, 11 §5). Pure — the actual writes/tombstones are owned by 14/the retention doc.

/** The four layers a DSAR erasure must reach (raw is the highest-restriction target, [S117]). */
export const DSAR_LAYERS = [
  "raw_captures",
  "parsed_records",
  "verified_records",
  "production_projection",
] as const;
export type DsarLayer = (typeof DSAR_LAYERS)[number];

export type ErasureAction = "tombstone" | "delete_blob" | "suppress";

export interface ErasureStep {
  layer: DsarLayer;
  action: ErasureAction;
  key: string; // the subject blind index (HMAC) — never clear PII
}

/** Build the fan-out plan for a subject (keyed on blind index). Raw is tombstoned + its blob deleted; parsed/
 *  verified are tombstoned; production is a suppression event (verified.suppressed → is_suppressed, 11 §5). */
export function planErasure(subjectBlindIndex: string): ErasureStep[] {
  return [
    { layer: "raw_captures", action: "delete_blob", key: subjectBlindIndex },
    { layer: "raw_captures", action: "tombstone", key: subjectBlindIndex },
    { layer: "parsed_records", action: "tombstone", key: subjectBlindIndex },
    { layer: "verified_records", action: "tombstone", key: subjectBlindIndex },
    { layer: "production_projection", action: "suppress", key: subjectBlindIndex },
  ];
}

/** Verifiability: the plan must reach EVERY layer (a DSAR that misses a layer is non-compliant, [S117]). */
export function reachesAllLayers(steps: ErasureStep[]): boolean {
  const covered = new Set(steps.map((s) => s.layer));
  return DSAR_LAYERS.every((l) => covered.has(l));
}

/** No clear PII in any step (the key is always the blind index). */
export function isPiiFree(steps: ErasureStep[], blindIndex: string): boolean {
  return steps.every((s) => s.key === blindIndex);
}
