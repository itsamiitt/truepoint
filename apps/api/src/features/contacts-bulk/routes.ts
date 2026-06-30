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
  bulkRevealExport,
  estimateBulkSpend,
} from "@leadwolf/core";
import {
  ForbiddenError,
  NotFoundError,
  ValidationError,
  bulkArchiveSchema,
  bulkAssignOwnerSchema,
  bulkEnrichSchema,
  bulkEstimateRequestSchema,
  bulkExportSchema,
  bulkStatusSchema,
  bulkTagsSchema,
} from "@leadwolf/types";
import { Hono } from "hono";
import { authn } from "../../middleware/authn.ts";
import { type RoleVariables, requireRole } from "../../middleware/requireRole.ts";
import { tenancy } from "../../middleware/tenancy.ts";
import { bulkFileStore } from "../import/bulkStore.ts";

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

/**
 * POST /contacts/bulk/estimate — the pre-flight credit projection for a bulk reveal/enrich (list-plan D5,
 * 06 §4.2). Body = { action: 'reveal'|'enrich' } + one of { contactIds | criteria }. Read-only: resolves the
 * selection to visible ids server-side and projects the worst-case spend + post-spend balance — NEVER a
 * client-computed cost, and it spends nothing. The UI shows this before any confirm so there is no surprise
 * spend. Any active workspace role may estimate (it reveals no PII, only counts + the projected cost).
 */
contactsBulkRoutes.post("/estimate", async (c) => {
  const workspaceId = requireWorkspace(c);
  const parsed = bulkEstimateRequestSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    throw new ValidationError(
      "Body must be { action: 'reveal'|'enrich' } + one of { contactIds | criteria }.",
    );
  const result = await estimateBulkSpend({
    scope: { tenantId: c.get("tenantId"), workspaceId },
    callerUserId: c.get("claims").sub,
    role: c.get("role"),
    action: parsed.data.action,
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

/**
 * POST /contacts/bulk/export/revealed — REVEALED CSV export (decrypted email/phone) of the selection. Each contact
 * is revealed THROUGH the gated reveal path (suppression-checked, charged per newly-revealed contact, audited);
 * suppressed contacts are EXCLUDED from the file. Viewer is denied in core (403). The CSV is written through the
 * FileStore (dev disk; prod S3); this returns the export id + counts. SPEND: the UI MUST call /estimate
 * (action:'reveal') first and confirm — this charges credits for newly-revealed contacts. Download via
 * GET /export/revealed/:exportId. (v1: explicit { contactIds } only; criteria/select-all is a follow-up.)
 */
contactsBulkRoutes.post("/export/revealed", async (c) => {
  const workspaceId = requireWorkspace(c);
  const parsed = bulkExportSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ValidationError("Body must be one of { contactIds | criteria }.");
  if (!parsed.data.contactIds || parsed.data.contactIds.length === 0)
    throw new ValidationError("A revealed export requires an explicit { contactIds } selection.");
  const exportId = crypto.randomUUID();
  const result = await bulkRevealExport({
    scope: { tenantId: c.get("tenantId"), workspaceId },
    callerUserId: c.get("claims").sub,
    role: c.get("role"),
    contactIds: parsed.data.contactIds,
    fileStore: bulkFileStore(),
    exportKey: `exports/${workspaceId}/${exportId}.csv`,
  });
  return c.json(
    {
      exportId,
      exported: result.exported,
      suppressedExcluded: result.suppressedExcluded,
      selected: result.selected,
    },
    200,
  );
});

/**
 * GET /contacts/bulk/export/revealed/:exportId — stream a previously-generated revealed CSV. The object key is
 * scoped to the CALLER's workspace (from the verified token, NEVER the client), so one workspace can never fetch
 * another's export. A missing / foreign id → 404. (v1 buffers the bounded file; streaming is a follow-up.)
 */
contactsBulkRoutes.get("/export/revealed/:exportId", async (c) => {
  const workspaceId = requireWorkspace(c);
  if (c.get("role") === "viewer")
    throw new ForbiddenError("insufficient_role", "Your role does not allow downloading exports.");
  const exportId = c.req.param("exportId");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(exportId))
    throw new ValidationError("exportId must be a UUID.");
  const key = `exports/${workspaceId}/${exportId}.csv`;
  let bytes: Uint8Array;
  try {
    const stream = await bulkFileStore().getObjectStream(key);
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream) chunks.push(chunk);
    bytes = Buffer.concat(chunks);
  } catch {
    throw new NotFoundError("Export not found.");
  }
  c.header("content-type", "text/csv; charset=utf-8");
  c.header("content-disposition", `attachment; filename="contacts-revealed-${exportId}.csv"`);
  return c.body(bytes, 200);
});
