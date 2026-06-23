# Shared Frontend Packages

Shared packages live under `packages/` in the one Bun monorepo and are **internal
Bun-workspace packages** under the `@leadwolf/` scope (resolved via the workspace,
not published to a registry). They follow the same file-size and
single-responsibility rules as application code. This file covers the **frontend**
shared packages; the backend is a separate service tier (`apps/api`, `@leadwolf/api`)
with its own internal modules (see **truepoint-platform** service-topology).

---

## Package Structure Template

```
packages/[package-name]/
├── src/
│   ├── index.ts          # Public API — re-exports only, no logic
│   └── ...               # Implementation files
├── package.json
├── tsconfig.json
└── README.md             # What it does, what it exports, a usage example
```

The `src/index.ts` barrel is the only thing consumers import from. Internal
structure can change freely without breaking callers.

---

## `@leadwolf/auth` — One Internal Package, Not Copied

The auth package wraps the centralised auth service (the dedicated `apps/auth` IdP,
`@leadwolf/auth-app`) and is consumed by **both** frontend apps.

> **It is a single internal Bun-workspace package, not copied per app.** A per-app
> copy is by
> definition *not* a single source of truth — the two copies drift, and drift in
> auth logic is a security risk (one app gets a fix the other doesn't). It lives once
> under the `@leadwolf/` scope; both apps depend on the workspace package. This
> corrects the earlier "copy per repo" framing.

```
packages/auth/src/
├── index.ts
├── session.ts       # getSession, refreshSession, clearSession
├── tokens.ts        # token validation helpers (no hand-decoding by callers)
├── redirect.ts      # redirectToLogin, redirectAfterLogin
└── types/auth.types.ts
```

`session.ts` and `tokens.ts` stay separate — session lifecycle and token parsing are
different concerns. The client-side usage pattern is in `auth.md`; the enterprise
identity model and threat model are in **truepoint-security** (enterprise-iam,
frontend-security).

---

## `@leadwolf/types` — Shared Zod Schemas (the API contract)

The cross-tier API contract is shared **Zod schemas** in `@leadwolf/types` — the
single source of truth for request/response types, imported by both the API
(`apps/api`) and the web/worker clients (see **truepoint-platform** api-contract).
There is no OpenAPI-generated client; the schema *is* the contract, so it is never
forked or hand-edited away from the shared definition.

```
packages/types/src/
├── index.ts             # Re-exports
├── schemas/             # Zod schemas — the request/response source of truth
└── ...                  # Inferred types (z.infer) exported for callers
```

A handwritten client instance (base URL, auth headers from `@leadwolf/auth`,
request/response interceptors) lives in the app/worker that calls the API and
validates payloads against these schemas. Changing a shared schema is a shared-file
change — coordinate it (see `multi-agent.md`).

---

## `@leadwolf/ui` — One Token Source, Diverging Components

The customer and internal design systems diverge enough to be separate component
sets — but their **brand tokens must not fork**.

> **Design tokens (colours, spacing, type, radii, shadows, motion) are a single
> shared source** consumed by both UIs. Two independent token sets would let the
> brand drift between customer and internal — same company, two slightly different
> looks. Only the *components* diverge; the *tokens* are one source (see the design
> skill, tokens.md). This corrects the earlier "two `@leadwolf/ui`, tokens included"
> framing.

```
packages/ui/src/
├── index.ts
├── tokens/              # ← consumes the single shared token source (not forked)
├── primitives/          # Atoms: Button, Input, Badge, Avatar (one per component)
├── composed/            # Molecules: Form, Modal, Dropdown
└── providers/ThemeProvider.tsx
```

A `primitives/` component never imports from `composed/` — dependencies flow downward.
The shared tokens (the `--tp-*` namespace) are defined once; each app's `@leadwolf/ui`
components build on them. Keep the shared package minimal and generic; app-specific
components stay in the app (see `internal-repo.md`).

---

## `@leadwolf/core`

Pure helpers only (there is no `utils` package). No side effects, no imports from
other `@leadwolf/` packages, no async. One concern per file (`phone.ts`, `date.ts`,
`email.ts`), files do not import each other.

> Note: the *normalisation* logic used for dedup/identity resolution (email, domain,
> phone) must be deterministic and shared so dedup keys match — its canonical home and
> rules are in **truepoint-data** enrichment-pipeline; `@leadwolf/core` may host the
> pure formatters, but the dedup semantics are owned there.

---

## `@leadwolf/permissions` (frontend rendering helper)

The frontend permission helper resolves what a user may *see* (rendering), reading
the user's resolved permissions. It mirrors — never replaces — the server-side
authorization, which is the real boundary (see **truepoint-security** access-control
and enterprise-iam). Role strings are never inlined outside this helper.

> **Implementation status:** not yet a standalone package — there is no
> `packages/permissions` today. The single-source-of-truth mandate stands; until the
> package exists, keep the rendering helper in one module (and grep before adding a
> role string anywhere else) rather than inlining roles across the apps.

---

## Adding a New Package

1. Copy the structure template into `packages/[name]/` (name it `@leadwolf/[name]`).
2. Add it under the workspace globs in the root `package.json` (`"workspaces": ["apps/*", "packages/*"]`) — already covered by `packages/*`, so a new `packages/[name]/` is picked up automatically; run `bun install` to link it.
3. Add it to the `turbo.json` build pipeline.
4. Write a `README.md` — required before any app imports it.
5. Export everything through `src/index.ts`.
6. Add it to the relevant reference file in this skill.
