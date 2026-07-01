// types.ts — the AI-usage slice's view types, mirroring the apps/api `/admin/ai-usage` response shape
// (per-tenant AI NL-search metering over a trailing window). No PII — call metadata + counts only.

export interface AiUsageTenant {
  tenantId: string;
  tenantName: string;
  requests: number;
  /** Non-"ok" outcomes (guard rejections + model/system failures). */
  failures: number;
  repairs: number;
  avgLatencyMs: number | null;
  inputTokens: number;
  outputTokens: number;
}

export interface AiUsageReport {
  windowDays: number;
  tenants: AiUsageTenant[];
}
