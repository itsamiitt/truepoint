// routes.ts — platform super-admin API (ADR-0032). authn + platformAdmin, NO tenancy: the caller reads
// ACROSS all tenants/workspaces via the audited withPlatformTx (the owner-role RLS bypass). Every read is
// recorded in platform_audit_log; results are bounded (PLATFORM_READ_LIMIT) — no unbounded cross-tenant
// scans. Transport only: the bounded read shapes live in @leadwolf/db (platformAdminRepository). This is the
// highest-privilege surface in the api; nothing reaches it without pa===true.
import { evaluateFlagsForTenant } from "@leadwolf/core";
import {
  PLATFORM_READ_LIMIT,
  accountHoldRepository,
  authPolicyRepository,
  featureFlagRepository,
  idempotencyRepository,
  jitElevationRepository,
  planTemplateRepository,
  platformAdminRepository,
  platformAdminWriteRepository,
  platformBillingReadRepository,
  platformDataQualityReadRepository,
  platformStaffRepository,
  platformTrustReadRepository,
  retentionClassPolicyRepository,
  supportNoteRepository,
  withPlatformTx,
} from "@leadwolf/db";
import {
  type AccountHoldView,
  ElevationRequiredError,
  LIST_PLATFORM_AUDIT_ACTIONS,
  NotFoundError,
  type StaffListOverview,
  type SupportNoteView,
  ValidationError,
  capabilitiesForRole,
  createSupportNoteSchema,
  creditAdjustSchema,
  featureFlagGlobalToggleSchema,
  featureFlagTenantToggleSchema,
  featureFlagUpsertSchema,
  placeAccountHoldSchema,
  planOverrideSchema,
  platformListQuerySchema,
  retentionPolicySchema,
  retentionPolicyUpdateSchema,
  setAuthEnforcementSchema,
  tenantStatusChangeSchema,
  userStatusChangeSchema,
} from "@leadwolf/types";
import { type Context, Hono } from "hono";
import { type ApiVariables, authn } from "../../middleware/authn.ts";
import { platformAdmin } from "../../middleware/platformAdmin.ts";
import { requireCapability } from "../../middleware/requireCapability.ts";
import { requireStaffRole } from "../../middleware/requireStaffRole.ts";
import { announcementRoutes } from "./announcements.ts";
import { auditLogRoutes } from "./auditLog.ts";
import { billingRoutes } from "./billing.ts";
import { complianceRoutes } from "./compliance.ts";
import { elevationRoutes } from "./elevations.ts";
import { impersonationRoutes } from "./impersonation.ts";
import { pricingRoutes } from "./pricing.ts";
import { providerConfigRoutes } from "./providerConfigs.ts";
import { staffRoutes } from "./staff.ts";
import { type SystemHealthProbe, probeQueues } from "./systemHealthProbes.ts";

// Accept any RFC-4122-shaped UUID (incl. the v7 ids this app mints) for path-param validation.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const adminRoutes = new Hono<{ Variables: ApiVariables }>();

adminRoutes.use("*", authn);
adminRoutes.use("*", platformAdmin);

const actorOf = (c: Context<{ Variables: ApiVariables }>) => ({
  userId: c.get("claims").sub,
  ip: c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
});

// ── Who am I (13a F3) — the caller's active staff role + the capabilities it grants. The console fetches this
// once to hide actions the operator can't perform (defence-in-depth; every endpoint still enforces its own
// gate). A plain role lookup, not a cross-tenant data read, so it is unaudited (the caller reading their own
// access). Returns role=null + no capabilities for a `pa` holder without an active platform_staff row. ──
adminRoutes.get("/me", async (c) => {
  const role = await platformStaffRepository.getActiveRole(c.get("claims").sub);
  return c.json({ staffRole: role ?? null, capabilities: role ? capabilitiesForRole(role) : [] });
});

adminRoutes.get("/workspaces", async (c) => {
  const workspaces = await withPlatformTx(actorOf(c), "admin.list_workspaces", (tx) =>
    platformAdminRepository.listWorkspaces(tx),
  );
  return c.json({ workspaces });
});

adminRoutes.get("/users", async (c) => {
  const parsed = platformListQuerySchema.safeParse({
    search: c.req.query("search"),
    status: c.req.query("status"),
    cursor: c.req.query("cursor"),
    limit: c.req.query("limit"),
  });
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message);
  const { rows, nextCursor } = await withPlatformTx(actorOf(c), "admin.list_users", (tx) =>
    platformAdminRepository.listUsers(tx, parsed.data),
  );
  return c.json({ users: rows, nextCursor });
});

// ── Global user management (13a Area 2, 13 §3.2) ───────────────────────────────────────────────────────
// Deactivate / reactivate a global user across tenants. super_admin or support. Same audited-write discipline
// as the tenant lifecycle ops: withPlatformTx (in-tx platform_audit_log), UUID-validated before the tx, a
// mandatory reason. Two lockout rails on deactivate: the caller cannot deactivate THEMSELVES (a clean 422
// before the tx), and a platform-staff target is refused in-tx (revoke the staff role first) — both roll the
// audit row back. (reset-MFA / force-reset / revoke-sessions reuse the packages/auth primitives in a later slice.)

