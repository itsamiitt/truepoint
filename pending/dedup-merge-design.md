# Design + Threat Model — `dedup_merge` / `bulk_delete` executors

> **Status (2026-07-02):** **GRAIN A IMPLEMENTED** on the user's go-ahead, with this doc's recommended defaults —
> overlay-only marker merge (one pair, reversible via unmark) + soft-only `bulk_delete` (cap 1000), both with
> EXPLICIT tenant+workspace predicates under FOR UPDATE (`platformAdminWrites.execDedupMerge` /
> `execBulkDelete`, wired in `dataRoutes.ts`'s approve executor). **GRAIN B (master-graph cluster merge/split)
> remains DESIGN-ONLY, security-review-gated** — §4's threat model and §5's grain-B decisions still stand for it.
> **Author:** agent · **Date:** 2026-07-01 (design) / 2026-07-02 (grain A shipped)

## 1. Where this plugs in (already built)

- The approval operations exist: `DATA_APPROVAL_OPERATIONS = ["bulk_delete", "dedup_merge", "retention_enforce", "bulk_export"]`
  (`packages/types/src/dataApproval.ts`).
- Maker-checker is live: file → approve/reject, requester ≠ approver, audited via `withPlatformTx`
  (`apps/api/src/features/admin/dataRoutes.ts`, `platformAdminWrites.decideApproval`).
- The executor seam exists: on approve, `dataRoutes.ts:~327` runs the op; today only `retention_enforce` and
  `bulk_export` execute — `dedup_merge` / `bulk_delete` hit *"No executor is wired for '<op>' yet"* (`:357`).
- The ER layer exists: `packages/db/src/repositories/erRepository.ts`, `schema/masterGraph.ts`
  (`master_persons`, `match_links`(`cluster_id`,`source_record_id`,`review_status`,`is_duplicate_of`),
  `source_records`(`resolved_person_id`)), and the survivorship projector
  (`projectorRepository.ts` + `projection_outbox`).
- The overlay dedup marker exists: `contacts.duplicate_of_contact_id` + the customer review surface
  (`listDuplicatePairs` / `unmarkDuplicate`, shipped).

## 2. What each executor does

### `dedup_merge` (confirm two records are the same entity)
Two grains are possible — **the review must pick one as v1** (recommend A):

- **A. Overlay-only merge (RECOMMENDED v1, lower blast radius):** operate on one workspace's `contacts`.
  Mark the loser `duplicate_of_contact_id = survivor`, re-point its list memberships / activity to the survivor,
  and (optionally) copy non-conflicting fields survivor-wins. NO master-graph write. Reversible via the existing
  `unmarkDuplicate`. Tenant/workspace-scoped — never spans tenants.
- **B. Master-graph cluster merge (Phase-2, higher blast radius):** re-point the loser cluster's `match_links` +
  `source_records.resolved_person_id` onto the survivor `cluster_id`, then enqueue a survivorship re-projection
  (`projection_outbox`) so each affected workspace's overlay golden fields recompute. This touches the SHARED
  Layer-0 graph and is where the cross-tenant threats below concentrate.

### `bulk_delete` (remove a set of records)
Soft-delete a bounded set of `contacts` (`deleted_at = now()`), tenant/workspace-scoped, with a hard cap on the
selection size. Cascades (list memberships, provenance) follow existing FK/soft-delete rules. Never a hard delete
in v1 (retention enforce owns hard deletion, separately gated).

## 3. The write primitive (build spec, once approved)

New master-graph write repo (privileged, audited) — only if grain B is approved:
- `mergeClusters(tx, { survivorClusterId, loserClusterId, actor })` — re-point `match_links` + `source_records`
  of the loser to the survivor; write a merge audit row; enqueue re-projection. Idempotent.
- `splitCluster(tx, { clusterId, sourceRecordIds })` — the inverse (reversibility mandate).
- Overlay re-point (grain A): `mergeContacts(tx, { survivorId, loserId })` — set `duplicate_of_contact_id`,
  move list memberships, soft-delete the loser. Reuses the existing overlay repo.
Runs INSIDE the approval's `withPlatformTx` so the decision + effect + audit row are one atomic transaction.

## 4. THREAT MODEL (the review checklist)

The executor runs under `withPlatformTx` = **owner/privileged role that BYPASSES RLS**. Therefore every write must
scope itself EXPLICITLY — never rely on RLS (the `findMatchExplicit` lesson). Points to sign off:

1. **Cross-tenant isolation.** Grain A must assert survivor + loser are in the SAME `tenant_id`/`workspace_id`
   (reject otherwise). Grain B: a cluster merge must not cause tenant A's overlay to surface tenant B's values —
   the re-projection must recompute each workspace's golden record from ONLY that workspace's entitled source
   records. **Add a cross-tenant isolation test** (a merge in tenant A leaves tenant B's projection unchanged).
2. **Authorization.** File = `data:manage`; approve = `data:review`; requester ≠ approver (already enforced).
   Confirm no self-approval path and that an expired request cannot execute.
3. **Reversibility.** Every merge is undoable (`unmarkDuplicate` / `splitCluster`). No irreversible master write in v1.
4. **Blast radius.** `bulk_delete` selection is capped (propose 1,000) + soft-delete only; `dedup_merge` is one
   pair per request. No unbounded fan-out inside the tx.
5. **Audit.** `withPlatformTx` writes `platform_audit_log` with `targetType`/`targetId`/`tenantId` + params; the
   row rolls back if the executor throws ("no trace for an action that didn't happen").
6. **PII.** The approval `params` + audit must carry IDs, never record values. No decrypted PII in the audit trail.
7. **Idempotency / replay.** Re-approving an already-executed request is a no-op (status guard), and the primitive
   is idempotent (re-pointing an already-merged cluster changes nothing).

## 5. Open decisions for the reviewer
- **Grain: A (overlay, recommended) or B (master graph) for v1?** Everything else follows from this.
- **`bulk_delete`: soft-only + cap value?** (recommend soft-only, cap 1,000.)
- **Does grain B require a second sign-off** (compliance_officer) beyond `data:review`?

Once §5 is decided + §4 signed off, the build is §3 + the executor branch in `dataRoutes.ts` + the isolation test.
