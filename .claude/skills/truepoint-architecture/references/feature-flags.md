# Feature Flags and Their Lifecycle

The pre-build pass and the rollback discipline lean on a single capability: turning a
feature off at runtime without a code deploy. That capability is feature flags. They
are how rollback works, how risky features ship safely, and how an incident is
mitigated in seconds (see **truepoint-operations** incident-response). This file is
the flag system and — just as important — the discipline that keeps flags from
rotting.

---

## Why Flags Exist Here

- **Runtime rollback.** A flag disables a misbehaving feature instantly, no deploy
  (the pre-build "turn it off without a code deploy" requirement). This is the first
  mitigation lever in most incidents.
- **Safe rollout.** A new feature ships dark, then to a small cohort, then widely —
  so a problem is caught at 1% of traffic, not 100%.
- **Decoupling deploy from release.** Code can merge and deploy behind a flag before
  the feature is switched on, which keeps branches short and merges clean (see
  `multi-agent.md`).

---

## The Flag System

- Flags are evaluated through a **single flag service/SDK**, never ad-hoc env checks
  scattered through the code. One evaluation path means one place to reason about and
  audit flag state.
- A flag evaluation takes the **context** needed to target: the org, the user, the
  plan, the cohort. Targeting is data (who sees the flag), not hardcoded.
- **Flag state is observable** — which flags are on, for whom — so an incident
  responder can see and change it (and changes are audited; flipping a flag in
  production is a recorded action).
- Flag checks have a **safe default** — if the flag service is unreachable, the
  evaluation returns the defined-safe value (usually "off" for a new feature), never
  an exception that breaks the page.

---

## Kinds of Flags (they have different lifetimes)

- **Release flags** — gate an in-progress feature during rollout. **Short-lived:**
  removed once the feature is fully launched and stable.
- **Ops/kill switches** — disable an expensive or risky subsystem under load (an
  enrichment kill switch, a search fallback). Longer-lived by design; they're
  operational controls (see **truepoint-operations** runbooks, which name the
  relevant kill switch per critical path).
- **Permission/entitlement flags** — gate a capability by plan/entitlement. These are
  really product configuration, often better expressed through the
  permissions/plan model (see **truepoint-security** enterprise-iam) than as a
  long-lived boolean flag — prefer the model where it fits.

Knowing which kind a flag is tells you whether it should be deleted after launch or
kept as a control.

---

## Flags Rot — Clean Them Up

A stale release flag is dead weight and a hazard: it adds a branch nobody exercises,
confuses the next agent about whether a path is live, and accumulates into a codebase
where no one knows what's actually on.

- **Every release flag has a removal owner and a planned removal**, the same way
  `REMOVE AFTER` comments do (see `removal-cleanup.md`). When the feature is fully
  launched, the flag and the now-dead "off" branch are deleted — both sides of the
  conditional are resolved to the live path.
- Removing a flag follows the removal-cleanup discipline: delete the flag check, the
  dead branch, the flag definition, and any config — then grep to confirm none
  remain. A flag referenced in code but deleted from the service (or vice versa) is a
  bug.
- Stale flags are reviewed periodically; a release flag older than its feature's
  launch is a cleanup task, not a permanent fixture.

---

## Using Flags Well

- Gate at a **clear seam** (a feature entry point), not sprinkled through many files —
  so the flag is easy to reason about and easy to remove.
- A flag is **not a substitute** for the additive-safe database discipline
  (`database.md`) — flags control code paths at runtime; schema still changes
  additively so old and new code paths both work during rollout.
- Name flags clearly for what they gate; a flag named for its ticket number is
  meaningless six months later.

---

## Checklist

- Is the feature behind a flag evaluated through the single flag service, with a
  safe default if the service is unreachable?
- Is targeting data-driven (org/user/plan/cohort), and is flag state observable and
  auditable for incident response?
- Is the flag's kind clear (release vs kill switch vs entitlement), and is an
  entitlement better expressed via the permissions/plan model?
- Does every release flag have a removal owner and a planned removal?
- When launched, are the flag, its dead branch, its definition, and its config all
  removed (grep-confirmed)?