/** Deactivate a global user (status → suspended). Needs users:deactivate. Audited "user.deactivate". */
adminRoutes.post("/users/:id/deactivate", requireCapability("users:deactivate"), async (c) => {
  const userId = c.req.param("id");
  if (!UUID_RE.test(userId)) throw new ValidationError("id must be a UUID");
  if (userId === c.get("claims").sub)
    throw new ValidationError("You cannot deactivate your own account.");
  const parsed = userStatusChangeSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message);
  await withPlatformTx(
    actorOf(c),
    "user.deactivate",
    async (tx) => {
      const res = await platformAdminWriteRepository.setUserStatus(tx, userId, "suspended", {
        blockPlatformAdmin: true,
      });
      if (!res.found) throw new NotFoundError("User not found.");
      if (res.blockedPlatformAdmin)
        throw new ValidationError(
          "Cannot deactivate a platform-staff account; revoke the staff role first.",
        );
    },
    { targetType: "user", targetId: userId, metadata: { reason: parsed.data.reason } },
  );
  return c.json({ ok: true, userId, status: "suspended" });
});

/** Reactivate a suspended user (status → active). Needs users:deactivate. Audited "user.reactivate". */
adminRoutes.post("/users/:id/reactivate", requireCapability("users:deactivate"), async (c) => {
  const userId = c.req.param("id");
  if (!UUID_RE.test(userId)) throw new ValidationError("id must be a UUID");
  const parsed = userStatusChangeSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message);
  await withPlatformTx(
    actorOf(c),
    "user.reactivate",
    async (tx) => {
      const res = await platformAdminWriteRepository.setUserStatus(tx, userId, "active", {
        blockPlatformAdmin: false,
      });
      if (!res.found) throw new NotFoundError("User not found.");
    },
    { targetType: "user", targetId: userId, metadata: { reason: parsed.data.reason } },
  );
  return c.json({ ok: true, userId, status: "active" });
});

// ── Tenants directory (13 §3.1) — plan / status / seats / credits per org; searchable + keyset-paged (F5). ──
adminRoutes.get("/tenants", async (c) => {
  const parsed = platformListQuerySchema.safeParse({
    search: c.req.query("search"),
    status: c.req.query("status"),
    cursor: c.req.query("cursor"),
    limit: c.req.query("limit"),
  });
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message);
  const { rows, nextCursor } = await withPlatformTx(actorOf(c), "admin.list_tenants", (tx) =>
    platformAdminRepository.listTenants(tx, parsed.data),
  );
  return c.json({ tenants: rows, nextCursor });
});

// ── Tenant detail (13 §3.1) — the org plus its workspaces + members. Each list is bounded. ──
adminRoutes.get("/tenants/:id", async (c) => {
  const tenantId = c.req.param("id");
  const detail = await withPlatformTx(
    actorOf(c),
    "admin.get_tenant",
    (tx) => platformAdminRepository.getTenantDetail(tx, tenantId),
    { targetType: "tenant", targetId: tenantId, tenantId },
  );
  if (!detail) throw new NotFoundError("Tenant not found.");
  return c.json(detail);
});

// ── Customer-360 overview (13a Area 3, 13 §3.3) — a tenant's reveal activity + active holds at a glance, for
// support. Broad read (any staff tier); audited. PII-free aggregate. ──
adminRoutes.get(
  "/tenants/:id/overview",
  requireStaffRole("super_admin", "support", "compliance_officer", "read_only"),
  async (c) => {
    const tenantId = c.req.param("id");
    if (!UUID_RE.test(tenantId)) throw new ValidationError("id must be a UUID");
    const o = await withPlatformTx(
      actorOf(c),
      "admin.tenant_overview",
      (tx) => platformAdminRepository.getTenantOverview(tx, tenantId),
      { targetType: "tenant", targetId: tenantId, tenantId },
    );
    return c.json({
      reveals30d: o.reveals30d,
      burn30d: o.burn30d,
      revealsTotal: o.revealsTotal,
      lastRevealAt: o.lastRevealAt ? o.lastRevealAt.toISOString() : null,
      activeHolds: o.activeHolds,
    });
  },
);

// ── Tenant lifecycle + manual credit ops (13a Area 1, 13 §3.1) ─────────────────────────────────────────
// These are the first cross-tenant WRITES on the admin surface. Each runs through withPlatformTx (owner
// visibility + an in-tx platform_audit_log row), is gated by the doc-13 capability matrix, validates the id
// as a UUID BEFORE the tx (a malformed id is a clean 422 with no audit row), and records a mandatory reason.
// A no-op write (unknown id / would-overdraw) throws INSIDE the tx so the audit row rolls back — no trace for
// an action that did not happen (the feature_flag-404 discipline). JIT elevation (13a F1) layers on later.

/** Suspend an org. super_admin only (the action gates the whole tenant). JIT-gated (13a F1): consumes a live
 *  "tenant.suspend" elevation for this tenant in-tx; without one → 403 elevation_required. Audited "tenant.suspend". */
adminRoutes.post("/tenants/:id/suspend", requireCapability("tenants:suspend"), async (c) => {
  const tenantId = c.req.param("id");
  if (!UUID_RE.test(tenantId)) throw new ValidationError("id must be a UUID");
  const parsed = tenantStatusChangeSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message);
  const actor = actorOf(c);
  await withPlatformTx(
    actor,
    "tenant.suspend",
    async (tx) => {
      const elevated = await jitElevationRepository.consume(tx, {
        staffUserId: actor.userId,
        action: "tenant.suspend",
        targetTenantId: tenantId,
      });
      if (!elevated) throw new ElevationRequiredError("tenant.suspend");
      const touched = await platformAdminWriteRepository.setTenantStatus(tx, tenantId, "suspended");
      if (touched === 0) throw new NotFoundError("Tenant not found.");
    },
    {
      targetType: "tenant",
      targetId: tenantId,
      tenantId,
      metadata: { reason: parsed.data.reason },
    },
  );
  return c.json({ ok: true, tenantId, status: "suspended" });
});

