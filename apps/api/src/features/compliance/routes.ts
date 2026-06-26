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
import {
  platformAuditReadRepository,
  suppressionRepository,
  withPlatformTx,
  withTenantTx,
} from "@leadwolf/db";
import {
  ForbiddenError,
  type TenantStaffAccess,
  ValidationError,
  consentCreateSchema,
  dsarIntakeSchema,
  suppressionCreateSchema,
} from "@leadwolf/types";
import { Hono } from "hono";
import { authn } from "../../middleware/authn.ts";
import { requireOrgRole } from "../../middleware/requireOrgRole.ts";
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

complianceRoutes.post("/suppression", requireRole("owner", "admin"), async (c) => {
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

// List the caller's manageable suppression entries (tenant + workspace scope; global rows excluded). The
// response never includes the email/phone blind indexes (HMACs of PII) — see suppressionRepository.list.
complianceRoutes.get("/suppression", async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId) throw new ForbiddenError("no_workspace");
  const rows = await withTenantTx({ tenantId: c.get("tenantId"), workspaceId }, (tx) =>
    suppressionRepository.list(tx),
  );
  return c.json({
    entries: rows.map((r) => ({
      id: r.id,
      scope: r.scope,
      match_type: r.matchType,
      domain: r.domain,
      contact_id: r.contactId,
      reason: r.reason,
      created_at: r.createdAt.toISOString(),
    })),
  });
});

// Remove one suppression entry. RLS limits removal to the caller's own scope, so a foreign/global id is a
// no-op (not an error). Every removal is audited in the same transaction (suppression.remove).
complianceRoutes.delete("/suppression/:id", requireRole("owner", "admin"), async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId) throw new ForbiddenError("no_workspace");
  const id = c.req.param("id");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new ValidationError("Invalid suppression id.");
  }
  await withTenantTx({ tenantId: c.get("tenantId"), workspaceId }, async (tx) => {
    await suppressionRepository.removeByIds(tx, [id]);
    await writeAudit(tx, {
      tenantId: c.get("tenantId"),
      workspaceId,
      actorUserId: c.get("claims").sub,
      action: "suppression.remove",
      entityType: "suppression_list",
      entityId: id,
      metadata: {},
    });
  });
  return c.body(null, 204);
});

complianceRoutes.post("/consent", requireRole("owner", "admin", "member"), async (c) => {
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

// owner/admin only: a withdrawal auto-inserts a GLOBAL suppression row (consent.ts → addGlobalSuppression),
// so it must not be looser than the direct owner/admin suppression writes it effectively triggers.
complianceRoutes.post("/consent/:contactId/withdraw", requireRole("owner", "admin"), async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId) throw new ForbiddenError("no_workspace");
  const result = await withdrawConsent(
    { tenantId: c.get("tenantId"), workspaceId },
    c.req.param("contactId"),
    c.get("claims").sub,
  );
  return c.json(result, 200);
});

// ── Customer-visible staff-access log (list-plan/07 §5, D2 — "the customer can see staff looking") ───────
// A tenant-admin reads the staff record-/data-level accesses to THEIR tenant's data (who, what, which list,
// when) — the trust-transparency surface promised by the privacy-first staff model. Tenant-admin-gated
// (compliance_admin / security_admin; owner implies). The tenant id comes from the VERIFIED session
// (`c.get("tenantId")`), never the request body — a customer can only ever see their OWN tenant's rows.
//
// The read goes through withPlatformTx — the DB-OWNER connection, the ONLY path that can read
// `platform_audit_log` (it is REVOKEd from + RLS-deny-all to leadwolf_app, and we deliberately keep it that
// way; the customer app role never touches the table). The owner connection is RLS-EXEMPT on every
// deployment (the table is ENABLE-not-FORCE, owner is the writer), so unlike leadwolf_admin (which is not
// BYPASSRLS on managed Postgres and would fail CLOSED) this read works on Neon/RDS/local alike. The read is
// tenant-FILTERED + action-allow-listed in the repository and projects only the transparency fields (no
// staff ip, no metadata). withPlatformTx additionally writes its own append-only audit row, so the
// customer's act of reading the staff-access trail is itself recorded (`compliance.read_staff_access`).
complianceRoutes.get(
  "/staff-access-log",
  requireOrgRole("compliance_admin", "security_admin"),
  async (c) => {
    const tenantId = c.get("tenantId");
    const actor = {
      userId: c.get("claims").sub,
      ip: c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    };
    const rows = await withPlatformTx(
      actor,
      "compliance.read_staff_access",
      (tx) => platformAuditReadRepository.listTenantStaffAccess(tx, tenantId),
      { targetType: "tenant", targetId: tenantId, tenantId },
    );
    const entries: TenantStaffAccess[] = rows.map((r) => ({
      id: r.id,
      actorUserId: r.actorUserId,
      action: r.action,
      targetType: r.targetType,
      targetId: r.targetId,
      occurredAt: r.occurredAt.toISOString(),
    }));
    return c.json({ entries });
  },
);
