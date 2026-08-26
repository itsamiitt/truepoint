# Component Reference

The components are exported from `@leadwolf/ui` (real path `packages/ui`) and
**imported normally**: `import { Card, TpButton, DataTable } from '@leadwolf/ui'`.
The two families live there side by side: the `Tp*` family in
`packages/ui/src/components/controls.tsx`, and the shadcn family in
`packages/ui/src/components/ui/*.tsx`. (Earlier material described accessing them via
a `window.TruePointUI` global inside function bodies — that was a prototype
workaround; with the package model there is no global and no load-order dance.
Anywhere this file or others show `window.TruePointUI` destructuring, use a normal
import instead.) Props are listed exactly as declared — `Tp*` controls also accept
standard HTML form attributes even when omitted from this list.

> **Both families render in every app.** The shadcn family used to be styled with
> Tailwind utilities, which only resolved in `apps/auth` — the one app that loads
> `tailwindcss` + `theme.css` — so in `web`/`admin`/`forge` those components put class
> names in the DOM with no CSS behind them and rendered as unstyled markup. They are
> now written against the same `primitives.css` classes as the `Tp*` family. Pick by
> API, not by app: `Button` is the one with `asChild`; `Input`/`Checkbox`/
> `RadioOption` are the no-JS-friendly native controls (they submit without
> JavaScript, which the auth flows need); `Tp*` is the prop-driven family with
> `loading`, `leftIcon`, `invalid` and friends.
>
> Dropped along the way: `@radix-ui/react-label`, `lucide-react` and
> `class-variance-authority` are no longer `@leadwolf/ui` dependencies. `react-dom` is
> now a peer, and the package declares `sideEffects: ["*.css"]` so a consumer's
> bundler can drop what it does not use.

> **Verify before you trust this file.** It is a map of `packages/ui/src`; the source
> is the territory. If a prop here disagrees with the component, the component wins.
> The *behaviour* claims below (focus, keyboard, ARIA) are asserted against a real DOM
> in `packages/ui/src/components/overlay.domtest.tsx` and `keyboard.domtest.tsx` — run
> `bun run test:dom` to see them, and read them when a claim here surprises you.

> **Finding a component:** the **Decision Tree** below maps a use-case to a component; the
> **Component Props** sections are then listed alphabetically (`Alert` → `TpTextarea`),
> with the `cn` helper last.

---

## Decision Tree — Which Component?

Before reaching for a `<div>`, ask:

| I need to… | Use |
|---|---|
| Wrap a page's content | `PageContainer` — the ONE page container; never a hand-rolled `max-width` |
| Head a page (title / eyebrow / subtitle / actions) | `PageHeader` |
| Show a data table / list | `DataTable` |
| Show a stat / metric | `StatTile` |
| Show status of a record | `StatusBadge` |
| Show a score (0–100 with colour) | the ScorePill *recipe* (inlined in the lists Data-Health cell — see patterns.md; not a component export) |
| Show a user's initials/avatar | `Avatar` |
| Show a pill/tag on a row | `TpChip` |
| Show a progress bar | `Progress` |
| Group content in a white card | `Card` |
| Open a flyout panel | `Drawer` |
| Open a modal confirmation | `Dialog` |
| Show a contextual menu | `DropdownMenu` |
| Show a hover tooltip | `Tooltip` |
| Show an anchored popover | `Popover` |
| Show a loading skeleton for a card or list | `LoadingState` (avatar + two lines per row) |
| Show a loading skeleton **for a `DataTable`** | `TableSkeleton` — a header band + per-column blocks. `LoadingState` in front of a grid makes the first paint lie about what is coming |
| Show one shimmer block, composing my own | `Skeleton` |
| Show empty state | `EmptyState` |
| Show error state | `ErrorState` |
| Switch between all four async states | `StateSwitch` |
| Primary action button | `TpButton variant="primary"` |
| Secondary / ghost button | `TpButton variant="secondary"` or `"ghost"` |
| Destructive action | `TpButton variant="danger"` |
| Icon-only button | `TpIconButton` |
| Text input | `TpInput` |
| Textarea | `TpTextarea` |
| Select / dropdown input | `TpSelect` |
| Checkbox | `TpCheckbox` |
| Toggle switch | `TpSwitch` |
| Filter chip (removable) | `TpChip` with `onRemove` |
| Tab switcher | `Tabs` |
| Segmented control | `SegmentedControl` |
| Search with suggestions | `Combobox` |
| Form field with label + error | `FieldGroup` |
| Form section with title | `FormSection` |
| Two-column form row | `FormRow` |
| Inline badge / tag | `Badge` (monochrome, or `variant="success"`) |
| Inline form/banner message | `Alert` — `destructive` for errors, `default` for a muted note |
| Horizontal rule, or an "or" divider | `Separator` (pass `label` for the centred divider) |
| Pagination controls | `Pagination` |
| Spinner | `Spinner` |
| Toast notification | `useToast()` inside `ToastProvider` |
| Icon from Lucide | `Icon` |
| Join class names conditionally | `cn` (clsx + tailwind-merge) |

