// routes.ts — POST /api/v1/contacts/from-database: "Add to workspace" (Layer-0-as-database slice 3).
// Materializes a person the PLATFORM DATABASE already holds into the caller's workspace. Transport only:
// the scope comes from the verified token, the addressing is URL-shaped (slug or LinkedIn/Sales-Nav URL —
// never a Layer-0 id), and the visibility policy + write discipline live in @leadwolf/core's materializer.
// One row per explicit user gesture (hard constraint 4); rate-limited like the capture paths.
import { checkCaptureRate } from "@leadwolf/auth";
import { env } from "@leadwolf/config";
import { materializeContactFromMaster } from "@leadwolf/core";
import { usageEventRepository, withTenantTx } from "@leadwolf/db";
import {
  ForbiddenError,
  ValidationError,
  contactFromDatabaseRequestSchema,
  contactFromDatabaseResponseSchema,
} from "@leadwolf/types";
import { Hono } from "hono";
import { authn } from "../../middleware/authn.ts";
import { type RoleVariables, requireRole } from "../../middleware/requireRole.ts";
import { tenancy } from "../../middleware/tenancy.ts";

export const contactsFromDatabaseRoutes = new Hono<{ Variables: RoleVariables }>();

contactsFromDatabaseRoutes.use("*", authn);
contactsFromDatabaseRoutes.use("*", tenancy);
contactsFromDatabaseRoutes.use("*", requireRole("owner", "admin", "member"));

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

  // Demand signal: which database records workspaces actually adopt (the mirror of the reveal-miss feed).
  // Non-fatal — a metering failure must never fail the add.
  if (env.USAGE_EVENTS_ENABLED && result.contactId) {
    try {
      await withTenantTx({ tenantId: claims.tid, workspaceId }, (tx) =>
        usageEventRepository.append(tx, {
          tenantId: claims.tid,
          workspaceId,
          userId: claims.sub,
          // `save` is the existing closed-vocabulary action for "this workspace kept a record" (0092's
          // CHECK); `surface` distinguishes a database adoption from a capture save.
          action: "save",
          subjectType: "contact",
          subjectId: result.contactId ?? undefined,
          metadata: { surface: "database" },
        }),
      );
    } catch (err) {
      console.warn("[from-database] usage metering skipped", err);
    }
  }

  return c.json(contactFromDatabaseResponseSchema.parse(result));
});
