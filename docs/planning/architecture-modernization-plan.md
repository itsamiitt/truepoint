# Architecture Modernization Plan — Fastest-Path TruePoint

> **Status:** proposed · **Date:** 2026-07-26 · **Author:** architecture audit (4 parallel deep-audit agents
> over backend, frontend, data layer, auth/deploy + 1 adversarial verification pass; 13/15 load-bearing
> claims CONFIRMED against code, 2 corrected — corrections incorporated below).
> **Scope:** the whole platform — `apps/{api,web,admin,auth,workers}`, `packages/{db,core,auth,search,ui,types}`,
> deploy pipeline. Forge apps included where they share the defects.
> **Companion mandates:** `truepoint-platform` (tenancy/API/caching/data-platform), `truepoint-architecture`
> (state-and-data), `truepoint-design` (virtualization), `truepoint-security` (token/session).
> Several findings below are places where the codebase violates its **own** skill mandates — cited inline.

---

## 1. Verdict

The bones are modern — Bun 1.3 + Hono, Next 15 App Router + React 19, Drizzle + RLS with UUIDv7 keys,
keyset cursors, BullMQ with DLQs/leader locks/outbox+`SKIP LOCKED` projectors, EdDSA JWKS with key
rotation. The speed problem is not the stack; it is **five systemic mistakes layered on the stack**:

1. **Per-request transaction multiplication.** Every guarded API call pays an *extra* full DB transaction
   just to learn the caller's role, on top of a 2-RTT RLS bootstrap inside every `withTenantTx`, on top of
   rate-limit + revocation Redis hops — a ~10–25 ms serial floor per call to remote Neon before the real
   query runs.
2. **The frontend is a 2019 SPA wearing App Router clothes.** A client-only `useEffect` auth gate with the
   token in JS memory makes RSC/SSR unusable: cold boot = empty HTML → JS → hydrate → cross-origin refresh
   → preflights → first data. ≥6 serial network legs across 3 origins before the first byte of real data.
   90% of features hand-roll `useState`+`useEffect` fetching while TanStack Query sits installed.
3. **Search is unindexed `ILIKE '%…%'`** — zero trgm/FTS indexes in 81 migrations, synonym expansion
   multiplying scan legs, one full aggregate scan *per facet* per request. A Typesense 27.1 container runs
   in prod compose **with zero consumers** (orphan; `TYPESENSE_*` env is read by nothing).
4. **Zero server-side read caching.** Redis serves only queues/rate-limits. The home dashboard runs 9
   serial live aggregates per view and computes its ETag *after* doing all the work. The caching mandate
   (`truepoint-platform/references/caching.md`) is entirely unimplemented.
5. **The deploy pipeline is the slowest and most fragile tier.** Single-stage Dockerfile that busts the
   install layer on any edit, 4 serial `next build`s on the prod host, no typecheck gate before deploy,
   hard-downtime `up -d` recreates, no CDN, mutable image tags, a committed Redis dump and a git-tracked
   dev signing key.

Everything below is verified with file:line evidence and ranked. The async/workers tier is architecturally
**ahead** of the request tier — most fixes concentrate on the request path, the data layer, and the pipeline.

---

## 2. Verified mistake catalog

Severity: P0 = user-visible latency/correctness at today's scale · P1 = scales badly / mandate violation ·
P2 = debt. ✅ = adversarially verified against code.

### 2.1 Request path (`apps/api`)

