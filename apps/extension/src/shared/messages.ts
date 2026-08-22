// Typed, Zod-validated message contracts between contexts (content script / UI ⇄ service worker).
// Every inbound message is parsed with `requestMessage` before handling (03 §1.8: validate senders +
// schema, drop unknowns). Responses are strongly typed per request via `ResponseFor`.
import type { ProfileIntelResponse, RevealedContact } from "@leadwolf/types";
import { z } from "zod";
import type { ViewedSubject } from "./linkedinUrl.ts";
import {
  type ErrorClass,
  type RevealCosts,
  type RevealType,
  capturedLink,
  capturedRecord,
  revealType,
  type subjectStatus,
} from "./types.ts";

export const requestMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("PING") }),
  z.object({ type: z.literal("GET_STATE") }),
  z.object({
    type: z.literal("LOOKUP"),
    subjectKey: z.string().min(1),
    sourceUrl: z.string().url(),
  }),
  z.object({ type: z.literal("CAPTURE"), record: capturedRecord }),
  // Sales-Nav URL harvest (docs/planning ecosystem): a batch of visible links from a search/list page.
  z.object({
    type: z.literal("LINKS_CAPTURED"),
    links: z.array(capturedLink).min(1).max(200),
    sourceUrl: z.string().url(),
  }),
  // Fetch-on-view: the rep opened a profile/company page; ensure the licensed document is fresh.
  z.object({
    type: z.literal("VIEW_FETCH"),
    entityKind: z.enum(["person", "company"]),
    url: z.string().url(),
  }),
  // The database-hit save (Layer-0-as-database): materialize the person the platform already holds —
  // never a DOM capture. The URL is the addressing key; the server canonicalizes.
  z.object({ type: z.literal("ADD_FROM_DATABASE"), url: z.string().url() }),
  z.object({ type: z.literal("REVEAL"), contactId: z.string().min(1), revealType }),
  // ── Profile Intelligence Panel (chrome-extension/14 X06 remainder) ──────────────────────────────────
  // Which subject is on screen RIGHT NOW. The panel is not a content script: it has no DOM, it can be
  // opened long after a page loaded, and it must follow the user across tabs — so it cannot wait for the
  // content script's LOOKUP broadcast to learn what to render (the hydrate-on-open gap, Panel.tsx). The SW
  // answers from the active tab's URL alone.
  z.object({ type: z.literal("GET_SUBJECT") }),
  // The panel's ONE read: the whole masked profile + company for a viewed page. `force` is the panel's
  // re-capture control — it drops the warm entry and re-asks the server rather than serving the cache.
  z.object({
    type: z.literal("INTEL"),
    subjectKey: z.string().min(1),
    sourceUrl: z.string().url(),
    force: z.boolean().optional(),
  }),
  // Save from the panel. The panel cannot read the page, so the SW asks the active tab's content script to
  // extract the visible header and enqueues it — the same user-initiated capture path the hover card uses,
  // triggered by a different button (hard constraint 4: an explicit gesture, on the page the user opened).
  z.object({ type: z.literal("CAPTURE_CURRENT") }),
  // Add-to-list, the panel footer's second action (C-01).
  z.object({ type: z.literal("LIST_LISTS") }),
  z.object({
    type: z.literal("ADD_TO_LIST"),
    listId: z.string().min(1),
    contactId: z.string().min(1),
  }),
  z.object({ type: z.literal("AUTH_LOGIN") }),
  z.object({ type: z.literal("AUTH_LOGOUT") }),
  z.object({ type: z.literal("SWITCH_WORKSPACE"), workspaceId: z.string().uuid() }),
  z.object({ type: z.literal("SWITCH_ORG"), tenantId: z.string().uuid() }),
  z.object({ type: z.literal("LIST_ORGS") }),
  z.object({ type: z.literal("OPEN_PANEL") }),
]);
export type RequestMessage = z.infer<typeof requestMessage>;
export type RequestType = RequestMessage["type"];

/** Non-PII account display, fetched from GET /auth/me (the JWT carries no name/email). */
export interface AccountDisplay {
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
  workspaceName: string | null;
}

export interface OrgSummary {
  tenantId: string;
  tenantName: string;
  isTenantOwner: boolean;
}

export interface AuthState {
  status: "signed_in" | "signed_out";
  /** Display label (email/name from GET /auth/me), or null before it resolves. */
  account: string | null;
  tenantId: string | null;
  workspaceId: string | null;
  credits: number | null;
}

