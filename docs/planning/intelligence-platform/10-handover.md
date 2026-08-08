# Phase 10 — Handover

What this programme built, what it decided, what it got wrong, and what a human must decide before the next
slice. Written to be read by someone who was not here.

**Standing caveat, stated once and true of everything below:** this host has no Docker and no
`ITEST_DATABASE_URL`. **Eight migrations, six repositories and three integration tests have never executed
against Postgres.** Every "green" in this document means typecheck + biome + dependency-cruiser + unit tests.
CI is the proof, and it has not run.

---

## 1. The correction that reframed the programme

The brief asked for a redesign of the database architecture. **TruePoint is not a greenfield**, and the
single most useful thing this programme produced was establishing that early:

A canonical Layer-0 master graph, an append-only evidence log, a field-grain provenance log, an
encrypted-channel model with HMAC blind indexes, a contributor pipeline with consent/quarantine/review, DSAR
+ suppression, and a reveal/credit ledger **already existed and shipped**. Several are stronger than what the
cascade reference documents propose. The work was therefore *extension and completion*, not redesign.

That reframing held for 27 iterations and was repeatedly re-confirmed the hard way — see §5.

---

## 2. What was built

### Schema (migrations 0100–0107, all additive; nothing dropped, nothing destroyed)

| Migration | Contents | Note |
|---|---|---|
| 0100 | Technology catalog — 5 tables | Generated |
| 0101 | `master_technology_adoptions`, `PARTITION BY RANGE (observed_at)` | Hand-authored. Grain is one row per detection **episode**, so no unique on (company, technology, method) |
| 0102 | `mirror_partition_acl()` + wiring into `ensure_month_partitions` | **Security fix** — partition ACLs do not inherit from the parent, so every new monthly partition was silently readable |
| 0103 | `master_signal_types` (lookup, not a CHECK enum) + partitioned `master_signals` | 13 seeded types; **no `intent` family** (X-04) |
| 0104 | Company/person completeness tables + `linkedin_public_id` backfill | Generated + hand-appended `ON CONFLICT DO NOTHING` |
| 0105 | `master_employment.master_company_id` → nullable, + raw/normalized employer name | The **only** existing-column change. CHECK added `NOT VALID` then `VALIDATE CONSTRAINT` to avoid an ACCESS EXCLUSIVE full scan |
| 0106 | Block-key indexes, `CREATE INDEX CONCURRENTLY` | With a `DO` block dropping invalid leftovers first |
| 0107 | `master_confidence_policy` + 26-row seed | **Feeds nothing — see conflict C9** |

### Code

- **Repositories** — `masterTechnologyRepository` (episode-grain detection with an advisory lock),
  `masterSignalsRepository` (PII guard on every write, runs as a pure exported function),
  `masterCompanyDetailRepository` (required `SuppressionVerdict` on contact-point writes),
  `jobChangeSweepRepository` (the owner-conn census + tenant read split).
- **Core** — `er/blocking.ts` (`foldToken` via `\p{M}`, `blockBudget`), `prospect/confidence.ts`
  (**unwired — C9**), `data-health/runJobChangeSweep.ts`.
- **Workers** — `erSweep.ts` gained a name-blocked second pass + `block_key` backfill;
  `jobChangeSweep.ts` is new and dark.
- **Grants** — `applyMigrations.ts` REVOKEs all 13 new Layer-0 tables from `leadwolf_app`, extends the
  `leadwolf_er` grant to cover them, and mirrors partition ACLs after the blanket GRANT.

### Tests

`intelligencePlatformIsolation.itest.ts` (13 tables × 4 verbs denied to `leadwolf_app`, partitions asserted
**by name** from `pg_inherits`), `intelligencePlatformRepositories.itest.ts` (episode grain, advisory lock
proven as a primitive with `lock_timeout` → `55P03`), `jobChangeSweep.itest.ts` (watermark bounds the census;
the owner-conn read is workspace-scoped where RLS is not the wall).

### The one user-visible capability shipped

**Slice 7.1 — the S-13 job-change fan-out sweep**, dark behind `JOB_CHANGE_SWEEP_ENABLED`. The detection
stack (`detectJobChange`, `recordJobChange`, `successor.ts`) had shipped long before and **nothing called
it**; S-13 measures time-to-learn-about-a-job-change, and that time was unbounded. This slice is the trigger.

---

## 3. What a human must decide (nothing below was resolved unilaterally — rule 6)

