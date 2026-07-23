# Data Model

This is the canonical entity model for TruePoint. Security can only be "perfectly
planned" against a model that exists; the frontend can only be consistent if every
feature agrees on what a Contact is versus a Prospect. This file is that
agreement. The relational specifics (indexes, partitioning) live in
`truepoint-platform` data-platform; the migration discipline in the architecture
`database.md`; this file is the shapes and the relationships.

Tenancy is **two-tier**: a row is scoped by `tenant_id` and, where it is
workspace-scoped, also by `workspace_id`. The names below use that pair (not a
single `org_id`).

---

## The Tenant Boundary

Every entity below except the platform-level ones (`Tenant`, the global
prospect/company dataset) is **tenant-owned**: it has a non-null `tenant_id` (and a
`workspace_id` where the row is workspace-scoped) and is isolated by RLS (see
`truepoint-platform` tenancy). The model is described per that assumption — every
table here carries `tenant_id` (+ `workspace_id` where workspace-scoped) unless
noted as global.

---

## Identity and Access Entities

- **Tenant** — the top tier of the boundary. The root of the data boundary. Has a
  plan, settings, and a cluster assignment (pooled or siloed — see platform
  tenancy).
- **Workspace** — the second tier: a tenant has one or more workspaces, and most
  CRM rows are scoped by `workspace_id` within their `tenant_id`. The workspace is
  the RLS boundary for working data.
- **User** — a person with a login. Belongs to one Tenant (the common case).
  Identity is federated for enterprise (SSO/SCIM — see `truepoint-security`
  enterprise-iam); the User row is the local projection.
- **Team** — a grouping of users within a Tenant (a sales pod, a territory). Used
  for sharing and reporting.
- **Membership** — links a User to a Team with a role. The join that expresses "who
  is on which team as what."
- **Role / Permission** — the target is roles as **data, not hardcoded enums** (see
  `truepoint-security` enterprise-iam). An Org admin can define roles; permissions
  attach to roles; this model must represent custom tenant-defined roles, not a
  fixed `customer|staff|admin` list.
  > **Implementation status:** roles today ARE closed enums — `tenant_members.org_role`
  > (`owner|billing_admin|security_admin|compliance_admin|member`, ADR-0030, enforced
  > by `requireOrgRole`) plus hardcoded workspace roles via `requireRole(...)`; there
  > are no roles/permissions tables yet (gap G-AUTH-10). Keep the mandate; don't
  > look for role tables today. (The platform-level `customer|staff|admin`
  distinction is the *surface* a user belongs to — the customer surface is
  `apps/web` (@leadwolf/web); the internal/platform-admin surface is `apps/admin`
  (@leadwolf/admin); within the customer surface, a tenant has its own richer
  roles.)

---

## The Two-Layer Contact Model

This is the most important modelling decision in the product, and the one agents
get wrong by conflating two different things:

- **Company** (accounts) and **Person** (global dataset) — the *canonical,
  deduplicated* records in the large sales-intelligence dataset. A Person is a real
  human; a Company is a real organisation. These are **not tenant-owned** in the
  sense of belonging to one workspace's CRM — they are the shared knowledge base
  that enrichment populates and search queries. Identity here is resolved via the
  dedup hierarchy (see `enrichment-pipeline.md`).

- **Contact** and **Prospect** (tenant-owned) — a *workspace's working record* that
  references a canonical Person/Company. When a workspace adds someone to their
  CRM, they create a tenant-owned Prospect/Contact (the `contacts` table) that
  points at the canonical Person. The workspace owns their notes, their deal, their
  activity, their list memberships, their ownership and sharing — but the
  underlying person's canonical attributes come from (and are enriched into) the
  shared Person record.

Why two layers: it lets enrichment improve the canonical Person once and benefit
every workspace that references them, while keeping each workspace's *relationship*
with that person (notes, stage, owner, history) strictly tenant-isolated.
Conflating them —
copying canonical attributes into per-tenant rows with no link — produces
duplicated, stale, un-enrichable data and is the classic mistake.

A tenant feature almost always operates on **Contact/Prospect** (tenant-owned);
enrichment and search operate on **Person/Company** (canonical) and surface
results the tenant can pull into their working set.

---

## CRM Working Entities (tenant-owned)

- **List** (`lists`) — a named collection of prospects within a workspace (a
  campaign, a segment). Has an owner (`ownerUserId`); visibility today is
  workspace-wide — see `ownership-and-sharing.md` for the model and its status.
- **ListMember** (`list_members`) — links a Prospect to a List. Carries
  `addedByUserId` (who added it) and when, and is `unique(list, contact)` so a
  prospect can't be double-added to the same list (for audit/activity).
- **Deal** — a pipeline opportunity tied to a Prospect/Company, with a stage and a
  value. Owned, with stage transitions audited.
