# Phase 7 — Rollout Options: How the Two-Layer Target Lands on a Live, Billions-Row, Multi-Tenant System

> **Gate: BRAINSTORM.** Phase 7 (Migration & Rollout) of the prospect↔company data initiative. The RESEARCH gate
> ([RESEARCH_07](./RESEARCH_07_migration.md)) fixed the *shape* of the migration — overwhelmingly **expand + backfill +
> cutover with NO hard contract** (the overlay keeps `contacts.account_id` and the old read path; Layer 0 is added
> *underneath*), the two-stage **build-before-attach** backfill (offline Stage A on the lake → per-workspace Stage B
> attach), and the centerpiece security control: the **grant-off wall** (`REVOKE ALL ON master_* FROM leadwolf_app` +
> least-privilege roles + a gating itest), because the shipped runner blanket-`GRANT`s every table to the customer role
> (`applyMigrations.ts:63-69`). This gate takes those as settled and brainstorms the one decision RESEARCH_07 left open:
> **what is the *unit of cutover* — across what axis do we stage the flip from the old `account_id` read path to the
> master-backed read, and how is each increment proven and rolled back?** It generates the three rollout strategies the
> task names — **(A) big-bang backfill then cutover**, **(B) expand/contract dual-write + shadow-read**, **(C)
> incremental per-workspace flag cutover** — plus the synthesis they imply, names each one's strongest argument and the
> failure that kills it, stress-tests them against the five hardest cases (RLS-safety-during-migration; backfilling the
> master link without double-charging reveals; rollback at each step; `account_id`↔`master_employment` consistency;
> preserving the import-path matching invariant), explicitly challenges the obvious big-bang default, and ends with a
> single DECISION + open questions. **It does not write the plan.** **Depends on:** RESEARCH_07 (the migration shape,
> the grant-off wall §4, the two-stage choreography §5, the Postgres lock rules §3, the pre-build pass §6);
> [BRAINSTORM_04](./BRAINSTORM_04_projection_options.md) (the copy-on-reveal materialization the read cutover serves);
> [BRAINSTORM_05](./BRAINSTORM_05_read_options.md) (the read-path surface being cut over); the shared ground-truth (the
> import-path MATCH-AGAINST invariant, the 4-signal identity hierarchy). **Ground truth:**
> [ADR-0021](../decisions/ADR-0021-global-master-graph-and-overlay.md),
> [ADR-0007](../decisions/ADR-0007-per-workspace-reveal-and-credit-counter.md),
> [ADR-0037](../decisions/ADR-0037-bulk-match-first-resolution-and-candidate-index.md),
> [ADR-0015](../decisions/ADR-0015-entity-resolution-dedup-engine.md); `03-database-design.md` §5.1/§5.2; the shipped
> machinery `packages/db/src/applyMigrations.ts`, `client.ts`, `rls/contacts.sql`, `schema/contacts.ts`,
> `schema/featureFlags.ts`, `core/src/enrichment/bulk/matchPort.ts`, `bulk/masterGraphMatcher.ts`,
> `core/src/import/runImport.ts`. External claims carry RESEARCH_07's `[VERIFIED]`/`[INFERRED]` provenance **by
> reference**; this gate adds no new external research — it reasons over the option space RESEARCH_07 mapped.

---

## 0. What this gate decides — and what it must not reopen

RESEARCH_07 decided the migration's **shape** (additive, reversible, two-stage, no hard contract) and its **non-negotiable
control** (grant-off). It did **not** decide the **rollout axis**: when D6 (the read-path cutover — the only
customer-visible, regret-prone step) finally flips a workspace from "company via `account_id` join" to "company via the
master-backed flattened view," *across what dimension does that flip progress, what evidence gates each increment, and
what is the rollback unit?* That is this gate's whole job, and it is genuinely open because three forces pull on it:

- **Blast radius vs. proof.** A flip you can prove correct in aggregate (shadow-read parity across all traffic) is not
  the same as a flip whose blast radius is one tenant. The three strategies trade these against each other.
- **Locality split.** Stage A (the Layer-0 ER build, D3) is **system-owned and has no `workspace_id`** (ADR-0021:81-84) —
  it is inherently a *global, offline* batch. Stage B (the overlay attach + read cutover, D2/D4/D5/D6) is **per-workspace,
  RLS-scoped** (`withTenantTx`). A rollout axis that ignores this split mis-stages one of the two stages.
- **The two company paths coexist.** Throughout the transition, `contacts.account_id → accounts` (the old per-workspace
  link, `contacts.ts:98`) and `master_person_id → master_persons.current_company_id → master_companies` (the new golden
  edge) are **both live and can disagree** — so the cutover is not a swap, it is a *reconciliation under measurement*.

