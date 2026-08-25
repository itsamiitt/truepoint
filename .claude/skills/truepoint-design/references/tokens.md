# Token Reference

> **Contents:** Text · Surfaces · Borders · Brand (Cobalt) · Status · Nav · Focus ·
> Buttons · Spacing · Page Layout · Table/Row · Radii · Shadows · Z-Index ·
> Typography (incl. the `--tp-text-*` scale) · Animation · Breakpoints ·
> Permitted Raw Values · Icon Sizing

Every colour, spacing, radius, shadow, z-index, font size, and timing value must be
expressed as a `var(--tp-*)` token. Never hardcode hex values or raw px numbers
outside the specific exceptions noted below.

The tokens are defined once in `packages/ui/src/tokens.css` (the `--tp-*` custom
properties); `packages/ui/src/theme.css` maps the Tailwind theme onto them via
`@theme inline`; the root `colors.css` is legacy.

> **Implementation status (updated 2026-08-22).** Raw **hex** is now a CI gate:
> `bun run lint:design-tokens` (`scripts/lint-design-tokens.mjs`) flags a hex used
> as a colour value in a `.css` declaration or a `.tsx` style object. It is
> deliberately narrow — `packages/ui/src/tokens.css` itself, `var(--token, #fallback)`
> (which `apps/extension` needs: a content script runs where `tokens.css` never
> loaded), Next's `themeColor` `<meta>` literal, and hexes inside comments are all
> excluded. Escape hatch: `// design-tokens-ok: <reason>`.
> Raw **px** is still code review only — no scanner reads it.

> **This table is a map, not the territory.** `packages/ui/src/tokens.css` is the
> source; every value below was read off it. If the two ever disagree, the
> stylesheet is right and this file is stale — fix this file.

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
| `--tp-ink-3` | `#6b7280` | Muted text, subtitles, metadata — **the faintest TEXT step** |
| `--tp-ink-4` | `#9ca3af` | Placeholders, disabled text, icon glyphs — **NEVER running text** |
| `--tp-on-fill` | `#ffffff` | Foreground *on* a filled/dark surface: button text, control marks, type on ink/twilight |

`--tp-ink-4` is 2.54:1 on white and worse on every tint — below the AA floor for
normal text (4.5:1) **and** for large text (3.0:1), so no size rescues it. A repo-wide
ratchet (`packages/ui/src/inkFourContrast.test.ts`) caps the existing usages; do not
add one. `--tp-ink-3` is the replacement, but check the surface: it clears AA on
`--tp-surface` (4.83) and `--tp-surface-2` (4.63) and **fails** on `--tp-surface-3`
(4.43) and `--nav-hover-fill` (4.39). See `accessibility.md`.

---

## Colour — Surfaces

| Token | Resolved value | Use for |
|---|---|---|
| `--tp-surface` | `#ffffff` | Cards, sidebar, topbar, drawers |
| `--tp-surface-2` | `#f9fafb` | Page background |
| `--tp-surface-3` | `#f4f5f7` | Nested backgrounds, well areas, **active nav fill** |
| `--tp-twilight` | `#0c0e1a` | The one dark fill (brand surfaces) |
| `--tp-scrim` | `rgba(17,24,39,0.32)` | The backdrop behind any overlay — dialog, drawer, mobile sidebar |

`--tp-scrim` was corrected from `0.4` to `0.32` and is now actually read: for a year
`.tp-ui-scrim` hardcoded `0.32` inline while the token said `0.4` and nothing
referenced it. `primitives.css` and `packages/app-shell/src/shell.css` both use the
token now — never re-inline a backdrop alpha.

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
| `--success` | `#16a34a` | Positive state — **FILL/icon only** (3.30:1 on white) |
| `--warning` | `#d97706` | Caution state — **FILL/icon only** (3.19:1 on white) |
| `--danger` | `#dc2626` | Negative/destructive — **FILL only** (3.99:1 on white) |
| `--success-700` | `#15803d` | Success as **TEXT** (5.02:1 on white) |
| `--warning-700` | `#b45309` | Warning as **TEXT** (~4.8:1 on `--tp-surface-2`) |
| `--danger-700` | `#b91c1c` | Destructive-button hover, **error TEXT** on light |
| `--success-50` | `#eaf6ee` | Faint success tint — the fill behind a success pill |
| `--warning-50` | `#fdf3e7` | Faint warning tint — the fill behind a warning pill |

