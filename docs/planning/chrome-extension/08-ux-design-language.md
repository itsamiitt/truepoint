# 08 — UX & Design Language (Minimal, Modern)

> **Series:** [TruePoint Browser Extension](./README.md) · **Doc:** 08 · **Status:** ✅ Drafted
> · **Prev:** [`07-market-gap-and-differentiation`](./07-market-gap-and-differentiation.md) · **Next:** [`09-product-architecture`](./09-product-architecture.md)

The extension must read as **the same product** as `app.truepoint.in` — because it *is* the same design
system. This doc specifies the minimal-modern UX for the four in-page surfaces as thin compositions of
`@leadwolf/ui` over the shared `var(--tp-*)` tokens. **Do not invent a parallel design language.** All
rules come from the `truepoint-design` skill; the extension-specific additions (shadow-DOM isolation,
focus-trap/return) are called out where the shipped components don't yet cover them.

---

## 1. Design principles

1. **Minimal + low-clutter.** One job per surface, **one primary action** per surface. Progressive
   disclosure: inline badge → hover-card → side-panel. Never a wall of text; `EmptyState` = one glyph +
   title + one line + one action.
2. **Calm + non-intrusive on the host page.** Everything injects inside a **shadow DOM** root: host-page
   CSS cannot bleed in, and TruePoint's `--tp-*` tokens (imported once inside that root) cannot leak out.
   No layout shift on the host; inline badges reserve fixed width via `tabular-nums`.
3. **Fast + optimistic.** Reveal/save render optimistically (the `StatusBadge` flips to a pending tone via
   a button `Spinner`, then to "Revealed"), rolling back with an inline `ErrorState`/`FieldGroup` error on
   failure. `LoadingState` skeletons are **shape-matched** so arriving data never reflows.
4. **Keyboard-first.** Real `TpButton`/`TpIconButton` everywhere (never `<div onClick>`); full tab
   reachability; the single `--focus-ring` (2px outline + 2px offset) never stripped; `Esc` closes the
   hover-card/popover; a command-style quick-search reachable without the mouse. Targets ≥ 44px
   (`--tp-row-h`); icon-only buttons carry a `label` prop.
5. **Four states, always.** Every data surface routes through the single `StateSwitch` — loading (skeleton)
   / empty (first-run vs filtered-to-zero copy) / error (`ErrorState` in-surface with `onRetry`, **never a
   toast**) / populated (virtualized + server cursor pagination for large results).
6. **Reuse, never reinvent.** Exact shared components (`StatusBadge`, `ScorePill`, `Avatar`,
   `Combobox`/SmartSearch, `DataTable`, `Drawer`, `Popover`) and only `var(--tp-*)` tokens — no hardcoded
   hex/px, **no Tailwind utility classes in app JSX** (token-driven inline `style={{}}`).
7. **Light-theme only.** No dark mode, no theme toggle, no `prefers-color-scheme:dark`. Even against a dark
   host page, the shadow root paints its own `--tp-surface` so the extension chrome is always the TruePoint
   light surface.
8. **Meaning never by color alone.** `StatusBadge` = tone + text; `ScorePill` = dot + number; status tones
   always carry text or shape. Cobalt (`--tp-cobalt`) is **fill/accent/active only, never body text**.

## 2. Token usage (the palette we're bound to)

Tokens live in `packages/ui/src/tokens.css`. The extension imports that same file inside its shadow root.

| Group | Tokens (representative) | Use in the extension |
|---|---|---|
| Text | `--tp-ink` #111827 · `--tp-ink-2` · `--tp-ink-3` #6b7280 · `--tp-ink-4` | name = ink/600; title/company = ink-3; metadata = ink-3/4 |
| Surface | `--tp-surface` #fff · `--tp-surface-2` · `--tp-surface-3` | card/panel bg = surface; nested wells = surface-3 |
| Border | `--tp-hairline` · `--tp-hairline-2` #e5e7eb | 1px separators between rows/sections |
| Brand | `--tp-cobalt` #2563c9 · `--tp-cobalt-50` | active tab, revealed-tint fill, logo — **never text** |
| Status | `--success` · `--warning` · `--danger` (+ `-700`) | verified dot, warnings, errors — paired with text |
| Radius | `--radius` 8px · `--tp-radius-sm` 6px · `--tp-radius-card` 14px | card = radius-card; chips/badges = radius-sm |
| Spacing | `--tp-space-1..8` (4→32px) | padding on a 4px scale; card body = space-4 |
| Elevation | `--tp-shadow-popover` · `--tp-shadow-drawer` | **one** soft shadow per overlay, never stacked |
| Motion | `--tp-ease-out` · `--tp-duration-fast` 120ms · `--tp-duration` 180ms | entrances (§5) |
| Type | `--font-sans` (Geist) · `--font-mono` · `tabular-nums` | numerics (scores/credits/counts) always tabular |
| Z-index | popover 70 · drawer 40 · toast 80 | the extension respects the same stacking scale inside its root |
| Focus | `--focus-ring` #9ca3af | the single visible focus ring |