| # | Sev | Where | Mistake | Fix |
|---|-----|-------|---------|-----|
| A1 | P0 ✅ | `apps/api/src/middleware/requireRole.ts:21` → `packages/db/src/repositories/workspaceRepository.ts:67` | Every guarded request runs an extra full `withTenantTx` (~5 RTTs) to read the caller's role; JWT claims carry `tid/wid/sid/scope/pa` but **no role** (`packages/auth/src/token.ts:47-52`). Home path stacks role-lookup + `buildJobViewer` + summary = 3 sequential tx groups. | Put `role` in access-token claims at mint/refresh; bust via the existing revocation path on membership change. Interim: 30–60 s LRU/Redis memo keyed `(sid,wid)`. |
| A2 | P0 ✅ | `packages/core/src/home/buildHomeSummary.ts:51-59` + `apps/api/src/features/home/routes.ts:68-80` | 9 awaits serialized in one tx (deliberate single-connection tradeoff, but still ~13 serial RTTs); **ETag checked after full compute** — 304 saves bytes, not work. | Single SQL round-trip (CTEs + `json_build_object`) or Redis 30–60 s read-through keyed `ws:{id}:home`; check `If-None-Match` against the cached hash **before** compute. |
| A3 | P0 ✅ | `apps/api/src/server.ts:10-13` | `Bun.serve` fully default: 128 MB body cap, 10 s idleTimeout (will kill SSE with its 15 s heartbeat), **no SIGTERM drain** — every deploy drops in-flight requests; `closeDb()` never called in api. | `{ maxRequestBodySize: 2_000_000, idleTimeout: 65 }` + SIGTERM handler that stops accepting, drains, then `closeDb()`. Same for `apps/forge-api/src/server.ts:107`. |
| A4 | P0 ✅ | `apps/api/src/features/import/routes.ts` + `features/import/queue.ts:14` | CSV/XLSX parsed synchronously on the API event loop; job payload **is** the parsed rows through Redis. v2 (object store + COPY staging) exists but dark behind `IMPORT_V2_ENABLED`/`BULK_IMPORT_ENABLED` (both default-off, `packages/config/src/env.ts:314,376`). Byte caps + 10 k queue shed bound the blast radius but don't fix the design. | Flip v2 on; payloads carry file refs only; parse in workers. |
| A5 | P1 ✅ | `apps/api/src/app.ts:110` + `middleware/rateLimit.ts:19-20` | Root `/api/*` rate limit runs pre-authn keyed by spoofable `x-forwarded-for` (per-subject re-mounts exist post-authn at router level — deliberate, but root key needs trust-proxy resolution). +2 serial Redis RTTs per request (rl + revocation). | Trust-proxy IP resolution; pipeline the two Redis calls; optional 5 s in-process negative cache on `isRevoked`. |
| A6 | P1 ✅ | `apps/api/src/app.ts:84` | Hono `compress()` on every response in the single-threaded Bun process; Caddy already does `encode zstd gzip` (it skips re-encoding, so this is **wasted Bun CPU**, not double work). hono 4.6.13 has no `threshold` option. | Delete app-level compress; let Caddy/edge encode. |
| A7 | P1 | `apps/api/src/features/events/routes.ts:21,37` | SSE: dedicated IORedis client **per connection** + 15 s heartbeat > Bun 10 s idleTimeout. | One shared psubscribe client per process, in-process fanout; heartbeat 8 s; per-user conn caps. |
| A8 | P1 | `apps/api/src/middleware/error.ts:15-23` + `app.ts:104` | 500s log nothing; no request-ID, no access log, no traces, no RED metrics (`/metrics` = auth counters only). Violates observability mandate (SKILL.md:129-131). Prod 500s undiagnosable. | Request-ID middleware + error logging in `onError` + latency histograms; OTel (hono + drizzle both have integrations after upgrade). |
| A9 | P2 | `apps/api/src/app.ts:98` | `/health` static `{status:"ok"}` — no DB/Redis readiness; compose marks API healthy with dead deps (workers do it right). | Real `/ready` probing pool + Redis. |
| A10 | P2 | `middleware/idempotency.ts:22-44` | Idempotency = 2 Postgres RTTs + `res.clone().json()` re-parse per write. | Redis + 24 h TTL; keep PG only for money paths if required. |
| A11 | P2 | `app.ts:190-193` | Public `/api/v1/pricing` hits DB per anonymous request; no `Cache-Control`. | `Cache-Control: public, s-maxage=3600` + edge cache; catalog changes ~never. |
| A12 | P2 | `features/reveal/routes.ts:86-91` | Masked contact list capped-limit with **no cursor** — violates cursor-pagination contract (SKILL.md:116-118). | Keyset cursor like `searchRepository.ts:319`. |
| A13 | P2 | `features/reveal/bulkRevealQueue.ts:18`, `features/import/queue.ts:22`, forge-api | Each producer module opens its own `new IORedis` (~6 clients in api process; packages/auth pins a *different* ioredis 5.4.1). | One shared producer connection; unify ioredis version. |

### 2.2 Frontend (`apps/web`, `admin`, `auth`, `packages/ui`)

