# 12 — I5: Probabilistic Entity Resolution (Build Record + Enable Gate)

**Status:** Built, SHADOW-ONLY, DARK behind `ER_SHADOW_ENABLED` (default off). No schema added. Turning it on
only *fills a human-review queue* — it never merges anything. **Acting on a proposal (confirm/merge) is a
separate, still-deferred, security-reviewed step (audit A2 / I4 executor).**

Closes build stage **I5** from [10-Implementation-Roadmap](./10-Implementation-Roadmap.md): a Splink-style
probabilistic matcher that proposes duplicate person clusters into `match_links(review_status='pending')` for
clerical review — the populator the I4 review queue was waiting on (audit P02, A10).

---

## What shipped (all additive, shadow-only)

| Slice | Commit | What |
|---|---|---|
| 1 | `cf32957` | **Pure Fellegi-Sunter scorer** (`er/fellegiSunter.ts`) — comparison vector → match weight → posterior probability → disposition (`auto_match`/`pending_review`/`no_match`). + test. |
| 2 | `74aa096` | **Pure comparison layer** (`er/compareRecords.ts` + Jaro-Winkler `er/stringSimilarity.ts`) — a person pair → 7-field observation vector. PII compared only as blind-index hex. Placeholder `DEFAULT_FIELD_WEIGHTS`. + tests. |
| 3 | `d4cfdac` | **Candidate generation** (`erRepository`) — `findBlockingCandidates` (blocks on shared `current_company_id`, the indexed selective key) + `listPersonsForEr`. System-scoped (`withErTx`), read-only, bounded. |
| 4 | `734753e` | **Shadow proposer** — `ER_SHADOW_ENABLED` flag + `proposePendingMatch` (inserts a `pending`/`splink` `match_links` row; idempotent; never `is_duplicate_of`, never re-points). |
| 5 | `cafdd4c` | **Leader-locked sweep** (`erSweep.ts`) — flag-gated, Redis-cursor-resumed scan; per seed: block → compare → score → propose. Registered in `register.ts`. |

## The flow (only when `ER_SHADOW_ENABLED` is on)

```
er sweep (leader-locked, cursor over master_persons)
  → for each seed at a company: findBlockingCandidates (same company)
    → compareRecords (linkedin / name(JW) / company / title …) → scoreFellegiSunter
      → pending_review OR auto_match ⇒ proposePendingMatch:
         insert match_links(review_status='pending', match_method='splink', probability)   [the ONLY write]
  ⇒ the DB-Ops review queue (I4 read surface) now has rows to triage
```

## Why the write is safe (verified, not assumed)

A `pending`/`splink` `match_links` row is **provably inert** in the authoritative graph:
- the **deterministic resolve path** (`masterGraphRepository`) has *zero* references to `review_status` /
  `is_duplicate_of` / `match_method` — it ignores them;
- the **I1 projector** counts `source_records` by resolved cluster, **not** `match_links` — a pending row doesn't
  move the shadow projection;
- **`is_duplicate_of`** (the C4 re-point cascade source) is written/read by nothing — the cascade isn't built,
  and the proposer leaves it NULL.

So enabling the sweep only fills a review queue. **Even `auto_match` is only ever *proposed*** — "no auto-merge
above threshold without a human" (roadmap I5).

## Flag-off safety

While `ER_SHADOW_ENABLED` is off: the sweep processor returns immediately (proposes nothing), and no other path
changed. The deterministic resolve path and the shipped ER are **byte-identical**.

---

## Enable gate (owner: the user)

1. **Calibrate before trusting the thresholds** — `DEFAULT_FIELD_WEIGHTS` (m/u per field) and the
   `DEFAULT_FELLEGI_SUNTER_CONFIG` thresholds are **placeholders**. Calibrate on a labelled set (the roadmap I5
   FP/FN test) so the proposals are precise.
2. **Flip `ER_SHADOW_ENABLED=true`** — safe (read-only effect: it fills a review queue). Watch the proposal
   volume/precision.
3. **The merge/split EXECUTOR that acts on a confirmed proposal is still deferred** — it mutates the master graph
   (re-point/survivorship, audit A2) and needs the security review + the I4 executor (see
   [08-Database-Operations-Module](./08-Database-Operations-Module.md)). Enabling the sweep does NOT enable any merge.

## Known follow-ups (not blockers)

- Blocking is company-only for now (`block_key` is unpopulated; name/email trgm indexes are deferred). Email/phone
  blind-index comparison isn't wired into the projection yet (set-valued channels), so v1 scores conservatively on
  linkedin + name + company + title — fewer, higher-precision proposals (the right bias for a shadow proposer).
- Company entity resolution (only person ER is built).

---

Next stages all need a gate you own: **I4 merge/split executor** (security review), **I6 Chrome extension**
(legal sign-off), **I7 scale/GA** (infra creds). See [10-Implementation-Roadmap](./10-Implementation-Roadmap.md).
