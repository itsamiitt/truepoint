// api.ts — the prospect slice's data access: typed, authenticated calls to apps/api for the masked search
// list and THE monetized reveal path (05 §6/§7, 07 §3, 09 §3.2). Reads the in-memory access token via
// fetchWithAuth (ADR-0016); never touches the DB or the auth origin directly. The slice's only seam to the
// backend. Reveal carries an Idempotency-Key so a retried POST never double-charges (07 §3).

import { fetchWithAuth } from "@/lib/authClient";
import { API_BASE } from "@/lib/publicConfig";
import type {
  ActivityRow,
  CustomFieldValueDto,
  CustomFieldValueInput,
  MaskedContact,
  RevealResponse,
  RevealType,
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
async function toApiError(res: Response, fallback: string): Promise<ApiError> {
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
 * POST /lists/:id/members — add the selected contacts to a list (09 §3). Lists are a later milestone, so an
 * unbuilt backend (404/501) returns `{ ok:false }` and the caller surfaces an honest "not available yet"
 * toast rather than faking the add. No fabricated mutation.
 */
export async function addContactsToList(
  listId: string,
  contactIds: string[],
): Promise<{ ok: boolean }> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/lists/${listId}/members`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ contactIds }),
  });
  if (notBuilt(res.status)) return { ok: false };
  if (!res.ok) throw await toApiError(res, "Could not add to list");
  return { ok: true };
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
