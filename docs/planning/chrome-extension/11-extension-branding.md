# 11 — Extension Branding & Visual Language

> **Series:** [TruePoint Browser Extension](./README.md) · **Doc:** 11 · **Status:** ✅ Drafted
> · **Prev:** [`10-extension-authentication`](./10-extension-authentication.md)

The branding plan for `apps/extension`, so it reads as a **native part of TruePoint** — the same tokens,
mark, type, and voice as `app.truepoint.in`. This complements the design-language doc
[`08`](./08-ux-design-language.md) (surfaces + states) with the **brand** layer (logo, color, type, voice,
per-surface application). Everything here is grounded in the shipped brand kit — do not invent new brand
elements.

> **Source of truth:** `packages/ui/src/tokens.css` (`--tp-*` tokens), `Guidelines/assets/` (mark + icons),
> `docs/planning/brand-identity.md` (usage rules + voice), and the auth app's `apps/auth/src/shared/*`
> (the visual pattern the extension's auth surface mirrors). The brand is **TruePoint**; the npm scope is
> `@leadwolf/*` — both correct (`CLAUDE.md`). The retired "wolf" metaphor is dead — do not use it.

---

## 1. Brand foundations

### 1.1 The mark
The TruePoint mark is **three stacked chevrons converging on an upward apex** (a "true point" / rising
signal), on a `0 0 100 100` viewBox, `stroke-width 8.5`, round caps/joins, `fill:none`:
- **Top/apex chevron = Cobalt `#2563c9`** — the only color in the whole brand.
- **Middle + bottom chevrons = Ink `#111827`.**

Ready-made assets in `Guidelines/assets/`: `truepoint-mark.svg` (default), `truepoint-mark-mono.svg`
(all-ink), `truepoint-mark-white.svg` (white strokes + `#5B8DEF` apex, for dark backgrounds),
`truepoint-lockup.svg` / `truepoint-lockup-white.svg`; icon set in `Guidelines/assets/icons/`
(`favicon-16/32/48.png`, `icon-192/512.png`, `icon-dark-512.png`, `icon-maskable-512.png`,
`apple-touch-icon-180.png`, `mark-master-1024.png`). The lockup is `BrandLockup.tsx` (mark `h-6 w-6` +
wordmark, `gap 8px`, `items-center`).

The **wordmark** "TruePoint" is Geist, one color (Ink), tight tracking (`-0.02em`), with a **weight shift not
a color shift**: `True` Regular 400 + `Point` ExtraBold 800.

**Usage rules** (brand-identity.md §6/§10): clearspace ≥ wordmark cap-height; min glyph 16px; the mark may sit
on `#111827` or `#FFFFFF` only (use the white/tint variant on dark). **Don'ts:** no gradients, drop shadows,
recoloring, stretching/rotating, second accent color; **Cobalt is never body text**. UI icons throughout are
**Lucide** (thin, muted grey) — the chevron motif lives **only** in the logo.

### 1.2 Color (from `tokens.css`)
- **Brand accent — Cobalt (fills / active / the mark apex only, NEVER text):** `--tp-cobalt #2563c9`,
  `--tp-cobalt-700 #1e4fa3`, `--tp-cobalt-50 #e9f0fc` (tint fill), `--tp-cobalt-tint #5b8def` (apex on dark).
- **Ink / text:** `--tp-ink #111827`, `--tp-ink-2 #374151`, `--tp-ink-3 #6b7280`, `--tp-ink-4 #9ca3af`,
  `--tp-on-fill #fff`.
- **Surfaces:** `--tp-surface #fff`, `--tp-surface-2 #f9fafb` (auth page bg), `--tp-surface-3 #f4f5f7`.
- **Borders:** `--tp-hairline #f0f0f0`, `--tp-hairline-2 #e5e7eb`.
- **Primary button = Ink (not accent):** `--tp-btn #111827`, hover `--tp-btn-700 #0b1220`.
- **Status (status only):** `--success #16a34a`, `--warning #d97706`, `--danger #dc2626`.
- **Focus ring:** `--focus-ring #9ca3af` (2px outline + 2px offset).

### 1.3 Typography, spacing, radius, elevation, motion
- **Type — Geist / Geist Mono.** Hierarchy by weight+size, never color. Body 14px; dense 13px; titles
  16–26px semibold; mono for data/IDs/credits; tabular-nums on numerics.
- **Spacing (4px scale):** `--tp-space-1..8` = 4/8/12/16/20/24/32.
- **Radius:** `--radius 8px` (buttons/inputs/cards/overlays), `--tp-radius-sm 6px` (chips), `--tp-radius-card 14px`.
- **Elevation — one soft shadow per overlay:** `--tp-shadow-popover`, `--tp-shadow-dialog`, `--tp-shadow-drawer`,
  `--tp-shadow-card`.
- **Motion (transform/opacity, <300ms):** `--tp-ease-out`, `--tp-duration-fast 120ms` / `--tp-duration 180ms`;
  keyframes `tp-fade-in`/`tp-rise-in`/`tp-slide-in-right`/`tp-pop-in`/`tp-skeleton`; collapses under
  `prefers-reduced-motion`. **Light theme only** — no dark mode.

### 1.4 Voice
**Precise. Relentless. Clean.** Direct, calm-confident, helpful-not-hypey, collaborative-never-creepy. Use:
find, reveal, score, pursue, signal, verified, clean. Avoid: scrape, harvest, blast, spray, stalk; no
exclamation spam; no "synergy/10x/game-changer". Example microcopy: reveal confirm *"Reveal Jane Doe — 1
credit. Balance after: 1,239."*; low credits (warning tone) *"Running low — 12 credits left."*

## 2. Asset & typography pipeline (standalone extension)

- **Toolbar/store icons:** ship the **real mark** from `Guidelines/assets/icons/` — copy `favicon-16/32/48.png`
  into `apps/extension/src/assets/icons/` (replacing the placeholder solid-cobalt PNGs the scaffold generates)
  and add `icon-128` (from `icon-192` downscaled or `mark-master-1024`) for the store listing. Provide the
  **maskable/dark** variant for dark toolbars.
- **Fonts:** self-host **Geist + Geist Mono** woff2 locally in `src/assets/fonts/` and `@font-face` them inside
  the extension pages + the shadow-DOM roots (no external font CDN — the strict CSP forbids remote assets, and
  `03` §1.6 bans remote origins). Weights 400/500/600/800.
- **Tokens:** import `@leadwolf/ui/tokens.css` once per surface (and inline it into each shadow root, as the
  hover-card already does). Use `Tp*`/shadcn components where the popup/panel run as extension pages;
  token-driven inline styles for the in-page shadow-DOM UI.
- **Update the manifest/icon generator:** the `scripts/gen-icons.mjs` placeholder is superseded — the manifest
  `icons` should point at the real mark PNGs.

## 3. Per-surface branding

### 3.1 Toolbar (action) icon
The three-chevron mark, cobalt apex. Light variant default; maskable/dark variant for dark toolbars. Sizes
16/32/48 (from the favicon set) + 128 for the store. No text in the icon. A small unread/state dot may use
`--tp-cobalt` (active) or `--success` (verified) — never a second brand color.

### 3.2 Popup
White card on `--tp-surface-2`, `--radius`, `--tp-hairline-2` border, one `--tp-shadow-popover`; **lockup
top-left**; Lucide icons in `--tp-ink-3`; Ink full-width primary button. Signed-out state = lockup + subtitle +
one Ink "Sign in to TruePoint". Signed-in = account row + `--success` "Connected" pill + credits `StatTile`
(tabular-nums) + "Open workspace". (Layout per `08` §3.3.)

### 3.3 Authentication pages (mirror AuthShell)
The interactive login renders inside `launchWebAuthFlow` on `auth.truepoint.in` — so it **already** uses the
real AuthShell (centered ~400px white card on `--tp-surface-2`, lockup top-left, 22px semibold title, labelled
inputs, full-width Ink `Button`/`SubmitButton` with `Spinner`, destructive `Alert role="alert"` for errors,
`tp-card-enter` rise). The extension must **not** rebuild a login form — it delegates to that page. Any
extension-owned auth chrome (the "signing you in…", "session expired — sign in again", "reconnecting" states)
mirrors the same recipe at popup width (~360px): lockup, 22px title, muted subtitle (`--tp-ink-3`), one Ink
action, calm copy.

### 3.4 Loading / empty / error / success (State Kit)
Reuse `LoadingState` (shape-matched skeleton, `tp-skeleton` opacity pulse — never a bare spinner for a data
surface), `EmptyState` (one muted Lucide glyph + title + one line + one action), `ErrorState` (calm title +
detail + ghost Retry, **in-surface, never a toast** for a failed load), success via **toast** with a `--success`
dot. **Never Cobalt** for these — status colors for status only. Auth-specific: "Signing you in…" =
`LoadingState`; "Couldn't reach TruePoint" = `ErrorState` + Retry; "Signed in" = a brief success toast.

### 3.5 Notifications
Toast style: white card, `--tp-hairline-2`, `--tp-shadow-popover`, a colored dot (`--success`/`--danger`),
bottom-right, `tp-rise-in`, `aria-live`. Copy in brand voice, no exclamation spam.

### 3.6 Permission-request screens
When requesting an `optional_host_permission` (capture-anywhere) or `identity`, show a calm monochrome card:
lockup, a one-line plain-English reason ("Grant access to this site to capture prospects here"), one Cobalt-fill
primary action at most, and a "Not now" ghost. Generous whitespace; no dark patterns; explain the value.

### 3.7 Onboarding / welcome
Post-install: a short, calm welcome (lockup, "Welcome to TruePoint", one line on what it does, a single
"Sign in" primary). Progressive — don't front-load permissions or a tour; reveal capabilities as used. Voice:
helpful, not hypey.

### 3.8 User-profile display
Grey-initials `Avatar` (28px, up to 2 initials from name/email — from `GET /auth/me`, since the JWT has no
name) + name in Ink + role/email in `--tp-ink-3`. No colored avatars (brand rule). A `DropdownMenu` for
settings/sign-out.

### 3.9 Workspace / org switcher
Follow the auth `workspace/page.tsx` pattern: a `DropdownMenu`/`RadioGroup` list of workspaces (and an org
switcher) — name in Ink, role muted (`--tp-ink-4`), the **active row tinted `--tp-cobalt-50`**. Switching
triggers the token re-mint (doc `10` §2.6) and a `STATE_CHANGED` re-render. Show the active workspace name in
the panel header and popup.

## 4. Consistency with the web application

The extension **is** the TruePoint design system, on the page: same `--tp-*` tokens, same mark, same Geist
type, same one-shadow-per-overlay, same Ink-primary/Cobalt-accent discipline, same State Kit, same voice. A
user moving between `app.truepoint.in` and the extension should see **no seam**. The only extension-specific
constraints: shadow-DOM isolation for in-page surfaces (`08` §3), self-hosted fonts (CSP), and popup/panel
widths (~360–420px vs the web's full layout).

## 5. Branding checklist

- [ ] Real mark PNGs from `Guidelines/assets/icons/` wired into the manifest `icons` (replace placeholders); add 128.
- [ ] Maskable/dark toolbar-icon variant shipped.
- [ ] Geist + Geist Mono self-hosted (woff2) + `@font-face` in pages and shadow roots.
- [ ] `@leadwolf/ui/tokens.css` imported per surface + inlined into each shadow root.
- [ ] Popup, auth-status chrome, State Kit surfaces, notifications, permission screens, onboarding, profile,
      and workspace switcher all follow §3 and the `08` recipes.
- [ ] No Cobalt as text; no second accent; no dark mode; Lucide-only UI icons; brand voice in all copy.

Cross-refs: design language + surfaces [`08`](./08-ux-design-language.md); auth flows that these surfaces
present [`10`](./10-extension-authentication.md); brand kit `Guidelines/` + `packages/ui/src/tokens.css`.
