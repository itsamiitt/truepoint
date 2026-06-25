// app.ts — compose the api: error handler + CORS (allow-listed app origins, credentials) + feature
// routers. The api is the only public HTTP surface (09); it trusts the access JWT and never issues one.

import { appOrigins } from "@leadwolf/config";
import { Hono } from "hono";
import { compress } from "hono/compress";
import { cors } from "hono/cors";
import { accountSearchRoutes } from "./features/account-search/index.ts";
import { activityRoutes } from "./features/activity/index.ts";
import { adminRoutes } from "./features/admin/index.ts";
import { aiSearchRoutes } from "./features/ai/index.ts";
import { authRoutes } from "./features/auth/index.ts";
import { billingRoutes, creditsRoutes } from "./features/billing/index.ts";
import { complianceRoutes, dsarPublicRoutes } from "./features/compliance/index.ts";
import { contactsBulkRoutes } from "./features/contacts-bulk/index.ts";
import { customFieldsRoutes } from "./features/custom-fields/index.ts";
import { emailRoutes, emailWebhookRoutes, templateRoutes } from "./features/email/index.ts";
import { enrichmentRoutes } from "./features/enrichment/index.ts";
import { homeRoutes } from "./features/home/index.ts";
import { importMappingTemplatesRoutes } from "./features/import-mapping-templates/index.ts";
import { importRoutes } from "./features/import/index.ts";
import { listsRoutes } from "./features/lists/index.ts";
import { outreachRoutes } from "./features/outreach/index.ts";
import { pipelineStagesRoutes } from "./features/pipeline-stages/index.ts";
import { revealRoutes } from "./features/reveal/index.ts";
import { salesNavRoutes } from "./features/sales-navigator/index.ts";
import { savedSearchesRoutes } from "./features/saved-searches/index.ts";
import { scimUserRoutes } from "./features/scim/index.ts";
import { scoringRoutes } from "./features/scoring/index.ts";
import { searchRoutes } from "./features/search/index.ts";
import { settingsRoutes } from "./features/settings/index.ts";
import { tagsRoutes } from "./features/tags/index.ts";
import { webhooksRoutes } from "./features/webhooks/index.ts";
import {
  workspaceMembersRoutes,
  workspaceSecurityRoutes,
  workspacesRoutes,
} from "./features/workspaces/index.ts";
import { onError } from "./middleware/error.ts";
import { rateLimit } from "./middleware/rateLimit.ts";

export const app = new Hono();

// How long (seconds) a browser may cache the credentialed CORS preflight. Without it, every sign-in re-runs
// an OPTIONS round-trip before each /api/v1 JSON POST and the Bearer GET /session (perf RC#5). 10 min is well
// under Chromium's cap; the origin/credentials decision is still re-applied server-side on the actual request.
const CORS_PREFLIGHT_MAX_AGE = 600;

app.onError(onError);
// Compress text/JSON responses (perf RC#10). Mounted first so it wraps every downstream response body; it
// honours Accept-Encoding, skips HEAD and already-encoded responses, and only reads the response (no request
// body), so authn/parsing are untouched. The api serves no SSE/long-poll surface, so there is no stream to
// buffer; the one non-JSON body (the bulk CSV export) is a complete in-memory string that gzips well.
app.use("*", compress());
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

app.get("/health", (c) => c.json({ status: "ok" }));
// Coarse per-caller throttle on the resource surface (IP-keyed here; per-subject once authn has set claims).
app.use("/api/*", rateLimit);
app.route("/api/v1/auth", authRoutes);
// Platform super-admin (ADR-0032): pa-gated, cross-tenant, audited — NOT workspace-scoped. Highest privilege.
app.route("/api/v1/admin", adminRoutes);
app.route("/api/v1/workspaces", workspacesRoutes);
// Workspace-admin session management (G-AUTH-2): /security/sessions + revoke/force-reauth. The /security/*
// paths don't overlap workspacesRoutes' GET / (same shared-prefix pattern as /api/v1/contacts).
app.route("/api/v1/workspaces", workspaceSecurityRoutes);
// Workspace members management (P1-03): /current/members + invite/role/remove. The /current/members* paths
// don't overlap workspacesRoutes' GET / nor the /security/* router (same shared-prefix pattern).
app.route("/api/v1/workspaces", workspaceMembersRoutes);
app.route("/api/v1/home", homeRoutes);
// Mapping-templates BEFORE the import router: imports has a `GET /:jobId` that would otherwise capture
// `/imports/mapping-templates` as a job id. The more specific prefix must register first (Hono first-match).
app.route("/api/v1/imports/mapping-templates", importMappingTemplatesRoutes);
app.route("/api/v1/imports", importRoutes);
// Bulk actions BEFORE the reveal router: the literal `bulk` segment must register before reveal's `/:id/reveal`
// so a bulk path is never captured as a contact id (same first-match pattern as imports/mapping-templates).
app.route("/api/v1/contacts/bulk", contactsBulkRoutes); // 24 Phase-3: owner/tags/status/archive/enrich/export
app.route("/api/v1/contacts", revealRoutes);
app.route("/api/v1/contacts", scoringRoutes); // /:id/scores + /:id/rescore — no path overlap with reveal
app.route("/api/v1/contacts", activityRoutes); // /:id/activities — no path overlap either
app.route("/api/v1/search", searchRoutes); // 24/ADR-0035: filtered search, typeahead, facet counts
// 24/ADR-0035 company-level (accounts) search — own base; no prefix overlap with /api/v1/search (distinct path).
app.route("/api/v1/account-search", accountSearchRoutes); // search/facets/count (POST) + suggest (GET)
app.route("/api/v1/saved-searches", savedSearchesRoutes); // 24 §8: persist + re-apply filter sets
app.route("/api/v1/lists", listsRoutes); // 24: static prospect lists (bulk add-to-list)
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
// M12 email subsystem foundations (email-planning/13 P0): mailbox connect + sending-domain DNS auth +
// send-quota read. Workspace/tenant-scoped behind authn+tenancy; credential writes never echo the secret.
app.route("/api/v1/email", emailRoutes);
// Pipeline stages (G-REV-7, ADR-0028): workspace stage CRUD + POST /contacts/:id/stage rollup. Mounted on
// its OWN base so /contacts/:id/stage cannot collide with the /api/v1/contacts reveal/scoring/activity slices.
app.route("/api/v1/pipeline-stages", pipelineStagesRoutes);
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
