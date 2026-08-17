// refreshAccount.ts — the CUSTOMER-triggered per-account company refresh from the linkedin_api origin
// fleet (docs/planning/linkedin-source-ingestion/ §account lane; dark behind
// LINKEDIN_ACCOUNT_REFRESH_ENABLED). The tenant-scoped sibling of the platform sweep: metered into
// provider_calls (workspace ledger, entityType "account" — requestHash already namespaces it), bounded by
// the same daily workspace budget the contact waterfall honours, and landed through the ONE landing
// (landLinkedinPayload, its own withErTx).
//
// Shape mirrors enrichContactV2's tx split: tx1 reads (account identity + cache + budget) — network I/O
// strictly OUTSIDE any transaction — tx2 writes the ledger row. The Layer-0 landing then runs in its own
// er transaction, idempotent on content hash.
//
// URL resolution ladder: the tenant's own linkedin_company_url first (what the customer asserted), else
// the master bridge's numeric linkedin_company_id → the sales-nav URL. Neither ⇒ "no_identity" — the API
// layer turns that into a 422; refreshing a company we cannot address is not an error worth retrying.

import { env } from "@leadwolf/config";
import {
  type TenantScope,
  accountRepository,
  masterProfileRepository,
  providerCallRepository,
  withErTx,
  withTenantTx,
} from "@leadwolf/db";
import { ProviderBudgetExceededError } from "@leadwolf/types";
import type { EnrichRequest } from "../enrichment/providerPort.ts";
import { requestHash } from "../enrichment/requestHash.ts";
import { landLinkedinPayload } from "./landSourcePayload.ts";
import {
  type LinkedinFetchResult,
  fetchLinkedinCompany,
  salesNavCompanyUrl,
} from "./linkedinSourceClient.ts";
import { LINKEDIN_API_SOURCE } from "./mapLinkedinPayload.ts";

const ACCOUNT_REFRESH_COST_MICROS = 25_000; // same placeholder unit cost as the person adapter
/** A cached company answer younger than this serves the refresh without vendor spend. The vendor's own
 *  capture cache is 6h; a day is the honest tenant-side floor for firmographics/headcount (monthly data). */
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface RefreshAccountInput {
  scope: TenantScope & { workspaceId: string };
  accountId: string;
  requestedByUserId?: string | null;
  /** Injectable for tests. */
  fetchCompany?: typeof fetchLinkedinCompany;
}

export type RefreshAccountResult =
  | { status: "landed"; cacheHit: boolean }
  | { status: "duplicate"; cacheHit: boolean } // landed before — the payload was already known
  | { status: "no_identity" } // account has no LinkedIn URL and no master LinkedIn id
  | { status: "not_found" }
  | { status: "unavailable" } // origin fleet dark/down — worker retry is appropriate
  | { status: "rejected" }; // the vendor refused this URL — retry is pointless

export async function refreshAccount(input: RefreshAccountInput): Promise<RefreshAccountResult> {
  const fetchCompany = input.fetchCompany ?? fetchLinkedinCompany;

  // ── tx1: identity + cache + budget (reads only) ────────────────────────────────────────────────────
  const pre = await withTenantTx(input.scope, async (tx) => {
    const account = await accountRepository.getForRefresh(tx, input.accountId);
    if (!account) return null;

    const daySpend = await providerCallRepository.spendSince(
      tx,
      input.scope.workspaceId,
      startOfUtcDay(),
    );
    return { account, daySpend };
  });
  if (!pre) return { status: "not_found" };

  // URL ladder. The master bridge read is Layer 0 → its own er transaction, outside tenant scope.
  let url = pre.account.linkedinCompanyUrl?.trim() || null;
  if (!url && pre.account.masterCompanyId) {
    const masterId = pre.account.masterCompanyId;
    const master = await withErTx((tx) =>
      masterProfileRepository.readCompanyForLanding(tx, masterId),
    );
    if (master?.linkedinCompanyId) url = salesNavCompanyUrl(master.linkedinCompanyId);
  }
  if (!url) return { status: "no_identity" };

  const request: EnrichRequest = {
    workspaceId: input.scope.workspaceId,
    entityType: "account",
    fields: [],
    subject: { linkedinUrl: url },
  };
  const hash = requestHash(request);

  // Fresh cached answer → land it (idempotent) with zero vendor spend.
  const cached = await withTenantTx(input.scope, (tx) =>
    providerCallRepository.findCached(tx, input.scope.workspaceId, hash),
  );
  if (
    cached &&
    cached.providerName === LINKEDIN_API_SOURCE &&
    Date.now() - cached.calledAt.getTime() < CACHE_MAX_AGE_MS
  ) {
    const landed = await landLinkedinPayload({
      payload: cached.responsePayload,
      fetchedAt: new Date(),
    });
    return landed.landed
      ? { status: "landed", cacheHit: true }
      : { status: "duplicate", cacheHit: true };
  }

  // Budget wall BEFORE spend — the enrichContactV2 posture: throw only before any vendor call.
  if (pre.daySpend + ACCOUNT_REFRESH_COST_MICROS > env.ENRICH_DAILY_BUDGET_MICROS) {
    throw new ProviderBudgetExceededError(
      "Daily enrichment budget reached; account refresh deferred.",
    );
  }

  // ── network I/O, outside any transaction ───────────────────────────────────────────────────────────
  const result: LinkedinFetchResult = await fetchCompany(url);

  // ── tx2: the ledger row (money/attempt truth), whatever happened ───────────────────────────────────
  const status = result.status === "ok" ? "hit" : result.status === "rejected" ? "miss" : "error";
  await withTenantTx(input.scope, (tx) =>
    providerCallRepository.record(tx, {
      tenantId: input.scope.tenantId,
      workspaceId: input.scope.workspaceId,
      providerName: LINKEDIN_API_SOURCE,
      requestHash: hash,
      status,
      costMicros: result.status === "ok" ? ACCOUNT_REFRESH_COST_MICROS : 0,
      responsePayload: result.status === "ok" ? result.payload : undefined,
    }),
  );

  if (result.status === "rejected") return { status: "rejected" };
  if (result.status !== "ok") return { status: "unavailable" };

  const landed = await landLinkedinPayload({ payload: result.payload, fetchedAt: new Date() });
  return landed.landed
    ? { status: "landed", cacheHit: false }
    : { status: "duplicate", cacheHit: false };
}

function startOfUtcDay(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}
