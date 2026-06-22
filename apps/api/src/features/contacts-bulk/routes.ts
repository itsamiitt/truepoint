// routes.ts — HTTP wiring for the Phase-3 bulk-action surface (24; mounted at /api/v1/contacts/bulk). Transport
// only: scope comes from the VERIFIED token (never the body), the caller user id is claims.sub, the workspace
// role is resolved by requireRole (and re-checked finer in core for owner-assign + export), validation is Zod at
// the edge, and ALL logic — visible-id filtering, the select-all cap, affected counts, owner policy, audit —
// lives in @leadwolf/core's bulk module. Every endpoint returns { affected } (export returns text/csv).
//
// Selection contract (every endpoint): the body carries EITHER { contactIds } OR { criteria: ContactQuery }
// (select-all-across-search), enforced exactly-one-of by the Zod schema; a `criteria` is resolved to ids in core
// (capped at BULK_SELECTION_CAP).

import {
  assignOwner,
  bulkArchive,
  bulkAssignTags,
  bulkChangeStatus,
  bulkEnrich,
  bulkExportCsv,
  bulkRemoveTags,
} from "@leadwolf/core";
import {
  ForbiddenError,
  ValidationError,
  bulkArchiveSchema,
  bulkAssignOwnerSchema,
  bulkEnrichSchema,
  bulkExportSchema,
  bulkStatusSchema,
  bulkTagsSchema,
} from "@leadwolf/types";
import { Hono } from "hono";
import { authn } from "../../middleware/authn.ts";
import { type RoleVariables, requireRole } from "../../middleware/requireRole.ts";
import { tenancy } from "../../middleware/tenancy.ts";

export const contactsBulkRoutes = new Hono<{ Variables: RoleVariables }>();

contactsBulkRoutes.use("*", authn);
contactsBulkRoutes.use("*", tenancy);
// All bulk actions require an active workspace membership; the role is stashed for the finer core policy gates
// (owner-assign: members may only self-assign/clear; export: viewer denied).
contactsBulkRoutes.use("*", requireRole("owner", "admin", "member", "viewer"));

function requireWorkspace(c: { get: (k: "workspaceId") => string | undefined }): string {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId)
    throw new ForbiddenError("no_workspace", "Select a workspace to run bulk actions.");
  return workspaceId;
}

/** POST /contacts/bulk/assign-owner — set/clear the soft owner. Body adds { ownerUserId }. */
contactsBulkRoutes.post("/assign-owner", async (c) => {
  const workspaceId = requireWorkspace(c);
  const parsed = bulkAssignOwnerSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    throw new ValidationError("Body must be { ownerUserId } + one of { contactIds | criteria }.");
  const result = await assignOwner({
    scope: { tenantId: c.get("tenantId"), workspaceId },
    callerUserId: c.get("claims").sub,
    role: c.get("role"),
    ownerUserId: parsed.data.ownerUserId,
    contactIds: parsed.data.contactIds,
    criteria: parsed.data.criteria,
  });
  return c.json(result, 200);
});

/** POST /contacts/bulk/tags — add one or more tags to the selection. Body adds { tagIds }. */
contactsBulkRoutes.post("/tags", async (c) => {
  const workspaceId = requireWorkspace(c);
  const parsed = bulkTagsSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    throw new ValidationError("Body must be { tagIds } + one of { contactIds | criteria }.");
  const result = await bulkAssignTags({
    scope: { tenantId: c.get("tenantId"), workspaceId },
    callerUserId: c.get("claims").sub,
    role: c.get("role"),
    tagIds: parsed.data.tagIds,
    contactIds: parsed.data.contactIds,
    criteria: parsed.data.criteria,
  });
  return c.json(result, 200);
});

/** DELETE /contacts/bulk/tags — remove one or more tags from the selection. Body adds { tagIds }. */
contactsBulkRoutes.delete("/tags", async (c) => {
  const workspaceId = requireWorkspace(c);
  const parsed = bulkTagsSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    throw new ValidationError("Body must be { tagIds } + one of { contactIds | criteria }.");
  const result = await bulkRemoveTags({
    scope: { tenantId: c.get("tenantId"), workspaceId },
    callerUserId: c.get("claims").sub,
    role: c.get("role"),
    tagIds: parsed.data.tagIds,
    contactIds: parsed.data.contactIds,
    criteria: parsed.data.criteria,
  });
  return c.json(result, 200);
});

/** POST /contacts/bulk/status — set outreach_status for the selection. Body adds { outreachStatus }. */
contactsBulkRoutes.post("/status", async (c) => {
  const workspaceId = requireWorkspace(c);
  const parsed = bulkStatusSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    throw new ValidationError(
      "Body must be { outreachStatus } + one of { contactIds | criteria }.",
    );
  const result = await bulkChangeStatus({
    scope: { tenantId: c.get("tenantId"), workspaceId },
    callerUserId: c.get("claims").sub,
    role: c.get("role"),
    outreachStatus: parsed.data.outreachStatus,
    contactIds: parsed.data.contactIds,
    criteria: parsed.data.criteria,
  });
  return c.json(result, 200);
});

/** POST /contacts/bulk/archive — soft-archive (hide) the selection. Body = selection only. */
contactsBulkRoutes.post("/archive", async (c) => {
  const workspaceId = requireWorkspace(c);
  const parsed = bulkArchiveSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ValidationError("Body must be one of { contactIds | criteria }.");
  const result = await bulkArchive({
    scope: { tenantId: c.get("tenantId"), workspaceId },
    callerUserId: c.get("claims").sub,
    role: c.get("role"),
    contactIds: parsed.data.contactIds,
    criteria: parsed.data.criteria,
  });
  return c.json(result, 200);
});

/** POST /contacts/bulk/enrich — enqueue a re-enrich/re-verify job for the selection. Returns { affected, jobId }. */
contactsBulkRoutes.post("/enrich", async (c) => {
  const workspaceId = requireWorkspace(c);
  const parsed = bulkEnrichSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ValidationError("Body must be one of { contactIds | criteria }.");
  const result = await bulkEnrich({
    scope: { tenantId: c.get("tenantId"), workspaceId },
    callerUserId: c.get("claims").sub,
    role: c.get("role"),
    contactIds: parsed.data.contactIds,
    criteria: parsed.data.criteria,
  });
  return c.json(result, 200);
});

/**
 * POST /contacts/bulk/export — role-gated CSV export of the MASKED (non-PII) columns for the selection. Viewer
 * is denied in core (403). Response is text/csv (not JSON), with a download filename; the export is audited.
 */
contactsBulkRoutes.post("/export", async (c) => {
  const workspaceId = requireWorkspace(c);
  const parsed = bulkExportSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ValidationError("Body must be one of { contactIds | criteria }.");
  const { csv, affected } = await bulkExportCsv({
    scope: { tenantId: c.get("tenantId"), workspaceId },
    callerUserId: c.get("claims").sub,
    role: c.get("role"),
    contactIds: parsed.data.contactIds,
    criteria: parsed.data.criteria,
  });
  c.header("content-type", "text/csv; charset=utf-8");
  c.header("content-disposition", `attachment; filename="contacts-export-${affected}.csv"`);
  c.header("x-affected-count", String(affected));
  return c.body(csv, 200);
});