/** Reactivate a suspended org. super_admin only. Audited "tenant.reactivate". */
adminRoutes.post("/tenants/:id/reactivate", requireCapability("tenants:suspend"), async (c) => {
  const tenantId = c.req.param("id");
  if (!UUID_RE.test(tenantId)) throw new ValidationError("id must be a UUID");
  const parsed = tenantStatusChangeSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message);
  await withPlatformTx(
    actorOf(c),
    "tenant.reactivate",
    async (tx) => {
      const touched = await platformAdminWriteRepository.setTenantStatus(tx, tenantId, "active");
      if (touched === 0) throw new NotFoundError("Tenant not found.");
    },
    {
      targetType: "tenant",
      targetId: tenantId,
      tenantId,
      metadata: { reason: parsed.data.reason },
    },
  );
  return c.json({ ok: true, tenantId, status: "active" });
});

/** Manual credit grant / adjustment (07 §7). super_admin or billing_ops. A positive delta is a "credit.grant",
 *  a negative one a "credit.adjust" — the immutable trail names the actual operation, not a generic "grant".
 *  JIT-gated (13a F1): consumes a live "credit.adjust" elevation for this tenant in-tx; without one → 403
 *  elevation_required. The repo's FOR UPDATE + the DB CHECK(>=0) are the overdraft guards; a would-overdraw
 *  debit is a clean 422 (and rolls the consumed elevation back, so the operator can retry). */
adminRoutes.post("/tenants/:id/credits", requireCapability("tenants:credits"), async (c) => {
  const tenantId = c.req.param("id");
  if (!UUID_RE.test(tenantId)) throw new ValidationError("id must be a UUID");
  const parsed = creditAdjustSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message);
  const { delta, reason } = parsed.data;
  const actor = actorOf(c);

  // Idempotency-Key replay (ADR-0004/0007): a network retry must NOT 403 on the already-consumed JIT
  // elevation (nor re-grant) — if this (tenant, key) already committed, replay its stored response without
  // re-running the grant or writing a second audit row. Owner-path read (no tenancy context on this surface).
  const idemKey = c.req.header("idempotency-key");
  if (idemKey) {
    const replay = await idempotencyRepository.findOwner(tenantId, idemKey);
    if (replay) {
      return c.json(
        replay.responseBody as { tenantId: string; delta: number; balanceAfter: number },
      );
    }
  }

  const balanceAfter = await withPlatformTx(
    actor,
    delta > 0 ? "credit.grant" : "credit.adjust",
    async (tx) => {
      const elevated = await jitElevationRepository.consume(tx, {
        staffUserId: actor.userId,
        action: "credit.adjust",
        targetTenantId: tenantId,
      });
      if (!elevated) throw new ElevationRequiredError("credit.adjust");
      const res = await platformAdminWriteRepository.adjustCredits(tx, tenantId, delta);
      if (!res.found) throw new NotFoundError("Tenant not found.");
      if (res.wouldOverdraw)
        throw new ValidationError(
          `This adjustment would overdraw the balance (current ${res.balanceAfter}).`,
          { balance: res.balanceAfter },
        );
      // Record the replay row IN-tx so the key commits atomically with the grant + its audit row.
      if (idemKey) {
        await idempotencyRepository.storeOwner(tx, tenantId, idemKey, {
          responseStatus: 200,
          responseBody: { tenantId, delta, balanceAfter: res.balanceAfter },
        });
      }
      return res.balanceAfter;
    },
    { targetType: "tenant", targetId: tenantId, tenantId, metadata: { delta, reason } },
  );
  return c.json({ tenantId, delta, balanceAfter });
});

// ── Plan override (13a Area 1, 13 §3.1, 07 §5) — apply a plan TEMPLATE's entitlements (plan id / seat &
// workspace caps / feature flags) to a tenant. A sensitive entitlement change → super_admin-only via the
// tenants:plan capability; withPlatformTx-audited "plan.override". The template is read + applied in one tx
// (an unknown template rolls the audit row back). Does not grant credits — the monthly grant is the job's. ──
adminRoutes.post("/tenants/:id/plan", requireCapability("tenants:plan"), async (c) => {
  const tenantId = c.req.param("id");
  if (!UUID_RE.test(tenantId)) throw new ValidationError("id must be a UUID");
  const parsed = planOverrideSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message);
  await withPlatformTx(
    actorOf(c),
    "plan.override",
    async (tx) => {
      const template = await planTemplateRepository.getByKey(tx, parsed.data.templateKey);
      if (!template) throw new NotFoundError(`Unknown plan template '${parsed.data.templateKey}'.`);
      const touched = await platformAdminWriteRepository.applyPlan(tx, tenantId, {
        plan: template.key,
        seatLimit: template.seatLimit,
        workspaceLimit: template.workspaceLimit,
        features: template.features,
      });
      if (touched === 0) throw new NotFoundError("Tenant not found.");
    },
    {
      targetType: "tenant",
      targetId: tenantId,
      tenantId,
      metadata: { templateKey: parsed.data.templateKey },
    },
  );
  return c.json({ ok: true, tenantId, plan: parsed.data.templateKey });
});