**The rule, one line:** status colour on a **fill or an icon** → `--success` /
`--warning` / `--danger`. Status colour that **is the text** → the `-700` step. The
base tones are under the 4.5:1 normal-text floor; they are fine behind a 3:1 non-text
graphic (a status dot, a check glyph) and wrong on a number or a label. Pair a tint
with its `-700` ink: `--success-700` on `--success-50` is 4.71:1; `--warning-700` on
`--warning-50` is 4.62:1.

### Soft danger scale — the *exclusion* surface

Not for destructive actions (that stays `--danger`). These read as "this is a
negative clause" — the progressive-exclude filter block and its chips:

| Token | Resolved value | Use for |
|---|---|---|
| `--danger-tint` | `#fef7f7` | The exclusion block's background |
| `--danger-50` | `#fdeaea` | Excluded-chip fill |
| `--danger-100` | `#f8d5d5` | Excluded-chip border |
| `--danger-200` | `#f0c7c7` | Stronger exclusion hairline |
| `--danger-ink` | `#8c5f5f` | Muted rose supporting copy (5.0:1 on `--danger-tint`, 5.3:1 on `--tp-surface`) |

ScorePill thresholds (the ScorePill *recipe* — inlined in the lists Data-Health
cell; see patterns.md). Note these are **dot fills**, which is why the base tones are
correct here:
```js
score >= 80 → var(--success)
score >= 50 → var(--warning)
score < 50  → var(--tp-ink-4)
```

---

## Colour — Nav and Focus

| Token | Resolved value | Use for |
|---|---|---|
| `--nav-active-fill` | `#e8e8e8` | Legacy active-nav fill. **Defined but not used by the shipped shell** — the active nav item paints `--tp-surface-3`. Do not reach for it for new work; it survives so the contrast tests can keep asserting it. |
| `--nav-hover-fill` | `#f3f4f6` | Nav / menu-item hover background (`primitives.css`, the shell). `--tp-ink-3` **fails** AA on it (4.39) — put `--tp-ink-2` or darker on this fill. |
| `--focus-ring` | `#9ca3af` | The one focus ring, applied globally by `:focus-visible` in `tokens.css`. Grey and subtle, never a glow — and never cobalt. |

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

## Page Layout

The one page-container contract, consumed by the `PageContainer` primitive (and by
the `.tp-page` alias in `@leadwolf/app-shell`). Before these existed every feature
invented its own max-width — ten different values across the four apps, fifteen of
them with **no** `margin: auto`, so pages pinned flush-left with a dead gutter on the
right. A container ALWAYS centres; only the cap varies.

| Token | Value | Use |
|---|---|---|
| `--tp-page-max` | `1280px` | `PageContainer width="default"` — dashboards, reports, mixed content |
| `--tp-page-max-narrow` | `880px` | `PageContainer width="narrow"` — forms, settings, detail |
| `--tp-page-pad-y` | `var(--tp-space-6)` | Page vertical padding (desktop) |
| `--tp-page-pad-x` | `var(--tp-space-8)` | Page horizontal padding (desktop) |
| `--tp-page-pad-y-sm` | `var(--tp-space-5)` | Page vertical padding (≤768px) |
| `--tp-page-pad-x-sm` | `var(--tp-space-4)` | Page horizontal padding (≤768px) |

`width="fluid"` sets no cap — tables, lists and search should use the whole content
column. Do not re-declare a page max-width in a feature stylesheet.

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
| `--radius` | `8px` | Panels, buttons, controls |
| `--tp-radius-sm` | `6px` | Smaller elements (chips, badges, nav items) |
| `--tp-radius-card` | `14px` | Dashboard cards/tiles — softer than a control (Brand Kit asset cards are 14–16px) |

