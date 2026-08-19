// stubs/authClient.ts — the app-domain token client, replaced by a fixture-backed router.
//
// This is the ONLY seam between the prospect slice and the network. The real module does PKCE + silent
// refresh against the auth origin; here `getAccessToken` hands back a well-formed unsigned JWT (the slice
// decodes its `sub` claim for the "Assign to me" action — see bulkResourcesApi.currentUserId) and
// `fetchWithAuth` answers from ../fixtures instead of hitting the wire.
//
// The router is deliberately more than a constant: it applies the query's term/bool/text filters and pages
// with a real cursor, so a preview card behaves like the surface does — clicking a facet narrows the grid,
// "Load more" appends the next page. Anything unmapped falls through to EMPTY_OK, an envelope carrying
// every collection key the slice destructures, so a route nobody fixtured renders an empty state rather
// than throwing.

import type { ContactHit } from "@leadwolf/types";
import * as F from "../fixtures";
import * as W from "../fixtures-web";

// ── token ───────────────────────────────────────────────────────────────────────────────────────────────
const b64url = (o: unknown) =>
  btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// Not a credential: an unsigned, expired-proof stand-in whose only consumer is the client-side `sub` decode.
const FAKE_JWT = `${b64url({ alg: "none", typ: "JWT" })}.${b64url({
  sub: F.USER_ID,
  wid: "00000000-0000-4000-8000-000000000999",
  exp: 4102444800,
})}.`;

export function getAccessToken(): string | null {
  return FAKE_JWT;
}

export function clearAccessToken(): void {}

export const RECOVERY_KEY = "lw_auth_recovery";

export type RecoveryAction = "restart" | "retry" | "fail";
export function recoveryActionFor(): RecoveryAction {
  return "fail";
}

export async function silentRefresh(): Promise<boolean> {
  return true;
}

// ── response helpers ────────────────────────────────────────────────────────────────────────────────────
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Every collection key the slice reads, so an unmapped route degrades to "empty", never to a crash. */
/**
 * Every collection key the app destructures, so an unmapped route degrades to "empty", never to a crash.
 *
 * This list is not decoration: a MISSING key is `undefined`, and the very next line in the caller is almost
 * always `.length` or `.map` — CompliancePage died exactly that way on `entries` when the wider app slice
 * landed. Harvested from every `as { x: ... }` unwrap across apps/web/src/features. Add to it whenever a
 * new surface reads a new key; there is no cost to an unused one.
 */
const EMPTY_OK = {
  ok: true, status: "ok", total: 0, count: 0, affected: 0, balance: 0, nextCursor: null,
  queued: 0, version: 1, id: null, listId: null, downloadUrl: null, checkoutUrl: null, portalUrl: null,
  clientId: null, secret: null, signingSecret: null, responseCode: null, plan: null, subscription: null,
  // collections
  hits: [], accounts: [], contacts: [], facets: [], suggestions: [], tags: [], lists: [],
  stages: [], searches: [], sequences: [], activities: [], values: [], scores: [],
  recordIds: [], revealed: [], history: [], items: [], results: [], enrollments: [],
  entries: [], announcements: [], apps: [], conflicts: [], connections: [], definitions: [],
  deliveries: [], domains: [], drafts: [], events: [], keys: [], links: [], mailboxes: [],
  mappings: [], members: [], packs: [], pairs: [], plans: [], runs: [], sessions: [],
  streams: [], tasks: [], teams: [], templates: [], threads: [], tokens: [], versions: [],
  webhooks: [], workspaces: [], reveals: [], jobs: [], rows: [], notifications: [], widgets: [],
  snapshots: [], fields: [], providers: [], invoices: [], usage: [], policies: [], reports: [],
};

// ── query application ───────────────────────────────────────────────────────────────────────────────────
interface TermClause { kind: "term"; field: string; op?: string; values: string[] }
interface BoolClause { kind: "bool"; field: string; value: boolean }
type Clause = TermClause | BoolClause | { kind: "range"; field: string; gte?: number; lte?: number };

const CONTACT_FIELD: Record<string, (c: ContactHit) => string | null> = {
  seniority: (c) => c.seniorityLevel,
  department: (c) => c.department,
  email_status: (c) => c.emailStatus,
  outreach_status: (c) => c.outreachStatus,
  location: (c) => c.locationCountry,
  company: (c) => c.emailDomain,
  owner: (c) => c.ownerUserId,
};

