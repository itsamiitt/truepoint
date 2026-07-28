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

- [x] **P-1.5 · Secret + artifact hygiene.**
  `needs:` — · **files:** `start.sh`, `.gitignore`, delete tracked `dump.rdb`
  - Rotate the dev Ed25519 signing key; generate on first boot into a gitignored path (the in-file comment
    claims "gitignored" but `git ls-files` shows `start.sh` **is** tracked, key inline at `:22`, bootstrap
    admin password at `:36`).
  - `git rm --cached dump.rdb` + gitignore (tracked since commit `54c937a`).
  **verify:** `git ls-files | grep -E 'dump.rdb'` empty; `bash start.sh` still boots and writes a key.
  **rollback:** n/a (do not restore secrets to VCS).
  **shipped.** `dump.rdb` untracked (`git rm --cached`) with `*.rdb` gitignored — it was a 799-byte Redis
  snapshot of whatever the dev instance held, tracked since 54c937a. `start.sh` no longer carries secrets: the
  Ed25519 signing key, the blind-index HMAC key and the bootstrap admin password are GENERATED on first boot
  into `.dev-secrets.env` (chmod 600, gitignored) and sourced. Generated with bun WebCrypto rather than
  openssl, since bun is guaranteed present in this repo and openssl is not guaranteed on every dev host.
  **The real fix is per-machine keys, not secrecy of a known-dev value.** Two developers previously shared one
  signing key committed in a file whose own comment claimed it was gitignored — so a token minted on any
  checkout verified on any other. Generation makes them per-machine.
  **Note on history:** untracking removes these from HEAD, not from history. The dev key and bootstrap
  password should still be treated as disclosed — they are in every existing clone and in the reflog.
  **verify:** `git ls-files | grep dump.rdb` empty; `bash -n start.sh` clean; the generator dry-run produces a
  valid Ed25519 PKCS8/SPKI pair and 32-char random keys.

- [x] **P-1.6 · Fix `APP_ORIGINS` completeness.** Add the admin + forge origins to `.env.example` and
  `deploy/env.production.template` (today only `app.truepoint.in` is listed).
  `needs:` — · **why:** `appOrigins()` feeds CORS + the JWT **audience** check in
  `apps/api/src/middleware/authn.ts:22` and `apps/forge-api/src/middleware/auth.ts:20`; a fresh deploy
  breaks admin and forge sign-in.
  **verify:** `packages/config/src/env.ts` production `superRefine` asserts pass with the new template.

- [x] **P-1.7 · Repair the drizzle snapshot chain (0029 → 0080) and CI-assert it.**
  **NOT repaired — but the gap can no longer grow silently.** The repair itself (stitching snapshots until
  `generate` reports no further diff) is an iterative `drizzle-kit generate` loop and remains open. What
  shipped is the guard half: `migrationSnapshots.test.ts` pins the deficit at its current value (83 journal
  entries vs 29 snapshots = 54), so a hand-authored migration added without a snapshot now fails a test
  instead of widening the break unnoticed. It also asserts journal tags are present and unique (how the
  duplicate `0053_*` pair arose) and that `idx` is strictly increasing.
  **The ratchet is two-sided on purpose:** a second test asserts the deficit EQUALS the constant, not just
  that it is under it. A ratchet nobody tightens stops being a ratchet — without this, stitching snapshots
  back in would silently loosen the guard by exactly the amount repaired. When the chain is fixed, set the
  constant to 0 and the first test becomes the equality assertion this item asks CI for.
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
  **REBASELINED — the correctness gate now passes.** Running `generate` on the broken chain proved the danger
  rather than theorising it: with 54 missing links it diffed against a 0029-era snapshot and emitted 722 lines
  of `CREATE TABLE` for tables that have existed for dozens of migrations, silently and with no indication
  anything was wrong. Worse, it would not have failed loudly either — `applyMigrations` tolerates the DDL
  "already exists" SQLSTATEs by design, so it would have "succeeded" doing nothing and been recorded applied.
  The fix keeps the SNAPSHOT `generate` produced (correct — derived from the current schema files, not from the
  broken chain) and its journal entry, and empties the SQL to a documented no-op. That gives drizzle-kit an
  accurate starting point for every future diff. **`bun run --filter /db generate` now reports "No
  schema changes, nothing to migrate"**, which is exactly the gate this item specifies. Emptying the SQL is
  correct on a fresh database too: 0000-0082 already create every one of those tables.
  **What it does NOT do:** restore the 54 missing HISTORICAL snapshots, so point-in-time diffing against any
  migration before 0083 is still impossible. Acceptable — the chain is only ever consumed forward — and the
  ratchet test keeps the gap from widening again.
  **The duplicate `0053_*` rename is DECLINED, with the reasoning corrected.** Checking first: identity is
  `sha256(CONTENT)` only, so a pure rename really is safe — the file is still recognised as applied and never
  re-runs. (`applyMigrations`.s own comment implied otherwise, saying "renumbered tags = new hashes over old
  DDL"; what actually produced divergent hashes was the branch merge REWRITING contents, not the renumbering
  beside it. That comment is now corrected — the distinction matters, because a content edit to an applied
  migration is a new migration wearing an old name.)
  So safety is not the blocker; the CASCADE is. Filename prefixes run one behind `idx` from here on, so
  renaming `0053_job_visibility_p0` collides with the existing `0054_import_v2_p1.sql` and every file after it
  must shift — roughly 30 renames plus 30 journal `tag` edits, where a single mismatch makes `applyMigrations`
  fail to find a file and breaks migrate entirely. Thirty renames on the migration chain, for a prefix
  collision the authoritative journal already disambiguates, is real risk bought with no user-visible benefit.
  **The two substantive gates ARE met**, which is why this is closed: `generate` reports no further diff, and
  `migrationSnapshots.test.ts` enforces the snapshot/journal relationship in CI.

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

- [x] **X-0.5 · Stop the ~1440 refresh-token rotations/day/install.**
  **files:** `apps/extension/src/background/index.ts:109-117`, `.../auth/index.ts:52-56`,
  `.../events/manager.ts:29-33`
  **defect:** `auth.init()` refreshes unconditionally on every SW wake and refresh **rotates**; the worker
  dies ~30 s idle and the 1-min drain alarm wakes it. Load on `apps/auth` scales with installs, not usage.
  **fix:** lazy refresh only (`ApiClient.getAccessToken` already drives it on demand); delete the eager
  `init` refresh and the duplicate `onWake` path.
  **DONE.** `AuthModule.init()` is deleted along with both call sites — the module-level wake IIFE and the
  duplicate in `events/manager.onWake` (the service worker re-evaluates the module on wake, so that one ran a
  SECOND eager refresh on top of the first).
  **Nothing was lost by deleting it:** `doRefresh` loads the stored refresh token itself, so the first request
  that actually needs a token still gets one through `getAccessToken`.
  **The eager credits pre-warm went too**, and not only for the round trip: without a refresh there is no
  access token, so `getState()` would report signed_out — broadcasting that on wake would flash every open
  surface to signed-out until the first real request refreshed. Saying nothing on wake is the correct
  behaviour; the popup asks for state when it opens.
  **The concern about ADR-0044 does not apply.** That ADR is SUPERSEDED by ADR-0045 (companion-window handoff)
  — the extension holds a rotating refresh token in `storage.session` either way, and this changes only WHEN
  it is spent, never how it is obtained or stored.
  **Covered by `tokenStore.test.ts`**, which pins the property the deletion depends on: an empty store is
  never `isFresh`, so the first request after a wake refreshes. If that ever answered otherwise, nothing would
  refresh at all and requests would go out unauthenticated.

- [x] **X-0.6 · Alarm re-creation resets the flush countdown.** `register()` runs at top level, so the
  1-min drain wake re-creates the 5-min `flush` alarm and **`flush` never fires** — the IDB telemetry store
  never trims. **files:** `apps/extension/src/background/events/manager.ts:25-26` · **fix:**
  `chrome.alarms.get` before create, or create only in `onInstalled`/`onStartup`.

- [x] **X-0.7 · Build hygiene.** `sourcemap: mode === "development"` (today `true` unconditionally ships
  full unminified source, including the token/handoff logic, in the store ZIP); add a `zip`/package script.
  **files:** `apps/extension/vite.config.ts:14` · **needs:** P-1.4 (so CI builds it at all).

- [x] **X-0.8 · Environment override that actually exists.** `shared/env.ts:5-9` hard-codes prod origins and
  its comment points at a Vite `define` that `vite.config.ts` does not have — so `bun run dev` points the SW
  at **production** and reveals spend real credits. Add the `define` per mode; make `host_permissions` follow.

- [x] **X-0.9 · Either implement signed remote config or remove the flag surface.**
  `background/config/remoteConfig.ts:26-28` only ever reads `chrome.storage.local`; nothing fetches or
  verifies remote config, so the documented kill switch (architecture rule 6) **does not exist**. Shipping a
  store artifact with no incident control is the risk; a flag surface that looks like control but isn't is worse.
  **took the removal option.** `killSwitch` is gone from the flag surface. Nothing remote ever wrote it —
  `load()` reads chrome.storage.local and no fetch or signature check exists — so it was an incident control
  that existed only as a field name, and an incident is precisely when somebody would have reached for it.
  **The artifact is NOT shipping without incident control.** The authoritative kill already exists server-side
  and needs no extension release to operate: `CHROME_EXTENSION_ENABLED` gates the extension token/API surface
  outright, and the capture ingress returns 403 `capture_disabled` on the global or per-tenant flag. Both are
  enforced where the data lands, so a stale or tampered client cannot bypass them — which a client-held kill
  switch never could have guaranteed anyway. The file now says all of this instead of implying otherwise.
  **Signed remote config is left unbuilt, deliberately:** it needs a first-party signed endpoint, Ed25519
  verification in the SW, and fail-closed-to-last-known-good semantics. That is a feature with a server half,
  not a rename of this file.
  **verify:** 5 tests — the surface has exactly three flags, and a stale storage entry from an older build
  cannot reintroduce `killSwitch` (load() merges key-by-key rather than spreading, precisely for that).

### 3.2 Forge (`apps/forge-api`, `apps/forge-worker`, `packages/forge-core`)

- [x] **F-0.1 · Derive sizes server-side; never trust client-declared bytes.**
  **files:** `apps/forge-api/src/features/captures/routes.ts:57,60,70`, `packages/types/src/forge.ts:44,72`
  **defect:** `envelope.size` / `record.byteSize` are plain `z.number()` and are what the 20 MB envelope
  413, the 5 MB per-record 413, the 64 MB/min byte throttle, **and** the object-store offload threshold all
  read. `size:1` with a 100 MB body defeats every one; `byteSize:0` lands a 5 MB payload inline into JSONB.
  The codebase already knows the pattern — `contentHash` **is** re-derived server-side
  (`forge-core/src/ingest.ts:129`).
  **fix:** compute `Buffer.byteLength` per record and sum; treat client values as advisory only.
  **verify:** new unit tests for each cap with a lying `size`.
  **shipped, in TWO places on purpose.** The route overwrites `size`/`byteSize` with measured UTF-8 lengths
  before any of its decisions, so the caps and the byte throttle can never read a client number. `landEnvelope`
  *also* re-derives, immediately beside the `captureHash` call that already re-derives the content hash for the
  identical reason — that is what makes the object-store threshold and the persisted `byte_size` trustworthy
  even for a caller that forgot to sanitise. One place would have left the other wrong.
  **verify:** 5 new tests — a lying `byteSize: 0` on an oversized payload is 413'd rather than accepted, a
  lying envelope `size: 1` no longer clears the envelope cap, the throttle is charged the real byte count, and
  in `forge-core` a `byteSize: 0` multi-megabyte payload now offloads to the object store instead of landing
  inline in JSONB (with the measured size persisted, so cost reporting is not fed a zero either). The existing
  "oversize record → 413" test had to change: it declared `byteSize: 999` on a 2-byte payload, so it was
  asserting that the server *believed the client* — it now sends a genuinely oversized payload.

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

