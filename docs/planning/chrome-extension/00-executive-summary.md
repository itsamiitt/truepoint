# 00 — Executive Summary

> **Series:** [TruePoint Browser Extension](./README.md) · **Doc:** 00 · **Status:** ✅ Drafted
> · **Next:** [`01-apollo-teardown`](./01-apollo-teardown.md)

---

## 1. Purpose

This program answers two questions at once:

1. **How does Apollo.io's Chrome extension actually work** — architecture, LinkedIn detection, data
   capture, multi-site support, automation, browser-lifecycle handling, security, and performance —
   reverse-engineered from the installed build (v15.1.1, Manifest V3)?
2. **What should TruePoint build** — an enterprise-grade, Manifest V3 extension that delivers the same
   user value (capture a prospect from LinkedIn → it appears enriched in TruePoint) **without** adopting
   Apollo's compliance-risky techniques, and reusing the ingestion/reveal server seam TruePoint already
   shipped?

## 2. What Apollo is, in one paragraph

Apollo's extension is a **Manifest V3, service-worker-centric, React/Redux/Webpack** application with the
**broadest possible permissions** (`host_permissions: *://*/*` + `scripting`). It declares only two tiny
static content scripts (LinkedIn + HubSpot loaders); **all rich UI is injected at runtime** from the
service worker via `chrome.scripting.executeScript` as large per-surface React bundles
(`inject.bundle.js` is 3.96 MB). Its core capability is a **MAIN-world network interceptor**
(`networkCalls.bundle.js`) that **monkey-patches `XMLHttpRequest` and `fetch`** to harvest LinkedIn's
private APIs — Voyager (`/voyager/api/graphql`), Sales Navigator (`/sales-api/*`), Recruiter
(`/talent/*`) — directly from the logged-in user's session, normalizes the payloads into a contact schema
(`firstName/lastName/jobTitle/email/phone_number/organization_name/linkedin_url`), and relays them to
Apollo's backend at `extension.apollo.io/api/v1`. It bundles a Twilio softphone (dialer), an InboxSDK
Gmail integration, Salesforce/HubSpot/Google-Calendar sidebars, and telemetry to Sentry, Amplitude,
New Relic, Customer.io, and Pusher. Behavior is remotely tunable via `chrome.storage.local` (`apiSelectors`)
and a hosted `extension-version-router.json`.

Full teardown: [`01-apollo-teardown.md`](./01-apollo-teardown.md).

## 3. The fork — what TruePoint copies and what it rejects

TruePoint's own product spec ([`prospect-database-platform/06`](../prospect-database-platform/06-Chrome-Extension-Capture.md))
and the security skill already set the posture. Restated as an explicit fork:

| Apollo technique | TruePoint decision | Why |
|---|---|---|
| `host_permissions: *://*/*` granted at install | **Least-privilege**: `activeTab` + a small static allowlist of supported hosts; everything else via `optional_host_permissions` requested on demand | Store-review friction, user trust, blast-radius. |
| MAIN-world monkey-patch of `XHR`/`fetch` to read LinkedIn's private Voyager/SalesNav APIs | **Rejected.** Capture only what the signed-in user is *rendered* (the visible profile the user opened), via a scoped DOM adapter + explicit user action | ToS/scraping exposure ("BrowserGate", `06-Chrome-Extension-Capture` §3); no bulk/background harvesting. |
| Enrich + normalize + dedup in-page, then POST to backend | **Thin producer**: capture minimal evidence + consent + `sourceUrl`, `POST /api/v1/ingest`; the **server** validates → dedups → resolves → suppresses → enriches → projects | Keeps dedup/suppression/compliance correct and centralized; no provider keys on the client. |
| Remotely-tuned selectors + version-router that can change behavior silently | **Signed remote config** for feature flags only; extraction rules are versioned in-repo and reviewed; no silent behavior swaps | Anti-tamper, auditability. |
| Rides the user's LinkedIn cookie session by interception | **Own auth**: PKCE against `auth.truepoint.in`, in-memory Bearer JWT, silent refresh | No credential/session confusion; standard OAuth. |

