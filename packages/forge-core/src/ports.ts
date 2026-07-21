// @forge/core ports — the interfaces @forge/ai adapters implement (04 §G-FORGE-402). core declares them;
// ai never imported here (core-must-not-import-ai). The AI extraction port is `ExtractionPort` (extraction.ts,
// P3, 09-ai-extraction-engine). Enrichment/verification adapters land with their docs.

/** Provider-waterfall enrichment adapter. */
export interface EnrichPort {
  enrich(input: { key: string }): Promise<{ fields: Record<string, unknown> } | null>;
}

/** Email/phone verification adapter. */
export interface VerifyPort {
  verify(input: { channel: "email" | "phone"; value: string }): Promise<{ status: string }>;
}
