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

import { and, asc, eq, gt, isNull, sql } from "drizzle-orm";
import { db, type Tx } from "../client.ts";
import { accountDomains, accountLocations } from "../schema/accountChildren.ts";
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

// ── S-A1/S-A3 backfill family (15 §2.2 — the executable contract; the S-CH3 backfillContactChannels sibling) ──
// The backfill's selection predicate IS its watermark: an account is "missing" a domain child when it holds
// the flat `domain` and NO live account_domains row exists — so any batch is re-runnable, a crash resumes by
// re-selecting, and a done account is never touched again (idempotent no-op by construction; no stored cursor).
// The predicate is 15 §2.2's completeness query verbatim, shared by the in-tx batch selection, the owner-conn
// census, and the S-A6/C2 gate count — one predicate, three readers, so the gate can never disagree with the
// walker. The HQ pass is the analog over account_locations (best-effort, count-only — never a gate, 15 §2.2).

/** One selected account of the WHERE-missing domain walk (flat cache = the source projected FROM — verbatim). */
export interface MissingAccountDomainRow {
  id: string;
  domain: string; // the flat accounts.domain (guaranteed non-null by the selection predicate)
}

/** One selected account of the WHERE-missing HQ-location walk (S-A3 best-effort synthesis input). */
export interface MissingAccountHqRow {
  id: string;
  hqCountry: string | null; // freetext ("United States") — the runner maps to ISO alpha-2 best-effort
  hqCity: string | null;
}

// The per-child "no live row" legs, shared verbatim between the tx selection (drizzle) and the owner census/count
// (raw, aliased `a`). Kept byte-for-byte parallel — the S-CH3 discipline (the gauge can never disagree).
const noLiveDomainChild = sql`NOT EXISTS (SELECT 1 FROM ${accountDomains} WHERE ${accountDomains.accountId} = ${accounts.id} AND ${accountDomains.deletedAt} IS NULL)`;
const noLiveLocation = sql`NOT EXISTS (SELECT 1 FROM ${accountLocations} WHERE ${accountLocations.accountId} = ${accounts.id} AND ${accountLocations.deletedAt} IS NULL)`;
const domainMissing = sql`(${accounts.domain} IS NOT NULL AND ${accounts.deletedAt} IS NULL AND ${noLiveDomainChild})`;
const hqMissing = sql`((${accounts.hqCountry} IS NOT NULL OR ${accounts.hqCity} IS NOT NULL) AND ${accounts.deletedAt} IS NULL AND ${noLiveLocation})`;

// Raw analogs (aliased `a`) for the owner-connection census + counts — the drizzle refs above render
// "accounts"."id", which the aliased owner query does not expose (the listWorkspacesMissingChannelProjection
// pattern). Kept parallel to the fragments above so the gauge never lies.
const DOMAIN_MISSING_RAW = `(a.domain IS NOT NULL AND a.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM account_domains ad WHERE ad.account_id = a.id AND ad.deleted_at IS NULL))`;
const HQ_MISSING_RAW = `((a.hq_country IS NOT NULL OR a.hq_city IS NOT NULL) AND a.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM account_locations al WHERE al.account_id = a.id AND al.deleted_at IS NULL))`;

export interface BackfillAccountChildResult {
  inserted: boolean;
  /** Hit ON CONFLICT DO NOTHING — a concurrent S-A2 write won the partial unique (race backstop, 15 §2.2);
   *  counted, never an error. */
  conflict: boolean;
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

