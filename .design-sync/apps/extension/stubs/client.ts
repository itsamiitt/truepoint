// stubs/client.ts — the extension's message bus to the service worker, replaced by a fixture responder.
//
// The real module (apps/extension/src/shared/client.ts, 20 lines) is the ONLY chrome.* touch point in the
// UI layer: `send` is chrome.runtime.sendMessage and `onBroadcast` is a chrome.runtime.onMessage listener.
// A preview card runs in a plain page with no extension runtime, so `chrome` is undefined and both throw.
//
// Replacing just this seam keeps Panel.tsx and Popup.tsx — the whole 550-line UI — running their real code:
// real state ladder, real reveal flow, real credits pill. Everything else the extension UI imports
// (i18n, env, idb, the zod message schemas) is left alone and runs for real.
//
// The responses below put the panel in its most designed-against state: signed in, a workspace selected,
// credits on hand, one queued item. Broadcasts are never fired — a card should paint one stable frame, not
// animate — but the unsubscribe contract is honored so effects clean up correctly.

import type {
  AppState,
  BroadcastMessage,
  CaptureResponse,
  LookupResponse,
  OrgSummary,
  RequestMessage,
  ResponseFor,
  RevealResponse,
} from "../../../../apps/extension/src/shared/messages.ts";

export const ACCOUNT = "priya.raghavan@northwind.example";

const STATE: AppState = {
  auth: {
    status: "signed_in",
    account: ACCOUNT,
    tenantId: "00000000-0000-4000-8000-000000000101",
    workspaceId: "00000000-0000-4000-8000-000000000201",
    credits: 248,
  },
  queueDepth: 1,
};

/** The database-hit rung of the lookup ladder: TruePoint holds this person, this workspace does not yet. */
const LOOKUP: LookupResponse = {
  status: {
    contactId: "ct_01hq8m4pv7",
    known: true,
    owned: false,
    outcome: "in_database",
    lastUpdatedAt: "2026-08-11T10:22:00Z",
  },
};

const CAPTURE: CaptureResponse = {
  status: { contactId: "ct_01hq8m4pv7", known: true, owned: true, outcome: "saved", lastUpdatedAt: "2026-08-18T09:14:22Z" },
};

/** A successful email reveal carrying the S-10 confidence badge (last verified + source count). */
const REVEAL: RevealResponse = {
  ok: true,
  revealType: "email",
  email: "p.raghavan@northwind.example",
  verification: { lastVerifiedAt: "2026-08-04T08:00:00Z", sourceCount: 3, sourceDiversity: 2 },
};

const ORGS: OrgSummary[] = [
  { tenantId: "00000000-0000-4000-8000-000000000101", tenantName: "Northwind Logistics", isTenantOwner: true },
  { tenantId: "00000000-0000-4000-8000-000000000102", tenantName: "Halcyon MedTech", isTenantOwner: false },
];

export async function send<M extends RequestMessage>(msg: M): Promise<ResponseFor<M["type"]>> {
  const by: Record<string, unknown> = {
    PING: { pong: true },
    GET_STATE: STATE,
    LOOKUP,
    CAPTURE,
    ADD_FROM_DATABASE: CAPTURE,
    REVEAL,
    LIST_ORGS: { orgs: ORGS },
  };
  return (by[msg.type] ?? { ok: true }) as ResponseFor<M["type"]>;
}

export function onBroadcast(_handler: (msg: BroadcastMessage) => void): () => void {
  // No broadcast is fired: a preview card should paint one stable frame. The unsubscribe is still real so
  // the components' cleanup effects behave exactly as they do in the extension.
  return () => {};
}
