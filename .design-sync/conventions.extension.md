# Building with TruePoint UI (`@leadwolf/ui`)

Every component loads from the global `window.TruePointUI` — e.g. `const { Card, TpButton, DataTable } = window.TruePointUI`. React must already be on the page; mount your tree into a dedicated child node (not the host's root). **Light theme only.**

## Two component families, one token system

- **Token primitives** — `Card`, `StatTile`, `StatusBadge`, `Avatar`, `Progress`, `Pagination`, `Spinner`, `Icon`, the state kit (`Skeleton`/`LoadingState`/`EmptyState`/`ErrorState`/`StateSwitch`), the `Tp*` form controls (`TpButton`, `TpInput`, `TpTextarea`, `TpSelect`, `TpCheckbox`, `TpSwitch`, `TpChip`, `TpIconButton`), `Tabs`/`SegmentedControl`, overlays (`Dialog`/`Drawer`), floating (`Popover`/`DropdownMenu`/`Tooltip`), `DataTable`, `Combobox`, and the form layout (`FormSection`/`FieldGroup`/`FormRow`). These are pre-styled from `.tp-ui-*` classes + the `--tp-*` tokens. Drive them with props — e.g. `<TpButton variant="danger">`, `<StatusBadge tone="success">`, `<Progress value={70} />`.
- **shadcn primitives** — `Button`, `Input`, `Label`, `Alert`, `Badge`, `Separator`, `Checkbox`, `RadioGroup`/`RadioOption`. Same look, themed via Tailwind utilities from the same tokens. Use props: `<Button variant="outline" size="sm">`. `Button`'s variants are exactly `default | outline | ghost | link` — an unknown name silently renders with no surface at all.

**This is a component + token system, not a utility-class kit.** Don't invent class names. Compose the shipped components; for your own layout glue (grids, spacing, a one-off accent) use inline styles that read the `--tp-*` CSS variables — never hardcode a brand hex.

## Token vocabulary (CSS custom properties — verbatim)

- **Text**: `--tp-ink` (primary), `--tp-ink-2`, `--tp-ink-3` (muted), `--tp-ink-4` (faint), `--tp-on-fill` (white — text/marks on filled or dark surfaces)
- **Surfaces**: `--tp-surface` (white), `--tp-surface-2`, `--tp-surface-3`; `--tp-twilight` (near-black feature surface), `--tp-scrim` (backdrop behind overlays)
- **Borders**: `--tp-hairline`, `--tp-hairline-2`
- **Brand cobalt** (fills/accents, never body text): `--tp-cobalt`, `--tp-cobalt-700`, `--tp-cobalt-50`
- **Primary action fill** (ink, not cobalt): `--tp-btn`, `--tp-btn-700` (hover) — with `--tp-on-fill` text
- **Status**: `--success`, `--warning`, `--danger`, `--danger-700` (destructive hover / error text). There is **no `--accent`** — the old Wolf-Indigo accent was retired; use `--tp-cobalt`.
- **Soft danger** (an *exclusion* surface, not destructive actions): `--danger-tint` (block background), `--danger-50` (chip fill), `--danger-100` / `--danger-200` (borders), `--danger-ink` (muted rose copy, AA-safe).
- **Shape**: `--radius` (8px), `--tp-radius-sm` (6px), `--tp-radius-card` (14px, for cards/tiles)
- **Spacing** (4px scale): `--tp-space-1` … `--tp-space-8`
- **Type**: `--font-sans` (Geist), `--font-mono` (Geist Mono)
- **Elevation**: `--tp-shadow-card`, `--tp-shadow-card-hover` (dashboard cards/tiles), `--tp-shadow-popover`, `--tp-shadow-drawer`, `--tp-shadow-dialog`, `--tp-shadow-rail`; **z-scale**: `--tp-z-sticky/-drawer/-overlay/-modal/-popover/-toast`

## Providers

None. Every component in this bundle renders standalone.

## The browser extension (this project's app groups)

Alongside the primitives this bundle ships the **real MV3 extension UI** — 4 components from the product itself.

- **`Panel`** — the side panel: brand bar with the compact credits pill, the tab row, and the tab body. Takes no props; reads its account state over the extension message bus and its captured list from IndexedDB.
- **`Popup`** — the toolbar popup: lockup, connection tag, account, credits, and one action into the side panel. Two whole-surface branches, signed-in and signed-out.
- **`CreditsPill`** — `credits: number | null`, plus `compact` for the panel's brand bar. A `null` balance renders an em dash, never a fabricated zero. Below the low-balance threshold the value switches to the warning tone.
- **`Mark`** — the chevron, `size` and `variant` (`default` | `mono` | `reversed`). Colour is inherited, not a prop.

**Design rules this surface encodes.** The extension is **small**: the panel is ~400px wide and the popup ~340px, so design for a single column and short labels. Credits are a **purchased settlement unit** — the pill reports a balance and is never a score, a streak, or something a contribution earns. Capture outcomes (`saved`, `duplicate`, `queued`) are stated plainly on each row; `queued` means durably stored locally but not yet acknowledged by the server, and must not be presented as "saved".

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
