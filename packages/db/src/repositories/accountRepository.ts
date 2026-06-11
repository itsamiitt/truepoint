// accountRepository.ts — data access for `accounts` (reveal/contacts domain). The import pipeline upserts a
// contact's company by its per-workspace dedup key (domain), so a contact links to one shared account row.
// Methods take the caller's transaction (Tx) so the whole per-row import runs in one withTenantTx (03 §9).

import { sql } from "drizzle-orm";
import type { Tx } from "../client.ts";
import { accounts } from "../schema/contacts.ts";

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
};