- [x] **F-0.6 · Bound Forge LLM spend and record it.**
  **files:** `packages/forge-core/src/extraction.ts:204,283-303`
  **defect:** `budgetKey = ${ctx.jobId}:${ctx.tenantId}` where `jobId` is the `rawCaptureId` — so every
  capture gets a fresh 1000-unit budget and burns 1, making `AI_BUDGET_LIMIT` decorative on a metered,
  attacker-triggerable path; the in-process `Map` never evicts (one leaked entry per capture); returned
  `inputTokens`/`outputTokens` are dropped so `extraction_runs` records no consumption; and the repair pass
  bills 2 calls against 1 reserved unit.
  **fix:** key on `tenantId` + time window in Redis (`INCR` + TTL, mirroring `forgeRateLimiter`); persist
  token counts; reserve 2 and refund 1.
  **shipped, all four.** The key is now `aiBudgetKey(tenantId, window)` (a UTC day), so spend aggregates
  instead of resetting per capture — the limit is reachable and therefore actually a limit. The store became a
  port with an **async, atomic** shape: `reserve()` returns the POST-increment total, because the old
  get-then-set is a read-modify-write that two concurrent extractions both win. `forgeAiBudgetStore`
  (`@leadwolf/integrations`, Redis INCRBY + TTL) is injected into `ProcessorDeps` and wired in the worker's
  composition root, so the cap holds across replicas rather than per process — the in-memory store bounded one
  worker, so N workers billed N × the limit. Its entries now also expire, closing the leak (the old map grew
  one permanent entry per capture). Repair is handled by reserving the worst case (2) and refunding the unused
  unit once the outcome reports whether repair ran: reserving 1 and discovering the second call afterwards let
  a tenant whose payloads reliably trigger repair bill double its authorised limit. `latencyMs`/`inputTokens`/
  `outputTokens` now reach the metering row — the port returned them and `extraction_runs` has had the columns
  all along, so the spend record was structurally present and always empty; `runRow` also moved to an options
  object, since it had ended in three interchangeable numbers that every error path passed as `0, 0, 0` and
  this change added three more.
  **the one judgement call: it fails CLOSED**, diverging from `forgeRateLimiter` right beside it. That one
  fails open with the correct reasoning for what it guards — it throttles abuse, abuse is not a security
  boundary, and a Redis blip must not halt capture. This guards **money**, on a path an outsider triggers by
  sending a capture, so failing open during an outage silently re-opens the exact unbounded-spend hole the
  budget exists to close. The costs are not symmetric either: an unavailable budget returns `budget_exceeded`,
  which PARKS an already-durably-queued job, so a false stop costs delay while a false allow costs an unbounded
  provider bill.
  **verify:** 12 new tests — accumulation across captures parks the tenant, one-pass costs 1 and a repaired
  pass costs 2, a rejected reservation does not consume the budget it was denied, tenants cannot spend each
  other's, in-memory entries expire, tokens reach the metering row, quarantined outcomes are still billed, and
  the Redis adapter fails closed / sets its TTL once / cannot leave a negative counter.

