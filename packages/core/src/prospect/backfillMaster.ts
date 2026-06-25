// backfillMaster.ts — the EXISTING-data complement to the Phase-2′ import resolution (PLAN_00 §11.5 / PLAN_07
// Stage B "per-workspace attach"). runImport resolves a row's master_person_id / master_company_id AS IT LANDS;
// this job resolves the overlay rows that landed BEFORE resolution existed (or whose per-row resolution failed
// non-fatally and left the bridges NULL = in-flight staging, ADR-0021). It walks ONE workspace in keyset-paged,
// bounded batches and re-resolves each contact through THE SAME resolver runImport uses
// (masterGraphRepository.resolveForImport) — one resolver, no skew between the import path and the backfill
// (ADR-0037). For each unresolved contact it stamps contacts.master_person_id and, when the contact has an
// account and ER resolved a company, accounts.master_company_id (the account stamp is IS-NULL-guarded in the
// repo, so it never clobbers an already-linked account).
//
// Tx topology mirrors runImport's split-role access: overlay reads/writes run under leadwolf_app (withTenantTx,
// RLS-scoped to the caller's workspace via the tx GUC — there is no explicit workspace predicate, isolation
// rides the tx), while master-graph resolution runs under the least-privilege leadwolf_er role (withErTx),
// because leadwolf_app has NO grant on the master_* tables. To keep the transaction count sane we resolve a
// WHOLE batch under one withErTx, then stamp the whole batch under one withTenantTx.
//
// Idempotent + crash-safe: findUnresolvedForBackfill only returns rows whose master_person_id IS NULL, so a
// re-run resolves only what's still unstamped; a row whose resolve/stamp fails stays NULL and is simply picked
// up by the next pass. Keyset cursor = the last row's id, so the job resumes from any cursor after a crash
// without re-scanning. A single bad row never aborts the batch — its error is logged and the row is skipped,
// leaving it NULL (in-flight staging) for a later pass.

import {
  accountRepository,
  contactRepository,
  masterGraphRepository,
  withErTx,
  withTenantTx,
} from "@leadwolf/db";
import { companyDomainKey } from "../enrichment/freemailDomains.ts";

export interface MasterBackfillResult {
  /** Total unresolved rows seen across every batch this run. */
  scanned: number;
  /** Of those, the rows that got a master_person_id stamped this run. */
  resolved: number;
}

/** One resolved row ready to be stamped under the overlay tx. */
interface ResolvedRow {
  contactId: string;
  accountId: string | null;
  /** null when the contact carried no person key (keyless row) — the person bridge stays NULL (staging). */
  masterPersonId: string | null;
  masterCompanyId: string | null;
}

/**
 * Backfill master_* bridges for the EXISTING overlay contacts of one workspace whose master_person_id is still
 * NULL, re-resolving each through the Phase-2′ resolver and stamping the contact (and, when applicable, its
 * account). Loops keyset-paged batches until a short/empty page; returns the scanned / resolved tally.
 *
 * The resolver input is built EXACTLY like runImport's landing-row path (resolveMasterForLanding): identity +
 * blind-index dedup keys only (never a revealable PII value), with the company key gated through
 * companyDomainKey so a freemail/role domain mints no company (F4). The account domain is preferred, falling
 * back to the email domain.
 */
export async function runMasterBackfill(
  scope: { tenantId: string; workspaceId: string },
  opts?: { batchSize?: number },
): Promise<MasterBackfillResult> {
  const limit = opts?.batchSize ?? 500;
  let cursor: string | null = null;
  let scanned = 0;
  let resolved = 0;

  for (;;) {
    // 1) Read one keyset-paged batch of unresolved contacts under the workspace-scoped overlay role.
    const batch = await withTenantTx(scope, (tx) =>
      contactRepository.findUnresolvedForBackfill(tx, cursor, limit),
    );
    if (batch.length === 0) break;
    scanned += batch.length;

    // 2) Resolve the WHOLE batch under ONE withErTx (leadwolf_er). One bad row is non-fatal: log + skip it, so
    //    it stays NULL (in-flight staging) for a later pass rather than aborting the batch.
    const resolvedRows: ResolvedRow[] = await withErTx(async (erTx) => {
      const out: ResolvedRow[] = [];
      for (const row of batch) {
        try {
          const input = {
            linkedinPublicId: row.linkedinPublicId ?? undefined,
            emailBlindIndex: row.emailBlindIndex ?? undefined,
            emailDomain: row.emailDomain ?? undefined,
            registrableDomain:
              companyDomainKey(row.accountDomain) ?? companyDomainKey(row.emailDomain),
            companyName: row.accountName ?? undefined,
          };
          const { masterPersonId, masterCompanyId } = await masterGraphRepository.resolveForImport(
            erTx,
            input,
          );
          out.push({
            contactId: row.id,
            accountId: row.accountId,
            masterPersonId,
            masterCompanyId,
          });
        } catch (err) {
          // Never fail the batch on one row — leave it NULL for the next pass (ADR-0021 staging).
          console.error("[master-backfill] resolve failed; leaving row unresolved", row.id, err);
        }
      }
      return out;
    });

    // 3) Stamp the whole batch under ONE withTenantTx (leadwolf_app, RLS-scoped). Stamp the contact bridge
    //    always; stamp the account bridge only when the contact has an account AND ER resolved a company
    //    (setMasterCompanyId is IS-NULL-guarded in the repo, so it never clobbers an already-linked account).
    //    A per-row stamp failure is non-fatal — skip it (the row stays NULL for the next pass).
    await withTenantTx(scope, async (tx) => {
      for (const r of resolvedRows) {
        try {
          // Stamp the person bridge ONLY when the row resolved to a golden person; a keyless row returns
          // masterPersonId null and stays NULL (in-flight staging), never minting a junk identity. The account
          // bridge is independent — a keyless contact may still resolve its company by domain.
          if (r.masterPersonId) {
            await contactRepository.update(tx, r.contactId, { masterPersonId: r.masterPersonId });
            resolved += 1;
          }
          if (r.accountId && r.masterCompanyId) {
            await accountRepository.setMasterCompanyId(tx, r.accountId, r.masterCompanyId);
          }
        } catch (err) {
          console.error("[master-backfill] stamp failed; leaving row unresolved", r.contactId, err);
        }
      }
    });

    // 4) Advance the keyset cursor to the last row's id; a short page means we reached the end.
    cursor = batch[batch.length - 1]!.id;
    if (batch.length < limit) break;
  }

  return { scanned, resolved };
}
