# Architecture Modernization — Detailed Implementation Plan

> **Status:** active · **Date:** 2026-07-26 · **Supersedes nothing; implements**
> [`architecture-modernization-plan.md`](./architecture-modernization-plan.md) (the audit + target architecture).
> **Evidence base:** 4 tier audits + 1 adversarial verification pass (13/15 confirmed) + 4 reference sweeps
> (dependency graph, upgrade compatibility, extension/forge, verification & migration mechanics).
> **Scope:** all 21 workspaces — `apps/{api,web,admin,auth,workers,extension,forge,forge-api,forge-worker}`
> + `packages/{app-shell,auth,config,core,db,forge-capture-sdk,forge-core,identity,integrations,search,types,ui}`.
> **This document is the execution spine.** Work items carry IDs, hard dependencies, exact files, real
> verification commands, and a rollback. Check items off here as they land.

---

## 0. How to use this document

- Work items are `[ ]` / `[x]`. **Never start an item whose `needs:` list is unchecked** — the ordering is
  load-bearing, not stylistic.
- Every item states its own verification. "Green" for this project means, exactly:
  ```bash
  bun run typecheck        # tsc --noEmit × 21 workspaces
  bun run lint             # biome check .  (lint + format + import order in one pass)
  bun run lint:boundaries  # depcruise apps packages — 11 error-severity rules
  # unit tests, CI-faithful (one process per file — plain `bun test` is NOT equivalent):
  for f in $(find packages apps -name '*.test.ts' -o -name '*.test.tsx' | sort); do bun test "./$f"; done
  # integration tests, need Postgres 16 + Redis 7:
  export ITEST_DATABASE_URL=postgres://leadwolf:leadwolf@localhost:5432/leadwolf
  export ITEST_REDIS_URL=redis://localhost:6379
  for f in $(find packages apps -name '*.itest.ts' | sort); do bun test --timeout 120000 "./$f"; done
  ```
  Baseline arithmetic: **typecheck 21/21 · boundaries 0 violations · 192 unit files · 92 itest files ·
  82 journal entries · 42 RLS files · 14 DB flag keys (all off)**.
- SLO acceptance targets come from **ADR-0024**: masked search p95 200 ms / p99 500 ms · reveal 300/800 ·
  list-grid 150/400 · record detail 150/400 · import enqueue 100/300 · availability 99.9% · search-sync
  (CDC→index) p95 < 5 s.

---

## 1. Guardrails — the twelve rules that keep this from breaking prod

These are derived from how the repo actually works. **Violating one of these is how a modernization pass
produces an outage.** Every work item below is written to obey them.

