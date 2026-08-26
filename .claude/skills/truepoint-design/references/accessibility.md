# Accessibility

Accessibility is not a polish pass — it is part of building the component
correctly the first time. TruePoint is a daily-driver tool for sales staff;
many use it keyboard-first, all day. A surface that only works with a mouse is
broken for a real portion of users, and retrofitting accessibility later is far
more expensive than building it in.

The design system components are accessible out of the box. Most accessibility
failures come from either bypassing the DS (raw `<div onClick>` instead of a
button) or from custom interactive surfaces that forget the keyboard. This file
is about not undoing what the DS gives you, and handling the custom cases right.

> **Conformance target: WCAG 2.2 AA.** This is the standard TruePoint builds and
> audits against — enterprise buyers ask for it, and many request a VPAT
> (accessibility conformance report). Treat 2.2 AA as the bar every surface must
> meet, audited periodically, not a one-time pass. The checks below are how you hit
> it in day-to-day work.

---

## Keyboard: Everything Interactive Is Reachable

Every action a mouse can take, a keyboard can take. Test by putting the mouse
away and tabbing through the surface.

- Use real interactive elements. A `TpButton`, `Button`, or `TpIconButton` is
  focusable and keyboard-activatable for free. A `<div onClick>` is not — it is
  invisible to keyboard and screen-reader users. This is the single most common
  failure, and **nothing automated catches it**: the "no raw `<button>`/`<input>`/
  `<table>`/`<dialog>`" rule is code review only. The automated slice is narrower
  than it sounds — Biome's `recommended` a11y rule set (`biome.json`),
  `bun run lint:roving-tabindex` (a composite ARIA role carrying `tabIndex={-1}`
  with no key handler), `bun run lint:design-tokens` (raw hex), and the contrast
  tests (`packages/ui/src/primitivesContrast.test.ts`,
  `packages/ui/src/inkFourContrast.test.ts`, and each app's own
  `contrast.test.ts`). None of those can see a `<div onClick>`, and none of them
  can tell you a key handler is *correct*. (The DS's own keyboard and focus behaviour
  *is* asserted against a real DOM — `packages/ui/src/components/overlay.domtest.tsx`
  and `keyboard.domtest.tsx`, run by `bun run test:dom` — but that covers the DS
  components, not what you build beside them.)
- Tab order follows visual order. If focus jumps around, the DOM order is wrong —
  fix the markup, do not patch with `tabindex` values above 0 (which create
  unpredictable focus traps).
