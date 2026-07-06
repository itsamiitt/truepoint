// accountBackfill.ts — S-A1/S-A3: the per-workspace account backfill runner (import-and-data-model-redesign
// 15 §2.2 — THE binding mechanics; 06 §Steps S-A1/S-A3). The accounts sibling of channelBackfill.ts, at
// smaller scale (one row per domained account, not per contact). Two passes, both driven fleet-wide by the
// leader-locked accountBackfillSweep in apps/workers:
//   • DOMAIN pass (S-A1, the MANDATED re-run — 15 §M-SEQ seq 55, 14 conflict ⑤): every LIVE account with a
//     flat `domain` and no live account_domains row gets its `is_primary` primary domain child. Its
//     completeness count is THE S-A6/C2 gate (07 §8 edge) — C2 must not activate until it reads 0.
//   • HQ pass (S-A3 — seq 56): every LIVE account with a flat hq_country/hq_city and no live account_locations
//     row gets a synthesized primary `hq` location, best-effort (freetext hq_country → ISO alpha-2 when
//     confidently mappable, else NULL + counted — 06 §3/§4 honesty). Its count is COUNT-ONLY, never a gate.
//
// THE CONTRACT, pinned (15 §2.2, inheriting §2.1's discipline):
//   • Connection posture: `withTenantTx` per batch — NEVER the owner connection for writes (rule 7). RLS is
//     ENFORCING during backfill.
//   • Iteration: keyset walk over `accounts.id` (uuid v7 ⇒ time-ordered stable cursor), batches (1000 default,
//     env-tunable), ONE tx per batch, each batch commits — no long transactions, ordinary MVCC.
//   • Watermark/resume: the WHERE-missing selection IS the watermark — an account is selected only while it
//     still lacks a live child row, so a crash/abort resumes by re-selecting and a re-run is an idempotent
//     no-op on done accounts (twice = once; no stored cursor).
//   • Abort/tenant-select: the S-A2 dual gate (ACCOUNT_DOMAINS_DUAL_WRITE env + `account_domains_dual_write`)
//     is re-evaluated IN-TX at EVERY batch boundary — flag off ⇒ the pass halts before the next batch
//     (fail-closed tenant selection AND the batch-boundary kill flag, one mechanism). Abort leaves a
//     consistent, partially-backfilled state that is INVISIBLE to users (reads stay flat until S-A6).
//   • Never touches the flat cache (the backfill reads FROM it) and never touches existing child rows (the
//     selection is WHERE-missing; `ON CONFLICT DO NOTHING` backstops the concurrent-dual-write race).
//
// No decrypt, no crypto here (deliberate contrast with channelBackfill — domains/addresses are clear non-PII).

import {
  accountChildRepository,
  type MissingAccountHqRow,
  withTenantTx,
} from "@leadwolf/db";
import { isAccountDomainsDualWriteEnabled } from "./accountDualWrite.ts";
import { countryToIso } from "./countryToIso.ts";

/** What the HQ backfill will write for ONE account — the pure decider's output (unit-testable, no IO). */
export interface AccountHqBackfillPlan {
  city: string | null;
  /** ISO alpha-2 or null (unmappable freetext hq_country — 06 §3 honesty; the account still gets a location). */
  country: string | null;
  /** hq_country was present but NOT confidently mappable to ISO ⇒ country left NULL, counted honestly. */
  countryUnmapped: boolean;
}

/** The pure per-account HQ decider: the flat hq fields → the synthesized `hq` location payload. A present but
 *  unmappable hq_country yields country=NULL + countryUnmapped=true (the row is STILL written — city carried,
 *  06 §3). city is carried verbatim (freetext); country is best-effort ISO via countryToIso. */
export function planAccountHqBackfill(row: MissingAccountHqRow): AccountHqBackfillPlan {
  const country = countryToIso(row.hqCountry);
  return {
    city: row.hqCity,
    country,
    countryUnmapped: row.hqCountry != null && row.hqCountry.trim() !== "" && country === null,
  };
}

export interface AccountBackfillOptions {
  /** Accounts per keyset batch (one tx per batch). 15 §2.2 default: 1000. */
  batchSize?: number;
  /** Batches processed per pass per call — the sweep's per-tick bound; a whale drains across ticks. */
  maxBatches?: number;
}

