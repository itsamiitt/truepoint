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

**The primitives need no provider** — everything in the `general` group renders standalone. The console surfaces do: anything that performs a write calls `useToast()` to report the outcome, and that hook **throws** outside its provider. Wrap any console subtree in `<ToastProvider>`.

## The staff console (this project's app groups)

Alongside the primitives this bundle ships the **real internal staff console** — 58 components from the product itself, not recreations. Groups map to console areas: `tenants`, `users`, `staff`, `billing`, `compliance`, `retention`, `data-ops`, `data-quality`, `data-sources`, `crm-sync`, `feature-flags`, `provider-configs`, `plans`, `pricing`, `content`, `audit-log`, `ai-usage`, `trust-abuse`, `system-health`, `imports`, `extension`, `auth-policy`, plus `shell` and `admin`.

- **Chrome**: `AdminShell` frames everything (rail, top bar, command palette). `ImpersonationBanner` is a fixed danger banner mounted once inside it.
- **Whole surfaces** take no props and load their own data: `TenantsPage`, `UsersPage`, `StaffPage`, `BillingEconomicsPage`, `CompliancePage`, `RetentionPage`, `DataOpsOverviewPage`, `SystemHealthPage`, `FeatureFlagsPage`, and the rest of the `*Page` set.
- **Tenant detail** is composed: `TenantDetailPage` takes a `tenantId` and stacks `TenantOverview`, `TenantEconomics`, `AuthEnforcementCard`, `TenantPurchases`, `TenantMoneyApprovals`, `TenantSubscription`, `TenantLedger`, `TenantHolds` and `SupportNotes` — each of which also takes a `tenantId` and loads its own slice, so you can use them individually.
- **Pickers**: `TenantPicker` / `UserPicker` are typeaheads over the real directories; `EntityPicker` is the generic they are built on (you supply `search`).
- **Dialogs**: `EditDefaultDialog`, `EditPolicyDialog`, `NewFlagDialog`, `OverrideDialog`, `RuleFormDialog`.

**Design rules this console encodes.** Money and high-risk data operations move under a **two-person rule** — `ApprovalsPage` and `TenantMoneyApprovals` exist because the requester can never be the approver. Destructive and lockout-capable controls (suspend, enforce retention, auth enforcement) always capture an audited **reason**. Counts that could not be read render as `—` or `null`, never as a fabricated `0`. Don't design a staff action that skips its justification field.

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
