# UI Patterns

Exact specifications for every repeating surface in TruePoint CRM.
These are fixed contracts — not suggestions. Deviating from them creates
inconsistency that multiplies as the product grows.

> **Contents:** Page Shell · Sidebar · Topbar · Density · Contact/Prospect Drawer ·
> Filter Bar/Smart Search · List Row · ScorePill · Responsive Breakpoints ·
> Stat Grid · Forms · Toasts · Page Content Padding

---

## Page Shell

The chrome is a **package**: `packages/app-shell` (`@leadwolf/app-shell`), shared by
`apps/web`, `apps/admin` and `apps/forge`. Before it existed each app carried its own
near-identical shell, which is how the three surfaces drifted apart.

It exports `AppShellFrame`, `Sidebar`, `TopBar` (plus `DensityToggle` and
`ShortcutsButton`), `NavItem`, `UserRow`, `Logo`/`Brandmark`/`Wordmark`,
`ShortcutsDialog`, `DensityProvider`/`useDensity`, `useSidebarPin`, the `nav.ts`
helpers, and `shell.css`. The `CommandPalette` component lives on its own subpath
(`@leadwolf/app-shell/palette`) so `cmdk` stays off every route's first load.

Each app **composes** those into its own `AppShell` — for the customer app,
`apps/web/src/components/shell/AppShell.tsx`. What stays per-app is what is genuinely
the app's: the auth/staff gate, the destination list (`navConfig.ts`), and the
app-specific top-bar widgets (`GlobalSearch`, `NotificationsBell`, `CreditPill`,
`OrgSwitcher`/`WorkspaceSwitcher`/`TeamSwitcher`).

Reuse both layers — never re-implement either.

Consume the stylesheet once per app, **after** the `@leadwolf/ui` sheets:
`@import "@leadwolf/app-shell/shell.css";`

```
Desktop / Tablet (≥ 769px)
┌──────────────────────────────────────────────────┐
│ .tp-shell — display:grid,                        │
│   grid-template-columns: var(--tp-rail-w) 1fr    │
│   <Sidebar />   (in-flow rail column — expands   │
│                  via :has(hover/focus) or pin)   │
│   <div>                                          │
│     <TopBar />                                   │
│     <main style={{ overflowY:'auto',             │
│                    background:'var(--tp-surface-2)' }}>
│       <CurrentView />                            │
│     </main>                                      │
│   </div>                                         │
│ </div>                                           │

Mobile (≤ 768px)
┌──────────────────────────────────────────────────┐
│ Same shell; the sidebar becomes a fixed          │
│ off-canvas overlay (translateX) behind a scrim,  │
│ opened by the TopBar hamburger. There is no      │
│ separate mobile nav component.                   │
```

**Adding a new view (Next.js App Router):**
1. Add a route under the authed route group: `app/(shell)/myview/page.tsx`
   (both apps use `(shell)` as the authed group)
2. Add its nav entry to the sidebar nav config so it appears in the shell
3. Build the page/feature as a feature module (see **truepoint-architecture**)
4. Do not create a new shell — the `(shell)` layout provides Sidebar/TopBar;
   the route inherits them for free

> Earlier prototype steps said "add to `NAV_ITEMS`" and "add a `case` to the view
> renderer in the app root". That single-file client-side view switcher is superseded by
> file-based routing: a surface is a route in the authed group, and the shared shell
> lives in that group's `layout.tsx` once (see the design skill SKILL.md, "Shell and
> Navigation"). Detail still opens in a drawer rather than navigating away.

---

## Sidebar

Fixed — do not modify. Reuse `Sidebar` from `@leadwolf/app-shell`
(`packages/app-shell/src/Sidebar.tsx`); do not redefine.

- The rail is an **in-flow grid column** of `.tp-shell` (`grid-template-columns:
  var(--tp-rail-w) 1fr`) — not an absolutely-positioned overlay
- Rail width: `60px` (token `--tp-rail-w`); expanded: `232px` (token `--tp-rail-expanded`)
- Expansion: CSS `:has(.tp-sidebar:hover)` / `:focus-within` — a **push**, not an
  overlay — plus a pin (`useSidebarPin` + the TopBar toggle); no JS mouse handlers
