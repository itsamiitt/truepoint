# Skill Audit — Findings (round 2, 2026-07-22)

Scope: all nine `.claude/skills/truepoint-*` skills (9 SKILL.md + 68 reference files, 10,008 lines — all 77 read in full this session). Detection ran as three parallel sweeps plus my own cross-skill pass; **every finding below was re-proven by me this session** against the cited source (command output or file read) unless its Confidence says otherwise. Ordered Critical → High → Medium → Low, PROBABLE at the end of its severity band.

Prior round (2026-07-20/21, commit `63270cc`) covered the six platform skills; its fixes were re-verified — the ones that still hold are listed under "Clean". Two of its findings re-surface here because the fix was partial (F-01 was explicitly deferred; F-31's sibling file was never edited).

**Verdict in one line:** frontmatter and the three extension skills are in good shape (small, precise defects only); the heavy drift is in `truepoint-architecture`'s auth/testing story, `truepoint-design`'s brand/shell references (pre-redesign spec), and `truepoint-platform/-data` claims that describe targets as built.

---

### F-01 — `auth.md` documents a client-auth SDK and middleware model that does not exist anywhere
- Skill:        truepoint-architecture (`references/auth.md`; also `SKILL.md`, `references/shared-packages.md`, repo-structure tables)
- Location:     `auth.md:43-77,88-106,124-129` · `SKILL.md:137-139` · `shared-packages.md:29-53` · `customer-repo.md:96` · `internal-repo.md:145`
- Current text: `import { getSessionFromRequest, sessionIsValid } from '@leadwolf/auth'` … "Every app's `middleware.ts` follows this structure" … "Authentication is … consumed via the shared internal `@leadwolf/auth` package. Neither app owns auth logic."
- Why wrong:    (a) Neither frontend app has a `middleware.ts` — the only one is `apps/auth/src/middleware.ts`, and it sets security headers (CSP/HSTS) only, zero session logic. (b) `@leadwolf/auth` exports none of `getSessionFromRequest` / `sessionIsValid` / `getSession` / `useSession` / `refreshSession` / `canAccessSurface` — its barrel is backend IdP primitives (`hashPassword`, `createSession`, `mintAccessToken`, JWKS, MFA, SSO) and its header says "consumed by apps/auth (the IdP origin) and apps/api (token verification)". (c) Neither `apps/web` nor `apps/admin` even depends on `@leadwolf/auth`. (d) The real client pattern is app-local: `apps/web/src/lib/authClient.ts` (PKCE `startLogin`/`completeLogin`, `silentRefresh`, `fetchWithAuth`, in-memory access token per ADR-0016) gated by `AppShell`, with `apps/admin/src/lib/{authClient,adminGate,pkce}.ts` as the admin analogues. (e) `shared-packages.md`'s package tree (`session.ts # getSession…`, `tokens.ts`, `redirect.ts`, `types/auth.types.ts`) matches nothing: the file is `token.ts`, there is no `redirect.ts`/`types/`, and `session.ts` exports server-side issuance (`createSession`/`rotateSession`/`revokeSession`). Note: `truepoint-security/references/frontend-security.md:66-69` describes the *real* model correctly — a direct cross-skill contradiction when both fire on a client-auth task.
- Proof:        `find apps/web apps/admin -maxdepth 3 -name middleware.ts` → nothing; `head apps/auth/src/middleware.ts` → "sets the mandatory security headers … HSTS, X-Frame-Options … CSP"; `head -25 packages/auth/src/index.ts` → `hashPassword`, `createSession`, `mintAccessToken`… (no session-SDK/hook exports); `grep "@leadwolf/auth" apps/web/package.json apps/admin/package.json` → no matches; `ls packages/auth/src` → `token.ts` (no `redirect.ts`, no `types/`); `ls apps/admin/src/lib`-equivalent verified (`adminGate.ts`, `authClient.ts`, `pkce.ts`).
- Failure:      An agent wiring client auth imports nonexistent APIs from a package the app doesn't depend on (hard build failure), or scaffolds per-app session middleware duplicating/contradicting the shipped in-memory-token PKCE design — an auth-boundary regression in the exact area the prior audit deferred for decision.
- Confidence:   CONFIRMED
- Fix:          Rewrite `auth.md` around the real pattern (app-local `lib/authClient.ts`, PKCE + silent refresh + `fetchWithAuth`, `AppShell`/`adminGate` gates, no Next middleware, `@leadwolf/auth` = backend-only); correct `SKILL.md:137-139` and the `shared-packages.md` `@leadwolf/auth` section; fix the two "What Goes Where" middleware rows. **Larger than a minimal diff — this is the item the prior audit deferred; needs your sign-off (questions.md Q1).**
- Blast radius: `auth.md` (whole file), `SKILL.md` one paragraph, `shared-packages.md` one section, one row each in `customer-repo.md`/`internal-repo.md`. `frontend-security.md` is already correct.

### F-02 — `brand.md`'s "canonical" logo, container, and wordmark are the retired pre-redesign brand
- Skill:        truepoint-design (`references/brand.md`)
- Location:     `brand.md:64-97` (mark + container), `:99-108` (wordmark)
- Current text: "The TruePoint logo mark is a three-layer stacked diamond. Canonical inline SVG: `<Svg size={17} sw={2.4}> <path d="M12 2 3 7l9 5 9-5-9-5Z"/> …`" … wordmark `fontWeight: 600, fontSize: 15, letterSpacing: '-0.01em'`
- Why wrong:    The shipped brand (Brand Kit + code) is **three rising chevrons** with only the apex in Cobalt — `<path d="M22 43 L50 28 L78 43">` etc. in both `Guidelines/TruePoint Brand Kit.html` and `apps/web/src/components/shell/Logo.tsx` ("Brand Kit v1.0 … three rising chevrons; apex = Cobalt, lower two = ink"). The wordmark is two-weight ("True" 400 + "Point" 700/800), not a single 600. The `<Svg>` helper does not exist anywhere. The diamond path has zero hits in the Brand Kit.
- Proof:        `grep -oE '<path d="M22 43[^"]*"' "Guidelines/TruePoint Brand Kit.html"` → `M22 43 L50 28 L78 43`; `grep -c "M12 2 3 7" "Guidelines/TruePoint Brand Kit.html"` → 0; `Logo.tsx:1,7,39` → chevron mark, apex-cobalt; `grep -rn "function Svg|const Svg" apps packages` → none.
- Failure:      Any agent placing the logo on a new surface draws the retired diamond-in-a-cobalt-box with a uniform-weight wordmark — a direct brand violation from the one file whose job is brand fidelity.
- Confidence:   CONFIRMED
- Fix:          Replace the "Code Implementation Reference" mark/container/wordmark blocks with the `Brandmark`/`Wordmark` implementation from `apps/web/src/components/shell/Logo.tsx`.
- Blast radius: `brand.md` only (colour table + typography table already match tokens.css; F-37 covers the one wrong size).

### F-03 — The `I*` icon family and `Svg` helper don't exist; icons are lucide-react via `Icon`
- Skill:        truepoint-design (`references/brand.md`, `references/patterns.md`, `references/tokens.md`)
- Location:     `brand.md:140-153` · `patterns.md:171-174` (`<IPhone size={15}/>`, `<IMail size={15}/>`) · `tokens.md:231-233` ("the `Svg` helper default")
- Current text: "All icons in `@leadwolf/ui` follow … The canonical set: IGrid, IUsers, IDeals, IContacts, … New icons are defined at the top of `@leadwolf/ui` with the `I` prefix"
- Why wrong:    Zero `I*` icon components exist in the repo. `@leadwolf/ui` ships a single `Icon` wrapper ("Pass any lucide-react glyph as `icon`", default strokeWidth 1.75); apps import glyphs from `lucide-react` (e.g. `Sidebar.tsx` imports `X` from lucide, `Icon` from the DS). No `Svg` helper anywhere.
- Proof:        `grep -rnE "\bI(Phone|Mail|Grid|Users|Deals|Bell|Dots|Building|...)\b" apps packages --include=*.tsx --include=*.ts` → no matches; `Icon.tsx:1,14` → lucide wrapper, `strokeWidth = 1.75`; `packages/ui/package.json` → `lucide-react: 1.18.0`.
- Failure:      Code copied from the `patterns.md` hover-actions example fails to compile; an agent obeying "new icons are defined at the top of `@leadwolf/ui` with the `I` prefix" forks a parallel hand-drawn icon system instead of using lucide + `Icon`.
- Confidence:   CONFIRMED
- Fix:          brand.md: "Icons are lucide-react rendered through `Icon` (`@leadwolf/ui`), strokeWidth 1.75 default; pick glyphs from lucide, don't hand-draw"; patterns.md example → `<Icon icon={Phone} size={15}/>`; tokens.md → attribute stroke default to `Icon`, drop `Svg`.
- Blast radius: three design references.

### F-04 — `patterns.md`'s "Fixed — do not modify" Sidebar spec contradicts the shipped sidebar on trigger, layout, active state, timing, and shadow
- Skill:        truepoint-design (`references/patterns.md`, `references/tokens.md`)
- Location:     `patterns.md:54-67` · `tokens.md:195-198`
- Current text: "Trigger: `onMouseEnter` → open … `<aside>` is `position: absolute` — overlays content … Active item: `background: var(--tp-cobalt-50)`, `color: var(--tp-cobalt-700)` … Shadow: `var(--tp-shadow-drawer)` when open … Sidebar uses `200ms` …; Label/badge opacity uses `160ms` with `60ms` delay"
- Why wrong:    The shipped shell is a CSS **grid**: the rail is a grid column expanded by `:has(.tp-sidebar:hover/:focus-within)` or a pin (`useSidebarPin` + TopBar toggle) — a push, not an overlay; `Sidebar.tsx` has zero mouse handlers. Active item is `background: var(--tp-surface-3); color: var(--tp-ink)` with a cobalt **glyph** only. Label reveal is `opacity var(--tp-duration-fast)` (120ms, no delay); the width transition rides `var(--tp-duration)` (180ms). The mobile overlay shadow is `--tp-shadow-rail`, not `--tp-shadow-drawer`.
- Proof:        `globals.css:176-231` → grid + `:has()` expansion; `:273-288` → `.is-active { background: var(--tp-surface-3); color: var(--tp-ink) }` + `.tp-nav-glyph { color: var(--tp-cobalt) }` (comment: "a subtle surface fill only — no colored bar/glow"); `grep -c "onMouseEnter|onMouseLeave" Sidebar.tsx` → 0; `globals.css:1171` → `box-shadow: var(--tp-shadow-rail)`.
- Failure:      An agent building the admin shell "to spec" — or auditing DS compliance — re-implements the cobalt-50 active state and absolute-overlay rail, reverting a deliberate shipped design decision on the highest-traffic chrome.
- Confidence:   CONFIRMED
- Fix:          Rewrite the Sidebar block: grid-column rail, hover/focus/pin expansion (push), active = surface-3 fill + cobalt glyph, 120ms label fade / 180ms column transition, mobile overlay `--tp-shadow-rail`. Update `tokens.md:197-198` timings to match.
- Blast radius: `patterns.md` Sidebar section, two lines in `tokens.md`.

### F-05 — `patterns.md`'s "Fixed" TopBar anatomy doesn't match the shipped TopBar
- Skill:        truepoint-design (`references/patterns.md`)
- Location:     `patterns.md:71-79`
- Current text: "Right: search input (hidden at tablet) | period `SegmentedControl` | `TpIconButton` (bell) | primary CTA" … "Bottom: `1px solid var(--tp-hairline)`"
- Why wrong:    The shipped right cluster (`TopBar.tsx:63-74`) is `GlobalSearch` · `DensityToggle` · keyboard-shortcuts `TpIconButton` · `NotificationsBell` · `CreditPill` — no period SegmentedControl, no primary CTA; the border is `var(--tp-hairline-2)` (`globals.css:386`). Height 56px/sticky/title 16px hold.
- Proof:        `sed -n '63,74p' TopBar.tsx` (cluster listed above); `globals.css:386` → `border-bottom: 1px solid var(--tp-hairline-2)`.
- Failure:      An agent building the admin topbar "to the fixed contract" adds a period picker + CTA and omits density/credits — divergent chrome between surfaces.
- Confidence:   CONFIRMED
- Fix:          Update the anatomy to the shipped cluster (+ hamburger/pin on the left) and `--tp-hairline-2`.
- Blast radius: one block in `patterns.md`.

### F-06 — "CI enforces coverage (80% packages/, 60% apps/)" — no coverage measurement exists anywhere
- Skill:        truepoint-architecture (`SKILL.md`, `references/testing.md`, `references/cicd.md`)
- Location:     `SKILL.md:277` · `testing.md:3` · `cicd.md:54-55`
- Current text: "CI enforces coverage (80% `packages/`, 60% `apps/`) but coverage is a floor."
- Why wrong:    `.github/workflows/ci.yml` runs typecheck / lint / boundaries / `bun test` (+ itest job) — no `--coverage`, no thresholds; `bunfig.toml` has only a `[test] preload`. Nothing measures coverage. (`cicd.md`'s copy sits under its per-app-pipeline status note; the other two are unmarked present-tense claims.)
- Proof:        `grep -c -i coverage .github/workflows/ci.yml` → 0; `cat bunfig.toml` → `[test] preload = ["./test/setup.ts"]` only.
- Failure:      Agents treat the gate as a safety net ("CI will fail if under-covered") and skip tests, or chase a numeric threshold nothing checks; PR text cites a nonexistent gate.
- Confidence:   CONFIRMED
- Fix:          Status-note in all three places: no coverage gate exists yet — CI runs `bun test` without coverage; 80/60 is the intended gate.
- Blast radius: three files, one clause each.

### F-07 — "`@leadwolf/core` — pure helpers only, no imports from other `@leadwolf/` packages, no async" is false; core is a server-side service layer
- Skill:        truepoint-architecture (`references/shared-packages.md`, `SKILL.md`)
- Location:     `shared-packages.md:108-117` · `SKILL.md:223`
- Current text: "Pure helpers only (there is no `utils` package). No side effects, no imports from other `@leadwolf/` packages, no async."
- Why wrong:    `packages/core/package.json` depends on `@leadwolf/config`, `@leadwolf/db`, `@leadwolf/types`; e.g. `packages/core/src/accounts/accountDualWrite.ts` imports `withTenantTx` from `@leadwolf/db` and `env` from `@leadwolf/config` and runs async in-transaction writes. Core hosts ingestion/reveal/projection/feature-flag service logic.
- Proof:        `packages/core/package.json` deps → `{'@leadwolf/config','@leadwolf/db','@leadwolf/types', libphonenumber-js, tldts, xlsx}`; `accountDualWrite.ts:17-20` → the imports above.
- Failure:      An agent imports `@leadwolf/core` into `apps/web`/`apps/admin` believing it's pure and browser-safe — dragging the server-only Postgres client toward the client bundle — or refuses to place legitimate service logic where the codebase actually keeps it.
- Confidence:   CONFIRMED
- Fix:          Reword both: `@leadwolf/core` is the shared **server-side** domain layer (depends on db/config/types; never import into frontend apps); pure formatters live in its leaf modules.
- Blast radius: two files.

### F-08 — Documented pagination envelope (`page: { nextCursor, hasMore }`) doesn't match the shipped flat contract
- Skill:        truepoint-platform (`references/api-contract.md`)
- Location:     `api-contract.md:48-63`
- Current text: `200 { "data": [ ... ], "page": { "nextCursor": "eyJpZCI6...", "hasMore": true } }`
- Why wrong:    No endpoint or shared schema returns a `page` wrapper or `hasMore`. Shipped pages are flat — e.g. `packages/types/src/lists.ts:71-74` `{ members, nextCursor: z.string().nullable() }` (null = last page); `hasMore` appears only as a local variable in `import/routes.ts` and client-derived state; no `page:{}` wrapper exists in any response type.
- Proof:        `grep -rn "hasMore" packages/types/src` → nothing; `grep -rn "page: {" packages/types/src apps/api/src/features` → only a SCIM-internal offset param; `lists.ts:71-74` quoted.
- Failure:      An agent building a new list endpoint to this file emits `{ data, page: {...} }` — inconsistent with every existing endpoint and unreadable by the existing web hooks; the "single source of truth" contract drifts in both directions.
- Confidence:   CONFIRMED
- Fix:          Replace the example with the real shape (`{ <items>, "nextCursor": "…" | null }`, null = end; clients derive has-more) and drop `hasMore` from the prose/checklist.
- Blast radius: `api-contract.md`; `large-data.md`/design references speak of `nextCursor`/`hasMore` generically — check phrasing when fixing.

### F-09 — Ownership file invents list visibility tiers, team-based visibility, and per-record shares that don't exist
- Skill:        truepoint-data (`references/ownership-and-sharing.md`)
- Location:     `ownership-and-sharing.md:44` (list visibility), `:58-60` (team visibility), `:64-66` (per-record share)
- Current text: "A List has its own visibility (private to owner, shared with named users, shared with a team, or workspace-wide)."
- Why wrong:    `lists` has no visibility column and no share model — the schema header says "Owner-vs-workspace visibility (if ever needed) is an app-layer concern — RLS only guarantees the workspace boundary"; `teams.ts` says "GROUPING ONLY: team membership NEVER restricts contact/list/search visibility"; no per-record share table exists in the schema. These three claims are unmarked present-tense; the adjacent saved-search paragraph *does* carry a status note, implying the unmarked ones are as-built.
- Proof:        `sed -n '1,6p' packages/db/src/schema/lists.ts` + `grep -c visibility lists.ts` → 1 (the comment itself); `sed -n '1,4p' teams.ts` → grouping-only; schema file list has no share table.
- Failure:      An agent (or user-facing copy written from this skill) presents a list as "private to owner" when every workspace member can read it — a real intra-workspace privacy mis-statement; or builds UI/API against a visibility field that doesn't exist.
- Confidence:   CONFIRMED
- Fix:          Status-note the three mechanisms as targets; state today's model plainly: workspace-visible, `ownerUserId` is a filter dimension, saved-search `private|workspace` is the only shipped visibility gate.
- Blast radius: `ownership-and-sharing.md`; `data-model.md:88-89` ("Has an owner and sharing") gets a cross-reference touch-up.

### F-10 — Four SKILL bodies say "TruePoint has six skills"; there are nine
- Skill:        truepoint-architecture, truepoint-design, truepoint-platform, truepoint-security (`SKILL.md` each)
- Location:     `truepoint-architecture/SKILL.md:33` · `truepoint-design/SKILL.md:41` · `truepoint-platform/SKILL.md:32` · `truepoint-security/SKILL.md:45`
- Current text: "TruePoint has six skills across orthogonal axes."
- Why wrong:    Nine skills exist (the three `truepoint-extension-*` skills landed in commit `8b035a2`); root `CLAUDE.md` says "nine skills — six platform skills plus three for the browser extension". The four "Which Skill, When" lists also omit the extension skills entirely.
- Proof:        `grep -n "six skills" .claude/skills/*/SKILL.md` → the four lines above; `ls .claude/skills` → 9 dirs; CLAUDE.md routing table lists all nine.
- Failure:      An agent inside any of the four skills routing a task that touches `apps/extension` finds no pointer to the extension skills — extension work proceeds under generic guidance, skipping the MV3/token/ToS rules those skills exist to enforce.
- Confidence:   CONFIRMED
- Fix:          "six" → "nine" plus one line noting the three extension siblings (route by the CLAUDE.md table).
- Blast radius: four SKILL.md bodies (count + list).

### F-11 — `BottomNav` is a phantom: five design/architecture spots document (and protect) a component that was never built
- Skill:        truepoint-design (primary), locations across four files
- Location:     `patterns.md:27-36,67` · `SKILL.md:184` · `accessibility.md:122-123` · `tokens.md:227-228`
- Current text: "Mobile: hide entirely, show `<BottomNav>` instead" / "On mobile, the `BottomNav` items are full-height touch targets — keep them so."
- Why wrong:    No `BottomNav` exists anywhere. Mobile (≤768px) turns the sidebar into a fixed off-canvas overlay behind a scrim, toggled by the TopBar hamburger.
- Proof:        `grep -rn "BottomNav" apps packages --include=*.tsx --include=*.ts --include=*.css` → no matches; `globals.css:1151-1177` → mobile overlay sidebar (+ `--tp-shadow-rail`).
- Failure:      An agent building a mobile surface adds a bottom nav bar (new chrome contradicting the shipped shell), or "verifies" the a11y of a component that doesn't exist while missing the real overlay-drawer focus concerns.
- Confidence:   CONFIRMED
- Fix:          Replace all BottomNav references with the real pattern: mobile off-canvas sidebar + scrim + hamburger.
- Blast radius: four design files (five spots).

### F-12 — Design SKILL hard rules mandate `ContactDrawer`/`SmartSearch`/`FilterBar` — none exist
- Skill:        truepoint-design (`SKILL.md`)
- Location:     `SKILL.md:71-72` (step-0 shared-atoms list), `:188-193` (drawer narrative), `:279-281` (hard rules: "No duplicating `Sidebar` or `ContactDrawer` — one shared source in `@leadwolf/ui`…", "use `ContactDrawer`")
- Current text: "**No navigating away from a list to show detail** — use `ContactDrawer`."
- Why wrong:    `ContactDrawer`, `SmartSearch`, `FilterBar` have zero hits in the repo. The prior audit fixed `components.md` (which now correctly says "There is no `ContactDrawer` export in `@leadwolf/ui` today — compose one from `Drawer`") and `patterns.md`, but the SKILL.md hard rules still direct agents at the phantom by name — an intra-skill contradiction with its own component reference.
- Proof:        `grep -rn "ContactDrawer|SmartSearch|FilterBar" apps packages --include=*.ts --include=*.tsx` → no files.
- Failure:      An agent obeying the zero-tolerance rule hunts for a component to reuse, finds none, and either stalls or imports a page-private drawer across features; the hard rule cannot be satisfied as written.
- Confidence:   CONFIRMED
- Fix:          Phrase as the pattern: "detail opens in a drawer composed from DS `Drawer` (see components.md) — never navigate away"; drop the phantom names or mark them target components.
- Blast radius: design `SKILL.md` only (references already fixed last round).

### F-13 — Brand-compliance review is pointed at a doc whose own header says it is superseded
- Skill:        truepoint-design (`SKILL.md`, `references/brand.md`)
- Location:     `SKILL.md:269-270` · `brand.md:10-11`
- Current text: "…token / accessibility / no-raw-hex adherence is **manual review** against `docs/planning/brand-identity.md` and `docs/planning/04-ui-ux-design.md` (and `Guidelines/`)."
- Why wrong:    `docs/planning/brand-identity.md` opens with "**Superseded** — … The authoritative brand source is `Guidelines/TruePoint Brand Kit.html` and the live design tokens in `packages/ui/src/tokens.css` … The corrected canonical facts below **override** the legacy text that follows" — its body is the legacy pre-redesign brand. `brand.md` bills it as the Kit's "planning-doc companion" without the caveat.
- Proof:        `head -8 docs/planning/brand-identity.md` → the `> [!IMPORTANT]` supersession banner.
- Failure:      A reviewer resolves a colour/token dispute from the superseded body (the same retired brand F-02 comes from) instead of the Brand Kit + tokens.css.
- Confidence:   CONFIRMED
- Fix:          Point manual review at `Guidelines/TruePoint Brand Kit.html` + `packages/ui/src/tokens.css`; mention brand-identity.md only as "superseded — header facts only".
- Blast radius: two design files.

### F-14 — "Geist … loaded automatically via the DS stylesheet" — actually self-hosted per app via next/font
- Skill:        truepoint-design (`references/brand.md`)
- Location:     `brand.md:125-127`
- Current text: "Both loaded automatically via the DS stylesheet — no separate `@font-face` needed."
- Why wrong:    `tokens.css:5-6` says the opposite: "Geist is self-hosted via next/font (the `geist` package): each app sets `--font-geist-*` on `<html>`". Each root layout must import `GeistSans`/`GeistMono` and attach the variables (`apps/web/src/app/layout.tsx:3-4,37` does); the DS supplies only fallback stacks.
- Proof:        `layout.tsx:3-4,37` next/font imports + variables; `tokens.css:5,11-13` comment + fallback stacks.
- Failure:      A new app/surface skips the next/font wiring ("the DS handles it") and silently ships system-font typography.
- Confidence:   CONFIRMED
- Fix:          "Geist is self-hosted per app via next/font (`geist` package); each root layout sets `--font-geist-*`; the DS provides the fallback stacks."
- Blast radius: one block in `brand.md`.

### F-15 — `STAGE_TONE` "from `@leadwolf/ui`" doesn't exist anywhere
- Skill:        truepoint-design (`references/components.md`)
- Location:     `components.md:336-342`
- Current text: "Stage mapping from `@leadwolf/ui`: `const STAGE_TONE = { New: 'muted', Qualified: 'success', … }`"
- Why wrong:    No `STAGE_TONE` (or any deal-stage mapping) exists in `@leadwolf/ui` or the repo; `StatusBadge.tsx` holds only the generic tone→CSS-var map.
- Proof:        `grep -rn "STAGE_TONE" apps packages --include=*.ts --include=*.tsx` → no matches.
- Failure:      An agent imports/relies on a canonical stage mapping that doesn't exist, or believes a per-callsite invention is centralized.
- Confidence:   CONFIRMED
- Fix:          Drop the attribution — present as a suggested mapping to define in the owning feature, or delete.
- Blast radius: one block.

### F-16 — "ScorePill … the app component in `apps/web` … Reuse it, never redefine" — no such component exists
- Skill:        truepoint-design (`references/patterns.md`; echoed `components.md:28`, `tokens.md:75-76`)
- Location:     `patterns.md:182-201`
- Current text: "Source of truth is the app component in `apps/web` (not a `@leadwolf/ui` export). Reuse it, never redefine"
- Why wrong:    There is no `ScorePill` component. The only occurrence is a comment ("ScorePill recipe — dot + tabular number") inside a private cell in `apps/web/src/features/lists/components/ListDetailPage.tsx:77`, which inlines the markup. The thresholds (≥80/≥50) match; there is nothing importable to "reuse".
- Proof:        `grep -rn "ScorePill" apps packages --include=*.ts --include=*.tsx` → the single comment hit.
- Failure:      An agent obeying "never redefine" searches for a component to import, finds none, and stalls — or imports a page-private cell across features.
- Confidence:   CONFIRMED
- Fix:          Reword: ScorePill is a *recipe* (dot + tabular number, 80/50 thresholds) currently inlined in the lists Data-Health cell; extract to a shared component on second use.
- Blast radius: three design files (one line each in components.md/tokens.md).

### F-17 — i18n reference mandates a translation layer that has zero infrastructure, unmarked
- Skill:        truepoint-design (`references/i18n.md`, `SKILL.md:295`)
- Location:     `i18n.md:13-21`
- Current text: "Every label, button, message, empty state, and error goes through the translation layer (a message catalog keyed by an ID), not as a literal string."
- Why wrong:    No i18n library exists in any package.json (no next-intl/i18next/formatjs/lingui — verified against the full dep list of `apps/web`), no catalog exists, and every user-facing string in the codebase — including inside `@leadwolf/ui` — is a hardcoded English literal. No status note anywhere in the file; the SKILL hard rule ("No untranslatable hardcoded user-facing strings") is stated as current law.
- Proof:        `apps/web/package.json` deps printed → no i18n package; DS components carry literal strings ("Try again", "Previous"/"Next").
- Failure:      An agent must route copy through a layer that doesn't exist — invents an unsanctioned i18n stack mid-feature, or a reviewer applying the checklist fails every existing surface including the DS itself.
- Confidence:   CONFIRMED
- Fix:          Add an implementation-status note: no i18n layer exists yet; today's enforceable rule is "write copy translation-*ready*" (no concatenation, interpolation-shaped, no string-length assumptions); the catalog is the target.
- Blast radius: `i18n.md` + one SKILL hard-rule qualifier.

### F-18 — "No CSS modules" — `apps/web` ships 28 first-party `*.module.css` files including the entire shell
- Skill:        truepoint-architecture (`references/customer-repo.md:175`), truepoint-design (`SKILL.md` styling section)
- Location:     `customer-repo.md:170-181` · design `SKILL.md:128-162`
- Current text: "**No CSS modules** unless a third-party library requires it"
- Why wrong:    28 `.module.css` files exist under `apps/web/src` — `Sidebar.module.css`, `TopBar.module.css`, `PageHeader.module.css`, plus ~20 feature stylesheets — none third-party-required. The shell the skills order agents to reuse verbatim is itself CSS-module-styled, so the stated styling model (inline `var(--tp-*)` only) misdescribes the sanctioned present-day pattern.
- Proof:        `find apps/web/src -name "*.module.css" | wc -l` → 28.
- Failure:      An agent extending the shell/features either "fixes" working module CSS into inline styles (churn) or duplicates styles inline instead of extending the feature's stylesheet — the exact inconsistency the skill exists to prevent.
- Confidence:   CONFIRMED
- Fix:          Amend both: token-driven CSS modules (`var(--tp-*)` values only) are an accepted app-styling layer alongside inline styles; the bans stay on Tailwind classes and raw values in app code.
- Blast radius: two files.

### F-19 — `patterns.md` routes new pages to an `(authed)` route group; the real group is `(shell)`
- Skill:        truepoint-design (`references/patterns.md`)
- Location:     `patterns.md:39-44`
- Current text: "1. Add a route under the authed route group: `app/(authed)/myview/page.tsx`"
- Why wrong:    The authed group in both apps is `(shell)` (its `layout.tsx` mounts the shell); no `(authed)` group exists. The design SKILL's own tree carries an "illustrative" disclaimer, and architecture's `customer-repo.md` documents `(shell)` correctly — `patterns.md` states the wrong name as literal step 1.
- Proof:        `ls apps/web/src/app` → `(public) (shell) auth …`; `ls apps/admin/src/app` → `(shell) callback …`.
- Failure:      An agent literally creates `app/(authed)/myview/page.tsx` — a new route group with no layout, so the page renders without the shell (no sidebar/topbar/auth gate). Broken surface.
- Confidence:   CONFIRMED
- Fix:          `(authed)` → `(shell)` in the steps.
- Blast radius: one block.

### F-20 — Queue registry claim ("7 queues + one imports DLQ") is a fraction of what's registered
- Skill:        truepoint-platform (`references/async-jobs.md`)
- Location:     `async-jobs.md:38-42`
- Current text: "The registered queues today are `imports`, `enrichment`, `firmographics`, `scoring`, `dedup`, `dsar`, and `outreach`, plus an `imports` **dead-letter queue**"
- Why wrong:    `apps/workers/src/register.ts` also registers `master_backfill`, `reverification`, email `sequence_tick`/`token_refresh`/retention queues, many sweep queues, and dedicated DLQs for enrichment/scoring/dsar/outreach/dedup/firmographics/master-backfill/… (~30 queues, 10+ DLQs).
- Proof:        `register.ts:264-326` (queue handles incl. `masterBackfillQueue`, `reverificationQueue`, `sequenceTickQueue`, `tokenRefreshQueue`, `retentionSweepQueue`…) and `:424-439` (eight+ `*DeadLetterQueue` exports).
- Failure:      An agent doing DLQ wiring/monitoring/fairness work treats `imports` as the only DLQ'd queue and misses two-thirds of the fleet.
- Confidence:   CONFIRMED
- Fix:          Replace the enumeration with a pointer: "the queues + per-queue DLQs + leader-locked sweeps registered in `apps/workers/src/register.ts`" — don't hardcode the list.
- Blast radius: one paragraph.

### F-21 — The error envelope's `requestId` doesn't exist; no request-id middleware at all
- Skill:        truepoint-platform (`references/api-contract.md`)
- Location:     `api-contract.md:90-98` (example), `:105-106`, `:167` (checklist)
- Current text: `"requestId": "req_8f3a..."` … "A `requestId` that ties the response to server logs/traces for support."
- Why wrong:    `packages/types/src/errors.ts:8-14` ProblemDetails = `{ type, title, status, code, detail?, [ext] }` — no requestId; `middleware/error.ts` emits none; zero non-test `requestId` hits in `apps/api/src`.
- Proof:        errors.ts shape quoted; `grep -rn requestId apps/api/src --include=*.ts | grep -v test` → nothing.
- Failure:      Support/debug flows ask users for an ID that never existed; a typed client requiring `requestId` fails to parse every error.
- Confidence:   CONFIRMED
- Fix:          Mark as target (status note: not emitted yet) or drop from the envelope/checklist.
- Blast radius: `api-contract.md`; `observability.md` mentions requestId correlation generically (its status note already covers the gap).

### F-22 — tenancy.md's ENABLE-only RLS exception is enumerated far too narrowly
- Skill:        truepoint-platform (`references/tenancy.md`; softer echo `truepoint-data/references/data-model.md:131-134`)
- Location:     `tenancy.md:33-37` (and checklist `:205-208`)
- Current text: "(Exception: tables written by the RLS-bypassing **owner** connection — the auth/tenant tables and `platform_audit_log`, via `withPlatformTx`/`recordPlatformEvent` in `client.ts` — are `ENABLE`-only…)"
- Why wrong:    Ten whole RLS files have zero `FORCE` — auth, creditLedger, eventOutbox, notifications, platform, platformOps, projectionOutbox, providerConfigs, subscriptions, workerOutbox (plus purchases/audit_log inside billing.sql) — and their writers are Stripe-webhook/worker/system paths on the raw owner connection, not (only) `withPlatformTx`/`recordPlatformEvent`. `rls/notifications.sql` documents the deliberate pattern.
- Proof:        `grep -c "FORCE ROW LEVEL SECURITY" packages/db/src/rls/*.sql | grep ":0"` → the ten files; `notifications.sql:8-10` → "ENABLE (not FORCE) — deliberately … a FORCE policy would BLOCK the owner".
- Failure:      An agent "hardening" RLS adds `FORCE` to notifications/credit_ledger/subscriptions because the skill says only auth tables + platform_audit_log qualify — Stripe grants, low-balance notifications, and import-complete writes then fail closed in production. This is the exact bug class the prior audit's F-06 fix was meant to prevent; the enumeration re-narrowed it.
- Confidence:   CONFIRMED
- Fix:          State the exception as the *category*: "any table whose system writers run on the owner connection — see the per-file headers in `packages/db/src/rls/*.sql` (~10 files today)"; drop the two-item list.
- Blast radius: `tenancy.md` two spots; optional one-word touch in `data-model.md` ("e.g." list is category-shaped already).

### F-23 — "Roles are data, not hardcoded enums" — they are hardcoded enums
- Skill:        truepoint-data (`references/data-model.md`)
- Location:     `data-model.md:42-49`
- Current text: "**Role / Permission** — roles are **data, not hardcoded enums** … this model must represent custom tenant-defined roles"
- Why wrong:    No roles/permissions tables exist. Org roles are a closed five-value varchar enum (`auth.ts:102-106`, ADR-0030: `owner|billing_admin|security_admin|compliance_admin|member`, enforced by `requireOrgRole`); workspace roles are hardcoded strings in `requireRole("owner","admin","member","viewer")` calls. `truepoint-security/enterprise-iam.md` marks the same mandate with a status note; data-model states it unmarked.
- Proof:        `auth.ts:102-106` quoted; `billing/routes.ts:86` `requireRole(...)`; schema has no roles/permissions tables.
- Failure:      An agent modelling a new permission looks for role/permission tables to attach rows to (none exist), or tells a tenant admin custom roles are supported.
- Confidence:   CONFIRMED
- Fix:          Keep the mandate, add the status note: today = closed enums (`org_role` + `requireRole`/`requireOrgRole`); roles-as-data is the target (G-AUTH-10).
- Blast radius: one bullet.

### F-24 — "search … today lives in the `@leadwolf/search` package consumed in-process" — nothing imports that package
- Skill:        truepoint-platform (`references/service-topology.md`)
- Location:     `service-topology.md:46-49`
- Current text: "Today this lives in the `@leadwolf/search` package consumed in-process"
- Why wrong:    Zero source imports of `@leadwolf/search` exist. Live search is `searchRepository` in `@leadwolf/db`, wired by `apps/api/src/features/search/searchPortProvider.ts` (its header: "The adapter lives in @leadwolf/db (searchRepository)…"), with `SearchPort` types in `@leadwolf/types`.
- Proof:        `grep -rn 'from "@leadwolf/search"' apps packages --include=*.ts*` → no matches; `searchPortProvider.ts:1-6` quoted.
- Failure:      An agent extending search edits `packages/search/*` — dead code; the change silently does nothing.
- Confidence:   CONFIRMED
- Fix:          Point at `@leadwolf/db` `searchRepository` + the api `searchPortProvider`; note `packages/search` holds only the unused in-memory adapter/ADR-0021 seam.
- Blast radius: one bullet.

### F-25 — "Each service deploys independently … zero-downtime rolling deploys" — single image, single script, documented downtime window
- Skill:        truepoint-platform (`references/service-topology.md`)
- Location:     `service-topology.md:106-116`
- Current text: "Each service deploys independently (its own pipeline…)" / "**Zero-downtime deploys**: rolling, with health checks"
- Why wrong:    One `leadwolf:latest` image is built and all services recreated together by `deploy/deploy.sh`; the script itself documents "SINGLE-HOST DEPLOY DOWNTIME WINDOW: each service runs as exactly one container, so `up -d` RECREATES it".
- Proof:        `deploy.sh:87` (single build), `:119` (window comment), `:127` (`up -d api auth workers web admin forge-api forge-worker forge caddy`).
- Failure:      An agent ships a "workers-only" change assuming the API isn't touched, or relies on zero-downtime for a business-hours deploy — the whole stack restarts.
- Confidence:   CONFIRMED
- Fix:          Status note: independent pipelines/rolling deploys are the target; today = one image + full-stack recreate with a downtime window (the decoupled migrate step is real).
- Blast radius: one section.

### F-26 — "The Services That Do Exist" omits the deployed Forge tier
- Skill:        truepoint-platform (`references/service-topology.md`)
- Location:     `service-topology.md:29-57`
- Current text: (services list names only `apps/api`, `apps/workers`, future `realtime`, in-package `search`)
- Why wrong:    `apps/forge-api`, `apps/forge-worker`, `apps/forge` exist, are compose services, deploy via `deploy.sh`, and have their own DB role/schema (`withForgeTx`, `leadwolf_forge`, ADR-0047 — "the ingest→verify pipeline can never read a customer's contacts").
- Proof:        `ls apps` → forge, forge-api, forge-worker; `docker-compose.prod.yml:168,184,198`; `client.ts:64-66` quoted.
- Failure:      An agent placing backend logic per this file puts forge-domain logic in `apps/api` — breaching the ADR-0047 schema/role firewall the forge tier exists to enforce.
- Confidence:   CONFIRMED
- Fix:          Add the three forge services with one line on the isolation rationale.
- Blast radius: one section.

### F-27 — search-infrastructure's status note describes a retired implementation as "today"
- Skill:        truepoint-data (`references/search-infrastructure.md`)
- Location:     `search-infrastructure.md:31-37`
- Current text: "search runs today on Postgres behind an **in-memory `SearchPort` adapter** (`apps/api/src/features/search/searchPortProvider.ts`; …)"
- Why wrong:    That file now wires the Postgres index-backed adapter and says so: "This replaces the bounded in-memory candidate set (the 500-row cap) with a real, index-backed query path."
- Proof:        `searchPortProvider.ts:1-6` quoted.
- Failure:      An agent assumes search is a 500-row in-memory scan and "re-platforms" a path that is already index-backed, or makes wrong scale judgments.
- Confidence:   CONFIRMED
- Fix:          Update the note: today = Postgres index-backed adapter via `searchRepository` behind `SearchPort`; OpenSearch/Typesense remain ADR-0021 future work.
- Blast radius: one status note.

### F-28 — secrets.md asserts a secrets manager and pipeline-pulled secrets that don't exist (unmarked)
- Skill:        truepoint-security (`references/secrets.md`)
- Location:     `secrets.md:52-63`
- Current text: "Real secret values live in a secrets manager (AWS Secrets Manager, Doppler, or the platform's equivalent), injected at deploy time. Per the CI/CD skill, the pipeline pulls them" … "The CI role has read-only access to secrets"
- Why wrong:    No secrets manager anywhere; production secrets are a gitignored `.env.production` on the deploy host consumed by `deploy/deploy.sh` as a docker build secret; CI pulls no secrets. The KMS section right below carries a status note; this section doesn't. (`cicd.md:135-147` shows the same aspirational AWS example — one fix should reconcile both.)
- Proof:        `grep -rin "doppler|secretsmanager" packages/config/src deploy` → nothing; `deploy.sh:7,87`.
- Failure:      An agent rotating/adding a prod secret hunts for a nonexistent manager instead of `deploy/env.production.template` + host `.env.production`; compliance answers cite manager-based injection that doesn't exist.
- Confidence:   CONFIRMED
- Fix:          Status note stating today's mechanism (host `.env.production` → docker build secret via `deploy/deploy.sh`); manager remains the target.
- Blast radius: `secrets.md` one section; optional matching note in `cicd.md`.

### F-29 — dependencies.md claims a vulnerability audit runs in CI; none does
- Skill:        truepoint-security (`references/dependencies.md`)
- Location:     `dependencies.md:26-36` (and checklist `:85-86`)
- Current text: "A vulnerability audit (`bun audit`, or `npm audit` against the same tree) runs in the pipeline"
- Why wrong:    `ci.yml` has zero audit steps (typecheck/lint/boundaries/tests only).
- Proof:        `grep -c -i audit .github/workflows/ci.yml` → 0.
- Failure:      CVE scanning treated as an operating control that nobody ever adds; a known-vulnerable dep ships unflagged.
- Confidence:   CONFIRMED
- Fix:          Mark as target ("add `bun audit` to CI") — the frozen-lockfile sentence above it is accurate and stays.
- Blast radius: one paragraph + checklist line.

### F-30 — enterprise-iam's status note is stale: "only an `is_tenant_owner` boolean" — a granular `org_role` enum now exists
- Skill:        truepoint-security (`references/enterprise-iam.md`)
- Location:     `enterprise-iam.md:79-83`
- Current text: "The model today is only an `is_tenant_owner` **boolean**, not org-defined roles with permission sets."
- Why wrong:    `tenant_members.org_role` exists (ADR-0030: `owner|billing_admin|security_admin|compliance_admin|member`, enforced by `requireOrgRole`; the boolean is commented "legacy — derived into org_role below").
- Proof:        `auth.ts:102-106` quoted.
- Failure:      An agent gating a new tenant-admin endpoint checks `isTenantOwner`, collapsing the five-role model (a `billing_admin` locked out; owner-only where `security_admin` should pass) — or rebuilds a role column that exists.
- Confidence:   CONFIRMED
- Fix:          Update the note: today = fixed five-value `org_role` enum + `requireOrgRole`; the remaining G-AUTH-10 gap is org-*defined* data-driven roles/permission sets.
- Blast radius: one status note.

### F-31 — access-control.md attributes general cross-tenant staff ops to `leadwolf_admin`; the as-built path is `withPlatformTx` (owner connection), and `leadwolf_admin` fails closed on Neon
- Skill:        truepoint-security (`references/access-control.md`)
- Location:     `access-control.md:170-178` and checklist `:195`
- Current text: "implemented via a tiny reviewed set of functions using an explicit elevated connection (the privileged `leadwolf_admin` role) that bypasses tenant RLS" / "Are cross-tenant operations restricted to `leadwolf_admin`…"
- Why wrong:    The platform-admin console runs on `withPlatformTx` — the DB-owner connection that writes a `platform_audit_log` row in the same transaction; `client.ts` states explicitly "Not withPrivilegedTx: on Neon leadwolf_admin lacks BYPASSRLS and would fail closed." `leadwolf_admin`/`withPrivilegedTx` is scoped to the DSAR/SCIM-token fan-out. The prior audit fixed this in `tenancy.md` (F-03) and flagged access-control.md as blast radius, but this file was never edited.
- Proof:        `client.ts:129-133` quoted; `grep -c withPlatformTx apps/api/src/features/admin/routes.ts` → 62, `withPrivilegedTx` → 0.
- Failure:      An agent building a new cross-tenant admin feature per this file reaches for `leadwolf_admin` → empty reads (fail-closed) on the actual deployment; a reviewer applying the checklist flags 62 compliant call sites as violations.
- Confidence:   CONFIRMED
- Fix:          Mirror tenancy.md's corrected wording: `withPlatformTx` (owner conn, auto-audited, behind the `pa` claim) = the general staff path; `withPrivilegedTx`/`leadwolf_admin` = DSAR/SCIM fan-out only.
- Blast radius: one section + one checklist line (retention-and-deletion.md's `leadwolf_admin`-for-DSAR claim is correct and stays).

### F-32 — threats.md lists remote-config signature checking as an existing mitigation; there is no signature check (or remote fetch) yet
- Skill:        truepoint-extension-auth (`references/threats.md`)
- Location:     `threats.md:22-23`
- Current text: "Mitigation: … remote config is signature-checked and fail-closed (X09) and can only flip flags, never change behavior."
- Why wrong:    `remoteConfig.ts` is a local-cache scaffold — "This scaffold caches flags locally; the signed fetch + signature check is the follow-up". The sibling skill (`build-release-and-store.md:23-24`) states this correctly as a marked TODO; the threat model asserts it as present.
- Proof:        `remoteConfig.ts:1-5` quoted.
- Failure:      A threat review accepts "config tampering: mitigated" and the fail-closed check is skipped when the remote fetch is added — exactly the tampering path the mitigation should close.
- Confidence:   CONFIRMED
- Fix:          "…signature check is a marked TODO (X09) — until it ships, treat unsigned/unverified config as all-flags-off."
- Blast radius: one bullet.

### F-33 — hovercard.md calls the X06 owned-action miswire "a known miswire to fix"; it's already fixed
- Skill:        truepoint-extension-linkedin (`references/hovercard.md`)
- Location:     `hovercard.md:23-25`
- Current text: "(this is a known miswire to fix — doc 14 X06)"
- Why wrong:    The owned branch now opens the app; the code comment marks the fall-through as previous behavior and doc 14's log records the fix (2026-07-21).
- Proof:        `hovercard/index.ts:128-133` → "Previously this fell through to the capture path (the chrome-extension/14 X06 miswire)" + `window.open(...)`.
- Failure:      An agent hunts for / "re-fixes" a wired branch, or reports the surface broken in a status audit.
- Confidence:   CONFIRMED
- Fix:          "(fixed; the X06 remainder is the panel tabs)".
- Blast radius: one parenthetical.

### F-34 — api-client.md says `ErrorClass` comes from `@leadwolf/types`; it's local to the extension
- Skill:        truepoint-extension-auth (`references/api-client.md`)
- Location:     `api-client.md:13`
- Current text: "→ a typed `ErrorClass` (from `@leadwolf/types`)"
- Why wrong:    `ErrorClass` is defined in `apps/extension/src/shared/types.ts`; `client.ts:12` imports it from `../../shared/types.ts`; `packages/types/src` has no such export.
- Proof:        `grep -rn ErrorClass packages/types/src` → nothing; `client.ts:12` quoted.
- Failure:      An agent extending the error taxonomy edits `@leadwolf/types` (compile error / shadow type).
- Confidence:   CONFIRMED
- Fix:          "(from `src/shared/types.ts`; the wire schemas are what come from `@leadwolf/types`)".
- Blast radius: one line.

### F-35 — service-worker-lifecycle.md says the event manager registers the `auth-refresh` alarm; it registers `drain`/`flush` only
- Skill:        truepoint-extension-architecture (`references/service-worker-lifecycle.md`)
- Location:     `service-worker-lifecycle.md:10-11`
- Current text: "The as-built `BrowserEventManager` … registers alarms for `drain`, `flush`, and `auth-refresh`"
- Why wrong:    `manager.register()` creates only `drain` (1 min) and `flush` (5 min); `auth-refresh` is a one-shot alarm scheduled from token expiry in `background/index.ts` (`chrome.alarms.create("auth-refresh", { when })`) and merely routed by the manager.
- Proof:        `manager.ts:25-26` and `index.ts:29-32` quoted.
- Failure:      An agent tuning refresh cadence edits `manager.register()` (no effect) instead of the expiry-driven scheduling in `index.ts`.
- Confidence:   CONFIRMED
- Fix:          "registers `drain` and `flush`; the one-shot `auth-refresh` alarm is scheduled from token expiry in `index.ts` and routed here."
- Blast radius: one line.

### F-36 — enablement.md pins two env gates to stale line numbers
- Skill:        truepoint-extension-auth (`references/enablement.md`)
- Location:     `enablement.md:10-11`
- Current text: "`env.ts:760-763`" (appOrigins) / "`packages/config/src/env.ts:567`" (CHROME_EXTENSION_ENABLED)
- Why wrong:    `appOrigins` is at `env.ts:843`; `CHROME_EXTENSION_ENABLED` at `:634`. (The `:38` anchor and the regex are still right.)
- Proof:        `grep -n "export const appOrigins|CHROME_EXTENSION_ENABLED: z" packages/config/src/env.ts` → 843 / 634.
- Failure:      An agent jumps to the cited lines and lands in an unrelated flag block, mis-editing the wrong gate.
- Confidence:   CONFIRMED
- Fix:          Drop the line numbers (they rot) or update to `:634`/`:843`.
- Blast radius: two table cells.

### F-37 — brand.md says page title is 15px; tokens.md, patterns.md, and the shipped CSS all say 16px
- Skill:        truepoint-design (`references/brand.md`)
- Location:     `brand.md:130`
- Current text: "| Page title | 15px | 600 |"
- Why wrong:    `.tp-topbar-title` is `font-size: 16px; font-weight: 600` (`globals.css:400-402`); tokens.md:173-175 and patterns.md:77 both say 16px — intra-skill contradiction plus wrong vs code.
- Proof:        `globals.css:400-402` quoted.
- Failure:      A new page title styled at 15px, visibly off from every existing surface.
- Confidence:   CONFIRMED
- Fix:          `15px` → `16px`.
- Blast radius: one cell.

### F-38 — Repo-structure trees list an `app/api/` BFF layer and an admin `hooks/` dir that don't exist
- Skill:        truepoint-architecture (`references/customer-repo.md`, `references/internal-repo.md`, `SKILL.md`)
- Location:     `customer-repo.md:24` · `internal-repo.md:23,28` · `SKILL.md:90-91`
- Current text: "`│   ├── api/  # Route handlers — BFF only`" … "Next.js route handlers (`app/api/`) do only BFF aggregation, auth-cookie handling, and the few frontend-owned webhooks" … admin tree lists `hooks/`
- Why wrong:    Neither app dir contains an `api/` directory or any `route.ts`; all traffic goes direct to `apps/api` via `fetchWithAuth`. `apps/admin/src` has `app components features lib` — no `hooks/`. (The middleware rows are covered by F-01.)
- Proof:        `ls apps/web/src/app` → `(public) (shell) auth import layout.tsx page.tsx providers.tsx globals.css`; `ls apps/admin/src/app` → `(shell) callback globals.css layout.tsx page.tsx`; `ls apps/admin/src` → `app components features lib`.
- Failure:      An agent hunts for the BFF/auth-cookie handlers "the frontend owns" (they don't exist), or scaffolds into a tree location the app doesn't use.
- Confidence:   CONFIRMED
- Fix:          Mark `api/` "(none today — create only if a BFF route is genuinely needed)"; reword SKILL.md to conditional ("route handlers, if added, do only…"); drop `hooks/` from the admin tree.
- Blast radius: three files, tree rows + one paragraph.

### F-39 — data-model presents `UsageEvent` as an existing entity; finops documents that no such table exists
- Skill:        truepoint-data (`references/data-model.md`; echo `references/enrichment-pipeline.md:129`)
- Location:     `data-model.md:123-127`
- Current text: "**UsageEvent** — metered actions (enrichment calls, exports) for quota and billing … Reliable, since billing depends on it."
- Why wrong:    No `usage_events` table exists; the metered ledger is `provider_calls` (`cost_micros`) + the append-only `audit_log` — exactly what `finops.md:69-73`'s status note says ("there is no single table named `UsageEvent`"). Unmarked here while sibling entries in the same section carry status notes.
- Proof:        `grep -rn "usage_events|usageEvents" packages/db/src/schema` → nothing; finops note quoted.
- Failure:      An agent emits/queries a UsageEvent row with nowhere to land instead of writing the `provider_calls`/ledger rows billing actually reads.
- Confidence:   CONFIRMED
- Fix:          Copy finops's clarification into the bullet (concept = `provider_calls` + `audit_log` today).
- Blast radius: two bullets.

### F-40 — observability's status note denies metrics that exist (worker Prometheus `/metrics`)
- Skill:        truepoint-platform (`references/observability.md`)
- Location:     `observability.md:11-15`
- Current text: "no distributed tracing/OpenTelemetry, no RED/USE metrics pipeline, and no codified SLOs/error budgets"
- Why wrong:    USE-style queue metrics exist and are scrapeable: per-queue depths/counters/DLQ sizes rendered as Prometheus text on the workers' `/metrics` (`apps/workers/src/metrics.ts` — "Scrapeable by any Prometheus-compatible collector today"). No-OTel/no-SLOs remain accurate.
- Proof:        `metrics.ts:1-7` quoted.
- Failure:      An agent rebuilds metrics emission that already exists instead of extending `metrics.ts`/`instrument()`.
- Confidence:   CONFIRMED
- Fix:          Amend the note: worker queue/DLQ Prometheus metrics exist (`apps/workers/src/metrics.ts`); missing = API-side RED metrics, tracing, SLOs, collector/dashboards.
- Blast radius: one status note.

### F-41 — Small confirmed extension-doc inaccuracies (grouped)
- Skill:        truepoint-extension-architecture / -auth / -linkedin
- Location:     `build-release-and-store.md:10-11` · `token-lifecycle.md:20-21` · `truepoint-extension-linkedin/SKILL.md:59-61`
- Current text: (a) "`types: ["chrome", "node"]`" (b) "**Proactive refresh on `chrome.alarms`** (~13 min, ahead of the 15-min access TTL)" (c) "detect navigation via History-API + `popstate` + a debounced `MutationObserver`"
- Why wrong:    (a) actual tsconfig is `["chrome", "node", "bun"]` (dropping `bun` breaks `bun test` typing). (b) the alarm fires at `expiry − 60s` (`REFRESH_LEAD_MS = 60_000`) ≈ **14 min** for the 900s TTL, floored at +30s. (c) `observer.ts` has no History-API patch (0 `pushState` hits) — popstate + MutationObserver + path-compare only; the reference file correctly frames the patch as a to-add completion, the SKILL body states it as-built.
- Proof:        `apps/extension/tsconfig.json:8`; `background/index.ts:17-18,29`; `grep -c pushState content/observer.ts` → 0.
- Failure:      (a) an agent copying the documented tsconfig breaks test typing; (b) wrong cadence when tuning refresh; (c) an agent assumes pushState navigations are caught — profile-to-profile navigations that mutate no observed container could be missed silently.
- Confidence:   CONFIRMED
- Fix:          (a) add `"bun"`; (b) "~14 min (expiry − 60s)"; (c) match the reference file's phrasing (popstate + observer today; History patch is the completion to add).
- Blast radius: three one-line edits.

### F-42 — Three extension-skill descriptions exceed the 1,024-char spec limit
- Skill:        truepoint-extension-architecture (1117), truepoint-extension-auth (1142), truepoint-extension-linkedin (1102)
- Location:     frontmatter `description` of each SKILL.md
- Current text: (the three folded descriptions; lengths measured by `Bun.YAML.parse` this session)
- Why wrong:    The Agent Skills authoring spec (fetched this session from platform.claude.com best-practices) states: "`description`: … Maximum 1,024 characters". All three exceed it. Claude Code itself truncates the *listing* only at 1,536 chars (fetched from code.claude.com skills doc), so nothing is lost in this harness today — but any spec-enforcing surface (API skill upload, claude.ai sync validation) can reject or truncate them.
- Proof:        phase0-inventory.mjs output: descLen 1117/1142/1102; both docs fetched this session with the quoted limits.
- Failure:      Skill validation failure or silent truncation outside Claude Code; portability of the skill set breaks.
- Confidence:   CONFIRMED (limit + measurements; the *harm today in Claude Code* is nil — that's why this is Low)
- Fix:          Tighten each description below 1,024 chars (the sibling-skill cross-references are the compressible part; keep trigger terms in the first sentence).
- Blast radius: three frontmatter blocks; auto-trigger behavior must be preserved (re-read after edit).

### F-43 — TOC convention unmet on long reference files (carryover from round 1)
- Skill:        multiple
- Location:     reference files >100 lines without a TOC: design `patterns.md` (300), `tokens.md` (233), architecture `pre-build-thinking.md` (310), `dependency-wiring.md` (239), `cicd.md` (195), platform `tenancy.md` (216), security `data-protection.md` (205), `access-control.md` (195), and others in the 100–200 band
- Current text: (files open straight into content)
- Why wrong:    Authoring best-practices (fetched this session): "For reference files longer than 100 lines, include a table of contents at the top." Round 1 filed this as F-10 and fixed only `components.md`.
- Proof:        file heads read this session; line counts from the inventory script.
- Failure:      Weak — partial reads lose orientation; risk grows with length.
- Confidence:   CONFIRMED (convention gap, not a factual error)
- Fix:          Short TOC on the 200+ files at minimum. Low priority.
- Blast radius: cosmetic, many files — batch only with approval.

### F-44 — "RDS Proxy in this deployment" — repo evidence says Neon pooled endpoint; no RDS Proxy is provisioned anywhere
- Skill:        truepoint-platform (`references/data-platform.md:42-44`, `SKILL.md:122-124`, `references/scaling-playbook.md:16-18`, `references/tenancy.md:135-137`)
- Location:     as above
- Current text: "A transaction-mode pooler (RDS Proxy in this deployment; equivalent to PgBouncer transaction mode)"
- Why wrong:    Nothing in the repo provisions RDS Proxy. `deploy/env.production.template:79-81` steers to "Managed Postgres (Neon / RDS)… Neon's default string is the POOLED (`-pooler`) host"; `client.ts` comments were written against Neon behavior ("on Neon leadwolf_admin lacks BYPASSRLS"). The functional guidance (transaction pooling, `prepare:false`) is correct either way.
- Proof:        template + client comments quoted; `grep -rl "RDS Proxy" deploy docker-compose.prod.yml` → nothing.
- Failure:      An agent debugging pooling hunts for RDS Proxy config that doesn't exist; RDS-Proxy-specific assumptions (pinning, IAM auth) creep in.
- Confidence:   PROBABLE — live infra isn't provable from the repo; all repo evidence points at Neon. Needs your one-line confirmation (questions.md Q8).
- Fix:          "a transaction-mode pooler (the managed provider's pooled endpoint — Neon `-pooler` today; PgBouncer/RDS-Proxy-equivalent)".
- Blast radius: four files, one phrase each.

### F-45 — compliance.md cites CODEOWNERS as change-management evidence; no CODEOWNERS file exists
- Skill:        truepoint-security (`references/compliance.md`; prescriptive echo in architecture `multi-agent.md:49-51`)
- Location:     `compliance.md:26-29`
- Current text: "(the architecture CI/CD, CODEOWNERS, and PR discipline are the evidence…)"
- Why wrong:    No CODEOWNERS file anywhere in the repo (`.github/` holds only `workflows/`). `multi-agent.md` frames it prescriptively ("back it with repo enforcement"), which is a mandate, not a claim — only compliance.md presents it as existing evidence.
- Proof:        `find . -maxdepth 3 -name CODEOWNERS -not -path "*/node_modules/*"` → nothing.
- Failure:      An auditor-facing answer names evidence that can't be shown.
- Confidence:   PROBABLE — an org-level CODEOWNERS (GitHub org settings / another repo) can't be ruled out from here (questions.md Q9).
- Fix:          "the CI gate and PR discipline are the evidence (CODEOWNERS is a target — see truepoint-architecture)".
- Blast radius: one clause.

---

## Preferences (not defects — never auto-fixed)
- `messaging.md:15` "drops unknowns" — the bus actually replies `{ error: "bad_message" }`; functionally a drop, but "rejects with a typed error" would be exact.
- `tenancy.md`/`access-control.md` use `prospects` as the example table (real: `contacts`) — clearly illustrative.
- `caching.md`'s "Redis is currently used for BullMQ queues and rate-limiting" omits smaller uses (leader locks, send-throttle) — the status note's gist is right.
- `service-topology.md:52-55` "Their Next.js route handlers do only BFF/auth-cookie/owned-webhook work" — `apps/auth` (the IdP) legitimately has route handlers + a direct DB dependency; phrasing could exclude it explicitly.
- `state-and-data.md` deviations (no `lib/queryClient.ts`, no default options, `keys.ts` sparse) — the file opens with "if the codebase differs… match the codebase", so these are self-hedged.
- Sibling reference→reference cross-links are pervasive but every reference is *also* linked directly from its SKILL.md table, so the one-level-deep rule's failure mode (content reachable only at depth 2) does not occur. No action needed.

## What checked out clean (spot-verified this session)
- **All 9 frontmatters** parse (real YAML parser), keys exactly `name`+`description`, names valid/≤64, third-person what+when, no XML, bodies ≤341 lines. Six descriptions ≤1,024 (three over — F-42).
- **Extension skills** (first-ever audit): `manifest.md` matches `manifest.config.ts` field-for-field (permissions, hosts, `externally_connectable`, CSP string, absent WAR/options/identity/cookies/webRequest); companion-handoff flow steps match code; token tiers/rotation/EdDSA/`storage.session`; api-client Bearer/Idempotency-Key/401-retry-once and the `rl:api` 120 / `rl:capture` 2000 / `rl:reveal` ~60 limits exact (`packages/auth/src/rateLimit.ts`); enablement gate semantics (regex, explicit-"true"-only, CORS+audience via `appOrigins`); storage tiers; ui-surfaces; adapters/observer/extract/hovercard file map; `linkedinPublicId`/`linkedinCompanyUrl` columns exist; dep-cruiser `extension-stays-thin` rule exists.
- **Tenancy core**: `withTenantTx`/`leadwolf_app`/`SET LOCAL ROLE`/`app.current_tenant_id`+`app.current_workspace_id`/`NULLIF` fail-closed/`prepare:false` all verbatim-correct; `withPlatformTx` audited-in-same-tx behind `pa` (prior F-03 fix holds in tenancy.md); two-tier pair with no `org_id` (prior F-05 fix holds).
- **Design tokens**: every `--tp-*`/`--radius`/`--danger*`/`--focus-ring` value named in the skills matches `tokens.css` (cobalt family, z-scale 30–90, durations 120/180/260, rail 60/232, row/table density, spacing scale); breakpoints 769/768/480 real; `.tp-topbar` 56px/sticky; prior F-01/F-07/F-09 component-prop fixes all hold against current sources (DataTable `cell`, StatTile `trend?: ReactNode`, Toast tones, render-prop Popover/DropdownMenu, Card `section`/padding 20, Avatar 28, TpIconButton `label` required, Combobox `value: string|null`, no `useBreakpoint`, no `--font-weight-*`).
- **Platform/data**: `/api/v1` + RFC-9457 `problem+json` via `AppError`/error middleware; Idempotency-Key middleware; queue names in `@leadwolf/types`; `provider_calls` `request_hash` cache + `cost_micros`; `dsar_requests` platform-owned via `withPrivilegedTx` (retention-and-deletion's claim is correct); consent `withdrawnAt` suppression; saved-search `private|workspace` app-layer note accurate; SCIM status note accurate post-fix (Users shipped, Groups TODO); Hono 4.6.13 / port 3001 / `bun.lock` / Biome+dependency-cruiser tooling notes all exact.
- **Operations**: all four references are process guidance; every repo-factual claim (finops ledger/credits/quota-gap notes, observability dependency note) verified accurate — zero findings.
- **Hygiene**: no MCP tool references, no secrets/keys/endpoints in any skill file, no Windows-style paths, no `--force`/`--no-verify`/skip-RLS instructions anywhere; every data-access instruction in the skills carries tenant scoping (check G: no criticals).

## Coverage statement (per §7)
- Skills found: 9. Fully read by me: 9 (77/77 files, in full, this session). Partially read: 0.
- Checks run: A (spec — scripted re-measure + real YAML parse + reachability), B (integrity — file-existence for every cited repo path in findings, nesting map, TOC census, MCP grep, script census [none exist]), C (cross-skill coherence + CLAUDE.md + main-agent-prompt), D (drift — tokens diff, component props vs source, structure `ls`, schema/table names, queue/env/gate names, code-example symbol verification), E (installed-version claims vs package.json/node_modules facts; both Anthropic authoring docs re-fetched this session), F (trigger surface + description lengths + overlap matrix), G (safety — secrets grep, bypass-instruction grep, tenant-scoping review).
- Checks skipped or reduced, with reasons: **D code-block typecheck-extraction was NOT run as a compiler pass** — skill code blocks are context-dependent fragments (imports omitted by design), so each was verified at symbol level (does the named export/prop/table/env var exist with that signature) instead; a tsc pass over synthetic files would have produced noise, not signal. **E external-world claims** (LinkedIn "BrowserGate", Chrome Web Store policy, `ExtensionInstallForcelist`) not verifiable from the repo and not adjudicated. **Live-infra properties** (Neon vs RDS Proxy, staging/preview domains, org-level CODEOWNERS, on-device X16 login path) unverifiable from the repo → held at PROBABLE/UNVERIFIED, never edited.
- Findings: **43 CONFIRMED** (F-01–F-43), **2 PROBABLE** (F-44, F-45), unverified items → `questions.md`.
- Fixes applied: 0 — gate held per operating doc §2 (no "autonomous" keyword; and the CONFIRMED set spans 8 skills, past the >5-skill stop line that applies even in autonomous mode).
- What I could not verify and what I'd need: production DB fronting (your one line: Neon pooled vs RDS Proxy), org-level CODEOWNERS/branch protection (GitHub settings screenshot or `gh api`), the extension's visible interactive-login path X16 (on-device test), external-world claims (out of scope).
- This audit is not "complete" in the absolute sense: the reduced code-block check, the unverifiable live-infra items, and the external-world claims above are the gaps.
