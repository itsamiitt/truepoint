# Reveal Experience — Target Architecture

## The central primitive: a no-charge, ownership-checked "get revealed data" read

The fix that unlocks issues #2, #3, #7, #9 without re-charging.

- **`GET /api/v1/contacts/:id/revealed`** (`getRevealedContact`) — decrypts email/phone **only for the
  `reveal_type`s this workspace owns** (a `contact_reveals` claim exists). No charge; RLS + ownership enforced;
  decrypt happens in `packages/core` (ciphertext never leaves the server). Returns email/phone/linkedin (email
  gated) / statuses / line-type / `ownedTypes` / reveal history.
- **`POST /api/v1/contacts/revealed/batch`** (`getRevealedContactsBatch`) — hydrates the visible page's owned
  rows in one call (`visibleContactIds` cross-workspace guard + per-id ownership-gated decrypt). Keeps
  decryption bounded to what's on screen.

## Read projection

`MaskedContact` gains an optional **`revealedTypes`** (which of email/phone/full_profile the workspace owns —
non-PII, never the values), computed in the search projection (`searchRepository`, the only wired adapter) via
a correlated `array_agg` over `contact_reveals`, RLS-scoped. Drives the grid's per-row reveal state + badge
without decrypting the dataset.

## Client: one source of truth

`RevealStore` (React context) caches revealed PII + reveal state across the list and detail, with optimistic
in-grid updates from the reveal response, page-load hydration via the batch endpoint, per-type cost caching,
and a **synchronous re-entry guard** so a double-click can't double-charge. The list and detail derive reveal
state the same way — closing the four-way inconsistency (#4).

## Credits

- Single reveal: charge-by-verified-result (ADR-0013), counter under `FOR UPDATE`, paired `spend` ledger
  entry. Cost + balance shown before confirm.
- **Cross-type dedup**: a reveal charges only for the *newly-owned* field(s); the `full_profile` bundle price
  is preserved when both fields are new but decomposes to the single-field price on partial ownership. The
  `contactRepository.update` row-lock serializes concurrent same-contact reveals before the ownership read
  (a load-bearing invariant).

## Async bulk reveal (ADR-0029 reserve-then-settle)

New tables `reveal_jobs` (control + progress + lease accounting) and `reveal_job_rows` (per-contact work-list
+ outcome). Flow:

1. **Create** — resolve the selection (explicit ids OR select-all `criteria`) to visible ids, size the
   worst-case estimate, persist the control row (`awaiting_confirmation`) + one `queued` row per contact.
   Spends nothing.
2. **Confirm (the money gate)** — one atomic tx: status-pinned `awaiting_confirmation → running` **then** lease
   the worst-case ceiling (one `FOR UPDATE`, subscription-first — the anti-hot-lock). Insufficient rolls back.
3. **Drive** (worker) — plan row bands, enqueue one `chunk` per band.
4. **Chunk** (worker) — reveal each `queued` row through the gated `revealContact` in **`lease` settle-mode**
   (claim + record cost, but don't touch the counter — the lease reserved it), tally outcomes + atomic
   progress; periodic status re-check for prompt cancel/pause.
5. **Finalize** — on the last drained row, write the revealed CSV + status-pinned `running → completed` +
   **release** the unspent remainder (exactly-once via the status pin).

**Accounting invariant:** `lease(-ceiling) + release(+remainder)` nets the counter to exactly `-spent`, and the
ledger `SUM(delta)` matches — so `billing-recon` stays green. The subscription bucket is restored spend-first
(pure `computeReleaseSplit`, unit-tested). Cancel releases the remainder; retry-failed re-submits the failed
ids as a *new* job (its own clean lease cycle).

The whole path is **dark behind `BULK_REVEAL_ENABLED`** (producer + confirm route both gate) and serial
(concurrency 1), mirroring bulk-enrichment. Migration/RLS/queue integration are CI-verified.

## Realtime (Phase 4, planned)

Emit `reveal.completed` + credit-change on the **transactional outbox** in the reveal tx (ADR-0027), delivered
over an authenticated **SSE** stream per user/workspace (Redis pub/sub fan-out, RLS-scoped) — replacing the
`credits:changed` window event and 60s polling for live cross-tab/teammate/bulk-progress sync.

## Security posture

Role-gate the money endpoints (viewer denied); ownership + RLS on every revealed-data read; bounded PII egress
(batch only hydrates visible owned rows); audit `reveal`; reveal burst limiter; `reveal_jobs` RLS
workspace-scoped; SSE stream RLS-scoped (Phase 4). PII-in-list is a deliberate, reversible product choice.
