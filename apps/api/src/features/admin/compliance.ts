// compliance.ts — platform-admin compliance-ops endpoints (13a Area 8, 13 §3.8). Mounted under
// /api/v1/admin/compliance, so the parent router already applied authn + platformAdmin. Compliance oversight
// is the compliance officer's surface → the compliance:read capability (compliance_officer; super_admin
// implies). The DSAR queue read runs through the audited withPlatformTx and returns a PII-free envelope only
// (never the encrypted subject email). DSAR requests are global, not per-tenant.

import {
  platformAdminWriteRepository,
  platformComplianceReadRepository,
  retentionPolicyRepository,
  subProcessorRepository,
  suppressionRepository,
  withPlatformTx,
} from "@leadwolf/db";
import {
  type DsarOversightRow,
  type GlobalSuppressionView,
  NotFoundError,
  type RetentionPolicyView,
  type SubProcessorView,
  ValidationError,
  addGlobalSuppressionSchema,
  dsarTransitionSchema,
  platformDsarQuerySchema,
  retentionPolicySetActiveSchema,
  retentionPolicyUpsertSchema,
  subProcessorSetActiveSchema,
  subProcessorUpsertSchema,
} from "@leadwolf/types";
import { type Context, Hono } from "hono";
import type { ApiVariables } from "../../middleware/authn.ts";
import { requireCapability } from "../../middleware/requireCapability.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const complianceRoutes = new Hono<{ Variables: ApiVariables }>();

complianceRoutes.use("*", requireCapability("compliance:read"));

const actorOf = (c: Context<{ Variables: ApiVariables }>) => ({
  userId: c.get("claims").sub,
  ip: c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
});

function toRow(r: {
  id: string;
  requestType: string;
  status: string;
  requestedAt: Date;
  verifiedAt: Date | null;
  completedAt: Date | null;
}): DsarOversightRow {
  return {
    id: r.id,
    requestType: r.requestType as DsarOversightRow["requestType"],
    status: r.status as DsarOversightRow["status"],
    requestedAt: r.requestedAt.toISOString(),
    verifiedAt: r.verifiedAt ? r.verifiedAt.toISOString() : null,
    completedAt: r.completedAt ? r.completedAt.toISOString() : null,
  };
}

/** The DSAR request queue (newest first), optionally filtered by status. Audited read; PII-free. */
complianceRoutes.get("/dsars", async (c) => {
  const parsed = platformDsarQuerySchema.safeParse({
    status: c.req.query("status"),
    limit: c.req.query("limit"),
  });
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message);
  const dsars = await withPlatformTx(actorOf(c), "admin.list_dsars", async (tx) =>
    (await platformComplianceReadRepository.listDsarRequests(tx, parsed.data)).map(toRow),
  );
  return c.json({ dsars });
});

/** Advance a DSAR through its staff workflow — verifying / processing / rejected. compliance:manage; audited
 *  "dsar.transition". 'completed' is NOT settable here: the erasure/export fulfilment records completion, never
 *  a manual flag (a hand-set 'completed' with no fulfilment would be a compliance violation). */
complianceRoutes.post("/dsars/:id/status", requireCapability("compliance:manage"), async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) throw new ValidationError("id must be a UUID");
  const parsed = dsarTransitionSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message);
  const { status, reason } = parsed.data;
  await withPlatformTx(
    actorOf(c),
    "dsar.transition",
    async (tx) => {
      const res = await platformAdminWriteRepository.setDsarStatus(tx, id, status);
      if (!res.found) throw new NotFoundError("DSAR request not found.");
      if (res.invalidFrom)
        throw new ValidationError(`Cannot move a '${res.invalidFrom}' DSAR to '${status}'.`);
    },
    {
      targetType: "dsar_request",
      targetId: id,
      metadata: { status, ...(reason ? { reason } : {}) },
    },
  );
  return c.json({ ok: true, id, status });
});

