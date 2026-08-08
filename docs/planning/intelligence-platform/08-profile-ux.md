# Phase 8 — Profile UX

> ## ⚠ THE FIRST VERSION OF THIS DOCUMENT WAS WRONG. It is corrected below, not deleted.
>
> v1 (iteration 23) claimed *"the S-10 confidence/freshness badge is ~2/3 built and surfaced nowhere"* and
> reordered the whole phase around shipping it. **That finding was false in every part.** The badge is built
> — v0 *and* v1 — and it renders in at least six places.
>
> **Root cause: case-sensitive greps treated as semantic answers.** I searched `apps/web/src` for
> `dataHealth|provenance|confidence|lastVerified` and read "zero matches" as "the feature does not exist".
> The code is there under `DataHealthCell`, `ContactDataHealth`, `dataHealthTone`, and an entire
> `features/data-health/` directory. A case-insensitive search returns **58 files**.
>
> This is the *same* failure recorded as the iteration-19 lesson, which I had written down as "don't treat a
> string match as a semantic answer" — and then repeated by making the search itself unsound. The lesson has
> been restated in `00-progress.md` in the form that would actually have caught it: **grep case-insensitively
> and search for the concept's several plausible spellings before concluding absence.**

---

## What actually exists (verified, case-insensitively, by reading the files)

The S-10 badge is **shipped end to end**, not pending:

| Piece | Where | Evidence |
|---|---|---|
| Field confidence math | `packages/types/src/confidence.ts` | `FIELD_HALF_LIFE_DAYS`, `METHOD_PRIOR`, `decayFactor`, `corroborationBoost`, `computeFieldConfidence`, `confidenceBand` |
| Record-level quality | `packages/types/src/dataHealth.ts` | `computeContactDataQuality`, `freshnessStatusFor`, `FRESHNESS_SLA_DAYS` |
| Corroboration aggregate | `packages/db/.../provenanceBadgeRepository.ts` | **called** from `packages/core/src/reveal/revealContact.ts:431`; asserted in `provenanceEvent.itest.ts:342` |
| Badge v1 assembly | `packages/core/src/data-health/badgeV1.ts` | "score + recency + corroboration count, shown in app, extension, and exports; outcome S-10" |
| List grid cell | `apps/web/.../ListDetailPage.tsx` | `DataHealthCell` — ScorePill (dot + tabular number) + `StatusBadge` freshness band + tooltip |
| Prospect detail | `apps/web/.../RecordDetail.tsx:540` | `dataHealthTone(contact)` |
| Whole feature area | `apps/web/src/features/data-health/` | `DataHealthPage`, `MetricsSection`, `FreshnessTrend`, `VerificationBreakdown`, `SourceCoverageSection`, `ReverificationActivity`, `MergeReviewDrawer`, `ReverifyNowButton` + a `(shell)/data-health` route |
| Home + reports | `home/DataHealthCard.tsx`, `home/DataHealthTrendCard.tsx`, `reports/DataHealthSection.tsx` | — |
| Extension | `apps/extension/src/ui/panel/Panel.tsx:235`, `shared/messages.ts:87` | `sourceDiversity` crosses the extension bridge |

R9's research finding still stands (neither ZoomInfo nor Apollo surfaces "last verified" in the standard UI)
— but TruePoint **already acted on it**. There is no badge gap to close.

---

## Conflict C9 (new, surfaced not resolved) — two field-confidence implementations

Found while checking the above. Two modules now compute "how much do we believe this field", by different
math, on different keys:

| | `packages/types/src/confidence.ts` (shipped) | `packages/core/src/prospect/confidence.ts` (mine, iteration ~12) |
|---|---|---|
| Model | `prior(method) × decay(age, halfLife) × corroborationBoost(n)` | `noisyOr(sourceWeight, sourceCount) × decay(age, halfLife)` |
| Keyed on | **method** (`smtp_verify`, `crawl`, …) | **field + sourceType**, with `*` wildcards and precedence |
| Half-lives | hardcoded constants | rows in `master_confidence_policy` (migration 0107, 26 seeded) |
| Corroboration | hand-rolled capped log curve, max +25% | falls out of noisy-OR algebra |
| Consumed by | `badgeV1.ts` → app, extension, exports | **nothing** |

Both are defensible; they cannot both be right about the same record. `badgeV1.ts`'s own header states the
stake exactly: *"a badge that disagrees with itself across surfaces is worse than no badge, because the user
cannot tell which one is lying."*

**Recommendation (needs sign-off — rule 6, and this touches shipped code reaching the extension):** keep
**one** scoring function, the `@leadwolf/types` one, because it is a leaf-package pure function already
consumed by three surfaces. Preserve the policy table's actual value — tunable half-lives and source weights
without a deploy — by letting `master_confidence_policy` **supply the constants** to that function rather than
fork the math. That keeps both intents and deletes one implementation, not one idea. Do not rip out the
shipped path.

*My module and its 33 tests stay in place, unwired, until this is decided.*

---

## What Phase 8 actually has left

With the badge finding withdrawn, the honest remaining scope is much narrower than the brief implies:

| Profile | State | Blocked on |
|---|---|---|
| **Prospect** | exists (`RecordDetail`, `QuickViewDrawer`), badge shown | Enriching it with `master_employment` SCD2 career timeline — **data exists**, this is buildable |
| **Company** | exists (`AccountDetailDrawer`) | New Layer-0 firmographic tables (locations, funding, contact points) are **empty** |
| **Technology** | **does not exist** | Catalog empty; C4/RD-7 seed decision unsigned |
| **Product** | **does not exist** | Same, plus C7 unresolved |

**The re-sequencing conclusion, which is the opposite of v1's:** Phase 8 is not blocked on UI work, it is
blocked on **data**. Three of the four profiles would render empty states over tables this programme created,
granted, indexed and tested but never populated. The high-value next work is the **populators** — the
adoption-edge feed and the signal producers — not more surfaces.

Building the Technology and Product profiles now would produce two pages that teach users the feature is
broken rather than unpopulated.

---

## Still true from v1

- **Null ≠ zero.** `buildConfidenceBadgeV1` returns null when `sourceDiversity <= 0`, with the reasoning
  written at the call site: until the provenance gate is on, that is true of *every* record, and "rendering a
  confident-looking zero across the whole database would be worse than showing nothing." Any new surface must
  keep that discipline.
- **The empty-state question** — what a profile section renders when its table exists but holds no rows —
  is the live design question, and it now governs most of this phase rather than a corner of it.
- **No JSX has been written.** `truepoint-design` has now been read (tokens via inline `var(--tp-*)`, no
  Tailwind in `apps/*` JSX, no raw elements, `StateSwitch` for four states, light-theme only, WCAG 2.2 AA,
  never meaning-by-colour-alone). `truepoint-architecture` still must be read before any component lands.