// ── Support notes (13a Area 3, 13 §3.3) — internal staff notes about a tenant, with an optional ticket link.
// Read by the support-facing roles; written by super_admin|support (audited "support_note.add"). Staff-only
// data — never surfaced to the customer (deny-all RLS + REVOKE). ──
function toNoteView(r: {
  id: string;
  tenantId: string;
  staffUserId: string;
  body: string;
  ticketUrl: string | null;
  createdAt: Date;
}): SupportNoteView {
  return {
    id: r.id,
    tenantId: r.tenantId,
    staffUserId: r.staffUserId,
    body: r.body,
    ticketUrl: r.ticketUrl,
    createdAt: r.createdAt.toISOString(),
  };
}

adminRoutes.get(
  "/tenants/:id/notes",
  requireStaffRole("super_admin", "support", "compliance_officer", "read_only"),
  async (c) => {
    const tenantId = c.req.param("id");
    if (!UUID_RE.test(tenantId)) throw new ValidationError("id must be a UUID");
    const notes = await withPlatformTx(
      actorOf(c),
      "admin.list_support_notes",
      async (tx) => (await supportNoteRepository.listForTenant(tx, tenantId)).map(toNoteView),
      { targetType: "tenant", targetId: tenantId, tenantId },
    );
    return c.json({ notes });
  },
);

adminRoutes.post("/tenants/:id/notes", requireCapability("tenants:notes:write"), async (c) => {
  const tenantId = c.req.param("id");
  if (!UUID_RE.test(tenantId)) throw new ValidationError("id must be a UUID");
  const parsed = createSupportNoteSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message);
  const actor = actorOf(c);
  const note = await withPlatformTx(
    actor,
    "support_note.add",
    (tx) =>
      supportNoteRepository.add(tx, {
        tenantId,
        staffUserId: actor.userId,
        body: parsed.data.body,
        ticketUrl: parsed.data.ticketUrl ?? null,
      }),
    { targetType: "tenant", targetId: tenantId, tenantId },
  );
  return c.json({ note: toNoteView(note) });
});

// ── Account holds (13a Area 7, 13 §3.7) — abuse / fraud / payment holds on a tenant. The abuse-review flag,
// distinct from suspend (Area 1). Read by the support-facing roles; placed / lifted by tenants:hold
// (super_admin|support), audited ("account.hold" / "account.hold.lift"). Staff-only (deny-all RLS). ──
function toHoldView(r: {
  id: string;
  tenantId: string;
  kind: string;
  reason: string;
  placedByUserId: string;
  placedAt: Date;
  liftedAt: Date | null;
  liftedByUserId: string | null;
}): AccountHoldView {
  return {
    id: r.id,
    tenantId: r.tenantId,
    kind: r.kind as AccountHoldView["kind"],
    reason: r.reason,
    placedByUserId: r.placedByUserId,
    placedAt: r.placedAt.toISOString(),
    liftedAt: r.liftedAt ? r.liftedAt.toISOString() : null,
    liftedByUserId: r.liftedByUserId,
  };
}

adminRoutes.get(
  "/tenants/:id/holds",
  requireStaffRole("super_admin", "support", "compliance_officer", "read_only"),
  async (c) => {
    const tenantId = c.req.param("id");
    if (!UUID_RE.test(tenantId)) throw new ValidationError("id must be a UUID");
    const holds = await withPlatformTx(
      actorOf(c),
      "admin.list_holds",
      async (tx) => (await accountHoldRepository.listForTenant(tx, tenantId)).map(toHoldView),
      { targetType: "tenant", targetId: tenantId, tenantId },
    );
    return c.json({ holds });
  },
);

adminRoutes.post("/tenants/:id/holds", requireCapability("tenants:hold"), async (c) => {
  const tenantId = c.req.param("id");
  if (!UUID_RE.test(tenantId)) throw new ValidationError("id must be a UUID");
  const parsed = placeAccountHoldSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message);
  const actor = actorOf(c);
  const hold = await withPlatformTx(
    actor,
    "account.hold",
    (tx) =>
      accountHoldRepository.place(tx, {
        tenantId,
        kind: parsed.data.kind,
        reason: parsed.data.reason,
        placedByUserId: actor.userId,
      }),
    { targetType: "tenant", targetId: tenantId, tenantId, metadata: { kind: parsed.data.kind } },
  );
  return c.json({ hold: toHoldView(hold) });
});

adminRoutes.post(
  "/tenants/:id/holds/:holdId/lift",
  requireCapability("tenants:hold"),
  async (c) => {
    const tenantId = c.req.param("id");
    const holdId = c.req.param("holdId");
    if (!UUID_RE.test(tenantId) || !UUID_RE.test(holdId))
      throw new ValidationError("id must be a UUID");
    const actor = actorOf(c);
    await withPlatformTx(
      actor,
      "account.hold.lift",
      async (tx) => {
        const touched = await accountHoldRepository.lift(tx, tenantId, holdId, actor.userId);
        if (touched === 0) throw new NotFoundError("Active hold not found.");
      },
      { targetType: "tenant", targetId: tenantId, tenantId, metadata: { holdId } },
    );
    return c.json({ ok: true, holdId });
  },
);