  /**
   * THE S-A6 ladder rung C2 probe (06 §5, "any non-deleted account_domains.domain exact"): resolve a domain to
   * the account that holds it as a live SECONDARY (is_primary = false, deleted_at IS NULL). Returns the owning
   * account id, or null when the domain is nowhere / is a PRIMARY (C1's job — see below) / lives under a
   * tombstone. Callers invoke this ONLY when the S-A6 read gate is ON (accountReadFromChildEnabledForScope);
   * gate-off it is never called, so the import company-match stays byte-identical (C1-only).
   *
   * WHY is_primary = false (the "C1 miss ⇒ probe" reading of 06 §5): C1 is the flat accounts.domain primary
   * cache and its atomic upsert (accountRepository.upsertByDomain) resolves a PRIMARY-domain hit (and mints on a
   * true miss) — with its established name-refresh + master-bridge semantics and INSERT…ON CONFLICT
   * concurrency-safety. So a domain that is some account's PRIMARY (⇒ is_primary=true child row) must fall
   * through to that atomic upsert, NOT be intercepted here. This rung intercepts ONLY the genuine C2 case: a
   * domain that is a live SECONDARY of an existing account — which C1 alone would miss (its flat cache holds a
   * DIFFERENT primary), silently minting a duplicate account (G17). ≥2 hits are IMPOSSIBLE by
   * `uniq_account_domains_ws_domain` (the whole-set live partial unique) — a domain belongs to at most one live
   * account per workspace — so a single row is unambiguous and LIMIT 1 is exact (06 §5 "≥2 accounts ⇒ ambiguity"
   * cannot arise from ONE domain value; the multi-DOMAIN-row ambiguity case is the mapping layer's, doc 08).
   * RLS scopes the probe to the caller's workspace via the tx GUC; the explicit workspace_id predicate is the
   * belt-and-braces the write path also carries. NEVER moves or re-primaries the domain (06 §1/§Edge: an import
   * never moves a domain; moving is an explicit verb).
   */
  async findAccountIdBySecondaryDomain(
    tx: Tx,
    workspaceId: string,
    domain: string,
  ): Promise<string | null> {
    const rows = await tx
      .select({ accountId: accountDomains.accountId })
      .from(accountDomains)
      .where(
        and(
          eq(accountDomains.workspaceId, workspaceId),
          eq(accountDomains.domain, domain), // citext — case-insensitive equality
          eq(accountDomains.isPrimary, false),
          isNull(accountDomains.deletedAt),
        ),
      )
      .limit(1);
    return rows[0]?.accountId ?? null;
  },

  // ── S-A1 domain backfill (15 §2.2, the mandated re-run — seq 55) ───────────────────────────────────────

  /** WHERE-missing keyset walk (id ASC, cursor = last id; null = start) over LIVE accounts holding a flat
   *  `domain` with NO live account_domains child. RLS scopes it to ONE workspace via the caller's withTenantTx
   *  GUC (no explicit workspace predicate — the findContactsMissingChannelProjection precedent). */
  async findAccountsMissingDomainChild(
    tx: Tx,
    cursor: string | null,
    limit: number,
  ): Promise<MissingAccountDomainRow[]> {
    const rows = await tx
      .select({ id: accounts.id, domain: accounts.domain })
      .from(accounts)
      .where(and(sql`${domainMissing}`, cursor === null ? undefined : gt(accounts.id, cursor)))
      .orderBy(asc(accounts.id))
      .limit(limit);
    // domainMissing guarantees domain non-null; narrow for the type.
    return rows.flatMap((r) => (r.domain ? [{ id: r.id, domain: r.domain }] : []));
  },

  /** S-A1's dedicated backfill insert — the 15 §2.2 sibling of applyAccountDomainWrite, NOT a second live
   *  write path: it NEVER touches the flat accounts.domain cache (flat is the source projected FROM; rewriting
   *  it would churn every account's updated_at) and must be a strict no-op on re-runs. Inserts the
   *  `is_primary=true` primary domain row WHERE the selection said none exists; `ON CONFLICT DO NOTHING` on the
   *  06 §1 partial uniques backstops a concurrent S-A2 dual-write (its row wins; ours is a conflict, counted).
   *  `source='import'` (NOT 'backfill' — the account_domains_source_enum CHECK forbids 'backfill'; 06 §Steps
   *  S-A1 pins 'import'; doc 16 drift row records the divergence from the S-CH3 'backfill' label). */
  async backfillAccountDomain(
    tx: Tx,
    scope: AccountChildScope,
    accountId: string,
    domain: string,
  ): Promise<BackfillAccountChildResult> {
    const rows = await tx
      .insert(accountDomains)
      .values({
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        accountId,
        domain,
        isPrimary: true,
        source: "import", // 06 §Steps S-A1; the CHECK forbids 'backfill' (drift row)
        sourceImportId: null, // lineage unknowable at backfill grain (the flat slot kept no pointer)
        pinned: false,
        verifiedAt: null,
      })
      .onConflictDoNothing()
      .returning({ id: accountDomains.id });
    return { inserted: rows[0] !== undefined, conflict: rows[0] === undefined };
  },

  // ── S-A3 HQ-location backfill (15 §2.2, best-effort — seq 56) ──────────────────────────────────────────

