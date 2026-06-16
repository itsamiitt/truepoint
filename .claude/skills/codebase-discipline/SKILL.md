---
name: codebase-discipline
description: >-
  The plain-English rulebook for how anyone (human or AI) safely adds or changes code in the
  LeadWolf repo. Use BEFORE planning or writing any code change — it covers where code goes, how to
  split big changes, commit/branch rules, the checks to run before every commit, frozen contracts,
  building for enterprise scale (millions of daily users), security, multi-agent coordination,
  worked examples, deploy gotchas, and a done checklist. Complements enterprise-architecture
  (layout + dependency graph), scalable-architecture (generic conventions), and plan-weaver
  (planning docs); it does not duplicate them — it links to them.
---

# codebase-discipline

**Read this before you touch the code.** This is the memory of *how we work* in the LeadWolf repo —
the rules that keep the codebase clean, easy to understand, and ready to serve millions of users a
day without falling over. If everyone (human or AI) follows it, anyone can open any feature and
know exactly where things live and how to change them safely.

This skill is the **how-you-work** layer. Three sister skills own the deeper detail, and this one
links to them instead of repeating them (so there is only ever one source of truth):

- [`enterprise-architecture`](../enterprise-architecture/SKILL.md) — the exact folder layout and
  the "what may import what" dependency graph.
- [`scalable-architecture`](../scalable-architecture/SKILL.md) — the generic modular principles
  behind that layout.
- [`plan-weaver`](../plan-weaver/SKILL.md) — keeping the planning docs in `docs/planning/` in sync.

When in doubt about *where code lives*, go to those. This document is about *how you move* once you
know where you are.

---

## 1. What this skill is for

Think of this as the team's shared memory. A new developer — or a fresh AI agent — should be able to
read it top to bottom in a few minutes and then add a feature, fix a bug, or ship a change without
making a mess or breaking production.

Two ideas run through everything below:

1. **Smallest safe change.** Touch the least code that solves the problem. Small changes are easy to
   review, easy to test, and easy to undo.
2. **Built for scale.** This product is meant to handle millions of users at the same time, every
   day. So every change has to ask: *will this still be fast and safe when a thousand people do it
   at once?*

---

## 2. The folder architecture

**Golden rule: organize by feature, not by technical layer.** A "feature" is a slice of the product
(import, billing, reveal). Everything that feature needs lives together, so you change one thing in
one place instead of hunting across the whole repo.

This is a **Turborepo monorepo**: `apps/*` (the runnable apps) and `packages/*` (shared libraries).
Each feature has the **same internal shape**, so once you understand one, you understand them all.

### The four layers, in plain English

| Layer | What it does | Where it lives |
|---|---|---|
| **Request layer** | Receives an HTTP request, checks the input, returns a response. **No business logic.** | `apps/api/src/features/<feature>/routes.ts` (web side: `apps/web/src/features/<feature>/api.ts`) |
| **Business-logic layer** | The actual rules — the "what happens" of the feature. **No HTTP, no database driver.** Reused by both the API and the background workers. | `packages/core/src/<feature>/` |
| **Data-access layer** | The **only** place allowed to talk to the database. | `packages/db/src/repositories/<x>Repository.ts` |
| **Shared types / validation** | The shapes and rules that everything agrees on (Zod schemas, error types). | `packages/types` |

**Why the split matters at scale:** when business logic is separate from HTTP, the *same* logic runs
inside a fast web request *and* inside a background worker handling a million-row import — no
copy-paste, no drift.

### Cross-cutting / shared code (used by more than one feature)

Kept **out** of feature folders so it never gets tangled:

- `packages/config` — environment variables and validation. **The only place `process.env` is read.**
- `packages/auth` — login / sessions / SSO primitives (no HTTP).
- `packages/ui` — shared design tokens and UI primitives.
- The database client (`packages/db/src/client.ts`) and the request middleware in
  `apps/api/src/middleware/` (`authn.ts`, `tenancy.ts`, `rateLimit.ts`, `error.ts`, `idempotency.ts`).

### Two rules that keep features tidy

- **One public entry point per feature.** Each feature/package exports through a single `index.ts`
  "barrel." Other parts of the app import *only* from that barrel — never reach into a feature's
  internals. (Example: `apps/api/src/features/import/index.ts` exports `{ importRoutes }` and nothing
  else is public.)