## 3. The four surfaces

### 3.1 Hover-card (Popover, ~320px)

**Purpose:** zero-commitment identity peek. Appears on hover (~300ms dwell) or click of a detected profile
anchor (a name, an email, a company). Answers *"who is this, and is it in TruePoint?"* and offers exactly
**one** primary action (Reveal, or Save when already revealed). Never blocks the host page; dismisses on
mouse-leave (+ small travel delay) and `Esc`.

**Layout:** floating `Popover` on the `--tp-z-popover` layer, `--tp-surface` bg, 1px `--tp-hairline-2`
border, `--tp-radius-card`, a single `--tp-shadow-popover`, padding `--tp-space-4`, anchored to the trigger
with an 8px offset and auto-flip. Header: `Avatar` (28px) + name (13/600 ink) + title/company (11–12/ink-3)
+ `StatusBadge`. Body: two `StatTile`-style mini-rows (a verified-email **dot** + a `ScorePill` = dot +
tabular number). Footer: one full-width `TpButton` primary + a `TpIconButton` overflow. All four states via
`StateSwitch`.

```
HOVER-CARD (Popover, ~320px, anchored to an in-page badge)
+------------------------------------------------------+   <- --tp-shadow-popover, --tp-radius-card
| (o) Priya Nair                    [ Not revealed ]   |   Avatar 28 + name 13/600 ink + StatusBadge
|     VP Sales · Acme Corp                             |   11-12 / --tp-ink-3
|------------------------------------------------------|   --tp-hairline
|  Email      * verified                               |   StatTile row: success dot + label (not color-alone)
|  Score      ( . ) 82                                 |   ScorePill = dot + tabular-nums number
|------------------------------------------------------|
|  [        Reveal contact        ]   [ ... ]          |   full-width TpButton primary + TpIconButton overflow
+------------------------------------------------------+

  LOADING (same box, StateSwitch skeleton — shape-matched, no reflow):
+------------------------------------------------------+
| (o) [====== 60% ======]           [==== 30% ====]    |
|     [========= 45% =========]                        |
|------------------------------------------------------|
|  [==== 40% ====]   [== 20% ==]                       |
+------------------------------------------------------+

  EMPTY / not-found:
     ( person glyph )   No TruePoint match
                        We couldn't find this profile.   [ Search TruePoint ]
```

### 3.2 Side-panel (Drawer, ~380px)

**Purpose:** the durable working surface docked to the right edge, persisting across host-site navigation.
Hosts the tabbed workspace: **Captured** (this page's detected people) · **Reveal** (credits + reveal
queue) · **Lists** · **Sequences** · **AI**. Where multi-step work happens without leaving the tab.

**Layout:** right-docked `Drawer` (reuse the `ContactDrawer` contract), 380px default (resizable to 420px),
full host-viewport height, `--tp-shadow-drawer`, slides in via `tp-slide-in-right`. Top: a 44px bar —
TruePoint mark + workspace switcher (`DropdownMenu`) + a `TpIconButton` collapse. Below: `SegmentedControl`
/ `Tabs`. Content is one scroll region; each tab is its own `StateSwitch` surface with skeletons sized to
expected rows. Sticky footer per tab holds the single primary action. Rows are `--tp-row-h` (44px); long
lists are virtualized + server cursor-paginated.

