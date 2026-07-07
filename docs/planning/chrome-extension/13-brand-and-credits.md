# 13 — Brand implementation + live credits (build record)

> **Status:** ✅ Implemented in `apps/extension` · **Type:** Implementation record
> · **Depends on:** `08` (UX/design language), `11` (branding plan), `Guidelines/` (Brand Identity + Brand Kit)

This doc records **what actually shipped** for the extension's brand/UI and its **live credit balance** —
the concrete mapping from the brand guidelines to the code, and the exact data-flow that fetches credits
from the main application. `11` is the *plan*; this is the *implementation*.

## 1. Brand system → code

**Single source of truth for tokens.** The extension does **not** define its own design tokens — it imports
`@leadwolf/ui/tokens.css` (already a workspace dep), which defines every `--tp-*` variable to the exact
Brand-Kit values. The rule from `Guidelines/`: **"Cobalt fills, Ink type"** — Cobalt `--tp-cobalt #2563C9`
appears only as a *fill* (the mark's apex, active states, the connected check), never as text; Ink
`--tp-ink #111827` drives all type and the primary button; hierarchy comes from weight + size, never color.

| Brand element | Code |
|---|---|
| Tokens (ink/surface/hairline/cobalt/semantic/radius/motion) | `@leadwolf/ui/tokens.css`, imported via `src/ui/brand.css` |
| Fonts — Geist + Geist Mono | self-hosted `src/assets/fonts/{Geist,GeistMono}-Variable.woff2` (from the `geist` pkg), `@font-face` in `brand.css`; MV3 CSP blocks CDN fonts, so `font-src 'self'` is added to the manifest |
| The mark (three chevrons; apex = Cobalt) + wordmark (True 400 / Point 800) | `src/ui/brand/Mark.tsx` (`Mark`/`Wordmark`/`Lockup`) |
| Credit balance (mono, tabular, low-balance state) | `src/ui/brand/CreditsPill.tsx` |
| Toolbar/app icons — the mark on a white rounded tile | `scripts/gen-icons.mjs` renders 16/32/48/128 from the brand geometry (was solid cobalt squares) |
| Voice ("Aim true.", find/reveal/score/pursue, verified) | `src/i18n/locales/en.ts`; manifest `name`/`description`/`action.default_title` |

Surfaces (`ui/popup/Popup.tsx`, `ui/panel/Panel.tsx`) render the `Lockup` header, Geist body type, Geist
**Mono** for labels/scores/credits/verified, hairline dividers, `--tp-radius-card` cards, and the active tab
as a soft Cobalt fill. Signed-out = the mark + "Aim true." + an Ink "Sign in".

## 2. Live credits — the data flow

The credit balance is fetched from the main application's API and cached in the service worker, then pushed
to the surfaces. **No polling**; freshness comes from open-time refresh + the reveal delta.

**Endpoints** (`apps/api/src/features/billing/routes.ts`, tenant-scoped, any role, Bearer):
- `GET /api/v1/credits/balance` → `{ balance }` — the balance read (`ApiClient.credits()`).
- `GET /api/v1/credits/reveal-costs` → `{ email, phone, full_profile }` — per-type cost (`ApiClient.revealCosts()`).
- `POST /api/v1/contacts/:id/reveal` returns `{ …, creditsCharged, balanceAfter }` — the authoritative
  post-charge balance (`billing.revealResponseSchema`).

**Service-worker cache** — `background/credits/store.ts` (`CreditsStore`): holds `{ balance, costs }`,
single-flight `refresh(force?)` with a 30 s staleness window, `applyReveal(balanceAfter)` (in-place update,
no round-trip), and `clear()` on sign-out. `getState()` merges `credits.balance` onto the `AuthState`.

**Triggers → broadcast** (`STATE_CHANGED`, which the popup/panel subscribe to):

```
sign-in (applyHandoff / init)   → credits.refresh(true)          → broadcast
popup/panel open (GET_STATE)    → return cached + stale refresh  → broadcast on change
reveal succeeds (REVEAL)        → credits.applyReveal(balanceAfter) → broadcast   (instant pill update)
switch workspace/org            → credits.refresh(true)          → broadcast
sign-out (AUTH_LOGOUT)          → credits.clear()                → broadcast
```

**Degradation:** any failure (offline / signed-out / 401) leaves the balance `null` → the pill shows "—" and
never throws; a low balance (≤ 20) renders in `--warning` with a "Low balance" hint.

**Why not SSE:** the app has a realtime backbone, but the extension is a thin producer — pull-on-open plus the
server-authoritative reveal delta keep the pill correct without holding an SSE connection open in the worker.
(Left as a future option if cross-device spend needs sub-second reflection.)

## 3. Fixed en route

- `ApiClient.credits()` previously called `GET /credits/me` (which returns `{ plan }`, not `{ balance }`) → it
  always returned `null`; repointed to `/credits/balance`.
- `getState()` never merged credits, and `reveal()` discarded `balanceAfter` → both now wired.
