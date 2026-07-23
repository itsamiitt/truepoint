# Skill Audit — Fix Log (round 2, 2026-07-22)

Applied: **all 43 CONFIRMED findings** (F-01–F-43) from `findings.md`, on user approval ("go ahead and complete this" / "fixed all issues??"). **Not applied:** F-44 (RDS-Proxy-vs-Neon wording) and F-45 (CODEOWNERS as evidence) — PROBABLE, blocked on questions.md Q8/Q9. All edits are markdown-only, uncommitted, on `feat/auth-platform-phase0`. 42 files changed, +475/−400.

Defaults taken on questions.md (user approved "all", no per-question answers): Q1 rewrite auth.md around the shipped pattern · Q2 chevron logo · Q3 update shell specs · Q4 status-note the unbuilt sharing mechanisms · Q5 keep 80/60 as noted target · Q6 flat pagination shape · Q7 status-note the deploy reality · Q10 shorten descriptions · Q11 TOCs on 200+-line refs.

## Per-finding log

- **F-01** (Critical, auth fiction) — `references/auth.md` **rewritten** around the shipped pattern (app-local `authClient.ts` PKCE / in-memory token / `silentRefresh` / `fetchWithAuth` / `AppShell`+`adminGate` gates / `useSessionIdentity`+`useSessionRole` / `@leadwolf/auth` = backend-only; every named export re-verified against source before writing). Companion edits: SKILL.md auth paragraph; shared-packages.md `@leadwolf/auth` section (real `token.ts`, no fictional tree); customer-/internal-repo.md middleware rows → authClient/gate rows. Verify: `grep -r "getSessionFromRequest|sessionIsValid|canAccessSurface" .claude/skills` → 0.
- **F-02** — brand.md logo/wordmark → chevron `Brandmark`/two-weight `Wordmark` from `Logo.tsx`; retired diamond + cobalt-box container removed. Verify: `grep "three-layer stacked diamond|M12 2 3 7"` → 0.
- **F-03** — brand.md iconography → lucide-react via DS `Icon` (+ example); patterns.md hover-actions example → `<Icon icon={Phone}/>`; tokens.md `Svg` attribution → `Icon` wrapper. Verify: `grep "IGrid|IPhone size|Svg size="` → 0.
- **F-04** — patterns.md Sidebar block → grid rail / `:has()` hover+pin push / surface-3+cobalt-glyph active / 120·180ms / `--tp-shadow-rail`; tokens.md timings matched; Page Shell diagram → `.tp-shell` grid @ 769px. Verify: `grep "onMouseEnter.*open|cobalt-50.*cobalt-700"` in patterns → 0.
- **F-05** — patterns.md TopBar → shipped cluster (GlobalSearch·DensityToggle·shortcuts·NotificationsBell·CreditPill), `--tp-hairline-2`, left pin/hamburger.
- **F-06** — coverage claim → stated-target with no-gate note in SKILL.md, testing.md, cicd.md.
- **F-07** — `@leadwolf/core` → server-side domain layer (deps named; never import into frontends) in shared-packages.md + SKILL.md.
- **F-08** — api-contract pagination → flat `{ <domain items>, nextCursor|null }` + explicit no-wrapper/no-`hasMore` sentence; consumption line fixed.
- **F-09** — ownership-and-sharing: list-visibility / team-visibility / per-record-share each marked target + status note stating today's workspace-visible reality; data-model List bullet aligned.
- **F-10** — "six skills" → nine + extension-sibling bullet in architecture/design/platform/security SKILL.md. Verify: `grep -r "six skills"` → 0.
- **F-11** — BottomNav removed in patterns.md (diagram, sidebar block, responsive table), design SKILL.md, accessibility.md, tokens.md → off-canvas sidebar + hamburger. Verify: `grep -r BottomNav` → 0.
- **F-12** — design SKILL shared-atoms list + drawer narrative + two hard rules → real shell components + "drawer composed from DS `Drawer`"; phantom names gone. Verify: `grep "SmartSearch|FilterBar"` → 0.
- **F-13** — brand review target → Brand Kit + tokens.css; brand-identity.md flagged superseded in SKILL.md + brand.md.
- **F-14** — Geist → self-hosted per app via next/font (brand.md).
- **F-15** — STAGE_TONE → "suggested mapping, not a `@leadwolf/ui` export" (components.md).
- **F-16** — ScorePill → recipe (inlined in lists Data-Health cell; extract on second use) in patterns.md, components.md, tokens.md.
- **F-17** — i18n.md status note (no layer; rule today = translation-readiness); SKILL hard rule reworded.
- **F-18** — token-driven CSS modules accepted in customer-repo.md + design SKILL styling section.
- **F-19** — `(authed)` → `(shell)` in patterns.md steps + design SKILL tree.
- **F-20** — async-jobs queue list → pointer to `register.ts` (~30 queues, per-queue DLQs, sweeps).
- **F-21** — requestId removed from envelope example; status note (no middleware yet); checklist line trimmed.
- **F-22** — tenancy ENABLE-only exception → category (~10 FORCE-less rls files; read the header before adding FORCE).
- **F-23** — data-model roles bullet → target + status note (org_role enum, requireRole/requireOrgRole, no role tables).
- **F-24** — service-topology search bullet → `searchRepository` in `@leadwolf/db` via `searchPortProvider.ts`; `packages/search` = unused seam.
- **F-25** — service-topology Deployment status note (single image, full-stack recreate, downtime window; migrate step real).
- **F-26** — forge tier added to services list (forge-api/forge-worker/forge, `leadwolf_forge`, ADR-0047 firewall).
- **F-27** — search-infrastructure status note → index-backed adapter (in-memory retired).
- **F-28** — secrets.md status note (host `.env.production` → docker build secret via deploy.sh); matching note in cicd.md Secrets section.
- **F-29** — dependencies.md audit → "belongs in the pipeline" + not-wired status note.
- **F-30** — enterprise-iam status note → five-value `org_role` enum today (boolean legacy); G-AUTH-10 = org-defined roles.
- **F-31** — access-control cross-tenant section + checklist → `withPlatformTx` general path; `withPrivilegedTx`/`leadwolf_admin` DSAR/SCIM only (Neon fail-closed noted). Verify: `grep "using an explicit elevated connection"` → 0.
- **F-32** — threats.md remote-config mitigation → marked TODO X09, treat unsigned as all-flags-off.
- **F-33** — hovercard.md X06 → fixed (remainder = panel tabs).
- **F-34** — api-client.md ErrorClass → `src/shared/types.ts`.
- **F-35** — service-worker-lifecycle → manager registers drain/flush; auth-refresh one-shot scheduled in index.ts.
- **F-36** — enablement.md stale line numbers dropped (file-level pointers kept).
- **F-37** — brand.md page title 15px → 16px.
- **F-38** — `app/api/` rows → "(none today…)" in both repo trees + SKILL.md conditional phrasing; admin `hooks/` row removed.
- **F-39** — UsageEvent → concept-not-a-table (`provider_calls` + `audit_log`) in data-model.md + enrichment-pipeline.md.
- **F-40** — observability note → worker Prometheus `/metrics` exists (extend, don't rebuild); missing = RED/tracing/SLOs/collector.
- **F-41** — tsconfig types +`"bun"` (build-release); refresh ~13→~14 min with mechanism (token-lifecycle); linkedin SKILL rule 4 → as-built popstate+observer, History patch = completion to add.
- **F-42** — three extension descriptions shortened: 1117→1012, 1142→1012, 1102→1019 chars (all ≤1024; trigger paths/terms retained; live-reloaded descriptions confirmed in-session).
- **F-43** — TOCs added: pre-build-thinking, dependency-wiring, patterns, tokens, tenancy, data-protection (components.md had one from round 1).

## Post-fix verification (Phase 6)

- **YAML/spec (check A):** inventory script re-run — 9/9 frontmatters parse (`Bun.YAML.parse`), keys exactly `name`+`description`, descriptions 654–1019 chars (**all ≤1024**), bodies ≤340 lines.
- **Stale-string sweep (checks B/D):** 30-pattern grep battery over `.claude/skills` — every defect string from findings.md now at 0 hits. Three deliberate survivors confirmed in context: `hasMore` (in the sentence saying it doesn't exist), `STAGE_TONE` (kept as suggested mapping with corrected attribution), `.env.production` references (the new status notes).
- **Sweep-caught residuals fixed during Phase 6:** patterns.md:225 responsive-table BottomNav; design SKILL `(authed)` tree; extension-auth description was 1053 on first pass → tightened to 1012.
- **Scope check:** `git status` — 42 modified files, all under `.claude/skills/`; no code, no frontmatter `name` fields, no renames, no deletions of un-understood content. Uncommitted.
- **Live reload:** the harness re-read the edited SKILL.md descriptions during the session (new descriptions active) — auto-trigger surface intact.

## Deferred / open

- **F-44** RDS Proxy vs Neon wording (4 files) — awaiting Q8.
- **F-45** CODEOWNERS-as-evidence (compliance.md) — awaiting Q9.
- Preferences section of findings.md — untouched by design.
