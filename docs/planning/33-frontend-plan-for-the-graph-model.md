# 33 — Frontend Plan for the Re-Planned Graph Model

> **Status:** Plan awaiting confirmation. No code written from this document yet.
> **Governs:** `apps/web` surfaces that read the Layer-0 graph after migration 0108.
> **Skills applied:** truepoint-architecture (structure + pre-build pass), truepoint-design
> (rendering, states, light-theme-only), truepoint-platform/data (what the API can serve),
> truepoint-security (what may be shown).
> **Companion:** [32](./32-database-audit-frontend-api-plan.md) is the audit this follows;
> `cascade-graph/` is the model's design rationale.

---

## 0. The finding that reorders everything

The tempting plan is "build UI for the new graph." That plan is wrong, because **most of the new
graph has no producer yet**. Verified against the code, not assumed:

| Layer-0 table | Written by | Populated today |
|---|---|---|
| `master_persons`, `master_companies` | `resolveForImport` on the live import path | ✅ **yes** |
| `master_employment` | minted on a new-person mint | ✅ **yes**, but a *bare* edge — no title, no dates |
| `source_records`, `provenance_event` | the import pipeline | ✅ **yes** |
| `master_education` | *nothing* | ❌ empty |
| `master_technology_adoptions` | *nothing* (awaits a licensed feed) | ❌ empty |
| `master_technology_vendors` | *nothing* | ❌ empty |
| `master_signals` | *nothing* | ❌ empty |

So the surfaces that would look most impressive in a demo — technology panels, displacement feeds,
alumni lists — would render empty for every customer, while the one Layer-0 asset that *is* real
(the provenance and confidence spine behind every imported field) has almost no UI at all.

**This plan is therefore sequenced by data availability, not by feature appeal.** Track A ships
against data that exists. Track B is already built and waits. Track C is explicitly not built.

> **A rule for this whole plan.** A surface that cannot distinguish *"we hold nothing"* from
> *"we have not matched this record yet"* must not ship. The first is a claim about the world; the
> second is a claim about us. Conflating them tells customers their data is empty when in fact our
> resolution has not run. Every component below carries both states separately.

---

## 1. Consolidation ruling — **no new routes**

Per `references/ui-consolidation.md`, the merge-first test was run on every item in this plan. The
result is unambiguous: **this plan adds zero routes, zero destinations and zero feature folders.**

| Candidate surface | Ruling |
|---|---|
| "Company intelligence" page | ❌ Same entity as the account drawer. Sections on the existing drawer. |
| "Technology explorer" page | ❌ Variant of account search — a filter, not a page. |
| "Graph / provenance" page | ❌ Provenance is an attribute of a field, not a destination. Inline + popover. |
| Education tab | ❌ Same entity as the contact drawer. A section, as shipped. |
| Data-health additions | ✅ Existing destination, new tab content only. |

Everything lands in `features/prospect/` (the drawers) and `features/data-health/` (the aggregate
views), both of which already exist.

---

## 2. Track A — ships against data that exists

### A1. Field provenance & confidence, inline on the record *(highest value, real data)*

**The gap.** `provenance_event` and `field_provenance` are populated for every imported field, and
`packages/types/src/confidence.ts` implements banding, decay and pin-floor with a full test suite.
Today that model surfaces in **exactly one place** — `RevealDialog` — so a customer sees confidence
only at the moment they spend a credit, and never afterwards.

**What to build.**
- A `<FieldProvenance>` popover in `@leadwolf/ui` (or `features/prospect/components/`) — anchored to
  a field value, showing: confidence band, "verified N days ago", source count, and the asserting
  source class. Band only, never the raw decimal (the existing `RevealDialog` precedent).
- Attach it to the revealed email/phone rows in `RecordDetail`, and to the `Identity` block fields.
- A compact band chip on grid rows, replacing nothing — it sits beside the existing ✓/?/— email
  glyph, which stays because it means something different (deliverability, not belief).

**Files:** `features/prospect/components/FieldProvenance.tsx` (new),
`hooks/useFieldProvenance.ts` (new), amendments to `RecordDetail.tsx` and the grid column defs.
**API:** needs a small read — `GET /contacts/:id/provenance` returning per-field band + recency +
source count. *Not yet built* (see §5).
**States:** unverified is a real, common state and renders as "unverified", not as an error.

### A2. Employment history from the graph *(real data, but be honest about its shape)*

**The gap.** The contact record shows a single current title. Layer 0 holds `master_employment`
stints, which is what makes tenure and job-change legible.

**The caveat that shapes the design.** The import path mints a **bare** edge — person↔company,
`is_current`, `is_primary` — with **no title and no dates**. So a timeline UI would render a list of
company names with blank dates, which looks broken rather than sparse.

**Ruling:** build the *component* to handle rich stints, but render a company-list form until the
edges carry titles/dates. Show "Previously at Acme, Globex" rather than an empty-looking timeline.
Revisit the timeline when an enrichment provider populates title/date on the edge.

### A3. `org_kind` — stop assuming every organization is a company

**The gap.** `master_companies` now carries `org_kind` (company | school | nonprofit | government).
The account surface assumes "company" everywhere: the drawer says *Firmographics*, the empty state
says *company*, the icon is a building.

**What to build.** A small `orgKind` awareness pass: the drawer heading, the avatar glyph, and the
"View N contacts" copy adapt when the bridged node is a school or government body. This is cheap and
prevents an obviously-wrong label the first time a university lands in someone's workspace.

---

## 3. Track B — already built, correctly waiting