| # | Sev | Where | Mistake | Fix |
|---|-----|-------|---------|-----|
| F1 | P0 ✅ | `apps/web/src/components/shell/AppShell.tsx:81,116` + `lib/authClient.ts:9` + **no `middleware.ts`** | Client-only `useEffect` auth gate; access token in JS memory (ADR-0016). Cold boot: empty HTML → JS → hydrate → cross-origin `POST auth.*/token/refresh` (itself ~4 Neon RTTs + rotation WRITE) → preflight → first data. RSC can never fetch. Every org/workspace switch = `window.location.reload()`. | §3.1 same-origin BFF + `__Host-` cookie + server middleware gate. This is the single unlock for SSR/RSC/streaming/PPR. |
| F2 | P0 ✅ | ~90% of features, e.g. `features/prospect/hooks/useProspectSearch.ts:40-83`, `useHomeSummary.ts:54-57`, `useListMembers.ts:26-29` | Server state hand-rolled in `useState`+`useEffect`; TanStack Query used only by `import/` + `data-health/`. Violates architecture SKILL "State and Data" mandate ("anything answerable by a GET lives in a TanStack Query hook — never useState"). No cache, no dedup, window-CustomEvent invalidation bus, 5 bespoke pollers. | Sweep to RQ v5: `useInfiniteQuery` for keyset load-more, `refetchInterval` for pollers, `invalidateQueries` replacing the event bus. |
| F3 | P0 ✅ | `packages/ui/src/components/DataTable.tsx:3,105-118` | Renders **all** accumulated rows; client sort re-sorts the accumulation per header click; `@tanstack/react-virtual` absent from lockfile. Violates design skill hard rule ("no un-virtualized large lists"). | Virtualize inside DataTable once — fixes every large surface. |
| F4 | P0 ✅ | `features/prospect/components/ProspectPage.tsx:86-103` | Contacts **and** accounts search+facet hooks all fire unconditionally — 4 dead POSTs (search + facets for the inactive scope) on every visit to the app's primary surface. | Gate inactive scope (`enabled:` once on RQ). |
| F5 | P0 ✅ | `useProspectSearch.ts:57-83`, `useAccountSearch.ts:96-122`, `useContactSearch.ts:20-47` | No AbortController/request keying — overlapping searches resolve out of order, **last-to-resolve wins** (stale results displayed); abandoned keystrokes still cost the backend. | Abort-previous or RQ keyed queries. |
| F6 | P1 | `AppShell.tsx:91`, `WorkspaceSwitcher.tsx:34`, `useSessionIdentity.ts:24` | `GET /auth/session` fetched independently per component — 2–4 duplicate calls per page; ~9 uncached shell-mount requests total. | One `useSession()` RQ hook `staleTime: Infinity` + a `/shell/bootstrap` aggregate. |
| F7 | P1 | `apps/admin/src/components/shell/AdminShell.tsx:43-60` | Two-stage gate **serial** (refresh → staff probe) holding console blank — worse than web's fixed pattern. | Render chrome after stage 1; verify staff in background. |
| F8 | P1 | `app/(public)/pricing/page.tsx` | The one public page client-fetches its catalog: zero `revalidate`/ISR anywhere in repo; empty shell for SEO/LCP. | Server fetch + `export const revalidate = 3600`. |
| F9 | P1 | all 4 apps | Zero `loading.tsx`, zero `error.tsx`, zero `<Suspense>`, zero streaming; `force-dynamic` used to dodge a `useSearchParams` bailout. | Route-group `loading/error.tsx`; Suspense boundary instead of `force-dynamic`. |
| F10 | P1 | `apps/{web,admin,forge}/src/lib/authClient.ts` (204/140/129 lines) ×3 `pkce.ts` | Security-critical token client triplicated and already drifted (forge lacks the `refreshInFlight` dedup). | Extract `@leadwolf/auth-client`. |
| F11 | P1 | `apps/web/next.config.mjs:9-27` | No `output:"standalone"`, no `headers()`; rewrites proxy `/api` through the Next server in single-origin deployments (serializing through one Node proxy). | Standalone output; direct API base in prod. |
| F12 | P1 | `features/reports/api.ts:31-53` | "Analytics" = fetch 200 raw rows to the browser, roll up client-side — silently wrong past 200. | Server-side aggregate endpoint (naive SQL rollup now; warehouse later per ADR-0010). |
| F13 | P2 | versions | next pinned 15.1.2 (Dec 2024) — pre-15.2.3 ⇒ **CVE-2025-29927** middleware-bypass class; react 19.0.0. | Upgrade train: latest 15.x now, 16 next. |
| F14 | P2 | `app/layout.tsx:9` + `globals.css:4` | tokens.css imported twice (JS + CSS `@import`). | Import once. |
| F15 | P2 | grep | Zero `next/dynamic` in apps/web — 694-line RecordDetail, editors, drawers all statically in route chunks (only `xlsx` done right). | Dynamic-import heavy conditional payloads. |
| F16 | P2 | `app/providers.tsx:13` | Default QueryClient: `staleTime: 0` + focus refetch = refetch storms for the features that DO use RQ. | `staleTime: 30_000, retry: 1` defaults. |

