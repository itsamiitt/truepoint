# Phase 4 — Projection Options: How a Revealed Golden Value Becomes a Per-Tenant, Per-Owner Thing

> **Gate: BRAINSTORM.** Phase 4 of the prospect↔company data initiative. The RESEARCH gate fixed the *access-path
> boundary* — Layer 0 stays system-owned (no `workspace_id`, no RLS, no `leadwolf_app` grant), reachable by exactly
> two customer paths: **masked search** and **paid reveal** (`RESEARCH_04 §7`, rules 1–6). This gate takes that as
> settled and brainstorms the one thing the access path leaves open: **once a reveal crosses the wall, *how* and
> *where* does the revealed golden value live for the workspace, and what is joined-vs-read at the masked-browse and
> the detail-read seam?** It generates four distinct materialization approaches, names each one's strongest argument
> and the failure that kills it, stress-tests them against the hardest cases (RLS across the seam; owner/visibility on
> the *shared* company; reveal/credit/suppression at both layers; billions×workspaces copy fan-out; staleness-if-copy
> vs cost-if-hydrate), explicitly challenges the obvious overlay-reference default, and ends with a single DECISION
> + open questions. **It does not write the plan.** **Depends on:** `RESEARCH_04_tenancy_projection.md` (the boundary
> this builds inside — §2.3 Cognism, §3.1 Snowflake, §3.2 grant-off, §3.4 facet leakage, §4.2 reveal gate, §5
> two-stage, §7 rules); the shared ground-truth (the field-level provenance gap Phase 3 owns; the import-path
> MATCH-AGAINST invariant). **Ground truth:** ADR-0021, ADR-0007, ADR-0022, ADR-0035; `03-database-design.md`
> §5.1/§5.2/§9/§12; `packages/db/src/schema/contacts.ts`, `packages/db/src/rls/contacts.sql`,
> `packages/db/src/client.ts`. External claims carry the RESEARCH_04 `[VERIFIED]`/`[INFERRED]` provenance by
> reference; this gate adds no new external research.

---

## 0. What this gate decides — and what it must not reopen

RESEARCH_04 already decided the **wall** (where the universe is isolated). It did **not** decide the
**materialization** (what shape the *thing the workspace keeps* takes once a reveal copies a value across that wall).
That is this gate's whole job, and it is a genuinely open design space because three later concerns all land on it:

- **Phase 3 — field-level provenance.** The shared ground-truth marks per-field `source`/`confidence`/`timestamp` as
  *"UNDESIGNED ANYWHERE (true gap to invent)"*: today `contacts` carries a flat `email_enc`/`email_status`/
  `last_verified_at` with **no per-field provenance** (`03-database-design.md:520-546`). Whatever shape the revealed
  value takes *is the surface Phase 3 has to hang provenance on* — so the materialization choice pre-constrains Phase 3.
- **The Cognism re-projection model** (`RESEARCH_04 §2.3` **[VERIFIED]**): a reveal is a *point-in-time* copy kept for
  the contract; a Layer-0 job change is a *signal* + an optional billable **re-reveal**, never a silent rewrite. The
  materialization must make "point-in-time, re-charge on change" expressible.
- **Survivorship** (ADR-0015): user-entered/revealed values are **not** silently superseded by a later provider/golden
  value — human correction outranks the graph.

**Fixed by RESEARCH_04 — not reopened here:** Layer 0 has no `workspace_id`/RLS/`leadwolf_app` grant
(`03-database-design.md:698`; `rls/contacts.sql:17-44`); the universe is reached only by masked search + paid reveal;
billing/ownership is per-workspace first-reveal-wins (ADR-0007:15-17); owner/team/list visibility is an app-layer
filter layered on RLS, re-checked at read (ADR-0022:40-45; `03-database-design.md:696`); the masked surface is
capped + small-cell-suppressed; cross-workspace reads are privileged + audited (`client.ts:30-35,95-111`). Every
option below is constrained to live *inside* rule 2 ("masked search + paid reveal"); none may grant `leadwolf_app`
a read on `master_*` unless it explicitly accepts that it is breaking the wall (only Option C does — and that is its
killer).

