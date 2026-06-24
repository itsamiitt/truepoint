# Dashboard Redesign — Scroll Isolation + Collapsible Sidebar + Visual Refresh

> Scope: `apps/web` shell chrome (customer dashboard). Frontend-only — no API, data,
> tenancy, security, or migration changes. Governed by `truepoint-design` +
> `truepoint-architecture`.

## Context

The TruePoint customer dashboard shell had two structural problems plus a quality bar
("modern, fully user-friendly, on-brand"):

1. **Scroll was not isolated** — scrolling the main content moved the whole dashboard
   (sidebar + top bar) instead of just the content.
2. **The sidebar was always-on and fixed-width** — it should be **collapsed by
   default**, **expand on hover**, and **stay open when clicked (pinned)**.

Confirmed with the user: collapsed style = **icon rail (68px)**; scope = **the two
fixes + a measured visual refresh** of the shell and Home cockpit.

## Root causes

- **Scroll:** `globals.css` `.tp-shell` used `min-height: 100dvh` (not a definite
  height), so the grid grew past the viewport and the `<body>` scrolled (invisibly,
  since scrollbars are hidden app-wide), dragging the full-height sidebar with it.
  Fix: `height: 100dvh` clamps the grid so `.tp-content`'s existing `overflow-y:auto`
  scrolls internally.
- **Sidebar:** the `<aside>` was grid column 1 at a fixed 232px, always visible on
  desktop, with no rail/hover/pin behavior.

## The rail model

| State | Width | Trigger | Content |
|---|---|---|---|
| Collapsed (default) | 60px (`--tp-rail-w`), icons only | resting | full |
| Hover / keyboard-focus | 232px (`--tp-rail-expanded`), icons + labels | `:hover` / `:focus-within` | **reflows with the rail (push)** |
| Pinned | 232px | top-bar toggle | **reflows with the rail (push)** |

Mechanism: the `<aside>` is an **in-flow grid item** in column 1 of `.tp-shell`
(`grid-template-columns: var(--tp-rail-w) 1fr`, `grid-template-rows: minmax(0,1fr)`,
`height:100dvh`) — never `position: fixed` on desktop, so the main column always sits
beside it. The **rail column itself** expands to `--tp-rail-expanded` on hover/focus
(`.tp-shell:not(.is-pinned):has(.tp-sidebar:hover, :focus-within)`) or when pinned
(`.tp-shell.is-pinned`), so the sidebar **and** the main content reflow together — the
content responds, it is never covered. Label/wordmark/switcher reveal is driven by a
**CSS container query** on the rail's own width, so it covers hover, focus, and pin with
one rule. The pin toggle is a persistent top-bar control (`aria-pressed`); pin state
persists to `localStorage` (`tp-sidebar-pinned`, SSR-safe, default collapsed) via a
`useSidebarPin` hook mirroring `DensityProvider`. On mobile the rail becomes a
`position: fixed` off-canvas overlay (hamburger + scrim) — unchanged. Degrades
gracefully: without `:has()` the rail still shows and the pin toggle still expands it.

## Visual refresh (measured, on-brand)

The Home cockpit was already redesigned to the Brand Kit (commit e65f4c8), so this is a
polish layered on top — not a teardown. The headline visual upgrade is the new shell
chrome itself (the rail). Plus: a live browser audit to surface concrete issues, then
targeted rhythm/consistency fixes and token-purity cleanup in `HomePage.module.css`.

## Files

- **Create** `apps/web/src/components/shell/useSidebarPin.ts`.
- **Modify** `packages/ui/src/tokens.css` (rail tokens), `apps/web/src/app/globals.css`
  (scroll fix + rail/hover/pin + container-query reveal + mobile),
  `apps/web/src/components/shell/{AppShell,TopBar,Sidebar}.tsx`, and
  `apps/web/src/features/home/components/HomePage.module.css` (polish).

## Verification

`bun run dev` → check scroll isolation, hover-expand (overlay), pin (push + persists),
keyboard focus reveal, reduced-motion, mobile overlay; live browser audit at
1280/768/375; `bun run typecheck` / `lint` / `lint:boundaries` clean.

## Decisions (confirmed)

- Collapsed style → icon rail (68px).
- Scope → two structural fixes + a measured visual refresh, preserving recent brand work.
