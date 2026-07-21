# 14 — Implementation Audit (living document)

> **Series:** [TruePoint Browser Extension](./README.md) · **Doc:** 14 · **Status:** ✅ living record
> · **Prev:** [`13-brand-and-credits`](./13-brand-and-credits.md)
>
> **Purpose:** the single living record of what from this series has actually shipped into
> `apps/extension` (+ its server seams), in the pattern of
> [`import-and-data-model-redesign/16-Implementation-Audit.md`](../import-and-data-model-redesign/16-Implementation-Audit.md).
> The design docs `00–13` are the target; this file is the only place shipped-status lives.
>
> **Why this doc exists:** the series was written "documentation-first" (README §3) on the premise that
> "the client build target (`apps/extension`) … does not yet exist" (README §0). That premise is now
> **stale** — a Manifest V3 client is built through **M1 + partial M2**, and the entire ADR-0045 auth
> path (client **and** backend) has shipped **dark**. Several docs still describe superseded or
> not-yet-built states; the [Drift log](#drift-log) reconciles each, with citations.
>
> **Update protocol:** a badge changes here first; a design doc is never edited to *pretend* something
> shipped. Stale claims are corrected in place (README §0, doc 12 §8, ADR-0043/0045) and logged below.

Legend: ✅ shipped & live · 🌒 built, dark (flag-off) · 💤 built, inert · 🟡 partial · 🔲 not built
(design only) · ❌ blocked on a missing prerequisite.

---

## Subsystem status

| Area | Design doc | Status | Evidence (file:line) |
|---|---|---|---|
| **Extension auth — client** (companion handoff · in-mem access JWT · rotating refresh · alarm pre-refresh · 401-retry) | `12` + ADR-0045 | 🌒 built, dark | `apps/extension/src/background/auth/{index,companionTab,refreshToken,tokenStore,account,errors}.ts`; API client `src/background/api/client.ts:47-127` |
| **Extension auth — backend** (mint/refresh/logout + handoff page + `EXTENSION_ORIGINS`) | `12 §8` | 🌒 built, dark **(was doc-12 "Phase A NET-NEW")** | `apps/auth/src/app/extension/{mint,refresh,logout}/route.ts` (mint drops `pa`: `mint/route.ts:83-90`); handoff `apps/web/src/app/auth/extension/page.tsx`; `packages/config/src/env.ts:38,760-763` |
| **Capture / ingest** (LinkedIn profile → SW queue → `POST /ingest`) | `06`/`02` | 🌒 built, dark (`CHROME_EXTENSION_ENABLED`) | `src/content/index.ts:15-33`; `src/background/{bus/index.ts:48-57,queue/captureQueue.ts,queue/scheduler.ts}`; `src/background/api/client.ts:92-127`; connector `packages/core/src/ingestion/connectors/chromeExtension.ts` |
| **Live credits** (SW `CreditsStore` · pill · reveal `balanceAfter` delta) | `13` | 🌒 built, dark | `src/background/credits/store.ts`; `src/ui/brand/CreditsPill.tsx`; `client.ts:144-162` (`/credits/balance`, `/credits/reveal-costs`) |
| **Reveal** (money path) | `06` | 🟡 **built but UNREACHABLE** — needs a `contactId` the client can't obtain (LOOKUP is a stub) | `src/background/bus/index.ts:59-78`; `client.ts:132-142`; blocked by X01/X02 (`apps/extension/README.md:46`) |
| **Side panel** (shell + Captured tab) | `08` | 🟡 partial — only "Captured" renders (local IndexedDB); `reveal`/`lists`/`sequences`/`ai` are `EmptyState` placeholders | `src/ui/panel/Panel.tsx:13-22,91-182,218-223` |
| **Popup** | `11`/`13` | 🌒 built, dark | `src/ui/popup/Popup.tsx:85-142` |
| **LinkedIn content script** (profile detect + SPA nav + hover card) | `01`/`02` | 🌒 built, dark — **profiles only** (`extract()` returns null off-profile) | `adapters/linkedin/index.ts:18-29,36-39,60-62`; SPA nav `content/observer.ts:1-40` (popstate + `MutationObserver`) |
| **Messaging bus** (Zod discriminated union · validate-and-drop) | `02` | 🌒 built, dark | `src/shared/messages.ts:13-100`; `src/background/bus/index.ts:11-20` |
| **LinkedIn identity → `contactId` resolver** | net-new | 🔲 **not built — the crux (X01)** | grep `linkedinPublicId` in `apps/api/src` = 0 hits; DB support exists (`packages/db/src/schema/contacts.ts:241-243`; `contactRepository.ts:403-514`) |
| **`GET /api/v1/me`** (display identity) | `12` gap #6 | 🔲 not built (X03) | called at `src/background/auth/account.ts:9`; only `/credits/me` exists (`billing/routes.ts:104`) |
| **`GET /api/v1/orgs`** (multi-org switch) | `12 §8` | 🔲 not built (X04) | `listOrgs` stub returns `[]` — `src/background/auth/index.ts:183-187` |
| **Realtime SSE** | `02` | 🌒 built, dark (`realtimeSse` flag off) | `src/background/eventStream.ts:22`; route `apps/api/src/app.ts:76`; default off `remoteConfig.ts:14-18` |
| **RemoteConfig signed fetch** (fail-closed) | `02`/`03` | 🟡 partial — caches locally; signature check is a marked TODO (X09) | `src/background/config/remoteConfig.ts:3-4,40-47` |
| **Telemetry upload** | `02`/`03` | 🟡 partial — events buffered in IDB, never uploaded (X10) | `src/background/telemetry/telemetry.ts:2` |
| **Options page** | — | 🔲 not built (absent — no `options_ui` in the manifest) | `manifest.config.ts` |
| **Company card + adapter** | `06`/`08` | 🔲 not built (X07) | `adapters/linkedin/index.ts:36-39` |
| **Quick actions** (add-to-list · add-note · server timeline) | `06`/`09` | 🔲 not built — **endpoints exist** (X06) | `POST /lists/:id/members` (`lists/routes.ts:134`); `POST/GET /contacts/:id/activities` (`activity/routes.ts:18,29`) |
| **Tasks / dialer / one-off email** | `06` | 🔲 not built — **no backend either** (X14, deferred) | no `tasks` table; calls are activity-log only; email is sequence-based |
| **Claude Skills library** | net-new | 🔲 not built → **in progress (X11 / P1)** | only the 6 `truepoint-*` skills exist under `.claude/skills/` |
| **Tests** (Vitest units + Playwright smoke) | `04` | 🔲 not built — **zero test files** (X12) | glob `apps/extension/**/*.{test,spec}.*` = 0; no `test` script in `package.json` |

---

## Gate-state tracker

| Gate / flag | State | Notes |
|---|---|---|
| `CHROME_EXTENSION_ENABLED` (env) | off (unset; explicit-`"true"`-only) | Gates the `chrome_extension` ingest connector (`packages/config/src/env.ts:567`); off ⇒ `/ingest` 400s "no connector". |
| `EXTENSION_ORIGINS` (env) | **unset** | Folds into `appOrigins()` (`env.ts:38,760-763`) → gates **both** API CORS **and** token-audience verification. Regex `^chrome-extension://[a-p]{32}$`. **Must be pinned to the published extension id** before any credentialed call succeeds — the single most important enablement flag. |
| `realtimeSse` (RemoteConfig flag) | off (default) | SSE stream stays dark (`remoteConfig.ts:14-18`). |
| `captureEnabled` / `bulkReveal` / `killSwitch` (RemoteConfig) | per remote config | `killSwitch` forces every `isEnabled(flag)` false (`remoteConfig.ts:40-47`). |
| Published extension id | **none yet** | Prerequisite for pinning `EXTENSION_ORIGINS` + the manifest `externally_connectable`. Needs a Chrome Web Store listing + the compliance sign-off (README §3, `06 §8/§10`). Tracked as X15. |

---

## Remaining backlog (gap register)

Stable IDs; later docs/commits cite them. The crux is **X01** — nothing today maps a LinkedIn identity
to a platform `contactId`, so reveal (built) is unreachable and every contact action is blocked.

| ID | Gap | Kind | Disposition |
|----|-----|------|-------------|
| **X01** | LinkedIn `publicId` → `contactId` **resolver endpoint** (`POST /api/v1/contacts/resolve`) — RLS-scoped, ownership-aware, returns `{status, contactId?, masked signals + linkedinPublicId}` | API+data+sec | **P2.** Read-only; reuses `uniq_contacts_ws_linkedin` + `contactRepository` match → **no migration**. |
| **X02** | Wire the extension `LOOKUP` handler to X01 | extension | **P3.** `src/background/bus/index.ts:44` TODO; currently hardcoded `unknown`. |
| **X03** | `GET /api/v1/me` (bare identity) — account name/email silently degrade to `null` | API | **P2.** |
| **X04** | `GET /api/v1/orgs` — unmounted | API | **P2.** |
| **X05** | Masked read projection omits `linkedinPublicId` | data | **P2** — resolver returns it (don't widen `maskedContactSchema`). |
| **X06** | Side-panel build-out: reveal/lists/sequences/ai tabs + server timeline; fix "open app" | UI | **P3/P4** — wire to existing `/lists`, `/contacts/:id/activities`, `/enrichment`. |
| **X07** | Content-script company/SalesNav adapters | integration | **P4.** SPA nav already handled. |
| **X08** | Manifest anti-fingerprint hygiene | security | **P4.** LinkedIn "BrowserGate" (Apr 2026) probes `web_accessible_resources` across ~6,200 known IDs. WAR is currently **absent** (good); if any is added, scope to `*.linkedin.com` + `use_dynamic_url:true`. Keep DOM reads minimal + user-initiated. |
| **X09** | RemoteConfig signed fetch, fail-closed | security | **P4.** |
| **X10** | Telemetry upload | ops | Deferred. |
| **X11** | Claude Skills library (three concern-split skills) | skills | **P1 (in progress).** |
| **X12** | No tests | test | **P4** (first units + one smoke). |
| **X13** | This audit doc + stale-claim reconciliation | docs | **P0 (this doc).** |
| **X14** | `tasks` entity + endpoints; dialer; one-off send-email | data+API | Deferred (net-new backend). |
| **X15** | Prod enablement (publish → pin `EXTENSION_ORIGINS` + `CHROME_EXTENSION_ENABLED`) | ops | Deferred (needs a published id + legal sign-off). |
| **X16** | **Interactive companion-window login for signed-out users** | extension | **Needs verification.** The shipped `companionTab.ts` opens a **background inactive tab** suited to *silent* verification of an existing `app.truepoint.in` session; a **visible** interactive-login surface (able to host MFA/WebAuthn per ADR-0045 §1) for a user who is *not* already signed in is not evident in the current code. Confirm on-device; if absent, add the visible-window path. |

---

## Drift log

Places where shipped code diverges from this series' design, with disposition. Every row is a fact with
a citation; "amend doc" edits happen at the doc's next touch (or inline here where noted).

| Date | Drift | Disposition |
|---|---|---|
| 2026-07-21 | **Auth backend is built** — doc `12 §8` "Phase A (NET-NEW)" and ADR-0045 §6 frame mint/refresh/logout + the handoff page + `EXTENSION_ORIGINS` as to-build; all exist (`apps/auth/src/app/extension/*`, `apps/web/src/app/auth/extension/page.tsx`). | Correct doc `12 §8` to "shipped, dark"; this audit is the source of truth. |
| 2026-07-21 | **Doc 12 gap-register evidence is refactored past** — it cites `auth/pkceFlow.ts` + `module.ts` (`12:145,148`), which no longer exist; auth is now `index.ts`+`companionTab.ts`+`refreshToken.ts`+`tokenStore.ts`+`account.ts`. Gaps #1/#2/#5/#7 are resolved exactly as doc 12 predicted (`12:152-155`); #3/#4 collapse to pinning `EXTENSION_ORIGINS` (config exists, value unset). | No doc edit — the pivot is complete; gaps closed by design. #6 (`GET /me`) survives → X03. |
| 2026-07-21 | **ADR-0043 §5 superseded** — auth is companion handoff, not `launchWebAuthFlow` PKCE (superseded by ADR-0045). **ADR-0043 §8** says "Preact + Zustand"; as-built is React 19 pages + a **vanilla-DOM Shadow-DOM** hover card, and **no Zustand** (plain classes + `useState`). | Annotate ADR-0043 §5/§8 at next touch (point §5 → ADR-0045; record the Preact/Zustand decision as not-taken). |
| 2026-07-21 | **ADR-0045 detail vs code** — (a) companion uses a background **tab** (`companionTab.ts`, `chrome.tabs.create({active:false})`), not a popup **window** (`chrome.windows.create({type:"popup"})`, ADR-0045 §1 / doc `12 §6.1`); (b) the refresh token lives in memory-backed `chrome.storage.session` (`refreshToken.ts`), not AES-GCM `chrome.storage.local` (ADR-0045 Decision 3 / doc `12 §6.2,§7`). | The `storage.session` choice is arguably **safer** (no token on disk, no key management) → **amend ADR-0045 Decision 3** to record it. The tab-vs-window point is the same open question as X16 (silent tab OK; interactive login likely needs a visible window) → resolve with X16. |
| 2026-07-21 | **Doc 06 stale endpoint** — maps live credits to `/credits/me`; code uses `/credits/balance`. | Already recorded in doc `13:37,65-66`; no further edit. |
| 2026-07-21 | **README premise stale** — README §0 ("the client build target … does not yet exist") and §3 ("No `apps/extension` code ships until this series is reviewed") are overtaken: an M1 client shipped **dark**. | Correct README §0 to point here; note the approach became "build dark behind flags," not "no code until sign-off." |

---

## Reading order for implementers

1. This doc (what's real) → 2. `12` + ADR-0045 (auth, as corrected here) → 3. `02`/`04` (architecture,
folder structure) → 4. `08`/`09` (UX + feature architecture) → 5. the three `truepoint-extension-*`
skills (once X11 lands) for the enforced build rules.
