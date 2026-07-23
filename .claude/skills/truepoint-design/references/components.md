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

> **Finding a component:** the **Decision Tree** below maps a use-case to a component; the
> **Component Props** sections are then listed alphabetically (`Alert` → `TpTextarea`).

---

## Decision Tree — Which Component?

Before reaching for a `<div>`, ask:

| I need to… | Use |
|---|---|
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
| Show loading skeleton | `LoadingState` or `Skeleton` |
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
| Inline badge / tag | `Badge` |
| Alert / banner | `Alert` |
| Horizontal rule | `Separator` |
| Pagination controls | `Pagination` |
| Spinner | `Spinner` |
| Toast notification | `useToast()` inside `ToastProvider` |
| Icon from Lucide | `Icon` |

---

## Component Props

### Alert
```ts
variant?: 'default' | 'destructive'
className?, id?, style?, children
```

### Avatar
```ts
name: string          // generates initials
size?: number         // px, default 28
style?
```

### Badge
```ts
variant?: 'default' | 'success'
className?, id?, style?, children
```

### Button (shadcn)
```ts
variant?: 'default' | 'outline' | 'ghost' | 'link'
size?: 'default' | 'sm' | 'full'
asChild?: boolean
className?, id?, style?, children
```

### Card
```ts
as?: 'section' | 'div' | 'article'    // default 'section'
style?, children
```
Has built-in `padding: 20`; override or extend via `style`.

### Checkbox (shadcn)
Standard HTML checkbox attributes + `className`, `id`, `style`, `children`.

### Combobox
```ts
options: Array<{ value: string; label: string; hint?: string }>
value: string | null
onChange?: (value: string) => void
placeholder?: string
searchPlaceholder?: string
emptyText?: string
className?
```

### DataTable
```ts
columns: Array<{
  key: string
  header: string | ReactNode
  cell: (row: Row) => ReactNode
  sortValue?: (row: Row) => string | number   // provide to enable client-side sort
  width?: number | string
  align?: 'left' | 'right' | 'center'
}>
rows: Array<Record<string, any>>
rowKey: (row, index) => string
onRowClick?: (row) => void
isSelected?: (row) => boolean
empty?: ReactNode              // shown when rows.length === 0
className?
```
Row height is `--tp-row-h` (44px). Hover actions: position absolutely at row
right, opacity 0 normally, 1 on row hover.

### Dialog
```ts
open: boolean
onClose: () => void
title?: ReactNode
description?: ReactNode
footer?: ReactNode
maxWidth?: number
children
```

### Drawer
```ts
open: boolean
onClose: () => void
title?: ReactNode
side?: 'right' | 'left'    // default 'right'
width?: number             // applied as max-width; no default
footer?: ReactNode
children
```
A contact detail drawer built on `Drawer` should use `width={480} side="right"` and reset to
`tab='overview'` via `useEffect([contact?.id])` when `contact` changes. (There is no
`ContactDrawer` export in `@leadwolf/ui` today — compose one from `Drawer` in the app.)

### DropdownMenu
```ts
trigger: (args: { toggle: () => void; open: boolean }) => ReactNode
items: Array<{
  label: ReactNode
  onSelect?: () => void
  icon?: ReactNode
  danger?: boolean
  separatorBefore?: boolean   // renders a divider above this item
}>
align?: 'start' | 'end'
side?: 'top' | 'bottom'
```

### EmptyState
```ts
icon?: ReactNode
title: string
description?: string
action?: ReactNode     // typically a TpButton
style?
```
One muted glyph max. No walls of text. One action max.

### ErrorState
```ts
title?: string
detail?: string
onRetry?: () => void
retryLabel?: string
style?
```

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
icon: LucideIcon
size?: number
strokeWidth?: number
className?, style?, label?
```

### Input (shadcn)
Standard HTML input attributes + `className`, `id`, `style`, `ref`.

### Label (shadcn)
```ts
asChild?: boolean
style?, className?, id?, children, ref
```

### LoadingState
```ts
rows?: number    // skeleton row count, default 4
label?: string
style?
```
Default loading body for cards and lists. Use inside `StateSwitch.skeleton`.

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
trigger: (args: { toggle: () => void; open: boolean }) => ReactNode
align?: 'start' | 'end'
side?: 'top' | 'bottom'
className?, children
```

### Progress
```ts
value: number           // 0–100 (or 0–max)
max?: number
tone?: 'success' | 'ink' | 'cobalt' | 'warning' | 'danger'
label?: string
className?, style?
```

### RadioGroup / RadioOption
Standard HTML radio attributes + `className`, `id`, `style`, `children`.

### SegmentedControl
```ts
items: Array<{ value: string; label: string }>
value: string
onChange: (value: string) => void
className?
```
Use for period pickers, view switches with 2–4 options.

### Separator
```ts
label?: string     // optional centre label
className?, id?, style?, children
```

### Skeleton
```ts
width?: number | string
height?: number | string
radius?: number | string
style?
```
Single shimmer block. Compose multiples for custom skeletons.
`opacity`-only animation — reduced-motion safe.

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
label: string
value: string | number
sublabel?: string
trend?: ReactNode        // a trailing accessory (e.g. a StatusBadge or trend chip)
style?
```

### StatusBadge
```ts
tone: 'success' | 'warning' | 'danger' | 'muted'
style?, children
```
Suggested stage→tone mapping (not a `@leadwolf/ui` export — define it in the
owning feature if needed):
```js
const STAGE_TONE = {
  New: 'muted', Qualified: 'success', Proposal: 'warning',
  Negotiation: 'warning', Won: 'success', Lost: 'danger'
}
```

### Tabs
```ts
items: Array<{ value: string; label: string }>
value: string
onChange: (value: string) => void
className?
```
Renders tab bar only — tab panel content is your responsibility.

### ToastProvider + useToast
```jsx
// Wrap subtree once (at the app root)
<ToastProvider>{children}</ToastProvider>

// Call anywhere inside
const { toast } = useToast();
toast({ title: 'Saved', description: 'Contact updated.' });        // tone?: 'default' | 'success' | 'error'
toast({ title: 'Error', tone: 'error' });
```

### Tooltip
```ts
label: string
children: ReactNode   // the trigger element
```

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
label?: string
style?, className?, id?, children
```
+ standard HTML checkbox attributes.

### TpChip
```ts
active?: boolean
onClick?: () => void
onRemove?: () => void   // shows × button
className?, children
```
For filter chips: `active` = chip is applied, `onRemove` = clear this filter.

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
style?, className?, id?, children
```
+ standard HTML checkbox attributes (`checked`, `onChange`, etc.)

### TpTextarea
```ts
invalid?: boolean
className?, id?, style?
```
+ all standard HTML textarea attributes.
