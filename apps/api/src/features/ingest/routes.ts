// routes.ts — the UNIFIED INGESTION entry (prospect-database-platform Phase 03 / I2; mounted at /api/v1/ingest).
// Transport only: the scope comes from the VERIFIED token (never the body), the body is validated against the
// shared `ingestionEnvelope` Zod, the source's CONNECTOR is looked up in @leadwolf/core's registry and runs its
// source-specific validation, and the endpoint returns a job handle. ADDITIVE — a NEW endpoint that does not touch
// the existing /import path or runImport. The async processing pipeline (evidence -> resolve -> enrich -> land) is
// wired per connector in later slices (audit P05); v1 validates + accepts.
import { checkCaptureRate } from "@leadwolf/auth";
import { env } from "@leadwolf/config";
import {
  fetchAndLandUrl,
  getConnector,
  linkedinUrlKey,
  registerBuiltinConnectors,
} from "@leadwolf/core";
import { contactRepository, sourceFetchRegistryRepository, withPrivilegedTx } from "@leadwolf/db";
import {
  ForbiddenError,
  type LinkFetchAck,
  ValidationError,
  ingestionEnvelope,
  linkCaptureRequestSchema,
  linkFetchAckSchema,
} from "@leadwolf/types";
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

/**
 * POST /api/v1/ingest/linkedin-links — the extension's Sales-Nav URL harvest (docs/planning ecosystem).
 * Writes ONLY the fetch registry (source_fetch_registry, 0118); never fetches inline. URLs are canonicalized
 * server-side (linkedinUrlKey), so lead/people/slug forms of one profile collapse to one target. Dark behind
 * LINKEDIN_LINK_CAPTURE_ENABLED; the extension-scope allow-list gates who may call it. Abuse-throttled by
 * URL volume like the capture connector.
 */
ingestRoutes.post("/linkedin-links", async (c) => {
  if (!env.LINKEDIN_LINK_CAPTURE_ENABLED) {
    throw new ValidationError("Link capture is not enabled.");
  }
  const parsed = linkCaptureRequestSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues[0]?.message ?? "Invalid link capture body.");
  }
  await checkCaptureRate(`links:${c.get("claims").sub}`, parsed.data.urls.length);

  // Canonicalize + dedup within the batch; unrecognized (search/list) URLs are dropped, not errored.
  const targets = new Map<
    string,
    { entityKind: "person" | "company"; url: string; ext: string | null }
  >();
  for (const item of parsed.data.urls) {
    const key = linkedinUrlKey(item.url);
    if (!key) continue;
    targets.set(`${key.entityKind}:${key.normalizedUrl}`, {
      entityKind: key.entityKind,
      url: key.normalizedUrl,
      ext: key.externalId,
    });
  }
  let registered = 0;
  for (const t of targets.values()) {
    await withPrivilegedTx((tx) =>
      sourceFetchRegistryRepository.registerUrl(tx, {
        entityKind: t.entityKind,
        normalizedUrl: t.url,
        externalId: t.ext,
      }),
    );
    registered += 1;
  }
  return c.json({ accepted: true, registered, dropped: parsed.data.urls.length - registered }, 202);
});

/**
 * POST /api/v1/ingest/linkedin-links/:kind/fetch — the fetch-on-view fast path (docs/planning ecosystem).
 * Body `{ url }`. Registers + (unless fresh within 30d) fetches the licensed document and lands it, then
 * re-resolves the caller's tenant contact so the hover card can read the intel back. Fresh URL ⇒ no vendor
 * call. Dark behind LINKEDIN_LINK_FETCH_ENABLED.
 */
ingestRoutes.post("/linkedin-links/:kind/fetch", async (c) => {
  if (!env.LINKEDIN_LINK_FETCH_ENABLED) {
    throw new ValidationError("Link fetch is not enabled.");
  }
  const kindParam = c.req.param("kind");
  if (kindParam !== "person" && kindParam !== "company") {
    throw new ValidationError("kind must be 'person' or 'company'.");
  }
  const body = (await c.req.json().catch(() => null)) as { url?: unknown } | null;
  if (!body || typeof body.url !== "string") throw new ValidationError("Body must be { url }.");
  const key = linkedinUrlKey(body.url);
  if (!key || key.entityKind !== kindParam) {
    const ack: LinkFetchAck = { outcome: "not_a_target", contactId: null, accountId: null };
    return c.json(linkFetchAckSchema.parse(ack));
  }

  await checkCaptureRate(`link-fetch:${c.get("claims").sub}`, 1);
  const result = await fetchAndLandUrl({
    entityKind: key.entityKind,
    normalizedUrl: key.normalizedUrl,
  });

  // Re-resolve to the caller's tenant contact (the by-linkedin resolver) so the card can address the intel
  // reads by contactId. A profile the workspace does not hold in its CRM lands golden data but has no
  // contactId — the card then offers "add to workspace" (the reveal-miss posture).
  const claims = c.get("claims");
  let contactId: string | null = null;
  if (key.entityKind === "person" && key.externalId && claims.wid) {
    const contact = await contactRepository.resolveByLinkedinPublicId(
      { tenantId: claims.tid, workspaceId: claims.wid },
      key.externalId,
    );
    contactId = contact?.id ?? null;
  }
  const ack: LinkFetchAck = { outcome: result.outcome, contactId, accountId: null };
  return c.json(linkFetchAckSchema.parse(ack));
});