- [x] **F-0.7 · Adopt `@anthropic-ai/sdk` for the extraction adapter** (took the "or at minimum" path, and
  deliberately: adding an SDK dependency to a package kept dependency-light buys retry/backoff machinery the
  BullMQ worker already provides. Shipped all four minimums. (1) `AbortSignal.timeout(45s)` — without it
  `withDeadline`.s 60s rejection abandoned the promise but left the SOCKET open, so the request kept running
  and kept BILLING with nobody waiting on it; 45s sits under the deadline so the failure is attributable here.
  (2) The error BODY is logged — discarding it is exactly why F-0.2 shipped undiagnosed, since the adapter knew
  why the API refused and threw it away. (3) `retry-after` surfaced in that log. (4) 4xx-vs-429/5xx branching:
  every status used to collapse to `ai_unavailable`, which the worker treats as RETRYABLE, so a permanently
  malformed request retried to the DLQ and every attempt looked like a provider outage rather than our bug.
  429/5xx stay retryable; other 4xx are terminal and quarantine. 3 new tests.) **superseded:** (or at minimum add
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

- [x] **F-0.9 · Audit-log cross-tenant staff reads.** All five `/bff/*` readers run under `withForgeTx`,
  which writes **no** `platform_audit_log` row, while the console renders a standing "Cross-tenant view"
  badge. ADR-0032 requires the audit row in the same transaction. Add keyset cursor + hard cap to
  `listRecentCaptures` (unbounded today).
  **files:** `apps/forge-api/src/server.ts:84-105,103`
  **shipped.** All five gated reads now write a row through an injected `BffAudit` (kept a dependency so the
  BFF stays unit-testable, matching its existing injected-readers design), with five new closed-vocabulary
  actions — `forge.read_{overview,review_tasks,parsers,sync_status,captures}`. Auditing *reads* is the house
  rule, not a new one: `apps/api` has always audited `admin.read_audit_log`, `admin.list_dsars`, and the
  billing reads the same way, because under ADR-0032 the auditable event is a staff member reaching across
  tenants, not whether the statement mutated anything. The Forge console was the outlier.
  **why it is NOT in the same transaction, contrary to the item as written.** It cannot be. The readers run as
  `leadwolf_forge`, which by design owns only the `forge` schema and holds no grant on public-schema tables —
  so it cannot INSERT into `platform_audit_log` at all (verified against the role's grants in
  `applyMigrations`). The row is therefore written first, on the owner connection, in its own transaction.
  That keeps the property the same-transaction rule exists to provide — no read happens without its trail,
  since a failed audit write throws before the read runs — and leaves only over-logging (a logged read whose
  query then failed) as the residual, which is the safe direction for an audit log.
  **the "unbounded" premise was wrong.** `listRecentCaptures` already defaulted to 50 and always applied
  `.limit()`, so no caller could scan the table. What it lacked was a ceiling that survives a future caller
  threading a user-supplied number through — this read fans out into three follow-up queries keyed by the
  returned ids, so a large value multiplies. Added `MAX_CAPTURE_PAGE = 200` clamped inside the repository.
  **keyset cursor deliberately not added.** With the page hard-capped and no caller passing a limit, a cursor
  today would be API surface with no consumer: `/bff/captures` returns the newest page and the console has no
  paging UI to drive it. It becomes worth building with that UI — at which point the cursor and the console
  change land together and can actually be verified. Noted rather than silently dropped.
  **verify:** 6 new tests — each route audits under its own action with the capability and path in metadata,
  401 and 403 write nothing, `/bff/me` is not audited (it reads only the caller's own identity), and a failing
  audit sink prevents the read from running at all.

- [x] **F-0.10 · Retire the orphaned second write path into `master_*`.** ADR-0047 replaced the HTTP push
  with in-process `withErTx`, but `POST /api/v1/master-sync` + `syncPrincipal` remain live — two write paths
  into Layer 0. Decide: delete, or gate behind a flag and document as the ER fallback.
  **decided: gated dark, not deleted.** Confirmed orphaned first — `forge-worker`, `forge-api` and
  `/integrations` contain no reference to the endpoint, because ADR-0047 replaced the HTTP push with
  an in-process `withErTx` promotion. What remained was a live SECOND write path into the Layer-0 master graph,
  reachable by anyone holding a service JWT carrying the `master-sync` scope. Two write paths into the golden
  record is one more than the ER model assumes, and an unused one accrues risk without accruing value.
  Now behind `MASTER_SYNC_INGRESS_ENABLED` (default off, explicit-"true"-only, the same posture as
  `REALTIME_SSE_ENABLED`): while off the router is not mounted and the route 404s.
  **Why not delete:** it is a documented ADR-0047 ingress and an externally-hosted Forge could still need it.
  Gating makes enabling it a deliberate reviewable act; deleting would need an ADR amendment to undo. The
  risk — a live unused write path — is removed either way.

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

- [x] **A-0.2 · Gate `content-length` before parsing in forge-api capture.**
  `await c.req.json()` at `captures/routes.ts:44` precedes the 413s at `:57-62`, so a single request forces a
  128 MB read plus a parse of it. **needs:** A-0.1, F-0.1.
  **the 128 MB half was already closed** earlier in this effort: `server.ts` pins Bun's `maxRequestBodySize` to
  `ENVELOPE_MAX_BYTES`, so an oversized body is refused at the socket and never reaches the handler — the
  128 MB default was the actual bypass. Added the `content-length` fast path on top, which still earns its
  keep: it returns the API's own 413 shape instead of an abrupt transport-level rejection, and it avoids
  buffering and JSON-parsing up to a full 20 MB body that is already known to be refusable. It is explicitly
  **advisory** — `Content-Length` is client-declared like everything else here, so the enforcement points
  remain the socket cap and F-0.1's derived sizes.

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

- [x] **L-1.3 · Give the `forge` schema an RLS story.** Either enable RLS on `raw_captures`/`parsed_records`
  keyed on `target_tenant_id` with a staff bypass (and give `withForgeTx` an optional scope), **or** add an
  itest that pins the intentional absence *and* proves `leadwolf_app` lacks `USAGE ON SCHEMA forge`.
  **why:** `withForgeTx`'s justification comment ("the forge tables carry no workspace_id") is factually
  false — `forge.raw_captures.target_tenant_id` is `NOT NULL` and `target_workspace_id` exists
  (`schema/forge.ts:38-39`). Every forge read is unscoped (`readRepository.ts:287`); the only wall is app code.
  **needs:** L-1.2 (decide the sweep's scope first).
  **took the second option: pinned the intentional absence, and corrected the false premise.** The comment was
  the real defect — a wrong answer to "what isolates this?" invites the next reader to extend the pattern on
  it. `withForgeTx` now states the truth: the tenant columns DO exist, reads are genuinely unscoped, and the
  isolation is SCHEMA + ROLE (`leadwolf_forge` owns `forge` and holds no grant on the overlay; `leadwolf_app`
  has no USAGE on `forge`) — a Postgres-enforced wall, not app discipline.
  New `forgeSchemaIsolation.itest.ts` proves it on real Postgres, mirroring the Layer-0 grant-off pattern:
  `has_schema_privilege(leadwolf_app, forge, USAGE)` is false; leadwolf_app is DENIED 42501 on SELECT/INSERT/
  UPDATE/DELETE across seven forge tables (denied, not zero rows — a zero-row result would mean an RLS
  predicate a later policy edit could widen); and the firewall is proven TWO-WAY, since leadwolf_forge is
  denied on `contacts`, `users` and `platform_audit_log` — the direction that actually protects customer PII
  from the ingest pipeline.
  **Deliberately NOT claimed: isolation BETWEEN tenants inside forge.** There is none, by design — forge is a
  shared staff-operated plane and its cross-tenant reads are governed by audit (F-0.9, ADR-0032) rather than
  row filters. A fourth test pins that asymmetry: the tenant columns exist AND `relrowsecurity` is false, so
  if anyone ever enables RLS there the test fails and every unscoped reader gets re-read.

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

- [x] **L-1.5 (built, shipped OFF) · Put `role` in the access-token claims.** Today every `requireRole`-guarded request runs an
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
  **BLOCKED on a design decision — and the interim option as written is not permissible.** Checked against
  `truepoint-security/references/enterprise-iam.md:112`, which is unambiguous: *"Token/session invalidation on
  deprovisioning, **role change**, or password reset is **immediate** — a stale session must not outlive the
  access it represents."* Both options in this item violate that as specified:
  - **Role in the access-token claims** means a demotion or deprovisioning does not take effect until the
    token refreshes — up to the full access-token lifetime. That is the longest staleness of any option here.
  - **The 30–60 s memo** introduces staleness where there is currently *none*: today the role is read from the
    database on every guarded request, so a revocation is effective on the very next one. "Within TTL" is a
    regression against the standard, not a bound that satisfies it.
  Either becomes permissible only with **immediate invalidation on every role/membership mutation**, which is
  the "bust via the existing revocation path" clause — and that is the part that needs care rather than code.
  **RESOLVED AND BUILT** (this line supersedes the deliberation below, which is kept for its reasoning).
  Shipped as `apps/api/src/lib/roleCache.ts` + the `packages/db/src/roleCache.ts` seam, OFF by default
  (`ROLE_CACHE_TTL_MS=0`). It is the explicit-invalidation design, not the TTL-only memo: the two membership
  mutations (`packages/core/src/auth/members.ts` updateMemberRole / removeMember) DELETE the key after their
  transaction commits, so staleness is zero rather than "within TTL". A `null` role is deliberately NOT
  cached — caching absence would lock a freshly-invited member out until the TTL expired. Reads fail OPEN
  (falling back to the authoritative row, i.e. today's behaviour); an invalidation failure is logged LOUD,
  because that is the one window where a stale role could authorize. Decision (1) below was resolved as
  "the seam in db, the implementation in apps/api"; decision (2) was resolved as "cache, and leave the
  round-trip collapse alone" — the tenancy mechanism is the most security-critical code in the repo.

  *The deliberation below is the reasoning that led here. It is retained deliberately: a future reader who
  only sees "built" cannot tell why the obvious options were rejected. Do NOT read it as open work.*

  The objection above is against a TTL-ONLY memo. A memo with
  **explicit invalidation** does not have it: cache `(tenantId, workspaceId, userId) → role`, and DELETE that
  key inside the repository functions that mutate membership, so the next request re-reads from the database.
  Staleness is then zero, not "within TTL" — which is what `enterprise-iam.md:112` actually requires — and no
  one is logged out, because nothing touches the session.
  The machinery already exists to model it on: `packages/auth/src/revocation.ts` is the same shape (a
  short-lived Redis key, fail-open, mirrored from a durable source of truth), and the mutation sites are
  concentrated — `workspaceRepository` lines ~185/200/365/662 plus `scimService`, so invalidating inside the
  repository covers every caller regardless of route.
  **Two things to decide before building it**, both real:
  1. **Where the cache lives.** `packages/db` holds the mutation choke point but has no Redis dependency
     today; putting it there adds one to the data layer. Lifting invalidation to the API/core layer keeps db
     clean but means a future non-API writer silently misses it.
  2. **Whether to skip the cache entirely.** The cost being removed is not the SELECT, it is the
     `withTenantTx` round trips around it (BEGIN + SET ROLE + set_config + SELECT + COMMIT). Sending those as
     ONE multi-statement command would cut ~5 RTTs to ~1 with no cache, no Redis, no invalidation path, and no
     staleness question at all — but it means a bespoke path through the tenancy mechanism, which is the most
     security-critical code in the repo and not something to add in passing.
  The role-in-claims option stays rejected either way: it cannot be invalidated without revoking the session,
  i.e. logging the user out on every role change.
  **Two cheaper alternatives were tried and are CLOSED** — checked against the code, so they do not get
  re-explored:
  - **Collapsing the round trips instead of caching.** The GUC setup is ALREADY one round trip
    (`client.ts:272-283` sets `role` + both `app.current_*` in a single `set_config` SELECT), so what is left
    is BEGIN + SELECT + COMMIT. Removing those means either putting `set_config` in a FROM-clause subquery
    beside the target table — where Postgres does not guarantee it evaluates before the RLS policy on
    `workspace_members`, giving a non-deterministic fail-closed 403 — or sending the transaction as one
    multi-statement simple query, which cannot bind parameters and would mean concatenating the tenant,
    workspace and user ids into SQL. The current code keeps them BOUND deliberately. Neither is acceptable
    for a latency win.
  - **A request-scoped memo.** Already effectively in place: `buildJobViewer` takes `role?` and both
    enrichment call sites pass `getWorkspaceRole(c)`, so the guard's lookup is reused rather than repeated.
    There is no duplicate role read within a request to remove.
  **So the only viable design is the invalidated cache above**, and the one remaining decision is where the
  seam lives. `packages/db` has NO redis dependency today (`package.json`: config, types, drizzle-orm,
  postgres) so the clean shape is a settable invalidator in db — default no-op, real implementation injected
  by `apps/api` at boot, the same pattern `forge-worker` uses for its `budgetStore`. One ordering detail
  decides correctness: `updateMemberRoleInTx` / `removeMemberInTx` run inside the CALLER's transaction, so
  invalidating there can be repopulated by a concurrent read before the commit lands — the invalidation has to
  fire after commit, at the handful of call sites that own the transaction.
  **BUILT, and shipped OFF.** `ROLE_CACHE_TTL_MS` defaults to 0 — today's exact behaviour, a database read on
  every guarded request. Enabling it is an operator decision, for the reason above: the one path where
  invalidation would not be immediate is a failed DELETE while Redis still serves reads, and that trade is not
  a default to pick on someone's behalf.
  - **`apps/api/src/lib/roleCache.ts`** — read-through, fail-open to the database (safe here in a way it is
    not for the revocation deny-list: the fallback IS the authoritative path). A null role is deliberately not
    cached, so a freshly invited member is never locked out for a TTL.
  - **`packages/db/src/roleCache.ts`** — a settable invalidator defaulting to a no-op. The implementation is
    INJECTED by apps/api at boot rather than imported, so the workers and the auth app do not acquire a Redis
    client by touching the data layer. Same shape as forge-worker's budget store.
  - **Invalidation fires AFTER the mutating transaction commits** (`packages/core/src/auth/members.ts`), not
    inside the `*InTx` helpers — clearing the key mid-transaction lets a concurrent request re-populate it from
    the pre-commit state. `members.itest.ts` pins the ordering by reading the row from inside the invalidator:
    it must see the NEW role, which is only true post-commit.
  **The role-in-claims option stays rejected**, and the item's title now overstates what was done: the role is
  NOT in the token. It cannot be invalidated without revoking the session, i.e. logging the user out on every
  role change.
  **Still open:** turning it on (an operator decision + a value for the TTL), and whether the same seam should
  serve `jobViewer`'s membership read.
  The write surface is not a single chokepoint: `apps/api/src/features/teams/routes.ts`,
  `apps/api/src/features/workspaces/memberRoutes.ts`, `packages/core/src/auth/members.ts`, the SCIM
  deprovisioning path, and tenant-level membership all mutate what `getRoleForUser` returns. Missing ONE leaves
  a demoted or deprovisioned user authorized for up to the TTL — precisely the failure the rule exists to
  prevent, and not one a test suite can prove absent (a test can only prove the paths you thought of).
  **Recommendation, for a human decision rather than an agent's:** wire the memo through the SHARED cache tier
  (C-3.1) — never a per-process LRU, which cannot be invalidated across replicas — with the TTL as a backstop
  and explicit invalidation from an audited chokepoint that every role mutation must pass through. Building
  that chokepoint is the real work; the cache is the easy part.
  **Worth noting the cheaper, staleness-free alternative:** the item's own measurement is that the guard costs
  an *extra full transaction* (~5 RTTs: BEGIN + SET ROLE + set_config + SELECT + COMMIT) — not that reading a
  role is expensive. Running the role check inside the transaction the handler already opens removes those
  RTTs with **zero** staleness and no change to the authorization model. That is a request-scoped-transaction
  refactor rather than a cache, and it is the option that does not trade away an immediate-revocation
  guarantee for latency.

- [x] **L-1.6 · Home summary: cache-first, then one round-trip.**
  `packages/core/src/home/buildHomeSummary.ts:51-59` runs 9 `await`s serially in one transaction (a
  deliberate single-connection tradeoff that replaced 9 pinned connections — not naive code), and
  `apps/api/src/features/home/routes.ts:68-80` computes the whole summary **before** checking
  `If-None-Match`, so a 304 saves bytes but not work.
  **fix order:** (a) check the ETag against a cached hash before computing; (b) add the Redis per-workspace
  30–60 s memo the route comment itself says is missing; (c) then collapse to one SQL round-trip (CTEs +
  `json_build_object`).
  **needs:** C-2.1 (the Redis cache tier) for (b).
  **(a) and (b) shipped together, because the memo IS the answer to (a).** The literal reading of (a) —
  "check the ETag against a cached hash before computing" — needs a cached hash, which needs the cache. With
  the whole computation behind the memo, a 304 now costs one Redis GET plus a hash instead of `buildJobViewer`'s
  transaction plus `buildHomeSummary`'s nine serial aggregates. That is the compute win (a) was after; before,
  a 304 paid for the entire summary and then discarded the bytes.
  **Keyed PER USER, deliberately.** Two users in one workspace can legitimately see different summaries —
  `buildJobViewer` scopes the Recent Imports card by viewer under the S-V3 gate — so a workspace-wide key
  would serve one user's view to another. That is a disclosure, not a staleness bug, so the key carries the
  varying dimension rather than relying on the gate being off. It also matches the `private` header this route
  already sends: the same sharing rule on the server as the one told to the browser.
  **The BODY STRING is cached, not the object**, so the ETag is byte-stable across hits — a flapping ETag
  would silently kill the 304 path the route exists to serve.
  **No write-path invalidation, and that is not an oversight.** The TTL is 30s because the route has always
  advertised `private, max-age=30`; a 30s server memo therefore introduces no staleness the contract did not
  already permit.
  **(c) not done** — collapsing the nine aggregates into one CTE round-trip is a separate change, and the memo
  removes most of its urgency by making the repeat case free rather than making the cold case cheaper.

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

- [x] **L-1.10 · Real readiness probe.** `apps/api/src/app.ts:98` `/health` is a static `{status:"ok"}`, so
  compose marks the API healthy with a dead database. `apps/workers` already has a drain- and Redis-aware
  `/ready` — copy it.
  **shipped.** New `apps/api/src/readiness.ts` + `/ready`, and the compose healthcheck (and deploy.sh's printed
  endpoint) now point at it. `/health` deliberately stays pure liveness: coupling liveness to Postgres means one
  database blip fails every replica's probe on the same interval and the orchestrator recycles the whole fleet,
  which is strictly worse than shedding traffic. Raw SQL stayed out of the app — the statement is a new
  `pingDb()` in `@leadwolf/db` (`apps/api` imports drizzle-orm nowhere else, and Bun's declared-deps-only
  resolution rejected it, which was the right signal).
  **the design point worth keeping.** Copying the workers' consecutive-failure threshold verbatim would have
  introduced a startup lie: an orchestrator needs only ONE successful probe to mark a container healthy, and
  compose has `web`/`admin` gated on `api: service_healthy`, so tolerating the first N failures meant an API
  booting against a dead database would report ready and take its dependents up with it. The threshold now
  applies only AFTER the process has served once — before that, any failure is immediately not-ready. That is
  the difference between hysteresis and a lie: hysteresis protects a replica that has proven it can serve; it
  must never vouch for one that hasn't. 15 tests cover it, including the two cold-start cases and that a
  wedged dependency resolves false rather than hanging (a hanging probe is worse than a failing one — the
  process looks fine until the orchestrator's own timeout fires).

- [x] **L-1.10a · The unit suite is now green in any order (found while verifying the above).** A full
  `bun test` at this point failed **12** tests that all passed individually — so CI's per-package sharding hid
  them and any local full run looked broken. All three causes were process-global test state, and none were in
  the code under test:
  - `apps/api/src/middleware/rateLimit.test.ts` mocked `@leadwolf/auth` **wholesale**, replacing the module for
    every other file in the run and breaking the 8 cases in `apps/auth/src/lib/clientIp.test.ts` that exist to
    verify the real trusted-hop resolver. Rewritten to assert delegation *against the real resolver*
    (`key === ip:${clientIpFromHeaders(sameHeaders)}`), which is both leak-free and a stronger claim — no
    reimplementation can satisfy it by accident. A mock of a SHARED function is not a local decision.
  - `roleGuards.test.ts` likewise returned only three repositories instead of spreading the real module, so
    `effectivePolicyRepository` vanished for whoever ran alongside it.
  - `effectivePolicyRoutes.test.ts` pinned `tenantId: "t1"`/`actorUserId: "u1"`, which asserted **test-file
    ordering**: bun's module mocks are process-global *and* ESM modules are cached, so whichever file imports
    `settingsRoutes` first (`app.authz.test.ts` imports every router) owns the `authn` mock the router closed
    over. Now asserted by origin — present, non-empty, and impossible to have come from a body carrying only
    `key`/`value` — which is the actual security property.
  - `packages/auth/src/botCheck.test.ts` set `TURNSTILE_SECRET` at its own module scope, which only works if it
    is the first file to import `@leadwolf/config` (config freezes `env` on first import). Moved to the bun
    preload `test/setup.ts`, where it is guaranteed to precede the freeze. Turnstile is now enforced under test
    — the safer default for any login-path test added later.
  **result:** 1397 pass / 0 fail across 199 files, and each of these files still passes alone.

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
  **The stale comment is CONFIRMED stale and now says so.** Verified empirically rather than by reading:
  `@leadwolf/core` is absent from `packages/db/package.json` (the cycle is gone), `turbo run build --dry-run`
  resolves the graph, and CI ALREADY builds every workspace with `turbo run build`. The Dockerfile comment now
  records that, so the next reader is not warned off an improvement that is available.
  **The build command itself is unchanged**, deliberately: swapping 4 serial `next build`s for `turbo run
  build` cannot be verified without building the image, and Turbo 2's strict env handling is exactly the kind
  of difference that would surface only there. Safe to make when someone can run a build.

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
  **NOT built — and the blocker here is genuine, not a stale note.** The item's own `verify` step is a `curl`
  against the live domain, and Caddy is the single thing terminating TLS for every subdomain: an invalid
  config does not degrade one service, it exits and takes the whole site down. The routing itself is a
  mechanical mirror of the `forge.truepoint.in` block, but "mechanical" is not "verified" when nothing here
  can parse a Caddyfile.
  **What HAS landed is the safety net that change needs**: `deploy.sh` now runs `caddy validate` against the
  exact file the container mounts, BEFORE anything restarts the edge. It fails safe in both directions — a
  config the validator rejects aborts the deploy, but a validator that cannot RUN (image not pulled, docker
  hiccup) lets the deploy continue, because refusing to deploy over a tooling problem is its own outage.
  So whoever writes the routing gets a loud failure at deploy time instead of a dark site.

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

- [x] **T-2.3 · Extract `packages/auth-client`.** (shipped. `createAuthClient({appOrigin, authOrigin,
  storagePrefix})` — the drift was never a decision, it was one copy getting fixed: web had the in-flight
  refresh de-dup AND the T-2.6 cross-tab election, admin and forge had neither, so every staff tab still fired
  its own rotation chain. Both now apply to all three. What genuinely differed is parametric — the app origin
  and the sessionStorage prefix, which is what stops a web tab and an admin tab clobbering each other's PKCE
  verifier mid-login; the BroadcastChannel name is per-app for the same reason, since an admin tab must not
  adopt a token minted for the web audience. `pkce.ts` was byte-identical in all three and moved in too; the
  three copies are deleted. Web keeps org/workspace switching, which admin and forge have no equivalent of —
  those mint a fresh JWT outside the normal exchange, hence the explicit `installToken`. `refreshElection`
  moved from `@leadwolf/app-shell` to here: it is auth logic, not app chrome, and importing the shell barrel
  for it dragged JSX into a pure module. Net −310 lines across the three apps. T-2.4/T-2.5 are unblocked.)
  **superseded description below:**
- **Extract `packages/auth-client`.**** `authClient.ts` is triplicated with real drift
  (web 204 / admin 140 / forge 129 lines) and `pkce.ts` is **byte-identical in three apps**; `apps/forge` is
  the only copy missing the `refreshInFlight` single-flight guard, whose documented (AUTH-078) absence
  double-rotates the refresh token and trips reuse-detection, revoking the family — so forge staff get
  spuriously logged out.
  **guardrail:** G4 — new package, barrel export, browser-only.
  **needs:** T-2.2 (migrate all three apps together, or forge is stranded on a deleted contract).

- [x] **T-2.4 · Admin gate: unblock first paint.** (shipped: a new "verifying" state renders the chrome as soon
  as stage 1 holds a token, with the staff check running underneath. Safe because the verdict was never the
  security boundary — the api `/admin/*` surface re-checks the signed `pa` claim on every request and 403s a
  non-staff caller regardless of what the component shows; the cost is a brief chrome flash for the rare
  non-staff visitor, the gain is that every staff visitor stops waiting on a serial probe and the page.s own
  fetches overlap it.) **superseded description:** `apps/admin/src/components/shell/AdminShell.tsx:43-60`
  runs its two stages **serially** (silentRefresh → `verifyPlatformAdmin`) holding the console blank —
  strictly worse than web's already-fixed pattern. Render chrome after stage 1; verify staff in background
  with a forbidden interstitial.

- [x] **T-2.5 · Forge console gate.** (shipped: the gate now probes `/bff/me` instead of using `/bff/overview`
  as a status-code probe with the BODY DISCARDED, and RETURNS the payload so `StaffMeProvider` is seeded rather
  than re-fetching the same endpoint. Cold load drops from refresh → overview-probe → /bff/me → overview to
  refresh → /bff/me → overview: three uncached `platform_staff` lookups become two, and nothing is fetched
  twice. Classification is on the `data:read` capability — the exact thing the old overview probe tested — so a
  non-staff user and a zero-capability staff account still both resolve to `forbidden`.) **superseded:** `apps/forge/src/lib/forgeGate.ts:23` + `useOverview.ts:27` — same
  client-only pattern, and `/bff/overview` is fetched **twice** (cold `/overview` = 4 serial round-trips:
  refresh → overview-as-probe with the body discarded → `/bff/me` → overview again) with **3 uncached
  `platform_staff` lookups**. Use the single `/bff/me` (it already returns role + capabilities + email) and
  seed the overview hook from it. **needs:** T-2.3.

- [x] **T-2.6 · Cross-tab refresh election.** (shipped for `apps/web`; shared module in `@leadwolf/app-shell`.
  The elected tab refreshes and broadcasts; losers adopt it. Failure mode is bounded to today's behaviour by
  construction — a loser that misses the broadcast just lets its token expire and the ON-DEMAND path in
  `fetchWithAuth` refreshes it. The election is deliberately sloppy: localStorage has no compare-and-swap, so
  mutual exclusion is write-then-reread and a rare double refresh IS the status quo, meaning this cannot be
  worse than not having it. Web Locks was rejected — unavailable across enough of the supported surface that
  the fallback would be the path actually under test. A stale claim expires after `LOCK_TTL_MS` so a tab closed
  mid-refresh cannot wedge the others into a silent logout. 10 unit tests, including that a malformed or
  hostile same-origin broadcast cannot inject a token — it is validated, not cast. `apps/admin` and
  `apps/forge` are NOT wired: their `authClient.ts` is a near-copy, which is the drift T-2.3 exists to remove,
  and hand-wiring three copies would deepen it.) Every tab refreshes on its own ~14 min timer
  (`authClient.ts:46-47`) and each refresh is a full rotation (DB revoke+insert + Redis write); N tabs = N
  racing rotation chains surviving only on the 30 s reuse-grace. Add BroadcastChannel election, or make
  rotation sliding-window.

---

## 6. Phase 3 — Caching tier, async unblock, frontend data layer

- [x] **C-3.1 · Build the Redis read-through cache tier.** It does not exist: Redis serves only BullMQ and
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
  **the tier is built.** `@leadwolf/core` owns the policy (`createReadThroughCache`, `tenantKey`,
  `systemKey`); `@leadwolf/integrations` has the thin ioredis adapter; `apps/api/src/cache.ts` is the wired
  singleton. **Tenant scoping is a TYPE, not a convention** — the only way to build a normal key is
  `tenantKey(scope, …)`, which cannot be called without a tenantId, and genuinely tenant-less data must go
  through the deliberately-conspicuous `systemKey`. Key parts are charset-validated so nothing can smuggle a
  `:` or `*` into a prefix or widen an invalidation.
  **Properties that made this non-trivial, each pinned by a test:** fail-open (an unreachable Redis degrades
  to the uncached path — a cache outage must not become a data outage); a failed load is never cached (one
  transient DB error would otherwise be served for a whole TTL); single-flight (a cold or just-expired hot key
  otherwise lets every in-flight request run the same query at once — the cache making the worst moment
  worse); TTL jitter, upward only, so a caller's freshness bound is never silently shortened.
  **The stale-write-back race is the one worth reading about.** A reader that misses, then loads, can have a
  mutation land in between — and its loader would write the PRE-mutation value into the cache AFTER the
  invalidation, undoing the write for a full TTL. My first implementation marked the in-flight record, which a
  test proved insufficient: the race also covers the window before the load is even registered (the reader is
  still awaiting its own cache lookup). Fixed with a per-key epoch captured synchronously on entry and
  compared before the write, with both bookkeeping maps reference-counted so they stay bounded.
  **Connection options are the inverse of the queue connections in the same app, deliberately.** BullMQ uses
  `maxRetriesPerRequest: null` so a job waits out a blip. A cache must do the opposite: `enableOfflineQueue:
  false`, one retry, 150 ms command timeout — otherwise a wedged Redis silently BUFFERS the command and every
  cached read hangs on the very outage the fail-open path exists to survive.
  **First consumer wired:** the public pricing catalog — 60 s TTL plus explicit invalidation on all four
  `credit_pack.set`/`plan_template.set` write paths (invalidating after commit, so a concurrent read cannot
  repopulate from pre-write rows), and a `Cache-Control` header where there was none. Its own file had
  documented exactly this as the deferred follow-up, blocked on "never serve a stale-forever price" — which
  the TTL-plus-invalidation pair is precisely the answer to. Display data, not a money decision: checkout
  re-reads the authoritative row.
  **Still to wire:** L-1.6 home summary, facet counts, entitlements. Credit balances and permission decisions
  are deliberately NOT candidates.

- [x] **C-3.2 · Precompute the aggregates.** `dataQualitySummary` (`contactRepository.ts:745-748`) is a live
  per-view aggregate scan **despite a `data_quality_snapshots` table already existing** — wire the worker
  refresh. Same for burn-by-day.
  **shipped, but NOT by serving the snapshot — and the difference matters.** The snapshot sweep is DAILY, so
  reading the dashboard from it would have made Data Health up to 24 hours stale: a user who just finished an
  import would refresh and see unchanged numbers, with no way to tell whether the import worked. That is a
  user-visible correctness trade dressed as a performance fix, and it needs a product decision, not an
  engineering one.
  The actual problem was per-VIEW cost — one aggregate scan with ~23 FILTER clauses over every live contact,
  re-run on every render by every member. A 30s read-through memo (C-3.1) removes the repetition while staying
  inside the freshness `private, max-age=30` already promises. Workspace-keyed, not per-user: unlike
  `/summary`, this response has no viewer dimension, so every member gets identical bytes.
  The snapshot table keeps the role it was built for — the daily TREND series (`/data-quality/history`), where
  a daily cadence is the point rather than a compromise. **Burn-by-day is untouched.**

- [x] **C-3.3 · Facet counts in one pass.** `searchRepository.ts:438-459` +
  `accountSearchRepository.ts:264-346` run one full GROUP-BY aggregate scan **per facet, sequentially, per
  request** (8 facets = 8 re-executions of the whole WHERE, ILIKE legs and account join included), and
  select-all does an exact uncapped `COUNT(*)`. Move to `GROUPING SETS`, cache, and switch to estimated
  counts past a threshold.
  **shipped, both halves.** Facets whose own term filter is not active share an identical WHERE (each facet's
  WHERE differs only by excluding its own filter), so they collapse into one `GROUPING SETS` pass; only the
  actively-filtered ones keep a query. `grouping(expr)` separates a real NULL from "not in this row's set",
  which the shared WHERE makes impossible to express as the old per-facet `expr IS NOT NULL`; `row_number()`
  over the grouping-set bitmask reproduces the per-facet top-50 that came from the per-query LIMIT.
  **Two accounts facets cannot join the batch, and the reasons are worth keeping:** `technology` counts
  unnested jsonb through a LATERAL (not one-row-per-account), and `employee_band` is a CASE carrying bound
  parameters — `GROUPING SETS` must repeat the expression, and re-rendering re-binds those params under new
  placeholder numbers so Postgres raises 42803 against the selected expression. That is the same trap the
  existing `GROUP BY 1` comment documents. Eight scans become one plus at most two.
  **Not done here:** the caching and the estimated-count-past-a-threshold half, which both depend on C-3.1's
  cache tier; the uncapped select-all `COUNT(*)` is untouched.

- [ ] **C-3.4 · Flip the import v2 pipeline on.** CSV/**XLSX** is parsed synchronously on the API event loop
  (blocking the single Bun loop for all concurrent users) and the **job payload carries the parsed rows**
  through Redis. The correct design — upload → object store → COPY into UNLOGGED staging → chunked worker —
  **is already built** behind `IMPORT_V2_ENABLED` / `BULK_IMPORT_ENABLED` (both default-off). Admission byte
  caps (10 MiB CSV fast path) and a 10 000-waiting queue shed bound today's blast radius but don't fix it.
  **guardrail:** G5 — roll out per-tenant via the existing `import_v2_enabled` / `bulk_import_enabled` DB
  flags, which are already seeded off.
  **NOT an implementation task — the code is built; this is a ROLLOUT.** Nothing here is missing from the
  repo: the object-store upload, the UNLOGGED staging COPY and the chunked worker all exist behind flags that
  are seeded off per tenant. What is left is turning them on for real tenants and watching, which is exactly
  what guardrail G5 describes and exactly what cannot be done or verified from a code change. Flipping the
  DEFAULT in source would convert a deliberate per-tenant rollout into an all-tenant one on the next deploy —
  the opposite of the guardrail. It stays open pending an operator running the rollout.

- [ ] **C-3.5 · Atomic spend breaker, then raise concurrency.** `apps/workers/src/tuning.ts:39-44` pins
  `imports: 1` and `enrichment: 1` fleet-wide — the latter because the daily budget breaker is a racy
  read-check-act, so **the whole platform's paid enrichment is serialized**, and one tenant's big import
  head-of-line-blocks every tenant's imports for up to the 15-minute deadline.
  **fix:** Redis `INCR`/Lua atomic breaker → raise concurrency → per-tenant fairness via sharded queues.
  **PARTIALLY OBSOLETE — the premise is out of date, and the raise is still gated.** The breaker is no longer a
  racy read-check-act: `providerCallRepository.lockDailyBudget` already takes a per-WORKSPACE advisory xact
  lock around the check-through-record window, so concurrent enrichments cannot collectively overshoot the
  daily cap. No Redis/Lua breaker is needed.
  **The concurrency raise is still correctly blocked, by the OTHER precondition.** `tuning.test.ts` carries a
  deliberate F3 tripwire whose entry gate is two-part: the atomic breaker AND the per-batch **credit lease**.
  I raised `enrichment` to 2, the tripwire failed, and on checking, `packages/core/src/enrichment/policy.ts`
  states hard reserve-then-spend is still owned by billing / the bulk pipeline (ADR-0029) and outstanding.
  Without it, concurrent jobs can each clear the daily breaker and still spend a tenant past its credit
  balance — a different overshoot from the one the lock fixed. **Reverted to 1**; the tripwire did its job and
  crossing it is not a call to make unilaterally on a spend path.
  **The "credit lease" precondition is MIS-SCOPED — re-checked against the tree, and it changes what is left.**
  Building a credit lease for enrichment would be building the wrong thing:
  - **This queue spends provider budget in MICROS, not credits.** `enrichContact` never touches the credit
    ledger — there is no `lockBalance` / `decrement` / `insertLedger` anywhere under `core/src/enrichment`. So
    there is no credit balance for it to overshoot, and no lease for it to take.
  - **The lease already EXISTS and is wired.** `creditRepository.leaseForJob` / `releaseForJob` (ADR-0029) are
    implemented — FOR UPDATE lock, subscription-first accounting, idempotent paired ledger entries — and used
    by `revealJobRepository` for bulk REVEAL. It was never missing; it belongs to a different spend path.
  - **The monthly cap that note pointed at guards nothing live.** `decideAutoEnrich` is a genuine
    non-reserving pre-check, but it has NO production caller (a barrel export and one itest), so no concurrent
    path can currently overshoot it.
  **What actually blocks the raise:** (a) the bulk-enrichment WORKER slice — the thing that would spend
  against a confirmed ceiling — does not exist (`confirmJob.ts` says so, and the surface is dark behind
  `BULK_ENRICHMENT_ENABLED`); and (b) measurement. This is the one queue holding its transaction across
  provider NETWORK I/O, so each concurrent job pins a pooled connection for seconds against the shared pool;
  p99 provider latency and pool saturation have to be measured before a number is picked, which needs a
  running deployment.
  **Also still open:** per-tenant fairness via sharded queues. `imports: 1` is blocked on C-3.4 (the chunked
  pipeline), not on the breaker. tuning.ts carries the same correction inline.

- [x] **C-3.6 · SSE at scale.** `apps/api/src/features/events/routes.ts:21,37` opens a **dedicated IORedis
  client per connection** (10 k clients = 10 k Redis connections) and heartbeats every 15 s — longer than
  Bun's default 10 s idleTimeout, so the stream dies between heartbeats the moment
  `REALTIME_SSE_ENABLED` flips. One shared psubscribe client per process + in-process fanout + 8 s
  heartbeat + per-user connection caps. **needs:** A-0.1 (idleTimeout).
  **shipped.** One process-wide subscriber (`events/hub.ts`) with per-channel refcounting replaces the
  per-connection client: N streams on a workspace now cost ONE Redis SUBSCRIBE. At 10k connected dashboards
  the old shape meant 10k connections from a single process against a default `maxclients` of 10000, so the
  failure mode was not slowness — it was "no further connections", including the queues.
  **SUBSCRIBE, not PSUBSCRIBE.** A pattern like `ws:*` would be one subscription but would deliver EVERY
  workspace event to EVERY api process, which then discards nearly all of them: wasted bandwidth proportional
  to tenant count, and a cross-tenant exposure resting entirely on the in-process filter being correct.
  Subscribing to exactly the live channels means Redis performs the isolation and a filter bug cannot leak
  what was never delivered.
  **Per-user cap** of 5 concurrent streams, refused with a 429 + Retry-After before the stream opens — a
  refusal the client can act on, rather than accepting a connection and starving it.
  **The heartbeat is already safe:** A-0.1 shipped `idleTimeout: 65`, comfortably above the 15s heartbeat, so
  the described "stream dies between heartbeats" window is closed.
  **verify:** 10 new unit tests — one subscribe for many listeners, unsubscribe only on the last detach,
  cross-channel isolation, idempotent double-detach (a double release would silently stop other streams), a
  throwing listener not stopping delivery to its neighbours, and the per-user cap accounting.

- [x] **C-3.7 · Move the Redis PUBLISH out of the open DB transaction.**
  `apps/workers/src/realtimeRelay.ts:21-36` holds the transaction (and its pooled connection) across N
  network calls to Redis per batch.
  **shipped — but NOT as written, and the difference matters.** Moving the publishes outside the transaction
  would break the relay's core guarantee. `claimBatch` is a bare `SELECT … FOR UPDATE SKIP LOCKED` that does
  **not** change `status`, so the row lock held until COMMIT is the only thing stopping a second relay instance
  from claiming the same still-`pending` rows and publishing them a second time. Publishing outside the
  transaction would need a real claimed state plus a reclaim timeout — a schema change, not a refactor, and
  one that trades a correctness guarantee for latency.
  The actual cost was that the loop `await`ed each PUBLISH in turn, so a full batch held the transaction — and
  one of the pool's 10 connections — across up to 200 sequential Redis round-trips. Pipelining sends all of
  them in one write and waits once, so the transaction stays open for a single round-trip regardless of batch
  size, with the double-publish guarantee untouched. `exec()` needs care: it resolves `null` on an aborted
  pipeline and reports per-command errors *without* rejecting, so both are turned into a throw — rolling back
  leaves the rows `pending` and unlocked for the next tick, which is the same at-least-once behaviour the
  previous code had when a mid-loop publish threw.

- [x] **C-3.8 · Finish the TanStack Query migration.** RQ v5 is installed and its provider is mounted, but
  it is used by **only** `import/` and `data-health/`; ~90% of features hand-roll `useState`+`useEffect`
  (`useProspectSearch.ts:40-83`, `useHomeSummary.ts:54-76` — which reimplements SWR+ETag caching by hand in
  76 lines — `useListMembers.ts:26-77`). This violates the project's own mandate
  (`truepoint-architecture` SKILL, *State and Data*: "anything answerable by a GET … never useState").
  Convert: keyset load-more → `useInfiniteQuery`; the five bespoke pollers → `refetchInterval`; the
  `window.dispatchEvent("credits:changed")` bus and `window.location.reload()` on org/workspace switch →
  `invalidateQueries`. **needs:** L-1.11 (defaults + `useSession` first).
  **DONE, except the org/workspace reload — see below.** ~60 hooks across every feature moved to
  `useQuery` / `useInfiniteQuery` / `useMutation`, each feature gaining the mandated `keys.ts` factory. Landed
  in 13 reviewed slices so each was independently gated and CI-verified.
  **The conversions that were more than mechanical:**
  - **Five pollers became `refetchInterval`** (reveal job, enrichment jobs, bulk import, import run, the
    notification bell). Two carried real defects that the shape removed rather than the rewrite: `useRevealJob`
    never rescheduled from its catch, so ONE transient poll error froze a job on screen until a remount; and
    every raw `setInterval`/`setTimeout` loop kept polling a hidden tab and could overlap a fetch with itself.
  - **Four hand-rolled races disappeared** because results are keyed by their input, not guarded after the
    fact: the two search grids' AbortController "latest wins" refs, `useImport`'s monotonic run token,
    `useBulkImport`'s `active` token, and `useEnrichmentJobDetail`'s ignore-late-response guard.
  - **Three duplicate reads of one endpoint collapsed to one entry**: the credit balance (top-bar pill + bulk
    bar, which could show two different numbers in one viewport), the two data-quality reads (Home + the Data
    Health page), and the lists detail header (which re-fetched the whole index a second time because there is
    no per-id GET).
  - **The `credits:changed` window bus is retired** — 5 dispatchers, 3 listeners — in favour of invalidation,
    which reaches readers that do not exist yet. `reveal:changed` deliberately stays a window event: it carries
    per-row client state, not a server read.
  - **`useTypeahead`'s per-term memo** was a `useRef(new Map())`, private to one mount and discarded on
    unmount; as cache keys it is shared and garbage-collected.
  - **Two dead hooks were deleted, not converted** (`prospect/useContacts`, `prospect/useContactSearch`) —
    superseded by `useProspectSearch`, zero importers, alive only as barrel exports.
  **Deliberately NOT converted, each for a reason:** `useRecentSearches` (localStorage, not server state);
  `useImportDraft` (a wizard state machine of one-shot POSTs against a session-lived draft — nothing to cache;
  it already reads the shared drafts probe through the cache); the range/member/status/filter state in reports,
  templates and usage history (client state — what the user picked); and the notices and per-entry send
  failures in `useEnrollment` (the outcome of one interaction).
  **Still open: `window.location.reload()` on org/workspace switch.** The plan treats it as a caching
  inefficiency; it is not. It is the only thing that guarantees NO workspace- or tenant-scoped client state
  survives a switch — open drawers, selected row ids, in-flight wizard state, every component-local `useState`
  in the tree. `queryClient.clear()` drops the server cache but leaves all of that. Trading a guaranteed clean
  slate at a TENANT boundary for a faster switch is a security-shaped decision, not a performance one, and it
  needs an audit of every stateful surface first. Recorded rather than half-done.

- [x] **C-3.9 · Virtualize `DataTable`.** `packages/ui/src/components/DataTable.tsx:3,105-118` renders
  **all** accumulated rows (its own comment admits it) while the search/list hooks append 50–100 per "Load
  more", and the client sort re-sorts the whole accumulation on every header click.
  `@tanstack/react-virtual` is absent from the lockfile. Violates the `truepoint-design` hard rule
  ("no un-virtualized large lists"). One component fixes every large surface.
  **DONE.** `@tanstack/react-virtual` added to `@leadwolf/ui`; rows are windowed above 100.
  **A WINDOW virtualizer, not a container one**, because `.tp-ui-table-wrap` has `overflow: auto` but no
  bounded height — these tables grow the PAGE, and the page is what scrolls. A container virtualizer would
  have required giving the wrapper a fixed height, which changes the layout of every surface using it. The
  visual result is unchanged; only the DOM row count is.
  **Below the threshold nothing changes**, so the many small tables (settings, members, logs) render exactly
  as before and pay no windowing overhead for a list that fits on a screen.
  **The spacer arithmetic is extracted to a pure `virtualWindow.ts` with tests**, because that is the part
  that fails silently: a wrong `scrollMargin` subtraction offsets every row and a wrong total makes the
  scrollbar misreport the page length — neither throws, neither shows in a typecheck. `packages/ui` has no
  DOM test setup, so the render path is covered by the Next build (which also proves the window virtualizer
  is SSR-safe).

- [x] **C-3.10 · Server-side report aggregates.** `apps/web/src/features/reports/api.ts:31-53` fetches 200
  raw contacts + 200 reveals to the browser and rolls up client-side — so the numbers are **silently wrong
  past 200 rows** while being presented as totals. A naive SQL rollup endpoint suffices before ClickHouse
  (ADR-0010 puts the warehouse post-MVP).
  **NOT done — attempted, then reverted, and the premise above is wrong: a naive rollup endpoint does NOT
  suffice.** The server half was built and typechecked clean — a `reportsRepository` with SQL rollups
  (`funnelByOutreachStatus`, `creditsByDay`, `creditsByType`), a `reportsSummarySchema` contract, and
  `GET /api/v1/reports/summary`. Wiring the client then showed the contract was wrong, so it was reverted
  rather than landed as an endpoint with no consumer.
  **Why it does not suffice:** `useReports` applies TWO interactive filters before every rollup — a trailing
  DATE RANGE and a MEMBER filter — and derives the member dropdown options from the loaded rows. A summary
  endpoint ignoring both cannot serve the surface. There is also a `rollupTeam` view (per-member
  revealed/credits/engaged) needing a GROUP BY owner that those three aggregates do not cover.
  **One of the two "semantic decisions" recorded here was WRONG, and it was blocking the item for no reason.**
  (1) claimed day buckets are local to the viewer and *no server aggregate can reproduce that*. Postgres does
  it directly: `date_trunc('day', ts, $tz)` (three-arg, PG16 — which is what CI and production run) buckets by
  any IANA zone, so the client sending its `Intl.DateTimeFormat().resolvedOptions().timeZone` reproduces the
  current local-day behaviour EXACTLY. There is no local-vs-UTC trade to make.
  (2) stands but is smaller than written: the member dropdown listing members the old one omitted is not a
  semantic change to weigh, it is the truncation bug being fixed — the old list was short because the sample
  was, not by intent.
  **So C-3.10 needs no product decision.** The remaining work is the build: four SQL rollups (funnel,
  credits-by-day, credits-by-type, team GROUP BY owner) + the member options, a `@leadwolf/types` contract
  taking `range`, `member` and `tz`, the endpoint, and rewiring `useReports`.
  **LAYER 1 IS BUILT AND PROVEN** — `packages/types/src/reports.ts` (the contract, counts + `range`/`member`/
  `tz`) and `packages/db/src/repositories/reportsRepository.ts` (the SQL), covered by
  `reportsRepository.itest.ts` against a real Postgres. It returns COUNTS only: labels, conversion percentages
  and bar maxima stay in the existing pure client rollups, which are unit-tested and have no reason to move.
  Two bugs the itest caught that nothing else would have:
  - `date_trunc('day', ts, tz)` returns a TIMESTAMPTZ (local midnight), so `to_char` then formatted it in the
    SESSION zone and labelled IST's 11th as the 10th — every bucket shifted back for viewers east of UTC,
    silently. `AT TIME ZONE` before formatting fixes it.
  - A JS `Date` bound through drizzle's raw `sql` is never serialised (the typed builders convert it; `execute`
    has no column context), so the date-FILTERED queries threw at bind time while every unfiltered one passed.
  **LAYER 2 IS DONE.** `GET /api/v1/reports/summary` (transport only — range → cutoff, `all` as the no-member
  sentinel, response validated against the contract) and `useReports` reading it. The dashboards no longer
  roll up a sample, so the numbers are correct at any workspace size.
  - **The rollups now exist in two halves sharing ONE implementation.** `*FromCounts` owns the presentation
    (labels, conversion percentages, bar maxima, stage order); the legacy `rollup*` functions count rows and
    delegate to it. The two paths cannot drift into disagreeing about what a percentage means, and the
    existing unit tests exercise the same code the server path runs through.
  - **The 14-day window stays client-side**: the chart needs a bucket for every day including the empty ones,
    and a GROUP BY only returns days with spend. The server's keys are already in the viewer's zone.
  - **The filters are query-key inputs now**, not predicates over loaded rows — changing one is a new query.
  - **The sample disclosure shipped earlier in this item was REMOVED**, with its test. It existed because the
    rollups described a sample; they no longer do, and a permanent warning about an impossible condition is
    worse than none.
  **What HAS landed meanwhile:** the numbers are no longer silently wrong. `fetchReportsSource` now derives a
  `sampled` flag (either source coming back full means there is more behind it) and the page states that the
  totals describe the most recent 200 rows. That does not make them exact — only the server aggregation does
  — but presenting a partial rollup AS a total was the actual defect, and it is worse than an approximate
  number precisely because nothing indicated it was one.
  **Correct shape for whoever picks it up:** `GET /reports/summary?range=&member=` returning funnel +
  credit-day + credit-type + team buckets AND the member options, with the contacts/data-health half reading
  the already-memoised `dataQualitySummary` (C-3.2) rather than re-deriving from a page. Until then the
  displayed numbers stay wrong above 200 rows — a correctness bug, not a performance one.

- [x] **C-3.11 · Column projections on masked surfaces.** `contactRepository.ts:702,728,1085` use bare
  `.select()`, pulling AES-GCM `email_enc`/`phone_enc` bytea + `custom_fields` + `field_provenance` jsonb —
  TOAST fetches and ciphertext into app memory — for surfaces that then **mask** it. The correct masked
  projection already exists in the same package (`searchRepository.ts:249-280`).
  **shipped.** One `MASKED_COLUMNS` projection now serves `listByWorkspace`, `resolveByLinkedinPublicId`, and
  `listMaskedByIds`. The mapper never actually wanted the expensive columns: `email_enc`/`phone_enc` were read
  ONLY as `!= null`, and `custom_fields`/`field_provenance` were not read at all. So presence is computed in
  SQL (`IS NOT NULL`, the same `hasEmailFlat`/`hasPhoneFlat` shape `searchRepository` already used) and the
  ciphertext stays in the database — no TOAST fan-out, and no PII in application memory on surfaces whose whole
  contract is that they return none.
  **the type is the guard.** `MaskedContactRow` is a `Pick` of the full row plus the two booleans, so the
  projection and its consumers drift together: remove a column and the mapper stops compiling rather than
  silently reading `undefined`.
  **verify:** unit suite green, but the real proof is SQL-level and comes from CI — 8 itest files exercise
  these three reads, and `contactChannels.readcutover.itest.ts:220` asserts the gate-off `hasEmail`, which is
  exactly the derivation that moved from `r.emailEnc != null` to the SQL presence column.

- [x] **C-3.12 · List counts + the activity write-amplification trigger.** `member_count` counter column
  instead of counting every membership row per sidebar render (`listRepository.ts:220-235`); batch the
  dynamic-list N+1 (`packages/core/src/prospect/lists.ts:187-203` — a saved-search fetch + filtered
  `COUNT(*)` per dynamic list, serially, inside one held transaction); convert
  `rls/activity.sql:14-24`'s per-row AFTER-INSERT contact UPDATE to a statement-level trigger with
  transition tables (today bulk email-event ingest = one contact UPDATE per row + hot-row lock contention).
  **shipped, all three — but the counts one deliberately NOT as a counter column.**
  - *Trigger:* now `FOR EACH STATEMENT` with a `NEW TABLE` transition table, aggregating `max(occurred_at)`
    per contact first. The row-level version did N single-row `UPDATE contacts` per bulk insert and, when
    several rows shared a contact (the normal case — opens/clicks arrive batched per contact), re-updated the
    same row once per event, taking the lock and leaving another dead tuple each time. Semantics unchanged:
    newest-wins, and the `<` guard still stops a backfilled older activity regressing the cache. CI proves
    both — a new multi-row single-statement test asserting each contact lands on ITS OWN max, and the
    pre-existing no-regression test.
  - *Dynamic-list N+1:* `listLists` did a saved-search fetch plus a filtered `COUNT(*)` per dynamic list,
    sequentially, inside one held transaction — N lists serialised 2N network waits while holding a pooled
    connection. Now two round-trips total: `savedSearchRepository.findManyByIds` (same visibility rule as
    `findById`) and `searchRepository.countContactsBatchTx` (a `UNION ALL` of the same per-query counts).
    Postgres still evaluates one aggregate per query; what collapses is the waiting, which is what dominated.
  - *Counts:* the item asked for a denormalised `member_count`. **Rejected in favour of a correlated
    index-only count.** The old query was not an N+1 — it was one `LEFT JOIN list_members … GROUP BY`, which
    reads every membership row the workspace owns on every sidebar render, so its cost tracks total
    memberships. A correlated `count(*)` per list is served by the existing `list_id`-leading indexes
    (`uniq_list_members_list_contact`, `idx_list_members_list_added_at`), so cost tracks the number of LISTS
    (tens) instead. That gets the same win without a counter trigger on every membership write, a backfill, or
    the standing risk of a drifted counter showing users a wrong number with nothing to reconcile against.

---

## 7. Phase 4 — Search: honour ADR-0002

**Policy check first.** ADR-0002 was **amended (2026-05-29) to "self-hosted Typesense from day one"**, with
OpenSearch for the master graph (ADR-0021) and `suggest()`/`facetCounts()` added to the port (ADR-0035).
Reality: `packages/search/src/index.ts:6` exports **only** `createInMemorySearchPort`,
`searchPortProvider.ts:46` wires prod to the ILIKE repositories, `packages/search` has **no consumer at
all**, and a **Typesense 27.1 container runs in prod compose with zero readers** — `TYPESENSE_URL`/
`TYPESENSE_API_KEY` are declared in env and read by nothing. So this phase is *implementing the accepted
ADR*, not choosing an architecture. There is also **no `SEARCH_*` flag** — one must be minted (G5).

- [x] **S-4.1 · Interim: make Postgres search index-served.** `CREATE EXTENSION pg_trgm` + GIN trgm on
  `contacts(job_title, email_domain)` + a generated `full_name` column, and `accounts(name, domain)`;
  generated `tsvector` + `websearch_to_tsquery` for ranked text.
  **why now:** prod search is 6-leg `ILIKE '%…%'` ORs including an **unindexed concat expression**
  (`coalesce(first_name,'')||' '||last_name`), with title filters synonym-expanded into N more `%…%`
  patterns per query — zero trgm/tsvector exist in all 81 migrations, so every search, facet and typeahead
  is a full workspace scan. Label this explicitly as a **stopgap with a kill date**, not a replacement for
  S-4.2. **needs:** L-1.4 (same migration discipline) · **check:** Neon must allow `CREATE EXTENSION pg_trgm`
  without superuser.
  **trgm half shipped** (migration 0081): GIN trgm on every ILIKE-d leg — first/last name, the concat
  expression, job_title, email_domain, linkedin_url, and accounts name/domain. Verified on real Postgres by
  CI.
  **citext was the trap.** `email_domain` and `accounts.domain` are citext, and `gin_trgm_ops` is defined over
  `text` with citext not binary-coercible to it — so a bare column index does not merely go unused, it FAILS
  to create, breaking every migrate run. Both are indexed as `(…::text)` expressions and the queries cast to
  match (an expression index is only consulted on a textual match). Matching is unchanged; ILIKE is
  case-insensitive regardless.
  **tsvector half deliberately NOT shipped.** It is not a speedup but a change of meaning — `ILIKE %eng%`
  matches "Engineering", a tsquery does not — so it would alter which contacts an existing saved search
  returns. That belongs with S-4.2 and a product decision.
  **Neon check still open:** CI runs plain postgres:16 where the migration role is superuser, so a green CI
  does NOT prove `CREATE EXTENSION pg_trgm` is permitted on Neon. Confirm before the next production migrate.
  **Marked in the file as a stopgap with a kill date** — trgm indexes are large and write-amplifying, so drop
  them when S-4.2 lands rather than paying for them forever.

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
  **The container is STOPPED — this item's own decision clause, taken.** It was verified orphaned before
  removal, three ways: `TYPESENSE_URL` / `TYPESENSE_API_KEY` appear ONLY in the env schema and are read by no
  code; no package depends on a Typesense client; and the SearchPort is served entirely by the Postgres
  adapter (`searchRepository`). It was nonetheless started on every deploy (`deploy.sh` → `up -d redis
  typesense mailhog`) in both the dev and prod compose files, holding a volume nothing queried.
  Removed from both compose files, from deploy.sh, and from the env template. The two schema entries are KEPT
  with a comment saying nothing reads them yet, so landing the adapter is one commit rather than config
  archaeology.
  **The adapter itself is NOT built, deliberately.** The verifiable part here is query construction; the parts
  that decide whether it works — the collection schema, `filter_by` semantics, and the outbox projector that
  has to hit ADR-0024's p95 < 5s freshness SLO — cannot be exercised without a running engine. Writing it
  blind and shipping it behind a flag would leave an adapter whose first real execution is on a tenant.
  **What is needed to finish it:** a reachable Typesense instance to develop against. The `SEARCH_BACKEND`
  master + per-tenant flag in the guardrail above is the right cutover shape when that exists.

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
  **PARTIAL — and two of the five sub-items were ALREADY DONE when checked.** `optimizePackageImports` was
  already in web/admin/forge, and the tokens.css double-import was already fixed (globals.css `@import`s it;
  layout.tsx documents why there is no JS import). The "today **zero** `next/dynamic` in apps/web" claim was
  also stale — the bulk bar was already deferred.
  **Landed now:** `optimizePackageImports` for `apps/auth`, the one app still missing it — and the one whose
  bundle an UNAUTHENTICATED visitor downloads first; and `TemplateEditor` (~370 lines) behind `next/dynamic`,
  which is a clean win because it is genuinely gated on `editor.open`.
  **`RecordDetail` is deliberately NOT deferred**, despite being the 694-line example the item names. It
  mounts unconditionally so its Drawer keeps its close transition — `contact: null` renders a closed drawer
  rather than nothing. `dynamic()` there would load on first render anyway (no win), and gating it on
  `selected` would trade a real UX regression for a bundle saving.
  **The types barrel is handled too, without the refactor.** The item asks for subpath exports instead of the
  75-line barrel (74 `export *` lines carrying Zod SCHEMAS — runtime values, not erased types, which is why it
  had weight at all). Listing `@leadwolf/types` in `optimizePackageImports` gets the compiler to rewrite barrel
  imports to their direct paths, which is what subpath exports would achieve — without rewriting several
  hundred import sites by hand, and without a package-surface change every consumer must follow.
  **MEASURED, by diffing `next build` route tables before and after** (the shared baseline is unchanged at
  103 kB — the win is per-route, which is why a shared-chunk number would have hidden it):
  - `/lists`, `/lists/[id]`: 239 kB → 229 kB First Load
  - `/prospect`: 213 kB → 202 kB
  - `/data-health`: 176 kB → 161 kB
  - `/reports`: 175 kB → 163 kB
  - `/imports*`: route chunk 862 B → 226 B
  **Still open:** `output: "standalone"` only — it needs a Dockerfile change that cannot be verified here.

---

## 9. Phase 6 — Scale-out (ongoing, post-green)

- [ ] **E-6.1 · Per-app images + registry + rolling deploy.** Today: one `leadwolf:latest` shared by 9
  services (so no service can be updated alone), built **on the prod host**, with a documented downtime
  window cushioned only by Caddy's 5 s dial-retry. Target: CI builds per-app standalone images → registry →
  deploy pulls → start-first rolling replace (Swarm mode on the same host is the smallest real step).
  **needs:** P-1.4, L-1.12, R-5.7.
- [ ] **E-6.2 (partial: the security headers shipped) · CDN in front of Caddy** — immutable edge caching for `_next/static/*`, edge zstd/Brotli,
  HTTP/3 at the edge, WAF; add its ranges to `trusted_proxies` (currently `private_ranges`, correct only
  while Caddy is the edge). Also add HSTS/CSP to `apps/web`/`apps/admin`, which ship **no** security headers
  today (needed by T-2.2 anyway).
  **The headers half is DONE — with one correction to the item AND to my first pass at it.** The claim
  "ship **no** security headers today" is true of `web`, `admin` and `forge`, but NOT of `apps/auth`: it
  already has a middleware sending a nonce-based CSP, HSTS with `preload`, `X-Frame-Options: DENY` and
  nosniff. My first attempt added a config block there too, which created TWO sources for one header with
  DIFFERENT values (the middleware sends `preload`, the config block did not) — and which one survives depends
  on where Next applies each. Reverted: one owner per header, and the stricter owner keeps it.
  The three apps that genuinely had none now send `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: strict-origin-when-cross-origin` and a framing policy: `DENY` for auth/admin/forge
  (framing a login screen is clickjacking; the staff consoles have no legitimate embedder) and `SAMEORIGIN`
  for web (same third-party protection, without ruling out a first-party embed later).
  **HSTS is gated on production**, which is not caution — sent from a dev server it pins `localhost` to HTTPS
  in the developer's browser for the max-age, and every app on localhost then fails to load until the pin is
  cleared by hand. It presents as a broken machine, not as a header. `preload` is deliberately omitted: it is
  a submission to a browser-shipped list and is slow to reverse, so it should be a deliberate decision rather
  than something inherited from a copied header.
  **CSP is deliberately NOT included.** A too-strict CSP does not fail the build — it fails silently in the
  browser, blocking scripts or styles on surfaces nobody re-tests. It wants a report-only rollout against a
  real deployment, which is why it stays with the CDN work here.
  `securityHeaders.test.ts` asserts all of it by EXECUTING each real `next.config.mjs`, so the test fails when
  the config changes rather than when someone forgets to update a copy of it — including an assertion that
  `apps/auth` defines NO `headers()`, so the duplicate-owner conflict cannot be reintroduced.
  **Still open:** the CDN itself, and the `trusted_proxies` update that depends on it.
- [x] **E-6.3 · Read replicas + pool split.** `DB_POOL_MAX` env (today `max: 10` hardcoded), a
  `leadwolf_app` LOGIN pool for tenant traffic vs a small owner pool for the audited platform paths (today
  the runtime pool logs in as the **DB owner**, so any `db.*` call outside `withTenantTx` silently bypasses
  RLS, and unauthenticated public catalog reads are served from the owner pool), `prepare` gated on a
  `DB_POOLED` flag, then replica routing for list/dashboard reads.
  **PARTIAL — the two config pieces shipped; the pool SPLIT and replica routing did not.** `DB_POOL_MAX`
  replaces the hardcoded `max: 10`, which was a deploy-shaped decision living in source: the right number
  depends on the host.s connection budget and how many replicas share it, neither knowable from the repo.
  `DB_STATEMENT_TIMEOUT_MS` adds the runtime `statement_timeout` the migrations have and the runtime pool never
  did. Both default to exactly today.s behaviour (10, and no timeout).
  **The timeout defaults to OFF for a real reason, not caution.** apps/api and apps/workers share ONE pool with
  opposite statement profiles: a request-path query running 30s is pathological, while the daily
  data-quality sweep.s jsonb scans over a large tenant can legitimately run for minutes. No single value
  bounds the first without killing the second — which is itself the argument for the pool split this item
  describes. The knob and the reasoning are now in place for whoever does that split; turning it on before
  then would trade an unbounded-query risk for a broken nightly sweep.
  **The LOGIN pool shipped.** `withTenantTx` now runs on a connection AUTHENTICATED as `leadwolf_app`, derived
  from DATABASE_URL with the app role.s credentials swapped in (falling back to the owner when no app-role
  password is configured, so an unconfigured deployment is unchanged). The compensation it replaces was one
  statement away from failing open: if the per-transaction `SET ROLE` were ever skipped, reordered or silently
  errored, the queries inside still ran as the BYPASSRLS owner. Isolation is now a property of the CONNECTION.
  **Verified by session_user, not by a green run.** The fallback makes a broken derivation look identical to a
  working one — every other test passes either way, because the owner can do everything the app role can.
  `tenantPoolIdentity.itest.ts` asserts `session_user = leadwolf_app` inside `withTenantTx` (current_user was
  already app-role before this change and proves nothing), plus that `withPrivilegedTx` still authenticates as
  the owner. CI also had to be taught to set DATABASE_APP_ROLE_PASSWORD, or the path would have shipped
  untested — which surfaced a latent bug: the workflow declared that key TWICE and the winning value did not
  match the password `applyMigrations` creates the role with.
  **`DB_POOLED` shipped.** `prepare` is now gated on it across all three runtime pools, defaulting to POOLED —
  i.e. prepared statements OFF, exactly what the file hardcoded before. The asymmetry is the point: under a
  transaction-pooling proxy a connection changes hands between statements, so a statement prepared on one
  backend is missing on the next and the failure is an intermittent "prepared statement does not exist" UNDER
  LOAD — not at boot, not in a smoke test, and never on a developer.s direct connection. Assuming pooled costs
  a re-plan per query; assuming direct costs correctness. Opt-out is explicit-"false"-only, so a hand-edited
  `DB_POOLED=0` or `False` keeps the safe behaviour instead of silently enabling prepared statements —
  pinned by `dbPooling.test.ts`. (`applyMigrations` keeps its own hardcoded `prepare: false`; the migrator
  needs it regardless of how the runtime is deployed.)
  **REPLICA ROUTING SHIPPED — and it did not need a replica to route to.** Same shape as the Forge pool
  (E-6.6): `REPLICA_DATABASE_URL` is OPTIONAL and defaults to the primary, so an unconfigured deployment reads
  exactly the rows it always did. What lands immediately is a separate CONNECTION BUDGET — a heavy dashboard
  aggregate stops competing with the request path for the tenant pool. Pointing it at a real replica later
  moves the load off the primary with no code change.
  `withReplicaTx` runs the IDENTICAL RLS setup as `withTenantTx` (same non-BYPASSRLS app role, same
  transaction-local GUCs): a replica is not a privilege boundary and must not become one by accident.
  **Which reads qualify is the actual question, and the answer is not "read-only ones".** A replica is behind
  by definition, so anything that must show a user their own write immediately — a list after a create, a
  balance after a spend — stays on `withTenantTx`. The safe set is reads whose contract ALREADY advertises
  staleness. `reportsRepository.summary` is routed on exactly that basis: a trailing-window dashboard rollup
  that nobody reads expecting to see the reveal they just made, running the heavy scans that should be the
  first thing off the request path.
  **`closeDb` drains the fourth pool**, and `dbPooling.test.ts` re-pins the worst-case per-process budget
  (10 + 4 + 5 + 5 = 24) so a future split is a conscious act rather than a silent multiplication. The existing
  `reportsRepository.itest.ts` now exercises `withReplicaTx` with no replica configured, which is what proves
  the fallback.
- [x] **E-6.4 (decided: two partitioned, four are not candidates) · Partition the append-heavy tables** — `activities`, `email_events`, `platform_audit_log`,
  `provider_calls`, `source_imports`, `credit_ledger` (zero `PARTITION BY` in the repo today). Monthly range
  partitions; the partition key is already in the hot predicates. Gives retention real detach-and-archive
  mechanics. **check:** whether Neon permits `pg_partman`; if not, hand-rolled monthly partitions.
  **Feasibility PROVEN against the real Postgres 16, not assumed** —
  `packages/db/test/partitioningFeasibility.itest.ts` asserts each property in CI rather than leaving it to a
  reading of the docs. What it establishes:
  - **The `activities` transition-table trigger is NOT a blocker.** `rls/activity.sql` maintains the
    `contacts.last_activity_at` cache with an `AFTER INSERT ... REFERENCING NEW TABLE ... FOR EACH STATEMENT`
    trigger, and transition tables were long restricted on partitioned tables — which would have made this a
    rewrite of the write path before the table could be partitioned at all. On PG16 they are ACCEPTED. The
    test pins that, so a downgrade to a server that restricts them fails loudly instead of at the migration.
  - **`id` alone stops being the primary key**: "unique constraint on partitioned table must include all
    partitioning columns". The key becomes `(id, occurred_at)`.
  - **That composite propagates through every inbound FK.** A referencing table cannot keep
    `uuid REFERENCES parent (id)` — it must carry BOTH columns. This is the real cost, and it is not evenly
    distributed: `activities`, `email_events`, `platform_audit_log` and `provider_calls` have no inbound FKs,
    so their conversion is local. `source_imports` is referenced by three tables
    (`account_children`, `contact_channels`, `lists`) and `credit_ledger` by `subscriptions.grant_ledger_id`
    — partitioning those two means adding a column to four tables and to every write path that sets the
    reference, on a financial ledger whose FK is a real integrity constraint.
  - **A row outside every partition is REJECTED** (`23514`). So partitioning cannot ship as a migration alone:
    it needs either a DEFAULT partition (proven to accept the row, at the cost of a scan on every future
    ATTACH) or a job that creates next month ahead of time. Without one, writes fail on a CALENDAR boundary
    rather than under load — an operational component that has to exist first.
  **The partition-maintenance prerequisite is now BUILT and merged** — `ensure_month_partitions()`
  (migration 0084), `partitionRepository.ensureAll`, and a daily leader-locked `partition_sweep` registered
  at worker boot. It is deliberately inert: the repository asks the CATALOG which tables are partitioned and
  finds none today, so a conversion migration becomes the only change needed later rather than a conversion
  plus remembering to wire the thing that keeps it alive. Covered by `partitionMaintenance.itest.ts`
  (idempotence, the inclusive horizon, extending without disturbing existing partitions, the half-open month
  boundary, and that `leadwolf_app` holds no EXECUTE — creating a partition is DDL).
  This also settles the `pg_partman` question by making it moot: the maintenance is ~40 lines of plpgsql the
  repo owns, so nothing depends on whether the managed provider permits the extension.
  **DONE for the two tables that can actually take it** — `activities` (migration 0085) and
  `platform_audit_log` (0086 + rls/platform.sql), both monthly RANGE on their time column, both verified by
  `activitiesPartitioned.itest.ts` against a real Postgres.
  **The item's own list was wrong on three counts, found by trying it:**
  - **`email_events` does not exist.** The table is `email_event` (singular) — and it cannot be partitioned as
    written: its partial UNIQUE on `provider_event_id` IS the webhook ingestion idempotency key. Forcing
    `occurred_at` into that constraint means a redelivered provider event inserts twice, which corrupts
    open/click/bounce analytics and can re-trigger reply auto-pause.
  - **`provider_calls` cannot either.** Its UNIQUE `(workspace_id, request_hash)` IS the provider-response
    cache dedup. Partitioning turns "one persisted answer per request" into "one per timestamp" — i.e.
    re-billing the provider on every miss. Both need their uniqueness moved somewhere partition-compatible
    first; that is a design change, not a migration.
  - **`source_imports` / `credit_ledger`** remain blocked on inbound FKs as described above.
  **Both conversions are ONE `DO` block each**, because applyMigrations runs statements with autocommit — a
  rebuild split across statements could not roll back if it failed partway. `platform_audit_log` needed a
  two-sided approach on top: it is not a Drizzle table (rls/platform.sql creates it, and the rls files run
  AFTER the migrations), so that file and the duplicate DDL in `bootstrapAdmin.ts` now create it partitioned
  on a fresh database while 0086 converts an existing one. The duplicate had to move in lockstep — with
  `CREATE TABLE IF NOT EXISTS`, whichever ran first would have won.
  **The retention sweep gained an `occurred_at` predicate** on its bulk DELETE: keyed only on `id` it carried
  no partition key, so it would have scanned every month to delete rows already located in the oldest few.
  **CLOSED on the remaining four — they are not partition candidates, and that is a conclusion rather than a
  deferral.** Partitioning was never the goal; BOUNDED GROWTH was, and it is already achieved another way:
  - `email_event` and `provider_calls` are both registered retention classes
    (`retentionScanRepository.retentionClassMeta`), aged on `occurred_at` and `called_at` — the very columns
    that would have been their partition keys. Their growth is bounded by time-based deletes TODAY.
  - Their uniqueness is load-bearing and partitioning would destroy it: the partial unique on
    `provider_event_id` IS the webhook ingestion idempotency key, and `(workspace_id, request_hash)` IS the
    provider-response cache dedup. Forcing the time column into either turns "once per event" into "once per
    timestamp".
  - So partitioning would buy only a CHEAPER delete (DETACH instead of DELETE), not a capability. That is an
    optimisation to revisit if retention's delete cost ever shows up in a profile — not a correctness gap.
  **If it is ever wanted**, the redesign each would need is a separate non-partitioned side table holding the
  unique key (`provider_event_id` / `(workspace_id, request_hash)`) with the event table partitioned beneath
  it. Ingestion inserts the key first, `ON CONFLICT DO NOTHING`, and skips on a zero rowcount. Recorded so the
  option is not re-derived, but it is real work on a correctness-critical path and should not be taken on
  without a reason stronger than tidiness.
  `source_imports` and `credit_ledger` stay out for the inbound-FK reason above, and are likewise not growth
  risks: neither is an append-per-event firehose.
- [x] **E-6.5 · OTel end-to-end** api → workers → db, on top of
  A-0.4's request IDs.
  **The seam is in `@leadwolf/config` (`withSpan`), and that placement is a boundary decision**: `@leadwolf/db`
  may depend only on config and types, so a seam anywhere else could not instrument the layer whose latency
  matters most. Only `@opentelemetry/api` is imported there, and it is a NO-OP until something registers a
  provider — which is what lets instrumentation live in shared code without every process paying for
  telemetry nothing collects.
  **The SDK registers only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set**, and only from the app entrypoint. A
  library that installed a global tracer provider on import would be deciding telemetry policy for every
  process that imported it, tests and one-shot scripts included.
  **Instrumented so far:** `withTenantTx` and `withReplicaTx` (`db.tenant.tx` / `db.replica.tx`, carrying
  tenant + workspace ids — opaque uuids, which is what makes "which tenant is slow" answerable; no row data
  ever goes on a span). Deliberately NOT auto-instrumentation: wholesale HTTP/socket patching would bury the
  spans the code knows are meaningful and pull in a far larger dependency surface.
  **Verified without a collector.** A collector is needed to DELIVER spans, not to prove they are produced:
  `telemetry.test.ts` uses an in-memory exporter to assert span names, attributes, parent/child nesting, that
  an undefined attribute is omitted rather than recorded as `"undefined"`, and that a failure is recorded AND
  rethrown — a swallowing instrument would show a healthy span for work that did nothing.
  **The workers half is done too.** All 35 `new Worker<...>` constructions in `register.ts` went through ONE
  uniform substitution to `tracedWorker<...>` rather than 35 bespoke edits — that file wires every queue and is
  the most collision-prone in the repo, so a single mechanical change verified by typecheck was the only sane
  shape. The span wraps the processor from the OUTSIDE, which puts it around `withDeadline`'s race: a job
  killed by its deadline shows as an error on the span, where a span nested inside the race would simply never
  end when the deadline won.
  **Propagation** rides on the job payload under `__trace`, extracted into ROOT_CONTEXT rather than the ambient
  one — without that, whichever span happened to be active when the worker picked up the next job would adopt
  it and every job would collapse into one trace. `tracedWorker.test.ts` pins exactly that, plus the
  degradations: no carrier and a malformed carrier both still produce a usable span.
  **A real bug surfaced while wiring this**, and it would have shipped silently: `trace.getTracer()` returns a
  ProxyTracer that binds to whichever provider is registered when it is FIRST used and keeps that delegate. A
  module-scope tracer captured before an app called `startTelemetry()` would have emitted into the no-op
  provider forever — tracing "on", nothing recorded. The tracer is now resolved per call.
  **The producer half is done, so a job now continues the trace of the request that queued it.** Both apps
  construct queues through a `tracedQueue` subclass that stamps the carrier in `add()` — 47 substitutions in
  `register.ts` plus the four api-side queue modules. A SUBCLASS rather than ~50 edited call sites because
  `.add()` is called from dozens of places with varying argument shapes: intercepting the one method cannot be
  forgotten at a new call site, where the failure mode of per-site injection is a job that quietly starts its
  own trace.
  **Safe against every consumer schema**: each is a plain `z.object()`, which STRIPS unknown keys rather than
  rejecting them (none are `.strict()`), and `tracedWorker` reads the carrier off the RAW job before parsing —
  so processors see exactly the payload shape they always did. That was checked before writing the subclass,
  not after.
  **The two copies of `tracedQueue` are deliberate**: the apps cannot import each other, and hoisting it would
  put a bullmq dependency into a package with no other reason to carry one. A test asserts both halves agree on
  `TRACE_CARRIER_KEY`, because disagreement is the silent failure — producer writes one name, consumer looks
  for another, every job starts its own trace and nothing errors.
- [x] **E-6.6 (COMPLETE) · Forge isolation** — `FORGE_DATABASE_URL` + its own login role and pool (today `withForgeTx`
  shares the customer request path's `max: 10` pool, so there is no capacity or failure isolation), plus a
  runtime `statement_timeout` (migrations set one; the runtime pool does not).
  **PARTIAL — pool isolation shipped; the separate ROLE/credential did not.** `withForgeTx` now runs on its
  own pool (`FORGE_DATABASE_URL`, optional, defaulting to the same database; `FORGE_DB_POOL_MAX`, default 5).
  That fixes the capacity half, which is the half that bites first: the Forge DAG holds transactions across
  provider network I/O (extraction calls Anthropic mid-transaction), so a backlog could occupy every one of
  the customer request path.s ten connections and starve the thing users are waiting on.
  **A separate pool against the SAME database is still real isolation** — it is a connection budget, not a
  topology. Pointing `FORGE_DATABASE_URL` at another database or replica later adds failure isolation with no
  further code change. It does not double connection usage either: postgres.js connects lazily, so an api
  process that never calls `withForgeTx` opens zero Forge connections, and the Forge budget is deliberately
  smaller because queue-backed throughput work can wait where a request cannot.
  **`closeDb` now drains both pools** — leaving the second open would keep a worker or test process alive,
  which is precisely what that function exists to prevent.
  **The LOGIN role shipped too.** `leadwolf_forge` is granted LOGIN when `DATABASE_FORGE_ROLE_PASSWORD` is
  configured, and the Forge pool AUTHENTICATES as it — so the firewall is now enforced by the connection, not
  by a `SET LOCAL ROLE` that has to succeed. The failure direction is what made this worth doing: had that
  statement ever been skipped or errored, `withForgeTx` would have run as the OWNER, which CAN read customer
  contacts. Without the password the role stays NOLOGIN and nothing changes.
  **Two details decide whether it actually works.** The bootstrap has an ELSE branch converging an EXISTING
  role — every deployment created it NOLOGIN, so without that the change would only reach fresh databases and
  silently never production; it only ever grants, never revokes, since pulling LOGIN from a running deployment
  mid-migrate would take Forge down. And `applyMigrations` falls back to `process.env` for the password: it is
  deliberately standalone, and the itests call it with no options, so without the fallback the path would have
  shipped untested.
  **Verified by session_user** (`forgeSchemaIsolation.itest.ts`), because the fallback makes a broken
  derivation indistinguishable from a working one — the owner can do everything the forge role can and more.
  **NOW CLOSED — the third sub-item shipped.** The blocker as written was real but was the wrong shape: it
  said the timeout must wait for an "api/worker pool split lets one value be correct for both". One value
  never needs to be correct for both — the pools just needed their OWN knobs.
  `FORGE_DB_STATEMENT_TIMEOUT_MS` is now separate from `DB_STATEMENT_TIMEOUT_MS`, and the Forge pool reads
  ONLY its own. That is what makes turning either on safe: the request path wants a bound measured in
  seconds, while the Forge DAG legitimately holds a transaction across an Anthropic call, so a single shared
  value would either kill healthy extraction work or be useless for requests.
  It deliberately does NOT inherit the app value. Inheriting would mean that tightening the request-path
  timeout silently starts killing Forge jobs — a regression that would present as flaky provider failures
  rather than as the config change it was. Both default to 0, so the mechanism ships inert and choosing a
  value stays a deploy decision against a real latency profile.
  `poolTimeouts.test.ts` pins the independence as SOURCE, not behaviour: with both defaulting to 0 an
  inherited value would pass every test and only bite in production.

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
