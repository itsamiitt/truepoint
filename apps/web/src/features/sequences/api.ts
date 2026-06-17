// api.ts — the sequences slice's data access: typed, authenticated calls to the outreach API (ADR-0009)
// plus the masked-contacts list that feeds the enroll picker. Reads the in-memory access token via
// fetchWithAuth (ADR-0016); never touches the DB or the auth origin directly. The slice's only seam to
// the backend. Errors carry the RFC-9457 problem `code` so enroll/send can branch on the failure mode.
//
// The redesign adds: pause/resume on a sequence, a templates list (GET /templates), and the AI draft seam
// (GET /outreach/drafts). The templates + drafts backends are post-MVP (M9) — when they 404/501 the helpers
// return an empty list with `available: false` so the panels render a "connect …" EmptyState instead of an
// error. The existing GET/POST /outreach/sequences contracts are unchanged.

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
  TemplateSummary,
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
export async function setSequenceStatus(
  sequenceId: string,
  status: SequenceStatus,
): Promise<void> {
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

/**
 * GET /templates — the message-template library (M9, panel within Sequences; 11 §4.3). Backend is not
 * wired yet, so a 404/501 resolves to `{ items: [], available: false }` and the panel shows a "connect …"
 * empty state rather than an error.
 */
export async function fetchTemplates(): Promise<MaybeList<TemplateSummary>> {
  const res = await fetchWithAuth(TEMPLATES_BASE);
  if (res.ok) {
    const data = (await res.json()) as { templates: TemplateSummary[] };
    return { items: data.templates ?? [], available: true };
  }
  if (isUnavailable(res.status)) return { items: [], available: false };
  throw await toApiError(res, "Could not load templates");
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
