// bulkActions.ts — business logic for the Phase-3 bulk-action surface over the prospect search results (24).
// Every operation is (a) workspace-scoped via ONE withTenantTx (RLS is the hard wall), (b) restricted to the
// caller's WORKSPACE-VISIBLE contacts — an explicit id list is filtered to visibleContactIds, a `criteria`
// (select-all-across-search) is resolved to ids via searchRepository (capped at BULK_SELECTION_CAP) and those
// ids are equally visible by construction — (c) returns an { affected } count the UI confirms, and (d) writes
// an audit row where the closed 08 §5 enum has an action for it. The owner-assign POLICY (admins set any owner;
// members only self/clear; the new owner must be an active member) lives here, NOT in the data layer.
//
// AUDIT MAPPING (08 §5 closed enum): assign-owner/status/archive → contact.update (archive → contact.delete,
// the soft-hide, kept distinct from the DSAR dsar.delete path); tags → tag.assign / tag.unassign; enroll →
// enroll (per contact, reusing enrollContact's own writer is avoided — see bulkEnroll). Bulk add-to-list reuses
// addContactsToList (no list-membership audit action exists). Bulk enrich enqueues an enrichment_jobs row and
// is NOT audited (no enrichment audit action in the closed enum) — documented on bulkEnrich.

import { env } from "@leadwolf/config";
import {
  type TenantScope,
  type Tx,
  contactRepository,
  creditRepository,
  enrichmentJobRepository,
  outreachLogRepository,
  revealRepository,
  searchRepository,
  sequenceRepository,
  suppressionRepository,
  tagRepository,
  withTenantTx,
  workspaceRepository,
} from "@leadwolf/db";
import {
  BULK_SELECTION_CAP,
  type BulkEnrollResult,
  type BulkEstimateAction,
  type BulkSpendEstimate,
  type ContactQuery,
  ForbiddenError,
  NotFoundError,
  type OutreachStatus,
  type WorkspaceRole,
} from "@leadwolf/types";
import { writeAudit } from "../compliance/writeAudit.ts";
import { planTitleFilter } from "../search/planTitleFilter.ts";

type WorkspaceScope = TenantScope & { workspaceId: string };

/**
 * The selection contract shared by every bulk op: EITHER an explicit `contactIds` list OR a `criteria`
 * ContactQuery (select-all-across-search). The API edge has already enforced exactly-one-of via Zod.
 */
export interface BulkSelectionInput {
  contactIds?: string[];
  criteria?: ContactQuery;
}

/** The shared caller context: scope + the verified user id + the resolved workspace role (for policy gates). */
interface BulkActor {
  scope: WorkspaceScope;
  callerUserId: string;
  role: WorkspaceRole;
}

/** Expand title term-filter values through the canonical taxonomy (mirrors searchPortProvider) so a `criteria`
 *  selection resolves the SAME ids the user saw in the results grid (e.g. "CEO" matches "Chief Executive..."). */
function expandTitleFilters(query: ContactQuery): ContactQuery {
  let changed = false;
  const filters = query.filters.map((clause) => {
    if (clause.kind !== "term" || clause.field !== "title") return clause;
    const synonyms = planTitleFilter(clause.values).synonyms;
    if (synonyms.length === 0) return clause;
    changed = true;
    return { ...clause, values: Array.from(new Set([...clause.values, ...synonyms])) };
  });
  return changed ? { ...query, filters } : query;
}

/**
 * Resolve a selection to the workspace-VISIBLE contact ids, INSIDE the given tx so there is no cross-tx
 * visibility gap. Explicit ids are filtered to the visible subset (cross-workspace guard); a `criteria` is
 * resolved via searchRepository, capped at BULK_SELECTION_CAP. Returns ids that are guaranteed live + visible.
 */
async function resolveVisibleSelection(tx: Tx, selection: BulkSelectionInput): Promise<string[]> {
  if (selection.criteria) {
    return searchRepository.resolveVisibleIds(
      tx,
      expandTitleFilters(selection.criteria),
      BULK_SELECTION_CAP,
    );
  }
  return contactRepository.visibleContactIds(tx, selection.contactIds ?? []);
}

// ── 1. Assign / reassign owner ─────────────────────────────────────────────────────────────────────────
export interface BulkAssignOwnerInput extends BulkActor, BulkSelectionInput {
  /** The new soft owner, or null to clear (unassign). */
  ownerUserId: string | null;
}

