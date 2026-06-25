# Phase 4 — Multi-Tenant & Per-Owner Projection: How a Shared Canonical Graph Becomes Per-Tenant, Per-Owner Views

> **Gate: RESEARCH.** Phase 4 of the prospect↔company data initiative — the **projection boundary**: how the
> system-owned Layer-0 master graph (ADR-0021) is exposed to a per-workspace, per-owner audience *without* ever
> being directly readable, under a tenancy model whose default isolation is Postgres RLS. This doc studies the
> data-vendor projection pattern (shared global dataset + per-tenant working copy; masked search + paid reveal;
> entitlement gating), the canonical shared-single-copy infra patterns (Snowflake secure data sharing, Postgres
> RLS shared-vs-global tables, search security-trimming), and the literature on aggregate/facet leakage, then maps
> each onto TruePoint's constraints and recommends a projection boundary. **Depends on:** `RESEARCH_00_current_state.md`
> (the frozen as-built baseline — FORCE-RLS overlay, the Layer-0 tension flagged at §6/P1/P8), `RESEARCH_02_linking_patterns.md`
> §3 (the edge's access-path isolation — the masked-search→reveal→copy path), and `RESEARCH_01_entity_modeling.md`
> (the golden-record shape being projected). **Ground truth:** ADR-0021, ADR-0022, ADR-0007; `03-database-design.md`
> §5.1/§5.2/§9/§12; `packages/db/src/client.ts`, `packages/db/src/rls/contacts.sql`. This gate **researches and
> documents only** — no brainstorm, no plan, no code/schema is written or modified. External claims are marked
> **[VERIFIED — url]** (a source states it) vs **[INFERRED]** (reasoned from public behaviour, not documented).

---

## 0. Scope & method

The question Phase 4 answers is narrow and load-bearing: **TruePoint runs one shared canonical asset (Layer 0,
system-owned, NOT workspace-RLS-scoped) under a product whose every other table is `ENABLE`+`FORCE ROW LEVEL
SECURITY` keyed on `workspace_id` (`rls/contacts.sql:17-44`).** These two postures are in direct tension: the
default isolation mechanism (an RLS predicate `workspace_id = current_setting('app.current_workspace_id')`) is
exactly what the shared graph must *not* have, because a `workspace_id` on a golden record would re-fragment the
universe that ADR-0021 exists to unify (`ADR-0021:81-84`; `RESEARCH_02 §4`). So isolation at Layer 0 cannot be an
RLS predicate — it must be an **access path**: a workspace reaches the universe only through **masked search**
and **paid reveal**, never a direct table read (`ADR-0021:129`; `03-database-design.md:376-377,698`).

This research does three things: (1) establishes how real data vendors project a shared graph into per-customer
views and gate the reveal (§2); (2) establishes the canonical infra patterns for "one physical copy, many
restricted projections" and what each teaches TruePoint (§3); (3) decomposes TruePoint's four projection
mechanisms — masked search, paid reveal/entitlement, owner-scoped visibility, list sharing — against the
constraints, surfaces the leakage hazards (§4–§5), and recommends a boundary (§7). It does **not** redesign the
edge (Phase 2), the golden record (Phase 1), or per-field provenance (Phase 3); those are cited as the *things
being projected*, not re-opened.

Vendor *internal* projection mechanics are almost never published; observable surface behaviour (what costs a
credit, what a view shows, what export is capped) is. Structural claims about a competitor's storage are
**[INFERRED]** unless a doc states them. The infra patterns (Snowflake, Postgres RLS, Azure Search) **are**
documented and are cited verbatim.

---

## 1. The projection problem, stated precisely

```
   ONE shared physical asset                          MANY restricted projections
   ─────────────────────────                          ───────────────────────────
   Layer 0  (system-owned, NO workspace RLS)          per-workspace, per-owner views
   master_persons ─ master_employment ─ master_companies
   master_emails / master_phones  (PII, encrypted)         │
   source_records / match_links   (lineage)                │  projected by ACCESS PATH, never table read:
        │                                                  │
        │  (1) MASKED SEARCH  ──────────────────────────►  facet/identity surface (no PII leaves index)
        │  (2) PAID REVEAL    ──────────────────────────►  copies ONE channel into the caller's overlay
        ▼                                                  ▼
   isolation = access path + least-privilege role     Layer 1 overlay (FORCE RLS on workspace_id)
   (ER pipeline / search-sync / reveal service only)  contacts/accounts + owner_user_id/visibility/lists
```

The projection has to satisfy five non-negotiables simultaneously (the shared ground-truth cross-cutting
constraints):

| # | Constraint | Where it bites in projection |
|---|---|---|
| C1 | **Workspace isolation is RLS, and Layer 0 has none** | The shared graph cannot carry `workspace_id`; isolation must move to the *access path*, not a row predicate |
| C2 | **Per-owner visibility is an app-layer filter, not RLS** (`ADR-0022:40-45`) | Owner/team scoping projects *inside* a workspace, layered on the RLS wall — and on the masked index too |
| C3 | **Canonical identity is shared** (the same human is one `master_persons`) | A reveal must charge per-workspace (ADR-0007) while the identity stays single — billing ≠ identity |
| C4 | **PII never leaves the index** (`03-database-design.md:383-384,698`) | The masked projection must expose enough to *find* a person but not the email/phone — that only the paid reveal decrypts |
| C5 | **Scale: billions of rows, millions of users** | The projection is the hottest read path; it must be candidate-narrowed + bounded (cursor), never a scan, and must not leak via facet counts at billions |

Everything below is in service of: **what is the smallest, safest set of access paths that lets a workspace find
and selectively materialize golden records, while the raw graph stays unreadable and the billing/ownership story
stays per-workspace?**

---

## 2. The data-vendor projection pattern (external, observable)

Every B2B data vendor runs structurally what ADR-0021 describes: **one large shared contact graph, projected to
each customer as a searchable-but-masked surface, with a credit-gated "reveal/export" that turns a masked record
into the customer's own working copy.** The surface behaviour is consistent enough to be a design reference.

### 2.1 ZoomInfo — a *view* is throttled, a *credit* is the export/reveal moment

ZoomInfo draws the cleanest verified line between **browsing the shared graph** and **taking a copy out of it**:

- **A "view" does not cost a credit** and is separately rate-limited: *"Since a view cannot be used to export or
  enrich data, it does not use a credit … each license gets the ability to view 2,000 profiles per user per
  month regardless of edition"* **[VERIFIED — https://help.zoominfo.com/s/article/Overview-of-Credits]**. The
  browse surface is *capped*, not free-for-all — the anti-scrape control sits on the *view*, before any reveal.
- **A credit is consumed on export/enrich:** *"credit usage occurs only when a user exports a contact or company
  profile from the platform to a CSV file or an application … For each exported record, one credit is charged"*
  **[VERIFIED — same]**. Export = the materialize-into-your-CRM moment = TruePoint's reveal-copies-into-overlay.
- **Bulk credits are pooled at the org level**, used for enrich/export via API/Workflows/Data Services
  **[VERIFIED — same]** — the org pool is ADR-0007's tenant-level `reveal_credit_balance`.
- **License terms forbid re-incorporating the shared data into your own product or reselling it**, and ZoomInfo
  *"may use technological means to place reasonable use limits to prohibit excessive use, including excessive
  downloads or screen views … such as sharing with third parties or attempting to circumvent limitations to
  purchased credits"* **[VERIFIED — https://www.zoominfo.com/legal/ltc]**. The contract + rate limiting *is* the
  isolation that keeps a customer from reconstructing the raw graph by exhaustively viewing/exporting it.

**Mapping:** ZoomInfo's *view* ↔ TruePoint **masked search** (gate with per-user/-workspace caps + rate limits);
ZoomInfo's *export credit* ↔ TruePoint **paid reveal** (`contact_reveals`, `ADR-0007`); ZoomInfo's *bulk credits*
↔ the tenant pool + per-team budgets (`ADR-0022` `team_credit_budgets`). The decisive lesson: **the throttle
belongs on the browse surface, not only on the reveal** — otherwise a customer scrapes the masked graph for free
and never pays a credit (C5 misuse). [INFERRED that ZoomInfo's internal store is a shared graph with per-customer
"my exported records" overlays — their contributor network and single deduped DB strongly imply it, but no doc
states the storage shape.]

### 2.2 Apollo — "net-new" reveal charges; an already-saved record is free to re-export

Apollo gates on **net-new**: *"When you export net-new contacts, Apollo charges credits to save the contacts and
give you access to verified contact emails … exporting saved contacts to a CSV doesn't require Apollo credits"*
and *"revealing an email costs 1 credit"*
**[VERIFIED — https://knowledge.apollo.io/hc/en-us/articles/4409237712141-Export-Contacts-to-a-CSV;
https://knowledge.apollo.io/hc/en-us/articles/9527776320781-What-Are-Credits]**. Admins set per-user credit
limits inside the org **[VERIFIED — same]** — the per-seat/per-team budget cap (ADR-0022). "Net-new vs already
saved" **is** TruePoint's *first-reveal-wins per workspace* (`ADR-0007`: the first `contact_reveals` row for a
`(workspace_id, contact_id)` sets ownership; re-revealing the same workspace copy is free).

### 2.3 Cognism — reveal-once, reuse for the contract, **re-charge only on job change**

Cognism states the per-tenant working-copy lifecycle most explicitly: *"one credit is used each time a contact
record is revealed. Once a contact has been redeemed, your team can continue using that record throughout the
contract. A credit is only used again if that contact changes jobs"*
**[VERIFIED — https://www.cognism.com/cognism-vs-lusha]**. This is the single most important external data point
for Phase 4's projection semantics, because it answers the reconciliation question RESEARCH_02 flagged (U3):

- A reveal produces a **durable per-tenant copy** that the customer keeps for the contract term — the overlay
  snapshot, decoupled from the still-evolving shared record.
- The shared graph keeps changing underneath (the person changes jobs). That change does **not** silently rewrite
  the customer's copy; instead it becomes a **billable re-projection event** ("a credit is only used again if
  that contact changes jobs"). The job-change *signal* (RESEARCH_02 §3, the ZoomInfo Tracker / Sales-Nav model)
  is the trigger; re-reveal is the action.

**Mapping:** this validates ADR-0021's "reveal copies a point-in-time value into the overlay" (`:48-51,84`) and
the RESEARCH_02 §3 conclusion that a Layer-0 job change surfaces as a *signal*, never an overlay overwrite — and
adds the billing dimension: the re-projection after a job change is the natural place a credit is (re-)charged.

### 2.4 Lusha — per-seat credit allocation; email vs phone asymmetry

Lusha allocates credits **per seat**: *"you select how many users you want, and Lusha automatically assigns a set
number of credits per user … Each time you reveal or export a contact, a credit is deducted,"* with **1 credit
per email and 10 per phone** **[VERIFIED — https://www.cognism.com/blog/lusha-pricing;
https://www.enrich.so/blog/lusha-pricing-breakdown]**. The email/phone asymmetry is TruePoint's `reveal_type`
pricing (`contact_reveals.reveal_type ∈ email|phone|full_profile`, `03-database-design.md:560`; ADR-0007 reveal
pricing varies by type). Per-seat allocation maps onto ADR-0022's per-team budgets carved from the tenant pool.

### 2.5 The cross-vendor projection pattern

| Vendor | Browse surface (masked) | Reveal/export gate | Re-use semantics | Org/seat budget |
|---|---|---|---|---|
| ZoomInfo | "view" detail page, **2,000/user/mo cap**, no credit **[V]** | export to CSV/CRM = 1 credit/record **[V]** | exported record kept; bulk credits org-pooled **[V]** | admin per-user limits **[V]** |
| Apollo | search masked results **[V]** | net-new reveal/export = 1 credit/email **[V]** | saved record re-export free **[V]** | admin per-user credit limits **[V]** |
| Cognism | search masked **[V]** | reveal record = 1 credit **[V]** | **kept for contract; re-charge on job change** **[V]** | licence-based allowance **[V]** |
| Lusha | search masked **[V]** | reveal/export = 1 email / 10 phone **[V]** | per-reveal **[V]** | **per-seat credit allocation** **[V]** |

**The convergent pattern: search/browse the shared graph in a masked form that is rate-/quota-capped; spend a
credit to materialize a specific record into your own durable working copy; charge again only when you take a
*new* record or the shared record materially changes (job change).** No vendor lets a customer read the raw
graph; all of them gate both the *browse* (caps/rate limits) and the *take* (credits). TruePoint's ADR-0021
two-layer model is exactly this pattern with the addition of an explicit RLS overlay and a system-owned golden
store — which the vendors achieve by contract + rate limiting rather than a published RLS mechanism. **TruePoint's
differentiator is that the projection boundary is enforced in the database and access path, not only in the EULA.**

---

## 3. Canonical infra patterns for "one copy, many restricted projections"

Three documented infrastructure patterns solve "single physical dataset, per-consumer restricted view." Each maps
onto a piece of the TruePoint boundary, and — importantly — each comes with a caveat TruePoint must respect.

### 3.1 Snowflake Secure Data Sharing + Row Access Policies + entitlements table

Snowflake is the reference implementation of *zero-copy* shared data with per-consumer restriction: one provider
dataset, many consumers, **no data duplication**, access filtered at query time by policy.

- **Row access policies (RAP)** filter which rows a consumer sees; **masking policies** restrict columns. A
  consumer accesses policy-protected shared data via a **shared database role**: *"A data sharing provider can
  share a database role to enable a data sharing consumer to access policy protected data"*
  **[VERIFIED — https://docs.snowflake.com/en/user-guide/data-sharing-policy-protected-data]**.
- The policy is **data-driven via an entitlements/mapping table**: *"The entitlements table serves as the base for
  the data-driven RAPs … An entitlements table specifies which Snowflake users or roles have access to specific
  tenants,"* and the multi-tenant trick is *"using Snowflake's `CURRENT_ACCOUNT()` function, combined with dynamic
  row access policies to create a self-managing multi-tenant architecture"*
  **[VERIFIED — https://www.snowflake.com/en/blog/data-vault-row-access-policies-multi-tenancy/;
  https://medium.com/snowflake/strategies-for-multi-tenant-data-sharing-in-snowflake-41d880011807]**.

**What it teaches TruePoint:** the *policy-driven projection* idea is sound, but Snowflake's RAP is still a
**row predicate** — the very thing C1 forbids at Layer 0 (no `workspace_id` on the golden record). TruePoint
cannot put a per-workspace RAP on `master_persons`, because there is no per-workspace ownership of a golden
record — *every* workspace is entitled to *find* *every* person (masked) and entitled to *reveal* any (for a
credit). So the Snowflake analogue applies **not to the golden table but to the projection surfaces**: the
masked search index and the reveal service are the "shared database role" through which the universe is reached,
and the *entitlements* are not "which rows" but "which **operations** (search vs reveal) at what **rate/budget**."
The entitlement is on the **verb**, not the **row**. This is the precise reason Layer 0 is system-owned-by-access-path
rather than RLS-scoped (`03-database-design.md:698`).

### 3.2 Postgres RLS: tenant-scoped tables get policies; **global tables deliberately get none**

The standard Postgres multi-tenant guidance explicitly carves out shared tables: *"Tenant-scoped tables must have
a `tenant_id` column and will get RLS policies, while global/shared tables have no `tenant_id` and RLS is
typically disabled or used only for special cases"*
**[VERIFIED — https://www.techbuddies.io/2026/01/01/how-to-implement-postgresql-row-level-security-for-multi-tenant-saas/;
https://www.postgresql.org/docs/current/ddl-rowsecurity.html]**. `SET LOCAL` (transaction-scoped GUC) is the
pooling-safe mechanism so a previous tenant's context never leaks across a pooled connection — exactly TruePoint's
`withTenantTx` (`SET LOCAL ROLE leadwolf_app` + `set_config(..., true)`, `client.ts:56-65`)
**[VERIFIED — same; AWS RLS blog https://aws.amazon.com/blogs/database/multi-tenant-data-isolation-with-postgresql-row-level-security/]**.

**What it teaches TruePoint:** the community pattern *already endorses* "global/shared tables have no `tenant_id`
and no RLS." TruePoint's Layer 0 is precisely this sanctioned case — but TruePoint hardens it beyond "RLS
disabled" into "**reachable only by least-privilege service roles**." Where the generic pattern says global tables
are read by everyone in-process, TruePoint says the `master_*` tables are touched **only by the ER pipeline,
search-sync, and the reveal service under their own least-privilege roles** (`03-database-design.md:698`), and the
customer-facing `leadwolf_app` role has **no grant** on them at all. The privileged escape hatches (`withPrivilegedTx`
→ `leadwolf_admin` BYPASSRLS for the audited DSAR fan-out; `withPlatformTx` → audited cross-tenant staff reads,
`client.ts:30-35,95-111`) are the only paths that cross workspaces, and both are audited. **So the projection
boundary is "no `workspace_id`, no RLS, no `leadwolf_app` grant" — RLS-off is necessary but not sufficient;
grant-off is the actual wall.**

### 3.3 Search security-trimming: filter at query time, but the index filter is **not** the authorization boundary

Azure AI Search documents the "search returns candidates, scoped by identity" pattern precisely. A security field
(e.g. `group_ids`) is stored `filterable:true, retrievable:false` and the query trims with
`group_ids/any(g:search.in(g, 'group_id1, group_id2'))`
**[VERIFIED — https://learn.microsoft.com/en-us/azure/search/search-security-trimming-for-azure-search]**. Two
verified cautions are load-bearing for TruePoint:

1. **The index filter is a *simulation* of authorization, not authorization.** *"There's no authentication or
   authorization through the security principal. The principal is just a string, used in a filter expression, to
   include or exclude a document."* **[VERIFIED — same]** — i.e. the search filter narrows candidates; it does
   **not** prove the caller may open a result. Truth lives elsewhere and must be re-checked.
2. **Pre-trim (filter inside the query) beats post-trim (filter results after) because post-trim leaks.**
   *"Pre-trimming is recommended for performance and general correctness; pre-trimming prevents information
   leakage for refiner data and hit count instances"*
   **[VERIFIED — https://learn.microsoft.com/en-us/sharepoint/dev/general-development/custom-security-trimming-for-search-in-sharepoint-server]**.
   Hit counts and *facet/refiner aggregates* leak membership if you filter only the returned page but compute
   counts over the unfiltered set.

**What it teaches TruePoint:** this is the verified backbone of the shared ground-truth principle *"search returns
candidate IDs fast; what the user may open is governed by tenant scope + ownership/sharing at read; permissions
are RE-CHECKED against truth at read"* (`ADR-0035`; shared ground-truth SEARCH note). The masked OpenSearch index
(`03-database-design.md:748`) returns candidate `master_person_id`s; what the workspace may *reveal/open* is
re-checked at read against Postgres truth (tenant scope, suppression `is_suppressed`, ownership). And the facet
caution feeds directly into §4.1 below.

### 3.4 Aggregate/facet leakage — masked search is not automatically safe

The masked search surface exposes *facet counts* (employee band, industry, seniority, "has_email") for the
billions-row universe (`03-database-design.md:399,418-419,730`; ClickHouse facet counts, ADR-0035). The privacy
literature is blunt that aggregates can leak membership even with mitigations: *"membership inference is a trivial
task when applied to raw aggregates … aggregation is not an effective privacy mechanism in itself,"* and
mitigations like **small-count suppression** and differential privacy reduce but do not eliminate leakage
**[VERIFIED — https://arxiv.org/html/2406.18671v1;
https://inventivehq.com/blog/database-inference-aggregation-attacks-guide]**. The classic attack: narrow a masked
search to a near-unique combination of facets (company + title + city + "has_phone") and read the *count* and the
*masked identity* to confirm a specific person exists, without spending a reveal credit.

**What it teaches TruePoint:** at billions of rows most facet cells are large and safe, but **narrow filter
combinations can yield small cells that confirm/deny an individual's presence** — a membership-inference channel
that the per-record reveal credit does not gate (because no reveal happened). The masked projection therefore
needs **small-cell suppression / minimum-bucket thresholds** on facet counts and on result hit-counts, plus the
view caps + rate limits from §2.1, as part of the projection design. [INFERRED that the major vendors apply
download/view caps partly for this reason; their EULAs forbid "excessive screen views," §2.1, which is consistent
with throttling membership-probing but is not stated as a privacy control.]

---

## 4. TruePoint's four projection mechanisms, decomposed

The boundary is built from four mechanisms. Two project Layer 0 → workspace (across the system-owned wall); two
project workspace → owner (inside the RLS wall). Keeping them distinct is the whole design.

### 4.1 Masked search projection (Layer 0 → workspace; the *browse* surface)

**What it is.** The global masked index (OpenSearch, sharded inverted index + `search_after` cursor;
`03-database-design.md:748`; ADR-0021/0035) flattens person+company into lean docs so one query answers "person
at company with these traits" (the §2.5 vendor browse surface). **No PII leaves the index** — `master_emails`/
`master_phones` are never indexed, only `has_email`/`has_phone` boolean facets (`03-database-design.md:383-384,418-419`).

**What it exposes vs withholds:**

| Exposed in masked search | Withheld (reveal-only) |
|---|---|
| Identity facets: name (for matching), title, seniority, dept, company, employee band, industry, location, `has_email`/`has_phone` | The actual email / phone (`master_emails.email_enc`, `master_phones.phone_enc`) |
| Candidate `master_person_id` (opaque to the client) | The raw `source_records` evidence / `match_links` lineage |
| Facet *counts* (subject to small-cell suppression, §3.4) | Anything that lets the row be reconstructed without a credit |

**Isolation mechanism:** *not* an RLS predicate (Layer 0 has none, C1) — instead **access path + rate/quota caps**.
The index is served by the search-sync/search service, not `leadwolf_app` reads of `master_*`. Suppressed
identities (`master_persons.is_suppressed = true`, the global objection mirror, `03-database-design.md:421`) are
excluded from the projection so a DSAR'd / opted-out person is not even *findable*. The browse surface is capped
per-user/-workspace (the ZoomInfo 2,000-views model, §2.1) to defeat scraping and membership probing (§3.4).

**The key tension this resolves:** the masked index is the *one* place the shared graph is broadly readable, so it
must be the *masked* projection by construction — the index schema is the privacy boundary. This is why
`03-database-design.md:698` says "masked global search (no PII leaves the index)" is the only broad read path.

### 4.2 Paid reveal / entitlement gate (Layer 0 → workspace; the *take* moment)

**What it is.** The credit-gated transition from "masked candidate" to "durable workspace copy" — TruePoint's
`contact_reveals` event log + the first-reveal-wins ownership trigger (ADR-0007; `03-database-design.md:559-560,705`).
A reveal **decrypts exactly one master channel inside the reveal transaction and copies the value into the calling
workspace's overlay** (`03-database-design.md:384,698`; ADR-0021:48-51) — it does **not** hand the workspace a
pointer into Layer 0.

**Entitlement checks at the gate (all in one transaction):**

1. **Credit balance** — `tenants.reveal_credit_balance >= 0` with `FOR UPDATE` (ADR-0007 mitigation;
   `03-database-design.md:686,713`), optionally a per-team budget check (`team_credit_budgets`, ADR-0022:46-50).
2. **Idempotency** — unique `(workspace_id, contact_id, reveal_type)` + client `Idempotency-Key` so a
   double-click/retry never double-charges (`03-database-design.md:560,714`; ADR-0007).
3. **Suppression/consent gate** — enforced at the *global* layer (`master_persons.is_suppressed`,
   `master_emails` status) **and** the overlay `suppression_list` (scope global|tenant|workspace), gating both
   reveal and send (`03-database-design.md:421,687`; ADR-0021:51). A suppressed person cannot be revealed even if
   a stale masked candidate leaked through.
4. **First-reveal-wins per workspace** — the first reveal sets `contacts.revealed_by_user_id/revealed_at`
   (immutable credit owner, distinct from `owner_user_id`); re-revealing the same workspace copy is free; revealing
   the *same human in another workspace charges again* (ADR-0007). This is how a single canonical identity (C3)
   coexists with per-workspace billing: **identity is shared, the reveal/charge is per-workspace.**

**Re-projection on change (the Cognism lesson, §2.3):** a Layer-0 job change does not overwrite the revealed
overlay snapshot; it surfaces as a job-change *signal* and the workspace may *re-reveal* the new value (a new
billable event). This is the U3 reconciliation Phase 3 owns — Phase 4 only fixes that **reveal copies a
point-in-time value; the live edge stays in Layer 0; a later change is a signal + optional re-reveal, never a
silent rewrite** (RESEARCH_02 §3; ADR-0015 survivorship — user-owned values not silently superseded).

### 4.3 Owner-scoped visibility (workspace → owner; an app-layer filter *atop* RLS)

**What it is.** *Inside* a workspace, after RLS has already walled out other workspaces, visibility is further
narrowed to owner/team. ADR-0022 is explicit that this is **authz layered on the workspace RLS, not a new RLS
scope**: overlay rows carry `owner_user_id`, `assigned_team_id`, and `visibility ∈ workspace|team|owner`
(default `workspace`), and when visibility is `team`/`owner` an **app-layer authz filter** (optionally an
*additional* RLS predicate) restricts read/write (`ADR-0022:40-45`; `03-database-design.md:503-506,540-543`).

**Why app-layer and not RLS:** the RLS GUC mechanism carries exactly one workspace identity
(`app.current_workspace_id`, `client.ts:60`); owner/team is a *richer* relationship (a user may be in many teams,
a manager sees subordinates, a record may be shared to a list — §4.4) that does not reduce to a single GUC
equality. Putting it in RLS would either over-restrict (a single owner GUC) or require a join-heavy policy that
fights the index. So ownership is filtered in the query/app layer, where the membership graph is available — the
same reasoning Snowflake uses an *entitlements table* join rather than a static predicate (§3.1). Critically, this
is **defense-in-depth, not the only wall**: the RLS workspace wall is always under it; an owner-filter bug leaks
*within* a workspace (bad, bounded) but never *across* workspaces (catastrophic, prevented by RLS).

**Projection into the masked index:** owner/team visibility is *overlay* state, so the **global** masked index
(Layer 0) carries none of it — search returns Layer-0 candidates regardless of who in the workspace owns a later
overlay copy. The per-workspace *overlay* search (the retained Typesense surface, ADR-0021:76) **does** carry
owner/team and should pre-trim on it (the Azure `search.in(team_ids, ...)` pattern, §3.3) — but **must still
re-check at read** (§5), because the index filter is not the boundary (§3.3 caution 1).

### 4.4 List-based sharing (workspace → owner; explicit positive grants)

**What it is.** The primary explicit-sharing mechanism (shared ground-truth OWNERSHIP note): `lists` /
`list_members` (workspace-scoped, `lists.ts`) let an owner share a curated set of records to a team/workspace
audience without changing each record's `visibility`. Saved-search visibility and per-record shares are the
secondary mechanisms. Sharing is **explicit and positive** — a record default-scoped to `owner` becomes visible to
others *because it is on a shared list*, not because the wall was lowered.

**Projection note:** list membership is the cleanest thing to feed a search pre-trim filter (a bounded set of
record IDs, the `search.in(id, 'id1,id2,…')` form Azure recommends for subsecond response, §3.3) — but the same
re-check-at-read rule applies. List sharing is also the natural *unsharing/audit* surface: removing a member
revokes the projection, and the action is audited (`audit_log`, `03-database-design.md:682`).

---

## 5. "Search returns candidates, permission re-checked at read" — the two-stage authorization

This principle (shared ground-truth SEARCH note; ADR-0035) is the seam that lets a fast, slightly-stale, broadly
readable index coexist with a strict, always-fresh permission model. It is the same two-stage pattern Azure AI
Search documents (§3.3) and the same eventual-consistency posture ADR-0035 takes.

```
  STAGE 1 — CANDIDATE GENERATION (fast, eventually consistent, NOT the boundary)
  ──────────────────────────────────────────────────────────────────────────────
  query → masked OpenSearch (Layer 0)         → candidate master_person_ids   [no PII, facets only, capped]
  query → per-workspace Typesense (overlay)   → candidate contact_ids         [pre-trimmed on owner/team/list]
        the index filter is a STRING, not authorization (Azure §3.3 caution 1)

  STAGE 2 — AUTHORIZE-AT-READ (slow path, against Postgres TRUTH, IS the boundary)
  ──────────────────────────────────────────────────────────────────────────────
  for each candidate the caller actually opens/reveals:
    • RLS re-applies under withTenantTx (workspace wall, fail-closed GUC)        → C1
    • app-layer owner/team/list visibility re-check (ADR-0022)                   → C2
    • suppression/consent re-check (is_suppressed, suppression_list)             → C4 / compliance
    • reveal: credit + idempotency + first-reveal-wins                           → C3 (§4.2)
  → read-your-own-write + detail reads come from Postgres, never the index (ADR-0035)
```

**Why two stages and not one:** the index can be stale (a just-suppressed person, a just-reassigned record, a
just-revoked list share) and is read broadly; re-checking at read against Postgres truth closes the staleness +
the "index filter is not auth" gap in one move. The cost — a Postgres authorization read per opened/revealed
record — is bounded because the user opens far fewer records than the search returns (cursor-paginated, bounded
result sets; no N+1, no scan, C5). **The index is an accelerator; Postgres + RLS + app-layer authz is the
boundary.** A bug in Stage 1 (over-broad candidates) is a performance/UX issue; only a bug in Stage 2 is a
security incident — which is why Stage 2 is the FORCE-RLS, audited, fail-closed path.

---

## 6. Tradeoffs against the TruePoint constraints

| Constraint | Projection decision | Risk if done wrong | Mitigation in the recommended boundary |
|---|---|---|---|
| **C1 Layer-0 has no RLS** | Isolation = access path + grant-off + least-privilege roles, never a `workspace_id` predicate on `master_*` | A `workspace_id` on a golden record re-fragments the universe + leaks RLS into the shared graph (`ADR-0021:81-84`) | `leadwolf_app` has **no grant** on `master_*`; only ER/search-sync/reveal roles touch them (`03 §9`) |
| **C2 owner visibility ≠ RLS** | Owner/team/list filter is app-layer, layered on RLS; pre-trim in overlay search | Treating the index pre-trim as the boundary → within-workspace leak (Azure §3.3) | Always re-check owner/team/list at read against Postgres (§5) |
| **C3 shared identity, per-workspace billing** | One `master_persons` identity; reveal charges per `(workspace, contact)`; re-charge in another workspace | Charging once globally would break per-workspace honest billing (ADR-0007); a `workspace_id` on identity would shard the human | first-reveal-wins per workspace; credit on the *overlay copy*, not the golden record |
| **C4 PII never leaves the index** | Masked index carries facets + `has_email/has_phone` only; channel decrypts only in the reveal tx | Indexing email/phone → a search dump = a data breach | `email_enc`/`phone_enc` never indexed (`03 §5.1`); reveal decrypts in-tx only (`03 §9`) |
| **C5 billions of rows / millions of users** | Two-stage authorize-at-read; candidate index + bounded cursor reads; facet small-cell suppression | Facet/hit-count membership inference (§3.4); scraping the masked surface for free; N+1 authorize reads | view caps + rate limits (§2.1); small-cell suppression (§3.4); bounded per-open authorize read (§5) |

**The central tension resolved.** Layer 0 NOT being RLS-scoped is *not* a hole in the FORCE-RLS posture — it is a
**different isolation primitive for a different kind of table**, exactly as the Postgres community guidance
sanctions (§3.2). The overlay's wall is a *row predicate* (RLS); the master graph's wall is an *access path*
(masked search + paid reveal) backed by *grant-off + least-privilege roles*. The two never overlap: nothing a
workspace runs as (`leadwolf_app`) can read `master_*`; everything a workspace sees of the universe is a
*projection* (masked facets) or a *materialized copy* (revealed value), never the source row. The audited
privileged roles (`leadwolf_admin` DSAR fan-out, `withPlatformTx` staff reads) are the only cross-cutting paths,
and both are logged (`client.ts:30-35,95-111`; `03 §9`).

**Implementation status:** none of the projection surfaces are built. RESEARCH_00 §6 confirms Layer 0 does not
exist in code, so there is "no RLS-vs-system-owned tension in code yet" — the FORCE-RLS overlay (`rls/contacts.sql`)
is shipped; the masked OpenSearch index, the reveal-into-overlay service, the least-privilege `master_*` roles, the
view caps, and the small-cell facet suppression are all **planned, unbuilt** (P1/P8, RESEARCH_00 §7). The
owner/team `visibility` columns and `teams` tables are also unbuilt (RESEARCH_00 §6; only `owner_user_id` exists
today). This doc states the *target* boundary; the gap is work for the BRAINSTORM/PLAN gates, never license to
weaken the FORCE-RLS overlay or the two-tenant isolation itest gate to make Layer-0 integration easier (security
has final say — CLAUDE.md precedence).

---

## 7. The recommended projection boundary

```
                              ┌───────────────────────────────────────────────────────────┐
   SYSTEM-OWNED (no RLS,      │   LAYER 0  master_persons / master_companies /            │
   no leadwolf_app grant)     │   master_employment / master_emails(PII) / source_records │
                              └───────────────────────────────────────────────────────────┘
        touched ONLY by:  ER pipeline role · search-sync role · reveal-service role   (least-privilege)
                              │                         │                         │
            ┌─────────────────┘                         │                         └───────────────┐
            ▼                                            ▼                                         ▼
   (A) MASKED SEARCH                          (B) PAID REVEAL                          (audited) PRIVILEGED
   OpenSearch, facets only, NO PII            decrypt 1 channel IN-TX,                 withPrivilegedTx (DSAR),
   capped per-user/-ws, small-cell            copy value → overlay,                    withPlatformTx (staff,
   suppression, suppressed rows excluded      credit + idempotency + suppression       logged) — the ONLY
            │  candidate master_person_ids     + first-reveal-wins per ws               cross-workspace reads
            ▼                                            ▼
  ╔═══════════════════════════════════════════════════════════════════════════════════════════════════╗
  ║  LAYER 1  OVERLAY  —  ENABLE + FORCE ROW LEVEL SECURITY on workspace_id  (fail-closed GUC)          ║
  ║  contacts/accounts (master_*_id back-ref, revealed snapshot) · owner_user_id · assigned_team_id ·   ║
  ║  visibility(workspace|team|owner) · lists/list_members                                              ║
  ║       STAGE-2 authorize-at-read:  RLS wall  →  app-layer owner/team/list filter  →  suppression     ║
  ╚═══════════════════════════════════════════════════════════════════════════════════════════════════╝
```

**The boundary, stated as rules:**

1. **Layer 0 isolation is access-path + grant-off, never an RLS row predicate.** No `workspace_id` on any
   `master_*` table; `leadwolf_app` holds no grant on them; only the ER, search-sync, and reveal service roles
   touch them, each least-privilege (§3.2; `03 §9`). RLS-off is *necessary*; grant-off is the *actual* wall.
2. **The universe is reachable by exactly two customer paths: masked search and paid reveal.** Masked search is
   the *only* broad read of the graph and is masked by index construction (facets + `has_email/has_phone`, no PII);
   paid reveal is the *only* way a PII channel materializes, and it copies a point-in-time value into the
   FORCE-RLS overlay (C4; §4.1–4.2).
3. **Billing/ownership is per-workspace on the overlay copy; identity stays single on the golden record.**
   first-reveal-wins per `(workspace, contact)`; re-charge in another workspace and on a job-change re-reveal
   (Cognism, §2.3); the human is never sharded by `workspace_id` (C3; ADR-0007).
4. **Within a workspace, owner/team/list visibility is an app-layer filter layered on RLS, re-checked at read.**
   It pre-trims the *overlay* search (Azure `search.in`, §3.3) but is authorized at read against Postgres truth —
   the index filter is never the boundary (C2; §5).
5. **The masked surface is capped and small-cell-suppressed.** Per-user/-workspace view/search caps + rate limits
   (ZoomInfo model, §2.1) defeat scraping; minimum-bucket thresholds on facet/hit counts defeat membership
   inference (§3.4). Suppressed identities are excluded from the projection entirely (`is_suppressed`, §4.1).
6. **Every cross-workspace read is privileged and audited.** Only `withPrivilegedTx` (DSAR fan-out) and
   `withPlatformTx` (staff) cross the workspace wall, and both log (`client.ts:30-35,95-111`).

**What I explicitly reject:**

- **A `workspace_id` column / per-workspace RLS policy on the master graph.** It is the obvious "make Layer 0 fit
  the RLS model" move and it is exactly wrong: it re-fragments the universe ADR-0021 unifies, defeats global
  dedup, shards a single human across N workspaces, and bleeds the RLS wall into the shared asset (C1;
  `ADR-0021:81-84`; RESEARCH_02 §4). Layer-0 isolation must stay access-path, not row-predicate.
- **Granting `leadwolf_app` read on `master_*` "just for search/reveal."** The customer role must never touch the
  graph directly; search goes through the masked index, reveal through the reveal-service role. A direct grant
  turns the access-path wall into a single forgotten `WHERE` clause away from a full-universe leak.
- **Treating the search index as the authorization boundary (skipping Stage-2 re-check).** Verified-unsafe: the
  index filter is "just a string," and post-trim leaks hit-counts/facets (Azure §3.3). Skipping the read-time
  re-check would leak within a workspace (owner/team) and serve stale suppression/reassignment.
- **An unmetered, uncapped masked browse surface.** Free unlimited masked search lets a customer scrape the
  universe and run membership inference for free, never spending a reveal credit — the failure §2.1's view caps
  and §3.4's suppression exist to prevent. The throttle belongs on the *browse*, not only the *reveal*.
- **Silently overwriting a revealed overlay copy when the Layer-0 record changes.** It violates survivorship
  (user-owned/revealed values are not silently superseded; ADR-0015) and the Cognism reuse model (§2.3); the
  correct surface is a job-change signal + an optional billable re-reveal (the U3 reconciliation Phase 3 owns).
- **Per-record RLS policies for owner/team visibility (Snowflake-style RAP at the overlay).** ADR-0022 already
  decided owner/team is app-layer authz, not a new RLS scope (`:40-45`); a join-heavy per-record RLS policy would
  fight the workspace-leading composite indexes and conflate two different walls. Keep RLS = workspace; keep
  owner/team/list = app-layer + read-time re-check.

---

## 8. Open questions handed to the BRAINSTORM gate (not answered here)

1. **Masked index field set + small-cell threshold.** Exactly which facets are projected, and at what minimum
   bucket size are facet/hit counts suppressed (the §3.4 membership-inference control)? Owned by ADR-0035 search
   design + a privacy threshold decision.
2. **View/search cap shape.** Per-user vs per-workspace vs per-tenant caps and rate limits on the masked browse
   surface (the ZoomInfo 2,000-views analogue, §2.1); where the counter lives and how it interacts with the
   credit pool.
3. **Reveal-service role + transaction shape.** The least-privilege DB role that decrypts a `master_emails`/
   `master_phones` channel and writes the overlay copy in one transaction — its exact grants, and how the credit
   decrement + suppression check + idempotency compose in that tx (extends ADR-0007 mitigations).
4. **Owner/team authorize-at-read mechanism.** App-layer filter only, or app-layer + an *additional* RLS predicate
   (ADR-0022 leaves it optional, `:43-44`)? How team membership + manager-sees-subordinates + list shares compose
   into one read-time authorization. Phase-4-adjacent, but the visibility *columns* are unbuilt (RESEARCH_00 §6).
5. **Job-change re-projection + re-charge.** When a Layer-0 edge change fires a signal, is the re-reveal a new
   `contact_reveals` row (re-charge, Cognism model) or a free refresh within a window? Overlaps U3 (Phase 3) and
   ADR-0013 (charge-for-verified-data); flag, don't decide here.
6. **Co-op contribution back-pressure.** When CONTRIBUTE-TO is opt-in enabled (`ADR-0021:60-62`), a workspace's
   overlay edits feed `source_records` that ER may promote — the projection then runs *both directions*. The
   write-back path's isolation (a workspace must not be able to read *which other workspace* contributed a value)
   is a projection concern this doc flags for a later gate.

---

## 9. Recommendation

**Adopt the access-path projection boundary of §7: Layer 0 stays system-owned with no `workspace_id`, no RLS, and
no `leadwolf_app` grant — isolated by exactly two masked/metered customer access paths (masked search + paid
reveal) plus audited privileged roles — while every per-owner view is an app-layer filter layered on the FORCE-RLS
overlay and re-checked at read.** This is the only model that satisfies all five constraints at once, and it is the
documented industry pattern (ZoomInfo/Apollo/Cognism/Lusha view-vs-credit, §2; Snowflake shared-single-copy + the
Postgres "global tables get no RLS" carve-out, §3.1–3.2) hardened with TruePoint's database-enforced boundary
rather than a EULA + rate-limit alone.

The three decisions that carry the most weight:

1. **Entitlement is on the verb, not the row** (§3.1). There is no per-workspace ownership of a golden record to
   express as an RLS predicate; *every* workspace may *find* (masked, capped) and *reveal* (for a credit) *any*
   non-suppressed person. So the projection gates **operations** (search vs reveal, at a rate/budget), not rows.
   This is precisely why Layer 0 is access-path-isolated, not RLS-isolated — and why putting `workspace_id` on the
   graph is the headline rejection.
2. **Two-stage authorize-at-read is the boundary; the index is an accelerator** (§5, verified by Azure §3.3). The
   masked index returns candidates fast and slightly stale; Postgres + RLS + app-layer owner/team/list + suppression
   re-checks at read are the wall. A Stage-1 bug is a UX issue; only a Stage-2 bug is an incident.
3. **Identity is single, billing is per-workspace** (§4.2, ADR-0007; Cognism §2.3). first-reveal-wins per
   `(workspace, contact)` reconciles a shared canonical human with honest per-team billing, and the Cognism
   "re-charge only on job change" model gives the clean re-projection semantics for the U3 reconciliation Phase 3
   will design.

**What I reject** is consolidated in §7 (the six rejected moves); the load-bearing one is the first:
**never give the master graph a `workspace_id` or a per-workspace RLS policy.** It looks like the way to make
Layer 0 obey the house RLS rule, and it would quietly destroy the shared-universe value the entire initiative
exists to deliver. The shared asset earns its keep precisely by *not* being workspace-partitioned; its safety
comes from the access path, the grant-off least-privilege roles, the masked index, the metered reveal, and the
audited privileged escape hatches — not from a row predicate.
