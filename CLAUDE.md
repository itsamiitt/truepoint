# TruePoint — CLAUDE.md
# Sales intelligence platform with a data contributor network

**Product brand:** TruePoint — everything a user sees. **Code identity:** the npm root is
`leadwolf` and every workspace package is `@leadwolf/*`. The brand and the scope deliberately
differ — never "fix" one to match the other. Real domains: `app.` / `auth.` / `api.` /
`forge.` / `doc.truepoint.in`.

## Product strategy (the contract — read before proposing any feature work)

Full strategy lives in docs/strategy/. Minimum required reading before planning:
03-outcomes.md, 04-opportunity-scores.md, 06-roadmap.md, 09-compliance.md.

**Markets we serve (job executor + job):**
1. SELLER: B2B sales professionals · "build and maintain an accurate, reachable
   list of the right people to contact at target accounts."
2. CONTRIBUTOR: the same users wearing a different hat · contribution is never
   its own job — it must arrive as exhaust of jobs they already do (verify
   before outreach, keep CRM clean, keep expanded free access via the
   Community tier).
3. ADMIN/REVOPS: "ensure the team's outreach data is accurate, deduplicated,
   and lawful."

**Current target outcomes (see 04 for full table):**
- C-01 (14.5) contribution requires near-zero marginal effort
- S-09 (14.0) minimize likelihood a record's person has left the company
- A-01 (13.7) every stored field has provenance and a lawful basis
- S-04 (13.7) working direct-dial/mobile coverage
- S-13 (13.6) fast detection of job changes on saved contacts
- S-08 (13.5) minimize first-contact email bounces
- C-02 (13.4) contributing must not expose a contributor's accounts/pipeline
- A-03 (13.3) fabricated/fraudulent contributions kept out of the graph
- S-10 (13.2) record confidence/verification recency is visible at a glance

**Non-goals (overserved — do not build without explicit human approval):**
raw database-size expansion for its own sake (S-05) · email sequencing/cadence
tooling (X-01) · AI email writing (X-02) · intent data (deferred, X-04) ·
news/social feeds. See 04-opportunity-scores.md.

## Rules (binding on every session)
1. Every feature, commit, and PR names the outcome ID(s) it advances: [S-xx],
   [C-xx], [A-xx]. Work that serves no listed outcome gets flagged, not built.
2. Acceptance criteria are written as outcome metrics (time / likelihood /
   count), and tests must encode them.
3. Any change that touches personal data (collection, storage, display, export,
   deletion) must state its compliance impact and pass the checklist in
   docs/strategy/09-compliance.md. When uncertain, stop and ask the human.
4. HARD CONSTRAINTS — never implement, even if asked casually in-session:
   background/bulk scraping of LinkedIn or other logged-in sites; capture of
   email/message body content; collection beyond user-initiated actions in the
   extension; any contribution flow without explicit consent + provenance
   logging. Changes here require a human decision recorded in decisions.md.
5. The confidence/provenance model (08-architecture) is the product's spine.
   No ingestion path may write to the graph without a provenance event.
6. When strategy and code conflict, surface the conflict — never silently
   reinterpret strategy.
7. Monetization is freemium: Free / Community (free, contribution-active) /
   Pro / Team — see docs/strategy/07-data-flywheel.md §Access model. No
   contributor-EARNED currency exists anywhere — no points, no bounties, no
   rewards a contribution can accrue; never implement one. (Amended 2026-07-31,
   decisions.md: the shipped reveal-credit ledger is a PURCHASED settlement
   unit, not a farmable reward, so A-03's "nothing to farm" property holds.
   Entitlement caps sit ABOVE credits; do not reconcile the two in code.)

## Project conventions

- **Stack:** one Bun monorepo — Bun 1.3.14 + Turbo 2.3.3 + Biome 1.9.4 (not pnpm/ESLint),
  TypeScript 5.7.2. Postgres 16 via Drizzle + postgres.js (RLS enforced, hand-written policies
  in `packages/db/src/rls/*.sql`); Redis 7 + BullMQ; Hono on Bun for APIs; Next.js 15 App
  Router + React 19 for the five web apps; S3-compatible object storage; search is
  Postgres-backed behind a `SearchPort` seam.
- **Layout:** `apps/{web,admin,auth,api,workers,extension,forge,forge-api,forge-worker,doc}` +
  `packages/{app-shell,auth,auth-client,config,core,db,forge-capture-sdk,forge-core,identity,
  integrations,search,types,ui}`.