/**
 * Bulk assign/reassign the soft owner over the visible selection. POLICY: workspace owner/admin may set ANY
 * owner; a member/viewer may only assign to THEMSELVES or clear (null) — assigning to a different user is a
 * 403. A non-null target owner must be an ACTIVE member of the workspace (else 404, no existence leak). Audits
 * `contact.update` with the new owner in metadata.
 */
export async function assignOwner(input: BulkAssignOwnerInput): Promise<{ affected: number }> {
  const { scope, callerUserId, role, ownerUserId } = input;
  const isAdmin = role === "owner" || role === "admin";
  if (!isAdmin && ownerUserId !== null && ownerUserId !== callerUserId) {
    throw new ForbiddenError(
      "insufficient_role",
      "Members can only assign prospects to themselves or clear the owner.",
    );
  }
  return withBulkTx(scope, async (tx) => {
    // A non-null target owner must be an ACTIVE member of the workspace (getRoleForUser is null otherwise).
    if (ownerUserId !== null) {
      const targetRole = await workspaceRepository.getRoleForUser(
        scope.tenantId,
        scope.workspaceId,
        ownerUserId,
      );
      if (!targetRole) {
        throw new NotFoundError("The chosen owner is not a member of this workspace.");
      }
    }
    const ids = await resolveVisibleSelection(tx, input);
    const affected = await contactRepository.assignOwner(tx, ids, ownerUserId);
    if (affected > 0) {
      await writeAudit(tx, {
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        actorUserId: callerUserId,
        action: "contact.update",
        entityType: "contact",
        metadata: { bulk: "assign_owner", ownerUserId, affected },
      });
    }
    return { affected };
  });
}

// ── 2. Add / remove tags ───────────────────────────────────────────────────────────────────────────────
export interface BulkTagsInput extends BulkActor, BulkSelectionInput {
  tagIds: string[];
}

/**
 * Bulk-assign one or more workspace tags to the visible selection (idempotent per (tag, contact) link). Each
 * tag id is verified to exist in the workspace (else 404). `affected` = the number of contacts processed (the
 * visible selection size). Audits `tag.assign` once with the tag ids + affected count in metadata.
 */
export async function bulkAssignTags(input: BulkTagsInput): Promise<{ affected: number }> {
  return withBulkTx(input.scope, async (tx) => {
    await assertTagsExist(tx, input.tagIds);
    const ids = await resolveVisibleSelection(tx, input);
    for (const tagId of input.tagIds) {
      for (const recordId of ids) {
        await tagRepository.assign(tx, {
          tenantId: input.scope.tenantId,
          workspaceId: input.scope.workspaceId,
          tagId,
          entity: "contact",
          recordId,
        });
      }
    }
    if (ids.length > 0) {
      await writeAudit(tx, {
        tenantId: input.scope.tenantId,
        workspaceId: input.scope.workspaceId,
        actorUserId: input.callerUserId,
        action: "tag.assign",
        entityType: "contact",
        metadata: { bulk: "assign_tags", tagIds: input.tagIds, affected: ids.length },
      });
    }
    return { affected: ids.length };
  });
}

/** Bulk-remove one or more workspace tags from the visible selection (a no-op per missing link). Audits
 *  `tag.unassign`. `affected` = the visible selection size. */
export async function bulkRemoveTags(input: BulkTagsInput): Promise<{ affected: number }> {
  return withBulkTx(input.scope, async (tx) => {
    await assertTagsExist(tx, input.tagIds);
    const ids = await resolveVisibleSelection(tx, input);
    for (const tagId of input.tagIds) {
      for (const recordId of ids) {
        await tagRepository.unassign(tx, tagId, "contact", recordId);
      }
    }
    if (ids.length > 0) {
      await writeAudit(tx, {
        tenantId: input.scope.tenantId,
        workspaceId: input.scope.workspaceId,
        actorUserId: input.callerUserId,
        action: "tag.unassign",
        entityType: "contact",
        metadata: { bulk: "remove_tags", tagIds: input.tagIds, affected: ids.length },
      });
    }
    return { affected: ids.length };
  });
}

/** Every tag id must resolve to a workspace tag (RLS-scoped) — guards against a foreign/non-existent tag id. */
async function assertTagsExist(tx: Tx, tagIds: string[]): Promise<void> {
  for (const tagId of tagIds) {
    const tag = await tagRepository.findById(tx, tagId);
    if (!tag) throw new NotFoundError("Tag not found in this workspace.");
  }
}

