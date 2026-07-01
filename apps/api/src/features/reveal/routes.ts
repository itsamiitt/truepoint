// routes.ts — HTTP wiring for the reveal domain (05 §6/§7; "Record Detail + Reveal"). GET serves the
// masked contact list; POST /:id/reveal runs the M3 money loop via packages/core (07 §3) — transport only:
// scope comes from the verified token (never the body), the Idempotency-Key replay sits in middleware, and
// masking + RLS + the credit invariants live in the core/db layers.

import {
  defaultEmailVerifier,
  defaultPhoneVerifier,
  editContactFields,
  revealContact,
} from "@leadwolf/core";
import { contactRepository } from "@leadwolf/db";
import {
  ForbiddenError,
  ValidationError,
  contactFieldEditSchema,
  revealRequestSchema,
} from "@leadwolf/types";
import { Hono } from "hono";
import { authn } from "../../middleware/authn.ts";
import { idempotency } from "../../middleware/idempotency.ts";
import { type RoleVariables, requireRole } from "../../middleware/requireRole.ts";
import { revealRateLimit } from "../../middleware/revealRateLimit.ts";
import { tenancy } from "../../middleware/tenancy.ts";

export const revealRoutes = new Hono<{ Variables: RoleVariables }>();

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
// Role-gated to member+ (a viewer must never spend tenant credits) and burst-throttled per caller ON TOP of the
// coarse /api limiter — the credit-safety guards the audit flagged as missing on the money endpoint.
revealRoutes.post(
  "/:id/reveal",
  requireRole("owner", "admin", "member"),
  revealRateLimit,
  idempotency,
  async (c) => {
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
      // The dedicated email verifier (06 §9): Reacher when REACHER_BACKEND_URL is configured, else the
      // pass-through (no grading). Verification runs OUTSIDE the charging tx inside revealContact.
      verifier: defaultEmailVerifier(),
      // The phone verifier (06 §9): Twilio Lookup when TWILIO_* is configured, else the E.164 format check.
      phoneVerifier: defaultPhoneVerifier(),
      ipAddress: c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      userAgent: c.req.header("user-agent") ?? null,
    });
    return c.json(result, 200);
  },
);

// Hand-edit a contact's scalar profile fields, PINNING each against future enrichment overwrite (PLAN_03 §1.4).
// Transport only: scope comes from the verified token (never the body), and the pin + RLS-scoped, idempotent
// write live in core/db (editContactFields). A foreign/absent id updates no row — a safe no-op, the same trust
// posture as the reveal route which never trusts the body for scope. Role-gated to member+ (a viewer must not
// mutate contact records).
revealRoutes.patch("/:id", requireRole("owner", "admin", "member"), async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId)
    throw new ForbiddenError("no_workspace", "Select a workspace to edit contacts.");

  const parsed = contactFieldEditSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    throw new ValidationError(
      "Provide at least one of firstName/lastName/jobTitle/seniorityLevel/department/locationCountry/locationCity.",
    );

  await editContactFields(
    { tenantId: c.get("tenantId"), workspaceId },
    c.req.param("id"),
    parsed.data,
    c.get("claims").sub,
  );
  return c.json({ ok: true }, 200);
});