```
SIDE-PANEL (right-docked Drawer, 380px, full host-viewport height)
+---------------------------------------------------+   <- --tp-shadow-drawer, tp-slide-in-right
| [TP]  Acme workspace  v            [ >| collapse ] |   44px bar: mark + switcher + TpIconButton
+---------------------------------------------------+
| [ Captured ][ Reveal ][ Lists ][ Sequences ][ AI ]|   SegmentedControl / Tabs
+---------------------------------------------------+
|  Captured on this page                    3 found |   section label 13/600 + count (tabular-nums)
|  ................................................ |
|  (o) Priya Nair          [Revealed]   ( . ) 82    |   --tp-row-h 44px; Avatar+name+StatusBadge+ScorePill
|      VP Sales · Acme                              |   subtitle 11-12 / --tp-ink-3
|  ................................................ |   --tp-hairline
|  (o) Dev Rao             [Not revealed] ( . ) 74  |
|      Head of Ops · Acme                           |
|  ................................................ |
|  (o) M. Shah            [Revealing... (spinner)]  |   optimistic pending state on button/badge
|      Analyst · Acme                               |
|   (virtualized list -> server cursor pagination)  |
+---------------------------------------------------+
|  [        Reveal all on page (3)        ]         |   sticky footer: ONE primary TpButton
+---------------------------------------------------+

  EMPTY (first-run) — Captured tab:
        ( magnifier glyph )   No profiles detected yet
                              Open a LinkedIn or company page to capture.

  ERROR (in-surface, never a toast):
        ( alert glyph )       Couldn't load captured contacts     [ Retry ]   <- ErrorState onRetry
```

### 3.3 Action popup (toolbar Popover, ~360px)

**Purpose:** the toolbar-icon target — auth state, connection status, quick search, credit balance, and a
jump into the side-panel. The lightweight entry point when the panel is closed.

**Layout:** `Popover` ~360px, `--tp-radius-card`, `--tp-shadow-popover`. Signed-out: logo lockup + one
primary `TpButton` "Sign in to TruePoint" + a subtle status line. Signed-in: header (`Avatar` + account +
`StatusBadge` success tone) · a credit `StatTile` (tabular-nums) · a `Combobox`/SmartSearch quick-find · a
captured-count row with a `TpButton` "Open workspace" (opens the Drawer). Footer: settings/sign-out via
`DropdownMenu`.

```
ACTION POPUP (toolbar Popover, ~360px) — signed-in
+-----------------------------------------------+
| (o) priya@acme.com        [ Connected ]       |   Avatar + account + StatusBadge success tone
|-----------------------------------------------|
|  Credits            1,240                      |   StatTile, tabular-nums
|  [  Quick search TruePoint...           ]      |   Combobox / SmartSearch
|-----------------------------------------------|
|  3 captured on this page                      |
|  [        Open workspace        ]  [ ... ]     |   primary TpButton opens Drawer + overflow menu
+-----------------------------------------------+
```

### 3.4 In-page inline badges

**Purpose:** non-intrusive recognition markers injected next to detected entities (name, email, company).
Signal at a glance — known to TruePoint? revealed? what score? — without opening anything. They're the
trigger for the hover-card.

**Layout:** a tiny inline `TpChip`-scale token, `--tp-radius-sm`, 20px tall, `tabular-nums`. Content = one
14px `Icon` (stroke 1.75) + optional `ScorePill` (dot + number, never color-alone). Tones map to
`StatusTone`: neutral (detected, hairline border) · `--tp-cobalt-50` tint fill (revealed) · success dot
(verified). A focusable button that anchors the hover-card, with an `aria-label`. Injected inside the
shadow-DOM wrapper so host CSS never bleeds in.

```
IN-PAGE INLINE BADGE (next to a detected name, inside shadow DOM)
   Priya Nair  [TP · 82]     <- 20px TpChip: Icon + ScorePill(dot+number), --tp-radius-sm, focusable, aria-label
```

## 4. Interaction patterns

- **Progressive disclosure:** badge (glance) → hover-card (peek, 300ms dwell, one action) → side-panel
  (full work). Each level reveals more only on intent; nothing auto-expands.
- **One primary action per surface:** hover-card footer = a single full-width `TpButton`; panel tab footer
  = a single sticky primary; secondary actions demote to a `TpIconButton` + `DropdownMenu` overflow.