### 2.3 Data layer (`packages/db`, `packages/search`)

| # | Sev | Where | Mistake | Fix |
|---|-----|-------|---------|-----|
| D1 | P0 ✅ | `searchRepository.ts:97-114,223-235`, `accountSearchRepository.ts:62-65` · `packages/search/src/index.ts:6` · `searchPortProvider.ts:46` | Prod search = 6-leg `ILIKE '%…%'` ORs incl. unindexed concat expression + synonym-expanded title legs; **zero trgm/tsvector in 81 migrations**; only `createInMemorySearchPort` exists — OpenSearch/Typesense adapters are vapor (ADR-0035 "later"). **Typesense 27.1 runs in prod compose with zero consumers.** | Now: `pg_trgm` GIN on contacts(job_title, email_domain, generated full_name), accounts(name, domain) + generated `tsvector` + `websearch_to_tsquery` ranking. Next: Typesense adapter behind the existing `SearchPort` seam fed by the already-built outbox projector. Until then: stop the orphan container. |
| D2 | P0 ✅ | `schema/contacts.ts:226-299` | **No `(workspace_id, created_at DESC, id DESC)` index on contacts** — the default sort of every search/list page does top-N heapsort over the whole RLS-visible slice. Accounts has the equivalent; contacts was missed. Score sort's `coalesce(priority_score,-1)` expression matches no index either. | Partial index `(workspace_id, created_at DESC, id DESC) WHERE deleted_at IS NULL` + coalesce-expression index, `CREATE INDEX CONCURRENTLY`. |
| D3 | P1 ✅ | `packages/db/src/client.ts:91-104` | `withTenantTx` = BEGIN + `SET LOCAL ROLE` + `SELECT set_config(...)` + query + COMMIT ≈ 5 RTTs; the comment claiming SET ROLE can't merge is wrong — `role` is a GUC: one `SELECT set_config('role',…,true), set_config('app.current_tenant_id',…), set_config('app.current_workspace_id',…)` = 1 RTT. | Single-statement context bootstrap (−1 RTT × every scoped tx fleet-wide). |
| D4 | P1 ✅ | `rls/*.sql` (43 files, e.g. `contacts.sql:32`, `billing.sql:70-79`) | Policies use bare `NULLIF(current_setting(...))::uuid` — **no `(SELECT …)` initplan wrap** repo-wide; on seq scans/hash joins/aggregates (facets, counts) the GUC+cast re-evaluates per row (classic ~100× RLS trap). | Mechanical rewrite to `= (SELECT NULLIF(current_setting(...),'')::uuid)`; the idempotent re-apply phase redeploys free. Add the tenant leg to workspace policies while touching them (defense-in-depth per tenancy.md). |
| D5 | P1 ✅ | `client.ts:13,130-163` | Pool hardcoded `max: 10`, no env knob; **runtime pool logs in as the DB owner** (RLS-bypassing) — `withPlatformTx` structurally requires it, so any `db.*` call outside `withTenantTx` silently bypasses RLS; unauthenticated public pricing reads served from the owner pool. `prepare: false` unconditional. | Two pools: `leadwolf_app` LOGIN pool for tenant paths (defense in depth), tiny owner pool for audited platform paths; `DB_POOL_MAX` env; gate `prepare` on a `DB_POOLED` flag. |
| D6 | P1 | `searchRepository.ts:397-459`, `accountSearchRepository.ts:264-346` | One full GROUP-BY aggregate scan **per facet, sequentially, per request** (8 facets = 8 re-executions of the whole WHERE); exact uncapped `COUNT(*)` for select-all. | Single-pass `GROUPING SETS`; Redis 30 s facet cache; estimated counts past threshold; long-term facets from the search engine. |
| D7 | P1 | `activityRepository.ts:103-107` | Home reads every workspace activity — only index has `contact_id` in the middle, killing the `(workspace, occurred_at)` range. | `(workspace_id, occurred_at DESC)` index. |
| D8 | P1 | migrations | Zero partitioning on unbounded append tables (activities, email_events, platform_audit_log, provider_calls, source_imports, credit_ledger). | pg_partman monthly range partitions before 10⁸ rows; partition key already in hot predicates. |
| D9 | P2 | `contactRepository.ts:702,728,1085` | Bare `.select()` pulls AES-GCM ciphertext bytea + jsonb blobs for **masked** list surfaces (wide-row I/O + TOAST, discarded). The correct masked projection exists in the same package (`searchRepository.ts:249-280`). | Column projections. |
| D10 | P2 | `listRepository.ts:220-235,295-301` | Sidebar counts every membership row per render; member pages sort `(added_at,id)` unindexed; `listLists` N+1 (saved-search fetch + filtered COUNT per dynamic list, serially in one held tx — `packages/core/src/prospect/lists.ts:187-203`). | `member_count` counter column; `(list_id, added_at DESC, id DESC)` + `(contact_id)` indexes; batch the dynamic-list counts. |
| D11 | P2 | `rls/activity.sql:14-24` | Per-row AFTER-INSERT trigger UPDATEs contacts on every activity insert — write amplification + hot-row locks under bulk ingest. | Statement-level trigger with transition tables, or batch in ingest worker. |
| D12 | P2 | `packages/db/drizzle.worktree.config.ts` (untracked) + `meta/_journal.json` | Config points at a stale worktree schema (generates wrong migrations if ever used); duplicate `0053_*` prefixes journaled; only ONE migration ever used `CONCURRENTLY`. | Delete the worktree config; CONCURRENTLY for all hot-table indexes; consider squashing pre-0060. |
| D13 | P2 | `workspaceRepository.ts:419` | Lone `.offset()` pagination (platform-admin) — keyset everywhere else. | Opportunistic keyset. |

