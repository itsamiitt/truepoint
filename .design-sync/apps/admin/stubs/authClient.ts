// stubs/authClient.ts — the staff console's token client, replaced by a fixture-backed route router.
//
// The real module is a @leadwolf/auth-client instantiation doing PKCE + in-memory tokens + silent refresh
// (ADR-0016). Here `fetchWithAuth` answers the /api/v1/admin/* surface from ../fixtures.
//
// The two staff gates are deliberately NOT stubbed. adminGate.verifyPlatformAdmin probes
// GET /admin/system-health and classifies on the STATUS (200 staff, 403 forbidden, 401 unauthenticated);
// StaffMeProvider reads GET /admin/me. Fixturing those two ROUTES instead of the gate modules means the
// console's real authorization code runs and resolves to the authorized branch — which is the state worth
// designing against, and it keeps the cards honest about what the app actually does.
//
// ROUTES is ordered: the first regex that matches wins, so put specific paths before their prefixes.
// Anything unmatched falls through to EMPTY_OK, an envelope carrying every collection key the console
// destructures, so a route nobody fixtured renders an empty state rather than throwing.

import * as F from "../fixtures";
import * as G from "../fixtures2";

const b64url = (o: unknown) =>
  btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// Not a credential: an unsigned stand-in whose only consumer is a client-side claim decode.
const FAKE_JWT = `${b64url({ alg: "none", typ: "JWT" })}.${b64url({
  sub: "00000000-0000-4000-8000-0000000000a1",
  pa: true,
  exp: 4102444800,
})}.`;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Every collection key a console slice reads, so an unmapped route degrades to "empty", never a crash. */
const EMPTY_OK = {
  ok: true, status: "ok", total: 0, count: 0, nextCursor: null,
  items: [], results: [], rows: [], tenants: [], users: [], staff: [], flags: [], plans: [], packs: [],
  runs: [], jobs: [], policies: [], records: [], entries: [], snapshots: [], links: [], rules: [],
  approvals: [], dsars: [], suppressions: [], subProcessors: [], origins: [], configs: [], events: [],
  announcements: [], deadLetters: [], notes: [], holds: [], purchases: [], ledger: [], series: [],
};

