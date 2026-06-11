// api.ts — the prospect slice's data access: typed, authenticated calls to apps/api for the masked search
// list and THE monetized reveal path (05 §6/§7, 07 §3, 09 §3.2). Reads the in-memory access token via
// fetchWithAuth (ADR-0016); never touches the DB or the auth origin directly. The slice's only seam to the
// backend. Reveal carries an Idempotency-Key so a retried POST never double-charges (07 §3).

import { fetchWithAuth } from "@/lib/authClient";
import { API_BASE } from "@/lib/publicConfig";
import type { MaskedContact, RevealResponse, RevealType } from "@leadwolf/types";

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

/** The masked search/list (05 §6): no PII — emailDomain is the only email facet until reveal. */
export async function fetchContacts(limit = 100): Promise<MaskedContact[]> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/contacts?limit=${limit}`);
  if (!res.ok) throw await toApiError(res, "Could not load contacts");
  const data = (await res.json()) as { contacts: MaskedContact[] };
  return data.contacts;
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