// ── Retention policies (13a Area 8, 13 §3.8) — staff-authored retention SLAs. Read = compliance:read (the
// router gate); writes additionally need compliance:manage. Audited "retention.set". ──
function toPolicy(r: {
  id: string;
  entity: string;
  field: string | null;
  retentionDays: number;
  reason: string | null;
  active: boolean;
  updatedAt: Date;
}): RetentionPolicyView {
  return {
    id: r.id,
    entity: r.entity as RetentionPolicyView["entity"],
    field: r.field,
    retentionDays: r.retentionDays,
    reason: r.reason,
    active: r.active,
    updatedAt: r.updatedAt.toISOString(),
  };
}

complianceRoutes.get("/retention", async (c) => {
  const policies = await withPlatformTx(actorOf(c), "admin.list_retention", async (tx) =>
    (await retentionPolicyRepository.list(tx)).map(toPolicy),
  );
  return c.json({ policies });
});

complianceRoutes.post("/retention", requireCapability("compliance:manage"), async (c) => {
  const parsed = retentionPolicyUpsertSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message);
  const actor = actorOf(c);
  const row = await withPlatformTx(
    actor,
    "retention.set",
    (tx) => retentionPolicyRepository.create(tx, { ...parsed.data, createdByUserId: actor.userId }),
    { targetType: "retention_policy", metadata: { entity: parsed.data.entity } },
  );
  return c.json({ policy: toPolicy(row) });
});

complianceRoutes.put("/retention/:id", requireCapability("compliance:manage"), async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) throw new ValidationError("id must be a UUID");
  const parsed = retentionPolicyUpsertSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message);
  await withPlatformTx(
    actorOf(c),
    "retention.set",
    async (tx) => {
      const touched = await retentionPolicyRepository.update(tx, id, parsed.data);
      if (touched === 0) throw new NotFoundError("Retention policy not found.");
    },
    { targetType: "retention_policy", targetId: id },
  );
  return c.json({ ok: true, id });
});

complianceRoutes.post(
  "/retention/:id/active",
  requireCapability("compliance:manage"),
  async (c) => {
    const id = c.req.param("id");
    if (!UUID_RE.test(id)) throw new ValidationError("id must be a UUID");
    const parsed = retentionPolicySetActiveSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message);
    await withPlatformTx(
      actorOf(c),
      "retention.set",
      async (tx) => {
        const touched = await retentionPolicyRepository.setActive(tx, id, parsed.data.active);
        if (touched === 0) throw new NotFoundError("Retention policy not found.");
      },
      { targetType: "retention_policy", targetId: id, metadata: { active: parsed.data.active } },
    );
    return c.json({ ok: true, id, active: parsed.data.active });
  },
);

// ── Global suppression / blocklist (13a Area 8, 13 §3.7) — a global domain block, immediately honored by the
// existing suppression gate (assertNotSuppressed). Read = compliance:read (router gate); writes need
// compliance:manage. Audited "suppress.add.global" / "suppress.remove.global". ──
function toSuppression(r: {
  id: string;
  matchType: string;
  domain: string | null;
  reason: string | null;
  createdAt: Date;
}): GlobalSuppressionView {
  return {
    id: r.id,
    matchType: r.matchType,
    domain: r.domain,
    reason: r.reason,
    createdAt: r.createdAt.toISOString(),
  };
}

complianceRoutes.get("/suppression", async (c) => {
  const entries = await withPlatformTx(actorOf(c), "admin.list_suppression", async (tx) =>
    (await suppressionRepository.listGlobal(tx)).map(toSuppression),
  );
  return c.json({ entries });
});

complianceRoutes.post("/suppression", requireCapability("compliance:manage"), async (c) => {
  const parsed = addGlobalSuppressionSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message);
  const actor = actorOf(c);
  const id = await withPlatformTx(
    actor,
    "suppress.add.global",
    (tx) =>
      suppressionRepository.insert(tx, {
        scope: "global",
        matchType: "domain",
        domain: parsed.data.domain,
        reason: parsed.data.reason ?? null,
        createdByUserId: actor.userId,
      }),
    { targetType: "suppression", metadata: { domain: parsed.data.domain } },
  );
  return c.json({ ok: true, id, domain: parsed.data.domain });
});

