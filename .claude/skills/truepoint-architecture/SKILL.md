---
name: truepoint-architecture
description: >
  Enforces TruePoint's frontend architecture standards across the `apps/web` (customer)
  and `apps/admin` (internal) Next.js apps in the Bun monorepo. Use this skill whenever creating, moving,
  refactoring, or reviewing any frontend file — new features, routes, API calls,
  components, hooks, utilities, or client-side services. Also triggers when
  scaffolding a frontend package, wiring auth on the client, adding an env var, or
  planning how to structure a frontend feature. Triggers on any planning or "how
  should we build X" conversation about TruePoint features — it runs a mandatory
  pre-build reasoning pass before any code is written. For backend, data, tenancy,
  queues, or scale concerns it defers to truepoint-platform and truepoint-data. If
  the task touches frontend source files or feature structure, this skill is active.
---

# TruePoint Architecture Skill

This skill governs how **frontend** code is structured, split, named, and placed
across TruePoint's two Next.js frontend apps in the monorepo (`apps/web`, `apps/admin`).
It exists so that every agent and
every engineer arrives at the same answer for "where does this go and how big
should it be?" without reverse-engineering prior decisions.

It is the frontend-structure skill. The backend, the database, tenancy, queues,
caching, and scale live in **truepoint-platform**; the data model and data products
live in **truepoint-data**. This skill consumes the API those skills define and does
not reach past it.

---

## Which Skill, When

TruePoint has nine skills — six platform skills plus three `truepoint-extension-*`
skills for the browser extension (see the root `CLAUDE.md` routing table). Most real
features touch several.

- **truepoint-architecture** (this skill) — WHERE frontend code lives and HOW it is
  structured. Feature modules, file size, client state/data flow, query keys, tests,
  frontend packages, multi-agent coordination, the pre-build pass.
- **truepoint-platform** — the backend, the database, the tenancy model, the API
  contract, queues, caching, service topology, observability, scale.
- **truepoint-data** — the canonical data model, ownership/sharing, the enrichment
  and verification pipelines, search, retention/deletion.
- **truepoint-design** — HOW it looks and behaves in the browser. Components, tokens,
  layout, responsive, accessibility, motion, copy, brand.
- **truepoint-security** — WHETHER it is safe. Access control, IAM, input validation,
  data protection, secrets, API hardening, compliance.
- **truepoint-operations** — running it: incidents, runbooks, FinOps.
- **truepoint-extension-{architecture,linkedin,auth}** — the browser extension
  (`apps/extension`): the MV3 shell/build, the LinkedIn content script, and
  extension auth/tokens. Anything under `apps/extension` routes there.

Take "add a prospect to a list":
- Architecture (this skill): where the feature folder, mutation hook, and query key
  live; how the four UI states are wired; which dependencies to wire.
- Platform: the API endpoint contract, the idempotency key, the write path.
- Data: the ListMembership row, the activity/audit rows, ownership.
- Design: how the button, modal, and toast look and behave; accessibility; copy.
- Security: the write is tenant-scoped (RLS) and the list ID from the client is
  verified server-side.

Read whichever skills your task touches. Any feature that handles data needs several
active at once.

---

## Step 0 — Think Before You Build

**Read `references/pre-build-thinking.md` before writing any code or creating any
file.** For every task, the agent completes a silent reasoning pass covering failure
modes, source of truth, security, scalability, edge cases, rollback, and worst-case
scenarios, then surfaces a structured plan for confirmation.

The scale questions in that pass (what breaks at 10x, does this need a queue, are
connections pooled, how is data isolated) are answered using **truepoint-platform**;
the data and tenancy questions using **truepoint-data** and **truepoint-platform**;
the security questions using **truepoint-security**. The pre-build pass asks; those
skills answer. Most data features need all of them.

**No code before the plan is confirmed.**

---

## The Application Architecture (resolves how the apps are built)

This is fixed, so there is one answer:

- The frontends — `apps/web` (`@leadwolf/web`, `app.truepoint.in`, the customer
  surface) and `apps/admin` (`@leadwolf/admin`, the internal/platform-admin surface;
  its subdomain is TBD) — are **Next.js App Router**
  applications. They use file-based routing, route groups, server components, and
  middleware. They are **pure presentation layers**: no business logic, no direct
  database access, no provider secrets. All of that is the backend
  (truepoint-platform; the real service is `apps/api`, `@leadwolf/api`). Next.js route
  handlers (`app/api/`), if ever added, do only BFF aggregation, auth-cookie
  handling, and the few frontend-owned webhooks — today neither frontend app has
  any (`apps/web`/`apps/admin` call `apps/api` directly via `fetchWithAuth`).
- **Note on the legacy prototype.** An earlier single-file `crm-app.jsx` prototype
  (with a `window.TruePointUI` global and a client-side view switcher) was the
  origin of the design system and patterns. It is **superseded** by the
  feature-folder structure here and by normal package imports from `@leadwolf/ui`
  (see the design skill). Do not build new work as a single file or against a window
  global; build features in `features/` and import the design system. Where the
  design skill still references `crm-app.jsx` as a source of truth for a shared atom,
  treat the equivalent `@leadwolf/ui` component as the real source.

This resolves the prior contradiction between file-based routing and a single-file
view switcher: it is Next.js App Router, with shared chrome via layouts, not a
hand-rolled shell in one JSX file.

---

## Working in Existing Code

Most tasks are modifications, not greenfield. Before changing existing code:

1. **Find the feature folder** that owns the surface; read its `index.ts`.
2. **Read the existing pattern before adding to it** — match the feature's existing
   `api/`, hooks, and components rather than your preferred style.
3. **Trace the data** — find the query/mutation hooks and query keys before touching
   server-state reads/writes (`state-and-data.md`).
4. **Check for a shared version first** — search `packages/` and the feature folder
   before writing a helper, component, or type. Don't create a second `formatPhone`.
5. **Grep before you rename or remove** (`removal-cleanup.md`).

A consistent codebase an agent can predict is worth more than a locally-optimal file
that surprises the next reader.

---

## The Two Frontend Apps

Both live in the one Bun monorepo (root package `leadwolf`) under `apps/`, alongside
`apps/auth` (`@leadwolf/auth-app`, the IdP), `apps/api` (`@leadwolf/api`), and
`apps/workers` (`@leadwolf/workers`). Shared code is in `packages/*` under the
`@leadwolf/*` scope.

| App | Serves | Audience |
|---|---|---|
| `apps/web` (`@leadwolf/web`) | `app.truepoint.in` | End customers |
| `apps/admin` (`@leadwolf/admin`) | internal/platform-admin surface (subdomain TBD) | Internal staff, platform admins |

Authentication is centralised (`auth.truepoint.in`, served by the dedicated
`apps/auth` IdP) and consumed via **each app's local auth client**
(`src/lib/authClient.ts` — PKCE, in-memory access token, silent refresh, ADR-0016);
`@leadwolf/auth` is the backend IdP/verification package (consumed by `apps/auth`
and `apps/api`, never by the frontends). Enterprise IAM
(SSO/SAML/SCIM) and the security model behind auth live in **truepoint-security**
(enterprise-iam); this skill covers only the client-side session/middleware pattern
(`auth.md`).

---

## The File Size Rule

Every file has one job. If a file is doing more than one job, split it.

**Guideline limit: 150 lines per file.** Files approaching it are a signal to split.
The goal is not to hit exactly 150 lines; it is to write files so focused that 150
is rarely needed. A file may exceed it only when splitting would force an artificial
abstraction that makes the code harder to understand — a rare, justified exception
(more common for a backend state machine or policy than for UI; see
`truepoint-platform` service-topology).

This matters for AI agents: a focused file fits cleanly in a single context read, so
an agent can understand and modify it without reconstructing intent from fragments.
Small files are an investment in every future agent interaction. (It is an important
discipline — but it is one of several; correctness rules like tenant-scoping every
query, see `truepoint-security`, outrank file size when they ever tension.)