- Active item: `background: var(--tp-surface-3)`, `color: var(--tp-ink)`, with the
  glyph in `var(--tp-cobalt)` — a subtle surface fill only, no cobalt tint/bar
- Labels/badges: `opacity` transition `var(--tp-duration-fast)` (120ms), no delay;
  the column width rides `var(--tp-duration)` (180ms)
- Mobile (≤768px): the sidebar becomes a fixed off-canvas overlay behind a scrim
  (`box-shadow: var(--tp-shadow-rail)`), toggled by the TopBar hamburger. This is
  the ONE place `--tp-z-drawer` (40) applies — the desktop rail has no z-index at
  all, because it is an in-flow column rather than an overlay

---

## Topbar

Fixed — do not modify. Reuse `TopBar` from `@leadwolf/app-shell`
(`packages/app-shell/src/TopBar.tsx`); do not redefine.

- Height: `56px`, sticky, `background: var(--tp-surface)`
- Bottom: `1px solid var(--tp-hairline-2)`
- Left: sidebar pin toggle / mobile hamburger, then page title (`16px, 600`) +
  optional subtitle (`var(--tp-text-caption)`, `--tp-ink-3` — **not** ink-4, which
  fails contrast as text at every size)
- Right: `GlobalSearch` | `DensityToggle` | `ShortcutsButton` |
  `NotificationsBell` | `CreditPill`. `DensityToggle` and `ShortcutsButton` are
  exports of `@leadwolf/app-shell` (from `TopBar.tsx`) — do not hand-roll either as
  a bare `TpIconButton`. The other three are `apps/web`'s own
- `z-index: var(--tp-z-sticky)` = `30`

---

## Density

The shell's `DensityProvider` sets `data-density` on a wrapper; `primitives.css`
reads it for row height and cell padding.

- **44px (`--tp-row-h`) is the default and the design target** — the standard
  interactive row height, comfortably above every touch-target guideline.
- **32px (`--tp-row-h-compact`) is the user's own choice**, made by pressing the
  `DensityToggle`, and it still clears WCAG 2.2 SC 2.5.8's 24px minimum target size.
- Compact is never the default and is never hardcoded on a surface. Read the
  density, do not pick it for the user.

---

## Contact / Prospect Drawer

Open on any list row click. Never navigate away from the list.

There is no `ContactDrawer` component anywhere — the detail drawer is **composed
per feature from the DS `Drawer`**. The shipped example is `apps/web`'s
`QuickViewDrawer` (`src/features/prospect/components/QuickViewDrawer.tsx`); read it
before building another. The DS `Drawer` already handles the portal, the focus trap,
focus return, top-most-Escape and the scroll lock — you supply content, not
behaviour.

```
<Drawer open={!!contact} onClose={() => setContact(null)}
        width={480} side="right">

  [Non-scrolling header]                          ← position sticky top 0
  Avatar · Name (600) · Title (ink-3, 13px) · Company (ink-3, 13px)
  StatusBadge for stage
  Close button (TpIconButton, top-right)

  Key metrics strip (3 cols: Fit score | Deal value | Owner)
  Border bottom separating header

  <Tabs items={[overview, activity, deals, notes]}
        value={tab} onChange={setTab} />

  [Scrollable body — tab content]

  [Footer — sticky bottom]
  TpButton variant="primary" → Send email
  TpButton variant="ghost" → Log call
  TpIconButton → ⋮ more actions

</Drawer>
```

**Rules:**
- Reset `tab` to `'overview'` whenever `contact` changes:
  `useEffect(() => setTab('overview'), [contact?.id])`
- Overview tab: 2-col company grid, contact info, tech stack chips, signals
- Activity tab: timeline with connecting line, icon avatars, who/when metadata
- Deals tab: deal card (stage + value + owner), "Add deal" CTA
- Notes tab: `TpTextarea` + save button, then previous notes as surface-2 cards

---

## Filter Bar / Smart Search

Default state: compact `TpInput` (height `40px`). No filter chrome shown.

**When typing:**
- Grouped suggestion dropdown appears below input
- Max 4 suggestions per category when no query
- All matching results when querying
- Keyboard nav: arrow keys move selection, Enter applies, Escape closes

**When filters are applied:**
- Chip row appears below input, separated by `1px solid var(--tp-hairline)`
- Each active filter is a `<TpChip active onRemove={() => removeFilter(key, value)}>`
- "Clear all" link appears only when chips are present
- Never show "No filters applied" text — hide the chip row entirely

