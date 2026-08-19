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

## The identity surfaces (this project's app groups)

Alongside the primitives this bundle ships the **real apps/auth layer** — 11 components from the product itself.

**Scope limit, stated plainly:** every route page in apps/auth (login, signup, forgot, reset, magic, mfa, sso, org, workspace, verify) is an `async` React Server Component and therefore cannot ship as a component here. What ships is the layer those pages are built from — and the screens themselves are reconstructed from exactly these parts in the `AuthShell` card's stories, which is what to copy when you build one.

- **Shells**: `AuthShell` (the centred single-purpose card every sign-in screen uses — `title`, optional `subtitle`, `children`, optional `footer`) and `AccountShell` (the wider signed-in settings layout, with an in-page `sections` nav whose anchors are deep-linked from the customer app).
- **Brand**: `BrandLockup` — the chevron mark plus the wordmark, fixed by the brand, no props.
- **Form controls**: `SubmitButton` (full-width, reflects a server action's pending state), `OtpInput` (the 6-digit code field; auto-submits on the sixth digit), `TurnstileWidget` (renders nothing when no site key is configured — that is deliberate, not a bug).
- **Account security sections**, each taking its data as props: `MfaSection`, `PasskeySection`, `SessionsSection`, `HistorySection`, plus `PasskeySignIn` for the MFA step.

**Design rules this layer encodes.** State-changing credential actions require a **step-up**: the user re-proves a password or an authenticator code before a factor is added or removed. The session backing the current browser is marked and is **never** offered a "sign out" action. An account with no password steps up with an authenticator code instead — don't design a step-up that assumes a password exists.

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
