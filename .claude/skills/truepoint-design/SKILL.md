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
2. **Shared atoms** — Does one of these already cover it? Reuse the exact component;
   never duplicate it.
   - **The chrome** (`AppShellFrame`, `Sidebar`, `TopBar`, `DensityToggle`,
     `ShortcutsButton`, `NavItem`, `UserRow`, `Logo`, `ShortcutsDialog`,
     `DensityProvider`, `useSidebarPin`) is `@leadwolf/app-shell`
     (`packages/app-shell`), composed per app by that app's own `AppShell.tsx` —
     for the customer surface, `apps/web/src/components/shell/AppShell.tsx`.
   - **The page scaffolding** (`PageHeader`, `PageContainer`) is `@leadwolf/ui`.
   - **Everything else that renders** is `@leadwolf/ui` too —
     `references/components.md` is the inventory.
   - **App recipes** (e.g. the ScorePill recipe) live in the owning feature; detail
     drawers are composed from the DS `Drawer`.
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
  `Checkbox`, `RadioGroup`, `RadioOption`. Same look, same tokens — and now literally
  the same stylesheet: they were rewritten off Tailwind utilities onto the
  `primitives.css` classes, so they render in **every** app. (Before that they only
  resolved in `apps/auth`, the one app that loads `tailwindcss` + `theme.css`; in
  `web`/`admin`/`forge` they emitted class names with no CSS behind them.) Choose by
  API, not by app: `Button` is the one with `asChild`; `Input`/`Checkbox`/`RadioOption`
  are the native controls that submit with no JavaScript.

Plus the page scaffolding — `PageHeader` and `PageContainer` — and the `cn` helper.

Full props/variants: `references/components.md`. Every token with its value:
`references/tokens.md`.

---

## Styling — Tokens via Inline Styles, Components Carry the Look

This resolves the prior Tailwind-vs-inline contradiction. The split is by layer:

- **Components encapsulate their own styling.** Reach for a `@leadwolf/ui`
  component before styling a `<div>`; the look lives in the DS.
- **App-level layout (in `apps/*`) uses inline `style={{ }}` reading `var(--tp-*)`
  tokens** — not Tailwind utility classes in app JSX, and not raw values. That
  includes `fontSize`: the `--tp-text-*` scale (micro 11 / caption 12 / body 13 /
  label 14 / lg 15 / title 16 / heading 18 / display 22) exists now, so a raw size
  has no excuse. A size off the ladder is a design decision, not a typo — put it in a
  token.
- **Token-driven CSS modules are an accepted app-styling layer** alongside inline
  styles — the shell and larger features use `*.module.css` whose values are
  `var(--tp-*)`; extend a feature's existing stylesheet rather than converting it.

The HARD RULE is scoped to app code: **no Tailwind utility classes in `apps/*` JSX**.
The design SYSTEM itself (`@leadwolf/ui`) is deliberately a hybrid and is exempt: inline
`--tp-*` tokens for the dashboard primitives (`Card.tsx`, `StatTile.tsx`, `state.tsx`)
and `.tp-ui-*` classes in `primitives.css` for everything with a stylesheet — including
the shadcn-derived components, which no longer use Tailwind utilities or CVA.
`theme.css` still maps the Tailwind theme onto the tokens via `@theme inline` for
`apps/auth`, the one app that loads Tailwind. Tailwind is not banned package-wide — it
is banned in app JSX.

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
  skill's UI-consolidation rule. The chrome components themselves come from
  `@leadwolf/app-shell`, shared by `apps/web`, `apps/admin` and `apps/forge`; each
  app's own `AppShell.tsx` composes them with its auth gate, its destination list and
  its own top-bar widgets.
- **The page inside the layout uses `PageContainer` + `PageHeader`** (`@leadwolf/ui`)
  — not a hand-rolled wrapper with its own `max-width`.

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
Biome (`biome.json`) runs format + lint (its `recommended` set includes a11y rules);
dependency-cruiser (`.dependency-cruiser.cjs`, via `bun run lint:boundaries`) enforces
module boundaries; `bun run lint:design-tokens`, `bun run lint:roving-tabindex` and the
contrast tests are CI gates. Everything else — raw px, raw elements, and the brand
rules — is **code review** against `Guidelines/TruePoint Brand Kit.html` and the live
tokens in `packages/ui/src/tokens.css`. (`docs/planning/brand-identity.md` is
superseded — trust only its header banner, never its legacy body.)

