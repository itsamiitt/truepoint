# Multi-Agent Coordination Plan (TruePoint bus)

The single source of truth for how the lead + worker/reviewer agents coordinate over the
coordination bus. Every agent reads this and runs the **Agent Loop** below. Goal: agents run
continuously, in disjoint lanes, and finish the backlog fast — with no stepped-on work, no
guessing, and clean review before anything reaches `main`.

Canonical remote: **`origin = github.com/itsamiitt/truepoint`** (`fallowls` is dead — ignore).
Ground all planning in **committed/remote state** (`git grep HEAD`, `git ls-files`), never a
host's uncommitted working tree.

## 1. Roles
- **Lead** (orchestrator): the only assigner. Plans/decomposes goals, assigns tasks, resolves
  conflicts, detects offline agents, integrates on review approval, keeps the board truthful.
- **Workers** (worker-a, worker-b, Agent C/D, …): implement one assigned task at a time on their
  own branch; never edit another agent's files.
- **Reviewer** (reviewer-qs): the **authoritative quality+security gate**. One approval = both
  signed off. Review-only.
- **Integrator** (human + lead): pushes branches, runs `bun install`/gates where creds/tooling
  exist, merges to `main` on reviewer APPROVE.

## 2. Task lifecycle (board states)
`pending` → `claimed` (assigned) → `in_progress` → `done` (code-complete + pushed) →
`in_review` → `approved` → merged.  Side state: `blocked` (waiting on a dep/decision).
Each task carries: goal, **owned files (disjoint lane)**, acceptance criteria, `dependsOn`,
required skills. One owner per task; lanes never overlap.

## 3. The Agent Loop (every agent, every tick — run it on a short `/loop`)
1. `read_inbox(you)` — act on the **latest-timestamped** authoritative message; treat older
   messages on the same topic as **stale**. Decisions anchored to a commit SHA / task id win.
2. `get_board(you)` — see your assigned task + team state; bump your heartbeat.
3. Have an `in_progress` task → continue it. Report via `update_task` notes (state + branch@sha).
   Hit ambiguity or a cross-lane need → **`nudge` the lead and wait; never guess.**
4. Task `done`/`blocked` and you're idle → `nudge` lead "idle, ready" and claim the next
   unblocked task assigned to you. If nothing's unblocked, do **non-piling** work (review a
   peer branch, write tests, recon, docs) rather than stacking unmergeable features.
5. Every report states: **which skills you applied** (codebase-discipline / enterprise-arch /
   scalable-arch / plan-weaver), the branch + sha, and any blocker.

## 4. Planning & assignment (lead)
- Decompose goals into small, **lane-disjoint** tasks grounded in committed code.
- Assign = `create_task(assignee, files, dependsOn)` + a **nudge** (decisions go by nudge, not
  only task notes — notes get missed on first pass).
- Keep a 1–2-deep backlog per agent; don't over-pile work that can't merge yet.
- Skills are mandatory; tasks name which apply.

## 5. Integration & review flow (PRE-PROD: speed, NO pre-merge gate)
Per the standing user directive this is pre-production: **no pre-merge permission gate** —
finished work lands on `main` fast. To avoid N diverging local mains across clones there is
**ONE canonical main = `origin/main` (itsamiitt)**.
1. Worker finishes a lane → small commits → **push its branch to `origin`** (push is the only
   cred-gated step; the integrator/human does it where sandboxed agents can't).
2. The **integrator** merges the branch **directly to `origin/main`** — no approval needed. Run
   `bun install` if deps changed; CI runs the gates + every `*.itest.ts` (PG+Redis) on push.
3. **Review runs POST-merge as a continuous safety net:** reviewer-qs (authoritative) + any free
   agent audit what landed and file **REVIEW-FIX** tasks (assignee = author, against `main`).
   Issues are fixed *forward* on `main`, not blocked before it.
4. **No private mains:** agents branch off `origin/main`, push branches, and let the integrator
   land them — they do NOT each keep their own merged `main`. Reconcile any divergence back to
   `origin/main` before continuing.
Explicit trade-off: speed over a pre-merge gate — safe because it's pre-prod and review+CI catch
issues fast *after* landing.

## 6. Crossed-messages discipline (hard-won)
The bus has no causal ordering, so:
- Lead **decides once**; never reverses over trivia. If a reversal is truly needed: send **one**
  terminal message anchored to an **immutable sha/task-id** and explicitly **void the superseded
  message by id**. Then go silent and let the last command propagate.
- Never reassign off a stale "idle" message — confirm the agent isn't mid-work first.
- Agents: reconcile to the latest authoritative word; older same-topic messages are stale.

## 7. Offline agent handling
- **Offline** = no `lastSeen` heartbeat for ~15 min **and** its task isn't progressing.
- Lead detects via `get_board` lastSeen + task state, and:
  - Task unstarted/early **and lane-portable** → reassign to a free agent.
  - Task mid-flight on a branch only that agent can see → can't cleanly reassign; **flag the
    user to restart that terminal**; nudge the agent in case it returns.
- Tasks are durable on the board, so a returning agent resumes from the board (no work lost).

## 8. New agent onboarding
1. New agent `register_agent(name, role)` + reports its **environment**: git read/push creds,
   bun/docker, which branches/worktrees it can see, host.
2. Lead assigns by **capability × current gap**: a real-host agent with the right branch →
   review/gates; a free agent → the highest-priority **unblocked** task; never duplicate an
   in-flight task.
3. New agents read this file + adopt the Agent Loop immediately.

## 9. Why this finishes faster
Disjoint lanes (no collisions) + continuous per-agent loops (no lead micro-driving) + review
running concurrently with new implementation + CI verifying on push + non-piling backpressure
when blocked. The lead only plans, unblocks, resolves conflicts, and integrates.
