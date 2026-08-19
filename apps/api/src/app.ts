// app.ts — compose the api: error handler + CORS (allow-listed app origins, credentials) + feature
// routers. The api is the only public HTTP surface (09); it trusts the access JWT and never issues one.

import { renderAuthMetrics } from "@leadwolf/auth";
import { appOrigins, env } from "@leadwolf/config";
import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  accountIntelligenceRoutes,
  contactIntelligenceRoutes,
} from "./features/account-intelligence/index.ts";
import { accountSearchRoutes } from "./features/account-search/index.ts";
import { activityRoutes } from "./features/activity/index.ts";
import { signalRoutes, watchlistRoutes } from "./features/alerts/index.ts";
import { adminRoutes } from "./features/admin/index.ts";
import { aiSearchRoutes } from "./features/ai/index.ts";
import { announcementsRoutes } from "./features/announcements/index.ts";
import { authRoutes } from "./features/auth/index.ts";
import { billingRoutes, creditsRoutes } from "./features/billing/index.ts";
import { complianceRoutes, dsarPublicRoutes } from "./features/compliance/index.ts";
import { contactsBulkRoutes } from "./features/contacts-bulk/index.ts";
import { contactsDedupRoutes } from "./features/contacts-dedup/index.ts";
import { contactsFromDatabaseRoutes } from "./features/contacts-from-database/index.ts";
import { contactsMergeRoutes } from "./features/contacts-merge/index.ts";
import { contactsResolveRoutes } from "./features/contacts-resolve/index.ts";
import { crmRoutes, crmWebhookRoutes } from "./features/crm-sync/index.ts";
import { customFieldsRoutes } from "./features/custom-fields/index.ts";
import {
  emailConnectRoutes,
  emailRoutes,
  emailWebhookRoutes,
  templateRoutes,
} from "./features/email/index.ts";
import { enrichmentRoutes } from "./features/enrichment/index.ts";
import { eventsRoutes } from "./features/events/routes.ts";
import { homeRoutes } from "./features/home/index.ts";
import { meRoutes, orgsRoutes } from "./features/identity/index.ts";
import { importMappingTemplatesRoutes } from "./features/import-mapping-templates/index.ts";
import {
  bulkImportRoutes,
  importArtifactRoutes,
  importRoutes,
  importScheduleRoutes,
} from "./features/import/index.ts";
import { ingestRoutes } from "./features/ingest/index.ts";
import { listsRoutes } from "./features/lists/index.ts";
import { marketRoutes } from "./features/market/index.ts";
import { masterSyncRoutes } from "./features/master-sync/index.ts";
import { notificationsRoutes } from "./features/notifications/index.ts";
import { outreachRoutes } from "./features/outreach/index.ts";
import { pipelineStagesRoutes } from "./features/pipeline-stages/index.ts";
import { publicPricingRoutes } from "./features/pricing/index.ts";
import { reportsRoutes } from "./features/reports/index.ts";
import { revealRoutes } from "./features/reveal/index.ts";
import { salesNavRoutes } from "./features/sales-navigator/index.ts";
import { savedSearchesRoutes } from "./features/saved-searches/index.ts";
import { scimUserRoutes } from "./features/scim/index.ts";
import { scoringRoutes } from "./features/scoring/index.ts";
import { searchRoutes } from "./features/search/index.ts";
import { settingsRoutes } from "./features/settings/index.ts";
import { tagsRoutes } from "./features/tags/index.ts";
import { teamsRoutes } from "./features/teams/index.ts";
import { webhooksRoutes } from "./features/webhooks/index.ts";
import {
  workspaceMembersRoutes,
  workspaceSecurityRoutes,
  workspacesRoutes,
} from "./features/workspaces/index.ts";
import { isDraining } from "./lifecycle.ts";
import { notFound, onError } from "./middleware/error.ts";
import { rateLimit } from "./middleware/rateLimit.ts";
import { requestId } from "./middleware/requestId.ts";
import { createReadinessGate, dbReadinessProbe } from "./readiness.ts";

export const app = new Hono();

