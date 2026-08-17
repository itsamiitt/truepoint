# 01a — Apollo.io Extension Teardown, refreshed against the INSTALLED build (v16.3.1)

> **Series:** [TruePoint Browser Extension](./README.md) · **Doc:** 01a (addendum to
> [01 — Apollo Teardown](./01-apollo-teardown.md)) · **Status:** ✅ Forensic audit of the on-disk build
> **Date:** 2026-08-17 · **Source:** the extension installed in this profile
> (`…/Extensions/alhgpfoeiimagjlnfekdhkjlkiomcapa/16.3.1_0`) — read-only teardown of the shipped bundles.

Doc 01 tore down an earlier Apollo build and its findings ("injectLINetwork loader → MAIN-world
XHR/fetch monkey-patch → `postMessage` bridge → Voyager capture") **still hold**. This addendum records the
16.3.1 specifics verified against the actual installed source, and the compliant-vs-not verdict that shapes
the TruePoint ecosystem work (docs/planning ecosystem; ADR-0043/0046).

## Manifest (v16.3.1)

- **MV3.** `content_scripts` inject `js/…injectLINetwork….js` on `*://*.linkedin.com/*` at
  `run_at:document_start` (isolated world — **no `world:"MAIN"` key**); a sibling `injectHSNetwork` on
  `*.hubspot.com/*`. Permissions: `scripting`, `tabs`, `webNavigation`, `contextMenus`, `notifications`,
  `storage`, `sidePanel` — **NOT `webRequest`**. `host_permissions:*://*/*`.
- CSP `connect-src` allowlists `app.apollo.io` / `extension.apollo.io` (+ Sentry / Amplitude / Customer.io /
  New Relic / Twilio / Pusher) — the capture-upload + telemetry destinations.

## Mechanism (verified in the bundles)

1. **MAIN-world injection = DOM `<script>` self-injection, NOT `scripting.executeScript({world})`.** The
   isolated `injectLINetwork` does
   `e=document.createElement("script"); e.src=chrome.runtime.getURL("js/networkCalls.bundle.js"); (document.head||documentElement).appendChild(e)`
   guarded by `window.__injectLiNetwork__`; a second copy is injected into LinkedIn's Strict-Mode **preload
   iframe** (`iframe[src*="preload"]`) after 3s.
2. **Read-only fetch/XHR monkey-patch** in `networkCalls.bundle.js`: `window.fetch` wrapped with
   `s.clone().json().then(...)` returning the original response untouched; `XMLHttpRequest.prototype.open`
   stashes `_url`, `.send` wraps `onreadystatechange`, `readyState===4` reads `.response`. Pure mirroring.
3. **URL allowlist keyed by surface** — `regular:["/voyager/api/graphql"]`,
   `sales_navigator:["/sales-api/salesApiLeadSearch","…salesApiPeopleSearch","…salesApiProfiles/(profileId:"]`,
   `recruiter:["/talent/…"]`, then a second operation-name filter (search vs profile).
4. **Buffer + bridge:** parsed JSON in page globals `window.LI_DATA` / `HISTORY_DATA` (company-people
   paginate by append); **pull-based `window.postMessage`** (`getLIAPIData` → `LIDataResponse`), the isolated
   side polls `setInterval(…,1000)` and forwards nav to the SW via `chrome.runtime.sendMessage({update_url})`.
   Whole path gated by `engageLiKillSwitch`.
5. **Upload = extracted structured fields** to `/linkedin_chrome_extension/parse_search_page` (+
   `/contacts/match`, `/mixed_people/search`) on Apollo's own session; **Sales-Nav/Recruiter payloads are
   AES-encrypted client-side**, regular LinkedIn plaintext. No LinkedIn cookies/tokens forwarded.
6. **Passive** — interceptors fire only from the user's own completed requests; no synthesized calls, no
   auto-pagination/scroll, no crawl. The only `setInterval` is the 1s bridge poll.

## What TruePoint reuses vs does differently

| Aspect | Apollo (observed) | TruePoint |
|---|---|---|
| Injection | DOM `<script>` MAIN-world shim | Same mechanism, **gated by ADR-0046** kill-switch + per-tenant flag + legal/DPIA (the fuller URL-extract path only); the DOM-anchor URL harvest needs no MAIN-world at all |
| Surface detection | regular/sales-nav/recruiter allowlist | in-repo `/sales/*` + `/in/` recognition |
| **What is captured** | full Voyager response **bodies** (names, headlines, profile fields) | **URLs only** — our hard constraint bars body scraping. The DATA comes from the **licensed `linkedin_api` server-side fetch**, never by mirroring LinkedIn's private-API bodies |
| Kill-switch | `engageLiKillSwitch` remote prop | env `CHROME_EXTENSION_ENABLED` + per-tenant flag + the new `LINKEDIN_LINK_CAPTURE_ENABLED`/`LINKEDIN_LINK_FETCH_ENABLED` |
| Obfuscation | client-side AES on exfiltrated bodies | unnecessary — URL-only capture has no sensitive body |
| Provenance | silent `window.LI_DATA` accumulation | explicit consent-logged capture → lawful-basis provenance event (A-01) |
| Passivity | passive observer, no replay | same — visible-DOM anchor harvest + user-initiated only |

**Verdict:** Apollo's passive-observer + kill-switch + surface-detection architecture is a clean, reusable
pattern; its full-body capture is exactly what our hard constraint and ADR-0046 firewall forbid. TruePoint's
Model B (URL harvest + licensed fetch) takes the good pattern and drops the non-compliant body capture.