- **Optimistic reveal:** on click, the button shows an in-flight `Spinner` and the `StatusBadge` flips to a
  pending tone immediately; success updates in place (a **toast confirms, never asks**); failure rolls back
  to an inline `ErrorState`/`FieldGroup` error (not a toast).
- **Skeletons + no layout shift:** `LoadingState` rows sized to the expected result on every surface;
  `Spinner` is reserved only for a small in-flight action (a submitting button).
- **Feedback matched to event:** `toast` confirms completed actions and summarises a bulk reveal as **one**
  toast; `Dialog` for a destructive confirm (remove from list — never `alert()`/`confirm()`); inline
  `FieldGroup` error for field validation (validate on **blur + submit**, never per keystroke, never clear
  on failed submit); `ErrorState`-in-`StateSwitch` for a failed load.
- **Dismissal discipline:** hover-card + popup close on `Esc`, outside-click, and mouse-leave (with a small
  close delay so travel to the card doesn't dismiss it); the side-panel persists until explicitly collapsed.
- **Bulk by criteria, not DOM rows:** "Reveal all on page" / "Add all captured" operate on the server-side
  selection set with one summary toast — never per-row loops; long lists are virtualized with server cursor
  pagination and server-side filter/sort.

## 5. Motion

Subtle, short, **transform/opacity only**, GPU-friendly, all under ~300ms, using the shared tokens:

- Hover-card enters with `tp-pop-in` (translateY 4px + scale .98→1) at `--tp-duration-fast` (120ms,
  `--tp-ease-out`).
- Side-panel `Drawer` enters with `tp-slide-in-right` (translateX 16px) at `--tp-duration` (180ms).
- Toasts/inline content rise with `tp-rise-in`; skeletons pulse with an opacity-only shimmer.
- **No layout/size animation of host content.** Badge injection appears instantly (fade-in only) so the
  host page never feels like it "jumped."
- Everything honors `prefers-reduced-motion`, which `tokens.css` already collapses to ~0.01ms globally — no
  per-component guard needed.

## 6. Accessibility (WCAG 2.2 AA)

Enterprise buyers request a VPAT; sales users are keyboard-heavy all day.

- Every interactive element is a real focusable `TpButton`/`TpIconButton` (never `<div onClick>`); tab order
  follows DOM/visual order (no `tabindex>0`); the single `--focus-ring` (2px outline, 2px offset) is always
  visible and never stripped.
- Overlays use correct roles/aria (`dialog` for Drawer/Dialog, `listbox` for Combobox) and `aria-live` for
  optimistic status changes + toasts.
- **Extension-specific gap to close:** the shipped `Drawer`/`Dialog`/`Popover` handle `Esc` + scrim-dismiss
  + body-scroll-lock but **do not implement a focus trap or focus-return**. The hover-card and side-panel
  **must add**: move focus in on open, **trap** it while open, and **return** it to the trigger on close.
  The hover-card must also be **click-openable** (not hover-only) so it's reachable without a pointer.
- No meaning by color alone (StatusBadge/ScorePill pair tone with text/number/shape); status tones meet
  contrast on `--tp-surface`; Cobalt is fill-only, never body text.
- Icon-only controls carry a `label` prop → accessible name; inline badges expose an `aria-label`
  (e.g. `"TruePoint: revealed, score 82"`) and are keyboard-focusable. Interactive targets ≥ 44px.
- **Shadow-DOM isolation** guarantees host-page focus styles and contrast overrides can't degrade the
  extension's a11y.

## 7. Copy & i18n

All user-facing copy goes through the i18n catalog (interpolation, not concatenation; locale-aware plurals
/ number / date / currency; RTL via logical CSS properties). Tone is the TruePoint brand voice: plain,
honest, no hype — the empty/error copy tells the user exactly what happened and the one next step. No
placeholder/Lorem filler; the filter chip row is hidden when no filters are active. Read `Guidelines/`
before any brand decision.

## 8. Net effect

**Minimal** — identity-first, one shadow, one accent (cobalt as fill/active only), ink neutrals, generous
4px-scale spacing, 44px targets. **Modern** — Geist type, tabular numerics, sub-300ms transform/opacity
motion, skeleton-not-spinner loading. And **indistinguishable from the core product**, because it is
literally the same tokens and components — which is the whole point: the extension is TruePoint, on the page.