- Interactive rows: the `DataTable` row click that opens the detail drawer
  (composed from the DS `Drawer` — e.g. `apps/web`'s `QuickViewDrawer`) is already
  keyboard-reachable. A row with `onRowClick` carries `tabIndex={0}` and activates
  on Enter or Space, and it ignores keys that bubbled up from a control *inside*
  the row — Enter on a row's menu button means "press me", not "open the record".
  You get that from the DS; do not re-add a bare click handler to a `<tr>`.
  Hover-revealed actions must become reachable on focus, not only on hover (see
  **Focus Visibility** below).
- Never remove focus outlines without replacing them. `outline: none` with no
  visible focus state is an accessibility failure. The DS provides a focus ring
  (`--focus-ring`) — use it; do not strip it.

---

## Focus Visibility — One Global Ring

The ring is defined once, in `packages/ui/src/tokens.css`, and every app inherits it
by importing that stylesheet:

```css
:focus-visible {
  outline: 2px solid var(--focus-ring);  /* #9ca3af — subtle grey, never neon */
  outline-offset: 2px;
}
```

- Because it is global, every focusable element gets it for free — **form fields
  included**. `primitives.css` used to carry `.tp-ui-field:focus { outline: none }`,
  which at specificity (0,2,0) beat the global rule and left every input in the
  product with a 1px border shift as its only focus indicator, visibly weaker than
  every button beside it. That suppression is gone: `.tp-ui-field:focus` now only
  darkens the border, *on top of* the ring.
- Do not re-introduce `outline: none` anywhere. A surface that genuinely needs a
  different indicator replaces the ring with something at least as visible, in the
  same rule — it never just removes it.
- **Hover-revealed row actions must also show on `:focus-within`.** A row that fades
  its actions in on `:hover` alone hides them from every keyboard user. Pair the
  selectors (`.row:hover .actions, .row:focus-within .actions`) so tabbing into the
  row reveals exactly what hovering it does.

---

## Focus Management in Overlays

Drawers and dialogs are where focus handling matters most. The DS `Drawer` and
`Dialog` (`packages/ui/src/components/overlay.tsx`) implement the whole contract —
do not hand-roll an overlay that skips it.

Both render into a **portal on `document.body`**, because a `transform`/`filter`
ancestor re-parents `position: fixed` and inline rendering could trap the modal
inside a card.

When an overlay opens:
- Focus moves into the overlay — the first focusable element, or the card itself
  when the body has none (the card carries `tabIndex={-1}`).
- Focus is **trapped** inside while it is open — Tab and Shift+Tab wrap at the
  edges and cannot leak to the page behind. `aria-modal` *without* a trap is worse
  than no ARIA at all: it tells assistive tech to ignore the page while real Tab
  focus walks straight into it.
- **Escape closes the TOP-MOST layer only.** Every layered surface — `Dialog`,
  `Drawer`, `DropdownMenu`, `Popover`, `Combobox`, `Tooltip` — registers with the
  shared stack in `packages/ui/src/components/overlayStack.ts`, so a menu opened
  inside a dialog closes alone on the first Escape and the dialog on the second.
- Body scroll lock is **reference-counted** across modal layers, so the first of two
  open overlays to close no longer unlocks the page behind the one still open.
- The accessible name comes from `title` (wired as `aria-labelledby`) and the
  description from `description` (`aria-describedby`). A **title-less** overlay must
  be given the `aria-label` prop — both components accept it, and without a name the
  dialog announces as an unlabelled region.

When it closes:
- Focus **returns** to the element that opened it (the row or button the user
  activated), so a keyboard user is not dumped back at the top of the page.

If you build any custom overlay (you generally should not — use `Drawer` or
`Dialog`), it must do all of the above. A detail drawer resetting to its overview
tab on open is a content reset; focus return on close is separate and also required.

---

## Screen Readers: Name Everything

A control with no accessible name is announced as "button" with no context.

- Icon-only buttons must have a label. `TpIconButton` takes a `label` prop, and
  `Icon` takes a `label` — use them. A bell icon button is `label="Notifications"`,
  not an unlabelled glyph.
- Form inputs are associated with a label. `FieldGroup` wires `htmlFor` to the
  control — use it rather than placing a bare input with a floating text label.
- Images and meaningful SVGs have alt text or an accessible label; purely
  decorative ones are hidden from screen readers (`aria-hidden`).
- Status changes that matter (a toast firing, a row being removed) should be
  announced. The DS `ToastProvider` handles toast announcement — use it rather
  than a custom transient `<div>` that a screen reader never sees.

---

## Colour and Contrast

- Never rely on colour alone to convey meaning. The `ScorePill` pairs a colour
  with a number; `StatusBadge` pairs a colour with text. A red dot with no label
  is invisible to a colour-blind user — always pair colour with text or shape.
- Text on a coloured background uses a token combination that meets contrast.
  The token palette is designed for this — `--tp-ink` on `--tp-surface` is safe;
  cobalt-on-white as small body text is not (which is why cobalt is fills and
  accents only, never body text — see `brand.md`).
- **`--tp-ink-4` is not a text colour at any size.** It is `#9ca3af` — 2.54:1 on
  `--tp-surface`, 2.43:1 on `--tp-surface-2`, 2.33:1 on `--tp-surface-3`, 2.31:1 on
  `--nav-hover-fill`. AA asks 4.5:1 for normal text and 3.0:1 for large, so every
  one of those is below **both** floors. It stays legitimate for **placeholders,
  disabled controls** (WCAG 1.4.3 exempts those) **and icon glyphs sitting beside
  their own label** — never for running text, a label, a hint or a timestamp.
- The faintest step that *is* text is `--tp-ink-3` — and even that depends on what
  is behind it: 4.83:1 on `--tp-surface` and 4.63:1 on `--tp-surface-2` (pass),
  4.43:1 on `--tp-surface-3` and 4.39:1 on `--nav-hover-fill` (fail). A token is
  never "AA" on its own; a *pair* is. Check the surface before you pick the ink.
- The existing `--tp-ink-4`-as-text usages are capped by a repo-wide ratchet
  (`packages/ui/src/inkFourContrast.test.ts`), an equality assertion that fails both
  when the count grows and when it silently shrinks. Do not add one — the number may
  only come down.

---

## Motion and `prefers-reduced-motion`

Some users experience motion sickness or vestibular disorders from animation.
TruePoint honours the preference **globally, once**: `packages/ui/src/tokens.css`
ends with a kill-switch that every app inherits by importing that stylesheet.

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
```

So a **CSS** animation or transition you add needs no per-animation wrapper — it
already collapses to near-instant, the `Skeleton` shimmer and the drawer slide
included. `@media (prefers-reduced-motion: no-preference)` around your keyframes is
still good practice and does no harm, but it is not what makes the surface
compliant, and its absence is not a bug.

What the global rule **cannot** reach is **JS-driven** motion — a
`requestAnimationFrame` loop, a scroll tween, a chart or canvas transition. Those
read the preference themselves:

```js
const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
```

Essential motion (a spinner indicating an in-flight request) can remain, but
keep it minimal. Decorative motion is the first thing to cut.

---

## Touch and Target Size

- Interactive targets are at least 44×44px effective size — this is why the
  standard row height is `--tp-row-h` (44px) and why `TpIconButton` is 32px with
  padding to reach the target. Do not shrink interactive controls below this.
- On mobile, the off-canvas sidebar's nav items and the TopBar hamburger stay
  ≥44px touch targets — keep them so.

---

## Verifying Accessibility

Before considering a surface done:
1. Put the mouse away. Tab through every interactive element. Can you reach and
   activate everything? Is the focus ring always visible?
2. Open every drawer/dialog with the keyboard. Does focus move in, trap, and
   return on close? Does Escape close it — and when a menu is open *inside* it,
   does the first Escape close only the menu?
3. Check every icon-only button has a `label`.
4. Check no meaning is carried by colour alone.
5. Turn on reduced-motion (OS setting) and confirm decorative animation stops.

These five checks catch the overwhelming majority of real accessibility bugs.
