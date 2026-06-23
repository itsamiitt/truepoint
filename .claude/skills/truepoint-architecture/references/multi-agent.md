# Multi-Agent Coordination

TruePoint is built by multiple agents working in parallel against the one shared git
monorepo, coordinating through git + worktrees (the repo uses `.claude/worktrees`) and
small commits. This file is how independent agents avoid stepping
on each other and produce work that merges cleanly. The failure modes of parallel
agents are different from — and worse than — those of a single agent.

If only one agent is working, most of this still applies (it keeps commits clean and
reviewable) but the collision rules matter less.

---

## The Core Problem

Two agents editing the same file at the same time produces merge conflicts, lost
work, or — worse — silently inconsistent state where each assumed its version won.
The architecture is already designed to minimise this: small single-responsibility
files, feature folders, barrel exports. Parallel work amplifies why those rules
matter.

The principle: **agents coordinate through git (branches, worktrees under
`.claude/worktrees`, small commits), not through
shared memory.** An agent cannot see what another is "thinking" — only committed
files and the work plan. So everything coordination-relevant must be visible in the
repo.

---

## Claiming Work

- Work is scoped to a **feature folder** or a **package**, never a vague
  cross-cutting task. "Build the prospect-lists feature" is claimable; "improve the
  app" is not.
- Two agents must not hold overlapping scopes. If features A and B both need a change
  to the same shared file, that shared change is its own claimed unit, done once,
  committed, and then both build on top.
- The file-size rule is a coordination tool: because each file does one thing, two
  agents working different concerns rarely touch the same file. Needing to edit a
  file another agent owns is a signal the work was scoped wrong — re-scope rather
  than edit across boundaries.

---

## Enforcement, Not Just Convention

Honor-system claiming is not enough at scale — back it with repo enforcement:

- **CODEOWNERS** assigns owning teams/areas to paths, so a PR touching a path
  requires the owner's review. This makes "who owns this" mechanical, not social.
- **Branch protection** on the default branch: required passing pipeline (lint,
  type-check, test, build), required review, no direct pushes. A green build for
  every other agent who pulls is guaranteed by the gate, not by goodwill (see
  `cicd.md`).
- **Collision-magnet files have a single owner** and are changed in small,
  immediately-committed units (below).

---

## The Shared-File Rule

Some files are touched by many features and are collision magnets. Treat edits as
serialized, single-owner operations:

- The shared permissions/policy definitions
- Shared design tokens (one source, the `--tp-*` namespace — see `shared-packages.md`)
- Root `turbo.json`, `biome.json`, the root `package.json` workspaces, `.env.example`
- Any barrel `index.ts` many features re-export through
- The shared API-contract schemas (`@leadwolf/types` Zod schemas), imported by both
  `apps/api` and the clients — a schema change ripples to every consumer, so coordinate
  it (see **truepoint-platform** api-contract)

When a feature needs a change here, make it a small, standalone, immediately-
committed unit — not a side-edit buried in a long-lived feature branch. The longer a
shared file diverges across branches, the worse the conflict.

---

## Database Migrations Across Parallel Agents

Migrations are a special collision point because order matters and two agents authoring
migrations independently will clash:

- **Migrations are sequenced.** Two agents each adding a sequence-prefixed Drizzle Kit
  migration in `packages/db/src/migrations` create an ordering ambiguity and can
  conflict on the same table (and on the `meta/` snapshots).
  Treat new migrations like a shared-file change: coordinate, and rebase so the
  sequence is linear and unambiguous (see `database.md` and **truepoint-platform**
  data-platform).
- **Never edit a migration that has run anywhere but your own machine** — write a new
  one (`database.md`).
- A migration plus the code that depends on it land in the **additive-safe order**
  (add column → backfill → use it; stop using → drop later), so a parallel agent who
  pulls mid-sequence never gets a broken schema/app pairing.
- For a schema change two features both need, the migration is its own claimed unit,
  landed first, before either feature builds on it.

---

## Commit Discipline for Parallel Work

- **Commit small and often.** A committed file is visible; an uncommitted one in a
  working tree is invisible and will collide.
- **One logical change per commit.**
- **Pull before you push** — integrate others' committed work first, so conflicts
  surface in your terminal where you have context, not in CI.
- **Never leave a feature half-wired across a push.** If you push, the pushed state
  must build and type-check. Use the `// WIRE:` stub pattern for anything incomplete
  so the build stays green for everyone who pulls.

---

## Stubs Keep Parallel Agents Unblocked

The `// WIRE:` stub pattern (from `dependency-wiring.md`) is doubly important with
parallel agents. If A depends on something B is still building, A stubs it with a
typed no-op and a `// WIRE:` comment rather than waiting or reaching into B's
unfinished code:

```ts
// WIRE: replace with real listExport once feature/list-export lands (owner: agent-3)
async function exportList(_id: string): Promise<Blob> {
  throw new Error('list export not yet implemented')
}
```

A's work builds, type-checks, and merges independently. When B lands, a grep for
`// WIRE:` surfaces every connection point. Name the owning unit so the dependency is
traceable.

---

## Merging and Integration

- Each claimed unit produces a focused change that builds and passes type-check and
  tests on its own, not depending on another agent's uncommitted work.
- Shared-file changes (including migrations and the shared `@leadwolf/types` schemas) land first, as their
  own units, before dependent features.
- If two units genuinely must change the same file, they are not independent —
  sequence them: one lands, the other rebases on top.

---

## What NOT to Do

- Do not hold a large multi-file change uncommitted while doing other work.
- Do not edit a file outside your claimed scope to "quickly fix" something — flag it
  as a separate unit; another agent may own it.
- Do not author a migration without coordinating its place in the sequence.
- Do not assume another agent's in-progress feature exists — stub against the
  contract, not the assumption.
- Do not push a state that fails to build or type-check.
- Do not resolve a merge conflict by blindly keeping your side — understand both
  sides (each is another agent's correct work) before resolving.
