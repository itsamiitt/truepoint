---
name: truepoint-design
description: >
  Governs all UI work in TruePoint — components, layout, tokens, responsive
  behaviour, large-data rendering, localization, and interaction patterns. Use this
  skill whenever writing or reviewing any JSX, styling, component selection, or
  layout code. Triggers on: building a page or view, adding a component, choosing
  between design-system components, handling loading/empty/error states, building a
  table or list at scale, implementing a drawer or modal, writing styles, picking
  spacing or colour, designing a form, localizing copy, or planning any visual
  surface. If the task touches how anything looks or behaves in the browser, this
  skill must be active.
---

# TruePoint Design Skill

TruePoint's UI is built on `@leadwolf/ui` — the shared React component and token
system, consumed as a normal package import by both frontend apps in the monorepo
(`@leadwolf/web`, the customer surface, and `@leadwolf/admin`, the internal/platform-admin
surface). Every UI decision flows from this design system. This skill makes sure every agent reaches
for the right component, uses the right token, and follows the right pattern every
time — and that the UI holds up at the scale of millions of users and many locales.

**TruePoint is light theme only.** The design system ships a single light theme. Do
not build dark-mode variants, a theme toggle, or `prefers-color-scheme: dark`
styles. Every token resolves to its light value.

> **Note on the legacy prototype.** Earlier material described the design system as
> a `window.TruePointUI` global loaded inside a single `crm-app.jsx` file. That was a
> prototype. The design system is **`@leadwolf/ui`** (real path `packages/ui`),
> imported normally; the app is a Next.js App Router application, not a single-file
> view switcher (see **truepoint-architecture**). Where older references say
> `window.TruePointUI` or "source of truth in `crm-app.jsx`", read the `@leadwolf/ui`
> package as the real source. This corrects the naming and the access pattern
> throughout.

---

## Which Skill, When

TruePoint has nine skills — six platform skills plus three `truepoint-extension-*`
skills for the browser extension (see the root `CLAUDE.md` routing table). Most real
features touch several.

- **truepoint-design** (this skill) — HOW it looks and behaves: components, tokens,
  layout, responsive, large-data rendering, accessibility, motion, copy, i18n, brand.
- **truepoint-architecture** — WHERE frontend code lives and HOW it is structured.
- **truepoint-platform** — the backend, data platform, API contract, queues, scale.
- **truepoint-data** — the data model, ownership/sharing, enrichment, search.
- **truepoint-security** — WHETHER it is safe.
- **truepoint-operations** — running it.
- **truepoint-extension-{architecture,linkedin,auth}** — the browser extension
  (`apps/extension`); its surfaces defer here for anything that renders.

Take "add a prospect to a list":
- Design (this skill): how the button, modal, and toast look; the four states;
  accessibility; copy.
- Architecture: where the feature folder, hook, and query key live.
- Platform/Data: the API contract, the ListMembership row, ownership.
- Security: the write is tenant-scoped and the list ID is verified server-side.

When a form takes input, design owns the validation *experience* (when and how
errors show); **truepoint-security** owns whether the input is *safe* (the server
re-validates; the client check is UX, not a boundary).

---

## Step 0 — Think Before You Build (UI Edition)

Before writing JSX, answer these internally — the UI equivalent of the architecture
pre-build pass:

1. **Information hierarchy** — What must the user see first? Default to progressive
   disclosure.
2. **Shared atoms** — Does the app shell (`Sidebar`, `TopBar`, `PageHeader` in
   `apps/web/src/components/shell/`), a `@leadwolf/ui` component, or an existing app
   recipe (e.g. the ScorePill recipe) already cover this? Reuse the exact
   component — never duplicate it. `references/components.md` is the inventory;
   detail drawers are composed from the DS `Drawer`.
3. **Brand asset?** — Does this show the logo, wordmark, a brand colour, or an icon?
   If yes, read `Guidelines/` (the brand kit, the primary source of truth) and then
   `references/brand.md` for the code patterns. Never approximate.
4. **Component exists in the DS?** — Before any styled `<div>`, check the inventory.
   Raw HTML elements (`<button>`, `<input>`, `<table>`, `<dialog>`) are banned where
   a DS equivalent exists.
5. **Token or raw value?** — Every colour, spacing, radius, shadow, font, and
   z-index is a `var(--tp-*)` token. No hex, no hardcoded px outside the
   `references/tokens.md` exceptions.
6. **Responsive** — How does it look at 1280 / 768 / 375px? It must work at all
   three.
7. **States** — Every data surface needs four: loading, empty, error, populated.
   `StateSwitch` handles all four. Wire it from the start.
8. **Scale** — Will this render a large list/table? Lists over a screenful are
   virtualized and server-paginated, with a performance budget — see
   `references/large-data.md`. A naive table over thousands of rows is a bug.
9. **Localization** — Is the copy translatable, and does the layout survive longer
   strings and RTL? See `references/i18n.md`.
10. **Density** — Interactive rows ≥ 44px (`--tp-row-h`). High information-to-chrome
    ratio. No padding inflation.

---

## The Design System

`@leadwolf/ui` is imported like any package — there is no window global and no
load-order dance:

