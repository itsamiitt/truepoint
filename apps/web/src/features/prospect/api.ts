// api.ts — the prospect slice's data access: typed, authenticated calls to apps/api for the masked search
// list and THE monetized reveal path (05 §6/§7, 07 §3, 09 §3.2). Reads the in-memory access token via
// fetchWithAuth (ADR-0016); never touches the DB or the auth origin directly. The slice's only seam to the
// backend. Reveal carries an Idempotency-Key so a retried POST never double-charges (07 §3).

import { fetchWithAuth } from "@/lib/authClient";
import { API_BASE } from "@/lib/publicConfig";
import type {
  ActivityRow,
  ContactQuery,
  CustomFieldValueDto,
  CustomFieldValueInput,
  MaskedContact,
  RevealCosts,
  RevealJobEstimate,
  RevealJobSummary,
  RevealResponse,
  RevealType,
  RevealedContact,
  Tag,
  TagColor,
  TaggableEntity,
} from "@leadwolf/types";

/**
 * A backend error mapped to its RFC-9457 Problem Details (09 §6). Carries the stable machine `code`
 * (e.g. "insufficient_credits", "suppressed") + status so the reveal flow can branch on the failure
 * mode, plus any extensions (the 402 ships `balance`/`required`).
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly extensions: Record<string, unknown>;

  constructor(message: string, status: number, code: string, extensions: Record<string, unknown>) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.extensions = extensions;
  }
}

/** Parse a non-OK response's Problem Details into an ApiError (mirrors the import slice's helper, typed). */
export async function toApiError(res: Response, fallback: string): Promise<ApiError> {
  const body = (await res.json().catch(() => null)) as
    | ({ detail?: string; title?: string; code?: string } & Record<string, unknown>)
    | null;
  const message = body?.detail ?? body?.title ?? `${fallback} (${res.status})`;
  const code = body?.code ?? "error";
  return new ApiError(message, res.status, code, body ?? {});
}

/**
 * A route that isn't built yet answers 404/501 — that's "no data here / not wired", not a failure to surface.
 * The activity timeline (M8) + lists/enroll/export backends gate behind later milestones, so the slice treats
 * those as not-built (empty / honest "not available yet") rather than fabricating data or faking a mutation.
 */
export function notBuilt(status: number): boolean {
  return status === 404 || status === 501;
}

/** The masked search/list (05 §6): no PII — emailDomain is the only email facet until reveal. */
export async function fetchContacts(limit = 100): Promise<MaskedContact[]> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/contacts?limit=${limit}`);
  if (!res.ok) throw await toApiError(res, "Could not load contacts");
  const data = (await res.json()) as { contacts: MaskedContact[] };
  return data.contacts;
}

/**
 * GET /credits/balance — the tenant's spendable reveal-credit balance (07 §3). Non-PII; the bulk-action
 * bar shows it as the remaining balance and re-reads it on the "credits:changed" event after a reveal.
 * The balance is authoritative server-side; the UI only displays it (never computes the spend).
 */
export async function getCreditBalance(): Promise<number> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/credits/balance`);
  if (!res.ok) throw await toApiError(res, "Could not load credit balance");
  const data = (await res.json()) as { balance: number };
  return data.balance;
}

/** One score-history row (09 §2). Shapes the API's `{ scores: [...] }`; the breakdown is opaque to the UI. */
export interface ScoreHistoryRow {
  id: string;
  icpFit: number;
  intentScore: number;
  engagementScore: number;
  compositeScore: number;
  scoredAt: string;
}

/** Newest-first score history for the detail panel's score block (ADR-0008). */
export async function fetchScores(id: string): Promise<ScoreHistoryRow[]> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/contacts/${id}/scores`);
  if (!res.ok) throw await toApiError(res, "Could not load scores");
  const data = (await res.json()) as { scores: ScoreHistoryRow[] };
  return data.scores;
}

/** The inline rescore result (09 §2): computeScore appends a versioned row + returns the fresh sub-scores. */
export interface RescoreResult {
  scoreId: string;
  icpFit: number;
  intentScore: number;
  engagementScore: number;
  compositeScore: number;
}

/**
 * POST /contacts/:id/rescore — recompute the lead score on demand. The endpoint runs computeScore inline
 * (pure DB work, fast), appends a fresh score-history row, and returns the new sub-scores. No body/charge:
 * the contact id + tenancy come from the path + the access token. Callers re-load fetchScores to show it.
 */
export async function rescoreContact(id: string): Promise<RescoreResult> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/contacts/${id}/rescore`, { method: "POST" });
  if (!res.ok) throw await toApiError(res, "Could not recompute score");
  return (await res.json()) as RescoreResult;
}

/**
 * THE monetized path (07 §3): reveal a contact's PII. Idempotent — a fresh Idempotency-Key per attempt
 * means a network retry replays the same charge instead of double-spending. PII appears ONLY in this
 * response (never in the masked list). 402 → insufficient_credits, 403 → suppressed (both via ApiError).
 */
