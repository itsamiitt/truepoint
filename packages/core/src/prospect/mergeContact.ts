// mergeContact.ts — the ORCHESTRATOR of the contact TRUE-MERGE engine (import-and-data-model-redesign 04 §3;
// S-C4). It is the ONE value-moving merge implementation (DM1); both surfaces call it — the customer verb
// (apps/api, Surface 2) and the Surface-1 staff maker-checker wrapper (S-C9). It composes the PURE field-union
// planner (contactMergePlan.ts) with the transactional executor (contactMergeRepository) inside ONE
// withTenantTx: survivor field writes + type-aware channel demotion + the full Class-A child re-point
// inventory + the loser tombstone + the contact.merge audit event commit or roll back AS ONE (04 §pre-build
// failure-modes). RLS on the tx is the tenant wall — this NEVER runs the owner path (04 §pre-build security).
//
// The caller (the verb) has ALREADY passed the dual gate (isContactMergeEnabled) + the role gate + the
// Idempotency-Key middleware; the engine is only constructed when the gate is ON. Legality (04 §3.1/§edge):
// self-merge → 400; loser already merged/tombstoned → 409 contact_merged (carries mergedInto); survivor
// tombstoned → 409; per-workspace daily cap → 409. Both ids are resolved via the RLS-scoped FOR UPDATE load
// (the IDOR guard) in deterministic id order (the concurrent-merge race guard).

import { env } from "@leadwolf/config";
import { contactMergeRepository, type SurvivorWriteSet, withTenantTx } from "@leadwolf/db";
import {
  CONTACT_MERGE_DECIDABLE_FIELDS,
  ContactMergeCapError,
  ContactMergedError,
  type FieldChangeAuditMetadata,
  type MergeFieldDecision,
  type MergeResult,
  NotFoundError,
  ValidationError,
} from "@leadwolf/types";
import { contactMergeEnabledForScope } from "./contactMergeGate.ts";
import { type MergeScalars, planContactMerge } from "./contactMergePlan.ts";

export interface RunContactMergeInput {
  scope: { tenantId: string; workspaceId: string };
  /** Survivor = the record that keeps its id (04 §3.2). */
  survivorContactId: string;
  loserContactId: string;
  decisions: MergeFieldDecision[];
  /** The merge actor (audit + explicit-loser-pick pins). null = system (never, in practice — both surfaces
   *  carry an actor). */
  userId: string;
}

const isBlank = (v: unknown): boolean =>
  v === null || v === undefined || (typeof v === "string" && v.trim() === "");

const scalarsOf = (r: {
  firstName: string | null;
  lastName: string | null;
  jobTitle: string | null;
  seniorityLevel: string | null;
  department: string | null;
  locationCountry: string | null;
  locationCity: string | null;
}): MergeScalars => ({
  firstName: r.firstName,
  lastName: r.lastName,
  jobTitle: r.jobTitle,
  seniorityLevel: r.seniorityLevel,
  department: r.department,
  locationCountry: r.locationCountry,
  locationCity: r.locationCity,
});

