# ADR-0043 — Browser extension architecture: MV3, least-privilege, thin-producer, compliant capture

- **Status:** Accepted
- **Date:** 2026-07-05
- **Related:** ADR-0009 (Sales-Nav human-in-the-loop link capture, never scrapes), ADR-0016 (dedicated
  auth origin + cross-domain token exchange), ADR-0021 (global master graph + overlay), ADR-0042 (reveal
  experience + async bulk), and the ingestion contract in `packages/types/src/ingestion.ts`.
- **Detail:** `docs/planning/chrome-extension/` (00–11 — engineering `00–05`, product `06–09`, auth & brand
  `10–11`). Builds on the product/compliance spec in
  `docs/planning/prospect-database-platform/06-Chrome-Extension-Capture.md`.
- **Companion ADR:** [ADR-0044](./ADR-0044-extension-authentication.md) locks the extension's authentication
  architecture (silent re-auth, no client refresh token).

## Context

TruePoint has the **server side** of a browser extension shipped and tested — the `chrome_extension`
ingestion connector (`packages/core/src/ingestion/connectors/chromeExtension.ts`), `POST /api/v1/ingest`
with a per-caller capture rate limit (`checkCaptureRate`), the reveal/enrichment endpoints, and the
`CHROME_EXTENSION_ENABLED` flag — but **no client build target exists**. To scope the client correctly we
reverse-engineered the installed **Apollo.io** extension (v15.1.1, MV3): a service-worker-centric
React/Redux app that requests `host_permissions: *://*/*`, injects large per-surface bundles at runtime,
and — critically — injects a **MAIN-world script that monkey-patches `XHR`/`fetch` to harvest LinkedIn's
private Voyager/Sales-Navigator/Recruiter APIs** from the user's session. That capture posture carries the
ToS/scraping exposure TruePoint's `06` spec and the security skill already reject. We need a locked
decision on how our extension is built before writing `apps/extension`.

## Decision

1. **Manifest V3, service-worker-as-hub.** One privileged service worker owns events, auth, the API
   client, the capture queue, scheduling, remote config, and telemetry; content scripts and UI are thin
   clients that message it. (MV2 is being removed; not a target.)

2. **Least-privilege permissions — never `*://*/*`.** Ship `activeTab` + a small static host allowlist
   (`*://*.linkedin.com/*` for v1); every other host is `optional_host_permissions` requested on a user
   gesture and revocable. `externally_connectable` is omitted or locked to `app.truepoint.in`; no
   `<all_urls>` web-accessible resources.

3. **Thin producer — no in-page enrichment, no DB, no provider keys.** The extension captures minimal
   evidence and `POST`s an ingestion envelope to `/api/v1/ingest`; the server runs
   validate → dedup → resolve → suppress → enrich → project. Idempotency is
   `hash(sourceUrl + captured fields)`, so re-capture is a server-side no-op.

4. **Compliant, user-initiated capture — reject MAIN-world interception.** We do **not** inject a
   MAIN-world script or read any site's private APIs. A per-site adapter (LinkedIn first) extracts only
   the **rendered, user-visible** profile the signed-in user opened, on an explicit user action, attaching
   `consent` + `sourceUrl` + `capturedAt`. Suppression is enforced server-side.

5. **Own auth via PKCE, in-memory short-lived token.** Login is PKCE against `auth.truepoint.in`
   (`chrome.identity.launchWebAuthFlow`), the access JWT lives in memory only (~15 min) with silent
   refresh; tenancy is pinned from verified token claims server-side, never sent in the body. No secrets on
   disk. (Mirrors `apps/web/src/lib/authClient.ts` + ADR-0016.)

6. **Survive the MV3 lifecycle.** The capture queue is **IndexedDB-backed**; all periodic work
   (queue drain, token pre-refresh, telemetry flush, config refresh) uses `chrome.alarms`, never
   `setInterval`. Every write is idempotent so a worker killed mid-flight recovers cleanly.

7. **Signed remote config for flags + kill switch only — extraction rules stay in-repo.** Unlike Apollo's
   remotely-tunable `apiSelectors`/version-router, our remote config is signature-checked and can only flip
   vetted feature flags or kill the extension; it can never swap extraction/behavior. Behavior in the
   store-reviewed build is the behavior that runs.

8. **Build/stack:** Vite + `@crxjs/vite-plugin`, TypeScript (strict), React 19 + `@leadwolf/ui` for
   extension pages, a tiny Preact + shadow-DOM hover-card for the in-page surface, Zustand (not Redux),
   `@leadwolf/types` for wire contracts. Depends only on `@leadwolf/types` (+ `@leadwolf/ui`);
   dependency-cruiser forbids importing `@leadwolf/db`/`@leadwolf/integrations`.

9. **Dark until legal sign-off.** Developed behind `CHROME_EXTENSION_ENABLED` + a per-tenant flag; GA is
   gated on the compliance sign-off in `06` §8/§10.

## Consequences

- **Positive:** minimal store-review and trust risk (no all-URLs, no private-API scraping); no new server
  tables (reuses the shipped seam); no client-side scale bottleneck (server does dedup/enrichment/limits);
  clean OAuth with no credential confusion; recoverable, idempotent captures; instant fleet kill switch.
- **Costs / trade-offs:** the extension captures **less** per profile than Apollo (only what the user
  sees, no bulk/search harvesting) — a deliberate compliance trade. Extraction is DOM-based and so more
  sensitive to LinkedIn markup changes, mitigated by reviewed updates + telemetry rather than remote
  selector pushes. A Firefox port is deferred (MV3 differences) behind a `chrome.*` abstraction seam.
- **Net-new work:** the whole `apps/extension` build target, plus the one auth wrinkle
  (`launchWebAuthFlow` redirect vs the web app's same-site redirect) and the drafted `GET /ingest/recent`
  read.

## Alternatives considered

- **Faithful Apollo clone (MAIN-world interception of LinkedIn private APIs).** Rejected: conflicts with
  `06` §3 and the security skill's final say; ToS/scraping exposure; unnecessary for the core value.
- **`*://*/*` for "capture anywhere" convenience.** Rejected in favor of `activeTab` + optional hosts;
  same capability, requested per-host, far lower blast radius and review friction.
- **In-page enrichment/dedup (thick client).** Rejected: would duplicate and diverge from the server
  pipeline, leak provider keys, and break centralized suppression/dedup.
- **MV2.** Rejected: deprecated/being removed.
