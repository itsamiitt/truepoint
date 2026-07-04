// routes.ts — HTTP wiring for the reveal domain (05 §6/§7; "Record Detail + Reveal"). GET serves the
// masked contact list; POST /:id/reveal runs the M3 money loop via packages/core (07 §3) — transport only:
// scope comes from the verified token (never the body), the Idempotency-Key replay sits in middleware, and
// masking + RLS + the credit invariants live in the core/db layers.

import { env } from "@leadwolf/config";
import {
  confirmRevealJob,
  createRevealJob,
  defaultEmailVerifier,
  defaultPhoneVerifier,
  editContactFields,
  getRevealedContact,
  getRevealedContactsBatch,
  revealContact,
} from "@leadwolf/core";
import {
  type RevealJobViewRow,
  contactRepository,
  creditRepository,
  revealJobRepository,
  searchRepository,
  withTenantTx,
} from "@leadwolf/db";
import {
  BULK_SELECTION_CAP,
  ForbiddenError,
  InsufficientCreditsError,
  type JobViewer,
  NotFoundError,
  type RevealJobSummary,
  ValidationError,
  bulkRevealCreateSchema,
  contactFieldEditSchema,
  revealRequestSchema,
  revealedBatchRequestSchema,
} from "@leadwolf/types";
import { Hono } from "hono";
import { authn } from "../../middleware/authn.ts";
import { idempotency } from "../../middleware/idempotency.ts";
import { type RoleVariables, getWorkspaceRole, requireRole } from "../../middleware/requireRole.ts";
import { revealRateLimit } from "../../middleware/revealRateLimit.ts";
import { tenancy } from "../../middleware/tenancy.ts";
import { bulkFileStore } from "../import/bulkStore.ts";
import { enqueueBulkRevealDrive } from "./bulkRevealQueue.ts";

/** Map a viewer-read control row to the PII-free customer status DTO (the reveal-jobs UI polls this).
 *  Creator attribution rides ONLY while the job-visibility dual gate is on for the tenant (import-redesign
 *  10 §2.1) — flag-off responses stay byte-identical (T-V4). */
function toRevealJobSummary(job: RevealJobViewRow, viewer: JobViewer): RevealJobSummary {
  const summary: RevealJobSummary = {
    id: job.id,
    revealType: job.revealType as RevealJobSummary["revealType"],
    status: job.status as RevealJobSummary["status"],
    totalContacts: job.totalContacts,
    processedContacts: job.processedContacts,
    revealedContacts: job.revealedContacts,
    alreadyOwnedContacts: job.alreadyOwnedContacts,
    suppressedContacts: job.suppressedContacts,
    failedContacts: job.failedContacts,
    creditEstimate: job.creditEstimate,
    creditSpent: job.creditSpent,
    resultReady: job.status === "completed" && job.resultKey !== null,
    createdAt: job.createdAt.toISOString(),
    startedAt: job.startedAt?.toISOString() ?? null,
    completedAt: job.completedAt?.toISOString() ?? null,
  };
  if (!viewer.scoped) return summary;
  return {
    ...summary,
    createdBy: { userId: job.createdByUserId, displayName: job.createdByDisplayName },
  };
}

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

// GET /:id/revealed — the NO-CHARGE view of a contact's ALREADY-OWNED reveal data (Phase 1 read primitive).
// Returns decrypted email/phone ONLY for the reveal_types this workspace owns; never charges, never re-reveals.
// Any workspace member may view data the workspace already owns (visibility is workspace-wide, soft-owner
// model); the ownership + RLS check in core is the security boundary. No role gate (read, no spend).
revealRoutes.get("/:id/revealed", async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId)
    throw new ForbiddenError("no_workspace", "Select a workspace to view contacts.");
  const result = await getRevealedContact(
    { tenantId: c.get("tenantId"), workspaceId },
    c.req.param("id"),
  );
  if (!result) throw new NotFoundError("Contact not found in this workspace.");
  return c.json(result, 200);
});

// POST /revealed/batch — hydrate already-owned reveal data for a page of contact ids (the grid's visible rows).
// NO charge; returns decrypted email/phone ONLY for the reveal_types this workspace owns, only for rows it owns
// something for. Same security boundary as GET /:id/revealed (ownership + RLS in core). Distinct path from
// POST /:id/reveal (segment "revealed" ≠ "reveal", and this has no `/reveal` suffix), so no route collision.
revealRoutes.post("/revealed/batch", async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId)
    throw new ForbiddenError("no_workspace", "Select a workspace to view contacts.");
  const parsed = revealedBatchRequestSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ValidationError("Body must be { contactIds: string[] (1-500) }.");
  const revealed = await getRevealedContactsBatch(
    { tenantId: c.get("tenantId"), workspaceId },
    parsed.data.contactIds,
  );
  return c.json({ revealed }, 200);
});

