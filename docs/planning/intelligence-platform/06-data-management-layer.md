# Phase 6 — Data-Management Layer

Phase 5 shipped the DDL. This phase makes it *do* something: repositories (the only data-access path),
the confidence/decay fold, the ER blocking sweep, and the adoption dual-write.

**Slice order and why.** Pure code first, DB-touching code second. Everything in `packages/core` is
unit-testable in this environment; everything in `packages/db` needs Postgres, which means CI. Building the
provable part first means each landed slice is actually verified rather than merely written.

| # | Slice | State |
|---|---|---|
| 6.1 | Confidence + decay fold (`packages/core`, pure) | ✅ **done, 33 tests passing** |
| 6.2 | Repositories for the new Layer-0 tables | ✅ **done** — technology, signals, company-detail |
| 6.3 | ER blocking — the candidate generator (`packages/core/src/er/blocking.ts`) | ✅ **done, 43 tests**; the worker sweep that calls it is queued |
| 6.4 | Name-blocked ER pass wired into the **existing** shadow sweep | ✅ **done** |
| 6.5 | Adoption cutover — **re-scoped: R-1's premise was wrong** | ✅ **corrected; no dual-write needed** |
| 6.5 | HMAC wiring for `master_company_contact_points.value_blind_index` | ☐ |
| 6.6 | `master_signals` joins the DSAR erasure fan-out | ☐ **blocks person-subject signal rows** |

---

## Slice 6.1 — the confidence fold (done)

`packages/core/src/prospect/confidence.ts`, beside `fieldProvenance.ts` and following the same contract:
pure, IO-free, no mutation of arguments, same input → same output. 33 tests, 75 assertions, all passing.

This is the curve `08-architecture.md` records as *"Decay curves are Phase 2 — not built"*.

### One deliberate deviation from the Phase-3 design, and why

`03-target-architecture.md` §4 specified **three** factors:

```
confidence = base(source_weight) × corroboration(source_count) × decay(age, half_life)
```

Implemented as **two**, because the first two collapse into one principled function:

```
confidence = noisyOr(source_weight, source_count) × decay(age, half_life)
```

**Noisy-OR** is the standard combination rule for independent evidence about the same proposition: one
source of reliability `w` is wrong with probability `(1-w)`; `n` independent sources are *all* wrong with
probability `(1-w)^n`; so belief is `1-(1-w)^n`. It is also precisely the philosophy `cascade 1.md` §2.4
names for contact attestations — *"confidence grows with independent corroboration — the same Noisy-OR
philosophy the propagation engine uses"*.

Keeping a separate hand-rolled corroboration curve **on top** of it would double-count corroboration and
require a second set of magic numbers to tune. Noisy-OR needs none: the "second source is worth far more
than the tenth" property falls out of the algebra. With `w=0.85` — 1 source → 0.850, 2 → 0.978 (+0.128),
5th → +0.00007. That is the diminishing-returns shape the design asked for, derived rather than tuned.
There is a test asserting exactly that property, so it cannot silently regress.

**The honest caveat, stated in the module:** noisy-OR assumes independence. Two providers reselling the same
upstream feed are not independent and will be overstated. `corroboration_ceiling` is the blunt defence — it
caps how many sources may compound — which is why the ceiling is per-policy rather than a constant. Real
source-independence modelling is a much later problem; capping is the right amount of machinery now.

### The defensive behaviour is the point

The interesting cases are not the happy path — they are what decides whether switching decay on quietly
mangles the graph. Each has a test:

| Case | Behaviour | Why |
|---|---|---|
| `observedAt` in the future | decay clamped to 1 | Clock skew would otherwise give `2^(+x) > 1` and hand out **more** confidence than any source justified — the only way this function could inflate a score. |
| `source_count` of 0 or negative | treated as 1 | A stored row is at least one assertion; a bad backfill must not zero out a real fact. |
| No policy matches | `confidence: null` | Not a default. `("*","*")` is seeded, so this shouldn't happen; if it does, the honest answer is "no opinion" and the caller leaves the stored value alone. Inventing a default would silently rescore the whole graph off a fallback nobody chose. |
| `observedAt` unknown | decay skipped, `ageDays: null` | Unknown age is not fresh age, but penalising it would punish sources that simply don't report a timestamp. The null lets the caller surface the distinction. |
| A policy row disabled | falls through to the next precedence tier | This is what makes `is_enabled` a safe rollout switch: turning one row off must not drop the field out of scoring entirely. |
| `half_life_days` ≤ 0 | no decay | Rather than dividing by zero. |