```jsx
// ✅ normal import
import { Card, TpButton, DataTable } from '@leadwolf/ui'

function MyView() {
  return <Card>…</Card>
}
```

Next.js code-splits these imports per route, which is exactly why the package model
replaces the old single-eager-global-bundle prototype — the design system loads with
the routes that use it, not all at once.

The DS has two component families sharing one token system:

- **Tp\* family** — `TpButton`, `TpInput`, `TpTextarea`, `TpSelect`, `TpCheckbox`,
  `TpSwitch`, `TpChip`, `TpIconButton`. Pre-styled, driven by props; also accept
  standard HTML form attributes.
- **shadcn family** — `Button`, `Input`, `Label`, `Alert`, `Badge`, `Separator`,
  `Checkbox`, `RadioGroup`, `RadioOption`. Same look, same tokens.

Full props/variants: `references/components.md`. Every token with its value:
`references/tokens.md`.

---

## Styling — Tokens via Inline Styles, Components Carry the Look

This resolves the prior Tailwind-vs-inline contradiction. The split is by layer:

- **Components encapsulate their own styling.** Reach for a `@leadwolf/ui`
  component before styling a `<div>`; the look lives in the DS.
- **App-level layout (in `apps/*`) uses inline `style={{ }}` reading `var(--tp-*)`
  tokens** — not Tailwind utility classes in app JSX, and not raw values.
- **Token-driven CSS modules are an accepted app-styling layer** alongside inline
  styles — the shell and larger features use `*.module.css` whose values are
  `var(--tp-*)`; extend a feature's existing stylesheet rather than converting it.

The HARD RULE is scoped to app code: **no Tailwind utility classes in `apps/*` JSX**.
The design SYSTEM itself (`@leadwolf/ui`) is deliberately a hybrid and is exempt:
inline `--tp-*` tokens for dashboard primitives (`Card.tsx`), Tailwind v4 (CSS-first,
`@theme inline` in `theme.css`) + CVA for the shadcn-derived components
(`components/ui/button.tsx`), and `.tp-ui-*` classes in `primitives.css`. Tailwind is
not banned package-wide — it is banned in app JSX.

```jsx
// ✅ correct
<div style={{
  padding: 'var(--tp-space-4)',
  background: 'var(--tp-surface)',
  borderRadius: 'var(--radius)',
  borderBottom: '1px solid var(--tp-hairline)',
}}>

// ❌ wrong — raw values
<div style={{ padding: 16, background: '#fff', borderRadius: 8 }}>
// ❌ wrong — utility classes in app JSX
<div className="p-4 bg-white rounded-lg border-b">
```

The only `<style>` exceptions in app code: `@keyframes`, `@font-face`, and the
scrollbar styling already defined in the shell. (How `@leadwolf/ui` styles its *own*
internals — the hybrid above — is the package's concern; app code composes components
+ token-driven inline styles.)

---

## Shell and Navigation (via Next.js, not a view switcher)

The app shell — sidebar, topbar, the authenticated frame — is provided by **Next.js
App Router layouts**, shared across routes through a route-group layout. This
replaces the prototype's single-file `CRMApp` view switcher.

```
app/(shell)/layout.tsx         ← renders Sidebar + TopBar, wraps all authed routes
app/(shell)/contacts/page.tsx  ← a route; inherits the shell from the layout
app/(shell)/deals/page.tsx     ← another route; same shell, no duplication
```

(The `contacts`/`deals` route paths above are illustrative of the App Router pattern,
not literal file locations — read them as "any route under the authed group".)

- **Adding a surface is adding a route** under the authed group — it inherits the
  shell from the layout for free. You do not hand-roll a new shell, and you do not
  add a case to a client-side switcher.
- **Shared chrome lives in the layout once** (Sidebar, TopBar; on mobile the sidebar
  becomes the off-canvas drawer opened by the TopBar hamburger)
  — never duplicated per page. This is the design expression of the architecture
  skill's UI-consolidation rule.

**Detail-in-drawer still holds as a UX pattern.** Opening a contact/prospect from a
list shows it in a drawer composed from the DS `Drawer` (see
`references/components.md`) rather than navigating to a separate full page —
the user keeps their place in the list. In the App Router this is implemented with
client drawer state (or intercepting/parallel routes if a shareable URL is needed),
not by leaving the list route. The principle ("don't lose the list to see a detail")
is unchanged; the mechanism is Next.js, not a bespoke shell.

Full shell, drawer, filter-bar, row, and responsive specs: `references/patterns.md`.

---

## State Handling

Every data surface handles all four states, wired at build time, via `StateSwitch`:

```jsx
import { StateSwitch, LoadingState, EmptyState, ErrorState } from '@leadwolf/ui'

function ProspectList({ filters }) {
  const { data, isLoading, error, refetch } = useProspects(filters)
  return (
    <StateSwitch
      loading={isLoading} error={error} empty={!data?.length}
      skeleton={<LoadingState rows={6} />}
      emptyState={<EmptyState title="No prospects" description="Try adjusting your filters." />}
      errorState={<ErrorState title="Failed to load" onRetry={refetch} />}
    >
      {/* populated state — for large results, see references/large-data.md */}
    </StateSwitch>
  )
}
```

