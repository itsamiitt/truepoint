// mergeApi.ts — the contact TRUE-MERGE customer verbs for the S-U8 duplicate-review upgrade (import-and-data-
// model-redesign 11 §5.2 / 04 §API). Thin typed fetchers over the merge PREVIEW (GET /contacts/:id/merge-preview)
// and the merge VERB (POST /contacts/:id/merge). Both are DUAL-GATED 404-off (04 §3.1): a 404 = "merging isn't
// enabled for this workspace" (never an existence oracle) → the typed MergeNotEnabledError the UI treats as an
// honest disabled state — hiding the Merge affordance, keeping dismiss-only (the apiV2 ImportsNotEnabledError
// precedent). This slice's only seam to the merge backend; the merge is IRREVERSIBLE + Idempotency-Key'd (04 §3.6).
"use client";

import { fetchWithAuth } from "@/lib/authClient";
import { API_BASE } from "@/lib/publicConfig";
import type { MergeFieldDecision, MergePreview, MergeResult } from "@leadwolf/types";
import { mergePreviewSchema, mergeResultSchema } from "@leadwolf/types";

// The pure decision logic lives in its own module (unit-tested without the transport seam); re-exported here so
// the review drawer imports both from one place.
export { type FieldPick, buildMergeDecisions } from "./mergeDecisions";

const CONTACTS_BASE = `${API_BASE}/api/v1/contacts`;

/** A 404 from the merge verbs = the CONTACT_MERGE dual gate is dark for this workspace (04 §3.1) — the feature
 *  does not exist here. The UI treats this typed error as a "not enabled" state (hide Merge, keep dismiss-only),
 *  never a failure banner — the apiV2 `ImportsNotEnabledError` precedent (S-U2). */
export class MergeNotEnabledError extends Error {
  readonly notEnabled = true as const;
  constructor(message = "Merging duplicates isn’t enabled for your workspace yet.") {
    super(message);
    this.name = "MergeNotEnabledError";
  }
}

/** RFC-9457 problem body → a human message (mirrors the data-health api.ts / apiV2 seam). */
async function problemMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { detail?: string; title?: string } | null;
  return body?.detail ?? body?.title ?? `${fallback} (${res.status})`;
}

/** GET /contacts/:survivorId/merge-preview?loser=<loserId> — the side-by-side field matrix + child-impact
 *  counts (04 §6). Non-PII masked scalars only. 404 ⇒ MergeNotEnabledError (dual gate dark). */
export async function fetchMergePreview(survivorId: string, loserId: string): Promise<MergePreview> {
  const res = await fetchWithAuth(
    `${CONTACTS_BASE}/${encodeURIComponent(survivorId)}/merge-preview?loser=${encodeURIComponent(loserId)}`,
  );
  if (res.status === 404) throw new MergeNotEnabledError();
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load the merge preview"));
  return mergePreviewSchema.parse(await res.json());
}

/** POST /contacts/:survivorId/merge — execute the IRREVERSIBLE true merge (survivor = :id; body = loser +
 *  the per-field decisions). A FRESH Idempotency-Key per confirmed pair makes a double-submit a safe replay
 *  (04 §3.6). 404 ⇒ MergeNotEnabledError; 409/429 (already-merged / daily-cap) surface the RFC-9457 detail. */
export async function mergeContacts(
  survivorId: string,
  body: { loserContactId: string; decisions: MergeFieldDecision[] },
): Promise<MergeResult> {
  const res = await fetchWithAuth(`${CONTACTS_BASE}/${encodeURIComponent(survivorId)}/merge`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify(body),
  });
  if (res.status === 404) throw new MergeNotEnabledError();
  if (!res.ok) throw new Error(await problemMessage(res, "Could not merge these contacts"));
  return mergeResultSchema.parse(await res.json());
}