Precedence is `(field, sourceType)` → `("*", sourceType)` → `(field, "*")` → `("*", "*")`, tested at every
tier including the disabled-row fallthrough.

### `daysUntilStale` — why the curve is worth having at all

Solves `evidence × 2^(-t/H) = threshold` for `t`, minus elapsed age. This is what turns reverification from
*"re-check everything every N days"* into *"re-check this value when it is about to stop being
trustworthy"* — the scheduler input behind S-09 and S-13. Returns null for non-decaying values and for
values already below threshold, so a caller is never told to wait a negative number of days.

### Not yet wired — deliberately

Nothing calls this yet. Per `04-validation.md`, decay ships **display-only first** (the S-10 badge), then
ranking, then reveal gating. A wrong half-life must never silently downgrade good records before it has been
watched against real telemetry, and the seeded half-lives in 0107 are calibration starting points, not
researched constants.

**Verification:** `bun test` 33 pass / 0 fail · full monorepo `typecheck` 25/25 · `biome check` clean ·
`depcruise` 0 errors.

---

## Slice 6.2a — `masterTechnologyRepository` (done)

Layer-0 data access for the catalog (0100) and the adoption edge (0101), shaped exactly like
`masterGraphRepository`: the **caller owns the transaction** (`Tx` in, always run inside `withErTx`), no
policy decisions, every write converges under concurrency.

### The one decision that needed real thought: an advisory lock, not a unique constraint

Everywhere else in this codebase, concurrent-insert convergence comes from a global UNIQUE plus
`ON CONFLICT DO NOTHING` — `primary_domain`, `email_blind_index`, `content_hash`.
`master_technology_adoptions` deliberately has **no** such unique, because its grain is one row per detection
*episode* and detected → removed → re-detected must be three rows (that sequence *is* the displacement
signal).

That leaves `recordDetection` with a genuine read-then-write race: two workers ingesting the same detection
concurrently would both find no open episode and both open one, and the company would appear to have adopted
the same technology twice. Fixed with a **transaction-scoped advisory lock** keyed on
`(company, technology, method)` — serialises exactly that triple and nothing else, released automatically at
commit or rollback, no cleanup path to forget.

The alternative — let duplicates land and collapse them on read — was **rejected**, and the reason is
recorded at the call site: the profile read is not the only consumer. The displacement sweep reads this table
too, and a spurious second episode is a spurious *"re-adopted"* signal fired at a customer.

### Other behaviour worth keeping

- **`recordDetection` extends rather than duplicates.** Repeated sightings of a live technology move
  `last_seen_at` forward on the open episode; a sighting after a removal opens a new one. `GREATEST`/`LEAST`
  mean a late-arriving OLD sighting can never make a stale detection look fresh — the whole reason valid time
  and transaction time are separate columns.
- **Alias resolution refuses to guess.** Match order is slug → cpe23 → wikidata_qid → alias, with alias last
  because an alias may legitimately be ambiguous ("Atlas" is several products). A `LIMIT 2` probe returns the
  match only when exactly one row comes back; two matches return **null** for the review queue rather than
  silently attaching a detection to the wrong product.
- **`closeDetection` returns a count, not a boolean** — per this codebase's RLS-denial discipline, a caller
  must be able to assert "changed exactly one row" rather than infer success from the absence of an error.
  Closing an already-closed episode affects zero rows and is not an error; a provider reporting a removal
  twice is normal.
- **The company read keeps `detection_method` in the grain** rather than flattening per technology, because a
  DNS record and a job-posting mention are very different claims and flattening would hide exactly the
  distinction the confidence policy is built around.

### Registry hygiene

The new repository landed as a 9th **unassigned** file in the navigation map. `REPO_DOMAIN` in
`.claude/hooks/lib/arch-map.mjs` is the registry the generator expects each phase to extend, so
`masterTechnology: "master-sync"` was added — same domain as `masterGraph`, because it is the same
system-owned graph. Back to 8 unassigned.