`Badge`, `Alert` and `Separator` are **not auth-only** any more — see the note at the
top of this file. Use them anywhere.

---

## Component Props

### Alert
```ts
variant?: 'default' | 'destructive'
className?, id?, style?, children
```

### Avatar
```ts
name: string | null | undefined   // generates up to two initials; null/empty → "?"
size?: number                     // px, default 28
style?
```
`aria-hidden` — it is decorative. The name it derives from must also be visible as
text beside it.

### Badge
```ts
variant?: 'default' | 'success'
className?, id?, style?, children
```
`success` is **success-green**, not cobalt. It used to tint with cobalt, which meant
the package shipped two "success" states in two different hues (this and
`StatusBadge`) — colour is the whole signal on a badge, so they have to agree.

### Button (shadcn)
```ts
variant?: 'default' | 'outline' | 'ghost' | 'link' | 'destructive'
size?: 'default' | 'sm' | 'full'
asChild?: boolean
className?, id?, style?, children, ref
```
36px tall, same visual contract as `TpButton` (`default` → the ink primary fill,
`outline` → secondary, `destructive` → danger). `asChild` (Radix `Slot`) lets an `<a>`
wear the button; with it, no `type` attribute is emitted. `buttonVariants({ variant,
size, className })` is exported as a **plain helper function** returning the class
string — use it to style a non-button element to match. (It is no longer a CVA
object; `class-variance-authority` was dropped.)

### Card
```ts
as?: 'section' | 'div' | 'article'    // default 'section'
style?, children
```
`--tp-surface-2` fill, hairline border, `var(--tp-radius-card)` (14px) and
`var(--tp-shadow-card)` — those two tokens were defined for the card and went unused
for a year, so the shipped card sat at the generic 8px with no elevation. Padding is
`var(--tp-space-5)`; override or extend via `style`.

### Checkbox (shadcn)
Standard HTML checkbox attributes + `className`, `id`, `style`. A native
`<input type="checkbox">` — it submits with **no JavaScript**, which the "trust this
device" box needs — painted with the house ink fill (matching `TpCheckbox`; the old
Tailwind version filled cobalt, so the package shipped two checkboxes that checked in
two different colours). It renders no label: compose it inside a `<label>`.

### Combobox
```ts
options: Array<{ value: string; label: string; hint?: string }>
value: string | null
onChange: (value: string) => void
onQueryChange?: (query: string) => void   // server-side search; debounce upstream
loading?: boolean                          // shows the searching state
placeholder?: string
searchPlaceholder?: string
emptyText?: string          // default "No matches"
loadingText?: string        // default "Searching…"
className?
```
A **real ARIA combobox**: the search input carries `role="combobox"` and keeps DOM
focus, pointing at the visually-active option via `aria-activedescendant`; the
`role="listbox"` holds **only** options. (The previous shape wrapped the input in the
listbox — invalid, and arrow keys did nothing.) Keyboard: ArrowUp/ArrowDown wrap,
Home/End jump, Enter selects, Escape closes; selection and Escape both return focus
to the trigger.