| # | Rule | Why (evidence) |
|---|---|---|
| **G1** | **Migrations are HAND-WRITTEN `.sql` + a hand-appended `_journal.json` entry. Never run `drizzle-kit generate`.** Next file = `0081_*`, `idx: 82` (0080 landed). | Snapshots stop at `meta/0028_snapshot.json` while the journal has **81** entries. `generate` would diff against the 0028 state, emit ~51 migrations of duplicate DDL, **and silently drop hand-written seed INSERTs** (e.g. `0033_retention_engine.sql:31-42`). Max numeric prefix is `0079`; max `idx` is 80 — they differ because two files share the `0053` prefix (both journaled, both apply: identity is the journal order + file sha256, not the filename). |
| **G2** | **RLS changes ship by editing `packages/db/src/rls/*.sql` — no migration needed.** But never put `CREATE INDEX CONCURRENTLY` there, and never add a file that sorts before `contacts.sql` and needs `set_updated_at()`. | Phase 3 of `applyMigrations` re-applies **all 43** files, sorted by filename, on **every** migrate, idempotently (`applyMigrations.ts:288-293`). Each file is executed as **one whole-file `sql.unsafe()`** = one implicit transaction. `rls/masterGraph.sql:12-14` documents that it relies on `contacts.sql` having already defined `set_updated_at()` because `c` < `m`. |
| **G3** | **`CREATE INDEX CONCURRENTLY` is allowed in a migration** — but the statement must stand **alone** between `--> statement-breakpoint` markers, and the chunk must first raise `statement_timeout`. | `applyJournalByHash` runs statement-by-statement in **autocommit — there is no `BEGIN`** (`applyMigrations.ts:60-73`), and `sql.unsafe(q)` with no args uses the simple query protocol. But the migrator connection sets `statement_timeout: 120000` (2 min), which will kill a real index build, and a failed CONCURRENTLY leaves an **INVALID** index while `25001` is *not* in the tolerated-SQLSTATE list, so the run aborts. (An in-repo comment at `0061_…:188-191` claims the opposite — it is stale, from Drizzle's old migrator.) |
| **G4** | **Barrel-only imports.** Every new cross-package export must be added to that package's `src/index.ts`. `@leadwolf/types` and `@leadwolf/config` are locked leaves. `apps/extension` may not import `db`/`integrations`. `packages/core` may not import `integrations`. | 11 error-severity depcruise rules gate CI (`.dependency-cruiser.cjs`): `no-deep-import-from-app`, `no-deep-import-cross-package`, `types-is-a-leaf`, `config-imports-only-types`, `extension-stays-thin`, `forge-capture-sdk-stays-thin`, `core-must-not-import-integrations`, `apps-never-import-apps`, `no-cross-feature-import`, `no-circular`, `forge-core-must-not-import-integrations`. |
| **G5** | **Anything risky ships behind the established dual gate**: an env master-switch (`z.string().optional().transform(v => v === "true")`, default off) **AND** a per-tenant DB flag, with the env layer short-circuiting before any query. | Canonical shape: `apps/api/src/features/import/importV2Gate.ts:16-23`. 14 flag keys seeded, all off. Flag-off must be **byte- and cost-identical** to today. This is the *only* real rollback lever (see G6). |
| **G6** | **There is no rollback.** The image is tagged only `leadwolf:latest` (no registry, no digest), migrations are forward-only with no `down`, and all 9 services share one image — so you cannot ship code to one service alone. | `deploy/deploy.sh`; `grep -i rollback DEPLOY.md` → nothing. Plan every risky item with a flag, not a revert. |
| **G7** | **Fix `apps/workers`' `@leadwolf/db` dependency BEFORE touching the Dockerfile.** | `@leadwolf/db` is a **devDependency** of `apps/workers` but imported at runtime in ~25 modules (`register.ts:18`, `outboxRelay.ts`, `realtimeRelay.ts`, 20 `queues/*.ts`). It works only because the Dockerfile deliberately installs dev deps. Any multi-stage prune / `--production` / `NODE_ENV=production` at install time breaks worker boot with an unresolvable module under Bun's per-package `node_modules`. |
| **G8** | **Zod / Hono / Drizzle bumps are atomic across workspaces.** Zod: `types` + `config` + `integrations` + `forge-api` + `extension` in one change. Hono: `api` + `forge-api` together. | Bun gives each package its own `node_modules`; a split zod major means two zod instances and broken cross-package schema reuse. `apps/extension` pins its own `zod@3.23.8` and defines duplicate wire schemas. |
| **G9** | **Never change `DEFAULT_APP_ROLE_PASSWORD` alone.** `applyMigrations.ts:21` and the hardcoded literal in `packages/db/test/itestDb.ts:35` must match or every RLS itest fails on auth. |
| **G10** | **`noUnusedLocals` + source-consumed packages means an unused local in `packages/ui` fails the production Docker build.** `tsconfig.base.json` is also a turbo `globalDependency` — editing it busts all 21 typecheck caches. |
| **G11** | **Respect the worker env surface.** Under `LEADWOLF_SURFACE=worker`, `AUTH_ORIGIN`/`AUTH_COOKIE_DOMAIN`/`JWT_SIGNING_KID` are `.invalid` sentinels whose **runtime read throws** via a Proxy get-trap (`env.ts:742-844`). Any new env var read by workers must be added to the worker-required set, not the web-only set. |
| **G12** | **`withForgeTx` has no GUCs** — it only does `SET LOCAL ROLE leadwolf_forge` (`client.ts:70-75`). Any collapse of `withTenantTx`'s round-trips must not assume the GUC statement exists on every path. And the `forge` schema has **zero RLS files**, so an "RLS sweep" silently skips the schema holding raw scraped PII. |

---

## 2. Phase −1 — Prerequisites (nothing else starts until these are green)

- [x] **P-1.1 · `apps/workers`: promote `@leadwolf/db` devDependency → dependency.**
  `needs:` — · **files:** `apps/workers/package.json`, `bun.lock`
  **why:** G7. Blocks every Dockerfile/multi-stage item.
  **verify:** `bun install` then `node scripts/check-lockfile.mjs`; `bun run typecheck`; `bun run lint:boundaries`.
  **rollback:** revert the two lines.

- [x] **P-1.2 · Unify `ioredis` to one version.** Unpin `packages/auth` (`5.4.1` → `^5.4.1`) and
  `apps/auth` (`5.4.1` → `^5.4.1`).
  `needs:` — · **files:** `packages/auth/package.json`, `apps/auth/package.json`, `bun.lock`
  **why:** `bullmq@5.78.0` pins `ioredis: 5.10.1` exactly, so today there are **two** client copies —
  auth's rate limiter / session store / revocation deny-list run 5.4.1 while the queues run 5.10.1.
  Unpinning lets bullmq's exact pin dominate; one copy remains.
  **verify:** `grep -c '"ioredis"' bun.lock` shows a single hoisted entry; auth unit tests
  (`packages/auth/*.test.ts`, 18 files) pass per-file; `bun run typecheck`.
  **rollback:** re-pin; the nested copy returns.

- [x] **P-1.3 · Delete the poisoned drizzle worktree config.**
  `needs:` — · **files:** delete `packages/db/drizzle.worktree.config.ts` (untracked)
  **why:** it hard-codes absolute `schema`/`out` paths into a dead agent worktree
  (`.claude/worktrees/agent-a2f457b1e256c2504/…`); if ever passed via `--config` it reads a stale schema
  and writes the migration into someone else's tree.
  **verify:** `git status` clean of it; `bun run --filter @leadwolf/db generate --help` unaffected.

- [x] **P-1.4 · Add build gates to CI.** New job step: `bun run build` (turbo, 5 build scripts incl.
  `apps/extension`'s `vite build`).
  `needs:` P-1.1 · **files:** `.github/workflows/ci.yml`
  **why:** CI runs typecheck/lint/boundaries/tests but **never builds**, so `next build` breaks (classically
  `noUnusedLocals` in `packages/ui` source, per G10) land on main and first surface inside `deploy.sh`.
  The extension is never built anywhere, so a CRXJS/manifest break is invisible.
  **verify:** CI green on a branch; deliberately introduce an unused local in `packages/ui`, confirm the
  new job fails, revert.
  **rollback:** remove the step.

- [ ] **P-1.5 · Secret + artifact hygiene.**
  `needs:` — · **files:** `start.sh`, `.gitignore`, delete tracked `dump.rdb`
  - Rotate the dev Ed25519 signing key; generate on first boot into a gitignored path (the in-file comment
    claims "gitignored" but `git ls-files` shows `start.sh` **is** tracked, key inline at `:22`, bootstrap
    admin password at `:36`).
  - `git rm --cached dump.rdb` + gitignore (tracked since commit `54c937a`).
  **verify:** `git ls-files | grep -E 'dump.rdb'` empty; `bash start.sh` still boots and writes a key.
  **rollback:** n/a (do not restore secrets to VCS).

- [x] **P-1.6 · Fix `APP_ORIGINS` completeness.** Add the admin + forge origins to `.env.example` and
  `deploy/env.production.template` (today only `app.truepoint.in` is listed).
  `needs:` — · **why:** `appOrigins()` feeds CORS + the JWT **audience** check in
  `apps/api/src/middleware/authn.ts:22` and `apps/forge-api/src/middleware/auth.ts:20`; a fresh deploy
  breaks admin and forge sign-in.
  **verify:** `packages/config/src/env.ts` production `superRefine` asserts pass with the new template.

- [ ] **P-1.7 · Repair the drizzle snapshot chain (0029 → 0080) and CI-assert it.**
  `needs:` P-1.3 · **files:** `packages/db/src/migrations/meta/*`, `.github/workflows/ci.yml`,
  delete `packages/db/src/migrations/_MAIN_MERGE_TODO.md` when done
  **why:** 29 snapshots vs 82 journal entries. This is the gate on any Drizzle upgrade (a newer drizzle-kit
  on a broken chain makes `generate` unusable *and* hides the break). Correctness gate, from the TODO file
  itself: after stitching, `generate` must report **no further diff**.
  **also:** renumber one of the duplicate `0053_*` files (cosmetic; identity is journal order + sha256, so
  do it as a rename + journal `tag` edit only, never a content change).
  **verify:** `bun run --filter @leadwolf/db generate` → "No schema changes"; new CI assertion
  `snapshots == journal entries`; full itest sweep green (a renamed migration changes
  `migrationSetHash()` so CI builds a fresh template DB — expect one slow first run).
  **rollback:** restore `meta/` from git.

---

## 3. Phase 0 — Correctness P0s (real bugs; these are not performance work)

The audits surfaced defects that silently lose data or disable whole subsystems. They land before
optimization because optimizing a broken path is wasted work.

### 3.1 Extension (`apps/extension`)

- [x] **X-0.1 · Stop the capture path from acknowledging then deleting the record.**
  **files:** `apps/extension/src/background/bus/index.ts:64`, `.../queue/scheduler.ts:35-38`
  **defect:** the bus returns `outcome:"saved"` synchronously (hover card renders "Saved"), while
  `CHROME_EXTENSION_ENABLED` is unset in prod → `getConnector` undefined → `/ingest` 400 →
  `classify()="validation"` → `handleError` **removes** the queue item. Silent data loss plus a lying UI.
  **fix:** bus returns `queued`, not `saved`; treat `no connector` / missing-workspace 400s as
  **park**, not drop; a `202` ack is not "landed".
  **verify:** unit test asserting a 400-with-`no connector` leaves the item in IDB; `bun test ./apps/extension/...`.

- [x] **X-0.2 · Add the two missing endpoints to the extension scope allow-list.**
  **files:** `apps/api/src/middleware/extensionScope.ts:43-51`
  **defect:** `GET /api/v1/contacts/by-linkedin/:publicId` (called from `background/api/client.ts:174`) and
  `GET /api/v1/events/stream` (`background/eventStream.ts:22`) are absent —
  `rule("GET","/api/v1/contacts/:id")` compiles to `^/api/v1/contacts/[^/]+/?$`, which cannot match two
  segments. Observe-only today; flipping `EXTENSION_SCOPE_ENFORCE=true` 403s the hover card on every profile.
  **fix:** add both rules **plus** a test asserting every path in `api/client.ts` is allow-listed.
  **verify:** new unit test; then `EXTENSION_SCOPE_ENFORCE=true` locally against the hover-card flow.

- [x] **X-0.3 · Reap `inflight` queue items.**
  **files:** `apps/extension/src/background/queue/captureQueue.ts:49-55`, `scheduler.ts:20`
  **defect:** `markInflight` runs *before* the network call and `due()` returns only `status==="pending"`,
  so an SW killed mid-drain — the premise of the whole MV3 design — leaves the item `inflight` forever.
  **fix:** reap `inflight` older than N seconds back to `pending` on drain (idempotency key makes the retry
  safe), or drop `markInflight` entirely.

- [x] **X-0.4 · Least-privilege manifest.** Remove unused `scripting` + `activeTab`; drop the dead
  `optional_host_permissions` (`https://*/*`, `http://*/*` — nothing ever calls
  `chrome.permissions.request`, and `http://` invites plaintext capture).
  **files:** `apps/extension/manifest.config.ts:30,36`
  **why:** violates `truepoint-extension-architecture` rule 3 and is a top Web-Store rejection reason.

- [ ] **X-0.5 · Stop the ~1440 refresh-token rotations/day/install.**
  **files:** `apps/extension/src/background/index.ts:109-117`, `.../auth/index.ts:52-56`,
  `.../events/manager.ts:29-33`
  **defect:** `auth.init()` refreshes unconditionally on every SW wake and refresh **rotates**; the worker
  dies ~30 s idle and the 1-min drain alarm wakes it. Load on `apps/auth` scales with installs, not usage.
  **fix:** lazy refresh only (`ApiClient.getAccessToken` already drives it on demand); delete the eager
  `init` refresh and the duplicate `onWake` path.

- [x] **X-0.6 · Alarm re-creation resets the flush countdown.** `register()` runs at top level, so the
  1-min drain wake re-creates the 5-min `flush` alarm and **`flush` never fires** — the IDB telemetry store
  never trims. **files:** `apps/extension/src/background/events/manager.ts:25-26` · **fix:**
  `chrome.alarms.get` before create, or create only in `onInstalled`/`onStartup`.

- [x] **X-0.7 · Build hygiene.** `sourcemap: mode === "development"` (today `true` unconditionally ships
  full unminified source, including the token/handoff logic, in the store ZIP); add a `zip`/package script.
  **files:** `apps/extension/vite.config.ts:14` · **needs:** P-1.4 (so CI builds it at all).

- [ ] **X-0.8 · Environment override that actually exists.** `shared/env.ts:5-9` hard-codes prod origins and
  its comment points at a Vite `define` that `vite.config.ts` does not have — so `bun run dev` points the SW
  at **production** and reveals spend real credits. Add the `define` per mode; make `host_permissions` follow.

- [ ] **X-0.9 · Either implement signed remote config or remove the flag surface.**
  `background/config/remoteConfig.ts:26-28` only ever reads `chrome.storage.local`; nothing fetches or
  verifies remote config, so the documented kill switch (architecture rule 6) **does not exist**. Shipping a
  store artifact with no incident control is the risk; a flag surface that looks like control but isn't is worse.

### 3.2 Forge (`apps/forge-api`, `apps/forge-worker`, `packages/forge-core`)

- [ ] **F-0.1 · Derive sizes server-side; never trust client-declared bytes.**
  **files:** `apps/forge-api/src/features/captures/routes.ts:57,60,70`, `packages/types/src/forge.ts:44,72`
  **defect:** `envelope.size` / `record.byteSize` are plain `z.number()` and are what the 20 MB envelope
  413, the 5 MB per-record 413, the 64 MB/min byte throttle, **and** the object-store offload threshold all
  read. `size:1` with a 100 MB body defeats every one; `byteSize:0` lands a 5 MB payload inline into JSONB.
  The codebase already knows the pattern — `contentHash` **is** re-derived server-side
  (`forge-core/src/ingest.ts:129`).
  **fix:** compute `Buffer.byteLength` per record and sum; treat client values as advisory only.
  **verify:** new unit tests for each cap with a lying `size`.

- [x] **F-0.2 · Fix the model/params mismatch that has the AI extract stage 100% dead in prod.**
  **files:** `packages/integrations/src/forgeAnthropicExtraction.ts:132`, `packages/config/src/forge.ts:55`
  **defect:** `thinking:{type:"adaptive"}` is sent to the default model `claude-haiku-4-5-20251001`, which
  does not support adaptive thinking → **400** → `res.status>=400` collapses to `unavailable(false)` at
  `:157`, surfacing no error. (The sibling `anthropic/nlSearchAdapter.ts:172` also uses adaptive but defaults
  to `claude-opus-4-8`, which supports it — that one is fine.)
  **fix:** for Haiku 4.5 either drop `thinking` or use `{type:"enabled",budget_tokens:N}`; or move the
  default to `claude-sonnet-5`/`claude-opus-5` and control depth via effort. Note `max_tokens:1024` cannot
  coexist with a ≥1024 `budget_tokens`. **Add a config-load assertion that validates model ↔ params.**
  **verify:** unit test per (model, params) pair; one live capture reaching `verified_records`.

- [x] **F-0.3 · Stop discarding `extraction.outcome`.**
  **files:** `apps/forge-worker/src/processors.ts:140-172`
  **defect:** `ai_unavailable` / `refused` / `truncated` are all ignored, `forge-resolve` is enqueued
  unconditionally and the job **completes**, so BullMQ never retries; verify then yields `confidence: 0`
  and `approvePromotion` blocks below 0.8 — so every capture silently becomes a permanently unpromotable
  review task. Compounds F-0.2 exactly.
  **fix:** throw on retryable outcomes; quarantine terminal ones; enqueue resolve only on `ok`/`repaired`.

- [x] **F-0.4 · Reject extension-audience tokens on forge staff routes.**
  **files:** `apps/forge-api/src/middleware/auth.ts:20,42-53`
  **defect:** `verifyAccessToken(token, [...appOrigins()])` and `appOrigins()` unions `EXTENSION_ORIGINS`,
  while `resolveStaff` applies **no scope check** — and `apps/api`'s extension-scope confinement is
  apps/api middleware, which does not run here. An extension token can therefore drive the whole forge BFF
  **and** the `review/approve` promotion path.
  **fix:** reject `scope ∋ extension` in `resolveStaff`; verify staff routes against `APP_ORIGINS` only.
  **verify:** new test minting an extension-audience token and asserting 403 on `/v1/review/approve`.

- [x] **F-0.5 · Scope the tolerated `23505`.**
  **files:** `packages/db/src/applyMigrations.ts:26-33,67-70`
  **defect:** `unique_violation` is tolerated on **every statement of every migration**, so a genuine
  integrity conflict during a backfill is swallowed, the migration is marked applied, and the database is
  left half-migrated with no error.
  **fix:** honour it only for opted-in statements (`-- @tolerate-duplicate`) or seed-only files.
  **verify:** itest that a real unique conflict now aborts the run; full itest sweep unchanged otherwise.
  **shipped — simpler than planned, and the audit is why.** No opt-in marker was added, because nothing
  needs one: every INSERT across all 16 seed-bearing migrations is already `ON CONFLICT`-guarded (verified
  mechanically — no migration file has more `INSERT INTO` occurrences than `ON CONFLICT` clauses), so a
  replayed seed raises nothing at all and `23505` was pure downside. It is simply **removed** from
  `ALREADY_EXISTS`; the remaining five codes are all DDL "object already exists", where skipping the
  statement leaves exactly the state the statement intended — that property is what makes tolerance safe,
  and a data error never has it. Adding a `-- @tolerate-duplicate` mechanism no caller needs would have
  been speculative machinery; `ON CONFLICT` in the SQL is the correct idempotency expression and it is
  visible where a reviewer reads it. The policy is now `isTolerableMigrationError()`, exported and pinned
  by `packages/db/src/migrationTolerance.test.ts` (4 tests) so re-widening it has to be deliberate. A
  dedicated itest was **not** added: the tolerance is a pure predicate, and the CI itest template DB is
  built by `applyMigrations`, so all 92 itests already exercise the changed path on every run.

- [ ] **F-0.6 · Bound Forge LLM spend and record it.**
  **files:** `packages/forge-core/src/extraction.ts:204,283-303`
  **defect:** `budgetKey = ${ctx.jobId}:${ctx.tenantId}` where `jobId` is the `rawCaptureId` — so every
  capture gets a fresh 1000-unit budget and burns 1, making `AI_BUDGET_LIMIT` decorative on a metered,
  attacker-triggerable path; the in-process `Map` never evicts (one leaked entry per capture); returned
  `inputTokens`/`outputTokens` are dropped so `extraction_runs` records no consumption; and the repair pass
  bills 2 calls against 1 reserved unit.
  **fix:** key on `tenantId` + time window in Redis (`INCR` + TTL, mirroring `forgeRateLimiter`); persist
  token counts; reserve 2 and refund 1.

- [ ] **F-0.7 · Adopt `@anthropic-ai/sdk` for the extraction adapter** (or at minimum add
  `AbortSignal.timeout`, 429/5xx-vs-4xx branching, `retry-after`, and error-body logging).
  **files:** `packages/integrations/src/forgeAnthropicExtraction.ts:27-31,157` · **needs:** F-0.2
  **why:** the hand-rolled `fetch` has no timeout/abort (so `withDeadline`'s 60 s rejection leaves the
  socket open and still billing), collapses every ≥400 to `ai_unavailable`, and discards the error body —
  which is precisely why F-0.2 shipped undiagnosed. No Anthropic SDK is a dependency of any workspace today.

- [x] **F-0.8 · Make the injection sanitizer readable again.** A literal NUL byte in the control-char class
  makes the file **binary** to `grep` and invisible to `git grep -I`, so a security-relevant sanitizer cannot
  be reviewed in a diff. **files:** `packages/forge-core/src/extraction.ts:70` · **fix:** write as escapes
  (`/[\u0000-\u001f]/g`).

  **A second instance was found and fixed.** A repo-wide byte scan (all 2618 tracked text files) turned up the
  same anti-pattern in `packages/core/src/ai/promptGuard.ts:41`: `sanitizeNlQuery`'s control-char class was
  written in literal bytes — NUL, BS, VT, FF, SO, US, **and DEL** (0x7F is why a first scan that only looked
  below 0x20 mis-read the set and a byte-level replace failed on a wrong pattern). The class is unchanged in
  behaviour but now written as escapes covering 0x00-0x08, 0x0B, 0x0C, 0x0E-0x1F, 0x7F, so the set is
  reviewable; before, any formatter, editor, or copy-paste could have narrowed a prompt-injection control with
  nothing visible in the diff. Pinned by two new tests in `promptGuard.test.ts` asserting all 32 C0 codes plus
  DEL are stripped and that printable and non-ASCII text survives. The same scan found and repaired two
  control bytes written into the prose of **this document** — which is what had made it `grep`-binary and
  unsearchable for its own work-item IDs. The repo is now at zero stray control/DEL bytes.
  **Method note, because this recurs:** an escape typed into a tool call is delivered as the real control
  byte, which is how all three instances were created. Fixing one therefore has to be done at the byte level
  (read bytes, splice, assert the resulting length, write bytes) — and when splicing in PowerShell, cast the
  slices with `[byte[]]`: `List.AddRange` rejects a boxed `Object[]`, and a partial failure there truncated
  `promptGuard.ts` to 35 bytes before `git checkout` restored it.

- [ ] **F-0.9 · Audit-log cross-tenant staff reads.** All five `/bff/*` readers run under `withForgeTx`,
  which writes **no** `platform_audit_log` row, while the console renders a standing "Cross-tenant view"
  badge. ADR-0032 requires the audit row in the same transaction. Add keyset cursor + hard cap to
  `listRecentCaptures` (unbounded today).
  **files:** `apps/forge-api/src/server.ts:84-105,103`

- [ ] **F-0.10 · Retire the orphaned second write path into `master_*`.** ADR-0047 replaced the HTTP push
  with in-process `withErTx`, but `POST /api/v1/master-sync` + `syncPrincipal` remain live — two write paths
  into Layer 0. Decide: delete, or gate behind a flag and document as the ER fallback.

### 3.3 Shared API/runtime P0s

- [x] **A-0.1 · Harden `Bun.serve` + graceful shutdown (api and forge-api).**
  **files:** `apps/api/src/server.ts:10-13`, `apps/forge-api/src/server.ts:107,134`
  **defect:** both export `{ port, fetch }` and nothing else: `maxRequestBodySize` unset (Bun default
  **128 MB** — any route buffers arbitrary JSON before Zod rejects), `idleTimeout` unset (Bun's 10 s will
  kill SSE, whose heartbeat is 15 s), **no SIGTERM drain** so every deploy drops in-flight requests, and
  `closeDb()` (which exists at `packages/db/src/client.ts:31`) is never called. `apps/workers` does this
  correctly (`apps/workers/src/index.ts:43-63`) — copy that shape.
  **for forge-api specifically:** the commit-then-enqueue window at `captures/routes.ts:57-63` means a
  SIGTERM there **permanently loses the enqueue**, and the reconciliation sweep meant to recover it is a
  TODO (`processors.ts:275`).
  **fix:** `{ maxRequestBodySize: 2_000_000 /* forge-api: ENVELOPE_MAX_BYTES */, idleTimeout: 65 }` +
  SIGTERM/SIGINT → stop accepting → drain → `closeDb()`.
  **verify:** a 3 MB body gets `413` not an OOM; `docker compose restart api` mid-request completes it.

- [ ] **A-0.2 · Gate `content-length` before parsing in forge-api capture.**
  `await c.req.json()` at `captures/routes.ts:44` precedes the 413s at `:57-62`, so a single request forces a
  128 MB read plus a parse of it. **needs:** A-0.1, F-0.1.

- [x] **A-0.3 · Rate-limit forge-api and gate `/metrics`.** `apps/api` applies `rateLimit` to `/api/*`;
  forge-api applies nothing globally, so every BFF read and the promotion write are unthrottled, and
  `/metrics` is unauthenticated on the public `forge-api.truepoint.in` origin.
  **files:** `apps/forge-api/src/app.ts:19-25`

- [x] **A-0.4 · Log 500s.** `apps/api/src/middleware/error.ts:15-23` returns a generic body and logs
  **nothing** — no stack, no request ID, no traces, no RED metrics anywhere (`/metrics` renders only auth
  counters and 404s unless `METRICS_TOKEN` is set). Production 500s are undiagnosable, violating the
  observability mandate (`truepoint-platform` SKILL.md:129-131).
  **fix:** request-ID middleware + structured error logging in `onError` + a latency histogram.

---

## 4. Phase 1 — Latency quick wins (days; no ADR changes)

- [x] **L-1.1 · Collapse the tenant-context bootstrap to 1 round-trip.**
  **files:** `packages/db/src/client.ts:88-108`
  Today: `SET LOCAL ROLE leadwolf_app` **then** a parameterised `SELECT set_config(tenant), set_config(ws)`
  = 2 setup RTTs on every scoped operation (≈5 RTTs per transaction to a remote Neon). `role` **is** a GUC,
  so all three fold into one statement: `SELECT set_config('role','leadwolf_app',true),
  set_config('app.current_tenant_id',$1,true), set_config('app.current_workspace_id',$2,true)`.
  The in-file comment claiming SET ROLE "cannot be parameterised or merged into a SELECT" is wrong.
  **guardrail:** G12 — `withForgeTx`/`withErTx`/`withPrivilegedTx` have different shapes; do not assume GUCs.
  **verify:** the full 92-file itest sweep (this is the single most RLS-sensitive change in the plan);
  specifically `rlsIsolation`, `masterGraphIsolation`, `roleModel`, `jobVisibility`.
  **rollback:** revert one function.

- [x] **L-1.2 · Initplan-wrap every RLS policy.** Mechanical rewrite across all 43 `rls/*.sql`:
  `workspace_id = (SELECT NULLIF(current_setting('app.current_workspace_id', true), '')::uuid)`.
  **why:** on index scans the bare form is fine (STABLE = once per scan), but on seq scans, hash joins and
  aggregate paths — facet counts, `countContacts`, list member counts — the GUC read + NULLIF + text→uuid
  cast re-evaluates **per row** (the documented RLS trap, up to ~100×). The 3-arm suppression policy
  (`billing.sql:70-75`) evaluates up to 2 GUC reads per row.
  **also:** add the missing `tenant_id` leg to workspace-only policies (defense in depth per `tenancy.md`).
  **guardrail:** G2 (ships by editing the files; no migration) and **G12** — there is no `rls/forge.sql`, so
  this sweep silently skips the forge schema. Either add one (see L-1.3) or record the deliberate absence.
  **verify:** `EXPLAIN (ANALYZE)` before/after on a facet-count query; full itest sweep.

- [ ] **L-1.3 · Give the `forge` schema an RLS story.** Either enable RLS on `raw_captures`/`parsed_records`
  keyed on `target_tenant_id` with a staff bypass (and give `withForgeTx` an optional scope), **or** add an
  itest that pins the intentional absence *and* proves `leadwolf_app` lacks `USAGE ON SCHEMA forge`.
  **why:** `withForgeTx`'s justification comment ("the forge tables carry no workspace_id") is factually
  false — `forge.raw_captures.target_tenant_id` is `NOT NULL` and `target_workspace_id` exists
  (`schema/forge.ts:38-39`). Every forge read is unscoped (`readRepository.ts:287`); the only wall is app code.
  **needs:** L-1.2 (decide the sweep's scope first).

- [x] **L-1.4 · Migration `0080`: the missing hot-path indexes.** Hand-written per G1/G3.
  - `contacts (workspace_id, created_at DESC, id DESC) WHERE deleted_at IS NULL` — **the default sort of
    every search/list page has no index today**; `accounts` already has its equivalent
    (`idx_accounts_ws_created_at`), contacts was simply missed.
  - the `coalesce(priority_score,-1) DESC` expression index for the score sort (the existing
    `idx_contacts_ws_priority_score` does not match the `coalesce` sort expression).
  - `activities (workspace_id, occurred_at DESC)` — the Home summary reads every workspace activity and the
    only existing index has `contact_id` in the middle, killing the range.
  - `list_members (list_id, added_at DESC, id DESC)` and `(contact_id)`.
  **each statement alone between `--> statement-breakpoint`, `CONCURRENTLY`, preceded by its own
  `SET statement_timeout` chunk** (G3).
  **verify:** `EXPLAIN` shows index scans for the default list query; itest sweep (new migration ⇒ fresh CI
  template DB, expect one slow run); `bun run db:migrate` twice (idempotence).

- [ ] **L-1.5 · Put `role` in the access-token claims.** Today every `requireRole`-guarded request runs an
  **extra full `withTenantTx`** (~5 RTTs: BEGIN + SET ROLE + set_config + SELECT + COMMIT) purely to read the
  caller's role, before the handler opens its own transaction — and on the Home path that stacks with
  `buildJobViewer` for **3 sequential transaction groups per request**.
  **files:** `packages/auth/src/token.ts:43-63` (claims are `tid/wid/sid/scope/pa` — no role),
  `apps/api/src/middleware/requireRole.ts:21`, `packages/db/src/repositories/workspaceRepository.ts:67`
  **fix:** mint `role` at login/refresh; bust via the existing revocation path on membership change.
  Interim (no token-shape change): a 30–60 s Redis/LRU memo keyed `(sid, wid)`.
  **guardrail:** the extension hand-decodes claims and ignores unknown ones (safe), but must **not** start
  trusting a role claim — `mint` deliberately drops `pa`. Re-check role on writes regardless.
  **verify:** auth unit tests; an itest asserting a revoked/changed membership stops authorizing within TTL.

- [ ] **L-1.6 · Home summary: cache-first, then one round-trip.**
  `packages/core/src/home/buildHomeSummary.ts:51-59` runs 9 `await`s serially in one transaction (a
  deliberate single-connection tradeoff that replaced 9 pinned connections — not naive code), and
  `apps/api/src/features/home/routes.ts:68-80` computes the whole summary **before** checking
  `If-None-Match`, so a 304 saves bytes but not work.
  **fix order:** (a) check the ETag against a cached hash before computing; (b) add the Redis per-workspace
  30–60 s memo the route comment itself says is missing; (c) then collapse to one SQL round-trip (CTEs +
  `json_build_object`).
  **needs:** C-2.1 (the Redis cache tier) for (b).

- [x] **L-1.7 · Drop app-level `compress()`.** `apps/api/src/app.ts:84` gzips every response inside the
  single-threaded Bun process. Caddy already does `encode zstd gzip` and **skips already-encoded bodies**,
  so this is not double compression — it is pure wasted Bun CPU on every response, and it prevents Caddy
  from applying the better zstd. (hono 4.6.13 has no `threshold` option.)

- [x] **L-1.8 · Raise CORS preflight cache 600 → 7200.** `apps/api/src/app.ts:69`,
  `apps/auth/src/lib/cors.ts:8`. Interim until T-2.1 deletes preflights entirely — preflight cache is
  per-exact-URL, so cursor-paginated URLs re-preflight every page today.

- [x] **L-1.9 · Trust-proxy IP resolution for the root rate limiter.**
  `apps/api/src/app.ts:110` mounts `rateLimit` on `/api/*` **before** authn, so the per-subject branch is
  dead at the root and it keys on spoofable `x-forwarded-for` (`rateLimit.ts:19-20`). Per-subject re-mounts
  *do* exist at router level (e.g. `import/routes.ts:97`) and not verifying a JWT pre-throttle is a
  deliberate perf choice — so fix the **IP resolution**, don't move the middleware. Also pipeline the two
  serial Redis hops (rate-limit consume + `isRevoked`) and consider a 5 s in-process negative cache.

- [ ] **L-1.10 · Real readiness probe.** `apps/api/src/app.ts:98` `/health` is a static `{status:"ok"}`, so
  compose marks the API healthy with a dead database. `apps/workers` already has a drain- and Redis-aware
  `/ready` — copy it.

- [x] **L-1.11 (partial: dead-scope gating, aborts, RQ defaults, loading/error) · Frontend: stop the wasted work on the app's busiest surface.**
  - `apps/web/src/features/prospect/components/ProspectPage.tsx:86-103` — contacts **and** accounts
    search+facet hooks all mount unconditionally (no hook takes an `enabled`/skip param and none reads
    `scope`), so **4 dead POSTs** fire on every visit. Gate the inactive scope.
  - `useProspectSearch.ts:57-83`, `useAccountSearch.ts:96-122`, `useContactSearch.ts:20-47` — no
    AbortController and no request keying, so overlapping searches resolve out of order and
    **last-to-resolve wins** (a stale-results correctness bug), and every abandoned keystroke still costs
    the backend.
  - One cached `useSession()` (today `GET /auth/session` is fetched independently by `AppShell.tsx:91`,
    `WorkspaceSwitcher.tsx:34`, `useSessionIdentity.ts:24` → 2–4 duplicate calls per page) and sane
    QueryClient defaults (`app/providers.tsx:13` is `new QueryClient()`, so `staleTime: 0` +
    `refetchOnWindowFocus` = refetch storms for the features that do use RQ).
  - `loading.tsx` per `(shell)` route group (all four apps have **zero** `loading.tsx`/`error.tsx`/`Suspense`).

- [ ] **L-1.12 · Dockerfile layer split.** `COPY package.json bun.lock` + every workspace manifest →
  `bun install --frozen-lockfile` → `COPY . .` → build. Today `COPY . .` precedes install (`Dockerfile:17-18`),
  so any file edit re-installs everything.
  **needs:** P-1.1 (G7 — the moment dev deps are pruned, workers break) · **also:** the "Turbo refuses the
  package graph" comment at `Dockerfile:20-24` is **stale** (the db↔core cycle is gone; the graph is
  acyclic), so `turbo run build` can replace the 4 serial `next build`s — verify empirically.

---

## 5. Phase 2 — Topology: one origin, server-side gate

**This is the highest-leverage change and the one with real blast radius.** Cold boot today is **≥6 serial
network round-trips across 3 origins** (307 → empty shell → JS+hydrate → cross-origin refresh → 2 preflights
→ first data), plus ~7 backend round-trips hidden inside the refresh and first API call.

**De-risking precedent that already exists in this repo:** `deploy/Caddyfile:69-87` already path-routes
`forge.truepoint.in` — `/bff/*` + `/v1/*` → `forge-api`, everything else → the console — with the comment
*"Same-origin means no CORS surface at all — forge-api deliberately ships none."* And
`apps/web/next.config.mjs:9-27` already has `/api/*` + `/auth/*` rewrites for the Replit single-domain
deployment, with `apps/auth` on `basePath="/auth"`. Phase 2 lifts that proven pattern from the Next Node
process up to Caddy.

- [ ] **T-2.1 · Caddy same-origin routing for `app.truepoint.in`.** Copy the forge block's shape:
  `/api/* → api:3001`, `/auth/* → auth:3000`, `/.well-known/* → auth:3000`, everything else → `web:3002`.
  Same for `admin.truepoint.in`.
  **effect:** every CORS preflight disappears; the Next Node process stops proxying API traffic.
  **verify:** `curl -si https://app.truepoint.in/api/v1/...` returns without an `OPTIONS`; no
  `access-control-*` needed; sign-in works end-to-end.
  **rollback:** revert the Caddyfile and `docker compose restart caddy` (it is a read-only bind mount, so
  `up -d` will **not** notice a content change).

- [ ] **T-2.2 · Access token into an `__Host-` httpOnly cookie on the app origin.**
  **files:** a new `apps/web` route handler that sets the cookie from the existing `/auth/callback`
  exchange; `apps/web/middleware.ts` (new); `apps/web/src/lib/authClient.ts`
  **design:** the cookie holds **only the 15-minute access token** — the durable rotating refresh session
  stays where ADR-0016 put it. `middleware.ts` gates on the cookie server-side, so the `tp-boot`
  "Loading…" screen and the client-gate waterfall disappear and **RSC can finally fetch**.
  **security posture:** this is *strictly better than today* against XSS exfiltration — the token currently
  lives in JS memory (`authClient.ts:9`, trivially readable by any XSS), and httpOnly makes it unreadable.
  It does require: `SameSite=Strict`, an Origin-check/`csrf()` middleware on mutating routes, and the CSP
  that `apps/web`/`apps/admin` **currently do not ship at all** (only `apps/auth` has a header middleware).
  **ADR action:** amends ADR-0016's "never an app-domain cookie" clause for the *access* token only. Note
  ADR-0016 explicitly **rejected** a `Domain=.truepoint.in` parent-domain cookie — an `__Host-` cookie is
  strictly narrower than what was rejected. Requires `truepoint-security` sign-off.
  **BLAST RADIUS — extension:** `apps/web/src/app/auth/extension/page.tsx:11,68-71,101` is the extension
  handoff and depends on JS-readable `getAccessToken()` / `silentRefresh()` / `startLogin()`. It **must** be
  carved out of the middleware gate (it runs in a background tab), and the extension keeps bearer tokens
  regardless (cookies are unusable from LinkedIn), so `EXT_TOKEN_BASE` refresh/logout and the `mint` route
  must survive intact.
  **needs:** T-2.1, X-0.1..X-0.5 (don't move the handoff while the capture path is lossy).

- [ ] **T-2.3 · Extract `packages/auth-client`.** `authClient.ts` is triplicated with real drift
  (web 204 / admin 140 / forge 129 lines) and `pkce.ts` is **byte-identical in three apps**; `apps/forge` is
  the only copy missing the `refreshInFlight` single-flight guard, whose documented (AUTH-078) absence
  double-rotates the refresh token and trips reuse-detection, revoking the family — so forge staff get
  spuriously logged out.
  **guardrail:** G4 — new package, barrel export, browser-only.
  **needs:** T-2.2 (migrate all three apps together, or forge is stranded on a deleted contract).

- [ ] **T-2.4 · Admin gate: unblock first paint.** `apps/admin/src/components/shell/AdminShell.tsx:43-60`
  runs its two stages **serially** (silentRefresh → `verifyPlatformAdmin`) holding the console blank —
  strictly worse than web's already-fixed pattern. Render chrome after stage 1; verify staff in background
  with a forbidden interstitial.

- [ ] **T-2.5 · Forge console gate.** `apps/forge/src/lib/forgeGate.ts:23` + `useOverview.ts:27` — same
  client-only pattern, and `/bff/overview` is fetched **twice** (cold `/overview` = 4 serial round-trips:
  refresh → overview-as-probe with the body discarded → `/bff/me` → overview again) with **3 uncached
  `platform_staff` lookups**. Use the single `/bff/me` (it already returns role + capabilities + email) and
  seed the overview hook from it. **needs:** T-2.3.

- [ ] **T-2.6 · Cross-tab refresh election.** Every tab refreshes on its own ~14 min timer
  (`authClient.ts:46-47`) and each refresh is a full rotation (DB revoke+insert + Redis write); N tabs = N
  racing rotation chains surviving only on the 30 s reuse-grace. Add BroadcastChannel election, or make
  rotation sliding-window.

---

## 6. Phase 3 — Caching tier, async unblock, frontend data layer

- [ ] **C-3.1 · Build the Redis read-through cache tier.** It does not exist: Redis serves only BullMQ and
  rate-limiting today. Implement exactly the typed tiers already specified in
  `docs/planning/18-scalability-performance.md §5` (entitlements ≤60 s invalidate-on-write; reveal-state /
  contact summary medium invalidate-on-write via outbox; search facet counts medium, bounded staleness OK;
  provider results long, request-hash keyed).
  **rules:** keys are tenant-scoped (`t:{tid}:ws:{wid}:…` — a key without the tenant is a cross-tenant leak
  through the cache); invalidate the narrowest key a mutation affects; short TTL + explicit invalidation
  over long TTL and hope; single-flight + TTL jitter on hot keys; **money and permission decisions are never
  served from a stale cache**.
  **first consumers:** `L-1.6` home summary, facet counts, credit balance, the public pricing catalog
  (`app.ts:190-193` hits the DB per anonymous request with no `Cache-Control`).

- [ ] **C-3.2 · Precompute the aggregates.** `dataQualitySummary` (`contactRepository.ts:745-748`) is a live
  per-view aggregate scan **despite a `data_quality_snapshots` table already existing** — wire the worker
  refresh. Same for burn-by-day.

- [ ] **C-3.3 · Facet counts in one pass.** `searchRepository.ts:438-459` +
  `accountSearchRepository.ts:264-346` run one full GROUP-BY aggregate scan **per facet, sequentially, per
  request** (8 facets = 8 re-executions of the whole WHERE, ILIKE legs and account join included), and
  select-all does an exact uncapped `COUNT(*)`. Move to `GROUPING SETS`, cache, and switch to estimated
  counts past a threshold.

- [ ] **C-3.4 · Flip the import v2 pipeline on.** CSV/**XLSX** is parsed synchronously on the API event loop
  (blocking the single Bun loop for all concurrent users) and the **job payload carries the parsed rows**
  through Redis. The correct design — upload → object store → COPY into UNLOGGED staging → chunked worker —
  **is already built** behind `IMPORT_V2_ENABLED` / `BULK_IMPORT_ENABLED` (both default-off). Admission byte
  caps (10 MiB CSV fast path) and a 10 000-waiting queue shed bound today's blast radius but don't fix it.
  **guardrail:** G5 — roll out per-tenant via the existing `import_v2_enabled` / `bulk_import_enabled` DB
  flags, which are already seeded off.

- [ ] **C-3.5 · Atomic spend breaker, then raise concurrency.** `apps/workers/src/tuning.ts:39-44` pins
  `imports: 1` and `enrichment: 1` fleet-wide — the latter because the daily budget breaker is a racy
  read-check-act, so **the whole platform's paid enrichment is serialized**, and one tenant's big import
  head-of-line-blocks every tenant's imports for up to the 15-minute deadline.
  **fix:** Redis `INCR`/Lua atomic breaker → raise concurrency → per-tenant fairness via sharded queues.

- [ ] **C-3.6 · SSE at scale.** `apps/api/src/features/events/routes.ts:21,37` opens a **dedicated IORedis
  client per connection** (10 k clients = 10 k Redis connections) and heartbeats every 15 s — longer than
  Bun's default 10 s idleTimeout, so the stream dies between heartbeats the moment
  `REALTIME_SSE_ENABLED` flips. One shared psubscribe client per process + in-process fanout + 8 s
  heartbeat + per-user connection caps. **needs:** A-0.1 (idleTimeout).

- [ ] **C-3.7 · Move the Redis PUBLISH out of the open DB transaction.**
  `apps/workers/src/realtimeRelay.ts:21-36` holds the transaction (and its pooled connection) across N
  network calls to Redis per batch.

- [ ] **C-3.8 · Finish the TanStack Query migration.** RQ v5 is installed and its provider is mounted, but
  it is used by **only** `import/` and `data-health/`; ~90% of features hand-roll `useState`+`useEffect`
  (`useProspectSearch.ts:40-83`, `useHomeSummary.ts:54-76` — which reimplements SWR+ETag caching by hand in
  76 lines — `useListMembers.ts:26-77`). This violates the project's own mandate
  (`truepoint-architecture` SKILL, *State and Data*: "anything answerable by a GET … never useState").
  Convert: keyset load-more → `useInfiniteQuery`; the five bespoke pollers → `refetchInterval`; the
  `window.dispatchEvent("credits:changed")` bus and `window.location.reload()` on org/workspace switch →
  `invalidateQueries`. **needs:** L-1.11 (defaults + `useSession` first).

- [ ] **C-3.9 · Virtualize `DataTable`.** `packages/ui/src/components/DataTable.tsx:3,105-118` renders
  **all** accumulated rows (its own comment admits it) while the search/list hooks append 50–100 per "Load
  more", and the client sort re-sorts the whole accumulation on every header click.
  `@tanstack/react-virtual` is absent from the lockfile. Violates the `truepoint-design` hard rule
  ("no un-virtualized large lists"). One component fixes every large surface.

- [ ] **C-3.10 · Server-side report aggregates.** `apps/web/src/features/reports/api.ts:31-53` fetches 200
  raw contacts + 200 reveals to the browser and rolls up client-side — so the numbers are **silently wrong
  past 200 rows** while being presented as totals. A naive SQL rollup endpoint suffices before ClickHouse
  (ADR-0010 puts the warehouse post-MVP).

- [ ] **C-3.11 · Column projections on masked surfaces.** `contactRepository.ts:702,728,1085` use bare
  `.select()`, pulling AES-GCM `email_enc`/`phone_enc` bytea + `custom_fields` + `field_provenance` jsonb —
  TOAST fetches and ciphertext into app memory — for surfaces that then **mask** it. The correct masked
  projection already exists in the same package (`searchRepository.ts:249-280`).

- [ ] **C-3.12 · List counts + the activity write-amplification trigger.** `member_count` counter column
  instead of counting every membership row per sidebar render (`listRepository.ts:220-235`); batch the
  dynamic-list N+1 (`packages/core/src/prospect/lists.ts:187-203` — a saved-search fetch + filtered
  `COUNT(*)` per dynamic list, serially, inside one held transaction); convert
  `rls/activity.sql:14-24`'s per-row AFTER-INSERT contact UPDATE to a statement-level trigger with
  transition tables (today bulk email-event ingest = one contact UPDATE per row + hot-row lock contention).

---

## 7. Phase 4 — Search: honour ADR-0002

**Policy check first.** ADR-0002 was **amended (2026-05-29) to "self-hosted Typesense from day one"**, with
OpenSearch for the master graph (ADR-0021) and `suggest()`/`facetCounts()` added to the port (ADR-0035).
Reality: `packages/search/src/index.ts:6` exports **only** `createInMemorySearchPort`,
`searchPortProvider.ts:46` wires prod to the ILIKE repositories, `packages/search` has **no consumer at
all**, and a **Typesense 27.1 container runs in prod compose with zero readers** — `TYPESENSE_URL`/
`TYPESENSE_API_KEY` are declared in env and read by nothing. So this phase is *implementing the accepted
ADR*, not choosing an architecture. There is also **no `SEARCH_*` flag** — one must be minted (G5).

- [ ] **S-4.1 · Interim: make Postgres search index-served.** `CREATE EXTENSION pg_trgm` + GIN trgm on
  `contacts(job_title, email_domain)` + a generated `full_name` column, and `accounts(name, domain)`;
  generated `tsvector` + `websearch_to_tsquery` for ranked text.
  **why now:** prod search is 6-leg `ILIKE '%…%'` ORs including an **unindexed concat expression**
  (`coalesce(first_name,'')||' '||last_name`), with title filters synonym-expanded into N more `%…%`
  patterns per query — zero trgm/tsvector exist in all 81 migrations, so every search, facet and typeahead
  is a full workspace scan. Label this explicitly as a **stopgap with a kill date**, not a replacement for
  S-4.2. **needs:** L-1.4 (same migration discipline) · **check:** Neon must allow `CREATE EXTENSION pg_trgm`
  without superuser.

- [ ] **S-4.2 · Build the real Typesense adapter behind `SearchPort`.** Overlay search + facets + suggest,
  every query filtered by `workspace_id` (ADR-0002 §4; `truepoint-security` has final say on the filter).
  Feed it from the **already-built** outbox + `FOR UPDATE SKIP LOCKED` projector — never dual-write from a
  request path. ADR-0024's freshness SLO is search-sync p95 < 5 s.
  **also:** the master-graph fuzzy-name path is currently unindexed *on the promise of an engine that has no
  adapter* (`schema/masterGraph.ts:14-15` marks trgm "DEFERRED (do not add)") — that is ER-blocking, so land
  trgm there under S-4.1.
  **guardrail:** G5 — mint a `SEARCH_BACKEND` env master + per-tenant flag so the cutover is per-tenant and
  instantly reversible. **decision:** if S-4.2 is not being built now, **stop the orphan container** (zero
  code impact) rather than leave it burning RAM and implying a capability that doesn't exist.

---

## 8. Phase 5 — Dependency upgrades + RSC/streaming

### 8.0 Version matrix (verified against the npm registry, 2026-07-26)

| Package | Was | Target | Note |
|---|---|---|---|
| drizzle-orm | 0.36.4 | **0.45.2** ✅ | **SQLi (CWE-89) in `sql.identifier()`/`sql.as()` — 0.44.x is the vulnerable branch, 0.45.2 is the fix.** No call sites in our code, so not exploitable here; upgraded as defense. |
| drizzle-kit | 0.28.1 | **0.31.10** ✅ | Snapshot format still v7 → existing 81 migrations untouched. Adds native Bun launch. |
| hono | 4.6.13 | **4.12.32** ✅ | ~40 advisories: CORS credential-wildcard reflection (CVE-2026-54290, High 7.1), 2× JWT alg-confusion High, cross-request JSX disclosure, **SSE CR/LF injection** (we have an SSE route), 2× bodyLimit bypass. |
| next | 15.1.2 | **15.5.22** ✅ | CVE-2025-29927 (middleware bypass, CVSS 9.1 — we were vulnerable) + the 13-advisory 2026-07-21 release (2× SSRF High, DoS, cache confusion). Interim; 16.2.12 is a separate migration. |
| react / react-dom | 19.0.0 | 19.2.8 | No breaking changes, but `useId` prefix changed `:r:`→`_r_` — churns snapshot tests. Land BEFORE Next 16 so the two failure modes don't interleave. |
| zod | 3.23.8 | 3.25.76 → 4.4.3 | **3.23.8 is below the `>=3.25.0` floor** every current zod-adjacent package now requires. Two-step by design. |
| typescript | 5.7.2 | **5.9.3** (not 6, not 7) | TS7 has **no public compiler API** (breaks typescript-eslint/ts-morph) *and* Next 16.2 cannot even detect it. |
| turbo | 2.3.3 | 2.10.7 (floor **2.10.6**) | 2.10.3/5/6 fix `prune`+`bun.lock`+`--frozen-lockfile` — exactly our Docker path. Zero config change needed. |
| biome | 1.9.4 | 2.5.5 | **Config breaks**: `files.ignore` removed, `organizeImports` moved. Own PR — the rewritten import organizer reorders imports repo-wide. |
| bun | 1.3.14 | **stay** | Already current; 1.4.0 (the Zig→Rust rewrite) is canary-only. |
| jose | 5.9.6 | 6.2.4 | 5.x is EOL. **`EdDSA` was NOT renamed** — Ed448/X448 were removed, Ed25519 is fine. Types shift `KeyObject`→`CryptoKey`. |
| bullmq / ioredis | 5.78.0 / 5.10.1 | 5.81.2 / 5.11.1 | bullmq exact-pins ioredis — bump in lockstep or a duplicate returns. |
| @tanstack/react-query | 5.101.3 | 5.101.4 | **No v6 exists** for React (only Svelte/Solid adapters went major). |
| @tanstack/react-virtual | — | 3.14.8 | New (C-3.9). **Must pass `useFlushSync: false`** or React 19 throws the flushSync-during-render warning. |
| typesense | 27.1 | 30.2 | Three majors behind. Snapshot BEFORE upgrading (v30 migrates synonyms/overrides); grouped `found` becomes approximate; `override_tags`→`curation_tags`. |

### 8.1 Corrections this research forced on the plan

- **`hono csrf()` does NOT protect `application/json`** — it only guards form-like content types. T-2.2 must use an explicit Origin/Sec-Fetch-Site check, not `csrf()`.
- **`compress()` DID have `threshold` in 4.6.13** (default 1024). Removing it (L-1.7) is still right — the edge does it better — but not for the reason first recorded.
- **`ContentfulStatusCode` landed in 4.6.15**, a patch: `c.json`/`c.text`/`c.html` no longer accept 101/204/205/304. Fixed in 4 sites. `c.body(null, 304)` stays legal.
- **drizzle 0.44+ wraps every driver error in `DrizzleQueryError`** → SQLSTATE checks must read `.cause`. One site (`packages/core/src/prospect/tags.ts`) fixed to walk the chain.
- **`drizzle-kit generate` cannot drop our hand-written RLS policies** — `generate` never opens a DB connection, and the policies exist in neither snapshot nor schema JSON. But `push`/`pull`/`drop` WOULD. Add a hard guard; never run them here.
- **`@zod/codemod` does not exist** (404). Use `zod-v3-to-v4` or `codemod.com`'s `zod-3-4`.
- **Neon: `neon_superuser` carries `BYPASSRLS`**, and roles created via Console/CLI/API inherit it while SQL-created roles do not. App traffic must use a SQL-created role — plus `FORCE ROW LEVEL SECURITY`, since a table owner bypasses RLS regardless.
- **Neon PG18 makes generated columns VIRTUAL by default, and virtual columns cannot be indexed** → S-4.1's `tsvector` column MUST say `STORED` explicitly or the GIN index silently becomes impossible.
- **Neon `idle_in_transaction_session_timeout` is 5 min** (not PG's 0) — a long `withTenantTx` that idles will be killed.
- **`CREATE INDEX CONCURRENTLY` on Neon**: use the DIRECT (non-`-pooler`) endpoint, and raise `maintenance_work_mem` (64 MB default is small for a GIN build) — both need a session `SET`, which the pooler forbids.
- **`pg_partman` 5.1.0 IS available on Neon** with its background worker on by default — but drive `run_maintenance_proc()` from a BullMQ repeatable job instead, since a BGW cannot wake a suspended compute while an external worker connecting does.
- **`bun test` has native `--isolate`, `--shard=M/N`, `--parallel` since 1.3.13** — replaces the hand-rolled `find` + per-file + `$((i % 4))` loops in CI.
- **Do NOT add `--bun` to the Next scripts**: an open Bun issue has `next start` returning 200 with empty bodies for server-side `fetch` when `content-length` is set (silent data loss), plus ~8× idle RSS.

### 8.2 Remaining ordering constraints

- [x] **U-5.0 (interim DONE — 15.5.22) · `apps/web` etc. are on `next 15.1.2`, which predates the CVE-2025-29927 middleware-bypass fix.**
  T-2.2 introduces `middleware.ts` as an **auth gate** — so the Next upgrade is a **hard prerequisite** for
  T-2.2, not a nice-to-have. (Today `apps/auth`'s middleware only sets headers, which is why the current
  exposure is limited to header stripping.)
- **U-5.1 · Zod 3→4 is atomic across `types` + `config` + `integrations` + `forge-api` + `extension`** (G8).
  Note `apps/forge-api` defines its own wire schemas in `src/features/review/schema.ts` (its header concedes
  they belong in `@leadwolf/types`) and the extension duplicates `capturedRecord` locally, mapping into
  `RawObservation` with **no validation** (`rawObservation` is `z.record(z.string(), z.unknown())`), so
  contract drift is undetectable client-side and lands as a 422 the scheduler **drops** (X-0.1).
- **U-5.2 · Drizzle 0.36→current is gated on P-1.7** (snapshot repair). 0.36 predates `pgPolicy`, so the
  bump is also what would let L-1.3's forge RLS be declared in TS.
- **U-5.3 · Hono 4.6.13 → ≥4.9 is atomic across `api` + `forge-api`** (G8) and pairs naturally with A-0.1's
  `Bun.serve` rewrite. Gets `compress()` `threshold`, per-route `bodyLimit`, `csrf()` (needed by T-2.2), and
  RPC (`hc<AppType>`) to replace the ~15 hand-rolled `fetch` + blind-`as`-cast feature clients.
- **U-5.4 · React Compiler / PPR** need the Next upgrade first. The codebase is 100% function components
  with heavy manual `useMemo`/`useCallback` — an ideal Compiler candidate.
- **U-5.5 · `@anthropic-ai/sdk`** is a *new* dependency (F-0.7) — no workspace has it today.
- Also queued: jose 5→6, TanStack Query current, `@tanstack/react-virtual` (new, C-3.9), Turbo 2.3.3→current
  (+ remote cache, and drop `.env` from `globalDependencies` — `start.sh` rewrites `.env` every dev boot,
  busting 100% of the turbo cache), Biome 1.9.4→2.x, TypeScript 5.7.2→current, `@crxjs/vite-plugin`
  (currently a **beta** producing a store artifact).

- [ ] **R-5.6 · RSC-first data flow.** Route `page.tsx` becomes a server component that `prefetchQuery`s the
  primary read (api reachable same-origin over the docker network) and wraps the existing client feature in
  `<HydrationBoundary>` — client hooks stay, they just start warm. Then `loading.tsx`/Suspense streaming
  (which also removes the `force-dynamic` crutch currently used to dodge the `useSearchParams` prerender
  bailout), then PPR. **needs:** T-2.2, C-3.8, U-5.0.

- [ ] **R-5.7 · Ship hygiene.** `output: "standalone"` for all four Next apps (Docker images currently ship
  full `node_modules`), `optimizePackageImports: ["@leadwolf/ui"]`, `next/dynamic` for the heavy conditional
  payloads (694-line `RecordDetail`, template editor, drawers — today **zero** `next/dynamic` in `apps/web`;
  only `xlsx` is done right), tokens.css imported once (today twice — JS import **and** CSS `@import`),
  `@leadwolf/types` subpath exports instead of the 74-line `export *` barrel.

---

## 9. Phase 6 — Scale-out (ongoing, post-green)

- [ ] **E-6.1 · Per-app images + registry + rolling deploy.** Today: one `leadwolf:latest` shared by 9
  services (so no service can be updated alone), built **on the prod host**, with a documented downtime
  window cushioned only by Caddy's 5 s dial-retry. Target: CI builds per-app standalone images → registry →
  deploy pulls → start-first rolling replace (Swarm mode on the same host is the smallest real step).
  **needs:** P-1.4, L-1.12, R-5.7.
- [ ] **E-6.2 · CDN in front of Caddy** — immutable edge caching for `_next/static/*`, edge zstd/Brotli,
  HTTP/3 at the edge, WAF; add its ranges to `trusted_proxies` (currently `private_ranges`, correct only
  while Caddy is the edge). Also add HSTS/CSP to `apps/web`/`apps/admin`, which ship **no** security headers
  today (needed by T-2.2 anyway).
- [ ] **E-6.3 · Read replicas + pool split.** `DB_POOL_MAX` env (today `max: 10` hardcoded), a
  `leadwolf_app` LOGIN pool for tenant traffic vs a small owner pool for the audited platform paths (today
  the runtime pool logs in as the **DB owner**, so any `db.*` call outside `withTenantTx` silently bypasses
  RLS, and unauthenticated public catalog reads are served from the owner pool), `prepare` gated on a
  `DB_POOLED` flag, then replica routing for list/dashboard reads.
- [ ] **E-6.4 · Partition the append-heavy tables** — `activities`, `email_events`, `platform_audit_log`,
  `provider_calls`, `source_imports`, `credit_ledger` (zero `PARTITION BY` in the repo today). Monthly range
  partitions; the partition key is already in the hot predicates. Gives retention real detach-and-archive
  mechanics. **check:** whether Neon permits `pg_partman`; if not, hand-rolled monthly partitions.
- [ ] **E-6.5 · OTel end-to-end** api → workers → db, on top of A-0.4's request IDs.
- [ ] **E-6.6 · Forge isolation** — `FORGE_DATABASE_URL` + its own login role and pool (today `withForgeTx`
  shares the customer request path's `max: 10` pool, so there is no capacity or failure isolation), plus a
  runtime `statement_timeout` (migrations set one; the runtime pool does not).

---

## 10. Work-item dependency graph

```
P-1.1 ──┬─► P-1.4 ──► E-6.1
        └─► L-1.12 ─┘
P-1.3 ──► P-1.7 ──► U-5.2 ──► L-1.3
P-1.2, P-1.5, P-1.6  (independent, land immediately)

Phase 0 (X-0.*, F-0.*, A-0.*)  — independent of Phase 1; X-0.1..X-0.5 gate T-2.2
A-0.1 ──► C-3.6, A-0.2
F-0.2 ──► F-0.7 ──► F-0.3

L-1.1, L-1.2 ──► L-1.3
L-1.4 (independent migration)
L-1.5, L-1.7..L-1.11 (independent)
C-3.1 ──► L-1.6, C-3.2, C-3.3
L-1.11 ──► C-3.8 ──► R-5.6

U-5.0 (Next upgrade, CVE) ──► T-2.2   ◄── X-0.1..X-0.5
T-2.1 ──► T-2.2 ──► T-2.3 ──┬─► T-2.4
                            └─► T-2.5
S-4.1 ──► S-4.2 (or: stop the orphan container)
U-5.3 ──► A-0.1 rewrite lands together
```

---

## 11. Risk register

| Risk | Item | Mitigation |
|---|---|---|
| RLS change silently opens cross-tenant reads | L-1.1, L-1.2, L-1.3 | The 92-file itest sweep is the gate; `masterGraphIsolation` proves the grant-off wall (SQLSTATE `42501`) and `rlsIsolation` proves wrong-workspace and unscoped both return 0 rows. Never merge these two items in one commit. |
| Cookie migration breaks the extension handoff | T-2.2 | Explicit `/auth/extension` carve-out + keep `EXT_TOKEN_BASE`/`mint`; extension stays on bearer tokens. Test the handoff before and after. |
| RLS sweep certifies a schema it never touched | L-1.2 | G12 — `forge` has no RLS file; L-1.3 must land or the absence must be pinned by an itest. |
| A migration that can't be undone | L-1.4, S-4.1, P-1.7 | Forward-only (G6): additive DDL only, `CONCURRENTLY`, and a feature flag for anything that changes read behaviour. |
| `next build` breaks in prod, not CI | all frontend items | P-1.4 first. |
| Prune breaks the worker fleet | L-1.12, E-6.1 | P-1.1 first (G7). |
| Two zod instances | U-5.1 | Atomic 5-workspace bump (G8). |
| Concurrent-agent worktree drift reaching prod config | P-1.3 | Generate migrations on main only; the poisoned config proves this already happened once. |
| Enabling `EXTENSION_SCOPE_ENFORCE` 403s the hover card | X-0.2 | Add the two rules **and** the coverage test before flipping. |

---

## 12. ADR actions

| ADR | Action |
|---|---|
| **ADR-0016** (dedicated auth origin) | **Amend** for T-2.2: the *access* token moves to an `__Host-` httpOnly cookie on the app origin; the durable rotating refresh session stays on the auth origin. Record that this is narrower than the `Domain=.truepoint.in` cookie the ADR rejected, and that httpOnly is strictly stronger than today's JS-memory token against XSS exfiltration. Security sign-off required. |
| **ADR-0002** (Typesense day one) | **No amendment.** S-4.1 is an explicitly time-boxed stopgap; S-4.2 implements the ADR as written. Record the stopgap + kill date in the ADR's amendment log. |
| **ADR-0032** (platform audit vocabulary) | Add the `forge.bff.*` cross-tenant read actions (F-0.9). |
| **ADR-0047** (forge master-graph sync) | Record the retirement (or flag-gating) of the orphaned `POST /api/v1/master-sync` second write path (F-0.10). |
| **New ADR-0048** | Server-side read cache tiers + invalidation contract (C-3.1), implementing `18 §5`. |
| **New ADR-0049** | Search backend cutover flag + the CDC/outbox indexing contract (S-4.2). |
| Housekeeping | Two files share the ADR-0036 number (`-bulk-async-job-and-staging-pipeline` and `-bulk-csv-enrichment-pipeline`). Next new ADR number is **0048**. |

---

## 13. Anti-goals — do not do these

- **Do not run `drizzle-kit generate`** to create a migration (G1) — and never with `--config` (P-1.3).
- **Do not put `CREATE INDEX CONCURRENTLY` in an `rls/*.sql` file** (G2), and do not assume a migration
  chunk with several `;`-separated statements is safe for it (G3).
- **Do not prune dev dependencies** from the image before P-1.1 (G7).
- **Do not "fix" the brand/scope mismatch** — TruePoint (product) vs `@leadwolf/*` (code) is deliberate.
- **Do not blind-prune the ~42 `worktree-agent-*` worktrees** — they hold uncommitted work.
- **Do not let the extension trust a role claim** (L-1.5) — `mint` drops `pa` deliberately.
- **Do not delete `packages/search`** — it is the `SearchPort` seam ADR-0002 requires; give it an adapter.
- **Do not change `DEFAULT_APP_ROLE_PASSWORD` without `itestDb.ts`** (G9).
- **Do not treat root `bun test` as the gate** — CI runs one process per file for a reason (§0).
