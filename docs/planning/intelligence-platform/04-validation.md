# Phase 4 — Validation

Validates the Phase 3 design **before** any migration is written. Every item is resolved against the code or
the strategy docs, not reasoned about. Two findings change the plan; one changes the brief's premise.

---

## Part 1 — the seven open items from `03-target-architecture.md` §8

### V1. Partition automation generalizes — ✅ **CONFIRMED, and it is free**

`packages/db/src/repositories/partitionRepository.ts` asks the catalog rather than carrying a list:

```sql
SELECT n.nspname || '.' || c.relname FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE c.relkind = 'p' AND n.nspname = 'public'
```

Its header states the intent explicitly: *"the sweep can be registered now, does nothing while no table is
partitioned, and starts maintaining each table the moment its conversion migration lands, with no second
change to remember."* It keeps `PARTITION_MONTHS_AHEAD = 3`, runs per-table (a failure on one table cannot
roll back partitions already created for others), and runs on the OWNER connection because partition
creation is DDL.

**Consequence:** migrations 0101 (`company_technology_adoptions`) and 0102 (`master_signals`) get partition
maintenance **with zero additional work**. The `ensure_month_partitions` SQL function from migration 0084
already handles one table generically. This removes an entire class of operational risk from the design.

### V2. ⛔ **THIS FINDING WAS WRONG — corrected in Phase 6.5. Read the correction before acting on it.**

> The section below claimed `master_companies.technographics` has four live readers, and revision R-1 (the
> dual-write + staged cutover) was built on it. **Both are wrong.** Verified in Phase 6.5:
>
> - **Nothing writes `master_companies.technographics`.** A repo-wide grep finds the schema line and nothing
>   else. It is a dead column.
> - **The "readers" read a different column.** The live technographic path is
>   `intent_signals(tech_install)` → `runFirmographicRollup` → **`accounts.technologies`** (a jsonb array of
>   tech slugs on the Layer-1 overlay, GIN-indexed) → the `technology` facet in `accountSearchRepository`
>   → the prospect filter group. It never touches Layer 0.
> - The audit's `[UNVERIFIED]` item — "does `accounts` carry its own technographics?" — was resolved **NO**,
>   and that was also wrong. `accounts` carries the same concept under a **different name**
>   (`accounts.technologies`, `contacts.ts:65`). The grep that resolved it searched for the literal string
>   `technographics` and so missed it.
>
> **Root cause:** a string-match grep was treated as a semantic answer. The lesson is recorded in
> `06-data-management-layer.md` §6.5.
>
> The consequence is that the migration is *simpler*, not harder: there is no dual-write to stage, because
> there is no live Layer-0 writer to keep in sync. See §6.5 for the corrected cutover.

### V2 (as originally written, now superseded)

Phase 3 assumed the jsonb column was effectively write-only. It is not. Confirmed consumers:

| Reader | Location |
|---|---|
| Account filter group in the prospect UI | `apps/web/src/features/prospect/accountFilterGroups.ts:94` |
| Account detail drawer display | `apps/web/src/features/prospect/components/AccountDetailDrawer.tsx` |
| A test asserting filter-group order includes `technographics` | `accountFilterGroups.test.ts:24` |
| Search facet `company_technographics` as `keyword[]` in the flattened person doc | `docs/planning/prospect-company-data/PLAN_05_search_and_cache.md:203,224` |

**Revision to migration 0107.** The backfill is not "read the jsonb once and move on." The sequence is:

1. 0101 lands the edge table; the adoption writer **dual-writes** — edge row *and* the jsonb column.
2. Backfill populates the edge from the jsonb (read-only against the source).
3. Readers migrate one at a time: search facet first (it is already a projection and can be rebuilt),
   then the filter group, then the drawer.
4. Only after all four readers are on the edge does a later release stop writing the jsonb.
5. The column is dropped in a release of its own, if ever.

**Also resolved — the `[UNVERIFIED]` from `02-audit.md` §6:** `accounts` does **not** carry its own
`technographics` column. A repo-wide grep for `technographics` returns `master_companies` only. The Layer-1
overlay reads the Layer-0 value; there is no second copy to reconcile. Good news for the cutover.

