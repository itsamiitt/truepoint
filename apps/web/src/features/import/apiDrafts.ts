// apiDrafts.ts — thin, typed fetchers for the S-I8 draft verbs (import-redesign 08 §2.3; the S-U7 wizard's
// server seam). Split from apiV2.ts per the 11 §8.2 per-endpoint-fetcher plan (and the 150-line rule). All
// verbs are DARK behind the IMPORT_V2 dual gate: gate-off the per-draft verbs 404 and the draft-create
// dispatch never fires (POST /imports without `mapping` falls through to the legacy 422) — which is why the
// wizard PROBES the gate via the drafts list (404 ⇒ ImportsNotEnabledError ⇒ today's one-shot flow) instead
// of blind-uploading the file. Everything rides fetchWithAuth (in-memory bearer, ADR-0016).

import { fetchWithAuth } from "@/lib/authClient";
import { API_BASE } from "@/lib/publicConfig";
import type {
  ColumnMapping,
  ImportDraftPreviewResponse,
  ImportDraftRef,
  ImportJobListResponse,
  ImportJobRef,
  ImportMergeMode,
  SourceName,
} from "@leadwolf/types";
import { type ImportJobDetail, ImportsNotEnabledError, problemMessage } from "./apiV2";

const IMPORTS_BASE = `${API_BASE}/api/v1/imports`;

/** GET /imports?state=draft — the viewer's live drafts (08 §7's wizard-resume opt-in; drafts are excluded
 *  from the default history read). Doubles as the S-U7 GATE PROBE: a 404 means the IMPORT_V2 dual gate is
 *  off (the list endpoint exists only gate-on — no existence oracle), surfaced as the typed not-enabled
 *  error the drafts hook treats as a terminal, silent answer. */
export async function fetchImportDrafts(limit = 20): Promise<ImportJobListResponse> {
  const params = new URLSearchParams({ state: "draft", limit: String(limit) });
  const res = await fetchWithAuth(`${IMPORTS_BASE}?${params}`);
  if (res.status === 404) throw new ImportsNotEnabledError();
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load your drafts"));
  return (await res.json()) as ImportJobListResponse;
}

/** POST /imports WITHOUT a `mapping` form field — the gate-on upload-once draft-create dispatch (08 §2.3).
 *  Answers the draft ref: jobId + the server-parsed HEADER ROW + the server's auto-map proposal, which the
 *  wizard PREFERS over its own client-side autoMapHeaders (the alias table lives server-side,
 *  packages/core headerAliases.ts). The file is uploaded exactly once — no re-read afterward. */
export async function postImportDraft(args: {
  file: File;
  sourceName: SourceName;
  /** Optional "import into list" target — server-validated against the workspace, never trusted. */
  listId?: string;
}): Promise<ImportDraftRef> {
  const form = new FormData();
  form.set("file", args.file);
  form.set("sourceName", args.sourceName);
  if (args.listId) form.set("listId", args.listId);
  const res = await fetchWithAuth(IMPORTS_BASE, { method: "POST", body: form });
  if (!res.ok) throw new Error(await problemMessage(res, "Could not upload the file"));
  return (await res.json()) as ImportDraftRef;
}

/** PUT /imports/:jobId/mapping — save the draft's mapping document (full replace, naturally idempotent;
 *  08 §3). The wizard PUTs on step-advance (map → preview), not per keystroke — one write per Continue.
 *  `templateId` records provenance when an applied template is still untouched (mapping wins when both
 *  are sent). Strategy fields ride along; absent fields resolve to the workspace policy default. */
export async function putDraftMapping(
  jobId: string,
  body: {
    mapping: ColumnMapping;
    templateId?: string;
    mergeMode?: ImportMergeMode;
    preservePopulated?: boolean;
  },
): Promise<ImportJobDetail> {
  const res = await fetchWithAuth(`${IMPORTS_BASE}/${encodeURIComponent(jobId)}/mapping`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await problemMessage(res, "Could not save the column mapping"));
  return (await res.json()) as ImportJobDetail;
}

/** POST /imports/:jobId/preview — the draft's FULL-PASS projection (08 §4): counts, would-create/update,
 *  in-file duplicates, per-column feedback, typed-code histogram + a bounded (≤50) sample of rejected rows.
 *  Recomputed per call; the non-PII summary also caches on the row (what resume renders). */
export async function postDraftPreview(jobId: string): Promise<ImportDraftPreviewResponse> {
  const res = await fetchWithAuth(`${IMPORTS_BASE}/${encodeURIComponent(jobId)}/preview`, {
    method: "POST",
  });
  if (!res.ok) throw new Error(await problemMessage(res, "Could not validate the file"));
  return (await res.json()) as ImportDraftPreviewResponse;
}

/** POST /imports/:jobId/commit — draft → queued/deferred (08 §2.3). Idempotency-Key REQUIRED: the wizard
 *  mints one uuid per draft (kept in state) so a double-click/retry replays the SAME 202, never a second
 *  import. 202 ⇒ the job ref; the wizard hands off to the durable job page (unchanged S-U3 flow). */
export async function commitDraft(jobId: string, idempotencyKey: string): Promise<ImportJobRef> {
  const res = await fetchWithAuth(`${IMPORTS_BASE}/${encodeURIComponent(jobId)}/commit`, {
    method: "POST",
    headers: { "idempotency-key": idempotencyKey },
  });
  if (!res.ok) throw new Error(await problemMessage(res, "Could not start the import"));
  return (await res.json()) as ImportJobRef;
}