- **Thin top-level wiring.** The main app file `apps/api/src/app.ts` only *connects* features
  (mounts routers, adds global middleware). It contains **no real logic**.

### Shallow, obvious names

Folder and file names say exactly what they hold. **Never** use vague names like `misc`, `helpers2`,
or `stuff`. Avoid deep nesting — if you're four folders deep, something is wrong.

### Example tree — server side (the real `import/` feature)

```
apps/api/src/features/import/
  index.ts            # PUBLIC: exports { importRoutes }. Nothing else is public.
  routes.ts           # Request layer: POST /api/v1/imports — validate + call core. NO logic here.

packages/core/src/import/
  runImport.ts        # Business logic: the pipeline (map→normalize→encrypt→dedup→upsert). NO HTTP.
  parseFile.ts        # Helpers for this feature only. NOT shared across features.
  normalize.ts
  normalize.test.ts   # Tests live next to the code they test.

packages/db/src/repositories/
  sourceImportRepository.ts   # Data access: the ONLY file that reads/writes import rows.

# Does NOT belong here: UI, another feature's logic, raw process.env, secrets.
```

### Example tree — client side (the real `home/` feature)

```
apps/web/src/features/home/
  index.ts            # PUBLIC: exports { HomePage }.
  components/
    HomePage.tsx      # The UI for this slice.
  hooks/
    useHomeSummary.ts # Data-fetching / state for this slice.
  api.ts              # Authenticated calls to the backend (uses fetchWithAuth).
  types.ts            # View-model types ONLY. Domain types come from @leadwolf/types.

apps/web/src/app/(shell)/home/
  page.tsx            # Thin route: just renders <HomePage />.

# Does NOT belong here: business logic, direct DB access, another feature's components.
```

### Look here first — the modules that already exist

Before you invent anything, check whether it already lives in one of these:

- **API features** (`apps/api/src/features/`): `auth`, `import`, `reveal`, `billing`, `enrichment`,
  `scoring`, `compliance`, `activity`, `sales-navigator`, `outreach`.
- **Web features** (`apps/web/src/features/`): `home`, `import`, `prospect`, `sequences`, `reports`,
  `settings-billing`, `settings-compliance`.
- **Core domain modules** (`packages/core/src/`): `import`, `reveal`, `enrichment`, `billing`,
  `compliance`, `scoring`, `data-health`, `activity`, `outreach`.
- **Worker queues** (`apps/workers/src/queues/`): `imports`, `enrichment`, `scoring`, `dsar`,
  `outreach`.

### When a new top-level folder is justified

A new top-level feature folder is **rare**. Justify it only when the work is a **genuinely distinct
business area** that none of the modules above covers. Otherwise it belongs *inside* an existing
feature. For the authoritative "what may import what" rules, see
[`enterprise-architecture`](../enterprise-architecture/SKILL.md) and
[`docs/planning/16-code-organization.md`](../../../docs/planning/16-code-organization.md).

---

## 3. The feature-planning rule (very important)

**Before planning any "new" feature, prove it isn't already here.** Duplicate features are one of
the worst things you can do to a codebase: logic gets split across two places, bugs hide in the gap
between them, and everyone wastes time wondering which copy is real.

Follow these steps **in order**:

1. **Search.** Look through the module lists in §2 and
   [`docs/planning/05-features-modules.md`](../../../docs/planning/05-features-modules.md) for
   anything close to your idea. Search the code for related names.
2. **If a match or a parent feature exists → build inside it.** Your idea is almost always an
   *enhancement* of something that already exists. Add it there, following that feature's existing
   shape. Example: "add LinkedIn capture" is not a new feature — it extends `sales-navigator`.
3. **Only create a new feature when both are true:** nothing related exists, **and** it's a truly
   distinct business area.

**When in doubt, ask before creating.** A two-minute question is cheaper than a duplicate feature.

---

## 4. How to split a big change into small, safe pieces

A large change is just several small changes in a sensible order. Land them one at a time, each one
shippable on its own.