The other 8 are untouched and remain a separate, tracked follow-up: 4 framework-root configs (expected) and
4 pre-existing unregistered repositories (`entitlementRepository`, `outcomeMetricsRepository`,
`provenanceBadgeRepository`, `usageEventRepository`).

**Verification:** full monorepo `typecheck` 25/25 · `biome check` clean · `depcruise` **0 errors** · map
regenerated, 1989 files, unassigned back to 8.

**Not verified, and cannot be from here:** none of these queries has run against Postgres. The advisory-lock
serialisation and the extend-vs-open branch both need an itest with two concurrent transactions — that is
Phase 9, and CI is the proof.

---

## Slice 6.2b — `masterSignalsRepository` + the PII guard (done, **21 tests passing**)

`04-validation.md` Part 3 set two hard requirements before person-subject signals are populated, and said of
the first, verbatim, that it *"needs an itest, not a comment"*. This slice turns both into code.

### Requirement 1 — the payload never carries contact values

A comment cannot enforce it and a CHECK constraint cannot express it, so the rule is executable:
`assertNoContactValues` runs on **every** write path and throws. It is a **pure, exported function**
specifically so it is unit-testable without Postgres — the compliance control is proven here, and the itest
then only has to show the repository calls it.

Why this matters more than it looks: a signal store that accumulates contact values becomes a **second
cleartext PII store**, with none of `master_emails`/`master_phones`' encryption, HMAC blind-index dedup, or
suppression wiring — and nothing would notice, because it arrives one convenient payload field at a time.
`{"new_employer_email": "..."}` on a `job_change` signal is exactly the shape of that mistake.

Three detection rules, chosen to be precise rather than broad:
- **Forbidden key tokens** (`email`, `phone`, `mobile`, `tel`, `fax`, `msisdn`, `directdial`), normalized past
  casing and separators. The key alone is disqualifying — an *empty* `contact_email` field is still a schema
  heading in the wrong direction, and that is the cheap moment to catch it.
- **Email-shaped values**, loose on the local part, strict on `@domain.tld`. The goal is catching a real
  address that slipped in, not validating RFC 5322.
- **E.164-shaped values** after separator stripping — a leading `+` and 8–15 digits. Deliberately **not** a
  generic "long run of digits" test, which would reject `amount_minor: 5000000000` and get the guard switched
  off by the first engineer it blocked.

**False positives are the real risk**, so roughly half the 21 tests exist to prove the guard stays out of the
way: funding amounts in minor units, long digit strings without a `+`, evidence URLs, realistic funding and
leadership payloads, headlines naming companies, numbers/booleans/dates. Violations report a **path**
(`payload.exec.work_email`) and a reason, because a message that doesn't name the field makes the person
debugging it guess between twelve keys.

### Requirement 2 — the DSAR erasure fan-out hook

`erasePersonSignals` is a real `DELETE`, not a tombstone: per `09-compliance.md` the right to erasure **beats**
the append-only principle for personal data. It returns a **count**, matching the RLS-denial discipline
(assert "removed exactly N", never infer from the absence of an error). A dated career event naming a person
is personal data even with no contact value in it, and a brand-new table is exactly what a fan-out quietly
misses.

### A constraint deliberately not added

A unique over `(subject, type, observed_at)` *is* expressible here — `observed_at` is the partition key — but
it would be wrong: two genuinely distinct signals of the same type can share a day, and a constraint that
silently drops the second is worse than a duplicate a human can see. Idempotency stays upstream on
`source_records.content_hash`, with an `evidence_ref` pre-check covering the replay case that hash cannot
(a re-run of a derivation over an already-ingested payload).

**Verification:** `bun test` **21 pass / 0 fail** · full monorepo `typecheck` 25/25 · `biome check` clean
(one template-literal fix applied) · `depcruise` **0 errors** · map 1991 files, unassigned still 8
(`masterSignals: "master-sync"` registered).

---

## Slice 6.2c — `masterCompanyDetailRepository`, and a **bug found in slices 6.2a/6.2b**

### The bug: the new repositories would have failed with permission denied

Writing the suppression check meant checking what `leadwolf_er` can actually read. Its explicit grant in
`applyMigrations.ts` ends with the comment, verbatim:

> *"A future Layer-0 table that the resolver writes MUST be added here."*