- **Gates:** `bun run lint` · `bun run typecheck` (runs `typecheck` AND `typecheck:tests` — test files
  are NOT covered by the plain task) · `bun test` · `bun run lint:boundaries` · `bun run lint:import-pii` ·
  `bun run lint:lockfile` · `bun run lint:itest-rejects` · `bun run lint:prod-switches` ·
  `bun run lint:secrets` · `bun run lint:roving-tabindex` · `bun run lint:design-tokens` ·
  `bun run lint:cross-feature` · `bun run lint:batch-inserts` · `bun run db:migrate`.
  The script-based ones are plain filesystem scans (no services, no env, seconds each) and each exists because
  its rule was previously enforced by memory and lost anyway: `itest-rejects` bans the `expect(...).rejects`
  shape that HANGS an itest instead of failing it; `prod-switches` fails if an env kill-switch is armed in
  `deploy/env.production.template` without a recorded reason — load-bearing since migration 0119 turned the
  per-tenant half of most flags globally on, leaving the env half as the only thing keeping dark work dark;
  `secrets` scans tracked files for credential shapes and for this product's PII formats
  (`.csv`/`.xlsx`/`.xls`/`.rdb`). The last two carry a declared escape hatch (`lint-secrets-ok:`,
  `itest-rejects-ok:`) — use it with a reason rather than loosening a pattern.
  **Until 2026-08-22, CI ran only `lint` and `lint:boundaries`**, so `lint:import-pii` and `lint:lockfile`
  were listed here but never actually enforced. All of them are steps in the gates job now.
  **`bun run lint` on a pre-2026-08-22 Windows checkout reports ~1,599 errors, and 1,582 of them are the
  line endings, not the code.** Biome formats to LF; `core.autocrlf=true` wrote CRLF to disk; every tracked
  source file therefore "needs to be formatted" while CI (Linux, LF) sees none of it. `.gitattributes` now
  pins `eol=lf`, so a fresh checkout matches CI — an existing working copy keeps its CRLF until the files
  are checked out again or `git add --renormalize .` is run. Do NOT "fix" this by reformatting the tree:
  the content is already correct, and a 2,500-file rewrite collides with every other session. To read the
  ~17 real findings before renormalising, scope the check (`bunx biome check apps/doc/src`) — a
  freshly-written LF file passes cleanly, which is how the split was measured.
  **To see exactly what CI sees, materialise the INDEX (which is LF) and check that:**
  ```sh
  rm -rf /tmp/lfview && mkdir -p /tmp/lfview && git archive HEAD | tar -x -C /tmp/lfview
  cd /tmp/lfview && bunx --bun @biomejs/biome@1.9.4 check .
  ```
  Same 2,536 files and the same error count as the runner, with no writes to your working copy. This is the
  only way to tell the ~20 real findings from the 1,582 line-ending ones — `bunx biome lint .` skips the
  FORMATTER, so it reports zero while CI fails. Two classes hide there and nothing local will show you them:
  genuine format drift in a file you edited after its last `--write`, and formatter-adjacent lint rules.
  **`biome.json` takes no comments** (it validates against its own schema — a `//` key errors, and so does a
  JSONC comment), so its one non-obvious entry is explained here: the `overrides` block turning `noConsoleLog`
  off for `scripts/**`, the db seed, the extension packer, and the two logger modules. In those files the
  console IS the output, not a stray debug line; the rule was 100% false positives there, and a check that is
  always wrong trains you to skim past its output — which is how a real stray `console.log` ships. It stays a
  warning everywhere else.
  **Biome suppression placement, learned twice:** `// biome-ignore lint/x/Rule:` binds to the node the
  diagnostic is REPORTED on and must be the **last line before it** — a11y rules often report on the
  `role=`/attribute rather than the element, so the directive goes inside the JSX attribute list. Prose first,
  directive last; a wrapped comment between them makes it bind to nothing and biome says `suppressions/unused`
  while the rule keeps firing.
  **`biome check --write` SILENTLY REFUSES the unsafe fixes, and `useTemplate` is one of them.** It prints
  `× Some errors were emitted while applying fixes.` and changes nothing; only `--write --unsafe` rewrites
  them. The two that bite here are `lint/style/useTemplate` (a `` `a` + `b` `` concatenation of template
  literals — very easy to write in a multi-line error message) and `lint/style/noUnusedTemplateLiteral`. This
  broke three branches at once on 2026-08-24: the safe `--write` was run, its output piped through `tail`, and
  the SCRIPT's own `ok` line printed underneath was read as the formatter passing. **Never read a format check
  through `tail` beside other output, and never assume `--write` finished the job** — run
  `bunx biome check <file>` on its own line afterwards and require `No fixes applied.` Otherwise CI's `lint`
  step is the only thing that catches it, i.e. after the push.
  **Git Bash MANGLES `git show <rev>:<path>` on Windows.** MSYS path conversion rewrites
  `origin/main:.github/workflows/ci.yml` into `origin\main;.github\workflows\ci.yml`, and git answers
  `fatal: ambiguous argument`. Prefix the command with `MSYS_NO_PATHCONV=1`. The trap is not the error, it is
  the error being HIDDEN: run it with `2>/dev/null` — which is a reflex when a file may not exist — and the
  fatal disappears, leaving empty output that reads exactly like "that path is not in this revision". On
  2026-08-24 that produced a confident wrong conclusion about which workflow file was on `main`. Same rule as
  above: if a command's output is empty, prove it ran before believing what the emptiness seems to say.
  **Do NOT author a script with a shell heredoc — write the file with an editor.** Backslash escapes written
  into a `cat > f <<'EOF'` heredoc arrive mangled, quoted delimiter or not: `\n` becomes a real newline, `\b`
  a backspace character, `\(` loses its backslash. On 2026-08-25 this cost six cycles in one session and never
  once appeared as an error — the damage always looked like a RESULT:
  · a regex built as `` `\\b${name}` `` matched nothing, so a runbook audit reported all 12 env switches
    missing when every one was present;
  · a `content:` string carrying `\n` produced a real newline inside a JS string literal, so the script failed
    to PARSE — and the run "proved" a mechanism it had never reached;
  · three separate attempts to plant a deliberate failure planted nothing, and each silently "passed".
  A heredoc is fine for prose (commit messages, PR bodies) — the trap is code containing escapes. If one is
  unavoidable, assert the string survived: read the file back and require a distinctive substring before
  trusting the run. `scripts/audit-dead-repository-methods.mjs`'s verdict writer does that and says why.