### V3. `company_technology_current` projection — **defer, with the trigger written**

The existing `projection_outbox` + `projectionSweep` machinery can build it whenever needed, and V2's
dual-write means the jsonb column *is* the current-state projection during the whole transition. Building a
third representation before measuring would be speculative. **Trigger:** company-profile p95 above SLO once
the drawer reads the edge directly.

### V4. `uniq_employment_stint` NULL-distinctness — ⚠ **real, and the proposed fix is wrong as written**

Postgres treats NULLs as distinct in a UNIQUE index by default, so once `master_company_id` becomes
nullable, two unresolved stints for the same person never collide. Phase 3 proposed a partial unique on
`(master_person_id, lower(company_name_raw), started_on) WHERE master_company_id IS NULL`.

**That is still not sufficient, and validation is where this gets caught.** `started_on` defaults to
`'-infinity'` as the "unknown start" sentinel — which is what makes unknown-start rows collide *by design*
in the existing index. Combined with a raw name, two genuinely different unresolved employers with the same
raw string and unknown start would now merge into one edge. The existing sentinel logic assumes the company
is known; extend it and the assumption breaks.

**Revised approach:** keep the partial unique but normalize the raw name the same way `master_companies.
name_normalized` is (legal-suffix-stripped, casefolded) rather than a bare `lower()`, and accept that
unresolved-stint dedup is **best-effort** until ER resolves the company. Record it as a known limitation
rather than pretending the index makes it exact. The alternative — no unique at all on unresolved rows —
lets a re-ingested payload mint a duplicate stint on every run, which is worse.

**Phase 9 must include an itest for exactly this**, and per the RLS-denial memory note, it asserts row
counts, not thrown errors.

### V5. Compliance review-gate block — produced below (Part 3). One new conflict raised (C8).

### V6. Notification-on-first-storage (research R8) — ✅ **answered by the strategy doc: planned, not built**

`docs/strategy/09-compliance.md` states: *"Notice obligations (e.g., GDPR Art. 14-style) planned per
beachhead jurisdiction with counsel — batched notice workflows if required."*

So it is a **known, tracked gap**, not an oversight. Nothing in this program's scope creates the obligation
where it did not exist — but Group C (`master_signals`) does add a new class of person-referencing record,
which is why it appears in the Part 3 block below.

### V7. CD-1 — ❌ **verified, and the finding is bigger than "two front doors"**

`apps/api/src/features/ingest/routes.ts` does **not** delegate to `landEnvelope`. What it actually does:

- validates the body against the `ingestionEnvelope` Zod schema from `@leadwolf/types`;
- **re-pins the scope to the verified token** and 403s a body `scope.tenantId` that disagrees — a genuine
  trust-boundary control, correctly implemented;
- throttles `chrome_extension` by record volume via `checkCaptureRate`, before connector validation;
- looks up the connector, calls `validateEnvelope` and `toRawObservations`;
- **returns `202 {accepted: true}` — and persists nothing.**

The route says so plainly in its own comments: *"v1 acks with the accepted count. The per-connector async
processing (evidence -> resolve -> enrich -> land) is a later slice."*

**The finding is the client-side half.** `apps/extension/src/background/queue/scheduler.ts:22-24` removes
the queue item on a successful response and records a `capture_result` outcome. So a capture that reaches
this endpoint is **acknowledged, deleted from the client's durable buffer, and never stored anywhere**. The
API is honest about being a stub; the extension treats the stub's 202 as durable acceptance. Neither side is
individually wrong — the contract between them is.

Note also **two different envelope types**: `ingestionEnvelope` (`@leadwolf/types`, used by `apps/api`) vs.
`IngestionEnvelopeV2` (`@leadwolf/types`, used by `landEnvelope`). Contract divergence is already real, not
hypothetical.

