# Customer App — `apps/web` (`@leadwolf/web`)

Serves `app.truepoint.in`. This is the only surface end customers interact with. It is
one app inside the one Bun monorepo (root package `leadwolf`), alongside `apps/admin`,
`apps/auth`, `apps/api`, `apps/workers`, `apps/doc`, `apps/forge`, `apps/forge-api`,
`apps/forge-worker` and `apps/extension`.

---

## Directory Structure

The monorepo root holds all apps and shared packages; this app is `apps/web`.

```
apps/
└── web/                             # @leadwolf/web — the customer app
    └── src/                         # ALL app source lives under src/  (@/* → ./src/*)
        ├── app/                     # Next.js App Router pages
        │   ├── (shell)/             # Route group: authed pages (inherit the app shell)
        │   │   ├── [feature]/
        │   │   │   └── page.tsx
        │   │   └── layout.tsx
        │   ├── (public)/            # Route group: unauthenticated pages
        │   ├── auth/                # auth entry / callback routes
        │   ├── api/                 # (none today — create only if a BFF route is genuinely needed)
        │   ├── layout.tsx           # Root layout
        │   ├── providers.tsx        # Client providers (query client, toast)
        │   └── globals.css
        ├── features/                # Feature modules (see below)
        ├── components/              # Shared UI components (this app only; incl. shell/)
        │                            #   shell/AppShell.tsx composes @leadwolf/app-shell
        │                            #   with this app's auth gate, navConfig and widgets
        ├── hooks/                   # Shared hooks (this app only)
        └── lib/                     # App-level setup (query client, authClient, helpers)
    # (Next.js middleware, if added, is apps/web/src/middleware.ts — none exists today.)

packages/                           # 13 shared @leadwolf/* workspace packages
├── ui/                             # @leadwolf/ui — design system (--tp-* tokens, PageHeader/PageContainer)
├── app-shell/                      # @leadwolf/app-shell — the shared Next.js chrome (web+admin+forge)
├── auth-client/                    # @leadwolf/auth-client — browser PKCE/token client (web+admin+forge)
├── types/                          # @leadwolf/types — shared Zod schemas (API contract)
├── auth/                           # @leadwolf/auth — backend IdP/verification (never imported by a frontend)
└── core/                           # @leadwolf/core — SERVER-side domain layer (never imported by a frontend)
#   also: config, db, identity, integrations, search, forge-core, forge-capture-sdk — all server-side

# repo root: turbo.json, biome.json, package.json (workspaces), .env.example,
# .github/workflows/ci.yml
```

---

## Feature Module Pattern

Every meaningful product surface lives in `features/`. A feature module owns
everything for that feature — its components, hooks, API calls, types, and tests.
Nothing leaks out except through the feature's `index.ts`.

```
features/
└── contacts/
    ├── index.ts                 # Public API of this feature (re-exports only)
    ├── components/
    │   ├── ContactList.tsx      # List view
    │   ├── ContactCard.tsx      # Individual card
    │   └── ContactSearch.tsx    # Search input + results
    ├── hooks/
    │   ├── useContacts.ts       # Data fetching hook
    │   └── useContactSearch.ts  # Search state
    ├── api/
    │   ├── index.ts             # Re-exports
    │   ├── fetch.ts             # GET /contacts
    │   └── update.ts            # PATCH /contacts/:id
    ├── types/
    │   └── contact.types.ts
    └── __tests__/
        ├── ContactList.test.tsx
        └── useContacts.test.ts
```

A page imports from the feature, not from inside the feature:
```ts
// ✅ correct
import { ContactList } from '@/features/contacts'

// ❌ wrong — reaches inside the feature's internals
import { ContactList } from '@/features/contacts/components/ContactList'
```

---

## What Goes Where