We **do** copy the parts that are simply good engineering: MV3 + service worker, per-surface adapters, a
message-passing bridge between worlds, a job queue with retry/backoff, structured telemetry, and remote
feature flags (done safely).

## 4. What we're building (the target, in one paragraph)

A **Manifest V3** extension (`apps/extension`, `@leadwolf/extension`) built with **Vite + CRXJS** in the
existing Bun/Turbo/Biome monorepo, depending only on `@leadwolf/types` (the wire contracts) and
`@leadwolf/ui` (the design system). A **service worker** hosts a **browser-event manager**, an
**auth module** (PKCE + in-memory token + silent refresh, mirroring `apps/web/src/lib/authClient.ts`), a
**capture queue** (persisted to IndexedDB, drained with idempotent retry to `/api/v1/ingest`), and a
**secure API layer**. A thin **content-script** layer runs a **website-adapter framework**: per-site
adapters (LinkedIn first) detect the page type, watch SPA navigation, and — **on explicit user action** —
extract the visible profile into the shared envelope, attaching consent + `sourceUrl` + `capturedAt`. A
**hover-card / side-panel UI** (React, `@leadwolf/ui`) shows the four states (loading/empty/error/data),
the "saved / duplicate / suppressed" result, and the metered **reveal** action
(`POST /api/v1/contacts/:id/reveal`). Full design: [`02-target-architecture.md`](./02-target-architecture.md).

## 5. Headline recommendations

1. **Ship MV3 from day one** — MV2 is being removed from Chrome; there is no reason to build on it.
2. **Least-privilege permissions** — `activeTab` + static allowlist + optional origins. Do not ask for
   `*://*/*`; it is the single biggest store-review and trust liability.
3. **Reuse the server seam, don't rebuild it** — `/api/v1/ingest`, `/contacts/:id/reveal`,
   `/enrichment/:entity/:id`, the `chrome_extension` connector, and `CHROME_EXTENSION_ENABLED` already
   exist and are tested. The extension is a client for them.
4. **Capture is user-initiated and consent-gated** — no background scraping, no private-API interception.
   This is both a compliance requirement and a differentiator we can state publicly.
5. **Persisted, idempotent capture queue** — MV3 service workers are killed aggressively; the queue must
   survive worker death (IndexedDB) and re-capture must be a server-side no-op
   (`idempotencyKey = hash(sourceUrl + fields)`, already the `06` design).
6. **Own auth, in-memory tokens** — never store long-lived secrets in `chrome.storage`; PKCE + short-lived
   Bearer + silent refresh against the auth origin.
7. **Structured telemetry + kill switch** — Sentry-style error capture, product analytics, and a
   server-driven kill switch so the extension can be disabled without a store release.

## 6. Risk & compliance posture (summary)

- **Legal sign-off gates GA**, exactly as `06-Chrome-Extension-Capture` §8/§10 states. The MV3 build can be developed behind
  `CHROME_EXTENSION_ENABLED` and a per-tenant flag, but is not turned on for customers until legal signs
  off on the capture posture.
- **Store review**: least-privilege permissions + a clear single purpose ("capture the prospect you're
  viewing into your TruePoint workspace") materially de-risk Chrome Web Store review vs. Apollo's
  all-URLs footprint.
- **PII**: no PII is persisted in clear on the client; the capture queue stores the minimal captured
  fields transiently and is drained + cleared on success. Reveal returns are shown, not cached to disk.

## 7. How to read this series

The series has two halves: **engineering** (`00–05`) and **product** (`06–09`). Engineers building the
extension should read `02` → `03` → `04` → `05`. Reviewers and stakeholders evaluating the approach
should read `00` → `01` §7 (Apollo's security model) → `03` §1 (our security model) → `05` (roadmap).
Product readers (features, market fit, design) should read `06` (feature catalogue) → `07` (market gap
& differentiation) → `08` (UX / design language) → `09` (product/feature architecture). The teardown
(`01`) is the evidence base; the target (`02`) is the design; `03`/`04` are the standards; `05` is the
plan; `06`–`09` are the product surface.
