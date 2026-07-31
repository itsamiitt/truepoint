# TruePoint — CLAUDE.md
# Sales intelligence platform with a data contributor network

**Product brand:** TruePoint — everything a user sees. **Code identity:** the npm root is
`leadwolf` and every workspace package is `@leadwolf/*`. The brand and the scope deliberately
differ — never "fix" one to match the other. Real domains: `app.` / `auth.` / `api.` /
`forge.truepoint.in`.

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
  Router + React 19 for the four web apps; S3-compatible object storage; search is
  Postgres-backed behind a `SearchPort` seam.
- **Layout:** `apps/{web,admin,auth,api,workers,extension,forge,forge-api,forge-worker}` +
  `packages/{app-shell,auth,auth-client,config,core,db,forge-capture-sdk,forge-core,identity,
  integrations,search,types,ui}`.
- **Build:** `bun run build` · **Test:** `bun test` · **Lint:** `bun run lint` ·
  **Typecheck:** `bun run typecheck` · **Boundaries:** `bun run lint:boundaries` ·
  **Migrate:** `bun run db:migrate`.
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
| apps | `apps/web` (customer), `apps/admin` (staff), `apps/forge` (operator), `apps/extension` (MV3, dark behind `CHROME_EXTENSION_ENABLED` + `EXTENSION_ORIGINS`) |

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
