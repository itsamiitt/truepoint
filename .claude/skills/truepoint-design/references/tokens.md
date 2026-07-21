# Token Reference

Every colour, spacing, radius, shadow, z-index, font, and timing value must be
expressed as a `var(--tp-*)` token. Never hardcode hex values or raw px numbers
outside the specific exceptions noted below.

The tokens are defined once in `packages/ui/src/tokens.css` (the `--tp-*` custom
properties); `packages/ui/src/theme.css` maps the Tailwind theme onto them via
`@theme inline`; the root `colors.css` is legacy. Raw-hex / raw-px adherence is a
manual review rule, not an automated check.

> **Implementation status:** there is no automated lint for raw hex / raw px — it is
> enforced by code review against the tokens in `packages/ui/src/tokens.css`.

> **Tokens are a single shared source across both frontend apps.** The customer
> (`@leadwolf/web`) and internal (`@leadwolf/admin`) apps may diverge in *components*,
> but they consume **one** token set — the brand does not fork between surfaces (see
> **truepoint-architecture** shared-packages). A new token is added to the shared
> source (`packages/ui/src/tokens.css`), not redefined per app.

---

## Colour — Text

| Token | Resolved value | Use for |
|---|---|---|
| `--tp-ink` | `#111827` | Primary body text, headings |
| `--tp-ink-2` | `#374151` | Secondary text, labels |
| `--tp-ink-3` | `#6b7280` | Muted text, subtitles, metadata |
| `--tp-ink-4` | `#9ca3af` | Faint text, placeholders, empty state |

---

## Colour — Surfaces

| Token | Resolved value | Use for |
|---|---|---|
| `--tp-surface` | `#ffffff` | Cards, sidebar, topbar, drawers |
| `--tp-surface-2` | `#f9fafb` | Page background |
| `--tp-surface-3` | `#f4f5f7` | Nested backgrounds, well areas |

---

## Colour — Borders

| Token | Resolved value | Use for |
|---|---|---|
| `--tp-hairline` | `#f0f0f0` | Subtle dividers, row separators |
| `--tp-hairline-2` | `#e5e7eb` | Stronger dividers, card outlines |

---

## Colour — Brand (Cobalt)

| Token | Resolved value | Use for |
|---|---|---|
| `--tp-cobalt` | `#2563c9` | Active nav fill, primary icon fill |
| `--tp-cobalt-700` | `#1e4fa3` | Active nav text, accent text |
| `--tp-cobalt-50` | `#e9f0fc` | Active nav background tint |
| `--tp-cobalt-tint` | `#5b8def` | Lighter cobalt, hover states |

**Never use cobalt as body text colour** — only for fills, accents, active states.

---

## Colour — Status

| Token | Resolved value | Use for |
|---|---|---|
| `--success` | `#16a34a` | Positive state, qualified, won |
| `--warning` | `#d97706` | Caution state, proposal, negotiation |
| `--danger` | `#dc2626` | Negative state, lost, destructive |
| `--danger-700` | `#b91c1c` | Destructive-button hover, error text on light |

ScorePill thresholds (from the app `ScorePill` component in `apps/web`):
```js
score >= 80 → var(--success)
score >= 50 → var(--warning)
score < 50  → var(--tp-ink-4)
```

---

## Colour — Buttons (internal)

| Token | Use |
|---|---|
| `--tp-btn` | Primary button fill (`#111827`) |
| `--tp-btn-700` | Primary button hover fill (`#0b1220`) |
| `--tp-twilight` | Dark fill (`#0c0e1a`) |

These are used internally by `TpButton`. Avoid referencing them directly.

---

## Spacing (4px scale)

| Token | Value | Use |
|---|---|---|
| `--tp-space-1` | `4px` | Tight gap (icon + label) |
| `--tp-space-2` | `8px` | Component inner gap |
| `--tp-space-3` | `12px` | Card inner padding (compact) |
| `--tp-space-4` | `16px` | Standard card padding |
| `--tp-space-5` | `20px` | Section gap |
| `--tp-space-6` | `24px` | Page-level padding (horizontal) |
| `--tp-space-8` | `32px` | Large section separation |

For topbar and sidebar padding, use `var(--tp-space-6)` (24px) horizontally.

---

## Spacing — Table / Row