### 2.4 Auth topology, deploy, monorepo

| # | Sev | Where | Mistake | Fix |
|---|-----|-------|---------|-----|
| I1 | P0 ✅ | `Dockerfile:12,17-18` | Single-stage; `COPY . .` **before** `bun install` — any edit re-installs everything; 4 Next apps built serially on the prod host bypassing Turbo (workaround for a cycle that no longer exists); image ships full source + devDeps; no standalone output. | Multi-stage: manifests → `bun install --frozen-lockfile` → source → `turbo run build` → per-app runtime stages on standalone output. Build in CI, push to registry; deploy = pull. |
| I2 | P0 ✅ | `deploy/deploy.sh:76-127` + CI | No typecheck/lint/test gate before prod build (only env sanity + lockfile-sync); CI never runs `next build`; `up -d` recreate = hard downtime cushioned only by Caddy's 5 s dial-retry — SSE/WebSocket all drop per deploy. | CI gate `turbo run typecheck build` + tests; 2 replicas start-first rolling update (smallest step: Swarm mode on the same host) or blue-green Caddy upstreams. |
| I3 | P1 ✅ | `start.sh:20-36` (git-tracked) + `dump.rdb` (git-tracked since 54c937a) | Inline base64 Ed25519 **private key** (comment claims "gitignored" — false) + bootstrap admin password in VCS; Redis dump committed at repo root. | Rotate the dev key, generate on first boot to a gitignored path; delete dump.rdb (+ history scrub if it ever held real data). |
| I4 | P1 | `deploy/Caddyfile` | No CDN — every global user hits one EC2 for `_next/static`; no security/cache `header` directives; HTTP/3 on (good) but doesn't fix distance. | Cloudflare/CloudFront in front: immutable edge cache for `_next/static/*`, edge Brotli/zstd, WAF; `trusted_proxies` update; HSTS/CSP at edge (web/admin currently ship **zero** security headers — and the token lives in JS memory). |
| I5 | P1 ✅ | `app.ts:69`, `apps/auth/src/lib/cors.ts:8` | Preflight per distinct URL (Authorization ⇒ non-simple) with `Access-Control-Max-Age: 600` — cursor-paginated URLs re-preflight every page. Whole CORS surface exists only because api.* is a separate origin. | Interim: max-age 7200. Real fix: same-origin `/api` proxy (§3.1) deletes all preflights. |
| I6 | P1 | `apps/auth` refresh path + `authClient.ts:46-47` | Every refresh (per tab, ~14 min) = full rotation: DB revoke+insert + Redis write; N tabs = N racing rotation chains saved only by the 30 s reuse-grace. | BroadcastChannel-elected single refresher; or sliding-window rotation (once per X min). |
| I7 | P1 | `docker-compose.prod.yml:42-46` + env template | **MailHog in prod compose**, `SMTP_URL=` empty default — the documented AUTH-061 silent-mail failure. | Remove from prod; SMTP_URL required in prod env schema. |
| I8 | P1 ✅ | `turbo.json:5` + `start.sh:10-46` + CI | `globalDependencies: [".env"]` while start.sh rewrites `.env` per boot = 100% turbo cache invalidation; no remote cache; `typecheck: dependsOn ^build` but no package has a build script (dead config); tsconfig has no `incremental`/project refs — quadratic typecheck growth. | Drop `.env` from globalDependencies (use `globalEnv` keys); remote cache; `tsc -b` project references or at least `incremental: true` with turbo-cached .tsbuildinfo. |
| I9 | P1 | `features/home/api.ts:19-33` (pattern ×15 files) | Hand-rolled fetch + blind `as` casts; shared Zod contract enforced server-side only; no typed client. | Hono RPC (`hc<AppType>`) after hono upgrade, or zod-openapi-generated client; parse-at-boundary in dev. |
| I10 | P2 | `docker-compose.prod.yml:213,77-95` | `caddy:2`/`redis:7`/`mailhog:latest` mutable tags; ~11 containers on one host, one Bun process per service, only api/auth get 0.25-CPU soft reservations. | Pin digests; per-service CPU limits; `reusePort: true` + N processes while single-host. |
| I11 | P2 | `packages/types/src/index.ts` | 74-line `export *` Zod barrel pulled into web bundle graph. | Subpath exports (`@leadwolf/types/contacts`). |

