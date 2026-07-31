# Decisions Log

⟨date⟩ — Pack created. Founding assumptions to validate in Phase 0:
1. Contribution-as-exhaust (C-01) can hit ≥25% weekly contributor rate.
2. C-02 anonymity controls are sufficient for reps/orgs to connect CRMs.
3. The freshness cluster (S-08/09/10/13) is the beachhead's top pain, per
   provisional scores in 04 (analytical estimates, not customer data).
4. Beachhead: ⟨to be chosen in Phase 0 per 05-segments.md criteria⟩.
5. Stack: recorded 2026-07-31 — see the entry below and CLAUDE.md §Project
   conventions.

⟨date⟩ — MONETIZATION PIVOT: credit/bounty reward economy replaced with
freemium (Free / Community / Pro / Team; 07 §Access model). Rationale: simpler
mental model, no farmable currency (A-03 surface shrinks to data-quality
fraud), category-standard pricing, C-06 easier (no clawbacks). Trade-off: the
per-action supply incentive is gone; supply now rests on contribution-as-
exhaust (C-01) plus the Community tier's structural incentive. C-03/C-04
redefined accordingly in 03/04. OPEN DECISION: Community unlock ON by default
vs. fully voluntary contribution — resolved by Phase 3's kill test
(activation ≥10% of free WAU). Compliance note added as rule 6 in 09.

2026-07-31 — KICKOFF GAP ANALYSIS. This pack was written as if greenfield
("Phase 0: no product code", ⟨ProductName⟩ placeholders, a target layout of
services/{graph,ingest,verify,entitlements,compliance}). The repo it landed in
is not greenfield: TruePoint / leadwolf, 9 apps, 13 packages, ~120 public tables
plus a separate `forge` schema, 88 migrations, a shipped global golden graph
(master_persons/companies/employment), CRM two-way sync, and an MV3 extension.
The pack's own README-PLAN.md says to MERGE CLAUDE.md with any existing one;
it was overwritten instead, losing the project guide and the skills routing.
Four decisions taken (human, in-session), plus the recorded stack:

  D1. TruePoint IS the product. Reconcile the strategy onto the existing system;
      do not rebuild. `services/*` are MODULES, not directories — the mapping to
      real paths is in CLAUDE.md §Project conventions. Rejected: treating the
      pack as belonging to a different repo, and treating TruePoint as a
      prototype to be superseded.
  D2. RULE 7 AMENDED. As written ("no credit, points, or bounty currency exists
      anywhere") the rule was false about this repo on the day it was written:
      credit_ledger, tenants.reveal_credit_balance, credit_packs (Stripe),
      billing_cycles.grant_credits, contact_reveals.credits_consumed, and
      packages/core/src/reveal/revealCharge.ts all ship today. Ruling: reveal
      credits are a PURCHASED settlement unit, not a farmable reward. The ban is
      scoped to contributor-EARNED currency, which does not exist and must not be
      built — so A-03's "nothing to farm" property is preserved. Entitlement caps
      sit ABOVE credits. Do NOT reconcile the two in code: ripping credits out
      touches the money loop, the ledger recon worker, Stripe webhooks, and the
      subscription grant worker, none of it flag-reversible.
  D3. X-01 FROZEN, NOT REMOVED. 04 scores sequencing/cadence as a non-goal
      (Opp 6.0, Sat 8.5), but outreach_sequences/steps/log (M9) and a full email
      send engine — DKIM/SPF/DMARC, ESP/OAuth mailboxes, tracking events,
      templates, threads (M12) — are already shipped. They keep running and keep
      working; they get zero roadmap capacity from Phase 1 onward, and any PR
      touching them must justify itself. Rejected: planned removal (destroys
      shipped capability) and rescoring X-01 into scope (contradicts 04's
      differentiation thesis).
  D4. PHASE 1 = SPINE FIRST, then the seller slice. Build provenance_event,
      contributor, entitlement/usage_event and reveal-miss logging, retrofit the
      existing reveal/search/save paths through them, THEN meet the seller AC.
      Rejected: seller-slice-first (violates invariant 1 in the interim and adds
      retrofit debt) and spine-only (makes Phase 1's own kill criterion
      unmeasurable).

Stack recorded: Bun 1.3.14 + Turbo + Biome monorepo; Postgres 16 via Drizzle +
postgres.js with hand-written RLS; Redis 7 + BullMQ; Hono on Bun; Next.js 15 +
React 19. Commands: build `bun run build`, test `bun test`, lint `bun run lint`,
typecheck `bun run typecheck`, migrate `bun run db:migrate`.

Conflicts surfaced per rule 6 and NOT silently reinterpreted — carried as open
questions on the Phase 1 plan, not resolved here: (a) Phase 0 was skipped, so
all of 03/04 remains analytical hypothesis; (b) no beachhead is chosen, so Phase
1's kill criterion (reveal-hit <40% in the beachhead) cannot be evaluated;
(c) no licensed/crawled seed exists at volume; (d) invariant 3 (suppression
checked at EVERY egress) is NOT satisfied today — searchRepository's own header
says suppression is "NOT yet covered" and assertNotSuppressed is called from
three sites only.
