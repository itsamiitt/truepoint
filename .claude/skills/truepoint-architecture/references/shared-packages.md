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

## `@leadwolf/auth` — Backend Primitives, One Package

`@leadwolf/auth` is the **backend** auth package: self-built primitives (password
hashing, session issuance/rotation, token mint/verify in `token.ts`, JWKS, MFA,
SSO adapters) consumed by `apps/auth` (the IdP origin) and `apps/api` (token
verification). **The frontend apps do not depend on it** — each owns a small local
auth client (`apps/{web,admin}/src/lib/authClient.ts` + `pkce.ts`; see `auth.md`).

> **It is a single internal Bun-workspace package, not copied per app.** A per-app
> copy is by definition *not* a single source of truth — copies drift, and drift in
> auth logic is a security risk. The same rule governs the two frontend
> `authClient.ts` files: they are deliberately small and parallel; change both
> deliberately, and never fork the underlying flow.

The client-side usage pattern is in `auth.md`; the enterprise identity model and
threat model are in **truepoint-security** (enterprise-iam, frontend-security).

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
└── *.ts                 # one Zod-schema module per domain (auth.ts, contacts.ts, …),
                         #   each exporting its schemas + inferred z.infer types (flat — no schemas/ dir)
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
├── index.ts             # Public API (re-exports)
├── cn.ts                # className helper
├── tokens.css           # the single shared --tp-* token source (not forked)
├── theme.css            # Tailwind @theme mapping onto the tokens
├── primitives.css       # .tp-ui-* classes
└── components/          # Card, DataTable, controls.tsx, ui/* (shadcn), …
```

Simpler components never import more complex ones — dependencies flow downward.
The shared tokens (the `--tp-*` namespace) are defined once (in `tokens.css`); the
components build on them. Keep the shared package minimal and generic; app-specific
components stay in the app (see `internal-repo.md`).

---

## `@leadwolf/core`

The shared **server-side domain layer** (there is no `utils` package). It depends on
`@leadwolf/db`, `@leadwolf/config`, and `@leadwolf/types`, hosts service logic
(ingestion, reveal, projection, feature flags) alongside pure formatters, and runs
async in-transaction work — so it is **server-only: never import it into
`apps/web`/`apps/admin`** (it would drag the Postgres client toward the browser
bundle). Organised by domain module (e.g. `email/`, `enrichment/`, `validation/`),
one concern per file.

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