It applies to `.ts`, `.tsx`, `.js`, `.jsx`, and config files with meaningful logic;
not to generated files, lock files, or flat schema lists.

---

## How to Split a File

```
enrichment.ts   (180 lines: fetching, normalising, caching, error handling)
```
becomes
```
enrichment/
├── index.ts          (re-exports; ~10 lines)
├── fetch.ts          (API call only; ~40 lines)
├── normalise.ts      (data shaping; ~35 lines)
├── cache.ts          (cache read/write; ~30 lines)
└── errors.ts         (typed error classes; ~20 lines)
```

The `index.ts` re-exports what the outside world needs; consumers import from
`enrichment/` and never know about the split. Use this for API integrations, form
logic, data transforms, service modules, and any hook that has grown multiple
concerns.

---

## Naming Conventions

**Files** — Components `PascalCase.tsx`; hooks `useCamelCase.ts`; utilities/services
`camelCase.ts`; types `camelCase.types.ts`; constants `SCREAMING_SNAKE.ts` or
`camelCase.constants.ts` (consistent per package); tests `*.test.ts`/`*.spec.ts`
co-located; config `camelCase.config.ts`.

**Directories** — Feature dirs `kebab-case/`; `__tests__/` only for dedicated test
folders (prefer co-location); never a top-level `utils/` — be specific
(`formatters/`, `validators/`, `transforms/`).

**Exports** — Every multi-file directory exposes an `index.ts` barrel; barrels only
re-export, no logic; named exports preferred everywhere except React components
(default export, for lazy loading).

---

## Shared Frontend Packages

Both apps consume shared **internal Bun-workspace** packages from the `@leadwolf/`
scope under `packages/` (not published to a registry — resolved via the workspace).
The full discipline is in `references/shared-packages.md`. Key points:

- `@leadwolf/auth` — **one internal package consumed by both apps**, not copied
  per app (a copy is not a single source of truth and lets auth logic drift — a
  security risk). The dedicated `apps/auth` IdP (`@leadwolf/auth-app`) backs it.
- `@leadwolf/types` — the shared Zod schemas that are the single source of truth for
  request/response types, imported by both the API (`apps/api`) and the web/worker
  clients; never hand-edited away from the schema. (There is no OpenAPI-generated
  client.)
- `@leadwolf/ui` — the design system. **Design tokens (brand) are a single shared
  source**; only the *components* may diverge between customer and internal. Tokens
  must not fork (see the design skill).
- `@leadwolf/core` — the shared **server-side** domain layer (it depends on
  `@leadwolf/db`/`@leadwolf/config`; never import it into `apps/web`/`apps/admin`).
  There is no `utils` package.

---

## Environment Variables

Every variable is documented in `.env.example`. `NEXT_PUBLIC_` is bundled into the
browser and is **public** — never put a secret behind it. No-prefix variables are
server-only. The full secret-handling discipline is in **truepoint-security**
(secrets).

---

## UI Consolidation Rule

Before scaffolding any new page, tab, route, or feature folder, ask: **can this live
on a surface that already exists?** The default is yes. Agents tend to create a new
tab/page per feature variation, producing duplicate layouts and hooks. Run the
merge-first test (same domain, same layout, variant-not-page, additive-not-parallel)
and consolidate by default. Full test, the enrichment before/after, and the
switcher-vs-tab-vs-query-param guidance: `references/ui-consolidation.md`.

## Removal Cleanup Rule

When anything is removed, it's not done until every trace is gone — component, hooks,
API files, types, route handler, permission entry, constants, analytics, and feature
flags (flags rot too — see `feature-flags.md`). After deleting, grep for references
and run `bun run typecheck`. Full checklist: `references/removal-cleanup.md`.

## Dependency Wiring Rule

Every feature that creates/modifies/deletes data has cross-cutting dependencies to
wire at build time — audit, export, permissions, activity feed, notifications,
optimistic UI, search indexing, webhooks. Stub the unbuilt ones with a typed no-op
and a `// WIRE:` comment. Full checklist and the prospect-to-list example:
`references/dependency-wiring.md`.

