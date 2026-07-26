# Building with TruePoint UI (`@leadwolf/ui`)

Every component loads from the global `window.TruePointUI` — e.g. `const { Card, TpButton, DataTable } = window.TruePointUI`. React must already be on the page; mount your tree into a dedicated child node (not the host's root). **Light theme only.**

**The primitives need no provider** — everything in the `general` group renders standalone. Two providers exist, and the `prospect` group needs them: wrap the subtree in `<ToastProvider>` (then `useToast()` fires toasts), and in `<RevealStoreProvider>` for anything that touches contact reveal data. See **The prospect surface** below.

## Two component families, one token system

- **Token primitives** — `Card`, `StatTile`, `StatusBadge`, `Avatar`, `Progress`, `Pagination`, `Spinner`, `Icon`, the state kit (`Skeleton`/`LoadingState`/`EmptyState`/`ErrorState`/`StateSwitch`), the `Tp*` form controls (`TpButton`, `TpInput`, `TpTextarea`, `TpSelect`, `TpCheckbox`, `TpSwitch`, `TpChip`, `TpIconButton`), `Tabs`/`SegmentedControl`, overlays (`Dialog`/`Drawer`), floating (`Popover`/`DropdownMenu`/`Tooltip`), `DataTable`, `Combobox`, and the form layout (`FormSection`/`FieldGroup`/`FormRow`). These are pre-styled from `.tp-ui-*` classes + the `--tp-*` tokens. Drive them with props — e.g. `<TpButton variant="danger">`, `<StatusBadge tone="success">`, `<Progress value={70} />`.
- **shadcn primitives** — `Button`, `Input`, `Label`, `Alert`, `Badge`, `Separator`, `Checkbox`, `RadioGroup`/`RadioOption`. Same look, themed via Tailwind utilities from the same tokens. Use props: `<Button variant="outline" size="sm">`.

**This is a component + token system, not a utility-class kit.** Don't invent class names. Compose the shipped components; for your own layout glue (grids, spacing, a one-off accent) use inline styles that read the `--tp-*` CSS variables — never hardcode a brand hex.

## Token vocabulary (CSS custom properties — verbatim)

- **Text**: `--tp-ink` (primary), `--tp-ink-2`, `--tp-ink-3` (muted), `--tp-ink-4` (faint), `--tp-on-fill` (white — text/marks on filled or dark surfaces)
- **Surfaces**: `--tp-surface` (white), `--tp-surface-2`, `--tp-surface-3`; `--tp-twilight` (near-black feature surface), `--tp-scrim` (backdrop behind overlays)
- **Borders**: `--tp-hairline`, `--tp-hairline-2`
- **Brand cobalt** (fills/accents, never body text): `--tp-cobalt`, `--tp-cobalt-700`, `--tp-cobalt-50`
- **Primary action fill** (ink, not cobalt): `--tp-btn`, `--tp-btn-700` (hover) — with `--tp-on-fill` text
- **Status**: `--success`, `--warning`, `--danger`, `--danger-700` (destructive hover / error text). There is **no `--accent`** — the old Wolf-Indigo accent was retired; use `--tp-cobalt`.
- **Soft danger** (the *exclusion* surface, not destructive actions): `--danger-tint` (block background), `--danger-50` (chip fill), `--danger-100` / `--danger-200` (borders), `--danger-ink` (muted rose copy, AA-safe). Used by the progressive-exclude blocks in `FilterPanel` / `AccountFilterPanel`.
- **Shape**: `--radius` (8px), `--tp-radius-sm` (6px), `--tp-radius-card` (14px, for cards/tiles)
- **Spacing** (4px scale): `--tp-space-1` … `--tp-space-8`
- **Type**: `--font-sans` (Geist), `--font-mono` (Geist Mono)
- **Elevation**: `--tp-shadow-card`, `--tp-shadow-card-hover` (dashboard cards/tiles), `--tp-shadow-popover`, `--tp-shadow-drawer`, `--tp-shadow-dialog`, `--tp-shadow-rail`; **z-scale**: `--tp-z-sticky/-drawer/-overlay/-modal/-popover/-toast`

## The prospect surface (`prospect` group)

Alongside the primitives the bundle ships the **real prospect surface** — 27 components from the product itself, not recreations. Use them instead of rebuilding a contact grid out of `DataTable`.

- **Whole page**: `ProspectPage` takes no props. It reads its search/filter state from the URL and loads its own data.
- **Pieces**: `FilterPanel` / `FilterRail` / `FacetTypeahead` (faceted rails), `AccountFilterPanel` + `AccountsTable` + `AccountDetailDrawer` (the company scope), `ProspectToolbar`, `QuickViewDrawer` → `RecordDetail`, `RowActions`, `BulkActionBar`, `SaveSearchPanel`, `RecentSearches`, `AiSearchBox` + `ParsedFilterPreview`, `TagChip` / `TagPicker`, `StageSelector` / `StageManagementPanel`.

**Providers.** Fourteen of them call `useToast()`, so `<ToastProvider>` is mandatory. `RevealCell`, `RevealDialog` and `RecordDetail` also read the reveal store — wrap those in `<RevealStoreProvider>`, and call `useRevealStore().hydrate(ids)` for the rows on screen or they render the "Revealed" flag without the value:

```jsx
const { ToastProvider, RevealStoreProvider, ProspectPage } = window.TruePointUI;

<ToastProvider>
  <RevealStoreProvider>
    <ProspectPage />
  </RevealStoreProvider>
</ToastProvider>
```

**Masked by default.** A contact row carries no PII — only a masked domain, status flags and counts. `RevealCell` / `RevealDialog` / `BulkRevealDialog` spend credits to unlock a value and always state the cost first; `QuickViewDrawer` is masked-only by design and hands off to `RecordDetail`. Never design a screen that shows an email address on a row that hasn't been revealed.

## Where the truth lives

Before composing, read `styles.css` (it `@import`s the tokens and component styles) and a component's `components/<group>/<Name>/<Name>.prompt.md` (usage + real examples) and `<Name>.d.ts` (props). The `.d.ts` lists each component's own props; native form controls (`Tp*`, `Input`, `Checkbox`) also accept the standard HTML attributes (`value`/`defaultValue`, `placeholder`, `disabled`, …) even though the trimmed `.d.ts` omits them.

## Idiomatic example

```jsx
const { Card, StatTile, TpButton } = window.TruePointUI;

<Card>
  <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "var(--tp-space-4)" }}>
    <StatTile label="Total leads" value="2,847" sublabel="+12% this month" />
    <StatTile label="Conversion rate" value="18.4%" sublabel="Across all sources" />
    <StatTile label="Pipeline value" value="$184,200" sublabel="64 open deals" />
  </div>
  <div style={{ marginTop: "var(--tp-space-4)", display: "flex", gap: "var(--tp-space-2)" }}>
    <TpButton variant="primary">New lead</TpButton>
    <TpButton variant="ghost">Import CSV</TpButton>
  </div>
</Card>
```
