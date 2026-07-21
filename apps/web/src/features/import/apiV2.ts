// apiV2.ts — data access for the durable import v2 surfaces (import-redesign 08 §7 verbs; S-U2/S-U3/S-U6).
// Thin, typed fetchers over the tenant import endpoints, all via fetchWithAuth (the in-memory access token,
// ADR-0016 — never a raw <a href>, which would carry no auth). Every surface renders server answers; the
// client never widens a query beyond what the role's endpoints return (10 §2.1). Separate from the legacy
// api.ts so the two transport contracts (legacy poll vs v2 durable) stay visibly distinct.

import { fetchWithAuth } from "@/lib/authClient";
import { API_BASE } from "@/lib/publicConfig";
import type {
  ImportJobDetailV2,
  ImportJobListResponse,
  ImportJobRef,
  ImportJobStatusResponse,
} from "@leadwolf/types";

const IMPORTS_BASE = `${API_BASE}/api/v1/imports`;

/** GET /imports is a NEW endpoint that exists ONLY behind the IMPORT_V2 dual gate: gate-off ⇒ 404 (no legacy
 *  import list, no existence oracle). The list surface treats this typed error as "not enabled" — an honest
 *  disabled state, not a failure banner. */
export class ImportsNotEnabledError extends Error {
  readonly notEnabled = true as const;
  constructor(message = "Import history isn’t enabled for your workspace yet.") {
    super(message);
    this.name = "ImportsNotEnabledError";
  }
}

/** RFC-9457 problem body → a human message (shared with the S-U7 draft fetchers in apiDrafts.ts). */
export async function problemMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { detail?: string; title?: string } | null;
  return body?.detail ?? body?.title ?? `${fallback} (${res.status})`;
}

/** The GET /imports/:jobId shape: the legacy poll response ALWAYS, plus the additive v2 members when the dual
 *  gate is on (08 §2.4 window). Gate-off / legacy numeric ids carry only the legacy fields, so the v2 members
 *  are optional — every consumer prefers `statusV2`/`counts` and falls back to the legacy `status`/`summary`. */
export type ImportJobDetail = ImportJobStatusResponse & Partial<ImportJobDetailV2>;

/** GET /imports — one keyset page of the durable history (08 §7). 404 ⇒ the dual gate is off (not enabled). */
export async function fetchImportJobs(
  cursor: string | null,
  limit = 50,
): Promise<ImportJobListResponse> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (cursor) params.set("cursor", cursor);
  const res = await fetchWithAuth(`${IMPORTS_BASE}?${params}`);
  if (res.status === 404) throw new ImportsNotEnabledError();
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load imports"));
  return (await res.json()) as ImportJobListResponse;
}

/** GET /imports/:jobId — one job's durable detail (the drawer + the job page share this). */
export async function fetchImportJobDetail(jobId: string): Promise<ImportJobDetail> {
  const res = await fetchWithAuth(`${IMPORTS_BASE}/${encodeURIComponent(jobId)}`);
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load this import"));
  return (await res.json()) as ImportJobDetail;
}

/** POST /imports/:jobId/cancel — idempotent stop-remainder (08 §2.2). 200 ⇒ the updated detail. */
export async function cancelImportJob(jobId: string): Promise<ImportJobDetail> {
  const res = await fetchWithAuth(`${IMPORTS_BASE}/${encodeURIComponent(jobId)}/cancel`, {
    method: "POST",
  });
  if (!res.ok) throw new Error(await problemMessage(res, "Could not cancel this import"));
  return (await res.json()) as ImportJobDetail;
}

/** POST /imports/:jobId/retry-failed — spawn the retry-failed CHILD job (08 §6.3). 202 ⇒ the child ref.
 *  Idempotency-Key makes a double-click return the SAME child (the server's partial unique). */
export async function retryFailedRows(jobId: string): Promise<ImportJobRef> {
  const res = await fetchWithAuth(`${IMPORTS_BASE}/${encodeURIComponent(jobId)}/retry-failed`, {
    method: "POST",
    headers: { "idempotency-key": `retry-${jobId}` },
  });
  if (!res.ok) throw new Error(await problemMessage(res, "Could not retry the failed rows"));
  return (await res.json()) as ImportJobRef;
}

/** The two PII-bearing error artifacts (08 §6.2): the repair CSV + the grouped error report. */
export type ArtifactKind = "repair" | "errors";

/** Download an error artifact through the PROXIED-WITH-AUDIT endpoint (10 §5 row 5 / 13 §4.3). We must fetch
 *  WITH the in-memory bearer token (a plain anchor click carries no auth) → blob → object-URL → click, so the
 *  server can evaluate the gate + write the download audit row before streaming. A 404 = not entitled OR no
 *  such artifact (uniform, no existence oracle) — surfaced as a plain message by the caller. */
export async function downloadArtifact(jobId: string, kind: ArtifactKind): Promise<void> {
  const res = await fetchWithAuth(
    `${IMPORTS_BASE}/${encodeURIComponent(jobId)}/artifacts/${kind}`,
  );
  if (!res.ok) throw new Error(await problemMessage(res, "Could not download the file"));
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `import-${jobId}-${kind}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
