// accountChildRepository.ts — the ONE sanctioned write path for the company-overlay child tables
// (`account_domains`, later `account_locations`) AND the flat primary-value caches they project into
// (`accounts.domain` = primary-domain cache; `accounts.hq_country`/`hq_city` = primary-location cache).
// The direct sibling of contactChannelRepository (05 §3.1, CH-INV-1) applied to accounts' domains/locations
// (import-and-data-model-redesign 06 §1/§3, S-A2). Every op runs the child-row change + flat-cache projection
// in the CALLER's withTenantTx — never two transactions, never fire-and-forget.
//
// PHASE (S-A2, dual-write): the FLAT columns are still the source of truth (06 §4 "while S-A2 dual-write runs
// the flat cache stays authoritative", the same phase rule as doc 05 §3.4). The account write path
// (import upsert; later enrichment / manual) writes the child row + cache in one tx; reads stay on the flat
// cache until S-A6. Domains and office addresses are NON-PII (06 §1/§3) — stored CLEAR (citext / plain text);
// deliberately NO value_enc/blind_index/crypto here (the contrast with doc 05's encrypted channel values).
// RLS on the caller's tx is the isolation wall (rls/accountChildren.sql — FORCE RLS, direct on workspace_id).
//
// PRIMARY DESIGNATION (06 §1, the pure rules in accountChildPlan.ts): the first live domain for an account
// becomes primary (+ the flat accounts.domain cache is rewritten from it); an existing live primary is NEVER
// flipped by import/enrichment (promotion is an explicit verb — 06 §1 asymmetry 2); per-account dedup on the
// (citext) domain. A domain already live on ANOTHER account in the workspace is the 06 §1 collision policy:
// "a match signal, never an error" — the write path SKIPS it and reports `collision` for the caller to count
// (the C2 match-ladder rung that RESOLVES to that account is S-A6's, not this write path's; and an import
// NEVER moves a domain from one account to another as a side effect — moving is an explicit verb, 06 §Edge).
// The whole-set `uniq_account_domains_ws_domain` partial unique is the DB race backstop, never the control
// flow. There is NO per-account cap here (domain caps are app-layer at the API edge — 06 §Misuse).

import { and, eq, isNull } from "drizzle-orm";
import type { Tx } from "../client.ts";
import { accountDomains } from "../schema/accountChildren.ts";
import { accounts } from "../schema/contacts.ts";
import { planAccountDomainWrite } from "./accountChildPlan.ts";

/** Tenancy stamp for new child rows (denormalized NOT NULL on every row — DM4). RLS on the caller's tx is the
 *  wall; these are the column values, never a trust boundary. */
export interface AccountChildScope {
  tenantId: string;
  workspaceId: string;
}

/** One domain value — clear (non-PII). `source` matches the account_domains_source_enum CHECK
 *  (import|enrichment|manual|master_suggestion — NOTE: NOT 'backfill', which the CHECK forbids; see the
 *  backfill methods below and doc 16 drift row). */
export interface AccountDomainValue {
  domain: string; // normalized eTLD+1 (DM1); freemail-guarded at the app edge
  source: string;
  sourceImportId?: string | null;
  pinned?: boolean; // pinned rows are never detached/demoted by import/enrichment (06 §1)
  verifiedAt?: Date | null; // enrichment sets it; import leaves it null
}

/** The ops S-A2's account writers compose. Promote/attach/detach user verbs land with doc 06/08's account API. */
export type AccountDomainWriteOp = { kind: "domain_upsert"; accountId: string; value: AccountDomainValue };

export type AccountDomainWriteOutcome =
  /** A new row was inserted. `becamePrimary` ⇒ the flat accounts.domain cache was re-projected from it. */
  | { result: "inserted"; rowId: string; becamePrimary: boolean }
  /** The domain already lived on the account. `promoted` ⇒ it filled a primary vacuum (+ cache projection). */
  | { result: "existing"; rowId: string; promoted: boolean }
  /** The domain is live on ANOTHER account in the workspace (whole-set ws-unique, 06 §1) — skipped, for the
   *  caller to count/signal; NEVER an error, NEVER a move (06 §Edge). */
  | { result: "collision" };

interface LiveDomainRow {
  id: string;
  domain: string;
  isPrimary: boolean;
}

/** Flat-cache projection (the write half of the 05-shared sync contract): accounts.domain is REWRITTEN from
 *  the newly designated primary domain. During S-A2 the account write already set this exact value flat in the
 *  same tx (the import upsert) — so this update is value-identical and makes the cache structural rather than
 *  coincidental (the general write path may attach a NEW primary that differs, e.g. a future promote verb). */
async function projectDomainToFlat(tx: Tx, accountId: string, domain: string): Promise<void> {
  await tx.update(accounts).set({ domain, updatedAt: new Date() }).where(eq(accounts.id, accountId));
}