export interface AppState {
  auth: AuthState;
  queueDepth: number;
}

export interface LookupResponse {
  status: z.infer<typeof subjectStatus>;
}

export interface CaptureResponse {
  status: z.infer<typeof subjectStatus>;
}

export interface RevealResponse {
  ok: boolean;
  revealType: RevealType;
  email?: string;
  phone?: string;
  errorClass?: ErrorClass;
  message?: string;
  /**
   * Confidence badge v0 (06-roadmap Phase 1; outcome S-10): "last verified ⟨n⟩ days ago · ⟨k⟩ sources",
   * shown in the app AND the extension. Optional so an older service worker or server simply omits it.
   *
   * `sourceCount: null` means we hold no evidence log for this record — NOT that no source vouched for it.
   * The panel omits the source clause on null rather than rendering "0 sources", which would put a
   * misleading confidence signal on every record until the provenance gate is on.
   */
  verification?: {
    lastVerifiedAt: string | null;
    sourceCount: number | null;
    sourceDiversity: number | null;
  };
  /** Every asked-for field is missing: the record exposed nothing and owned nothing (S-12). Distinct from a
   *  free re-reveal, which the panel must not describe as "nothing on file". */
  nothingToReveal?: boolean;
}

/** Maps a request `type` to its response shape, so `bus.send()` is fully typed. */
export type ResponseFor<T extends RequestType> = T extends "PING"
  ? { pong: true }
  : T extends "GET_STATE"
    ? AppState
    : T extends "LOOKUP"
      ? LookupResponse
      : T extends "CAPTURE" | "ADD_FROM_DATABASE"
        ? CaptureResponse
        : T extends "REVEAL"
          ? RevealResponse
          : T extends "AUTH_LOGIN" | "AUTH_LOGOUT" | "SWITCH_WORKSPACE" | "SWITCH_ORG"
            ? AuthState
            : T extends "LIST_ORGS"
              ? { orgs: OrgSummary[]; activeTenantId: string | null }
              : T extends "OPEN_PANEL"
                ? { ok: boolean }
                : T extends "LINKS_CAPTURED"
                  ? { registered: number; dropped: number }
                  : T extends "VIEW_FETCH"
                    ? { outcome: string; contactId: string | null }
                    : T extends "GET_SUBJECT"
                      ? { subject: ViewedSubject | null }
                      : T extends "INTEL"
                        ? IntelResponse
                        : T extends "CAPTURE_CURRENT"
                          ? CaptureResponse
                          : T extends "LIST_LISTS"
                            ? { lists: ListSummary[] }
                            : T extends "ADD_TO_LIST"
                              ? { ok: boolean; affected?: number; errorClass?: ErrorClass }
                              : never;

/** One workspace list, trimmed to what the picker renders (id + name + size). Never its members. */
export interface ListSummary {
  id: string;
  name: string;
  memberCount: number;
}

/**
 * Everything the Profile Intelligence Panel renders for one subject, in one message.
 *
 * `intel` is the server's masked aggregate; `costs` and `revealed` ride along because the SW already holds
 * or can cheaply fetch them and a panel that had to ask separately would render its price labels and its
 * owned values a beat late. `revealed` is the NO-CHARGE read of values this workspace already owns
 * (ADR-0042) — present only for an owned contact, and never persisted anywhere by the client.
 */
export interface IntelPayload {
  intel: ProfileIntelResponse;
  costs: RevealCosts | null;
  revealed: RevealedContact | null;
  fetchedAt: number;
}

export type IntelResponse =
  | { ok: true; payload: IntelPayload }
  | { ok: false; errorClass: ErrorClass; message?: string };

/** SW → surfaces broadcasts (state fan-out; no request/response). */
export type BroadcastMessage =
  | { type: "STATE_CHANGED"; state: AppState }
  | { type: "SUBJECT_STATUS"; subjectKey: string; status: z.infer<typeof subjectStatus> }
  // The user navigated (or switched tabs) to a page the extension recognises. Lets the panel follow along
  // without polling: it re-reads for the new subject and drops what it was showing.
  | { type: "SUBJECT_VIEWED"; subject: ViewedSubject | null };

/** Narrow a request by type without re-parsing (after `requestMessage.parse`). */
export function isRequestType<T extends RequestType>(
  msg: RequestMessage,
  type: T,
): msg is Extract<RequestMessage, { type: T }> {
  return msg.type === type;
}