| Code | Location |
|---|---|
| A page for a route | `src/app/(shell)/[feature-name]/page.tsx` |
| Feature components, hooks, API | `src/features/[feature-name]/` |
| A component used by 3+ features | `src/components/` |
| A hook used by 3+ features | `src/hooks/` |
| A pure helper (formatting, parsing) used by one feature | that feature's own `lib/` |
| A pure helper shared across features **in this app** | `src/lib/` |
| A pure helper shared across **apps** | `packages/types/src/` if it belongs with the contract shapes, else a new focused package. **Not `@leadwolf/core`** — that is the server-side domain layer (it depends on `@leadwolf/db` and `@leadwolf/config`) and importing it into `apps/web` drags a database client into the browser bundle. `lint:boundaries` enforces this |
| A reusable UI primitive (button, input, page header) | `packages/ui/src/` |
| A piece of the app chrome (sidebar, top bar, palette) | `packages/app-shell/src/` — shared with `apps/admin` and `apps/forge` |
| A server action or route handler (BFF) | `src/app/api/` (none exist today — create only if genuinely needed) |
| An auth check / redirect (rendering gate) | `src/lib/authClient.ts` (a thin instantiation of `@leadwolf/auth-client`) + the `AppShell` gate — there is no Next.js middleware (see `auth.md`) |
| A request/response type (the API contract) | `packages/types/src/` (shared Zod schemas) |

If you are unsure, ask: does this code know about the customer product? If yes,
it belongs in `features/`. If it is generic enough to work in any Next.js app,
it belongs in a package.

---

## Component Rules

Each component file exports one component. If a component has sub-components
that are only used internally, they live in the same directory as separate files
— not in the same file.

```
ContactCard/
├── index.ts          # re-export
├── ContactCard.tsx   # main component (~60 lines max)
├── ContactAvatar.tsx # sub-component used only here
└── ContactCard.types.ts
```

Props interfaces are defined in the same file as the component unless they are
shared — in that case they move to `[feature].types.ts`.

---

## Hook Rules

Hooks do one thing. If a hook is fetching data AND managing local UI state AND
handling optimistic updates, split it:

```
hooks/
├── useContacts.ts        # fetching + caching only (react-query)
├── useContactForm.ts     # form state only (controlled React state)
└── useContactOptimistic.ts  # optimistic updates only
```

> **There is no form library.** `react-hook-form` is not installed in any workspace —
> do not reach for it, and do not add it mid-feature. In `apps/web` a form is
> **controlled component state** in a client component, submitting through the
> feature's `api/` folder. (`apps/auth` is the one app that uses the other shape —
> Server Components posting to `"use server"` actions, so its flows work with
> JavaScript disabled; that is why the DS ships native no-JS `Input`/`Checkbox`/
> `RadioOption`.) Validation shapes come from the shared `@leadwolf/types` Zod
> schemas either way; the client check is UX and the server re-validates (see
> **truepoint-security**).

A hook file should never import from another hook file in the same directory
in a way that creates a chain. If two hooks depend on each other, they belong
in the same feature module with a shared internal utility.

---

## API Call Rules

Never write raw `fetch` or `axios` calls inside components or hooks directly.
All API calls go through a typed client whose payloads are validated against the
shared `@leadwolf/types` Zod schemas, or through a file in the feature's `api/`
folder — never an ad-hoc fetch outside that boundary.

A feature's `api/` folder structure:
```
api/
├── index.ts       # re-exports all functions
├── fetch.ts       # read operations
├── mutate.ts      # write operations (create, update, delete)
└── types.ts       # request/response types for this feature's API
```

Each function in `fetch.ts` and `mutate.ts` has one responsibility: one
endpoint, one return type. Error handling lives in the calling hook, not in
the API file.

---

## Styling

Styling is governed by the **design skill** — this section only states where the
boundary sits, so the two skills agree (the prior Tailwind-vs-inline contradiction
is resolved in favour of the design skill's token-driven approach):

- **Components encapsulate their own styling.** Reach for a `@leadwolf/ui`
  component before a styled `<div>`; the design system carries the look.
- **App-level layout uses inline `style={{ }}` reading `var(--tp-*)` tokens** — not
  Tailwind utility classes in app JSX, and not raw hex/px values. Every colour,
  space, radius, and shadow is a token.
- **Token-driven CSS modules are accepted** — the shell and larger features use
  `*.module.css` whose values are `var(--tp-*)` tokens; extend a feature's existing
  stylesheet rather than converting it to inline styles (and keep raw hex/px out of
  modules too). `<style>` blocks only for the narrow exceptions the design skill
  lists (`@keyframes`, `@font-face`).
- **Responsive** behaviour follows the design skill's breakpoints and patterns.

Full styling rules, tokens, components, and the permitted exceptions live in the
**truepoint-design** skill — defer to it for anything that renders.
