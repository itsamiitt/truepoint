// routes.ts — the two "from the database" verbs on /api/v1/contacts (Layer-0-as-database slice 3 + the
// 2026-08-25 reveal-as-save decision). Transport only: the scope comes from the verified token, addressing is
// URL-shaped (slug or LinkedIn/Sales-Nav URL — never a Layer-0 id), and the visibility policy + write
// discipline live in @leadwolf/core.
//
//   POST /from-database         "Add to workspace" — kept for the extension's in-database card; no longer
//                               offered anywhere in apps/web.
//   POST /from-database/reveal  reveal IS the save gesture: materialize + reveal one channel in ONE request
//                               [S-06][S-04]. Guarded exactly like the money route (role → entitlement →
//                               reveal throttle → idempotency) PLUS the capture-rate budget the add spends —
//                               one person per explicit gesture (hard constraint 4).
//
// Both are LITERAL segments under /contacts, so this router is mounted before revealRoutes' `/:id/reveal`.
import { checkCaptureRate } from "@leadwolf/auth";
import { env } from "@leadwolf/config";
import {
  defaultEmailVerifier,
  defaultPhoneVerifier,
  materializeContactFromMaster,
  revealFromDatabase,
} from "@leadwolf/core";
import { usageEventRepository, withTenantTx } from "@leadwolf/db";
import {
  ForbiddenError,
  ValidationError,
  contactFromDatabaseRequestSchema,
  contactFromDatabaseResponseSchema,
  contactRevealFromDatabaseRequestSchema,
  contactRevealFromDatabaseResponseSchema,
} from "@leadwolf/types";
import { Hono } from "hono";
import { bumpSearchVersion } from "../../lib/searchVersion.ts";
import { authn } from "../../middleware/authn.ts";
import { idempotency } from "../../middleware/idempotency.ts";
import { requireEntitlement } from "../../middleware/requireEntitlement.ts";
import { type RoleVariables, requireRole } from "../../middleware/requireRole.ts";
import { revealRateLimit } from "../../middleware/revealRateLimit.ts";
import { tenancy } from "../../middleware/tenancy.ts";

export const contactsFromDatabaseRoutes = new Hono<{ Variables: RoleVariables }>();

contactsFromDatabaseRoutes.use("*", authn);
contactsFromDatabaseRoutes.use("*", tenancy);
contactsFromDatabaseRoutes.use("*", requireRole("owner", "admin", "member"));

/**
 * Demand signal: which database records workspaces actually adopt (the mirror of the reveal-miss feed).
 * `save` is the existing closed-vocabulary action for "this workspace kept a record" (0092's CHECK); `surface`
 * distinguishes a database adoption from a capture save. Non-fatal — a metering failure must never fail the
 * add or the reveal.
 */
async function recordDatabaseSave(
  scope: { tenantId: string; workspaceId: string; userId: string },
  contactId: string | null,
): Promise<void> {
  if (!env.USAGE_EVENTS_ENABLED || !contactId) return;
  try {
    await withTenantTx({ tenantId: scope.tenantId, workspaceId: scope.workspaceId }, (tx) =>
      usageEventRepository.append(tx, {
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        userId: scope.userId,
        action: "save",
        subjectType: "contact",
        subjectId: contactId,
        metadata: { surface: "database" },
      }),
    );
  } catch (err) {
    console.warn("[from-database] usage metering skipped", err);
  }
}

contactsFromDatabaseRoutes.post("/from-database", async (c) => {
  const claims = c.get("claims");
  const workspaceId = claims.wid;
  if (!workspaceId) {
    throw new ForbiddenError("no_workspace", "Select a workspace to add a contact.");
  }
  const parsed = contactFromDatabaseRequestSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues[0]?.message ?? "Invalid request body.");
  }

  await checkCaptureRate(`from-db:${claims.sub}`, 1);
  const scope = { tenantId: claims.tid, workspaceId, capturedByUserId: claims.sub };
  const result = await materializeContactFromMaster(
    scope,
    parsed.data.linkedinPublicId
      ? { linkedinPublicId: parsed.data.linkedinPublicId }
      : { url: parsed.data.url as string },
  );
  await recordDatabaseSave(
    { tenantId: claims.tid, workspaceId, userId: claims.sub },
    result.contactId,
  );
  return c.json(contactFromDatabaseResponseSchema.parse(result));
});

// The money variant. requireEntitlement runs BEFORE the throttle and the idempotency store on purpose (the
// same reasoning as /:id/reveal): a request the plan does not cover should not consume a rate-limit token and
// must never be recorded as an idempotent response. The capture-rate check sits inside the handler AFTER the
// idempotency claim, so a throttled attempt releases the key and a retry re-executes.
contactsFromDatabaseRoutes.post(
  "/from-database/reveal",
  requireEntitlement("reveal_month"),
  revealRateLimit,
  idempotency,
  async (c) => {
    const claims = c.get("claims");
    const tenantId = c.get("tenantId");
    const workspaceId = c.get("workspaceId");
    if (!workspaceId) {
      throw new ForbiddenError("no_workspace", "Select a workspace before revealing.");
    }
    const parsed = contactRevealFromDatabaseRequestSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) {
      throw new ValidationError(
        parsed.error.issues[0]?.message ??
          "Body must be { linkedinPublicId | url, reveal_type: email|phone|full_profile }.",
      );
    }

    // One person per explicit gesture: the same capture budget the add path spends (hard constraint 4).
    await checkCaptureRate(`from-db:${claims.sub}`, 1);

    const result = await revealFromDatabase({
      scope: { tenantId, workspaceId },
      userId: claims.sub,
      by: parsed.data.linkedinPublicId
        ? { linkedinPublicId: parsed.data.linkedinPublicId }
        : { url: parsed.data.url as string },
      revealType: parsed.data.reveal_type,
      // The same verifiers /:id/reveal wires (06 §9): Reacher / Twilio when configured, else the
      // pass-through / E.164 check. Verification runs OUTSIDE the charging tx inside revealContact.
      verifier: defaultEmailVerifier(),
      phoneVerifier: defaultPhoneVerifier(),
      ipAddress: c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      userAgent: c.req.header("user-agent") ?? null,
    });

    await recordDatabaseSave({ tenantId, workspaceId, userId: claims.sub }, result.contactId);
    // S5: a row joined the workspace AND its reveal state flipped — this workspace's facet/count aggregates
    // are stale; retire their generation. Fail-open (TTL backstop) and never blocks the spend.
    await bumpSearchVersion({ tenantId, workspaceId });
    return c.json(contactRevealFromDatabaseResponseSchema.parse(result), 200);
  },
);