**None of the eleven new Layer-0 tables were in it.** Both repositories shipped in 6.2a and 6.2b run under
`withErTx` and would have failed at runtime on the first query — not at review, not at typecheck, not in any
gate that runs without Postgres.

Fixed by extending the grant: `SELECT, INSERT, UPDATE` on the eleven writable tables, `SELECT` only on
`master_signal_types` and `master_confidence_policy` (staff-authored config an ingest path must never
rewrite), and **no DELETE anywhere** — the existing rule is that erasure stays on the audited
owner/`withPrivilegedTx` path.

Two consequences worth recording:
- **`erasePersonSignals` is therefore NOT a `withErTx` call**, and its docblock now says so loudly. Calling it
  as `leadwolf_er` fails, which is the *correct* outcome: erasure is an audited privileged operation, not
  something an ingest path can reach.
- The two partitioned tables are granted on the **parent**, which is what every query names, and their
  partitions inherit the same ACL automatically through `mirror_partition_acl` (0102). The security fix from
  Phase 5 pays for itself here — without it the monthly sweep would have minted partitions the resolver
  could not write.

### The suppression check is a parameter, not a join — verified, not assumed

`04-validation.md` Part 3 requires `master_company_contact_points` to join the suppression check. **It cannot
be a join from this repository.** `suppression_list` is an RLS-scoped overlay table, and `leadwolf_er` has
*"NO overlay grant (it must never touch contacts/accounts)"* and is explicitly not `BYPASSRLS`.

So it follows the pattern `masterGraphRepository` already established for the contribution gate: the check
happens caller-side where the scope is readable, and the **decision** is carried in. The parameter is
**required, not optional** — an optional `suppressed?: boolean` is a check someone forgets, and the failure
mode is a suppressed individual's address quietly re-entering the graph through the company door. Required
means the type system refuses the call until a decision exists.

Suppression returns `null` rather than throwing: a suppressed value arriving in a provider feed is a *normal*
event, and a throw would abort an otherwise-fine batch.

### `recordPersonIdentifier` returns conflicts instead of swallowing them

`uniq_master_person_identifier` is global on `(id_type, id_value)`. The obvious implementation is
`ON CONFLICT DO NOTHING` — and it would be wrong. If an identifier is already held by a *different* master
person, that is not a duplicate: it is **evidence the two golden records are the same person**, which is the
strongest merge hint entity resolution can receive. Swallowing it discards exactly the signal ER exists to
act on. So the conflict is returned as `{status: "conflict", heldByPersonId}` and the caller routes it to
review. The race between the pre-SELECT and the INSERT is re-read afterwards, so the conflict survives a
concurrent claim rather than degrading into a generic failure.

### Also

`upsertCompanyLocation` UPDATEs the HQ rather than inserting a second — two sources disagreeing about the
headquarters is a survivorship problem to resolve, and `uniq_master_company_hq` would reject the insert
anyway. `recordCompanyFunding` repeats the best-effort-dedup caveat at the code layer, because this is the
layer that would otherwise paper over it.

**Verification:** full monorepo `typecheck` 25/25 · `biome check` clean across all 199 `packages/db` files ·
`depcruise` **0 errors** · guard tests still 21/0 · map 1992 files, unassigned 8.

---

## Slice 6.3 — ER blocking, **after deleting a duplicate I had already written**

### The mistake, and how it was caught

I built blocking keys *and* a Fellegi-Sunter scorer. A name collision on `FieldComparison` at the barrel
export surfaced `packages/core/src/er/fellegiSunter.ts` — **which already existed, tested, with a calibrated
`DEFAULT_FELLEGI_SUNTER_CONFIG`**, alongside `compareRecords.ts` (comparison vectors, `DEFAULT_FIELD_WEIGHTS`)
and `stringSimilarity.ts`.

The Phase-2 audit recorded the probabilistic tier as "reserved, not implemented" — which was true **of the
schema** (`block_key` unindexed, `match_method` only ever writing `'deterministic'`). I carried that forward
into an assumption about the **code**, and never checked. The schema was reserved; the pure scoring modules
were already shipped and simply unwired.

