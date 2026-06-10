// routes.ts — HTTP wiring for the reveal domain (05 §6/§7; "Record Detail + Reveal"). GET serves the
// masked contact list; POST /:id/reveal runs the M3 money loop via packages/core (07 §3) — transport only:
// scope comes from the verified token (never the body), the Idempotency-Key replay sits in middleware, and
// masking + RLS + the credit invariants live in the core/db layers.

import { revealContact } from "@leadwolf/core";
import { contactRepository } from "@leadwolf/db";
import { ForbiddenError, ValidationError, revealRequestSchema } from "@leadwolf/types";
import { Hono } from "hono";
import { authn } from "../../middleware/authn.ts";
import { idempotency } from "../../middleware/idempotency.ts";
import { type TenancyVariables, tenancy } from "../../middleware/tenancy.ts";

export const revealRoutes = new Hono<{ Variables: TenancyVariables }>();

revealRoutes.use("*", authn);
revealRoutes.use("*", tenancy);

revealRoutes.get("/", async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId)
    throw new ForbiddenError("no_workspace", "Select a workspace to view contacts.");
  const limit = Math.min(Number(c.req.query("limit") ?? 100) || 100, 500);
  const contacts = await contactRepository.listByWorkspace(
    { tenantId: c.get("tenantId"), workspaceId },
    limit,
  );
  return c.json({ contacts });
});

// The single monetized path (09 §3.2): idempotent, suppression-gated, charged against the tenant counter.
revealRoutes.post("/:id/reveal", idempotency, async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId)
    throw new ForbiddenError("no_workspace", "Select a workspace before revealing.");

  const parsed = revealRequestSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    throw new ValidationError("Body must be { reveal_type: email|phone|full_profile }.");

  const result = await revealContact({
    scope: { tenantId: c.get("tenantId"), workspaceId },
    userId: c.get("claims").sub,
    contactId: c.req.param("id"),
    revealType: parsed.data.reveal_type,
    ipAddress: c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    userAgent: c.req.header("user-agent") ?? null,
  });
  return c.json(result, 200);
});
