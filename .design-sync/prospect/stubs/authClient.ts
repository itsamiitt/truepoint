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
const EMPTY_OK = {
  ok: true, status: "ok", total: 0, count: 0, affected: 0, balance: 0, nextCursor: null,
  hits: [], accounts: [], contacts: [], facets: [], suggestions: [], tags: [], lists: [],
  stages: [], searches: [], sequences: [], activities: [], values: [], scores: [],
  recordIds: [], revealed: [], history: [], items: [], results: [], enrollments: [],
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
  if (seg[0] === "custom-fields") return json({ values: F.CUSTOM_FIELDS });

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
  if (seg[0] === "lists" && seg[2] === "members") return json({ listId: seg[1], affected: 24 }, 201);
  if (path === "/outreach/sequences") return json({ sequences: F.SEQUENCES });
  if (path?.startsWith("/outreach/")) return json({ affected: 24, enrolled: 24, skipped: 0 }, 201);

  return json(EMPTY_OK);
}

// The rest of the real module's surface, so any import resolves. None of it runs in a preview.
export function startLogin(): void {}
export function logout(): void {}
export async function exchangeCode(): Promise<boolean> {
  return true;
}