---

## 3. Target architecture (the fastest coherent version of this system)

### 3.1 Topology: one origin, edge-first

```
Browser ──► Cloudflare (CDN: _next/static immutable, edge zstd/HTTP3, WAF)
              │
              ▼
            Caddy (one origin: app.truepoint.in)
              ├── /api/*   ──► apps/api   (Hono, Bun)      ← same-origin: CORS+preflights deleted
              ├── /auth/*  ──► apps/auth  (IdP, Next)      ← cookie becomes __Host- on app origin
              └── /*       ──► apps/web   (Next standalone)
            admin.truepoint.in → same pattern.
```

- Keep the PKCE + rotating-refresh IdP core (it is good). Amend **ADR-0016**: the refresh session moves to
  an `__Host-` httpOnly cookie on the app origin; the browser-held bearer token disappears. `middleware.ts`
  gates server-side — the boot screen and the 4-leg cold-start waterfall cease to exist.
- CSRF becomes a requirement the moment cookie auth lands: `SameSite=Lax` + Origin-check middleware on
  mutating routes (Hono `csrf()`), double-submit only if embedding needs arise. Security skill sign-off gate.
- Role claim added to the access token; requireRole becomes claim-read (A1).
- Cross-tab: BroadcastChannel single-refresher (I6).

**Cold boot after:** 1 document request (HTML already contains first-paint data via RSC over the docker
network) + parallel static assets. From ≥6 serial cross-origin legs to effectively 1–2.

### 3.2 Frontend: RSC-first, client-warm

- Route `page.tsx` = server component; `prefetchQuery` the primary read server-side (api reachable
  same-origin over the internal network), wrap existing client features in `<HydrationBoundary>` — client
  hooks stay, they just start warm.