> **Implementation status (updated 2026-08-22):** two of these rules are now checked, the
> rest still are not.
>
> - **no-raw-hex — CHECKED.** `bun run lint:design-tokens` (`scripts/lint-design-tokens.mjs`,
>   a CI gate) flags a hex used as a colour value in a `.css` declaration or a `.tsx` style
>   object. Deliberately narrow: `packages/ui/src/tokens.css`, `var(--token, #fallback)`
>   (which `apps/extension` needs — a content script runs where tokens.css never loaded),
>   Next's `themeColor` `<meta>` literal, and hexes inside comments are all excluded.
>   Escape hatch: `// design-tokens-ok: <reason>`.
> - **keyboard operability — PARTLY CHECKED.** `bun run lint:roving-tabindex` catches a
>   composite ARIA role with `tabIndex={-1}` and no key handler — the trap that makes an
>   option unreachable. It cannot tell you the handler is *correct*; only a browser can.
> - **contrast — CHECKED.** Each app asserts the token pairs it paints
>   (`apps/doc/src/components/contrast.test.ts`, `apps/web/src/contrast.test.ts`,
>   `apps/admin/src/contrast.test.ts`), and `packages/ui/src/primitivesContrast.test.ts` covers
>   the shared stylesheet by **deriving** its pairs from the CSS — so a new primitive with a bad
>   pairing fails without anyone maintaining a list. `apps/forge` has no pair test on purpose:
>   it paints exactly one token (`--tp-ink` on white, 21:1) through DS primitives, so there is
>   nothing to enumerate yet. What none of them can see: colour-only rules (the background comes
>   from an ancestor), composited alpha, and inline styles.
> - **`--success` / `--warning` are FILL tones, not text tones.** 3.30:1 and 3.19:1 on white —
>   fine behind a status dot or a check icon (WCAG 1.4.11 asks 3:1 of a meaningful graphic),
>   under the 4.5:1 floor for a number or a label. Use **`--success-700`** / **`--warning-700`**
>   (added 2026-08-22, 5.02:1) whenever the status colour IS the text, exactly as
>   `--danger-700` has always been the text-safe half of `--danger`.
> - **`--tp-ink-4` is NOT a text colour — ratcheted repo-wide.** It is 2.54:1 on white and
>   worse on every tint, which is below the AA floor for normal text (4.5:1) *and* for large
>   text (3.0:1) — no text size passes. It remains fine for placeholders, disabled controls
>   (WCAG 1.4.3 exempts those) and icon glyphs. The existing text usages across `apps/web`,
>   `apps/admin`, `apps/auth` and `packages/ui` are capped by
>   `packages/ui/src/inkFourContrast.test.ts` — an **equality** assertion, so it fails both
>   when the count grows and when it silently shrinks. **Cite the file, never a number, in
>   prose**: the budget only moves down, and every quoted figure goes stale the next time it
>   does. Read `INK4_TEXT_BUDGET` when you need the current one. **Do not add a new usage.**
>   Reach for `--tp-ink-3` — but check the surface first: ink-3 clears AA on white and
>   `--tp-surface-2` and FAILS on `--tp-surface-3` and `--nav-hover-fill`.
> - **overlay focus management and composite-widget keyboard — IMPLEMENTED IN THE DS,
>   AND BEHAVIOURALLY TESTED.** `Dialog`/`Drawer` portal-render, move focus in, trap Tab
>   (wrapping both ways), return focus to the opener, ref-count the scroll lock, and
>   close only the top-most layer on Escape (the shared `overlayStack.ts`).
>   `DropdownMenu`, `Combobox`, `Tabs` and `SegmentedControl` each implement their ARIA
>   pattern's full keyboard model, `Tooltip` clones `aria-describedby` onto the trigger
>   and dismisses on Escape, `DataTable` makes a clickable row focusable and
>   Enter/Space-activatable, and `Toast` mounts its live region before the first toast.
>   Every one of those is asserted against a real DOM in
>   `packages/ui/src/components/overlay.domtest.tsx` and `keyboard.domtest.tsx`, run by
>   **`bun run test:dom`** (a CI step; the `.domtest.tsx` extension keeps them out of a
>   plain `bun test`, which has no DOM). So **hand-rolling any of it is now the
>   violation** — a bespoke overlay or a `role="menu"` you wired yourself is strictly
>   worse than the DS component and has to be justified, not merely written.
>   `bun run lint:roving-tabindex` still catches the specific trap of a composite role
>   with `tabIndex={-1}` and no key handler in *app* code.
> - **every `.tp-ui-*` class a component emits must exist — CHECKED.**
>   `packages/ui/src/classCoverage.test.ts` fails the build on a class name with no
>   definition in `primitives.css`. This is the gate that would have caught the audit's
>   most expensive defect: nine exported components styled with Tailwind utilities that
>   only resolved in `apps/auth`, rendering as unstyled markup everywhere else while
>   typecheck, biome and the contrast tests all passed — they were all passing on a
>   string. It cannot prove a class *looks* right, only that its styling exists.
> - **no-raw-element, and the rest below — NOT checked.** "No raw `<button>`/`<input>`/
>   `<table>`/`<dialog>` where a DS equivalent exists" is code review only — no lint bans
>   them. Biome (`recommended`, including its a11y rules) and dependency-cruiser cover
>   formatting/lint and import boundaries, and neither can see a `<div onClick>`.

- **No hardcoded hex.** `#2563c9` → `var(--tp-cobalt)`.
- **No raw `<button>`/`<input>`/`<table>`/`<dialog>`** — use the DS equivalents.
- **No duplicating the shell or a detail drawer** — one shared source: the chrome is
  `@leadwolf/app-shell` (composed per app by that app's `AppShell.tsx`), the page
  scaffolding is `PageHeader`/`PageContainer` from `@leadwolf/ui`, and drawers are
  composed from the DS `Drawer`.
- **No hand-rolled overlay focus management or composite-widget keyboard** — the DS
  implements both; re-implementing either is the violation, not the fix.
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
