# Reveal Experience — Current-State Audit

The shipped state at the start of the initiative, grounded in code. Most items are now resolved (see
[`04-phase-plan.md`](./04-phase-plan.md)); this records the baseline and where each issue lived.

## Reported issue → confirmed cause

| # | Reported issue | Cause | File(s) |
|---|---|---|---|
| 1 | No reveal button in list | Columns ignored `isRevealed`; `RowActions` email item inert | `ProspectPage.tsx`, `RowActions.tsx` |
| 2 | Reveal not reflected | Row type holds no PII; `markRevealed` flips a bool; PII discarded on close | `useProspectSearch.ts`, `contacts.ts`, `RecordDetail.tsx` |
| 3 | "View revealed" friction | Re-opened the confirm dialog + re-revealed; no read path | `RecordDetail.tsx`, `RevealDialog.tsx` |
| 4 | Inconsistent status | 4 surfaces derived "revealed" differently | `ProspectPage.tsx`, `RowActions.tsx`, `RecordDetail.tsx`, `export.ts` |
| 5 | Inconsistent feedback | No reveal error toasts; no re-entry guard; no per-row spinner | `useReveal.ts`, `useBulkReveal.ts` |
| 6 | Credits not shown pre-reveal | Single-reveal dialog showed prose only | `RevealDialog.tsx` |
| 7 | Can't tell if revealed | `maskedEmail`/`emailGlyphFor` ignore `isRevealed` | `features/prospect/types.ts` |
| 8 | Bulk incomplete | Client-side sequential loop; no cancel/retry/parallelism; select-all disabled | `bulkReveal.ts`, `BulkActionBar.tsx` |
| 9 | No caching | PII never stored client-side; no server cache | `useReveal.ts`, `revealContact.ts` |
| 10 | Inconsistent sync | Only a same-tab `window "credits:changed"` (balance only); no event/SSE | `useReveal.ts`, `revealContact.ts` |

## Backend correctness / security gaps found

- **No role gate** on `POST /:id/reveal` — a *viewer could spend tenant credits*. (Fixed P0.)
- **Cross-`reveal_type` double-charge** — `email` then `full_profile` both billed the email field. (Fixed P0.)
- **No provider timeout** on Reacher/Twilio verify — a hung provider hangs the synchronous reveal. (Fixed P0.)
- **Credit-back gap** — bounce refund only matched `reveal_type='email'`, missing `full_profile`; and an
  over-refund risk when a `full_profile` carried a phone-only charge. (Fixed P0 — refunds the earliest
  email-covering claim.)
- **No reveal-specific rate limit** on the money endpoint. (Added P0.)
- **Bulk reveal not queued** — `bulkRevealExport` looped `revealContact` per contact, each taking the tenant
  `FOR UPDATE` (the hot-lock ADR-0029 forbids); mid-run failure left partial charges with no file. (Replaced
  by the async job, P3.)

## What was already correct (built on, not rebuilt)

Idempotent single-reveal claim (unique `(workspace_id, contact_id, reveal_type)` + `FOR UPDATE` + `CHECK
balance>=0`); charge-by-verified-result (`chargeFor`) with 0-credit rows on bad data; `last_verified_at`
freshness stamp on reveal; the M11 `credit_ledger` (migration `0040`) with paired `spend` entries; the bulk
**estimate-before-confirm** surface; the sticky multi-select `BulkActionBar`.

## Adversarial-review findings (during implementation)

A skeptical review of the money/PII paths caught a real regression introduced in Phase 0: the widened
credit-back matcher could refund a *phone* charge on an email bounce (free/invalid email → `full_profile`
charges phone-only → email bounces → the phone-charging row is the only match). Fixed by refunding the
**earliest email-covering claim** (always the one that charged for the email), with no `credits_consumed`
filter. A low-severity PII-egress point (LinkedIn URL exposed on any claim) was tightened to require email
ownership.