**Fixed by RESEARCH_07 — not reopened here:** the migration is expand/backfill/cutover, no hard contract, `account_id`
retained (RESEARCH_07 §1); `master_*_id` stays **nullable** (ADR-0021:63-65 in-flight staging — never `NOT NULL` in this
migration); the **grant-off wall** is a first-class, tested step (RESEARCH_07 §4; `applyMigrations.ts:74-84` precedent);
Stage A runs **offline on the lake/Spark, never the OLTP primary** (Stripe model, RESEARCH_07 §2.2); the backfill reuses
the **one** `MatchPort` + `matchKeys.ts` normalizer — no second matcher (ADR-0037:75-81); the Postgres lock rules
(`CONCURRENTLY`, `NOT VALID`+`VALIDATE`, `lock_timeout`+retry) are obeyed per statement (RESEARCH_07 §3); the FORCE-RLS
overlay posture and the two-tenant isolation itest stay green (CLAUDE.md precedence — security has final say). Every
option below is constrained to live *inside* that shape; none may weaken FORCE-RLS, grant `leadwolf_app` a read on
`master_*`, or make a column `NOT NULL` to ease a flip.

The five cross-cutting constraints carried from the shared ground-truth: **C1** Layer 0 has no RLS (isolation by access
path + grant-off); **C2** owner/visibility is app-layer, not RLS; **C3** shared identity, per-workspace billing/reveal;
**C4** matching is free, revealing is metered (the HC2 crux); **C5** billions of rows × millions of users — no global
cliff, no unbounded fan-out, no un-rollback-able step.

---

## 1. The axis being brainstormed

```
   STAGE A (global, offline, system-owned)            STAGE B (per-workspace, online, RLS-scoped)
   ────────────────────────────────────────            ──────────────────────────────────────────
   source_imports.raw_data + provider_calls            for each workspace, withTenantTx(scope):
        │  ER (Splink-on-Spark over Iceberg)             D4 attach: MatchPort.matchRow → set master_*_id (0 credits)
        ▼  [grant-off: REVOKE ALL FROM leadwolf_app]      D5 dual-write: every NEW import row sets master_*_id
   master_persons ─ master_employment ─ master_companies  D6 read cutover: account_id-join ──► master-backed view
        (golden, no workspace_id)                                         ▲
                                                          THE OPEN AXIS ──┘  across WHAT do we stage D6, and how is
                                                                             each increment PROVEN and ROLLED BACK?
```

Every option answers three sub-questions; the options differ **only** in these three answers — which is what makes them
distinct strategies rather than variations:

| | **Q1** Unit of cutover (what advances) | **Q2** Gate on each increment (the go/no-go evidence) | **Q3** Rollback unit (blast radius of a regression) |
|---|---|---|---|
| **A** big-bang | **Time** — one global "go-live" after a full offline build | Offline validation (row counts / sampled diff); no live read-parity signal | **All tenants at once**; if `account_id`/old path is dropped → restore-from-backup |
| **B** expand/contract dual-write + shadow-read | **Pipeline phase** — all tenants move through each phase together | **Aggregate shadow-read mismatch rate** (Scientist, live, all traffic) | **All tenants at once** (revert the global read flag) |
| **C** per-workspace flag cutover | **Workspace (tenant)** — each flips independently, population ramped 1%→100% | Per-workspace flag decision (operator/canary), no built-in parity proof | **One tenant** (flag-off) — finest unit |
| **D** synthesis (B-spine × C-flip) | **Phase globally** for shared/additive steps, **workspace** for the D6 read flip | **Per-workspace shadow-read parity** gates each workspace's flip | **One tenant** for D6 + per-phase reversible for the shared steps |

---

## 2. The four options

### Option A — Big-bang: full offline backfill, then one global cutover

**Flow.** Build Layer 0 completely offline (Stage A over the entire lake), run the global overlay attach (D4) to set
`master_*_id` on every existing `contacts`/`accounts` row, validate in aggregate (row counts, a sampled diff of
account-derived vs. master-derived company), then in a single coordinated change enable import dual-write (D5) and **flip
the read path for every workspace at once** (D6) — optionally demoting/removing the old `account_id` read path in the same
window. One validation, one switch, one "go-live."

**Strongest argument: minimal transitional surface — old and new code barely coexist.** A's appeal is that there is no
long-lived period of two read paths, two write paths, and a per-tenant state machine to operate. The dual-path window is
compressed to the cutover itself, so the two paths have almost no time to drift, and engineers reason about one before/after
state instead of a population of half-migrated tenants. For a smaller dataset this is genuinely the simplest correct thing —
and the *build* half of it (Stage A as one offline batch) is in fact the right shape (see §4).

