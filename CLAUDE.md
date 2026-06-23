# TruePoint — Project Guide for Agents

**Product brand:** TruePoint — everything a user sees. **Code identity:** the npm root is
`leadwolf` and every workspace package is `@leadwolf/*`. The brand and the scope deliberately
differ — never "fix" one to match the other. **Repo:** one Bun monorepo (Bun 1.3.14 + Turbo +
Biome, not pnpm/ESLint) — `apps/{web,admin,auth,api,workers}` + `packages/{auth,config,core,db,
integrations,search,types,ui}`. Real domains: `app.` / `auth.` / `api.truepoint.in`.

The multi-agent operating model (topology, QSA gate, task briefs) lives in
`docs/planning/main-agent-prompt.md`; planning docs in `docs/planning/`; the live navigation
map in `docs/ARCHITECTURE_MAP.md` (kept in sync by `.claude/hooks/gen-architecture-map.mjs`).

## Skills — when to use which

This project ships six skills under `.claude/skills/`. Most real features need several at
once. **Before writing any code, file, or migration, read the `SKILL.md` of every skill your
task touches** — and run the pre-build pass in `truepoint-architecture` first.

### Routing — pick by what the task involves

| If the task involves… | Use |
|---|---|
| Backend logic (`apps/api`, Hono on Bun), the database (`packages/db`, Drizzle + RLS), the **tenancy model** (two-tier `tenant_id`/`workspace_id`), the API contract (`/api/v1`, cursor pagination, idempotency-key, RFC 9457 envelope, shared Zod in `@leadwolf/types`), queues (`apps/workers`, BullMQ/Redis), caching, service boundaries, deploy, "will this scale / what breaks at 10x" | **truepoint-platform** |
| The data model, who owns/can-see a record (owner-scope & list-based sharing), enrichment, verification, search over the dataset, retention/deletion/DSAR | **truepoint-data** |
| Where frontend code/files/components live (`apps/web` customer, `apps/admin` internal), feature structure, client state & data fetching, frontend tests, feature flags | **truepoint-architecture** |
| Anything that renders — `@leadwolf/ui` components, tokens (`var(--tp-*)`), layout, large tables/lists, accessibility (WCAG 2.2 AA), motion, copy, i18n, brand | **truepoint-design** |
| Whether it's safe — access control & tenant isolation (RLS), IAM/SSO/SCIM, input validation, secrets/KMS, PII/residency, API hardening, abuse/scraping, telephony, compliance | **truepoint-security** |
| Running it in production — incidents, breach response, cost/FinOps (metered enrichment), runbooks | **truepoint-operations** |

### Composition — most features touch several

Example — "add a prospect to a list" needs: **architecture** (the feature folder/hook/query-key
in `apps/web`) + **platform** (the `apps/api` endpoint, idempotency, write path) + **data** (the
`list_members` row, ownership, activity/audit) + **design** (`@leadwolf/ui` button, modal, toast,
four states) + **security** (tenant- and workspace-scoped, ownership-checked write; the list ID
from the client is never trusted). Read all that apply.

### The mandatory pre-build gate

For every task, run the pre-build reasoning pass in
`truepoint-architecture/references/pre-build-thinking.md` and present the plan before coding.
That pass **asks** the hard questions; the answers come from:
- scale, queues, caching, **tenancy**, pooling → **truepoint-platform**
- data model, ownership/sharing, enrichment, search, deletion → **truepoint-data**
- access, IAM, residency, abuse, compliance → **truepoint-security**

Don't answer a tenancy/scale/data question from first principles when a skill fixes the answer
— cite it.

### Precedence when skills tension

- **Security has the final say on whether something is safe.** On any access, tenant-isolation,
  secret, PII, or compliance point, security wins over convenience or structure.
- **Platform owns the tenancy mechanism (RLS), the API contract, and scale.** Data,
  architecture, and design build on them, not around them.
- **Data owns the model and ownership semantics; security enforces them.**
- **Design owns what renders; it defers to security** on whether input/data is safe (client
  validation is UX, not a boundary).
- **Structure rules never override correctness rules** — the file-size / feature-folder rules in
  architecture never justify skipping tenant-scoping, a missing isolation test, or input
  validation.

### Non-negotiable read-first rule

The relevant `SKILL.md` is read **before** any code/file/migration in that area. A data path is
not started without `truepoint-platform` (tenancy) + `truepoint-data` + `truepoint-security`
open. A multi-tenant write without an RLS-enforced, ownership-checked path is a bug, not a style
choice.

> **Notes.** Skill names are `truepoint-*` (the product brand); the package scope inside them is
> `@leadwolf/*` (the code) — both are correct, by design. Several skills carry
> `> **Implementation status:**` notes where the codebase does not yet meet a mandate: the
> mandate is the target and the gap is work to do — never license to skip the rule.