The five cross-cutting constraints carried from the shared ground-truth and `RESEARCH_04 §1`: **C1** Layer-0 has no
RLS (isolation is access-path); **C2** owner visibility ≠ RLS (app-layer); **C3** shared identity, per-workspace
billing; **C4** PII never leaves the index; **C5** billions of rows / millions of users (no N+1, no unbounded fan-out).

---

## 1. The axis being brainstormed

```
  SYSTEM-OWNED LAYER 0 (no RLS, no leadwolf_app grant)        WORKSPACE LAYER 1 (FORCE RLS on workspace_id)
  ───────────────────────────────────────────────────        ───────────────────────────────────────────────
  master_persons ─ master_employment ─ master_companies       contacts (master_person_id ptr, curation, owner,
  master_emails(email_enc) / master_phones(phone_enc)          visibility) · accounts (master_company_id ptr)
        │   golden value, ONE physical copy, always-live              ▲
        │                                                             │  the workspace READS here
        └──── paid reveal (decrypt 1 channel in-tx) ────────► ??? ────┘
                                                              ▲
                       THE OPEN QUESTION ────────────────────┘
              where does the revealed value physically land, and what does a read join/hydrate?
```

Every option answers three sub-questions; the differences between options reduce to these answers:

| | **Q1** Where does the revealed PII value physically live? | **Q2** What does the overlay `contacts` row store? | **Q3** At masked-browse & detail-read, what is hydrated from Layer 0 vs read locally? |
|---|---|---|---|
| **A** copy-into-overlay | In the `contacts` columns (`email_enc`…) | A pointer **and** a value copy | Browse: Layer-0 candidates. Read: pure RLS overlay read, **never** touches Layer 0 |
| **B** materialized projection | In a denormalized per-workspace snapshot table | A pointer; values live in the projection table | Read: from the per-workspace projection (continuously CDC-refreshed from Layer 0) |
| **C** view-time hydration | **Only** in Layer 0 (`master_emails`) | **Only** a pointer (`master_person_id`) | Read: hydrate live from `master_emails` per-read, entitlement-checked |
| **D** scoped reveal-ledger | In a shared **RLS-scoped** channel table keyed by `(workspace, master_person, channel)` | A pointer + workspace-private curation | Read: JOIN the workspace's own RLS channel rows, **never** touches Layer 0 |

---

## 2. The four options

### Option A — Overlay-references-master + reveal-time COPY into the overlay columns (the ADR-0021 default)

**Schema / flow.** This is exactly what ADR-0021 describes (`:48-51,84`) and what the as-built overlay is one FK away
from. `contacts.master_person_id` (`03-database-design.md:518`) points at the golden person; the reveal transaction
(reveal-service role) checks the credit pool `FOR UPDATE` with `CHECK (reveal_credit_balance >= 0)`
(ADR-0007:40; `03-database-design.md:686,713`), enforces idempotency on the unique `contact_reveals
(workspace_id, contact_id, reveal_type)` (`03-database-design.md:560,714`), gates suppression at **both** layers
(`master_persons.is_suppressed`, `03-database-design.md:421`, **and** `suppression_list` scope global|tenant|workspace,
`:687`), decrypts `master_emails.email_enc` (`:441`) in-tx, and **copies** the cleartext-then-re-encrypted value into
`contacts.email_enc`/`email_status`/`last_verified_at` (`:520-544`). The `AFTER INSERT ON contact_reveals` trigger
sets `is_revealed`/`revealed_by_user_id`/`revealed_at` first-reveal-wins (`:705`). Post-reveal the overlay row is
**self-sufficient**: it carries the value.