// ── Async bulk-reveal jobs (reveal-experience Phase 3, ADR-0029/0036) ────────────────────────────────────
// Create → confirm(lease) → drive/chunk on a worker → finalize(release). Spends NOTHING until the confirm gate
// (member+, env.BULK_REVEAL_ENABLED). Distinct path segment (/reveal-jobs) — no collision with /:id/reveal.

/** Create a job over an explicit selection OR a select-all-matching query (resolved to visible ids here). Only
 *  arms the confirm gate — no credit moves. Returns the worst-case estimate + whether the balance covers it. */
revealRoutes.post("/reveal-jobs", requireRole("owner", "admin", "member"), async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId)
    throw new ForbiddenError("no_workspace", "Select a workspace before revealing.");
  const parsed = bulkRevealCreateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    throw new ValidationError("Body must be { revealType, contactIds | criteria }.");
  const scope = { tenantId: c.get("tenantId"), workspaceId };

  // Select-all-matching → materialize the visible ids server-side (capped). This is what makes bulk reveal work
  // across an entire search result, which the synchronous client loop could not.
  const contactIds = parsed.data.criteria
    ? await withTenantTx(scope, (tx) =>
        searchRepository.resolveVisibleIds(tx, parsed.data.criteria!, BULK_SELECTION_CAP),
      )
    : (parsed.data.contactIds ?? []);
  if (contactIds.length === 0) throw new ValidationError("No contacts match the selection.");

  const created = await createRevealJob({
    scope,
    revealType: parsed.data.revealType,
    contactIds,
    createdByUserId: c.get("claims").sub,
    idempotencyKey: c.req.header("Idempotency-Key") ?? null,
  });
  const balance = await creditRepository.getBalance(scope);
  const max = created.estimate.projectedMaxCredits;
  return c.json(
    {
      jobId: created.jobId,
      revealType: parsed.data.revealType,
      totalContacts: created.estimate.totalContacts,
      billableContacts: created.estimate.billableContacts,
      alreadyOwnedContacts: created.estimate.alreadyOwnedContacts,
      projectedMaxCredits: max,
      balance,
      balanceAfter: Math.max(0, balance - max),
      sufficient: balance >= max,
    },
    created.created ? 201 : 200,
  );
});

/** List the reveal jobs visible to the viewer (status polling). Any active role may read; the repo's
 *  jobVisibility predicate decides WHICH rows (import-redesign 10 §2.1). S-V2: viewer wired with the
 *  dual gate hard-off (scoped: false ⇒ workspace-wide, byte-identical); S-V3 evaluates the real gate. */
revealRoutes.get("/reveal-jobs", requireRole("owner", "admin", "member", "viewer"), async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId) throw new ForbiddenError("no_workspace", "Select a workspace.");
  const viewer: JobViewer = { userId: c.get("claims").sub, role: getWorkspaceRole(c), scoped: false };
  const jobs = await revealJobRepository.listJobs(
    { tenantId: c.get("tenantId"), workspaceId },
    viewer,
  );
  return c.json({ jobs: jobs.map((job) => toRevealJobSummary(job, viewer)) });
});

/** One job's status — the SAME predicate as the list (10 §4.2 rule 2); invisible ⇒ 404. */
revealRoutes.get(
  "/reveal-jobs/:jobId",
  requireRole("owner", "admin", "member", "viewer"),
  async (c) => {
    const workspaceId = c.get("workspaceId");
    if (!workspaceId) throw new ForbiddenError("no_workspace", "Select a workspace.");
    const viewer: JobViewer = { userId: c.get("claims").sub, role: getWorkspaceRole(c), scoped: false };
    const job = await revealJobRepository.getJob(
      { tenantId: c.get("tenantId"), workspaceId },
      viewer,
      c.req.param("jobId"),
    );
    if (!job) throw new NotFoundError("Reveal job not found in this workspace.");
    return c.json(toRevealJobSummary(job, viewer));
  },
);