complianceRoutes.post(
  "/suppression/:id/remove",
  requireCapability("compliance:manage"),
  async (c) => {
    const id = c.req.param("id");
    if (!UUID_RE.test(id)) throw new ValidationError("id must be a UUID");
    await withPlatformTx(
      actorOf(c),
      "suppress.remove.global",
      async (tx) => {
        const touched = await suppressionRepository.removeGlobalById(tx, id);
        if (touched === 0) throw new NotFoundError("Global suppression entry not found.");
      },
      { targetType: "suppression", targetId: id },
    );
    return c.json({ ok: true, id });
  },
);

// ── Sub-processor registry (13a Area 8 / GDPR Art. 28) — the third-party processors TruePoint discloses (name,
// purpose, processing location, DPA link). Read = compliance:read (router gate); writes need compliance:manage.
// Audited "sub_processor.set". An empty dpaUrl normalises to null. ──
function toSubProcessor(r: {
  id: string;
  name: string;
  purpose: string;
  location: string;
  dpaUrl: string | null;
  active: boolean;
  sortOrder: number;
  updatedAt: Date;
}): SubProcessorView {
  return {
    id: r.id,
    name: r.name,
    purpose: r.purpose,
    location: r.location,
    dpaUrl: r.dpaUrl,
    active: r.active,
    sortOrder: r.sortOrder,
    updatedAt: r.updatedAt.toISOString(),
  };
}

complianceRoutes.get("/sub-processors", async (c) => {
  const subProcessors = await withPlatformTx(actorOf(c), "admin.list_sub_processors", async (tx) =>
    (await subProcessorRepository.list(tx)).map(toSubProcessor),
  );
  return c.json({ subProcessors });
});

complianceRoutes.post("/sub-processors", requireCapability("compliance:manage"), async (c) => {
  const parsed = subProcessorUpsertSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message);
  const actor = actorOf(c);
  const row = await withPlatformTx(
    actor,
    "sub_processor.set",
    (tx) =>
      subProcessorRepository.create(tx, {
        name: parsed.data.name,
        purpose: parsed.data.purpose,
        location: parsed.data.location,
        dpaUrl: parsed.data.dpaUrl?.trim() || null,
        sortOrder: parsed.data.sortOrder,
        createdByUserId: actor.userId,
      }),
    { targetType: "sub_processor", metadata: { name: parsed.data.name } },
  );
  return c.json({ subProcessor: toSubProcessor(row) });
});

complianceRoutes.put("/sub-processors/:id", requireCapability("compliance:manage"), async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) throw new ValidationError("id must be a UUID");
  const parsed = subProcessorUpsertSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message);
  await withPlatformTx(
    actorOf(c),
    "sub_processor.set",
    async (tx) => {
      const touched = await subProcessorRepository.update(tx, id, {
        name: parsed.data.name,
        purpose: parsed.data.purpose,
        location: parsed.data.location,
        dpaUrl: parsed.data.dpaUrl?.trim() || null,
        sortOrder: parsed.data.sortOrder,
      });
      if (touched === 0) throw new NotFoundError("Sub-processor not found.");
    },
    { targetType: "sub_processor", targetId: id },
  );
  return c.json({ ok: true, id });
});

complianceRoutes.post(
  "/sub-processors/:id/active",
  requireCapability("compliance:manage"),
  async (c) => {
    const id = c.req.param("id");
    if (!UUID_RE.test(id)) throw new ValidationError("id must be a UUID");
    const parsed = subProcessorSetActiveSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message);
    await withPlatformTx(
      actorOf(c),
      "sub_processor.set",
      async (tx) => {
        const touched = await subProcessorRepository.setActive(tx, id, parsed.data.active);
        if (touched === 0) throw new NotFoundError("Sub-processor not found.");
      },
      { targetType: "sub_processor", targetId: id, metadata: { active: parsed.data.active } },
    );
    return c.json({ ok: true, id, active: parsed.data.active });
  },
);