async function domainUpsert(
  tx: Tx,
  scope: AccountChildScope,
  accountId: string,
  value: AccountDomainValue,
): Promise<AccountDomainWriteOutcome> {
  // Live domain rows for this account (small-N: domains ≤ ~10 per account, 06 §Scalability; index-backed under
  // the RLS workspace predicate via idx_account_domains_account).
  const live: LiveDomainRow[] = await tx
    .select({ id: accountDomains.id, domain: accountDomains.domain, isPrimary: accountDomains.isPrimary })
    .from(accountDomains)
    .where(and(eq(accountDomains.accountId, accountId), isNull(accountDomains.deletedAt)));

  const target = value.domain.toLowerCase(); // citext is case-insensitive; compare lowercased in JS
  const match = live.find((r) => r.domain.toLowerCase() === target);
  const verdict = planAccountDomainWrite({
    matchExists: match !== undefined,
    matchIsPrimary: match?.isPrimary ?? false,
    hasLivePrimary: live.some((r) => r.isPrimary),
  });

  // keep_existing: the domain is already represented on this account and no change is warranted — a strict
  // no-op so a re-import never churns updated_at (idempotent; verified_at refresh from enrichment lands with
  // the enrichment domain writer, doc 16 drift row — the current instrumented writer is import-only).
  if (verdict === "keep_existing") return { result: "existing", rowId: match!.id, promoted: false };

  if (verdict === "promote_existing") {
    await tx
      .update(accountDomains)
      .set({ isPrimary: true, updatedAt: new Date() })
      .where(eq(accountDomains.id, match!.id));
    await projectDomainToFlat(tx, accountId, match!.domain);
    return { result: "existing", rowId: match!.id, promoted: true };
  }

  // NEW domain — whole-set ws-collision pre-check (06 §1 collision policy): the same domain live on ANOTHER
  // account is a MATCH SIGNAL the C2 ladder (S-A6) resolves, not a write-path error and never a move. Skip +
  // report; the partial unique is the race backstop, never the control flow.
  const wsHit = await tx
    .select({ id: accountDomains.id, accountId: accountDomains.accountId })
    .from(accountDomains)
    .where(
      and(
        eq(accountDomains.workspaceId, scope.workspaceId),
        eq(accountDomains.domain, value.domain),
        isNull(accountDomains.deletedAt),
      ),
    )
    .limit(1);
  if (wsHit[0] && wsHit[0].accountId !== accountId) return { result: "collision" };

  const becamePrimary = verdict === "insert_primary";
  const inserted = await tx
    .insert(accountDomains)
    .values({
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      accountId,
      domain: value.domain,
      isPrimary: becamePrimary,
      source: value.source,
      sourceImportId: value.sourceImportId ?? null,
      pinned: value.pinned ?? false,
      verifiedAt: value.verifiedAt ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: accountDomains.id });

  if (!inserted[0]) {
    // Race backstop: a concurrent tx won one of the partial uniques. Re-read per-account; a hit is a dedup
    // match (treat as existing), otherwise the domain landed on another account — a collision.
    const again = await tx
      .select({ id: accountDomains.id })
      .from(accountDomains)
      .where(
        and(
          eq(accountDomains.accountId, accountId),
          eq(accountDomains.domain, value.domain),
          isNull(accountDomains.deletedAt),
        ),
      )
      .limit(1);
    if (again[0]) return { result: "existing", rowId: again[0].id, promoted: false };
    return { result: "collision" };
  }

  if (becamePrimary) await projectDomainToFlat(tx, accountId, value.domain);
  return { result: "inserted", rowId: inserted[0].id, becamePrimary };
}

export const accountChildRepository = {
  /**
   * THE single sanctioned account-domain write (06 §1, S-A2). Composes inside the CALLER's withTenantTx — the
   * child-row change and any flat-cache projection commit or roll back with the caller's own flat account write
   * (the 05-shared sync contract: same tx, never two). Gate discipline: callers invoke this ONLY when the S-A2
   * dual gate (ACCOUNT_DOMAINS_DUAL_WRITE env + `account_domains_dual_write` per-tenant flag) evaluated ON —
   * gate-off performs ZERO child-table work by construction (the parity guarantee). Outcomes are data, never
   * throws (a skipped/collided domain must never fail the caller's row); a genuine DB error propagates and
   * aborts the caller's tx — dual-write is atomic with the flat write by design.
   */
  async applyAccountDomainWrite(
    tx: Tx,
    scope: AccountChildScope,
    op: AccountDomainWriteOp,
  ): Promise<AccountDomainWriteOutcome> {
    return domainUpsert(tx, scope, op.accountId, op.value);
  },
};
