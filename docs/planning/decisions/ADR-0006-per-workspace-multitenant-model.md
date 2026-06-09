# ADR-0006 — Per-workspace multi-tenant data model

- **Status:** Accepted
- **Date:** 2026-05-29
- **Context doc:** [02-architecture.md](../02-architecture.md), [03-database-design.md](../03-database-design.md)
- **Supersedes:** [ADR-0005](./ADR-0005-multi-tenancy-and-global-contact-db.md) (global shared contact DB) and [ADR-0003](./ADR-0003-three-layer-data-model.md) (three-layer raw/provenance/golden model)
- **Amended by:** [ADR-0019](./ADR-0019-global-identity-and-tenant-membership.md) (user-scoping → global identity + `tenant_members`); [ADR-0021](./ADR-0021-global-master-graph-and-overlay.md) (the *no-global-golden-record* clause **reopened** — a global master graph is added as **Layer 0**; the per-workspace model below stands as the **Layer 1 overlay**)

## Context

LeadWolf is repositioned from a **global data vendor** (one shared, de-duplicated golden contact DB everyone searches) to a **per-workspace prospecting CRM**: each paying customer (**tenant**) has one or more **workspaces** (teams/brands/regions/clients), and each workspace builds and owns its **own** contacts and accounts — imported and enriched from external sources (Apollo, ZoomInfo, LinkedIn, Sales Navigator, CSV, CRM). Different workspaces deliberately keep separate copies of the same company/person because they have different ICPs, notes, scores, and outreach state.

This requires a tenancy layer the prior ADRs didn't have and reverses two locked decisions.

## Decision

**Tenancy:** `tenant → workspace → workspace_member → user`.
- A `tenant` is the paying organization (plan, seat/workspace limits, credit balance).
- A `workspace` is the collaboration + data-isolation scope; all contacts/accounts/activities/reveals live inside exactly one workspace.
- A `user` belongs to one tenant and is granted access to specific workspaces via `workspace_members`, with a **per-workspace role** (`owner`/`admin`/`member`/`viewer`).
- A distinct **tenant-level billing/owner** capability governs billing, workspace creation, seat/workspace limits, and suspension (a gap the raw proposal left — see [ADR-0007](./ADR-0007-per-workspace-reveal-and-credit-counter.md) and `00 §6` glossary).
- Website signups auto-provision tenant + owner user + default "My workspace" + owner membership (`provision_new_signup`).

**Data ownership:** contacts and accounts are **per-workspace copies** carrying both `tenant_id` (denormalized) and `workspace_id`. No global golden record. Provenance for each contact is captured by `source_imports` (raw source payload per import) rather than a per-field lineage graph.

**Isolation:** Postgres **RLS** keyed by a session GUC — `SET LOCAL app.current_workspace_id` (and `app.current_tenant_id` for tenant-scoped tables) — **plus** the retained app-layer AsyncLocalStorage context (belt-and-suspenders). Queries run under a non-`BYPASSRLS` role; the GUC is reset per pooled connection (PgBouncer transaction mode note).

> **User identity amended by [ADR-0019](./ADR-0019-global-identity-and-tenant-membership.md) (2026-06-09):**
> a user is now a **global identity** (`users` is global; one login across many orgs), and org membership
> moved to a new **`tenant_members`** table (carrying `is_tenant_owner` + status). The per-workspace **data**
> model, RLS, and the `provision_new_signup` tree above are **unchanged** — only the user↔tenant scoping
> (`tenant → workspace → workspace_member → user`) changed to `identity ↦ many tenant_members ↦ workspaces`.

## Rationale

The founders chose to optimize for per-team curation and control over a shared asset. Per-workspace copies eliminate cross-team coordination problems (whose notes/score/status win?) and make isolation, export, and deletion per-workspace trivial.

## Alternatives considered

| Option | Verdict | Why |
|---|---|---|
| **Per-workspace copies (this ADR)** | Chosen | Matches the prospecting-CRM positioning; clean isolation/curation. |
| Coexist/hybrid (global golden + per-workspace overlay) | Rejected | Preserved the shared asset + provable DSAR but added two-tier complexity the founders chose not to carry. |
| Global shared DB (ADR-0005, superseded) | Rejected | The data-vendor model is no longer the product. |

## Consequences

- **Positive:** simple, hard per-workspace isolation; independent ICPs/notes/scores; trivial per-workspace export and deletion; straightforward RLS.
- **Negative (consciously accepted):**
  - **No shared 100M-row asset** — the same human is stored/revealed independently in every workspace.
  - **No field-level provenance / golden merge / cross-source dedup / replay-unmerge** — provenance is only the raw `source_imports.raw_data` per import.
  - **DSAR is harder to prove complete** — a data subject can exist as many per-workspace copies; deletion must **fan out** across every workspace's contacts + `source_imports` + `contact_reveals` + `activities`, then verify (see [08 §4](../08-compliance.md)).
  - **No cross-source confidence model** for field correctness. (Note: *lead scoring* — how good a prospect is — still exists per workspace, see [ADR-0008](./ADR-0008-lead-scoring-model.md); it is distinct from the now-removed *data-confidence* model.)
- **Data-residency:** `region`/`jurisdiction` tags carry on contacts/accounts for later EU split.
- **Future:** a read-only cross-workspace/cross-tenant "tenant search" could aggregate overlays later (see [10 Beyond](../10-roadmap.md)).

## Revisit if
DSAR fan-out cost, duplicate-storage cost, or the lack of a shared asset becomes painful — revisit the hybrid model (the superseded ADR-0005/0003 bodies are the starting point). **→ Triggered (2026-06-09): [ADR-0021](./ADR-0021-global-master-graph-and-overlay.md) adopts the hybrid — a global master graph (Layer 0) beneath this per-workspace overlay (Layer 1).**