| Token | Value | Use |
|---|---|---|
| `--tp-row-h` | `44px` | Standard interactive row height |
| `--tp-row-h-compact` | `32px` | Compact row (dense lists) |
| `--tp-cell-pad-y` | `10px` | Cell vertical padding |
| `--tp-cell-pad-y-compact` | `5px` | Compact cell vertical padding |
| `--tp-cell-pad-x` | `12px` | Cell horizontal padding |
| `--tp-table-font` | `13px` | Table cell font size |

---

## Radii

| Token | Value | Use |
|---|---|---|
| `--radius` | `8px` | Cards, panels, buttons |
| `--tp-radius-sm` | `6px` | Smaller elements (chips, badges, nav items) |

---

## Shadows

| Token | Use |
|---|---|
| `--tp-shadow-popover` | Dropdowns, popovers, tooltips |
| `--tp-shadow-drawer` | Contact drawer, side panels |
| `--tp-shadow-dialog` | Modals, dialogs |
| `--tp-shadow-bar` | Sticky bottom bars |

---

## Z-Index Scale

| Token | Value | Use |
|---|---|---|
| `--tp-z-sticky` | `30` | Topbar, sticky headers |
| `--tp-z-drawer` | `40` | Sidebar (expanded), drawers |
| `--tp-z-overlay` | `50` | Backdrop overlays |
| `--tp-z-modal` | `60` | Dialogs |
| `--tp-z-popover` | `70` | Dropdowns, popovers |
| `--tp-z-toast` | `80` | Toast notifications |
| `--tp-z-command` | `90` | Command palette (reserved) |

Never invent z-index values. Use this scale. The expanded sidebar overlay uses `--tp-z-drawer` (40).

---

## Typography

| Token | Value | Use |
|---|---|---|
| `--font-sans` | Geist → system fallback | All UI text |
| `--font-mono` | Geist Mono → system fallback | Code, IDs, tabular data |

Font **weights** are raw values, not tokens (there are no `--font-weight-*` custom
properties): `400` body, `500` labels/secondary headings, `600` names, values and active
nav, `700` for the large score number (`.tp-score-big`). Hierarchy comes from weight + size,
never colour.

Font sizes (design-system scale):
- Page title: `16px, 600`
- Topbar subtitle: `12px, ink-4`
- Nav label: `14px, 500 (inactive) / 600 (active)`
- Table cell: `var(--tp-table-font)` = `13px`
- ScorePill: `13px, 600`
- Row subtitle: `11–12px, ink-3`

**Tabular numbers** — always use `fontVariantNumeric: 'tabular-nums'` on:
score values, currency amounts, percentages, counts. Prevents layout shift
when values update.

---

## Animation Timing

| Token | Value | Use |
|---|---|---|
| `--tp-duration-fast` | `120ms` | Micro-interactions (hover bg) |
| `--tp-duration` | `180ms` | Standard transitions |
| `--tp-duration-slow` | `260ms` | Larger layout transitions |
| `--tp-ease` | `cubic-bezier(0.4,0,0.2,1)` | Standard easing |
| `--tp-ease-out` | `cubic-bezier(0,0,0.2,1)` | Decelerate (drawers entering) |

Sidebar uses `200ms cubic-bezier(0.4,0,0.2,1)` for width transition.
Label/badge opacity uses `160ms` with `60ms` delay on open.

---

## Permitted Raw Values

The following are the ONLY cases where raw px values are acceptable:

- `1px` for border widths — there is no `--tp-space-0.25`
- `2px` for `outline-offset` or `border-offset`
- `0` — unitless zero, always valid
- Pixel values used as JavaScript numbers in `window.innerWidth` comparisons

Everything else uses a token.

---

## Icon Sizing

Icons are sized by context, not arbitrarily. Pick the size that matches the
element the icon sits in, so iconography stays consistent across the app.

| Context | Size |
|---|---|
| Inside a small/compact control, row action | 14–15px |
| Standard nav item, button icon, inline with body text | 16–18px |
| Logo mark in sidebar, bottom-nav item | 17–20px |
| Section header or emphasis icon | 20px |

Match the icon size to siblings. The Sidebar nav uses 18px; the BottomNav uses
20px; row hover actions use 14–15px; the logo mark uses 17px. When adding an
icon next to existing ones, match their size rather than introducing a new value.

Icon stroke width is `1.75` by default (the `Svg` helper default), `2.4` only
for the logo mark. Do not vary stroke width per icon — it makes the set look
inconsistent.
