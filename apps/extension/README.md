# @leadwolf/extension — TruePoint browser extension (MV3)

The in-page prospect-capture client. **Thin producer**: it captures only the visible profile the
signed-in user opened (human-in-the-loop, no scraping), enqueues an idempotent envelope to
`POST /api/v1/ingest`, and lets the server pipeline do validate → dedup → suppress → enrich → project.
No provider keys, no DB, no MAIN-world injection, least-privilege permissions.

Design docs: [`docs/planning/chrome-extension/`](../../docs/planning/chrome-extension/) (00–09) +
[`ADR-0043`](../../docs/planning/decisions/ADR-0043-chrome-extension-architecture.md).

## Scripts

```bash
bun run --filter @leadwolf/extension typecheck   # tsc --noEmit over src
bun run --filter @leadwolf/extension build        # vite + CRXJS → dist/ (loadable unpacked)
bun run --filter @leadwolf/extension dev          # vite dev with HMR
bun --cwd apps/extension scripts/gen-icons.mjs    # regenerate manifest icons
```

Load `apps/extension/dist` via `chrome://extensions` → Developer mode → **Load unpacked**.

## Layout (matches 04 §2 / 09 §2)

```
src/
  background/   service worker: bus · api · auth (PKCE) · queue+scheduler · config · telemetry · eventStream
  content/      isolated-world: adapters (linkedin) · observer · extract · hovercard (shadow DOM)
  ui/           react surfaces: popup · panel
  shared/       messages (Zod) · storage (chrome.storage + IndexedDB) · types · client · env
  i18n/         message catalog + loader
```

## Status — first increment (M0 + M1 spine)

**Working end-to-end:** MV3 manifest + build config; the service-worker runtime (message bus, API client
with RFC-9457 + idempotency, the ADR-0045 companion-window auth, IndexedDB capture queue + alarm-driven
drain with backoff, local feature flags, telemetry, dark SSE consumer); the LinkedIn adapter + navigation
observer + shadow-DOM hover-card with the capture flow to `/ingest`; the popup; and the **Profile
Intelligence Panel**.

**The panel** (`src/ui/panel/`, 2026-08-22) is two tabs — Prospect and Company — over ONE server read,
`POST /api/v1/contacts/lookup/intel`, which composes the masked Layer-0 profile, the employer's
firmographics and headcount series, and this workspace's own contact row. It hydrates on open from the
active tab's URL (`GET_SUBJECT`) rather than waiting for a content-script broadcast, and follows navigation
and tab switches from there. The signals list is derived by a pure, unit-tested function
(`intel/deriveSignals.ts`) in which **every row cites the field, the basis and the grade it came from** —
nothing is inferred beyond the record, and there is no model, no scoring and no intent data.

**Stubbed / follow-up (clearly marked in code):**

- `RemoteConfig` caches flags locally — add the **signed** fetch + signature check (fail-closed).
- Notes + the server activity timeline on the panel (the endpoints exist; add-to-list is built).
- A per-contact **verify** endpoint — the panel shows verification recency but cannot trigger one, because
  no such endpoint exists (enrichment *finds* a value; it does not verify one).
- No DOM/E2E suite yet: the tests here are pure unit tests (`bun test`) plus the server-side itest.
- The hover-card is docked (top-right) as the MVP surface; the badge-anchored variant is 08 §3.1.
- Company **DOM** extraction (X07) remains deliberately unbuilt — the Company tab resolves from the URL
  server-side, so no company page is ever read.

## Guardrails (enforced by design)

Least-privilege permissions (no `*://*/*`); visible-DOM extraction only (no `fetch`/`XHR` patching);
in-memory short-lived token (never on disk); tenancy from JWT claims (never trusted from the client);
every capture idempotent + server-suppression-gated.
