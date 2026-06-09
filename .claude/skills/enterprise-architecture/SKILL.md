---
name: enterprise-architecture
description: >-
  Govern and navigate the LeadWolf monorepo. Use whenever you create, edit, move, or refactor source
  files under apps/** or packages/**, add a feature/module, or are asked to update/audit the architecture
  map (navigation graph). Enforces this repo's feature-based, layered, typed, small-file architecture
  (Turborepo: apps/* + packages/*, source of truth in docs/planning/16 + 02) and keeps
  docs/ARCHITECTURE_MAP.md + docs/architecture-map.json in sync with the code. Complements
  scalable-architecture (generic conventions) and plan-weaver (planning docs); do not duplicate them.
---

# enterprise-architecture

**Prime directive: when invoked on an architecture-affecting task, keep LeadWolf feature-based, layered,
typed, small-file, and navigable.** Be honest about what enforces what. A skill description influences
when a model loads this skill — it does **not** guarantee real-time enforcement on every keystroke. The
two backstops that are *mechanical* are: the **CI lint gate** (`dependency-cruiser`, runs on every push)
and the **`Stop` hook** (refreshes the navigation map at every task end). This skill is the brains; those
two are the guarantees. Trust them, not the prose.

This repo's locked architecture is a **Turborepo monorepo** — `apps/{web,api,workers,admin}` (thin
transport adapters) + `packages/{core,db,auth,integrations,search,email,ui,analytics,observability,
config,types}` (side-effect-free libraries). Domain logic lives in `packages/core`; data access in
`packages/db`; jobs in `apps/workers`. See `reference/architecture-contract.md`.

## When this skill applies

- Creating / editing / moving / refactoring source under `apps/**` or `packages/**`.
- Adding a new feature/module (it spans api + web slices + a `core` domain + a `db` repository + maybe a
  worker queue).
- "update / audit / regenerate the architecture map (navigation graph)".

When it does **not** apply:
- Edits to `docs/planning/**` → that's [`plan-weaver`](../plan-weaver/SKILL.md).
- Generic greenfield scaffolding unrelated to LeadWolf's monorepo → that's
  [`scalable-architecture`](../scalable-architecture/SKILL.md).

## Authoritative sources (read these; do not restate or fork them)

- **LeadWolf layout + the allowed dependency graph** → [`docs/planning/16-code-organization.md`](../../../docs/planning/16-code-organization.md)
  and [`docs/planning/02-architecture.md`](../../../docs/planning/02-architecture.md).
- **Generic conventions + import-boundary lint configs** → the `scalable-architecture` skill's
  [`REFERENCE.md`](../scalable-architecture/REFERENCE.md) and
  [`templates/import-boundaries.md`](../scalable-architecture/templates/import-boundaries.md).
- **Canonical feature/domain list** → [`docs/planning/05-features-modules.md`](../../../docs/planning/05-features-modules.md)
  (modules) + [`docs/planning/11-information-architecture.md`](../../../docs/planning/11-information-architecture.md)
  §2/§6 (the 6 web destinations → module → API map).
- `reference/architecture-contract.md` is a **distillation with links back** to the above — a quick
  index, never the source of truth. If it disagrees with 16/02, 16/02 win and the contract is corrected.

## Load supporting files only when needed (progressive disclosure)

- **`reference/architecture-contract.md`** — the two trees, inside-an-app / inside-a-package layouts, the
  allowed import edges, layer separation, naming, file-size, and the tenant-scoping invariant.
- **`reference/navigation-map-spec.md`** — the exact format/schema for `docs/ARCHITECTURE_MAP.md` and
  `docs/architecture-map.json`, plus the planned-vs-live trust rules. Read this **before** regenerating
  the map; do not hand-improvise the format.
- **`reference/map-maintenance.md`** — when to regenerate, the `status:"planned"` bootstrap, and the
  merge-conflict (regenerate-wins) policy.
- **`reference/ownership-matrix.md`** — which skill/doc owns each cross-cutting rule (validation, error
  handling, tenant-scoping, testing, migrations) so nothing is silently dropped.
- **`templates/`** — `ARCHITECTURE_MAP.md` + `architecture-map.json` skeletons, and
  `dependency-cruiser.cjs` (the import-boundary rules, installed with first code).

## Operating workflow (numbered; follow in order)

### 1. Read the map first — as a *starting index*, not ground truth
Open `docs/architecture-map.json` / `docs/ARCHITECTURE_MAP.md` to locate the files a feature touches
before searching. **Caveats that matter:**
- The map can go **stale mid-task** (you read it at step 1, then add three files). For multi-file work or
  any doubt, **re-derive from the filesystem** rather than trusting a path you read earlier.
- If `status` is `"planned"`, the listed paths are **targets, not locations** — the code does not exist
  yet. Never open a planned path as if it were real.
- If `status` is `"live"`, validate a path exists before relying on it; if code and map disagree, the
  **code wins** and the map gets regenerated (step 5).

### 2. Confirm the change fits the architecture
Check it against `reference/architecture-contract.md`. If it needs a **new feature/module**, create the
correct monorepo slices (only those it actually needs):
- `apps/api/src/features/<domain>/` — `routes.ts` (HTTP wiring only) + `schema.ts` + `index.ts`.
- `apps/web/src/features/<domain>/` — `components/ hooks/ api.ts store.ts? types.ts index.ts`.
- `packages/core/src/<domain>/` — the service(s) + helpers (the business rules; HTTP-agnostic).
- `packages/db/src/repositories/<entity>Repository.ts` — data access only.
- `apps/workers/src/queues/<queue>.ts` — if it has async work.
Wire each `index.ts` barrel to export only the public surface.

### 3. Make the change (the rules that bite)
- **Layer separation:** `apps/api routes.ts` → `packages/core` service → `packages/db` repository. Logic
  never leaks upward (services know nothing about HTTP; repositories know nothing about business rules).
- **Dependency direction:** `apps/*` may import `packages/*` but **never another app**; import a package
  only through its `index.ts` (**no deep imports**); no cross-feature imports inside an app. The
  `dependency-cruiser` gate enforces this — see `reference/architecture-contract.md` §"Mechanical gate".
- **Tenant-scoping (LeadWolf invariant):** every workspace-scoped repository query runs under the RLS
  GUC (`app.current_workspace_id` / `app.current_tenant_id`) inside the transaction; workspace id comes
  from the session/key, never the request body (02 §4, 03 §9). Flag any repository that omits it.
- **Naming:** descriptive, role-based filenames (`revealContact.ts`, `contactRepository.ts`,
  `RevealButton.tsx`); never `helpers.ts` / `utils2.ts`. (16 §8.)
- **Header comment:** each new file starts with a 1–2 line comment stating its single responsibility.
- **No `process.env` outside `packages/config`**; no secrets in code; no dead or commented-out code.

### 4. Verify file sizes & responsibilities (with the escape hatch)
Evaluate any file approaching ~200 (soft) / ~300 (16 §8) lines: if it has **more than one
responsibility**, extract by responsibility ("extract when a block has a name") — but only when it's
safe and doesn't hurt readability. **Escape hatch (overrides the cap):** a genuinely cohesive single unit
(a coherent React feature component, a Drizzle schema file) may exceed 300 lines — **leave it and add a
one-line header note saying why**. 300 is an evaluation trigger, not a hard ceiling. Never chop a cohesive
file to hit a number.

### 5. Regenerate the navigation map (the end-of-task step)
- **JSON:** run `node .claude/hooks/gen-architecture-map.mjs` — it deterministically rebuilds
  `docs/architecture-map.json` from the filesystem (stable-sorted, byte-stable). Do **not** hand-edit the
  JSON.
- **Prose:** refresh `docs/ARCHITECTURE_MAP.md` from the new JSON per `reference/navigation-map-spec.md`
  (tree + FEATURE→FILES index + DEPENDENCY section + Mermaid graph). The JSON owns the paths; you own the
  one-line purposes and the graph.
- If the generator reports an `unassigned[]` file, that's a placement/naming violation — fix the file's
  location/name, don't paper over it in the map.

### 6. Report
State what changed and where, referencing the FEATURE→FILES index: e.g. "Lists →
`apps/api/src/features/lists/routes.ts`, `packages/core/src/lists/*`,
`packages/db/src/repositories/listRepository.ts`, `apps/web/src/features/lists/*`." Note map status
(`planned`/`live`) and any flagged violations.

## Guardrails (non-negotiable)

- **The map is authoritative but the code is truth.** If they disagree, regenerate the map to match code.
- **Never introduce an app→app import or a deep package import.** Route cross-app/cross-feature needs
  through a package's public `index.ts`. The CI gate will fail the build otherwise.
- **Tenant-scoping is not optional** on workspace-scoped data access.
- **Regenerate, don't hand-write, the JSON map.** Prose is yours; the machine map is the generator's.
- **Stay in your lane.** Planning-doc coherence is `plan-weaver`; generic scaffolding is
  `scalable-architecture`. The navigation map lives in `docs/` (not `docs/planning/`).
- **Match existing conventions** over personal preference; consistency wins.
