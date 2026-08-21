// companyRoutes.ts — the public data API's company surface (ADR-0049), the first endpoints machine
// credentials actually authenticate.
//
// WHY COMPANIES FIRST, AND ONLY COMPANIES. A public API over the PERSON half of the master graph is an egress
// with no suppression_list coverage: Layer-0 reads check only master_persons.is_suppressed, which mirrors the
// DSAR fan-out alone — not tenant/workspace suppression rows, and with no domain rung — and the two tables
// cannot be joined in one query because leadwolf_er has no grant on suppression_list and leadwolf_app none on
// master_*. Serving people through here before that is reconciled would breach invariant 3 of 09-compliance
// (suppression at EVERY egress). Company records carry ORGANIZATION facts only — no person, no contact
// channel, nothing a data subject can be suppressed on — so they have no such precondition and ship now.
// The person and search endpoints stay unbuilt and are recorded as blocked in ADR-0049, not forgotten.
//
// THE MONEY PATH, in the order it must happen:
//   read (er tx, no lock) → if no match: 200-with-null, charge nothing → if match: tenant tx { lock balance,
//   refuse if short, decrement, ledger the spend, record usage } → respond.
// The graph read is deliberately OUTSIDE the tenant transaction: it is the slow part, and holding a
// FOR UPDATE on the tenant row across it would serialize every concurrent call from the same customer behind
// one query. Same reasoning revealContact.ts gives for keeping verification out of its lock window.

import { checkApiKeyRate } from "@leadwolf/auth";
import { env } from "@leadwolf/config";
import {
  apiUsageRepository,
  creditRepository,
  masterCompanyReadRepository,
  withErTx,
  withTenantTx,
} from "@leadwolf/db";
import { InsufficientCreditsError, ValidationError } from "@leadwolf/types";
import { Hono } from "hono";
import { idempotency } from "../../middleware/idempotency.ts";
import { type PublicApiVariables, apiKeyAuth, requireScope } from "./apiKeyAuth.ts";
import { toCompanyPayload } from "./serialize.ts";

export const publicCompanyRoutes = new Hono<{ Variables: PublicApiVariables }>();

publicCompanyRoutes.use("*", apiKeyAuth);

/**
 * A registrable domain, normalised the way the graph stores it: lowercase, no scheme, no path, no leading
 * "www.". Callers send what they have — a URL, a display domain — and we meet them there rather than
 * returning a validation error they have to guess their way out of.
 */