Pass `onQueryChange` for a server-driven picker — the DS then stops filtering
client-side (it would fight the caller's narrowing) and renders `loadingText` instead
of `emptyText` while `loading`.

### DataTable
Generic in the row type — `DataTable<T>`; `columns`, `rows`, `rowKey`, `onRowClick`
and `isSelected` all share that `T`, so cells are typed rather than
`Record<string, any>`.
```ts
columns: Array<{
  key: string
  header: ReactNode
  cell: (row: T) => ReactNode
  sortValue?: (row: T) => string | number   // provide to enable client-side sort
  width?: number | string
  align?: 'left' | 'right' | 'center'
}>
rows: T[]
rowKey: (row: T, index: number) => string
onRowClick?: (row: T) => void
isSelected?: (row: T) => boolean
empty?: ReactNode              // shown when rows.length === 0
className?
```
What it gives you, and must not be re-implemented on top of:
- **Sortable headers are real `<button>`s inside the `<th>`**, not a click handler on
  the `th`; every `th` carries `scope="col"` and the active one `aria-sort`.
- **A row with `onRowClick` is a control**: `tabIndex={0}`, activating on Enter or
  Space, and ignoring keys that bubbled up from a control *inside* the row.
- **Selection is `data-selected`**, not `aria-selected` — `aria-selected` on a plain
  `<tr>` outside a grid/treegrid is invalid ARIA. Style off the data attribute.
- **Above 100 rows it window-virtualizes** (a *window* virtualizer, because the page
  scrolls, not the wrapper). While virtualizing it sets `aria-rowcount` on the table
  and `aria-rowindex` on each row, so a screen reader is not told a 4,000-row table
  has 24 rows. Below the threshold nothing changes.
- Row height is `--tp-row-h` (44px), or `--tp-row-h-compact` under compact density.
  Hover actions: opacity 0 → 1 on row hover **and `:focus-within`**.

### Dialog
```ts
open: boolean
onClose: () => void
title?: ReactNode
description?: ReactNode
footer?: ReactNode
maxWidth?: number
'aria-label'?: string      // required when there is no `title`
children
```

### Drawer
```ts
open: boolean
onClose: () => void
title?: ReactNode
side?: 'right' | 'left'    // default 'right'
width?: number             // applied as max-width; no default (CSS caps at 460px)
footer?: ReactNode
'aria-label'?: string      // required when there is no `title`
children
```

Both overlays: **portal-rendered on `document.body`**, focus moves in on open, Tab is
**trapped**, focus **returns to the opener** on close, Escape closes only the
**top-most** layer (shared `overlayStack.ts`), and body-scroll lock is
reference-counted across modal layers. `title` becomes `aria-labelledby` and (on
`Dialog`) `description` becomes `aria-describedby`; with no `title`, pass
`aria-label` or the overlay is unnamed. Do not hand-roll any of this — an
`aria-modal` overlay without a trap is worse than no ARIA at all.

A detail drawer built on `Drawer` typically uses `width={480} side="right"` and resets
to `tab='overview'` via `useEffect([contact?.id])` when the record changes. (There is
no `ContactDrawer` export in `@leadwolf/ui` — compose one in the app; `apps/web`'s
`QuickViewDrawer` is the shipped example.)

### DropdownMenu
```ts
trigger: (args: { toggle: () => void; open: boolean; props: TriggerProps }) => ReactNode
items: Array<{
  label: ReactNode
  onSelect?: () => void
  icon?: ReactNode
  danger?: boolean            // renders in --danger-700
  separatorBefore?: boolean   // renders a divider above this item
}>
align?: 'start' | 'end'       // default 'end'
side?: 'top' | 'bottom'
```
The trigger render-prop now hands back a **third field, `props`**, carrying
`aria-haspopup` / `aria-expanded` / `aria-controls`. Spread it — that is how the DS
wires the ARIA relationship instead of forty call sites doing it by hand:

```jsx
<DropdownMenu
  trigger={({ toggle, props }) => (
    <TpIconButton label="Row actions" {...props} onClick={toggle}>
      <Icon icon={MoreVertical} size={15} />
    </TpIconButton>
  )}
  items={items}
/>
```
Old two-field destructuring (`{ toggle, open }`) still compiles — `props` is additive.

It is a **real ARIA menu**: focus moves onto the first `menuitem` when it opens,
ArrowUp/ArrowDown walk the items (wrapping), Home/End jump to the ends, Escape closes
the top-most layer, Tab leaves the widget entirely, and selecting or leaving returns
focus to the trigger.

### EmptyState
```ts
icon?: ReactNode
title: ReactNode
description?: ReactNode
action?: ReactNode     // typically a TpButton
style?
```
One muted glyph max. No walls of text. One action max.

### ErrorState
```ts
title?: ReactNode      // default "Something went wrong"
detail?: ReactNode
onRetry?: () => void
retryLabel?: string    // default "Try again"
style?
```
`role="alert"` — it announces itself when it replaces the content.

### FieldGroup
```ts
label?: ReactNode
hint?: ReactNode
error?: ReactNode
htmlFor?: string
className?, children
```
Wraps a single form control with label above, error/hint below.

### FormRow
```ts
label?: ReactNode
description?: ReactNode
className?, children
```
Two-column layout: label+description left, control right.

### FormSection
```ts
title?: ReactNode
description?: ReactNode
className?, children
```
Named section within a settings/config form.

### Icon
```ts
icon: IconComponent      // structural: (SVGProps & { size?, strokeWidth? }) => Element
size?: number            // default 16
strokeWidth?: number     // default 1.75
className?, style?, label?
```
`IconComponent` is a **structural** type, not a lucide import — lucide-react glyphs
satisfy it, and `@leadwolf/ui` no longer depends on `lucide-react`, so the glyph comes
from the consuming app. Decorative by default (`aria-hidden`); passing `label` turns it
into a labelled `role="img"` graphic.

### Input (shadcn)
Standard HTML input attributes + `className`, `id`, `style`, `ref`. A native `<input>`
on the `.tp-ui-field` class — identical to `TpInput`, submits and validates with no
JavaScript, turns its border red on `aria-invalid`, and takes the grey focus ring from
the global `:focus-visible` rule.

### Label (shadcn)
```ts
// native <label> props
htmlFor?, style?, className?, id?, children, ref
```
A real `<label>` — pair it with an `Input` via `htmlFor`/`id`. **No `asChild`**:
Radix's Label primitive was dropped (it exists to forward clicks when the label is
*not* a real `<label>`, which was never the case here).

