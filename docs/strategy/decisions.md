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

  D11. OVERLAY PROVENANCE EVENTS ARE NOT BUILT; PHASE 1 CLOSES AT LAYER 0
      (2026-07-31). The last open item. Writing events for contact/account
      changes would require granting leadwolf_app — the CUSTOMER role — INSERT on
      provenance_event, which it is REVOKE'd from entirely today, plus the
      table's first RLS write policy. Ruling: do not. 08's invariant 1 binds "the
      materialized graph", and Layer 0 IS that graph; the overlay is a per-tenant
      working copy that already carries field_provenance. So Phase 1 is complete
      as specified without handing the customer role write access to the evidence
      log, where a tenant-scoped injection could forge assertions.
      The schema already supports overlay events (entity_type contact|account +
      scope_ref, CHECK-enforced), so this is a decision deferred on its own
      merits, not a design gap. Rejected: the grant + RLS policy (real capability,
      real new attack surface, and a first RLS policy on a table whose isolation
      is currently grant-off — two mechanisms to keep right instead of one), and a
      separate non-fatal withErTx (would reverse D7 for the overlay half, letting
      an overlay field exist with no event and making A-01 unclaimable there).
  D12. PHASE 1 COMPLETE (2026-07-31). Every item in the approved plan is
      implemented, tested and verified, or explicitly closed with a reason:
      D9 (S-07 trigger — would fire on the provenance-free mint), D11 (overlay
      events), and extension ENABLEMENT, which stays gated pending the counsel
      review 09 rule 1 requires. Note that gate blocks turning the extension ON,
      not building it — the side-panel badge shipped dark under that reading.
      Gates all green on this branch: lint, typecheck 25/25 (test files now
      included — see below), 1896 unit tests, 65 itest assertions over the new
      work, 5/5 app builds, dependency boundaries (no db↔core cycle), import-PII,
      lockfile, and drizzle reporting no drift.
      THREE DORMANT GUARDS WERE WIRED UP, and they matter more than any single
      fix here: `typecheck:tests` (defined in 3 packages, invoked by nothing — it
      is how a bare-object jsonb parameter reached a commit), `check-lockfile`
      (written for the exact failure of editing package.json without bun, wired
      to nothing), and two itest beforeAll hooks missing their timeout argument.
      Each was proven to FIRE before being trusted.

  D13. THE CONTRIBUTION CONTROLS ARE AN OPT-OUT OVER THE IDENTITY MINT, NOT AN
      OPT-IN (2026-08-04). Phase 4's "CRM contributor controls" needed a decision
      that rule 6 says must be surfaced rather than assumed.
      The finding first: crm-sync has NO path to the shared graph. It writes only
      to the per-workspace overlay and leaves master_person_id NULL. The
      contribution happens one hop later and unlabelled — the master-backfill
      sweep resolves ANY null-bridge contact and MINTS a golden node on a clean
      miss, unable to tell a CRM-sourced row from an imported one. So the
      controls had to be enforced there, and the natural shape was default-deny.
      Default-deny is WRONG here, and ADR-0021 is why. The mint in question is
      MATCH-AGAINST: identity and dedup keys only, email_enc NULL, no provenance,
      no profile fields. The repo already treats that as the CONTRIBUTE-TO-off
      state. Making it default-deny would stop the dedup spine growing for every
      existing tenant on the day the migration ships — silently, with no customer
      having asked — which is re-litigating ADR-0021 backwards under a Phase 4
      control's name.
      So: contribution_policy.contribute_enabled defaults false and stays the
      switch for the Phase-3 co-op path that would contribute actual VALUES; it
      is read by nothing today. What the backfill gate reads is the exclusion
      lists (domain / account / contact) and never_share_fields, and those bind
      ALWAYS — an exclusion list that only takes effect once some other master
      switch is on is a trap, because the admin who saved "never share acme.com"
      believes it is in force from that moment. A workspace with no controls set
      behaves byte-identically to before the gate existed.
      A denied row still LINKs to a person the graph already holds and only
      declines to MINT a new one. Gating the link too would be a silent product
      downgrade wearing a privacy control's name.

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

## 2026-08-18 — Forge capture/egress env switches armed on the preview instance (operator decision)