// ── Purchases + refunds (13a Area 4, 13 §3.4, 07 §6/§7) — a tenant's credit-pack purchases and an audited
// refund (reverse the credits + mark refunded). Read = billing:read; refund = tenants:credits (a credit move).
// The refund clamps to the available balance (the bare counter can't go negative). ──
adminRoutes.get("/tenants/:id/purchases", requireCapability("billing:read"), async (c) => {
  const tenantId = c.req.param("id");
  if (!UUID_RE.test(tenantId)) throw new ValidationError("id must be a UUID");
  const purchases = await withPlatformTx(
    actorOf(c),
    "admin.list_purchases",
    async (tx) =>
      (await platformBillingReadRepository.listPurchases(tx, tenantId)).map((p) => ({
        id: p.id,
        credits: p.credits,
        amountCents: p.amountCents,
        status: p.status,
        createdAt: p.createdAt.toISOString(),
      })),
    { targetType: "tenant", targetId: tenantId, tenantId },
  );
  return c.json({ purchases });
});

adminRoutes.post(
  "/tenants/:id/purchases/:purchaseId/refund",
  requireCapability("tenants:credits"),
  async (c) => {
    const tenantId = c.req.param("id");
    const purchaseId = c.req.param("purchaseId");
    if (!UUID_RE.test(tenantId) || !UUID_RE.test(purchaseId))
      throw new ValidationError("id must be a UUID");
    const result = await withPlatformTx(
      actorOf(c),
      "credit.adjust",
      async (tx) => {
        const r = await platformAdminWriteRepository.refundPurchase(tx, tenantId, purchaseId);
        if (!r.found) throw new NotFoundError("Purchase not found.");
        if (r.alreadyRefunded) throw new ValidationError("Purchase is already refunded.");
        return { reversed: r.reversed, balanceAfter: r.balanceAfter };
      },
      {
        targetType: "tenant",
        targetId: tenantId,
        tenantId,
        metadata: { purchaseId, action: "refund" },
      },
    );
    return c.json({ purchaseId, reversed: result.reversed, balanceAfter: result.balanceAfter });
  },
);

// ── Staff lists-overview (list-plan/07 §3.1, D2) — the PRIVACY-FIRST staff view of a tenant's lists. ──────
// Returns per-list METADATA + an AGGREGATE member COUNT only — NO list_members, NO contact PII. This is the
// legitimate operating surface: a staff tier may see the container (name/owner/count), NONE may read its
// members here. Record-level access is reachable ONLY through break-glass impersonation (the separate
// /impersonation surface, which sets the workspace GUC under leadwolf_app).
//
// Role gate (capability matrix, list-plan/07 §2): super_admin / support / compliance_officer / read_only may
// read the full list metadata. `billing_ops` is DELIBERATELY EXCLUDED — the matrix limits billing_ops to
// "List metadata: counts only", and this surface returns names/descriptions, which exceeds that tier; the
// billing surface gets aggregate counts elsewhere (the tenants directory / usage analytics). The read runs
// through the audited withPlatformTx (an admin.list.view_metadata row names the tenant); the tenantId is
// validated as a UUID BEFORE the tx so a malformed id is a clean 422 with no audit row.
adminRoutes.get(
  "/tenants/:tenantId/lists",
  requireStaffRole("super_admin", "support", "compliance_officer", "read_only"),
  async (c) => {
    const tenantId = c.req.param("tenantId");
    if (!UUID_RE.test(tenantId)) throw new ValidationError("tenantId must be a UUID");
    const rows = await withPlatformTx(
      actorOf(c),
      LIST_PLATFORM_AUDIT_ACTIONS.viewMetadata,
      (tx) => platformAdminRepository.listTenantListsOverview(tx, tenantId),
      { targetType: "tenant", targetId: tenantId, tenantId },
    );
    const lists: StaffListOverview[] = rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      ownerUserId: r.ownerUserId,
      memberCount: r.memberCount,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }));
    return c.json({ lists });
  },
);

// ── Auth-policy enforcement master switch (P1-01) — STAFF-ONLY per-tenant enable + break-glass disable. ──
// The lockout-capable login gates (IP allowlist / allowed methods / session + idle timeout / forced-MFA
// enrollment, packages/auth) fire only when BOTH the global env master-arm AND this per-tenant switch are on.
// A super_admin enables enforcement for a VERIFIED tenant; the `enabled:false` direction IS the break-glass —
// it re-opens password/all-method login within the ≤15-min token window WITHOUT a deploy. The write is
// audited (admin.set_auth_enforcement) in the SAME withPlatformTx tx; the tenantId is validated as a UUID
// BEFORE the tx so a malformed id is a clean 422 with no audit row. Tenant security_admins can never reach
// this switch (it is absent from the tenant-editable authPolicySchema), so an org cannot self-lock-out.
adminRoutes.post(
  "/tenants/:tenantId/auth-enforcement",
  requireStaffRole("super_admin"),
  async (c) => {
    const tenantId = c.req.param("tenantId");
    if (!UUID_RE.test(tenantId)) throw new ValidationError("tenantId must be a UUID");
    const parsed = setAuthEnforcementSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message);
    const { enabled } = parsed.data;
    await withPlatformTx(
      actorOf(c),
      "admin.set_auth_enforcement",
      (tx) => authPolicyRepository.setEnforcement(tx, tenantId, enabled),
      { targetType: "tenant", targetId: tenantId, tenantId, metadata: { enabled } },
    );
    return c.json({ ok: true, tenantId, enforcementEnabled: enabled });
  },
);

