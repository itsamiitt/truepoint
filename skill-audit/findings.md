# Skill Audit — Findings

Scope: the six `.claude/skills/truepoint-*` skills (SKILL.md + 52 reference files).
Every finding below was verified **this session** by reading the cited skill line and the
cited ground-truth source (command output or file read). Ordered most-severe first.

**Verdict in one line:** the six SKILL.md **bodies** and all frontmatter are clean; the
drift lives in the reference files — concentrated in the design component reference and the
architecture repo-structure references.

Confidence key: **CONFIRMED** = proven by source this session (fix-eligible). **PROBABLE** =
divergence proven, but the right fix depends on intent → propose, don't auto-apply.

---

### F-01 — `components.md` documents props/variants that don't match the component source
- Skill:        truepoint-design (`.claude/skills/truepoint-design/references/components.md`)
- Location:     multiple; representative lines below
- Why wrong:    The component reference — the file an agent reads to pick props for every
  `@leadwolf/ui` component — has drifted from the actual source in `packages/ui/src/components/`.
  Personally verified mismatches (skill → actual source):
  - **DataTable** column `render?` → source field is `cell` and is **required**; skill also
    types `rowKey: string | ((row)=>string)` → source is function-only `(row, index)=>string`
    (`components.md:121,126` vs `DataTable.tsx:11,34`).
  - **StatTile** `trend?: { value; up }` → source is `trend?: ReactNode`; `patterns.md:249`
    even shows the wrong usage `trend={{ value: s.delta, up: s.up }}` (`components.md:322` vs
    `StatTile.tsx:16`).
  - **Toast** `variant: 'destructive'` → source has no `variant`; it is `tone?: 'default' |
    'success' | 'error'` (`components.md:356`, `patterns.md:294` vs `Toast.tsx:15,24`).
  - **Popover / DropdownMenu** `trigger: ReactNode` → source is a **render prop**
    `(args:{toggle,open})=>ReactNode`; menu items use `onSelect`/`danger`/`separatorBefore`,
    not the documented `onClick`/`variant`/`disabled`/`{type:'separator'}` (`components.md:160-167,254`
    vs `floating.tsx:28,61-67,75`).
  - **Card** "No padding — add your own" → source hard-codes `padding: 20`; `as` default is
    `section`, not `div` (`components.md:97,100` vs `Card.tsx:8,21`).
  - **TpIconButton** `label?` (optional) → source `label: string` **required**
    (`components.md:395` vs `controls.tsx:62`); **Dialog/Drawer** `maxWidth`/`width` typed
    `string | number` → source `number` only (`components.md:141,151` vs `overlay.tsx:40,83`).
  - Additional agent-extracted instances in the same file (source file:line given, not
    re-read line-by-line by me): Avatar default `32`→`28`; Pagination props documented
    required→all optional; StateSwitch `loading/empty/error` required→optional; Combobox
    `value?: string`→`value: string|null` required; FieldGroup/FormRow/FormSection labels
    required→optional.
- Proof:        `packages/ui/src/components/DataTable.tsx:11` `cell: (row: T) => ReactNode;`
  (no `render`); `Toast.tsx:15` `type ToastTone = "default" | "success" | "error";` (no
  `variant`); `floating.tsx:44` calls `trigger({ toggle, open })` (a plain ReactNode trigger
  throws); `StatTile.tsx:16` `trend?: ReactNode;`; `Card.tsx:21` `padding: 20,`.
- Failure:      An agent copies a documented prop shape → **TypeScript error** (`cell`
  missing, excess `variant`/`render`, `string` maxWidth) or **runtime crash** (`{value,up}`
  object rendered as a React child → "Objects are not valid as a React child"; a non-function
  `trigger` → "trigger is not a function"). This is the highest-frequency defect: it fires on
  ordinary component use.
- Confidence:   CONFIRMED (8 component sources read this session).
- Fix:          Correct each documented prop/variant to match the source signatures; fix the
  `patterns.md:249` StatTile example and `patterns.md:294` Toast example.
- Blast radius: `components.md`, plus the two `patterns.md` usage examples. No code changes —
  the skills only. Fix is mechanical per-prop.

---