export async function revealContact(id: string, revealType: RevealType): Promise<RevealResponse> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/contacts/${id}/reveal`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "Idempotency-Key": crypto.randomUUID(),
    },
    body: JSON.stringify({ reveal_type: revealType }),
  });
  if (!res.ok) throw await toApiError(res, "Reveal failed");
  return (await res.json()) as RevealResponse;
}

/**
 * GET /contacts/:id/revealed — the NO-CHARGE view of a contact's ALREADY-OWNED reveal data (Phase 1). Returns
 * decrypted email/phone ONLY for the reveal_types this workspace owns, plus statuses, LinkedIn, and the reveal
 * history. Never spends credits. The record detail calls this on open for a revealed contact so the PII shows
 * instantly and persistently — no re-confirm, no re-charge.
 */
export async function fetchRevealedContact(id: string): Promise<RevealedContact> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/contacts/${id}/revealed`);
  if (!res.ok) throw await toApiError(res, "Could not load revealed data");
  return (await res.json()) as RevealedContact;
}

/**
 * POST /contacts/revealed/batch — hydrate already-owned reveal data for a page of contact ids (no charge).
 * Only the rows the workspace owns something for come back. Used to fill the grid's inline values for
 * previously-revealed rows on page load.
 */
export async function batchRevealedContacts(contactIds: string[]): Promise<RevealedContact[]> {
  if (contactIds.length === 0) return [];
  const res = await fetchWithAuth(`${API_BASE}/api/v1/contacts/revealed/batch`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ contactIds }),
  });
  if (!res.ok) throw await toApiError(res, "Could not load revealed data");
  const data = (await res.json()) as { revealed: RevealedContact[] };
  return data.revealed;
}

/** GET /credits/reveal-costs — per-reveal_type credit cost so the UI can show "Reveal email · N cr" up front. */
export async function getRevealCosts(): Promise<RevealCosts> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/credits/reveal-costs`);
  if (!res.ok) throw await toApiError(res, "Could not load reveal costs");
  return (await res.json()) as RevealCosts;
}

// ── Async bulk-reveal jobs (Phase 3) — the path that works across an ENTIRE search result (select-all). ──
/** POST /contacts/reveal-jobs — create a job over explicit ids OR a select-all criteria. Arms the confirm gate;
 *  spends nothing. Returns the worst-case estimate + whether the balance covers it. */
export async function createBulkRevealJob(body: {
  revealType: RevealType;
  contactIds?: string[];
  criteria?: ContactQuery;
}): Promise<RevealJobEstimate> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/contacts/reveal-jobs`, {
    method: "POST",
    headers: { "content-type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await toApiError(res, "Could not create bulk reveal job");
  return (await res.json()) as RevealJobEstimate;
}

/** GET /contacts/reveal-jobs/:id — poll a job's status/progress. */
export async function fetchRevealJob(jobId: string): Promise<RevealJobSummary> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/contacts/reveal-jobs/${jobId}`);
  if (!res.ok) throw await toApiError(res, "Could not load reveal job");
  return (await res.json()) as RevealJobSummary;
}

/** POST /contacts/reveal-jobs/:id/confirm — the money gate (leases the ceiling + starts the run). 402 =
 *  insufficient, 403 = feature not enabled (dark), 409 = not awaiting confirmation. */
export async function confirmBulkRevealJob(
  jobId: string,
): Promise<{ ok: boolean; status: string }> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/contacts/reveal-jobs/${jobId}/confirm`, {
    method: "POST",
  });
  if (!res.ok) throw await toApiError(res, "Could not confirm reveal job");
  return (await res.json()) as { ok: boolean; status: string };
}

/** POST /contacts/reveal-jobs/:id/cancel — cancel + release the unspent lease. */
export async function cancelBulkRevealJob(jobId: string): Promise<{ ok: boolean; status: string }> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/contacts/reveal-jobs/${jobId}/cancel`, {
    method: "POST",
  });
  if (!res.ok) throw await toApiError(res, "Could not cancel reveal job");
  return (await res.json()) as { ok: boolean; status: string };
}

/** GET /contacts/reveal-jobs/:id/download — a signed URL for the revealed CSV (terminal jobs only). */
export async function fetchBulkRevealDownloadUrl(jobId: string): Promise<string> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/contacts/reveal-jobs/${jobId}/download`);
  if (!res.ok) throw await toApiError(res, "Could not get the download");
  return ((await res.json()) as { downloadUrl: string }).downloadUrl;
}

// ── Tags (ADR-0028, G-REV-6): workspace tag definitions + record assignments + filter-by-tag. ───────────
/** GET /tags — the workspace's tags with live usage counts (the picker list + the filter facets). */
export async function fetchTags(): Promise<Tag[]> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/tags`);
  if (!res.ok) throw await toApiError(res, "Could not load tags");
  const data = (await res.json()) as { tags: Tag[] };
  return data.tags;
}

/** POST /tags — create a workspace tag; returns its id. 409 (tag_name_taken) surfaces as an ApiError. */
export async function createTag(name: string, color: TagColor): Promise<{ id: string }> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/tags`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, color }),
  });
  if (!res.ok) throw await toApiError(res, "Could not create tag");
  return (await res.json()) as { id: string };
}

