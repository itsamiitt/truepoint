---
name: truepoint-extension-linkedin
description: >
  Governs how TruePoint's browser extension integrates with LinkedIn (and future supported
  sites) from the content script — page detection, the per-site adapter framework,
  single-page-app navigation detection, minimal user-visible DOM extraction, the injected
  Shadow-DOM hover card, and the anti-fingerprint / Terms-of-Service posture that keeps the
  extension a compliant citizen rather than a scraper. Use this skill whenever creating or
  editing anything under `apps/extension/src/content` — the content script, `observer.ts`, the
  `adapters/` registry or a site adapter, `extract/`, or `hovercard/` — or when deciding what
  the extension is allowed to read off a page. It is one of three sibling extension skills:
  the MV3 shell/build is `truepoint-extension-architecture`; auth/tokens/API is
  `truepoint-extension-auth`. Anything about how the hover card looks defers to
  `truepoint-design`; whether an extraction is *safe or compliant* is `truepoint-security`'s
  final say. If the task touches the content script, a site adapter, SPA detection, DOM
  extraction, or the in-page surface, this skill is active.
---

# TruePoint Extension — LinkedIn Integration Skill

This skill governs the **content-script side** of the extension: recognizing the page the signed-in user is
on, extracting the minimum needed to identify the prospect, and doing so without becoming what LinkedIn's ToS
and our own security skill forbid — a scraper. The governing decision is **ADR-0043 §4** (compliant,
user-initiated capture; reject MAIN-world interception), and the operative external reality is LinkedIn's
active extension-detection program (see `references/anti-fingerprint-and-tos.md`).

Status of what's built vs pending is in `docs/planning/chrome-extension/14-implementation-audit.md` — today
the LinkedIn adapter handles **profiles only**; company/SalesNav adapters are a known gap (X07).

---

## Which Skill, When

- **truepoint-extension-linkedin** (this skill) — content script, site adapters, SPA navigation, DOM
  extraction, hover card, ToS/fingerprint posture.
- **truepoint-extension-architecture** — the SW, the message bus this script talks to, the manifest that
  scopes where this script runs.
- **truepoint-extension-auth** — nothing on the content-script path holds a token; the SW does the auth'd call.

The content script is a **thin, untrusted-adjacent client**: it runs in a foreign page's neighborhood, holds
no secrets, and asks the service worker for everything (see `truepoint-extension-architecture/references/messaging.md`).

---

## The five rules

1. **Capture only what the signed-in user is actively viewing, on their action** (ADR-0043 §4). The extension
   identifies the one profile the user opened; it does not crawl connections, search results, or backgrounded
   tabs. Attach `consent` + `sourceUrl` + `capturedAt` to every capture; suppression runs server-side.

2. **Read the rendered, user-visible DOM only — never a private API.** Do **not** inject a MAIN-world script,
   monkey-patch `fetch`/`XHR`, or read Voyager/Sales-Navigator/Recruiter endpoints. That is the Apollo
   anti-pattern ADR-0043 rejects and the exact behavior LinkedIn detects and enforces against.

3. **Extract the minimum identity, then let the server do the rest.** The join key is the LinkedIn public
   identifier (`/in/<publicId>`). Send it to the SW to resolve against our own data; do not scrape a full
   profile to reconstruct data we already license server-side. See `references/dom-extraction.md`.

4. **Handle the SPA.** LinkedIn never full-reloads; detect navigation via History-API + `popstate` +
   a debounced `MutationObserver`, and re-run the adapter on a real path change. See `references/spa-navigation.md`.

5. **Minimize the fingerprint surface.** Keep `web_accessible_resources` absent (or scoped + `use_dynamic_url`),
   keep host permissions tight, and keep the injected footprint to the Shadow-DOM hover card. See
   `references/anti-fingerprint-and-tos.md`.

---

## Reference Files

Read only the one that matches your task.

| Task | Read |
|---|---|
| Adding/altering a site adapter or the registry | `references/site-adapters.md` |
| Detecting navigation on a single-page app | `references/spa-navigation.md` |
| Deciding what to read off the page / a selector | `references/dom-extraction.md` |
| Permissions footprint, ToS, LinkedIn detection | `references/anti-fingerprint-and-tos.md` |
| The injected in-page hover card | `references/hovercard.md` |

> Companion skills: `truepoint-extension-architecture` (the shell), `truepoint-extension-auth` (the auth'd
> call the SW makes with what you extract), `truepoint-design` (how the hover card looks),
> `truepoint-security` (final say on whether an extraction is safe/compliant).