**Killer failure mode: at billions of rows it is a stale snapshot flipped on faith with an un-rollback-able cliff.** Three
compounding defects. (1) **The build window is long and the world mutates under it.** Stage A over billions of rows takes
real wall-clock time; during it, workspaces keep importing, revealing, and editing, so the offline snapshot is *stale at
cutover* — A must therefore reconcile a delta, which is dual-write reintroduced *under time pressure with no shadow-read
proof* (the exact thing A claimed to avoid). (2) **No live go/no-go.** A flips on an offline validation that cannot
capture production read parity; at this scale you cannot eyeball correctness, and the `account_id`↔`master_employment`
disagreement (HC4) is *expected-nonzero* (curation), so an offline diff can't distinguish "wrong" from "deliberately
filed differently." (3) **Total blast radius, cliff rollback.** A global read flip — especially if `account_id` is dropped —
makes a regression a restore-from-backup event, not a flag flip; this is the un-rollback-able cliff the entire online-DDL
literature exists to avoid (RESEARCH_07 §2, §7-reject). A's "simplicity" is a false economy: it defers dual-write to a
panic and trades away rollback, proof, and containment to dodge a complexity the architecture has already neutralized (§4).

### Option B — Expand/contract: global dual-write + shadow-read, staged by pipeline phase (the Stripe model)

**Flow.** The canonical four-step (RESEARCH_07 §2.2). Expand (D1/D2/D7 + grant-off), backfill (D3 offline, D4 attach),
turn on import **dual-write globally** (D5 — every new row resolves + sets `master_*_id`), then run **shadow reads** across
all traffic: a Scientist-style comparator executes both the `account_id`-join and the master-backed view in production and
reports the **aggregate mismatch rate**. When aggregate parity crosses the threshold, **flip reads globally** (D6), no hard
contract. The unit of progress is the *phase*: all workspaces advance through expand → backfill → dual-write → shadow →
new-read together.

**Strongest argument: it flips on empirical, production-measured proof, not faith — and every phase is reversible.** B is
the industry reference precisely because the read switch is gated by a *measured* mismatch rate under real load, and each
phase is independently revertible (stop dual-write; revert the read flag). Of the four, B produces the **strongest
correctness evidence** before the customer-visible flip: you do not move reads until the new path has been shown to return
the same answers as the old one at scale. It is the right *discipline*.

**Killer failure mode: the read flip is still global — aggregate parity averages away the per-tenant outliers that break.**
B proves parity *in aggregate*, then flips *everyone* on that aggregate. But the `account_id`↔`master_employment`
disagreement (HC4) is **not uniformly distributed**: a workspace that files contacts under parent/holding accounts, or whose
`accounts` rows deduped two domains the master keeps distinct, or whose data is simply stale, has a *high local* mismatch
that a global average drowns. B flips those workspaces on a number that was never about them, and the blast radius is **all
such tenants simultaneously**. Secondary defects: global dual-write requires Stage A globally complete before the invariant
holds anywhere (the same long pole as A for the import path, HC5); the shadow-read **doubles read cost** during the
comparison window at billions scale; and the shadow-read itself is a **new code path that reads `master_*`** and so must run
under a least-privilege reveal/search role — wire it under `withTenantTx` (`leadwolf_app`) and it either fails grant-off or,
if "fixed" by a grant, breaches the wall (HC1). B has the proof but not the containment.

### Option C — Incremental per-workspace cutover behind a flag

**Flow.** The unit of progress is the **workspace (tenant)**. Each workspace independently advances off → attached →
dual-write → read-cutover, gated by a flag, and the *population of workspaces* is ramped 1%→100% (the LaunchDarkly
percentage model, RESEARCH_07 §2.4). Canary the friendliest (and the messiest) tenants first; each flip's blast radius is
one tenant; a regression is reverted by flipping that one flag.

**Strongest argument: minimal blast radius and instant, per-tenant rollback.** C is the **operationally safest** flip: a
regression is contained to one workspace and reverted by one flag — no global cliff, no all-or-nothing revert. It lets you
*canary the outliers B averages away*: flip a messy-account tenant alone, watch it, and contain the damage if it breaks. Of
the four, C has the finest rollback unit and the smallest worst-case blast.

