# Reveal Experience — Overview

The **Contact & Email Reveal** flow (uncover a prospect's email/phone by spending credits) is a core
Sales-Intelligence surface. This initiative audited the shipped implementation, researched how leading
enterprise platforms build reveal, and rebuilt the experience to enterprise standard across six phases.

- **Audit** → [`02-current-state-audit.md`](./02-current-state-audit.md)
- **Enterprise research** → [`01-enterprise-research.md`](./01-enterprise-research.md)
- **Target architecture** → [`03-target-architecture.md`](./03-target-architecture.md)
- **Phased roadmap + status** → [`04-phase-plan.md`](./04-phase-plan.md)
- **Decision record** → [`ADR-0042`](../decisions/ADR-0042-reveal-experience-and-async-bulk.md)

## The problem (as reported)

1. No **Reveal** button in the contacts list/table.
2. After a reveal, the frontend didn't reflect the new data.
3. Users had to open the record → click "View revealed" → re-confirm to *see* the data.
4. Reveal status was inconsistent across surfaces.
5. Loading / progress / success / error feedback was missing or inconsistent.
6. Credits weren't clearly shown before/after a reveal.
7. No way to tell whether a contact was already revealed.
8. Bulk reveal was incomplete.
9. No caching of previously-revealed contacts.
10. Backend↔frontend state sync was inconsistent.

## Root cause

The read side had **no PII-carrying primitive**: the masked row type (`MaskedContact`) exposed `isRevealed`
but never the email/phone plaintext, and there was **no no-charge way to fetch already-owned reveal data**.
So a reveal could only flip a boolean, the values were discarded on dialog close, and the only way to *see*
PII was to re-run (and re-charge) the reveal. This single fact drove issues #2, #3, #7, #9, #10.

## What was built (by phase)

| Phase | Delivers | Fixes |
|---|---|---|
| 0 | Backend credit-safety + correctness hardening | role gate on the money endpoint, cross-type dedup, provider timeouts, credit-back |
| 1 | No-charge "view revealed data" read primitive | #2, #3 |
| 2 | In-list reveal + one client source of truth + cost-before-confirm | #1, #4, #5, #6, #7, #9, #10 (non-realtime) |
| 3 | Enterprise async bulk reveal (jobs, lease/release, worker, API, UI) | #8 |
| 4 | Realtime sync (transactional outbox + SSE) | #10 (fully) |
| 5 | Performance, accessibility, QA polish | — |

Phases 0–3 are implemented and on `main`; Phase 3 is **dark-launched** behind `BULK_REVEAL_ENABLED`. Phases
4–5 are planned. See [`04-phase-plan.md`](./04-phase-plan.md) for detailed status.

## Guiding principles

- **You only pay for valid data** (ADR-0013 charge-by-verified-result + credit-back) — the wedge against
  competitors who charge for misses.
- **Reveal is per-workspace, first-reveal-wins; re-access is free** (ADR-0007).
- **One credit lease per bulk job**, never a per-row hot-lock (ADR-0029).
- **Tenancy is enforced at the database (RLS)**; every reveal read is ownership-checked.
