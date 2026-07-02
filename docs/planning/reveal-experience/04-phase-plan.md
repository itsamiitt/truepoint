# Reveal Experience — Phased Roadmap & Status

Priority: correctness/security → highest-friction UX → enterprise depth → realtime → polish. Phases 0–2 are
locally gate-verifiable; Phases 3–4 add migrations/RLS/integration verified in CI (no local Docker).

## Phase 0 — Backend correctness & security hardening ✅ shipped
- Role-gate `POST /:id/reveal` + `PATCH /:id` to member+ (viewer denied).
- Cross-`reveal_type` dedup (`revealCharge`, unit-tested) — no double-charge.
- `AbortController` timeouts on Reacher/Twilio verifiers (config `REVEAL_VERIFY_TIMEOUT_MS`).
- Credit-back covers `full_profile` email bounces; refunds the earliest email-covering claim (never a phone
  charge). *(Adversarial-review fix.)*
- Reveal burst limiter (`REVEAL_RATE_PER_MIN`).
- Gates: biome, typecheck, unit tests. **On main.**

## Phase 1 — Persistent revealed-data read ✅ shipped — fixes #2, #3
- `getRevealedContact` + `GET /:id/revealed` (no-charge, ownership-checked). No new audit action → no migration.
- Record drawer renders real email/phone/LinkedIn inline (copy, color-coded badge, phone line-type, source +
  reveal history); "View revealed" is an instant read, not a re-charge.
- **On main.**

## Phase 2 — In-list reveal + one source of truth + cost ✅ shipped — fixes #1, #4, #5, #6, #7, #9, #10 (non-realtime)
- `revealedTypes` on `MaskedContact` + search projection; `/contacts/revealed/batch`; `/credits/reveal-costs`.
- `RevealStore` (optimistic + hydration + re-entry guard + cost cache); `RevealCell` in-grid reveal with cost;
  single-reveal cost-before-confirm; color-coded badges.
- **On main.**

## Phase 3 — Enterprise async bulk reveal ✅ shipped (dark) — fixes #8
- `reveal_jobs`/`reveal_job_rows` schema + migration `0050` + RLS + repo; credit **lease/release** primitives
  (pure `computeReleaseSplit` unit-tested).
- Core: estimate, create/confirm, drive/chunk runner (`lease` settle-mode + finalize/release).
- Wiring: BullMQ producer + worker (`BULK_REVEAL_ENABLED`, serial, DLQ) + `/reveal-jobs` API
  (create/list/get/confirm/cancel/pause/resume/failed/download).
- Frontend: `BulkRevealJobDialog` (create → estimate → confirm → progress → CSV), select-all-matching enabled,
  graceful dark-launch.
- **On main, dark behind `BULK_REVEAL_ENABLED`.** Enable = a separate CI-parity-gated step (verify the
  migration applies, RLS/integration tests pass, then flip the flag).

## Phase 4 — Realtime sync (outbox + SSE) ✅ shipped (dark) — fixes #10 fully
- `event_outbox` (migration 0051) + `eventOutboxRepository`; `reveal.completed` appended IN the reveal tx
  (crash-safe); best-effort `reveal.job.progress`/`.completed` + `credits.changed` on the bulk path.
- Leaderless relay (`apps/workers/realtimeRelay.ts`, FOR UPDATE SKIP LOCKED) → Redis pub/sub.
- Authenticated, workspace-scoped SSE gateway (`GET /api/v1/events/stream`, streamSSE, mounted before compress).
- Web `lib/eventStream` fetch-reader (Bearer token → not native EventSource) + shell `RealtimeBridge` →
  reconciles balance + reveal state onto the existing window-event bus; polling stays as the fallback.
- **On main, dark behind `REALTIME_SSE_ENABLED`.** Enable = CI-verify migration 0051 + RLS + the
  outbox→relay→SSE integration, then flip the flag (the relay registers, the stream opens, the client connects).

## Phase 5 — Performance, accessibility & QA polish ⏳ planned
- Redis cache for revealed-data reads (invalidated by `reveal.completed`); virtualized table; skeletons;
  keyboard shortcuts + context menu; WCAG 2.2 AA pass; full test sweep.

## Enabling Phase 3 in production (checklist)
1. CI applies migration `0050` cleanly (idempotent; hand-authored — never `drizzle-kit generate`).
2. RLS/isolation tests for `reveal_jobs`/`reveal_job_rows` pass.
3. Lease/settle/release accounting integration test passes; `billing-recon` asserts `balance == SUM(delta)`.
4. Flip `BULK_REVEAL_ENABLED=true`; the worker registers, the confirm route opens, the producer enqueues.
5. Optional: add a per-tenant `bulk_reveal_enabled` flag for gradual rollout (mirrors bulk-enrichment).