Corrective action taken rather than papered over:
- **Deleted** the duplicate `scoreMatch` / `decideMatch` / `MatchScore` / `MatchDecision`.
- **Moved** the surviving code to `packages/core/src/er/blocking.ts`, beside its siblings, not `prospect/`.
- Its header now points at the existing scorer explicitly, so the next reader does not repeat the mistake.

What survived is genuinely missing: both sibling modules describe the candidate generator as *"a later
slice"*, and `grep` confirms no blocking existed anywhere in `packages/core`.

### Three test failures that were real design errors, not test bugs

1. **A claim in my own comment was false.** I wrote that keying on the first initial unifies
   "Bob"/"Robert" — it does not; they have different initials. The initial unifies *truncations*
   (Rob/Robert, Kate/Katherine), not *substitutions* (Bob/Robert, Bill/William). The comment was corrected
   and the limitation is now **asserted by a test**, so it is a documented property rather than a surprise.
   Closing it needs a nickname lookup table; the deterministic tier resolves most of those pairs anyway.
2. **The prior does real work.** I expected one agreeing high-discrimination field to yield >0.99. Against a
   1-in-10,000 prior it lands at ~0.49 — correctly. Two records drawn at random are overwhelmingly likely to
   be different people, and one shared field does not overturn that. A model returning 0.99 there would
   auto-merge on a single field, which is how a canonical graph gets poisoned. Now tested both ways.
3. `blockBudget(0)` returned **negative zero** — `(0 * -1) / 2` in IEEE-754. Compares equal to 0, serialises
   as `-0`, fails a structural assertion. Guarded and tested.

### Two rules the module exists to enforce (research R5)

- **A blocking rule must never use a similarity function.** Similarity must be evaluated across all candidate
  pairs before it can filter any — exactly the quadratic cost blocking exists to avoid. Every key is a
  deterministic, equality-joinable string transform, index-backed by migration 0106. `stringSimilarity.ts` is
  for comparing an already-blocked pair.
- **A record with too little to key on gets NULL, not a placeholder.** A shared "unknown" bucket is the
  quadratic bomb wearing a block's clothing.

`blockBudget` counts **comparisons, not records** — 1,000 records is ~500,000 pairs — and returns the count
so the sweep can *log* what it skipped. Silently dropping an oversized block reads as "nothing to resolve
here" when the truth is "this is where duplicates cluster", since an over-large block usually means a very
common surname.

One further correction: the diacritic strip started as a `[̀-ͯ]` range, which biome rejects
(`noMisleadingCharacterClass`) and which covers only the Latin block — silently failing to fold Vietnamese,
Devanagari or Arabic marks. Now `\p{M}`, which is both lint-clean and actually correct.

**Verification:** `bun test packages/core/src/er/` **43 pass / 0 fail** (includes the pre-existing
fellegiSunter and stringSimilarity suites) · monorepo `typecheck` 25/25 · `biome check packages/core/src`
clean · `depcruise` **0 errors**.

**Pre-existing and untouched:** `packages/db/src/seed.ts` carries two `noConsoleLog` lint errors from commit
`40846ede`. Not introduced here and not fixed here — unrelated file, separate change.

---

## Slice 6.4 — the name-blocked pass, wired into the sweep that **already existed**

I checked before building this time. `apps/workers/src/queues/erSweep.ts` is **already complete**:
leader-locked, Redis-cursor-resumed, bounded per tick, scoring with `compareRecords` + `scoreFellegiSunter`,
proposing `match_links(review_status='pending', match_method='splink')`, gated on `ER_SHADOW_ENABLED`, never
auto-merging. The tracker item "build the sweep" was wrong — derived from the schema-level audit finding
rather than the worker code, the same error as iteration 17.

What is genuinely missing is named verbatim in `erRepository.ts`'s own header:

> *"block_key is RESERVED/unpopulated and the name trgm indexes are deferred, so name/email blocking is a
> later refinement; a seed with no company yields no candidates here."*

### Why the name pass is additive, not a replacement

The two blocks find **different** duplicates and neither subsumes the other:

| | finds | misses |
|---|---|---|
| **Company block** (existing) | colleagues — the natural dedup neighbourhood, high precision | anyone company-less; anyone recorded at two companies |
| **Name block** (new, `block_key`) | company-less persons; the **same person at two companies** | people whose surname/country disagree across sources |

