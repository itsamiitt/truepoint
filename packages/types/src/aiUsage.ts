// aiUsage.ts — shared contracts for the metered AI-request log (M14 / 13a Area 14). The outcome vocabulary is
// the source of truth for the ai_requests.outcome column + the API route that records it; the usage-rollup
// shapes back the (staff) platform AI-observability read.

import { z } from "zod";

/** How one AI model call ended. "ok" = a valid filter was produced; the rest are guard/model/system stops. */
export const aiRequestOutcome = z.enum([
  "ok",
  "rejected", // prompt-injection guard rejected the input (no spend)
  "budget_exceeded", // per-tenant daily AI budget reached
  "unavailable", // model unreachable / no API key
  "invalid_output", // model output failed validation even after repair
  "error", // unexpected failure
]);
export type AiRequestOutcome = z.infer<typeof aiRequestOutcome>;

/** One tenant's AI usage rollup over a window (platform observability). */
export const aiUsageByTenant = z.object({
  tenantId: z.string().uuid(),
  requests: z.number().int().nonnegative(),
  failures: z.number().int().nonnegative(),
  repairs: z.number().int().nonnegative(),
  avgLatencyMs: z.number().nullable(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
});
export type AiUsageByTenant = z.infer<typeof aiUsageByTenant>;

/** The staff AI-usage read payload: per-tenant rollups over `sinceDays`. */
export const aiUsageReport = z.object({
  sinceDays: z.number().int().positive(),
  tenants: z.array(aiUsageByTenant),
});
export type AiUsageReport = z.infer<typeof aiUsageReport>;
