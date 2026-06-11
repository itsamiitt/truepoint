// routes.ts — HTTP wiring for the compliance domain (08 §2/§3/§4, 09): workspace/tenant suppression CRUD,
// consent record/withdraw, and the PUBLIC self-serve DSAR intake (no session — rate-limited; identity
// verification + processing are the privileged staff workflow). Transport only; gates, fan-out, and the
// privileged path live in core/db.

import {
  blindIndex,
  createDsarRequest,
  recordConsent,
  withdrawConsent,
  writeAudit,
} from "@leadwolf/core";
import { suppressionRepository, withTenantTx } from "@leadwolf/db";
import {
  ForbiddenError,
  ValidationError,
  consentCreateSchema,
  dsarIntakeSchema,
  suppressionCreateSchema,
} from "@leadwolf/types";
import { Hono } from "hono";
import { authn } from "../../middleware/authn.ts";
import { type TenancyVariables, tenancy } from "../../middleware/tenancy.ts";

// ── Public DSAR intake (08 §4) — deliberately session-less; throttled by the global /api limiter ───────
export const dsarPublicRoutes = new Hono();

dsarPublicRoutes.post("/", async (c) => {
  const parsed = dsarIntakeSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ValidationError("Body must be { request_type, email }.");
  const id = await createDsarRequest(parsed.data.request_type, parsed.data.email);
  return c.json({ id, status: "received" }, 202);
});

// ── Authenticated compliance surface (suppression + consent) ───────────────────────────────────────────
export const complianceRoutes = new Hono<{ Variables: TenancyVariables }>();

complianceRoutes.use("*", authn);
complianceRoutes.use("*", tenancy);

complianceRoutes.post("/suppression", async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId) throw new ForbiddenError("no_workspace");
  const parsed = suppressionCreateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ValidationError("Invalid suppression entry.");
  const body = parsed.data;

  // The match key must be present for the declared match_type (mirrors the DB CHECK).
  const entry = {
    scope: body.scope,
    tenantId: c.get("tenantId"),
    workspaceId: body.scope === "workspace" ? workspaceId : null,
    matchType: body.match_type,
    emailBlindIndex:
      body.match_type === "email" && body.email
        ? blindIndex(body.email.trim().toLowerCase())
        : null,
    domain: body.match_type === "domain" ? (body.domain ?? null) : null,
    contactId: body.match_type === "contact_id" ? (body.contact_id ?? null) : null,
    reason: body.reason ?? null,
    createdByUserId: c.get("claims").sub,
  };
  if (!entry.emailBlindIndex && !entry.domain && !entry.contactId) {
    throw new ValidationError("The match key for the declared match_type is required.");
  }

  const id = await withTenantTx({ tenantId: c.get("tenantId"), workspaceId }, async (tx) => {
    const created = await suppressionRepository.insert(tx, entry);
    await writeAudit(tx, {
      tenantId: c.get("tenantId"),
      workspaceId,
      actorUserId: c.get("claims").sub,
      action: "suppression.add",
      entityType: "suppression_list",
      entityId: created,
      metadata: { scope: entry.scope, matchType: entry.matchType },
    });
    return created;
  });
  return c.json({ id }, 201);
});

complianceRoutes.post("/consent", async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId) throw new ForbiddenError("no_workspace");
  const parsed = consentCreateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ValidationError("Invalid consent record.");
  const id = await recordConsent(
    { tenantId: c.get("tenantId"), workspaceId },
    {
      contactId: parsed.data.contact_id,
      jurisdiction: parsed.data.jurisdiction.toUpperCase(),
      lawfulBasis: parsed.data.lawful_basis,
      source: parsed.data.source ?? null,
      recordedByUserId: c.get("claims").sub,
    },
  );
  return c.json({ id }, 201);
});

complianceRoutes.post("/consent/:contactId/withdraw", async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId) throw new ForbiddenError("no_workspace");
  const result = await withdrawConsent(
    { tenantId: c.get("tenantId"), workspaceId },
    c.req.param("contactId"),
    c.get("claims").sub,
  );
  return c.json(result, 200);
});
