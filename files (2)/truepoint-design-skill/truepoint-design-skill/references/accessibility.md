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
  failure, and the lint config already bans raw `<button>` to push you to the DS.
- Tab order follows visual order. If focus jumps around, the DOM order is wrong —
  fix the markup, do not patch with `tabindex` values above 0 (which create
  unpredictable focus traps).
- Interactive rows: the `DataTable` row click that opens the `ContactDrawer`
  must also be reachable by keyboard — the row is focusable and opens on Enter.
  Hover-revealed actions must become reachable on focus, not only on hover (see
  the focus-visible rule below).
- Never remove focus outlines without replacing them. `outline: none` with no
  visible focus state is an accessibility failure. The DS provides a focus ring
  (`--focus-ring`) — use it; do not strip it.

---

## Focus Management in Overlays

Drawers and dialogs are where focus handling matters most. The DS `Drawer` and
`Dialog` handle this — do not hand-roll an overlay that skips it.

When an overlay opens:
- Focus moves into the overlay (to the first focusable element or the heading).
- Focus is **trapped** inside while it is open — Tab cycles within the overlay,
  it does not leak to the page behind.
- Escape closes the overlay.

When it closes:
- Focus **returns** to the element that opened it (e.g. the row or button the
  user activated), so a keyboard user is not dumped back at the top of the page.

If you build any custom overlay (you generally should not — use `Drawer` or
`Dialog`), it must do all of the above. The `ContactDrawer` resetting to the
overview tab on open is a content reset; focus return on close is separate and
also required.

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
- Do not invent low-contrast greys for "subtle" text below `--tp-ink-4`. That
  token is already the faintest readable step.

---

## Motion and `prefers-reduced-motion`

Some users experience motion sickness or vestibular disorders from animation.
Every non-essential animation must be disabled under `prefers-reduced-motion`.

- The DS `Skeleton` shimmer is already reduced-motion-safe (opacity-only).
- Any animation you add — a drawer slide, a hover transition, a loading
  animation — wraps its keyframes so motion is opt-out:

```css
@media (prefers-reduced-motion: no-preference) {
  /* animation here — only runs when the user has NOT asked to reduce motion */
}
```

Essential motion (a spinner indicating an in-flight request) can remain, but
keep it minimal. Decorative motion is the first thing to cut.

---

## Touch and Target Size

- Interactive targets are at least 44×44px effective size — this is why the
  standard row height is `--tp-row-h` (44px) and why `TpIconButton` is 32px with
  padding to reach the target. Do not shrink interactive controls below this.
- On mobile, the `BottomNav` items are full-height touch targets — keep them so.

---

## Verifying Accessibility

Before considering a surface done:
1. Put the mouse away. Tab through every interactive element. Can you reach and
   activate everything? Is the focus ring always visible?
2. Open every drawer/dialog with the keyboard. Does focus move in, trap, and
   return on close? Does Escape close it?
3. Check every icon-only button has a `label`.
4. Check no meaning is carried by colour alone.
5. Turn on reduced-motion (OS setting) and confirm decorative animation stops.

These five checks catch the overwhelming majority of real accessibility bugs.