`--tp-radius-card` and `--tp-shadow-card` were both defined for the Brand Kit's
"cards float" and then never applied by the component they were named after; the DS
`Card` now uses both, so a card is 14px + elevated, not the generic 8px + flat.

---

## Shadows

| Token | Use |
|---|---|
| `--tp-shadow-popover` | Dropdowns, popovers, tooltips |
| `--tp-shadow-drawer` | Side panels — casts **left**, for right-side drawers |
| `--tp-shadow-dialog` | Modals, dialogs, the command palette |
| `--tp-shadow-bar` | Sticky bottom bars |
| `--tp-shadow-rail` | The left rail / off-canvas sidebar — casts **right**, onto content |
| `--tp-shadow-card` | Resting elevation for dashboard cards/tiles (used by `Card`) |
| `--tp-shadow-card-hover` | Hover elevation for the same |

One soft shadow per overlay — the brand allows exactly that, which is why these are
extracted here instead of being hand-written inline per surface.

---

## Z-Index Scale

| Token | Value | Use |
|---|---|---|
| `--tp-z-sticky` | `30` | Topbar, sticky headers |
| `--tp-z-drawer` | `40` | The **mobile off-canvas sidebar** (its scrim sits at `calc(… - 1)`) |
| `--tp-z-overlay` | `50` | The shared scrim `.tp-ui-scrim` |
| `--tp-z-modal` | `60` | Dialogs **and the DS `Drawer`** |
| `--tp-z-popover` | `70` | Dropdowns, popovers, tooltips |
| `--tp-z-toast` | `80` | Toast notifications |
| `--tp-z-command` | `90` | Command palette |

Never invent z-index values; use this scale.

Two names that read confusingly and are both correct:
- **The desktop expanded sidebar has no z-index at all.** It is an *in-flow grid
  column* of `.tp-shell` that widens — a push, not an overlay (see patterns.md
  "Sidebar"). `--tp-z-drawer` applies only to the ≤768px off-canvas form of it, in
  `packages/app-shell/src/shell.css`.
- **The DS `Drawer` sits on `--tp-z-modal` (60), not `--tp-z-drawer` (40)**, because
  it shares `.tp-ui-scrim` with `Dialog` and that scrim is at `--tp-z-overlay` (50).
  A drawer at 40 would render *behind its own backdrop*. `--tp-z-drawer` keeps its
  name for the shell's mobile rail, which paints its own backdrop below itself.

---

## Typography

| Token | Value | Use |
|---|---|---|
| `--font-sans` | Geist → system fallback | All UI text |
| `--font-mono` | Geist Mono → system fallback | Code, IDs, tabular data |

### The type scale — `fontSize` finally has tokens

Added because there wasn't one: every app was told "no raw px" while `fontSize` had
nothing to point at, so ~150 raw sizes accumulated across web/admin/auth/extension
and the ladder drifted into 10.5/11.5/12.5 steps no two surfaces shared. **These
eight ARE the ladder.** A size not on it is a design decision, not a typo, and
belongs in a token.

| Token | Value | Use |
|---|---|---|
| `--tp-text-micro` | `11px` | Dense table meta, tiny pills |
| `--tp-text-caption` | `12px` | Hints, eyebrows, timestamps |
| `--tp-text-body` | `13px` | The default UI text size — rows, menus, descriptions |
| `--tp-text-label` | `14px` | Form controls, buttons, primary body |
| `--tp-text-lg` | `15px` | Drawer titles, section leads |
| `--tp-text-title` | `16px` | Dialog titles, card headings |
| `--tp-text-heading` | `18px` | Panel headings |
| `--tp-text-display` | `22px` | Destination page titles (the cockpit header scales above this responsively) |

Font **weights** are raw values, not tokens (there are no `--font-weight-*` custom
properties): `400` body, `500` labels/secondary headings, `600` names, values and active
nav, `700` for the large score number (`.tp-score-big`). Hierarchy comes from weight + size,
never colour.

