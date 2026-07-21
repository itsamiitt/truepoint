# Skill Audit — Fix Log

All edits are to skill **reference files** only (no SKILL.md frontmatter/body, no app code).
Each fix re-verified against source. `git diff --name-only .claude/skills/**/SKILL.md` → empty
(no frontmatter touched; YAML intact).

## Files touched
- design: `components.md`, `patterns.md`, `tokens.md`
- architecture: `pre-build-thinking.md`, `customer-repo.md`, `internal-repo.md`, `cicd.md`, `shared-packages.md`
- platform: `tenancy.md`  ·  data: `data-model.md`  ·  security: `enterprise-iam.md`

---

## F-01 — components.md props/variants → match source
18 edits so the documented API matches `packages/ui/src/components/*`:
- DataTable `render?`→`cell` (required) + `sortValue?`/`align?` added; `rowKey` → `(row,index)=>string`
- StatTile `trend` object → `ReactNode`; Toast `variant:'destructive'` → `tone:'error'`
- Popover/DropdownMenu `trigger` → render prop; item `onClick/variant/disabled/{type:'separator'}` → `onSelect/danger/separatorBefore`
- Card "no padding" → `padding:20`; `as` default `div`→`section`; Avatar `32`→`28`; TpIconButton `label?`→required
- Dialog/Drawer `maxWidth`/`width` `string|number`→`number`; Combobox `value?`→`value: string|null`; Pagination/StateSwitch/FieldGroup/FormRow/FormSection required→optional
- patterns.md usage examples fixed (StatTile `trend={<StatusBadge…>}`, Toast `tone:'error'`, DataTable `cell:`)
- Verify: `grep -c "render?: (row|variant: 'destructive'|trend?: { value" components.md` → 0; `cell: (row` / `tone: 'error'` / `onSelect?` present. ✅

## F-02 — architecture repo structure → `src/`-rooted, real route group
- customer-repo.md + internal-repo.md: directory trees + "What Goes Where" tables re-rooted under
  `src/`; route group `(auth)`→`(shell)`; workflow comment → `ci.yml`.
- shared-packages.md: `types/src` `schemas/`→flat; `ui/src` `tokens//primitives//composed/`→real
  `*.css` + `components/`; core `phone.ts/date.ts/email.ts`→domain modules.
- cicd.md: added implementation-status note (single `ci.yml` today; per-app pipelines are the target).
- Verify: `grep -rl "(auth)/" truepoint-architecture` → 0; `(shell)/` + `src/app/(shell)` present. ✅
- **DEFERRED (needs your decision — see report):** `@leadwolf/auth` is backend auth primitives, but
  `auth.md` (whole client-SDK model: `getSessionFromRequest`/`useSession`/`session.canAccessSurface`/
  per-app `middleware.ts`) and shared-packages.md's `@leadwolf/auth` section describe a client wrapper
  that doesn't exist. Bigger than F-02 + intent-dependent → NOT rewritten.

## F-03 — tenancy.md cross-tenant path → `withPlatformTx`
- Rewrote the "Cross-Tenant Operations" bullet: general staff path = `withPlatformTx` (owner conn,
  auto-writes `platform_audit_log`); `withPrivilegedTx`/`leadwolf_admin` reserved for DSAR fan-out.
- Verify: `grep -n withPlatformTx tenancy.md` → :36,153,159. ✅

## F-04 — mislocated/phantom design components
- ScorePill: `@leadwolf/ui` → app component in `apps/web` (components.md:26, patterns.md:184, tokens.md:75).
- Sidebar/Topbar: `@leadwolf/ui` → app-shell (`apps/web/src/components/shell/`) (patterns.md:56,73).
- ContactDrawer: components.md note clarifies it's composed from `Drawer`, not a `@leadwolf/ui` export.
- Verify: `grep "Source of truth in \`@leadwolf/ui\`|custom atom in" design/` → 0. ✅

## F-05 — pre-build pass `orgId` → `tenant_id`/`workspace_id`
- pre-build-thinking.md:119. Verify: `grep "orgId" pre-build-thinking.md` → 0. ✅

## F-06 — RLS FORCE exception documented
- tenancy.md:33,199 + data-model.md:133: noted `ENABLE`-only for owner-connection-written tables
  (auth/tenant, `platform_audit_log`) — `FORCE` would block the owner writer and fail closed.
- Verify: `grep -c "ENABLE\`-only" …` → 3. ✅

## F-07 — phantom hook + tokens removed
- patterns.md: removed the fictional `useBreakpoint` hook; replaced with CSS-media-query guidance +
  the app's real breakpoints (769/768/480).
- tokens.md: removed the 4 non-existent `--font-weight-*` "tokens" (weights are raw values; corrected
  the "800 large stat" claim to 600/700); removed the retired `--accent` token (→ real `--danger-700`).
- Verify: `grep "function useBreakpoint|font-weight-extrabold|\`--accent\`" design/` → 0. ✅

## F-08 — stale SCIM note (broader than reported)
- enterprise-iam.md:53-57. Finding said only "no `scim_tokens`" was stale; on fixing, the whole
  "no SCIM API, no `scim_tokens`" clause was stale — `apps/api/src/features/scim/` (/scim/v2/Users) +
  token mint/list/revoke exist. Corrected to: user provisioning + `scim_tokens` exist; **group mapping**
  (`/scim/v2/Groups`) remains TODO.
- Verify: `grep "no SCIM API, no" enterprise-iam.md` → 0. ✅

## F-09 — design numeric drift
- patterns.md/tokens.md: rail `68/244`→`60/232` (real tokens `--tp-rail-w`/`--tp-rail-expanded`);
  page title `15px`→`16px`; sidebar `z-index:20`→`--tp-z-drawer` (40, consistent with the z-scale).
- Verify: `grep "68px\` (constant|244px\` (constant|z-index: 20|15px, 600" design/` → 0. ✅

## F-10 — components.md navigation aid
- Added a "Finding a component" pointer (Decision Tree + alphabetical props) below the intro.

---

## Handled by status-note (not rewritten — aspirational-vs-current, matches the skills' own pattern)
- cicd.md per-app-pipeline model (one `ci.yml` today).

## Coverage
- Findings fixed: F-01, F-03, F-04, F-05, F-06, F-07, F-08, F-09, F-10 fully; F-02 structural part
  fully, `@leadwolf/auth` model **deferred** for your decision.
- Newly surfaced while fixing: F-08 scope larger (fixed accurately); the `@leadwolf/auth` client-SDK
  fiction in auth.md + shared-packages.md (deferred). Both reported, not silently expanded.