**The pattern:**
1. Add the new thing alongside the old thing (don't delete yet).
2. Switch callers over to the new thing.
3. Remove the old thing in a separate, final commit.

**Common templates:**

*A new endpoint* — keep the route thin, put the logic in core:
```ts
// apps/api/src/features/<feature>/routes.ts  (REQUEST LAYER — no logic)
feature.post("/", async (c) => {
  const input = MyInputSchema.parse(await c.req.json());   // validate
  const scope = { tenantId: c.get("tenantId"), workspaceId: c.get("workspaceId") };
  const result = await doTheThing(scope, input);            // call core
  return c.json(result);
});
```
```ts
// packages/core/src/<feature>/doTheThing.ts  (BUSINESS LOGIC — no HTTP)
export async function doTheThing(scope: TenantScope, input: MyInput) {
  // rules live here; data access goes through a repository
}
```

*A new service (business logic)* — new file in `packages/core/src/<feature>/`, then export it from
that package's `index.ts` barrel so others can use it.

*Moving a file* — move the file, but **keep the barrel's public exports identical** so nothing that
imports the feature breaks. Then run `bun run arch:map` to refresh the navigation map.

*A risky change* — put it behind a flag so you can ship it dark and turn it on later:
```ts
if (config.features.newThing) {
  await newThing(scope, input);
} else {
  await oldThing(scope, input);
}
```

---

## 5. One change at a time

Keep each commit small and focused so history stays clean and any change can be reviewed — or
reverted — on its own.

- **One commit = one topic.** Don't mix a bug fix with a refactor with a new feature.
- **Size targets:** aim for **~300 changed lines** per commit and stay within **one feature folder**.
- **File size:** keep files around **200 lines (soft) / 300 lines (hard)** — same rule the rest of
  the repo follows (see [`docs/planning/16-code-organization.md`](../../../docs/planning/16-code-organization.md)).
  If a file is growing past that, split it before you commit.
- **Commit messages — Conventional Commits**, the format this repo already uses:
  `type(scope): short summary` — e.g. `feat(reveal): add CSV export`, `fix(deploy): ...`,
  `refactor(import): split runImport`. Common types: `feat`, `fix`, `refactor`, `chore`, `docs`,
  `test`.

---

## 6. The checks before every commit

Run these from the repo root. **All must pass before you commit.**

```bash
bun run typecheck         # types are correct (must be clean)
bun run lint              # Biome rules pass (must be clean)
bun test                  # tests pass
bun run lint:boundaries   # no illegal imports across the dependency graph (must be clean)
bun run arch:map          # regenerate the navigation map if you added/moved/renamed files
```

`bun run format` (Biome) auto-fixes formatting — run it freely.

**Expected result:** every command exits green, and the architecture map is clean (zero unassigned
files). A **Stop hook** (`.claude/hooks/check-architecture-map.mjs`) fails closed if
[`docs/ARCHITECTURE_MAP.md`](../../../docs/ARCHITECTURE_MAP.md) / `docs/architecture-map.json` are
stale — if it complains, run `bun run arch:map` and commit the refreshed map.

If a check fails, **fix the cause** — never commit broken or skipped work.

---

## 7. Branch rules

- **Always work on a fresh branch.** Branch off `main`.
- **Never commit straight to `main`.**
- **Name branches `type/short-kebab-desc`** — e.g. `feat/reveal-csv-export`, `fix/import-dedup`.
- **Keep branches small and short-lived.** One feature/fix per branch.
- **Several people/agents at once:** each takes a separate branch and a separate feature folder so
  diffs don't collide. See §12.

---

## 8. Things that must never change casually (frozen)

These are contracts other systems and customers depend on. Changing them carelessly breaks live
clients. Treat them as frozen:

- **API paths** — e.g. `/api/v1/...`. Other apps call these.
- **Response shapes** — the JSON we return, including RFC-9457 "Problem Details" errors. Defined as
  Zod contracts in `packages/types`.
- **Database schema** — tables, columns, types.

**The safe way to change a frozen thing:**
1. Make it **additive** — add the new field/route/column; don't remove or rename the old one yet.
2. For schema, write a **new Drizzle migration** in `packages/db` (never edit an old one).
3. Record the decision as an **ADR** via [`plan-weaver`](../plan-weaver/SKILL.md).
4. Keep the old shape working until every client has moved, then remove it in a separate change.

See [`docs/planning/09-api-design.md`](../../../docs/planning/09-api-design.md) for the API contract
rules and the ADR registry for locked decisions.

---

## 9. Building for enterprise scale (millions of daily users)

Every change must stay fast and stable when thousands of people hit it at once. Rules below are in
plain English; where the infrastructure already exists it's marked, and where it's a **gap** the
rule says "do this going forward."

**Database**
- Always filter by an **indexed column**. `tenant_id` and `workspace_id` are indexed — query by them.
- **Never load everything into memory.** Always paginate. Existing endpoints cap the page size
  (max 500) — keep doing that.
- Keep **read replicas** in mind for heavy read paths. *(Gap: single database today — design reads so
  they could move to a replica later; don't assume one exists yet.)*
- **Don't run long queries inside a request handler.** If it's slow, push it to a background worker.
- **Respect the connection pool** (`max: 10`, `prepare: false` for the pooler). Don't hold
  connections open or open your own.

**Caching**
- Redis exists. **Cache hot, frequently-read data**, set a sensible **expiry (TTL)**, and **clear
  the cache when the underlying data changes** (stale cache = wrong answers).

**Background work**
- Anything slow — imports, enrichment, scoring, DSAR exports, outreach sends — goes to a **BullMQ
  queue** in `apps/workers`, **never** blocking the user's request. The queues already exist; add
  your slow work to the right one.

**Multi-tenant isolation (critical)**
- **Every query must be scoped to the right tenant/workspace.** Always go through
  `withTenantTx(scope, …)`, which drops to the `leadwolf_app` role and sets the row-level-security
  values for that transaction. One customer must **never** see another's data, even under load.
- Cross-tenant work (e.g. an admin DSAR) uses the **audited** `withPrivilegedTx` only.
- **Never hand-write a query outside a repository.** The repository + RLS are your double safety net.

**Statelessness**
- Request handlers hold **no per-user state in memory**. State lives in the database or Redis. This
  is what lets the app run on many servers behind a load balancer.

**Rate limiting & abuse protection**
- Every public endpoint is protected by `rate-limiter-flexible` at `/api/*`. **Protect any new
  public endpoint too.** The limiter fails *open* if Redis is down (an infra outage shouldn't block
  real users), but the endpoint still needs the rule attached.

**Bulk / batch operations**
- Process large data in **streams and batches**, never as one giant in-memory blob. The import
  pipeline already streams — follow that pattern for anything large.

**Observability**
- Every important path should emit **structured logs** and, eventually, **metrics**, so we spot
  slowdowns before users feel them. *(Gap: today it's mostly console logging — no metrics or tracing
  yet. Rule: write structured logs now; add metrics as that infrastructure lands.)*

**Graceful failure**
- Use **timeouts**, **retries with backoff**, and **fallbacks** so one slow dependency can't take
  everything down. Workers already drain in-flight jobs on shutdown; the rate limiter already fails
  open. Build new code the same way.

**Always**
- **No N+1 queries** (don't run one query per row in a loop — fetch in one go).
- **No unbounded loops** over user data (always have a limit).
- **Load-test anything on a hot path before shipping.**

---

## 10. Style do's and don'ts

**Do:**
- Match the Biome baseline: 100-char lines, 2-space indent, double quotes, semicolons, trailing
  commas. `bun run format` does this for you.
- Use clear, descriptive names that say what the thing is.
- Keep functions small and single-purpose.

**Don't:**
- ❌ `console.log` in app code — use the structured logger.
- ❌ Read `process.env` anywhere except `packages/config`.
- ❌ Giant functions or giant files (see the size rule in §5).
- ❌ Dead code — delete it, don't comment it out.
- ❌ Vague names (`misc`, `helpers2`, `stuff`).
- ❌ TODOs without a **name and date** — `// TODO(amit, 2026-06-15): …`.
- ❌ Secrets in code — ever.

---

## 11. Read the memory first

Before you touch a sensitive area, read the relevant note so you don't break something subtle:

- **Compliance / personal data (PII), DSAR, suppression** → [`docs/planning/08-compliance.md`](../../../docs/planning/08-compliance.md)
- **Auth, sessions, SSO, MFA** → [`docs/planning/17-authentication.md`](../../../docs/planning/17-authentication.md)
- **Money — credits, the reveal transaction** → [`docs/planning/07-billing-credits.md`](../../../docs/planning/07-billing-credits.md)
- **Database schema + row-level security** → [`docs/planning/03-database-design.md`](../../../docs/planning/03-database-design.md)
- **Locked decisions** → the ADRs in `docs/planning/decisions/` (managed by [`plan-weaver`](../plan-weaver/SKILL.md)).

Also check your long-term memory (CLARA) for anything relevant before starting non-trivial work.

---

## 12. Working with multiple agents (or people) at once

So two of you never edit the same file and step on each other:

- **Claim your area.** Say which feature/files you're working on before you start.
- **One branch per agent**, one feature per branch.
- **Don't edit the same files in parallel.** If two changes truly need the same file, do them in
  sequence, not at once.
- **Small commits** so merges stay painless.
- **Coordinate through the plan / planning docs**, not by guessing what the other agent is doing.

---

## 13. Security

Whenever you touch something sensitive (auth, billing, PII, anything tenant-scoped), **stop and ask:
"could this be exploited?"** Then **write a test that proves your fix works** and stays fixed.

Scale-related security counts too:

- **Floods of requests** → make sure rate limiting covers the endpoint (§9).
- **Data leaks across tenants** → every query through `withTenantTx`; never bypass RLS; trust the
  repository + RLS double net, and add a test that proves tenant A can't read tenant B's rows.
- **PII** → use the existing encryption (`encryptPii`) and blind-index helpers; don't store raw
  sensitive data.
- **Secrets** → never in code; always via `packages/config`.

---

## 14. Worked examples — "if I want X, do this"

- **Add an API endpoint** → new route in `apps/api/src/features/<feature>/routes.ts` (validate +
  call core) → logic in `packages/core/src/<feature>/` → data via a repository in `packages/db` →
  mount it in `apps/api/src/app.ts` → run the §6 checks.
- **Add a web page** → new feature folder under `apps/web/src/features/<feature>/` (components/,
  hooks/, `api.ts`, `index.ts`) → thin `page.tsx` under `app/(shell)/<feature>/` that renders it.
- **Fix a bug** → write a failing test that reproduces it → fix the cause → test goes green → §6
  checks → small `fix(scope): …` commit.
- **Add a background worker/job** → add the slow work to the right queue in
  `apps/workers/src/queues/` (or wire a new one in `register.ts`) → the API just enqueues, never
  does the slow work inline.
- **Add a database migration** → new Drizzle migration in `packages/db` (never edit an old one) →
  additive change → run `bun run db:migrate` → add/adjust RLS if needed.
- **Refactor a big file** → split into smaller files in the same feature, keep the `index.ts`
  exports identical, run `bun run arch:map`, land it as its own `refactor(scope): …` commit.
- **Extend an existing feature (instead of making a new one)** → find the parent feature (§3), add
  your code inside it following its existing shape. This is the default — most "new" work is really
  an extension.

---

## 15. Deploy gotchas (mistakes that have broken prod before)

- The slim Bun image has **no `wget`/`curl`** — healthchecks must use `bun -e "fetch(...)"`.
- **JWT keys must exist** in `deploy/keys/` or every login fails — the deploy script hard-fails
  first if they're missing.
- **DNS must resolve before Caddy** starts, or TLS certificate issuance fails.
- The connection **pooler resets transaction settings** — set the tenant/RLS values *inside each
  transaction* (which `withTenantTx` already does), never once at connect time.
- **Migrations must bypass the pooler** — they run against the direct database host.
- **Next.js builds are memory-hungry** (~8 GB) — give the build enough memory.

---

## 16. The "done" checklist

Tick all of these before you say a change is finished:

- [ ] My code is in the **right feature folder**, following the standard shape (§2).
- [ ] I confirmed this is **not a duplicate** of an existing feature (§3).
- [ ] I checked this **won't slow things down at scale** — indexed queries, pagination, slow work
      off to a worker, tenant-scoped (§9).
- [ ] `bun run typecheck`, `bun run lint`, `bun test`, `bun run lint:boundaries` all pass; the
      architecture map is refreshed (§6).
- [ ] **Frozen contracts** (API paths, response shapes, schema) are untouched — or changed safely
      with a migration + ADR (§8).
- [ ] If I touched something sensitive, I **wrote a test proving it's safe** (§13).
- [ ] One topic, small commit, Conventional Commit message, on a fresh branch (§5, §7).

---

## 17. One-sentence summary

**Find the right feature, make the smallest safe change, prove it's tenant-scoped and fast at scale,
run the checks, and leave the repo cleaner than you found it.**