- Finish the RQ sweep (F2): `useInfiniteQuery` keyset load-more, `refetchInterval` pollers, SSE →
  `invalidateQueries`, kill the window-event bus and `location.reload()` on switch.
- `loading.tsx`/`error.tsx` per route group; Suspense boundary replaces `force-dynamic`; then **PPR**
  (Next 16) — static shell chrome served from edge, data streams in.
- **React Compiler** once on latest Next (codebase is 100% function components with heavy manual memo —
  ideal candidate).
- Virtualized `DataTable` via `@tanstack/react-virtual` (F3) — one component fixes every big surface.
- `output: "standalone"` + `optimizePackageImports: ["@leadwolf/ui"]` + `next/dynamic` for drawers/editors.
- `@leadwolf/auth-client` package replaces the 3 drifted copies (F10).

### 3.3 API: claims-fast, cache-deliberate

- Per-request budget after fixes: JWKS-cached local verify (already ✅) + 1 pipelined Redis hop
  (rl+revocation) + **1-RTT** tenant tx bootstrap (D3) + the actual query. No role tx (A1), no wasted gzip
  (A6). Floor drops from ~10–25 ms to ~2–5 ms.
- **Redis read-through tier** (the missing caching.md layer): tenant-scoped keys
  (`t:{tid}:ws:{wid}:home`, facets, credit balance, pricing), short TTL + explicit invalidation keyed to
  mutations, single-flight on hot keys. ETag checked **before** compute.
- Hono ≥4.9: `bodyLimit` per route, RPC types for the frontends; Zod 4 in `@leadwolf/types`
  (7–15× parse speedup on every request); drizzle 0.44+; jose 6; one ioredis version.
- Observability floor: request-ID, structured error logs, RED metrics, OTel traces api→workers→db.
- Bun.serve hardening + SIGTERM drain + real `/ready` (A3, A9).

### 3.4 Data: index-true, engine-backed search

- **Phase-now (pure SQL, no new infra):** contacts keyset + score indexes (D2), activities `(ws, occurred_at)`
  (D7), pg_trgm GIN + generated tsvector columns (D1), initplan-wrapped RLS everywhere (D4), masked-column
  projections (D9), list counter columns (D10). All `CONCURRENTLY`.
- **Engine:** Typesense adapter implementing the existing `SearchPort`, fed by the already-built
  outbox→projector pattern (never dual-write from request paths); facets/typo-tolerance/instant counts move
  off Postgres. The container is already deployed — give it consumers or stop it.
- **Pools:** `leadwolf_app` LOGIN pool for tenant traffic; small owner pool for audited platform paths;
  `DB_POOL_MAX` env; read-replica routing once caching lands (data-platform.md mandate).
- **Aggregates:** snapshot tables refreshed by workers (data_quality_snapshots exists — wire it); reports
  rollups server-side (F12).
- **Partitioning:** pg_partman monthly on the append tables (D8) — gives retention real detach-archive mechanics.

### 3.5 Async: already good — unblock it