- **Activity** — the timeline of what happened to an entity (calls, emails, stage
  changes, additions). Append-heavy → time-partitioned (see platform
  data-platform). Records IDs and actions, not duplicated PII (see
  `truepoint-security` data-protection).
  > **Implementation status:** time-partitioning is the target — not yet
  > implemented; the append-heavy tables are unpartitioned today (see
  > `packages/db/src/migrations`).
- **Note** — free-text a user attaches to a record. Untrusted on the way out as
  much as in (stored-XSS — see `truepoint-security` input-and-injection).
- **Task** — a to-do tied to a record and an owner.
- **Call** — a telephony record (if the dialer is in scope): who called whom, when,
  duration, recording reference, consent/DNC flags (see `truepoint-security`
  abuse-and-edge for TCPA/DNC). Append-heavy → partitioned.

---

## Cross-Cutting Entities

- **AuditEvent** — immutable record of who did what to which record (see the
  architecture dependency-wiring audit pattern). IDs + action + actor + timestamp,
  never the personal contents. Append-only, partitioned.
  > **Implementation status:** append-only is met; partitioning is the target —
  > not yet implemented (see `packages/db/src/migrations`).
- **EnrichmentResult / cache** — provider responses keyed by the dedup identity, so
  the same lookup isn't re-paid (see `enrichment-pipeline.md` and platform
  caching). Today this is the DB-level `provider_calls` table
  (`unique(workspace, request_hash)`, sha256-keyed) — there is no Redis hot-cache
  layer yet.
- **UsageEvent** (concept, not a table) — metered actions for quota and billing
  (see `truepoint-operations` FinOps). There is **no `usage_events` table**: today
  the metered ledger is `provider_calls` rows (`cost_micros`) plus the append-only
  `audit_log` (see finops). Write those; don't invent a UsageEvent row.

---

## Modelling Rules

- **Every tenant-owned table: `tenant_id NOT NULL` (+ `workspace_id NOT NULL`
  where workspace-scoped) + RLS policy + a `tenant_id`/`workspace_id`-leading
  index.** RLS is `ENABLE` + `FORCE` (`ENABLE`-only for tables written by the
  RLS-bypassing owner connection, e.g. audit/auth), fail-closed via `NULLIF` on the GUC. Added in
  the same migration that creates the table (platform tenancy + data-platform;
  architecture `database.md`).
- **Ownership fields are explicit**: `ownerUserId` (the user who owns the record) is
  a first-class column on owned entities, because visibility/filtering depends on it
  (see `ownership-and-sharing.md`). It is a *soft-owner* filter dimension, not the
  access wall (the workspace is the RLS wall). It is never a field a user can
  self-set on an arbitrary record (mass-assignment — see `truepoint-security`
  access-control).
- **References, not copies**: a tenant Prospect references a canonical Person by ID;
  it does not copy the canonical attributes into per-tenant columns that then drift.
- **Dedup keys are constraints**: the identity-resolution keys (provider ID,
  normalised email, etc.) are backed by unique constraints where they must be
  unique, so duplicates are rejected at the database even if application dedup is
  bypassed (see `enrichment-pipeline.md`, platform api-contract idempotency).
- **Soft-delete vs hard-delete is a deliberate per-entity choice** driven by
  retention and subject-deletion rules — not a default (see
  `retention-and-deletion.md`).
- **Enums handle the unknown case**: a status/stage enum always has a defined
  default/unknown handling so an unrecognised value doesn't break (the pre-build
  edge-case rule).

---

## A Worked Relationship

"Add a prospect to a list" touches:

```
Person (canonical, global) ──referenced by──▶ Prospect (tenant-owned, tenant_id, workspace_id, ownerUserId)
                                                   │
                                                   ├─▶ ListMember (tenant_id, workspace_id) ──▶ List (tenant_id, workspace_id, ownerUserId, sharing)
                                                   ├─▶ Activity (tenant_id, workspace_id, append)
                                                   ├─▶ AuditEvent (tenant_id, append)
                                                   └─▶ UsageEvent (if metered)
```

The architecture dependency-wiring skill lists what must be *wired* (audit,
activity, permissions, etc.); this file is what those rows *are* and how they
relate. Both apply to the same feature.

---

## Checklist

- Does the feature operate on tenant-owned Contact/Prospect, or canonical
  Person/Company — and is that the right layer?
- Does every new tenant table have `tenant_id` (+ `workspace_id` where
  workspace-scoped) + ENABLE/FORCE RLS + a `tenant_id`/`workspace_id`-leading index?
- Are ownership fields explicit and not user-self-settable on arbitrary records?
- Does a tenant record *reference* canonical data rather than copying it?
- Are dedup/uniqueness keys backed by database constraints?
- Is soft-vs-hard delete chosen deliberately per the retention rules?
- Do audit/activity rows hold IDs and actions, never duplicated PII?
