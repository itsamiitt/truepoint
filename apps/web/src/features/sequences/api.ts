// api.ts — the sequences slice's data access: typed, authenticated calls to the outreach API (ADR-0009)
// plus the masked-contacts list that feeds the enroll picker. Reads the in-memory access token via
// fetchWithAuth (ADR-0016); never touches the DB or the auth origin directly. The slice's only seam to
// the backend. Errors carry the RFC-9457 problem `code` so enroll/send can branch on the failure mode.
//
// The redesign adds: pause/resume on a sequence, the templates editor (GET/POST/PATCH /templates + versions/
// preview/restore — M12 P2, LIVE), and the AI draft seam (GET /outreach/drafts, still post-MVP). The drafts
// helper returns `available: false` on a 404/501 so its panel renders a "connect …" EmptyState instead of an
// error; templates degrade the same way for an older deploy. The GET/POST /outreach/sequences contracts are
// unchanged.

import { fetchWithAuth } from "@/lib/authClient";
import { API_BASE } from "@/lib/publicConfig";
import type { MaskedContact } from "@leadwolf/types";
import type {
  DraftSummary,
  EnrollResult,
  EnrollmentEntry,
  NewSequenceInput,
  NewStepInput,
  SendResult,
  SequenceStatus,
  SequenceSummary,
  TemplateDetail,
  TemplatePreview,
  TemplateStatus,
  TemplateSummary,
  TemplateVersion,
} from "./types";

const OUTREACH_BASE = `${API_BASE}/api/v1/outreach`;
const TEMPLATES_BASE = `${API_BASE}/api/v1/templates`;

/**
 * A backend error mapped to its RFC-9457 Problem Details (09 §6). Carries the stable machine `code`
 * ("suppressed" 403, "validation_error" 422, "not_found") + status so the UI can branch on the failure
 * mode while surfacing the server's message verbatim.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

/** Parse a non-OK response's Problem Details into an ApiError (mirrors the prospect slice's helper). */
async function toApiError(res: Response, fallback: string): Promise<ApiError> {
  const body = (await res.json().catch(() => null)) as {
    detail?: string;
    title?: string;
    code?: string;
  } | null;
  const message = body?.detail ?? body?.title ?? `${fallback} (${res.status})`;
  return new ApiError(message, res.status, body?.code ?? "error");
}

/** A status that means the endpoint isn't wired yet (404 not_found / 501 not_implemented). */
function isUnavailable(status: number): boolean {
  return status === 404 || status === 501;
}

/** A list payload + whether the backend exists yet (false → the panel shows a "connect …" empty state). */
export interface MaybeList<T> {
  items: T[];
  available: boolean;
}

/** GET /outreach/sequences — the workspace's sequences for the list view. */
export async function fetchSequences(): Promise<SequenceSummary[]> {
  const res = await fetchWithAuth(`${OUTREACH_BASE}/sequences`);
  if (!res.ok) throw await toApiError(res, "Could not load sequences");
  const data = (await res.json()) as { sequences: SequenceSummary[] };
  return data.sequences;
}

/** POST /outreach/sequences — create a sequence shell (201 → its id). */
export async function createSequence(input: NewSequenceInput): Promise<string> {
  const res = await fetchWithAuth(`${OUTREACH_BASE}/sequences`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await toApiError(res, "Could not create sequence");
  const data = (await res.json()) as { id: string };
  return data.id;
}

/** PATCH /outreach/sequences/:id — flip a sequence's status (pause ⇄ resume). */
export async function setSequenceStatus(sequenceId: string, status: SequenceStatus): Promise<void> {
  const res = await fetchWithAuth(`${OUTREACH_BASE}/sequences/${sequenceId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status }),
  });
  if (!res.ok) throw await toApiError(res, "Could not update the sequence");
}

/** POST /outreach/sequences/:id/steps — append a step (201 → id + stepOrder). */
export async function addSequenceStep(
  sequenceId: string,
  input: NewStepInput,
): Promise<{ id: string; stepOrder: number }> {
  const res = await fetchWithAuth(`${OUTREACH_BASE}/sequences/${sequenceId}/steps`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await toApiError(res, "Could not add step");
  return (await res.json()) as { id: string; stepOrder: number };
}

/** POST /outreach/sequences/:id/enroll — 403 "suppressed" (DNC), 422 "validation_error" (e.g. unrevealed). */
export async function enrollContact(sequenceId: string, contactId: string): Promise<EnrollResult> {
  const res = await fetchWithAuth(`${OUTREACH_BASE}/sequences/${sequenceId}/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ contact_id: contactId }),
  });
  if (!res.ok) throw await toApiError(res, "Could not enroll contact");
  return (await res.json()) as EnrollResult;
}

/** GET /outreach/sequences/:id/log — the enrollment log for the detail panel. */
export async function fetchEnrollmentLog(sequenceId: string): Promise<EnrollmentEntry[]> {
  const res = await fetchWithAuth(`${OUTREACH_BASE}/sequences/${sequenceId}/log`);
  if (!res.ok) throw await toApiError(res, "Could not load the enrollment log");
  const data = (await res.json()) as { entries: EnrollmentEntry[] };
  return data.entries;
}

/** POST /outreach/log/:id/send — send the enrollment's next step (the CAN-SPAM 422 surfaces verbatim). */
export async function sendNextStep(logId: string): Promise<SendResult> {
  const res = await fetchWithAuth(`${OUTREACH_BASE}/log/${logId}/send`, { method: "POST" });
  if (!res.ok) throw await toApiError(res, "Send failed");
  return (await res.json()) as SendResult;
}