// ── System health (13 §9) — service status + two complementary job views. `jobs` is the import_jobs
// CONTROL-TABLE tally (a bounded DB read, the historical queue-depth/DLQ proxy); `queues` is the LIVE BullMQ
// view (real depth/DLQ + connected-worker counts the api reads off Redis via the producer singletons, B2).
// workers/redis are now REAL probe results — no longer hardcoded "unknown"; search STAYS "unknown" (it has no
// api client to probe — do not fabricate a green check). The route never hangs (each probe is timeout-bounded)
// and never 500s on a probe failure (probeQueues always resolves; the defensive .catch degrades a total
// failure to redis:"down"/workers:"unknown" and still returns 200). ──
adminRoutes.get("/system-health", async (c) => {
  const statuses = await withPlatformTx(actorOf(c), "admin.system_health", (tx) =>
    platformAdminRepository.sampleJobStatuses(tx),
  );

  const byStatus: Record<string, number> = {};
  for (const s of statuses) byStatus[s] = (byStatus[s] ?? 0) + 1;

  const queueDepth = (byStatus.queued ?? 0) + (byStatus.running ?? 0) + (byStatus.estimating ?? 0);
  const deadLetter = byStatus.failed ?? 0;

  // Live BullMQ probe. probeQueues already absorbs per-queue failures via allSettled and always resolves; the
  // .catch is belt-and-suspenders against a synchronous singleton-construction error so the route can NEVER
  // 500 from a probe — a total failure degrades to redis:"down"/workers:"unknown" with no queue readings.
  const probe = await probeQueues().catch(
    () => ({ redis: "down", workers: "unknown", queues: [] }) as SystemHealthProbe,
  );

  return c.json({
    // The api answered this request, so it is up; database is up (the tx above ran). workers/redis are real
    // BullMQ probe results; search stays "unknown" — no api client exists to probe it (no fabricated checks).
    services: [
      { name: "api", status: "up" },
      { name: "database", status: "up" },
      { name: "workers", status: probe.workers },
      { name: "redis", status: probe.redis },
      { name: "search", status: "unknown" },
    ],
    // Live per-queue depth / DLQ (failed) / connected-worker counts; reachable:false + null counts when down.
    queues: probe.queues,
    jobs: {
      sampleSize: statuses.length,
      truncated: statuses.length >= PLATFORM_READ_LIMIT,
      byStatus,
      queueDepth,
      deadLetter,
    },
  });
});

// ── Data-quality cockpit (P5; 10 §5 Data Health + PLAN_06 re-verification) — cross-tenant DQ observability: the
// platform-wide rollup of the latest per-workspace data_quality_snapshots + the recent re-verification ledger.
// Read-only and coarse-gated (any staff, like /system-health); `admin.data_quality` is a plain withPlatformTx
// read string, deliberately NOT in the mutation enum. NON-PII — counts only, never contact rows. ──
adminRoutes.get("/data-quality", async (c) => {
  const rawDays = Number(c.req.query("days") ?? "30");
  const days = Number.isInteger(rawDays) && rawDays >= 1 && rawDays <= 365 ? rawDays : 30;
  const since = new Date(Date.now() - days * 86_400_000);
  const data = await withPlatformTx(actorOf(c), "admin.data_quality", async (tx) => {
    // Sequential — one tx is one connection; no concurrent statements on it.
    const rollup = await platformDataQualityReadRepository.rollup(tx);
    const totals = await platformDataQualityReadRepository.verificationTotals(tx, since);
    const recentRuns = await platformDataQualityReadRepository.recentVerificationRuns(
      tx,
      PLATFORM_READ_LIMIT,
    );
    return { rollup, totals, recentRuns };
  });
  return c.json({
    windowDays: days,
    rollup: {
      workspaces: data.rollup.workspaces,
      latestAt: data.rollup.latestAt ? data.rollup.latestAt.toISOString() : null,
      total: data.rollup.total,
      withEmail: data.rollup.withEmail,
      withPhone: data.rollup.withPhone,
      emailValid: data.rollup.emailValid,
      fresh: data.rollup.fresh,
      stale: data.rollup.stale,
      neverVerified: data.rollup.neverVerified,
    },
    verification: {
      totals: data.totals,
      recentRuns: data.recentRuns.map((r) => ({
        tenantId: r.tenantId,
        tenantName: r.tenantName,
        finishedAt: r.finishedAt.toISOString(),
        scanned: r.scanned,
        reverified: r.reverified,
        errored: r.errored,
      })),
    },
  });
});

// ── Trust & abuse (P6, 13 §3 abuse-ops) — cross-tenant trust signals: signup velocity (tenants/users), a
// free/disposable-email signup heuristic, active abuse/fraud holds by kind, and the tenant-status mix. Read-only,
// coarse-gated (any staff, like /system-health + /data-quality); `admin.trust_abuse` is a plain withPlatformTx
// read string, NOT in the mutation enum. NON-PII — counts only. ──
adminRoutes.get("/trust-abuse", async (c) => {
  const data = await withPlatformTx(actorOf(c), "admin.trust_abuse", async (tx) => {
    // Sequential — one tx is one connection; no concurrent statements on it.
    const signals = await platformTrustReadRepository.signals(tx);
    const holds = await platformTrustReadRepository.activeHoldsByKind(tx);
    const tenantStatus = await platformTrustReadRepository.tenantsByStatus(tx);
    return { signals, holds, tenantStatus };
  });
  return c.json(data);
});

