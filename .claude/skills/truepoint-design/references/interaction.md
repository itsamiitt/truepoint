# Interaction Patterns

How TruePoint behaves in motion: when to animate, how forms validate, how
feedback is delivered, and how loading is shown. These are the moment-to-moment
interaction decisions that make a UI feel considered rather than thrown together.

---

## Motion

Motion in TruePoint is functional, not decorative. It shows relationships
(where a panel came from), provides feedback (a row settling after an action),
or directs attention (a new item appearing). It is never movement for its own sake.

**Use the motion tokens** (see `tokens.md`):
- `--tp-duration-fast` (120ms) — micro-interactions: hover background, button press
- `--tp-duration` (180ms) — standard: most transitions
- `--tp-duration-slow` (260ms) — larger: a drawer or panel entering
- `--tp-ease` for standard movement, `--tp-ease-out` for things entering

**Principles:**
- Animate `transform` and `opacity` only. They are GPU-accelerated and do not
  trigger layout. Animating `width`, `height`, `top`, or `left` causes jank —
  the Sidebar is the one deliberate exception (its width transition is measured
  and accepted).
- Keep durations short. Anything over ~300ms feels sluggish in a tool people use
  all day. Fast and subtle beats slow and showy.
- Every decorative animation respects `prefers-reduced-motion` (see
  `accessibility.md`). Wrap keyframes in `@media (prefers-reduced-motion: no-preference)`.
- Hover transitions are fine on desktop but must never be the *only* way to
  reveal something — keyboard focus must reveal it too.

When in doubt, less motion. A still interface that responds instantly often
feels better than one that animates every change.

---

## Form Validation

Forms validate in a way that helps the user finish, not one that scolds them
mid-typing.

**When to validate:**
- Validate a field **on blur** (when the user leaves it), not on every keystroke.
  Validating as someone types the third character of their email and flashing
  red is hostile.
- Re-validate **on submit** — catch anything still invalid and focus the first
  invalid field.
- Once a field has shown an error, *then* you may validate it live as they fix
  it, so they see the error clear in real time.

**How errors display:**
- Use `FieldGroup`'s `error` prop — it places the message directly under the
  field, associated with the input for screen readers.
- Use the control's `invalid` prop (`TpInput`, `TpSelect`, `TpTextarea` all take
  it) so the field itself shows the error state, not just the text.
- The message says what is wrong and how to fix it: "Enter a valid email
  address," not "Invalid input." Errors are specific and actionable (see
  `writing.md`).

**Submit state:**
- Disable the submit button while the mutation is in flight, and show its
  loading state (`TpButton loading`) so the user does not double-submit.
- On failure, keep the form filled — never clear a form on a failed submit. The
  user should be able to retry without re-entering everything (this mirrors the
  error-handling rule in the architecture skill).

---

## Feedback: Toast vs Inline vs Dialog

Match the feedback mechanism to the weight and location of the event.

| Situation | Mechanism |
|---|---|
| An action succeeded, no further attention needed | Toast (`useToast`) — brief, auto-dismiss |
| An action failed but is retryable | Destructive toast + keep the UI/form intact |
| A field is invalid | Inline error on the field (`FieldGroup` + `invalid`) |
| A destructive action needs confirmation first | `Dialog` — block until the user confirms or cancels |
| A whole data surface failed to load | `ErrorState` inside `StateSwitch` (not a toast) |
| Persistent context the user needs to keep seeing | `Alert` — stays in place, not transient |

**Rules:**
- A toast confirms; it does not ask. Anything requiring a decision is a `Dialog`,
  not a toast with buttons.
- Never use `alert()` or `confirm()` — use `Dialog`.
- Do not stack toasts for a bulk action — one toast summarising the result
  ("12 prospects added"), not twelve toasts.
- A failed load is not a toast — the user is looking at the surface, so the
  error belongs in the surface (`ErrorState`), where the retry is.

---

## Loading

Loading states keep the user oriented while data is in flight.

- Use `StateSwitch` with a `LoadingState` skeleton for any data surface (see the
  design skill's State Handling section). Never a bare centered spinner for a
  whole page — it tells the user nothing about what is coming.
- **Skeletons match the shape of the content they replace.** A list skeleton is
  rows the height of real rows; a card skeleton has the card's structure. A
  skeleton that looks nothing like the result causes a jarring layout shift when
  data arrives. Use `LoadingState rows={n}` sized to the expected result.
- A spinner (`Spinner`) is for a small in-flight action — a button submitting, a
  section refreshing — not for a full page or list.
- Avoid loading flashes for fast responses. If data usually returns in under
  ~200ms, a skeleton that appears and vanishes instantly is worse than a brief
  blank — react-query's cached data avoids most of this.

---

## Empty States

Distinguish two different empties — they need different copy:

- **First-run empty** (no data exists yet): invite the user to act. "No prospects
  yet — add your first" with the primary action. This is an opportunity, not a
  dead end.
- **Filtered-to-zero** (data exists, the filter excludes it all): tell them the
  filter is the cause. "No prospects match these filters" with a clear-filters
  action — not "add your first prospect," which is wrong and confusing here.

Use `EmptyState` for both, with copy and an action appropriate to which empty it
is. One muted glyph, a title, an optional line, one action — never a wall of text.
