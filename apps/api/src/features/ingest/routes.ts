// routes.ts — the UNIFIED INGESTION entry (prospect-database-platform Phase 03 / I2; mounted at /api/v1/ingest).
// Transport only: the scope comes from the VERIFIED token (never the body), the body is validated against the
// shared `ingestionEnvelope` Zod, the source's CONNECTOR is looked up in @leadwolf/core's registry and runs its
// source-specific validation, and the endpoint returns a job handle. ADDITIVE — a NEW endpoint that does not touch
// the existing /import path or runImport. The async processing pipeline (evidence -> resolve -> enrich -> land) is
// wired per connector in later slices (audit P05); v1 validates + accepts.
import { checkCaptureRate } from "@leadwolf/auth";
import { getConnector, registerBuiltinConnectors } from "@leadwolf/core";
import { ForbiddenError, ValidationError, ingestionEnvelope } from "@leadwolf/types";
import { Hono } from "hono";
import { authn } from "../../middleware/authn.ts";
import { type RoleVariables, requireRole } from "../../middleware/requireRole.ts";
import { tenancy } from "../../middleware/tenancy.ts";

// Register the built-in connectors once at module load (idempotent).
registerBuiltinConnectors();

export const ingestRoutes = new Hono<{ Variables: RoleVariables }>();
ingestRoutes.use("*", authn);
ingestRoutes.use("*", tenancy);
ingestRoutes.use("*", requireRole("owner", "admin", "member"));

/**
 * POST /api/v1/ingest — validate the envelope, pin its scope to the caller's session, look up the connector, run
 * its validation, and accept. The tenant is taken from the VERIFIED token; a body `scope.tenantId` that disagrees
 * is a 403 (a client-supplied tenant is never trusted). An unknown source is a 400.
 */
ingestRoutes.post("/", async (c) => {
  const parsed = ingestionEnvelope.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues[0]?.message ?? "Invalid ingestion envelope.");
  }
  const tenantId = c.get("tenantId");
  const workspaceId = c.get("workspaceId");
  // Trust boundary: the envelope's tenant MUST match the session's — never ingest into another tenant.
  if (parsed.data.scope.tenantId !== tenantId) {
    throw new ForbiddenError("scope_mismatch", "The envelope tenant does not match your session.");
  }
  const connector = getConnector(parsed.data.source);
  if (!connector) {
    throw new ValidationError(`No connector is registered for source '${parsed.data.source}'.`);
  }
  // Capture sources (chrome_extension) are a scraping abuse vector — throttle by RECORD VOLUME per caller (on top
  // of the coarse /api rate limit) BEFORE the connector validates. Additive: only reached when chrome_extension is
  // registered (its flag is on); every server-side source is byte-identical. Fails open on a Redis outage.
  if (parsed.data.source === "chrome_extension") {
    await checkCaptureRate(`ingest:${c.get("claims").sub}`, parsed.data.records.length);
  }
  // Re-pin the scope to the token (workspaceId from the session when present) before the connector sees it.
  const envelope = {
    ...parsed.data,
    scope: { tenantId, workspaceId: workspaceId ?? parsed.data.scope.workspaceId },
  };
  connector.validateEnvelope(envelope);
  const observations = connector.toRawObservations(envelope);
  // v1 acks with the accepted count. The per-connector async processing (evidence -> resolve -> enrich -> land)
  // is a later slice; this endpoint is additive and leaves the existing /import path byte-identical.
  return c.json({ accepted: true, source: envelope.source, records: observations.length }, 202);
});