**Killer failure mode: a flag controls *who*, not *whether the new path is correct* — and "per-workspace" mis-models Stage
A.** Two defects. (1) **No built-in proof.** A per-workspace flag flips a tenant whether or not the master-backed read is
*right* for it; without B's shadow-read parity as the gate, C is just a faster way to ship a possibly-wrong read one tenant
at a time. The flag is necessary (containment) but not sufficient (it is not evidence). (2) **Stage A is not
per-workspace.** Layer 0 has **no `workspace_id`** (ADR-0021:81-84) — the heaviest step (D3 ER build) is inherently global
and offline; framing "the whole migration" as per-workspace hides that Stage A must populate *that workspace's universe*
before any per-workspace attach/dual-write can hold the invariant (HC5). (3) **Granularity gap (repo-specific).** The
shipped flag surface is **global + per-TENANT** (`feature_flags` + `tenant_feature_flags`, `featureFlags.ts:15-44`), **not
per-workspace** — a tenant with many workspaces cannot be partially flipped without a finer override that does not yet
exist (open question, §6). C has the containment but not the proof, and its "workspace" unit is really "tenant" today.

### Option D — Synthesis: B's phase-gated spine with C's per-workspace, shadow-read-gated read flip

**Flow.** Put each step on the axis that matches its risk. Use **B's phase discipline** for the *globally-shared, additive,
reversible* steps: expand (D1/D2/D7 with grant-off as a first-class tested step), the offline **global** Stage-A build (D3
on lake/Spark), and **global import dual-write** (D5) enabled once Stage A is ready. Then use **C's per-workspace
granularity** for the *one risky, customer-visible* step — the D6 read cutover — **gated by B's shadow-read parity measured
per workspace**: a workspace flips only after *its own* mismatch rate is under threshold; ramp the population of workspaces
1%→100%; `account_id` + the old read path stay live as the instant per-workspace rollback (RESEARCH_07 §1, §2.3 "keep the
old intact"). Two axes: **phase × workspace**.

**Distinct from A/B/C** (not a variation): vs **A**, there is never a global cliff and never a dropped `account_id` in v1 —
every step is reversible. vs **B**, the read flip is **per-workspace, not global**, so per-tenant outliers (HC4) cannot be
averaged away and the blast radius of a bad flip is one tenant. vs **C**, it keeps B's shadow-read **proof** (C alone flips
on a flag without proving parity) *and* it correctly models Stage A as a **global, non-per-workspace** offline batch rather
than pretending the whole migration is per-workspace. D is the only option that is simultaneously *proven* (B's parity) and
*contained* (C's per-tenant rollback) while honoring the Stage-A/Stage-B locality split RESEARCH_07 §5 fixed.

**Strongest argument: the right axis for each step's risk — cheap shared infra rolls out globally and reversibly, the one
regret-prone customer switch rolls out per-tenant with empirical proof and one-tenant rollback.** D maximizes both
correctness evidence (B) and rollback granularity (C) at the same time, which neither B nor C does alone.

**Killer cost (not a disqualifier): the most moving parts — two rollout axes + a per-workspace state machine + a flag
granularity the shipped surface lacks.** D operates a phase axis and a per-workspace axis at once, needs a per-workspace
(or accepts per-tenant) flag override (§6 open-Q 1), and carries the per-workspace shadow-read comparator. But **every piece
is individually reversible**, so the operational complexity *buys* safety rather than risk — the opposite of A, whose
simplicity buys a cliff. The complexity is the price of putting each step on its correct axis.

---

## 3. Stress test against the hard cases

| Hard case | **A** big-bang | **B** global dual-write+shadow | **C** per-workspace flag | **D** synthesis |
|---|---|---|---|---|
| **HC1** RLS-safe during migration (no cross-ws read; no FORCE-lockout) | ◐ walls unchanged, but a master-read isolation bug exposes **all** tenants at flip | ◐ same wall, **plus** shadow-read is a new `master_*` reader that must dodge `leadwolf_app` | ✅ any read-cutover isolation bug confined to one tenant | ✅ confined to one tenant + B's grant-off discipline on the shadow reader |
| **HC2** attach master link without double-charging reveals | ◐ free if it uses the match seam, but only **aggregate** credit-delta auditable | ◐ free; aggregate-auditable | ✅ free; **per-workspace** credit-delta = 0 assertable | ✅ free; per-workspace credit-delta = 0 assertable |
| **HC3** rollback at each step | ❌ global cliff; dropped `account_id` → restore-from-backup | ⚠️ per-phase reversible but read flip reverts **all** tenants | ✅ per-tenant flag-off (finest unit) | ✅ per-tenant flag-off + per-phase reversible |
| **HC4** `account_id` ↔ `master_employment` company consistency | ❌ flips on a global average; messy-account tenants break unseen | ⚠️ aggregate parity hides per-tenant divergence | ◐ contains the break, but no parity proof unless B's gate added | ✅ per-workspace parity gate measures + tunes the divergence before flipping |
| **HC5** import-path matching invariant during transition | ❌ needs global Stage A before any dual-write; stale-snapshot catch-up | ⚠️ global dual-write needs global Stage A (long pole) | ◐ per-ws, but must know Stage A covers that ws's universe | ✅ global dual-write once Stage A ready; per-ws read flip independent |

The five, in prose — the two subtle ones (HC2, HC4) first:

**HC2 — backfilling the master link without double-charging reveals (the crux the task flags).** Attaching `master_*_id`
to an existing overlay row is a **MATCH (match-against), which is free by construction** — it is *not* a reveal. The two are
different seams: the `MatchPort.matchRow` path returns `matched`/`matched_internal` with **0 credits**
(`masterGraphMatcher.ts:15` "*0 credits, outcome matched_internal*"; `matchPort.ts:48-62` — `MatchRowResult` carries no
billing field), whereas a *reveal* is the separately metered first-reveal-wins verb keyed on
`contact_reveals(workspace_id, contact_id, reveal_type)` that decrements the credit pool `FOR UPDATE` (ADR-0007:15-17,40)
and sets `is_revealed`/`revealed_by_user_id`/`revealed_at` (`contacts.ts:128-129`, guarded by the
`is_revealed = (revealed_by_user_id IS NOT NULL)` check `contacts.ts:184-186`). So the attach must: (i) go through the
**match** seam, **never** the reveal service; (ii) write **only** `master_person_id`/`master_company_id`; (iii) **never**
touch `is_revealed`/`revealed_by_user_id`/`revealed_at` or the credit pool. A contact the workspace already revealed/imported
keeps its reveal state untouched; attaching the golden pointer to it is free and **idempotent** (deterministic keys resolve
the same row to the same master id on re-run — RESEARCH_07 §6.2). The danger is an implementation that routes the backfill
through the reveal-and-charge path; the guard is that match ≠ reveal and the backfill uses only the free match seam, plus a
**backfill invariant test** asserting the credit pool is unchanged and **zero `contact_reveals` rows are written by the
attach**. This is option-independent in principle — but **per-workspace options (C/D) make it auditable per tenant**
(assert each workspace's credit-pool delta = 0 across its attach), whereas big-bang (A) can only assert the global
aggregate, hiding a per-tenant charge bug until a customer disputes it.

**HC4 — `account_id` ↔ `master_employment`-derived company consistency (the case that decides the axis).** Two paths from a
contact to a company coexist for the whole transition: the **old** per-workspace `contacts.account_id → accounts` (deduped
by `(workspace_id, domain)`, one company, no history — `contacts.ts:98,197`) and the **new**
`master_person_id → master_persons.current_company_id → master_companies` (the golden current edge, ADR-0021). They **can
and will disagree**: the person changed jobs (the overlay `account_id` is stale); the workspace deliberately filed the
contact under a parent/holding account (curation); the overlay deduped two domains the master keeps distinct, or vice-versa.
**Precedence:** `master_employment` is the golden *fact* ("Alice works at Acme now"); `account_id` is the workspace's **own
curation** and is **survivorship-protected** — human filing is not silently overwritten by a provider/golden value
(ADR-0015). So the read cutover does **not** overwrite `account_id`; it surfaces the master-derived current employer as the
*golden facet* and keeps `account_id` as the workspace pointer, and the **shadow-read measures the disagreement rate as the
go/no-go**. Because the disagreement is *expected-nonzero* (curation is legitimate divergence, not error), the gate must
distinguish "deliberately different" from "wrong answer" — a threshold an *aggregate* global flip (A/B) cannot tune per
tenant. **This is the single sharpest argument for the per-workspace, shadow-gated flip (D):** only it measures *each
workspace's own* divergence and flips that workspace when *its* number is acceptable, instead of flipping the messy-account
tenants on an average that was never about them.

**HC1 — RLS safety during migration (two sub-hazards, mostly option-independent; blast radius is what differs).** (a) **The
grant-off wall.** The instant `master_*` are created, the next migrate's blanket `GRANT … ON ALL TABLES TO leadwolf_app` +
`ALTER DEFAULT PRIVILEGES` (`applyMigrations.ts:63-69`) auto-grants the customer role the **entire shared universe**; Layer
0 has no `workspace_id`, so no fail-closed predicate — one forgotten `WHERE` = full-universe cross-tenant breach
(RESEARCH_07 §4). The migration **must** `REVOKE ALL ON master_* FROM leadwolf_app` (mirroring the platform-staff REVOKE at
`applyMigrations.ts:74-84`), add least-privilege ER/search-sync/reveal roles, and ship a gating itest (`leadwolf_app`
`SELECT` on `master_*` errors / returns zero rows). This is **identical in A/B/C/D** — *but* B and D introduce a **new
application read path** (the shadow-read of the master-backed view) that touches `master_*` and **must run under a
least-privilege reveal/search role, never `leadwolf_app`/`withTenantTx`**; wire it under `withTenantTx` and it either fails
grant-off or, if "fixed" by a grant, breaches the wall. So the grant-off rule must be enforced in *application* code for the
shadow reader, not only in the migration. (b) **No FORCE-lockout of the app role.** The core overlay steps (D2/D8) only
**add nullable columns** to the already-`ENABLE`+`FORCE ROW LEVEL SECURITY` `contacts`/`accounts` (`rls/contacts.sql:17-18,
28-29`) — metadata-only, **no policy change, no lockout hazard**, and **no transitional window where workspace isolation
weakens** (the walls are untouched throughout). The *only* lockout risk is D8's **optional** ADR-0022 visibility RLS
predicate: adding a policy/`FORCE` on a live table takes `ACCESS EXCLUSIVE`, and if the policy is not created in the same
window, default-deny **blanks the overlay** (locks the app role out of its own rows) — mitigated by `lock_timeout`+retry and
same-window policy creation (RESEARCH_07 §3). Net: HC1 is option-independent for the *mechanism*; the *blast radius* of a
master-read isolation bug is **all tenants** under A's global flip vs **one tenant** under C/D.

**HC3 — rollback at each step.** A: expand/backfill are reversible (drop the nullable col / NULL-out — safe because
`account_id` still serves, RESEARCH_07 §6.8), but the **global read cutover is the cliff** — drop `account_id`/the old path
and rollback = restore-from-backup, not a flag. B: each phase reversible, but the read flip is **all-or-nothing** — a
regression in 2% of tenants forces reverting 100%. C: **per-workspace flag-off = the finest unit**, one tenant. D: C's
per-tenant rollback for D6 **plus** B's per-phase reversibility for the shared steps — the best of both. Rollback strongly
favors C/D; A is worst.

**HC5 — preserving the import-path matching invariant during transition.** The invariant (ADR-0021:53-65): every overlay row
**always** resolves to a master entity via match-against. During transition this is an **eventual** guarantee —
`master_*_id` nullable = in-flight staging (ADR-0021:63-65) — enforced by (a) D5 dual-write for new rows + (b) D4 backfill
for old rows, **both via the same `MatchPort`/`matchKeys`** (no second matcher — ADR-0037:75-81). The import path **admits
the gap today**: `runImport.ts` does not yet set `master_*_id` (RESEARCH_07 D5). The ordering hazard: a workspace must **not**
be declared "invariant-holding" until Stage A has populated *its universe* **and** D5 is on **and** the D4 backlog is
drained; until then new imports land `master_*_id = NULL` (tolerated staging, re-attached by the next sweep — exactly like
today's `account_id = NULL`). And because `masterGraphMatcher` is a **STUB** returning `none` until the candidate index
lands (`masterGraphMatcher.ts:26-34`), matches **degrade gracefully** to the overlay + provider tiers — never an error.
Big-bang (A) needs **global** Stage A complete before turning on dual-write anywhere (long pole + stale-snapshot catch-up);
B needs global Stage A for its global dual-write; **D** lets dual-write go global once Stage A is ready while the
per-workspace read flip proceeds independently — the cleanest decoupling.

---

## 4. Challenging the obvious default (big-bang, A)

Big-bang is the *tempting* default — "just build the master graph offline, then flip" — because it promises one clean
before/after with no long-lived dual-path code, no per-tenant state machine, and one validation to run. That instinct is
**half right and half catastrophic**, and the split is the whole lesson of this gate:

1. **Big-bang is the right shape for the BUILD, the wrong shape for the CUTOVER.** Stage A (the Layer-0 ER build, D3) *is*
   a global offline batch — built once, fully, on the lake/Spark before anything attaches (RESEARCH_07 §5; Stripe's
   offline-snapshot model §2.2). Conceding this is honest: the *build* is big-bang-shaped. The defect is using big-bang for
   the **customer-visible read cutover (D6)**, where global + irreversible is exactly wrong. D encodes precisely this split:
   global offline build, incremental per-workspace flip.
2. **Big-bang doesn't avoid dual-write — it defers it to a panic.** The offline build window over billions of rows is long;
   the world mutates under it; at cutover the snapshot is stale, so A must reconcile a delta — which **is** dual-write,
   reintroduced under time pressure with no shadow-read proof. A pays the dual-write cost anyway, at the worst possible
   moment.
3. **Big-bang flips on faith; the scale forbids faith.** There is no live read-parity signal — an offline diff cannot
   capture production behavior and cannot tell HC4's *legitimate* `account_id`↔`master_employment` divergence from a wrong
   answer. B/C/D flip on a **measured** mismatch rate. At billions of rows you cannot eyeball correctness.
4. **Big-bang cannot see per-tenant outliers.** A global aggregate validation passes while the messy-account workspaces
   (HC4) break — and they all break *at once*, with the rollback being a restore, not a flag (HC3). A per-tenant ramp is the
   only mechanism that surfaces the outlier before it is customer-visible.
5. **Big-bang's one true virtue is already neutralized.** Its real benefit — least dual-path drift — is cheap to buy
   elsewhere: the backfill and the live import path are **the same `MatchPort` call** (ADR-0037 anti-drift, RESEARCH_07 §5),
   so the two paths **cannot** drift; the "transitional complexity" A claims to avoid is already collapsed to one seam. So A
   trades away rollback, proof, and blast-radius containment to dodge a complexity the architecture has already removed.

The challenge does **not** rehabilitate the lazy alternatives either: **B alone** ships the proof but flips globally
(per-tenant outliers averaged away, all-or-nothing rollback); **C alone** ships the containment but flips on a flag without
proving parity and mis-models the global Stage A. The live question the default leaves open is therefore not "big-bang vs.
staged" — that is settled against big-bang — but **"on which axis does each step belong, and how is the one risky flip both
proven and contained,"** which is the B×C synthesis (D).

---

## 5. DSAR, consistency & implementation-status notes

**DSAR during the migration.** Erasure stays the audited platform fan-out keyed on `email_blind_index` (`contacts.ts:107`;
`withPrivilegedTx`, `client.ts:30-35`): one master identity → tombstone every overlay `contacts` copy + null PII
(`deleted_at`, `contacts.ts:147`) → `global`-scope suppression row blocks re-import (`list-plan/02-data-model.md §5.2`). The
migration adds one rule: a **suppressed/tombstoned subject must be excluded from re-match/re-attach mid-backfill** — Stage B
must not resurrect a `master_*_id` link onto a row being erased, and Stage A must not re-cluster a suppressed identity
(RESEARCH_07 §6.4). The per-workspace cutover (C/D) makes this auditable per tenant; it does not change the cascade.

**Consistency invariant during transition.** Because `account_id` is **retained and demoted** (not dropped — RESEARCH_07
§1), there is never a moment where a contact loses its company link: the old path serves until D6 flips that workspace, and
after the flip the master-derived company is the golden facet while `account_id` remains the workspace's own pointer (HC4).
No window of "no company" exists for any contact in any option.

**Implementation status (work-to-do, never license to skip — security has final say, CLAUDE.md precedence).**
- Layer 0 (`master_*`, `source_records`, `match_links`), the offline ER topology, and the least-privilege roles are
  **planned, unbuilt** (RESEARCH_00 P1/P5/P6/P8); `masterGraphMatcher` is a **shipped stub** returning `none`
  (`masterGraphMatcher.ts:26-34`). The rollout's Stage A has nothing to attach to until these land.
- The **grant-off REVOKE** for `master_*` and the **"`leadwolf_app` cannot read `master_*`" gating itest** are **not yet
  present** — the blanket `GRANT` (`applyMigrations.ts:63-69`) would auto-open Layer 0 the moment the tables exist
  (RESEARCH_07 §4). This is the highest-priority migration step in any option.
- The **flag surface is per-TENANT, not per-workspace** (`feature_flags` + `tenant_feature_flags`,
  `featureFlags.ts:15-44`). Option C/D's "per-workspace" flip either accepts per-tenant granularity (flip a whole tenant at
  once) or needs a finer override that does not exist today (§6 open-Q 1).
- The **shadow-read comparator** (Scientist-style) is unbuilt; the `MatchPort`/`matchKeys` seam and the
  `enrichment_job_rows` backfill ledger (`enrichmentJobs.ts`, with `match_method`/`match_outcome`/`match_confidence`) **are**
  shipped and are the right vehicles (RESEARCH_07 §2.5, §5). The **CONCURRENTLY execution lane** and `INVALID`-index sweep
  (RESEARCH_07 §3) remain a gap for the PLAN.

---

## 6. DECISION

**Adopt Option D — a phase-gated spine (B's discipline) with a per-workspace, shadow-read-gated read cutover (C's
granularity), no hard contract — and reject big-bang cutover (A), global-only dual-write+shadow (B-alone), and
flag-without-proof (C-alone).** Stated as one direction for the PLAN:

> **"Build globally and offline; flip per-workspace, on proof, reversibly."** Roll out the *shared, additive, reversible*
> steps on a **global phase axis** — expand (`master_*` create + the **grant-off REVOKE + gating itest as the first
> security step**) → offline **Stage-A** ER build on the lake/Spark (never the OLTP primary) → **global import dual-write**
> (D5) once Stage A covers the universe, via the one `MatchPort` (free, 0-credit match — never the reveal seam). Roll out
> the *one risky, customer-visible* step — the **D6 read cutover** — on a **per-workspace axis**, gated by **that
> workspace's own shadow-read parity** (distinguishing legitimate `account_id`↔`master_employment` curation divergence from
> a wrong answer), ramped 1%→100% across the tenant population, with `account_id` + the old read path **retained** as the
> instant per-tenant rollback. `master_*_id` stays **nullable** (in-flight staging); no `NOT NULL`, no dropped `account_id`,
> no hard contract in v1.

Why this and not the alternatives:

- **Reject A (big-bang cutover).** It is a stale snapshot flipped on faith with a restore-from-backup cliff and no
  per-tenant visibility (HC3/HC4); it defers dual-write to a panic; and its one virtue (least drift) is already neutralized
  because backfill and live writes are the same `MatchPort` call (§4). Big-bang is correct only for the *build* (Stage A is
  an offline batch) — which D keeps.
- **Reject B-alone (global flip).** It has the proof but flips everyone on an aggregate that averages away the per-tenant
  outliers that actually break (HC4), and its rollback reverts 100% of tenants for a 2% regression (HC3). D keeps B's
  shadow-read *proof* and B's phase discipline for the shared steps, but moves the flip per-workspace.
- **Reject C-alone (flag without proof).** A flag controls *who*, not *whether the new read is correct*; without B's
  parity gate it ships a possibly-wrong read one tenant at a time, and "per-workspace" mis-models the global Stage A (HC5).
  D keeps C's per-tenant containment but adds B's parity gate and the correct global Stage-A axis.

This satisfies all five constraints: **C1** (Layer 0 stays grant-off; the shadow reader runs under a least-privilege role,
never `leadwolf_app`); **C2** (owner/visibility untouched — the migration is additive nullable columns on the unchanged
FORCE-RLS overlay); **C3** (attach is a free match, reveal stays the separately-metered per-workspace verb — HC2); **C4**
(matching free, revealing metered — the no-double-charge guard); **C5** (no global cliff, no un-rollback-able step, offline
billions-scale build off the primary, per-tenant blast radius on the only risky flip).

### Open questions handed to the PLAN (not decided here)

1. **Per-workspace vs per-tenant flip granularity.** The shipped flag surface is **per-TENANT** (`tenant_feature_flags`,
   `featureFlags.ts:29-44`). Does the D6 cutover need a true **per-workspace** override (a tenant flipped partially), or is
   per-tenant granularity acceptable (flip a whole tenant at once)? Settle the unit precisely and, if per-workspace, name
   the override mechanism — extends RESEARCH_07 §8.
2. **Shadow-read scope, sampling, and the HC4 threshold.** Which reads get compared (the "person at company with traits"
   query, the detail read, the account↔company facet), the per-workspace sampling rate, and the mismatch threshold that
   gates a workspace's flip — specified to **separate legitimate `account_id`↔`master_employment` curation divergence from a
   wrong answer** (HC4). RESEARCH_05-adjacent.
3. **`account_id` ↔ `master_employment` read-time precedence.** When they disagree post-flip, what does the read return —
   golden current employer, the workspace `account_id`, or both as distinct facets — and how is survivorship (workspace
   curation not silently overwritten, ADR-0015) expressed at read? (HC4)
4. **Per-workspace Stage-A readiness signal.** How does the cutover state machine know Stage A has populated *that
   workspace's universe* enough to attach + dual-write (a coverage metric, not just "Stage A finished globally")? (HC5)
5. **The backfill no-charge guard.** The exact assertion (per-workspace credit-pool delta = 0; **zero** `contact_reveals`
   rows written by the attach) and where it lives (a backfill invariant test); plus how a **concurrent live reveal** during
   the attach is ordered so neither clobbers the other (fill-only). (HC2)
6. **The Stage-A catch-up delta.** Rows imported/revealed/edited while Stage A runs offline — swept by a continuous
   re-attach, or a final reconciliation pass before each workspace's flip? (the staleness window big-bang ignores, §4.2)
7. **Shadow-reader role + grant-off enforcement in app code.** The exact least-privilege role the shadow-read of the
   master-backed view runs under (never `leadwolf_app`), and how the grant-off itest is extended to cover this *application*
   read path, not just the migration grants (HC1). Inherits RESEARCH_07 §8 open-Q 2 + the CONCURRENTLY-lane/`INVALID`-sweep
   mechanics (open-Q 1).
