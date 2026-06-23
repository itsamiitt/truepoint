# Enrichment Pipeline

Enrichment is the core of a sales intelligence product: turning a thin signal (a
name, a domain, a LinkedIn URL) into a complete, verified contact and company
record. It is also the most architecturally demanding subsystem — it's async,
externally-dependent, metered (it costs real money per call), and it must keep the
dataset clean rather than filling it with duplicates. This file is how it's built.

The original skills treated enrichment only as a security concern (SSRF, keys,
rate limits). Those still apply (see `truepoint-security` integrations) — this file
is the architecture they secure.

---

## It Runs as a Job, Always

Enrichment depends on slow, sometimes-down third-party APIs. It never runs inside a
request (see `truepoint-platform` async-jobs). A request to enrich returns an
accepted/queued response; a worker on the `enrichment` queue does the work and the
result appears via the activity feed / a job-status the UI can read.

This also means enrichment is **idempotent and cache-aware** by construction — a
redelivered job must not re-pay a provider (see Caching below and platform
async-jobs).

---

## The Provider Waterfall

No single provider has every record, and providers differ in price and accuracy
per field. Enrichment chains providers in a **cost- and accuracy-aware waterfall**:

- Try providers in an order that balances cost and hit-rate — cheaper/cached
  sources first, premium providers only if needed.
- **Stop at first sufficient answer.** Once a field is filled to the required
  confidence, don't keep paying other providers for it. Different fields may
  resolve from different providers (email from one, phone from another).
- **Fall through on miss or low confidence**, not on error alone — a provider that
  returns a low-confidence guess shouldn't end the waterfall if a better source
  exists.
- The ordering is configurable, not hardcoded, so it can be tuned as provider
  prices and accuracy change. Per-field provider preferences are data.

The order and stopping rule are where enrichment cost is won or lost — see
`truepoint-operations` FinOps. A naive "call every provider for every field" is
both slow and expensive.

---

## Identity Resolution (Dedup) — The Clean-Data Backbone

The same person/company arrives from many sources in many shapes. Without a
resolution step, the canonical dataset (see `data-model.md`) fills with
duplicates — the failure that makes a sales-intelligence dataset worthless.

Resolve identity by a **signal hierarchy**, strongest first:

1. **Stable provider/external ID** — a provider's persistent ID, or a LinkedIn URN
   for a person / company — the strongest signal when present.
2. **Normalised email** (person) — lowercased, canonicalised. A strong unique-ish
   key.
3. **Normalised domain** (company) — registrable domain via a public-suffix-aware
   parse (not a naive suffix strip — the compound-ccTLD trap), so `co.uk` etc. are
   handled correctly.
4. **Normalised domain + normalised name** (person at company) — when no email/ID.
5. **Fuzzy match** (name + company + signals) — the weakest, used only to *suggest*
   a merge above a confidence threshold, never to silently merge.

Rules:

- **Match confidence has thresholds.** Above a high threshold → same record
  (merge/attach). Below it → treat as new, or queue for review — never silently
  merge on a weak signal (a wrong merge corrupts two records and is hard to undo).
- **The resolution keys are backed by database constraints** (see `data-model.md`,
  platform api-contract idempotency) so two concurrent enrichments of the same
  person can't both insert a duplicate — the constraint rejects the second.
- **Merges are reversible / audited.** A merge records what was combined so a bad
  merge can be unwound.
- Normalisation (email, domain, phone, name) is shared, deterministic logic — the
  same input always normalises the same way, or the keys don't match. This is
  exactly where subtle bugs (URL/case/suffix mismatches) cause silent dedup
  failures, so it's centralised and tested.

---

## Field-Level Merge and Provenance

When a record is enriched from multiple sources over time, each field's value has
a **provenance**: which provider supplied it, when, at what confidence.

- A higher-confidence/fresher value can supersede a lower one; field-level merge is
  per-field, not whole-record-overwrite.
- Provenance lets you explain "where did this email come from?" and re-evaluate
  when a provider is found unreliable.
- User-entered values are their own provenance and generally aren't overwritten by
  enrichment without care — a human correction outranks a provider guess.

---

## Caching: Never Pay Twice

Provider responses are cached keyed by the resolved identity (see platform
caching). Before calling any provider:

- Check the cache. A fresh cached result for this identity/field is returned
  without a provider call — no cost, no latency.
  > **Implementation status:** the cache today is the DB-level `provider_calls`
  > table (`unique(workspace, request_hash)`, sha256 of the request) — there is no
  > Redis hot-cache layer yet. The "check before any provider call" mandate stands;
  > it is currently enforced via that table.
- Cache entries have a **freshness policy** — contact data goes stale (people
  change jobs), so cached enrichment has a TTL after which a re-enrich is allowed,
  balanced against cost.
- A redelivered job hits the cache and does nothing expensive (idempotency +
  cost — platform async-jobs, operations FinOps).

---

## Cost and Quota Controls

Enrichment is metered spend, so it's bounded (see `truepoint-security` api-security
and `truepoint-operations` FinOps):

- **Per-tenant quotas/credits** — a tenant can't exceed its plan's enrichment
  allowance; a stolen session can't run up an unbounded bill.
- **Rate-limited** per user and per tenant server-side.
- **Bulk enrichment** is a job with per-tenant fairness so one tenant's
  million-record enrichment doesn't starve others or blow the budget in one burst.
- Every enrichment call emits a **UsageEvent** for metering/billing (see
  `data-model.md`).

---

## Outbound Safety (from security, restated)

The pipeline makes outbound calls, so it obeys the outbound rules (see
`truepoint-security` integrations + input-and-injection):

- Provider keys are **server-side only**; the browser never calls a provider.
- Outbound URLs are **allowlisted** to provider domains — never a raw
  user-supplied URL (SSRF).
- **Only the minimum data leaves** — an email or domain for a lookup, not a full
  prospect record (data minimisation).
- **EU-prospect PII** sent to a provider has residency/compliance implications —
  see `truepoint-security` compliance and data-protection.
- The provider **response is untrusted input** — validated and escaped before
  storage/render, or it's stored-XSS by proxy.

---

## Checklist

- Is enrichment a queued, idempotent, cache-checked job — never in a request?
- Does the waterfall stop at first sufficient answer and fall through on
  miss/low-confidence, with configurable cost-aware ordering?
- Is identity resolved by the signal hierarchy with confidence thresholds, weak
  matches never silently merged?
- Are dedup keys backed by DB constraints, and merges audited/reversible?
- Is each field's provenance tracked, with user values protected?
- Are results cached with a freshness policy so providers are never paid twice?
- Are per-tenant quotas, rate limits, and UsageEvents in place?
- Are provider keys server-side, URLs allowlisted, minimum PII sent, responses
  treated as untrusted?