| # | Decision | Recommendation | Blocks |
|---|---|---|---|
| **C4 / RD-7** | enthec/webappanalyzer is **GPL-3.0**, confirmed from the repo. TruePoint ships a distributed Chrome extension. | Use the field *shape* (not copyrightable); seed data from licensed/public sources | The technology catalog, and therefore the Technology + Product profiles entirely |
| **C7** | Model products as a specialization of the technology catalog | Yes — no established B2B product-intelligence pattern exists; a vendor's product and an adopter's technology are one object seen from two ends | The Product profile's shape |
| **C8** | `09-compliance.md` rule 3 forbids personal contact data; `cascade 1.md` §2.4 requires it | **Keep rule 3.** The cascade doc is a reference, not a mandate | What the Prospect profile's contact section may show |
| **C9** | **Two field-confidence implementations.** Shipped `packages/types/src/confidence.ts` (method prior × decay × capped corroboration) feeds `badgeV1` → app, extension, exports, and is composed by the tested `detectJobChange`. This programme's `packages/core/src/prospect/confidence.ts` (noisy-OR over `master_confidence_policy`) feeds **nothing**. | Keep the shipped leaf-package function; let `master_confidence_policy` **supply its constants** rather than fork the math. Do not touch the shipped path without sign-off. | Real cleanup; migration 0107's whole purpose |
| **C10** | `SignalType` ships five values strategy forbids populating | Comment, don't delete (**the comment half is now applied** — `packages/types/src/intel.ts`) | Nothing; latent trap closed |
| **C6** | Skills/education on the person profile serve no listed outcome | Flag, don't build, unless they serve S-04/S-09/S-13 targeting | Person-profile scope |

**C9 is the one with a cost of delay.** Two implementations of "how much do we believe this field" will
disagree, and `badgeV1.ts` states the stake in its own header: *"a badge that disagrees with itself across
surfaces is worse than no badge, because the user cannot tell which one is lying."*

---

## 4. Where the programme stopped, and why

Phase 8 (the four profile UIs) is **blocked on data, not on UI**. Three of the four requested profiles read
tables this programme created, granted, indexed and tested but **never populated** —
`master_technology_adoptions` and `master_signals` hold no rows and have no producer. Building them now ships
pages whose every section renders an empty state, which teaches users the feature is broken rather than
unpopulated.

The same audit found `intent_signals` has exactly one producer (the sweep above) and, before it, none — so
`computeScore`'s intent component and `firmographics.ts`'s tech/funding rollups have been reading an empty
table the whole time. **Populators are the high-value next work**, and C4/RD-7 gates the technology half.

---

## 5. How this programme was wrong, six times, in one way

Every significant error had the same shape: **concluding something was absent from a narrow check.**

1. Duplicated `er/fellegiSunter.ts` — it already existed, tested.
2. Planned an ER sweep that was already built.
3. Grepped `technographics`; the column is `accounts.technologies`.
4. Missed that `leadwolf_er` needed grants on 11 new tables — the comment said so; I had not read it.
5. **Declared the S-10 confidence badge unbuilt and wrote a whole design doc on the gap.** Case-sensitive
   greps for `dataHealth|provenance|confidence` returned zero. The code is `DataHealthCell`,
   `ContactDataHealth`, `features/data-health/`. Case-insensitive: **58 files**, including a whole shipped
   feature area with its own route.
6. Duplicated field-confidence scoring — conflict C9 above.

**The rule that would have caught all six**, now in the tracker's standing constraints:

> Search case-insensitively, and try the concept's several plausible spellings — camelCase, kebab-case, the
> type name, the directory name — before concluding anything is absent. Prefer a directory listing to a
> content grep when asking whether a *feature* exists. **A grep locates; only a read establishes meaning.**
> Absence of a string is not absence of a capability.

Iterations 23–24 are left in the tracker with the wrong finding struck rather than deleted, because the
retraction is more useful to the next reader than a clean record would be.

---

## 6. Reading order for someone picking this up

1. `00-progress.md` — the tracker: phase board, 27 iterations, conflicts C1–C10, standing constraints.
2. `02-audit.md` — what already existed. **Read before proposing anything.**
3. `01-research.md` — R1–R10 with citations, and the ones marked `[COULD NOT VERIFY]`.
4. `03-target-architecture.md` + `03a-contribution-architecture.md` — the design and the write-ownership matrix.
5. `07-integration-and-producers.md` — the producer audit and slice 7.1, in the brief's seven-statement form.
6. `08-profile-ux.md` — **read the retraction banner first.**
7. `04-validation.md`, `05-migration-plan.md`, `06-data-management-layer.md` — validation, ledger, the
   central layer.

---

## 7. The honest summary

The programme delivered: a Layer-0 intelligence schema that is isolated, granted, indexed and partitioned
correctly; a security fix for partition ACLs that was a real hole; the ER blocking tier; and one working
user-visible capability (S-13 job-change detection, dark). It produced ten documents and surfaced six
decisions rather than silently making them.

It did not deliver: populated tables, the four profile UIs, or a resolution to C9. It could not — three of
those need a licensed data feed and a human decision, and the fourth needs a human to choose between two
defensible confidence models.

The most valuable single artifact is probably §5 above.