export interface AccountBackfillWorkspaceResult {
  domainsScanned: number;
  domainsCreated: number;
  domainConflicts: number;
  hqScanned: number;
  hqCreated: number;
  hqUnmapped: number;
  hqConflicts: number;
  domainBatches: number;
  hqBatches: number;
  /** Both passes exhausted their missing set this call (final batch under-filled). */
  drained: boolean;
  /** The dual gate read OFF at a batch boundary — halted fail-closed (also the dynamic abort). */
  gateOff: boolean;
}

/**
 * Backfill ONE workspace's missing account children (domain pass then HQ pass), up to `maxBatches` keyset
 * batches EACH. Safe to call any number of times in any order relative to S-A2 traffic (idempotent,
 * WHERE-missing, conflict-backstopped); the sweep re-invokes it every tick until the census stops returning
 * the workspace. Gated per batch on the S-A2 dual gate (tenant selection + abort).
 */
export async function runAccountBackfillForWorkspace(
  scope: { tenantId: string; workspaceId: string },
  opts: AccountBackfillOptions = {},
): Promise<AccountBackfillWorkspaceResult> {
  const batchSize = opts.batchSize ?? 1000;
  const maxBatches = opts.maxBatches ?? 10;
  const result: AccountBackfillWorkspaceResult = {
    domainsScanned: 0,
    domainsCreated: 0,
    domainConflicts: 0,
    hqScanned: 0,
    hqCreated: 0,
    hqUnmapped: 0,
    hqConflicts: 0,
    domainBatches: 0,
    hqBatches: 0,
    drained: false,
    gateOff: false,
  };

  // ── DOMAIN pass ──────────────────────────────────────────────────────────────────────────────────────
  let cursor: string | null = null;
  let domainDrained = false;
  for (let i = 0; i < maxBatches; i++) {
    const batch = await withTenantTx(scope, async (tx) => {
      // Batch-boundary gate check (fail-closed tenant selection + the abort flag, one mechanism).
      if (!(await isAccountDomainsDualWriteEnabled(tx, scope.tenantId))) {
        return { gateOff: true as const };
      }
      const rows = await accountChildRepository.findAccountsMissingDomainChild(tx, cursor, batchSize);
      let created = 0;
      let conflicts = 0;
      for (const row of rows) {
        const res = await accountChildRepository.backfillAccountDomain(tx, scope, row.id, row.domain);
        if (res.inserted) created += 1;
        if (res.conflict) conflicts += 1;
      }
      const lastId = rows.length > 0 ? (rows[rows.length - 1]?.id ?? null) : null;
      return { gateOff: false as const, rows: rows.length, lastId, created, conflicts };
    });
    if (batch.gateOff) {
      result.gateOff = true;
      return result; // fail-closed: halt BOTH passes (the HQ pass rides the same gate)
    }
    result.domainBatches += 1;
    result.domainsScanned += batch.rows;
    result.domainsCreated += batch.created;
    result.domainConflicts += batch.conflicts;
    if (batch.rows < batchSize) {
      domainDrained = true;
      break;
    }
    cursor = batch.lastId;
  }

  // ── HQ pass (best-effort; rides the SAME gate) ─────────────────────────────────────────────────────────
  cursor = null;
  let hqDrained = false;
  for (let i = 0; i < maxBatches; i++) {
    const batch = await withTenantTx(scope, async (tx) => {
      if (!(await isAccountDomainsDualWriteEnabled(tx, scope.tenantId))) {
        return { gateOff: true as const };
      }
      const rows = await accountChildRepository.findAccountsMissingHqLocation(tx, cursor, batchSize);
      let created = 0;
      let unmapped = 0;
      let conflicts = 0;
      for (const row of rows) {
        const plan = planAccountHqBackfill(row);
        const res = await accountChildRepository.backfillAccountHqLocation(tx, scope, row.id, {
          city: plan.city,
          country: plan.country,
        });
        if (res.inserted) {
          created += 1;
          if (plan.countryUnmapped) unmapped += 1;
        }
        if (res.conflict) conflicts += 1;
      }
      const lastId = rows.length > 0 ? (rows[rows.length - 1]?.id ?? null) : null;
      return { gateOff: false as const, rows: rows.length, lastId, created, unmapped, conflicts };
    });
    if (batch.gateOff) {
      result.gateOff = true;
      return result;
    }
    result.hqBatches += 1;
    result.hqScanned += batch.rows;
    result.hqCreated += batch.created;
    result.hqUnmapped += batch.unmapped;
    result.hqConflicts += batch.conflicts;
    if (batch.rows < batchSize) {
      hqDrained = true;
      break;
    }
    cursor = batch.lastId;
  }

  result.drained = domainDrained && hqDrained;
  return result;
}