The operator (Sunil) directed in-session that every feature gate be enabled on the
production preview host, explicitly including the Forge pipeline switches that ship
dark (FORGE_CAPTURE_ENABLED / FORGE_SYNC_EGRESS_ENABLED — the OQ-2 posture). Recorded
here per the dark-pipeline governance rule. Bounding facts: FORGE_CAPTURE_TENANTS
remains EMPTY, so the per-tenant half of the capture gate still refuses every tenant;
the extract stage has no ANTHROPIC_API_KEY and no S3 object store configured, so no
capture could progress past ingest even if a tenant were listed. Legal sign-off for GA
of capture (ADR-0043 §9) remains OUTSTANDING — arming the env switch does not waive
it; listing a real tenant in FORGE_CAPTURE_TENANTS before that sign-off is the line
that must not be crossed.

## 2026-08-18 — Layer-0 becomes THE product database (operator decision; plan: image-png-the-data-storage)

The operator directed that the licensed-vendor master graph is the product database: globally searchable
(Apollo-style /prospect Database scope), materializable into a workspace ("Add to workspace"), and served
to the extension as instant hits. Two prior code decisions are REVERSED by this, recorded per rule 6:

(a) D4 — URL-shaped identity is free. getRevealedContact gated linkedinUrl behind the email reveal
    ("must not hand back the LinkedIn URL for free"). Under the database model the profile URL is the
    ADDRESSING key (masked projections carry slug/linkedinUrl/salesNavProfileUrl); the paid product is
    the channels. Numeric ids/urns remain internal-only.
(b) D10 — Postgres is the global read path. masterGraph.ts deferred fuzzy-name GINs to an OpenSearch
    adapter; the trgm indexes (0123, partial on the visible predicate) are built now, with the engine
    adapter as the kill-date successor.

New READ-side policy layer (0121): master_persons.visibility ('private'|'licensed'|'coop') + is_suppressed
+ merge tombstone = MASTER_PERSON_VISIBLE, applied inside every Layer-0 customer read. Workspace-minted
persons stay 'private' (the co-op boundary holds); only provider-landed rows are 'licensed'. Channel rows
carry source_name; only licensed channels are revealable across workspaces (pay-once copy on reveal,
gated MASTER_CHANNEL_REVEAL_ENABLED). Suppression is now enforced at READ as well as landing.

## 2026-08-19 — Market-intelligence surface ratified (user directive; series: docs/planning/market-intelligence/)

The user directed implementation of the market-intelligence roadmap ("follow the road map and plan and
implement filling all the gaps and issues"), which this entry records as the D-1 ratification the series
required (09-roadmap-and-decisions.md): TruePoint builds the combined sales + market intelligence surface
NOW, ahead of the post-Phase-6 rescore the strategy roadmap had sequenced. Scope boundary unchanged:
company facts in (hiring, funding/M&A, tech change, leadership, filings — the RD-4 line); X-04 person-level
intent stays OUT, the missing 'intent' signal family stays missing, and hard constraints 1-4 bind every
acquisition path. Non-goals X-01/X-02 untouched.

In-repo defaults from the series' register adopted with this entry: D-2 (confidence unification = shipped
badge leaf fn sourcing constants from master_confidence_policy, display-only first), D-8 (erasure of
person-referencing signals = anonymize to company event), D-9 (IA regroup per 07-product-surfaces.md).
Still open — commercial/procurement, no code may assume them: D-4 funding/registry feed, D-5 technographics
feed + C4 GPL clearance, D-6 postings feed, D-3 final tier packaging (build flag-gated behind
plan_templates.features keys pending pricing sign-off). Everything ships dark behind default-off gates.

## 2026-08-21 — Search consolidation; Accounts searches the global graph (operator decision; plan: docs/planning/search-consolidation/)

The operator directed that `/companies` be retired and both prospecting surfaces fold into one **Search**
destination (`/prospect` → `/search`), with People and Accounts as tabs inside a collapsible filter drawer,
and that the Accounts tab search the **global** company graph (`master_companies`) rather than the
workspace-scoped `accounts` table ("not the companies which are part of someone's uploaded list").
Workspace accounts remain visible on the same tab as a *state of a row*, mirroring how the People tab
already merges owned contacts with database people.

This **partially reverses D-9** (the market-intelligence IA regroup ratified 2026-08-19), which split
account search out to its own `/companies` destination. D-9's other provisions — the signal feed,
watchlists, the markets board — are unaffected; only the account-search destination is folded back, and the
markets board moves with it to `/search/markets`. Recorded per rule 6.

Three consequences recorded with it:

(a) **A company visibility policy now exists.** `MASTER_COMPANY_VISIBLE` is the company twin of
    `MASTER_PERSON_VISIBLE`, applied inside every Layer-0 company read, with the 0134 partial indexes built
    on the same predicate: `org_kind = 'company' AND primary_domain IS NOT NULL AND field_provenance <> '{}'`.
    The provenance clause is load-bearing and was NOT in the first draft. Measured against production:
    `fillCompanyPrimaryDomain` back-fills domains onto position-minted stubs, so a domain-only predicate
    admits 3,747 rows of which only 231 carry any firmographics — 94% would render as blank rows.
    `field_provenance <> '{}'` is the CAUSE (a company document landed) rather than a symptom, and selects
    exactly the same 231. `prov_hwm` was considered and rejected: never written, 0 rows. `primary_domain`
    additionally becomes the URL-shaped addressing key — the D4 posture (2026-08-18) extended to companies.

(b) **Add-to-workspace is no longer a prerequisite for viewing a profile.** Any authenticated user may read
    the masked Layer-0 profile of any visible person or company. This is net-new read surface, not a relaxed
    check — there was never a `GET /contacts/:id`, and the "gate" was three lines of frontend that had
    nothing to open. Channel values remain paid; reveal remains workspace-scoped and credit-gated; no
    workspace-overlay fact (owner, stage, tags, activities, reveal state) is served on a global profile,
    structurally — Layer 0 has no workspace column. A-01/A-03 and the co-op boundary are unchanged.

(c) **Profile views are rate-limited, NOT metered per plan.** The new profile routes are an enumeration
    surface, so they carry per-user and per-tenant limits. They deliberately do NOT get an `entitlement`
    key: production has 0 `entitlement` rows, 0 `subscriptions`, and `plan_templates.features` is `{}` on
    both rows, so `resolveEntitlement` fails open and a new key would be inert config — the fourth instance
    of the "configuration that configures nothing" pattern audit 32 §9C/§9D/§9E already records three of.
    Reversible: one `requireEntitlement` line per route if pricing later wants the cap.

Population at decision time (read-only census, 2026-08-21): 176 visible `master_persons` (9,591 of 9,767
are `private`/workspace-minted and correctly unsellable), 231 visible `master_companies`, first landing
2026-08-18, growing ~100 rows/day, single `linkedin_api` origin throttled at `http 429` but landing between
throttles. The Accounts tab is therefore architecturally correct and commercially thin until ingestion
catches up; that is an ingestion-throughput problem, not a surface problem.
## 2026-08-21 — Public developer portal built at doc.truepoint.in (user directive; ADR-0048)

The user directed "plan and create a new nested application which will be on doc.truepoint.in as per this
detailed plan", supplying `DocappPlan/` — a ten-file business plan for selling company/people data through a
credit-priced API to software companies and AI-agent builders. What was built is the portal that plan puts
first (published pricing in weeks 1-2, dataset pages in weeks 3-4, a docs site in Phase 2): `apps/doc`
(`@leadwolf/doc`), a fifth Next app that is anonymous, fully prerendered, and holds no personal data, no
database client, no auth and no `@leadwolf/config` — enforced by the `doc-app-holds-no-data-path`
dependency-cruiser rule, verified to fire. Design: ADR-0048 + docs/planning/34-public-developer-portal.md.

FOUR CONFLICTS between the brief and this pack are surfaced per rule 6 and NOT silently reinterpreted. None
is resolved here; each needs a human decision before any code implements it.

(a) CONTRIBUTOR-EARNED CREDITS — blocking, rule 7. DocappPlan/02 §6, 04 §Source B, 05 §3 and 06 §4 all price
    contribution in earned credits ("1 verified new contact contributed = N lookup credits"). 07 §Access model
    says the opposite in one line — "no credit, points, or bounty currency anywhere in the system" — and the
    MONETIZATION PIVOT entry above records this exact mechanic being deleted, because a farmable currency
    turns A-03 from data-quality fraud into economic fraud and creates the C-06 clawback problem. The brief
    revives a decision already taken and reversed. The portal therefore publishes PURCHASED credits only and
    carries no earn-rate anywhere; a unit test (apps/doc/src/content/content.test.ts) fails the build if that
    copy ever appears. The brief's supply thesis is NOT thereby endorsed.

(b) SALES NAVIGATOR FALLBACK — blocking, rule 4. DocappPlan/04 §Source A lists a Sales Navigator extraction
    service as waterfall stage 3; 08 §Risk 2 concedes it violates LinkedIn's User Agreement and proposes to
    run it as an "internal stopgap with a written retirement date". Rule 4 forbids it outright and the framing
    does not change that. The published sourcing statement enumerates the supply classes this product stands
    behind and leaves no room for logged-in-platform extraction. No retirement date is recorded here: a
    hard-constraint breach is not something a marketing page schedules.

