# Internal App — `apps/admin` (`@leadwolf/admin`)

The internal/platform-admin surface (operators, supervisors, platform superadmins).
Its subdomain is TBD. It is one app inside the one Bun monorepo, alongside `apps/web`
(the customer app), `apps/auth`, `apps/api`, and `apps/workers`. Operator and
superadmin concerns are sections of this one app — they share enough logic that
splitting them into separate apps would create more overhead than it saves; route
groups separate the two concern areas within `apps/admin`.

---

## Directory Structure

```
apps/
└── admin/                       # @leadwolf/admin — the internal/platform-admin app
    ├── app/
    │   ├── (auth)/
    │   │   ├── calls/           # operator-facing sections
    │   │   ├── contacts/
    │   │   ├── dashboard/
    │   │   ├── users/           # platform-admin sections
    │   │   ├── billing/
    │   │   ├── platform/
    │   │   └── layout.tsx
    │   ├── api/
    │   └── layout.tsx
    ├── features/                # Feature modules (operator + platform-admin)
    ├── components/              # App-specific shared components
    ├── hooks/                   # App-specific shared hooks
    ├── lib/
    └── middleware.ts

packages/                       # shared @leadwolf/* workspace packages
├── ui/                         # @leadwolf/ui — design system (--tp-* tokens)
├── types/                      # @leadwolf/types — shared Zod schemas (API contract)
├── auth/                       # @leadwolf/auth — auth wrapper
└── core/                       # @leadwolf/core — shared pure helpers

# RBAC role logic: today a single source-of-truth module (see the permissions note
# below) — there is no packages/permissions package yet.
# repo root: turbo.json, biome.json, package.json (workspaces), .env.example,
# .github/workflows/ (path-filtered per app)
```

---

## The App-Specific vs Shared Rule

Before placing any code, ask: does this belong only to `apps/admin` (operator or
platform-admin sections), only to `apps/web` (the customer app), or to both?

| Code belongs to | Place it in |
|---|---|
| Internal-only (operator / platform-admin) | `apps/admin/features/` or `apps/admin/components/` |
| Customer-only | `apps/web/features/` or `apps/web/components/` |
| Both apps | `packages/` (`@leadwolf/*`) |

When moving code from one app into a shared package, the package is the single
source of truth. The apps import from the package — never copy-paste between apps.

---

## Feature Module Pattern

Same structure as the customer app. Each feature is self-contained.

```
apps/admin/features/
└── call-bar/
    ├── index.ts
    ├── components/
    │   ├── CallBar.tsx
    │   ├── CallTimer.tsx
    │   └── CallControls.tsx
    ├── hooks/
    │   ├── useActiveCall.ts
    │   └── useCallDuration.ts
    ├── api/
    │   ├── index.ts
    │   ├── fetch.ts
    │   └── mutate.ts
    ├── types/
    │   └── call.types.ts
    └── __tests__/
```

---

## Permissions Package

`@leadwolf/permissions` is the only place role logic lives.

> **Implementation status:** not yet a standalone package — there is no
> `packages/permissions` today. The mandate below stands; until the package exists,
> keep the role logic in one source-of-truth module and grep before adding a role
> string anywhere else, then extract it to `packages/permissions/` when it lands.

```
packages/permissions/src/
├── index.ts             # Public API
├── roles.ts             # Role enum / constants (~30 lines)
├── guards.ts            # canDo(role, action) checks (~50 lines)
├── policies/
│   ├── index.ts
│   ├── contacts.ts      # Contact-related permissions
│   ├── billing.ts       # Billing permissions
│   └── platform.ts      # Platform admin permissions
└── types/
    └── permissions.types.ts
```

Rules:
- Role strings are never hardcoded outside this package
- Every permission check goes through `guards.ts`
- Adding a new role requires a PR to this package — not a one-off string in a component
- Both apps read from `@leadwolf/permissions` — they never duplicate logic

---

## Internal vs Customer Design System

Both apps share `@leadwolf/ui` but can extend it. The base package provides
the foundational primitives (built on the shared `--tp-*` tokens). Each app can have
an `app-specific/` components folder for components too specialised to share.

Operator UI tends toward: real-time status, dense tables, call controls, quick
actions. Platform-admin UI tends toward: data tables, configuration forms, audit
logs, platform controls.

Do not merge these concerns into the shared `@leadwolf/ui` — keep the shared
package minimal and generic. App-specific components stay in the app.

---

## What Goes Where (Internal)

| Code | Location |
|---|---|
| An operator-facing page | `apps/admin/app/(auth)/[route]/page.tsx` |
| A platform-admin page | `apps/admin/app/(auth)/[route]/page.tsx` |
| Internal feature (components, hooks, API) | `apps/admin/features/[feature-name]/` |
| Shared component (both apps need it) | `packages/ui/src/` |
| Role / permission logic | `packages/permissions/src/` (mandate; not yet a package — see the permissions note) |
| A request/response type (the API contract) | `packages/types/src/` (shared Zod schemas) |
| Pure helper | `packages/core/src/` |
| Server action / route handler | `apps/admin/app/api/` |
| Auth check / redirect | `apps/admin/middleware.ts` |