/** POST /tags/:id/assign — attach a tag to a record (idempotent server-side). */
export async function assignTag(
  tagId: string,
  entity: TaggableEntity,
  recordId: string,
): Promise<void> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/tags/${tagId}/assign`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ entity, record_id: recordId }),
  });
  if (!res.ok) throw await toApiError(res, "Could not assign tag");
}

/** POST /tags/:id/unassign — detach a tag from a record (a no-op if not assigned). */
export async function unassignTag(
  tagId: string,
  entity: TaggableEntity,
  recordId: string,
): Promise<void> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/tags/${tagId}/unassign`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ entity, record_id: recordId }),
  });
  if (!res.ok) throw await toApiError(res, "Could not remove tag");
}

/** An assigned tag on a record — the lighter per-record shape (no usage/createdAt). Derived from the
 *  canonical Tag so it can never drift from it (the single source of truth in @leadwolf/types). */
export type RecordTag = Pick<Tag, "id" | "name" | "color">;

/** GET /tags/records/:entity/:recordId — the tags assigned to one record (RecordDetail "Tags" section). */
export async function fetchRecordTags(
  recordId: string,
  entity: TaggableEntity = "contact",
): Promise<RecordTag[]> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/tags/records/${entity}/${recordId}`);
  if (!res.ok) throw await toApiError(res, "Could not load tags");
  const data = (await res.json()) as { tags: RecordTag[] };
  return data.tags;
}

/** GET /tags/:id/records — the record ids carrying a tag (drives client-side filter-by-tag). */
export async function fetchRecordsByTag(
  tagId: string,
  entity: TaggableEntity = "contact",
): Promise<string[]> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/tags/${tagId}/records?entity=${entity}`);
  if (!res.ok) throw await toApiError(res, "Could not load tagged records");
  const data = (await res.json()) as { recordIds: string[] };
  return data.recordIds;
}

/** The contact activity timeline (09 §3, M8). `available:false` means the route isn't built yet (404/501). */
export interface ActivityFeed {
  available: boolean;
  activities: ActivityRow[];
}

/**
 * GET /contacts/:id/activities — the per-contact timeline (sends/opens/clicks/replies/calls/notes). The
 * timeline backend is an M8 gate, so a 404/501 is treated as not-built (`available:false`) and the detail
 * panel renders a first-class EmptyState instead of an error. No fabricated activity.
 */
export async function fetchActivities(id: string): Promise<ActivityFeed> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/contacts/${id}/activities`);
  if (notBuilt(res.status)) return { available: false, activities: [] };
  if (!res.ok) throw await toApiError(res, "Could not load activity");
  const data = (await res.json()) as { activities?: ActivityRow[] };
  return { available: true, activities: data.activities ?? [] };
}

/** A contact's custom-field values, joined to their definitions (ADR-0028). `available:false` = not built. */
export interface CustomFieldsFeed {
  available: boolean;
  values: CustomFieldValueDto[];
}

/**
 * GET /custom-fields/values/contact/:id — the contact's custom-field values + definitions (ADR-0028, M8). A
 * 404/501 means the custom-fields backend isn't built yet (`available:false`) so the detail panel renders an
 * EmptyState instead of an error. No fabricated values.
 */
export async function fetchCustomFields(id: string): Promise<CustomFieldsFeed> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/custom-fields/values/contact/${id}`);
  if (notBuilt(res.status)) return { available: false, values: [] };
  if (!res.ok) throw await toApiError(res, "Could not load custom fields");
  const data = (await res.json()) as { values?: CustomFieldValueDto[] };
  return { available: true, values: data.values ?? [] };
}

/**
 * PATCH /custom-fields/values/contact/:id — set custom-field values (shallow-merged, validated by type
 * server-side). Returns the record's full value set. An unbuilt backend (404/501) returns available:false.
 */
export async function setCustomFields(
  id: string,
  values: Record<string, CustomFieldValueInput>,
): Promise<CustomFieldsFeed> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/custom-fields/values/contact/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ values }),
  });
  if (notBuilt(res.status)) return { available: false, values: [] };
  if (!res.ok) throw await toApiError(res, "Could not save custom fields");
  const data = (await res.json()) as { values?: CustomFieldValueDto[] };
  return { available: true, values: data.values ?? [] };
}

/**
 * POST /outreach/enrollments — enroll the selected contacts in a sequence (09 §3.3). The outreach engine
 * gates behind a later milestone, so an unbuilt backend (404/501) returns `{ ok:false }` and the caller is
 * honest about it. Suppression/consent gating runs server-side; the UI never fakes an enroll.
 */
export async function enrollContacts(contactIds: string[]): Promise<{ ok: boolean }> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/outreach/enrollments`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ contactIds }),
  });
  if (notBuilt(res.status)) return { ok: false };
  if (!res.ok) throw await toApiError(res, "Could not enroll");
  return { ok: true };
}