function matches(c: ContactHit, clauses: Clause[]): boolean {
  for (const cl of clauses) {
    if (cl.kind === "term") {
      const read = CONTACT_FIELD[cl.field];
      if (!read) continue; // a facet this fixture doesn't model — don't filter everything away
      const v = read(c);
      const hit = v !== null && cl.values.includes(v);
      if (cl.op === "exclude" ? hit : !hit) return false;
    } else if (cl.kind === "bool") {
      const v =
        cl.field === "has_email" ? c.hasEmail
        : cl.field === "has_phone" ? c.hasPhone
        : cl.field === "is_revealed" ? c.isRevealed
        : cl.field === "never_contacted" ? c.outreachStatus === "new"
        : null;
      if (v !== null && v !== cl.value) return false;
    }
  }
  return true;
}

function searchContacts(body: { text?: string; filters?: Clause[]; cursor?: string; limit?: number }) {
  const text = (body.text ?? "").trim().toLowerCase();
  let rows = F.CONTACTS.filter((c) => matches(c, body.filters ?? []));
  if (text) {
    rows = rows.filter((c) =>
      [c.firstName, c.lastName, c.jobTitle, c.department, c.emailDomain]
        .filter(Boolean).join(" ").toLowerCase().includes(text),
    );
  }
  const limit = Math.min(body.limit ?? 25, 200);
  const start = body.cursor ? Number.parseInt(body.cursor, 10) || 0 : 0;
  const page = rows.slice(start, start + limit);
  const next = start + limit < rows.length ? String(start + limit) : null;
  return { hits: page, nextCursor: next, facets: F.CONTACT_FACETS };
}