### LoadingState
```ts
rows?: number    // skeleton row count, default 4
label?: string   // default "Loading"
style?
```
The **card/list** loading body — an avatar circle plus two lines per row. For a
`DataTable`, use `TableSkeleton` instead. Use inside `StateSwitch.skeleton`.

### PageContainer
```ts
width?: 'fluid' | 'default' | 'narrow'   // default 'default'
className?, children
```
The ONE page container, and the layout peer of `PageHeader`. It **always centres**;
only the cap varies — `fluid` no cap (tables, lists, search), `default`
`--tp-page-max` (1280px), `narrow` `--tp-page-max-narrow` (880px). Padding is
responsive, which is why it is a component and not an inline style. It exists because
eighteen per-feature `.page` classes had invented ten different max-widths and fifteen
of them forgot `margin: auto`, pinning content flush-left. Do not hand-roll a
replacement.

### PageHeader
```ts
eyebrow?: ReactNode      // mono uppercase marker; its presence selects the "cockpit" variant
title: ReactNode
subtitle?: ReactNode
actions?: ReactNode      // right-aligned (e.g. a TpButton)
className?
```
Renders `<header data-variant="cockpit|destination">` with an `<h1>`. Two variants:
**cockpit** (with `eyebrow`, a larger responsive title — the Home surface) and
**destination** (everything else). One `PageHeader` per page.

### Pagination
```ts
onPrev?: () => void
onNext?: () => void
hasPrev?: boolean
hasNext?: boolean
label?: string     // e.g. "Page 2 of 14"
className?
```

### Popover
```ts
trigger: (args: { toggle: () => void; open: boolean; props: TriggerProps }) => ReactNode
children: ReactNode | ((close: () => void) => ReactNode)
align?: 'start' | 'end'
side?: 'top' | 'bottom'    // 'top' opens upward, for triggers near the bottom edge
className?
```
Same third `props` field as `DropdownMenu` — spread it onto the trigger for
`aria-expanded`/`aria-controls`. `children` may be a **render-prop receiving `close`**,
so a panel's own action can dismiss it without the caller tracking open state. Joins
the shared overlay stack: outside-pointerdown closes it, and Escape closes it only
when it is the top-most layer (returning focus to whatever had it when the layer
opened).

