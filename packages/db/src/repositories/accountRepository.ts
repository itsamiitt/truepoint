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
}

export const accountRepository = {
  /** Insert the account, or return the existing one for this (workspace, domain). Returns the account id. */
  async upsertByDomain(tx: Tx, input: AccountUpsertInput): Promise<string> {
    const rows = await tx
      .insert(accounts)
      .values({
        tenantId: input.tenantId,
        workspaceId: input.workspaceId,
        name: input.name,
        domain: input.domain,
      })
      .onConflictDoUpdate({
        target: [accounts.workspaceId, accounts.domain],
        targetWhere: sql`${accounts.domain} IS NOT NULL`,
        set: { name: input.name, updatedAt: new Date() },
      })
      .returning({ id: accounts.id });
    return rows[0]!.id;
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
};