(c) PUBLIC REAL-DATA SAMPLES — rule 3. DocappPlan/10 asks for a 25-row sample of the real dataset on each
    public page. That is an anonymous egress nobody can suppress and nobody can erase once cached, against
    09-compliance's requirement of suppression at EVERY egress and ≤72h erasure propagation. The pages publish
    the FIELD LIST (what a buyer actually evaluates) with fabricated rows on RFC 2606 reserved domains,
    labelled as illustrative and asserted by test. A real sample needs an authenticated, suppression-checked,
    logged delivery path — not built.

(d) A FOURTH MARKET WITH NO OUTCOME IDS — rule 1. 03-outcomes names three markets (SELLER, CONTRIBUTOR,
    ADMIN/REVOPS). The brief's buyer — a developer or agent consuming data by API — is a fourth, and the
    API-as-product business is adjacent to non-goal S-05 (raw database-size expansion). Rule 1 says such work
    is flagged, not built. What WAS built is the subset serving shipped outcomes: A-01 (a public, specific
    sourcing-and-lawful-basis statement), S-10 (publishing what a confidence score and verification recency
    mean, so the shipped badge is legible from outside the app) and A-02/S-11 (a findable route to opt out).
    The commercial pages — plan pricing, credit costs, dataset catalogue — describe a business this pack has
    not ratified; they ship as dated published INTENT, every item badged "planned", and the operator owes a
    ratification entry here before any metering, billing or public-API code is written against them.

Bounding facts: no endpoint on api.truepoint.in answers the documented paths (there is no api-public feature),
so nothing on the site is callable today; doc.truepoint.in is deliberately NOT added to APP_ORIGINS, so it
receives no auth cookie and widens no CORS or token-audience surface; and the app builds with zero environment,
so it cannot fail on a secret it never holds.

## 2026-08-21 — The API market is ratified; machine credentials built (user directive; ADR-0049)

The user directed "build api on web application and keep its usage dashboard inside the default web
dashboard". This is the operator decision ADR-0048 §C4 asked for and did not have: the developer/API consumer
is a FOURTH market, absent from 03-outcomes' three (SELLER, CONTRIBUTOR, ADMIN/REVOPS), and rule 1 therefore
required it to be flagged rather than built. It is now ratified. The commercial pages on doc.truepoint.in stop
being dated intent and become the published contract of a business this pack endorses.

WHAT THIS DOES NOT RATIFY. A decision to sell data by API is not a decision about where the data comes from.
ADR-0048 §C1 (contributor-earned credits — rule 7, and already reversed once by the MONETIZATION PIVOT above)
and §C2 (the Sales Navigator extraction path — rule 4) are untouched and remain unbuilt. Non-goals X-01/X-02
untouched.

BUILT (ADR-0049, credential layer only): `api_keys` — tenant- and workspace-bound, scoped, SHA-256-hashed
bearer credentials, managed at /api/v1/tenants/me/api-keys behind the `security_admin` org role (ADR-0030).
This closes recorded conflict C11 (intelligence-platform/09 §2: "the one real gap: there are no API keys") and
turns on apps/web's Settings ▸ Developer panel, which shipped in M10 and has been showing "API keys connect
once the developer API ships" ever since — the frontend was never the missing part. 09 §11 open question 4 is
resolved in favour of key→workspace binding: scope comes from the credential, never from an X-Workspace-Id
header the caller controls.

NOT BUILT, and one of the reasons is a compliance precondition rather than a scheduling one:

(a) THE DATA ENDPOINTS. A public API over the master graph is a NEW EGRESS WITH NO suppression_list COVERAGE.
    Every Layer-0 read checks only master_persons.is_suppressed, which mirrors the DSAR fan-out alone — not
    tenant/workspace-scoped suppression_list rows, and with no domain rung. The two cannot be joined in one
    query: leadwolf_er has no grant on suppression_list, leadwolf_app none on master_*. The overlay path
    reconciles them in a SECOND transaction (revealContact, after the er tx); a public surface must do the
    same or it will serve suppressed people. Invariant 3 of 09-compliance — suppression at EVERY egress — is
    a precondition for those endpoints, not a follow-up.