**This raises CD-1 from a tidiness argument to a correctness fix**, and it should land *before* the new
entity families add more contribution surface. Revised CD-1: `apps/api` `/api/v1/ingest` delegates to
`forge-core`'s `landEnvelope` after connector validation, inheriting server-authoritative hashing, sizing,
tenant-prefixed object keys, and post-commit enqueue. Until it does, either the extension's capture flag
stays off, or the client must not delete on 202.

---

## Part 2 — the design validated against the brief's six criteria

### Scalability
Partition **count** is the ceiling (PostgreSQL manual, R7), not row count. Two new monthly-partitioned
tables add 24 partitions/year against a documented comfort zone of "a few thousand". `partitionRepository`
handles them automatically (V1). **Pass**, with the written revisit trigger: adoption edge > 1.5B rows, or
p95 on `idx_adoption_technology` above SLO for two consecutive weeks.

### Performance
Risk concentrates in one query: "current technologies for this company", which is a per-company scan across
partitions on an episode-grained table. Mitigations in order of cost: (1) the jsonb column remains the
current-state answer during transition (V2), (2) `idx_adoption_company` covers the point read, (3) the
`company_technology_current` projection if measurement demands it (V3). **Pass, with measurement gates** —
no new datastore is authorized by any of these paths.

### Data quality
Confidence = source weight × corroboration × decay, with all three inputs already stored. Decay ships
display-only first. The probabilistic ER tier is bounded by capped block sizes. **Pass.**

### Maintainability
The design adds no new architectural concept — new tables in existing patterns, new parsers in an existing
registry, new `entity_type` values in a column deliberately built without an FK. It adds **no** new
deployable process, queue topology, or datastore. **Pass.**

### Security
The single highest risk in the whole program is migration **0108**: every new Layer-0 table must be
`REVOKE`d from `leadwolf_app` and given an `rls/*.sql` file mirroring `rls/masterGraph.sql`. A new
system-owned table inheriting a blanket grant is cross-tenant exposure. Per the RLS-denial note, the
isolation itest must assert **"affected zero rows"**, not "threw" — INSERT raises under `WITH CHECK`, but
UPDATE/DELETE with no policy silently affect nothing. **Conditional pass — gated on 0108 and its itests.**

### Cost
No new infrastructure. The real cost line is **buying technographic and signal data**, not storing it —
consistent with research R1/R3 and cascade 2's buy-don't-build recommendation. Provider spend runs through
the existing `provider_calls` cost ledger and `provider_configs` budget breaker. **Pass.**

### Extensibility
`signal_types` as a lookup table means new signal families cost a row, not a migration (fixes D6). `kind`
on `master_technologies` means products and services cost a value, not a table. `provenance_event.
entity_type` has no FK by design. **Pass.**

---

## Part 3 — compliance review-gate block (required by `09-compliance.md` §Review gates)

Every PR touching personal data must state five things. Stated here for the whole design, to be repeated
per-PR:

| Table | Data elements | Lawful-basis tag | Consent surface | Suppression enforcement | Erasure propagation |
|---|---|---|---|---|---|
| `master_technologies`, categories, aliases, vendors, features | **None personal** — company/product facts | inherited from `source_records.lawful_basis_snapshot` | n/a | n/a | n/a |
| `company_technology_adoptions` | **None personal** — company↔technology | as above | n/a | n/a | n/a |
| `master_company_locations`, `master_company_funding` | **None personal** — company facts | as above | n/a | n/a | n/a |
| `master_company_contact_points` | Generic mailboxes / switchboard. **Nominally company data, but `firstname.lastname@` or a routed `info@` can be personal data in practice** | `lawful_basis` on the provenance event | n/a | **Must join the suppression check** — same blind-index path as `master_emails` | value row deleted + tombstone provenance event |
| `master_person_identifiers` | Personal — public profile handles | `lawful_basis` on the provenance event | existing contributor consent | via `master_persons.is_suppressed` | `ON DELETE CASCADE` from `master_persons`, matching the channel tables |
| `master_signals` (`subject_type='person'`, e.g. `leadership_change`) | **Personal** — references a person and a dated career event | `lawful_basis` required per row | existing | subject-level via `is_suppressed` | **must be included in the DSAR fan-out** — a signal naming a person is personal data even though `payload` holds no contact value |