- **`bun run build` needs an environment.** `@leadwolf/config` validates at import, so a Next build with no
  env dies with a bare `Required` list and a "Failed to collect page data" trace that names no cause. In
  production the Dockerfile injects it via a BuildKit secret; locally, export the same placeholders
  `test/setup.ts` uses — and note `AUTH_COOKIE_DOMAIN` must equal the `AUTH_ORIGIN` **host**, or the build
  fails validation rather than compilation.
- **Integration tests** need Postgres. Default is Testcontainers (Docker); without Docker, point
  `ITEST_DATABASE_URL` at any superuser connection and each file clones its own database from a migrated
  template. Run each `.itest.ts` in its OWN process — the db client is a module singleton.
  In external mode also export `DATABASE_APP_ROLE=leadwolf_app` +
  `DATABASE_APP_ROLE_PASSWORD` (the applyMigrations default `Lw_App_Role_2026!x7Qm`) **and**
  `DATABASE_FORGE_ROLE_PASSWORD` — each missing password makes its connection helper fall back to the OWNER
  connection *silently*, and the failure then reads like a broken security boundary rather than a missing env
  var: `withTenantTx` → role-identity proofs fail with `session_user` = `postgres`; a WRONG app password fails
  `28P01` (invalid password), which looks like the RLS wall is broken; `withForgeTx` with no forge password →
  `forgeSchemaIsolation.itest.ts` reports `postgres` where it expects `leadwolf_forge`, which looks like the
  ADR-0047 forge↔tenant firewall has failed. All three are the environment, not the code. **The suites that
  need more than Postgres, named** (a full sweep on 2026-08-22 ran 121 of the 122 `packages/db` files):
  `workspaceSwitch` needs Redis (session revocation) and fails with repeated `[ioredis] Unhandled error
  event`; `apps/workers/test/imports.{queue,conflict,resilience}` and `importFairness` need a container
  runtime and fail with `Could not find a working container runtime strategy`; `importSoak.nightly` and
  `importSoak.fairness.nightly` are nightly by name and not part of a normal run. Everything else runs against
  a plain external Postgres.
- **Never assert a rejected DB call with `expect(...).rejects`.** A promise holding a pooled connection can be
  left unsettled, and the symptom is a HANG — of that assertion AND of every later query in the file, since
  the itest pools are `max: 1`. Use an explicit try/catch that returns the error. This has bitten
  partitionMaintenance, contactMerge and tags; activitiesPartitioned documents it at the call site.