// ── 3. Change outreach status ──────────────────────────────────────────────────────────────────────────
export interface BulkStatusInput extends BulkActor, BulkSelectionInput {
  outreachStatus: OutreachStatus;
}

/** Bulk set outreach_status over the visible selection (value validated at the edge). Audits `contact.update`. */
export async function bulkChangeStatus(input: BulkStatusInput): Promise<{ affected: number }> {
  return withBulkTx(input.scope, async (tx) => {
    const ids = await resolveVisibleSelection(tx, input);
    const affected = await contactRepository.setOutreachStatus(tx, ids, input.outreachStatus);
    if (affected > 0) {
      await writeAudit(tx, {
        tenantId: input.scope.tenantId,
        workspaceId: input.scope.workspaceId,
        actorUserId: input.callerUserId,
        action: "contact.update",
        entityType: "contact",
        metadata: { bulk: "change_status", outreachStatus: input.outreachStatus, affected },
      });
    }
    return { affected };
  });
}

// ── 4. Archive (soft hide) ─────────────────────────────────────────────────────────────────────────────
/**
 * Bulk soft-archive (hide) the visible selection: stamp deleted_at so the rows leave search/lists. DISTINCT
 * from the DSAR tombstone (which also NULLs PII + fans out) — this is the reversible hide path. Audits
 * `contact.delete` (the soft-delete; the DSAR hard erase uses dsar.delete, kept separate).
 */
export async function bulkArchive(
  input: BulkActor & BulkSelectionInput,
): Promise<{ affected: number }> {
  return withBulkTx(input.scope, async (tx) => {
    const ids = await resolveVisibleSelection(tx, input);
    const affected = await contactRepository.archive(tx, ids);
    if (affected > 0) {
      await writeAudit(tx, {
        tenantId: input.scope.tenantId,
        workspaceId: input.scope.workspaceId,
        actorUserId: input.callerUserId,
        action: "contact.delete",
        entityType: "contact",
        metadata: { bulk: "archive", affected },
      });
    }
    return { affected };
  });
}

// ── 6. Enroll into a sequence ──────────────────────────────────────────────────────────────────────────
export interface BulkEnrollInput extends BulkActor, BulkSelectionInput {
  sequenceId: string;
}

/**
 * Bulk-enroll the visible selection into a sequence (idempotent per contact). The sequence must exist in the
 * workspace (else 404). Mirrors the single-contact enrollContact GATES, but FILTERS instead of aborting the
 * batch (08 §3): a contact is enrolled only if it is REVEALED (you can't sequence a copy you don't own) and
 * NOT suppressed/DNC — unrevealed or suppressed contacts are counted in `skipped`, never enrolled. An existing
 * (sequence, contact) membership is a silent no-op (alreadyEnrolled). Newly enrolled rows roll the contact's
 * outreach_status up to in_sequence. Audits one `enroll` row for the batch. (Per-contact gate keeps the bulk
 * path compliant; a batched suppression/reveal lookup is a future perf optimization, the cap bounds the cost.)
 */
export async function bulkEnroll(input: BulkEnrollInput): Promise<BulkEnrollResult> {
  return withBulkTx(input.scope, async (tx) => {
    const sequence = await sequenceRepository.getById(tx, input.sequenceId);
    if (!sequence) throw new NotFoundError("Sequence not found in this workspace.");
    const ids = await resolveVisibleSelection(tx, input);

    let enrolled = 0;
    let alreadyEnrolled = 0;
    let skipped = 0;
    for (const contactId of ids) {
      // Gate (mirrors enrollContact): revealed-only + the unbypassable suppression/DNC check. Filtered, not thrown.
      const contact = await revealRepository.getContactForReveal(tx, contactId);
      if (!contact || !contact.isRevealed) {
        skipped += 1;
        continue;
      }
      const suppressed = await suppressionRepository.findMatch(tx, {
        contactId: contact.id,
        emailBlindIndex: contact.emailBlindIndex,
        emailDomain: contact.emailDomain,
      });
      if (suppressed) {
        skipped += 1;
        continue;
      }
      const logId = await outreachLogRepository.enroll(tx, {
        tenantId: input.scope.tenantId,
        workspaceId: input.scope.workspaceId,
        sequenceId: input.sequenceId,
        contactId,
      });
      if (logId) {
        enrolled += 1;
        await outreachLogRepository.markContactInSequence(tx, contactId);
      } else {
        alreadyEnrolled += 1;
      }
    }
    if (enrolled > 0) {
      await writeAudit(tx, {
        tenantId: input.scope.tenantId,
        workspaceId: input.scope.workspaceId,
        actorUserId: input.callerUserId,
        action: "enroll",
        entityType: "sequence",
        entityId: input.sequenceId,
        metadata: { bulk: "enroll", sequenceId: input.sequenceId, enrolled, skipped },
      });
    }
    return { affected: enrolled, enrolled, alreadyEnrolled, skipped };
  });
}