**Chip row:**
```jsx
{hasActiveFilters && (
  <div style={{ padding:'var(--tp-space-2) var(--tp-space-6)',
                borderTop:'1px solid var(--tp-hairline)',
                display:'flex', gap:'var(--tp-space-2)', flexWrap:'wrap', alignItems:'center' }}>
    {activeChips.map(chip => (
      <TpChip
        key={chip.key+chip.value}
        active
        onRemove={() => removeFilter(chip)}
        // Name every remove control. The default is "Remove", which is fine for a lone
        // chip and wrong for a ROW: eight identical "Remove" buttons tell a screen-reader
        // user nothing about which filter they are about to drop.
        removeLabel={`Remove filter ${chip.cat}: ${chip.value}`}
      >
        {chip.cat}: {chip.value}
      </TpChip>
    ))}
    <TpButton variant="link" size="sm" onClick={clearAll}>Clear all</TpButton>
  </div>
)}
```

"Clear all" is a `TpButton variant="link"` — not a raw `<button>` with inline colour.
The DS variant already carries the link treatment, the focus ring and the hit area,
and a raw `<button>` where a DS equivalent exists is a hard-rule violation.

---

## List Row (DataTable)

Standard row anatomy (all list views):

```
Avatar (28–32px) | Name (600) + subtitle (ink-3, 11–12px)
| Company | StatusBadge | ScorePill | Value (tabular-nums, 600)
```

- Row height: `44px` via `--tp-row-h` (`--tp-row-h-compact`, 32px, when the user has
  chosen compact density — see **Density** above)
- Hover actions: positioned right side, `opacity: 0 → 1` on row hover
  ```jsx
  // Inside a DataTable column's cell (icons: lucide-react via the DS Icon wrapper)
  cell: (row) => (
    <div style={{ display:'flex', gap:'var(--tp-space-1)',
                  opacity: revealed ? 1 : 0,
                  transition:'opacity var(--tp-duration-fast) var(--tp-ease)' }}>
      <TpIconButton label="Call" onClick={...}><Icon icon={Phone} size={15}/></TpIconButton>
      <TpIconButton label="Email" onClick={...}><Icon icon={Mail} size={15}/></TpIconButton>
    </div>
  )
  ```
  **`revealed` must be hover OR focus.** Actions that appear on `:hover` alone do not
  exist for a keyboard user — pair the CSS selector with `:focus-within`, or include
  focus in the state that drives the opacity.
- Row click: opens the detail drawer (a `Drawer` composition — see above) — never
  navigates away. `DataTable` makes a row with `onRowClick` focusable and activates
  it on Enter/Space for you; do not add your own `<tr>` key handler

---

## ScorePill (Recipe)

ScorePill is a *recipe*, not a component: today it is inlined in the lists
Data-Health cell (`apps/web/src/features/lists/components/ListDetailPage.tsx`), where
it is written with a **CSS module** (`../lists.module.css`) and paired with a
freshness `StatusBadge`. **Match the shipped recipe** — read that cell before writing
a new one — and extract it to a shared component on second use rather than redefining
variants. The sketch below is the shape, not a file to copy verbatim:

```jsx
function ScorePill({ score }) {
  const tone = score >= 80 ? 'var(--success)'
             : score >= 50 ? 'var(--warning)'
             : 'var(--tp-ink-4)';
  return (
    <span style={{ display:'inline-flex', alignItems:'center', gap:'var(--tp-space-1)',
                   fontVariantNumeric:'tabular-nums', fontWeight:600,
                   fontSize:'var(--tp-text-body)' }}>
      <span style={{ width:6, height:6, borderRadius:999, background:tone, flexShrink:0 }} />
      {score}
    </span>
  );
}
```

Always: dot + number, tabular-nums, `fontWeight: 600`, `var(--tp-text-body)` (13px).
The tone tokens are correct here because they colour a **dot** — a non-text graphic.
If a variant ever puts the status colour on the *number*, it must switch to
`--success-700` / `--warning-700` (see tokens.md).

---

## Responsive Breakpoints