Where the scale lands on real surfaces:
- Page title: `var(--tp-text-title)` (16px), 600 — or the `PageHeader` primitive,
  which owns the destination/cockpit sizes for you
- Topbar subtitle: `var(--tp-text-caption)` (12px), `--tp-ink-3` (**not** ink-4 —
  it is text, and ink-4 fails contrast at every size)
- Nav label: `var(--tp-text-label)` (14px), 500 inactive / 600 active
- Table cell: `var(--tp-table-font)` = 13px
- ScorePill: `var(--tp-text-body)` (13px), 600
- Row subtitle: `var(--tp-text-micro)`–`var(--tp-text-caption)`, `--tp-ink-3`

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

The sidebar column width rides `var(--tp-duration)` (180ms); label/badge opacity
uses `var(--tp-duration-fast)` (120ms), no delay.

All motion collapses to near-instant under `prefers-reduced-motion` via a **global**
kill-switch at the end of `tokens.css` — components do not repeat the guard. See
`accessibility.md` for what that rule can and cannot reach.

The shared keyframes also live in `tokens.css` and are used app-wide (opacity/
transform only): `tp-fade-in`, `tp-rise-in`, `tp-slide-in-right`, `tp-pop-in`, and
`tp-skeleton`. Reuse one before writing new keyframes.

---

## Breakpoints

| Token | Value | Meaning |
|---|---|---|
| `--tp-bp-desktop` | `769px` | Desktop and up |
| `--tp-bp-mobile` | `768px` | Mobile and below |
| `--tp-bp-small` | `480px` | Small phones |

These are **documentation tokens**. CSS cannot interpolate a `var()` into a media
query, so `@media` rules still spell the number out — the tokens exist so a fourth
value never gets invented (the code had eight: 480/540/640/720/768/769/860/900).
Where the real queries live: `packages/app-shell/src/shell.css` for the shell,
each app's own stylesheet for its features (see patterns.md "Responsive Breakpoints").

---

## Permitted Raw Values

The following are the ONLY cases where raw px values are acceptable:

- `1px` for border widths — there is no `--tp-space-0.25`
- `2px` for `outline-offset` or `border-offset`
- `0` — unitless zero, always valid
- The pixel number inside a `window.matchMedia('(max-width: 768px)')` query when a
  client component genuinely needs the breakpoint in JS. (Not `window.innerWidth` —
  reading it forces layout and gives you a number that goes stale the moment the
  window resizes; `matchMedia` gives you a subscribable match instead.)
- The numeric spelling of a breakpoint inside an `@media` rule — CSS cannot read a
  `var()` there. Use the `--tp-bp-*` value, not a new one.

Everything else uses a token — **including `fontSize`**, which now has the full
`--tp-text-*` scale above and no longer has an excuse.

---

## Icon Sizing

Icons are sized by context, not arbitrarily. Pick the size that matches the
element the icon sits in, so iconography stays consistent across the app.

| Context | Size |
|---|---|
| Inside a small/compact control, row action | 14–15px |
| Standard nav item, button icon, inline with body text | 16–18px |
| Logo mark in sidebar, mobile-drawer nav item | 17–20px |
| Section header or emphasis icon | 20px |

Match the icon size to siblings. The Sidebar nav uses 18px; the mobile drawer nav
uses 20px; row hover actions use 14–15px; the logo mark uses 17px. When adding an
icon next to existing ones, match their size rather than introducing a new value.

Icon stroke width is `1.75` by default (the DS `Icon` wrapper's default). `Icon`
takes an `IconComponent` — a *structural* type (`size` + `strokeWidth` + standard SVG
props), which lucide-react glyphs satisfy; `@leadwolf/ui` itself no longer depends on
`lucide-react`, so the glyph comes from the consuming app's dependency. The logo mark
has its own stroke spec (`packages/app-shell/src/Logo.tsx`). Do not vary stroke width
per icon — it makes the set look inconsistent.