**Strongest argument: the read never crosses the seam.** A is the *only* option (with D) where, after the reveal, every
customer read is a pure `withTenantTx` → FORCE-RLS overlay read (`rls/contacts.sql:28-33`; `client.ts:48-68`) that
touches **no** `master_*` table — so the access-path wall is crossed exactly once, in the audited reveal tx, and never
again on the hot read path. Staleness is *correct by design*: the copy is the Cognism "point-in-time value kept for
the contract" (`RESEARCH_04 §2.3`) and it satisfies survivorship (a user edit to the overlay copy is never silently
overwritten by a later golden value — ADR-0015). DSAR already models the copy: each overlay copy is tombstoned
independently by the blind-index fan-out (`list-plan/02-data-model.md §5.2`). It is the lowest-surprise, lowest-new-code
option — the schema is already shaped for it.

**Killer failure mode: it has nowhere to put Phase-3 provenance, and the copy is flat.** A copies the value onto *flat
contact columns* that carry one `email_status` + one `last_verified_at` for the whole row — there is **no per-field
`source`/`confidence`/`timestamp`** (`03-database-design.md:520-546`), which is precisely the gap the ground-truth says
Phase 3 must invent. Proceeding with naive A forces Phase 3 to either explode `contacts` into
`email_source`/`email_confidence`/`email_updated_at`/`phone_source`/… column-per-field-per-channel, or bolt on a side
table — and the moment you bolt on a side table you have built Option D. So A's "lowest new code" virtue is partly an
illusion: it defers the provenance cost to Phase 3 and makes it worse. Secondary: re-projection on job change needs a
re-reveal write path that overwrites the flat columns, which fights survivorship (which field won? the row has no
per-field as-of to arbitrate).

### Option B — Materialized per-workspace projection tables (denormalized person+company snapshot)

**Schema / flow.** A `workspace_prospect_projection` table (or a per-workspace materialized view) that **flattens**
`master_persons` + `master_employment` + `master_companies` (`03-database-design.md:409-436`) into one denormalized row
per `(workspace_id, master_person_id)` the workspace has saved/revealed — the "denormalize person+company so one query
answers 'person at company with these traits'" shape (shared ground-truth SEARCH note; `03-database-design.md:730`).
FORCE-RLS on `workspace_id`. The **search-sync/CDC worker** (`03-database-design.md:751-753`) refreshes each
workspace's rows whenever the underlying master entity changes (Aurora logical-replication CDC fan-out, the same
pipeline that feeds OpenSearch/ClickHouse).

**Strongest argument: rich workspace-local faceting with zero read-time Layer-0 join.** B makes the per-workspace
overlay search surface (the retained Typesense surface, ADR-0021:76) *durable in Postgres*: a workspace can filter and
facet its own revealed/saved universe (seniority × employee-band × tech-stack) entirely RLS-locally, no hydration, no
Layer-0 touch — the fastest possible "person at company with these company traits" read for the records a workspace
cares about.

**Killer failure mode: it is a second source of truth, continuously fanned out — exactly what ADR-0035 forbids.** B
duplicates *golden field values* into an RLS table and then must keep N per-workspace copies in sync via CDC, which is
the precise anti-pattern ADR-0035 (amending ADR-0002) rules out: *"Postgres stores truth; the index is the query
surface — NEVER two independent sources."* B creates a second *authoritative-looking* store of master values inside the
RLS wall, with its own drift, its own reconciliation, its own consistency window — and unlike the search index (which
is openly eventually-consistent and re-checked at read, `RESEARCH_04 §5`), B's rows *look like* curated overlay truth.
Worse for the wall: a CDC-refreshed denormalized projection of master fields, sitting in an RLS table for records the
workspace **never paid to reveal**, is a *free copy of the universe by projection* — scraping by materialization,
defeating the metered reveal (`RESEARCH_04 §2.1` view-cap lesson). And the storage/write fan-out is the worst of the
four (full firmographic snapshot × every touched record × continuous refresh) — the billions×workspaces explosion is
*real* here, not hypothetical (H4 below).

### Option C — Pure view-time hydration (join master into the overlay at read, no copy)

