// accountRepository.ts — data access for `accounts` (reveal/contacts domain). The import pipeline upserts a
// contact's company by its per-workspace dedup key (domain), so a contact links to one shared account row.
// Methods take the caller's transaction (Tx) so the whole per-row import runs in one withTenantTx (03 §9).

import { eq, sql } from "drizzle-orm";
import type { Tx } from "../client.ts";
import { accounts } from "../schema/contacts.ts";

/** Firmographic fields the rollup may set (24 Phase-0.5). Only provided fields are written. */
export interface AccountFirmographicsPatch {
  technologies?: string[];
  fundingStage?: string | null;
  companyStage?: string | null;
  foundedYear?: number | null;
}

export interface AccountUpsertInput {
  tenantId: string;
  workspaceId: string;
  name: string;
  domain: string; // required — accounts are deduped on (workspace_id, domain); callers skip domainless rows
  // overlay → Layer-0 golden bridge (ADR-0021); set by import MATCH-AGAINST resolution. Nullable; only written
  // when resolution returns a company so a later unresolved upsert never clobbers an existing bridge with null.
  masterCompanyId?: string | null;
}

export const accountRepository = {
  /**
   * The company-match ladder rung C1 (06 §5) + create-on-miss: insert the account, or return the existing LIVE
   * one for this (workspace, domain). Returns the account id. The ON CONFLICT arbiter is the S-A5 live-only
   * partial unique `uniq_accounts_ws_domain WHERE domain IS NOT NULL AND deleted_at IS NULL` — so the
   * `targetWhere` MUST carry `AND deleted_at IS NULL` to match that predicate (Postgres infers a partial arbiter
   * only when the ON CONFLICT predicate implies the index predicate; the pre-S-A5 `domain IS NOT NULL` alone no
   * longer matches and would fail inference at runtime once 0061 is applied — a gate-INDEPENDENT correctness fix
   * the S-A5 index swap made necessary, doc 16 drift row). Behaviour-neutral today (nothing writes deleted_at
   * yet ⇒ every row satisfies `deleted_at IS NULL`); once the soft-delete verb ships this is exactly 06 §4's
   * "import upsert on a tombstoned account creates a NEW account, never resurrects" — a tombstoned same-domain
   * row is not in the arbiter index, so ON CONFLICT does not fire against it and a fresh account is minted.
   */
  async upsertByDomain(tx: Tx, input: AccountUpsertInput): Promise<string> {
    const rows = await tx
      .insert(accounts)
      .values({
        tenantId: input.tenantId,
        workspaceId: input.workspaceId,
        name: input.name,
        domain: input.domain,
        masterCompanyId: input.masterCompanyId ?? null,
      })
      .onConflictDoUpdate({
        target: [accounts.workspaceId, accounts.domain],
        targetWhere: sql`${accounts.domain} IS NOT NULL AND ${accounts.deletedAt} IS NULL`,
        // Only stamp the bridge when resolution actually produced a company — never overwrite an existing
        // master_company_id with null (an unresolved re-import keeps the prior link; ADR-0021 staging).
        set: {
          name: input.name,
          updatedAt: new Date(),
          ...(input.masterCompanyId != null ? { masterCompanyId: input.masterCompanyId } : {}),
        },
      })
      .returning({ id: accounts.id });
    return rows[0]!.id;
  },

  /**
   * Batched mirror of upsertByDomain for an import chunk (15-bulk-import-design §2): one multi-row INSERT …
   * ON CONFLICT (workspace_id, domain) WHERE domain IS NOT NULL DO UPDATE, returning a domain → account-id map.
   * Two semantics are preserved from upsertByDomain:
   *   • the bridge-null rule — `coalesce(excluded.master_company_id, accounts.master_company_id)` so an unresolved
   *     re-import NEVER overwrites an existing master_company_id with null (only a resolved company stamps it);
   *   • name is refreshed from the incoming row (excluded.name), exactly like the single-row set.
   * Inputs MUST be deduped by (workspace_id, domain) FIRST — ON CONFLICT DO UPDATE may not touch the same target
   * row twice in one statement — so duplicates are collapsed in JS (case-insensitively, matching citext): the last
   * row's name wins (mirrors sequential upserts) and the latest non-null master bridge is kept. Domainless inputs
   * are skipped (callers never pass them; accounts dedup on domain). The map is keyed by the stored (lowercased,
   * via the shared normalizeDomain) domain — the same value the caller looks a contact's account up by.
   */
  async upsertByDomainBatch(tx: Tx, inputs: AccountUpsertInput[]): Promise<Map<string, string>> {
    const deduped = new Map<string, AccountUpsertInput>();
    for (const input of inputs) {
      if (!input.domain) continue;
      const key = `${input.workspaceId}\u0000${input.domain.toLowerCase()}`;
      const prev = deduped.get(key);
      // Last-writer-wins name (sequential-upsert parity); keep the latest non-null master bridge across dupes.
      deduped.set(key, {
        ...input,
        masterCompanyId: input.masterCompanyId ?? prev?.masterCompanyId ?? null,
      });
    }
    const values = [...deduped.values()];
    if (values.length === 0) return new Map();

    const rows = await tx
      .insert(accounts)
      .values(
        values.map((input) => ({
          tenantId: input.tenantId,
          workspaceId: input.workspaceId,
          name: input.name,
          domain: input.domain,
          masterCompanyId: input.masterCompanyId ?? null,
        })),
      )
      .onConflictDoUpdate({
        target: [accounts.workspaceId, accounts.domain],
        // Match the S-A5 live-only partial arbiter (see upsertByDomain) — `AND deleted_at IS NULL` is required
        // for partial-index inference once 0061 is applied; behaviour-neutral until soft-delete writes land.
        targetWhere: sql`${accounts.domain} IS NOT NULL AND ${accounts.deletedAt} IS NULL`,
        set: {
          name: sql`excluded.name`,
          updatedAt: new Date(),
          // Never overwrite an existing bridge with null (mirror upsertByDomain): keep the prior value when the
          // incoming row resolved no company. `excluded.*` is the proposed row; `accounts.*` is the existing one.
          masterCompanyId: sql`coalesce(excluded.master_company_id, ${accounts.masterCompanyId})`,
        },
      })
      .returning({ id: accounts.id, domain: accounts.domain });

    const out = new Map<string, string>();
    for (const r of rows) if (r.domain) out.set(r.domain, r.id);
    return out;
  },

  /**
   * The ladder rung C2 "proceed as update" projection (06 §5): when a row's domain resolved to an existing
   * account as a live SECONDARY (via accountChildRepository.findAccountIdBySecondaryDomain), refresh that
   * account exactly as C1's upsert DO UPDATE would — name last-writer-wins + stamp the master bridge only when
   * resolution produced one (never clobber an existing bridge with null; ADR-0021 staging). Bumps updated_at
   * (a user-facing import touch, like the C1 update). NEVER attaches or re-primaries the matched domain — an
   * import never moves a domain (06 §1/§Edge); the domain is already a known secondary of this account. Caller
   * passes an account id already resolved under RLS in the same tx; UPDATE-by-id is concurrency-safe (the row
   * exists). Invoked ONLY on the S-A6-gate-on C2 path.
   */
  async refreshMatchedAccount(
    tx: Tx,
    accountId: string,
    input: { name: string; masterCompanyId?: string | null },
  ): Promise<void> {
    await tx
      .update(accounts)
      .set({
        name: input.name,
        updatedAt: new Date(),
        ...(input.masterCompanyId != null ? { masterCompanyId: input.masterCompanyId } : {}),
      })
      .where(eq(accounts.id, accountId));
  },

  /**
   * Set firmographic facet fields on an account (24 Phase-0.5 populate path). Only the provided fields are
   * written (a partial patch); a no-field patch is a no-op. Caller passes an account id already visible in its
   * workspace (RLS is the backstop). updated_at is intentionally NOT bumped — firmographics are derived
   * annotations refreshed by the rollup, not user edits.
   */
  async updateFirmographics(
    tx: Tx,
    accountId: string,
    patch: AccountFirmographicsPatch,
  ): Promise<void> {
    const set: Record<string, unknown> = {};
    if (patch.technologies !== undefined) set.technologies = patch.technologies;
    if (patch.fundingStage !== undefined) set.fundingStage = patch.fundingStage;
    if (patch.companyStage !== undefined) set.companyStage = patch.companyStage;
    if (patch.foundedYear !== undefined) set.foundedYear = patch.foundedYear;
    if (Object.keys(set).length === 0) return;
    await tx.update(accounts).set(set).where(eq(accounts.id, accountId));
  },

  /**
   * Stamp the overlay → Layer-0 company bridge on an existing account during the master-link backfill. Only
   * writes when master_company_id is currently NULL (the `IS NULL` guard) so a backfill NEVER clobbers an
   * already-resolved bridge — once linked, stays linked (re-pointing on master merge/split is a separate path).
   * updated_at is intentionally NOT bumped: this is a derived backfill, not a user edit (mirrors
   * updateFirmographics). Caller passes an account id already visible in its workspace; RLS is the backstop.
   */
  async setMasterCompanyId(tx: Tx, accountId: string, masterCompanyId: string): Promise<void> {
    await tx
      .update(accounts)
      .set({ masterCompanyId })
      .where(sql`${accounts.id} = ${accountId} AND ${accounts.masterCompanyId} IS NULL`);
  },
};