(b) Per-key rate limiting. middleware/rateLimit.ts SKIPS any request carrying an Authorization header (it
    assumes authn will charge per-subject), so an API-key call under /api/* would be throttled by NEITHER
    limiter. A per-key bucket must land with the endpoints.
(c) Two published-contract collisions to resolve before the endpoints ship: doc.truepoint.in publishes
    /v1/* paths, snake_case fields and kebab-case error codes; the shipped platform serves /api/v1/*,
    camelCase fields and snake_case codes. Both are published; one has to change, and the platform is the one
    with users.

CORRECTION TO THE 2026-08-18 ENTRY ABOVE (item (d), now stale): it states that invariant 3 is unsatisfied
because "searchRepository's own header says suppression is NOT yet covered and assertNotSuppressed is called
from three sites only". The searchRepository half is FIXED — buildWhere now carries a NOT EXISTS anti-join
over all three suppression rungs, covering results, facet counts and typeahead. assertNotSuppressed has four
call sites, not three. The REMAINING half of that invariant is (a) above: the Layer-0 plane, which is exactly
where the new API would read.

## 2026-08-22 — Profile Intelligence Panel: shape, gating, and the photo gate held (user decisions)

The user directed that the extension's side panel be built to the Claude Design project "TruePoint
Extension" (`templates/profile-intel-panel`). Three decisions were taken in-session and are recorded here
because two of them deviate from a standing convention and the third RE-AFFIRMS a hard gate.

(a) **Two tabs only — Prospect and Company.** The Captured, Reveal, Lists, Sequences and AI tabs are removed.
    Three of those rendered an `EmptyState` and nothing else (the X06 remainder), and two of them named
    explicit non-goals (X-01 sequencing, X-02 AI email). Reveal's job moves into the Prospect tab's contact
    card. The IndexedDB `recent` store and its reaper stay — the popup still reports "{count} captured on
    this page" — so nothing about the capture queue changes.

(b) **The new read ships DEFAULT-ON, not behind its own feature flag.** `POST /api/v1/contacts/lookup/intel`
    has no `*_ENABLED` switch of its own. This deviates from the "everything dark behind a default-off gate"
    convention the extension series otherwise follows, and the reasoning is that the convention's purpose is
    already served: the extension-wide counsel gates (`CHROME_EXTENSION_ENABLED`, `EXTENSION_ORIGINS`,
    both unset in production per D10/D12) mean no extension-scoped token exists to call it, and the route is
    on the deny-by-default `extensionScope` allow-list. The enumeration guard that DOES matter is kept:
    per-caller rate limiting (`checkDatabaseProfileRate`), the same budget the web's global profile routes
    carry. Note the consequence honestly — a WEB session's token can call this route today, and it returns
    the same masked, suppression-checked data the profile routes already serve.

(c) **Profile photos stay raw-only — the 2026-08-16 HUMAN GATE is NOT opened.** The design shows a LinkedIn
    profile picture and per-position company logos. `profile_picture` is dropped at the mapper boundary and
    survives only in `source_records.raw_data`; position `company_logo` was never mapped. The panel renders
    initials for people and monograms for positions instead, and shows the COMPANY logo, which is a mapped
    field. Opening that gate would need its own entry here plus a column, a mapper change and a DSAR path;
    the user declined it for this pass.

Also recorded, as design-versus-record conflicts resolved against the record (rule 6): the design's mono
footer showed `company_id` / `member_id`, which are internal link metadata under the 2026-08-16 front-end
contract — replaced with the registrable domain and the captured date; "Verify · 1" has no endpoint behind
it and was omitted rather than wired to enrichment, which finds rather than verifies; and "stated
integrations"/"investors stated" would have required mining the company description, so the tab shows the
`specialties` field and says plainly that it is the company's own words. Credit prices are interpolated from
`GET /credits/reveal-costs` — the design's "2 credits" for a phone is an ops setting
(`REVEAL_COST_PHONE`, currently 1), not a number in code.

---

2026-08-22 — FIVE OPEN DECISIONS, gathered in one place. None is a blocked task waiting on effort; each is a
judgement that belongs to a human, and each is currently the reason some real work is not proceeding. They
accumulated across a long hardening session and were scattered over ~28 commits and four documents, which is
how a decision quietly becomes a non-decision. Every one is measured, not estimated.

1. **`--tp-ink-4` as a text colour — 95 sites.** The token is 2.54:1 on white and worse on every tint, below
   the WCAG AA floor for normal text (4.5) AND for large text (3.0), so no text size makes it pass. The
   selectors are mostly informational (`.note`, `.footnote`, `.kpiLabel`, `.timelineTime`, `.sectionHint`);
   a minority are genuinely exempt (a placeholder, icon glyphs, disabled states — 1.4.3 exempts those).
   Not a find-and-replace: `--tp-ink-3` clears AA on white and `--tp-surface-2` but FAILS on `--tp-surface-3`
   and `--nav-hover-fill`, so it is a per-surface call. Held at 95 by
   `packages/ui/src/inkFourContrast.test.ts`; two shared-primitive cases (every form hint, every page eyebrow)
   were already fixed because they were unambiguous and in `packages/ui`.
   **Decide:** migrate per surface, or accept a documented subset as exempt.

2. **Nine cross-feature imports in `apps/web`.** accounts→prospect (×5), accounts→signals, lists→prospect,
   search→prospect, home→api-usage. dependency-cruiser's `no-cross-feature-import` never reported them —
   the cruise runs without a per-app tsconfig so the `@/*` alias does not resolve (251 unresolved, 0 resolved),
   and the rule matches on resolved paths. Now held by `bun run lint:cross-feature`; every other app is at zero.
   **Decide:** move the shared pieces into `shared/`, or acknowledge `prospect` as a base other destinations
   may build on and record that as the rule.

3. **I4's "merge→split→re-derive" exit gate cannot be met** (docs/planning/prospect-database-platform/13 §3a).
   Layer-0 refuses unmerge on purpose — `erRepository.confirmMerge` says "there is no unmerge, and pretending
   otherwise would invite a caller to try" — and Layer-1 records re-pointed children as tallies, not row ids,
   so no merge either grain performs today is invertible. That is unfixable retroactively.
   **Decide:** ship a split (which needs a per-row merge journal first), or amend the exit gate. Building
   against code that says there is no unmerge would be the silent reinterpretation rule 6 forbids.

4. **X3 security sign-off** (database-management-research/16). Unchanged and still the gate on A1/A2 to `main`.
   The audit's own register says every remaining item there is blocked by design and "the next move is a human
   decision, not more code" — worth taking at face value rather than re-scanning.

5. **`users` / `user_sessions` grant posture** (docs/planning/audits/identity-grant-posture.md). Re-verified
   2026-08-22: neither has an RLS policy or a REVOKE, while seven sibling auth tables have one or the other.
   `users.is_platform_admin` is WRITABLE by the customer app role — a privilege-escalation primitive, and the
   sharpest edge in the gap. The obvious fixes both fail as written: a blanket REVOKE breaks 20 join sites,
   and a column-level REVOKE does nothing in PostgreSQL against a table-level grant (you must revoke the table
   privilege and re-grant per column, which obliges every future column). The login path is outside the blast
   radius either way — it runs on the owner connection, not `leadwolf_app`.
   **Decide:** option A (policy on `user_sessions` keyed on `user_id`), B (column re-grant on `users`),
   C (route both behind the auth service and REVOKE), or D (accept, documented). Security has final say.

Two standing ratchets exist so none of the above can quietly get worse while it waits: ink-4 at 95,
cross-feature at 9 (web) / 0 (everywhere else). Both fail the build if the number rises, and both refuse to
pass silently if it falls — they demand the budget be tightened instead.

6. **The email send-quota window: rolling 30 days, or the billing cycle?** (2026-08-22,
   `packages/db/src/repositories/sendQuotaRepository.ts`.) Until now nothing reset `email_send_used` at all —
   `resetPeriod` had no caller, so a tenant that hit its quota was blocked from sending forever. That part is
   simply a bug and is fixed: `lock()` now rolls an elapsed window under the row lock it already holds.
   What is NOT settled is the window's length. The method's own comment said "monthly/daily" and never chose,
   so the fix ships a documented `SEND_QUOTA_PERIOD_DAYS = 30` — the choice that is defensible without knowing
   the answer, because a rolling 30 days can never hand a tenant two windows' worth of sends inside one
   calendar month, which is the direction that costs money.
   **Decide:** keep the rolling window, or align it to the billing cycle (`billing_cycles`) so quota and
   invoice describe the same period. If billing-aligned, the constant should be REPLACED by the cycle
   boundary, not re-tuned — a unit test asserts the 30 deliberately, so changing the number alone fails the
   build and sends the next reader here.

7. **Managed callback origins (AUTH-036): platform-scoped, or post-authentication widening?** (2026-08-23,
   `docs/planning/auth-platform/MANAGED_ORIGINS_BLOCKER.md`.) The auth tracker lists "wire the redirect/CORS
   guards to `resolveAllowedOrigins`" as the next item. It is not a wiring task: three of the four call sites
   validate the return origin before any tenant exists (the user has supplied only an email), and the fourth
   is gated by a CORS preflight, which carries no credentials and so cannot be tenant-scoped even in
   principle. Both obvious workarounds — unioning all tenants' origins, or resolving a tenant from a hint —
   let an untrusted input choose which allow-list to validate against, which hands any tenant a redirect
   target for everyone else's users.
   **Decide:** (B) honour only the platform-NULL rows the table already carries, so the env floor becomes
   bootstrap and platform origins extend it without a deploy — small, no cross-tenant widening possible, works
   at every call site including the preflight; or (A) keep the env floor as the sole pre-auth gate and consult
   per-tenant managed origins only after authentication has established the tenant — more work, and the
   extension mint surface stays env-only regardless. Recommendation is (B) first, (A) only if tenant
   self-service is a real requirement. Nothing was changed unilaterally: security has final say on redirect
   gates. This is also why `authAllowedOriginsRepository`'s three methods show as dead in the
   repository-call-site audit — there is nowhere correct to call them from yet.

8. **Global suppression has THREE writers, and the STAFF one is the narrowest.** (2026-08-24.) Found by
   auditing `packages/core` for exported functions nothing references. An earlier version of this entry said
   "two writers" and implied address-level global suppression did not exist; both were wrong, and the
   corrected picture is below.
   - **Live, staff-initiated:** `POST /admin/compliance/suppression`
     (`apps/api/src/features/admin/compliance.ts:273`) inlines `suppressionRepository.insert` with
     `matchType: "domain"` hardcoded, and its contract (`addGlobalSuppressionSchema`) rejects `@` outright.
     Audit action `suppress.add.global`.
   - **Live, automated:** `dsarFanoutRepository.addGlobalSuppression(tx, emailBlindIndex, reason)`
     (`packages/db/src/repositories/dsarRepository.ts:236`) writes `scope='global', match_type='email'` with a
     BLIND INDEX, and is called on consent withdrawal (`consent.ts:72`, reason `consent_withdrawn`) and on
     DSAR delete (`deleteFanout.ts:112`, reason `dsar:<id>`). Audit action `suppression.add`.
   - **Unused:** `addGlobalSuppression` in `packages/core/src/email/governance.ts` accepts exactly one of
     `{email, domain}`, blind-indexes the email, and audits as `email.global_suppression.add`. No caller.
   - **So the capability is NOT missing** — an individual address IS globally suppressible, and two compliance
     flows do it every day. What is missing is a STAFF-INITIATED address-level suppression: the only surface a
     human operator has is domain-only, so a staff member asked to suppress one person must either block their
     whole employer or wait for a consent/DSAR event to do it.
   - **Three audit actions for one logical operation** (`suppress.add.global`, `suppression.add`,
     `email.global_suppression.add`), so the platform audit log cannot be queried for "global suppressions"
     without knowing all three strings. That is the sharper half of this entry.
   - **Why it matters structurally:** three code paths writing a compliance-critical table is the drift hazard
     this codebase names in its own words (migration 0136 refused to duplicate the title taxonomy in SQL for
     exactly this reason). A future fix to one path silently misses the others.
   **Decide:** (a) point the admin route at the core verb and widen its contract to accept an email — staff
   gain address-level suppression, and two of the three paths collapse into one audit action; or (b) confirm
   domain-only is the intended STAFF policy, delete the unused core function, and reconcile the audit action
   names so the log is queryable. Not changed unilaterally: suppression is a compliance control and CLAUDE.md
   rule 3 applies.
9. **`usage_events` has no tenant half in the code.** (2026-08-24,
   `scripts/audit-feature-flag-coherence.mjs`.) Migration 0088 seeds `provenance_events` and `usage_events`,
   describes them as "the per-tenant halves of three DUAL GATES", and
   `apps/api/src/features/admin/routes.ts:1428-1443` presents each to staff as a paired per-tenant flag.
   Neither key has an `isFlagEnabledForTenant` call anywhere. **Only one of the two is a gap** — this entry
   originally claimed both were, and that was wrong; the correction is below.

   **`provenance_events` — NOT a gap. Seeded ahead of its consumer, exactly as 0088 says.** That flag gates
   OVERLAY events only (`entity_type` contact|account), and 0088's own asymmetry note states Layer-0
   `master_*` events "ride the env half ALONE" because Layer 0 has no tenant to key on. **Every
   `provenance_event` writer that exists today is Layer-0**: `enrichmentEvidence` (person), `runImport`
   (person, company), `landSourcePayload` and `forgeSyncRepository`. `revealContact`'s
   `PROVENANCE_EVENTS_ENABLED` check is a Layer-0 READ (`badgeFor(tx, "person", …)`). No overlay writer has
   been built — the `contact`/`account` entity types in `consent.ts`, `deleteFanout.ts` and `fanoutSignals.ts`
   are audit-log and notification writes, a different table. So env-only gating is CORRECT here, and the
   tenant flag is waiting for a writer, the same "seeded ahead of its consumer" pattern recorded for
   `masterJobPostingsRepository.upsertPosting`. **Add the tenant read when the first overlay writer lands, not
   before.**

   **`usage_events` — a real gap.** `usage_event` rows carry tenant and workspace, 0088 calls the flag a
   "per-tenant rollout gate for usage_event emission", and all four emitters gate on the env switch alone:
   `packages/core/src/prospect/lists.ts:396`, `packages/core/src/reveal/revealContact.ts:417`,
   `apps/api/src/features/contacts-from-database/routes.ts:49`,
   `apps/api/src/features/contacts-resolve/routes.ts:69`. Flipping `USAGE_EVENTS_ENABLED` therefore starts
   emission for EVERY tenant at once, which is the staged rollout the dual gate exists to make possible, and
   the per-tenant control staff can see does nothing.
   - Cost is small and the codebase already solved the hot-path question: the two `apps/api` sites can use
     `apps/api/src/lib/gateMemo.ts` (5s in-process + 30s shared read-through, with invalidation), and the two
     core sites sit on paths that already hold a tenant scope.
   - Migration 0119 later set `global_enabled = true` on every defined flag, so adding the read makes the
     tenant half default to ON; the seed's own `false` no longer applies. Whoever wires it must choose the
     intended default explicitly rather than inherit it.
   **Decide:** (a) add the tenant-half read at the four `usage_events` emitters; or (b) accept env-only gating
   for it, and remove `flagKey: "usage_events"` from the admin listing so staff are not shown a dead control.
   Either way `provenance_events` needs no change now.

## 10. `user_sessions` has no RLS by design, but a customer-surface path now reads it as `leadwolf_app`

**Status:** open — needs a human decision. Raised 2026-08-25 while sweeping every `tenant_id` table for RLS
coverage (the sweep that found the partition bypass fixed in the same session).

**What is true.** `user_sessions` is one of very few tables carrying `tenant_id`/`workspace_id` with no RLS
policy at all, and that is deliberate and recorded. `packages/db/src/rls/auth.sql` states it: the user-scoped
auth tables (`user_sessions`/`user_mfa_methods`/`trusted_devices`/`auth_email_tokens`) are auth-service-owned
and keyed by `user_id`, read by the auth service under its own privileged connection BEFORE any tenant is
chosen. A tenant-predicate policy is close to circular there: you look the session up in order to learn which
tenant it belongs to. The runtime backs this up — the default pool connects as the DB owner and only
`withTenantTx` drops to `leadwolf_app`.

**What has changed since that was written.** `packages/core/src/auth/adminSessions.ts` — the workspace-admin
session-management surface — reads and writes `user_sessions` INSIDE `withTenantTx`, i.e. as `leadwolf_app`,
which the "auth-service-owned" rationale does not contemplate. Two comments in the one feature disagreed about
whether the table is gated:

- `revokeAllForMemberInTx` was right: "RLS does not gate user_sessions, so the membership check is the
  caller's responsibility."
- `revokeMemberSession` said it re-used "the RLS-scoped read", which was false. Corrected in this session.

The app role additionally holds SELECT/INSERT on the table through the schema-wide grant. Nothing reachable
reads it cross-tenant today, and the stored credential material is not usable if read — the session `id` is an
internal reference (the cookie carries the refresh token) and only the token's SHA-256 hash is stored. What a
cross-tenant read would expose is `user_id`, `tenant_id`, `ip_address`, `user_agent` and timestamps: who is
logged in, from where, on what device, in which org. IP addresses are personal data under GDPR, so this is a
compliance question as well as an isolation one (09-compliance.md).

**What was done now, deliberately narrow:** `revokeInTx` is scoped by `workspaceId` instead of session id
alone, so the guarantee no longer depends on its single caller having called `findActiveInWorkspace` first,
and an itest pins it (it fails when the predicate is removed). The false comment is corrected. **The security
model itself was not changed** — adding RLS to an authentication table is not a call to make without a human.

**Decide:** (a) add a workspace-scoped policy to `user_sessions` — verified compatible with all three
tenant-tx methods, and the owner-connected auth path bypasses it since these policies are ENABLE-not-FORCE; or
(b) keep the table ungated and instead REVOKE the app role's grants on it, moving the admin session surface to
a privileged seam; or (c) accept the status quo now that the predicates are explicit, and record in
`rls/auth.sql` that a customer-surface path legitimately touches the table so the next reader is not misled by
the "auth-service-owned" framing.