Responsive behaviour is driven by **CSS media queries**, not a shared JS hook — there
is no `useBreakpoint` in the codebase. If a client component genuinely needs the
current breakpoint in JS, read it with `window.matchMedia(...)` inside an effect
(never `window.innerWidth`).

Where the queries live:
- **Shell breakpoints** — `packages/app-shell/src/shell.css`. That file owns when the
  rail collapses to an off-canvas overlay and when the topbar tightens. Do not
  re-declare shell behaviour in an app stylesheet.
- **Feature breakpoints** — each app's own stylesheet (`apps/web/src/app/globals.css`
  and the feature `*.module.css` files) carries its own `@media` rules.
- **`--tp-bp-*` are documentation tokens.** CSS cannot interpolate a `var()` into a
  media query, so every rule spells the number out; the tokens exist so a fourth
  value never gets invented. Use 769 / 768 / 480 and nothing else.

The three documented viewports:

| Breakpoint | Layout changes |
|---|---|
| Desktop ≥ 769px | Full sidebar rail + topbar search visible |
| Mobile ≤ 768px | Sidebar off-canvas (hamburger) + topbar search hidden + 2-col stat grid |
| Small ≤ 480px | Fewer table columns + tightest spacing |

Mobile DataTable columns: hide `loc` and `email`. Show only: Prospect, Company, Fit, Value.

---

## Stat Grid

```jsx
<div style={{
  display: 'grid',
  gridTemplateColumns: tablet ? 'repeat(2, 1fr)' : 'repeat(4, 1fr)',
  gap: 'var(--tp-space-4)',
  padding: 'var(--tp-space-6)',
}}>
  {STATS.map(s => (
    <StatTile key={s.label}
      label={s.label}
      value={s.value}
      sublabel={s.detail}
      trend={<StatusBadge tone={s.up ? 'success' : 'danger'}>{s.delta}</StatusBadge>}
    />
  ))}
</div>
```

---

## Forms (Settings / Config)

Use `FormSection` → `FormRow` → `FieldGroup` → control.

```jsx
<FormSection title="Notifications" description="Control what you get notified about.">
  <FormRow label="Email digest" description="Daily summary of activity">
    <TpSwitch checked={emailDigest} onChange={e => setEmailDigest(e.target.checked)} />
  </FormRow>
  <FormRow label="CRM stage changes" description="Alert on deal stage transitions">
    <TpSwitch checked={stageAlerts} onChange={e => setStageAlerts(e.target.checked)} />
  </FormRow>
</FormSection>

<FormSection title="Contact owner">
  <FieldGroup label="Default owner" htmlFor="owner-select">
    <TpSelect id="owner-select" value={owner} onChange={e => setOwner(e.target.value)}>
      <option value="">Unassigned</option>
      {owners.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
    </TpSelect>
  </FieldGroup>
</FormSection>
```

---

## Toasts

Wrap the app root once in `<ToastProvider>`. Call from any component:

```jsx
const { toast, success, error } = useToast();

// Shorthands for the two common tones
success('Contact saved', 'Changes applied.');
error('Save failed', err.message);

// The full form — `duration` in ms; 0 keeps it until dismissed (default 4000)
toast({ title: 'Import running', description: 'We will tell you when it finishes.',
        duration: 0 });
```

The live region is mounted always (empty or not), so the *first* toast is announced —
a region created in the same commit as its first content is the classic reason first
toasts go unheard. Every toast also carries a real "Dismiss notification" close
button, which is what makes a sticky (`duration: 0`) toast removable without a mouse.

Never use `alert()` or custom inline error states for transient feedback.

---

## Page Content Padding

Use the DS primitives — both are `@leadwolf/ui` exports, and both are the reason ten
different per-feature max-widths stopped accumulating:

```jsx
<PageContainer width="fluid">            {/* tables, lists, search — no cap */}
  <PageHeader title="Prospects" subtitle="…" actions={<TpButton>Refresh</TpButton>} />
  …
</PageContainer>
```

`PageContainer` always centres; only the cap varies (`fluid` | `default` 1280px |
`narrow` 880px) and its padding is responsive. Do **not** hand-roll a page wrapper
with a `max-width` — that is how the flush-left dead-gutter bug came back the first
five times.

For sections within a page that need vertical separation:
```jsx
<div style={{ marginBottom: 'var(--tp-space-8)' }}>
```

Never use padding values not on the spacing scale.
