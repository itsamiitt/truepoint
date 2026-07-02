// createRevealJob.ts — the create + confirm steps of the async bulk-reveal job (Phase 3). Create resolves the
// selection to the caller's VISIBLE contacts, computes the worst-case estimate (visibility + current ownership),
// and persists the control row (awaiting_confirmation) + one queued work-row per contact — spending NOTHING.
// Confirm is the money gate: it atomically leases the worst-case ceiling (ADR-0029) and flips the job to
// running (revealJobRepository.confirmAndLease); the API then enqueues the drive. No credit moves until confirm.

import {
  type ConfirmRevealJobResult,
  type TenantScope,
  contactRepository,
  revealJobRepository,
  revealRepository,
  withTenantTx,
} from "@leadwolf/db";
import type { RevealType } from "@leadwolf/types";
import { revealCostFor } from "../revealContact.ts";
import { type RevealCandidate, type RevealEstimate, projectRevealEstimate } from "./estimate.ts";

type WsScope = TenantScope & { workspaceId: string };

export interface CreateRevealJobInput {
  scope: WsScope;
  revealType: RevealType;
  contactIds: string[];
  createdByUserId: string;
  idempotencyKey?: string | null;
}

export interface CreateRevealJobResult {
  jobId: string;
  created: boolean;
  estimate: RevealEstimate;
}

export async function createRevealJob(input: CreateRevealJobInput): Promise<CreateRevealJobResult> {
  const { scope, revealType } = input;

  // Read visibility + current ownership to size the worst-case estimate (one scoped tx; no PII decrypted).
  const { visible, candidates } = await withTenantTx(scope, async (tx) => {
    const vis = await contactRepository.visibleContactIds(tx, input.contactIds);
    if (vis.length === 0) return { visible: [] as string[], candidates: [] as RevealCandidate[] };
    const masked = await contactRepository.listMaskedByIds(tx, vis);
    const claims = await revealRepository.listClaimsByContactIds(tx, scope.workspaceId, vis);
    const owned = new Map<string, { email: boolean; phone: boolean }>();
    for (const c of claims) {
      const e = owned.get(c.contactId) ?? { email: false, phone: false };
      if (c.revealType === "email" || c.revealType === "full_profile") e.email = true;
      if (c.revealType === "phone" || c.revealType === "full_profile") e.phone = true;
      owned.set(c.contactId, e);
    }
    const maskedById = new Map(masked.map((m) => [m.id, m]));
    const orderedVisible: string[] = [];
    const cands: RevealCandidate[] = [];
    for (const cId of vis) {
      const m = maskedById.get(cId);
      if (!m) continue;
      const o = owned.get(cId) ?? { email: false, phone: false };
      orderedVisible.push(cId);
      cands.push({
        hasEmail: m.hasEmail,
        hasPhone: m.hasPhone,
        ownedEmail: o.email,
        ownedPhone: o.phone,
      });
    }
    return { visible: orderedVisible, candidates: cands };
  });

  const estimate = projectRevealEstimate(revealType, candidates, revealCostFor(revealType));

  const job = await revealJobRepository.createJob(scope, {
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
    createdByUserId: input.createdByUserId,
    revealType,
    totalContacts: estimate.totalContacts,
    creditEstimate: estimate.projectedMaxCredits,
    idempotencyKey: input.idempotencyKey ?? null,
  });

  if (job.created) {
    await revealJobRepository.insertRows(
      scope,
      job.id,
      visible.map((contactId, rowIndex) => ({ contactId, rowIndex })),
    );
  }

  return { jobId: job.id, created: job.created, estimate };
}

/** The confirm money gate — leases the worst-case ceiling + flips awaiting_confirmation → running, atomically. */
export async function confirmRevealJob(
  scope: WsScope,
  jobId: string,
  userId: string,
): Promise<ConfirmRevealJobResult> {
  return revealJobRepository.confirmAndLease(scope, jobId, userId);
}