function startOfUtcDay(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * Execute a contact true-merge (04 §3). Survivor keeps its id; the loser is tombstoned with an irreversible
 * merged_into pointer. Returns the survivor id, the per-child re-point tallies, and the audit event id.
 * Idempotent: re-submitting the same pair after commit fails the merged-input legality check (the loser is
 * tombstoned), so a retry (same Idempotency-Key or not) has no second effect (04 §pre-build duplicate).
 */
export async function runContactMerge(input: RunContactMergeInput): Promise<MergeResult> {
  const { scope, survivorContactId, loserContactId, decisions, userId } = input;
  if (survivorContactId === loserContactId) {
    throw new ValidationError("A contact cannot be merged into itself.");
  }
  // Allowlist the decision fields (closed set — 04 §pre-build security; unknown enum → 400).
  for (const d of decisions) {
    if (!CONTACT_MERGE_DECIDABLE_FIELDS.includes(d.field)) {
      throw new ValidationError(`Unknown merge decision field: ${d.field}`);
    }
  }

  return withTenantTx(scope, async (tx) => {
    const { survivor, loser } = await contactMergeRepository.lockAndLoadPair(
      tx,
      survivorContactId,
      loserContactId,
    );
    // RLS made a foreign/cross-tenant id invisible ⇒ absent ⇒ 404 (the IDOR guard, no cross-workspace touch).
    if (!survivor || !loser) {
      throw new NotFoundError("Both contacts must exist in this workspace to merge.");
    }
    // Legality (04 §3.1/§edge): neither side already merged; survivor must be live.
    if (loser.deletedAt || loser.mergedIntoContactId) {
      // Carry the loser's ACTUAL supersession pointer (null when it was soft-deleted but never merged) — never a
      // best-effort `survivor.id` fallback: the S-C9 staff wrapper keys its idempotent re-approve on
      // `mergedInto === survivorId`, so a fabricated survivor pointer would let a deleted-not-merged loser
      // falsely report an idempotent success (a merge that never moved values marked "done"). 04 §edge.
      throw new ContactMergedError(
        loser.mergedIntoContactId,
        "The loser contact is already merged or deleted.",
      );
    }
    if (survivor.deletedAt || survivor.mergedIntoContactId) {
      throw new ContactMergedError(
        survivor.mergedIntoContactId,
        "The survivor contact is already merged or deleted.",
      );
    }

    // Per-workspace daily cap (04 §3.1 FinOps brake). 0 = unlimited.
    const cap = env.CONTACT_MERGE_DAILY_CAP;
    if (cap > 0) {
      const used = await contactMergeRepository.countMergesSince(
        tx,
        scope.workspaceId,
        startOfUtcDay(),
      );
      if (used >= cap) {
        throw new ContactMergeCapError(
          "This workspace has reached its daily merge limit. It resets at UTC midnight.",
        );
      }
    }

    const mergedAtIso = new Date().toISOString();
    const plan = planContactMerge({
      survivor: {
        scalars: scalarsOf(survivor),
        provenance: survivor.fieldProvenance,
        customFields: survivor.customFields,
      },
      loser: { scalars: scalarsOf(loser), customFields: loser.customFields },
      decisions,
      userId,
      mergedAtIso,
    });

    // 04 §1 non-scalar "blank fills from loser" + reveal-trio adoption + last_activity max.
    const writeSet: SurvivorWriteSet = {
      scalarWrites: plan.scalarWrites as Record<string, string | null>,
      provenance: plan.provenance,
      customFields: plan.customFields,
    };
    if (isBlank(survivor.accountId) && !isBlank(loser.accountId)) writeSet.accountId = loser.accountId;
    if (isBlank(survivor.ownerUserId) && !isBlank(loser.ownerUserId)) {
      writeSet.ownerUserId = loser.ownerUserId;
    }
    if (isBlank(survivor.masterPersonId) && !isBlank(loser.masterPersonId)) {
      writeSet.masterPersonId = loser.masterPersonId;
    }
    // Reveal state (04 §3.4, billing-sensitive): if the loser is revealed and the survivor is not, the
    // survivor adopts the loser's reveal trio as a unit (the CHECKs are satisfied together); if both are
    // revealed, the survivor keeps its own (first-reveal-wins). The contact_reveals CLAIMS re-point regardless.
    if (loser.isRevealed && !survivor.isRevealed) {
      writeSet.isRevealed = true;
      writeSet.revealedByUserId = loser.revealedByUserId;
      writeSet.revealedAt = loser.revealedAt;
    }
    // last_activity_at = max(survivor, loser).
    if (
      loser.lastActivityAt &&
      (!survivor.lastActivityAt || loser.lastActivityAt > survivor.lastActivityAt)
    ) {
      writeSet.lastActivityAt = loser.lastActivityAt;
    }

    await contactMergeRepository.applySurvivorWrites(tx, survivorContactId, writeSet);
    const repointed = await contactMergeRepository.repointChildren(tx, loserContactId, survivorContactId, {
      workspaceId: scope.workspaceId,
    });
    await contactMergeRepository.tombstoneLoser(tx, loserContactId, survivorContactId);

    // The contact.merge audit event (04 §4): reconstructable from audit alone — survivor, loser, decisions,
    // the loser's field_provenance map, the scalar before/after, and the re-point tallies per child table.
    const fieldChangeMeta: FieldChangeAuditMetadata = { src: "merge", fields: plan.fieldChanges };
    const auditEventId = await contactMergeRepository.recordMergeEvent(tx, {
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      actorUserId: userId,
      survivorContactId,
      loserContactId,
      metadata: {
        survivorContactId,
        loserContactId,
        decisions,
        loserFieldProvenance: loser.fieldProvenance,
        repointed,
        ...(fieldChangeMeta as unknown as Record<string, unknown>),
      },
    });

    return { survivorContactId, loserContactId, repointed, auditEventId };
  });
}

/**
 * Surface-1 (staff, maker-checker) contact true-merge (04 §3.5; S-C9) — the wrapper over the SAME core engine
 * the customer verb uses (DM1: ONE value-moving merge implementation, TWO entry surfaces). It supersedes the
 * grain-A `dedup_merge` executor FOR VALUE MOVING only — that executor keeps its shipped marker-only semantics
 * (a reversible staff annotation); this one runs the irreversible engine on the target tenant's withTenantTx
 * (RLS-correct — NOT the owner path). "Rides the merge gate + maker-checker" (15 seq 65): the tenant's merge
 * dual gate must be ON, and the caller (the approval executor) has already enforced maker≠checker.
 *
 * SEAM CAVEAT (recorded in doc 16): the engine commits in its OWN tenant tx, so it is not rolled back by a
 * later failure in the owner-path approval tx. To keep a re-approve after a partial SAFE, an already-merged
 * loser (merged into THIS survivor) is treated as an idempotent success rather than a hard 409.
 */
export async function runStaffContactMerge(input: RunContactMergeInput): Promise<MergeResult> {
  if (!(await contactMergeEnabledForScope(input.scope))) {
    throw new ValidationError(
      "Contact merge is not enabled for this tenant — flip the merge gate before approving a true merge.",
    );
  }
  try {
    return await runContactMerge(input);
  } catch (err) {
    // Idempotent replay of our OWN prior (partially-committed) merge: the loser is already merged into this
    // survivor → treat as done so the approval can be marked executed on retry (not wedged forever).
    if (
      err instanceof ContactMergedError &&
      err.extensions?.mergedInto === input.survivorContactId
    ) {
      return {
        survivorContactId: input.survivorContactId,
        loserContactId: input.loserContactId,
        repointed: {},
        auditEventId: null,
      };
    }
    throw err;
  }
}