The second row of that table is the important one. **A person recorded at two companies is the job-change
duplicate — outcomes S-09 and S-13, the two this programme exists to serve** — and a company-keyed block can
*never* surface it, because the two rows disagree on precisely the key it blocks on. Company-less persons
were previously skipped outright (`if (!seed.currentCompanyId) return 0`), making them invisible to ER
entirely.

### What was added

- `erRepository.findCandidatesByBlockKey` — equality join on the column migration 0106 indexed.
- `erRepository.countBlockMembers` + `blockBudget` admission — an over-large block is **skipped and logged**,
  never silently dropped, because an over-large block usually means a very common surname, which is exactly
  where real duplicates cluster. A silent skip would read as "nothing to resolve here".
- `erRepository.setBlockKey` — the only write this repository makes to `master_persons`, deliberately narrow
  (one non-PII ER-internal column) and guarded on `block_key IS NULL`, so recomputing keys under a changed
  rule stays a deliberate migration rather than a side effect of maintenance.
- `ErCandidatePerson` widened with `blockKey` and `locationCountry` (an *input* to the key, not a scored
  field).
- **The backfill runs inside the existing tick**, over rows already loaded and already bounded by the tick
  budget — a separate backfill sweep would re-scan the same table to do strictly less.

`sweepSeed` now unions both candidate sets and dedupes by the existing order-independent pair key, so a
person found by both blocks is still scored once.

**Verification:** monorepo `typecheck` 25/25 · `biome check` clean · `depcruise` **0 errors** · blocking
tests 43/0. The sweep itself needs Postgres and Redis — CI is the proof, and `ER_SHADOW_ENABLED` remains the
kill switch.

---

## Slice 6.5 — the dual-write that turned out not to exist

Checking who **writes** `master_companies.technographics` before building a dual-write for it overturned
`04-validation.md` V2 and the R-1 revision that depended on it. **No code was written this slice; a wrong
plan was retired instead.**

### What is actually true

| | claimed in V2 | verified in 6.5 |
|---|---|---|
| Writers of `master_companies.technographics` | implied live | **none.** Repo-wide grep finds the schema line and nothing else. Dead column. |
| The four "readers" | read the Layer-0 jsonb | read **`accounts.technologies`** — a different column, on the Layer-1 overlay |
| Does `accounts` carry technographics? | resolved **NO** | **YES**, under a different name: `accounts.technologies` (`contacts.ts:65`), jsonb array of slugs, GIN-indexed |

The live technographic path never touches Layer 0:

```
intent_signals(tech_install) → runFirmographicRollup → accounts.technologies (jsonb[], GIN)
  → accountSearchRepository `technology` facet (jsonb array overlap) → prospect filter group
```

### Root cause, worth recording

The audit resolved *"does `accounts` carry its own technographics?"* by grepping for the literal string
`technographics`. The column is named `technologies`. **A string-match grep was treated as a semantic
answer**, and a NO that meant "this exact word does not appear" was written down as "this concept does not
exist". Every downstream conclusion inherited it.

Same failure shape as iterations 17 and 18 — assuming absence from a narrow check — and the third time in
this programme that verifying before building changed the plan.

### The corrected cutover — simpler, and pointed at the right target

There is **no dual-write to stage**, because there is no live Layer-0 writer to keep in sync. `0107` in the
ledger (formerly "dual-write adoption edge; staged reader cutover") is retired. What replaces it:

1. **Populate `master_technology_adoptions`** from licensed feeds (the buy-don't-build decision, research
   R1/cascade 2). This is the first *real* technographics store — it is not replacing a working one.
2. **Point the rollup at the edge.** The thing the adoption edge should eventually supersede is not the dead
   jsonb column but the `intent_signals(tech_install)` → `runFirmographicRollup` path, which infers
   technographics from a tenant-scoped signal table rather than reading a canonical one. That is a
   behavioural change to a shipped, working feature and is therefore **proposed, not made**.
3. **Drop `master_companies.technographics`** in a release of its own, once (1) lands. It is dead now, so
   dropping it destroys nothing — but it stays until the replacement is populated, per the
   never-drop-in-the-same-release rule.

**Nothing above is implemented.** Step 2 changes how a live filter behaves and needs a human decision;
step 3 waits on step 1.