These shipped in the 0108 work and need **no further frontend effort**. They render honest
"not matched yet" / "nothing recorded" states and will fill in the day a producer runs.

- **Builds / Runs sections** on the account drawer (`AccountTechnologySections.tsx`).
- **Education section** on the contact drawer (`EducationSection.tsx`).

**Do not** add loading polish, empty-state illustrations or filters to these until they have data.
Effort spent making an empty surface prettier is effort spent hiding that it is empty.

---

## 4. Track C — do not build yet, and why

| Surface | Blocked on |
|---|---|
| Displacement feed ("who dropped X") | `master_technology_adoptions` has no producer; `removed_at` is never set, so the feed is permanently empty. |
| Alumni-of-school list | Data is empty **and** there is no tenant anchor — a school is rarely an account in a customer's workspace, so the surface has no natural home. Needs a product decision before a design. |
| Technology-first browse ("who uses GA") | Same empty-data problem; and the existing account technology facet reads `accounts.technologies`, which is a *different* dataset (see §6). |
| Signal timeline | `master_signals` has no producer; `intent_signals` (tenant) has exactly one live type. |
| `as_of` time-travel control | The API supports it. Real, but it is a power-user affordance over data we barely have — revisit once history exists to travel through. |

---

## 5. API work this plan requires

Only one genuinely new endpoint, plus one additive field. **Status: the endpoint shipped; the additive field is blocked — see below.**

1. **`GET /api/v1/contacts/:id/provenance`** *(new, for A1)* — per-field band, last-verified, source
   count, source class. Same two-transaction pattern as the other Layer-0 reads: resolve the contact
   under `withTenantTx`, then read under `withErTx`. No raw scores, no contributor reference.
2. ~~**`confidence_band` on search rows**~~ *(additive, for the A1 grid chip)* — **NOT BUILT, and it
   should not be built until §9D of plan 32 is decided.** The performance constraint I wrote here
   (compute in-query or denormalize, never per-row — the grid renders 50 rows and an N+1 would be felt
   immediately) is still right, but it is not the binding one. The binding problem is *which number*:

   - The drawer badge reads **Layer 0** — `provenanceBadgeRepository` over `provenance_event`, through
     `buildConfidenceBadgeV1`, reachable only via `withErTx` because `leadwolf_app` is REVOKE'd from
     that table.
   - Search runs **Layer 1** under RLS. In-query, the only confidence data it can reach is
     `contacts.field_provenance` (jsonb), `email_status` and `last_verified_at` — a *different store*.

   Computing the chip from the tenant store would put a "high" chip in the grid beside a "medium"
   badge in the drawer for the same contact. `badgeV1.ts` states the rule this breaks in its own
   header: *"a badge that disagrees with itself across surfaces is worse than no badge, because the
   user cannot tell which one is lying."* And plan 32 §9D already found **two** confidence engines
   shipping and disagreeing by 0.09–0.17; deriving a third for the grid makes that worse, not better.

   The honest options are (a) decide §9D first, then denormalize the winning band onto `contacts` with
   a producer that keeps it fresh, or (b) leave the chip out of the grid. What must not happen is a
   third in-query derivation that looks cheap and quietly contradicts the drawer.

Both belong in `packages/types/src/accountIntelligence.ts` first — contract before implementation.

---

## 6. The unresolved product question (needs a human)

`accounts.technologies` (a per-workspace rollup **inferred** from intent signals) and
`master_technology_adoptions` (actual **detection**) are two different datasets that answer
superficially the same question. The shipped account filter reads the former; the new "Runs" section
reads the latter.

I relabeled the older block to *"Signals from your workspace"* so the two stop looking
interchangeable, but that is a mitigation, not a decision. **The decision — does the technology
facet cut over to Layer-0 detection once a producer exists, and what happens to workspaces relying
on the inferred list? — is yours, not an implementation detail.** Cutting over today would break a
working filter, which is why it has not been done.

---

## 7. Pre-build pass (the questions the protocol requires)

- **Source of truth.** Layer 0 for graph facts; the tenant overlay for anything the customer edits.
  The UI never merges the two into one list — that is the failure this whole model exists to prevent.
- **Failure modes.** Every new surface uses `StateSwitch` with four states, and treats *unresolved*
  as a distinct fifth. A Layer-0 read failing must degrade the section, never the drawer.
- **Security.** No new PII crosses the boundary: provenance carries source class and dates, not
  values; no `master_*` id is ever rendered or accepted from the client.
- **Scale.** The provenance popover is fetched **on open**, never per row. The grid band comes from
  the search payload. No new N+1.
- **Rollback.** Each section is independently removable; none is load-bearing for an existing flow.
- **Design constraints.** Light theme only. `@leadwolf/ui` primitives only. `--tp-*` tokens only.
  Hierarchy from weight and size, not colour. Band colour is semantic and must not become the
  accent.
- **Worst case.** A confidence band that is wrong in the *reassuring* direction — showing "high" on
  a stale field — is worse than showing nothing, because customers will email on it. Hence band-only
  display, an explicit unverified state, and the recency string always shown beside the band.

---

## 8. Build order

1. **A3 `org_kind` awareness** — smallest, no API work, removes an actively wrong label.
2. **A1 provenance contract + endpoint**, then the popover, then the grid chip.
3. **A2 employment**, in its honest company-list form.
4. Stop. Re-open Track C only when a producer lands, and re-run this plan's §0 table first.

**Definition of done for this plan:** a customer can see *why* the system believes a field, on a
record they already have, without spending a credit — and no surface claims emptiness that is
actually just unresolved identity.
