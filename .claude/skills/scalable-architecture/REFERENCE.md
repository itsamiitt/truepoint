# scalable-architecture — REFERENCE

Detailed conventions for the `scalable-architecture` skill. `SKILL.md` is the lean spine; load this file
when you need naming rules, the import-boundary enforcement config, the barrel strategy, separation-of-
concerns rules, testing layout, or per-stack / monorepo folder variations.

---

## 1. Naming conventions

Consistency (principle #10) matters more than which convention you pick. Defaults:

| Thing | Convention | Example |
|---|---|---|
| Feature folder | `kebab-case`, singular noun | `features/billing/`, `features/user-profile/` |
| Component file (TS/React) | `PascalCase.tsx`, one component per file | `InvoiceTable.tsx` |
| Hook file | `useThing.ts`, camelCase starting with `use` | `useInvoices.ts` |
| Service file | `thingService.ts` (or `thing.service.ts`) | `billingService.ts` |
| Types file | `types/index.ts` or `thing.types.ts` | `types/index.ts` |
| Utility file | `kebab-case.ts` or `camelCase.ts`, verb-y | `format-currency.ts` |
| Barrel | `index.ts` (TS) / `__init__.py` (Python) | `features/billing/index.ts` |
| Test file | `<name>.test.ts` (co-located) | `billingService.test.ts` |
| Constant | `UPPER_SNAKE_CASE` | `MAX_RETRIES` |
| Python module | `snake_case.py` | `billing_service.py` |

Rules: one primary export per file; name the file after its export; never use index files for anything
but re-export barrels; avoid generic names (`utils.ts`, `helpers.ts`) at feature scope — name by purpose.

## 2. File-size & complexity targets

- Soft cap **~200 lines**, hard cap **~300 lines** per file. Past that, split by responsibility.
- One React component per file. Extract sub-components and hooks rather than growing one file.
- A function over ~50 lines or with deep nesting is a split signal.
- These caps exist so an AI assistant can hold a whole file in context — that is the point of #9.

## 3. Layered separation of concerns

Within a feature, three layers, each with one job:

1. **Presentation (`components/`, and `hooks/` for stateful UI logic)** — renders and handles interaction.
   No direct `fetch`/DB/SDK calls; no business rules. Calls services via hooks.
2. **Business logic (`services/`)** — the feature's rules, orchestration, and external calls (API/SDK).
   Pure, testable, framework-agnostic where possible. This is where logic lives, NOT in components (#6).
3. **Data access (`services/` calling `lib/` clients, or a `repositories/` sublayer)** — talks to the
   DB/API client. Returns typed domain objects, not raw rows/responses.

Flow: `component → hook → service → data-access/lib`. Never skip upward (a component must not call the DB
client directly). Validation of inputs belongs at the service boundary (e.g. with Zod / Pydantic).

## 4. Import boundaries & the dependency graph

The single most important rule: **features never import from each other** (#4).

Allowed import directions:
- `features/<x>` → `shared/`, `lib/`, `config/`, `store/`, and its own files. ✅
- `features/<x>` → `features/<y>`. ❌ Route the need through `shared/` or `<y>`'s published `index`.
- `shared/` → `shared/`, `lib/`, `config/`. ✅ `shared/` → `features/`. ❌ (shared must not depend on a feature)
- `lib/` → external packages + `config/`. ❌ `lib/` → `features/` or `shared/` domain code.
- `app/` (routing/entry) → `features/<x>/index` (public surface only), `shared/`, `config/`. ✅

### Enforce it mechanically
Don't rely on discipline — wire a lint rule (see `templates/import-boundaries.md` for copy-paste config):
- **ESLint flat config** with `no-restricted-imports` patterns banning `features/*/!(index)` deep imports
  and cross-feature paths; or
- **`eslint-plugin-boundaries`** with element types (`feature`, `shared`, `lib`, `app`) and an allow-list; or
- **`dependency-cruiser`** with `forbidden` rules + a `depcruise` CI step; or
- **Python**: `import-linter` contracts (layered + independence contracts) in CI.

## 5. Public interface / barrel strategy

- Each feature exposes exactly one public entry: `features/<x>/index.ts`. It re-exports only what other
  layers may use (a few components, a service function or two, public types).
- Everything not re-exported is **internal** — other code must not reach into `features/<x>/services/...`.
- Keep barrels thin (re-exports only, no logic). Prefer named exports over default.
- In a monorepo, the package's `package.json` `exports`/`main` points at the package `index.ts`; that IS
  the public interface, and the lint rule forbids deep imports past it.

## 6. Testing structure

- **Co-locate** unit tests with code: `features/<x>/__tests__/thing.test.ts` (or `thing.test.ts` beside
  the file). Test services and hooks (the logic), not pixels.
- Integration/e2e tests live in a top-level `tests/` (or `e2e/`) folder, separated from unit tests.
- Naming: `*.test.ts` for unit; `*.e2e.ts` / Playwright specs for end-to-end. Python: `tests/` package
  with `test_*.py`.
- Because logic lives in services/hooks (#6), most behavior is unit-testable without rendering UI.

## 7. Config & secrets

- One `config/` module validates env **at boot** and exports a typed config object. Use Zod (TS) or
  Pydantic `BaseSettings` (Python). Fail fast on a missing/invalid var.
- Code reads config from this module — never `process.env.X` / `os.environ[...]` scattered through
  features.
- `.env.example` documents every variable name with a placeholder value and a comment. Real `.env` is
  git-ignored. Never commit secrets (#8).

## 8. AI-friendliness conventions

- Small, single-purpose files (#9) and a predictable per-feature layout mean an assistant can find and
  load exactly what it needs.
- Explicit types (#7) let the assistant reason about contracts without running code.
- A `CLAUDE.md` at the repo root records these conventions so every AI session follows them. Keep an
  `ARCHITECTURE.md` for humans; `CLAUDE.md` may reference it.
- If the project calls an LLM/AI provider, isolate it: provider calls live in a service (or a dedicated
  `features/ai/` or `lib/ai/`), prompts are versioned in files/constants (not buried inline), and the
  provider is behind an interface so tests can mock/replay it.

---

## 9. Per-stack folder variations

### React / Next.js (App Router) — TypeScript
Keep `app/` for routing only; put real code in `features/`. Routes are thin and delegate to a feature's
public `index`.
```
src/
├── app/                 # Next.js routes (thin): page.tsx, layout.tsx, route.ts → call features
├── features/<x>/        # components/ services/ hooks/ types/ utils/ index.ts
├── shared/              # ui/ hooks/ utils/ constants/ types/
├── lib/                 # db client, api clients, third-party SDK wrappers
├── config/              # env.ts (Zod-validated), constants
└── store/               # global state (Zustand/Redux) if needed
```
- Server components/actions call services directly; client components call hooks that call services.
- A route file should be a handful of lines: parse input → call `features/<x>` → return.

### Node / Hono / Express — TypeScript (backend)
Features map to domains, not to HTTP layers. No top-level `controllers/`.
```
src/
├── features/<x>/
│   ├── routes.ts        # HTTP wiring (thin): validate → call service → respond
│   ├── services/        # domain logic
│   ├── repositories/    # data access (DB queries)
│   ├── types/  utils/
│   └── index.ts         # public surface (router + any shared service)
├── shared/              # middleware, errors, validation helpers, types
├── lib/                 # db client, queue, cache, external clients
├── config/              # env validation
└── app.ts               # compose feature routers into the server
```
- `routes.ts` is the only place that knows about HTTP; services know nothing about req/res.

### Turborepo monorepo variant (`apps/*` + `packages/*`)
Use when there are multiple deployables or shared libraries. Each app is a deployable; each package is a
side-effect-free library exported through a typed `index.ts`.
```
apps/
├── web/        # Next.js (feature-sliced internally, as above)
├── api/        # Hono/Express server (feature-sliced internally, as above)
├── workers/    # background jobs
└── admin/      # internal console
packages/
├── core/       # domain logic, split by domain: core/<domain>/{ ... }, public index.ts
├── db/         # schema, migrations, repositories
├── auth/       # authentication
├── integrations/  # one folder per external provider
├── ui/         # shared components + theme tokens
├── config/     # Zod-validated env + shared tsconfig/lint presets
└── types/      # shared schemas + inferred types
```
**Dependency graph (enforce with `dependency-cruiser` / boundaries):**
- `apps/*` may depend on `packages/*`; **`apps/*` never depend on each other**.
- `packages/*` are side-effect-free; each exposes a public `index.ts`; **no deep imports** past it.
- Typical allowed layering: `core` → `db`, `types`, `config`; `integrations` → `core`, `types`;
  `ui` → only React/styling + `types`; `config`/`types` depend on nothing internal (leaf packages).
- Inside `packages/core`, split by domain (e.g. `core/billing/`, `core/scoring/`) — same feature-folder
  discipline applies one level down.

### Python (FastAPI / Django) — brief
Organize by feature/domain package, not by Django app-type folders.
```
src/<project>/
├── features/<x>/
│   ├── router.py        # FastAPI APIRouter (thin) — or Django urls/views, thin
│   ├── service.py       # business logic
│   ├── repository.py    # data access (ORM/SQL)
│   ├── schemas.py       # Pydantic models / type hints
│   └── __init__.py      # public surface
├── shared/  lib/  config/
└── main.py              # app assembly
tests/
```
- Type-hint everything; validate at the service boundary with Pydantic.
- Enforce feature independence with `import-linter` contracts in CI.

---

## 10. Quick checklist (used by review mode)

- [ ] Organized by feature, no by-type top-level folders (`controllers/`, `models/`, `views/`).
- [ ] No cross-feature imports; boundary lint rule present and passing.
- [ ] Each feature has an `index` barrel exposing only its public surface.
- [ ] Components contain no business logic / data access.
- [ ] No file over ~300 lines.
- [ ] Everything typed; no `any` / missing type hints.
- [ ] No hardcoded secrets; `.env.example` present and current.
- [ ] Tests co-located for units; integration/e2e separated.
- [ ] Consistent naming across all features.