`StateSwitch` is declarative — never hand-roll `if (loading) return <Spinner>` chains.

---

## When JSX Becomes a Component

Extract a chunk into its own named component when: it's used in more than one place;
it has its own state or effect; it's conceptually one named thing ("the score pill");
or its file is approaching the architecture size limit and this is a clean seam. Do
not extract prematurely — markup used once, with no state, that reads clearly inline,
stays inline. Extract on repetition, state, or a real name — not on reflex. Where it
goes: the architecture feature-module pattern.

---

## Accessibility

Accessibility is part of building the component right. TruePoint is keyboard-first
for sales staff. Essentials: every interactive element is keyboard-reachable with a
visible focus ring; icon-only buttons have a `label`; drawers/dialogs trap focus and
return it on close (the DS handles this — don't hand-roll one that skips it); never
convey meaning by colour alone; decorative motion respects `prefers-reduced-motion`;
targets ≥ 44px. The conformance target is **WCAG 2.2 AA**. Full guidance and the
verification checklist: `references/accessibility.md`.

---

## Interaction and Writing

Motion is functional, `transform`/`opacity` only, under ~300ms, reduced-motion-aware.
Forms validate on blur and submit, never per keystroke, never clear on failed
submit. Feedback matches the event (toast confirms, dialog asks, inline error marks
a field, `ErrorState` covers a failed load). Loading uses shape-matched skeletons.
Full detail: `references/interaction.md`. Form validation in the browser is UX, not
security (the server re-validates — **truepoint-security** input-and-injection).

UI copy is design material: imperative buttons ("Save changes"), errors that explain
and direct without blaming, inviting empty states, sentence case, never filler. All
user-facing copy is **localizable** (see `references/i18n.md`). Full guidance:
`references/writing.md`.

---

## Hard Rules (Zero Tolerance)

These are mandates every UI surface must meet. How each is currently enforced:
Biome (`biome.json`) runs format + lint; dependency-cruiser (`.dependency-cruiser.cjs`,
via `bun run lint:boundaries`) enforces module boundaries; token / accessibility /
no-raw-hex adherence is **manual review** against `Guidelines/TruePoint Brand Kit.html`
and the live tokens in `packages/ui/src/tokens.css`. (`docs/planning/brand-identity.md`
is superseded — trust only its header banner, never its legacy body.)

> **Implementation status:** there is no custom design-lint yet — the token / a11y /
> no-raw-hex / no-raw-element rules below are not automatically checked. They are
> enforced by code review against the Brand Kit + tokens.css; Biome and
> dependency-cruiser cover only formatting/lint and import boundaries.

- **No hardcoded hex.** `#2563c9` → `var(--tp-cobalt)`.
- **No raw `<button>`/`<input>`/`<table>`/`<dialog>`** — use the DS equivalents.
- **No duplicating the shell or a detail drawer** — one shared source (the
  app-shell components in `apps/web/src/components/shell/`; drawers composed from
  the DS `Drawer`).
- **No navigating away from a list to show detail** — open it in a drawer (DS
  `Drawer` composition).
- **No hand-rolled shell** — the shell is the Next.js authed layout; add a route.
- **No Tailwind utility classes in app JSX (`apps/*`)** — app code uses token-driven
  inline styles. (The `@leadwolf/ui` package itself is a hybrid and is exempt — see
  Styling above.)
- **No placeholder filler or Lorem Ipsum.**
- **No brand decisions without reading `Guidelines/` first.**
- **No empty filter-state text** — hide the chip row when no filters are active.
- **No dark mode.**
- **No `<div onClick>` for actions** — use a real button.
- **No stripping focus outlines** without an equivalent visible focus state.
- **No meaning by colour alone.**
- **No un-virtualized large lists** — large data uses virtualization + server
  pagination (`references/large-data.md`).
- **Copy is written translation-ready** — interpolation-shaped, never concatenated
  sentences (`references/i18n.md`; no i18n catalog exists yet — see its status note).

---

## Reference Files

| Task | Read |
|---|---|
| Logo, wordmark, colours, iconography, typeface | `references/brand.md` |
| Choosing a component, props/variants | `references/components.md` |
| A token for colour, spacing, shadow, z-index, icon size | `references/tokens.md` |
| Shell, drawer, filter bar, row, topbar, responsive | `references/patterns.md` |
| Large tables/lists, virtualization, pagination, perf budgets | `references/large-data.md` |
| Localization, RTL, number/date/currency formatting | `references/i18n.md` |
| Keyboard, focus, screen readers, contrast, motion | `references/accessibility.md` |
| Motion, form validation, feedback, loading, empty states | `references/interaction.md` |
| Button labels, error messages, microcopy, tone | `references/writing.md` |

---

## Companion Skills

This skill governs what renders. It defers to **truepoint-architecture** (where
files/data flow live), **truepoint-platform/data** (the API and data behind the UI),
and **truepoint-security** (whether it's safe). A data feature is governed by several
at once — this skill says how it looks and behaves.
