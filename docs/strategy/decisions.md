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

  D5. CONTRIBUTOR IDENTITY LIVES IN THE `forge` SCHEMA (2026-07-31), not in a new
      dedicated `provenance` schema+role. Reuses the shipped forge firewall: no
      third least-privilege role to operate, and forge.raw_captures already
      carries captured_by_user_id, the closest existing thing to contributor
      identity. What this preserves and what it costs, stated so nobody has to
      re-derive it:
        HOLDS — the product-level C-02 promise. leadwolf_app (the customer role)
        has no grant anywhere in the forge schema, so no request served to a user
        can resolve a contributor by any query. Crucially leadwolf_er — the role
        that WRITES provenance_event.contributor_ref — has no forge grant either,
        so the path that records a ref cannot turn it back into a person. The ref
        stays a bare uuid in `public` with no FK and no resolvable referent.
        COSTS — blast-radius isolation. leadwolf_forge holds DML on ALL TABLES IN
        SCHEMA forge plus ALTER DEFAULT PRIVILEGES, so every forge worker can read
        contributor identity whether it needs to or not. A compromised or buggy
        forge job therefore reaches further than it would have under a dedicated
        role. Accepted trade, not an oversight. Revisiting it is a table move plus
        a grant change, cheap because nothing in `public` references these tables.
      contributorIsolation.itest.ts asserts BOTH halves — including the leadwolf_forge
      read — so any future change to the posture surfaces as a failing test with a
      reason attached rather than as silent drift.

  D6. LAWFUL BASIS: DEFAULT + PER-WORKSPACE OVERRIDE (2026-07-31). Surfaced while
      building S-05: provenance_event.lawful_basis is NOT NULL, but NOTHING in the
      codebase derived a basis. source_records.lawful_basis_snapshot is written
      NULL by its only writer, and ingestion.ts's consentContext requires a basis
      for CAPTURE sources while marking it optional for admin_upload/enrichment/crm
      because those "carry their basis elsewhere" — an elsewhere that did not
      exist. Resolution order, in packages/core/src/provenance/lawfulBasis.ts:
      a basis travelling WITH the data (consentContext on a capture) beats the
      workspace's configured basis (import_policy/enrichment_policy.lawful_basis,
      migration 0091), which beats the platform default legitimate_interest.
      The default is deliberately NOT 'consent': claiming consent we never
      collected asserts a legal fact about a person that no record supports.
      Capture channels (extension, coop) that arrive with NO declared basis are
      recorded with acceptance_state='pending' — auditable, but they do not
      project, which is 09 rule 4 read literally.
      KNOWN LIMIT: resolution is per WORKSPACE, not per data-subject jurisdiction.
      contacts.jurisdiction/region exist and a per-subject resolver is the correct
      end state (09 § Regional gating) but belongs with Phase 5 and its counsel
      review. Honest for a single-jurisdiction workspace, knowingly insufficient
      for one spanning several. Rejected: hardcoding a basis per source_type (09
      asks for config, not code forks) and holding everything pending until
      configured (ships Phase 1 dark and proves nothing).
  D7. A FAILED PROVENANCE APPEND FAILS THE WRITE IT DESCRIBES (2026-07-31). The
      event appends inside the CALLER'S transaction; if it fails, the graph write
      rolls back. This deliberately departs from the shipped precedent:
      recordImportEvidence (runImport.ts) opens its OWN withErTx and is explicitly
      non-fatal, "a failure logs and never fails the landing". Following that
      verbatim would leave 08-architecture invariant 1 untrue — the graph could
      hold fields with no event — and A-01's "every stored field carries
      provenance" unclaimable. Cost: a bug in the event path can now block imports
      and enrichment, which is why it ships behind PROVENANCE_EVENTS_ENABLED and
      gets soak time before any per-tenant flag flips.

  D8. PHASE 1 EMITS LAYER-0 PROVENANCE EVENTS ONLY (2026-07-31). The overlay
      write path runs in withTenantTx as leadwolf_app, which is REVOKE'd from
      provenance_event; SET LOCAL ROLE leadwolf_er inside that tx would require
      leadwolf_app to be a MEMBER of leadwolf_er, handing the customer role the
      whole master graph and destroying the grant-off wall. Layer-0 writes already
      run under withErTx, which holds the grant, so D7's same-transaction append
      works there with no new privileges. 08's invariant 1 binds "the materialized
      graph", and Layer 0 IS that graph — the overlay is a tenant working copy.
      Overlay events stay schema-supported but unwritten; granting leadwolf_app
      INSERT (plus an RLS write policy) is a security decision to take
      deliberately later, not a wiring detail to slip in now.
  D9. THE S-07 GUC TRIGGER IS NOT BUILT, and this is a correction to the approved
      plan rather than a deferral. The plan specified an AFTER INSERT/UPDATE
      trigger on master_* raising unless a provenance GUC was set. Against the
      actual architecture that guard fires on the MINT — which is deliberately
      provenance-free (masterGraphRepository's co-op-safe MATCH-AGAINST boundary
      writes nothing, by design), while events attach one transaction later at the
      evidence hop. So it would warn on every legitimate mint, and a guard that
      cries wolf on correct behaviour gets muted — worse than no guard, because it
      looks like enforcement. Enforcement today is the three layers that DO fit:
      the grant-off wall, the append-only trigger, and the repository chokepoint,
      all covered by itests. If a backstop is wanted later the honest shape is a
      reconciliation METRIC (master rows carrying field_provenance with zero
      events) rather than a write-time trigger.

  D10. PHASE 1 BUILD COMPLETE, VERIFICATION NOT (2026-07-31). Everything in the
      approved Phase 1 plan that could be built in this environment is built and
      pushed to feat/data-mgmt-01-research-brief. Everything ships DARK except
      two always-on items, and those two are deliberate: the masked-export
      suppression gate and the suppression match indexes. A compliance filter
      behind a feature flag is not compliance, so that fix could not ship off.
      BUILT: provenance_event (partitioned, append-only, grant-walled) · forge.
      contributor + consent log · lawful-basis resolution · Layer-0 provenance
      writers at BOTH hops (import evidence, forge→master sync) · usage_event ·
      entitlement + shadow-mode requireEntitlement · reveal + save + miss
      metering · confidence badge v0 on reveal · outcome metrics incl. the
      reveal-hit rate · the M1/M2/M3 reveal-miss taxonomy · the masked-export
      suppression gate.
      NOT BUILT, each with a stated reason rather than left silent: the S-07 GUC
      trigger (D9 — would fire on the provenance-free mint); search-side
      suppression (needs EXPLAIN against a now-indexed suppression_list, and the
      roadmap puts it in Phase 5 — export was taken first because that is where
      data physically leaves); extension end-to-end (both gates stay off pending
      the counsel review 09 rule 1 requires); overlay provenance events (D8 —
      needs a deliberate security decision about granting leadwolf_app INSERT).
      VERIFICATION OWED, and this is the real risk in the branch. There is no bun
      in the authoring environment, so `bun run lint`, `bun run typecheck` and
      EVERY test written for this work have never executed. What WAS verified
      locally with node: migration statement shape, the breakpoint marker never
      appearing in prose, snapshot-ratchet arithmetic, journal tag uniqueness and
      idx ordering, the provenance vocabulary matching its CHECK constraints in
      0089, and a purpose-built checker confirming every named @leadwolf/* import
      across 1825 files resolves to a real barrel export (that last one exists
      because four non-existent APIs were caught by hand first: toast.info,
      AppError's positional signature, isFeatureEnabled, and c.get("scope")).
      VERIFICATION NOW CLOSED (2026-07-31, later the same day). bun was installed
      and every gate run: typecheck 22/22 packages, `bun test` 1896 pass / 0 fail
      across 244 files, and all four itests green against a real Postgres —
      provenanceEvent 13, meteringAccess 13, contributorIsolation 6,
      suppressionExport 5 (37 assertions, 0 failures). Migrations 0088-0095 and
      both new rls files apply cleanly to a fresh database.
      RUNNING THE GATES FOUND SIX REAL DEFECTS that no static check had caught:
      two backticks-inside-template-literal PARSE errors (one in applyMigrations'
      GRANTS string, which would have stopped every migration, itest and deploy —
      and the comment that caused it was the one explaining a different fix);
      twelve typecheck errors in the pre-existing revealCharge tests from widening
      RevealChargeResult; a flag description at 567 chars against a varchar(500)
      column, caught by a migrationSeedLengths guard I did not know existed; and
      an entitlement itest asserting the WRONG MECHANISM (see below).
      CORRECTION TO THE D-SERIES: the claim that the app role is "denied"
      INSERT/UPDATE/DELETE on `entitlement` is only half right. Under FORCE RLS
      with a SELECT-only policy, INSERT raises 42501 but UPDATE and DELETE raise
      NOTHING — the rows are invisible as targets, so the statement matches zero
      rows and reports success. Both are safe; only one is loud, so "no error"
      must never be read as "it worked". The test now asserts the STATE after the
      attempt, which is the property that actually matters.
      CHAIN REBASELINED: `generate` re-emitted only 0091's columns and 0094's
      indexes (proving no other barrel drift) and now reports "No schema changes".
      0095 carries that snapshot, hand-made idempotent so it does not rely on the
      migrator's error-tolerance path. EXPECTED_DEFICIT stays 61 — one entry, one
      snapshot; 0091/0094 still lack their own and the historical gap is P-1.7's.
      KNOWN, NOT MINE: contactMerge.itest.ts has 2 timeouts. Verified pre-existing
      by running it against the pre-session commit — same 4 pass / 2 fail.
      ENVIRONMENT: verified on Postgres 17 (a scratch instance on port 55432, the
      system cluster untouched) against the repo's declared 16. Everything
      exercised behaves identically, but CI on 16 remains the authority.

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
