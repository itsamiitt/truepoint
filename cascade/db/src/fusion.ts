// Confidence fusion (04 §1): dedupe by source → dampen → combine.
// Base rule is TruthFinder's noisy-OR; the dampening factor and source dedup
// are the published mitigations for correlated sources (TruthFinder KDD'07;
// Knowledge Vault KDD'14). Pure — same inputs, same output.

export const DAMPENING = 0.8;

export interface Sighting {
  sourceId: string;
  confidence: number;
}

export function fuseConfidence(sightings: Sighting[], gamma: number = DAMPENING): number {
  const strongestPerSource = new Map<string, number>();
  for (const s of sightings) {
    const prev = strongestPerSource.get(s.sourceId);
    if (prev === undefined || s.confidence > prev) strongestPerSource.set(s.sourceId, s.confidence);
  }
  let survival = 1;
  for (const c of strongestPerSource.values()) {
    survival *= 1 - gamma * c;
  }
  const fused = 1 - survival;
  return Math.round(fused * 1000) / 1000;
}