/** The failed contact ids — the frontend "retry failed" re-submits them as a NEW job (clean lease cycle). */
revealRoutes.get(
  "/reveal-jobs/:jobId/failed",
  requireRole("owner", "admin", "member"),
  async (c) => {
    const workspaceId = c.get("workspaceId");
    if (!workspaceId) throw new ForbiddenError("no_workspace", "Select a workspace.");
    const contactIds = await revealJobRepository.listFailedContactIds(
      { tenantId: c.get("tenantId"), workspaceId },
      c.req.param("jobId"),
    );
    return c.json({ contactIds });
  },
);

/** Signed download URL for the revealed CSV (terminal jobs only). Rides the viewer-predicated detail read
 *  (10 §4.2 rule 2): when the gate is on, a member can fetch only their own job's export. */
revealRoutes.get(
  "/reveal-jobs/:jobId/download",
  requireRole("owner", "admin", "member"),
  async (c) => {
    const workspaceId = c.get("workspaceId");
    if (!workspaceId) throw new ForbiddenError("no_workspace", "Select a workspace.");
    const viewer: JobViewer = { userId: c.get("claims").sub, role: getWorkspaceRole(c), scoped: false };
    const job = await revealJobRepository.getJob(
      { tenantId: c.get("tenantId"), workspaceId },
      viewer,
      c.req.param("jobId"),
    );
    if (!job || !job.resultKey)
      throw new NotFoundError("No revealed export is ready for this job.");
    const downloadUrl = await bulkFileStore().getSignedDownloadUrl(job.resultKey);
    return c.json({ downloadUrl });
  },
);

/** The MONEY GATE: lease the worst-case ceiling + flip awaiting_confirmation → running, then enqueue the drive.
 *  Dark until BULK_REVEAL_ENABLED (defense in depth on top of the producer's own gate). */
revealRoutes.post(
  "/reveal-jobs/:jobId/confirm",
  requireRole("owner", "admin", "member"),
  async (c) => {
    const workspaceId = c.get("workspaceId");
    if (!workspaceId) throw new ForbiddenError("no_workspace", "Select a workspace.");
    if (!env.BULK_REVEAL_ENABLED)
      throw new ForbiddenError("feature_disabled", "Bulk reveal is not enabled.");
    const scope = { tenantId: c.get("tenantId"), workspaceId };
    const jobId = c.req.param("jobId");
    const res = await confirmRevealJob(scope, jobId, c.get("claims").sub);
    if (res.result === "insufficient")
      throw new InsufficientCreditsError(res.balance, res.required);
    if (res.result === "not_awaiting")
      return c.json({ code: "not_awaiting", detail: "Job is not awaiting confirmation." }, 409);
    await enqueueBulkRevealDrive({ kind: "drive", jobId, scope });
    return c.json({ ok: true, status: "running" });
  },
);

/** Cancel a non-terminal job + release the unspent lease remainder. */
revealRoutes.post(
  "/reveal-jobs/:jobId/cancel",
  requireRole("owner", "admin", "member"),
  async (c) => {
    const workspaceId = c.get("workspaceId");
    if (!workspaceId) throw new ForbiddenError("no_workspace", "Select a workspace.");
    const ok = await revealJobRepository.cancelAndRelease(
      { tenantId: c.get("tenantId"), workspaceId },
      c.req.param("jobId"),
      c.get("claims").sub,
    );
    return c.json({ ok, status: ok ? "cancelled" : "unchanged" });
  },
);

/** Pause a running job (chunks stop at the next status re-check; the lease is retained for resume). */
revealRoutes.post(
  "/reveal-jobs/:jobId/pause",
  requireRole("owner", "admin", "member"),
  async (c) => {
    const workspaceId = c.get("workspaceId");
    if (!workspaceId) throw new ForbiddenError("no_workspace", "Select a workspace.");
    const ok = await revealJobRepository.pauseRunning(
      { tenantId: c.get("tenantId"), workspaceId },
      c.req.param("jobId"),
    );
    return c.json({ ok, status: ok ? "paused" : "unchanged" });
  },
);

/** Resume a paused job + re-enqueue the drive (it re-plans the still-queued rows). */
revealRoutes.post(
  "/reveal-jobs/:jobId/resume",
  requireRole("owner", "admin", "member"),
  async (c) => {
    const workspaceId = c.get("workspaceId");
    if (!workspaceId) throw new ForbiddenError("no_workspace", "Select a workspace.");
    const scope = { tenantId: c.get("tenantId"), workspaceId };
    const jobId = c.req.param("jobId");
    const ok = await revealJobRepository.resumePaused(scope, jobId);
    if (ok) await enqueueBulkRevealDrive({ kind: "drive", jobId, scope });
    return c.json({ ok, status: ok ? "running" : "unchanged" });
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
