# Skill Audit — Questions (round 2, 2026-07-22)

Intent calls I can't make from the code alone, plus the two PROBABLE findings needing your one-line answer. Nothing here gets edited without it.

1. **F-01 scope (`auth.md` rewrite).** The whole client-auth reference describes a nonexistent SDK/middleware model; the real pattern is app-local `authClient.ts` (PKCE, in-memory token, ADR-0016). Approve a full rewrite of `auth.md` around the shipped pattern (plus the small SKILL.md / shared-packages.md corrections) — or do you want `@leadwolf/auth` to *become* a client SDK someday, in which case I mark the file as target-architecture instead?

2. **F-02 brand section.** Replace brand.md's diamond-logo "Code Implementation Reference" with the shipped chevron `Brandmark`/`Wordmark` from `apps/web/src/components/shell/Logo.tsx` — yes/no?

3. **F-04/F-05 "Fixed — do not modify" shell specs.** Update the Sidebar/TopBar blocks in patterns.md to the shipped grid/pin/density design (they currently describe the pre-redesign shell) — yes/no?

4. **F-09 ownership model.** Mark list-visibility tiers / team visibility / per-record shares as **targets** (status notes) and state today's workspace-visible + owner-filter model — or are those mechanisms near-term roadmap you'd rather keep reading as the model, gap-noted differently?

5. **F-06 coverage numbers.** Keep "80% packages / 60% apps" as the stated *target* with a status note (my default), or delete the numbers until a gate exists?

6. **F-08 pagination prose.** Rewrite the api-contract example to the shipped flat `{ items, nextCursor|null }` shape — or is the `page:{nextCursor,hasMore}` envelope the intended v2 direction that endpoints should migrate *to*?

7. **F-25 deploy model.** Status-note the single-host/single-image downtime reality in service-topology (keeping independent-pipelines as target) — yes/no?

8. **F-44 (PROBABLE).** What fronts production Postgres — Neon pooled (`-pooler`) endpoint, or an actual RDS Proxy? One word decides the wording in four files.

9. **F-45 (PROBABLE).** Does CODEOWNERS/branch-protection exist at the GitHub org/repo-settings level (invisible to me here)? If no, compliance.md's claim gets softened to target.

10. **F-42 descriptions >1024.** Shorten the three extension-skill descriptions below the 1,024-char spec limit (no functional change in Claude Code; restores spec/portability compliance) — yes/no?

11. **F-43 TOCs.** Add short TOCs to the 200+-line reference files (batch, cosmetic) — worth doing now, or defer?

12. **Application order.** On approval I'd fix in this order: F-01 (with your Q1 answer) → F-02..F-09 (High) → Mediums → Lows, one finding at a time with per-fix re-verification, everything uncommitted for your review. Any findings you want *excluded*?
