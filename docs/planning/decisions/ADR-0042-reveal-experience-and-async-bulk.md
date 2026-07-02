# ADR-0042 — Reveal experience: no-charge read primitive + async bulk reveal (lease/settle/release)

- **Status:** Accepted
- **Date:** 2026-07-02
- **Related:** ADR-0007 (per-workspace reveal + credit counter), ADR-0013 (charge-by-verified-result +
  credit-back), ADR-0025 (freshness/reverification), ADR-0027 (real-time delivery + event backbone),
  ADR-0029 (credit ledger + lease decrement), ADR-0036 (bulk async job + staging pipeline).
- **Detail:** `docs/planning/reveal-experience/`.

## Context

The shipped reveal flow had no PII-carrying read primitive: the masked row exposed `isRevealed` but never the
email/phone, and there was no no-charge way to fetch already-owned reveal data — so revealed values were
discarded on dialog close and could only be seen by re-running (re-charging) the reveal. Bulk reveal was a
client-side sequential loop that took the tenant counter `FOR UPDATE` per contact — the exact hot-lock
ADR-0029 forbids — and could not operate on select-all-across-results. There were also money-safety gaps
(a viewer could spend credits; a cross-`reveal_type` double-charge).

## Decision

1. **A no-charge, ownership-checked "get revealed data" read** (`GET /contacts/:id/revealed`, batch
   `/revealed/batch`). Decrypts email/phone only for `reveal_type`s the workspace owns; RLS + ownership are the
   security boundary; decrypt stays in `packages/core`. This is the primitive the persistent UI reads from.

2. **Extend the read projection with `revealedTypes`** (non-PII: which fields owned) so the grid renders
   per-row reveal state without decrypting the dataset. A single client `RevealStore` is the source of truth
   (optimistic updates + page-load hydration + a synchronous re-entry guard).

3. **Cross-`reveal_type` dedup** — charge only for newly-owned fields; preserve the `full_profile` bundle price
   when both fields are new, decompose to single-field price on partial ownership. Credit-back refunds the
   earliest email-covering claim (never a phone charge).

4. **Async bulk reveal via `reveal_jobs`/`reveal_job_rows`** with the ADR-0029 **reserve-then-settle** credit
   model: lease the worst-case ceiling once at confirm (one `FOR UPDATE`, subscription-first), reveal each
   contact in a non-charging `lease` settle-mode (the single-reveal path stays byte-identical), and release the
   unspent remainder at finalize. `lease(-ceiling) + release(+remainder)` nets the counter to exactly `-spent`
   and the ledger `SUM(delta)` matches, so `billing-recon` stays green. Each credit move is atomic with a
   status-pinned one-way transition (confirm/finalize/cancel), giving exactly-once semantics.

5. **Dark-launch behind `BULK_REVEAL_ENABLED`** (producer + confirm route gate; serial worker; DLQ), mirroring
   bulk-enrichment. Migration/RLS/queue integration are CI-verified; the hand-authored migration `0050` never
   uses `drizzle-kit generate` (stale-snapshot hazard).

6. **Realtime (Phase 4):** emit `reveal.completed` on the transactional outbox (ADR-0027) and deliver over an
   authenticated SSE stream, replacing polling for live cross-tab/teammate/bulk-progress sync.

## Alternatives considered

- **Charge per contact in the bulk job (no lease)** — simpler, reuses `revealContact` unchanged, but violates
  ADR-0029's single-lease rule and reintroduces the per-row hot-lock. Rejected; the lease is the enterprise
  requirement. (The serial worker also mitigates the DoS, but the lease additionally guarantees the job can
  afford its worst case up front.)
- **Decrement at settle, soft (counter-neutral) lease** — cannot both hold the overdraft guard (`balance >= 0`)
  and keep `balance == SUM(ledger delta)` without double-counting. Rejected in favor of lease-then-release,
  which is provably recon-correct.
- **Inline PII in every list row via a decrypt-on-list query** — expensive + a larger PII surface. Rejected in
  favor of bounded batch hydration of visible owned rows only.

## Consequences

- Already-revealed data shows instantly and persistently with no re-charge; the grid reveals in place; bulk
  reveal scales across an entire search result.
- New tables + a new migration → new-table verification is CI/Docker-gated on hosts without Docker.
- The bulk lease over-reserves the worst case (conservative), releasing the remainder — a brief hold on other
  spending during a job, accepted per ADR-0029.
- The subscription bucket is restored spend-first on release (`computeReleaseSplit`, unit-tested).