// ── 7. Enrich / re-verify ──────────────────────────────────────────────────────────────────────────────
export interface BulkEnrichInput extends BulkActor, BulkSelectionInput {}

/**
 * Enqueue a re-enrich/re-verify job for the visible selection. Reuses the existing enrichment_jobs path: it
 * creates a queued enrichment_jobs control row whose `options.contactIds` carries the exact visible selection
 * for the enrichment worker to process (sourceName "manual", sourceFile a synthetic "bulk-reenrich" marker).
 * It does NOT run the waterfall inline (that is the worker's job) and does NOT charge credits at enqueue time —
 * the worker enforces the budget breaker per the existing enrichment pipeline. NOT audited: the closed 08 §5
 * enum has no enrichment-job action; the job row itself is the durable record. Returns { affected, jobId }.
 */
export async function bulkEnrich(
  input: BulkEnrichInput,
): Promise<{ affected: number; jobId: string }> {
  // Resolve the visible ids in their own short tx (createJob opens its own withTenantTx).
  const ids = await withBulkTx(input.scope, (tx) => resolveVisibleSelection(tx, input));
  if (ids.length === 0) {
    // Nothing visible to enrich — surface 404 rather than create an empty job.
    throw new NotFoundError("No matching contacts to enrich in this workspace.");
  }
  const job = await enrichmentJobRepository.createJob(input.scope, {
    tenantId: input.scope.tenantId,
    workspaceId: input.scope.workspaceId,
    createdByUserId: input.callerUserId,
    sourceFile: "bulk-reenrich",
    sourceName: "manual",
    status: "queued",
    totalRows: ids.length,
    options: { mode: "bulk_reverify", contactIds: ids },
  });
  return { affected: ids.length, jobId: job.id };
}

// ── 8. CSV export (role-gated, masked columns only) ──────────────────────────────────────────────────────
/** The roles allowed to export (viewer is denied). Owner/admin/member may export the masked, non-PII columns. */
const EXPORT_ROLES: ReadonlySet<WorkspaceRole> = new Set(["owner", "admin", "member"]);

export interface BulkExportInput extends BulkActor, BulkSelectionInput {}

/**
 * Role-gated CSV export of the MASKED (non-PII) columns for the visible selection — NEVER decrypts email/phone.
 * Viewer is denied (403). Audits `export` with the row count. Returns the CSV body as a string (the route sets
 * the text/csv content type + filename). One workspace-scoped tx: resolve ids → fetch masked rows → audit.
 */
export async function bulkExportCsv(
  input: BulkExportInput,
): Promise<{ csv: string; affected: number }> {
  if (!EXPORT_ROLES.has(input.role)) {
    throw new ForbiddenError("insufficient_role", "Your role does not allow exporting contacts.");
  }
  return withBulkTx(input.scope, async (tx) => {
    const ids = await resolveVisibleSelection(tx, input);
    const rows = await contactRepository.listMaskedByIds(tx, ids);
    await writeAudit(tx, {
      tenantId: input.scope.tenantId,
      workspaceId: input.scope.workspaceId,
      actorUserId: input.callerUserId,
      action: "export",
      entityType: "contact",
      metadata: { bulk: "export_csv", affected: rows.length },
    });
    return { csv: toCsv(rows), affected: rows.length };
  });
}

/** The exported, MASKED columns (no PII). Header order is stable so the file is deterministic + diff-friendly. */
const EXPORT_COLUMNS = [
  "id",
  "firstName",
  "lastName",
  "jobTitle",
  "emailDomain",
  "emailStatus",
  "hasEmail",
  "hasPhone",
  "seniorityLevel",
  "department",
  "locationCountry",
  "locationCity",
  "outreachStatus",
  "isRevealed",
  "ownerUserId",
  "createdAt",
] as const;