- Flip import v2 (A4): object store upload → COPY staging → chunked workers; payloads = refs.
- Atomic Redis Lua budget breaker → raise enrichment/bulk concurrency from 1 (the racy read-check-act is
  the only reason the whole platform's paid enrichment is serialized).
- SSE: shared subscriber, heartbeat 8 s (A7). Per-tenant queue fairness (sharded queues) so one tenant's
  import can't head-of-line-block every tenant.

### 3.6 Build & deploy: CI-built, zero-downtime, edge-cached

- CI: `turbo run typecheck build` + tests gate → multi-stage per-app images (standalone) → registry.
- Deploy: pull + start-first rolling replace (Swarm mode single-host is the smallest step), healthcheck-gated;
  Caddy dial-retry becomes backstop, not the strategy.
- Turbo remote cache; `.env` out of globalDependencies; TS project refs.
- Hygiene: pin image digests; remove MailHog from prod; rotate + ungit the dev signing key; delete dump.rdb
  and the drizzle worktree config; Next ≥15.2.3 (CVE-2025-29927) then 16.

---

## 4. Expected effect (cold boot, logged-in user)

| Leg | Today | Target |
|---|---|---|
| Document | 307 redirect + empty shell | HTML with first-paint data (RSC), PPR static shell from edge |
| Auth | serial cross-origin refresh (4 Neon RTTs + rotation write) before anything | cookie validated in middleware; no browser-visible auth leg |
| CORS | 2+ preflights, re-preflight per cursor page | none (same origin) |
| First data | after hydrate+refresh+preflight: rl+revocation+role-tx+2-RTT-bootstrap+query | in the document; subsequent calls ~2–5 ms server floor |
| Search | full-workspace ILIKE scan + 8 sequential facet scans | trgm/tsvector index scans → Typesense facets |
| Dashboard | 9 serial live aggregates per view | Redis read-through (30–60 s) + snapshot tables; ETag-first |
| Deploy | host-built, downtime window, cache-busted installs | CI image pull, start-first, layer-cached |

---

## 5. Phased roadmap

**Phase 0 — quick wins (days; no ADR changes).**
D2/D7 indexes · D3 1-RTT bootstrap · D4 RLS initplan sed · A1 role claim (or memo) · A2 ETag-first + Redis
memo · A3 server hardening · A6 drop compress · I5 max-age 7200 · F4 dead-scope gating · F5 abort ·
F6/F16 useSession + RQ defaults · F9 loading.tsx · I1 Dockerfile layer split · I2 CI typecheck gate ·
I3 key rotation + dump.rdb/worktree-config deletion · stop orphan Typesense.
*Exit: p50 API latency and /prospect + /home visibly faster; deploys stop re-installing.*

**Phase 1 — topology (about a week).** Caddy same-origin routing · `__Host-` cookie + middleware gate +
CSRF (ADR-0016 amendment, security sign-off) · kill reload-on-switch · `@leadwolf/auth-client` ·
BroadcastChannel refresher. *Exit: zero preflights; cold boot ≤2 serial legs; boot screen gone.*

**Phase 2 — caching + async + tables (1–2 weeks).** Redis read-through tier + invalidation · snapshot
aggregates · import v2 ON · Lua budget breaker + concurrency raise · SSE shared subscriber · virtualized
DataTable · RQ migration sweep · standalone builds + registry deploys + start-first. *Exit: dashboard ≤1
query amortized; imports off the event loop; zero-downtime deploys.*

**Phase 3 — search + RSC (2–4 weeks).** trgm/tsvector live, then Typesense adapter via outbox CDC ·
facets from engine · RSC prefetch + HydrationBoundary route-by-route · streaming · dynamic imports ·
pricing ISR. *Exit: search p95 index-served; primary routes render with data at TTFB.*

**Phase 4 — scale-out (ongoing).** Next 16 + PPR + React Compiler · CDN in front · read replica routing ·
pg_partman partitions · OTel end-to-end · split app-role/owner pools · reports off OLTP · enterprise
silo routing per tenancy.md.

---

## 6. Risks & decision points

- **ADR-0016 amendment (cookie/BFF)** — the highest-leverage change; touches auth, security posture (CSRF
  strategy needed), and all three frontends. Do not start Phase 3 RSC work before it lands.
- **RLS rewrite (D4)** — mechanical but repo-wide; verify with `EXPLAIN` on facet/count paths and the
  existing itest suite before/after.
- **Owner-pool split (D5)** — `withPlatformTx` structurally assumes owner; needs a deliberate two-pool
  design, not a find-replace.
- **Search engine adoption** — keep Postgres as source of truth; the outbox projector is the only sync
  path; never dual-write. Typesense per-workspace filtering must carry `workspace_id` in every query
  (security skill final say).
- **Concurrent-agent worktrees** — drizzle worktree config shows parallel-agent drift reaching prod
  config; keep migration generation on main only.

## 7. Strengths to preserve (do not "modernize" away)

UUIDv7 PKs · keyset cursors with full-precision timestamps · transaction-local GUC RLS (pooler-correct,
`prepare:false` under Neon pooling) · EdDSA + kid-rotation JWKS with internal-origin fetch + boot warmup ·
Redis-backed global rate limiting · workers tier: DLQs, deadlines, leader locks, backpressure, outbox +
`FOR UPDATE SKIP LOCKED` projectors · COPY-into-UNLOGGED-staging bulk import (v2) · masked projection
pattern in searchRepository · hand-rolled SVG charts (no chart-lib bloat) · dynamic-imported xlsx.
