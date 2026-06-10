# ADR-0028 — Record customization layer (custom fields, stages, tags)

- **Status:** Accepted
- **Date:** 2026-06-10
- **Context doc:** [05-features-modules.md](../05-features-modules.md), [03-database-design.md](../03-database-design.md)

## Context

The overlay record model is **closed**: `contacts`/`accounts` carry a fixed column set, `outreach_status`
is a closed enum, and there is no lightweight labeling besides lists. The enterprise audit graded this the
corpus's top product gap ([28 §3.6](../28-enterprise-readiness-audit.md), G-REV-5/6/7 — Critical/High):
custom fields are table-stakes for a CRM-shaped product and a hard prerequisite for faithful CRM sync
(M10), import mapping, segment rules, and automation conditions; teams also need their own pipeline
stages and tags. At the same time `outreach_status` is **load-bearing shared vocabulary** (doc-map §5)
consumed by reports, automation, and the API — it cannot simply be opened up.

## Decision

Add a workspace-scoped **record customization layer**, landing **M8**:

- **`custom_field_definitions`** — workspace-scoped, per `entity_type` (`contact`|`account`): `key`,
  `label`, `field_type` ∈ `text|number|date|boolean|enum|multi_enum|user|url`, `validation` jsonb,
  `is_required`, `archived_at`; definition count capped per plan tier (`tenants.features`).
- **Values as typed jsonb** — one `custom_fields jsonb` column on `contacts`/`accounts` (GIN-indexed),
  validated against the definition by `packages/types` at the edge. Not per-definition physical columns
  (DDL churn at 100M+ rows) and not an EAV value table (joins on the hot masked-list path).
- **Stage layer** — **`pipeline_stages`**: workspace-defined, ordered stages, each mapping to **exactly
  one** canonical `outreach_status` value. UI (boards/views), reports, and automation conditions operate
  on stages; the enum remains the system vocabulary — **H-vocab intact**.
- **Tags** — **`tags`** (workspace-scoped; governed: who may create) + **`record_tags`**; filterable,
  bulk-applicable labels orthogonal to lists.
- **Propagation:** custom fields and tags are first-class in search facets (search-sync indexes them),
  import column mapping, CRM-sync field mapping, automation conditions, exports, and the public API.
  Mutations write the new record-mutation audit actions ([08 §5](../08-compliance.md)).

## Rationale

Typed-jsonb-with-registry gives schema stability at scale, per-plan governance, and end-to-end typing
(Zod definitions generated from the registry), while the stage **mapping** preserves every consumer of
the canonical enum. This is the smallest design that unblocks CRM-sync fidelity and enterprise data
modeling without re-opening the shared vocabulary.

## Alternatives considered

| Option | Verdict | Why |
|---|---|---|
| **Definitions + typed jsonb values (this ADR)** | Chosen | No DDL churn; GIN-indexable; cap-governable; type-safe at the edge. |
| Physical column per definition | Rejected | Online DDL churn on 100M+-row tables; migration risk per customer change. |
| EAV value table | Rejected | Hot-path join amplification on the masked grid; harder typing. |
| Open up `outreach_status` per workspace | Rejected | Breaks load-bearing shared vocabulary (reports/automation/API). |

## Consequences

- **Positive:** table-stakes customization; faithful CRM mapping; stages/tags power department views and
  automation; per-plan caps keep blast radius bounded.
- **Negative:** jsonb validation discipline; search-sync mapping updates on definition changes; facet
  cardinality growth (mitigate: only `enum|boolean|number|date` fields become facets by default).
- **Wiring:** schema flagged in [03 §14](../03-database-design.md); module text in
  [05 §7](../05-features-modules.md); milestone M8 ([10](../10-roadmap.md)); settings surface in
  [29 §6](../29-settings-administration-architecture.md).

## Revisit if

Definition counts or facet cardinality at the top tier strain the index (move heavy fields to a side
table), or customers need cross-workspace field templates (ties workspace templates, 28 G-WS-2).