// ── Import-jobs monitor (data-management A4; 15-bulk-import-design) — recent bulk-import jobs ACROSS all
// tenants, the staff rollout-monitoring feed for the COPY-staging pipeline. Per-job status / av-scan / row
// tallies / failure reason joined to the tenant name, newest-first + bounded (PLATFORM_READ_LIMIT). View-only
// staff tiers may read (super_admin always passes); the read runs on the audited withPlatformTx. The action
// `admin.list_import_jobs` is a READ — like admin.list_tenants / admin.list_users it is a plain withPlatformTx
// string and is deliberately NOT in the platformAuditAction mutation enum (only writes are enum-tracked).
// METADATA + tallies only (the repo selects import_jobs, never import_job_rows) — no imported contact PII
// leaves the boundary. Read-only: no actions on this surface. The repo shape is returned directly via c.json
// (no Zod schema), matching the sibling cross-tenant list reads (tenants / users / workspaces).
adminRoutes.get(
  "/import-jobs",
  requireStaffRole("super_admin", "support", "read_only"),
  async (c) => {
    const jobs = await withPlatformTx(actorOf(c), "admin.list_import_jobs", (tx) =>
      platformAdminRepository.recentImportJobs(tx),
    );
    return c.json({ jobs });
  },
);

// ── Retention-runs review (data-management A5; 16-retention-engine-design) — recent retention-engine RUNS
// ACROSS all tenants, the SHADOW evidence operators review BEFORE flipping a class to `enforce`. Per-run class /
// mode / candidate ["would delete"] + deleted tallies / cutoff / run timestamps joined to the tenant name,
// newest-first + bounded (PLATFORM_READ_LIMIT). The view-only compliance/read tiers may read (super_admin always
// passes); the read runs on the audited withPlatformTx. The action `admin.list_retention_runs` is a READ —
// like admin.list_import_jobs / admin.list_tenants it is a plain withPlatformTx string and is deliberately NOT
// in the platformAuditAction mutation enum (only writes are enum-tracked). COUNTS-only (retention_runs carries
// no contact rows / PII) — nothing sensitive leaves the boundary. Read-only: no actions on this surface. The
// repo shape is returned directly via c.json (no Zod schema), matching the sibling cross-tenant reads.
adminRoutes.get(
  "/retention-runs",
  requireStaffRole("super_admin", "compliance_officer", "read_only"),
  async (c) => {
    const runs = await withPlatformTx(actorOf(c), "admin.list_retention_runs", (tx) =>
      platformAdminRepository.recentRetentionRuns(tx),
    );
    return c.json({ runs });
  },
);

// ── Feature flags (13 §3.5, ADR-0011) ──────────────────────────────────────────────────────────────────
// All reads + writes go through withPlatformTx: cross-tenant owner visibility + an in-tx platform_audit_log
// row. Writes use the ADR-0032 platform-audit action vocabulary (feature_flag.set). Flags are global +
// per-tenant override; the customer app role is read-only on these tables (rls/featureFlags.sql).

/** List every flag with its per-tenant overrides (the admin flags screen). Two bounded queries (defs +
 *  all overrides) grouped in memory — no per-flag N+1. */
adminRoutes.get("/feature-flags", async (c) => {
  const flags = await withPlatformTx(actorOf(c), "admin.list_feature_flags", async (tx) => {
    const [defs, overrides] = await Promise.all([
      featureFlagRepository.listGlobal(tx),
      featureFlagRepository.allOverrides(tx),
    ]);
    const byKey = new Map<string, { tenantId: string; enabled: boolean }[]>();
    for (const o of overrides) {
      const list = byKey.get(o.flagKey) ?? [];
      list.push({ tenantId: o.tenantId, enabled: o.enabled });
      byKey.set(o.flagKey, list);
    }
    return defs.map((def) => ({
      key: def.key,
      description: def.description,
      globalEnabled: def.globalEnabled,
      defaultEnabled: def.defaultEnabled,
      createdAt: def.createdAt.toISOString(),
      updatedAt: def.updatedAt.toISOString(),
      overrides: byKey.get(def.key) ?? [],
    }));
  });
  return c.json({ flags });
});

/** Define or update a flag (idempotent on key). Audited. */
adminRoutes.put("/feature-flags", requireCapability("flags:manage"), async (c) => {
  const parsed = featureFlagUpsertSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message);
  const input = parsed.data;
  await withPlatformTx(actorOf(c), "feature_flag.set", (tx) =>
    featureFlagRepository.upsert(tx, {
      key: input.key,
      description: input.description,
      globalEnabled: input.global_enabled,
      defaultEnabled: input.default,
    }),
  );
  return c.json({ ok: true, key: input.key });
});

/** Toggle a flag's global default on/off. Audited. 404 if the flag is undefined — the NotFoundError is
 *  thrown INSIDE the tx so the audit row rolls back (a failed toggle leaves no "feature_flag.set" trace). */
adminRoutes.post("/feature-flags/:key/global", requireCapability("flags:manage"), async (c) => {
  const key = c.req.param("key");
  const parsed = featureFlagGlobalToggleSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message);
  await withPlatformTx(actorOf(c), "feature_flag.set", async (tx) => {
    const found = await featureFlagRepository.setGlobal(tx, key, parsed.data.enabled);
    if (!found) throw new NotFoundError(`Unknown feature flag '${key}'.`);
  });
  return c.json({ ok: true, key, globalEnabled: parsed.data.enabled });
});