### Progress
```ts
value: number           // 0–100 (or 0–max)
max?: number
tone?: 'success' | 'ink' | 'cobalt' | 'warning' | 'danger'
label?: string
className?, style?
```

### RadioGroup / RadioOption
Standard HTML radio attributes + `className`, `id`, `style`, `children`. Native
`<input type="radio">` rows (the org/workspace pickers submit with **no JavaScript**);
the selected row highlights via CSS `:has(:checked)`, no JS. Give every `RadioOption`
in a group the same `name` and mark the first `defaultChecked`.

### SegmentedControl
```ts
items: Array<{ value: string; label: ReactNode }>
value: string
onChange: (value: string) => void
className?
'aria-label'?: string
```
Use for period pickers and view switches with 2–4 options. It is a
**`role="radiogroup"` of `role="radio"` with `aria-checked`** — *not* a tablist. It
picks a value (a period, a scope, a view), it does not switch a panel; calling it a
tablist told screen-reader users to expect a panel that never existed. Roving
tabindex + ArrowLeft/Right/Up/Down (wrapping) + Home/End, focus following selection.

### Separator
```ts
label?: ReactNode     // optional centre label — renders the "or" divider
className?, id?, style?, children
```
Without `label` it is a decorative hairline with no role.

### Skeleton
```ts
width?: number | string
height?: number | string
radius?: number | string
style?
```
Single shimmer block. Compose multiples for custom skeletons.
`opacity`-only animation, and reduced-motion is handled globally by `tokens.css`.

### Spinner
```ts
size?: number
label?: string    // sr-only accessible label
style?
```

### StateSwitch
```ts
loading?: boolean
error?: unknown       // truthy = show error state
empty?: boolean
onRetry?: () => void
skeleton?: ReactNode       // defaults to LoadingState
emptyState?: ReactNode     // defaults to EmptyState
errorState?: ReactNode     // defaults to ErrorState
children: ReactNode        // shown when populated
```
The single correct way to handle async state. Use on every data surface.

### StatTile
```ts
label: ReactNode
value: ReactNode
sublabel?: ReactNode
trend?: ReactNode        // a trailing accessory (e.g. a StatusBadge or trend chip)
style?
```

### StatusBadge
```ts
tone?: 'success' | 'warning' | 'danger' | 'muted'   // optional — defaults to 'muted'
style?, children
```
The tone colours a **dot**, never the label text (the label stays `--tp-ink-2`), which
is why the base `--success`/`--warning`/`--danger` fill tones are correct here.
Suggested stage→tone mapping (not a `@leadwolf/ui` export — define it in the
owning feature if needed):
```js
const STAGE_TONE = {
  New: 'muted', Qualified: 'success', Proposal: 'warning',
  Negotiation: 'warning', Won: 'success', Lost: 'danger'
}
```

### TableSkeleton
```ts
rows?: number         // default 8
columns?: number[]    // relative flex weight per column; default [2,12,10,8,8,2]
label?: string        // default "Loading table"
style?
```
The **table-shaped** loading body: a muted header band plus per-column shimmer blocks.
Use this in front of a `DataTable` — `LoadingState` is the avatar-and-two-lines *card*
shape, and putting it there made every grid's first paint lie about what was coming.
Pass `columns` matching your real layout when you know it.

### Tabs
```ts
items: Array<{ value: string; label: ReactNode }>
value: string
onChange: (value: string) => void
className?
'aria-label'?: string
```
Renders the tab bar only — panel content is your responsibility. Implements the
tablist keyboard model: **roving tabindex** (one tab stop for the whole group) with
ArrowLeft/Right/Up/Down wrapping and Home/End, focus following selection. If you need
a *value* picker rather than a panel switcher, that is `SegmentedControl`.