### F-02 — Architecture repo-structure references omit the real `src/` layer and mis-name the authed route group
- Skill:        truepoint-architecture (`references/customer-repo.md`, `references/internal-repo.md`, `references/shared-packages.md`, `references/cicd.md`)
- Location:     `customer-repo.md:13-44,91-99`; `internal-repo.md:16-32`; `shared-packages.md:45,67,110`; `cicd.md:15`
- Why wrong:    The directory trees describe `apps/web/app`, `apps/web/features`,
  `apps/web/components`, `apps/web/hooks`, `apps/web/lib`, `apps/web/middleware.ts` — but the
  repo is **`src`-rooted**: `apps/web/src/{app,components,features,lib}`. Top-level
  `apps/web/app`/`features`/`hooks`/`lib`/`middleware.ts` **do not exist**. The authed route
  group is named `(auth)` (`customer-repo.md:17,91`) but the repo uses `(shell)`; `apps/web`
  has no `hooks/` dir at all; `middleware.ts` exists only in `apps/auth`. Specific wrong file
  paths: `packages/auth/src/tokens.ts` (real: `token.ts`), `packages/types/src/schemas/`
  (types/src is flat), `packages/core/src/{phone,date,email}.ts` (core/src is subdir-structured),
  `.github/workflows/customer-web.yml` (only `ci.yml` exists).
- Proof:        `ls apps/web` → `src` (no `app`/`features`); `ls apps/web/src/app` →
  `(public) (shell) auth import layout.tsx page.tsx`; `ls packages/auth/src` → `token.ts`
  (no `tokens.ts`); `ls .github/workflows` → `ci.yml` only. (The `@/…` imports the skill
  teaches, e.g. `@/features/contacts`, DO resolve — `apps/web/tsconfig.json:13` maps
  `@/*`→`./src/*` — so import examples are fine; only the filesystem trees/paths drift.)
- Failure:      An agent reading the tree literally creates a route at `app/(auth)/…` or a
  top-level `middleware.ts` — the route lands outside the real `(shell)` group so it never
  inherits the shell layout, and the file sits at a path the `@/*` alias doesn't cover.
- Confidence:   CONFIRMED (structure verified by `ls`).
- Fix:          Insert the `src/` level in both directory trees + the "What Goes Where"
  tables; rename `(auth)`→`(shell)`; correct `tokens.ts`→`token.ts`, drop/adjust the
  `schemas/` subdir and flat `core` files, fix the workflow filename. **Larger than a
  one-liner** — a reference rewrite; flag for review before applying.
- Blast radius: `customer-repo.md`, `internal-repo.md`, `shared-packages.md`, `cicd.md`,
  `auth.md` (also cites `middleware.ts`). Design SKILL.md:173 uses `(authed)` but self-flags
  its paths illustrative (SKILL.md:178-179) — lower priority.

---

### F-03 — `tenancy.md` names `withPrivilegedTx`/`leadwolf_admin` as the cross-tenant staff path; the audited path is `withPlatformTx`
- Skill:        truepoint-platform (`references/tenancy.md`)
- Location:     `tenancy.md:141-153`
- Why wrong:    tenancy.md says platform-admin analytics / billing / support "are implemented
  with … the privileged `leadwolf_admin` role (`withPrivilegedTx`)". `client.ts` documents a
  separate, newer path — `withPlatformTx` (ADR-0032), the owner-connection super-admin path
  that **writes a `platform_audit_log` row in the same transaction** — and explicitly says it
  is used *instead of* `withPrivilegedTx` because "on Neon `leadwolf_admin` lacks BYPASSRLS and
  would fail closed." `withPrivilegedTx` is scoped to "the audited DSAR fan-out." tenancy.md
  doesn't mention `withPlatformTx` (nor `leadwolf_er`, `withPlatformReadTx`).
- Proof:        `packages/db/src/client.ts:114-119` (`withPlatformTx` … "Not withPrivilegedTx:
  on Neon leadwolf_admin lacks BYPASSRLS and would fail closed."); `:36-38` (`withPrivilegedTx`
  = "used only by the audited DSAR fan-out"); `:128-134` (auto-writes `platform_audit_log`).