/** Set or clear a per-tenant override. `enabled: null` clears it. Audited. */
adminRoutes.post("/feature-flags/:key/tenant", requireCapability("flags:manage"), async (c) => {
  const key = c.req.param("key");
  const parsed = featureFlagTenantToggleSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message);
  const { tenant_id, enabled } = parsed.data;
  await withPlatformTx(
    actorOf(c),
    "feature_flag.set",
    async (tx) => {
      // The flag must exist before an override can reference it (FK + a clearer 404 than a constraint error).
      const def = await featureFlagRepository.getGlobal(tx, key);
      if (!def) throw new NotFoundError(`Unknown feature flag '${key}'.`);
      if (enabled === null) {
        await featureFlagRepository.clearTenantOverride(tx, key, tenant_id);
      } else {
        await featureFlagRepository.setTenantOverride(tx, key, tenant_id, enabled);
      }
    },
    { targetType: "feature_flag", targetId: key, tenantId: tenant_id, metadata: { enabled } },
  );
  return c.json({ ok: true, key, tenantId: tenant_id, enabled });
});

/** Preview the evaluated flag state for a tenant (per-tenant override else global default). Audited read.
 *  tenantId is validated as a UUID BEFORE the tx so a malformed id is a clean 422 with no audit row (and
 *  no raw Postgres 22P02 500). */
adminRoutes.get("/feature-flags/evaluate/:tenantId", async (c) => {
  const tenantId = c.req.param("tenantId");
  if (!UUID_RE.test(tenantId)) throw new ValidationError("tenantId must be a UUID");
  const flags = await withPlatformTx(actorOf(c), "admin.evaluate_feature_flags", (tx) =>
    evaluateFlagsForTenant(tx, tenantId),
  );
  return c.json({ tenantId, flags });
});

// ── Global retention policies (data-management A2; design 16-retention-engine-design.md) ─────────────────
// One GLOBAL policy per data class: its TTL (null = never) + its disabled|shadow|enforce mode. The store is
// platform-managed (no tenant_id) and the customer app role has NO write policy under FORCE RLS, so both the
// read and the write run on the audited withPlatformTx (the owner path). The READ is open to the view-only
// staff tiers; the WRITE arms real deletion when a class is flipped to `enforce`, so it is super_admin-ONLY
// and audited (retention_policy.set). The per-tenant `retention_engine_enabled` flag is the outer gate on
// the sweep — a policy never deletes for a tenant that has the engine off.

/** List every global retention policy. View-only staff tiers may read; the write below is super_admin only.
 *  Response is Zod-validated against the shared RetentionPolicy contract before it leaves the boundary. */
adminRoutes.get(
  "/retention-policies",
  requireStaffRole("super_admin", "compliance_officer", "read_only"),
  async (c) => {
    const policies = await withPlatformTx(actorOf(c), "admin.list_retention_policies", (tx) =>
      retentionClassPolicyRepository.listPolicies(tx),
    );
    return c.json({ policies: retentionPolicySchema.array().parse(policies) });
  },
);

/** Define or update a class's policy (idempotent on data class). super_admin ONLY — flipping `mode` to
 *  `enforce` ARMS permanent deletion for that class — and AUDITED (retention_policy.set, with the class +
 *  new ttl/mode as the target/metadata). The upsert runs on withPlatformTx: under FORCE RLS the app role has
 *  no write policy on retention_class_policies, so the write MUST run on the owner path. dataClass is validated as
 *  a real retentionDataClass by the body schema (retentionPolicyUpdateSchema). FUTURE: a compliance_officer
 *  co-sign (dual-control) could be required on the enforce flip — a separate approval workflow, out of scope
 *  here; today the controls are super_admin-only + audit + the UI confirm dialog. */
adminRoutes.put("/retention-policies", requireStaffRole("super_admin"), async (c) => {
  const parsed = retentionPolicyUpdateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message);
  const policy = parsed.data;
  await withPlatformTx(
    actorOf(c),
    "retention_policy.set",
    (tx) => retentionClassPolicyRepository.upsertPolicy(tx, policy),
    {
      targetType: "retention_policy",
      targetId: policy.dataClass,
      metadata: { ttlDays: policy.ttlDays, mode: policy.mode },
    },
  );
  return c.json({ ok: true, dataClass: policy.dataClass });
});

// ── Provider configs (13 §3.6) — enable/disable + monthly budget, super_admin-gated. Own module to keep
// this file focused; the parent authn + platformAdmin middleware already apply to the mounted sub-routes. ──
adminRoutes.route("/provider-configs", providerConfigRoutes);
// Platform audit-log viewer (super_admin|compliance_officer), staff RBAC + impersonation (super_admin/support).
adminRoutes.route("/audit-log", auditLogRoutes);
adminRoutes.route("/staff", staffRoutes);
adminRoutes.route("/impersonation", impersonationRoutes);
// JIT elevation request/list (13a F1, super_admin|billing_ops) — minted here, consumed by the gated actions above.
adminRoutes.route("/elevations", elevationRoutes);
// Billing / revenue-ops economics (13a Area 4, super_admin|billing_ops).
adminRoutes.route("/billing", billingRoutes);
// Credit-pack pricing catalog (13a Area 5, pricing:manage).
adminRoutes.route("/pricing", pricingRoutes);
// Compliance ops — cross-tenant DSAR oversight (13a Area 8, compliance:read).
adminRoutes.route("/compliance", complianceRoutes);
// Announcements authoring (13a Area 10, content:manage).
adminRoutes.route("/announcements", announcementRoutes);