/** Serialize masked contacts to RFC-4180 CSV (always-quoted, CRLF rows) — no PII columns are ever included. */
function toCsv(rows: Array<Record<string, unknown>>): string {
  const cell = (v: unknown): string => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const header = EXPORT_COLUMNS.map(cell).join(",");
  const lines = rows.map((r) => EXPORT_COLUMNS.map((col) => cell(r[col])).join(","));
  return [header, ...lines].join("\r\n");
}

// ── 9. Select-all-across-search count ────────────────────────────────────────────────────────────────────
/** The exact total of workspace-visible contacts matching a query (powers "Select all N results"). */
export async function searchCount(
  scope: WorkspaceScope,
  query: ContactQuery,
): Promise<{ total: number }> {
  const total = await searchRepository.countContacts(scope, expandTitleFilters(query));
  return { total };
}

// ── 10. Credit ESTIMATE before run (D5, list-plan/06 §4.2) ───────────────────────────────────────────────
export interface BulkEstimateInput extends BulkActor, BulkSelectionInput {
  action: BulkEstimateAction;
}

/**
 * Project the spend a bulk REVEAL or ENRICH/re-verify would cost, BEFORE any credit is spent (list-plan D5 —
 * "always show cost + estimate before spend"). Resolves the selection to the workspace-VISIBLE ids (the same
 * cross-workspace-safe path the real mutation uses, so the count is honest), reads the non-PII per-member
 * signals, then projects:
 *
 *  - **reveal** — `billable` = members that are revealable (have an email + not yet revealed in this
 *    workspace); `projectedMax` = billable × the per-email reveal cost (07 §1). This is the WORST case — the
 *    actual charge is ≤ this because charge-only-valid (06 §4.1): an `invalid`/`catch_all`/`unknown` verify
 *    charges 0. Already-revealed members are `matchable` (re-reveal is free, first-wins).
 *  - **enrich / re-verify** — enrichment fills the overlay and re-verify re-checks owned data: BOTH are a
 *    SYSTEM cost, never a user credit charge (06 §1/§3.4 — "Re-verify ≠ re-charge"; "users pay only on
 *    reveal"). So `projectedMax` = 0 and every visible member is `matchable` (resolved internally / owned).
 *    New paid provider data only ever bills later, through a reveal, gated by this same estimate.
 *
 * A RANGE estimate, never a guarantee (06 §4.2). One workspace-scoped tx; reads only — spends nothing.
 */
export async function estimateBulkSpend(input: BulkEstimateInput): Promise<BulkSpendEstimate> {
  return withBulkTx(input.scope, async (tx) => {
    const ids = await resolveVisibleSelection(tx, input);
    const balance = await creditRepository.currentBalance(tx, input.scope.tenantId);
    const selectionCount = ids.length;

    if (input.action === "enrich") {
      // Enrichment/re-verify is a SYSTEM cost (06 §1/§3.4) — no user credits are charged at run time. Every
      // visible member resolves internally (it is already in the workspace overlay), so all are `matchable`.
      return {
        action: "enrich",
        selectionCount,
        matchableCount: selectionCount,
        billableCount: 0,
        projectedMaxCredits: 0,
        balance,
        balanceAfterMin: balance,
      };
    }

    // reveal — project the worst-case per-valid charge over the revealable members.
    const signals = await contactRepository.enrichSignalsByIds(tx, ids);
    const revealable = signals.filter((s) => s.hasEmail && !s.isRevealed).length;
    // Already-revealed members re-reveal for free (per-workspace first-wins, 06 §4.4) → matchable, 0 spend.
    const alreadyRevealed = signals.filter((s) => s.isRevealed).length;
    const projectedMaxCredits = revealable * env.REVEAL_COST_EMAIL;
    return {
      action: "reveal",
      selectionCount,
      matchableCount: alreadyRevealed,
      billableCount: revealable,
      projectedMaxCredits,
      balance,
      balanceAfterMin: balance - projectedMaxCredits,
    };
  });
}

// ── shared tx helper ─────────────────────────────────────────────────────────────────────────────────────
/** Run a bulk mutation inside ONE workspace-scoped tx (RLS GUC set) — the single seam all writes go through. */
function withBulkTx<T>(scope: WorkspaceScope, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withTenantTx(scope, fn);
}
