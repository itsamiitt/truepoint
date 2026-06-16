---
name: plan-weaver
description: >-
  Plan, refine, and keep LeadWolf's planning docs (docs/planning/) completely wired and consistent.
  Use when adding or changing ANY plan, decision, feature, milestone, schema, enum, ADR, or roadmap
  item in docs/planning/ — or when asked to audit/sync/wire the planning docs, or check them for
  drift. Reads the whole corpus, produces a structured plan, and propagates the change across EVERY
  related .md file (decision log, cross-links, feature↔milestone matrix, risk register, ADRs, README,
  shared enums/vocab) so nothing ever drifts out of sync. To execute a planned change (commits,
  pre-commit checks, scale, deploy), follow codebase-discipline.
---

# plan-weaver

**Prime directive: keep all of LeadWolf's plans completely wired to each other.** Any change to one
planning document must be propagated to every related document in the same pass, so the corpus is never
internally inconsistent. You are the guardian of cross-document coherence.

The planning corpus lives in `docs/planning/` (files `00-overview.md` … `10-roadmap.md`, `README.md`)
and `docs/planning/decisions/` (ADRs). It is **tightly coupled by design** — a single decision is
reflected in the decision log, one or more deep docs, an ADR, cross-links, matrices, and shared
vocabularies. Editing one file alone reliably leaves the others stale. This skill prevents that.

## When this skill applies

Use it for any of:
- **Add** — a new module/feature, section, doc, or decision.
- **Change** — an existing decision, value, schema element, milestone assignment, or ADR.
- **Refine** — expand or rewrite existing planning content.
- **Audit** — read-only: report drift/inconsistencies without changing anything.

If the request is unrelated to `docs/planning/` (e.g. application code), this skill does not apply.

## Required reading before you act

Always load these first — they are the skill's knowledge base:
1. `reference/doc-map.md` — the wiring map: doc adjacency graph, the wiring points (decision log,
   matrices, README index), the 10 drift hazards (H1–H10), the shared-vocabulary index, and the ADR
   registry. **This is the source of truth for "what is connected to what."**
2. `reference/conventions.md` — the house style every edit must match.
3. `reference/consistency-checklist.md` — the audit you run before finishing.

Then read the actual in-scope planning docs (don't trust the map blindly — re-derive from the live
files and update your understanding if the docs have structurally changed; note any drift you find).

## Operating workflow (follow in order)

### 1. Load context
Read the three reference files above, then the planning docs relevant to the request. Confirm the live
docs still match `doc-map.md`; if the structure drifted, trust the live files and flag the map as
needing an update (you may update `doc-map.md` itself as part of the change).

### 2. Classify the request
Decide which kind it is: **add / change / refine / audit**. For **audit**, skip to step 6 and emit only
the report (make no content edits).

### 3. Build and present the impact set
Using the doc-map adjacency + the 10 hazards + the shared-vocabulary index, enumerate **every** file,
section, table, ADR, and matrix the change touches. Cross-check against the hazards explicitly — e.g.
if the change touches the reveal transaction, the impact set MUST include all of {07 §3, 08 §3, 09 §3}
(H1); if it touches an enum like `email_status`, include every usage location (H7).

Present this impact set to the user as a short list ("I will edit: …") **before** editing. This is the
"impact set → apply → report" mode. Proceed to apply in the same turn unless the change is genuinely
ambiguous or destructive — then ask.

### 4. Author the primary change
Edit the lead document first, matching `conventions.md` exactly (numbered headings, relative link
style, markdown grid tables, mermaid only for architecture, integer credits, confidence ∈ [0,1], bold
for **terms**). Make **surgical** edits — never rewrite an entire doc when a section will do.

### 5. Propagate across the whole impact set (the wiring step)
In the same pass, update every connected location so the corpus stays coherent:

- **Decision log** (`00-overview.md` §7): add or modify the row; set its "Why / ADR" rationale link.
- **Cross-links:** add/repair links in both directions where the map marks a pair as bidirectional.
- **Feature ↔ milestone:** update the matrix in `05-features-modules.md` **and** the milestone detail in
  `10-roadmap.md` together — they must always agree (H10).
- **Risk register** (`10-roadmap.md`): adjust a risk row or its owner-milestone if the change affects it.
- **ADRs** (`decisions/`): for a significant or previously-locked decision, create a new ADR from
  `templates/adr-template.md` and/or set the superseded ADR's `Status:` to `Superseded by ADR-NNNN`.
  **Never silently overwrite a locked (Accepted) ADR decision.**
- **README index** (`README.md`): update the table if a doc is added, renamed, or removed.
- **Open-questions** sections: mark resolved items, or add newly-surfaced ones, in the right doc.
- **Shared vocabulary:** if an enum / role / ledger-entry-type / status value changes, update its
  definition (usually in `03-database-design.md`) **and every usage** listed in the vocab index.
- **doc-map.md:** if the change adds/removes a doc, link, hazard, or vocab term, update the map too.

### 6. Run the consistency check
Execute `reference/consistency-checklist.md` against the changed set (and, for audit mode, the whole
corpus): broken links, header numbering, decision-log↔ADR parity, matrix↔roadmap parity,
risk↔milestone-DoD parity, enum/vocab drift, ADR status integrity, orphaned/contradictory decisions.
Fix anything you can; report anything that needs a human decision.

### 7. Report
Emit a concise change report:
- **Request** — one line restating what was asked.
- **Impact set** — the files/sections touched.
- **Changes** — bullet per file: `path §section — what changed`.
- **Wiring verified** — which hazards/links/matrices you reconciled.
- **Consistency** — `pass | warn | fail` + any remaining issues.
- **Follow-ups** — new open questions or decisions the user should make.

## Guardrails (non-negotiable)

- **Completeness over speed.** Never stop after editing the lead doc; the job is done only when every
  connected file is reconciled and the consistency check passes.
- **The tripod rule:** the lead doc, the decision log (00 §7), and the relevant ADR must always agree.
  If you touch one of these for a decision, touch the other two.
- **Don't fabricate.** If a value isn't decided (e.g. pricing placeholders in 07 §1), reference the
  placeholder; never invent a concrete number in prose.
- **Locked decisions are sacred.** Change them only via a new or superseding ADR with rationale, plus a
  decision-log update — never an in-place rewrite.
- **Surface conflicts.** If a requested change contradicts an existing decision/ADR, say so and propose
  options instead of silently resolving it.
- **Match the voice.** Edits must be indistinguishable from the existing docs (see conventions).

## Invocation examples

- `add a "data exports & webhooks" module` → write it into `05`, update the feature↔milestone matrix +
  `10` roadmap, add cross-links, add a decision-log row, run the check, report.
- `change the search engine decision to Typesense` → supersede/extend ADR-0002, update decision log
  (00 §7), `03 §14`, `10` Beyond, resolve the related open question, report.
- `audit` (or `check the plans for drift`) → read-only consistency report across the whole corpus, no
  edits.
