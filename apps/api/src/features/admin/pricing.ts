// pricing.ts — platform-admin credit-pack (pricing) config (13a Area 5, 13 §3.5). Mounted under
// /api/v1/admin/pricing, so the parent router already applied authn + platformAdmin. Pricing is a sensitive
// commercial control → the pricing:manage capability (super_admin). All reads/writes go through the audited
// withPlatformTx; upsert + toggle write a "credit_pack.set" platform_audit_log row. No customer-facing read
// here — the public, transparent pricing surface (ADR-0012) is a separate read endpoint.

import { creditPackRepository, planTemplateRepository, withPlatformTx } from "@leadwolf/db";
import {
  type CreditPackView,
  NotFoundError,
  type PlanTemplateView,
  ValidationError,
  creditPackSetActiveSchema,
  creditPackUpsertSchema,
  planTemplateSetActiveSchema,
  planTemplateUpsertSchema,
} from "@leadwolf/types";
import { type Context, Hono } from "hono";
import type { ApiVariables } from "../../middleware/authn.ts";
import { requireCapability } from "../../middleware/requireCapability.ts";

export const pricingRoutes = new Hono<{ Variables: ApiVariables }>();

pricingRoutes.use("*", requireCapability("pricing:manage"));

const actorOf = (c: Context<{ Variables: ApiVariables }>) => ({
  userId: c.get("claims").sub,
  ip: c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
});

function toView(r: {
  key: string;
  name: string;
  credits: number;
  priceCents: number;
  active: boolean;
  sortOrder: number;
  updatedAt: Date;
}): CreditPackView {
  return {
    key: r.key,
    name: r.name,
    credits: r.credits,
    priceCents: r.priceCents,
    active: r.active,
    sortOrder: r.sortOrder,
    updatedAt: r.updatedAt.toISOString(),
  };
}

/** The full credit-pack catalog (active + retired). */
pricingRoutes.get("/credit-packs", async (c) => {
  const packs = await withPlatformTx(actorOf(c), "admin.list_credit_packs", async (tx) =>
    (await creditPackRepository.list(tx)).map(toView),
  );
  return c.json({ packs });
});

/** Create or update a credit pack (idempotent on key). Audited "credit_pack.set". */
pricingRoutes.put("/credit-packs", async (c) => {
  const parsed = creditPackUpsertSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message);
  const input = parsed.data;
  const pack = await withPlatformTx(
    actorOf(c),
    "credit_pack.set",
    (tx) => creditPackRepository.upsert(tx, input),
    {
      targetType: "credit_pack",
      targetId: input.key,
      metadata: { credits: input.credits, priceCents: input.priceCents },
    },
  );
  return c.json({ pack: toView(pack) });
});

/** Toggle a pack's availability. 404 if the key is unknown (thrown in-tx so the audit row rolls back). */
pricingRoutes.post("/credit-packs/:key/active", async (c) => {
  const key = c.req.param("key");
  const parsed = creditPackSetActiveSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message);
  await withPlatformTx(
    actorOf(c),
    "credit_pack.set",
    async (tx) => {
      const touched = await creditPackRepository.setActive(tx, key, parsed.data.active);
      if (touched === 0) throw new NotFoundError(`Unknown credit pack '${key}'.`);
    },
    { targetType: "credit_pack", targetId: key, metadata: { active: parsed.data.active } },
  );
  return c.json({ ok: true, key, active: parsed.data.active });
});

// ── Plan templates (13a Area 5, 13 §3.5 / 07 §5) — the plan/entitlement catalog. ──

function toTemplateView(r: {
  key: string;
  name: string;
  seatLimit: number;
  workspaceLimit: number | null;
  monthlyCreditGrant: number | null;
  features: Record<string, boolean>;
  active: boolean;
  sortOrder: number;
  updatedAt: Date;
}): PlanTemplateView {
  return {
    key: r.key,
    name: r.name,
    seatLimit: r.seatLimit,
    workspaceLimit: r.workspaceLimit,
    monthlyCreditGrant: r.monthlyCreditGrant,
    features: r.features,
    active: r.active,
    sortOrder: r.sortOrder,
    updatedAt: r.updatedAt.toISOString(),
  };
}

/** The full plan-template catalog (active + retired). */
pricingRoutes.get("/plan-templates", async (c) => {
  const templates = await withPlatformTx(actorOf(c), "admin.list_plan_templates", async (tx) =>
    (await planTemplateRepository.list(tx)).map(toTemplateView),
  );
  return c.json({ templates });
});

/** Create or update a plan template (idempotent on key). Audited "plan_template.set". */
pricingRoutes.put("/plan-templates", async (c) => {
  const parsed = planTemplateUpsertSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message);
  const input = parsed.data;
  const template = await withPlatformTx(
    actorOf(c),
    "plan_template.set",
    (tx) => planTemplateRepository.upsert(tx, input),
    { targetType: "plan_template", targetId: input.key, metadata: { seatLimit: input.seatLimit } },
  );
  return c.json({ template: toTemplateView(template) });
});

/** Toggle a plan template's availability. 404 if the key is unknown (thrown in-tx → audit row rolls back). */
pricingRoutes.post("/plan-templates/:key/active", async (c) => {
  const key = c.req.param("key");
  const parsed = planTemplateSetActiveSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message);
  await withPlatformTx(
    actorOf(c),
    "plan_template.set",
    async (tx) => {
      const touched = await planTemplateRepository.setActive(tx, key, parsed.data.active);
      if (touched === 0) throw new NotFoundError(`Unknown plan template '${key}'.`);
    },
    { targetType: "plan_template", targetId: key, metadata: { active: parsed.data.active } },
  );
  return c.json({ ok: true, key, active: parsed.data.active });
});