**Schema / flow.** The overlay `contacts` row stores **only** `master_person_id` (`03-database-design.md:518`) plus
workspace-private state (notes, lists, `owner_user_id`, `visibility`, `:540-543`) — **no** PII value columns. The
reveal writes **only an entitlement row** (`contact_reveals` is already exactly this event log, `:559-560`), not a
value copy. At detail read, the API hydrates the channel by reading `master_emails`/`master_phones` for the
`master_person_id` (`:438-459`), gated by an entitlement check ("does a `contact_reveals` row exist for
`(workspace, master_person, channel)`?").

**Strongest argument: one source of truth, zero copy, automatic freshness.** C is the cleanest *data* model: the golden
value lives **once** in Layer 0; every workspace always reads the freshest verified value; per-field provenance lives
once on `master_emails` (`source_count`, `last_verified_at`, `verification_source`, `:446-447`) and is never smeared or
duplicated; storage is minimal; a job change propagates with no re-projection machinery. If the access-path wall did
not exist, C would win on elegance.

**Killer failure mode: it detonates the access-path wall (C1) — and breaks billing + survivorship as collateral.** C
requires every *customer* detail read to read `master_emails`, so `leadwolf_app` must hold a **grant on the
system-owned graph** — which `RESEARCH_04 §3.2` and rule 1 forbid in the strongest terms (*"grant-off is the actual
wall … a direct grant turns the access-path wall into a single forgotten `WHERE` clause away from a full-universe
leak"*). Hydration at read also makes every read **cross the Layer-0/Layer-1 seam** at billions scale — an RLS-less
hot path, N+1 across the Citus shard boundary (`03-database-design.md:745`), the opposite of the bounded-read posture
C5 demands. And the very liveness that makes C "clean" *breaks the product semantics*: it silently changes the value
under a paying customer with no re-charge (violating the Cognism point-in-time/re-charge model, `RESEARCH_04 §2.3`)
and makes survivorship impossible (a user-edited overlay value cannot override a live golden read — there is no overlay
value to hold). C is the option whose greatest strength is exactly the thing the boundary exists to prevent.

### Option D — Scoped reveal-ledger as the materialization (entitlement-on-the-verb; copy into a shared RLS channel table)

**Schema / flow.** Promote `contact_reveals` from an *event log* into the *value store*. A
`revealed_channels (id, tenant_id, workspace_id, master_person_id, contact_id, channel ∈ {email,phone}, value_enc,
as_of, source, confidence, status, revealed_at)` table — **one physical table**, FORCE-RLS on `workspace_id` (the same
posture as `contacts`, `rls/contacts.sql:28-33`), written by the **reveal-service role** in the reveal tx: decrypt the
master channel **once**, re-encrypt and write the workspace's **own** scoped row, carrying its **as-of snapshot +
per-field provenance baked into the row** (`source`/`confidence`/`status`/`as_of`). The overlay `contacts` row keeps
only `master_person_id` + workspace-private curation; at read, the workspace JOINs its own `revealed_channels` rows
(RLS-scoped, bounded by `contact_id`/`master_person_id`, **never** Layer 0). This is the `contact_reveals` schema
(`03-database-design.md:559-560`, already monthly-partitioned, `:735-736`) one step elevated to carry the value.

**Distinct from A/B/C** (not a variation): vs **A**, the copy lands in a purpose-built, provenance-carrying *scoped
channel* table, not smeared onto flat contact columns; vs **B**, it stores **only revealed channels** (append-on-reveal,
credit-gated), with **no** denormalized firmographic snapshot and **no** continuous CDC refresh — it is not a second
source of truth, it is a per-workspace ledger of *what this workspace paid to materialize*; vs **C**, it **is** a copy,
so the read never crosses the seam.

**Strongest argument: it satisfies the boundary, Phase-3 provenance, and the Cognism model simultaneously.** Read never
crosses the seam (like A — RLS-local, no `master_*` grant). Per-field provenance/as-of lives **natively on the channel
row** — the Phase-3 gap is pre-answered without exploding `contacts` (each channel carries its own `source`/`confidence`/
`status`/`as_of`). Job-change re-projection is a **new `revealed_channels` row** (clean point-in-time history + a clean
re-charge hook, the Cognism `RESEARCH_04 §2.3` model, and the Snowflake "entitlement on the verb, not the row" shape,
`§3.1`). DSAR is clean: fan out by `email_blind_index` → master identity → delete this workspace's channel rows by
`master_person_id` (one key, all scoped copies). Survivorship is expressible: the overlay can hold a user-edited value
that outranks any revealed channel, with the channel's `as_of` arbitrating freshness.

**Killer failure mode: more moving parts than A, and it does NOT solve storage.** D splits the overlay into "curation
row + channel value rows," so every read that needs a revealed value is a JOIN — *bounded and RLS-local* (not a
Layer-0 hydrate), so survivable, but it is a second writer on the overlay side and more surface than A. Critically, D
still **duplicates PII per workspace** — the same copy fan-out as A (it improves provenance + re-projection *semantics*,
it does **not** reduce storage). If `revealed_channels` is mis-scoped, it is the same leak surface as any RLS table —
the wall is the same FORCE-RLS predicate, no better, no worse than `contacts`.

---

## 3. Stress test against the hard cases

| Hard case | **A** copy-into-overlay | **B** materialized projection | **C** view-time hydrate | **D** scoped reveal-ledger |
|---|---|---|---|---|
| **H1** RLS across the seam (read) | ✅ read is pure RLS, no seam crossing | ⚠️ read RLS-local but CDC writer crosses seam continuously | ❌ every read crosses seam; needs `leadwolf_app` grant on `master_*` | ✅ read is pure RLS, no seam crossing |
| **H2** owner/visibility on the *shared* company | ✅ owner on overlay `accounts`, master company ownerless | ⚠️ projection may leak ownerless master fields as if owned | ⚠️ hydrate exposes shared edge live; owner still on overlay | ✅ owner on overlay; channel rows carry no firmographics |
| **H3** reveal/credit/suppression at both layers | ✅ gate in reveal tx; DSAR tombstones copy | ⚠️ must also suppress every projected copy on the fly | ◐ live suppression "for free" — but only because it broke the wall | ✅ gate in reveal tx; DSAR deletes channel rows by master id |
| **H4** billions×workspaces fan-out + storage | ◐ bounded by **paid reveals**, not by universe | ❌ bounded by **saved/projected** set → genuine explosion | ✅ zero copy | ◐ bounded by **paid reveals**, same as A |
| **H5** staleness-if-copy vs cost-if-hydrate | ✅ stale = the *desired* point-in-time semantics | ❌ stale **and** a second source of truth | ❌ always-fresh **but** breaks billing + survivorship + wall | ✅ stale = desired; `as_of` makes re-projection explicit |

The three sharpest, in prose:

**H2 — can owner-scoping even apply to the company? (the subtle one the task flags.)** No — and this disqualifies the
intuition that ownership lives on "the company." Ownership/visibility are **Layer-1 overlay** properties:
`accounts.owner_user_id`/`visibility` and `contacts.owner_user_id`/`visibility` (`03-database-design.md:503-506,540-543`;
ADR-0022:40-45). The **golden** `master_companies` row is *shared and ownerless* — it has no `owner_user_id` column by
design (`:390-406`), because every workspace is equally entitled to find it (masked) and reveal it (for a credit)
(`RESEARCH_04 §3.1`, entitlement-on-the-verb). Two workspaces revealing the same `master_company` each mint their own
overlay `accounts` row with their own owner/visibility; the shared golden company carries none. The same holds for the
**prospect↔company edge**: `master_employment` (`:428-436`) is a shared, ownerless fact ("Alice works at Acme") — *who
in a workspace owns the relationship* is expressed only by the overlay's own `contacts.account_id` link
(`:517`) + the contact's `owner_user_id`, never on `master_employment`. **Consequence for the options:** B and C are
the dangerous ones here — B's denormalized projection and C's live hydration both surface *shared, ownerless master
fields* into a workspace read, and a careless implementation can present them as if they were owned/curated overlay
data, blurring the wall. A and D keep the clean split: the overlay row (owned, visibility-scoped) points at the shared
ownerless golden entity; the revealed *value* is the only thing copied, and it lands in an owned/RLS-scoped place.

**H3 — reveal/credit/suppression at both layers.** Credit is per-workspace and *option-independent*: all four charge
the tenant pool `FOR UPDATE` per `(workspace, contact, reveal_type)` (ADR-0007:15-17; `03-database-design.md:686`).
Suppression is the discriminator. For the **copy** options (A/B/D), a *post-reveal* global suppression
(`master_persons.is_suppressed`, `:421`, or a new `suppression_list` row, `:687`) must still *reach the already-made
copy* — which is exactly the audited DSAR fan-out the existing model performs: tombstone the overlay copy + null PII +
global suppression row blocks re-import (`list-plan/02-data-model.md §5.2`). D makes this *cleaner* than A: delete
`revealed_channels` by `master_person_id` and the value is gone from every scoped copy in one keyed fan-out, while the
curation row survives as a referential anchor. **C** appears to "win" — a newly-suppressed person *instantly*
disappears from every workspace because there is no copy to chase — but that apparent win is just the wall-break
restated: the only reason C gets live suppression for free is that it reads the live golden record on every customer
read, which is the C1 violation. So H3 is a trap: the "better" suppression story belongs to the option that is
disqualified for *having* that liveness.

**H4 — is "billions × workspaces" real?** Mostly a red herring for A and D, and decisive against B. A/D copy **only
what a workspace paid to reveal**; reveals are credit-gated, so the total copy count = total paid reveals across all
workspaces, **bounded by credit spend, not by `|universe| × |workspaces|`** (the ZoomInfo export-is-metered model,
`RESEARCH_04 §2.1`). A customer that reveals 50k contacts stores 50k channel copies — not a slice of billions. **B**
is the opposite: its projection is bounded by the *saved/searched/faceted* set, which a workspace can grow to the
whole result universe **without paying a reveal credit** — so B genuinely risks billions×workspaces of continuously
CDC-refreshed denormalized rows, and it does so *for free*, defeating the meter. C stores nothing. Net: H4 kills B,
does not meaningfully distinguish A from D, and favors C only on the axis where C is already disqualified.

**H5 — staleness vs cost, the crux that inverts the naive intuition.** The naive read is "copying is wasteful and goes
stale; hydrating is clean and always fresh." For *this* product that is backwards. Staleness of a revealed copy is the
**product-correct** behavior: ADR-0007 sells a point-in-time reveal, Cognism confirms the industry keeps the copy for
the contract and *re-charges on job change* (`RESEARCH_04 §2.3`), and survivorship (ADR-0015) *requires* a held copy so
a user edit can outrank a later golden value. "Always fresh" (C) is therefore not a benefit but a **liability**: it
deprives the product of the snapshot it bills against and the held value survivorship needs. So the cost of copying
(staleness + storage) buys exactly the semantics the product wants, and the benefit of hydrating (freshness) costs
exactly the semantics the product needs. D sharpens this further than A: the explicit `as_of` on each channel row makes
the point-in-time contract a first-class column and the re-projection-on-change a new row rather than an overwrite.

---

## 4. Challenging the obvious default (A)

A is the ADR-0021 default and it is *directionally right* — the boundary posture (copy into an RLS table, read never
crosses the seam) is the correct one, and the H1–H5 matrix vindicates it over B and C on every axis that matters. But
the default deserves a harder look on one seam, because "it's the ADR default and the schema already fits" is not a
reason to ship its *weakest* form:

1. **A's copy is flat and provenance-blind.** A lands the value on `contacts.email_enc`/`email_status`/`last_verified_at`
   (`03-database-design.md:520-544`) — one status, one timestamp, no `source`/`confidence` per field. The ground-truth
   names per-field provenance as the *undesigned gap Phase 3 must invent*. So naive A doesn't avoid the provenance
   problem; it **defers and worsens** it: Phase 3 must either widen `contacts` into a column-per-field-per-channel
   explosion or add a side table — and the side table *is* Option D. The choice "A or D" is really "where does Phase-3
   provenance live: smeared on the contact, or native on a channel row."
2. **A's re-projection overwrites; D's appends.** On a job change, A must overwrite the flat columns (losing history and
   fighting survivorship — which field is authoritative when the row has no per-field `as_of`?). D writes a new
   `revealed_channels` row with a new `as_of`, giving point-in-time history and a clean re-charge hook for free (the
   Cognism model becomes a row, not a mutation).
3. **A and D are the *same boundary posture*.** Both copy into a FORCE-RLS table; both keep the read off Layer 0; both
   have identical credit/suppression/DSAR semantics and identical (paid-reveal-bounded) storage fan-out. D is not a
   different wall — it is A with the copy moved to a place where Phase-3 provenance and Cognism re-projection are native
   rather than retrofitted. The honest framing is therefore **not "A vs D" as rival architectures, but "ship A's
   posture in its flat form, or in its provenance-carrying form."**

The challenge does **not** rehabilitate B or C: B's second-source-of-truth (H5, ADR-0035) and free-projection scraping
(H4) are disqualifying; C's wall-break (H1/C1) and billing/survivorship breakage (H5) are disqualifying. The live
question the default leaves open is narrower and entirely *inside* A's posture: **flat copy on the contact, or
provenance-carrying copy in a scoped channel store.**

---

## 5. DSAR / deletion & implementation-status notes

**DSAR cascade (all copy options).** Erasure stays the audited platform fan-out keyed on `email_blind_index`
(`master_emails.email_blind_index`, `03-database-design.md:442`; `client.ts:30-35` `withPrivilegedTx`): find the one
master identity, tombstone every overlay `contacts` copy + null PII, insert a `global`-scope `suppression_list` row to
block re-import (`:687`), and — under D — delete this subject's `revealed_channels` rows by `master_person_id` in the
same fan-out (cleaner than A's per-column null, since the value lives in deletable rows, not row columns). C has *no
copy to erase* but must instead guarantee suppression is enforced at every hydrate — which only works because C reads
live, i.e. it re-states C's wall-break. The "golden identity is the unit of deletion" guarantee (ADR-0021 Mitigation,
`:129`) holds for all four; D makes the overlay-side erasure a row delete rather than a column scrub.

**Implementation status (none of this is built).** Per `RESEARCH_00`/`RESEARCH_04 §6`: Layer 0 (`master_*`,
`source_records`, `match_links`) does **not** exist in code; the masked OpenSearch index, the reveal-into-overlay
service, and the least-privilege `master_*` roles are **planned, unbuilt**; the overlay `master_person_id`/
`master_company_id` FKs are **planned** (`03-database-design.md:518,495` is the target DDL, not the as-built
`contacts.ts`); the `owner_user_id`/`visibility`/`teams` columns are **unbuilt** (only `owner_user_id` analog exists
today). What *does* exist and is one step from D: `contact_reveals` as an event log (`03-database-design.md:559-560`,
already monthly-partitioned, `:735-736`) and the FORCE-RLS overlay posture (`rls/contacts.sql:17-44`). This is the
*target* materialization decision; the gap is work for the PLAN gate — **never** license to weaken the FORCE-RLS
overlay, the two-tenant isolation itest gate, or the no-`leadwolf_app`-grant-on-`master_*` rule to make the copy easier
(security has final say — CLAUDE.md precedence).

---

## 6. DECISION

**Proceed with the COPY-ON-REVEAL posture (A/D family) — reject continuous projection (B) and view-time hydration (C)
— and within it, materialize the revealed value into a provenance-carrying, RLS-scoped channel store (Option D's
shape) rather than smeared onto flat `contacts` columns (naive A).** Stated as one direction for the PLAN:

> **"Scoped copy-on-reveal, read never crosses the seam."** The reveal transaction copies a *point-in-time*,
> *per-field-provenanced*, *as-of-stamped* channel value across the access-path wall **once**, into a FORCE-RLS,
> workspace-scoped store; every subsequent customer read is RLS-local and never touches `master_*`; the overlay
> `contacts` row holds the `master_person_id` pointer + workspace-private curation; a Layer-0 change is a signal + an
> optional billable re-reveal (a new channel row), never a silent rewrite.

Why this and not the alternatives:

- **Reject C (hydrate).** It is the only option that requires granting `leadwolf_app` a read on the system-owned graph
  — the explicit headline rejection of `RESEARCH_04` (rule 1, §3.2) — and it breaks the point-in-time billing model
  and survivorship as collateral (H1, H5). Its single virtue (freshness) is a product *liability* here.
- **Reject B (continuous projection).** It creates a second source of truth inside the RLS wall (ADR-0035: never two
  independent sources), enables free scraping-by-projection of un-revealed records (H4, defeating the meter), and has
  the worst storage/write fan-out of the four (H4 — the only option where billions×workspaces is real).
- **Adopt A's posture, lean to D's shape.** A and D are the *same* wall (copy into FORCE-RLS, read off Layer 0, identical
  credit/suppression/DSAR, identical paid-reveal-bounded storage). D differs only in *where* the copy lands — and that
  difference pre-answers Phase 3's per-field provenance gap and gives the Cognism re-projection-on-job-change a clean
  append-a-row semantics instead of A's lossy column overwrite (§4).

This satisfies all five constraints: **C1** (read stays RLS, no `master_*` grant — unlike C); **C2** (owner/visibility
stay overlay-side app-layer filters atop RLS, never on the shared ownerless golden entity — H2); **C3** (identity single
in Layer 0, billing per-workspace on the channel copy); **C4** (PII decrypts only in the reveal tx, never indexed);
**C5** (copy bounded by paid reveals, reads bounded + RLS-local, no continuous fan-out — unlike B, no seam-crossing
hot path — unlike C).

### Open questions handed to the PLAN (not decided here)

1. **A's columns vs D's channel table — the one micro-decision left inside the chosen posture.** Does the revealed value
   land on `contacts` (widened for Phase-3 provenance) or in a dedicated `revealed_channels` store? This gate recommends
   D's shape; the PLAN must settle the exact table (or column set), its FORCE-RLS policy, its partitioning (extend the
   `contact_reveals` monthly partition, `03-database-design.md:735`?), and its relationship to the existing
   `contact_reveals` event log (does `revealed_channels` *replace*, *extend*, or *sit beside* it?). **Hard dependency on
   Phase 3** (field-level provenance) — coordinate the boundary.