const ROUTES: Array<[RegExp, () => unknown]> = [
  // ── the two gate probes (see the header) ────────────────────────────────────────────────────────────
  [/\/admin\/system-health\b/, () => F.SYSTEM_HEALTH],
  [/\/admin\/me\b/, () => ({ staffRole: "super_admin", capabilities: F.STAFF_CAPABILITIES })],

  // ── feature reads ───────────────────────────────────────────────────────────────────────────────────
  // ── tenant detail sub-routes ────────────────────────────────────────────────────────────────────────
  // These MUST precede the bare `/tenants/:id` entry below: ROUTES is first-match, and `/tenants/[^/?]+`
  // matches `/tenants/abc/ledger` just as happily as `/tenants/abc`. Each of TenantOverview,
  // TenantEconomics, TenantPurchases, TenantSubscription, SupportNotes, TenantHolds and TenantLedger takes
  // only a tenantId and fetches its own slice, so without these the detail surface is a stack of empties.
  [/\/admin\/tenants\/[^/?]+\/overview\b/, () => G.TENANT_360],
  [/\/admin\/tenants\/[^/?]+\/economics\/trend\b/, () => ({ trend: G.ECONOMICS_TREND })],
  [/\/admin\/tenants\/[^/?]+\/economics\b/, () => ({ economics: G.TENANT_ECONOMICS_DETAIL })],
  [/\/admin\/tenants\/[^/?]+\/purchases\b/, () => ({ purchases: G.TENANT_PURCHASES })],
  [/\/admin\/tenants\/[^/?]+\/subscription\b/, () => ({ subscription: G.TENANT_SUBSCRIPTION })],
  [/\/admin\/tenants\/[^/?]+\/ledger\b/, () => ({ entries: G.TENANT_LEDGER, nextCursor: null })],
  [/\/admin\/tenants\/[^/?]+\/notes\b/, () => ({ notes: G.TENANT_NOTES })],
  [/\/admin\/tenants\/[^/?]+\/holds\b/, () => ({ holds: G.TENANT_HOLDS })],
  [/\/admin\/tenants\/[^/?]+\/auth-enforcement\b/, () => ({ enforcementEnabled: true })],

  [/\/admin\/tenants\/[^/?]+/, () => F.TENANT_DETAIL],
  [/\/admin\/tenants\b/, () => ({ tenants: F.TENANTS, total: F.TENANTS.length, nextCursor: null })],
  [/\/admin\/users\b/, () => ({ users: F.USERS, total: F.USERS.length, nextCursor: null })],
  [/\/admin\/staff\b/, () => ({ staff: F.STAFF })],
  [/\/admin\/audit-log\b/, () => ({ entries: F.AUDIT_ENTRIES, nextCursor: null })],
  [/\/admin\/ai-usage\b/, () => F.AI_USAGE],
  [/\/admin\/trust-abuse\b/, () => F.TRUST_ABUSE],
  [/\/admin\/import-jobs\b/, () => ({ jobs: F.IMPORT_JOBS })],
  [/\/admin\/elevations\b/, () => ({ items: [] })],
  // An ACTIVE session, not null. The banner renders nothing when nothing is impersonating — correct, but a
  // blank card documents nothing. The state worth designing against is the one the banner exists for: a
  // live session, named, with its justification and a one-click End.
  [/\/admin\/impersonation\/active\b/, () => ({
    sessions: [{
      id: "imp_01hq9x1",
      targetTenantId: "00000000-0000-4000-8000-000000000101",
      targetUserId: "00000000-0000-4000-8000-000000000301",
      reason: "Reproducing a saved-search bug the customer reported on ticket SUP-4182.",
      expiresAt: "2026-08-18T11:00:00Z",
    }],
  })],
  [/\/auth\/session\b/, () => ({ ok: true })],

  // ── billing ─────────────────────────────────────────────────────────────────────────────────────────
  // Order matters: the more specific economics paths come before the bare /economics prefix.
  [/\/admin\/billing\/economics\/by-tenant\b/, () => ({ tenants: G.ECONOMICS_BY_TENANT, rows: G.ECONOMICS_BY_TENANT })],
  [/\/admin\/billing\/economics\/trend\b/, () => ({ points: G.ECONOMICS_TREND, trend: G.ECONOMICS_TREND, series: G.ECONOMICS_TREND })],
  [/\/admin\/billing\/economics\b/, () => ({ summary: G.ECONOMICS })],
  [/\/admin\/billing\/low-balance\b/, () => ({ tenants: G.LOW_BALANCE })],
  [/\/admin\/billing\/approvals\b/, () => ({ approvals: G.BILLING_APPROVALS })],

  // ── compliance ──────────────────────────────────────────────────────────────────────────────────────
  [/\/admin\/compliance\/dsars\b/, () => ({ dsars: G.DSARS, requests: G.DSARS, items: G.DSARS })],
  [/\/admin\/compliance\/suppression\b/, () => ({ suppressions: G.SUPPRESSIONS, entries: G.SUPPRESSIONS, items: G.SUPPRESSIONS })],
  [/\/admin\/compliance\/retention\b/, () => ({ policies: G.COMPLIANCE_RETENTION, items: G.COMPLIANCE_RETENTION })],
  [/\/admin\/compliance\/sub-processors\b/, () => ({ subProcessors: G.SUB_PROCESSORS, items: G.SUB_PROCESSORS })],

  // ── content ─────────────────────────────────────────────────────────────────────────────────────────
  [/\/admin\/announcements\b/, () => ({ announcements: G.ANNOUNCEMENTS, items: G.ANNOUNCEMENTS })],

  // ── crm sync ────────────────────────────────────────────────────────────────────────────────────────
  [/\/admin\/crm\/sync-health\b/, () => ({ connections: G.CRM_CONNECTIONS, items: G.CRM_CONNECTIONS })],
  [/\/admin\/crm\/dead-letters\b/, () => ({ deadLetters: G.CRM_DEAD_LETTERS, items: G.CRM_DEAD_LETTERS })],

  // ── data ops ────────────────────────────────────────────────────────────────────────────────────────
  [/\/admin\/data\/overview\b/, () => G.DATA_OPS_OVERVIEW],
  [/\/admin\/data\/imports\/[^/?]+/, () => G.IMPORT_DETAIL],
  [/\/admin\/data\/enrichment\/runs\b/, () => ({ runs: G.ENRICHMENT_RUNS, items: G.ENRICHMENT_RUNS })],
  [/\/admin\/data\/verification\/runs\b/, () => ({ runs: G.VERIFICATION_RUNS, items: G.VERIFICATION_RUNS })],
  [/\/admin\/data\/quality\/snapshots\b/, () => ({ snapshots: G.FLEET_QUALITY, items: G.FLEET_QUALITY, rows: G.FLEET_QUALITY })],
  [/\/admin\/data\/approvals\b/, () => ({ approvals: G.APPROVALS, requests: G.APPROVALS, items: G.APPROVALS })],
  [/\/admin\/data\/validation\/rules\b/, () => ({ rules: G.VALIDATION_RULES, items: G.VALIDATION_RULES })],
  [/\/admin\/data\/dedup\/links\b/, () => ({ links: [], items: [] })],
  [/\/admin\/data-quality\b/, () => G.DATA_QUALITY],

  // ── data sources, extension, flags ──────────────────────────────────────────────────────────────────
  [/\/admin\/data-sources\b|\/admin\/origins\b/, () => ({ origins: G.ORIGINS, items: G.ORIGINS })],
  [/\/admin\/extension\b/, () => G.EXTENSION_META],
  [/\/admin\/feature-flags\/env-gates\b|\/admin\/env-gates\b/, () => ({ gates: G.ENV_GATES })],
  [/\/admin\/feature-flags\b|\/admin\/flags\b/, () => ({ flags: G.FEATURE_FLAGS, items: G.FEATURE_FLAGS })],

  // ── pricing catalogue ───────────────────────────────────────────────────────────────────────────────
  [/\/admin\/pricing\/plan-templates\b/, () => ({ templates: G.PLAN_TEMPLATES, plans: G.PLAN_TEMPLATES, items: G.PLAN_TEMPLATES })],
  [/\/admin\/pricing\/credit-packs\b/, () => ({ packs: G.CREDIT_PACKS, creditPacks: G.CREDIT_PACKS, items: G.CREDIT_PACKS })],
  [/\/admin\/provider-configs\b|\/admin\/providers\b/, () => ({ providers: G.PROVIDER_CONFIGS, configs: G.PROVIDER_CONFIGS, items: G.PROVIDER_CONFIGS })],

  // ── retention + auth policy ─────────────────────────────────────────────────────────────────────────
  // The retention ENGINE routes are `/retention-runs` and `/retention-policies` (hyphenated), and the policy
  // shape there is @leadwolf/types' {dataClass, ttlDays, mode} — NOT the compliance surface's
  // {entity, retentionDays, reason}. Getting either wrong is silent: the first fell through to EMPTY_OK and
  // crashed on `.length`, the second rendered a table with a blank Data class column.
  [/\/admin\/retention-runs\b/, () => ({ runs: G.RETENTION_RUNS })],
  [/\/admin\/retention-policies\b/, () => ({ policies: G.RETENTION_POLICIES })],
  [/\/admin\/retention\b/, () => ({ policies: G.COMPLIANCE_RETENTION, items: G.COMPLIANCE_RETENTION })],
  // `/admin/auth/platform-policy`, not `/admin/auth-policy` — the feature directory name and the route
  // name differ, and guessing from the directory rendered the "No platform defaults set" empty state.
  [/\/admin\/auth\/platform-policy\b/, () => ({ policies: G.PLATFORM_DEFAULTS })],
];

export async function fetchWithAuth(input: RequestInfo | URL, _init?: RequestInit): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  for (const [re, body] of ROUTES) if (re.test(url)) return json(body());
  return json(EMPTY_OK);
}

export function getAccessToken(): string | null {
  return FAKE_JWT;
}
export function clearAccessToken(): void {}
export async function silentRefresh(): Promise<boolean> {
  return true;
}
export async function startLogin(): Promise<void> {}
export async function completeLogin(): Promise<void> {}
export async function logout(): Promise<void> {}

export const RECOVERY_KEY = "lw_admin_recovery";
export type RecoveryAction = "restart" | "retry" | "fail";
export function recoveryActionFor(): RecoveryAction {
  return "fail";
}