/** GET /contacts — masked rows for the enroll picker (only isRevealed rows are enrollable). */
export async function fetchContacts(limit = 100): Promise<MaskedContact[]> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/contacts?limit=${limit}`);
  if (!res.ok) throw await toApiError(res, "Could not load contacts");
  const data = (await res.json()) as { contacts: MaskedContact[] };
  return data.contacts;
}

/** A page of the template library + whether the backend exists yet + the opaque keyset cursor for the next page. */
export interface TemplatePage extends MaybeList<TemplateSummary> {
  nextCursor: string | null;
}

/**
 * GET /templates — the owner-scoped template library (M12 P2, 11 §4.3), keyset-paginated. The backend is
 * live; a 404/501 (older deploy) still resolves to `available: false` so the panel degrades gracefully rather
 * than erroring. Pass the prior page's `nextCursor` to fetch the next page.
 */
export async function fetchTemplates(
  opts: { cursor?: string; status?: TemplateStatus } = {},
): Promise<TemplatePage> {
  const params = new URLSearchParams();
  if (opts.cursor) params.set("cursor", opts.cursor);
  if (opts.status && opts.status !== "active") params.set("status", opts.status);
  const qs = params.toString();
  const res = await fetchWithAuth(qs ? `${TEMPLATES_BASE}?${qs}` : TEMPLATES_BASE);
  if (res.ok) {
    const data = (await res.json()) as {
      templates: TemplateSummary[];
      nextCursor: string | null;
    };
    return { items: data.templates ?? [], available: true, nextCursor: data.nextCursor ?? null };
  }
  if (isUnavailable(res.status)) return { items: [], available: false, nextCursor: null };
  throw await toApiError(res, "Could not load templates");
}

/** GET /templates/:id — one template's full editor view (owner-or-shared; 404 if not visible). */
export async function fetchTemplateDetail(id: string): Promise<TemplateDetail> {
  const res = await fetchWithAuth(`${TEMPLATES_BASE}/${id}`);
  if (!res.ok) throw await toApiError(res, "Could not load the template");
  return (await res.json()) as TemplateDetail;
}

/** GET /templates/:id/versions — the template's immutable version history (newest first). */
export async function fetchTemplateVersions(id: string): Promise<TemplateVersion[]> {
  const res = await fetchWithAuth(`${TEMPLATES_BASE}/${id}/versions`);
  if (!res.ok) throw await toApiError(res, "Could not load version history");
  const data = (await res.json()) as { versions: TemplateVersion[] };
  return data.versions;
}

/** Create a reusable, versioned template (M12 P2). The created template is owner-scoped (D8). */
export async function createTemplate(input: {
  name: string;
  subject?: string | null;
  body: string;
  channel?: "email" | "linkedin";
  shared?: boolean;
}): Promise<{ id: string }> {
  const res = await fetchWithAuth(TEMPLATES_BASE, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await toApiError(res, "Could not create the template");
  return (await res.json()) as { id: string };
}

/**
 * PATCH /templates/:id — owner-only (D8). A content change (subject+body together) appends an immutable
 * version; name/shared/status are metadata. Send only the changed fields.
 */
export async function updateTemplate(
  id: string,
  patch: {
    subject?: string | null;
    body?: string;
    name?: string;
    shared?: boolean;
    status?: TemplateStatus;
  },
): Promise<{ version: number | null }> {
  const res = await fetchWithAuth(`${TEMPLATES_BASE}/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw await toApiError(res, "Could not save the template");
  return (await res.json()) as { version: number | null };
}

/**
 * POST /templates/:id/preview — render the saved content (or an unsaved draft) with sample merge data. The
 * render is server-side + safe; this is read-only.
 */
export async function previewTemplate(
  id: string,
  draft?: { subject?: string | null; body?: string; sample?: Record<string, string> },
): Promise<TemplatePreview> {
  const res = await fetchWithAuth(`${TEMPLATES_BASE}/${id}/preview`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(draft ?? {}),
  });
  if (!res.ok) throw await toApiError(res, "Could not preview the template");
  return (await res.json()) as TemplatePreview;
}

/** POST /templates/:id/restore — owner-only (D8): append a new version cloning version N. */
export async function restoreTemplateVersion(
  id: string,
  version: number,
): Promise<{ version: number }> {
  const res = await fetchWithAuth(`${TEMPLATES_BASE}/${id}/restore`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ version }),
  });
  if (!res.ok) throw await toApiError(res, "Could not restore that version");
  return (await res.json()) as { version: number };
}

/**
 * GET /outreach/drafts — AI/manual drafts awaiting human review (draft → review → send; 05 §13/§16).
 * Backend is post-MVP; a 404/501 resolves to `available: false` so the panel gates on "review required"
 * without inventing drafts. There is intentionally NO send call here — sending stays human-reviewed.
 */
export async function fetchDrafts(): Promise<MaybeList<DraftSummary>> {
  const res = await fetchWithAuth(`${OUTREACH_BASE}/drafts`);
  if (res.ok) {
    const data = (await res.json()) as { drafts: DraftSummary[] };
    return { items: data.drafts ?? [], available: true };
  }
  if (isUnavailable(res.status)) return { items: [], available: false };
  throw await toApiError(res, "Could not load drafts");
}