- **Every `beforeAll` that provisions a database needs `}, 180_000)`.** Without it the hook inherits bun's 5s
  default and fails on setup cost, then the teardown throws a TypeError on the unassigned handle that REPLACES
  the real error. Optional-chain the teardown so the cause survives.
- **Repositories in `packages/db/src/repositories/` are the ONLY data-access layer.** Tenancy
  seams: `withTenantTx` / `withReplicaTx` / `withPrivilegedTx` / `withErTx` / `withForgeTx` /
  `withPlatformTx`.

### 08-architecture service names → where they actually live

The doc's `services/*` are **modules, not directories**. Do not create a `services/` tree.

| 08 service | Lives in |
|---|---|
| graph | `packages/db/src/schema/masterGraph.ts` + `masterGraphRepository` (Layer 0, no tenant key); ER in `packages/forge-core` |
| ingest | the `forge` Postgres schema (`raw_captures → parsed_records → verified_records → sync`), `/api/v1/ingest`, the `import_jobs` trio |
| verify | `verification_jobs` + the `reverification` / `reverification_sweep` queues in `apps/workers` |
| confidence | `field_provenance` jsonb + `packages/core/src/prospect/fieldProvenance.ts` (the pure fold). Decay curves are Phase 2 — not built. |
| entitlements | `subscriptions`, `billing_cycles`, `plan_templates.features`, `tenant_feature_flags`, `credit_ledger` (+ `entitlement`, Phase 1) |
| fraud | not built (Phase 3) |
| compliance | `suppression_list`, `consent_records`, `dsar_requests`, `retention_*`, the `dsar` queue |
| connectors | `packages/db/src/schema/crm.ts` (9 tables, dark behind `CRM_SYNC_ENABLED`) |
| apps | `apps/web` (customer), `apps/admin` (staff), `apps/forge` (operator), `apps/doc` (public docs/pricing at `doc.truepoint.in` — no auth, no data client, zero-env build; ADR-0048), `apps/extension` (MV3, dark behind `CHROME_EXTENSION_ENABLED` + `EXTENSION_ORIGINS`) |

## Skills — read before writing code in that area

Nine skills under `.claude/skills/`. **Read the `SKILL.md` of every skill your task touches
before writing any code, file, or migration** — and run the pre-build pass in
`truepoint-architecture/references/pre-build-thinking.md` first. Most real features need
several at once.

| If the task involves… | Use |
|---|---|
| `apps/api` (Hono on Bun), the database, the two-tier `tenant_id`/`workspace_id` tenancy model, the `/api/v1` contract (cursor pagination, idempotency-key, RFC 9457), queues, caching, deploy, "will this scale" | **truepoint-platform** |
| The data model, who owns/can-see a record, enrichment, verification, search over the dataset, retention/deletion/DSAR | **truepoint-data** |
| Where frontend code lives, feature structure, client state & data fetching, frontend tests, feature flags | **truepoint-architecture** |
| Anything that renders — `@leadwolf/ui`, tokens (`var(--tp-*)`), layout, large tables, WCAG 2.2 AA, motion, copy, i18n | **truepoint-design** |
| Access control & tenant isolation (RLS), IAM/SSO/SCIM, input validation, secrets/KMS, PII/residency, abuse, compliance | **truepoint-security** |
| Incidents, breach response, cost/FinOps, runbooks | **truepoint-operations** |
| `apps/extension` — service worker, manifest, message bus, storage, MV3 lifecycle, build/release | **truepoint-extension-architecture** |
| The extension's LinkedIn integration — content scripts, site adapters, SPA nav, DOM extraction, hover card, ToS posture | **truepoint-extension-linkedin** |
| The extension's auth & API — companion-window handoff, extension-scoped tokens, SW API client, the enablement gates | **truepoint-extension-auth** |

**Precedence when skills tension.** Security has the final say on whether something is safe.
Platform owns the tenancy mechanism (RLS), the API contract, and scale. Data owns the model and
ownership semantics; security enforces them. Design defers to security on whether input is safe.
**Structure rules never override correctness rules** — the file-size / feature-folder rules never
justify skipping tenant-scoping, an isolation test, or input validation.

A data path is not started without **truepoint-platform** (tenancy) + **truepoint-data** +
**truepoint-security** open. A multi-tenant write without an RLS-enforced, ownership-checked path
is a bug, not a style choice.

> Skill names are `truepoint-*` (the brand); the package scope inside them is `@leadwolf/*` (the
> code) — both correct, by design. Where a skill carries an `> **Implementation status:**` note,
> the mandate is the target and the gap is work to do — never licence to skip the rule.
