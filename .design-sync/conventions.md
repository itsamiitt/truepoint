# Building with TruePoint UI (`@leadwolf/ui`)

Every component loads from the global `window.TruePointUI` — e.g. `const { Card, TpButton, DataTable } = window.TruePointUI`. React must already be on the page; mount your tree into a dedicated child node (not the host's root). **Light theme only.**

**No global provider is required** — components render standalone. The one exception is toasts: wrap the subtree in `<ToastProvider>` and call `useToast()` to fire them. Nothing else needs a provider.

## Two component families, one token system

- **Token primitives** — `Card`, `StatTile`, `StatusBadge`, `Avatar`, `Progress`, `Pagination`, `Spinner`, `Icon`, the state kit (`Skeleton`/`LoadingState`/`EmptyState`/`ErrorState`/`StateSwitch`), the `Tp*` form controls (`TpButton`, `TpInput`, `TpTextarea`, `TpSelect`, `TpCheckbox`, `TpSwitch`, `TpChip`, `TpIconButton`), `Tabs`/`SegmentedControl`, overlays (`Dialog`/`Drawer`), floating (`Popover`/`DropdownMenu`/`Tooltip`), `DataTable`, `Combobox`, and the form layout (`FormSection`/`FieldGroup`/`FormRow`). These are pre-styled from `.tp-ui-*` classes + the `--tp-*` tokens. Drive them with props — e.g. `<TpButton variant="danger">`, `<StatusBadge tone="success">`, `<Progress value={70} />`.
- **shadcn primitives** — `Button`, `Input`, `Label`, `Alert`, `Badge`, `Separator`, `Checkbox`, `RadioGroup`/`RadioOption`. Same look, themed via Tailwind utilities from the same tokens. Use props: `<Button variant="outline" size="sm">`.

**This is a component + token system, not a utility-class kit.** Don't invent class names. Compose the shipped components; for your own layout glue (grids, spacing, a one-off accent) use inline styles that read the `--tp-*` CSS variables — never hardcode a brand hex.

## Token vocabulary (CSS custom properties — verbatim)

- **Text**: `--tp-ink` (primary), `--tp-ink-2`, `--tp-ink-3` (muted), `--tp-ink-4` (faint)
- **Surfaces**: `--tp-surface` (white), `--tp-surface-2`, `--tp-surface-3`
- **Borders**: `--tp-hairline`, `--tp-hairline-2`
- **Brand cobalt** (fills/accents, never body text): `--tp-cobalt`, `--tp-cobalt-700`, `--tp-cobalt-50`
- **Status**: `--success`, `--warning`, `--danger`, `--accent`
- **Shape**: `--radius` (8px), `--tp-radius-sm` (6px)
- **Spacing** (4px scale): `--tp-space-1` … `--tp-space-8`
- **Type**: `--font-sans` (Geist), `--font-mono`
- **Elevation**: `--tp-shadow-popover`, `--tp-shadow-drawer`, `--tp-shadow-dialog`; **z-scale**: `--tp-z-sticky/-drawer/-overlay/-modal/-popover/-toast`

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
