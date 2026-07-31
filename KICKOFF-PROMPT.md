# Kickoff prompt for Claude Code
# Usage: open Claude Code in the repo root → Shift+Tab until "plan mode on" →
# paste everything below the line.

---

Read CLAUDE.md fully, then read docs/strategy/ in numeric order (01 through 09
and decisions.md). Treat 04-opportunity-scores.md as the prioritization source
of truth and 09-compliance.md as hard constraints.

Then inspect the existing system: enumerate the repo structure, identify the
current stack, frameworks, data stores, auth, and any existing entities that
overlap with the data model in docs/strategy/08-architecture.md. List what
exists vs. what the architecture doc assumes, and where they conflict.

Then produce a Phase 1 implementation plan (scope defined in
docs/strategy/06-roadmap.md § Phase 1) containing:

1. Gap analysis — existing system vs. Phase 1 target, with a recommendation to
   adapt-in-place or add new services, and why.
2. Data model migration plan for: person, company, employment, contact_point,
   provenance_event, contributor, subscription, entitlement, usage_event, suppression_entry —
   reconciled with whatever already exists.
3. Work breakdown — ordered tasks, each tagged with the outcome ID(s) it
   advances and sized (S/M/L). Flag any task serving no listed outcome.
4. Acceptance criteria per task, derived from the outcome statements (time /
   likelihood / count form), plus the analytics events to instrument so the
   outcome metric is measurable from day one.
5. Compliance checkpoints — which tasks touch personal data and what
   09-compliance.md requires of each.
6. Open questions for me, batched at the end — do not resolve genuinely
   strategic ambiguities yourself.

Do not write any code yet. Keep the plan reviewable (I will edit it with
Ctrl+G). After I approve, we exit plan mode and implement task by task, tests
first where the acceptance criteria allow it, committing as
type(scope): summary [S-xx].

---

# Follow-up prompts (use as each phase begins)
- "Phase complete? Audit the last N commits against Phase ⟨n⟩'s outcome IDs in
  06-roadmap.md; list outcomes with no progress and work serving no outcome."
- "Plan Phase ⟨n+1⟩ per 06-roadmap.md using the same 6-part format."
- "Interviews done: here are revised Imp/Sat numbers ⟨paste⟩. Update
  04-opportunity-scores.md, recompute Opp, re-sort, and propose roadmap deltas
  for my approval. Log the change in decisions.md."
- "/jtbd-review this diff: which outcome does it advance, does it touch a
  non-goal area, do tests encode the acceptance criteria, compliance impact?"
