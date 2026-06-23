# UI Patterns

Exact specifications for every repeating surface in TruePoint CRM.
These are fixed contracts — not suggestions. Deviating from them creates
inconsistency that multiplies as the product grows.

---

## Page Shell

```
Desktop / Tablet (≥ 640px)
┌──────────────────────────────────────────────────┐
│ <div style={{ display:'flex', height:'100vh' }}  │
│   <Sidebar />  (width: RAIL_W = 68px, flex-shrink:0) │
│   <div style={{ flex:1, display:'flex',          │
│                 flexDirection:'column',           │
│                 overflow:'hidden' }}>             │
│     <Topbar />                                   │
│     <main style={{ flex:1, overflowY:'auto',     │
│                    background:'var(--tp-surface-2)' }}>
│       <CurrentView />                            │
│     </main>                                      │
│   </div>                                         │
│ </div>                                           │

Mobile (< 640px)
┌──────────────────────────────────────────────────┐
│ <div style={{ display:'flex', flexDirection:     │
│               'column', height:'100vh' }}>        │
│   <Topbar />                                     │
│   <main style={{ flex:1, overflowY:'auto' }}>    │
│     <CurrentView />                              │
│   </main>                                        │
│   <BottomNav />                                  │
│ </div>                                           │
```

**Adding a new view (Next.js App Router):**
1. Add a route under the authed route group: `app/(authed)/myview/page.tsx`
2. Add its nav entry to the sidebar nav config so it appears in the shell
3. Build the page/feature as a feature module (see **truepoint-architecture**)
4. Do not create a new shell — the authed layout provides Sidebar/Topbar/BottomNav;
   the route inherits them for free

> Earlier prototype steps said "add to `NAV_ITEMS`" and "add a `case` to the view
> renderer in the app root". That single-file client-side view switcher is superseded by
> file-based routing: a surface is a route in the authed group, and the shared shell
> lives in that group's `layout.tsx` once (see the design skill SKILL.md, "Shell and
> Navigation"). Detail still opens in `ContactDrawer` rather than navigating away.

---

## Sidebar

Fixed — do not modify. Reuse the shared `@leadwolf/ui` component; do not redefine.

- Rail width: `68px` (constant `RAIL_W`)
- Expanded width: `244px` (constant `DRAWER_W`)
- Trigger: `onMouseEnter` → open, `onMouseLeave` → close
- `<aside>` is `position: absolute` — overlays content when expanded
- `<div>` spacer (`width: RAIL_W`) holds the flex layout gap
- Active item: `background: var(--tp-cobalt-50)`, `color: var(--tp-cobalt-700)`, `fontWeight: 600`
- Labels/badges: `opacity` transition `160ms`, `60ms` delay on open, `0ms` on close
- Shadow: `var(--tp-shadow-drawer)` when open, `none` when closed
- `z-index: 20` (below sticky/drawer scale)
- Mobile: hide entirely, show `<BottomNav>` instead

---

## Topbar

Fixed — do not modify. Reuse the shared `@leadwolf/ui` component; do not redefine.

- Height: `56px`, sticky, `background: var(--tp-surface)`
- Bottom: `1px solid var(--tp-hairline)`
- Left: page title (`15px, 600`) + optional subtitle (`12px, ink-4`)
- Right: search input (hidden at tablet) | period `SegmentedControl` | `TpIconButton` (bell) | primary CTA
- `z-index: var(--tp-z-sticky)` = `30`

---

## Contact / Prospect Drawer

Open on any list row click. Never navigate away from the list.

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
  <div style={{ padding:'8px var(--tp-space-6)', borderTop:'1px solid var(--tp-hairline)',
                display:'flex', gap:'var(--tp-space-2)', flexWrap:'wrap', alignItems:'center' }}>
    {activeChips.map(chip => (
      <TpChip key={chip.key+chip.value} active onRemove={() => removeFilter(chip)}>
        {chip.cat}: {chip.value}
      </TpChip>
    ))}
    <button onClick={clearAll} style={{ fontSize:12, color:'var(--tp-cobalt-700)',
      background:'none', border:'none', cursor:'pointer', padding:'0 4px' }}>
      Clear all
    </button>
  </div>
)}
```

---

## List Row (DataTable)

Standard row anatomy (all list views):

```
Avatar (28–32px) | Name (600) + subtitle (ink-3, 11–12px)
| Company | StatusBadge | ScorePill | Value (tabular-nums, 600)
```

- Row height: `44px` via `--tp-row-h`
- Hover actions: positioned right side, `opacity: 0 → 1` on row hover
  ```jsx
  // Inside DataTable column render
  render: (row) => (
    <div style={{ display:'flex', gap:4, opacity: isHovered ? 1 : 0, transition:'opacity 120ms' }}>
      <TpIconButton onClick={...}><IPhone size={15}/></TpIconButton>
      <TpIconButton onClick={...}><IMail size={15}/></TpIconButton>
    </div>
  )
  ```
- Row click: opens `ContactDrawer` — never navigates away

---

## ScorePill (Custom Atom)

Source of truth in `@leadwolf/ui`. Import it, never redefine.

```jsx
function ScorePill({ score }) {
  const tone = score >= 80 ? 'var(--success)'
             : score >= 50 ? 'var(--warning)'
             : 'var(--tp-ink-4)';
  return (
    <span style={{ display:'inline-flex', alignItems:'center', gap:5,
                   fontVariantNumeric:'tabular-nums', fontWeight:600, fontSize:13 }}>
      <span style={{ width:6, height:6, borderRadius:99, background:tone, flexShrink:0 }} />
      {score}
    </span>
  );
}
```

Always: dot + number, tabular-nums, `fontWeight: 600`, `fontSize: 13`.

---

## Responsive Breakpoints

```js
function useBreakpoint() {
  const [bp, setBp] = React.useState({
    mobile: window.innerWidth < 640,
    tablet: window.innerWidth < 1024
  });
  React.useEffect(() => {
    const h = () => setBp({
      mobile: window.innerWidth < 640,
      tablet: window.innerWidth < 1024
    });
    window.addEventListener('resize', h);
    return () => window.removeEventListener('resize', h);
  }, []);
  return bp;
}
```

| Breakpoint | Layout changes |
|---|---|
| Desktop ≥ 1024px | Full sidebar rail + topbar search visible |
| Tablet 640–1023px | Rail sidebar + topbar search hidden + 2-col stat grid |
| Mobile < 640px | No sidebar + BottomNav + 2-col stat grid + fewer table columns |

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
      trend={{ value: s.delta, up: s.up }}
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
const { toast } = useToast();

// Success
toast({ title: 'Contact saved', description: 'Changes applied.' });

// Error
toast({ title: 'Save failed', description: error.message, variant: 'destructive' });
```

Never use `alert()` or custom inline error states for transient feedback.

---

## Page Content Padding

Standard page content:
```jsx
<div style={{ padding: 'var(--tp-space-6)' }}>
```

For sections within a page that need vertical separation:
```jsx
<div style={{ marginBottom: 'var(--tp-space-8)' }}>
```

Never use padding values not on the spacing scale.