---

## State and Data (client side)

Keep server state and client state strictly separate. Anything answerable by a GET
is server state and lives in a TanStack Query hook — never `useState`. Reads go
through query hooks, writes through mutation hooks; components never call the API
client directly. Query keys are defined once per feature in `keys.ts` and are
hierarchical. Errors surface through the hook to the component (an `ErrorState` for
failed loads, a destructive toast for failed actions). This is the **client cache**;
the server-side cache (CDN/Redis) is **truepoint-platform** caching. Full patterns:
`references/state-and-data.md`.

---

## Testing

Coverage targets are 80% `packages/`, 60% `apps/` — a floor, not a goal. (No CI
coverage gate exists yet: CI runs `bun test` without coverage; the thresholds are
the intended gate to build toward.)
Beyond unit/component tests, the test classes that matter at scale — contract tests
against the API (the shared `@leadwolf/types` Zod schemas), integration tests, the
mandatory **cross-tenant isolation test**, and load tests — are covered in
`references/testing.md`. Wire the cheap high-value tests at build time.

> **Implementation status:** the cross-tenant isolation mandate is only partially met
> — a DB-level proof exists (`packages/db/test/workspaceSwitch.itest.ts`), but there
> is no per-endpoint cross-tenant isolation test yet.

---

## Multiple Agents

TruePoint is built by multiple agents in parallel against the shared monorepo,
coordinating through git + worktrees (the repo uses `.claude/worktrees`) and small
commits, not shared memory. Claim work by feature
folder or package; serialize edits to collision-magnet shared files; commit small and
often; never push a state that fails to build; stub unbuilt dependencies with
`// WIRE:`. Enforcement (CODEOWNERS, branch protection) and the migration-collision
rule are in `references/multi-agent.md`.

---

## Reference Files

Read only the one that matches your task.

| Task | Read |
|---|---|
| Working in `apps/web` (customer) | `references/customer-repo.md` |
| Working in `apps/admin` (internal) | `references/internal-repo.md` |
| Adding/modifying a shared frontend package | `references/shared-packages.md` |
| New page/tab vs consolidate | `references/ui-consolidation.md` |
| CI/CD pipelines, commits, PRs | `references/cicd.md` |
| Client-side auth, tokens, sessions | `references/auth.md` |
| Removing a feature or option | `references/removal-cleanup.md` |
| Wiring cross-cutting dependencies | `references/dependency-wiring.md` |
| Client state, data fetching, query keys, errors | `references/state-and-data.md` |
| Writing tests / what to test | `references/testing.md` |
| Working with other agents in parallel | `references/multi-agent.md` |
| Frontend migration hygiene (DB migrations → platform) | `references/database.md` |
| Feature flags and their lifecycle | `references/feature-flags.md` |
| Pre-build reasoning pass (read before any code) | `references/pre-build-thinking.md` |

> Note: `references/database.md` covers migration *hygiene*. The data *platform*
> (scaling, partitioning, pooling, tenancy) is **truepoint-platform**; the data
> *model* is **truepoint-data**. Read those for anything beyond migration mechanics.

> Note: the navigation/architecture map (`docs/ARCHITECTURE_MAP.md` +
> `docs/architecture-map.json`) is kept in sync by the active hooks
> `.claude/hooks/gen-architecture-map.mjs` + `check-architecture-map.mjs` (run on
> Stop) — keep it clean when you move or add source files. Planning docs live in
> `docs/planning/` and must stay internally wired when a feature or decision changes.

---

## Companion Skills

This skill governs frontend structure. It defers to **truepoint-platform** (backend,
data platform, tenancy, scale), **truepoint-data** (model, enrichment, search),
**truepoint-design** (everything that renders), **truepoint-security** (whether it's
safe), and **truepoint-operations** (running it). A feature that handles data is
governed by several at once — this skill says where the frontend files and client
data flow live.
