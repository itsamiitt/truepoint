// tenantSignalsRepository.ts — the TENANT side of the signal projection (market-intelligence MI-S6).
// Every function runs inside the caller's withTenantTx: RLS is the wall, and the INSERT..SELECT below
// leans on it twice — the accounts read is workspace-filtered by policy, and tenant_signals' WITH CHECK
// refuses any row whose workspace_id is not the session's. The sweep hands us Layer-0 FACTS (already
// PII-guarded at their write path); this file only decides which overlay rows they attach to.

import { sql } from "drizzle-orm";
import type { Tx } from "../client.ts";
import type { FanoutSignal } from "./signalFanoutRepository.ts";

export interface TenantSignalRow {
  id: string;
  accountId: string | null;
  contactId: string | null;
  typeCode: string;
  family: string;
  headline: string | null;
  amountMinor: number | null;
  currency: string | null;
  observedAt: Date;
  deliveredAt: Date;
}

export const tenantSignalsRepository = {
  /**
   * Project one Layer-0 company signal onto every bridged account in THIS workspace.
   * INSERT..SELECT so account resolution and the write are one statement under RLS; ON CONFLICT on the
   * (workspace, master signal) wall makes redelivery a no-op — the sweep is at-least-once by design.
   * Returns the number of rows actually written (0 = already delivered or no bridged account).
   */
  async projectCompanySignal(tx: Tx, signal: FanoutSignal): Promise<number> {
    const rows = (await tx.execute(
      sql`INSERT INTO tenant_signals
            (tenant_id, workspace_id, account_id, master_signal_id, type_code, family,
             headline, amount_minor, currency, observed_at)
          SELECT a.tenant_id, a.workspace_id, a.id, ${signal.id}::uuid, ${signal.typeCode},
                 ${signal.family}, ${signal.headline ?? null}, ${signal.amountMinor ?? null},
                 ${signal.currency ?? null}, ${signal.observedAt.toISOString()}::timestamptz
            FROM accounts a
           WHERE a.master_company_id = ${signal.masterCompanyId}::uuid
             AND a.deleted_at IS NULL
          ON CONFLICT (workspace_id, master_signal_id) DO NOTHING
          RETURNING id`,
    )) as unknown as Array<{ id: string }>;
    return rows.length;
  },

  /** The feed read: recent-first, optionally scoped to one account. Keyset-free v1 — LIMIT-capped. */
  async listRecent(
    tx: Tx,
    opts: { accountId?: string; limit?: number } = {},
  ): Promise<TenantSignalRow[]> {
    const accountFilter = opts.accountId ? sql`AND account_id = ${opts.accountId}::uuid` : sql``;
    const rows = (await tx.execute(
      sql`SELECT id, account_id, contact_id, type_code, family, headline,
                 amount_minor, currency, observed_at, delivered_at
            FROM tenant_signals
           WHERE true ${accountFilter}
           ORDER BY observed_at DESC
           LIMIT ${Math.min(opts.limit ?? 50, 200)}`,
    )) as unknown as Array<{
      id: string;
      account_id: string | null;
      contact_id: string | null;
      type_code: string;
      family: string;
      headline: string | null;
      amount_minor: number | null;
      currency: string | null;
      observed_at: Date;
      delivered_at: Date;
    }>;
    return rows.map((r) => ({
      id: r.id,
      accountId: r.account_id,
      contactId: r.contact_id,
      typeCode: r.type_code,
      family: r.family,
      headline: r.headline,
      amountMinor: r.amount_minor,
      currency: r.currency,
      observedAt: new Date(r.observed_at),
      deliveredAt: new Date(r.delivered_at),
    }));
  },
};
