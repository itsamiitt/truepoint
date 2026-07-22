# Service Topology

This file answers "where does this backend logic live?" — the backend equivalent
of the architecture skill's "what goes where" for the frontend. It defines the
service boundaries so an agent places server logic consistently instead of
inventing a new service per feature (the backend version of the UI-consolidation
failure).

---

## The Shape: A Modular Backend, Not a Microservice Sprawl

TruePoint's backend is a **modular monolith with a few independently-scaled
workers**, not a swarm of microservices. At this stage that is the right default:
one deployable API service (`apps/api`) organised into clear internal feature
modules, plus separate worker processes (`apps/workers`) for async work, with any
genuinely-distinct concern (real-time, search) extracted to its own service only
when a real force demands it.

Why not microservices-first: premature service decomposition multiplies
deployment, network failure modes, distributed-transaction problems, and
cross-service auth — most of which are unnecessary when clean *module* boundaries
inside one service achieve the same separation without the operational tax.
Extract a service only when a real force demands it (independent scaling profile,
independent failure isolation, a different runtime).

---

## The Services That Do Exist

- **`apps/api`** (`@leadwolf/api`) — the HTTP API (see `api-contract.md`), a
  standalone Hono-on-Bun service on port 3001. Stateless, horizontally scaled
  behind a load balancer. Handles requests, owns the business modules, enqueues
  jobs. Holds no long-running work.
- **`apps/workers`** (`@leadwolf/workers`) — async job processors on Bun (see
  `async-jobs.md`), booted from `apps/workers/src/register.ts`. Separate
  deployable(s), scaled by queue depth. May be split by queue class (a heavy
  enrichment worker fleet vs a light outreach fleet).
- **`realtime`** — websocket/presence service for live call status, presence, and
  push updates to the sales floor (see the design real-time needs). Separate
  because its connection model and scaling profile differ entirely from
  request/response.
  > **Implementation status:** not yet met in the codebase — there is no separate
  > `realtime` service today; this is a future-extraction option, not a present
  > service.
- **`search`** — the search query + indexing surface (see `truepoint-data`
  search-infrastructure). Today it runs in-process in `apps/api`:
  `features/search/searchPortProvider.ts` wires the `SearchPort` (types in
  `@leadwolf/types`) to the Postgres index-backed `searchRepository` in
  `@leadwolf/db`. (`packages/search` holds only the unused in-memory adapter kept
  as the ADR-0021 seam — don't edit it expecting product effect.) Extracting a
  real search service is a future option.
- **`apps/forge-api` / `apps/forge-worker` / `apps/forge`** (`@leadwolf/forge*`) —
  the TruePoint Forge data plane (ADR-0047): the capture→parse→verify pipeline in
  its own `forge` schema under the least-privilege `leadwolf_forge` DB role
  (`withForgeTx`), so ingest can never read tenant contacts. Three separate compose
  services; the Forge console calls its own BFF, not the main API. Forge-domain
  logic goes here — never into `apps/api`.

The two frontend apps (`apps/web` = `@leadwolf/web`, the customer surface; and
`apps/admin` = `@leadwolf/admin`, the internal/platform-admin surface) are *not*
backend services — they are Next.js presentation layers that call `apps/api` (see
the architecture skill). `apps/auth` (`@leadwolf/auth-app`) is the dedicated Next.js
IdP. Their Next.js route handlers do only BFF/auth-cookie/owned-webhook work.

---

## Internal Module Boundaries (Inside `apps/api`)

The API service is organised into domain **feature** folders with the same single-
responsibility discipline as the frontend feature folders:

```
apps/api/src/features/
  contacts-bulk/   # contact + company domain
  search/          # prospect/account search working-set
  lists/           # lists and membership
  pipeline-stages/ # pipeline
  activity/        # activity feed + audit emission
  enrichment/      # enrichment orchestration (calls truepoint-data pipeline)
  billing/         # plans, usage, quotas
  auth/            # session, token verification
  outreach/        # outbound outreach
  ...              # account-search, scoring, compliance, settings, webhooks, …
```

Each feature owns its routes, its service/business logic, its data access, and its
types. A feature exposes a clear internal interface; other features call that, not
its internals. Cross-cutting concerns live in `apps/api/src/middleware/`
(`tenancy.ts` for tenant context, `authn.ts`, `idempotency.ts`, `rateLimit.ts`,
`error.ts`) and are applied uniformly — not reimplemented per feature.

The same file-size and single-responsibility rules from the architecture skill
apply to backend files: one job per file, split when a file grows multiple
concerns. (Backend logic — a state machine, a complex policy — gets a bit more
headroom than the UI 150-line guideline where forcing a split would obscure the
logic; the principle is one responsibility, not a hard line count.)

---

## Statelessness and Horizontal Scale

- The `api` service is **stateless** — any instance can serve any request. No
  in-process session store, no in-memory cache that must be consistent across
  instances (that's Redis — see `caching.md`), no sticky-session requirement.
- Horizontal scale is adding instances behind the load balancer. This only works
  if the service holds no per-instance state — which is why sessions, rate
  counters, and the tenant directory live in shared Redis, and jobs live in a
  shared queue.
- The same applies to workers: any worker can pick up any job for any tenant
  (setting tenant context per job).

---

## Deployment

> **Implementation status:** independent per-service pipelines and rolling
> zero-downtime deploys are the **target**. Today one image (`leadwolf:latest`) is
> built and every service is recreated together by `deploy/deploy.sh`
> (`up -d api auth workers web admin forge-* caddy`) on a single host — the script
> itself documents the resulting downtime window. The decoupled migrate step below
> is real. Do not assume a workers-only change leaves the API untouched.

- Each service deploys independently (its own pipeline — mirrors the architecture
  CI/CD per-app pipelines). A change to workers doesn't redeploy the API.
- **Zero-downtime deploys**: rolling, with health checks; the additive-first
  database discipline (see architecture `database.md`) means old and new instances
  run against the same schema during a deploy without breaking.
- **Migrations run as a deliberate step**, decoupled from instance rollout, in the
  additive-safe order — never a destructive schema change in the same release as
  the code that stops using the old shape.
- Configuration and secrets are injected at deploy time from the secrets manager
  (see architecture env-vars + `truepoint-security` secrets); each environment and
  each siloed cluster has its own config.

---

## When to Extract a Real Service

Extract a module into its own service only when one of these is true — the same
"when separate is correct" discipline the UI-consolidation rule applies to pages:

- It has a **fundamentally different scaling profile** (realtime, search — already
  separate).
- It needs **failure isolation** so its outage can't take down the core API.
- It runs a **different runtime** or workload type that doesn't fit the API
  process.

Absent one of these, a clean internal module is the answer — not a new service,
a new pipeline, a new network hop, and a new failure mode.

---

## Checklist

- Is this logic placed in the right existing module rather than a new service?
- Is the `api` service stateless, with shared state in Redis/queue/DB?
- Does anything long-running live in workers, not the request path?
- Does each service deploy independently with zero-downtime + additive migrations?
- If extracting a service, is there a real scaling/isolation/runtime force — not
  just "it felt cleaner"?
