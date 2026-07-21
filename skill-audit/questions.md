# Skill Audit — Questions (unverifiable / intent-dependent — never edited without your answer)

These are the calls I can't make from the code alone. Each is answerable in one line; your
answer decides whether the related finding gets fixed and how.

1. **`src/` layer in the architecture trees (F-02).** The repo is `src`-rooted
   (`apps/web/src/…`) but `customer-repo.md`/`internal-repo.md` show `src`-less trees and the
   route group `(auth)` (real: `(shell)`). Fix the reference trees to match the repo, or do you
   intend those files to stay as an idealized/target structure?

2. **Not-yet-built design components (F-04).** `ContactDrawer`, `SmartSearch`, `FilterBar`,
   `BottomNav` don't exist anywhere. Should the skill stop presenting them as existing
   `@leadwolf/ui` exports and mark them as target patterns — or are they slated to be built as
   `@leadwolf/ui` components (leave as-is)?

3. **`ScorePill`/`Sidebar`/`TopBar` location (F-04).** These exist as `apps/web` feature/shell
   components, not `@leadwolf/ui`. Correct the skill to point at the app locations, or is the
   plan to promote them into `@leadwolf/ui` (leave the claim as aspirational)?

4. **`FORCE` RLS exception (F-06).** Should `tenancy.md`/`data-model.md` document the
   deliberate `ENABLE`-only exception for owner-connection-written tables (audit/auth/platform),
   or keep `FORCE` stated as the universal default and treat the exceptions as out-of-scope for
   the skill?

5. **Cross-tenant helper (F-03).** Make `withPlatformTx` the documented general audited
   platform-admin path in `tenancy.md` (with `withPrivilegedTx`/`leadwolf_admin` scoped to the
   DSAR fan-out)? Or is `withPrivilegedTx` still the intended primary and `withPlatformTx` an
   internal detail?

6. **`useBreakpoint` (F-07).** Is a responsive breakpoint hook planned (keep the reference and
   build it), or should `patterns.md` drop it in favour of CSS media queries like the rest of
   the app?

7. **Canonical breakpoint set (F-09).** What is the intended set? The skill contradicts itself
   (`1280/768/375` vs `640/1024`) and the app CSS uses `768/720/480`. One authoritative set
   would let me reconcile the design references.

8. **Scope of edits.** Fixing F-01/F-02 cleanly touches ~4 reference files with many small
   edits (>5 skills is not in play; it's within truepoint-design + truepoint-architecture).
   Approve the full pass, or do you want it limited to the CONFIRMED single-line fixes
   (F-05, F-08, and the clear F-01 prop corrections) first?
