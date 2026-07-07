// routes.ts — the contact TRUE-MERGE customer verb (import-and-data-model-redesign 04 §API; S-C5). Mounted at
// /api/v1/contacts (survivor = :id in the path). DUAL-GATED 404-off: while the merge gate is dark
// (CONTACT_MERGE_ENABLED env + contact_merge_enabled flag) the verb + preview return 404 — the feature does
// not exist for this tenant (04 §pre-build rollback). The survivor and loser ids are validated live-in-
// workspace under RLS inside the engine's tx (the IDOR guard); the workspace is taken from the VERIFIED token,
// never the body. Idempotency-Key on the write (an expensive, IRREVERSIBLE, destructive verb). Transport only:
// core (previewContactMerge / runContactMerge) does the work; RLS is the tenant wall.
import { contactMergeEnabledForScope, previewContactMerge, runContactMerge } from "@leadwolf/core";
import {
  ForbiddenError,
  NotFoundError,
  ValidationError,
  mergePreviewSchema,
  mergeRequestSchema,
  mergeResultSchema,
} from "@leadwolf/types";
import { Hono } from "hono";
import { authn } from "../../middleware/authn.ts";
import { idempotency } from "../../middleware/idempotency.ts";
import { type RoleVariables, requireRole } from "../../middleware/requireRole.ts";
import { tenancy } from "../../middleware/tenancy.ts";

export const contactsMergeRoutes = new Hono<{ Variables: RoleVariables }>();
contactsMergeRoutes.use("*", authn);
contactsMergeRoutes.use("*", tenancy);

/** GET /contacts/:id/merge-preview?loser=<uuid> — the side-by-side review data (04 §6): field matrix +
 *  child-impact counts. Read-only, non-PII scalars only. 404 while the merge gate is dark. */
contactsMergeRoutes.get(
  "/:id/merge-preview",
  requireRole("owner", "admin", "member", "viewer"),
  async (c) => {
    const workspaceId = c.get("workspaceId");
    if (!workspaceId) throw new ForbiddenError("no_workspace", "Select a workspace to merge.");
    const scope = { tenantId: c.get("tenantId"), workspaceId };
    if (!(await contactMergeEnabledForScope(scope))) throw new NotFoundError();

    const loser = c.req.query("loser");
    if (!loser) throw new ValidationError("Query param `loser` (the loser contact id) is required.");
    const preview = await previewContactMerge({
      scope,
      survivorContactId: c.req.param("id"),
      loserContactId: loser,
    });
    return c.json(mergePreviewSchema.parse(preview), 200);
  },
);

/** POST /contacts/:id/merge — execute the true merge (survivor = :id). Idempotency-Key required; 404 while
 *  the merge gate is dark. Legality/caps → RFC-9457 problems from the engine (400/404/409). */
contactsMergeRoutes.post(
  "/:id/merge",
  requireRole("owner", "admin", "member"),
  idempotency,
  async (c) => {
    const workspaceId = c.get("workspaceId");
    if (!workspaceId) throw new ForbiddenError("no_workspace", "Select a workspace to merge.");
    const scope = { tenantId: c.get("tenantId"), workspaceId };
    if (!(await contactMergeEnabledForScope(scope))) throw new NotFoundError();

    const parsed = mergeRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      throw new ValidationError("Body must be { loserContactId, decisions?: [{field, winner}] }.");

    const result = await runContactMerge({
      scope,
      survivorContactId: c.req.param("id"),
      loserContactId: parsed.data.loserContactId,
      decisions: parsed.data.decisions,
      userId: c.get("claims").sub,
    });
    return c.json(mergeResultSchema.parse(result), 200);
  },
);