// ── router ──────────────────────────────────────────────────────────────────────────────────────────────
export async function fetchWithAuth(input: string, init: RequestInit = {}): Promise<Response> {
  const url = new URL(input, "https://app.truepoint.in");
  const path = url.pathname.replace(/^\/api\/v1/, "");
  const method = (init.method ?? "GET").toUpperCase();
  const body = (() => {
    try { return init.body ? JSON.parse(String(init.body)) : {}; } catch { return {}; }
  })();
  const seg = path.split("/").filter(Boolean);

  // ── contact search
  if (path === "/search/contacts") return json(searchContacts(body));
  if (path === "/search/facets") return json({ facets: F.CONTACT_FACETS });
  if (path === "/search/count") return json({ total: F.TOTAL_CONTACTS });
  if (path === "/search/suggest") {
    const prefix = (url.searchParams.get("prefix") ?? "").toLowerCase();
    return json({
      suggestions: F.SUGGESTIONS.filter((s) => s.displayLabel.toLowerCase().includes(prefix)),
    });
  }
  if (path === "/ai-search") return json(F.AI_SEARCH_RESPONSE);

  // ── account search
  if (path === "/account-search/search") {
    const limit = Math.min(body.limit ?? 25, 200);
    const start = body.cursor ? Number.parseInt(body.cursor, 10) || 0 : 0;
    const page = F.ACCOUNTS.slice(start, start + limit);
    return json({ accounts: page, nextCursor: start + limit < F.ACCOUNTS.length ? String(start + limit) : null });
  }
  if (path === "/account-search/facets") return json({ facets: F.ACCOUNT_FACETS });
  if (path === "/account-search/count") return json({ total: F.TOTAL_ACCOUNTS });
  if (path === "/account-search/suggest") {
    const prefix = (url.searchParams.get("prefix") ?? "").toLowerCase();
    return json({
      suggestions: F.ACCOUNT_FACETS
        .filter((f) => f.displayLabel.toLowerCase().includes(prefix))
        .map((f) => ({ value: f.value, displayLabel: f.displayLabel, count: f.count })),
    });
  }

  // ── tags
  if (path === "/tags" && method === "GET") return json({ tags: F.TAGS });
  if (path === "/tags" && method === "POST")
    return json({ id: "00000000-0000-4000-8000-000000000399" }, 201);
  if (seg[0] === "tags" && seg[2] === "records") return json({ recordIds: F.CONTACTS.slice(0, 8).map((c) => c.id) });
  if (seg[0] === "tags" && seg[1] === "records")
    return json({ tags: F.TAGS.slice(0, 2).map(({ id, name, color }) => ({ id, name, color })) });
  if (seg[0] === "tags" && (seg[2] === "assign" || seg[2] === "unassign")) return json({ ok: true, status: "ok" });

  // ── saved searches
  if (path === "/saved-searches" && method === "GET") return json({ searches: F.SAVED_SEARCHES });
  if (path === "/saved-searches" && method === "POST") return json(F.SAVED_SEARCHES[0], 201);
  if (seg[0] === "saved-searches" && method === "DELETE") return new Response(null, { status: 204 });
  if (seg[0] === "saved-searches") return json(F.SAVED_SEARCHES[0]);

  // ── pipeline stages
  if (path === "/pipeline-stages" && method === "GET") return json({ stages: F.STAGES });
  if (path === "/pipeline-stages" && method === "POST") return json(F.STAGES[0], 201);
  if (seg[0] === "pipeline-stages" && seg[1] === "contacts")
    return json({ contactId: F.CONTACTS[0].id, stageId: F.STAGES[2].id, outreachStatus: "replied" });
  if (seg[0] === "pipeline-stages" && method === "DELETE") return new Response(null, { status: 204 });
  if (seg[0] === "pipeline-stages") return json(F.STAGES[0]);

  // ── billing
  if (path === "/credits/balance") return json({ balance: F.CREDIT_BALANCE });
  if (path === "/credits/reveal-costs") return json(F.REVEAL_COSTS);

  // ── reveal
  if (path === "/contacts/revealed/batch") {
    const ids: string[] = body.contactIds ?? body.ids ?? [];
    const want = new Set(ids);
    return json({ revealed: F.REVEALED.filter((r) => want.size === 0 || want.has(r.contactId)) });
  }
  if (seg[0] === "contacts" && seg[2] === "revealed") {
    const hit = F.REVEALED.find((r) => r.contactId === seg[1]);
    return hit ? json(hit) : json({ detail: "Not revealed", code: "not_revealed" }, 404);
  }
  if (seg[0] === "contacts" && seg[2] === "reveal")
    return json(F.REVEALED[0] ?? EMPTY_OK, 201);
  if (seg[0] === "contacts" && seg[2] === "activities") return json({ activities: F.ACTIVITIES });
  if (seg[0] === "contacts" && seg[2] === "scores") return json({ scores: F.SCORES });
  if (seg[0] === "contacts" && seg[2] === "rescore") return json({ ...F.SCORES[0], recomputed: true });
  // Only the VALUES route belongs to the prospect slice; the bare /custom-fields collection is the settings
  // panel's DEFINITIONS list and is answered further down. Matching the prefix here emptied that panel.
  if (seg[0] === "custom-fields" && seg[1] === "values") return json({ values: F.CUSTOM_FIELDS });

  // ── bulk
  if (path === "/contacts/bulk/estimate") {
    // BulkSpendEstimate. Resolve the selection the way the server does — from the envelope, not a constant
    // — so a 1-row estimate and a 200-row estimate actually differ. Matchable resolves for free; only the
    // residual can spend.
    const action = body.action === "enrich" ? "enrich" : "reveal";
    const selectionCount: number = Array.isArray(body.contactIds) ? body.contactIds.length : F.TOTAL_CONTACTS;
    const matchableCount = Math.floor(selectionCount * 0.25);
    const billableCount = selectionCount - matchableCount;
    const projectedMaxCredits = billableCount * (action === "enrich" ? 2 : 1);
    return json({
      action,
      selectionCount,
      matchableCount,
      billableCount,
      projectedMaxCredits,
      balance: F.CREDIT_BALANCE,
      balanceAfterMin: F.CREDIT_BALANCE - projectedMaxCredits,
    });
  }
  if (path === "/contacts/bulk/export") return json({ downloadUrl: "https://app.truepoint.in/exports/prospects.csv" });
  if (path === "/contacts/bulk/status") return json({ ok: true, status: "completed" });
  if (path?.startsWith("/contacts/bulk/")) return json({ affected: 24, jobId: "00000000-0000-4000-8000-000000000777" });
  // Reveal jobs: the create call returns an ESTIMATE, everything else returns a SUMMARY — two different
  // shapes on the same path family (see the fixtures header).
  if (seg[0] === "contacts" && seg[1] === "reveal-jobs") {
    if (seg.length === 2 && method === "POST") {
      // Price by the requested type, like the server does — otherwise an email job and a phone job come
      // back with identical numbers and the two cards are indistinguishable.
      const type = (body.revealType ?? "email") as keyof typeof F.REVEAL_COSTS;
      const perUnit = F.REVEAL_COSTS[type] ?? 1;
      const projected = F.REVEAL_JOB_ESTIMATE.billableContacts * perUnit;
      return json(
        {
          ...F.REVEAL_JOB_ESTIMATE,
          revealType: type,
          projectedMaxCredits: projected,
          balanceAfter: F.CREDIT_BALANCE - projected,
          sufficient: projected <= F.CREDIT_BALANCE,
        },
        201,
      );
    }
    if (seg[3] === "download") return json({ downloadUrl: "https://app.truepoint.in/exports/revealed.csv" });
    if (seg[3] === "confirm")
      return json({ ...F.REVEAL_JOB_SUMMARY, status: "running", processedContacts: 1_402, revealedContacts: 1_180, creditSpent: 1_180, startedAt: "2026-07-26T09:05:00.000Z" });
    if (seg[3] === "cancel") return json({ ...F.REVEAL_JOB_SUMMARY, status: "cancelled" });
    return json(F.REVEAL_JOB_SUMMARY);
  }
  if (path === "/contacts") return json({ contacts: F.CONTACTS });

  // ── lists + sequences
  if (path === "/lists" && method === "GET") return json({ lists: F.LISTS });
  if (path === "/lists" && method === "POST") return json({ ...F.LISTS[0], name: body.name ?? "New list" }, 201);
  // GET returns the member PAGE ({members, nextCursor}); POST/DELETE return the affected count. Splitting on
  // method matters: the list-detail surface reads `.members` and crashed on the write-shaped reply.
  if (seg[0] === "lists" && seg[2] === "members" && method === "GET")
    return json({ members: F.CONTACTS, nextCursor: null });
  if (seg[0] === "lists" && seg[2] === "members") return json({ listId: seg[1], affected: 24 }, 201);
  // One sequences fixture serves both callers: the prospect enroll picker reads {id,name}, the Sequences
  // surface reads stepCount/enrolledCount/metrics. The narrower prospect shape crashed the send dashboard
  // on `selected.enrolledCount.toLocaleString()`, which is not guarded.
  if (path === "/outreach/sequences") return json(W.SEQUENCES);
  // GET /outreach/sequences/:id/log is a READ; without this it fell into the write catch-all below and
  // answered {affected,enrolled,skipped}, so the enrollment panel reported "data is undefined".
  if (seg[0] === "outreach" && seg[3] === "log" && method === "GET") return json(W.ENROLLMENTS);
  if (path?.startsWith("/outreach/")) return json({ affected: 24, enrolled: 24, skipped: 0 }, 201);

  // ── the wider apps/web surface ────────────────────────────────────────────────────────────────────────
  // Everything above serves the prospect grid. These serve the other 129 components. Order matters: the
  // more specific path wins, so nested routes come before their prefix.
  //
  // Several of these exist because an EMPTY envelope is not enough — the caller reads a SCALAR or an object
  // off the response (`creditBalance.toLocaleString()`, `prefs.in_app`, `profile.name.trim()`) and a missing
  // key is `undefined` on the very next line. Seven surfaces crashed exactly that way.
  if (path === "/home/summary") return json(W.HOME_SUMMARY);
  if (path === "/home/data-quality/history") return json(W.DATA_QUALITY_HISTORY);
  if (path === "/home/data-quality/reverification-runs") return json(W.REVERIFICATION_RUNS);
  if (path === "/home/data-quality/retention-runs") return json(W.RETENTION_RUNS_WEB);
  if (path?.startsWith("/home/data-quality")) return json(W.DATA_QUALITY);
  if (path === "/contacts/duplicates") return json({ pairs: W.DUPLICATE_PAIRS });
  // /contacts/:survivor/merge-preview?loser=… — the drawer zod-parses this, so it must be the exact shape.
  if (seg[0] === "contacts" && seg[2] === "merge-preview") return json(W.MERGE_PREVIEW);

  // credits + billing
  if (path === "/credits/me") return json(W.CREDITS_ME);
  if (path === "/credits/balance") return json(W.CREDIT_BALANCE);
  if (path === "/credits/usage") return json(W.CREDIT_USAGE);
  if (path === "/credits/subscription") return json({ subscription: W.SUBSCRIPTION });
  if (path === "/credits/reveal-costs") return json(W.REVEAL_COSTS);
  if (path?.startsWith("/credits/ledger")) return json(W.CREDIT_LEDGER);
  if (path === "/pricing/credit-packs") return json(W.PUBLIC_PACKS);
  if (path?.startsWith("/pricing")) return json(W.PUBLIC_PLANS);

  // settings: user
  if (path === "/settings/user/notifications") return json(W.NOTIFICATION_PREFS);
  if (path?.startsWith("/settings/user")) return json(W.USER_PROFILE);

  // settings: tenant + security
  if (path === "/settings/tenant/members") return json(W.TENANT_MEMBERS);
  if (path === "/settings/tenant") return json(W.ORGANIZATION);
  if (path === "/settings/security/auth-policy") return json(W.AUTH_POLICY);
  if (path === "/settings/security/auth-audit") return json(W.AUTH_AUDIT);
  if (path === "/settings/security/identity/domains") return json(W.IDENTITY_DOMAINS);
  if (path === "/settings/security/identity/scim/tokens") return json(W.SCIM_TOKENS);
  if (path === "/settings/security/identity") return json(W.IDENTITY);
  if (path === "/settings/security/sso") return json(W.SSO_CONFIG);
  if (path === "/settings/auto-enrich") return json(W.AUTO_ENRICH);
  if (path?.startsWith("/settings/provider-priority") || path === "/settings/enrichment/providers")
    return json(W.PROVIDER_PRIORITY);

  // workspaces
  if (path === "/auth/session") return json(W.SESSION_PROFILE);
  if (path === "/workspaces/current") return json(W.WORKSPACE_CURRENT);
  if (path === "/workspaces/security/sessions") return json(W.WORKSPACE_SESSIONS);
  if (path === "/workspaces/current/members" || path === "/workspaces/security/members") return json(W.TENANT_MEMBERS);
  if (path?.startsWith("/workspaces")) return json(W.WORKSPACES);

  // email / mailboxes
  if (path === "/email/analytics") return json(W.SEND_QUOTA);
  if (path?.startsWith("/email")) return json({ ...W.MAILBOXES, ...W.SENDING_DOMAINS, ...W.SEND_QUOTA });

  // outreach + templates + inbox
  if (path === "/outreach/enrollments") return json(W.ENROLLMENTS);
  if (path === "/compliance/suppression") return json(W.SUPPRESSIONS);
  if (path === "/templates") return json(W.TEMPLATES);
  if (seg[0] === "templates" && seg[2] === "versions") return json(W.TEMPLATE_VERSIONS);
  if (seg[0] === "templates" && seg[2] === "preview")
    return json({ subject: "Quick question about Ramp ops", body: "Hi Priya,\n\nI work with RevOps teams at companies like Ramp...", fields: ["first_name", "company", "sender_name"] });
  if (seg[0] === "templates" && seg[1] && W.TEMPLATE_DETAIL[seg[1]]) return json(W.TEMPLATE_DETAIL[seg[1]]);
  if (path === "/tasks") return json(W.TASKS);
  if (path === "/inbox") return json(W.THREADS);
  if (seg[0] === "inbox" && seg[1]) return json(W.THREAD_DETAIL);

  // lists (the wider list surface; the prospect grid's own list routes are handled above)
  if (seg[0] === "lists" && seg[1] && !seg[2] && method === "GET") return json(W.LISTS.lists[0]);
  if (path?.startsWith("/lists")) return json(W.LISTS);

  // notifications + announcements + sales navigator
  if (path?.startsWith("/notifications")) return json(W.NOTIFICATIONS);
  if (path === "/announcements") return json(W.ANNOUNCEMENTS_WEB);
  if (path?.startsWith("/sales-navigator")) return json(W.SALES_NAV_LINKS);

  // developer + integrations
  if (path === "/tenants/me/api-keys") return json(W.API_KEYS);
  if (path === "/tenants/me/oauth-apps") return json(W.OAUTH_APPS);
  if (path === "/webhooks/deliveries") return json(W.WEBHOOK_DELIVERIES);
  if (path === "/webhooks") return json(W.WEBHOOKS);
  if (path?.startsWith("/custom-fields")) return json(W.CUSTOM_FIELDS);
  if (path === "/teams") return json(W.TEAMS);

  // CRM sync (the customer-facing view)
  // /crm/connections/:id/{runs,mappings,streams} — the connection id is seg[2], the collection seg[3].
  if (seg[0] === "crm" && seg[3] === "mappings") return json(W.CRM_MAPPINGS);
  if (seg[0] === "crm" && seg[3] === "runs") return json(W.CRM_RUNS);
  if (seg[0] === "crm" && seg[3] === "streams") return json(W.CRM_STREAMS);
  if (path === "/crm/conflicts") return json(W.CRM_CONFLICTS);
  if (path?.startsWith("/crm")) return json(W.CRM_CONNECTIONS_WEB);

  // reports + jobs
  if (path === "/reports/summary") return json(W.REPORTS_SUMMARY);
  if (path?.startsWith("/enrichment/jobs")) return json(W.ENRICHMENT_JOBS_WEB);
  if (seg[0] === "imports" && seg[1] === "bulk") return json(W.BULK_IMPORT_STATUS);
  // GET /imports/:id is the DETAIL route — answering it with the list is what made every job read
  // "Waiting to start" (no statusV2 ⇒ legacyStatusToV2(undefined) ⇒ "queued").
  if (seg[0] === "imports" && seg[1] && W.IMPORT_JOB_DETAILS[seg[1]]) return json(W.IMPORT_JOB_DETAILS[seg[1]]);
  if (path?.startsWith("/imports")) return json(W.IMPORT_JOBS_WEB);

  return json(EMPTY_OK);
}

