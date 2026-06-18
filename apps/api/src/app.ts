// app.ts — compose the api: error handler + CORS (allow-listed app origins, credentials) + feature
// routers. The api is the only public HTTP surface (09); it trusts the access JWT and never issues one.

import { appOrigins } from "@leadwolf/config";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { activityRoutes } from "./features/activity/index.ts";
import { adminRoutes } from "./features/admin/index.ts";
import { aiSearchRoutes } from "./features/ai/index.ts";
import { authRoutes } from "./features/auth/index.ts";
import { billingRoutes, creditsRoutes } from "./features/billing/index.ts";
import { complianceRoutes, dsarPublicRoutes } from "./features/compliance/index.ts";
import { enrichmentRoutes } from "./features/enrichment/index.ts";
import { homeRoutes } from "./features/home/index.ts";
import { importRoutes } from "./features/import/index.ts";
import { outreachRoutes } from "./features/outreach/index.ts";
import { revealRoutes } from "./features/reveal/index.ts";
import { salesNavRoutes } from "./features/sales-navigator/index.ts";
import { searchRoutes } from "./features/search/index.ts";
import { scoringRoutes } from "./features/scoring/index.ts";
import { workspacesRoutes } from "./features/workspaces/index.ts";
import { onError } from "./middleware/error.ts";
import { rateLimit } from "./middleware/rateLimit.ts";

export const app = new Hono();

app.onError(onError);
app.use("*", cors({ origin: [...appOrigins()], credentials: true }));

app.get("/health", (c) => c.json({ status: "ok" }));
// Coarse per-caller throttle on the resource surface (IP-keyed here; per-subject once authn has set claims).
app.use("/api/*", rateLimit);
app.route("/api/v1/auth", authRoutes);
// Platform super-admin (ADR-0032): pa-gated, cross-tenant, audited — NOT workspace-scoped. Highest privilege.
app.route("/api/v1/admin", adminRoutes);
app.route("/api/v1/workspaces", workspacesRoutes);
app.route("/api/v1/home", homeRoutes);
app.route("/api/v1/imports", importRoutes);
app.route("/api/v1/contacts", revealRoutes);
app.route("/api/v1/contacts", scoringRoutes); // /:id/scores + /:id/rescore — no path overlap with reveal
app.route("/api/v1/contacts", activityRoutes); // /:id/activities — no path overlap either
app.route("/api/v1/search", searchRoutes); // 24/ADR-0035: filtered search, typeahead, facet counts
app.route("/api/v1/ai-search", aiSearchRoutes); // 23/ADR-0023: NL → validated filter (for confirmation)
app.route("/api/v1/sales-navigator", salesNavRoutes);
app.route("/api/v1/outreach", outreachRoutes);
app.route("/api/v1/billing", billingRoutes);
app.route("/api/v1/credits", creditsRoutes);
app.route("/api/v1/enrichment", enrichmentRoutes);
// Public DSAR intake must register BEFORE the authenticated compliance router, whose `*` middleware
// would otherwise 401 the session-less form (08 §4).
app.route("/api/v1/compliance/dsar", dsarPublicRoutes);
app.route("/api/v1/compliance", complianceRoutes);