2. **The reveal-service role + transaction shape.** Exact least-privilege grants for the role that decrypts `master_*`
   and writes the scoped copy in one tx; how the credit `FOR UPDATE`, the both-layer suppression check, the idempotency
   unique, and the copy-write compose atomically (extends ADR-0007:40). Owned jointly with truepoint-security.
3. **Re-projection & re-charge semantics.** On a job-change signal, is the re-reveal a *new* `revealed_channels` row
   (re-charge, Cognism `§2.3`) or a free in-window refresh? Overlaps Phase-3 U3 reconciliation and ADR-0013
   (charge-for-verified-data) — the PLAN must name the trigger, the window, and the billing rule.
4. **Survivorship arbitration on the copy.** When the overlay holds a user-edited value *and* a revealed channel value
   *and* a newer re-revealed channel, which wins at read, and how does `as_of` + a `user_overridden` flag express
   "human correction outranks provider guess" (ADR-0015)? A read-time precedence rule the PLAN must specify.
5. **Owner/visibility re-check at read on the channel store.** Does the FORCE-RLS workspace predicate suffice for
   `revealed_channels`, or does it also need the app-layer owner/team/list re-check that `contacts` gets (ADR-0022:40-45;
   `03-database-design.md:696`)? Likely yes (a channel row is as sensitive as the contact) — confirm in the PLAN.
6. **Masked-browse facet hydration vs the channel copy.** The masked Layer-0 search returns candidates with facets only
   (`RESEARCH_04 §4.1`); confirm that the *overlay* list/detail surfaces read the channel copy (not Layer 0) and that
   no browse path accidentally hydrates an un-revealed value — the seam the PLAN's read paths must hold.