  /** WHERE-missing keyset walk over LIVE accounts holding a flat hq_country/hq_city with NO live
   *  account_locations child. RLS-scoped via the caller's tx (the domain-pass precedent). */
  async findAccountsMissingHqLocation(
    tx: Tx,
    cursor: string | null,
    limit: number,
  ): Promise<MissingAccountHqRow[]> {
    const rows = await tx
      .select({ id: accounts.id, hqCountry: accounts.hqCountry, hqCity: accounts.hqCity })
      .from(accounts)
      .where(and(sql`${hqMissing}`, cursor === null ? undefined : gt(accounts.id, cursor)))
      .orderBy(asc(accounts.id))
      .limit(limit);
    return rows.map((r) => ({ id: r.id, hqCountry: r.hqCountry ?? null, hqCity: r.hqCity ?? null }));
  },

  /** S-A3's dedicated backfill insert: the primary `hq` location synthesized from the flat cache. NEVER
   *  touches the flat hq_country/hq_city (flat is the source projected FROM). `country` is the runner's
   *  best-effort ISO alpha-2 (NULL when the freetext hq_country was unmappable — 06 §3 backfill honesty).
   *  `source='import'` (CHECK-valid; true origin unknowable at backfill grain — doc 16 drift row).
   *  `ON CONFLICT DO NOTHING` on `uniq_account_locations_primary` backstops a race. */
  async backfillAccountHqLocation(
    tx: Tx,
    scope: AccountChildScope,
    accountId: string,
    loc: { city: string | null; country: string | null },
  ): Promise<BackfillAccountChildResult> {
    const rows = await tx
      .insert(accountLocations)
      .values({
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        accountId,
        type: "hq",
        city: loc.city,
        country: loc.country,
        isPrimary: true,
        source: "import",
        pinned: false,
      })
      .onConflictDoNothing()
      .returning({ id: accountLocations.id });
    return { inserted: rows[0] !== undefined, conflict: rows[0] === undefined };
  },

  // ── System-level census + gates (owner connection — intentionally cross-workspace, non-PII ids/counts) ──

  /** SYSTEM-LEVEL census for the leader-locked account-backfill sweep: the (tenantId, workspaceId) of every
   *  workspace still holding an account that needs EITHER pass (missing domain child OR missing hq location).
   *  OWNER connection (no leadwolf_app drop — the set is intentionally cross-workspace; the
   *  listWorkspacesMissingChannelProjection precedent); NON-PII ids only; NOT reachable from a tenant request.
   *  `limit`-capped fan-out. */
  async listWorkspacesNeedingAccountBackfill(
    limit = 1000,
  ): Promise<Array<{ tenantId: string; workspaceId: string }>> {
    const rows = (await db.execute(
      sql`SELECT DISTINCT tenant_id, workspace_id FROM accounts a
          WHERE ${sql.raw(DOMAIN_MISSING_RAW)} OR ${sql.raw(HQ_MISSING_RAW)}
          LIMIT ${limit}`,
    )) as unknown as Array<{ tenant_id: string; workspace_id: string }>;
    return rows.map((r) => ({ tenantId: r.tenant_id, workspaceId: r.workspace_id }));
  },

  /** THE S-A6/C2 GATE (15 §2.2's verification query, the domainMissing predicate verbatim): live accounts with
   *  a flat `domain` and no live account_domains row. **S-A6's C2 rung must not activate until this reads 0**
   *  after the post-dual-write re-run (07 §8 edge; 15 §M-SEQ seq 55). Owner connection — fleet-wide non-PII
   *  count; also the sweep's `backfill_domain_remaining` gauge. */
  async countAccountsMissingDomainChild(): Promise<number> {
    const rows = (await db.execute(
      sql`SELECT count(*)::int AS n FROM accounts a WHERE ${sql.raw(DOMAIN_MISSING_RAW)}`,
    )) as unknown as Array<{ n: number }>;
    return rows[0]?.n ?? 0;
  },

  /** The HQ-pass completeness count — COUNT-ONLY, NEVER a gate (15 §2.2: S-A3's backfill is best-effort;
   *  unmappable-country rows still get a location with `country NULL`, so this converges to 0, but nothing
   *  blocks on it). Exposed as the `backfill_hq_remaining` gauge. Owner connection, non-PII count. */
  async countAccountsMissingHqLocation(): Promise<number> {
    const rows = (await db.execute(
      sql`SELECT count(*)::int AS n FROM accounts a WHERE ${sql.raw(HQ_MISSING_RAW)}`,
    )) as unknown as Array<{ n: number }>;
    return rows[0]?.n ?? 0;
  },
};
