// api.ts — the Data Health slice's data access: typed, authenticated reads of the per-workspace Data Health
// endpoints (mirrors features/home/api.ts — the same fetchWithAuth + problemMessage seam, ADR-0016). This slice
// reuses the EXISTING GET /home/data-quality* endpoints (no new backend); it is a dedicated destination view over
// the same workspace-scoped, PII-safe rollups the Home cockpit cards read. The slice's only seam to the backend.

import { fetchWithAuth } from "@/lib/authClient";
import { API_BASE } from "@/lib/publicConfig";
import type { DuplicatePairView } from "@leadwolf/types";
import type {
  DataQualityTrendPoint,
  RetentionRun,
  ReverificationRun,
  WorkspaceDataQuality,
} from "./types";

async function problemMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { detail?: string; title?: string } | null;
  return body?.detail ?? body?.title ?? `${fallback} (${res.status})`;
}

/** Load the per-workspace Data Health rollup (coverage / deliverability / freshness counts). */
export async function fetchDataQuality(): Promise<WorkspaceDataQuality> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/home/data-quality`);
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load your data health"));
  return (await res.json()) as WorkspaceDataQuality;
}

/** Load the per-workspace Data Health trend series (newest first). */
export async function fetchDataQualityHistory(): Promise<DataQualityTrendPoint[]> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/home/data-quality/history`);
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load your data health history"));
  return (await res.json()) as DataQualityTrendPoint[];
}

/** Load the per-workspace freshness re-verification runs (newest first). */
export async function fetchReverificationRuns(): Promise<ReverificationRun[]> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/home/data-quality/reverification-runs`);
  if (!res.ok) {
    throw new Error(await problemMessage(res, "Could not load your re-verification activity"));
  }
  return (await res.json()) as ReverificationRun[];
}

/** Load the per-tenant retention-engine run audit (shadow evidence; newest first). */
export async function fetchRetentionRuns(): Promise<RetentionRun[]> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/home/data-quality/retention-runs`);
  if (!res.ok) {
    throw new Error(await problemMessage(res, "Could not load your retention activity"));
  }
  return (await res.json()) as RetentionRun[];
}

/** The outcome of an on-demand re-verification trigger (POST /home/data-quality/reverify), branched so the UI
 *  can show distinct toasts for rate-limit (429) and not-allowed (403) without throwing. */
export type ReverifyTriggerResult =
  | { ok: true }
  | { ok: false; reason: "rate_limited" | "forbidden" | "error"; message: string };

/** Trigger the per-workspace re-verification on demand. Owner/admin only + rate-limited + flag-gated server-side;
 *  inherently bounded + idempotent (the worker no-ops when re-verification is off for the tenant). */
export async function triggerReverification(): Promise<ReverifyTriggerResult> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/home/data-quality/reverify`, {
    method: "POST",
  });
  if (res.ok) return { ok: true };
  if (res.status === 429) {
    const message = await problemMessage(res, "Try again shortly");
    return { ok: false, reason: "rate_limited", message };
  }
  if (res.status === 403) {
    const message = await problemMessage(res, "You don't have access");
    return { ok: false, reason: "forbidden", message };
  }
  const message = await problemMessage(res, "Could not start re-verification");
  return { ok: false, reason: "error", message };
}

/** Load the workspace's auto-flagged duplicate contact pairs for review (GET /contacts/duplicates). */
export async function fetchDuplicatePairs(): Promise<DuplicatePairView[]> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/contacts/duplicates`);
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load your duplicate contacts"));
  const body = (await res.json()) as { pairs: DuplicatePairView[] };
  return body.pairs;
}

/** Override a wrong auto-dedup call ("this is not a duplicate") — POST /contacts/duplicates/:id/unmark. */
export async function unmarkDuplicate(contactId: string): Promise<void> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/contacts/duplicates/${contactId}/unmark`, {
    method: "POST",
  });
  if (!res.ok) throw new Error(await problemMessage(res, "Could not update this contact"));
}