// How long (seconds) a browser may cache the credentialed CORS preflight. Without it, every sign-in re-runs
// an OPTIONS round-trip before each /api/v1 JSON POST and the Bearer GET /session (perf RC#5). The origin/
// credentials decision is still re-applied server-side on the actual request.
//
// 2h (Chromium's cap) rather than 10min because the preflight cache is keyed per EXACT URL: with cursor
// pagination every page is a new URL and therefore a fresh OPTIONS round-trip, so a short max-age re-pays the
// preflight constantly during normal browsing. This is an interim measure — routing /api under the app origin
// (deploy/Caddyfile, mirroring the forge.truepoint.in block) removes the preflight surface entirely.
const CORS_PREFLIGHT_MAX_AGE = 7200;

// Unmatched routes get the SAME problem+json envelope as everything else. Without this, Hono's plain-text
// default made the one response a client is most likely to hit by accident — a typo'd path, a stale SDK —
// the one response that broke the contract every other error honours (audit 32 · C4).
app.notFound(notFound);
app.onError(onError);
// Correlation id FIRST, so every response carries one — including 500s rendered by onError above (which logs
// the id alongside the stack) and the long-lived SSE stream registered below.
app.use("*", requestId);
// SSE realtime stream (reveal-experience Phase 4, ADR-0027). It carries its own CORS (the global cors is
// registered after this). Dark until REALTIME_SSE_ENABLED (the route 404s); authn+tenancy run inside
// eventsRoutes. It used to be mounted here specifically to sit ahead of compress() so the long-lived stream
// could not be buffered by the compressor; compress() is gone (see below), but the ordering is kept because
// the stream also wants its own narrower CORS ahead of the global one.
app.use(
  "/api/v1/events/*",
  cors({ origin: [...appOrigins()], credentials: true, maxAge: CORS_PREFLIGHT_MAX_AGE }),
);
app.route("/api/v1/events", eventsRoutes);
// NO app-level compress(). Compression happens at the edge (`encode zstd gzip`, deploy/Caddyfile) and Caddy
// SKIPS bodies that already carry a Content-Encoding — so compressing here does not double-compress, it just
// (a) burns CPU in this single-threaded Bun process on every response and (b) PREVENTS the edge from applying
// zstd, which compresses better than the gzip hono can emit. hono 4.6.13 also has no `threshold` option, so it
// paid a CompressionStream setup on tiny JSON bodies too. Revisit only if a deployment ever runs without an
// encoding-capable proxy in front.
// CORS: origin allow-list + credentials unchanged. maxAge caches the credentialed preflight (RC#5).
// exposeHeaders makes ETag readable cross-origin (app.* → api.*) — else the browser strips it and the Home
// summary's conditional-request (If-None-Match → 304) revalidation is silently dead in production.
app.use(
  "*",
  cors({
    origin: [...appOrigins()],
    credentials: true,
    exposeHeaders: ["ETag"],
    maxAge: CORS_PREFLIGHT_MAX_AGE,
  }),
);