### ToastProvider + useToast
```jsx
// Wrap subtree once (at the app root)
<ToastProvider>{children}</ToastProvider>

// Call anywhere inside
const { toast, success, error } = useToast();

success('Saved', 'Contact updated.');
error('Save failed', err.message);

toast({ title: 'Import running', tone: 'default',   // 'default' | 'success' | 'error'
        description: 'We will tell you when it finishes.',
        duration: 0 });                              // ms; 0 = sticky. Default 4000.
```
The live region (`aria-live="polite"`, labelled "Notifications") is **mounted always**,
empty or not — a region created in the same commit as its first content is the classic
reason first toasts go unannounced across NVDA/JAWS/VoiceOver. Every toast carries a
real **"Dismiss notification"** close button, which is what makes a sticky
(`duration: 0`) toast removable without a mouse.

### Tooltip
```ts
label: ReactNode
children: ReactNode   // the trigger element
```
`aria-describedby` is **cloned onto the trigger element** when `children` is a single
element (it used to sit on the wrapper `<span>`, which is never the element focus
lands on, so the tooltip was never announced). Escape dismisses it (WCAG 2.2 SC
1.4.13), and it joins the shared overlay stack so that press does not also close a
dialog underneath.

### TpButton
```ts
variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'link'
size?: 'sm' | 'md'
full?: boolean         // width: 100%
loading?: boolean      // shows spinner, disables
leftIcon?: ReactNode
rightIcon?: ReactNode
className?, id?, style?, children
```
+ standard HTML button attributes (`onClick`, `disabled`, `type`, etc.)

### TpCheckbox
```ts
label?: ReactNode
style?, className?, id?, children
```
+ standard HTML checkbox attributes. **`children` works as the label text**
(`{label ?? children}`) — either spelling renders the same `<span>`. It used to crash
React: children were spread onto the `<input>`, which is a void element.

### TpChip
```ts
active?: boolean
onClick?: () => void     // makes the chip body a button (e.g. a filter facet)
onRemove?: () => void    // shows the trailing × button
removeLabel?: string     // accessible name for the ×; default "Remove"
className?, children
```
For filter chips: `active` = chip is applied, `onRemove` = clear this filter.

**Always pass `removeLabel` when rendering a row of chips.** The default announces
eight identical "Remove" buttons and a screen-reader user cannot tell which filter
they are about to drop — name each one ("Remove filter Industry: Software").

Structure, which matters if you style it: the wrapper is **always a `<span>`**, the
pressable body is a `<button class="tp-ui-chip-body">`, and the × is a **sibling**
`<button>`, not a child. The old shape nested a `role="button"` span *inside* the
chip's own `<button>` — interactive content inside a button is invalid HTML with
undefined assistive-tech behaviour.

### TpIconButton
```ts
label: string     // aria-label — required
className?, id?, style?, children
```
32px square ghost icon button. Wrap icon as children.

### TpInput
```ts
invalid?: boolean
className?, id?, style?
```
+ all standard HTML input attributes (`value`, `onChange`, `placeholder`,
`disabled`, `type`, `onKeyDown`, etc.)

### TpSelect
```ts
invalid?: boolean
className?, id?, style?
```
+ all standard HTML select attributes + `<option>` children.

### TpSwitch
```ts
label?: ReactNode      // optional trailing label
style?, className?, id?, children
```
+ standard HTML checkbox attributes (`checked`, `onChange`, etc.). A native checkbox
with `role="switch"`. Same `children`-as-label behaviour as `TpCheckbox`
(`{label ?? children}`) — and the same history: passing children used to crash the
void `<input>`. With **no** label, give it an `aria-label`.

### TpTextarea
```ts
invalid?: boolean
className?, id?, style?
```
+ all standard HTML textarea attributes.

`invalid` on `TpInput`/`TpSelect`/`TpTextarea` sets `aria-invalid` as well as the
class, and `.tp-ui-field[aria-invalid="true"]` turns the border red — so a field made
invalid by a server response, without the prop, still looks invalid.

---

## `cn`

```ts
cn(...inputs: ClassValue[]): string
```
`clsx` + `tailwind-merge`. Join class names conditionally
(`cn('tp-ui-btn', active && 'is-active', className)`); it is what every DS component
uses internally, and it is exported for app code that composes classes on a CSS
module.