**Three binding requirements this produces, which Phase 5 must not skip:**

1. `master_company_contact_points` inherits the **normalized-value suppression check**, not just a uniqueness
   constraint. A `generic_email` that is really one person's mailbox must be suppressible.
2. `master_signals` joins the **DSAR erasure fan-out** in `packages/forge-core/src/dsar.ts` and
   `apps/workers/src/queues/dsar.ts`. Erasure is a tombstone provenance event → graph reprocess (per
   09-compliance), with a ≤72h SLA (A-02). A person-subject signal left behind after erasure is a compliance
   failure, and it is exactly the kind of thing a new table quietly misses.
3. `master_signals.payload` carries **no contact values, ever** — same rule as `provenance_event.payload`,
   and it needs an itest, not a comment.

---

## Part 4 — new conflict C8: the brief wants personal contact data; the strategy forbids it

`docs/strategy/09-compliance.md` hard rule 3, verbatim:

> **Business-contact data only: work emails, work phones, role, company. No sensitive categories, ever;
> personal addresses out of scope.**

`cascade 1.md` §2.4 is explicit in the other direction — it asks for *"multiple professional **and personal**
emails"* and personal phones, with `email_type: professional | personal | unknown` as a column, and the
brief carries that requirement forward.

These cannot both hold. Per rule 6, this is surfaced, not silently reinterpreted.

**What is *not* in conflict, and is already built:** multiple emails and multiple phones per person, typed,
independently verified, with per-value provenance. `master_emails` / `master_phones` support any number of
values with a global blind index each. The disputed part is exclusively the **personal/private** category —
a person's private Gmail or personal mobile.

**Recommendation: keep hard rule 3.** It is not merely policy caution. It is what makes the lawful-basis
story defensible (legitimate interest for business contact is a far stronger position than for a private
mobile), it is what keeps outcome A-01 achievable, and it aligns with the market position research R8
identified — that the live objection against Apollo is *how specific individuals' data got in*, not missing
paperwork.

**Consequence if you accept the recommendation:** no schema change is needed at all — the existing channel
tables already do everything the brief asks except carry a `personal` type, and adding that type is the
whole decision. If you instead want personal contact data, that is a **counsel decision recorded in
`decisions.md`**, not a migration, and it changes the compliance surface materially.

**No implementation in either direction until this is decided.** It does not block any other Group.

---

## Part 5 — revisions to the Phase 3 design

| # | Revision | Cause |
|---|---|---|
| R-1 | Migration 0107 becomes a **dual-write + staged reader cutover**, not a one-shot backfill; jsonb column stays authoritative until all four readers migrate | V2 |
| R-2 | Unresolved-stint unique uses the **`name_normalized` normalization**, and best-effort dedup is recorded as a known limitation rather than claimed as exact | V4 |
| R-3 | **CD-1 promoted from cleanup to a correctness fix, sequenced first.** Until `/api/v1/ingest` persists, the extension must not delete queue items on 202 | V7 |
| R-4 | `master_signals` explicitly joins the DSAR fan-out; `master_company_contact_points` explicitly joins the suppression check | Part 3 |
| R-5 | `company_technology_current` projection **deferred** behind a measurement trigger | V3 |
| R-6 | Personal-email/phone typing **blocked** pending the C8 decision; everything else in Groups A–E proceeds | Part 4 |

---

## Part 6 — verdict

The Phase 3 design **passes validation** on scalability, performance, quality, maintainability,
extensibility and cost, and passes on security **conditional on migration 0108 and its isolation itests**.

Six revisions apply. One item (C8) needs a human decision and blocks nothing else. One item (V7) is a
correctness bug found during validation that should be fixed before the new contribution surface grows —
which is precisely what a validation phase is for.

**Ready to proceed to Phase 5 (implementation) for Groups A, B, C, D, E**, in the migration order
0100 → 0108, with CD-1's fix sequenced ahead of any new contribution path.