function normaliseDomain(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return null;
  const withoutScheme = trimmed.replace(/^https?:\/\//, "");
  const host = (withoutScheme.split("/")[0] ?? "").replace(/^www\./, "");
  // A registrable domain has at least one dot and no whitespace. This is a shape check, not a DNS check.
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(host) ? host : null;
}

// ── GET /company/match ───────────────────────────────────────────────────────────────────────────────────
// FREE, and that is a product decision rather than an oversight: an integration calls this on every inbound
// record to decide whether enriching is worth a credit, so metering it would tax the very step that keeps a
// customer's spend efficient — and it would earn almost nothing while making our cost model look worse in
// every buyer's spreadsheet. It is rate-limited instead, which is the right control for a cheap read.
publicCompanyRoutes.get("/match", requireScope("search:read"), async (c) => {
  const domain = normaliseDomain(c.req.query("domain") ?? "");
  if (!domain) throw new ValidationError("A `domain` query parameter is required.");

  const row = await withErTx((tx) => masterCompanyReadRepository.findByDomainTx(tx, domain));

  // Usage is recorded even for a free, unmatched call: calls − billed_calls is what makes the customer's
  // no-match rate visible to them, and dropping the misses would quietly flatter it.
  await withTenantTx({ tenantId: c.get("tenantId"), workspaceId: c.get("workspaceId") }, (tx) =>
    apiUsageRepository.record(tx, {
      tenantId: c.get("tenantId"),
      workspaceId: c.get("workspaceId"),
      apiKeyId: c.get("apiKeyId"),
      endpoint: "company.match",
      billed: false,
      credits: 0,
    }),
  );

  // 200 with matched:false rather than 404. A miss is a normal outcome of a lookup, not an error, and making
  // the caller branch on a status code for it is how integrations end up treating gaps as outages.
  if (!row) return c.json({ matched: false, company: null, credits_charged: 0 });
  return c.json({
    matched: true,
    company: { domain: row.primaryDomain, name: row.name },
    credits_charged: 0,
  });
});

// ── POST /company/enrich ─────────────────────────────────────────────────────────────────────────────────
// Billable. `idempotency` is mounted so a retried request with the same Idempotency-Key replays the stored
// response instead of re-executing — which is what makes "a retry after a timeout cannot double-charge you"
// true rather than aspirational.
publicCompanyRoutes.post("/enrich", requireScope("search:read"), idempotency, async (c) => {
  const body = (await c.req.json().catch(() => null)) as { domain?: unknown } | null;
  const raw = typeof body?.domain === "string" ? body.domain : "";
  const domain = normaliseDomain(raw);
  if (!domain) throw new ValidationError("Body must be { domain: string }.");

  const tenantId = c.get("tenantId");
  const workspaceId = c.get("workspaceId");
  const apiKeyId = c.get("apiKeyId");

  // 1. Read the graph OUTSIDE any tenant lock. leadwolf_er, and MASTER_COMPANY_VISIBLE is applied inside the
  //    repository — a school node, a minted stub or a company with no firmographics can never reach here.
  const row = await withErTx((tx) => masterCompanyReadRepository.findByDomainTx(tx, domain));

  // 2. No match → no charge. The call is still counted, so the customer can see their own hit rate.
  if (!row) {
    await withTenantTx({ tenantId, workspaceId }, (tx) =>
      apiUsageRepository.record(tx, {
        tenantId,
        workspaceId,
        apiKeyId,
        endpoint: "company.enrich",
        billed: false,
        credits: 0,
      }),
    );
    return c.json({ matched: false, company: null, credits_charged: 0 });
  }

  // 3. Match → charge, ledger and meter in ONE transaction. If any of them fails the whole thing rolls back,
  //    so there is no state in which the counter moved without a ledger row explaining it.
  const cost = env.API_COST_COMPANY_ENRICH;
  const balanceAfter = await withTenantTx({ tenantId, workspaceId }, async (tx) => {
    let remaining: number;
    if (cost > 0) {
      const { balance, subscriptionBalance } = await creditRepository.lockBalance(tx, tenantId);
      if (balance < cost) throw new InsufficientCreditsError(balance, cost);
      // Subscription-first (ADR-0041): burn the perishable resetting bucket before purchased credits, exactly
      // as the reveal path does. A public call must not spend a customer's durable credits while their
      // monthly grant sits unused.
      const fromSubscription = Math.min(cost, subscriptionBalance);
      await creditRepository.decrement(tx, tenantId, cost, fromSubscription);
      remaining = balance - cost;
      await creditRepository.insertLedger(tx, {
        tenantId,
        workspaceId,
        entryType: "spend",
        delta: -cost,
        balanceAfter: remaining,
        // Each EXECUTED call is a distinct spend. Replay protection lives one layer up in the idempotency
        // middleware, which never lets the same Idempotency-Key execute twice — so a fresh key here is
        // correct rather than lax.
        idempotencyKey: `api:${crypto.randomUUID()}`,
        actorUserId: null, // a machine caller has no user
        reason: "public_api.company.enrich",
        metadata: { endpoint: "company.enrich", apiKeyId, domain, fromSubscription },
      });
    } else {
      remaining = await creditRepository.currentBalance(tx, tenantId);
    }
    await apiUsageRepository.record(tx, {
      tenantId,
      workspaceId,
      apiKeyId,
      endpoint: "company.enrich",
      billed: cost > 0,
      credits: cost,
    });
    return remaining;
  });

  return c.json({
    matched: true,
    company: toCompanyPayload(row),
    credits_charged: cost,
    credits_remaining: balanceAfter,
  });
});

// Re-exported so app.ts can mount the limiter check without importing @leadwolf/auth directly.
export { checkApiKeyRate };