// The rest of the real module's surface, so any import resolves. None of it runs in a preview.
export function startLogin(): void {}
export function logout(): void {}
export async function exchangeCode(): Promise<boolean> {
  return true;
}

// ── org / workspace switching ───────────────────────────────────────────────────────────────────────────
// The shell's OrgSwitcher and WorkspaceSwitcher call these. The real ones hit the AUTH origin with
// credentials (the org list is cross-tenant, so it cannot come from the tenant-scoped api), then rotate the
// session cookie, install a fresh JWT and RELOAD the page. A card must never reload itself, so the two
// switch calls resolve without doing anything — the list is what the components render.

export interface OrgOption {
  tenantId: string;
  tenantName: string;
  isTenantOwner: boolean;
}

export async function listOrgs(): Promise<{ orgs: OrgOption[]; activeTenantId: string | null }> {
  return {
    orgs: [
      { tenantId: "00000000-0000-4000-8000-000000000101", tenantName: "Northwind Logistics", isTenantOwner: true },
      { tenantId: "00000000-0000-4000-8000-000000000102", tenantName: "Halcyon MedTech", isTenantOwner: false },
      { tenantId: "00000000-0000-4000-8000-000000000105", tenantName: "Ironbridge Group", isTenantOwner: false },
    ],
    activeTenantId: "00000000-0000-4000-8000-000000000101",
  };
}

/** Inert: the real call rotates the session and reloads the window, which a preview card must not do. */
export async function switchOrg(_tenantId: string): Promise<void> {}

/** Inert for the same reason — the real call re-pins the workspace and reloads. */
export async function switchWorkspace(_workspaceId: string): Promise<void> {}

// ── the global-fetch seam ───────────────────────────────────────────────────────────────────────────────
// Most slices call fetchWithAuth, which is the seam this module replaces. The PUBLIC pricing page does not:
// it is unauthenticated, so it calls the global `fetch` directly — and with nothing intercepting that, its
// request never resolves and the card sits in its skeleton forever. Routing /api/v1 through the same table
// keeps ONE router rather than a second set of answers that can drift from it. Anything else is left alone.
if (typeof globalThis.fetch === "function") {
  const passthrough = globalThis.fetch.bind(globalThis);
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return href.includes("/api/v1/")
      ? fetchWithAuth(href, init ?? {})
      : passthrough(input as RequestInfo, init);
  }) as typeof fetch;
}
