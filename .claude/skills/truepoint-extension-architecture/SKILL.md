---
name: truepoint-extension-architecture
description: >
  Governs the structure, build, and runtime shell of TruePoint's Manifest V3 browser
  extension (`apps/extension`) — the service-worker-as-hub topology, folder layout, the
  Vite + @crxjs build, the manifest, the message bus, storage tiers and the MV3 service-worker
  lifecycle, signed remote config / feature flags, packaging, release, and Chrome Web Store
  compliance. Use this skill whenever creating, moving, or reviewing any file under
  `apps/extension`, editing `manifest.config.ts` or `vite.config.ts`, adding a background
  module, a message type, a storage key, an alarm, or an extension surface (side panel, popup,
  options). It is one of three sibling extension skills: LinkedIn/content-script work is
  `truepoint-extension-linkedin`; auth/token/API-client work is `truepoint-extension-auth`.
  Anything that *renders* defers to `truepoint-design`; backend, tenancy, queues, and scale
  defer to `truepoint-platform`/`truepoint-data`; whether something is *safe* is
  `truepoint-security`'s final say. If the task touches the extension's build, manifest,
  service worker, messaging, storage, or release, this skill is active.
---

# TruePoint Extension — Architecture Skill

This skill governs **how the `apps/extension` client is structured and built** — the MV3 shell that
hosts every extension feature. It exists so every agent places code, wires messages, and manages the
service-worker lifecycle the same way, matching what already shipped (M1 + partial M2, dark).

Ground truth for what is built vs pending is **`docs/planning/chrome-extension/14-implementation-audit.md`**
(the living audit). The locked decisions are **ADR-0043** (MV3, least-privilege, thin producer) — read it
with doc 14's as-built annotations, because §5 (auth) is superseded by ADR-0045 and §8's "Preact + Zustand"
was not taken.

---

## Which Skill, When

The extension is covered by three sibling skills on orthogonal axes:

- **truepoint-extension-architecture** (this skill) — the shell: folder layout, build, manifest, the
  service worker, the message bus, storage/lifecycle, remote config, release, store compliance.
- **truepoint-extension-linkedin** — content scripts, site adapters, SPA-navigation detection, minimal
  DOM extraction, the anti-fingerprint/ToS posture, the hover card.
- **truepoint-extension-auth** — companion-window handoff, token lifecycle, the SW API client, the
  handoff threat model, and the `EXTENSION_ORIGINS`/`CHROME_EXTENSION_ENABLED` enablement gates.

Precedence (unchanged from `CLAUDE.md`): **security has final say** on anything that could leak a token or
expand the attack surface; **platform/data** own the server seam the extension consumes (it never reaches
past `/api/v1`); **design** owns anything that renders. This skill never overrides those.

---

## The seven rules

1. **Service-worker-as-hub.** One background service worker owns events, auth, the API client, the capture
   queue, scheduling, remote config, credits, and telemetry (`src/background/index.ts`). Content scripts and
   UI surfaces are **thin clients** that message it — they hold no tokens, no HTTP client, no business logic.

2. **Thin producer (ADR-0043 §3).** The extension captures minimal, user-visible evidence and `POST`s an
   ingestion envelope to `/api/v1/ingest`. It holds **no DB access, no provider keys, no in-page enrichment**.
   `.dependency-cruiser.cjs`'s `extension-stays-thin` rule forbids importing `@leadwolf/db`/`@leadwolf/integrations`
   — depend only on `@leadwolf/types` (wire contracts) and `@leadwolf/ui` (tokens CSS).

3. **Least-privilege manifest — never `*://*/*`.** Static host allowlist is `api.truepoint.in` +
   `*.linkedin.com`; anything else is `optional_host_permissions` on a user gesture. See `references/manifest.md`.

4. **Survive the MV3 lifecycle.** The service worker is killed ~30s after its last event. All periodic work
   uses `chrome.alarms`, **never `setInterval`**; the capture queue is IndexedDB-backed; every write is
   idempotent so a worker killed mid-flight recovers. See `references/service-worker-lifecycle.md`.

5. **Typed message bus, validate-and-drop.** Every cross-context message is a Zod discriminated-union member;
   the SW validates each inbound message and drops unknowns. See `references/messaging.md`.

6. **No remotely-hosted code (MV3 hard rule).** All logic ships in the store-reviewed bundle. Signed remote
   config can flip **vetted flags or kill the extension** — it can never change extraction or behavior
   (ADR-0043 §7). See `references/build-release-and-store.md`.

7. **Reuse tokens, not the component barrel.** Extension surfaces import `@leadwolf/ui/tokens.css` (and
   `?inline` for Shadow DOM) and read `var(--tp-*)`; they do **not** pull the Tailwind-dependent shadcn
   components into the Vite build. See `references/ui-surfaces.md`. Anything that renders defers to
   `truepoint-design`.

---

## Folder layout (as-built)

```
apps/extension/
  manifest.config.ts      # typed MV3 manifest (defineManifest)
  vite.config.ts          # Vite 6 + @crxjs/vite-plugin + react
  src/
    background/           # the service worker (hub): index.ts + api/ auth/ bus/ config/ credits/
                          #   events/ queue/ telemetry/
    content/              # LinkedIn content script: index.ts, observer.ts, extract/, adapters/, hovercard/
    ui/                   # panel/ (side panel), popup/, brand/ — React 19 pages, inline-styled tokens
    shared/               # messages.ts (bus contract), client.ts, env.ts, idb.ts, storage.ts, types.ts
    i18n/                 # locales
```

A new background concern is a folder under `src/background/` with an `index.ts` barrel; a new surface is a
folder under `src/ui/` with its own `index.html` + `main.tsx`; a new message is a new union member in
`src/shared/messages.ts` (see `references/messaging.md`).

---

## Reference Files

Read only the one that matches your task.

| Task | Read |
|---|---|
| Editing `manifest.config.ts` — permissions, hosts, CSP, surfaces | `references/manifest.md` |
| Background work, alarms, the capture queue, worker death | `references/service-worker-lifecycle.md` |
| Adding/altering a message type or the bus | `references/messaging.md` |
| Where a piece of state/data lives (memory/session/local/IDB) | `references/state-and-storage.md` |
| The Vite/CRXJS build, packaging, versioning, Web Store review | `references/build-release-and-store.md` |
| A side panel / popup / options surface | `references/ui-surfaces.md` |

> Companion skills: `truepoint-extension-linkedin`, `truepoint-extension-auth`, and — for anything visual —
> `truepoint-design`. The server seam is owned by `truepoint-platform`/`truepoint-data`; safety by
> `truepoint-security`. Status truth lives in `docs/planning/chrome-extension/14-implementation-audit.md`.
