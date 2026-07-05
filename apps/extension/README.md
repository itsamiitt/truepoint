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
with RFC-9457 + idempotency, PKCE auth, IndexedDB capture queue + alarm-driven drain with backoff, remote
config, telemetry, dark SSE consumer); the LinkedIn adapter + navigation observer + shadow-DOM hover-card
with the capture flow to `/ingest`; the popup and a four-state panel.

**Stubbed / follow-up (clearly marked in code):**

- `LOOKUP` returns `unknown` — wire `POST /search/contacts` (import the `ContactQuery` schema from
  `@leadwolf/types`) for a real owned/known check.
- `RemoteConfig` caches flags locally — add the **signed** fetch + signature check (fail-closed).
- Feature modules beyond capture/reveal (lists, sequences, ai-assist, signals, crm-sync) per 09 §2.
- Reveal needs a `contactId`; today it appears once `LOOKUP`/SSE supplies one.
- Tests (Vitest unit + Playwright loaded-extension E2E) per 04 §3.
- The hover-card is docked (top-right) as the MVP surface; the badge-anchored variant is 08 §3.1.

## Guardrails (enforced by design)

Least-privilege permissions (no `*://*/*`); visible-DOM extraction only (no `fetch`/`XHR` patching);
in-memory short-lived token (never on disk); tenancy from JWT claims (never trusted from the client);
every capture idempotent + server-suppression-gated.
