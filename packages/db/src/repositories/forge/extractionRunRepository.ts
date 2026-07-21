// extractionRunRepository — the append-only metering writer (09 §Metering). A plain function the extract
// worker adapts to @forge/core's meter callback (no db→core cycle). Numeric quality signals are stored as
// strings (Drizzle numeric); never the extracted PII value.
import type { Tx } from "../../client.ts";
import { extractionRuns } from "../../schema/forge.ts";

export interface ExtractionRunInsert {
  jobId: string;
  targetTenantId?: string;
  model: string;
  outcome: string;
  usedRepair: boolean;
  extractSchemaVersion?: string;
  groundingCoverage?: number;
  judgeScore?: number;
  confidence?: number;
  latencyMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
}

const num = (n: number | undefined): string | null => (n === undefined ? null : n.toFixed(3));

export async function insertExtractionRun(tx: Tx, row: ExtractionRunInsert): Promise<void> {
  await tx.insert(extractionRuns).values({
    jobId: row.jobId,
    targetTenantId: row.targetTenantId ?? null,
    model: row.model,
    outcome: row.outcome,
    usedRepair: row.usedRepair,
    extractSchemaVersion: row.extractSchemaVersion ?? null,
    groundingCoverage: num(row.groundingCoverage),
    judgeScore: num(row.judgeScore),
    confidence: num(row.confidence),
    latencyMs: row.latencyMs ?? null,
    inputTokens: row.inputTokens ?? null,
    outputTokens: row.outputTokens ?? null,
    cachedTokens: row.cachedTokens ?? null,
  });
}