// Liveness + drain awareness. Returns 503 once SIGTERM has started a drain so the orchestrator/edge stops
// routing new work to a process that is on its way out. This is a LIVENESS probe and stays that way: it
// deliberately does not touch Postgres, because coupling liveness to a dependency means one database blip
// fails every replica's probe simultaneously and the orchestrator recycles the whole fleet. "Can this process
// serve traffic" is a different question, answered by /ready below.
app.get("/health", (c) =>
  isDraining() ? c.json({ status: "draining" }, 503) : c.json({ status: "ok" }),
);
// Readiness — drain state plus a bounded, threshold-gated Postgres probe (see readiness.ts for why bounded
// and why thresholded). This is what compose gates `caddy` on, so a dead database actually stops traffic
// instead of being reported healthy. The body is a coarse label for whoever reads a probe log; it is not a
// diagnostic surface and intentionally leaks nothing about the failure.
const readinessGate = createReadinessGate({ isDraining, probe: dbReadinessProbe() });
app.get("/ready", async (c) => {
  const verdict = await readinessGate();
  return verdict.ready
    ? c.json({ status: "ready" }, 200)
    : c.json({ status: "not_ready", reason: verdict.reason }, 503);
});
// Internal auth-SLI scrape (Phase 1 observability, doc 03 §10). OFF BY DEFAULT: 404 unless METRICS_TOKEN is set
// AND the request carries `Authorization: Bearer <token>` — a scraper has no user JWT, so the shared secret IS
// the gate. A wrong/absent token also 404s: the endpoint is invisible to anyone without the secret (don't
// advertise it). Renders THIS process's in-process auth counters (apps/api: revocation-check SLIs) as Prometheus
// text. Registered OUTSIDE /api/* so no user authn / rate-limit applies; intended to sit behind an internal network.
app.get("/metrics", (c) => {
  const token = env.METRICS_TOKEN;
  if (!token || c.req.header("authorization") !== `Bearer ${token}`) return c.notFound();
  return c.text(renderAuthMetrics(), 200, { "content-type": "text/plain; version=0.0.4" });
});
// Unauthenticated per-IP backstop. Runs pre-authn, so it charges only tokenless requests; authenticated
// traffic is charged per-subject inside authn AFTER the token verifies (and a failed verify is billed back to
// the IP bucket there). See middleware/rateLimit.ts for why the old claims-aware branch here was dead code.
app.use("/api/*", rateLimit);
app.route("/api/v1/auth", authRoutes);
// Extension identity reads (chrome-extension/14 X03/X04): GET /me (display identity for the popup/panel) +
// GET /orgs (the caller's orgs for the switcher). Each keyed by the token's sub → a user only ever sees their
// own identity/memberships. Own bases; no overlap with /credits/me or /admin/me.
app.route("/api/v1/me", meRoutes);
app.route("/api/v1/orgs", orgsRoutes);
// Platform super-admin (ADR-0032): pa-gated, cross-tenant, audited — NOT workspace-scoped. Highest privilege.
app.route("/api/v1/admin", adminRoutes);
app.route("/api/v1/announcements", announcementsRoutes); // 13a Area 10 — customer banner read
app.route("/api/v1/notifications", notificationsRoutes); // G-NTF-1 — per-user in-app notification feed
app.route("/api/v1/workspaces", workspacesRoutes);
app.route("/api/v1/teams", teamsRoutes); // Part D — workspace grouping (org-chart, not an access boundary)
// Workspace-admin session management (G-AUTH-2): /security/sessions + revoke/force-reauth. The /security/*
// paths don't overlap workspacesRoutes' GET / (same shared-prefix pattern as /api/v1/contacts).
app.route("/api/v1/workspaces", workspaceSecurityRoutes);
// Workspace members management (P1-03): /current/members + invite/role/remove. The /current/members* paths
// don't overlap workspacesRoutes' GET / nor the /security/* router (same shared-prefix pattern).
app.route("/api/v1/workspaces", workspaceMembersRoutes);
app.route("/api/v1/home", homeRoutes);
app.route("/api/v1/reports", reportsRoutes);
// Mapping-templates BEFORE the import router: imports has a `GET /:jobId` that would otherwise capture
// `/imports/mapping-templates` as a job id. The more specific prefix must register first (Hono first-match).
app.route("/api/v1/imports/mapping-templates", importMappingTemplatesRoutes);
// Bulk COPY-staging import (backlog #2, phase 6) BEFORE the import router for the same first-match reason as
// mapping-templates: importRoutes' `GET /:jobId` would otherwise capture `/imports/bulk` as a job id. The router
// is GATED DARK behind BULK_IMPORT_ENABLED (default false) — every route 403s and nothing is created while off.
app.route("/api/v1/imports/bulk", bulkImportRoutes);
// Error-artifact downloads (S-V5/S-S4) BEFORE the import router: its `/:jobId/artifacts/:kind` is a deeper path
// than importRoutes' `/:jobId`, so there is no capture conflict — registered first for the same discipline.
app.route("/api/v1/imports", importArtifactRoutes);
// Scheduled imports (P5) BEFORE the import router: `/imports/schedules` must register before importRoutes'
// `/:jobId` so the literal `schedules` segment is never captured as a job id (the mapping-templates / bulk /
// artifacts first-match precedent). Every verb 404s while the scheduled-imports dual gate is off.
app.route("/api/v1/imports", importScheduleRoutes);
app.route("/api/v1/imports", importRoutes);
// Bulk actions BEFORE the reveal router: the literal `bulk` segment must register before reveal's `/:id/reveal`
// so a bulk path is never captured as a contact id (same first-match pattern as imports/mapping-templates).
app.route("/api/v1/contacts/bulk", contactsBulkRoutes); // 24 Phase-3: owner/tags/status/archive/enrich/export
// Within-workspace dedup review (database-management-research G09) — the literal `duplicates` segment registers
// BEFORE the reveal router so it is never captured as a contact `:id` (same first-match pattern as /contacts/bulk).
app.route("/api/v1/contacts/duplicates", contactsDedupRoutes);
// True-merge verb + preview (S-C5): /:id/merge + /:id/merge-preview — no path overlap with reveal/scores/
// activities. Dual-gated 404-off (dark until the merge flag flips).
app.route("/api/v1/contacts", contactsMergeRoutes);
// Extension LinkedIn resolver (chrome-extension/14 X01): GET /contacts/by-linkedin/:publicId → the masked
// contact for the slug in the active workspace. Registered BEFORE the reveal router so the literal
// `by-linkedin` segment is never captured as a contact `:id` (same first-match discipline as /contacts/bulk).
app.route("/api/v1/contacts", contactsResolveRoutes);
// "Add to workspace" (Layer-0-as-database): a LITERAL segment, so it must precede revealRoutes' `/:id`.
app.route("/api/v1/contacts", contactsFromDatabaseRoutes);
app.route("/api/v1/contacts", revealRoutes);
app.route("/api/v1/contacts", scoringRoutes); // /:id/scores + /:id/rescore — no path overlap with reveal
app.route("/api/v1/contacts", activityRoutes); // /:id/activities — no path overlap either
app.route("/api/v1/contacts", contactIntelligenceRoutes); // /:id/education — Layer-0 read, no overlap
app.route("/api/v1/search", searchRoutes); // 24/ADR-0035: filtered search, typeahead, facet counts
// 24/ADR-0035 company-level (accounts) search — own base; no prefix overlap with /api/v1/search (distinct path).
app.route("/api/v1/account-search", accountSearchRoutes); // search/facets/count (POST) + suggest (GET)
// The first API surface over Layer 0. Mounted on /accounts (the tenant-visible resource) rather than on any
// master_* id: the client addresses its own account and the server resolves the bridge, so the shared graph
// is never addressable directly. `relationship` is required — develops and uses are disjoint answers.
app.route("/api/v1/accounts", accountIntelligenceRoutes);
app.route("/api/v1/saved-searches", savedSearchesRoutes); // 24 §8: persist + re-apply filter sets
// Market-intelligence MI-S5/MI-S6 (docs/planning/market-intelligence/): account watchlists + per-user
// signal subscriptions, and the tenant_signals feed (the workspace's DELIVERED copy — never Layer 0).
app.route("/api/v1/watchlists", watchlistRoutes);
app.route("/api/v1/signals", signalRoutes);
app.route("/api/v1/market", marketRoutes); // MI-S7: the non-PII segment board (honest-empty while dark)
app.route("/api/v1/lists", listsRoutes); // 24: static prospect lists (bulk add-to-list)
// Unified ingestion entry (prospect-database-platform Phase 03 / I2) — one idempotent envelope for every source.
app.route("/api/v1/ingest", ingestRoutes);
// Machine-only Forge master-sync ingress (docs/planning/forge/11, ADR-0047) — its own scope-gated principal,
// NOT the human authn→tenancy→requireRole chain.
//
// DARK BY DEFAULT (F-0.10). ADR-0047 replaced this HTTP push with an in-process withErTx promotion, and
// nothing in this repo calls the endpoint any more — so what remained was a live, orphaned SECOND write path
// into the Layer-0 master graph, reachable by anyone holding a service JWT carrying the master-sync scope.
// Two write paths into the golden record is one more than the ER model assumes. Not deleted, because it is a
// documented ADR-0047 ingress an externally-hosted Forge could still need; gated, so enabling it is a
// deliberate reviewable act rather than the status quo.
if (env.MASTER_SYNC_INGRESS_ENABLED) {
  app.route("/api/v1/master-sync", masterSyncRoutes);
}
app.route("/api/v1/ai-search", aiSearchRoutes); // 23/ADR-0023: NL → validated filter (for confirmation)
app.route("/api/v1/sales-navigator", salesNavRoutes);
app.route("/api/v1/custom-fields", customFieldsRoutes); // ADR-0028: field definitions + typed-jsonb values
app.route("/api/v1/tags", tagsRoutes); // ADR-0028/G-REV-6: workspace tags + record assignments + filter
app.route("/api/v1/outreach", outreachRoutes);
// M12 P2: email templates — the path the Sequences ▸ Templates panel already targets (lights up the stub).
app.route("/api/v1/templates", templateRoutes);
// Public, SIGNATURE-verified ESP delivery/bounce webhook (P1) must register BEFORE the authed email router,
// whose `*` authn would otherwise 401 the session-less ESP call (mirrors dsar-before-compliance).
app.route("/api/v1/email/webhooks", emailWebhookRoutes);
// Session-less OAuth connect CALLBACK (P1) — the provider redirects the browser here with no Bearer token, so
// it too must register BEFORE the authed email router; identity is recovered from the single-use `state`.
app.route("/api/v1/email", emailConnectRoutes);
// M12 email subsystem foundations (email-planning/13 P0): mailbox connect + sending-domain DNS auth +
// send-quota read. Workspace/tenant-scoped behind authn+tenancy; credential writes never echo the secret.
app.route("/api/v1/email", emailRoutes);
// Pipeline stages (G-REV-7, ADR-0028): workspace stage CRUD + POST /contacts/:id/stage rollup. Mounted on
// its OWN base so /contacts/:id/stage cannot collide with the /api/v1/contacts reveal/scoring/activity slices.
// CRM bidirectional sync (crm-sync §3.3/§5.2). The PUBLIC, signature-verified provider webhook registers
// BEFORE the authed router, whose `*` authn would 401 the session-less provider call. DARK until
// CRM_SYNC_ENABLED + the per-tenant flag + a connection promoted past shadow.
app.route("/api/v1/crm/webhooks", crmWebhookRoutes);
app.route("/api/v1/crm", crmRoutes);
app.route("/api/v1/pipeline-stages", pipelineStagesRoutes);
// Public, UNAUTHENTICATED transparent pricing catalog (ADR-0012): active credit packs + plan tiers. Carries
// no authn/tenancy (the page renders with no token/tenant/balance); only the coarse /api/* IP rate-limit
// above applies. Reads NON-PII platform config on the owner connection (withPlatformReadTx) — never tenant data.
app.route("/api/v1/pricing", publicPricingRoutes);
app.route("/api/v1/billing", billingRoutes);
app.route("/api/v1/credits", creditsRoutes);
app.route("/api/v1/enrichment", enrichmentRoutes);
app.route("/api/v1/settings", settingsRoutes); // workspace settings (auto-enrich policy, G-ENR-1)
// Outbound webhooks (developer settings, 09 §10, 12 §5): CRUD subscriptions + delivery log + replay/self-test.
app.route("/api/v1/webhooks", webhooksRoutes);
// Public DSAR intake must register BEFORE the authenticated compliance router, whose `*` middleware
// would otherwise 401 the session-less form (08 §4).
app.route("/api/v1/compliance/dsar", dsarPublicRoutes);
app.route("/api/v1/compliance", complianceRoutes);
// SCIM 2.0 provisioning/deprovisioning (enterprise IAM, 17 / ADR-0018; 09 "SCIM deprovisioning race & token
// abuse"). Mounted DISJOINT from /api/v1: an org's IdP calls /scim/v2/Users with a `scim_tokens` bearer token,
// NOT a user access JWT — so this router carries its OWN auth (scimAuth) + the SCIM error envelope, and is not
// behind the /api/* user authn / rate-limit chain above. Tenant isolation: the token resolves to exactly one
// tenant and scopes every operation (RLS) to its members.
app.route("/scim/v2", scimUserRoutes);