- Failure:      An agent building `apps/admin` cross-tenant analytics per tenancy.md reaches
  for `withPrivilegedTx` → (a) skips the mandatory audit row that `withPlatformTx` enforces
  (tenancy.md:153 promises "every cross-tenant read by staff is auditable"), and/or (b) uses a
  role that fails closed on the actual deployment.
- Confidence:   PROBABLE (both helpers exist; whether to make `withPlatformTx` the documented
  default or keep the model-level simplification is an intent call).
- Fix:          In "Cross-Tenant Operations", name `withPlatformTx` as the general audited
  staff path (auto-audited), scope `withPrivilegedTx`/`leadwolf_admin` to the DSAR fan-out.
- Blast radius: `tenancy.md`; cross-check `access-control.md:170-178,195` (same claim).

---

### F-04 — Design skill presents non-`@leadwolf/ui` components as shared DS components to import
- Skill:        truepoint-design (`SKILL.md`, `references/patterns.md`, `references/components.md`)
- Location:     `SKILL.md:71-72,189,281`; `patterns.md:54-67,71-79,83,182-199`; `components.md:26`
- Why wrong:    The skill tells agents to reuse/import `ScorePill`, `Sidebar`, `Topbar`,
  `ContactDrawer`, `SmartSearch`, `FilterBar`, `BottomNav` from `@leadwolf/ui`
  (patterns.md:56 "the shared `@leadwolf/ui` component"; patterns.md:184 "Source of truth in
  `@leadwolf/ui`. Import it"). None are exported by `@leadwolf/ui`. `ScorePill` lives in
  `apps/web/src/features/lists/…`; `Sidebar`/`TopBar` live in `apps/web/src/components/shell/`;
  `ContactDrawer`/`SmartSearch`/`FilterBar`/`BottomNav` don't exist anywhere.
- Proof:        `grep -rn ScorePill packages/ui/src` → none; found at
  `apps/web/src/features/lists/components/ListDetailPage.tsx`. `Sidebar`→`apps/web/src/components/shell/Sidebar.tsx`;
  `TopBar`→`…/shell/TopBar.tsx`. `grep -rn 'ContactDrawer|SmartSearch|FilterBar|BottomNav' packages/ui/src apps/web/src` → none.
- Failure:      `import { ScorePill } from '@leadwolf/ui'` is an unresolved import; an agent
  told to reuse the "@leadwolf/ui Sidebar" doesn't find it and rebuilds one — the exact
  duplication the skill's hard rules forbid.
- Confidence:   CONFIRMED (grep). (Note: `TopBar` casing also differs from the skill's `Topbar`.)
- Fix:          Correct the location claims (app-shell/feature components, not `@leadwolf/ui`);
  mark genuinely-unbuilt names (`ContactDrawer`, `SmartSearch`, `FilterBar`) as target patterns,
  not existing exports. **Confirm intent** for the not-yet-built ones (see questions.md).
- Blast radius: design SKILL.md + patterns.md + components.md + accessibility.md:34,60.

---

### F-05 — Pre-build pass tells agents to scope queries by `orgId`; the canonical column is `tenant_id`/`workspace_id`
- Skill:        truepoint-architecture (`references/pre-build-thinking.md`)
- Location:     `pre-build-thinking.md:119`
- Why wrong:    "Always filter by `userId` or `orgId` on every query" names `orgId` — a column
  the data model explicitly disclaims. `data-model.md:12`: "The names below use that pair (not
  a single `org_id`)"; CLAUDE.md:23 and security SKILL.md:132 use `tenant_id`/`workspace_id`.
- Proof:        `data-model.md:10-12`; `CLAUDE.md:23` "two-tier `tenant_id`/`workspace_id`";
  `grep -rn org_id packages/db/src/schema` → no matches.
- Failure:      The pre-build pass is read before every task; it seeds the wrong scoping-column
  vocabulary, so an agent reasons about (and may write) isolation against a non-existent `orgId`
  instead of the RLS pair — the "inconsistent vocabulary across skills" defect.
- Confidence:   CONFIRMED.
- Fix:          `userId` or `orgId` → `tenant_id`/`workspace_id` (the RLS scope) in that prompt.
- Blast radius: one line in `pre-build-thinking.md`.

---

### F-06 — "RLS is `ENABLE` + `FORCE`" is stated universally, but ~30 tenant-owned tables are deliberately `ENABLE`-only
- Skill:        truepoint-platform (`references/tenancy.md`), truepoint-data (`references/data-model.md`)
- Location:     `tenancy.md:33,199`; `data-model.md:133,181`
- Why wrong:    Both state every tenant-owned table's RLS is `ENABLE` + `FORCE`. In the repo,
  92 `ENABLE` vs 62 `FORCE` statements: the auth/tenant/owner-written tables (auth.sql, billing.sql,
  etc.) are `ENABLE`-only **by design**, because they're written by the RLS-bypassing owner
  connection (`withPlatformTx`/`recordPlatformEvent`), where `FORCE` would block the owner and
  fail closed.
- Proof:        `grep -rc "FORCE ROW LEVEL SECURITY" packages/db/src/rls` → 62 vs 92 ENABLE;
  `packages/db/src/rls/auth.sql:28,33,44,50,56` (ENABLE, no FORCE); `client.ts:117-119,151-156`
  (owner-connection writers).
- Failure:      An agent adding a new owner-written table (audit/auth/platform config), following
  "always FORCE", adds `FORCE` → the owner-connection insert fails closed. This is the exact bug
  class the codebase already carved out.
- Confidence:   PROBABLE (the universal claim is provably over-broad; whether to document the
  owner-written exception or keep `FORCE`-as-safe-default is an intent call).
- Fix:          Note the `ENABLE`-only exception for owner-connection-written tables
  (platform_audit_log, auth/tenant tables).
- Blast radius: `tenancy.md`, `data-model.md`; relates to F-03.

---

### F-07 — Design references cite a `useBreakpoint` hook and `--font-weight-*` tokens that don't exist
- Skill:        truepoint-design (`references/patterns.md`, `references/tokens.md`)
- Location:     `patterns.md:210-217`; `tokens.md:167-170`
- Why wrong:    `patterns.md` documents a `useBreakpoint` hook (mobile `<640`, tablet `<1024`);
  `tokens.md` documents `--font-weight-normal/medium/semibold/extrabold` (400/500/600/800)
  custom properties. Neither exists: no `useBreakpoint` anywhere in the repo; no `--font-weight-*`
  defined in `tokens.css`/`theme.css`.
- Proof:        `grep -rln useBreakpoint packages apps` (excl. node_modules) → none;
  `grep -rn "font-weight-(normal|medium|semibold|extrabold)" packages/ui/src` → none.
- Failure:      `useBreakpoint()` → unresolved import; `var(--font-weight-semibold)` → resolves
  to nothing (invalid CSS value).
- Confidence:   CONFIRMED.
- Fix:          Remove/replace the phantom hook and font-weight tokens (use real weights or
  Tailwind classes). Confirm whether a breakpoint hook is intended (questions.md).
- Blast radius: `patterns.md`, `tokens.md`.

---

### F-08 — Stale implementation note: "there is no `scim_tokens`" — the table now exists
- Skill:        truepoint-security (`references/enterprise-iam.md`)
- Location:     `enterprise-iam.md:53-55`
- Why wrong:    The Implementation-status note says "there is **no SCIM API, no `scim_tokens`**,
  and no group mapping." A `scim_tokens` table (+ its RLS) now exists.
- Proof:        `packages/db/src/schema/scim.ts:17` `export const scimTokens = pgTable("scim_tokens", {`;
  `packages/db/src/rls/scim.sql` exists.
- Failure:      An agent building SCIM reads "no `scim_tokens`" and creates a duplicate table →
  migration collision. (The broader "SCIM stubbed" is still directionally true — only the
  `scim_tokens` clause is stale.)
- Confidence:   CONFIRMED.
- Fix:          Drop the "no `scim_tokens`" clause (keep "no SCIM API / no group mapping" if still true).
- Blast radius: one clause in `enterprise-iam.md`.

---

### F-09 — Design numeric/config values drifted from the tokens (Low)
- Skill:        truepoint-design (`references/patterns.md`, `references/tokens.md`, `SKILL.md`)
- Location:     `patterns.md:58-59,66`; `tokens.md:157,173`; `SKILL.md:83`
- Why wrong / Proof (each verified against `tokens.css`/`globals.css`):
  - Sidebar rail `RAIL_W 68 / DRAWER_W 244` (`patterns.md:58-59`) vs `tokens.css:121-122`
    `--tp-rail-w: 60px; --tp-rail-expanded: 232px`. (The `tokens.css:119-120` comment is *also*
    stale — repeats 68/244.)
  - Page-title `15px` (`tokens.md:173`) vs `globals.css` `.tp-topbar-title` `16px`.
  - "Sidebar `z-index: 20`" (`tokens.md:157`) — no `--tp-z-*` equals 20; mobile sidebar uses
    `--tp-z-drawer` (40).
  - Breakpoints are internally inconsistent (SKILL.md:83 `1280/768/375` vs patterns.md `640/1024`)
    and differ from the app media queries (`768/720/480`); none are defined as tokens.
  - Card `as` default `div`→ actual `section`; Avatar default `32`→ actual `28`.
- Failure:      Minor visual mismatch if an agent hard-codes the stale number (e.g. a 68px rail
  against a 60px token).
- Confidence:   CONFIRMED.
- Fix:          Update the numbers to the token values; reconcile the breakpoint set.
- Blast radius: design references only.

---

### F-10 — Large reference files lack a table of contents (Low, convention)
- Skill:        all (most visible: truepoint-design `references/components.md`, 426 lines)
- Location:     files >~100 lines without a TOC (Appendix A convention)
- Why wrong:    Appendix A: reference files above ~100 lines should carry a TOC so they aren't
  partially read. The larger refs (`components.md` 426, `patterns.md` 313,
  `pre-build-thinking.md` 310, `dependency-wiring.md` 239, `tokens.md` 232) start straight into
  content.
- Proof:        `head -12` of each shows a title then immediate content, no TOC.
- Failure:      Weak — these are within a single read; risk grows only past ~400 lines
  (`components.md`).
- Confidence:   CONFIRMED (convention gap, not a factual error).
- Fix:          Add a short TOC to `components.md` at minimum. Optional for the rest.
- Blast radius: cosmetic.

---

## Preferences (not defects — never auto-fixed)
- design `SKILL.md:80-81` / `tokens.md:2` blanket "every colour/radius/… is a `var(--tp-*)`" is
  loose: `--radius`, `--success`, `--danger`, `--focus-ring`, `--nav-*`, `--font-*` are
  intentionally unprefixed (tokens.md lists the real names correctly, and SKILL.md's own example
  uses `var(--radius)`). Wording, not a defect.
- `prospects` as the example table name (`tenancy.md:97`, `api-contract.md:49`,
  `access-control.md:59`) is an illustrative placeholder; the real tenant record table is
  `contacts` (`data-model.md:67`). Not a factual error, but using `contacts` would be truer.

## What checked out clean (no findings)
- All six frontmatters (name/description limits, third-person, what+when, YAML parse, no unknown
  keys). All six SKILL.md bodies (components, tokens, versions, ports, file paths, package names).
- Design **token names**: every concrete `--tp-*` named across the design skill is defined in
  `tokens.css` (spacing, z-index, density, motion, shadow scales all match).
- Design **component names** (39 of them) and most variants/props; the `{Card,TpButton,DataTable}`
  import; the StateSwitch four-state kit.
- Real DB tables/columns named in data/platform/security (contacts, accounts, lists, list_members,
  provider_calls, dsar_requests, audit_log, tenant_id/workspace_id/ownerUserId, …).
- Tenancy mechanism core: `withTenantTx`, `leadwolf_app`, `SET LOCAL ROLE`, `set_config(...,true)`,
  `NULLIF` fail-closed, `prepare:false` — all verbatim-correct against `client.ts` + `rls/*.sql`.
- Version claims (Hono 4.6.13, Bun 1.3.14, lockfile `bun.lock`); API contract (`/api/v1`,
  RFC-9457, Idempotency-Key). No backslash paths, no nested references, no MCP-tool misuse, no
  cross-skill/CLAUDE.md contradiction on brand/tooling/tenancy vocabulary (except F-05).
