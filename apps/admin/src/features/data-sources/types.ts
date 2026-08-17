// types.ts — local view model for the data-sources (origin fleet) admin slice. Mirrors the
// /admin/data-sources GET payload (provider_origins masked view — key HINT only, never a secret).
export interface DataSourceOriginView {
  id: string;
  provider: string;
  label: string;
  baseUrl: string;
  apiKeyHint: string | null;
  priority: number;
  paused: boolean;
  lastOkAt: string | null;
  consecutiveFailures: number;
  lastError: string | null;
  lastErrorAt: string | null;
}

export interface OriginTestResult {
  status: "ok" | "rejected" | "unavailable";
  httpStatus: number | null;
  latencyMs: number;
}
